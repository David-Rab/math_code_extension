// Copying a selection from the conversation gives Markdown source instead of
// the drawn text: headings, lists, tables, emphasis, links and code come back
// as Markdown, and each formula as the LaTeX it was written with. The result
// is rebuilt from what is selected on screen, so it is exactly the selection.

const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'HR', 'DIV', 'DETAILS', 'SUMMARY', 'SECTION']);
// Controls drawn inside the conversation (copy and rewind buttons, tool lines, menus) are not part of the text.
const SKIP = new Set(['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA', 'IMG', 'SCRIPT', 'STYLE']);

interface Ctx {
  /** In your own messages every line break was typed; in replies a hard break is Markdown's. */
  breaks: boolean;
}

const isEl = (n: Node): n is HTMLElement => n.nodeType === 1;
const tex = (el: HTMLElement) => el.getAttribute('data-tex');
const isBlock = (n: Node) => isEl(n) && (BLOCKS.has(n.tagName) || (tex(n) !== null && (n.tagName === 'DIV' || n.tagName === 'PRE')));

/** Characters that would be read as Markdown if left bare in ordinary text. */
function escapeText(s: string): string {
  return s
    .replace(/([\\`*$])/g, '\\$1')
    .replace(/(^|[^A-Za-z0-9])_|_(?=[^A-Za-z0-9]|$)/g, (m) => m.replace('_', '\\_'))
    .replace(/<(?=[A-Za-z/!?])/g, '\\<');
}

function fenced(code: string, tick: string, min: number): string {
  let n = min;
  for (const run of code.match(new RegExp(`\\${tick}+`, 'g')) ?? []) n = Math.max(n, run.length + 1);
  return tick.repeat(n);
}

function inline(node: Node, ctx: Ctx): string {
  if (node.nodeType === 3) return escapeText(node.nodeValue ?? '');
  if (!isEl(node) || SKIP.has(node.tagName)) return '';
  const source = tex(node);
  if (source !== null) return source;
  const inner = () => [...node.childNodes].map((c) => inline(c, ctx)).join('');
  switch (node.tagName) {
    case 'BR': {
      // The renderer writes a line break after each <br>; do not add a second one.
      const follows = node.nextSibling?.nodeType === 3 && (node.nextSibling.nodeValue ?? '').startsWith('\n');
      return (ctx.breaks ? '' : '\\') + (follows ? '' : '\n');
    }
    case 'STRONG':
    case 'B':
      return wrap(inner(), '**');
    case 'EM':
    case 'I':
      return wrap(inner(), '*');
    case 'S':
    case 'DEL':
      return wrap(inner(), '~~');
    case 'CODE': {
      const code = node.textContent ?? '';
      const f = fenced(code, '`', 1);
      const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
      return code ? `${f}${pad}${code}${pad}${f}` : '';
    }
    case 'A': {
      const href = node.getAttribute('data-href') ?? '';
      const text = inner();
      if (node.classList.contains('image-link')) return `![${text.replace(/^🖼\s*/u, '')}](${href})`;
      if (!href) return text;
      // A web address written bare is a link by itself; a file link needs its target spelled out.
      if ((node.textContent ?? '') === href && /^https?:\/\//i.test(href)) return href;
      return `[${text}](${/[\s()]/.test(href) ? `<${href}>` : href})`;
    }
    default:
      return inner();
  }
}

/** Emphasis markers sit against the text: spaces at the ends move outside them. */
function wrap(s: string, mark: string): string {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
}

/** A paragraph that would start like a heading, list, quote or rule keeps its first character literal. */
function paragraph(s: string): string {
  return s
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .replace(/^(#{1,6}\s|>|[-+]\s|\d+[.)]\s|-{3,}\s*$|={3,}\s*$)/gm, '\\$1');
}

const indent = (s: string, by: string) => s.split('\n').map((l, i) => (i && l ? by + l : l)).join('\n');

function list(el: HTMLElement, ctx: Ctx): string {
  const items = [...el.children].filter((c) => c.tagName === 'LI') as HTMLElement[];
  const ordered = el.tagName === 'OL';
  const start = Number(el.getAttribute('start') ?? 1) || 1;
  const loose = items.some((li) => [...li.children].some((c) => c.tagName === 'P'));
  return items
    .map((li, i) => {
      const mark = ordered ? `${start + i}. ` : '- ';
      return mark + indent(blocks(li, ctx, loose ? '\n\n' : '\n'), ' '.repeat(mark.length));
    })
    .join(loose ? '\n\n' : '\n');
}

function table(el: HTMLElement, ctx: Ctx): string {
  const rows = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].filter((c) => c.tagName === 'TH' || c.tagName === 'TD') as HTMLElement[]);
  if (!rows.length) return '';
  const cell = (c: HTMLElement) => inline(c, ctx).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim();
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const align = (c: HTMLElement) => ({ left: ':--', right: '--:', center: ':-:' })[c.style.textAlign] ?? '---';
  const head = rows[0];
  const headed = head.some((c) => c.tagName === 'TH');
  // A selection that starts below the header row still needs one to be a table.
  const out = [line(headed ? head.map(cell) : head.map(() => ' ')), line(head.map(align))];
  for (const r of headed ? rows.slice(1) : rows) out.push(line(r.map(cell)));
  return out.join('\n');
}

function block(el: HTMLElement, ctx: Ctx): string {
  const source = tex(el);
  if (source !== null) return source;
  switch (el.tagName) {
    case 'P':
      return paragraph(inline(el, ctx));
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return `${'#'.repeat(Number(el.tagName[1]))} ${inline(el, ctx).replace(/\s+/g, ' ').trim()}`;
    case 'UL':
    case 'OL':
      return list(el, ctx);
    case 'PRE': {
      const codeEl = el.querySelector('code');
      const code = (codeEl ?? el).textContent?.replace(/\n$/, '') ?? '';
      const lang = [...(codeEl?.classList ?? [])].find((c) => c.startsWith('language-'))?.slice(9) ?? '';
      const f = fenced(code, '`', 3);
      return `${f}${lang}\n${code}\n${f}`;
    }
    case 'BLOCKQUOTE':
      return blocks(el, ctx)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'TABLE':
      return table(el, ctx);
    case 'HR':
      return '---';
    default:
      return blocks(el, ctx);
  }
}

/** The children of a container as Markdown blocks; loose text between blocks becomes a paragraph. */
function blocks(parent: ParentNode, ctx: Ctx, sep = '\n\n'): string {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    const text = paragraph(run.map((n) => inline(n, ctx)).join(''));
    if (text) out.push(text);
    run = [];
  };
  for (const n of parent.childNodes) {
    if (isEl(n) && SKIP.has(n.tagName)) continue;
    if (!isBlock(n)) {
      run.push(n);
      continue;
    }
    flush();
    const el = n as HTMLElement;
    const own: Ctx = el.classList.contains('user') ? { breaks: true } : ctx;
    const text = block(el, own);
    if (text.trim()) out.push(text);
  }
  flush();
  return out.join(sep);
}

/** What contains a node up to the conversation, innermost first. */
function ancestors(n: Node, stop: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let e = isEl(n) ? n : n.parentElement; e && e !== stop; e = e.parentElement) out.push(e);
  return out;
}

