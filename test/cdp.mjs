// Opens a harness page in headless Chrome over the DevTools protocol, waits for
// the benchmark report in #perf, prints it, and optionally saves a screenshot.
// usage: node test/cdp.mjs <page.html> [screenshot.png] [width] [height]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [page, shot, width = '1000', height = '1250'] = process.argv.slice(2);
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-chrome-'));
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...(process.env.NOGPU ? ['--disable-gpu'] : []), '--no-first-run',
  '--allow-file-access-from-files', `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
  } catch {}
}
if (!target) throw new Error('chrome did not start');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const waiting = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) waiting.get(m.id)(m);
});
const call = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await call('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

await call('Page.enable');
await call('Performance.enable');
if (process.env.FULLDRAFT) await call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__fullDraft = true' });
await call('Page.navigate', { url: 'file:///' + path.resolve(page).replace(/\\/g, '/') });
let report = '';
for (let i = 0; i < 600 && !report; i++) {
  await sleep(200);
  report = (await evaluate(`document.getElementById('perf')?.textContent ?? ''`)) || '';
}
const metrics = Object.fromEntries((await call('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]));
const ms = (k) => Math.round((metrics[k] ?? 0) * 1000);
console.log(report || 'TIMEOUT: no report');
console.log(JSON.stringify({ scriptMs: ms('ScriptDuration'), styleMs: ms('RecalcStyleDuration'), layoutMs: ms('LayoutDuration'), taskMs: ms('TaskDuration'), layouts: metrics.LayoutCount }));
if (shot) {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shot, Buffer.from(r.result.data, 'base64'));
}
ws.close();
proc.kill();
process.exit(report && !report.startsWith('TIMEOUT') ? 0 : 1);
