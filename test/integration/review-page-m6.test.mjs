import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { registerReviewCommand } from '../../host/dsh/commands.mjs';
import { registerReviewRoute } from '../../host/dsh/review-route.mjs';
import { createHistoryReader } from '../../host/dsh/history.mjs';
import { registerReviewTools } from '../../host/dsh/tools.mjs';
import { createRun } from '../../src/review/state.mjs';
import { decodeReviewResponse, reviewViewModel, createReviewRequestGate } from '../../src/review/view-model.mjs';
import { testStore, automaticAgents } from './helpers.mjs';
import { DshAgentRunner } from '../../host/dsh/agent-runner.mjs';
import { usageSummary } from '../../src/review/usage.mjs';
async function fixture(t) {
  const disk = await testStore(); const runner = automaticAgents();
  const service = new ReviewService({ store: disk.store, agentRunner: runner });
  t.after(async () => { await service.dispose(); await disk.cleanup(); });
  let command; let route; let released = 0; const resolutions = []; const root = { id: 'root' }; const foreign = { id: 'foreign' }; const child = { id: 'child' };
  const tasks = [{ id: 'task-1', revision: 4, subject: 'Legacy task', description: 'Historical evidence', status: 'completed', writeScopes: ['src/**'] }];
  const commands = { register(definition) { command = definition; return () => { command = undefined; }; }, async execute(agent, line, attachments, signal) { assert.deepEqual(attachments, []); return { commandId: 'command-real-result', result: await command.handler({ agent, commandId: 'command-real-result', signal, rawInput: line.slice('/review '.length) }) }; } };
  registerReviewCommand(commands, async (_agent, _runId, options) => { resolutions.push(options); return service; }, { readHistory: createHistoryReader({ listTasks: () => structuredClone(tasks) }) });
  const connection = { admit: () => ({ peer: { principal: { kind: 'owner' } } }), fetch: { register(definition) { route = definition; return async () => { released++; }; } } };
  const disposeRoute = registerReviewRoute({ get: () => connection }, commands, { get: (id) => [root, foreign, child].find((agent) => agent.id === id), roots: () => [root, foreign] });
  const send = async (request, sessionId = 'root', extra = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/team-board/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, request, ...extra }) }));
    return { response, envelope: await response.json() };
  };
  const call = async (...args) => decodeReviewResponse((await send(...args)).envelope);
  return { ...disk, runner, service, commands, connection, root, resolutions, tasks, send, call, disposeRoute, released: () => released };
}
test('page routes use actual command results and the same service state as tools with duplicate and stale writes', async (t) => {
  const f = await fixture(t); f.service.kick = () => {};
  const request = { action: 'start', requestId: 'page-start', requirement: 'Timeout', preset: 'quick@2', mode: 'review' };
  const started = await f.call(request); const duplicate = await f.call(request); assert.equal(started.runId, duplicate.runId);
  assert.equal((await f.service.store.list()).length, 1);
  const tools = new Map(); const dispose = registerReviewTools({ tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } } }, async () => f.service, () => true); t.after(dispose);
  const command = { action: 'stop', runId: started.runId, operationId: 'same-operation', expectedRevision: started.revision };
  const stopped = await f.call(command); const replay = await f.call(command); assert.equal(stopped.revision, replay.revision);
  const toolStatus = await tools.get('review_status').execute({ runId: started.runId }, { agent: f.root });
  assert.equal(toolStatus.status, stopped.status); assert.equal(toolStatus.revision, stopped.revision);
  const stale = await f.send({ ...command, operationId: 'new-stale' }); assert.equal(stale.envelope.value.result.kind, 'error'); assert.match(stale.envelope.value.result.text, /REVISION_CONFLICT/);
  assert.throws(() => decodeReviewResponse(stale.envelope), /REVISION_CONFLICT/);
  const read = await f.call({ action: 'read', runId: started.runId, section: 'run' }); assert.equal(read.preset, 'quick@2');
  assert.equal(f.resolutions.at(-1).readOnly, true); assert.ok(!tools.has('review_decide'));
  const other = await f.send({ action: 'status', runId: started.runId }, 'foreign'); assert.equal(other.envelope.value.result.kind, 'error'); assert.match(other.envelope.value.result.text, /another root/);
});
test('authenticated route ignores no claimed identity and rejects missing auth, child roots, and body authority fields', async (t) => {
  const f = await fixture(t);
  f.connection.admit = () => ({ rejection: 401 }); assert.equal((await f.send({ action: 'list' })).response.status, 401);
  f.connection.admit = () => ({ peer: { principal: { kind: 'model' } } }); assert.equal((await f.send({ action: 'list' })).response.status, 403);
  f.connection.admit = () => ({ peer: { principal: { kind: 'owner' } } });
  assert.equal((await f.send({ action: 'list' }, 'child')).response.status, 409);
  assert.equal((await f.send({ action: 'list' }, 'root', { kind: 'user' })).response.status, 400);
  assert.equal((await f.send({ action: 'start', requestId: 'x', requirement: 'x', projectRoot: 'elsewhere' })).envelope.value.result.kind, 'error');
  await f.disposeRoute(); assert.equal(f.released(), 1);
});
test('history is read-only and explicit repeatable import creates new executions with durable source retained', async (t) => {
  const f = await fixture(t); const original = structuredClone(f.tasks); const before = await f.call({ action: 'history' });
  assert.equal(before.items[0].readOnly, true); assert.equal(f.resolutions.length, 0); assert.equal(f.runner.calls.length, 0); assert.equal((await f.service.store.list()).length, 0);
  const request = { action: 'import', historyId: 'task-1', requestId: 'import-once', preset: 'quick@2' };
  const imported = await f.call(request); await f.service.wait(imported.runId); const repeat = await f.call(request); assert.equal(repeat.runId, imported.runId);
  const run = await f.service.required(imported.runId);
  assert.equal(run.provenance.source.taskRevision, 4); assert.equal(run.provenance.importedBy, 'root'); assert.equal(run.provenance.status, 'imported'); assert.equal(run.provenance.evidence, 'unknown'); assert.ok(run.provenance.importedAt); assert.equal(run.provenance.digest, before.items[0].digest); assert.ok(run.executions.length > 0); assert.deepEqual(f.tasks, original);
});
test('read partitions keep check definitions separate from results and paginate long lists and logs', async (t) => {
  const f = await fixture(t); f.service.kick = () => {};
  const { runId } = await f.call({ action: 'start', requestId: 'paging', requirement: 'Inspect' });
  await f.service.mutate(runId, 'seed-list', (run) => { run.checks = [{ id: 'definition' }]; run.checkResults = [{ checkId: 'definition', outcome: 'unknown' }]; run.history.push(...Array.from({ length: 43 }, (_, i) => ({ name: i }))); return null; });
  assert.equal((await f.call({ action: 'read', runId, section: 'checkSpecs' })).items.length, 1);
  const results = await f.call({ action: 'read', runId, section: 'checkResults' }); assert.equal(results.items[0].outcome, 'unknown');
  const first = await f.call({ action: 'read', runId, section: 'history' }); assert.equal(first.items.length, 20); assert.equal(first.nextCursor, 20);
  const ref = await f.service.store.writeArtifact(runId, 'logs/long.txt', 'x'.repeat(39000));
  const a = await f.call({ action: 'read', runId, section: 'artifact', id: ref }); assert.equal(a.content.length, 16000); assert.equal(a.nextCursor, 16000);
  const b = await f.call({ action: 'read', runId, section: 'artifact', id: ref, cursor: a.nextCursor }); assert.equal(b.content.length, 16000);
});
test('view model bounds data and generation gate aborts old session and section responses', () => {
  const gate = createReviewRequestGate(); const a = gate.begin('session-a:run-a:report'); const b = gate.begin('session-b:run-b:checks'); assert.equal(a.controller.signal.aborted, true); assert.equal(gate.accepts(a), false); assert.equal(gate.accepts(b), true); gate.cancel(); assert.equal(b.controller.signal.aborted, true);
  assert.equal(reviewViewModel(null).state, 'empty'); const vm = reviewViewModel({ runId: 'a' }, 'findings', { items: Array.from({ length: 150 }, (_, i) => ({ id: String(i), description: 'x'.repeat(3000) })) }); assert.equal(vm.rows.length, 100); assert.equal(vm.truncated, true); assert.equal(vm.mode, 'unknown'); assert.equal(vm.rows[0].title.length, 1200);
});
test('structured decide is user-only, deduplicates the same answer and continues through the shared service', async (t) => {
  const f = await fixture(t); f.service.kick = () => {};
  const { runId } = await f.call({ action: 'start', requestId: 'choose', requirement: 'Choose behavior' });
  await f.service.mutate(runId, 'seed-choice', (run) => { run.status = 'waiting_user'; run.questions = [{ id: 'q', question: 'Choose?', sourceExecutionId: 'source', status: 'open', findingIds: [], options: [{ id: 'yes', label: 'Yes', description: 'Continue' }] }]; return null; });
  const before = await f.service.required(runId);
  await assert.rejects(f.service.decide(runId, 'q', 'yes', { kind: 'model', sessionId: 'root' }, 'model-choice'), /q/);
  const action = { action: 'decide', runId, questionId: 'q', optionId: 'yes', operationId: 'user-choice', expectedRevision: before.revision };
  const accepted = await f.call(action); const repeat = await f.call(action); assert.equal(accepted.revision, repeat.revision);
  const run = await f.service.required(runId); assert.equal(run.questions[0].answeredBy, 'root'); assert.equal(run.decisions.length, 1);
  const invalid = await f.send({ ...action, operationId: undefined }); assert.equal(invalid.envelope.value.result.kind, 'error');
});
test('service disposal aborts a pending usage observation and awaits its release without changing historical run', async (t) => {
  const f = await fixture(t); f.service.kick = () => {};
  const { runId } = await f.call({ action: 'start', requestId: 'usage-stop', requirement: 'Inspect' });
  await f.service.mutate(runId, 'seed-execution', (run) => { run.status = 'completed'; run.executions.push({ executionId: 'usage-e', stageId: 'review', role: 'reviewer', attempt: 1, inputRevision: 1, requirementRevision: 1, decisionRevision: 0, inputFingerprint: 'x', workStatus: 'completed', applicability: 'current', startedAt: new Date().toISOString(), childSessionId: 'child' }); return null; });
  let started; const ready = new Promise((resolve) => { started = resolve; }); let released = false;
  f.runner.readUsage = async (_execution, signal) => { started(); await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); released = true; throw new Error('cancelled'); };
  const before = await f.service.required(runId); const pending = f.service.inspect(runId, 'usage'); const rejected = assert.rejects(pending, /cancelled/); await ready;
  await f.service.dispose(); await rejected; assert.equal(released, true); assert.equal(f.service.reads.size, 0); assert.deepEqual(await f.service.required(runId), before);
});
test('usage retains committed event references, releases observation and reports unavailable tokens as unknown', async () => {
  let disposed = 0; const runner = new DshAgentRunner({}, {}, { async observeSession(_id, options) { assert.equal(options.projectionMode, 'none'); return { events: [{ type: 'assistant/message', seq: 9, data: { usage: { inputTokens: 21, outputTokens: 5 } } }], [Symbol.dispose]() { disposed++; } }; } });
  const entry = { executionId: 'e', childSessionId: 'c' }; const observed = await runner.readUsage(entry); assert.equal(disposed, 1); assert.deepEqual(observed.source.eventSeqs, [9]); assert.equal(observed.tokens.inputTokens, 21); assert.equal(observed.tokens.totalTokens, null);
  const run = createRun({ runId: 'usage', requestId: 'usage', requestDigest: 'd', rootSessionId: 'root', projectRoot: 'tmp', requirement: 'x' }); run.executions.push({ ...entry, startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z' });
  const summary = usageSummary(run, new Map([['e', observed]])); assert.equal(summary.inputTokens, 21); assert.equal(summary.totalTokens, null); assert.equal(summary.executions[0].elapsedMs, 1000);
  const missing = usageSummary(run); assert.equal(missing.inputTokens, null); assert.equal(missing.tokenStatus, 'unknown'); assert.equal(missing.humanHandlingMs, null);
});
