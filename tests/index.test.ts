// SPDX-License-Identifier: MIT
//
// Copyright 2026 Cisco Systems, Inc. and its affiliates
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import ircExtension from "../src/index";

type Tool = { loadMode?: string; execute(...args: unknown[]): Promise<{ details: unknown }> };

const servers: Server[] = [];
const shutdowns: (() => Promise<void>)[] = [];
const directories: string[] = [];
const home = process.env.OMP_IRC_HOME;

function load(): { tools: Map<string, Tool>; call: (name: string, params: object) => Promise<any> } {
  const tools = new Map<string, Tool>();
  const pi = {
    zod, logger: { warn() {} }, sendMessage() {}, registerCommand() {},
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
/** Minimal IRC server: welcomes `tester` and confirms whichever channel it joins. */
async function fakeIrc(): Promise<number> {
  const { server, port } = await listen((socket) => {
    let pending = "";
    socket.on("data", (data) => {
      pending += data.toString("utf8");
      for (let end = pending.indexOf("\r\n"); end >= 0; end = pending.indexOf("\r\n")) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (line.startsWith("USER ")) socket.write(":irc 001 tester :welcome\r\n");
        if (line.startsWith("JOIN ")) socket.write(`:tester!u@h ${line}\r\n`);
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
});
