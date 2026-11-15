// Converts PNG screenshots to JPEG (quality 0.86) with headless Edge, to keep the repository small.
// Usage: node design/tools/to-jpeg.mjs <dir> [--delete]   (recurses; writes <name>.jpg next to <name>.png)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [dir, flag] = process.argv.slice(2);
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : p.endsWith(".png") && files.push(p); } })(dir);
const edge = process.env.EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const port = 9700 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(process.env.TEMP ?? ".", "velora-jpg-"));
const proc = spawn(edge, [`--remote-debugging-port=${port}`, "--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => d.error ? rej(new Error(d.error.message)) : res(d.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  for (const f of files) {
    const b64 = fs.readFileSync(f).toString("base64");
    const expr = `new Promise((res)=>{const i=new Image();i.onload=()=>{const c=document.createElement('canvas');c.width=i.width;c.height=i.height;c.getContext('2d').drawImage(i,0,0);res(c.toDataURL('image/jpeg',0.86).split(',')[1]);};i.src='data:image/png;base64,${b64}';})`;
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    fs.writeFileSync(f.replace(/\.png$/, ".jpg"), Buffer.from(r.result.value, "base64"));
    if (flag === "--delete") fs.unlinkSync(f);
    console.log("converted", f);
  }
  ws.close();
} finally { proc.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
