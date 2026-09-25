// End-to-end: runs ChatSession (the real extension host code) against the
// real claude.exe with a fake VS Code, and checks what the panel would show.
// Usage: npm run e2e -- <scratch work dir>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { settings, FakePanel } from './mock-vscode';
import { ChatSession } from '../src/session';
import { WarmPool } from '../src/warm';
import { setBundledExecutable } from '../src/config';

const work = process.argv[2];
if (!work) throw new Error('pass a scratch work directory');
fs.mkdirSync(work, { recursive: true });
setBundledExecutable(path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'));
Object.assign(settings, { initialModel: 'haiku', initialPermissionMode: 'default', remoteControl: 'off', prewarm: false, toolActivity: 'summary' });

const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

async function waitIdle(s: ChatSession, timeoutMs: number) {
  const start = Date.now();
  let sawBusy = false;
  while (Date.now() - start < timeoutMs) {
    if (s.status.busy) sawBusy = true;
    else if (sawBusy) {
      // A background subagent's completion can start a follow-up turn; give it a moment.
      await sleep(1500);
      if (!s.status.busy) return true;
    }
    await sleep(200);
  }
  return false;
}

function autoRespond(panel: FakePanel) {
  panel.watch((m) => {
    if (m.t !== 'item' || m.item.state !== 'pending') return;
    const it = m.item;
    setTimeout(() => {
      if (it.kind === 'permission') panel.fromView({ t: 'permission', id: it.id, allow: true });
      if (it.kind === 'question') panel.fromView({ t: 'answer', id: it.id, answers: Object.fromEntries(it.questions.map((q: any) => [q.question, q.options[0].label])) });
      if (it.kind === 'plan') panel.fromView({ t: 'plan', id: it.id, approve: true, mode: 'default' });
    }, 100);
  });
}

const items = (s: ChatSession, thread = 'main') => s.transcript.items.get(thread) ?? [];
const texts = (s: ChatSession, thread = 'main') => items(s, thread).filter((i: any) => i.kind === 'text').map((i: any) => i.text as string);

// ---------------------------------------------------------------- 1. full turn
const warm = new WarmPool();
const panel = new FakePanel();
autoRespond(panel);
const s = new ChatSession(panel as any, work, warm);
await s.start();
panel.fromView({ t: 'ready' });

const PROMPT = `Do these steps in order:
1) Create a file named e2e.txt containing the word hi, using the Write tool.
2) Use the AskUserQuestion tool to ask me which color I prefer, with the options Red and Blue.
3) Use the Agent tool to launch one general-purpose subagent with description "e2e-sub" and prompt "Reply with exactly: the sub says $x^2$. Use no tools." Do not run it in the background; wait for its result.
4) Finally reply with one sentence stating my color and what the subagent said.`;
panel.fromView({ t: 'send', text: PROMPT });
check('turn finished', await waitIdle(s, 240000), `still busy after 240s`);
console.log(`      (${secs()})`);

const sub = [...s.transcript.threads.values()].find((t) => t.title === 'e2e-sub');
check('subagent got its own tab', !!sub, JSON.stringify([...s.transcript.threads.values()].map((t) => t.title)));
if (sub) {
  check('subagent tab shows its task', items(s, sub.id).some((i: any) => i.kind === 'prompt'));
  check('subagent text streamed into its tab', texts(s, sub.id).some((t) => /sub says/i.test(t)), JSON.stringify(items(s, sub.id)).slice(0, 300));
  check('subagent marked finished', sub.status === 'done', sub.status);
  check('main thread links to subagent', items(s).some((i: any) => i.kind === 'agent' && i.threadId === sub.id));
}
const perm: any = items(s).find((i: any) => i.kind === 'permission');
check('permission prompt shown and allowed', perm?.state === 'allowed', JSON.stringify(perm));
check('file actually written', fs.existsSync(path.join(work, 'e2e.txt')));
const q: any = items(s).find((i: any) => i.kind === 'question');
check('question card shown and answered', q?.state === 'answered', JSON.stringify(q));
check('final reply uses the answer', texts(s).some((t) => /red/i.test(t)), JSON.stringify(texts(s)));
check('tool activity grouped', items(s).some((i: any) => i.kind === 'tools'));
check('text streamed as drafts', panel.posted.some((m) => m.t === 'draft' && m.text));
check('no unsupported events', !items(s).some((i: any) => i.kind === 'unknown'), JSON.stringify(items(s).filter((i: any) => i.kind === 'unknown').map((i: any) => i.label)));
check('no leftover draft', s.transcript.drafts.size === 0);

const st = s.status;
check('models listed', st.models.length > 0, String(st.models.length));
check('context usage known', typeof st.contextPercent === 'number', String(st.contextPercent));
check('cache hit known', typeof st.cacheHitPercent === 'number', String(st.cacheHitPercent));
check('plan limits known', !!st.rateLimits?.fiveHour, JSON.stringify(st.rateLimits));
check('version known', !!st.version, st.version);
check('session id known', !!st.sessionId);
console.log(`      status: model=${st.model} mode=${st.permissionMode} effort=${st.effort} ctx=${st.contextPercent}% cache=${st.cacheHitPercent}% 5h=${st.rateLimits?.fiveHour?.utilization}%`);

// ---------------------------------------------------------------- 2. controls
panel.fromView({ t: 'setModel', value: 'sonnet' });
await sleep(2500);
check('switch model', /sonnet/.test(s.status.model ?? '') && s.status.modelChoice === 'sonnet', `${s.status.model} / ${s.status.modelChoice}`);
panel.fromView({ t: 'setEffort', value: 'low' });
await sleep(2000);
check('switch effort', s.status.effort === 'low', String(s.status.effort));
panel.fromView({ t: 'setMode', value: 'acceptEdits' });
await sleep(1000);
check('switch permission mode', s.status.permissionMode === 'acceptEdits', s.status.permissionMode);
panel.fromView({ t: 'setModel', value: 'haiku' });
panel.fromView({ t: 'setMode', value: 'default' });
await sleep(2000);

// ---------------------------------------------------------------- 3. stop
panel.fromView({ t: 'send', text: 'Write a 600-word essay about prime numbers. Use no tools.' });
await sleep(6000);
const tStop = Date.now();
panel.fromView({ t: 'interrupt' });
const stopped = await waitIdle(s, 30000);
check('stop ends the turn', stopped, `after ${Date.now() - tStop}ms`);
console.log(`      stopped in ${((Date.now() - tStop) / 1000).toFixed(1)}s`);
check('stop shown in conversation', items(s).some((i: any) => i.kind === 'notice' && /Stopped/.test(i.text)));

// ---------------------------------------------------------------- 4. resume
const sessionId = s.status.sessionId!;
panel.dispose();
await sleep(1000);
const panel2 = new FakePanel();
const s2 = new ChatSession(panel2 as any, work, warm, sessionId);
await s2.start();
panel2.fromView({ t: 'ready' });
const snap = panel2.posted.find((m) => m.t === 'snapshot');
check('resumed panel gets a snapshot', !!snap);
const sub2 = [...s2.transcript.threads.values()].find((t) => t.title === 'e2e-sub');
check('history: subagent tab rebuilt', !!sub2 && texts(s2, sub2.id).some((t) => /sub says/i.test(t)));
check('history: your prompts shown', items(s2).some((i: any) => i.kind === 'user' && i.text.includes('e2e.txt')));
check('history: replies shown', texts(s2).some((t) => /red/i.test(t)));
panel2.fromView({ t: 'send', text: 'Reply with only the word: resumed' });
check('resumed session answers', await waitIdle(s2, 120000));
check('resumed session remembers', texts(s2).some((t) => /resumed/i.test(t)) && s2.status.sessionId === sessionId, `${s2.status.sessionId} vs ${sessionId}`);
panel2.dispose();

// ---------------------------------------------------------------- 5. pre-warm
settings.prewarm = true;
warm.fill(work);
const tw = Date.now();
while (!warm.isReady(work) && Date.now() - tw < 90000) await sleep(250);
check('spare process warmed', warm.isReady(work), `after ${(Date.now() - tw) / 1000}s`);
console.log(`      warm-up took ${((Date.now() - tw) / 1000).toFixed(1)}s in the background`);
const panel3 = new FakePanel();
const s3 = new ChatSession(panel3 as any, work, warm);
await s3.start();
panel3.fromView({ t: 'ready' });
const tSend = Date.now();
let firstToken = 0;
panel3.watch((m) => {
  if (!firstToken && m.t === 'draft' && m.text) firstToken = Date.now() - tSend;
});
panel3.fromView({ t: 'send', text: 'Reply with only the word: warm' });
check('warm session answers', await waitIdle(s3, 120000));
console.log(`      first token ${(firstToken / 1000).toFixed(1)}s after send (warm)`);
panel3.dispose();
warm.dispose();

const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} passed  (${secs()})`);
process.exit(failed ? 1 : 0);
