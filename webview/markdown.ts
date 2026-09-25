// Markdown + LaTeX rendering. Math is always tokenized (so markdown never
// mangles it); the renderer then outputs KaTeX or the raw source depending on
// the "render math" toggle.
import MarkdownIt from 'markdown-it';
import type { StateInline, StateBlock } from 'markdown-it';
import katex from 'katex';

let renderMath = true;
export function setRenderMath(on: boolean) {
  if (on !== renderMath) htmlCache.clear();
  renderMath = on;
}

// Blackboard-bold shorthands KaTeX lacks (it already has \R \Z \N), plus the user's own.
const BUILTIN_MACROS: Record<string, string> = { '\\F': '\\mathbb{F}', '\\Q': '\\mathbb{Q}', '\\C': '\\mathbb{C}', '\\E': '\\mathbb{E}' };
let macros: Record<string, string> = { ...BUILTIN_MACROS };
let macrosKey = '';
export function setMacros(user: Record<string, string> | undefined) {
  const key = JSON.stringify(user ?? {});
  if (key === macrosKey) return;
  macrosKey = key;
  macros = { ...BUILTIN_MACROS, ...(user ?? {}) };
  texCache.clear();
  htmlCache.clear();
}

const texCache = new Map<string, string>();
function tex(src: string, display: boolean): string {
  if (!renderMath) {
    const raw = escapeHtml(display ? `$$${src}$$` : `$${src}$`);
    return display ? `<pre class="tex-raw">${raw}</pre>` : `<code class="tex-raw">${raw}</code>`;
  }
  const key = (display ? 'D' : 'I') + src;
  let out = texCache.get(key);
  if (out === undefined) {
    try {
      out = katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html', trust: false, macros: { ...macros } });
    } catch (e) {
      out = `<code class="tex-error" title="${escapeHtml(String((e as Error).message))}">${escapeHtml(src)}</code>`;
    }
    if (texCache.size > 3000) texCache.clear();
    texCache.set(key, out);
  }
  return display ? `<div class="math-display">${out}</div>` : out;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// --- inline: $...$, $$...$$ (inline display), \( ... \), \[ ... \] ----------
function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  const ch = src.charCodeAt(start);

  if (ch === 0x5c /* \ */) {
    const next = src[start + 1];
    if (next !== '(' && next !== '[') return false;
    const close = next === '(' ? '\\)' : '\\]';
    const end = src.indexOf(close, start + 2);
    if (end < 0) return false;
    if (!silent) {
      const t = state.push(next === '(' ? 'math_inline' : 'math_inline_display', 'math', 0);
      t.content = src.slice(start + 2, end);
    }
    state.pos = end + 2;
    return true;
  }

  if (ch !== 0x24 /* $ */) return false;
  if (start > 0 && src[start - 1] === '\\') return false;

  if (src[start + 1] === '$') {
    const end = src.indexOf('$$', start + 2);
    if (end < 0 || end === start + 2) return false;
    if (!silent) {
      const t = state.push('math_inline_display', 'math', 0);
      t.content = src.slice(start + 2, end);
    }
    state.pos = end + 2;
    return true;
  }

  // Pandoc rules: no space after the opening $, no space before the closing $,
  // and the closing $ is not followed by a digit (so "$5 and $10" stays text).
  const after = src[start + 1];
  if (after === undefined || /\s/.test(after)) return false;
  let end = start + 1;
  while ((end = src.indexOf('$', end)) >= 0) {
    if (src[end - 1] === '\\') {
      end++;
      continue;
    }
    if (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] ?? '')) {
      end++;
      continue;
    }
    break;
  }
  if (end < 0) return false;
  if (!silent) {
    const t = state.push('math_inline', 'math', 0);
    t.content = src.slice(start + 1, end);
  }
  state.pos = end + 1;
  return true;
}

