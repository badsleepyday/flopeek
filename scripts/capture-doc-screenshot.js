"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SCREENSHOT_ROOT = path.join(ROOT, "docs", "assets", "screenshots");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function browserPath() {
  const candidates = process.platform === "win32"
    ? [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("Chrome or Edge is required to capture documentation screenshots.");
  return found;
}

function safeOutput(value) {
  const output = path.resolve(ROOT, value || "");
  const relation = path.relative(SCREENSHOT_ROOT, output);
  if (!value || relation.startsWith("..") || path.isAbsolute(relation) || path.extname(output).toLowerCase() !== ".png") throw new Error("--output must be a PNG inside docs/assets/screenshots.");
  return output;
}

function loopbackUrl(value) {
  const parsed = new URL(value || "");
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)) throw new Error("--url must be a local HTTP URL.");
  return parsed.toString();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExit(child, milliseconds) {
  if (child.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(milliseconds),
  ]);
}

async function waitForFile(file, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
    await delay(100);
  }
  throw new Error("Browser DevTools endpoint did not become ready.");
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method && this.events.has(message.method)) {
        const listeners = this.events.get(message.method);
        this.events.delete(message.method);
        listeners.forEach((resolve) => resolve(message.params));
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      if (!this.events.has(method)) this.events.set(method, []);
      this.events.get(method).push(resolve);
    });
  }

  close() {
    this.socket.close();
  }
}

async function main() {
  const url = loopbackUrl(argument("--url"));
  const output = safeOutput(argument("--output"));
  const click = argument("--click");
  const level = argument("--level");
  const keyboardFlow = process.argv.includes("--keyboard-flow");
  const viewportWidth = Number(argument("--width") || 1600);
  const viewportHeight = Number(argument("--height") || 1000);
  const flowId = argument("--flow-id");
  const fromVersion = Number(argument("--from-version"));
  const toVersion = Number(argument("--to-version"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-doc-browser-"));
  const activePortFile = path.join(profile, "DevToolsActivePort");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const child = spawn(browserPath(), [
    "--headless=new",
    "--disable-gpu",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=PaintHolding,PaintHoldingCrossOrigin",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  let client;
  let browserClient;
  try {
    if (level && !["domain", "feature", "component", "symbol"].includes(level)) throw new Error("--level must be domain, feature, component, or symbol.");
    if (!Number.isInteger(viewportWidth) || !Number.isInteger(viewportHeight) || viewportWidth < 320 || viewportWidth > 3200 || viewportHeight < 320 || viewportHeight > 2400) throw new Error("--width and --height must be integers from 320 through 3200 and 2400 respectively.");
    await waitForFile(activePortFile);
    const [port, browserPathname] = fs.readFileSync(activePortFile, "utf8").trim().split(/\r?\n/u);
    browserClient = new CdpClient(`ws://127.0.0.1:${port}${browserPathname}`);
    await browserClient.connect();
    const pageResponse = await fetch(`http://127.0.0.1:${port}/json/new?about%3Ablank`, { method: "PUT" });
    if (!pageResponse.ok) throw new Error(`Unable to create capture page (${pageResponse.status}).`);
    const page = await pageResponse.json();
    client = new CdpClient(page.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", { width: viewportWidth, height: viewportHeight, deviceScaleFactor: 1, mobile: false });
    const loaded = client.once("Page.loadEventFired");
    await client.send("Page.navigate", { url });
    await loaded;
    await delay(1800);
    await client.send("Runtime.evaluate", { expression: `(() => { const root = document.querySelector("#root-input"); if (root) root.value = "D:\\\\work\\\\example-project"; return true; })()` });
    if (level) {
      const result = await client.send("Runtime.evaluate", {
        expression: `(() => { const select = document.querySelector("#level-filter"); if (!select) throw new Error("Level selector not found"); select.value = ${JSON.stringify(level)}; select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(`Unable to set capture level ${level}.`);
      await delay(1800);
    }
    if (keyboardFlow) {
      const focusResult = await client.send("Runtime.evaluate", {
        expression: `(() => { const flow = document.querySelector("#flow-list button"); if (!flow) throw new Error("Flow button not found"); flow.focus(); return document.activeElement === flow; })()`,
        returnByValue: true,
      });
      if (!focusResult.result?.value) throw new Error("Unable to focus a static flow button for keyboard capture.");
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await delay(1200);
      const activated = await client.send("Runtime.evaluate", { expression: "Boolean(document.querySelector('#inspector .flow-lens-steps'))", returnByValue: true });
      if (!activated.result?.value) throw new Error("Keyboard activation did not open the selected Flow Lens.");
    }
    if (click) {
      const expression = `(() => { const target = document.querySelector(${JSON.stringify(click)}); if (!target) throw new Error("Capture target not found"); target.click(); return true; })()`;
      const result = await client.send("Runtime.evaluate", { expression, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`Unable to click ${click}.`);
      await delay(1800);
    }
    if (flowId) {
      if (!Number.isSafeInteger(fromVersion) || !Number.isSafeInteger(toVersion)) throw new Error("--flow-id requires integer --from-version and --to-version values.");
      const expression = `openFlowComparison(${JSON.stringify(flowId)}, ${fromVersion}, ${toVersion}).then(() => true)`;
      const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`Unable to open Flow Lens comparison for ${flowId}.`);
      await delay(1800);
    }
    await client.send("Page.bringToFront");
    await client.send("Runtime.evaluate", { expression: "document.documentElement.dataset.capture = 'true'; window.scrollTo(0, 1); document.body.getBoundingClientRect(); window.scrollTo(0, 0); document.body.getBoundingClientRect();" });
    await delay(600);
    const screenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(output, Buffer.from(screenshot.data, "base64"));
    console.log(`${path.relative(ROOT, output)} (${fs.statSync(output).size} bytes)`);
  } finally {
    const closeBrowser = browserClient ? browserClient.send("Browser.close").catch(() => {}) : Promise.resolve();
    await Promise.race([closeBrowser, delay(1000)]);
    await waitForExit(child, 2000);
    client?.close();
    browserClient?.close();
    if (!child.killed) child.kill();
    await waitForExit(child, 1000);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); break; }
      catch { await delay(200); }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
