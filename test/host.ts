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
import { savedCompactions } from '../src/compactions';
import { findMacros, inputsOf, parseMacros } from '../src/macros';
import { arrange, cleanGroupName, cleanOrganizer, forget, groupNames, initOrganizer, organizer, renameGroup, setGroup, setPinned } from '../src/organize';
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
check('checklist tools are asked for (off by default for SDK sessions since Claude Code 2.1.296)', (opts.env as any)?.CLAUDE_CODE_ENABLE_TODO_TOOLS === '1' && (opts.env as any)?.PATH === process.env.PATH);
check('…as launch options', opts.model === 'opus' && opts.effort === 'xhigh' && opts.permissionMode === 'auto', { model: opts.model, effort: opts.effort, mode: opts.permissionMode });
Object.assign(settings, { initialModel: 'haiku', initialPermissionMode: 'plan' });
check('the "initial" settings win over what you picked last', launchSettings().model === 'haiku' && launchSettings().permissionMode === 'plan', launchSettings());
check("a tab's own picks win over both (kept across a restart)", launchSettings({ model: 'sonnet', permissionMode: 'default' }).model === 'sonnet' && launchSettings({ permissionMode: 'default' }).permissionMode === 'default');
check('picking "default" in a tab passes no model', launchSettings({ model: 'default' }).model === undefined);
Object.assign(settings, { initialModel: '', initialPermissionMode: 'bypassPermissions' });
check('an unsafe mode in the settings is ignored', launchSettings().permissionMode === 'auto', launchSettings());
check('an unsafe mode is never a launch option', launchSettings({ permissionMode: 'bypassPermissions' }).permissionMode === undefined && buildOptions(proj, () => undefined, {}, { permissionMode: 'bypassPermissions' }).permissionMode === undefined);
Object.assign(settings, { initialPermissionMode: '' });

// --- pinned sessions and groups ---------------------------------------------
{
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const list = [1, 2, 3, 4, 5].map((n) => ({ id: id(n), title: `s${n}` })); // most recent first
  const o = cleanOrganizer({ pins: [id(4), id(2), 'not-an-id', id(4), 7], groups: { [id(1)]: '  Thesis  ', [id(3)]: 'admin', [id(4)]: 'admin', bogus: 'x', [id(5)]: '   ' }, extra: true });
  check('stored pins and groups are cleaned', JSON.stringify(o.pins) === JSON.stringify([id(4), id(2)]) && JSON.stringify(o.groups) === JSON.stringify({ [id(1)]: 'Thesis', [id(3)]: 'admin', [id(4)]: 'admin' }), o);
  const a = arrange(list, o);
  check('pinned sessions come first, in the order pinned', a.pinned.map((s) => s.title).join() === 's4,s2', a.pinned);
  check('groups follow by name; a pinned session is listed once', a.groups.map((g) => `${g.name}:${g.sessions.map((s) => s.title).join('+')}`).join() === 'admin:s3,Thesis:s1', a.groups);
  check('the rest keeps its order', a.rest.map((s) => s.title).join() === 's5', a.rest);
  check('nothing is lost or doubled', a.pinned.length + a.groups.reduce((n, g) => n + g.sessions.length, 0) + a.rest.length === list.length);
  check('a group name is trimmed and bounded', cleanGroupName('  a   b  ') === 'a b' && cleanGroupName('x'.repeat(99))!.length === 40 && cleanGroupName('   ') === undefined && cleanGroupName(5) === undefined);

  const mem: Record<string, unknown> = {};
  initOrganizer({ get: (k: string) => mem[k], update: async (k: string, v: unknown) => void (mem[k] = v), keys: () => Object.keys(mem) } as any);
  setPinned(id(1), true);
  setPinned(id(2), true);
  setGroup(id(2), 'Thesis');
  setGroup(id(3), 'Thesis');
  check('pin and group are stored', JSON.stringify(mem['claudePanel.sessionOrganizer']) === JSON.stringify({ pins: [id(1), id(2)], groups: { [id(2)]: 'Thesis', [id(3)]: 'Thesis' } }), mem);
  renameGroup('Thesis', 'Paper');
  check('renaming a group moves all its sessions', groupNames().join() === 'Paper' && organizer().groups[id(3)] === 'Paper');
  setPinned(id(1), false);
  forget(id(2));
  check('unpinning and deleting leave nothing behind', organizer().pins.length === 0 && JSON.stringify(organizer().groups) === JSON.stringify({ [id(3)]: 'Paper' }), organizer());
  renameGroup('Paper', undefined);
  check('removing a group keeps its sessions, ungrouped', groupNames().length === 0 && arrange(list, organizer()).rest.length === 5);
}

