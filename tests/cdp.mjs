// Tiny Chrome DevTools Protocol client for the end-to-end test (no dependencies; Node 22+).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ].find((p) => fs.existsSync(p));

// Starts Chrome with a throwaway profile. --enable-unsafe-extension-debugging allows Extensions.loadUnpacked.
// Chrome picks a free debugging port and reports it in DevToolsActivePort, so parallel or back-to-back runs don't collide.
export async function launchChrome({ headless = true, chromePath = DEFAULT_CHROME } = {}) {
  if (!chromePath) throw new Error("Chrome not found. Set CHROME_PATH.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lra-chrome-"));
  const child = spawn(
    chromePath,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      ...(headless ? ["--headless=new"] : []),
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(150);
    try {
      const [port, wsPath] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").trim().split("\n");
      if (port && wsPath) wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
    } catch {}
  }
  if (!wsUrl) {
    child.kill();
    throw new Error("Chrome didn't start");
  }
  const cdp = await CDP.connect(wsUrl);
  const close = async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await cdp.send("Browser.close").catch(() => {});
    await Promise.race([exited, sleep(5000)]);
    child.kill();
    // Chrome's helper processes can hold profile files for a moment after it exits. Removing the
    // temp profile is housekeeping, so it's retried and never allowed to fail the run.
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        return;
      } catch {
        await sleep(300);
      }
    }
  };
  return { cdp, close };
}

export class CDP {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new CDP(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return {
      id: sessionId,
      send: (method, params) => this.send(method, params, sessionId),
      on: (method, fn) => this.on((m) => m.sessionId === sessionId && m.method === method && fn(m.params)),
      evaluate: async (expression) => {
        const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
    };
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 10000, interval = 150, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? ` (${last.message})` : ""}`);
}
