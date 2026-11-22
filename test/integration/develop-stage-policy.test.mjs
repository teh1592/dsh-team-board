import test from 'node:test';
import assert from 'node:assert/strict';
import { installStageToolPolicy } from '../../host/review-plugin.mjs';
for (const stage of ['build', 'review', 'verify']) test(`stage policy ${stage} preserves ancestor preset role tools and guards own non-role tools`, () => {
  const inherited = ['research', 'read', 'write', 'edit', 'pwsh', 'review_start'];
  const own = ['structured_output', 'review_submit', 'local_extra'];
  const denied = new Set(); let guard;
  const agent = { id: 'child', ctx: { tools: {
    restrict({ deny }) {
      assert.equal(deny.length, 1);
      const [name] = deny;
      if (own.includes(name)) throw new Error(`tools.restrict() names unknown global tool ${JSON.stringify(name)}; known global tools: ${inherited.join(', ')}`);
      denied.add(name); return () => denied.delete(name);
    },
    guard(fn) { guard = fn; return () => { guard = undefined; }; },
  } } };
  const ctx = { tools: { definitions(key) { assert.equal(key, agent); return [...inherited, ...own, 'run_code'].map((name) => ({ name })); } } };
  const dispose = installStageToolPolicy(ctx, agent, stage);
  assert.equal(denied.has('read'), false); assert.equal(denied.has('research'), false); assert.equal(denied.has('review_start'), true);
  for (const name of ['write', 'edit', 'pwsh']) { assert.equal(denied.has(name), stage !== 'build'); assert.equal(guard({ name }) === undefined, stage === 'build'); }
  assert.equal(guard({ name: 'structured_output' }), undefined); assert.equal(guard({ name: 'run_code' }), undefined);
  assert.ok(guard({ name: 'local_extra' })); assert.equal(denied.has('local_extra'), false);
  dispose(); assert.equal(denied.size, 0); assert.equal(guard, undefined); dispose();
});
test('stage policy rolls back prior restrictions and propagates unexpected setup errors', () => {
  let released = 0;
  const agent = { ctx: { tools: { restrict({ deny: [name] }) { if (name === 'broken') throw new Error('provider failed'); return () => { released++; }; }, guard() { throw new Error('unexpected guard'); } } } };
  assert.throws(() => installStageToolPolicy({ tools: { definitions: () => [{ name: 'review_start' }, { name: 'broken' }] } }, agent, 'build'), /provider failed/);
  assert.equal(released, 1);
});
