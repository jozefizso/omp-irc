// SPDX-License-Identifier: MIT
//
// Copyright 2026 Cisco Systems, Inc. and its affiliates
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// Direct file transfer between two IRC peers, in the spirit of DCC SEND: IRC carries only a small offer and
// the endpoint, the file itself travels over one raw TCP connection. IRC cannot carry megabytes (the server
// throttles every connection), so file bytes never go through it.
//
//   sender -> receiver (direct message):  OMPFILE OFFER <id> <size> <sha256> <name> [<host> <port> <token>]
//   receiver -> sender (reverse mode):    OMPFILE LISTEN <id> <host> <port> <token>
//   receiver -> sender:                   OMPFILE DECLINE <id>
//
// With an endpoint in the offer the sender listens and the receiver connects. Without one (reverse mode) the
// receiver listens and the sender connects; use that when the sender's firewall blocks inbound connections.
// Whoever connects first sends "<token>\n"; the listener drops connections that do not present the token.
// The sender then streams exactly <size> bytes and half-closes; the receiver verifies size and SHA-256 and
// answers "OK\n" or "FAIL <reason>\n".

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { basename, join, resolve, sep } from "node:path";

export const FILE_PREFIX = "OMPFILE ";

const ID_RE = /^[0-9a-f]{8}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^\w[\w.-]{0,99}$/;
const MAX_TOKEN_LINE = 64;
const TOKEN_WAIT_MS = 5_000;

export interface Endpoint { host: string; port: number; token: string }
export interface FileOffer {
  id: string;
  from: string;
  name: string;
  size: number;
  sha256: string;
  endpoint?: Endpoint;
  time: string;
}
export interface TransferResult {
  id: string;
  peer: string;
  name: string;
  size: number;
  sha256: string;
  durationMs: number;
  /** Where the file was written (receiver only). */
  path?: string;
}
export type ControlResult = { kind: "offer"; offer: FileOffer } | { kind: "handled" } | { kind: "ignored" };

export interface TransferOptions {
  /** Largest file that may be offered or accepted. */
  maxBytes: number;
  /** How long to wait for the peer to answer, connect or accept. */
  waitMs: number;
  /** Abort a transfer whose connection has been silent this long. */
  idleMs: number;
  maxOffers: number;
  offerTtlMs: number;
}
export const DEFAULT_TRANSFER_OPTIONS: TransferOptions = {
  maxBytes: 1024 ** 3,
  waitMs: 120_000,
  idleMs: 30_000,
  maxOffers: 16,
  offerTtlMs: 10 * 60_000,
};
export interface TransferDeps {
  send(target: string, text: string): Promise<void>;
  /** Local address of the IRC connection; used as the default listen and advertise address. */
  localAddress(): string | undefined;
}
export interface SendOptions {
  /** true (default): this side listens and the receiver connects. false: the receiver listens. */
  listen?: boolean;
  /** Address to listen on and advertise. Default: the local address of the IRC connection. */
  host?: string;
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface AcceptOptions {
  /** Reverse mode only: address to listen on and advertise. */
  host?: string;
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Reduce a file name to the safe subset used on the wire and on disk. */
export function sanitizeName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, "/")).replace(/[^\w.-]/g, "_").replace(/^[^\w]+/, "").slice(0, 100);
  return NAME_RE.test(cleaned) ? cleaned : "file";
}

