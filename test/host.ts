// Host-side checks with a fake VS Code and no claude.exe: which links from a
// reply open (and how), which remembered settings a new tab starts with, and
// what a problem report contains.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { settings, shown, executed, external, answers, workspace } from './mock-vscode';
import { openLink } from '../src/links';
import { cleanLastUsed, initPrefs, lastUsed, rememberLastUsed, onLastUsedChange } from '../src/prefs';
import { launchSettings, buildOptions } from '../src/session';
import { reportBody } from '../src/report';
import { Transcript } from '../src/transcript';

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 400)}`}`);
};

// --- links ------------------------------------------------------------------
const root = path.resolve('.test/host-work');
fs.rmSync(root, { recursive: true, force: true });
const proj = path.join(root, 'proj');
fs.mkdirSync(path.join(proj, 'docs', 'pictures'), { recursive: true });
fs.writeFileSync(path.join(proj, 'docs', 'pictures', 'a.png'), 'not really a picture');
fs.writeFileSync(path.join(proj, 'notes.md'), 'one\ntwo\nthree\n');
fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');

const reset = () => (executed.splice(0), shown.splice(0), external.splice(0), (answers.confirm = true));
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const link = async (href: string) => {
  reset();
  await openLink(href, proj);
  return executed.map((c) => c[0]).join();
};

workspace.workspaceFolders = [{ uri: { fsPath: proj } }];
check('a folder inside the workspace is shown in the Explorer', (await link('docs/pictures/')) === 'revealInExplorer' && same(executed[0][1].fsPath, path.join(proj, 'docs', 'pictures')), executed);
check('…without an error message', shown.length === 0, shown);
workspace.workspaceFolders = undefined;
check('a folder of a project that is not the workspace is shown in the file manager', (await link('docs/pictures')) === 'revealFileInOS', executed);

check('a picture opens in the editor for its type', (await link('docs/pictures/a.png')) === 'vscode.open' && executed[0][2].selection === undefined, executed);
await link('notes.md#L2-L3');
check('a line range is selected', executed[0]?.[0] === 'vscode.open' && executed[0][2].selection?.at.join() === '1,0,2,0', executed);
check('a missing file gives a plain message, not an error', (await link('docs/nope.md')) === '' && /does not exist/.test(shown[0]?.text ?? ''), shown);

for (const bad of ['\\\\server\\share\\x.txt', '//server/share/x.txt', 'file:///c:/Windows/win.ini', 'vscode://settings', 'command:workbench.action.terminal.new', 'javascript:alert(1)'])
  check(`refused: ${bad}`, (await link(bad)) === '' && external.length === 0 && /Not opened/.test(shown[0]?.text ?? ''), { executed, shown });

answers.confirm = false;
reset();
answers.confirm = false;
await openLink('../outside.txt', proj);
check('a file outside the project asks first, and stays closed when declined', executed.length === 0 && /outside this project/.test(shown[0]?.text ?? ''), { executed, shown });
check('…and opens when confirmed', (await link('../outside.txt')) === 'vscode.open' && /outside this project/.test(shown[0]?.text ?? ''), { executed, shown });
answers.confirm = false;
reset();
answers.confirm = false;
await openLink('..', proj);
check('a folder outside the project asks first too', executed.length === 0 && /folder outside this project/.test(shown[0]?.text ?? ''), { executed, shown });
await link('https://example.com/x');
check('web links go to the browser', external[0] === 'https://example.com/x' && executed.length === 0, external);

// --- remembered model, effort and permission mode ---------------------------
check('remembered values are kept when valid', JSON.stringify(cleanLastUsed({ model: 'opus[1m]', effort: 'high', permissionMode: 'auto' })) === '{"model":"opus[1m]","effort":"high","permissionMode":"auto"}');
for (const mode of ['bypassPermissions', 'dontAsk', 'BYPASSPERMISSIONS', '', 7, null])
  check(`a remembered permission mode of ${JSON.stringify(mode)} is dropped`, cleanLastUsed({ permissionMode: mode }).permissionMode === undefined);
