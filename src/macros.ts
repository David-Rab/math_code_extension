// Your own math macros: one file you write, in LaTeX, that formulas in the
// panel can use. It lives in the extension's user-level storage (not in any
// project), is opened with "MathPanel: Edit Math Macros", and is the only file
// read: no project file is ever looked at. Definitions are plain text handed
// to KaTeX, which runs untrusted (no links, images, HTML or styles) with
// bounded expansion.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const TEMPLATE = `% MathPanel macros
%
% Formulas in the panel can use the macros defined in this file. Write them as
% in a LaTeX preamble; a saved change applies to open panels at once. Examples:
%
%   \\newcommand{\\iso}{\\cong}
%   \\newcommand{\\pair}[2]{\\langle #1, #2 \\rangle}
%   \\DeclareMathOperator{\\Hom}{Hom}
%   \\def\\R{\\mathbb{R}}
%
% Understood: \\newcommand, \\renewcommand, \\providecommand, \\DeclareMathOperator,
% \\DeclarePairedDelimiter, \\def, \\let. Not supported: a macro with an optional
% argument. Everything else in this file is ignored, so you can paste a whole
% preamble. The mathMacros setting, if you use it, wins over this file.

`;

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

let file: string | undefined;
let loaded: Record<string, string> = {};
let stamp = '';

/** Where the file is: `dir` is the extension's own user-level storage folder. */
export function initMacroFile(dir: string) {
  file = path.join(dir, 'macros.tex');
  reloadMacroFile();
}

export function macroFilePath(): string | undefined {
  return file;
}

/** Read the file again if it changed. Returns true when the macros are different now. */
export function reloadMacroFile(): boolean {
  if (!file) return false;
  let next: Record<string, string> = {};
  let now = '';
  try {
    const st = fs.statSync(file);
    now = `${st.mtimeMs}:${st.size}`;
    if (now === stamp) return false;
    // Keyed as KaTeX wants them, with the backslash.
    next = Object.fromEntries(Object.entries(parseMacros(fs.readFileSync(file, 'utf8'))).map(([name, body]) => [`\\${name}`, body]));
  } catch {
    /* no file yet: no macros */
  }
  const changed = JSON.stringify(next) !== JSON.stringify(loaded);
  stamp = now;
  loaded = next;
  return changed;
}

/** The macros of the file, as `\name` -> body. */
export function fileMacros(): Record<string, string> {
  return loaded;
}

/** Make sure the file exists (with an explanation and examples) and return its path. */
export function ensureMacroFile(): string | undefined {
  if (!file) return undefined;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, TEMPLATE);
  }
  return file;
}
