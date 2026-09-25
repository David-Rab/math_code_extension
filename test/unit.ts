// Unit checks for Transcript logic that the live e2e run cannot force:
// progress lists, sign-in detection, newly classified events, images and
// fork points.
import { Transcript } from '../src/transcript';

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 300)}`}`);
};
const asst = (content: any[], extra: any = {}) => ({ type: 'assistant', parent_tool_use_id: null, message: { content }, ...extra });
const toolResult = (id: string, content: any, extra: any = {}) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra });

// --- TodoWrite
{
  const t = new Transcript();
  t.handle(asst([{ type: 'tool_use', id: 'a', name: 'TodoWrite', input: { todos: [
    { content: 'Read the paper', activeForm: 'Reading the paper', status: 'completed' },
    { content: 'Prove the lemma', activeForm: 'Proving the lemma', status: 'in_progress' },
    { content: 'Write it up', activeForm: 'Writing it up', status: 'pending' },
  ] } }]));
  const todos = t.todos.get('main') ?? [];
  check('TodoWrite fills the progress list', todos.length === 3 && todos[1].status === 'in_progress', todos);
  check('TodoWrite is not shown as tool activity', !(t.items.get('main') ?? []).some((i) => i.kind === 'tools'));
}

// --- TaskCreate / TaskUpdate
{
  const t = new Transcript();
  t.handle(asst([{ type: 'tool_use', id: 'c1', name: 'TaskCreate', input: { subject: 'Step one', description: 'x' } }]));
  t.handle(toolResult('c1', 'Task #7 created successfully: Step one', { tool_use_result: { task: { id: '7', subject: 'Step one' } } }));
  t.handle(asst([{ type: 'tool_use', id: 'c2', name: 'TaskCreate', input: { subject: 'Step two', description: 'y' } }]));
  t.handle(toolResult('c2', 'Task #8 created successfully: Step two'));
  t.handle(asst([{ type: 'tool_use', id: 'u1', name: 'TaskUpdate', input: { taskId: '7', status: 'completed' } }]));
  t.handle(asst([{ type: 'tool_use', id: 'u2', name: 'TaskUpdate', input: { taskId: '8', status: 'in_progress' } }]));
  const todos = t.todos.get('main') ?? [];
  check('TaskCreate gets real ids (structured and from text)', todos.map((x) => x.id).join() === '7,8', todos);
  check('TaskUpdate changes status', todos[0]?.status === 'completed' && todos[1]?.status === 'in_progress', todos);
  t.handle(asst([{ type: 'tool_use', id: 'u3', name: 'TaskUpdate', input: { taskId: '7', status: 'deleted' } }]));
  check('TaskUpdate deleted removes it', (t.todos.get('main') ?? []).length === 1);
}

// --- subagent progress list stays in its tab
{
  const t = new Transcript();
  t.handle(asst([{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'helper', prompt: 'do it' } }]));
  t.handle(asst([{ type: 'tool_use', id: 's1', name: 'TodoWrite', input: { todos: [{ content: 'sub step', status: 'pending', activeForm: 'x' }] } }], { parent_tool_use_id: 'ag' }));
  check('subagent progress list is per tab', (t.todos.get('ag') ?? []).length === 1 && !t.todos.get('main'));
}

// --- sign-in detection
{
  const t = new Transcript();
  const r1 = t.handle(asst([{ type: 'text', text: 'x' }], { error: 'authentication_failed' }));
  check('assistant authentication_failed asks for sign-in', r1.auth === 'authentication_failed', r1);
  const r2 = t.handle({ type: 'result', subtype: 'success', is_error: true, result: 'OAuth token has expired. Please run /login.' });
  check('expired token result asks for sign-in', !!r2.auth, r2);
  const r3 = t.handle({ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long' });
  check('other errors do not ask for sign-in', !r3.auth, r3);
}

// --- newly classified events
{
  const t = new Transcript();
  const quiet = ['post_turn_summary', 'control_request_progress', 'worker_shutting_down', 'bridge_state'].map((subtype) => t.handle({ type: 'system', subtype }));
  check('known system events are not "unsupported"', quiet.every((r) => !r.unknown));
  t.handle({ type: 'conversation_reset', trigger: 'clear', new_conversation_id: 'n' });
  check('/clear shows a notice', (t.items.get('main') ?? []).some((i) => i.kind === 'notice' && /cleared/.test(i.text)));
  const r = t.handle({ type: 'system', subtype: 'brand_new_thing' });
  check('unknown events still surface', !!r.unknown && (t.items.get('main') ?? []).some((i) => i.kind === 'unknown'));
}

// --- history: images, uuids and fork points
{
  const t = new Transcript();
  t.handle({ type: 'user', uuid: 'u1', parent_tool_use_id: null, message: { content: 'first' } }, true);
  t.handle({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'reply' }] } }, true);
  t.handle({ type: 'user', uuid: 'u2', parent_tool_use_id: null, message: { content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: 'what is this?' },
  ] } }, true);
  const users = (t.items.get('main') ?? []).filter((i) => i.kind === 'user') as any[];
  check('history user messages keep their uuid', users[0]?.uuid === 'u1' && users[1]?.uuid === 'u2', users);
  check('first message has no fork point, second forks after the reply', users[0]?.forkPoint === undefined && users[1]?.forkPoint === 'a1', users.map((u) => u.forkPoint));
  check('history images become thumbnails', users[1]?.images?.[0] === 'data:image/png;base64,AAAA', users[1]);
  t.addUser('live one', 'u3');
  const live = (t.items.get('main') ?? []).filter((i) => i.kind === 'user').pop() as any;
  check('live message forks after the latest message', live.forkPoint === 'u2' && live.uuid === 'u3', live);
}

// --- subagent timing
{
  const t = new Transcript();
  t.handle(asst([{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'timed' } }], { timestamp: '2026-09-25T10:00:00Z' }));
  t.handle(toolResult('ag', 'done', { timestamp: '2026-09-25T10:02:30Z' }));
  const th = t.threads.get('ag')!;
  check('subagent start/end times from history', th.endedAt! - th.startedAt! === 150_000, th);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
