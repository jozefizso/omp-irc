// SPDX-License-Identifier: MIT
//
// Copyright 2026 Cisco Systems, Inc. and its affiliates
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import { connect as connectNet, isIP, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { readFile } from "node:fs/promises";

export interface ConnectOptions {
  host: string;
  port: number;
  nick: string;
  channel: string;
  tls?: boolean;
  caFile?: string;
  password?: string;
}

export interface IrcMessage {
  from: string;
  target: string;
  text: string;
  time: string;
}

type IrcSocket = Socket | TLSSocket;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_READ_BUFFER = 64 * 1024;
const MAX_PAYLOAD_BYTES = 400;
const NICK_RE = /^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,30}$/;
const CHANNEL_RE = /^[#&+!][^\x00\x07\r\n ,:]{1,199}$/;

function rejectInjection(value: string, field: string): void {
  if (/[\x00\r\n]/.test(value)) throw new Error(`${field} must not contain NUL or line breaks`);
}
function validTarget(target: string): boolean {
  return NICK_RE.test(target) || CHANNEL_RE.test(target);
}
function fold(value: string): string {
  return value.toLowerCase().replace(/[\[\]\\^]/g, (c) => ({ "[": "{", "]": "}", "\\": "|", "^": "~" })[c]!);
}
function splitPayload(text: string, maxBytes: number): string[] {
  const result: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let part = "";
    let bytes = 0;
    for (const cp of line) {
      const n = Buffer.byteLength(cp, "utf8");
      if (bytes + n > maxBytes) {
        result.push(part);
        part = "";
        bytes = 0;
      }
      part += cp;
      bytes += n;
    }
    result.push(part);
  }
  return result;
}

export class IrcClient {
  private socket?: IrcSocket;
  private callback?: (message: IrcMessage) => void;
  private options?: ConnectOptions;
  private joined = false;
  private connecting = false;
  private connected = false;
  private lastServerError?: { code: string; message: string };
  private buffer: Buffer = Buffer.alloc(0);
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private connectReject?: (error: Error) => void;
  private connectResolve?: () => void;
  private closePromise?: Promise<void>;

  constructor(onMessage?: (message: IrcMessage) => void) { this.callback = onMessage; }

