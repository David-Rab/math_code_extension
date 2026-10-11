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

// --- events Claude Code sends that the SDK's types do not list yet
{
  const t = new Transcript();
  t.setMainRunning(true);
  const r = t.handle({ type: 'system', subtype: 'task_summary', detail: 'Reading the test files' });
  check('task_summary is not "unsupported"', !r.unknown && !(t.items.get('main') ?? []).some((i) => i.kind === 'unknown'));
  check('task_summary says what Claude is doing', t.threads.get('main')!.activity === 'Reading the test files', t.threads.get('main'));
  t.handle({ type: 'system', subtype: 'task_summary', detail: null });
  check('an empty task_summary clears it', t.threads.get('main')!.activity === undefined);
  t.handle({ type: 'system', subtype: 'task_summary', detail: 'Reading files' });
  t.setMainRunning(false);
  check('the summary goes away when the turn ends', t.threads.get('main')!.activity === undefined);
  const quiet = [{ type: 'system', subtype: 'session_metadata', metadata: {} }, { type: 'active_goal', value: null }, { type: 'autocompact_state', value: {} }].map((m) => t.handle(m));
  check('session_metadata, active_goal, autocompact_state are not "unsupported"', quiet.every((x) => !x.unknown));
  // 2.1.287: the session title, and what plugins ("Claude Mods") draw.
  const mods = ['session_title_changed', 'ui_status', 'ui_log', 'ui_panes', 'ui_scroll', 'ui_focus', 'ui_invalidate'].map((subtype) => t.handle({ type: 'system', subtype, title: 'x', plugin: 'p', text: 'y' }));
  check('session_title_changed and plugin panes are not "unsupported"', mods.every((x) => !x.unknown) && !(t.items.get('main') ?? []).some((i) => i.kind === 'unknown'));
  const toast = t.handle({ type: 'system', subtype: 'ui_toast', plugin: 'you-should-know', text: 'The tests were not run.', timeout_ms: 5000 });
  check("a plugin's notification is shown", !toast.unknown && (t.items.get('main') ?? []).some((i) => i.kind === 'notice' && i.text === 'you-should-know: The tests were not run.'), t.items.get('main'));
}

// --- only agents get a tab; a shell command gets one only while it runs in the background
{
  const t = new Transcript();
  t.handle(asst([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }]));
  t.handle({ type: 'system', subtype: 'task_started', task_id: 'k1', tool_use_id: 'b1', description: 'Run the tests', task_type: 'local_bash', is_backgrounded: false });
  check('a foreground shell command gets no tab', !t.threads.has('b1') && t.threads.size === 1, [...t.threads.keys()]);
  t.handle({ type: 'system', subtype: 'task_updated', task_id: 'k1', patch: { status: 'completed' } });
  t.handle({ type: 'system', subtype: 'task_notification', task_id: 'k1', tool_use_id: 'b1', status: 'completed' });
  check('…also not when it finishes', t.threads.size === 1);

  t.handle({ type: 'system', subtype: 'task_started', task_id: 'k2', tool_use_id: 'b2', description: 'Dev server', task_type: 'local_bash', is_backgrounded: true });
  const bg = t.threads.get('b2');
  check('a background shell command gets a tab that can be stopped', bg?.agentType === 'background command' && bg.taskId === 'k2' && bg.background === true, bg);

  t.handle({ type: 'system', subtype: 'task_started', task_id: 'k3', tool_use_id: 'b3', description: 'Long build', task_type: 'local_bash', is_backgrounded: false });
  t.handle({ type: 'system', subtype: 'task_updated', task_id: 'k3', patch: { is_backgrounded: true } });
  check('a command moved to the background gets a tab then', t.threads.get('b3')?.status === 'running' && t.threads.get('b3')?.taskId === 'k3', t.threads.get('b3'));
  t.handle({ type: 'system', subtype: 'task_updated', task_id: 'k3', patch: { status: 'killed' } });
  check('…and its status follows the task', t.threads.get('b3')?.status === 'stopped');

  t.handle({ type: 'system', subtype: 'task_started', task_id: 'k4', tool_use_id: 'h1', description: 'housekeeping', task_type: 'local_agent', skip_transcript: true });
  check('housekeeping tasks get no tab', !t.threads.has('h1'));
}

