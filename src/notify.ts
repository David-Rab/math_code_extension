// Sound and VS Code notifications for "Claude needs you" and "Claude finished".
// Both only fire when you are not already looking at that panel.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { log } from './config';

export type NotifyKind = 'needsYou' | 'done';

const DEFAULT_SOUNDS: Record<NotifyKind, string> = {
  needsYou: 'C:\\Windows\\Media\\Windows Notify Messaging.wav',
  done: 'C:\\Windows\\Media\\chimes.wav',
};

function wants(setting: string, kind: NotifyKind): boolean {
  const v = vscode.workspace.getConfiguration('claudePanel').get<string>(setting, setting === 'sound' ? 'needsYou' : 'needsYouAndDone');
  return v === 'needsYouAndDone' || (v === 'needsYou' && kind === 'needsYou');
}

let lastSound = 0;
function playSound(kind: NotifyKind) {
  if (process.platform !== 'win32' || Date.now() - lastSound < 2500) return;
  const c = vscode.workspace.getConfiguration('claudePanel');
  const file = c.get<string>(kind === 'needsYou' ? 'soundNeedsYou' : 'soundDone', '') || DEFAULT_SOUNDS[kind];
  if (!/\.wav$/i.test(file) || !fs.existsSync(file)) return;
  lastSound = Date.now();
  // The path travels in an environment variable, never inside the command text.
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object System.Media.SoundPlayer $env:CLAUDE_PANEL_SOUND).PlaySync()'], {
    env: { ...process.env, CLAUDE_PANEL_SOUND: file },
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  p.on('error', (e) => log(`sound: ${e.message}`));
  p.unref();
}

/**
 * `attended`: the user is looking at this panel right now, so stay quiet.
 * `reveal`: what the notification's "Show" button does.
 */
export function notify(kind: NotifyKind, message: string, attended: boolean, reveal: () => void) {
  if (attended) return;
  if (wants('sound', kind)) playSound(kind);
  if (wants('notification', kind)) {
    void vscode.window.showInformationMessage(message, 'Show').then((choice) => {
      if (choice === 'Show') reveal();
    });
  }
}
