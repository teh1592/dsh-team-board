import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { DshProjectFiles } from '../../host/dsh/project-files.mjs';
import { createRun, beginExecution } from '../../src/review/state.mjs';
import { testStore } from './helpers.mjs';
const checks = [{ id: 'unit', argv: ['node', '--test'], kind: 'test', parser: 'node-test', onlyNewFailures: true, inputs: ['src/**'] }];
async function setup(t, { withWorkspace = true, withBuild = false } = {}) {
  const disk = await testStore(); const files = new DshProjectFiles(disk.fs, disk.projectRoot);
  await disk.fs.writeText(await disk.fs.resolve('.review/config.json'), JSON.stringify({ schemaVersion: 1, checks }));
  await disk.fs.writeText(await disk.fs.resolve('src/value.mjs'), 'export const value = 1;');
  const run = createRun({ runId: 'baseline-run', requestId: 'baseline', requestDigest: 'd', rootSessionId: 'root', projectRoot: disk.projectRoot, requirement: 'Change value', mode: 'develop' });
  if (withWorkspace) {
    const snapshot = await files.snapshot(); const ref = await disk.store.writeArtifact(run.runId, 'inputs/1/workspace.json', snapshot);
    run.workspace = { baselineRef: ref, latestRef: ref, baselineFingerprint: snapshot.digest, latestFingerprint: snapshot.digest, changes: [] };
    run.rework = { count: 0, max: 2, findingIds: [] };
  }
  if (withBuild) {
    const execution = beginExecution(run, { executionId: 'previous-build', stageId: 'build', role: 'developer', inputFingerprint: 'old' });
    execution.workStatus = 'completed'; execution.result = { summary: 'Already edited', changed: ['src/value.mjs'], completedTaskIds: [] }; execution.processed = true;
  }
  await disk.store.create(run);
  const calls = []; let unknown = false;
  const service = new ReviewService({ store: disk.store, projectFiles: files, agentRunner: { async start() { throw new Error('Baseline test must not start a model'); } }, commandRunner: {
    async run(spec, signal) { calls.push({ spec, signal }); return unknown ? { checkId: spec.id, outcome: 'unknown', exitCode: null, summary: 'Tool missing', stdout: '', stderr: '' } : { checkId: spec.id, outcome: 'failed', exitCode: 1, stdout: 'not ok 1 - existing failure\n# tests 1\n# pass 0\n# fail 1', stderr: '' }; }, async dispose() {},
  } });
  t.after(async () => { await service.dispose(); await disk.cleanup(); });
  return { ...disk, service, files, calls, run, setUnknown(value) { unknown = value; } };
}
test('initialize recovers workspace-published baseline-not-started crash window before any build', async (t) => {
  const { service, calls, run } = await setup(t);
  await service.develop.initialize(run.runId);
  const current = await service.required(run.runId);
  assert.equal(calls.length, 1, 'missing baseline must be acquired on re-entry');
  assert.equal(current.workspace.checkBaselines.unit.status, 'ready');
  assert.ok(current.workspace.checkBaselines.unit.configDigest);
  assert.equal(current.checkResults.filter((result) => result.baseline).length, 1);
  await service.develop.initialize(run.runId); assert.equal(calls.length, 1, 'completed original baseline is reused');
});
test('unknown baseline pauses without build and retries after tool restoration', async (t) => {
  const { service, calls, run, setUnknown } = await setup(t, { withWorkspace: false });
  setUnknown(true); await service.develop.initialize(run.runId);
  let current = await service.required(run.runId);
  assert.equal(current.status, 'paused'); assert.match(current.diagnostic, /baseline/i);
  assert.equal(current.workspace.checkBaselines.unit.status, 'waiting'); assert.equal(current.executions.length, 0);
  setUnknown(false);
  await service.mutate(run.runId, 'retry-baseline-only', (next) => { next.status = 'queued'; return null; });
  await service.develop.initialize(run.runId);
  current = await service.required(run.runId);
  assert.equal(current.workspace.checkBaselines.unit.status, 'ready'); assert.equal(calls.length, 2);
  assert.equal(current.executions.length, 0);
});
test('trusted original baseline survives code changes and known failures are compared without recollecting it', async (t) => {
  const { service, fs, calls, run } = await setup(t);
  await service.develop.initialize(run.runId);
  await service.mutate(run.runId, 'build-started', (next) => { beginExecution(next, { executionId: 'build-now', stageId: 'build', role: 'developer', inputFingerprint: 'build-input' }); return null; });
  await fs.writeText(await fs.resolve('src/value.mjs'), 'export const value = 2;');
  await service.develop.initialize(run.runId);
  assert.equal(calls.length, 1, 'original baseline is not recollected from changed files');
  const config = await service.develop.config(await service.required(run.runId));
  const result = await service.develop.runCheck(run.runId, config.checks[0], config);
  assert.equal(result.outcome, 'passed'); assert.equal(result.reason, 'known-baseline-failures');
  assert.equal(calls.length, 2);
});
test('existing build without trusted baseline pauses instead of collecting modified code as original baseline', async (t) => {
  const { service, calls, run } = await setup(t, { withBuild: true });
  await service.develop.initialize(run.runId);
  const current = await service.required(run.runId);
  assert.equal(current.status, 'paused'); assert.match(current.diagnostic, /baseline.*after.*build|build.*baseline/i);
  assert.equal(calls.length, 0); assert.equal(current.checkResults.length, 0);
});