// --- what the agent map shows about a subagent: kind, model, context, activity
{
  const t = new Transcript();
  t.handle(asst([{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'helper', prompt: 'do it' } }]));
  check('an Agent call without a type is the general-purpose agent', t.threads.get('ag')?.agentType === 'general-purpose', t.threads.get('ag'));
  t.handle({ type: 'system', subtype: 'task_started', task_id: 'k', tool_use_id: 'ag', description: 'helper', subagent_type: 'Explore', task_type: 'local_agent' });
  check('task_started names the agent type', t.threads.get('ag')?.agentType === 'Explore' && t.threads.get('ag')?.taskId === 'k', t.threads.get('ag'));
  const usage = { input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 5_000, output_tokens: 90 };
  t.handle(asst([{ type: 'text', text: 'hi' }], { parent_tool_use_id: 'ag', message: { model: 'claude-haiku-4-5-20251001', usage, content: [{ type: 'text', text: 'hi' }] } }));
  const th = t.threads.get('ag')!;
  check("a subagent's replies give its model and context size", th.model === 'claude-haiku-4-5-20251001' && th.contextTokens === 45_100, th);
  check('the main agent is not touched by subagent usage', t.threads.get('main')!.contextTokens === undefined && t.threads.get('main')!.model === undefined);
  t.handle({ type: 'system', subtype: 'task_progress', task_id: 'k', tool_use_id: 'ag', description: 'helper', usage: { total_tokens: 1, tool_uses: 2, duration_ms: 3 }, last_tool_name: 'Grep' });
  check('task_progress says what a subagent is doing', t.threads.get('ag')?.activity === 'Using Grep', t.threads.get('ag'));
  t.handle({ type: 'system', subtype: 'task_notification', task_id: 'k', tool_use_id: 'ag', status: 'completed' });
  check('…until it finishes', t.threads.get('ag')?.activity === undefined && t.threads.get('ag')?.status === 'done', t.threads.get('ag'));
  let emitted = 0;
  const quiet = new Transcript(() => emitted++);
  quiet.handle(asst([{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'helper' } }]));
  const before = emitted;
  quiet.updateThread('ag', { title: 'helper', status: 'running' });
  check('an update that changes nothing is not sent to the view', emitted === before, emitted - before);
}

// --- an agent continued with SendMessage stays in its tab (live)
{
  const t = new Transcript();
  t.handle(asst([{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'fixer', prompt: 'fix it', run_in_background: true } }]));
  t.handle({ type: 'system', subtype: 'task_started', task_id: 'T1', tool_use_id: 'ag', description: 'fixer', subagent_type: 'general-purpose', task_type: 'local_agent', is_backgrounded: true });
  t.handle(toolResult('ag', 'Async agent launched successfully. agentId: T1 (internal ID)'));
  t.handle(asst([{ type: 'text', text: 'first report' }], { parent_tool_use_id: 'ag' }));
  t.handle({ type: 'system', subtype: 'task_notification', task_id: 'T1', tool_use_id: 'ag', status: 'completed' });
  check('background agent finished', t.threads.get('ag')?.status === 'done');

  t.handle(asst([{ type: 'tool_use', id: 'sm', name: 'SendMessage', input: { to: 'T1', message: 'now also do this' } }]));
  t.handle({ type: 'system', subtype: 'task_started', task_id: 'T1', tool_use_id: 'sm', description: 'fixer', subagent_type: 'general-purpose', task_type: 'local_agent', is_backgrounded: true });
  check('a continued agent gets no second tab', t.threads.size === 2 && !t.threads.has('sm'), [...t.threads.keys()]);
  check('…and runs again in its own tab', t.threads.get('ag')?.status === 'running' && t.threads.get('ag')?.endedAt === undefined, t.threads.get('ag'));
  const follow = (t.items.get('ag') ?? []).filter((i) => i.kind === 'prompt');
  check('the follow-up message is shown in that tab, after the task', follow.length === 2 && follow[1].kind === 'prompt' && follow[1].followUp === true && follow[1].text === 'now also do this', follow);
  t.handle(toolResult('sm', '{"success":true}'));
  t.handle(asst([{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'ls' } }], { parent_tool_use_id: 'ag' }));
  t.handle({ type: 'system', subtype: 'task_progress', task_id: 'T1', tool_use_id: 'sm', description: 'fixer', usage: {}, last_tool_name: 'Bash' });
  check('its activity goes to that tab', t.threads.get('ag')?.activity === 'Using Bash' && (t.items.get('ag') ?? []).some((i) => i.kind === 'tools'));
  t.handle({ type: 'system', subtype: 'task_notification', task_id: 'T1', tool_use_id: 'sm', status: 'completed' });
  check('…and it finishes there', t.threads.get('ag')?.status === 'done' && t.threads.size === 2, t.threads.get('ag'));

  t.handle(asst([{ type: 'tool_use', id: 'sm2', name: 'SendMessage', input: { to: 'T1', message: 'again' } }]));
  t.handle({ type: 'system', subtype: 'task_started', task_id: 'T1', tool_use_id: 'sm2', description: 'fixer', task_type: 'local_agent', is_backgrounded: true });
  t.handle({ type: 'system', subtype: 'task_updated', task_id: 'T1', patch: { status: 'killed' } });
  check('a continued agent can be stopped', t.threads.get('ag')?.status === 'stopped' && t.threads.get('ag')?.taskId === 'T1');
  t.handle(asst([{ type: 'tool_use', id: 'sm3', name: 'SendMessage', input: { to: 'someone-else', message: 'hi' } }]));
  check('a message to something that is not one of its agents changes no tab', t.threads.size === 2 && t.threads.get('ag')?.status === 'stopped');
}

