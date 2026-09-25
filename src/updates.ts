// Detects Claude Code releases newer than the bundled one, shows what changed,
// and can rebuild + reinstall this extension against the new version.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './config';

export interface BuildInfo {
  sdkVersion: string;
  claudeCodeVersion: string;
  sourceDir: string;
}

export function readBuildInfo(extPath: string): BuildInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(extPath, 'dist', 'build-info.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

export interface Latest {
  sdkVersion: string;
  claudeCodeVersion: string;
}

export async function fetchLatest(): Promise<Latest | undefined> {
  try {
    const r = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest', { signal: AbortSignal.timeout(10000) });
    const j: any = await r.json();
    const sdkVersion = String(j.version ?? '');
    const claudeCodeVersion = String(j.claudeCodeVersion ?? j.version ?? '');
    // These strings end up in a terminal command: accept plain x.y.z only.
    const plain = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
    if (!plain.test(sdkVersion) || !plain.test(claudeCodeVersion)) {
      log(`update check: ignoring unexpected version ${JSON.stringify([sdkVersion, claudeCodeVersion]).slice(0, 100)}`);
      return undefined;
    }
    return { sdkVersion, claudeCodeVersion };
  } catch (e) {
    log(`update check failed: ${(e as Error).message}`);
    return undefined;
  }
}

export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** The CHANGELOG.md sections for versions after `since`, up to and including `upTo`. */
export async function changelogSince(since: string, upTo: string): Promise<string> {
  try {
    const r = await fetch('https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md', { signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    const sections = text.split(/^## /m).slice(1);
    const wanted = sections.filter((s) => {
      const v = s.split('\n')[0].trim();
      return /^\d+\.\d+\.\d+$/.test(v) && newer(v, since) && !newer(v, upTo);
    });
    return wanted.length ? wanted.map((s) => '## ' + s.trim()).join('\n\n') : '_No changelog entries found for these versions._';
  } catch (e) {
    return `_Could not fetch the changelog: ${(e as Error).message}_`;
  }
}

export async function showChangelog(current: string, latest: string) {
  const body = await changelogSince(current, latest);
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `# Claude Code changes since ${current}\n\nThis panel bundles Claude Code ${current}; the latest is ${latest}.\nNew message types that this panel does not know yet appear as "Unsupported event" cards until it is updated.\n\n${body}\n`,
  });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
}

/** Rebuild this extension against the latest SDK in a terminal, then reinstall it. */
export function runUpdate(info: BuildInfo, latest: Latest) {
  if (!fs.existsSync(path.join(info.sourceDir, 'package.json'))) {
    void vscode.window.showErrorMessage(`Claude Panel source folder not found: ${info.sourceDir}`);
    return;
  }
  const term = vscode.window.createTerminal({ name: 'Claude Panel update', cwd: info.sourceDir, shellPath: 'cmd.exe' });
  term.show();
  term.sendText(
    `npm install @anthropic-ai/claude-agent-sdk@${latest.sdkVersion} --save-exact && npm run typecheck && npm test && npm run package && code --install-extension claude-panel.vsix --force && echo "Done: reload the window to use Claude Code ${latest.claudeCodeVersion}."`,
  );
}
