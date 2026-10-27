// SPDX-License-Identifier: MIT
//
// Copyright 2026 Cisco Systems, Inc. and its affiliates
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErgoServer } from "../src/server";

const config = join(tmpdir(), "omp-ergo-test.yaml");

async function fakeErgo(body: string): Promise<{ binary: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "omp-ergo-test-"));
  const binary = join(directory, "ergo");
  await writeFile(binary, `#!/bin/sh\n${body}\n`);
  await chmod(binary, 0o700);
  return { binary, directory };
}

describe("ErgoServer", () => {
  test("reports executable spawn errors and retains failed status", async () => {
    const server = new ErgoServer();
    await expect(server.start({ binary: join(tmpdir(), "missing-ergo-binary"), config })).rejects.toThrow("Unable to start Ergo");
    expect(server.status().state).toBe("failed");
    await server.stop();
    expect(server.status().state).toBe("stopped");
  });

  test("reports an early executable exit with captured output", async () => {
    const server = new ErgoServer();
    await expect(server.start({ binary: process.execPath, config })).rejects.toThrow("Ergo exited");
    expect(server.status().state).toBe("failed");
    await server.stop();
  });

  test.skipIf(process.platform === "win32")("times out and terminates a process without a readiness log", async () => {
    const fixture = await fakeErgo("echo waiting; exec sleep 30");
    const server = new ErgoServer();
    try {
      await expect(server.start({ binary: fixture.binary, config })).rejects.toThrow("did not report readiness");
      expect(server.status().state).toBe("failed");
    } finally {
      await server.stop();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 20_000);

  test.skipIf(process.platform === "win32")("waits for a ready process to exit on stop", async () => {
    const fixture = await fakeErgo("echo 'Server running'; trap 'exit 0' TERM; while :; do sleep 1; done");
    const server = new ErgoServer();
    try {
      await server.start({ binary: fixture.binary, config });
      expect(server.status().state).toBe("running");
      await server.stop();
      expect(server.status().state).toBe("stopped");
    } finally {
      await server.stop();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
