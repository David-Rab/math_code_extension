// Builds a standalone HTML page that runs the real webview bundle on a stored
// session, for screenshots and render timing in a headless browser.
// Usage: node .test/harness.mjs <session dir> <session id> [tab title substring] [out.html]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSessionMessages, listSubagents, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk';
import { Transcript } from '../src/transcript';

const [dir, id, tabMatch = '', out = '.test/harness/index.html'] = process.argv.slice(2);
const t = new Transcript();
for (const m of await getSessionMessages(id, { dir })) t.handle(m, true);
for (const a of await listSubagents(id, { dir })) for (const m of await getSubagentMessages(id, a, { dir })) t.handle(m, true);
for (const th of t.threads.values()) if (th.status === 'running') th.status = 'done';

const snapshot = {
  ...t.snapshotParts(),
  status: {
    models: [{ value: 'opus', displayName: 'Opus 5.5', description: '', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    modelChoice: 'opus',
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: 'default',
    contextPercent: 34,
    contextTokens: 68000,
    contextMax: 200000,
    cacheHitPercent: 92,
    rateLimits: { fiveHour: { utilization: 8 }, sevenDay: { utilization: 7 } },
    remote: { state: 'on', url: 'https://claude.ai/code/x' },
    commands: ['compact', 'context', 'model'],
    busy: false,
    starting: false,
    version: '2.1.282',
    sessionId: id,
  },
  config: { renderMath: process.env.MATH !== 'off', toolActivity: 'summary', showThinking: false, enterToSend: true },
};
const active = [...t.threads.values()].find((x) => tabMatch && x.title.toLowerCase().includes(tabMatch.toLowerCase()))?.id ?? 'main';
const itemCount = [...t.items.values()].reduce((n, l) => n + l.length, 0);

const rel = (f: string) => path.relative(path.dirname(out), path.join('dist/webview', f)).replace(/\\/g, '/');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="${rel('katex.min.css')}"><link rel="stylesheet" href="${rel('style.css')}">
<style>
:root { --vscode-editor-background:#1f1f1f; --vscode-foreground:#cccccc; --vscode-font-family:"Segoe UI",sans-serif; --vscode-font-size:13px;
  --vscode-editor-font-family:Consolas,monospace; --vscode-descriptionForeground:#9d9d9d; --vscode-panel-border:#2b2b2b; --vscode-input-background:#313131;
  --vscode-button-background:#0078d4; --vscode-button-foreground:#fff; --vscode-button-secondaryBackground:#313131; --vscode-button-secondaryForeground:#ccc;
  --vscode-textLink-foreground:#4daafc; --vscode-focusBorder:#0078d4; --vscode-textCodeBlock-background:#2b2b2b; --vscode-editorWidget-background:#202020;
  --vscode-badge-background:#616161; --vscode-errorForeground:#f85149; --vscode-editorWarning-foreground:#cca700; }
</style></head><body><div id="root"></div>
<pre id="perf" style="display:none"></pre>
<script>
window.__errors = [];
window.onerror = (m) => { window.__errors.push(String(m)); document.getElementById('perf').textContent = 'ERROR ' + m; };
const SNAP = ${JSON.stringify(snapshot).replace(/</g, '\\u003c')};
const report = {};
const out = () => (document.getElementById('perf').textContent = JSON.stringify({ ...report, errors: window.__errors }));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
async function until(pred) { while (!pred()) await frame(); return performance.now(); }
async function bench() {
  // 1. first render of the whole session
  let t0 = performance.now();
  const LONGEST = SNAP.items.main.filter((i) => i.kind === 'text').map((i) => i.text).sort((a, b) => b.length - a.length)[0] ?? '';
  if (${JSON.stringify(process.env.EMPTY ?? '')} === '1') SNAP.items.main = SNAP.items.main.slice(0, 1);
  window.postMessage({ t: 'snapshot', snapshot: SNAP }, '*');
  report.firstRenderMs = Math.round((await until(() => document.querySelector('.thread') && document.querySelector('.thread').children.length > 0)) - t0);
  report.items = ${itemCount}; report.threads = ${t.threads.size};
  if (${JSON.stringify(process.env.BENCH ?? '')} !== '1') return out();
  // 2. switching through every tab and back
  const tabs = [...document.querySelectorAll('.tab')];
  t0 = performance.now();
  for (const tab of tabs) { tab.click(); await frame(); }
  tabs[0].click(); await frame();
  report.tabSwitchAvgMs = Math.round((performance.now() - t0) / (tabs.length + 1));
  // 3. streaming: a long math-heavy reply arriving in small chunks, 60 per second
  const src = LONGEST;
  const chunks = Math.min(600, Math.ceil(src.length / 12));
  const step = Math.ceil(src.length / chunks);
  let slow = 0, worst = 0, last = performance.now(), frames = 0, done = false;
  (async () => { while (!done) { const t = await frame(); const d = t - last; last = t; frames++; if (d > 50) slow++; worst = Math.max(worst, d); } })();
  t0 = performance.now();
  for (let i = 1; i <= chunks; i++) {
    window.postMessage({ t: 'draft', threadId: 'main', text: src.slice(0, i * step) }, '*');
    await new Promise((r) => setTimeout(r, 16));
  }
  await frame(); done = true;
  Object.assign(report, { streamChars: src.length, streamChunks: chunks, streamSeconds: +((performance.now() - t0) / 1000).toFixed(1), frames, slowFrames: slow, worstFrameMs: Math.round(worst) });
  out();
}
window.acquireVsCodeApi = () => ({
  postMessage(m) { if (m.t === 'ready') bench().catch((e) => { window.__errors.push(String(e)); out(); }); },
  getState() { return { active: ${JSON.stringify(active)} }; },
  setState() {},
});
</script>
<script src="${rel('main.js')}"></script>
</body></html>`,
);
console.log(`wrote ${out}: ${t.threads.size} threads, ${itemCount} items, active tab ${active}`);
