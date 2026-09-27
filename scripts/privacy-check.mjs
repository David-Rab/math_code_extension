// Blocks a commit that would publish personal data or secrets.
// Runs as the git pre-commit hook (scans the staged version of every staged
// file) and via `npm run check-privacy -- --all` (scans every tracked file).
//
// What it looks for:
//  - token/key shapes (Anthropic keys, bearer tokens, JWTs, private keys)
//  - email addresses other than the noreply ones used in commits
//  - absolute home paths that name a real user (C:\Users\<name>, /Users/<name>, /home/<name>)
//  - recorded-session tells: real thinking signatures, remote-control session URLs
//  - your own identifiers, read at check time (never stored in the repo):
//    account/organization ids and email from ~/.claude.json, your Windows user
//    name, and any extra strings listed in .privacy-denylist (git-ignored)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
// --files a b: check these files on disk (used to test the checker itself).
const fileArgs = process.argv.includes('--files') ? process.argv.slice(process.argv.indexOf('--files') + 1) : null;
const all = process.argv.includes('--all') || !!fileArgs;

const files = (fileArgs ?? (all ? git('ls-files') : git('diff', '--cached', '--name-only', '--diff-filter=ACMR')).split('\n'))
  .filter(Boolean)
  .filter((f) => f !== 'package-lock.json'); // registry URLs and integrity hashes only
const read = (f) => (all ? fs.readFileSync(f, 'utf8') : git('show', `:${f}`));

// Personal identifiers: from the local Claude config and the OS, plus a local denylist.
const personal = new Set();
const user = os.userInfo().username;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  const a = cfg.oauthAccount ?? {};
  for (const v of [a.accountUuid, a.organizationUuid, a.emailAddress, cfg.userID]) if (typeof v === 'string' && v.length > 5) personal.add(v);
} catch {
  /* no Claude config on this machine */
}
try {
  for (const line of fs.readFileSync('.privacy-denylist', 'utf8').split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) personal.add(t);
  }
} catch {
  /* optional */
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rules = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['OAuth token field', /"(access|refresh)_?token"\s*:\s*"[^"]{8,}"/i],
  ['email address', /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|anthropic\.com\b)[A-Za-z0-9.-]+\.[a-z]{2,}/],
  ['home path with a real user name', new RegExp(`(?:[A-Za-z]:[\\\\/]+Users[\\\\/]+|/Users/|/home/)(?!user\\b|x\\b|<)(${escape(user)}|[A-Za-z0-9._-]+)`, 'i')],
  ['Claude project-folder key with a user name', /\b[A-Za-z]--Users-(?!user\b)[A-Za-z0-9._]+-/],
  ['real thinking signature (can encode account ids)', /"signature"\s*:\s*"(?!sig")[A-Za-z0-9+/=]{20,}/],
  ['remote-control session URL', /claude\.ai\/code\/session_[A-Za-z0-9]{8,}/],
  ...[...personal].map((p) => ['your own identifier', new RegExp(escape(p), 'i')]),
];
// Allowed on purpose: the redaction patterns themselves, and the copyright holder.
const allowed = [/redact|\[redacted\]|privacy-check/i];

const findings = [];
for (const f of files) {
  let text;
  try {
    text = read(f);
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue; // binary
  text.split('\n').forEach((line, i) => {
    if (allowed.some((a) => a.test(line)) && /sk-ant-|Bearer|token|signature|session_/.test(line)) return;
    for (const [what, re] of rules) {
      const m = line.match(re);
      if (m) findings.push(`${f}:${i + 1}: ${what}: ${m[0].slice(0, 60)}`);
    }
  });
}

if (findings.length) {
  console.error(`privacy-check: ${findings.length} problem(s) — nothing was committed.\n`);
  for (const x of findings.slice(0, 50)) console.error('  ' + x);
  console.error('\nRemove or replace these (use placeholders such as C:\\Users\\user or 00000000-...), then commit again.');
  process.exit(1);
}
console.log(`privacy-check: ${files.length} file(s) clean.`);
