import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { executionInputs } from '../../src/review/inputs.mjs';
import { createRun, beginExecution, invalidate } from '../../src/review/state.mjs';
import { testStore, automaticAgents } from './helpers.mjs';
const request = { requestId: 'q', requirement: 'Timeout handling' };
async function setup(t, options = {}) {
  const disk = await testStore(); t.after(() => disk.cleanup());
  const runner = automaticAgents(options);
  const service = new ReviewService({ store: disk.store, agentRunner: runner, stageTimeoutMs: options.stageTimeoutMs ?? 1200000 });
  t.after(() => service.dispose()); return { ...disk, runner, service };
}
test('both reviewers failing waits for an explicit degraded decision and reports valid opinion count', async (t) => {
  const { service, store, runner } = await setup(t, { failRole: ['architecture', 'test-maintenance'] });
  const { runId } = await service.start(request, { sessionId: 'root' }); await service.wait(runId);
  let run = await store.load(runId); assert.equal(run.status, 'waiting_user'); assert.equal(runner.calls.length, 3);
  assert.equal(run.questions[0].id, 'review-unavailable');
  await service.decide(runId, 'review-unavailable', 'continue', { kind: 'user', sessionId: 'root' }, 'choose-continue'); await service.wait(runId);
  run = await store.load(runId); assert.equal(run.status, 'completed'); assert.equal(runner.calls.length, 4);
  assert.ok(run.decisions.some((decision) => decision.owner === 'user:root'));
  assert.match((await service.inspect(runId, 'report')).content, /有效独立意见：0\/2/);
});
test('both reviewers can fail twice, retry twice and then continue without duplicate user decisions', async (t) => {
  const { service, store } = await setup(t, { failRole: ['architecture', 'test-maintenance'] });
  const { runId } = await service.start(request, { sessionId: 'root' }); await service.wait(runId);
  await service.decide(runId, 'review-unavailable', 'retry', { kind: 'user', sessionId: 'root' }, 'retry-first'); await service.wait(runId);
  assert.equal((await store.load(runId)).status, 'waiting_user');
  await service.decide(runId, 'review-unavailable', 'retry', { kind: 'user', sessionId: 'root' }, 'retry-second'); await service.wait(runId);
  await service.decide(runId, 'review-unavailable', 'continue', { kind: 'user', sessionId: 'root' }, 'continue-third'); await service.wait(runId);
  const run = await store.load(runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.decisions.filter((decision) => decision.owner === 'user:root').length, 3);
  assert.equal(new Set(run.decisions.map((decision) => decision.id)).size, run.decisions.length);
});
test('review timeout pauses once and releases every handle without unbounded retries', async (t) => {
  const { service, store, runner } = await setup(t, { hold: (spec) => spec.stageId === 'review', stageTimeoutMs: 100 });
  const { runId } = await service.start(request, { sessionId: 'root' }); await service.wait(runId);
  const run = await store.load(runId);
  assert.equal(run.status, 'paused'); assert.equal(runner.calls.filter((call) => call.stageId === 'review').length, 2);
  assert.ok(run.executions.filter((execution) => execution.stageId === 'review').every((execution) => execution.workStatus === 'interrupted'));
  assert.ok(runner.handles.every((handle) => handle.cancelled));
});
test('revision gives decide only current findings, decisions and tasks, while historical records remain queryable', async (t) => {
  const { service, store, runner } = await setup(t);
  const { runId } = await service.start(request, { sessionId: 'root' }); await service.wait(runId);
  const old = await store.load(runId); const oldFindingIds = old.findings.map((finding) => finding.id);
  await service.revise(runId, { operationId: 'revision-2', requirement: 'Timeout handling with retry', reason: 'Add retry requirement' }); await service.wait(runId);
  const run = await store.load(runId); assert.equal(run.status, 'completed'); assert.equal(run.requirementRevision, 2);
  const decide = runner.calls.filter((call) => call.stageId === 'decide').at(-1);
  assert.equal(decide.inputs.findings.some((finding) => oldFindingIds.includes(finding.id)), false);
  assert.equal(decide.inputs.decisions.some((decision) => decision.requirementRevision === 1), false);
  assert.equal(decide.inputs.tasks.some((task) => task.decisionIds.includes('1:D-1')), false);
  assert.ok(run.tasks.some((task) => task.decisionIds.includes('1:D-1'))); assert.ok(run.tasks.some((task) => task.decisionIds.includes('2:D-1')));
  const report = (await service.inspect(runId, 'report')).content;
  assert.equal(report.includes('task-1-1'), false);
});
test('fixed Node probe calls the owned command runner and persists check and log references', async (t) => {
  const { service, store, projectRoot } = await setup(t);
  const { runId } = await service.start(request, { sessionId: 'root' }); await service.wait(runId);
  let command;
  service.commandRunner = { async run(spec) { command = spec; return { checkId: spec.id, outcome: 'passed', exitCode: 0, stdout: '{"reviewProbe":true}', stderr: '' }; }, async dispose() {} };
  const probe = await service.probe(runId);
  assert.equal(probe.outcome, 'passed'); assert.equal(command.argv[0], 'node'); assert.equal(command.cwd, projectRoot);
  const run = await store.load(runId); assert.equal(run.checkResults.length, 1); assert.ok(run.checkResults[0].logRef);
  assert.match(await store.readArtifact(runId, probe.logRef), /reviewProbe/);
});
test('notification delivery failure leaves completed run and one pending notice to retry', async (t) => {
  const { service, store } = await setup(t);
  service.notifier = { async enqueue() { throw new Error('root temporarily unavailable'); } };
  const { runId } = await service.start(request, { sessionId: 'root' }); await service.wait(runId);
  const run = await store.load(runId); assert.equal(run.status, 'completed'); assert.equal(run.notifications.length, 1); assert.equal(run.notifications[0].status, 'pending');
  service.notifier = { async enqueue() { return 'accepted'; } };
  await Promise.all([service.notify(runId), service.notify(runId)]);
  assert.equal((await store.load(runId)).notifications[0].messageId, 'accepted');
});