// --- a paper's own macros ----------------------------------------------------
{
  const defs = parseMacros(
    [
      '\\newcommand{\\equi}{\\operatorname{Isom}}',
      '\\newcommand\\Fam{\\mathcal{C}}   % a comment with \\newcommand{\\fake}{x}',
      '\\renewcommand*{\\pair}[2]{\\langle #1, #2 \\rangle}',
      '\\providecommand{\\nested}{\\mathbf{a_{b_{c}}}}',
      '\\DeclareMathOperator{\\Hom}{Hom}',
      '\\DeclareMathOperator*{\\colim}{colim}',
      '\\DeclarePairedDelimiter{\\abs}{\\lvert}{\\rvert}',
      '\\def\\R{\\mathbb{R}}',
      '\\def\\two#1#2{#1+#2}',
      '\\let\\eps\\varepsilon',
      '\\newcommand{\\opt}[2][default]{#1 #2}', // optional argument: cannot be expressed
      '\\def\\delim(#1){#1}', // delimited parameters: cannot be expressed
      '\\definecolor{x}{rgb}{1,0,0}', // not \\def
      '\\newcommand{\\percent}{50\\% of it}',
      '\\newcommand{\\equi}{\\operatorname{Isom}^+}', // a later definition wins
    ].join('\n'),
  );
  const want: Record<string, string> = {
    equi: '\\operatorname{Isom}^+',
    Fam: '\\mathcal{C}',
    pair: '\\langle #1, #2 \\rangle',
    nested: '\\mathbf{a_{b_{c}}}',
    Hom: '\\operatorname{Hom}',
    colim: '\\operatorname*{colim}',
    abs: '\\lvert #1 \\rvert',
    R: '\\mathbb{R}',
    two: '#1+#2',
    eps: '\\varepsilon',
    percent: '50\\% of it',
  };
  check('macro definitions are read from TeX source', JSON.stringify(Object.entries(defs).sort()) === JSON.stringify(Object.entries(want).sort()), defs);
  check('files a source loads are found', JSON.stringify(inputsOf('\\input{preamble}\n\\usepackage[utf8]{inputenc, mymacros}\n% \\input{commented}\n\\include{ch/one}')) === '["preamble","inputenc","mymacros","ch/one"]');

  // A project with two papers that define \equi differently, and one macro everyone agrees on.
  const proj2 = path.join(root, 'papers');
  const w = (f: string, text: string) => (fs.mkdirSync(path.dirname(path.join(proj2, f)), { recursive: true }), fs.writeFileSync(path.join(proj2, f), text));
  w('a/paper.tex', '\\input{preamble}\n\\newcommand{\\Fam}{\\mathcal{C}}\n\\begin{document}x\\end{document}');
  w('a/preamble.tex', '\\newcommand{\\equi}{\\operatorname{Isom}}\n\\DeclareMathOperator{\\Stab}{Stab}');
  w('b/other.tex', '\\newcommand{\\equi}{\\mathrm{iso}}\n\\DeclareMathOperator{\\Stab}{Stab}\n\\newcommand{\\only}{\\beta}');
  w('b/third.tex', '\\DeclareMathOperator{\\Stab}{Stab}');
  fs.writeFileSync(path.join(root, 'outside.tex'), '\\newcommand{\\secret}{\\alpha}');
  const all = async () => ['a/paper.tex', 'a/preamble.tex', 'b/other.tex', 'b/third.tex'].map((f) => path.join(proj2, f)).concat(path.join(root, 'outside.tex'));
  let listed = 0;
  const counting = async () => (listed++, all());

  const inPaper = await findMacros(['equi', 'Fam', 'Stab'], proj2, [path.join(proj2, 'a/paper.tex')], counting);
  check("the conversation's own paper decides, through the files it loads", inPaper.macros.equi === '\\operatorname{Isom}' && inPaper.macros.Fam === '\\mathcal{C}' && inPaper.macros.Stab === '\\operatorname{Stab}' && inPaper.sources.equi === 'a/paper.tex', inPaper);
  check('…without looking at the rest of the project', listed === 0);
  const other = await findMacros(['equi'], proj2, [path.join(proj2, 'b/other.tex'), path.join(proj2, 'a/paper.tex')], counting);
  check('the most recently used paper wins', other.macros.equi === '\\mathrm{iso}', other);
  const none = await findMacros(['equi', 'Stab', 'only', 'nowhere', 'secret', 'bad name', '../x'], proj2, [], counting);
  check('with no paper in the conversation: used only when the whole project agrees', none.macros.Stab === '\\operatorname{Stab}' && none.macros.only === '\\beta' && !('equi' in none.macros), none.macros);
  check('contradicting definitions are not guessed between, and say why', /2 different ways across 2 files/.test(none.unresolved.equi ?? ''), none.unresolved);
  check('files outside the project are never used', !('secret' in none.macros) && !('secret' in (await findMacros(['secret'], proj2, [path.join(root, 'outside.tex')], all)).macros));
  check('a file that loads a file outside the project does not reach it', (w('a/escape.tex', '\\input{../../outside}'), !('secret' in (await findMacros(['secret'], proj2, [path.join(proj2, 'a/escape.tex')], async () => [])).macros)));
  // A shared preamble in another folder (TeX finds it through its search path).
  w('c/paper.tex', '\\input{shared}\n\\usepackage{amsmath}');
  w('lib/shared.tex', '\\newcommand{\\equi}{\\cong}');
  const withLib = async () => [...(await all()), path.join(proj2, 'c/paper.tex'), path.join(proj2, 'lib/shared.tex')];
  check('a preamble loaded from elsewhere in the project is followed when its name is unique', (await findMacros(['equi'], proj2, [path.join(proj2, 'c/paper.tex')], withLib)).macros.equi === '\\cong');
  w('lib2/shared.tex', '\\newcommand{\\equi}{\\simeq}');
  const twoLibs = async () => [...(await withLib()), path.join(proj2, 'lib2/shared.tex')];
  const ambiguous = await findMacros(['equi'], proj2, [path.join(proj2, 'c/paper.tex')], twoLibs);
  check('…and not when two files share that name', !('equi' in ambiguous.macros) && /different ways/.test(ambiguous.unresolved.equi ?? ''), ambiguous);
  w('a/preamble.tex', '\\newcommand{\\equi}{\\operatorname{Isom}_0}');
  check('an edited file is read again', (await findMacros(['equi'], proj2, [path.join(proj2, 'a/paper.tex')], all)).macros.equi === '\\operatorname{Isom}_0');
}

