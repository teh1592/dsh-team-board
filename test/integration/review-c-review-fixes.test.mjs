import test from 'node:test';
import assert from 'node:assert/strict';
import { installReview } from '../../host/review-plugin.mjs';
import { ReviewService } from '../../host/review-service.mjs';
import { createRun } from '../../src/review/state.mjs';
import { createHistoryReader } from '../../host/dsh/history.mjs';
import { fingerprint } from '../../src/review/state.mjs';
import { testStore, automaticAgents } from './helpers.mjs';
import { registerReviewTools } from '../../host/dsh/tools.mjs';
import { DshAgentRunner } from '../../host/dsh/agent-runner.mjs';
for (const name of ['review_status', 'review_read']) test(`cold mounted ${name} reads without recovery, kick or persisted changes`, async (t) => {
  const disk = await testStore(); t.after(() => disk.cleanup());
  const run = createRun({ runId: 'cold-run', requestId: 'cold', requestDigest: 'd', rootSessionId: 'root', projectRoot: disk.projectRoot, requirement: 'Read historical run' });
  run.status = 'paused'; await disk.store.create(run);
  let writes = 0; let recoveries = 0; let kicks = 0;
  const write = disk.fs.writeText; disk.fs.writeText = async (...args) => { writes++; return write(...args); };
  const recover = ReviewService.prototype.recover; const kick = ReviewService.prototype.kick;
  ReviewService.prototype.recover = async function() { recoveries++; return recover.call(this); };
  ReviewService.prototype.kick = function(...args) { kicks++; return kick.apply(this, args); };
  t.after(() => { ReviewService.prototype.recover = recover; ReviewService.prototype.kick = kick; });
  const root = { id: 'root', session: {} }; const tools = new Map();
  const dependencies = { fs: disk.fs, subagents: {}, agents: { get: () => root, roots: () => [] }, workingDirectory: { get: () => disk.projectRoot } };
  const dispose = installReview({ get: (key) => dependencies[key], tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } } });
  t.after(dispose);
  const value = await tools.get(name).execute({ runId: run.runId, ...(name === 'review_read' ? { section: 'run' } : {}) }, { agent: root });
  assert.equal(value.runId, run.runId); assert.equal(recoveries, 0); assert.equal(kicks, 0); assert.equal(writes, 0); assert.deepEqual(await disk.store.load(run.runId), run);
  // An explicit mutation still prepares the same service normally.
  await tools.get('review_control').execute({ runId: run.runId, action: 'stop', operationId: 'stop-cold' }, { agent: root });
  assert.equal(recoveries, 1); assert.ok(writes > 0);
});
test('review_read caller cancellation reaches usage observation, releases its lease and stops further reads', async (t) => {
  const disk = await testStore(); const root = { id: 'root' }; const caller = new AbortController();
  const run = createRun({ runId: 'read-cancel', requestId: 'read-cancel', requestDigest: 'd', rootSessionId: root.id, projectRoot: disk.projectRoot, requirement: 'Read usage' });
  run.status = 'completed';
  run.executions = ['first', 'second'].map((id) => ({ executionId: id, childSessionId: `child-${id}`, stageId: 'review', role: id, attempt: 1, inputRevision: 1, requirementRevision: 1, decisionRevision: 0, inputFingerprint: id, workStatus: 'completed', applicability: 'current', startedAt: '2026-01-01T00:00:00Z' }));
  await disk.store.create(run);
  let entered; const ready = new Promise((resolve) => { entered = resolve; }); let observed; let releases = 0; const queried = [];
  const runner = new DshAgentRunner({}, {}, { async observeSession(id, { signal }) {
    queried.push(id); observed = signal; entered();
    await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    return { get events() { throw new Error('Usage observation cancelled'); }, [Symbol.dispose]() { releases++; } };
  } });
  const service = new ReviewService({ store: disk.store, agentRunner: runner }); const tools = new Map();
  const dispose = registerReviewTools({ tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } } }, async () => service, () => true);
  t.after(async () => { dispose(); await service.dispose(); await disk.cleanup(); });
  const pending = tools.get('review_read').execute({ runId: run.runId, section: 'usage' }, { agent: root, signal: caller.signal }); pending.catch(() => {});
  await ready; caller.abort(new Error('Caller stopped'));
  assert.equal(observed.aborted, true, 'tool caller cancellation must reach sessionQuery');
  await assert.rejects(pending, /Usage observation cancelled/);
  assert.equal(releases, 1); assert.deepEqual(queried, ['child-first']); assert.equal(service.reads.size, 0);
  assert.equal(service.readLifetime.signal.aborted, false, 'caller cancellation releases without unloading the plugin');
  assert.deepEqual(await disk.store.load(run.runId), run);
});
test('history stage imports retain meeting and preset from the complete parent and receipt tree', async (t) => {
  const block = (...lines) => ['```team-board-meeting', ...lines, '```'].join('\n');
  const tasks = [
    { id: 'parent', revision: 2, subject: 'Meeting', description: block('meeting: m-fixture', 'preset: standard@1', 'status: running'), status: 'in_progress', writeScopes: [] },
    { id: 'stage', revision: 3, subject: 'Review stage', description: block('meeting: m-fixture', 'stage: redteam', 'attempt: 1', 'status: done'), status: 'completed', writeScopes: [] },
  ];
  const original = structuredClone(tasks); const reader = createHistoryReader({ listTasks: () => tasks });
  const page = await reader({ id: 'root' }); const stage = page.items.find((item) => item.id === 'stage');
  assert.equal(stage.source.meetingId, 'm-fixture'); assert.equal(stage.source.preset, 'standard@1');
  const exact = (await reader({ id: 'root' }, 'stage')).items[0]; assert.equal(exact.digest, stage.digest); assert.equal(exact.digest, fingerprint({ source: exact.source, content: exact.content }));
  const disk = await testStore(); const service = new ReviewService({ store: disk.store, agentRunner: automaticAgents() });
  t.after(async () => { await service.dispose(); await disk.cleanup(); });
  const request = { requestId: 'import-stage', preset: 'quick@2' }; const actor = { kind: 'user', sessionId: 'root' };
  const imported = await service.importHistory(request, exact, actor); await service.wait(imported.runId);
  assert.equal((await service.importHistory(request, exact, actor)).runId, imported.runId);
  const run = await service.required(imported.runId); assert.deepEqual(run.provenance.source, exact.source); assert.equal(run.provenance.digest, exact.digest); assert.deepEqual(tasks, original);
  const orphan = createHistoryReader({ listTasks: () => [tasks[1]] }); const missing = (await orphan({ id: 'root' })).items[0];
  assert.equal(missing.source.meetingId, 'm-fixture'); assert.equal(missing.source.preset, null);
});
