import * as vscode from 'vscode';
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
export function log(line: string) {
  channel ??= vscode.window.createOutputChannel('Claude Panel');
  channel.appendLine(`${new Date().toISOString().slice(11, 23)} ${line}`);
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
