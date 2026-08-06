/**
 * Codex + Grok transcript parsers - fixtures are trimmed copies of REAL
 * on-disk transcripts (Codex CLI v0.144.1 rollout, Grok Build grok-4.5
 * chat_history), captured 2026-07-13. If either agent changes its format,
 * update the fixture from a fresh real file, not by hand.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript as parseCodex } from '../capture/sources/codex.js';
import { parseTranscript as parseGrok } from '../capture/sources/grok.js';
import { parseTranscript as parseAgy } from '../capture/sources/agy.js';

const CODEX_SID = '019f5bb2-2d82-75b1-948f-9039e8a376c8';

const codexLines = [
  { timestamp: '2026-07-13T13:37:11.701Z', type: 'session_meta', payload: { session_id: CODEX_SID, id: CODEX_SID, cwd: '/tmp/smoke/codex', originator: 'codex_exec', cli_version: '0.144.1', source: 'exec' } },
  { timestamp: '2026-07-13T13:37:12.000Z', type: 'event_msg', payload: { type: 'task_started' } },
  { timestamp: '2026-07-13T13:37:12.001Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'AGENTS.md instructions blah' }] } },
  { timestamp: '2026-07-13T13:37:12.002Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...</environment_context>' }] } },
  { timestamp: '2026-07-13T13:37:12.003Z', type: 'world_state', payload: {} },
  { timestamp: '2026-07-13T13:37:12.004Z', type: 'turn_context', payload: {} },
  { timestamp: '2026-07-13T13:37:12.005Z', type: 'event_msg', payload: { type: 'user_message', message: 'Run the shell command `echo hello-from-codex` then reply with exactly: pong', images: [] } },
  { timestamp: '2026-07-13T13:37:29.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'I’ll run the requested command now.' } },
  { timestamp: '2026-07-13T13:37:29.001Z', type: 'response_item', payload: { type: 'message', id: 'msg_063070a22acc01b7016a54ea180a18819a', role: 'assistant', content: [{ type: 'output_text', text: 'I’ll run the requested command now.' }], phase: 'commentary' } },
  { timestamp: '2026-07-13T13:37:30.902Z', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_063070a22acc', status: 'completed', call_id: 'call_CJH4BcCf8IoCXE5BWJfjPwvf', name: 'exec', input: 'const r = await tools.exec_command({"cmd":"echo hello-from-codex"});\ntext(r.output);\n' } },
  { timestamp: '2026-07-13T13:37:31.100Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_CJH4BcCf8IoCXE5BWJfjPwvf', output: [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: 'hello-from-codex\n' }] } },
  { timestamp: '2026-07-13T13:37:32.000Z', type: 'event_msg', payload: { type: 'token_count' } },
  { timestamp: '2026-07-13T13:37:33.000Z', type: 'response_item', payload: { type: 'message', id: 'msg_063070a22acc01b7016a54ea1c6f2481', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }], phase: 'final_answer' } },
  { timestamp: '2026-07-13T13:37:33.500Z', type: 'event_msg', payload: { type: 'task_complete' } },
];
const CODEX_JSONL = codexLines.map(l => JSON.stringify(l)).join('\n') + '\n';

describe('codex rollout parser', () => {
  it('maps a real rollout to prompt/assistant/tool entries, skipping injected context', () => {
    const { entries, lastUuid, foundWatermark } = parseCodex(CODEX_JSONL, null);
    assert.equal(foundWatermark, true);
    assert.deepEqual(entries.map(e => e.kind), ['prompt', 'assistant', 'tool_use', 'tool_result', 'assistant']);

    const [prompt, commentary, toolUse, toolResult, final] = entries as any[];
    assert.match(prompt.prompt, /hello-from-codex/);
    assert.equal(commentary.source_uuid, 'msg_063070a22acc01b7016a54ea180a18819a');
    assert.equal(toolUse.tool_use_id, 'call_CJH4BcCf8IoCXE5BWJfjPwvf');
    assert.equal(toolUse.tool_name, 'exec');
    assert.equal(toolResult.tool_use_id, 'call_CJH4BcCf8IoCXE5BWJfjPwvf');
    assert.equal(toolResult.tool_name, 'exec'); // denormalized via the toolNames map
    assert.match(String(toolResult.content), /hello-from-codex/);
    assert.equal(final.text, 'pong');
    // Watermark is positional on the last processed line.
    assert.equal(lastUuid, `${CODEX_SID}#${codexLines.length - 1}`);
    // Every entry has a ts from the envelope timestamp.
    assert.ok(entries.every(e => typeof (e as any).ts === 'string'));
  });

  it('resumes from a positional watermark and only emits the tail', () => {
    const full = parseCodex(CODEX_JSONL, null);
    // Watermark just after the tool_use line (index 9).
    const { entries, foundWatermark } = parseCodex(CODEX_JSONL, `${CODEX_SID}#9`);
    assert.equal(foundWatermark, true);
    assert.deepEqual(entries.map(e => e.kind), ['tool_result', 'assistant']);
    // The tail tool_result still knows its tool name from the pre-watermark scan.
    assert.equal((entries[0] as any).tool_name, 'exec');
    assert.ok(full.entries.length > entries.length);
  });

  it('treats a foreign watermark as not-found so the caller replays from the top', () => {
    const { foundWatermark, entries } = parseCodex(CODEX_JSONL, 'other-session#5');
    assert.equal(foundWatermark, false);
    // Not-found still parses in full (the caller decides to replay).
    assert.equal(entries.length, 5);
  });
});

describe('codex rollout parser - hostile inputs', () => {
  it('empty / whitespace-only file yields nothing and keeps the watermark', () => {
    for (const content of ['', '\n\n', '   \n']) {
      const r = parseCodex(content, null);
      assert.deepEqual(r.entries, []);
      assert.equal(r.lastUuid, null);
    }
  });

  it('missing session_meta (truncated head) still parses with positional fallbacks', () => {
    const noMeta = codexLines.slice(1).map(l => JSON.stringify(l)).join('\n');
    const { entries } = parseCodex(noMeta, null);
    assert.deepEqual(entries.map(e => e.kind), ['prompt', 'assistant', 'tool_use', 'tool_result', 'assistant']);
    // Stable payload ids still key dedup even without a session id.
    assert.equal((entries.find(e => e.kind === 'tool_use') as any).source_uuid, 'call_CJH4BcCf8IoCXE5BWJfjPwvf');
  });

  it('a torn tail line (reader raced the writer) is skipped without advancing the watermark past it', () => {
    const full = codexLines.map(l => JSON.stringify(l)).join('\n');
    const torn = full.slice(0, full.length - 40); // truncate mid-JSON on the last line
    const r1 = parseCodex(torn, null);
    // The torn line contributed nothing and the watermark stops BEFORE it...
    assert.ok(r1.lastUuid!.endsWith(`#${codexLines.length - 2}`), r1.lastUuid!);
    // ...so the next scan of the completed file picks up exactly the final line.
    const r2 = parseCodex(full, r1.lastUuid);
    assert.equal(r2.foundWatermark, true);
    assert.deepEqual(r2.entries.map(e => e.kind), []); // last line is event_msg task_complete - skipped
    assert.equal(r2.lastUuid, `${CODEX_SID}#${codexLines.length - 1}`);
  });

  it('a watermark past EOF (file replaced by a shorter rollout, same sid) replays instead of wedging', () => {
    const { foundWatermark, entries } = parseCodex(CODEX_JSONL, `${CODEX_SID}#999`);
    assert.equal(foundWatermark, false); // caller replays from the top; server dedup collapses
    assert.equal(entries.length, 5);
  });

  it('garbage lines interleaved with real ones are skipped silently', () => {
    const mixed = ['not json at all', JSON.stringify(codexLines[0]), '{"half":', JSON.stringify(codexLines[6]), '[]', 'null'].join('\n');
    const { entries } = parseCodex(mixed, null);
    assert.deepEqual(entries.map(e => e.kind), ['prompt']);
  });
});

const GROK_SID = '019f5bb0-bae1-7102-b750-44d68dd10fe1';

const grokLines = [
  { type: 'system', content: 'You are Grok 4.5 released by xAI...' },
  { type: 'user', content: '<user_info>\nOS Version: linux\n</user_info>' }, // plain env block, no synthetic_reason
  { type: 'user', content: 'AGENTS.md says...', synthetic_reason: 'agents_md' },
  { type: 'user', content: '<user_query>\nRun the shell command `echo stream-test` then reply with exactly: pong\n</user_query>', prompt_index: 0 },
  { type: 'reasoning', id: 'r1', encrypted_content: 'xxx', status: 'completed', summary: [] },
  { type: 'assistant', content: '', tool_calls: [{ id: 'call-c22b43bc-e892-484e-b2ff-6d0d9578b868-0', name: 'run_terminal_command', arguments: '{"command":"echo stream-test","description":"Run echo stream-test command"}' }], model_id: 'grok-4.5', reasoning_effort: 'high' },
  { type: 'tool_result', tool_call_id: 'call-c22b43bc-e892-484e-b2ff-6d0d9578b868-0', content: 'exit: 0\nstream-test\n' },
  { type: 'reasoning', id: 'r2', encrypted_content: 'yyy', status: 'completed', summary: [] },
  { type: 'assistant', content: 'pong', model_id: 'grok-4.5', reasoning_effort: 'high' },
];
const GROK_JSONL = grokLines.map(l => JSON.stringify(l)).join('\n') + '\n';

describe('grok chat_history parser', () => {
  it('maps a real chat_history to prompt/assistant/tool entries, skipping synthetic + reasoning', () => {
    const { entries, lastUuid, foundWatermark } = parseGrok(GROK_JSONL, null, { sessionId: GROK_SID });
    assert.equal(foundWatermark, true);
    assert.deepEqual(entries.map(e => e.kind), ['prompt', 'assistant', 'tool_use', 'tool_result', 'assistant']);

    const [prompt, callTurn, toolUse, toolResult, final] = entries as any[];
    // Wrapper stripped: the prompt is exactly what the user typed.
    assert.equal(prompt.prompt, 'Run the shell command `echo stream-test` then reply with exactly: pong');
    assert.equal(callTurn.model, 'grok-4.5');
    assert.equal(toolUse.tool_use_id, 'call-c22b43bc-e892-484e-b2ff-6d0d9578b868-0');
    assert.equal(toolUse.tool_name, 'run_terminal_command');
    assert.deepEqual(toolUse.tool_input, { command: 'echo stream-test', description: 'Run echo stream-test command' });
    assert.equal(toolResult.tool_name, 'run_terminal_command');
    assert.equal(final.text, 'pong');
    assert.equal(lastUuid, `${GROK_SID}#${grokLines.length - 1}`);
  });

  it('resumes from a positional watermark', () => {
    // Watermark after the assistant tool-call line (index 5).
    const { entries, foundWatermark } = parseGrok(GROK_JSONL, `${GROK_SID}#5`, { sessionId: GROK_SID });
    assert.equal(foundWatermark, true);
    assert.deepEqual(entries.map(e => e.kind), ['tool_result', 'assistant']);
    assert.equal((entries[0] as any).tool_name, 'run_terminal_command');
  });

  it('a watermark from another session is not found', () => {
    const { foundWatermark } = parseGrok(GROK_JSONL, 'someone-else#3', { sessionId: GROK_SID });
    assert.equal(foundWatermark, false);
  });

  it('tool_use/tool_result dedup keys are the stable call ids (survive file rewrites)', () => {
    const { entries } = parseGrok(GROK_JSONL, null, { sessionId: GROK_SID });
    const toolUse = entries.find(e => e.kind === 'tool_use') as any;
    const toolResult = entries.find(e => e.kind === 'tool_result') as any;
    assert.equal(toolUse.source_uuid, toolUse.tool_use_id);
    assert.equal(toolResult.source_uuid, `${toolUse.tool_use_id}#out`);
  });

  it('a watermark past EOF (chat_history rewritten shorter, e.g. rewind) replays instead of wedging', () => {
    const { foundWatermark, entries } = parseGrok(GROK_JSONL, `${GROK_SID}#500`, { sessionId: GROK_SID });
    assert.equal(foundWatermark, false);
    assert.equal(entries.length, 5);
  });

  it('no session id in context still parses; positional uuids degrade to bare indexes', () => {
    const { entries } = parseGrok(GROK_JSONL, null, {});
    assert.deepEqual(entries.map(e => e.kind), ['prompt', 'assistant', 'tool_use', 'tool_result', 'assistant']);
    // Tool entries keep their stable ids regardless.
    assert.equal((entries.find(e => e.kind === 'tool_use') as any).source_uuid, 'call-c22b43bc-e892-484e-b2ff-6d0d9578b868-0');
  });

  it('an orphan tool_result (its assistant line lost to truncation) still lands, name unknown', () => {
    const orphan = JSON.stringify({ type: 'tool_result', tool_call_id: 'call-orphan-0', content: 'out' });
    const { entries } = parseGrok(orphan + '\n', null, { sessionId: GROK_SID });
    assert.equal(entries.length, 1);
    assert.equal((entries[0] as any).tool_use_id, 'call-orphan-0');
    assert.equal((entries[0] as any).tool_name, undefined);
  });

  it('tool_calls with malformed arguments JSON pass the raw string through', () => {
    const line = JSON.stringify({ type: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 't', arguments: '{oops' }] });
    const { entries } = parseGrok(line + '\n', null, { sessionId: GROK_SID });
    const tu = entries.find(e => e.kind === 'tool_use') as any;
    assert.equal(tu.tool_input, '{oops');
  });
});

const AGY_CID = '838e4ef3-ea93-468f-a06d-2f2cfc1fdef1';

// Trimmed copy of a REAL agy transcript_full.jsonl (v1.1.2, 2026-07-22) - the
// repeated EPHEMERAL_MESSAGE/SYSTEM_MESSAGE bodies are shortened, everything
// else (types, step_index, structure) is verbatim. Note step_index 5/6 are
// swapped in the real file (CHECKPOINT logged after CODE_ACTION but with a
// lower index) - kept as-is since the parser must watermark on line position,
// never step_index.
const agyLines = [
  { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-07-22T21:34:29Z',
    content: '<USER_REQUEST>\nCreate a file called hello.txt in the current directory containing the text hi. Then stop.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-07-22T14:34:29-07:00.\n</ADDITIONAL_METADATA>' },
  { step_index: 1, source: 'SYSTEM', type: 'CONVERSATION_HISTORY', status: 'DONE', created_at: '2026-07-22T21:34:29Z' },
  { step_index: 2, source: 'SYSTEM', type: 'EPHEMERAL_MESSAGE', status: 'DONE', created_at: '2026-07-22T21:34:29Z',
    content: 'The following is an <EPHEMERAL_MESSAGE> ... critical instructions ...' },
  { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-22T21:34:29Z',
    thinking: 'Deciding to use write_to_file...',
    tool_calls: [{ name: 'write_to_file', args: { CodeContent: 'hi', TargetFile: '/tmp/agy-hook-probe/hello.txt', Overwrite: false } }] },
  { step_index: 4, source: 'MODEL', type: 'CODE_ACTION', status: 'DONE', created_at: '2026-07-22T21:34:35Z',
    content: 'Created At: 2026-07-22T14:34:35-07:00\nCompleted At: 2026-07-22T14:34:35-07:00\nCreated file file:///tmp/agy-hook-probe/hello.txt with requested content.' },
  { step_index: 6, source: 'SYSTEM', type: 'EPHEMERAL_MESSAGE', status: 'DONE', created_at: '2026-07-22T21:34:35Z',
    content: 'The following is an <EPHEMERAL_MESSAGE> ... critical instructions ...' },
  { step_index: 5, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: '2026-07-22T21:34:35Z',
    content: '{{ CHECKPOINT 0 }}\nThe earlier parts of this conversation have been truncated...' },
  { step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-07-22T21:34:35Z',
    content: 'I have created the file [hello.txt](file:///tmp/agy-hook-probe/hello.txt) with the content "hi" as requested.',
    thinking: 'Confirming the file was created...' },
];
const AGY_JSONL = agyLines.map(l => JSON.stringify(l)).join('\n') + '\n';

describe('agy transcript parser', () => {
  it('maps a real transcript to prompt/tool_use/tool_result/assistant entries, skipping internal bookkeeping', () => {
    const { entries, lastUuid, foundWatermark } = parseAgy(AGY_JSONL, null, { conversationId: AGY_CID });
    assert.equal(foundWatermark, true);
    assert.deepEqual(entries.map(e => e.kind), ['prompt', 'tool_use', 'tool_result', 'assistant']);

    const [prompt, toolUse, toolResult, reply] = entries as any[];
    assert.equal(prompt.prompt, 'Create a file called hello.txt in the current directory containing the text hi. Then stop.');
    assert.equal(toolUse.tool_name, 'write_to_file');
    assert.equal(toolUse.tool_input.TargetFile, '/tmp/agy-hook-probe/hello.txt');
    assert.equal(toolResult.tool_use_id, toolUse.tool_use_id);
    assert.match(toolResult.content, /Created file file:\/\/\/tmp\/agy-hook-probe\/hello\.txt/);
    assert.match(reply.text, /content "hi" as requested/);
    // Watermark is positional on the last processed LINE, not step_index
    // (lines 5/6 carry swapped step_index values in the real file).
    assert.equal(lastUuid, `${AGY_CID}#${agyLines.length - 1}`);
    assert.ok(entries.every(e => typeof (e as any).ts === 'string'));
  });

  it('a tool-result narrative type other than CODE_ACTION (e.g. RUN_COMMAND) still pairs correctly', () => {
    // agy has no single generic "tool result" type - it's per tool category
    // (confirmed live: CODE_ACTION for file writes, RUN_COMMAND for the shell
    // tool). The parser must not hardcode an exhaustive type allowlist.
    const lines = [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\nrun echo hi\n</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-01-01T00:00:01Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo hi' } }] },
      { step_index: 2, source: 'MODEL', type: 'RUN_COMMAND', created_at: '2026-01-01T00:00:02Z',
        content: 'The command completed successfully.\nOutput:\nhi\n' },
      { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-01-01T00:00:02Z', content: 'done' },
    ];
    const jsonl = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
    const { entries } = parseAgy(jsonl, null, { conversationId: 'rc1' });
    assert.deepEqual(entries.map(e => e.kind), ['prompt', 'tool_use', 'tool_result', 'assistant']);
    const toolUse = entries[1] as any;
    const toolResult = entries[2] as any;
    assert.equal(toolUse.tool_name, 'run_command');
    assert.equal(toolResult.tool_use_id, toolUse.tool_use_id);
    assert.match(toolResult.content, /Output:\nhi/);
  });

  it('a bookkeeping line between a tool call and its result does not break the pairing', () => {
    const lines = [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\nwrite a file\n</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-01-01T00:00:01Z',
        tool_calls: [{ name: 'write_to_file', args: { TargetFile: '/tmp/x.txt' } }] },
      { step_index: 2, source: 'SYSTEM', type: 'EPHEMERAL_MESSAGE', created_at: '2026-01-01T00:00:01Z',
        content: 'reminder noise' },
      { step_index: 3, source: 'MODEL', type: 'CODE_ACTION', created_at: '2026-01-01T00:00:02Z',
        content: 'Created file /tmp/x.txt' },
    ];
    const jsonl = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
    const { entries } = parseAgy(jsonl, null, { conversationId: 'bk1' });
    assert.deepEqual(entries.map(e => e.kind), ['prompt', 'tool_use', 'tool_result']);
    assert.equal((entries[2] as any).tool_use_id, (entries[1] as any).tool_use_id);
  });

  it('a CODE_ACTION with no preceding tool call falls back to a system entry, not a dropped line', () => {
    const line = JSON.stringify({
      step_index: 0, source: 'MODEL', type: 'CODE_ACTION', created_at: '2026-01-01T00:00:00Z',
      content: 'orphan narrative',
    });
    const { entries } = parseAgy(line + '\n', null, { conversationId: 'o1' });
    assert.deepEqual(entries.map(e => e.kind), ['system']);
    assert.equal((entries[0] as any).content, 'orphan narrative');
  });

  it('a thinking-only PLANNER_RESPONSE (no content, about to call a tool) is skipped, not surfaced empty', () => {
    const { entries } = parseAgy(AGY_JSONL, null, { conversationId: AGY_CID });
    assert.ok(!entries.some(e => e.kind === 'assistant' && (e as any).text === ''));
    // Only the ONE PLANNER_RESPONSE with real content became an assistant entry.
    assert.equal(entries.filter(e => e.kind === 'assistant').length, 1);
  });

  it('resumes from a positional watermark and only emits the tail', () => {
    const full = parseAgy(AGY_JSONL, null, { conversationId: AGY_CID });
    const { entries, foundWatermark } = parseAgy(AGY_JSONL, `${AGY_CID}#4`, { conversationId: AGY_CID });
    assert.equal(foundWatermark, true);
    assert.deepEqual(entries.map(e => e.kind), ['assistant']);
    assert.ok(full.entries.length > entries.length);
  });

  it('a watermark from another conversation is not found (replays from the top)', () => {
    const { foundWatermark, entries } = parseAgy(AGY_JSONL, 'other-conv#3', { conversationId: AGY_CID });
    assert.equal(foundWatermark, false);
    assert.equal(entries.length, 4);
  });

  it('a watermark past EOF replays instead of wedging', () => {
    const { foundWatermark, entries } = parseAgy(AGY_JSONL, `${AGY_CID}#500`, { conversationId: AGY_CID });
    assert.equal(foundWatermark, false);
    assert.equal(entries.length, 4);
  });

  it('extracts the clean request text, dropping ADDITIONAL_METADATA/USER_SETTINGS_CHANGE noise', () => {
    const line = JSON.stringify({
      step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z',
      content: '<USER_REQUEST>\ndo the thing\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nModel changed\n</USER_SETTINGS_CHANGE>',
    });
    const { entries } = parseAgy(line + '\n', null, { conversationId: 'c1' });
    assert.equal((entries[0] as any).prompt, 'do the thing');
  });

  it('no conversation id in context still parses; positional uuids degrade to a bare index', () => {
    const { entries, lastUuid } = parseAgy(AGY_JSONL, null, {});
    assert.deepEqual(entries.map(e => e.kind), ['prompt', 'tool_use', 'tool_result', 'assistant']);
    assert.equal(lastUuid, `#${agyLines.length - 1}`);
  });

  it('hostile inputs: empty/whitespace and corrupt JSON lines are ignored, not thrown', () => {
    for (const content of ['', '\n\n', '   \n']) {
      const r = parseAgy(content, null, { conversationId: AGY_CID });
      assert.deepEqual(r.entries, []);
      assert.equal(r.lastUuid, null);
    }
    const mixed = '{not json}\n' + JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: 't', content: 'ok' }) + '\n';
    const r = parseAgy(mixed, null, { conversationId: AGY_CID });
    assert.equal(r.entries.length, 1);
    assert.equal((r.entries[0] as any).text, 'ok');
  });
});

describe('hook payload normalization (grok camelCase)', () => {
  it('maps camelCase (Grok) and snake_case (Claude/Codex) to one shape', async () => {
    const { normalizeHookInput } = await import('../hooks/capture-runner.js');
    assert.deepEqual(
      normalizeHookInput({ hookEventName: 'Stop', sessionId: 's1', transcriptPath: '/t', cwd: '/c' }),
      { session_id: 's1', transcript_path: '/t', cwd: '/c', hook_event_name: 'Stop' },
    );
    assert.deepEqual(
      normalizeHookInput({ hook_event_name: 'Stop', session_id: 's2', transcript_path: '/t2', cwd: '/c2' }),
      { session_id: 's2', transcript_path: '/t2', cwd: '/c2', hook_event_name: 'Stop' },
    );
  });

  it('maps agy\'s conversationId to session_id', async () => {
    const { normalizeHookInput } = await import('../hooks/capture-runner.js');
    assert.deepEqual(
      normalizeHookInput({ conversationId: 'conv-1', transcriptPath: '/t3' }),
      { session_id: 'conv-1', transcript_path: '/t3', cwd: undefined, hook_event_name: undefined },
    );
  });

  it('shrugs off garbage payloads', async () => {
    const { normalizeHookInput } = await import('../hooks/capture-runner.js');
    for (const raw of [null, 42, 'str', [], { sessionId: 7, cwd: {} }]) {
      const h = normalizeHookInput(raw);
      assert.equal(h.session_id, undefined);
      assert.equal(h.transcript_path, undefined);
    }
  });
});

describe('opencode transcript parser', () => {
  // Fixture mirrors the plugin-written format: one {info, parts} line per
  // message (SDK Message + Part[] shapes, opencode 1.18.x).
  const SID = 'ses_abc123';
  const ocLines = [
    {
      info: { id: 'msg_01', sessionID: SID, role: 'user', time: { created: 1754400000000 }, agent: 'build', model: { providerID: 'gipity', modelID: 'deepseek/deepseek-v4-pro' } },
      parts: [
        { id: 'prt_01', sessionID: SID, messageID: 'msg_01', type: 'text', text: 'add a /health endpoint' },
        { id: 'prt_02', sessionID: SID, messageID: 'msg_01', type: 'text', text: 'injected context', synthetic: true },
      ],
    },
    {
      info: {
        id: 'msg_02', sessionID: SID, role: 'assistant', time: { created: 1754400001000, completed: 1754400009000 },
        parentID: 'msg_01', modelID: 'deepseek/deepseek-v4-pro', providerID: 'gipity', mode: 'build',
        path: { cwd: '/w', root: '/w' }, cost: 0.002,
        tokens: { input: 1200, output: 340, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'tool_use',
      },
      parts: [
        { id: 'prt_03', sessionID: SID, messageID: 'msg_02', type: 'text', text: 'Adding it now.' },
        {
          id: 'prt_04', sessionID: SID, messageID: 'msg_02', type: 'tool', callID: 'call_777', tool: 'bash',
          state: { status: 'completed', input: { command: 'echo ok' }, output: 'ok', title: 'echo ok', metadata: {}, time: { start: 1, end: 2 } },
        },
      ],
    },
    {
      info: {
        id: 'msg_03', sessionID: SID, role: 'assistant', time: { created: 1754400010000 },
        parentID: 'msg_01', modelID: 'deepseek/deepseek-v4-pro', providerID: 'gipity', mode: 'build',
        path: { cwd: '/w', root: '/w' }, cost: 0.001,
        tokens: { input: 1600, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop',
      },
      parts: [
        { id: 'prt_05', sessionID: SID, messageID: 'msg_03', type: 'reasoning', text: 'thinking...' },
        { id: 'prt_06', sessionID: SID, messageID: 'msg_03', type: 'text', text: 'Done - /health returns 200.' },
      ],
    },
  ];
  const OC_JSONL = ocLines.map(l => JSON.stringify(l)).join('\n') + '\n';

  it('maps {info, parts} lines to prompt/assistant/tool entries, skipping synthetic + reasoning', async () => {
    const { parseTranscript: parseOpencode } = await import('../capture/sources/opencode.js');
    const { entries, lastUuid, foundWatermark } = parseOpencode(OC_JSONL, null);
    assert.equal(foundWatermark, true);
    assert.deepEqual(entries.map(e => e.kind), ['prompt', 'assistant', 'tool_use', 'tool_result', 'assistant']);

    const [prompt, callTurn, toolUse, toolResult, final] = entries as any[];
    assert.equal(prompt.prompt, 'add a /health endpoint'); // synthetic part skipped
    assert.equal(prompt.source_uuid, 'msg_01');
    assert.equal(callTurn.model, 'deepseek/deepseek-v4-pro');
    assert.equal(callTurn.input_tokens, 1200);
    assert.equal(callTurn.output_tokens, 340);
    assert.equal(callTurn.stop_reason, 'tool_use');
    assert.equal(toolUse.tool_use_id, 'call_777');
    assert.equal(toolUse.tool_name, 'bash');
    assert.deepEqual(toolUse.tool_input, { command: 'echo ok' });
    assert.equal(toolResult.content, 'ok');
    assert.equal(final.text, 'Done - /health returns 200.');
    assert.equal(lastUuid, 'msg_03');
  });

  it('resumes from a message-id watermark', async () => {
    const { parseTranscript: parseOpencode } = await import('../capture/sources/opencode.js');
    const { entries, foundWatermark, lastUuid } = parseOpencode(OC_JSONL, 'msg_02');
    assert.equal(foundWatermark, true);
    assert.deepEqual(entries.map(e => e.kind), ['assistant']);
    assert.equal(lastUuid, 'msg_03');
  });

  it('a foreign watermark (forked/rewound session) replays from the top', async () => {
    const { parseTranscript: parseOpencode } = await import('../capture/sources/opencode.js');
    const { entries, foundWatermark } = parseOpencode(OC_JSONL, 'msg_zz');
    assert.equal(foundWatermark, false);
    assert.equal(entries.length, 5);
  });

  it('reports usage totals (fresh + cache tokens) for the parsed range only', async () => {
    const { parseTranscript: parseOpencode } = await import('../capture/sources/opencode.js');
    const cachedLine = JSON.stringify({
      info: {
        id: 'msg_05', sessionID: SID, role: 'assistant', time: { created: 1754400030000 },
        parentID: 'msg_01', modelID: 'deepseek/deepseek-v4-pro', providerID: 'gipity', mode: 'build',
        path: { cwd: '/w', root: '/w' }, cost: 0,
        tokens: { input: 50, output: 60, reasoning: 0, cache: { read: 400, write: 30 } },
      },
      parts: [{ id: 'prt_10', sessionID: SID, messageID: 'msg_05', type: 'text', text: 'cached turn' }],
    });
    // Full parse: msg_02 (1200/340) + msg_03 (1600/20) + msg_05 (50+400+30/60).
    const full = parseOpencode(OC_JSONL + cachedLine + '\n', null);
    assert.deepEqual(full.usage, { tokensIn: 1200 + 1600 + 480, tokensOut: 340 + 20 + 60 });
    // From a watermark: only messages past it count.
    const tail = parseOpencode(OC_JSONL + cachedLine + '\n', 'msg_03');
    assert.deepEqual(tail.usage, { tokensIn: 480, tokensOut: 60 });
  });

  it('tool dedup keys are the stable call ids; errored tools carry is_error', async () => {
    const { parseTranscript: parseOpencode } = await import('../capture/sources/opencode.js');
    const errLine = JSON.stringify({
      info: {
        id: 'msg_04', sessionID: SID, role: 'assistant', time: { created: 1754400020000 },
        parentID: 'msg_01', modelID: 'deepseek/deepseek-v4-pro', providerID: 'gipity', mode: 'build',
        path: { cwd: '/w', root: '/w' }, cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{
        id: 'prt_09', sessionID: SID, messageID: 'msg_04', type: 'tool', callID: 'call_err', tool: 'bash',
        state: { status: 'error', input: { command: 'boom' }, error: 'exploded', time: { start: 1, end: 2 } },
      }],
    });
    const { entries } = parseOpencode(errLine + '\n', null);
    const toolUse = entries.find(e => e.kind === 'tool_use') as any;
    const toolResult = entries.find(e => e.kind === 'tool_result') as any;
    assert.equal(toolUse.source_uuid, 'call_err');
    assert.equal(toolResult.source_uuid, 'call_err#out');
    assert.equal(toolResult.is_error, true);
    assert.equal(toolResult.content, 'exploded');
  });

  it('shrugs off garbage lines', async () => {
    const { parseTranscript: parseOpencode } = await import('../capture/sources/opencode.js');
    const { entries } = parseOpencode('not json\n{"info":{}}\n{"parts":[]}\n' + OC_JSONL, null);
    assert.equal(entries.length, 5);
  });
});
