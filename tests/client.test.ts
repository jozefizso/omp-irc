// SPDX-License-Identifier: MIT
//
// Copyright 2026 Cisco Systems, Inc. and its affiliates
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { IrcClient } from "../src/client";

const servers: Server[] = [];
const clients: IrcClient[] = [];

async function fakeServer(onConnection: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(onConnection);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return { server, port: address.port };
}
function client(onMessage?: ConstructorParameters<typeof IrcClient>[0]): IrcClient {
  const instance = new IrcClient(onMessage);
  clients.push(instance);
  return instance;
}
function lines(socket: Socket, callback: (line: string) => void): void {
  let pending = "";
  socket.on("data", (data) => {
    pending += data.toString("utf8");
    for (;;) {
      const end = pending.indexOf("\r\n");
      if (end < 0) break;
      callback(pending.slice(0, end));
      pending = pending.slice(end + 2);
    }
  });
}
async function start(client: IrcClient, port: number): Promise<void> {
  await client.connect({ host: "127.0.0.1", port, nick: "tester", channel: "#room" });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((value) => value.disconnect()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("IrcClient", () => {
  test("waits for self JOIN, answers PING, and delivers non-self PRIVMSG only", async () => {
    const received: string[] = [];
    const messages: unknown[] = [];
    const pong = Promise.withResolvers<void>();
    const { port } = await fakeServer((socket) => {
      lines(socket, (line) => {
        received.push(line);
        if (line === "PONG :token") pong.resolve();
        if (line.startsWith("USER ")) socket.write(":irc 001 tester :welcome\r\n");
        if (line === "JOIN #room") socket.write("PING :token\r\n:tester!u@h JOIN :#room\r\n:alice!u@h PRIVMSG #room :hi\r\n:tester!u@h PRIVMSG #room :self\r\n");
      });
    });
    const instance = client((message) => messages.push(message));
    await start(instance, port);
    await pong.promise;
    expect(received).toContain("PONG :token");
    expect(instance.status()).toMatchObject({ connected: true, joined: true, channel: "#room" });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from: "alice", target: "#room", text: "hi" });
  });

  test("handles fragmented UTF-8 protocol lines", async () => {
    const messages: unknown[] = [];
    const received = Promise.withResolvers<void>();
    const { port } = await fakeServer((socket) => {
      lines(socket, (line) => {
        if (line.startsWith("USER ")) socket.write(":irc 001 tester :welcome\r\n");
        if (line === "JOIN #room") {
          const bytes = Buffer.from(":tester!u@h JOIN :#room\r\n:alice!u@h PRIVMSG #room :café\r\n");
          socket.write(bytes.subarray(0, bytes.indexOf(Buffer.from("é")) + 1));
          socket.write(bytes.subarray(bytes.indexOf(Buffer.from("é")) + 1));
        }
      });
    });
    const instance = client((message) => { messages.push(message); received.resolve(); });
    await start(instance, port);
    await received.promise;
    expect(messages).toMatchObject([{ text: "café" }]);
  });


  test("splits multiline and long UTF-8 outbound messages safely", async () => {
    const sent: string[] = [];
    const received = Promise.withResolvers<void>();
    const { port } = await fakeServer((socket) => {
      lines(socket, (line) => {
        if (line.startsWith("USER ")) socket.write(":irc 001 tester :welcome\r\n");
        if (line === "JOIN #room") socket.write(":tester!u@h JOIN :#room\r\n");
        if (line.startsWith("PRIVMSG ")) {
          sent.push(line.slice(line.indexOf(" :") + 2));
          if (sent.length === 3) received.resolve();
        }
      });
    });
    const instance = client();
    await start(instance, port);
    await instance.send("#room", `${"é".repeat(250)}\nlast`);
    await received.promise;
    expect(sent.map((part) => Buffer.byteLength(part, "utf8"))).toEqual([400, 100, 4]);
    expect(sent.join("")).toBe(`${"é".repeat(250)}last`);
  });

  test("rejects handshake nickname errors and server ERROR without hanging", async () => {
    const { port } = await fakeServer((socket) => {
      lines(socket, (line) => { if (line.startsWith("USER ")) socket.write(":irc 433 * tester :in use\r\n"); });
    });
    await expect(start(client(), port)).rejects.toThrow(/rejected handshake/);

    const { port: errorPort } = await fakeServer((socket) => {
      lines(socket, (line) => { if (line.startsWith("USER ")) socket.write("ERROR :service unavailable\r\n"); });
    });
    await expect(start(client(), errorPort)).rejects.toThrow(/service unavailable/);
  });

  test("keeps a joined connection usable after a message destination error", async () => {
    const processed = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<string>();
    const { port } = await fakeServer((socket) => {
      socket.once("close", processed.resolve);
      lines(socket, (line) => {
        if (line.startsWith("USER ")) socket.write(":irc 001 tester :welcome\r\n");
        if (line === "JOIN #room") socket.write(":tester!u@h JOIN :#room\r\n");
        if (line === "PRIVMSG #missing :hello") socket.write(":irc 403 tester #missing :No such channel\r\nPING :after-error\r\n");
        if (line === "PONG :after-error") processed.resolve();
        if (line === "PRIVMSG #room :still here") delivered.resolve(line);
      });
    });
    const instance = client();
    await start(instance, port);
    await instance.send("#missing", "hello");
    await processed.promise;
    expect(instance.status()).toMatchObject({ connected: true, joined: true, lastServerError: { code: "403" } });
    await instance.send("#room", "still here");
    expect(await delivered.promise).toBe("PRIVMSG #room :still here");
  });

  test("rejects injection/invalid targets and reports clean disconnect", async () => {
    const { port } = await fakeServer((socket) => {
      lines(socket, (line) => {
        if (line.startsWith("USER ")) socket.write(":irc 001 tester :welcome\r\n");
        if (line === "JOIN #room") socket.write(":tester!u@h JOIN :#room\r\n");
      });
    });
    const instance = client();
    await start(instance, port);
    await expect(instance.send("#room\r\nQUIT", "bad")).rejects.toThrow();
    await expect(instance.send("#room", "bad\rQUIT")).rejects.toThrow();
    await expect(instance.send("#room", "bad\u0000text")).rejects.toThrow();
    await expect(instance.send("#bad target", "bad")).rejects.toThrow(/target/);
    await instance.disconnect();
    expect(instance.status()).toMatchObject({ connected: false, joined: false });
  });
  test("rejects line breaks in handshake credentials before connecting", async () => {
    const instance = client();
    await expect(instance.connect({
      host: "127.0.0.1", port: 1, nick: "tester", channel: "#room", password: "first\nsecond",
    })).rejects.toThrow(/password.*line breaks/);
  });
  test("can reconnect after server failure and cancels a pending connect on disconnect", async () => {
    let connectionCount = 0;
    const { promise: thirdHandshake, resolve: sawThirdHandshake } = Promise.withResolvers<void>();
    const { port } = await fakeServer((socket) => {
      connectionCount++;
      lines(socket, (line) => {
        if (line.startsWith("USER ")) {
          if (connectionCount === 3) { sawThirdHandshake(); return; }
          if (connectionCount === 1) socket.write("ERROR :first connection failed\r\n");
          else socket.write(":irc 001 tester :welcome\r\n");
        }
        if (line === "JOIN #room") socket.write(":tester!u@h JOIN :#room\r\n");
      });
    });
    const instance = client();
    await expect(start(instance, port)).rejects.toThrow(/first connection failed/);
    await start(instance, port);
    expect(instance.status()).toMatchObject({ connected: true, joined: true });
    await instance.disconnect();

    const pending = client();
    const connection = pending.connect({ host: "127.0.0.1", port, nick: "tester", channel: "#room" });
    const outcome = connection.then(() => "unexpected connection", (error: Error) => error.message);
    await thirdHandshake;
    await pending.disconnect();
    expect(await outcome).toMatch(/disconnected before JOIN/);
  });
});