  async connect(options: ConnectOptions): Promise<void> {
    if (this.socket || this.connecting) throw new Error("IRC client is already connected or connecting");
    rejectInjection(options.host, "host");
    rejectInjection(options.nick, "nickname");
    rejectInjection(options.channel, "channel");
    if (options.password !== undefined) rejectInjection(options.password, "password");
    if (!options.host || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Invalid IRC host or port");
    if (!NICK_RE.test(options.nick)) throw new Error("Invalid IRC nickname");
    if (!CHANNEL_RE.test(options.channel)) throw new Error("Invalid IRC channel");
    this.options = { ...options };
    this.connecting = true;
    this.lastServerError = undefined;
    let ca: Buffer | undefined;
    try { if (options.caFile) ca = await readFile(options.caFile); }
    catch (error) { this.connecting = false; this.options = undefined; throw error; }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.connectResolve = resolve;
    this.connectReject = reject;
    const socket = options.tls
      ? connectTls({
          host: options.host,
          port: options.port,
          ...(ca ? { ca } : {}),
          ...(!isIP(options.host) ? { servername: options.host } : {}),
          rejectUnauthorized: true,
        })
      : connectNet({ host: options.host, port: options.port });
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => this.fail(new Error("IRC handshake timed out")), HANDSHAKE_TIMEOUT_MS);
    socket.on("data", (data) => {
      if (this.socket !== socket || data.length === 0) return;
      this.receive(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    socket.on("error", (error) => {
      if (this.socket === socket) this.fail(error);
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      if (this.connectReject) {
        this.fail(new Error("IRC connection closed before channel JOIN"));
        return;
      }
      this.clearTimer();
      this.connected = false;
      this.joined = false;
      this.connecting = false;
      this.socket = undefined;
      this.buffer = Buffer.alloc(0);
    });
    const beginHandshake = () => {
      if (this.socket !== socket) return;
      if (options.password) this.writeLine(`PASS :${options.password}`);
      this.writeLine(`NICK ${options.nick}`);
      this.writeLine(`USER ${options.nick} 0 * :omp IRC client`);
    };
    socket.once(options.tls ? "secureConnect" : "connect", beginHandshake);
    return promise;
  }

  async send(target: string, text: string): Promise<void> {
    rejectInjection(target, "target");
    if (/\x00/.test(text) || /\r(?!\n)/.test(text)) throw new Error("Message must not contain NUL or bare carriage returns");
    if (!validTarget(target)) throw new Error("Invalid IRC target");
    if (typeof text !== "string") throw new Error("Message must be a string");
    if (!this.connected || !this.socket || this.socket.destroyed) throw new Error("IRC client is not connected");
    const prefix = `PRIVMSG ${target} :`;
    const maxBytes = Math.min(MAX_PAYLOAD_BYTES, 510 - Buffer.byteLength(prefix, "utf8"));
    for (const part of splitPayload(text, maxBytes)) await this.writeLineAsync(`${prefix}${part}`);
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.clearTimer();
    this.connecting = false;
    this.connected = false;
    this.joined = false;
    const reject = this.connectReject;
    this.connectReject = undefined;
    this.connectResolve = undefined;
    reject?.(new Error("IRC client disconnected before JOIN"));
    this.socket = undefined;
    this.options = undefined;
    this.buffer = Buffer.alloc(0);
    if (socket.destroyed) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1000);
    timer.unref();
    socket.once("close", () => { clearTimeout(timer); resolve(); });
    socket.end();
    this.closePromise = promise;
    await this.closePromise;
    this.closePromise = undefined;
  }

  status(): object {
    return { connected: this.connected, connecting: this.connecting, joined: this.joined, channel: this.joined ? this.options?.channel : undefined, nick: this.options?.nick, ...(this.lastServerError ? { lastServerError: { ...this.lastServerError } } : {}) };
  }

  /** Local address of the IRC connection, i.e. the interface the peer can reach us on. */
  localAddress(): string | undefined { return this.socket?.localAddress; }

  /** Our current nickname while connected. */
  nickname(): string | undefined { return this.connected ? this.options?.nick : undefined; }

  private receive(data: Buffer): void {
    if (data.length === 0) return;
    if (this.buffer.length + data.length > MAX_READ_BUFFER) {
      this.fail(new Error("IRC read buffer limit exceeded"));
      return;
    }
    this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) break;
      const line = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 2);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const match = /^(?:@[^ ]+ )?(?::([^ ]+) )?([^ ]+)(?: (.*))?$/.exec(line);
    if (!match) return;
    const prefix = match[1] ?? "";
    const command = match[2]!.toUpperCase();
    const params = (match[3] ?? "").split(" ");
    if (command === "PING") { this.writeLine(`PONG ${params.at(-1) ?? ""}`); return; }
    if (command === "ERROR") { this.fail(new Error(`IRC server error: ${params.join(" ").replace(/^:/, "")}`)); return; }
    if (!this.connecting && /^[45]\d{2}$/.test(command)) {
      this.lastServerError = { code: command, message: params.join(" ") };
      return;
    }
    if (/^(432|433|436|437|451|461|464|403|471|473|474|475|476|477|489)$/.test(command)) {
      this.fail(new Error(`IRC server rejected handshake or JOIN (${command}): ${params.join(" ")}`));
      return;
    }
    const nick = prefix.split("!")[0]!;
    if (command === "001" && this.connecting) {
      this.connected = true;
      this.writeLine(`JOIN ${this.options!.channel}`);
      return;
    }
    if (command === "JOIN" && this.options && fold(nick) === fold(this.options.nick)) {
      const channel = (params[0] ?? "").replace(/^:/, "");
      if (fold(channel) === fold(this.options.channel)) {
        this.joined = true;
        this.connecting = false;
        this.clearTimer();
        const resolve = this.connectResolve;
        this.connectResolve = undefined;
        this.connectReject = undefined;
        resolve?.();
      }
      return;
    }
    if (command === "PRIVMSG" && this.callback && this.options && fold(nick) !== fold(this.options.nick) && params.length >= 2) {
      this.callback({ from: nick, target: params[0]!, text: params.slice(1).join(" ").replace(/^:/, ""), time: new Date().toISOString() });
    }
  }

  private writeLine(line: string): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    socket.write(`${line}\r\n`);
  }
  private writeLineAsync(line: string): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("IRC connection is closed"));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    socket.write(`${line}\r\n`, (error) => error ? reject(error) : resolve());
    return promise;
  }
  private fail(error: Error): void {
    this.clearTimer();
    this.connected = false;
    this.joined = false;
    this.connecting = false;
    const reject = this.connectReject;
    this.connectReject = undefined;
    this.connectResolve = undefined;
    this.options = undefined;
    this.buffer = Buffer.alloc(0);
    reject?.(error);
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
  }
  private clearTimer(): void { if (this.handshakeTimer) clearTimeout(this.handshakeTimer); this.handshakeTimer = undefined; }
}
