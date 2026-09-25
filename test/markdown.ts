// Checks the math tokenizer on cases that commonly break Markdown + LaTeX.
import { renderMarkdown, setRenderMath, setMacros, splitDraft } from '../webview/markdown';

const cases: [string, string, (html: string) => boolean][] = [
  ['inline', 'Euler: $e^{i\\pi}+1=0$ holds.', (h) => h.includes('class="katex"') && !h.includes('$')],
  ['prices stay text', 'It costs $5 and $10 today.', (h) => !h.includes('katex') && h.includes('$5 and $10')],
  ['subscripts not italic', 'Let $a_1 * b_2 * c_3$ and $x_i$.', (h) => !h.includes('<em>') && (h.match(/class="katex"/g) ?? []).length === 2],
  ['display $$ block', 'Before\n\n$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$\n\nAfter', (h) => h.includes('katex-display') && h.includes('After')],
  ['\\[ \\] display', 'Then \\[ a^2+b^2=c^2 \\] done.', (h) => h.includes('katex-display')],
  ['\\( \\) inline', 'Then \\( \\alpha \\) done.', (h) => h.includes('class="katex"')],
  ['align env', '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}', (h) => h.includes('katex-display') && !h.includes('\\begin')],
  ['\\[ block over lines', 'Claim:\n\\[\n\\sum_{k=1}^n k = \\frac{n(n+1)}{2}\n\\]\nQED', (h) => h.includes('katex-display') && h.includes('QED')],
  ['unterminated (streaming)', 'Partial:\n\n$$\n\\sum_{k=1}^n', (h) => !h.includes('katex-display')],
  ['escaped dollar', 'Price \\$5, math $y$.', (h) => h.includes('$5') && (h.match(/class="katex"/g) ?? []).length === 1],
  ['math in list', '- first $a<b$\n- second $b>c$', (h) => (h.match(/class="katex"/g) ?? []).length === 2 && h.includes('<li>')],
  ['code keeps dollars', 'Run `echo $HOME and $PATH`.', (h) => !h.includes('katex') && h.includes('$HOME')],
  ['file link', 'See [main.ts:3](src/main.ts#L3).', (h) => h.includes('data-href="src/main.ts#L3"')],
  ['bad tex does not throw', 'Oops $\\frac{1}{$ ok', (h) => typeof h === 'string'],
  ['built-in \\F \\Q macros', 'Over $\\F_q$ and $\\Q$.', (h) => !h.includes('katex-error') && !h.includes('#cc0000')],
];

// Custom macros from settings.
setMacros({ '\\Gal': '\\operatorname{Gal}' });
cases.push(['custom macro', 'The group $\\Gal(L/K)$.', (h) => !h.includes('#cc0000') && h.includes('Gal')]);

// Streaming split: finished paragraphs vs the one being written.
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const splitCases: [string, string, { blocks: string[]; tail: string }][] = [
  ['two paragraphs, second in progress', 'First para.\n\nSecond', { blocks: ['First para.'], tail: 'Second' }],
  ['open $$ keeps blank lines inside', 'Intro\n\n$$\na\n\nb', { blocks: ['Intro'], tail: '$$\na\n\nb' }],
  ['closed $$ then text', 'Intro\n\n$$\na\n$$\n\nNext', { blocks: ['Intro', '$$\na\n$$'], tail: 'Next' }],
  ['code fence with blank line', '```\nx\n\ny\n```\n\nAfter', { blocks: ['```\nx\n\ny\n```'], tail: 'After' }],
  ['align env with blank line', '\\begin{align}\na\n\nb\n\\end{align}\n\nZ', { blocks: ['\\begin{align}\na\n\nb\n\\end{align}'], tail: 'Z' }],
  ['trailing blank line stays in tail', 'One\n\n', { blocks: ['One'], tail: '' }],
];
for (const [name, src, want] of splitCases) {
  const got = splitDraft(src);
  cases.push([`split: ${name}`, src, () => eq(got, want) || (console.log('      got', JSON.stringify(got)), false)]);
}

let failed = 0;
for (const [name, src, ok] of cases) {
  const h = renderMarkdown(src, false);
  const pass = ok(h);
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '\n      ' + h.slice(0, 300)}`);
}
setRenderMath(false);
const raw = renderMarkdown('Raw $x_1$ here', false);
const rawOk = raw.includes('tex-raw') && raw.includes('$x_1$') && !raw.includes('katex');
if (!rawOk) failed++;
console.log(`${rawOk ? 'PASS' : 'FAIL'}  math off shows source`);
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
