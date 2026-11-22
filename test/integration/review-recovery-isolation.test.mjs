import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { installReview } from '../../host/review-plugin.mjs';
import { sessionIndexDefinition } from '../../host/dsh/session-index.mjs';
import { createRun, beginExecution } from '../../src/review/state.mjs';
import { testStore, automaticAgents, deferred } from './helpers.mjs';
function savedRun(projectRoot, runId, rootSessionId = 'root') {
  return createRun({ runId, requestId: runId, requestDigest: 'd', rootSessionId, projectRoot, requirement: 'Timeout handling' });
}
async function saveRaw(store, run, stageId, result) {
  const execution = beginExecution(run, { executionId: `${run.runId}-execution`, stageId, role: 'lead', inputFingerprint: 'saved-input' });
  execution.childSessionId = `${run.runId}-child`;
  execution.rawResultRef = `artifacts/${execution.executionId}/raw.json`;
  const envelope = { schemaVersion: 1, executionId: execution.executionId, requirementRevision: 1, decisionRevision: 0, inputFingerprint: execution.inputFingerprint, kind: stageId, result };
  await store.writeArtifact(run.runId, execution.rawResultRef, { stopReason: 'completed', structured: envelope, output: [] });
  await store.create(run);
}
test('business-invalid recovered decide is isolated from a healthy run and remains readable and retryable', async (t) => {
  const disk = await testStore(); t.after(() => disk.cleanup());
  const bad = savedRun(disk.projectRoot, 'a-bad-decide');
  await saveRaw(disk.store, bad, 'decide', { summary: 'Invalid adoption', decisions: [{ id: 'D-bad', findingIds: [], choice: 'adopt', reason: 'Needs implementation', checks: ['Check timeout'] }], questions: [] });
  const good = savedRun(disk.projectRoot, 'z-good-intake');
  await saveRaw(disk.store, good, 'intake', { summary: 'Healthy saved intake', acceptance: ['Timeout handled'], questions: [] });
  const runner = automaticAgents();
  const service = new ReviewService({ store: disk.store, agentRunner: runner }); t.after(() => service.dispose());
  await assert.doesNotReject(service.recover());
  await service.wait(good.runId);
  assert.equal((await service.status(bad.runId)).status, 'error');
  const failed = await service.required(bad.runId);
  assert.equal(failed.executions[0].workStatus, 'error'); assert.match(failed.executions[0].diagnostic, /IMPLEMENTATION_REQUIRED|D-bad/);
  assert.equal((await service.required(good.runId)).executions[0].workStatus, 'completed');
  await service.control(bad.runId, 'retry', { operationId: 'retry-invalid-raw' }); await service.wait(bad.runId);
  assert.equal((await service.status(bad.runId)).status, 'completed');
});
test('root B opening after root A flushes B pending notice and starts B queued work in the cached project service', { timeout: 3000 }, async (t) => {
  const disk = await testStore();
  const completed = savedRun(disk.projectRoot, 'b-completed', 'root-B'); completed.status = 'completed'; completed.phase = 'report';
  completed.notifications.push({ notificationId: 'b-completed:1:completed:report:0', revision: 0, status: 'pending', summary: { runId: completed.runId, projectRoot: disk.projectRoot, status: 'completed' } });
  await disk.store.create(completed);
  const queued = savedRun(disk.projectRoot, 'b-queued', 'root-B'); queued.preset = 'quick@2'; await disk.store.create(queued);
  const aRun = savedRun(disk.projectRoot, 'a-completed', 'root-A'); aRun.status = 'completed'; await disk.store.create(aRun);
  const eventsB = []; const noticeDelivered = deferred();
  const rootA = { id: 'root-A', session: { snapshotEvents: () => [] }, followup() {} };
  const rootB = { id: 'root-B', session: { snapshotEvents: () => eventsB }, followup(message) { eventsB.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }); noticeDelivered.resolve(); } };
  const live = new Map([[rootA.id, rootA]]); const tools = []; const listeners = new Map(); let initialObservationCount = 0;
  const startAccepted = deferred();
  const subagents = { list: () => ['fresh'], getProvider: () => ({ name: 'fresh', inheritsParentContext: false, capabilities: { outputSchema: true } }),
    async startActivation(spec) {
      startAccepted.resolve(spec);
      const identity = JSON.parse(spec.request.prompt[0].text.split('身份：')[1].split('\n\n')[0]);
      return { childId: 'B-child', result: Promise.resolve({ stopReason: 'completed', output: [], structured: { ...identity, result: { summary: 'Choose timeout', acceptance: ['Timeout handled'], questions: [{ id: 'timeout', question: 'Choose timeout', findingIds: [], options: [{ id: 'retry', label: 'Retry', description: 'Retry once' }, { id: 'stop', label: 'Stop', description: 'Stop now' }] }] } } }), async dispose() {} };
    } };
  const originalList = disk.store.list.bind(disk.store);
  const services = { fs: disk.fs, subagents, agents: { get: (id) => live.get(id), roots: () => [...live.values()] }, workingDirectory: { get: () => disk.projectRoot } };
  const ctx = { get: (name) => services[name], tools: { register(definition) { tools.push(definition); return () => {}; } }, on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); } };
  const dispose = installReview(ctx); t.after(async () => { await dispose(); await disk.cleanup(); });
  const status = tools.find((tool) => tool.name === 'review_status');
  await status.execute({ runId: aRun.runId }, { agent: rootA });
  assert.equal((await disk.store.load(completed.runId)).notifications[0].status, 'pending');
  assert.equal(eventsB.length, 0);
  live.set(rootB.id, rootB);
  await listeners.get('agent/created')({ agent: rootB });
  assert.ok(eventsB.some((event) => event.data.inserted[0].content[0].text.includes('b-completed')));
  const started = await startAccepted.promise;
  assert.equal(started.request.parent.id, 'root-B');
});
test('same root request in two projects has distinct run IDs, project-local replay, and readable old indexed run', async (t) => {
  const first = await testStore(); const second = await testStore(); t.after(() => first.cleanup()); t.after(() => second.cleanup());
  const a = new ReviewService({ store: first.store, agentRunner: automaticAgents(), isRootOnline: () => false });
  const b = new ReviewService({ store: second.store, agentRunner: automaticAgents(), isRootOnline: () => false });
  t.after(() => a.dispose()); t.after(() => b.dispose());
  const request = { requestId: 'same-request', requirement: 'Timeout handling' }; const actor = { sessionId: 'same-root' };
  const one = await a.start(request, actor); const two = await b.start(request, actor);
  await a.wait(one.runId); await b.wait(two.runId);
  assert.notEqual(one.runId, two.runId);
  assert.equal((await a.start(request, actor)).runId, one.runId);
  assert.equal((await b.start(request, actor)).runId, two.runId);
  let index = sessionIndexDefinition.init();
  for (const value of [one, two]) index = sessionIndexDefinition.apply(index, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  assert.equal(index[one.runId], first.projectRoot); assert.equal(index[two.runId], second.projectRoot);
  const tools = []; const agent = { id: actor.sessionId, session: {} };
  const services = { fs: first.fs, subagents: {}, agents: { get: () => agent, roots: () => [] }, workingDirectory: { get: () => second.projectRoot }, sessionProjections: { async register() { return { stateOf: () => index, async dispose() {} }; } } };
  const dispose = installReview({ get: (key) => services[key], tools: { register(definition) { tools.push(definition); return () => {}; } } }); t.after(dispose);
  const old = await tools.find((tool) => tool.name === 'review_status').execute({ runId: one.runId }, { agent });
  assert.equal(old.projectRoot, first.projectRoot); assert.equal(old.runId, one.runId);
});
