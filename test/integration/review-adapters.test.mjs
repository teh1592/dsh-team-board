import test from 'node:test';
import assert from 'node:assert/strict';
import { DshAgentRunner } from '../../host/dsh/agent-runner.mjs';
import { DshCommandRunner } from '../../host/dsh/command-runner.mjs';
import { DshNotifier } from '../../host/dsh/notifier.mjs';
import { registerReviewTools, submitDefinition } from '../../host/dsh/tools.mjs';
import { registerReviewCommand } from '../../host/dsh/commands.mjs';
import { buildExecutionSpec } from '../../src/review/inputs.mjs';
import { createRun, beginExecution, acceptResult } from '../../src/review/state.mjs';
import { deferred } from './helpers.mjs';
const resultEnvelope = { schemaVersion: 1, executionId: 'execution', requirementRevision: 1, decisionRevision: 0, inputFingerprint: 'f', kind: 'review', result: { decision: 'accept', summary: 'Looks good', findings: [], risks: [], tests: [] } };
test('AgentRunner chooses fresh provider, receives activation.result, sends ContentBlock[] and waits for disposal', async () => {
  const parent = { id: 'root' }; const signal = new AbortController().signal; let start; let send; let disposals = 0;
  const subagents = {
    list: () => ['fork', 'spawn'],
    getProvider: (name) => ({ name, inheritsParentContext: name === 'fork', capabilities: { outputSchema: true }, prepareContinuable() {} }),
    async startActivation(spec) { start = spec; return { childId: spec.childId, messageId: 'accepted-message', result: Promise.resolve({ output: [], structured: resultEnvelope, stopReason: 'completed' }), async dispose() { disposals++; } }; },
    async sendMessage(...args) { send = args; return 'sent'; },
  };
  const managed = new Map();
  const adapter = new DshAgentRunner(subagents, { get: () => parent }, undefined, managed);
  const handle = await adapter.start({ runId: 'run', rootSessionId: 'root', executionId: 'execution', stageId: 'review', projectRoot: 'C:/project', prompt: 'full materials', signal });
  assert.equal(start.provider, 'spawn'); assert.equal(start.delivery, 'caller'); assert.equal(start.request.parent, parent);
  assert.deepEqual(start.request.prompt, [{ type: 'text', text: 'full materials' }]);
  assert.equal(start.signal, signal); assert.equal(start.request.outputSchema.properties.kind.const, 'review');
  assert.equal(managed.has(handle.childId), true);
  assert.deepEqual((await handle.result).envelope, resultEnvelope);
  await adapter.sendMessage('root', handle.childId, 'continue', signal);
  assert.deepEqual(send, [parent, handle.childId, [{ type: 'text', text: 'continue' }], { signal }]);
  await Promise.all([handle.cancel(), handle.cancel()]); assert.equal(disposals, 1);
});
test('parse failure retains raw output, provider capabilities suppress unsupported schema and reject inherited context', async () => {
  let submitted;
  const subagents = { list: () => ['external'], getProvider: () => ({ name: 'external', inheritsParentContext: false, capabilities: { outputSchema: false } }), async startActivation(spec) { submitted = spec; return { childId: 'external-child', result: Promise.resolve({ output: [{ type: 'text', text: 'invalid JSON' }], stopReason: 'completed' }), async dispose() {} }; } };
  const adapter = new DshAgentRunner(subagents, { get: () => ({ id: 'root' }) });
  const handle = await adapter.start({ rootSessionId: 'root', stageId: 'review', signal: new AbortController().signal });
  const received = await handle.result;
  assert.ok(received.parseError); assert.equal(received.raw.output[0].text, 'invalid JSON'); assert.equal(submitted.request.outputSchema, undefined);
  subagents.getProvider = () => ({ inheritsParentContext: true });
  assert.throws(() => adapter.chooseProvider(), { code: 'FRESH_PROVIDER_UNAVAILABLE' });
});
test('recovery uses successful structured_output pair, verifies identity and releases observation', async () => {
  let released = 0; let observed;
  const execution = { ...resultEnvelope, childSessionId: 'child' };
  const sessionQuery = { async observeSession(id, options) { observed = [id, options]; return { events: [{ type: 'tool/call', data: { name: 'structured_output', callId: 'call', arguments: JSON.stringify(resultEnvelope) } }, { type: 'tool/result', data: { message: { toolCallId: 'call', isError: false } } }], [Symbol.dispose]() { released++; } }; } };
  const adapter = new DshAgentRunner({}, {}, sessionQuery);
  const recovered = await adapter.recover({ runId: 'run' }, execution);
  assert.equal(recovered.kind, 'result'); assert.deepEqual(recovered.envelope, resultEnvelope);
  assert.deepEqual(observed, ['child', { projectionMode: 'none' }]); assert.equal(released, 1);
  sessionQuery.observeSession = async () => ({ events: [{ type: 'tool/call', data: { name: 'structured_output', arguments: JSON.stringify(resultEnvelope) } }], [Symbol.dispose]() { released++; } });
  assert.equal((await adapter.recover({ runId: 'run' }, execution)).kind, 'interrupted'); assert.equal(released, 2);
});
test('CommandRunner supplies complete spawn spec, collects output, handles timeout and waits for quiescence', async () => {
  const finished = deferred(); let spawnSpec; let waited = 0; let terminated = 0;
  const processHandle = { done: finished.promise, collected: { stdout: { readFrom: () => ({ text: 'node check', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } }, terminate() { terminated++; finished.resolve({ exitCode: 1, signal: null }); }, async waitForExit() { waited++; return true; } };
  const runner = new DshCommandRunner({ async resolveExecutable(name) { return `C:/${name}.exe`; }, spawn(spec) { spawnSpec = spec; return processHandle; } });
  const result = await runner.run({ id: 'node-probe', argv: ['node', '-e', 'console.log(1)'], cwd: 'C:/project', timeoutMs: 1 });
  assert.equal(result.outcome, 'unknown'); assert.equal(result.timedOut, true); assert.equal(terminated, 1); assert.equal(waited, 1);
  assert.deepEqual(spawnSpec.argv, ['C:/node.exe', '-e', 'console.log(1)']); assert.equal(spawnSpec.stdio.stdin, 'ignore'); assert.equal(spawnSpec.stdio.stdout.maxBytes, 65536);
  assert.equal(result.stdout, 'node check');
});
test('Notifier records an identified followup once across replay', async () => {
  const events = []; let calls = 0;
  const agent = { session: { snapshotEvents: () => events }, followup(message) { calls++; events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }); } };
  const notifier = new DshNotifier({ get: () => agent });
  const notification = { notificationId: 'run:completed', summary: { runId: 'run' } };
  const first = await notifier.enqueue('root', notification); const second = await notifier.enqueue('root', notification);
  assert.equal(first, second); assert.equal(calls, 1); assert.equal(events[0].data.inserted[0].role, 'user');
});
test('five root tools and human decision command use one service; child submission enforces actual identity', async () => {
  const definitions = []; const commands = []; const calls = [];
  const run = { rootSessionId: 'root' };
  const service = { required: async () => run, async decide(...args) { calls.push(args); return { runId: 'run' }; }, async submit(...args) { calls.push(args); return { applicability: 'current' }; } };
  const dispose = registerReviewTools({ tools: { register(definition) { definitions.push(definition); return () => {}; } } }, async () => service, () => true);
  assert.deepEqual(definitions.map((d) => d.name), ['review_start', 'review_status', 'review_control', 'review_read', 'review_revise']);
  registerReviewCommand({ register(definition) { commands.push(definition); return () => {}; } }, async () => service);
  const result = await commands[0].handler({ commandId: 'command', agent: { id: 'root' }, rawInput: 'decide run Q-1 option' });
  assert.equal(result.kind, 'success'); assert.equal(calls[0][3].kind, 'user');
  const submit = submitDefinition(service, 'run', 'execution', 'child');
  await assert.rejects(submit.execute({ result: resultEnvelope }, { agent: { id: 'other' } }), /identity/);
  await submit.execute({ result: resultEnvelope }, { agent: { id: 'child' } });
  assert.equal(calls.at(-1)[2].sessionId, 'child'); dispose();
});
test('conflicting completion is archived stale and does not replace the first result', () => {
  const run = createRun({ runId: 'r', requestId: 'q', requestDigest: 'd', rootSessionId: 'root', projectRoot: 'C:/p', requirement: 'x' });
  beginExecution(run, { executionId: 'execution', role: 'architecture', stageId: 'review', inputFingerprint: 'f' });
  acceptResult(run, resultEnvelope, 'first');
  const second = { ...resultEnvelope, result: { ...resultEnvelope.result, summary: 'Conflicting second output' } };
  assert.equal(acceptResult(run, second, 'second').applicability, 'stale');
  assert.equal(run.executions[0].result.summary, 'Looks good'); assert.equal(run.artifacts.length, 2);
});
