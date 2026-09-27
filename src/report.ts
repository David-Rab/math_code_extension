// "Report a problem": saves your description plus diagnostics as a Markdown
// file in the extension's source project (bug-reports/), where a Claude
// session working on the extension picks it up. Nothing leaves the machine.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log, logFile } from './config';
import { readBuildInfo } from './updates';
import type { ChatSession } from './session';

export async function reportProblem(extPath: string, session: ChatSession | undefined) {
  const description = await vscode.window.showInputBox({
    title: 'Report a problem with Claude Panel',
    prompt: 'What went wrong, and what did you expect? (Saved locally for Claude to fix.)',
    placeHolder: 'e.g. the rewind menu did nothing when I clicked "Rewind code to here"',
    ignoreFocusOut: true,
  });
  if (!description?.trim()) return;

  const info = readBuildInfo(extPath);
  const now = new Date();
  const lines: string[] = [];
  lines.push(`# ${description.trim().split('\n')[0].slice(0, 90)}`, '');
  lines.push(`- **Reported:** ${now.toISOString()}`);
  lines.push(`- **Status:** open`);
  const version = JSON.parse(fs.readFileSync(path.join(extPath, 'package.json'), 'utf8')).version;
  lines.push(`- **Panel:** ${version} · Claude Code ${info?.claudeCodeVersion ?? '?'} · VS Code ${vscode.version}`);
  if (session) {
    const st = session.status;
    lines.push(`- **Session:** ${st.sessionId ?? '(not started)'}${st.title ? ` “${st.title}”` : ''}`);
    lines.push(`- **Folder:** ${session.cwd}`);
    lines.push(`- **State:** model ${st.model ?? '?'} · mode ${st.permissionMode ?? '?'} · effort ${st.effort ?? '-'} · busy ${st.busy} · starting ${st.starting} · remote ${st.remote.state}`);
    const threads = [...session.transcript.threads.values()];
    lines.push(`- **Tabs:** ${threads.map((t) => `${t.title} (${t.status})`).join(', ')}`);
  } else lines.push('- **Session:** none active');
  lines.push('', '## What happened', '', description.trim(), '');

  if (session) {
    const all = [...session.transcript.items.entries()].flatMap(([thread, items]) => items.map((i) => ({ thread, i })));
    const odd = all.filter(({ i }) => i.kind === 'unknown' || (i.kind === 'notice' && i.level !== 'info'));
    if (odd.length) {
      lines.push('## Warnings, errors and unsupported events in this session', '');
      for (const { thread, i } of odd.slice(-20))
        lines.push(`- [${thread === 'main' ? 'main' : 'subagent'}] ${i.kind === 'unknown' ? `unsupported event ${i.label}` : `${(i as any).level}: ${(i as any).text}`}`);
      lines.push('');
    }
    const recent = (session.transcript.items.get('main') ?? []).slice(-8).map((i) => {
      const text = 'text' in i ? String((i as any).text).replace(/\s+/g, ' ').slice(0, 160) : '';
      return `- ${i.kind}${'state' in i ? ` (${(i as any).state})` : ''}${text ? `: ${text}` : ''}`;
    });
    lines.push('## Last items in the main tab', '', ...recent, '');
  }

  try {
    const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-150).join('\n');
    lines.push('## Panel log (last 150 lines)', '', '```', tail.trimEnd(), '```', '');
  } catch {
    lines.push('_(panel log not readable)_', '');
  }

  // The source project when it exists (so a Claude session there finds it), else the extension's own storage.
  const dir = info?.sourceDir && fs.existsSync(path.join(info.sourceDir, 'package.json')) ? path.join(info.sourceDir, 'bug-reports') : path.join(extPath, 'bug-reports');
  fs.mkdirSync(dir, { recursive: true });
  const slug = description.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'problem';
  const file = path.join(dir, `${now.toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${slug}.md`);
  fs.writeFileSync(file, lines.join('\n'));
  log(`problem report saved: ${file}`);
  const choice = await vscode.window.showInformationMessage(
    'Problem report saved. Ask Claude in the code_extension project to look at the bug reports.',
    'Open report',
  );
  if (choice === 'Open report') await vscode.window.showTextDocument(vscode.Uri.file(file));
}
