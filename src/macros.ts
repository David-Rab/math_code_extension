// A paper's own LaTeX macros, so that formulas in the conversation that use
// them render. Nothing is read until a formula actually contains a macro the
// renderer does not know; then its definition is looked up:
//
//  1. in the .tex/.sty/.cls files Claude read or edited in this conversation
//     (most recent first) and the files those \input or load, so the paper
//     being discussed decides;
//  2. else anywhere in the project, but only when every definition found
//     there is the same. Contradicting definitions are never guessed between.
//
// Definitions are plain text handed to KaTeX, which runs untrusted (no links,
// images, HTML or styles) with bounded expansion. Claude is told nothing.
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_FILE = 400_000; // characters read per file
const MAX_BODY = 2000;
const NAME = /^[A-Za-z]{1,40}$/;

/** Remove TeX comments: an unescaped % to the end of its line. */
function stripComments(s: string): string {
  return s.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, '$1$2');
}

/** The {...} group starting at `i` (after spaces): its content and the index after it. */
function group(s: string, i: number): [string, number] | undefined {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] !== '{') return undefined;
  let depth = 0;
  for (let j = i; j < s.length && j < i + MAX_BODY * 2; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return undefined;
}

/** A macro name written as {\name} or \name. */
function name(s: string, i: number): [string, number] | undefined {
  const m = /^\s*(?:\{\s*\\([A-Za-z]+)\s*\}|\\([A-Za-z]+))/.exec(s.slice(i, i + 80));
  return m ? [m[1] ?? m[2], i + m[0].length] : undefined;
}

/**
 * The macros a TeX source defines, as KaTeX macro bodies keyed by name (no
 * backslash). Understands \newcommand, \renewcommand, \providecommand,
 * \DeclareRobustCommand, \DeclareMathOperator, \DeclarePairedDelimiter, \def
 * and \let. Macros with an optional argument, or \def with delimited
 * parameters, are left out: KaTeX cannot express them. A later definition of
 * the same name replaces an earlier one.
 */
export function parseMacros(source: string): Record<string, string> {
  const s = stripComments(source.slice(0, MAX_FILE));
  const out: Record<string, string> = {};
  const start = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|DeclarePairedDelimiter|def|gdef|let)(\*?)(?![A-Za-z])/g;
  for (let m = start.exec(s); m; m = start.exec(s)) {
    const [kind, star] = [m[1], m[2] === '*'];
    const n = name(s, start.lastIndex);
    if (!n || !NAME.test(n[0])) continue;
    let i = n[1];
    let body: string | undefined;
    if (kind === 'let') {
      const target = /^\s*=?\s*\\([A-Za-z]+)/.exec(s.slice(i, i + 80));
      if (target) body = `\\${target[1]}`;
    } else if (kind === 'def' || kind === 'gdef') {
      const after = i + /^(?:#[1-9])*/.exec(s.slice(i, i + 40))![0].length;
      if (!/^\s*\{/.test(s.slice(after, after + 8))) continue; // delimited parameters
      const g = group(s, after);
      if (g) body = g[0];
    } else if (kind === 'DeclareMathOperator') {
      const g = group(s, i);
      if (g) body = `\\operatorname${star ? '*' : ''}{${g[0]}}`;
    } else if (kind === 'DeclarePairedDelimiter') {
      const left = group(s, i);
      const right = left && group(s, left[1]);
      if (left && right) body = `${left[0]} #1 ${right[0]}`;
    } else {
      const args = /^\s*\[\s*(\d)\s*\]/.exec(s.slice(i, i + 20));
      if (args) i += args[0].length;
      if (/^\s*\[/.test(s.slice(i, i + 20))) continue; // optional argument with a default
      const g = group(s, i);
      if (g) body = g[0];
    }
    if (body !== undefined && body.length <= MAX_BODY) out[n[0]] = body.trim();
  }
  return out;
}

/** Local files a TeX source pulls in: \input, \include, \usepackage, \RequirePackage. */
export function inputsOf(source: string): string[] {
  const s = stripComments(source.slice(0, MAX_FILE));
  const out: string[] = [];
  for (const m of s.matchAll(/\\(input|include|usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g))
    for (const f of m[2].split(',')) if (/^[\w./ -]+$/.test(f.trim())) out.push(f.trim());
  return out;
}

function inside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Parsed files, reused until the file changes on disk.
const cache = new Map<string, { stamp: string; macros: Record<string, string>; inputs: string[] }>();

async function parsed(file: string): Promise<{ macros: Record<string, string>; inputs: string[] } | undefined> {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) return undefined;
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(file);
    if (hit?.stamp === stamp) return hit;
    const handle = await fs.promises.open(file, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_FILE));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      text = buf.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
    const entry = { stamp, macros: parseMacros(text), inputs: inputsOf(text) };
    if (cache.size > 5000) cache.clear();
    cache.set(file, entry);
    return entry;
  } catch {
    return undefined;
  }
}

