import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ViewConfig } from './shared/protocol';

export interface Config {
  view: ViewConfig;
  claudeExecutable: string;
  initialModel: string;
  initialPermissionMode: string;
  remoteControl: 'auto' | 'on' | 'off';
  prewarm: boolean;
  checkForUpdates: boolean;
}

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('claudePanel');
  return {
    view: {
      renderMath: c.get('renderMath', true),
      toolActivity: c.get('toolActivity', 'summary'),
      showThinking: c.get('showThinking', false),
      enterToSend: c.get('enterToSend', true),
      mathMacros: c.get('mathMacros', {}),
    },
    claudeExecutable: c.get('claudeExecutable', ''),
    initialModel: c.get('initialModel', ''),
    initialPermissionMode: c.get('initialPermissionMode', ''),
    remoteControl: c.get('remoteControl', 'auto'),
    prewarm: c.get('prewarm', true),
    checkForUpdates: c.get('checkForUpdates', true),
  };
}

let channel: vscode.OutputChannel | undefined;
/** Also written to %TEMP%/claude-panel.log (trimmed at 2 MB) for diagnosing problems after the fact. */
export const logFile = path.join(os.tmpdir(), 'claude-panel.log');
export function log(line: string) {
  channel ??= vscode.window.createOutputChannel('Claude Panel');
  const stamped = `${new Date().toISOString().slice(0, 23)} ${line}`;
  channel.appendLine(stamped);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, stamped + '\n');
  } catch {
    /* logging must never break the panel */
  }
}

export function showLog() {
  channel ??= vscode.window.createOutputChannel('Claude Panel');
  channel.show(true);
}

let bundledExe = '';
export function setBundledExecutable(p: string) {
  bundledExe = p;
}
/** claude.exe to run: the user's override, else the copy shipped in this extension. */
export function claudeExecutable(): string | undefined {
  return readConfig().claudeExecutable || bundledExe || undefined;
}