// --- block: $$ ... $$, \[ ... \], \begin{env} ... \end{env} ----------------
const ENV = /^\\begin\{(equation|align|gather|multline|eqnarray|alignat|flalign|split|cases|matrix|pmatrix|bmatrix|array)\*?\}/;

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const lineText = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
  const first = lineText(startLine);
  let open: string, close: string, keepDelims = false;
  if (first.startsWith('$$')) [open, close] = ['$$', '$$'];
  else if (first.startsWith('\\[')) [open, close] = ['\\[', '\\]'];
  else {
    const env = first.match(ENV);
    if (!env) return false;
    open = '';
    close = `\\end{${first.slice(7, first.indexOf('}'))}}`;
    keepDelims = true;
  }
  if (silent) return true;

  let body = first.slice(open.length);
  let line = startLine;
  let found = false;
  const closeAt = (s: string) => s.indexOf(close, keepDelims ? 0 : 0);
  let idx = closeAt(body);
  if (idx >= 0 && (keepDelims || body.trim().length > 0)) {
    found = true;
    body = keepDelims ? body.slice(0, idx + close.length) : body.slice(0, idx);
  } else {
    const parts = [body];
    while (++line < endLine) {
      const t = lineText(line);
      idx = closeAt(t);
      if (idx >= 0) {
        parts.push(keepDelims ? t.slice(0, idx + close.length) : t.slice(0, idx));
        found = true;
        break;
      }
      parts.push(t);
    }
    body = parts.join('\n');
  }
  if (!found) return false; // unterminated (e.g. still streaming): leave as text
  const token = state.push('math_block', 'math', 0);
  token.content = body;
  token.map = [startLine, line + 1];
  state.line = line + 1;
  return true;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
md.inline.ruler.before('escape', 'math_inline', mathInline);
md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
md.renderer.rules.math_inline = (t, i) => tex(t[i].content, false);
md.renderer.rules.math_inline_display = (t, i) => tex(t[i].content, true);
md.renderer.rules.math_block = (t, i) => tex(t[i].content, true);

// Links: keep the target in data-href; the click handler asks the extension to open it.
const defaultLinkOpen = md.renderer.rules.link_open ?? ((t, i, o, _e, self) => self.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') ?? '';
  tokens[idx].attrSet('data-href', href);
  tokens[idx].attrSet('href', '#');
  tokens[idx].attrSet('title', href);
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/**
 * Split streaming text into finished blocks and the block still being
 * written. Finished blocks never change, so they render once; only the tail
 * re-renders as tokens arrive. Boundaries are blank lines outside code
 * fences and display math.
 */
export function splitDraft(src: string): { blocks: string[]; tail: string } {
  const lines = src.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  let math: string | null = null; // closing delimiter while inside display math
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (fence) {
      if (t.startsWith(fence)) fence = null;
    } else if (math) {
      if (t.includes(math)) math = null;
    } else if (/^(```|~~~)/.test(t)) {
      fence = t.slice(0, 3);
    } else if (t.startsWith('$$') && !(t.length > 2 && t.slice(2).includes('$$'))) {
      math = '$$';
    } else if (t.startsWith('\\[') && !t.includes('\\]')) {
      math = '\\]';
    } else {
      const env = t.match(/^\\begin\{([^}]+)\}/);
      if (env && !t.includes(`\\end{${env[1]}}`)) math = `\\end{${env[1]}}`;
    }
    if (t === '' && !fence && !math && i < lines.length - 1) {
      if (cur.length) blocks.push(cur.join('\n'));
      cur = [];
    } else cur.push(line);
  }
  return { blocks, tail: cur.join('\n') };
}

const htmlCache = new Map<string, string>();
/** Render markdown to HTML. Finished messages are cached; drafts pass cache=false. */
export function renderMarkdown(src: string, cache = true): string {
  if (cache) {
    const hit = htmlCache.get(src);
    if (hit !== undefined) return hit;
  }
  const html = md.render(src);
  if (cache) {
    if (htmlCache.size > 2000) htmlCache.clear();
    htmlCache.set(src, html);
  }
  return html;
}
