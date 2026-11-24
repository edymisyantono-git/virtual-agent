// Browser check for QA: opens a page in headless Edge/Chrome over the DevTools protocol and reports what a
// person would see: console errors, uncaught exceptions, failed requests (missing assets), title, canvas and
// WebGL, a frame-rate estimate, and screenshots before and after a click / Enter / Space.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BROWSERS = [
  process.env.VC_PDF_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].filter(Boolean);

const wait = ms => new Promise(r => setTimeout(r, ms));

export async function browse({ url, outDir, settleMs = 4000 }) {
  const exe = BROWSERS.find(p => fs.existsSync(p));
  if (!exe) return { ok: false, error: "No Edge or Chrome found for the browser check." };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vc-qa-"));
  const proc = spawn(exe, ["--headless=new", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  const report = { ok: true, url, title: "", console: [], exceptions: [], failed: [], canvas: [], webgl: null, fps: null, text: "", screenshots: [] };
  let ws;
  try {
    // The browser writes its DevTools port into the profile once it is up.
    let port;
    for (let i = 0; i < 60 && !port; i++) {
      await wait(250);
      try { port = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim(); } catch { /* not yet */ }
    }
    if (!port) throw new Error("The browser did not start.");
    let target;
    for (let i = 0; i < 40 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page"); } catch { /* not yet */ }
      if (!target) await wait(250);
    }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("DevTools connection failed.")); });
    let n = 0; const pending = {};
    const requests = {};
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; return; }
      const p = m.params || {};
      if (m.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning" || p.type === "assert"))
        report.console.push(`${p.type}: ${(p.args || []).map(a => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
      else if (m.method === "Runtime.exceptionThrown") {
        const d = p.exceptionDetails || {};
        report.exceptions.push(`${d.exception?.description || d.text || "error"}`.split("\n").slice(0, 3).join(" | ").slice(0, 400) + (d.url ? ` (${d.url}:${d.lineNumber})` : ""));
      }
      else if (m.method === "Log.entryAdded" && p.entry?.level === "error") report.console.push(`error: ${p.entry.text}`.slice(0, 300));
      else if (m.method === "Network.requestWillBeSent") requests[p.requestId] = p.request?.url;
      else if (m.method === "Network.responseReceived" && p.response?.status >= 400) report.failed.push(`${p.response.status} ${p.response.url}`);
      else if (m.method === "Network.loadingFailed" && !p.canceled) report.failed.push(`${p.errorText} ${requests[p.requestId] || ""}`);
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++n; pending[id] = m => m.error ? rej(new Error(m.error.message)) : res(m.result); ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJs = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
    const shot = async name => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, name);
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      report.screenshots.push(file);
    };

    for (const d of ["Page", "Runtime", "Log", "Network"]) await send(`${d}.enable`);
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url });
    await wait(settleMs);
    const info = await evalJs(`(async () => {
      const c = [...document.querySelectorAll("canvas")].map(x => x.width + "x" + x.height);
      let gl = null; try { const t = document.createElement("canvas"); gl = t.getContext("webgl2") ? "webgl2" : t.getContext("webgl") ? "webgl" : "none"; } catch { gl = "error"; }
      const frames = await new Promise(r => { let k = 0; const t0 = performance.now(); const f = () => { k++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(k / 2); }; requestAnimationFrame(f); });
      return { title: document.title, canvas: c, webgl: gl, fps: Math.round(frames), text: (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400) };
    })()`) || {};
    Object.assign(report, { title: info.title || "", canvas: info.canvas || [], webgl: info.webgl, fps: info.fps, text: info.text || "" });
    await shot("screen-1-loaded.png");
    // Try to start whatever the page offers: click the middle, then Enter and Space.
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 640, y: 400, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 640, y: 400, button: "left", clickCount: 1 });
    for (const key of [["Enter", 13], [" ", 32]]) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: key[0], code: key[0] === " " ? "Space" : "Enter", windowsVirtualKeyCode: key[1], text: key[0] === " " ? " " : "\r" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: key[0], code: key[0] === " " ? "Space" : "Enter", windowsVirtualKeyCode: key[1] });
    }
    await wait(2500);
    await shot("screen-2-after-input.png");
  } catch (e) {
    report.ok = false; report.error = e.message;
  } finally {
    try { ws?.close(); } catch { /* closed */ }
    try { proc.kill(); } catch { /* gone */ }
    await wait(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked; temp dir */ }
  }
  report.console = [...new Set(report.console)].slice(0, 30);
  report.exceptions = [...new Set(report.exceptions)].slice(0, 20);
  report.failed = [...new Set(report.failed)].slice(0, 40);
  return report;
}
