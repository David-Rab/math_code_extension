// "Report a problem": saves your description plus diagnostics as a Markdown
// file in the extension's source project (bug-reports/), where a Claude
// session working on the extension picks it up. Nothing leaves the machine.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log, logFile, redact } from './config';
import { readBuildInfo } from './updates';
import type { ChatSession } from './session';
import type { ImageAttachment } from './shared/protocol';

/**
 * Ask for the report. With a panel open, its own form is used (several lines,
 * pasted text and screenshots); without one, a one-line input box.
 */
export async function reportProblem(extPath: string, session: ChatSession | undefined) {
  if (session) {
    session.showReportForm();
    return;
  }
  const description = await vscode.window.showInputBox({
    title: 'Report a problem with MathPanel',
    prompt: 'What went wrong, and what did you expect? (Saved locally for Claude to fix. Open a panel first to write more or paste screenshots.)',
    placeHolder: 'e.g. the rewind menu did nothing when I clicked "Rewind code to here"',
    ignoreFocusOut: true,
  });
  if (description?.trim()) await saveReport(extPath, undefined, description, []);
}

const EXT: Record<ImageAttachment['mediaType'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** The report's Markdown, without the log. Pure, so it can be tested. */
export function reportBody(description: string, panelLine: string, session: ChatSession | undefined, imageFiles: string[], now: Date): string {
  const text = description.trim() || '(screenshots only)';
  const lines: string[] = [];
  lines.push(`# ${text.split('\n')[0].trim().slice(0, 90)}`, '');
  lines.push(`- **Reported:** ${now.toISOString()}`);
  lines.push(`- **Status:** open`);
  lines.push(`- **Panel:** ${panelLine}`);
  if (session) {
    const st = session.status;
    lines.push(`- **Session:** ${st.sessionId ?? '(not started)'}${st.title ? ` “${st.title}”` : ''}`);
    lines.push(`- **Folder:** ${session.cwd}`);
    lines.push(`- **State:** model ${st.model ?? '?'} · mode ${st.permissionMode ?? '?'} · effort ${st.effort ?? '-'} · busy ${st.busy} · starting ${st.starting} · remote ${st.remote.state}`);
    const threads = [...session.transcript.threads.values()];
    lines.push(`- **Tabs:** ${threads.map((t) => `${t.title} (${[t.agentType, t.status].filter(Boolean).join(', ')})`).join(', ')}`);
  } else lines.push('- **Session:** none active');
  lines.push('', '## What happened', '', text, '');
  if (imageFiles.length) lines.push('## Screenshots', '', ...imageFiles.map((f, i) => `![screenshot ${i + 1}](${f})`), '');

  if (session) {
    const all = [...session.transcript.items.entries()].flatMap(([thread, items]) => items.map((i) => ({ thread, i })));
    const odd = all.filter(({ i }) => i.kind === 'unknown' || (i.kind === 'notice' && i.level !== 'info'));
    if (odd.length) {
      lines.push('## Warnings, errors and unsupported events in this session', '');
      for (const { thread, i } of odd.slice(-20))
        lines.push(`- [${thread === 'main' ? 'main' : 'subagent'}] ${i.kind === 'unknown' ? `unsupported event ${i.label}` : `${(i as any).level}: ${(i as any).text}`}`);
      lines.push('');
      // The first event of each unsupported kind, in full: what is needed to add support for it.
      const firstOfKind = new Map<string, string>();
      for (const { i } of odd) if (i.kind === 'unknown' && !firstOfKind.has(i.label)) firstOfKind.set(i.label, i.raw);
      for (const [label, raw] of [...firstOfKind].slice(0, 5)) lines.push(`### Unsupported event ${label}`, '', '~~~~', raw.slice(0, 2000).replace(/~~~~/g, '~ ~ ~ ~'), '~~~~', '');
    }
    const recent = (session.transcript.items.get('main') ?? []).slice(-8).map((i) => {
      const text = i.kind === 'unknown' ? i.label : 'text' in i ? String((i as any).text).replace(/\s+/g, ' ').slice(0, 160) : '';
      return `- ${i.kind}${'state' in i ? ` (${(i as any).state})` : ''}${text ? `: ${text}` : ''}`;
    });
    lines.push('## Last items in the main tab', '', ...recent, '');
  }
  return lines.join('\n');
}

export async function saveReport(extPath: string, session: ChatSession | undefined, description: string, images: ImageAttachment[]) {
  const info = readBuildInfo(extPath);
  const now = new Date();
  // The source project when it exists (so a Claude session there finds it), else the extension's own storage.
  const dir = info?.sourceDir && fs.existsSync(path.join(info.sourceDir, 'package.json')) ? path.join(info.sourceDir, 'bug-reports') : path.join(extPath, 'bug-reports');
  fs.mkdirSync(dir, { recursive: true });
  const slug = description.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'problem';
  const base = `${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${slug}`;

  // Screenshots are saved next to the report, under names made here (never from the webview).
  const imageFiles: string[] = [];
  for (const [i, im] of images.entries()) {
    const ext = EXT[im.mediaType];
    if (!ext) continue;
    const name = `${base}-${i + 1}.${ext}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(im.data, 'base64'));
    imageFiles.push(name);
  }

  const version = JSON.parse(fs.readFileSync(path.join(extPath, 'package.json'), 'utf8')).version;
  const panelLine = `${version} · Claude Code ${info?.claudeCodeVersion ?? '?'} · VS Code ${vscode.version}`;
  const lines = [reportBody(description, panelLine, session, imageFiles, now)];
  try {
    const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-150).join('\n');
    lines.push('## Panel log (last 150 lines)', '', '~~~~', tail.trimEnd().replace(/~~~~/g, '~ ~ ~ ~'), '~~~~', '');
  } catch {
    lines.push('_(panel log not readable)_', '');
  }

  const file = path.join(dir, `${base}.md`);
  fs.writeFileSync(file, redact(lines.join('\n')));
  log(`problem report saved: ${file}`);
  const choice = await vscode.window.showInformationMessage(
    'Problem report saved. Ask Claude in the code_extension project to look at the bug reports.',
    'Open report',
  );
  if (choice === 'Open report') await vscode.window.showTextDocument(vscode.Uri.file(file));
}
