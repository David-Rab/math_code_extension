// How many times a saved conversation was compacted. Read back through the
// SDK, a conversation starts at its latest compaction, so the earlier ones are
// only visible in the saved file itself: each is one "compact_boundary" line.
// The files are only read, line by line, and only those lines are parsed.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

export interface Compactions {
  count: number;
  last?: { at?: number; fromTokens?: number; auto?: boolean };
}

const ID = /^[0-9a-f-]{36}$/i;
const AGENT = /^[A-Za-z0-9_-]{1,64}$/;

/** The folder under ~/.claude/projects that holds this conversation, wherever its project lives. */
export function sessionFolder(sessionId: string, projects = path.join(os.homedir(), '.claude', 'projects')): string | undefined {
  if (!ID.test(sessionId)) return undefined;
  try {
    for (const d of fs.readdirSync(projects)) if (fs.existsSync(path.join(projects, d, `${sessionId}.jsonl`))) return path.join(projects, d);
  } catch {
    /* no saved conversations */
  }
  return undefined;
}

export async function countCompactions(file: string): Promise<Compactions> {
  const out: Compactions = { count: 0 };
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch {
    return out;
  }
  try {
    for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.includes('"compact_boundary"')) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m?.type !== 'system' || m.subtype !== 'compact_boundary') continue;
      const meta = m.compactMetadata ?? m.compact_metadata ?? {};
      const at = Date.parse(m.timestamp);
      const from = meta.preTokens ?? meta.pre_tokens;
      out.count++;
      out.last = { at: Number.isFinite(at) ? at : undefined, fromTokens: typeof from === 'number' ? from : undefined, auto: meta.trigger ? meta.trigger === 'auto' : undefined };
    }
  } catch {
    /* unreadable: report what was counted */
  }
  return out;
}

/** Compactions of a saved conversation and of each of its subagents (keyed by agent id). */
export async function savedCompactions(sessionId: string, projects?: string): Promise<{ main: Compactions; agents: Record<string, Compactions> }> {
  const none = { main: { count: 0 }, agents: {} };
  const dir = sessionFolder(sessionId, projects);
  if (!dir) return none;
  const main = await countCompactions(path.join(dir, `${sessionId}.jsonl`));
  const agents: Record<string, Compactions> = {};
  let files: string[] = [];
  try {
    files = fs.readdirSync(path.join(dir, sessionId, 'subagents'));
  } catch {
    /* no subagents */
  }
  for (const f of files) {
    const id = f.match(/^agent-(.+)\.jsonl$/)?.[1];
    if (!id || !AGENT.test(id)) continue;
    const c = await countCompactions(path.join(dir, sessionId, 'subagents', f));
    if (c.count) agents[id] = c;
  }
  return { main, agents };
}
