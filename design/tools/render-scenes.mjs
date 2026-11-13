// Renders the Living Room background scenes (src/theme/living-room/scenes.ts) to WebP with headless Edge.
// Usage: node design/tools/render-scenes.mjs [outDir=src/assets/scenes] [--size 3840x2160] [--quality 88]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const outDir = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--"))) ?? "src/assets/scenes";
const [W, H] = opt("--size", "3840x2160").split("x").map(Number);
const quality = Number(opt("--quality", "88"));
const { SCENES, sceneSvg } = await import(pathToFileURL(path.resolve("src/theme/living-room/scenes.ts")).href);
fs.mkdirSync(outDir, { recursive: true });
const edge = process.env.EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const port = 9500 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? ".", "velora-scenes-"));
const proc = spawn(edge, [`--remote-debugging-port=${port}`, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => d.error ? rej(new Error(d.error.message)) : res(d.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < SCENES.length; i++) {
    const sc = SCENES[i];
    const html = `<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#050506}svg{display:block;width:${W}px;height:${H}px}</style>${sceneSvg(sc, i)}`;
    await send("Page.navigate", { url: "data:text/html;base64," + Buffer.from(html).toString("base64") });
    await sleep(900);
    const shot = await send("Page.captureScreenshot", { format: "webp", quality });
    const file = path.join(outDir, `${sc.id}.webp`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log("wrote", file, Math.round(fs.statSync(file).size / 1024) + " KB");
  }
  ws.close();
} finally { proc.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
