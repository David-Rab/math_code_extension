// Copying a selection as Markdown, checked in a real browser (headless Chrome)
// on the real webview bundle: whole replies must come back as Markdown that
// renders the same as the original, and partial selections as exactly the
// part selected. Needs a build first. Usage: npm run test-copy
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderMarkdown } from '../webview/markdown';

const samples: [string, string][] = [
  ['headings and emphasis', '# Title\n\nSome **bold**, *italic*, ~~gone~~ and `code` text.\n\n## Second level\n\nA [link](src/file.ts#L3) and a bare https://example.com/page link.\n\n### Third\n\nLast.'],
  ['lists', 'Intro:\n\n- one\n- two with **bold**\n  - nested a\n  - nested b\n- three\n\n3. third\n4. fourth\n\nLoose:\n\n- first para\n\n  second para of the same item\n\n- next item'],
  ['code', 'Run this:\n\n```ts\nconst x: number = 1;\n\nif (x < 2) console.log(`x`);\n```\n\nand ``a ` tick`` inline, then plain:\n\n```\nno language\n```'],
  ['quote, rule, table', '> quoted line\n> second line\n\n---\n\n| Name | Value | Note |\n|:-----|------:|:----:|\n| a | 1 | x \\| y |\n| **b** | 2 | $z_1$ |'],
  ['math', 'Inline $e^{i\\pi}+1=0$ and \\(a_1 < b_2\\), then display:\n\n$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$\n\nand\n\n\\[\n\\sum_{k=1}^n k = \\frac{n(n+1)}{2}\n\\]\n\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n\nDone with $\\F_q$.'],
  ['characters that look like Markdown', 'It costs \\$5 and \\$10, 2 \\* 3 \\* 4 is 24, a snake_case_name stays, \\_private\\_ too, and a \\<div> is text. Back\\\\slash.'],
  ['soft line breaks', 'first line\nsecond line of the same paragraph\nthird\n\nnext paragraph'],
];
// More replies to round-trip, from a local file of strings (not part of the repository).
if (process.env.COPY_EXTRA) for (const [i, text] of (JSON.parse(fs.readFileSync(process.env.COPY_EXTRA, 'utf8')) as string[]).entries()) samples.push([`extra ${i}`, text]);
const partial = 'Start of para with $a^2+b^2$ inside and **bold words** after.\n\n- item one\n- item two\n- item three\n\n3. third\n4. fourth\n5. fifth\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\n| A | B |\n|---|--:|\n| a1 | b1 |\n| a2 | b2 |';
const mine = 'line one\nline two\n\nnew paragraph with $x^2$';

// A reply that uses macros of your own: unknown until your macro file defines them.
const usesMacros = 'The map is $\\equi P_k$, for sets in $\\Fam$, and $\\Zed$ stays undefined. Again $\\equi$ and $\\Fam$.';

const snapshot = {
  threads: [{ id: 'main', title: 'Main', status: 'done' }],
  items: { main: [...samples.map(([, text], i) => ({ kind: 'text', id: `s${i}`, text })), { kind: 'text', id: 'partial', text: partial }, { kind: 'user', id: 'mine', text: mine }, { kind: 'text', id: 'macros', text: usesMacros }] },
  drafts: {},
  todos: {},
  status: { models: [], commands: [], remote: { state: 'off' }, busy: false, starting: false, sessionId: 'demo' },
  config: { renderMath: true, toolActivity: 'summary', showThinking: false, enterToSend: true, mathMacros: {} },
};