// --- the same, rebuilt from a saved conversation
{
  const t = new Transcript();
  const note = (toolUse: string, status: string) => ({ type: 'user', parent_tool_use_id: null, message: { content: `<task-notification>\n<task-id>T9</task-id>\n<tool-use-id>${toolUse}</tool-use-id>\n<status>${status}</status>\n</task-notification>` } });
  t.handle(asst([{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'fixer', prompt: 'fix it', run_in_background: true } }]), true);
  t.handle(toolResult('ag', [{ type: 'text', text: 'Async agent launched successfully. (internal) agentId: T9 (internal ID - do not mention)' }]), true);
  t.handle(note('ag', 'completed'), true);
  t.handle(asst([{ type: 'tool_use', id: 'sm', name: 'SendMessage', input: { to: 'T9', message: 'now also do this' } }]), true);
  check('history: a continued agent is running again', t.threads.get('ag')?.status === 'running' && t.threads.size === 2, [...t.threads.values()]);
  t.handle(toolResult('sm', '{"success":true}'), true);
  t.handle(note('sm', 'completed'), true);
  check('history: its notification (naming the SendMessage call) finishes it', t.threads.get('ag')?.status === 'done' && t.threads.size === 2, t.threads.get('ag'));
  t.handle(asst([{ type: 'tool_use', id: 'smx', name: 'SendMessage', input: { to: 'T9', message: 'x' } }]), true);
  t.handle(toolResult('smx', 'No such agent', { message: { content: [{ type: 'tool_result', tool_use_id: 'smx', content: 'No such agent', is_error: true }] } }), true);
  check('history: a message that was not delivered leaves the agent as it was', t.threads.get('ag')?.status === 'done', t.threads.get('ag'));
  // The agent's own transcript: its task, its work, then the follow-up in its place.
  const sub = (m: any) => t.handle({ parent_tool_use_id: 'ag', ...m }, true);
  sub({ type: 'user', message: { content: 'fix it' } });
  sub({ type: 'assistant', message: { content: [{ type: 'text', text: 'first report' }] } });
  sub({ type: 'user', is_meta: true, message: { content: 'The coordinator sent a message while you were working:\nnow also do this\n\nAddress this before completing your current task.' } });
  sub({ type: 'user', message: { content: '<system-reminder>\nYour final report is delivered to the coordinator.\n</system-reminder>' } });
  sub({ type: 'user', is_meta: true, message: { content: 'an internal note that is not a follow-up' } });
  sub({ type: 'assistant', message: { content: [{ type: 'text', text: 'second report' }] } });
  const kinds = (t.items.get('ag') ?? []).map((i) => (i.kind === 'prompt' ? (i.followUp ? `follow-up:${i.text}` : 'task') : i.kind === 'text' ? i.text : i.kind));
  check('history: the follow-up sits between the two reports, without its wrapper', kinds.join(' | ') === 'task | first report | follow-up:now also do this | second report', kinds);
  // A compacted conversation is saved as a summary in place of what came before.
  const c = new Transcript();
  c.handle({ type: 'user', isCompactSummary: true, parent_tool_use_id: null, message: { content: 'This session is being continued from a previous conversation. '.repeat(50) } }, true);
  c.handle({ type: 'user', is_meta: true, parent_tool_use_id: null, message: { content: 'Another session sent a message: a long report' } }, true);
  c.handle({ type: 'user', uuid: 'u', parent_tool_use_id: null, message: { content: 'next question' } }, true);
  const shown = c.items.get('main') ?? [];
  check('history: a compaction summary is a short notice, and system notes are not shown as your messages', shown.length === 2 && shown[0].kind === 'notice' && shown[1].kind === 'user' && shown[1].text === 'next question', shown.map((i) => i.kind));
}

