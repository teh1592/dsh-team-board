import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { registerReviewTools } from '../../host/dsh/tools.mjs';
import { createRun } from '../../src/review/state.mjs';
import { testStore } from './helpers.mjs';
function assertPlainJson(value, at = '$') {
  assert.notEqual(value, undefined, `${at} owns undefined`);
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) assertPlainJson(child, `${at}.${key}`);
}
test('review_read run omits absent optional report and material source fields at the actual tool boundary', async (t) => {
  const disk = await testStore(); const service = new ReviewService({ store: disk.store, agentRunner: {} });
  t.after(async () => { await service.dispose(); await disk.cleanup(); });
  const run = createRun({ runId: 'plain-json', requestId: 'plain-json', requestDigest: 'd', rootSessionId: 'root', projectRoot: disk.projectRoot, requirement: 'Read JSON', materials: [{ name: 'source-less material', content: 'actual body' }] });
  await disk.store.create(run);
  const definitions = [];
  const dispose = registerReviewTools({ tools: { register(definition) { definitions.push(definition); return () => {}; } } }, async () => service, () => true); t.after(dispose);
  const value = await definitions.find((tool) => tool.name === 'review_read').execute({ runId: run.runId, section: 'run' }, { agent: { id: 'root' } });
  assertPlainJson(value);
  assert.equal(Object.hasOwn(value, 'reportRef'), false);
  assert.equal(Object.hasOwn(value.materials[0], 'source'), false);
});
