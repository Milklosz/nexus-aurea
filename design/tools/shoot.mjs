// Renders VELORA screens with headless Edge over the DevTools protocol (no extra dependencies).
// Usage: node design/tools/shoot.mjs <url> <outDir> [--sizes 1920x1080,3840x2160] [--steps "name:key,key|name2:key"]
//   Each step list entry presses the given keys (e.g. ArrowRight,ArrowRight,Enter) and then writes <outDir>/<name>-<w>x<h>.png.
// Example: node design/tools/shoot.mjs http://127.0.0.1:1431/ design/screens --steps "home:|focus3:ArrowRight,ArrowRight,ArrowRight"
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [url, outDir, ...rest] = process.argv.slice(2);
if (!url || !outDir) { console.error("usage: shoot.mjs <url> <outDir> [--sizes WxH,..] [--steps ...]"); process.exit(2); }
const opt = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
const sizes = opt("--sizes", "1920x1080,3840x2160").split(",").map((s) => s.split("x").map(Number));
const steps = opt("--steps", "home:").split("|").map((s) => { const [name, keys = ""] = s.split(":"); return { name, keys: keys.split(",").filter(Boolean) }; });
const edge = process.env.EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const port = 9300 + Math.floor(Math.random() * 400);
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? ".", "velora-shoot-"));
const proc = spawn(edge, [`--remote-debugging-port=${port}`, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(p) { for (let i = 0; i < 50; i++) { try { return await (await fetch(`http://127.0.0.1:${port}${p}`)).json(); } catch { await sleep(200); } } throw new Error("edge did not start"); }
try {
  const targets = await json("/json");
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => d.error ? rej(new Error(d.error.message)) : res(d.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  const keyInfo = { ArrowRight: [39], ArrowLeft: [37], ArrowUp: [38], ArrowDown: [40], Enter: [13], Escape: [27], Backspace: [8], Tab: [9] };
  const press = async (key) => { const [code] = keyInfo[key] ?? [0]; const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }; await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }); await send("Input.dispatchKeyEvent", { type: "keyUp", ...base }); await sleep(450); };
  for (const [w, h] of sizes) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url });
    await sleep(2500);
    for (const step of steps) {
      for (const k of step.keys) await press(k);
      await sleep(900);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const file = path.join(outDir, `${step.name}-${w}x${h}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log("wrote", file);
    }
  }
  ws.close();
} finally { proc.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
