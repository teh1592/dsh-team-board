import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { installReview } from '../../host/review-plugin.mjs';
import { createRun } from '../../src/review/state.mjs';
import { testStore, automaticAgents, deferred } from './helpers.mjs';

test('service disposal attempts activation and command release when checkpoint publication fails', async () => {
  const done = deferred(); let cancellations = 0; let commands = 0;
  const service = new ReviewService({ store: { async commit() { throw new Error('disk busy'); } }, agentRunner: {}, commandRunner: { async dispose() { commands++; throw new Error('command teardown error'); } } });
  service.runners.set('running', done.promise);
  service.active.set('execution', { runId: 'running', controller: new AbortController(), handle: { async cancel() { cancellations++; done.resolve(); } } });
  await assert.rejects(service.dispose(), AggregateError);
  assert.equal(service.closing, true); assert.equal(cancellations, 1); assert.equal(commands, 1);
});
for (const projectionFailure of ['registration', 'disposal']) {
  test(`plugin disposal releases project services despite projection ${projectionFailure} failure`, async (t) => {
    const disk = await testStore(); let commandReleases = 0; let projections = 0;
    const tools = new Map(); const listeners = new Map(); const root = { id: 'root', session: {}, followup() {} };
    const dependencies = { fs: disk.fs, subagents: {}, agents: { roots: () => [root], get: () => root }, workingDirectory: { get: () => disk.projectRoot }, subprocess: {}, sessionProjections: { async register() { if (projectionFailure === 'registration') throw new Error('projection registration failure'); return { stateOf: () => ({}), async dispose() { projections++; throw new Error('projection dispose failure'); } }; } } };
    const originalDispose = (await import('../../host/dsh/command-runner.mjs')).DshCommandRunner.prototype.dispose;
    const CommandRunner = (await import('../../host/dsh/command-runner.mjs')).DshCommandRunner;
    CommandRunner.prototype.dispose = async function() { commandReleases++; await originalDispose.call(this); };
    t.after(() => { CommandRunner.prototype.dispose = originalDispose; });
    const ctx = { get: (name) => dependencies[name], tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } }, on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); } };
    const dispose = installReview(ctx);
    // Public status forces the already-created project service readiness without consulting the projection index.
    await assert.rejects(tools.get('review_status').execute({ runId: undefined }, { agent: root }));
    await assert.rejects(dispose(), AggregateError);
    assert.equal(commandReleases, 1); assert.equal(tools.size, 0); assert.equal(listeners.size, 0);
    assert.equal(projections, projectionFailure === 'disposal' ? 1 : 0);
    await disk.cleanup();
  });
}
test('corrupt JSON and schema runs are diagnosed individually while healthy runs recover and new requests start', async (t) => {
  const disk = await testStore();
  const service = new ReviewService({ store: disk.store, agentRunner: automaticAgents() });
  t.after(async () => { await service.dispose(); await disk.cleanup(); });
  const good = createRun({ runId: 'healthy-history', requestId: 'good', requestDigest: 'd', rootSessionId: 'root', projectRoot: disk.projectRoot, requirement: 'Healthy history' });
  good.status = 'completed'; await disk.store.create(good);
  await disk.store.writeArtifact('broken-json', 'run.json', '{broken');
  await disk.store.writeArtifact('broken-schema', 'run.json', { schemaVersion: 1, runId: 'broken-schema' });
  await assert.doesNotReject(service.recover());
  assert.deepEqual((await disk.store.list()).map((run) => run.runId), ['healthy-history']);
  const diagnostics = await disk.store.listDiagnostics();
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.runId === 'broken-json'));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.runId === 'broken-schema'));
  assert.equal((await service.status(good.runId)).storageDiagnostics.length, 2);
  const report = await service.inspect(good.runId, 'diagnostics'); assert.equal(report.items.length, 2);
  const broken = await service.inspect('broken-json', 'diagnostics'); assert.equal(broken.items[0].runId, 'broken-json');
  const started = await service.start({ requestId: 'new-develop', requirement: 'Timeout handling', mode: 'develop' }, { sessionId: 'root' });
  await service.wait(started.runId); assert.equal((await service.status(started.runId)).status, 'paused');
  assert.match(await disk.store.readArtifact('broken-json', 'run.json'), /broken/);
});