// Runs in the page.
async function inPage(snap: unknown, sampleCount: number) {
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  window.postMessage({ t: 'snapshot', snapshot: snap }, '*');
  for (let i = 0; i < 400 && document.querySelectorAll('.msg').length < sampleCount + 3; i++) await frame();
  for (let i = 0; i < 5; i++) await frame();

  const copy = (range: Range): string | null => {
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const data = new DataTransfer();
    const ev = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
    const at = range.commonAncestorContainer;
    (at.nodeType === 1 ? (at as Element) : at.parentElement!).dispatchEvent(ev);
    return ev.defaultPrevented ? data.getData('text/plain') : null;
  };
  const all = (el: Element) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return copy(r);
  };
  /** The text node under `root` containing `needle`, and where it starts. */
  const find = (root: Element, needle: string, after = false): [Node, number] => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.nodeValue ?? '').indexOf(needle);
      if (i >= 0) return [n, after ? i + needle.length : i];
    }
    throw new Error(`not found: ${needle}`);
  };
  const between = (root: Element, from: string, to: string) => {
    const r = document.createRange();
    r.setStart(...find(root, from));
    r.setEnd(...find(root, to, true));
    return copy(r);
  };

  const replies = [...document.querySelectorAll('.msg.assistant .md')];
  const whole = replies.slice(0, sampleCount).map(all);
  const p = replies[sampleCount];
  const insideFormula = (() => {
    const r = document.createRange();
    const glyph = document.createTreeWalker(p.querySelector('.katex')!, NodeFilter.SHOW_TEXT).nextNode()!;
    r.setStart(glyph, 0);
    r.setEnd(...find(p, ' inside', true));
    return copy(r);
  })();
  const input = document.querySelector('.composer textarea') as HTMLTextAreaElement;
  input.value = 'typed in the box';
  input.focus();
  input.select();
  const fromBox = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
  input.dispatchEvent(fromBox);
  const parts = {
    'part of a paragraph': between(p, 'para with', 'bold'),
    'starting inside a formula': insideFormula,
    'two list items': between(p, 'item two', 'item three'),
    'numbered items keep their numbers': between(p, 'fourth', 'fifth'),
    'inside a code block': between(p, 'x = 1;', 'const y'),
    'table rows': between(p, 'a1', 'b2'),
    'my own message': all(document.querySelector('.msg.user .md')!),
    'two messages at once': between(document.querySelector('.thread')!, 'fifth', 'line one'),
    'the message box is left to the browser': fromBox.defaultPrevented ? 'taken over' : null,
  };
  // Your macro file is saved with two definitions: the host sends the new settings to the open panel.
  const withMacros = replies[replies.length - 1];
  const undefinedNow = () => [...withMacros.innerHTML.matchAll(/color:#cc0000;?">\\([A-Za-z]+)</g)].map((m) => m[1]);
  const before = undefinedNow();
  window.postMessage({ t: 'config', config: { ...(snap as any).config, mathMacros: { '\\equi': '\\cong', '\\Fam': '\\mathcal C' } } }, '*');
  for (let i = 0; i < 10; i++) await frame();
  const macros = {
    before,
    after: undefinedNow(),
    formulas: withMacros.querySelectorAll('.katex').length,
    copied: all(withMacros),
    tooltip: [...document.querySelectorAll('.statusbar .toggle')].map((b) => b.getAttribute('title') ?? '').find((t) => t.startsWith('Render LaTeX math')) ?? '',
  };
  document.getElementById('perf')!.textContent = JSON.stringify({ errors: (window as any).__errors, whole, parts, macros });
}

const out = '.test/harness/copy.html';
const rel = (f: string) => path.relative(path.dirname(out), path.join('dist/webview', f)).replace(/\\/g, '/');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  `<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="${rel('katex.min.css')}"><link rel="stylesheet" href="${rel('style.css')}"></head>
<body><div id="root"></div><pre id="perf" style="display:none"></pre>
<script>
window.__errors = [];
window.onerror = (m) => { window.__errors.push(String(m)); };
const inPage = ${inPage.toString()};
window.acquireVsCodeApi = () => ({
  postMessage(m) { if (m.t === 'ready') inPage(${JSON.stringify(snapshot).replace(/</g, '\\u003c')}, ${samples.length}).catch((e) => { document.getElementById('perf').textContent = JSON.stringify({ errors: [String(e && e.stack || e)], whole: [], parts: {} }); }); },
  getState() { return {}; },
  setState() {},
});
</script>
<script src="${rel('main.js')}"></script></body></html>`,
);

const report = JSON.parse(execFileSync(process.execPath, ['test/cdp.mjs', out], { encoding: 'utf8' }).split('\n')[0]) as { errors: string[]; whole: (string | null)[]; parts: Record<string, string | null> };
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};
check('no script errors in the page', report.errors.length === 0, report.errors);
samples.forEach(([name, src], i) => {
  const got = report.whole[i];
  const [a, b] = [renderMarkdown(got ?? '', false), renderMarkdown(src, false)];
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  // On a difference: where the two renderings part, a little of each.
  const detail = `copied renders as …${JSON.stringify(a.slice(Math.max(0, at - 60), at + 80))}
      original as       …${JSON.stringify(b.slice(Math.max(0, at - 60), at + 80))}`;
  check(`whole reply copies as Markdown that renders the same: ${name}`, got !== null && a === b, detail);
});
const expected: Record<string, string | null> = {
  'part of a paragraph': 'para with $a^2+b^2$ inside and **bold**',
  'starting inside a formula': '$a^2+b^2$ inside',
  'two list items': '- item two\n- item three',
  'numbered items keep their numbers': '4. fourth\n5. fifth',
  'inside a code block': 'x = 1;\nconst y',
  'table rows': '|   |   |\n| --- | --: |\n| a1 | b1 |\n| a2 | b2 |',
  'my own message': mine,
  'the message box is left to the browser': null,
};
for (const [name, want] of Object.entries(expected)) check(`selection: ${name}`, report.parts[name] === want, `copied: ${JSON.stringify(report.parts[name])}`);
const two = report.parts['two messages at once'] ?? '';
check('selection: two messages at once, without the buttons between them', two.startsWith('5. fifth\n\n```js\nconst x = 1;') && two.endsWith('| a2 | b2 |\n\nline one') && !/[⧉↶]/.test(two), `copied: ${JSON.stringify(two)}`);
const m = (report as unknown as { macros: { before: string[]; after: string[]; formulas: number; copied: string | null; tooltip: string } }).macros;
check('macros of your own: unknown ones are shown as written until defined', JSON.stringify(m.before) === '["equi","Fam","Zed","equi","Fam"]', m.before);
check('…a saved macro file redraws the messages already on screen', JSON.stringify(m.after) === '["Zed"]' && m.formulas === 5, m);
check('…copying still gives the source as written', m.copied === usesMacros, m.copied);
check('…the math toggle lists your macros and how to define more', m.tooltip.includes('Your macros: \\equi \\Fam') && m.tooltip.includes('Edit Math Macros'), m.tooltip);
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
