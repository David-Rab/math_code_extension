// Live check of the folder-trust flow: a session in a fresh, untrusted folder
// shows the trust card; answering "Trust" makes Claude Code record the trust.
// Usage: npm run trust-e2e -- <new scratch dir>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { settings, FakePanel } from './mock-vscode';
import { ChatSession, type SessionHost } from '../src/session';
import { WarmPool } from '../src/warm';
import { setBundledExecutable } from '../src/config';
import { isTrusted } from '../src/trust';

const dir = path.resolve(process.argv[2]);
fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
// A project permission rule that is ignored until the folder is trusted.
fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(echo trust-check:*)'] } }));
setBundledExecutable(path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'));
Object.assign(settings, { initialModel: 'haiku', initialPermissionMode: 'default', remoteControl: 'off', prewarm: false, sound: 'off', notification: 'off' });
const host: SessionHost = { openSession() {}, sessionsChanged() {}, async saveReport() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 300)}`}`);
};

check('fresh folder starts untrusted', isTrusted(dir) === false, isTrusted(dir));
const panel = new FakePanel();
const s = new ChatSession(panel as any, dir, new WarmPool(), host);
await s.start();
panel.fromView({ t: 'ready' });
const card: any = s.transcript.items.get('main')?.find((i) => i.kind === 'trust');
check('trust card shown before Claude Code starts', !!card && card.state === 'pending' && !(s as any).q, card);
check('card names the folder', card?.folder?.toLowerCase() === dir.toLowerCase(), card?.folder);

panel.fromView({ t: 'trust', id: card.id, choice: 'trust' });
// Permission prompts are answered "deny" so we can see whether the project rule applied.
const prompts: string[] = [];
panel.watch((m) => {
  if (m.t === 'item' && m.item.kind === 'permission' && m.item.state === 'pending') {
    prompts.push(m.item.detail);
    panel.fromView({ t: 'permission', id: m.item.id, allow: false });
  }
});
panel.fromView({ t: 'send', text: 'Run the shell command: echo trust-check ok   — then reply with its output only.' });
for (let i = 0; i < 600 && !(s.status.busy === false && (s.transcript.items.get('main') ?? []).some((x: any) => x.kind === 'text')); i++) await sleep(200);
await sleep(1500);
check('Claude Code recorded the trust', isTrusted(dir) === true, isTrusted(dir));
check('project permission rule now applies (no prompt for the allowed command)', prompts.length === 0, prompts);
const reply = (s.transcript.items.get('main') ?? []).filter((x: any) => x.kind === 'text').map((x: any) => x.text).join(' ');
check('command ran', /trust-check ok/.test(reply), reply);
panel.dispose();

// A second session in the same folder does not ask again.
const panel2 = new FakePanel();
const s2 = new ChatSession(panel2 as any, dir, new WarmPool(), host);
await s2.start();
check('trusted folder: no card next time', !s2.transcript.items.get('main')?.some((i) => i.kind === 'trust'));
panel2.dispose();

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
