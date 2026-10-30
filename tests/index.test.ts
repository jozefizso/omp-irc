// SPDX-License-Identifier: MIT
//
// Copyright 2026 Cisco Systems, Inc. and its affiliates
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import ircExtension from "../src/index";

type Tool = { loadMode?: string; execute(...args: unknown[]): Promise<{ details: unknown }> };
type Delivered = { customType?: string; content: string };

const servers: Server[] = [];
const shutdowns: (() => Promise<void>)[] = [];
/** Messages the extension handed to the agent (pi.sendMessage), in order. */
const delivered: Delivered[] = [];
let deliveryWaiter: { count: number; resolve: () => void } | undefined;
/** Resolves once at least `count` messages have been delivered to the agent. */
function delivery(count: number): Promise<void> {
  if (delivered.length >= count) return Promise.resolve();
  const waiter = Promise.withResolvers<void>();
  deliveryWaiter = { count, resolve: waiter.resolve };
  return waiter.promise;
}
const directories: string[] = [];
const home = process.env.OMP_IRC_HOME;

function load(): { tools: Map<string, Tool>; call: (name: string, params: object) => Promise<any> } {
  const tools = new Map<string, Tool>();
  const pi = {
    zod, logger: { warn() {} }, registerCommand() {},
    sendMessage(message: Delivered) { delivered.push(message); if (deliveryWaiter && delivered.length >= deliveryWaiter.count) deliveryWaiter.resolve(); },
    registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
    on(event: string, handler: () => Promise<void>) { if (event === "session_shutdown") shutdowns.push(handler); },
  };
  ircExtension(pi as unknown as ExtensionAPI);
  const call = async (name: string, params: object) =>
    (await tools.get(name)!.execute("call", params, undefined, undefined, { cwd: process.cwd() })).details;
  return { tools, call };
}
async function listen(onConnection: (socket: Socket) => void = () => {}): Promise<{ server: Server; port: number }> {
  const server = createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return { server, port: address.port };
}
/** Minimal IRC server: welcomes `tester` and confirms whichever channel it joins, then runs `afterJoin`. */
async function fakeIrc(afterJoin: (socket: Socket) => void = () => {}): Promise<number> {
  const { server, port } = await listen((socket) => {
    let pending = "";
    socket.on("data", (data) => {
      pending += data.toString("utf8");
      for (let end = pending.indexOf("\r\n"); end >= 0; end = pending.indexOf("\r\n")) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (line.startsWith("USER ")) socket.write(":irc 001 tester :welcome\r\n");
        if (line.startsWith("JOIN ")) { socket.write(`:tester!u@h ${line}\r\n`); afterJoin(socket); }
      }
    });
  });
  servers.push(server);
  return port;
}
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-irc-index-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  delivered.length = 0;
  deliveryWaiter = undefined;
  await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  if (home === undefined) delete process.env.OMP_IRC_HOME;
  else process.env.OMP_IRC_HOME = home;
});

describe("ircExtension", () => {
  test("keeps the self-start tools in the top-level tool set", () => {
    const { tools } = load();
    for (const name of ["irc_host", "irc_join", "irc_status", "irc_connect", "irc_send", "irc_receive"]) {
      expect(tools.get(name)?.loadMode, name).toBe("essential");
    }
  });

  test("irc_join fills in local defaults", async () => {
    const port = await fakeIrc();
    const { call } = load();
    expect(await call("irc_join", { port, nick: "tester" })).toMatchObject({ joined: true, channel: "#omp", nick: "tester" });
  });

  test("irc_host joins a server already listening without provisioning Ergo", async () => {
    const port = await fakeIrc();
    const storage = join(await scratch(), "irc");
    process.env.OMP_IRC_HOME = storage;
    const { call } = load();
    const details = await call("irc_host", { port, nick: "tester", channel: "#room" });
    expect(details).toMatchObject({ hosted: false, client: { joined: true, channel: "#room" } });
    expect(details.joinCommand).toBe(`/irc join ${JSON.stringify({ host: "127.0.0.1", port, channel: "#room" })}`);
    expect(existsSync(storage)).toBe(false);
    expect(await call("irc_status", {})).toMatchObject({ server: { state: "stopped" } });
  });

  test("irc_host provisions Ergo only when the port refuses connections", async () => {
    const { server, port } = await listen();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // A file where the storage directory belongs makes provisioning fail before any download.
    const storage = join(await scratch(), "not-a-directory");
    await writeFile(storage, "");
    process.env.OMP_IRC_HOME = storage;
    const { call } = load();
    await expect(call("irc_host", { port, nick: "tester" })).rejects.toMatchObject({ code: "EEXIST", path: storage });
  });

  test("irc_host does not provision Ergo over a listener that is not IRC", async () => {
    const { server, port } = await listen((socket) => socket.destroy());
    servers.push(server);
    const storage = join(await scratch(), "irc");
    process.env.OMP_IRC_HOME = storage;
    const { call } = load();
    // Reset or early close, depending on timing; either way the port is taken.
    await expect(call("irc_host", { port, nick: "tester" })).rejects.toThrow();
    expect(existsSync(storage)).toBe(false);
  });

  test("shows a direct file offer to the agent as a note, drops channel offers, and downloads on accept", async () => {
    const payload = randomBytes(50_000);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const token = "f".repeat(32);
    const confirmed = Promise.withResolvers<string>();
    const { server: sender, port: senderPort } = await listen((socket) => {
      let seen = "";
      socket.on("data", (data) => {
        seen += data.toString("latin1");
        if (seen === `${token}\n`) socket.write(payload); // token accepted: stream the file
        else if (seen.endsWith("OK\n")) confirmed.resolve("OK"); // receiver's verification reply
      });
    });
    servers.push(sender);
    const port = await fakeIrc((socket) => {
      socket.write(`:alice!u@h PRIVMSG #omp :OMPFILE OFFER 0000aaaa 10 ${sha256} evil.bin 127.0.0.1 9 ${token}\r\n`);
      socket.write(`:alice!u@h PRIVMSG tester :OMPFILE OFFER 0000beef ${payload.length} ${sha256} dump.bin 127.0.0.1 ${senderPort} ${token}\r\n`);
      socket.write(":alice!u@h PRIVMSG tester :hello\r\n");
    });
    const { call } = load();
    await call("irc_join", { port, nick: "tester" });
    await delivery(2);
    expect(delivered[0]!.content).toContain("file offer id=0000beef name=dump.bin");
    expect(delivered[0]!.content).not.toContain("OMPFILE");
    expect(delivered[1]!.content).toContain("hello");
    expect(delivered.some((message) => message.content.includes("evil.bin"))).toBe(false);
    expect(await call("irc_status", {})).toMatchObject({ fileOffers: [{ id: "0000beef", name: "dump.bin", from: "alice", mode: "sender-listens" }] });

    const directory = await scratch();
    const received = await call("irc_accept_file", { id: "0000beef", directory });
    expect(received).toMatchObject({ name: "dump.bin", size: payload.length, sha256, path: join(directory, "dump.bin") });
    expect((await readFile(join(directory, "dump.bin"))).equals(payload)).toBe(true);
    expect(await confirmed.promise).toBe("OK");
    expect(await call("irc_status", {})).toMatchObject({ fileOffers: [] });
  });
});