check('odd remembered values are dropped', JSON.stringify(cleanLastUsed({ model: 'x --dangerously-skip-permissions', effort: 'extreme', extra: 1 })) === '{}' && JSON.stringify(cleanLastUsed('nonsense')) === '{}');
check('"default" model means nothing to pass on', cleanLastUsed({ model: 'default' }).model === undefined);

const stored: Record<string, unknown> = { 'claudePanel.lastUsed': { model: 'sonnet', permissionMode: 'bypassPermissions' } };
initPrefs({ get: (k: string) => stored[k], update: async (k: string, v: unknown) => void (stored[k] = v), keys: () => Object.keys(stored) } as any);
check('stored values are cleaned when loaded', lastUsed().model === 'sonnet' && lastUsed().permissionMode === undefined, lastUsed());
let changes = 0;
onLastUsedChange(() => changes++);
rememberLastUsed({ model: 'opus', effort: 'xhigh', permissionMode: 'acceptEdits' });
rememberLastUsed({ model: 'opus' });
check('picks are stored once per change', changes === 1 && JSON.stringify(stored['claudePanel.lastUsed']) === '{"model":"opus","effort":"xhigh","permissionMode":"acceptEdits"}', stored);
rememberLastUsed({ permissionMode: 'bypassPermissions' });
check('an unsafe mode cannot be remembered', lastUsed().permissionMode === undefined && !JSON.stringify(stored).includes('bypass'), stored);
rememberLastUsed({ permissionMode: 'auto' });

Object.assign(settings, { initialModel: '', initialPermissionMode: '' });
check('a new tab starts with what you picked last', JSON.stringify(launchSettings()) === '{"model":"opus","effort":"xhigh","permissionMode":"auto"}', launchSettings());
const opts = buildOptions(proj, () => undefined);
check('…as launch options', opts.model === 'opus' && opts.effort === 'xhigh' && opts.permissionMode === 'auto', { model: opts.model, effort: opts.effort, mode: opts.permissionMode });
Object.assign(settings, { initialModel: 'haiku', initialPermissionMode: 'plan' });
check('the "initial" settings win over what you picked last', launchSettings().model === 'haiku' && launchSettings().permissionMode === 'plan', launchSettings());
check("a tab's own picks win over both (kept across a restart)", launchSettings({ model: 'sonnet', permissionMode: 'default' }).model === 'sonnet' && launchSettings({ permissionMode: 'default' }).permissionMode === 'default');
check('picking "default" in a tab passes no model', launchSettings({ model: 'default' }).model === undefined);
Object.assign(settings, { initialModel: '', initialPermissionMode: 'bypassPermissions' });
check('an unsafe mode in the settings is ignored', launchSettings().permissionMode === 'auto', launchSettings());
check('an unsafe mode is never a launch option', launchSettings({ permissionMode: 'bypassPermissions' }).permissionMode === undefined && buildOptions(proj, () => undefined, {}, { permissionMode: 'bypassPermissions' }).permissionMode === undefined);
Object.assign(settings, { initialPermissionMode: '' });

// --- problem report ---------------------------------------------------------
{
  const transcript = new Transcript();
  transcript.handle({ type: 'system', subtype: 'brand_new_thing', detail: 'payload-123' });
  transcript.handle({ type: 'system', subtype: 'brand_new_thing', detail: 'payload-456' });
  const session: any = { cwd: proj, transcript, status: { sessionId: 'sid', title: 'T', busy: false, starting: false, remote: { state: 'off' } } };
  const body = reportBody('First line\n\nsecond paragraph\n  {"pasted": true}', '1.0 · test', session, ['r-1.png', 'r-2.jpg'], new Date(0));
  check('the report title is the first line', body.startsWith('# First line\n'), body.slice(0, 60));
  check('the whole description is kept, line breaks included', body.includes('First line\n\nsecond paragraph\n  {"pasted": true}'));
  check('screenshots are linked', body.includes('![screenshot 1](r-1.png)') && body.includes('![screenshot 2](r-2.jpg)'));
  check('an unsupported event is included in full, once per kind', body.includes('payload-123') && !body.includes('payload-456') && body.includes('- **Status:** open'), body);
  check('a report with only screenshots still has a title', reportBody('  ', 'x', undefined, ['a.png'], new Date(0)).startsWith('# (screenshots only)'));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
