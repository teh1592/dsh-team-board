import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { DshProjectFiles } from '../../host/dsh/project-files.mjs';
import { testStore, automaticAgents, deferred } from './helpers.mjs';
import { checkFingerprint } from '../../src/review/checks.mjs';
const checks = [{ id: 'node-tests', kind: 'test', parser: 'node-test', argv: ['node', '--test'], inputs: [], outputs: ['generated/'], required: true }];
async function fixture(t) {
  const disk = await testStore();
  await disk.store.writeArtifact('seed', 'unused', 'seed');
  await disk.fs.writeText(await disk.fs.resolve('.review/config.json'), JSON.stringify({ schemaVersion: 1, checks, references: [{ kind: 'existing', target: 'src/api/timeout.mjs' }] }));
  const runner = automaticAgents(); const start = runner.start;
  runner.start = async (spec) => {
    if (spec.stageId !== 'build') return start(spec);
    runner.calls.push(spec);
    await disk.fs.writeText(await disk.fs.resolve('src/api/timeout.mjs'), 'export const timeout = 42;\n');
    const identity = JSON.parse(spec.prompt.split('身份：')[1].split('\n\n')[0]);
    const envelope = { ...identity, result: { summary: 'Implemented timeout', changed: ['src/api/timeout.mjs'], completedTaskIds: spec.inputs.tasks.filter((task) => task.workStatus !== 'completed').map((task) => task.id), resolvedFindingIds: [] } };
    return { childId: 'builder', result: Promise.resolve({ raw: { structured: envelope, output: [], stopReason: 'completed' }, envelope }), async cancel() {} };
  };
  const commandCalls = [];
  const commandRunner = { async run(spec) { commandCalls.push(spec); return { checkId: spec.id, outcome: 'passed', exitCode: 0, stdout: '# tests 2\n# pass 2\n# fail 0', stderr: '', startedAt: 'start', endedAt: 'end' }; }, async dispose() {} };
  const service = new ReviewService({ store: disk.store, agentRunner: runner, commandRunner, projectFiles: new DshProjectFiles(disk.fs, disk.projectRoot) });
  service.develop.beforeVerify = async (runId) => { if (await service.develop.checks(runId, ['implementation', 'delivery'])) await service.checkpoint(runId, 'paused', 'M4 ready for independent verification'); };
  t.after(async () => { await service.dispose(); await disk.cleanup(); });
  return { ...disk, runner, commandCalls, service };
}
test('M4 develop executes one build with full decisions, changes actual files, runs current checks and pauses for verify', async (t) => {
  const { service, store, runner, commandCalls } = await fixture(t);
  const { runId } = await service.start({ requestId: 'develop', requirement: 'Add timeout module', mode: 'develop' }, { sessionId: 'root' });
  await service.wait(runId);
  const run = await service.required(runId);
  assert.equal(run.status, 'paused', run.diagnostic);
  assert.match(run.diagnostic, /independent verification/);
  assert.equal(runner.calls.filter((call) => call.stageId === 'build').length, 1);
  const build = runner.calls.find((call) => call.stageId === 'build');
  assert.equal(build.inputs.decisions.length, 1); assert.equal(build.inputs.reviews.length, 2);
  assert.match(build.prompt, /Timeout and cancellation test/);
  assert.ok(run.tasks.every((task) => task.workStatus === 'completed'));
  assert.equal(commandCalls.length, 1);
  assert.equal(run.checkResults[0].outcome, 'passed'); assert.equal(run.checkResults[0].applicability, 'current');
  assert.equal(run.checkResults[0].testSummary.tests, 2);
  assert.match(await store.readArtifact(runId, run.checkResults[0].logRef), /tests 2/);
  assert.equal(run.workspace.changes[0].path, 'src/api/timeout.mjs');
  assert.equal(run.workspace.referenceResults[0].reason, 'local-reference');
});
test('project snapshot includes new code, excludes run/output artifacts, and changed input reruns checks', async (t) => {
  const { service, fs, runner, commandCalls } = await fixture(t);
  const { runId } = await service.start({ requestId: 'changes', requirement: 'Add timeout module', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  const files = service.develop.files; const config = await files.configuration();
  const before = await service.develop.snapshot(config);
  await fs.writeText(await fs.resolve('generated/cache.txt'), 'generated');
  await service.store.writeArtifact(runId, 'logs/extra.txt', 'extra log');
  assert.equal((await service.develop.snapshot(config)).digest, before.digest);
  await fs.writeText(await fs.resolve('src/api/timeout.mjs'), 'export const timeout = 43;\n');
  assert.notEqual((await service.develop.snapshot(config)).digest, before.digest);
  await service.control(runId, 'resume', { operationId: 'resume' }); await service.wait(runId);
  assert.equal(commandCalls.length, 2); assert.equal(runner.calls.filter((call) => call.stageId === 'build').length, 1);
  assert.equal((await service.required(runId)).checkResults[0].applicability, 'stale');
});
test('downstream check includes another check generated output and reruns when generated input changes', async (t) => {
  const { service, fs } = await fixture(t);
  await fs.writeText(await fs.resolve('.review/config.json'), JSON.stringify({ schemaVersion: 1, checks: [
    { id: 'generate', argv: ['node', 'generate.mjs'], inputs: ['src/**'], outputs: ['generated/'] },
    { id: 'validate', argv: ['node', 'validate.mjs'], inputs: ['generated/**'], outputs: [] },
  ] }));
  let validations = 0;
  service.commandRunner.run = async (spec) => {
    if (spec.id === 'generate') await fs.writeText(await fs.resolve('generated/schema.json'), '{"version":1}');
    if (spec.id === 'validate') validations++;
    return { checkId: spec.id, outcome: 'passed', exitCode: 0, stdout: '', stderr: '' };
  };
  const { runId } = await service.start({ requestId: 'generated-input', requirement: 'Add timeout module', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  const config = await service.develop.config(await service.required(runId)); const validate = config.checks.find((check) => check.id === 'validate');
  const before = await service.develop.snapshot(config, validate);
  assert.ok(before.files['generated/schema.json'], 'downstream input must include the generator output');
  const projectBefore = await service.develop.snapshot(config);
  await fs.writeText(await fs.resolve('generated/schema.json'), '{"version":2}');
  const after = await service.develop.snapshot(config, validate);
  assert.notEqual(checkFingerprint(before, validate, config.digest), checkFingerprint(after, validate, config.digest));
  assert.equal((await service.develop.snapshot(config)).digest, projectBefore.digest, 'project baseline may exclude generated directories');
  await service.control(runId, 'resume', { operationId: 'revalidate-generated' }); await service.wait(runId);
  assert.equal(validations, 2);
  const results = (await service.required(runId)).checkResults.filter((result) => result.checkId === 'validate');
  assert.equal(results[0].applicability, 'stale'); assert.equal(results[1].applicability, 'current');
});
