// Opening links from Claude's replies.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './config';

/** The real location of a path, following symlinks/junctions of its nearest existing ancestor. */
function realPath(p: string): string {
  let rest = '';
  for (let cur = p; ; cur = path.dirname(cur)) {
    try {
      return path.join(fs.realpathSync.native(cur), rest);
    } catch {
      if (path.dirname(cur) === cur) return p;
      rest = path.join(path.basename(cur), rest);
    }
  }
}

function isInside(file: string, root: string) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Open a link from a reply. Web links go to the browser (VS Code asks about
 * untrusted domains). Anything else must be a file or folder: network paths
 * (\\server\share) and other URI schemes are refused, because opening a network
 * path makes Windows connect to that server with your login; anything outside
 * the project needs a confirmation. A folder is shown in the Explorer; a file
 * opens in the editor VS Code uses for its type (so pictures open as pictures),
 * and is never run.
 */
export async function openLink(href: string, cwd: string) {
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  const m = href.match(/^(.*?)(?:#L(\d+)(?:-L?(\d+))?)?$/);
  if (!m) return;
  let file: string;
  try {
    file = decodeURIComponent(m[1]);
  } catch {
    return;
  }
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file);
  if (/^[\\/]{2}/.test(file) || scheme) {
    log(`refused link ${JSON.stringify(href).slice(0, 200)}`);
    void vscode.window.showWarningMessage(`Not opened: ${file.slice(0, 120)} is not a web link or a local file.`);
    return;
  }
  file = realPath(path.resolve(cwd, file));
  if (/^[\\/]{2}/.test(file)) {
    log(`refused link to a network location ${JSON.stringify(file).slice(0, 200)}`);
    void vscode.window.showWarningMessage('Not opened: that link leads to a network location.');
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    void vscode.window.showWarningMessage(`Not opened: ${file} does not exist.`);
    return;
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => realPath(f.uri.fsPath));
  if (![realPath(cwd), ...folders].some((r) => isInside(file, r))) {
    const what = stat.isDirectory() ? 'folder' : 'file';
    const ok = await vscode.window.showWarningMessage(`Open a ${what} outside this project?`, { modal: true, detail: file }, 'Open');
    if (ok !== 'Open') return;
  }
  const uri = vscode.Uri.file(file);
  if (stat.isDirectory()) {
    // The Explorer side bar only shows the workspace's own folders; anything else is shown in the file manager.
    await vscode.commands.executeCommand(folders.some((r) => isInside(file, r)) ? 'revealInExplorer' : 'revealFileInOS', uri);
    return;
  }
  const line = m[2] ? Math.max(0, Number(m[2]) - 1) : undefined;
  const end = line !== undefined && m[3] ? Math.max(line, Number(m[3]) - 1) : line;
  await vscode.commands.executeCommand('vscode.open', uri, {
    viewColumn: vscode.ViewColumn.One,
    preview: true,
    ...(line !== undefined ? { selection: new vscode.Range(line, 0, end!, 0) } : {}),
  });
}
