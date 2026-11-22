import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { installReview } from '../../host/review-plugin.mjs';
import { DshProjectFiles } from '../../host/dsh/project-files.mjs';
import { createRun } from '../../src/review/state.mjs';
import { automaticAgents, testStore } from './helpers.mjs';
const config = { schemaVersion: 1, checks: [{ id: 'unit', argv: ['node', '--test'], kind: 'test', parser: 'node-test', inputs: ['src/**'] }] };
async function fixture(t) {
  const disk = await testStore();
  const files = new DshProjectFiles(disk.fs, disk.projectRoot);
  await disk.fs.writeText(await disk.fs.resolve('.review/config.json'), JSON.stringify(config));
  await disk.store.initialize();
  const snapshot = await files.snapshot();
  const run = createRun({ runId: 'a-develop', requestId: 'develop', requestDigest: 'd', rootSessionId: 'root', projectRoot: disk.projectRoot, requirement: 'Implement timeout', mode: 'develop' });
  const ref = await disk.store.writeArtifact(run.runId, 'inputs/1/workspace.json', snapshot);
  run.workspace = { baselineRef: ref, latestRef: ref, baselineFingerprint: snapshot.digest, latestFingerprint: snapshot.digest, changes: [] };
  run.rework = { count: 0, max: 2, findingIds: [] };
  await disk.store.create(run);
  const healthy = createRun({ runId: 'z-healthy-review', requestId: 'healthy', requestDigest: 'h', rootSessionId: 'root', projectRoot: disk.projectRoot, requirement: 'Healthy review' });
  healthy.status = 'completed'; await disk.store.create(healthy);
  const agents = automaticAgents(); const original = agents.start;
  agents.start = async (spec) => {
    if (!['build', 'verify'].includes(spec.stageId)) return original(spec);
    agents.calls.push(spec);
    const identity = JSON.parse(spec.prompt.split('身份：')[1].split('\n\n')[0]);
    let result;
    if (spec.stageId === 'build') {
      await disk.fs.writeText(await disk.fs.resolve('src/api/timeout.mjs'), 'export const timeout = 43;');
      result = { summary: 'Implemented', changed: ['src/api/timeout.mjs'], completedTaskIds: spec.inputs.tasks.filter((task) => task.workStatus !== 'completed').map((task) => task.id) };
    } else result = { decision: 'accept', summary: 'Verified', findings: [], risks: [], tests: ['Timeout checked'] };
    const envelope = { ...identity, result };
    return { childId: `child-${spec.executionId}`, result: Promise.resolve({ envelope, raw: { structured: envelope, output: [], stopReason: 'completed' } }), async cancel() {} };
  };
  let commands = 0;
  const service = new ReviewService({ store: disk.store, projectFiles: files, agentRunner: agents, commandRunner: { async run(spec) { commands++; return { checkId: spec.id, outcome: 'passed', exitCode: 0, stdout: '# tests 1\n# pass 1\n# fail 0', stderr: '' }; }, async dispose() {} } });
  t.after(async () => { await service.dispose(); await disk.cleanup(); });
  return { ...disk, files, service, agents, run, healthy, commands: () => commands };
}
test('bad develop config recovery persists local pause, leaves healthy history readable and resumes after repair', async (t) => {
  const { service, store, fs, agents, commands, run, healthy } = await fixture(t);
  await fs.writeText(await fs.resolve('.review/config.json'), '{bad config');
  await assert.doesNotReject(service.recover());
  const paused = await store.load(run.runId);
  assert.equal(paused.status, 'paused'); assert.match(paused.diagnostic, /DEVELOP_RECOVERY_INPUT_ERROR.*INVALID_JSON/);
  assert.equal((await service.status(healthy.runId)).status, 'completed');
  assert.match((await service.inspect(healthy.runId, 'report')).content, /Healthy review/);
  assert.equal(agents.calls.length, 0); assert.equal(commands(), 0); assert.equal(service.active.size, 0); assert.equal(service.develop.activeChecks.size, 0);
  await fs.writeText(await fs.resolve('.review/config.json'), JSON.stringify(config));
  await service.control(run.runId, 'resume', { operationId: 'resume-repaired-config' }); await service.wait(run.runId);
  assert.equal((await service.required(run.runId)).status, 'completed');
});
for (const code of ['PROJECT_SYMLINK', 'SNAPSHOT_LIMIT']) test(`${code} recovery is isolated and affected run can still be cancelled`, async (t) => {
  const { service, files, agents, commands, run, healthy } = await fixture(t);
  files.snapshot = async () => { throw Object.assign(new Error('Read-only project snapshot rejected'), { code }); };
  await assert.doesNotReject(service.recover());
  assert.equal((await service.required(run.runId)).status, 'paused'); assert.match((await service.required(run.runId)).diagnostic, new RegExp(code));
  assert.equal((await service.status(healthy.runId)).status, 'completed');
  assert.equal((await service.control(run.runId, 'cancel', { operationId: 'cancel-unreadable-project' })).status, 'cancelled');
  assert.equal(agents.calls.length, 0); assert.equal(commands(), 0); assert.equal(service.runners.size, 0);
});
test('plugin publishes project service despite develop config error so actual status read and cancel tools stay callable', async (t) => {
  const { fs, projectRoot, healthy, run } = await fixture(t);
  await fs.writeText(await fs.resolve('.review/config.json'), '{broken');
  const definitions = new Map(); const root = { id: 'root', session: {} };
  const dependencies = { fs, agents: { get: () => root, roots: () => [] }, subagents: {}, workingDirectory: { get: () => projectRoot } };
  const dispose = installReview({ get: (name) => dependencies[name], tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } } });
  t.after(dispose);
  const call = (name, args) => definitions.get(name).execute(args, { agent: root });
  assert.equal((await call('review_status', { runId: healthy.runId })).status, 'completed');
  assert.match((await call('review_read', { runId: healthy.runId, section: 'report' })).content, /Healthy review/);
  assert.equal((await call('review_control', { runId: run.runId, action: 'cancel', operationId: 'cancel-from-tool' })).status, 'cancelled');
});
test('recovery input isolation does not swallow failed diagnostic publication or artifact writes', async (t) => {
  const { service, store, fs } = await fixture(t);
  await fs.writeText(await fs.resolve('.review/config.json'), '{broken');
  const commit = store.commit.bind(store); const writeArtifact = store.writeArtifact.bind(store);
  store.commit = async () => { throw Object.assign(new Error('Diagnostic disk write failed'), { code: 'EIO' }); };
  await assert.rejects(service.recover(), { code: 'EIO' });
  store.commit = commit;
  await fs.writeText(await fs.resolve('.review/config.json'), JSON.stringify(config));
  store.writeArtifact = async () => { throw Object.assign(new Error('Artifact disk write failed'), { code: 'EIO' }); };
  await assert.rejects(service.recover(), { code: 'EIO' });
  store.writeArtifact = writeArtifact;
});
