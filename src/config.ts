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

/** Masks anything that looks like a credential before it reaches a log or report. */
export function redact(s: string): string {
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[redacted]')
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/("?(?:access|refresh|id)_?token"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[redacted]')
    .replace(/claude\.ai\/code\/session_[A-Za-z0-9]+/g, 'claude.ai/code/session_[redacted]');
}

let channel: vscode.OutputChannel | undefined;
/** Also written to %TEMP%/mathpanel.log (trimmed at 2 MB) for diagnosing problems after the fact. */
export const logFile = path.join(os.tmpdir(), 'mathpanel.log');
export function log(line: string) {
  channel ??= vscode.window.createOutputChannel('MathPanel');
  const stamped = `${new Date().toISOString().slice(0, 23)} ${redact(line)}`;
  channel.appendLine(stamped);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, stamped + '\n');
  } catch {
    /* logging must never break the panel */
  }
}

export function showLog() {
  channel ??= vscode.window.createOutputChannel('MathPanel');
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