type Elsewhere = (name: string) => Promise<string | undefined>;

/**
 * A file's macros together with those of the project files it loads (which it
 * may then redefine). A loaded file is looked for next to the loading one, as
 * TeX does first; one that TeX would find through its search path instead (a
 * shared preamble in another folder) is taken when the project has exactly one
 * file of that name.
 */
async function withInputs(file: string, root: string, seen: Set<string>, elsewhere: Elsewhere, depth = 0): Promise<Record<string, string>> {
  const key = path.resolve(file).toLowerCase();
  if (seen.has(key) || depth > 3 || !inside(file, root)) return {};
  seen.add(key);
  const p = await parsed(file);
  if (!p) return {};
  const out: Record<string, string> = {};
  for (const inp of p.inputs) {
    const local = [inp, `${inp}.tex`, `${inp}.sty`].map((c) => path.resolve(path.dirname(file), c)).find((c) => inside(c, root) && fs.existsSync(c) && fs.statSync(c).isFile());
    const target = local ?? (await elsewhere(path.basename(inp)));
    if (target) Object.assign(out, await withInputs(target, root, seen, elsewhere, depth + 1));
  }
  return Object.assign(out, p.macros);
}

export interface MacroLookup {
  /** name -> KaTeX macro body */
  macros: Record<string, string>;
  /** name -> the file it was taken from, relative to the project */
  sources: Record<string, string>;
  /** name -> why it was not used, for names that are defined somewhere */
  unresolved: Record<string, string>;
}

const normal = (body: string) => body.replace(/\s+/g, ' ').trim();

/**
 * Look up definitions for `names` (without backslash). `touched`: the TeX
 * files of this conversation, most recent first. `listAll`: every TeX file of
 * the project, asked for only when the conversation's own files do not settle
 * a name. Only files inside `root` are read.
 */
export async function findMacros(names: string[], root: string, touched: string[], listAll: () => Promise<string[]>): Promise<MacroLookup> {
  const out: MacroLookup = { macros: {}, sources: {}, unresolved: {} };
  const rel = (f: string) => path.relative(root, f).replace(/\\/g, '/');
  let left = [...new Set(names.filter((n) => NAME.test(n)))];

  // The project's files are listed at most once per lookup, and only if needed.
  let listing: Promise<string[]> | undefined;
  const all = () => (listing ??= listAll().then((files) => files.filter((f) => inside(f, root)).slice(0, 3000)));
  const elsewhere: Elsewhere = async (name) => {
    const wanted = [name, `${name}.tex`, `${name}.sty`].map((n) => n.toLowerCase());
    const hits = (await all()).filter((f) => wanted.includes(path.basename(f).toLowerCase()));
    return hits.length === 1 ? hits[0] : undefined;
  };

  for (const file of touched) {
    if (!left.length) break;
    const defs = await withInputs(file, root, new Set(), elsewhere);
    for (const n of left)
      if (n in defs) {
        out.macros[n] = defs[n];
        out.sources[n] = rel(file);
      }
    left = left.filter((n) => !(n in out.macros));
  }
  if (!left.length) return out;

  // Project-wide: used only when unanimous.
  const variants = new Map<string, Map<string, { body: string; file: string; count: number }>>();
  for (const file of await all()) {
    const p = await parsed(file);
    if (!p) continue;
    for (const n of left) {
      if (!(n in p.macros)) continue;
      const byBody = variants.get(n) ?? new Map();
      const k = normal(p.macros[n]);
      const v = byBody.get(k) ?? { body: p.macros[n], file, count: 0 };
      v.count++;
      byBody.set(k, v);
      variants.set(n, byBody);
    }
  }
  for (const [n, byBody] of variants) {
    const all = [...byBody.values()];
    if (all.length === 1) {
      out.macros[n] = all[0].body;
      out.sources[n] = rel(all[0].file);
    } else out.unresolved[n] = `defined in ${all.length} different ways across ${all.reduce((k, v) => k + v.count, 0)} files`;
  }
  return out;
}
