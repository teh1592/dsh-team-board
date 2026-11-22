import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { createRun } from '../../src/review/state.mjs';
import { testStore } from './helpers.mjs';
async function setup(t, states) {
  const disk = await testStore();
  const service = new ReviewService({ store: disk.store, agentRunner: {} });
  service.kick = () => {};
  t.after(async () => { await service.dispose(); await disk.cleanup(); });
  for (const [runId, status] of Object.entries(states)) {
    const run = createRun({ runId, requestId: runId, requestDigest: runId, rootSessionId: 'root', projectRoot: disk.projectRoot, requirement: runId, mode: 'develop' });
    run.status = status; await disk.store.create(run);
  }
  return { ...disk, service };
}
test('completed develop revision returns busy when another run owns the project and preserves original revision', async (t) => {
  const { service } = await setup(t, { previous: 'completed', writer: 'queued' });
  await assert.rejects(service.revise('previous', { operationId: 'revision', requirement: 'Updated requirement', reason: 'Revision' }), { code: 'PROJECT_WRITER_BUSY' });
  assert.equal((await service.required('previous')).status, 'completed');
  assert.equal((await service.required('previous')).requirementRevision, 1);
});
for (const action of ['resume', 'retry']) test(`develop ${action} returns busy before reactivating a competing paused run`, async (t) => {
  const { service } = await setup(t, { previous: 'paused', writer: 'queued' });
  await assert.rejects(service.control('previous', action, { operationId: action }), { code: 'PROJECT_WRITER_BUSY' });
  assert.equal((await service.required('previous')).status, 'paused');
});
for (const first of ['start', 'revise']) test(`concurrent ${first} and competing activation grant exactly one develop writer`, async (t) => {
  const { service, store } = await setup(t, { previous: 'completed' });
  const start = () => service.start({ requestId: 'new-request', requirement: 'New task', mode: 'develop' }, { sessionId: 'root' });
  const revise = () => service.revise('previous', { operationId: 'revision', requirement: 'Updated task', reason: 'Revision' });
  const results = await Promise.allSettled(first === 'start' ? [start(), revise()] : [revise(), start()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'PROJECT_WRITER_BUSY').length, 1);
  assert.equal((await store.list()).filter((run) => !['completed', 'cancelled'].includes(run.status)).length, 1);
});