// --- compactions are counted; events new in Claude Code 2.1.296
{
  const t = new Transcript();
  t.handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 970_000 }, timestamp: '2026-10-04T07:24:22Z' });
  t.handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 400_000 } });
  const main = t.threads.get('main')!;
  check('each compaction is counted, with when and from what size', main.compactions === 2 && main.lastCompaction?.fromTokens === 400_000 && main.lastCompaction?.auto === false, main);
  check('…and noted in the conversation', (t.items.get('main') ?? []).filter((i) => i.kind === 'notice' && /compacted/.test(i.text)).length === 2);
  t.setCompactions('main', 1);
  check('a lower count from the saved file does not replace it', t.threads.get('main')!.compactions === 2);
  t.setCompactions('main', 5, { at: 1, fromTokens: 9 });
  check('a higher count from the saved file does', t.threads.get('main')!.compactions === 5 && t.threads.get('main')!.lastCompaction?.fromTokens === 9);

  const h = new Transcript();
  h.handle({ type: 'user', isCompactSummary: true, parent_tool_use_id: null, message: { content: 'summary' } }, true);
  check('history: the compaction a saved transcript starts with is counted', h.threads.get('main')!.compactions === 1);

  t.handle(asst([{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'helper', prompt: 'p', effort: 'xhigh' } }]));
  check("a subagent's effort is known when its Agent call names one", t.threads.get('ag')?.effort === 'xhigh', t.threads.get('ag'));
  t.handle(asst([{ type: 'tool_use', id: 'ag2', name: 'Agent', input: { description: 'helper', prompt: 'p', effort: { odd: 1 } } }]));
  check('…and absent otherwise', t.threads.get('ag2')?.effort === undefined);

  t.setMainRunning(true);
  const r1 = t.handle({ type: 'system', subtype: 'permission_check_status', tool_use_id: 'x', status: 'checking' });
  check('a slow permission check shows as activity', !r1.unknown && /allowed/.test(t.threads.get('main')!.activity ?? ''), t.threads.get('main'));
  t.handle({ type: 'system', subtype: 'permission_check_status', tool_use_id: 'x', status: 'done' });
  check('…and clears when decided', t.threads.get('main')!.activity === undefined);
  const r2 = t.handle({ type: 'system', subtype: 'instruction_size_warning', total_chars: 90000, total_limit_chars: 40000, file_count: 3 });
  const r3 = t.handle({ type: 'system', subtype: 'file_attachments_missing', message_uuid: 'm', sent_count: 3, missing: [{ file_uuid: 'a', reason: 'timeout' }] });
  const warns = (t.items.get('main') ?? []).filter((i) => i.kind === 'notice' && i.level === 'warn').map((i: any) => i.text);
  check('instruction size and missing attachments are warnings, not "unsupported"', !r2.unknown && !r3.unknown && warns.some((w) => /90,000 characters/.test(w)) && warns.some((w) => /1 of 3 attached files/.test(w)), warns);
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