/**
 * The selection inside `root` as Markdown, or null when there is nothing there
 * to convert (then the browser's own copy applies).
 */
export function selectionToMarkdown(sel: Selection | null, root: Element): string | null {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const parts: string[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i).cloneRange();
    if (!root.contains(range.commonAncestorContainer)) return null;
    // A formula is copied whole: its drawn glyphs are not text that can be cut.
    const formula = (n: Node) => ancestors(n, root).find((e) => tex(e) !== null);
    const first = formula(range.startContainer);
    if (first) range.setStartBefore(first);
    const last = formula(range.endContainer);
    if (last) range.setEndAfter(last);

    const around = ancestors(range.commonAncestorContainer, root);
    const ctx: Ctx = { breaks: around.some((e) => e.classList.contains('user')) };
    // Inside one code block: the code itself, as plain text.
    if (around.some((e) => e.tagName === 'PRE' || e.tagName === 'CODE')) {
      parts.push(range.toString());
      continue;
    }
    let content: ParentNode = range.cloneContents();
    // A numbered list cut at the start of the selection keeps the numbers of the items selected.
    const common = range.commonAncestorContainer;
    const down = ancestors(range.startContainer, isEl(common) ? common : common.parentElement!).reverse();
    let copyOf: Node | null = content.firstChild;
    for (let k = 0; k < down.length && copyOf && isEl(copyOf) && copyOf.tagName === down[k].tagName; k++) {
      const at = down[k].tagName === 'OL' && down[k + 1] ? [...down[k].children].indexOf(down[k + 1]) : -1;
      if (at > 0) copyOf.setAttribute('start', String((Number(down[k].getAttribute('start') ?? 1) || 1) + at));
      copyOf = copyOf.firstChild;
    }
    // List items and table rows only mean something inside their list or table.
    for (const e of around) {
      if (!['UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TR'].includes(e.tagName)) {
        if (e.tagName === 'LI' || e.tagName === 'TD' || e.tagName === 'TH') break; // within one item or cell: just its text
        continue;
      }
      const shell = e.cloneNode(false) as HTMLElement;
      if (e.tagName === 'OL') {
        const at = [...e.children].findIndex((li) => range.intersectsNode(li));
        shell.setAttribute('start', String((Number(e.getAttribute('start') ?? 1) || 1) + Math.max(0, at)));
      }
      shell.append(content as Node);
      const holder = document.createDocumentFragment();
      holder.append(shell);
      content = holder;
    }
    parts.push(blocks(content, ctx));
  }
  const text = parts.join('\n\n').replace(/ /g, ' ');
  return text.trim() ? text : null;
}
