// SPDX-License-Identifier: MIT
//
// Copyright 2026 Cisco Systems, Inc. and its affiliates
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const supported = (process.platform === "win32" && process.arch === "x64")
  || (process.platform === "linux" && ["x64", "arm64"].includes(process.arch));

test.skipIf(!supported)("rejects an unverified release before extraction and removes setup locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-irc-integrity-"));
  try {
    // A child isolates the network replacement from other protocol tests and sessions.
    const script = `
      import { prepareErgo } from ${JSON.stringify(new URL("../src/setup.ts", import.meta.url).href)};
      globalThis.fetch = async () => new Response("not the official release archive");
      try {
        await prepareErgo({ port: 16667, dataDir: ${JSON.stringify(directory)} });
        process.exitCode = 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("checksum mismatch")) throw error;
      }
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
    const exit = await child.exited;
    expect(exit, await new Response(child.stderr).text()).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
