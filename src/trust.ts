// Folder trust. Claude Code ignores a folder's own settings (permission rules,
// hooks, MCP servers) until the folder is trusted. The panel asks you, and on
// "Trust" passes Claude Code's launch-time trust attestation so Claude Code
// records the trust itself; the panel only ever reads ~/.claude.json.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from './config';

let state: vscode.Memento | undefined;
export function initTrust(globalState: vscode.Memento) {
  state = globalState;
}

const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * The folder a trust decision covers: the git repository root, else the folder
 * itself. Found by looking for .git in the folder and its parents. No process is
 * started: running a bare "git" with the workspace as the current directory would
 * let a repository supply its own git.exe on Windows.
 */
export async function trustRoot(cwd: string): Promise<string> {
  const upper = (p: string) => (/^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p);
  for (let p = path.resolve(cwd); ; p = path.dirname(p)) {
    if (fs.existsSync(path.join(p, '.git'))) return upper(p);
    if (path.dirname(p) === p) return upper(cwd);
  }
}

/**
 * Whether Claude Code already trusts this folder (or a folder above it).
 * undefined when that cannot be read; then the panel does not ask.
 */
export function isTrusted(root: string): boolean | undefined {
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).projects ?? {};
    const trusted = new Set(
      Object.entries<any>(projects)
        .filter(([, v]) => v?.hasTrustDialogAccepted === true)
        // Claude Code keys trust by exact spelling ("C:" and "c:" differ), and the
        // panel always launches with "C:", so compare exact spellings.
        .map(([k]) => k.replace(/\\/g, '/').replace(/\/+$/, '')),
    );
    const exact = (p: string) => trusted.has(p.replace(/\\/g, '/').replace(/\/+$/, ''));
    for (let p = root; ; p = path.dirname(p)) {
      if (exact(p)) return true;
      if (path.dirname(p) === p) return false;
    }
  } catch (e) {
    log(`trust check: ${(e as Error).message}`);
    return undefined;
  }
}

export function neverAsk(root: string): boolean {
  return (state?.get<string[]>('claudePanel.untrustedFolders') ?? []).includes(key(root));
}

export async function rememberNeverAsk(root: string) {
  const list = state?.get<string[]>('claudePanel.untrustedFolders') ?? [];
  if (!list.includes(key(root))) await state?.update('claudePanel.untrustedFolders', [...list, key(root)]);
}