function fold(nick: string): string { return nick.toLowerCase(); }
function randomHex(bytes: number): string { return randomBytes(bytes).toString("hex"); }
function abortError(): Error { return new Error("File transfer aborted"); }
function validEndpoint(host: string, port: number, token: string): boolean {
  if (isIP(host) === 0 || host === "0.0.0.0" || host === "::") return false;
  if (/^(22[4-9]|23\d)\./.test(host) || /^ff/i.test(host)) return false; // multicast
  return Number.isInteger(port) && port >= 1 && port <= 65535 && TOKEN_RE.test(token);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Race a promise against a timeout and an abort signal. */
function guard<T>(promise: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
  const { promise: result, resolve: done, reject } = Promise.withResolvers<T>();
  if (signal?.aborted) { reject(abortError()); return result; }
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
  const onAbort = () => { cleanup(); reject(abortError()); };
  const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${what}`)); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  promise.then((value) => { cleanup(); done(value); }, (error) => { cleanup(); reject(error); });
  return result;
}

async function openListener(host: string, port: number): Promise<{ server: Server; port: number }> {
  const server = createServer({ allowHalfOpen: true });
  const { promise, resolve: listening, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(port, host, () => { server.off("error", reject); listening(); });
  await promise;
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Listener has no address"); }
  return { server, port: address.port };
}

/** Read the first line of a connection and compare it with the expected token; resolves with bytes after it. */
function readToken(socket: Socket, token: string): Promise<Buffer> {
  const { promise, resolve: done, reject } = Promise.withResolvers<Buffer>();
  let buffer = Buffer.alloc(0);
  const cleanup = () => { clearTimeout(timer); socket.off("data", onData); socket.off("error", fail); socket.off("close", onClose); };
  const fail = (error: Error) => { cleanup(); reject(error); };
  const onClose = () => fail(new Error("connection closed before token"));
  const timer = setTimeout(() => fail(new Error("no token received")), TOKEN_WAIT_MS);
  const onData = (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    const end = buffer.indexOf(0x0a);
    if (end < 0) { if (buffer.length > MAX_TOKEN_LINE) fail(new Error("token line too long")); return; }
    socket.pause();
    cleanup();
    const got = Buffer.from(buffer.subarray(0, end).toString("latin1"), "latin1");
    const want = Buffer.from(token, "latin1");
    if (got.length !== want.length || !timingSafeEqual(got, want)) { reject(new Error("bad token")); return; }
    done(buffer.subarray(end + 1));
  };
  socket.on("data", onData);
  socket.on("error", fail);
  socket.on("close", onClose);
  return promise;
}

/** Wait for one connection that presents `token`; every other connection is dropped. Closes the server. */
function acceptVerified(server: Server, token: string, idleMs: number): Promise<{ socket: Socket; leftover: Buffer }> {
  const { promise, resolve: done, reject } = Promise.withResolvers<{ socket: Socket; leftover: Buffer }>();
  let finished = false;
  const stop = () => { finished = true; server.off("connection", onConnection); server.off("error", onError); server.close(); };
  const onError = (error: Error) => { if (!finished) { stop(); reject(error); } };
  const onConnection = (socket: Socket) => {
    socket.setTimeout(idleMs, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    readToken(socket, token).then((leftover) => {
      if (finished) { socket.destroy(); return; }
      stop();
      socket.setTimeout(idleMs, () => socket.destroy(new Error("idle timeout")));
      socket.removeAllListeners("error");
      done({ socket, leftover });
    }, () => socket.destroy());
  };
  server.on("connection", onConnection);
  server.on("error", onError);
  return promise;
}

function connectWithToken(endpoint: Endpoint, idleMs: number): Promise<Socket> {
  const { promise, resolve: done, reject } = Promise.withResolvers<Socket>();
  const socket = connect({ host: endpoint.host, port: endpoint.port, allowHalfOpen: true });
  const onError = (error: Error) => { socket.destroy(); reject(error); };
  socket.once("error", onError);
  socket.once("connect", () => {
    socket.off("error", onError);
    socket.setTimeout(idleMs, () => socket.destroy(new Error("idle timeout")));
    socket.write(`${endpoint.token}\n`);
    socket.pause(); // buffer incoming bytes until the consumer attaches its listener
    done(socket);
  });
  return promise;
}

/** Read one reply line ("OK" or "FAIL ...") that the receiver sends after verifying the file. */
function readReply(socket: Socket): Promise<string> {
  const { promise, resolve: done, reject } = Promise.withResolvers<string>();
  let buffer = "";
  const cleanup = () => { socket.off("data", onData); socket.off("error", onError); socket.off("close", onClose); };
  const onError = (error: Error) => { cleanup(); reject(error); };
  const onClose = () => { cleanup(); reject(new Error("Connection closed without a verification reply")); };
  const onData = (data: Buffer) => {
    buffer += data.toString("latin1");
    if (buffer.length > 200) { cleanup(); reject(new Error("Reply too long")); return; }
    const end = buffer.indexOf("\n");
    if (end >= 0) { cleanup(); done(buffer.slice(0, end)); }
  };
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  socket.resume();
  return promise;
}

async function streamFile(socket: Socket, path: string): Promise<void> {
  const { promise, resolve: done, reject } = Promise.withResolvers<void>();
  const source = createReadStream(path);
  source.once("error", reject);
  socket.once("error", reject);
  source.once("end", () => { socket.off("error", reject); done(); }); // all bytes handed to the socket; the receiver replies by byte count, so no FIN is needed
  source.pipe(socket, { end: false });
  await promise;
}

/** Receive exactly offer.size bytes into partPath and verify the SHA-256; the caller removes the part file on failure. */
function receiveFile(socket: Socket, leftover: Buffer, offer: FileOffer, partPath: string): Promise<void> {
  const { promise, resolve: done, reject } = Promise.withResolvers<void>();
  const hash = createHash("sha256");
  const out = createWriteStream(partPath, { flags: "wx" });
  let received = 0;
  let settled = false;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    out.destroy();
    reject(error);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    socket.pause();
    out.once("close", () => {
      if (hash.digest("hex") !== offer.sha256) reject(new Error("sha256 mismatch"));
      else done();
    });
    out.end();
  };
  const onChunk = (chunk: Buffer) => {
    if (settled) return;
    if (received + chunk.length > offer.size) { fail(new Error("sender sent more than the offered size")); return; }
    received += chunk.length;
    hash.update(chunk);
    if (!out.write(chunk)) { socket.pause(); out.once("drain", () => socket.resume()); }
    if (received === offer.size) finish();
  };
  out.once("error", fail);
  socket.on("error", fail);
  socket.on("close", () => fail(new Error(`connection closed after ${received} of ${offer.size} bytes`)));
  socket.on("end", () => { if (received < offer.size) fail(new Error(`connection ended after ${received} of ${offer.size} bytes`)); });
  out.once("open", () => {
    if (offer.size === 0) { finish(); return; }
    if (leftover.length) onChunk(leftover);
    socket.on("data", onChunk);
    socket.resume();
  });
  return promise;
}

/**
 * Write the final line and half-close, then give the peer a moment to read it and close first. Destroying right
 * after end() can discard bytes that are still queued in the socket.
 */
async function endWith(socket: Socket, text: string): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  const timer = setTimeout(done, TOKEN_WAIT_MS);
  socket.once("close", () => done());
  socket.once("error", () => done());
  socket.resume(); // the receiver paused it at the byte count; a paused socket can hold the write back
  socket.end(text);
  await promise;
  clearTimeout(timer);
}

interface OutgoingEntry {
  peer: string;
  onListen: (endpoint: Endpoint) => void;
  decline: (error: Error) => void;
}

export class FileTransfers {
  private readonly options: TransferOptions;
  private readonly offers = new Map<string, FileOffer>();
  private readonly outgoing = new Map<string, OutgoingEntry>();

  constructor(private readonly deps: TransferDeps, options: Partial<TransferOptions> = {}) {
    this.options = { ...DEFAULT_TRANSFER_OPTIONS, ...options };
  }

  /** Offers received and not yet accepted or declined. */
  pending(): Array<Omit<FileOffer, "endpoint"> & { mode: "sender-listens" | "receiver-listens" }> {
    this.purge();
    return [...this.offers.values()].map(({ endpoint, ...offer }) => ({ ...offer, mode: endpoint ? "sender-listens" : "receiver-listens" }));
  }

  /**
   * Handle a message that may be a file-transfer control message. Only direct messages count: a channel message
   * with the prefix is swallowed so it cannot make an offer.
   */
  handleControl(from: string, direct: boolean, text: string): ControlResult {
    if (!text.startsWith(FILE_PREFIX)) return { kind: "ignored" };
    if (!direct) return { kind: "handled" };
    const words = text.slice(FILE_PREFIX.length).split(" ");
    switch (words[0]) {
      case "OFFER": return this.onOffer(from, words);
      case "LISTEN": {
        const [, id, host, portText, token] = words;
        const entry = id ? this.outgoing.get(id) : undefined;
        const port = Number(portText);
        if (entry && fold(entry.peer) === fold(from) && validEndpoint(host ?? "", port, token ?? "")) entry.onListen({ host: host!, port, token: token! });
        return { kind: "handled" };
      }
      case "DECLINE": {
        const entry = words[1] ? this.outgoing.get(words[1]) : undefined;
        if (entry && fold(entry.peer) === fold(from)) entry.decline(new Error(`${from} declined the file`));
        return { kind: "handled" };
      }
      default: return { kind: "handled" };
    }
  }

  async send(target: string, filePath: string, options: SendOptions = {}): Promise<TransferResult> {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a regular file");
    if (info.size > this.options.maxBytes) throw new Error(`File is larger than the ${this.options.maxBytes} byte limit`);
    const sha256 = await hashFile(filePath);
    const name = sanitizeName(filePath);
    const id = randomHex(4);
    const waitMs = options.timeoutMs ?? this.options.waitMs;
    const started = Date.now();

    const listenMessage = Promise.withResolvers<Endpoint>();
    const declined = Promise.withResolvers<never>();
    declined.promise.catch(() => {});
    this.outgoing.set(id, { peer: target, onListen: listenMessage.resolve, decline: declined.reject });

    let server: Server | undefined;
    let socket: Socket | undefined;
    try {
      let leftover: Buffer = Buffer.alloc(0);
      if (options.listen !== false) {
        const host = this.hostFor(options.host);
        const token = randomHex(16);
        const listener = await openListener(host, options.port ?? 0);
        server = listener.server;
        await this.deps.send(target, `${FILE_PREFIX}OFFER ${id} ${info.size} ${sha256} ${name} ${host} ${listener.port} ${token}`);
        const accepted = await guard(Promise.race([acceptVerified(server, token, this.options.idleMs), declined.promise]), waitMs, `${target} to connect`, options.signal);
        socket = accepted.socket;
        leftover = accepted.leftover;
      } else {
        await this.deps.send(target, `${FILE_PREFIX}OFFER ${id} ${info.size} ${sha256} ${name}`);
        const endpoint = await guard(Promise.race([listenMessage.promise, declined.promise]), waitMs, `${target} to accept and listen`, options.signal);
        socket = await guard(connectWithToken(endpoint, this.options.idleMs), waitMs, `connection to ${endpoint.host}:${endpoint.port}`, options.signal);
      }
      if (leftover.length) throw new Error("Receiver sent unexpected data");
      const active = socket;
      options.signal?.addEventListener("abort", () => active.destroy(abortError()), { once: true });
      const replying = readReply(active);
      replying.catch(() => {}); // surfaced by the await below; avoids an unhandled rejection if streaming fails first
      await streamFile(active, filePath);
      const reply = await replying;
      if (reply !== "OK") throw new Error(`Receiver rejected the file: ${reply.replace(/^FAIL /, "")}`);
      return { id, peer: target, name, size: info.size, sha256, durationMs: Date.now() - started };
    } finally {
      this.outgoing.delete(id);
      server?.close();
      socket?.destroy();
    }
  }

  async accept(id: string, directory: string, options: AcceptOptions = {}): Promise<TransferResult> {
    this.purge();
    const offer = this.offers.get(id);
    if (!offer) throw new Error(`No pending file offer with id ${id}`);
    this.offers.delete(id);
    const dir = resolve(directory);
    await mkdir(dir, { recursive: true });
    const finalPath = join(dir, offer.name);
    if (!finalPath.startsWith(dir + sep)) throw new Error("Refusing a destination outside the target directory");
    if (await lstat(finalPath).then(() => true, () => false)) throw new Error(`${finalPath} already exists; choose another directory`);
    const partPath = `${finalPath}.part-${id}`;
    const waitMs = options.timeoutMs ?? this.options.waitMs;
    const started = Date.now();

    let server: Server | undefined;
    let socket: Socket | undefined;
    try {
      let leftover: Buffer = Buffer.alloc(0);
      if (offer.endpoint) {
        socket = await guard(connectWithToken(offer.endpoint, this.options.idleMs), waitMs, `connection to ${offer.endpoint.host}:${offer.endpoint.port}`, options.signal);
      } else {
        const host = this.hostFor(options.host);
        const token = randomHex(16);
        const listener = await openListener(host, options.port ?? 0);
        server = listener.server;
        await this.deps.send(offer.from, `${FILE_PREFIX}LISTEN ${id} ${host} ${listener.port} ${token}`);
        const accepted = await guard(acceptVerified(server, token, this.options.idleMs), waitMs, `${offer.from} to connect`, options.signal);
        socket = accepted.socket;
        leftover = accepted.leftover;
      }
      const active = socket;
      options.signal?.addEventListener("abort", () => active.destroy(abortError()), { once: true });
      await receiveFile(active, leftover, offer, partPath);
      if (await lstat(finalPath).then(() => true, () => false)) throw new Error(`${finalPath} appeared during the transfer; not overwriting`);
      try { await rename(partPath, finalPath); }
      catch (error) { throw new Error(`Could not publish ${finalPath}: ${(error as Error).message}`); }
      await endWith(active, "OK\n");
      return { id, peer: offer.from, name: offer.name, size: offer.size, sha256: offer.sha256, durationMs: Date.now() - started, path: finalPath };
    } catch (error) {
      if (socket && !socket.destroyed) await endWith(socket, `FAIL ${(error as Error).message.replace(/[\r\n]+/g, " ").slice(0, 120)}\n`);
      await rm(partPath, { force: true });
      throw error;
    } finally {
      server?.close();
      socket?.destroy();
    }
  }

  async decline(id: string): Promise<void> {
    const offer = this.offers.get(id);
    if (!offer) throw new Error(`No pending file offer with id ${id}`);
    this.offers.delete(id);
    await this.deps.send(offer.from, `${FILE_PREFIX}DECLINE ${id}`);
  }

  private onOffer(from: string, words: string[]): ControlResult {
    const [, id, sizeText, sha256, name, host, portText, token] = words;
    const hasEndpoint = words.length === 8;
    if (words.length !== 5 && !hasEndpoint) return { kind: "handled" };
    const size = Number(sizeText);
    if (!ID_RE.test(id ?? "") || !/^\d{1,15}$/.test(sizeText ?? "") || size > this.options.maxBytes) return { kind: "handled" };
    if (!SHA_RE.test(sha256 ?? "") || !NAME_RE.test(name ?? "")) return { kind: "handled" };
    let endpoint: Endpoint | undefined;
    if (hasEndpoint) {
      const port = Number(portText);
      if (!validEndpoint(host!, port, token!)) return { kind: "handled" };
      endpoint = { host: host!, port, token: token! };
    }
    this.purge();
    if (this.offers.has(id!) || this.offers.size >= this.options.maxOffers) return { kind: "handled" };
    const offer: FileOffer = { id: id!, from, name: name!, size, sha256: sha256!, ...(endpoint ? { endpoint } : {}), time: new Date().toISOString() };
    this.offers.set(offer.id, offer);
    return { kind: "offer", offer };
  }

  private hostFor(requested: string | undefined): string {
    const host = requested ?? this.deps.localAddress();
    if (!host) throw new Error("Cannot determine a local address: not connected to IRC. Pass host.");
    if (isIP(host) === 0 || host === "0.0.0.0" || host === "::") throw new Error(`host must be one specific local IP address, got ${host}`);
    return host;
  }

  private purge(): void {
    const limit = Date.now() - this.options.offerTtlMs;
    for (const [id, offer] of this.offers) if (Date.parse(offer.time) < limit) this.offers.delete(id);
  }
}
