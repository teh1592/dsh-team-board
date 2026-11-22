import test from 'node:test';
import assert from 'node:assert/strict';
import { installReview } from '../../host/review-plugin.mjs';

test('review waits for dependencies, releases on withdrawal, and remounts on restoration without affecting board tools', async () => {
  const activeTools = new Map(); const activeListeners = new Map(); const scopes = [];
  const tools = { register(definition) { activeTools.set(definition.name, definition); return () => activeTools.delete(definition.name); } };
  const services = { tools };
  const ctx = {
    tools, get: (name) => services[name],
    on(name, handler) { activeListeners.set(name, handler); return () => activeListeners.delete(name); },
    inject(required, callback) {
      const state = { required, callback, cleanup: undefined, disposed: false };
      scopes.push(state);
      return { async dispose() { state.disposed = true; await state.cleanup?.(); state.cleanup = undefined; } };
    },
  };
  async function refresh() {
    for (const state of scopes) {
      const ready = !state.disposed && state.required.every((name) => services[name]);
      if (!ready && state.cleanup) { await state.cleanup(); state.cleanup = undefined; }
      if (ready && !state.cleanup) state.cleanup = state.callback(ctx);
    }
  }
  tools.register({ name: 'team_board' });
  const dispose = installReview(ctx);
  await refresh(); assert.deepEqual([...activeTools.keys()], ['team_board']);
  assert.equal(scopes.length, 1);
  Object.assign(services, { fs: {}, subagents: {}, agents: { roots: () => [] }, workingDirectory: {} });
  await refresh();
  assert.equal(activeTools.size, 6); assert.ok(activeTools.has('review_start')); assert.equal(activeListeners.size, 3);
  delete services.agents;
  await refresh(); assert.deepEqual([...activeTools.keys()], ['team_board']); assert.equal(activeListeners.size, 0);
  services.agents = { roots: () => [] };
  await refresh(); assert.equal(activeTools.size, 6); assert.equal(activeListeners.size, 3);
  await dispose();
  assert.deepEqual([...activeTools.keys()], ['team_board']); assert.equal(activeListeners.size, 0);
  await refresh(); assert.equal(activeTools.size, 1);
});
