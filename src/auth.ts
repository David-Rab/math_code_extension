// Sign-in state and the sign-in flow. The panel never sees credentials: it
// asks the bundled claude.exe for its status, and signing in runs Claude
// Code's own `auth login` (browser OAuth) in a VS Code terminal.
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { claudeExecutable, log } from './config';

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
}

let last: AuthStatus | undefined;
const listeners = new Set<(s: AuthStatus) => void>();

/** Last known status (undefined until checked). */
export function knownAuth(): AuthStatus | undefined {
  return last;
}

export function onAuthChange(l: (s: AuthStatus) => void): vscode.Disposable {
  listeners.add(l);
  return { dispose: () => listeners.delete(l) };
}

export function checkAuth(): Promise<AuthStatus | undefined> {
  const exe = claudeExecutable();
  if (!exe) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(exe, ['auth', 'status', '--json'], { timeout: 30000, windowsHide: true }, (err, stdout) => {
      try {
        const j = JSON.parse(stdout);
        const s: AuthStatus = { loggedIn: !!j.loggedIn, email: j.email, subscriptionType: j.subscriptionType };
        const changed = last?.loggedIn !== s.loggedIn;
        last = s;
        if (changed) for (const l of listeners) l(s);
        resolve(s);
      } catch {
        log(`auth status failed: ${err?.message ?? stdout.slice(0, 200)}`);
        resolve(undefined);
      }
    });
  });
}

let running: Promise<boolean> | undefined;

/**
 * Run Claude Code's own sign-in in a terminal and wait until it succeeds or
 * the terminal is closed. Only one sign-in runs at a time; later callers share it.
 */
export function signIn(): Promise<boolean> {
  running ??= (async () => {
    const exe = claudeExecutable();
    if (!exe) return false;
    // The executable is started directly (no shell), with fixed arguments.
    const term = vscode.window.createTerminal({ name: 'Claude sign-in', shellPath: exe, shellArgs: ['auth', 'login', '--claudeai'] });
    term.show();
    let closed = false;
    const sub = vscode.window.onDidCloseTerminal((t) => {
      if (t === term) closed = true;
    });
    try {
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await checkAuth();
        if (s?.loggedIn) {
          if (!closed) term.dispose();
          void vscode.window.showInformationMessage(`Signed in to Claude${s.email ? ` as ${s.email}` : ''}.`);
          return true;
        }
        if (closed) return false;
      }
      return false;
    } finally {
      sub.dispose();
      running = undefined;
    }
  })();
  return running;
}
