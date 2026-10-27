// SPDX-License-Identifier: MIT
//
// Copyright 2026 Cisco Systems, Inc. and its affiliates
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";

export interface ErgoServerStatus {
  state: "stopped" | "starting" | "running" | "stopping" | "failed";
  pid?: number;
  error?: string;
  logs: string;
}

const STARTUP_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 1_900;
const LOG_LIMIT = 16 * 1024;

/** Owns one Ergo process; each instance has independent lifecycle state. */
export class ErgoServer {
  private child?: ChildProcess;
  private state: ErgoServerStatus["state"] = "stopped";
  private error?: string;
  private logs = "";
  private startPromise?: Promise<object>;

  start(options: { binary: string; config: string }): Promise<object> {
    if (this.state === "running") return Promise.resolve(this.status());
    if (this.startPromise) return this.startPromise;
    if (this.state === "stopping") return Promise.reject(new Error("Ergo is stopping"));
    this.state = "starting";
    this.error = undefined;
    this.logs = "";
    this.startPromise = this.startProcess(options).finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private startProcess(options: { binary: string; config: string }): Promise<object> {
    const config = resolve(options.config);
    const child = spawn(options.binary, ["run", "--conf", config], {
      cwd: dirname(config), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const { promise, resolve: ready, reject } = Promise.withResolvers<object>();
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.error = message;
      this.state = "failed";
      child.kill();
      reject(new Error(`${message}${this.logs ? `\nErgo output:\n${this.logs}` : ""}`));
    };
    const observe = (chunk: Buffer) => {
      this.logs = (this.logs + chunk.toString("utf8")).slice(-LOG_LIMIT);
      // Upstream irc/server.go logs "Server running" only after setupListeners succeeds.
      if (!settled && /\bServer running\b/.test(this.logs)) {
        settled = true;
        clearTimeout(timer);
        this.state = "running";
        ready(this.status());
      }
    };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);
    child.once("error", (error) => fail(`Unable to start Ergo: ${error.message}`));
    child.once("exit", (code, signal) => {
      const message = `Ergo exited${code === null ? ` (signal ${signal ?? "unknown"})` : ` with code ${code}`}`;
      if (!settled) fail(message);
      else if (this.child === child && this.state !== "stopping") {
        this.state = "failed";
        this.error = message;
      }
      if (this.child === child && this.state === "stopping") this.state = "stopped";
    });
    timer = setTimeout(() => fail(`Ergo did not report readiness within ${STARTUP_TIMEOUT_MS}ms`), STARTUP_TIMEOUT_MS);
    return promise;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.state = "stopped";
      this.child = undefined;
      return;
    }
    this.state = "stopping";
    const { promise: exited, resolve } = Promise.withResolvers<void>();
    child.once("exit", resolve);
    const forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_500);
    const shutdownTimer = setTimeout(resolve, STOP_TIMEOUT_MS);
    child.kill("SIGTERM");
    await exited;
    clearTimeout(forceTimer);
    clearTimeout(shutdownTimer);
    if (this.child === child) {
      if (child.exitCode !== null || child.signalCode !== null) {
        this.child = undefined;
        this.state = "stopped";
      } else {
        this.state = "failed";
        this.error = "Ergo process did not exit after termination signals";
      }
    }
  }

  status(): ErgoServerStatus {
    return {
      state: this.state,
      ...(this.child?.pid === undefined ? {} : { pid: this.child.pid }),
      ...(this.error === undefined ? {} : { error: this.error }),
      logs: this.logs,
    };
  }
}
