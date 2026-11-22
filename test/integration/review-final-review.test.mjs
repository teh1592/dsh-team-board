import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { registerReviewCommand } from '../../host/dsh/commands.mjs';
import { validateEnvelope } from '../../src/review/schemas.mjs';
import { createRun, beginExecution } from '../../src/review/state.mjs';
import { testStore, automaticAgents } from './helpers.mjs';
const result = { schemaVersion: 1, executionId: 'exec', requirementRevision: 1, decisionRevision: 0, inputFingerprint: 'f', kind: 'intake', result: { summary: 'Choose timeout', acceptance: ['Timeout recovers'], questions: [{ id: 'timeout-behavior', question: 'Choose behavior', findingIds: [], options: [{ id: 'retry-once', label: 'Retry once', description: 'Retry once before error' }, { id: 'return-error', label: 'Return error', description: 'Return immediately' }] }] } };
test('question and option IDs must be command-compatible nonempty slugs', () => {
  assert.equal(validateEnvelope(result), result);
  for (const id of ['', ' ', 'timeout behavior', 'timeout\tbehavior', 'timeout\nbehavior', '/timeout', 'timeout:behavior']) {
    const question = structuredClone(result); question.result.questions[0].id = id;
    assert.throws(() => validateEnvelope(question), undefined, `question id ${JSON.stringify(id)}`);
    const option = structuredClone(result); option.result.questions[0].options[0].id = id;
    assert.throws(() => validateEnvelope(option), undefined, `option id ${JSON.stringify(id)}`);
  }
});
test('waiting_user nextActions command round-trips through actual review command handler and creates implementation requirements', async (t) => {
  const disk = await testStore(); t.after(() => disk.cleanup());
  const runner = automaticAgents({ questions: true });
  const originalStart = runner.start;
  runner.start = async (spec) => {
    const handle = await originalStart(spec);
    if (spec.stageId === 'decide') handle.result = handle.result.then((received) => {
      const question = received.envelope?.result.questions[0];
      if (question) { question.id = 'timeout-behavior'; question.options[0].id = 'retry-once'; }
      return received;
    });
    return handle;
  };
  const service = new ReviewService({ store: disk.store, agentRunner: runner }); t.after(() => service.dispose());
  const { runId } = await service.start({ requestId: 'command-roundtrip', requirement: 'Timeout handling' }, { sessionId: 'root' }); await service.wait(runId);
  const status = await service.status(runId);
  assert.equal(status.status, 'waiting_user');
  const action = status.nextActions.find((entry) => entry.command);
  assert.ok(action); assert.match(action.command, /^\/review decide /);
  let command;
  registerReviewCommand({ register(definition) { command = definition; return () => {}; } }, async () => service);
  const executed = await command.handler({ commandId: 'real-user-command', agent: { id: 'root' }, rawInput: action.command.slice('/review '.length) });
  assert.equal(executed.kind, 'success', executed.text);
  await service.wait(runId);
  const run = await service.required(runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.questions.find((question) => question.id === 'timeout-behavior').answer, 'retry-once');
  assert.ok(run.tasks.length); assert.ok(run.decisions.at(-1).checks.length);
});
test('reload recovers completed raw text JSON without structured output or session lookup, then reuses its intake', async (t) => {
  const disk = await testStore(); t.after(() => disk.cleanup());
  const run = createRun({ runId: 'raw-text-recovery', requestId: 'raw-text', requestDigest: 'd', rootSessionId: 'root', projectRoot: disk.projectRoot, requirement: 'Timeout handling' });
  const execution = beginExecution(run, { executionId: 'external-intake', stageId: 'intake', role: 'lead', inputFingerprint: 'external-input' });
  execution.childSessionId = 'external-child'; execution.rawResultRef = 'artifacts/external-intake/raw.json';
  const envelope = { schemaVersion: 1, executionId: execution.executionId, requirementRevision: execution.requirementRevision, decisionRevision: execution.decisionRevision, inputFingerprint: execution.inputFingerprint, kind: 'intake', result: { summary: 'Recovered external intake', acceptance: ['Timeout recovers'], questions: [] } };
  await disk.store.writeArtifact(run.runId, execution.rawResultRef, { stopReason: 'completed', output: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\`` }] });
  run.status = 'paused'; await disk.store.create(run);
  const runner = automaticAgents(); let sessionLookups = 0;
  runner.recover = async () => { sessionLookups++; return { kind: 'interrupted', diagnostic: 'External child has no durable session' }; };
  const service = new ReviewService({ store: disk.store, agentRunner: runner }); t.after(() => service.dispose());
  await service.recover();
  const restored = await service.required(run.runId);
  assert.equal(restored.executions[0].workStatus, 'completed'); assert.equal(restored.executions[0].processed, true);
  assert.equal(restored.executions[0].result.summary, 'Recovered external intake'); assert.equal(sessionLookups, 0);
  await service.control(run.runId, 'resume', { operationId: 'resume-recovered-text' }); await service.wait(run.runId);
  assert.equal((await service.required(run.runId)).status, 'completed');
  assert.equal(runner.calls.filter((call) => call.stageId === 'intake').length, 0);
});