// --- compactions counted from saved conversation files ----------------------
{
  const projects = path.join(root, 'projects');
  const sid = '00000000-0000-4000-8000-0000000000aa';
  const dir = path.join(projects, 'C--some-project');
  fs.mkdirSync(path.join(dir, sid, 'subagents'), { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  const boundary = (ts: string, pre: number, trigger = 'auto') => line({ type: 'system', subtype: 'compact_boundary', timestamp: ts, compactMetadata: { trigger, preTokens: pre } });
  fs.writeFileSync(
    path.join(dir, `${sid}.jsonl`),
    [line({ type: 'user', message: { content: 'the words "compact_boundary" in a message do not count' } }), boundary('2026-10-01T10:00:00Z', 900000), 'not json "compact_boundary"', line({ type: 'assistant' }), boundary('2026-10-02T11:00:00Z', 500000, 'manual')].join('\n') + '\n',
  );
  fs.writeFileSync(path.join(dir, sid, 'subagents', 'agent-a1b2.jsonl'), boundary('2026-10-02T12:00:00Z', 300000) + '\n');
  fs.writeFileSync(path.join(dir, sid, 'subagents', 'agent-quiet.jsonl'), line({ type: 'user' }) + '\n');
  const c = await savedCompactions(sid, projects);
  check('compactions are counted from the saved file, real ones only', c.main.count === 2 && c.main.last?.fromTokens === 500000 && c.main.last?.auto === false && c.main.last?.at === Date.parse('2026-10-02T11:00:00Z'), c.main);
  check("…and each subagent's own", JSON.stringify(Object.keys(c.agents)) === '["a1b2"]' && c.agents.a1b2.count === 1, c.agents);
  check('an unknown or malformed conversation id counts nothing', (await savedCompactions('00000000-0000-4000-8000-0000000000bb', projects)).main.count === 0 && (await savedCompactions('../../x', projects)).main.count === 0);
}

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
