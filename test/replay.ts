// Replays a recorded SDK stream through Transcript and prints the result.
// Usage: node --experimental-strip-types test/replay.ts <stream.jsonl>
import fs from 'node:fs';
import { Transcript } from '../src/transcript';

const file = process.argv[2] ?? 'test/fixtures/probe-stream.jsonl';
const t = new Transcript();
let unknown = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  if (t.handle(JSON.parse(line)).unknown) unknown++;
}
for (const th of t.threads.values()) {
  console.log(`\n=== [${th.id}] ${th.title} (${th.status}${th.background ? ', background' : ''}${th.agentType ? ', ' + th.agentType : ''})`);
  for (const it of t.items.get(th.id)!) {
    const body = it.kind === 'tools' ? it.tools.map((x) => `${x.name}(${x.summary}) ${x.status}`).join(', ')
      : 'text' in it ? it.text.slice(0, 100) : it.kind === 'agent' ? `-> tab ${it.threadId} "${it.title}"` : it.kind === 'unknown' ? it.label : '';
    console.log(`  ${it.kind.padEnd(9)} ${body}`);
  }
}
console.log(`\nunknown message kinds: ${unknown}; drafts left: ${t.drafts.size}`);
