// SPDX-License-Identifier: MIT
//
// Copyright 2026 Cisco Systems, Inc. and its affiliates
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTransfers, sanitizeName, type FileOffer, type TransferOptions } from "../src/transfer";

let root: string;
const servers: Server[] = [];

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "omp-irc-transfer-")); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => { const { promise, resolve } = Promise.withResolvers<void>(); server.close(() => resolve()); return promise; }));
  await rm(root, { recursive: true, force: true });
});

/** Two peers whose control messages are delivered to each other in memory; file bytes use real TCP on loopback. */
function pair(options: Partial<TransferOptions> = {}) {
  const sent: string[] = [];
  const firstOffer = Promise.withResolvers<FileOffer>();
  const alice: FileTransfers = new FileTransfers({
    send: async (_target, text) => { sent.push(text); const result = bob.handleControl("alice", true, text); if (result.kind === "offer") firstOffer.resolve(result.offer); },
    localAddress: () => "127.0.0.1",
  }, options);
  const bob: FileTransfers = new FileTransfers({
    send: async (_target, text) => { alice.handleControl("bob", true, text); },
    localAddress: () => "127.0.0.1",
  }, options);
  return { alice, bob, sent, offer: firstOffer.promise };
}
/** A TCP listener on loopback that the test controls; closed after the test. */
async function listen(onConnection: (socket: Socket) => void): Promise<number> {
  const server = createServer(onConnection);
  servers.push(server);
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener has no address");
  return address.port;
}
async function makeFile(name: string, size: number): Promise<{ path: string; data: Buffer }> {
  const data = randomBytes(size);
  const path = join(root, name);
  await writeFile(path, data);
  return { path, data };
}
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
/**
 * How a promise settled, captured without blocking. Do not start `expect(promise).rejects` before triggering the
 * event that settles it: Bun 1.3 runs the event loop inside it until the promise settles, which deadlocks.
 */
const outcome = (promise: Promise<unknown>) => promise.then(() => undefined, (error: Error) => error);
/** Endpoint advertised in a sender-listens OFFER line. */
function endpointOf(offerLine: string): { host: string; port: number } {
  const words = offerLine.split(" ");
  return { host: words[6]!, port: Number(words[7]) };
}

