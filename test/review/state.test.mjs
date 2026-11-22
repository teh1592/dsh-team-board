import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, applyOperation, beginExecution, acceptResult, invalidate, fingerprint } from '../../src/review/state.mjs';
import { validateEnvelope, validateRun, outputSchema } from '../../src/review/schemas.mjs';
import { loadReviewPreset } from '../../src/review/preset.mjs';
const request = { runId: 'r-1', requestId: 'q-1', requestDigest: 'digest', rootSessionId: 'root', projectRoot: 'C:/project', requirement: 'Improve API timeouts' };
const review = { decision: 'reject', summary: 'Need timeout behavior', findings: [{ id: 'F-1', severity: 'medium', description: 'Handle timeout', basis: 'Requirement' }], risks: [], tests: ['timeout test'] };
function envelope(run, execution) { return { schemaVersion: 1, executionId: execution.executionId, requirementRevision: run.requirementRevision, decisionRevision: run.decisionRevision, inputFingerprint: execution.inputFingerprint, kind: 'review', result: review }; }
test('running -> completed uses a new operation while attempt remains stable; negative review completes work', () => {
  let run = createRun(request);
  const started = applyOperation(run, 0, { operationId: 'start', request: 'start', apply: (next) => beginExecution(next, { executionId: 'e-1', stageId: 'review', role: 'architecture', inputFingerprint: 'f' }) });
  run = started.run;
  const execution = run.executions[0];
  const completed = applyOperation(run, 1, { operationId: 'result', request: 'result', apply: (next) => acceptResult(next, envelope(next, execution), 'artifacts/e-1.json') });
  assert.equal(completed.run.executions[0].workStatus, 'completed');
  assert.equal(completed.run.executions[0].reviewDecision, 'reject');
  assert.equal(completed.run.executions[0].attempt, 1);
  assert.equal(completed.run.revision, 2);
  assert.deepEqual(validateRun(JSON.parse(JSON.stringify(completed.run))), completed.run);
});
test('same operation and content replays before revision check; different content conflicts', () => {
  const op = { operationId: 'same', request: { a: 1 }, apply: (run) => { run.status = 'running'; return { accepted: true }; } };
  const first = applyOperation(createRun(request), 0, op);
  const replay = applyOperation(first.run, 0, { ...op, apply() { throw new Error('replayed apply ran'); } });
  assert.equal(replay.replayed, true); assert.equal(replay.run.revision, 1);
  assert.throws(() => applyOperation(first.run, 1, { ...op, request: { a: 2 } }), { code: 'OPERATION_CONFLICT' });
  assert.throws(() => applyOperation(first.run, 0, { ...op, operationId: 'new' }), { code: 'REVISION_CONFLICT' });
});
test('two roles have independent executions; revised or cancelled late output is archived stale', () => {
  const run = createRun(request);
  const a = beginExecution(run, { executionId: 'a', stageId: 'review', role: 'architecture', inputFingerprint: 'same-input' });
  const b = beginExecution(run, { executionId: 'b', stageId: 'review', role: 'test-maintenance', inputFingerprint: 'same-input' });
  const late = envelope(run, a);
  assert.notEqual(a.executionId, b.executionId);
  invalidate(run, 'requirements changed');
  const result = acceptResult(run, late, 'artifacts/old.json');
  assert.equal(result.applicability, 'stale'); assert.equal(run.artifacts.length, 1); assert.equal(a.result, undefined);
  assert.equal(run.requirementRevision, 2);
});
test('result identity, role output and status vocabularies are validated', () => {
  const run = createRun(request);
  const execution = beginExecution(run, { executionId: 'a', stageId: 'review', role: 'architecture', inputFingerprint: 'f' });
  const result = envelope(run, execution);
  assert.equal(validateEnvelope(result), result);
  assert.throws(() => validateEnvelope({ ...result, result: { ...review, decision: 'completed' } }), { code: 'INVALID_STRUCTURE' });
  assert.throws(() => validateEnvelope({ ...result, requirementRevision: -1 }), { code: 'INVALID_VERSION' });
  assert.throws(() => validateRun({ ...run, status: 'passed' }), { code: 'INVALID_STRUCTURE' });
  assert.equal(outputSchema('review').properties.result.properties.decision.enum.includes('reject'), true);
});
test('new presets supply independent review roles and skip build in review mode', async () => {
  const standard = await loadReviewPreset('standard@2');
  assert.deepEqual(standard.stages.map((s) => s.id), ['intake', 'review', 'decide', 'report']);
  assert.deepEqual(standard.stages[1].roles, ['architecture', 'test-maintenance']);
  const quick = await loadReviewPreset('quick@2', 'develop');
  assert.deepEqual(quick.stages.map((s) => s.id), ['intake', 'decide', 'build', 'verify', 'report']);
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
});
