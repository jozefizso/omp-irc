// SPDX-License-Identifier: MIT
//
// Copyright 2026 Cisco Systems, Inc. and its affiliates
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const VERSION = "2.19.1";
const RELEASES: Record<string, { archive: string; sha256: string }> = {
  "win32-x64": {
    archive: "ergo-2.19.1-windows-x86_64.zip",
    sha256: "5397fac56f7110839aac2d8ab436279eb2a00dddfcc07032605b423e85ea40b6",
  },
  "linux-x64": {
    archive: "ergo-2.19.1-linux-x86_64.tar.gz",
    sha256: "c275f2de8e8eb074c38707136392290172400b5b78616cb9f660351527924b47",
  },
  "linux-arm64": {
    archive: "ergo-2.19.1-linux-arm64.tar.gz",
    sha256: "3f68fee0ede09eeeb205a553fe9727b409c686752e1cc2fea34ae2f9d64517fb",
  },
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function code(error: unknown): string | undefined {
  return object(error) && typeof error.code === "string" ? error.code : undefined;
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if (code(error) === "ENOENT") return false; throw error; }
}

async function download(path: string, archive: string, expectedHash: string): Promise<void> {
  const response = await fetch(`https://github.com/ergochat/ergo/releases/download/v${VERSION}/${archive}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) throw new Error(`Ergo download failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) { callback(new Error("Ergo release archive exceeds size limit")); return; }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.from(response.body), verify, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  if (hash.digest("hex") !== expectedHash) throw new Error("Ergo release checksum mismatch; archive will not be executed");
}

async function install(root: string): Promise<string> {
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`Automatic Ergo setup is unavailable for ${process.platform}/${process.arch}. Use /irc server-start with your own binary and config.`);
  const folder = release.archive.replace(/\.(zip|tar\.gz)$/, "");
  const directory = join(root, folder);
  const executable = process.platform === "win32" ? "ergo.exe" : "ergo";
  const binary = join(directory, executable);
  const marker = join(directory, ".verified-release");
  if (await exists(binary) && await exists(marker) && (await readFile(marker, "utf8")).trim() === release.sha256) return binary;
  if (await exists(directory)) throw new Error(`Incomplete Ergo installation at ${directory}. Move it aside before retrying /irc host.`);

  const lock = `${directory}.lock`;
  try { await mkdir(lock); }
  catch (error) {
    if (code(error) === "EEXIST") throw new Error(`Ergo setup is already in progress. Retry after it finishes. If interrupted, remove the stale lock directory: ${lock}`);
    throw error;
  }
  let staging: string | undefined;
  try {
    staging = await mkdtemp(join(root, ".install-"));
    const archive = join(staging, release.archive);
    await download(archive, release.archive, release.sha256);
    // Use Windows' ZIP-capable bsdtar, not a Git/MSYS GNU tar earlier on PATH.
    const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    try { await run(tar, ["-xf", archive, "-C", staging], { timeout: 30_000, windowsHide: true }); }
    catch (error) { throw new Error(`Unable to extract Ergo with ${tar}. Windows requires its built-in tar.exe; Linux requires tar on PATH. ${String(error)}`); }
    const extracted = join(staging, folder);
    await access(join(extracted, executable));
    if (process.platform !== "win32") await chmod(join(extracted, executable), 0o700);
    await writeFile(join(extracted, ".verified-release"), release.sha256, { mode: 0o600 });
    await rename(extracted, directory);
    return binary;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

/** Provision a pinned Ergo release and a private, loopback-only instance. Never edits user-supplied configs. */
export async function prepareErgo(options: { port: number; dataDir?: string }): Promise<{ binary: string; config: string; directory: string }> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Invalid IRC port");
  const root = resolve(options.dataDir ?? process.env.OMP_IRC_HOME ?? join(homedir(), ".omp", "irc"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const binary = await install(root);
  const directory = join(root, `server-${options.port}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const configPath = join(directory, "ircd.yaml");
  const listener = `127.0.0.1:${options.port}`;
  const lock = join(directory, ".setup-lock");
  try { await mkdir(lock); }
  catch (error) {
    if (code(error) === "EEXIST") throw new Error(`Ergo instance setup is already in progress. If interrupted, remove the stale lock directory: ${lock}`);
    throw error;
  }
  try {
    if (!await exists(configPath)) {
      const { stdout } = await run(binary, ["defaultconfig"], { cwd: directory, timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true });
      const config = Bun.YAML.parse(stdout);
      if (!object(config) || !object(config.server) || !object(config.network) || !object(config.datastore) || !object(config.languages)) throw new Error("Unexpected Ergo default configuration format");
      config.network.name = "OMP";
      config.server.name = "irc.omp.local";
      config.server.listeners = { [listener]: {} };
      config.server.motd = join(dirname(binary), "ergo.motd");
      config.languages.path = join(dirname(binary), "languages");
      config.datastore.path = "ircd.db";
      await writeFile(configPath, Bun.YAML.stringify(config), { flag: "wx", mode: 0o600 });
    }
    // Refuse unexpected edits rather than exposing an existing config or overwriting the user's changes.
    const config = Bun.YAML.parse(await readFile(configPath, "utf8"));
    if (!object(config) || !object(config.server) || !object(config.server.listeners)
      || Object.keys(config.server.listeners).length !== 1 || !object(config.server.listeners[listener])
      || Object.keys(config.server.listeners[listener]).length !== 0
      || !object(config.datastore) || config.datastore.path !== "ircd.db") {
      throw new Error(`Managed Ergo config was changed: ${configPath}. Use /irc server-start for custom configurations.`);
    }
    if (!await exists(join(directory, "ircd.db"))) {
      await run(binary, ["initdb", "--conf", configPath], { cwd: directory, timeout: 15_000, windowsHide: true });
    }
    return { binary, config: configPath, directory };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