describe("FileTransfers", () => {
  test("sender listens: a multi-megabyte file arrives intact", async () => {
    const { alice, bob, offer } = pair();
    const { path, data } = await makeFile("dump one.bin", 3 * 1024 * 1024 + 17);
    const sending = alice.send("bob", path);
    const offered = await offer;
    expect(offered).toMatchObject({ name: "dump_one.bin", size: data.length, sha256: sha(data), from: "alice" });
    const received = await bob.accept(offered.id, join(root, "in"));
    const sentResult = await sending;
    expect(received.path).toBe(join(root, "in", "dump_one.bin"));
    expect((await readFile(received.path!)).equals(data)).toBe(true);
    expect(sentResult.sha256).toBe(sha(data));
    expect(await readdir(join(root, "in"))).toEqual(["dump_one.bin"]);
  });

  test("receiver listens (reverse mode): the sender connects out", async () => {
    const { alice, bob, offer, sent } = pair();
    const { path, data } = await makeFile("rev.bin", 1024 * 1024);
    const sending = alice.send("bob", path, { listen: false });
    const offered = await offer;
    expect(sent[0]!.split(" ")).toHaveLength(6); // OMPFILE OFFER id size sha name, no endpoint
    expect(bob.pending()[0]?.mode).toBe("receiver-listens");
    const received = await bob.accept(offered.id, join(root, "in"));
    await sending;
    expect((await readFile(received.path!)).equals(data)).toBe(true);
  });

  test("an empty file transfers", async () => {
    const { alice, bob, offer } = pair();
    const { path } = await makeFile("empty.bin", 0);
    const sending = alice.send("bob", path);
    const received = await bob.accept((await offer).id, join(root, "in"));
    await sending;
    expect((await readFile(received.path!)).length).toBe(0);
  });

  test("declining ends the sender's wait", async () => {
    const { alice, bob, offer } = pair();
    const { path } = await makeFile("no.bin", 100);
    const sending = outcome(alice.send("bob", path));
    await bob.decline((await offer).id);
    expect((await sending)?.message).toMatch(/declined/);
    expect(bob.pending()).toEqual([]);
  });

  test("a connection with the wrong token is dropped and the real receiver still succeeds", async () => {
    const { alice, bob, offer, sent } = pair();
    const { path, data } = await makeFile("tok.bin", 4096);
    const sending = alice.send("bob", path);
    const offered = await offer;
    const intruder = connect(endpointOf(sent[0]!));
    const closed = Promise.withResolvers<void>();
    intruder.on("close", () => closed.resolve());
    intruder.on("error", () => {});
    intruder.write(`${"0".repeat(32)}\n`);
    await closed.promise;
    const received = await bob.accept(offered.id, join(root, "in"));
    await sending;
    expect((await readFile(received.path!)).equals(data)).toBe(true);
  });

  test("a SHA-256 mismatch is rejected and leaves no file behind", async () => {
    const { bob } = pair();
    const payload = randomBytes(2048);
    const token = "a".repeat(32);
    const port = await listen((socket) => {
      socket.on("data", (chunk) => { if (chunk.toString("latin1").includes(token)) { socket.write(payload); socket.end(); } });
    });
    const claimed = bob.handleControl("mallory", true, `OMPFILE OFFER 0000000a ${payload.length} ${sha(randomBytes(8))} evil.bin 127.0.0.1 ${port} ${token}`);
    expect(claimed.kind).toBe("offer");
    await expect(bob.accept("0000000a", join(root, "in"))).rejects.toThrow(/sha256 mismatch/);
    expect(await readdir(join(root, "in"))).toEqual([]);
  });

  test("a stream that ends early is rejected and leaves no partial file", async () => {
    const { bob } = pair();
    const token = "b".repeat(32);
    const port = await listen((socket) => { socket.on("data", () => { socket.write(randomBytes(100)); socket.end(); }); });
    bob.handleControl("mallory", true, `OMPFILE OFFER 0000000b 5000 ${sha(randomBytes(1))} short.bin 127.0.0.1 ${port} ${token}`);
    await expect(bob.accept("0000000b", join(root, "in"))).rejects.toThrow(/connection (ended|closed) after \d+ of 5000 bytes/);
    expect(await readdir(join(root, "in"))).toEqual([]);
  });

  test("a stream with extra bytes is rejected", async () => {
    const { bob } = pair();
    const port = await listen((socket) => { socket.on("data", () => { socket.write(randomBytes(300)); socket.end(); }); });
    bob.handleControl("mallory", true, `OMPFILE OFFER 0000000e 200 ${sha(randomBytes(1))} long.bin 127.0.0.1 ${port} ${"e".repeat(32)}`);
    await expect(bob.accept("0000000e", join(root, "in"))).rejects.toThrow(/more than the offered size/);
    expect(await readdir(join(root, "in"))).toEqual([]);
  });

  test("never overwrites an existing file", async () => {
    const { alice, bob, offer } = pair();
    const { path } = await makeFile("keep.bin", 10);
    await mkdir(join(root, "in"));
    await writeFile(join(root, "in", "keep.bin"), "original");
    const cancel = new AbortController();
    const sending = outcome(alice.send("bob", path, { signal: cancel.signal }));
    await expect(bob.accept((await offer).id, join(root, "in"))).rejects.toThrow(/already exists/);
    cancel.abort();
    expect((await sending)?.message).toMatch(/aborted/);
    expect(await readFile(join(root, "in", "keep.bin"), "utf8")).toBe("original");
  });

  test("ignores malformed, oversized, channel and unsolicited control messages", async () => {
    const { bob } = pair({ maxBytes: 1000 });
    const good = sha(randomBytes(1));
    const token = "c".repeat(32);
    const offer = (extra: string) => bob.handleControl("mallory", true, `OMPFILE OFFER 0000000c ${extra}`);
    expect(offer(`2000 ${good} big.bin`).kind).toBe("handled"); // larger than maxBytes
    expect(offer(`10 ${good} ../etc.bin`).kind).toBe("handled"); // path in the name
    expect(offer(`10 ${good} a.bin 0.0.0.0 9000 ${token}`).kind).toBe("handled"); // wildcard endpoint
    expect(offer(`10 ${good} a.bin 224.0.0.1 9000 ${token}`).kind).toBe("handled"); // multicast endpoint
    expect(offer(`10 ${good} a.bin example.com 9000 ${token}`).kind).toBe("handled"); // not an IP literal
    expect(offer(`10 ${good} a.bin 127.0.0.1 99999 ${token}`).kind).toBe("handled"); // bad port
    expect(bob.handleControl("mallory", false, `OMPFILE OFFER 0000000d 10 ${good} a.bin`).kind).toBe("handled"); // channel message
    expect(bob.handleControl("mallory", true, "hello").kind).toBe("ignored"); // ordinary chat
    expect(bob.pending()).toEqual([]);
    await expect(bob.accept("0000000c", join(root, "in"))).rejects.toThrow(/No pending file offer/);
  });

  // Exercises the real timeout path, so it needs a genuine (short) delay; no event can stand in for "nobody came".
  test("an unanswered offer times out and releases its listening port", async () => {
    const { alice, sent } = pair();
    const { path } = await makeFile("wait.bin", 10);
    await expect(alice.send("bob", path, { timeoutMs: 100 })).rejects.toThrow(/Timed out waiting for bob to connect/);
    const attempt = connect(endpointOf(sent[0]!));
    const failure = Promise.withResolvers<string>();
    attempt.on("error", (error: NodeJS.ErrnoException) => failure.resolve(error.code ?? ""));
    expect(await failure.promise).toBe("ECONNREFUSED");
  });

  test("a LISTEN reply from a different nickname is ignored", async () => {
    const { alice, bob, offer } = pair();
    const { path, data } = await makeFile("who.bin", 64);
    let intruderConnections = 0;
    const intruderPort = await listen(() => { intruderConnections++; });
    const sending = alice.send("bob", path, { listen: false });
    const offered = await offer;
    alice.handleControl("mallory", true, `OMPFILE LISTEN ${offered.id} 127.0.0.1 ${intruderPort} ${"d".repeat(32)}`);
    const received = await bob.accept(offered.id, join(root, "in")); // bob's own LISTEN must still win
    await sending;
    expect((await readFile(received.path!)).equals(data)).toBe(true);
    expect(intruderConnections).toBe(0);
  });
});

describe("sanitizeName", () => {
  test("keeps only a safe basename", () => {
    expect(sanitizeName("C:\\temp\\my dump (1).dmp")).toBe("my_dump__1_.dmp");
    expect(sanitizeName("/etc/passwd")).toBe("passwd");
    expect(sanitizeName("..\\..\\.hidden")).toBe("hidden");
    expect(sanitizeName("...")).toBe("file");
    expect(sanitizeName("a".repeat(300))).toHaveLength(100);
  });
});
