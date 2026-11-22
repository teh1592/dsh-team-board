import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { createRun } from '../../src/review/state.mjs';
import { testStore, deferred } from './helpers.mjs';
for (const action of ['stop', 'dispose']) test(`registry queries carry cancellation and ${action} stops before the next package`, async (t) => {
  const disk = await testStore(); const entered = deferred(); const fallback = deferred();
  const calls = []; let released = 0; let commandDisposals = 0;
  const run = createRun({ runId: 'registry-run', requestId: 'registry', requestDigest: 'd', rootSessionId: 'root', projectRoot: disk.projectRoot, requirement: 'Check packages', mode: 'develop' });
  run.status = 'running'; await disk.store.create(run);
  const files = { projectRoot: disk.projectRoot, async references() { return ['one', 'two', 'three'].map((packageName) => ({ target: packageName, packageName, declared: null, outcome: 'unknown', reason: 'external-package-needs-registry' })); } };
  const commandRunner = {
    async run(spec, signal) {
      calls.push({ spec, signal }); entered.resolve();
      if (calls.length === 1) await Promise.race([fallback.promise, new Promise((resolve) => {
        if (signal?.aborted) { released++; resolve(); }
        else signal?.addEventListener('abort', () => { released++; resolve(); }, { once: true });
      })]);
      return { checkId: spec.id, outcome: signal?.aborted ? 'unknown' : 'passed', exitCode: signal?.aborted ? null : 0, stdout: '"1.0.0"' };
    },
    async dispose() { commandDisposals++; },
  };
  const service = new ReviewService({ store: disk.store, agentRunner: {}, commandRunner, projectFiles: files });
  t.after(async () => { fallback.resolve(); await service.dispose(); await disk.cleanup(); });
  const work = service.develop.references({ references: [] }, { files: {} }, run.runId);
  const runner = work.finally(() => service.runners.delete(run.runId)); service.runners.set(run.runId, runner);
  await entered.promise;
  const stopping = action === 'stop' ? service.control(run.runId, 'stop', { operationId: 'stop-registry' }) : service.dispose();
  const timer = setTimeout(() => fallback.resolve(), 150);
  await stopping; clearTimeout(timer); await runner;
  assert.ok(calls[0].signal instanceof AbortSignal, 'registry subprocess needs an owned abort signal');
  assert.equal(calls[0].signal.aborted, true); assert.equal(released, 1);
  assert.equal(calls.length, 1, 'stopping must not publish the second or third query');
  assert.equal(service.develop.activeChecks.size, 0); assert.equal(service.runners.size, 0);
  assert.equal(commandDisposals, action === 'dispose' ? 1 : 0);
});
