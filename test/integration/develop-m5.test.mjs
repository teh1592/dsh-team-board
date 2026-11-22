import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../../host/review-service.mjs';
import { DshProjectFiles } from '../../host/dsh/project-files.mjs';
import { automaticAgents, testStore, deferred } from './helpers.mjs';
async function fixture(t, { machineFailure = false, permanentFailure = false } = {}) {
  const disk = await testStore();
  const checks = [{ id: 'unit', kind: 'test', parser: 'node-test', argv: ['node', '--test'], inputs: ['src/api/**'], outputs: [] }];
  await disk.fs.writeText(await disk.fs.resolve('.review/config.json'), JSON.stringify({ schemaVersion: 1, checks }));
  const agents = automaticAgents(); const original = agents.start; let builds = 0; let verifies = 0; let commands = 0;
  agents.start = async (spec) => {
    if (!['build', 'verify'].includes(spec.stageId)) return original(spec);
    agents.calls.push(spec);
    const identity = JSON.parse(spec.prompt.split('身份：')[1].split('\n\n')[0]);
    let result;
    if (spec.stageId === 'build') {
      builds++;
      await disk.fs.writeText(await disk.fs.resolve('src/api/timeout.mjs'), `export const timeout = ${builds > 1 ? 43 : 42};\n`);
      result = { summary: `Build ${builds}`, changed: ['src/api/timeout.mjs'], completedTaskIds: spec.inputs.tasks.filter((task) => task.workStatus !== 'completed').map((task) => task.id), resolvedFindingIds: spec.inputs.findings.filter((finding) => finding.origin === 'verification' && finding.status !== 'resolved').map((finding) => finding.id) };
    } else {
      verifies++;
      const defect = !machineFailure && (verifies === 1 || permanentFailure);
      result = { decision: defect ? 'needs_revision' : 'accept', summary: defect ? 'Boundary defect' : 'Implementation accepted', findings: defect ? [{ id: 'boundary', severity: 'high', description: 'Timeout must be 43', basis: 'Actual implementation returns 42', taskIds: [spec.inputs.tasks[0].id] }] : [], risks: [], tests: ['Boundary examined'], resolvedFindingIds: defect ? [] : spec.inputs.findings.filter((finding) => finding.origin === 'verification' && finding.status !== 'resolved').map((finding) => finding.id) };
    }
    const envelope = { ...identity, result };
    return { childId: `${spec.stageId}-${spec.executionId}`, result: Promise.resolve({ raw: { structured: envelope, output: [], stopReason: 'completed' }, envelope }), async cancel() {} };
  };
  const commandRunner = { async run(spec) { commands++; const fail = machineFailure && (commands === 1 || permanentFailure); return { checkId: spec.id, outcome: fail ? 'failed' : 'passed', exitCode: fail ? 1 : 0, stdout: `${fail ? 'not ok 1 - boundary\n' : ''}# tests 1\n# pass ${fail ? 0 : 1}\n# fail ${fail ? 1 : 0}`, stderr: '', startedAt: 'start', endedAt: 'end' }; }, async dispose() {} };
  const service = new ReviewService({ store: disk.store, agentRunner: agents, projectFiles: new DshProjectFiles(disk.fs, disk.projectRoot), commandRunner });
  t.after(async () => { await service.dispose(); await disk.cleanup(); });
  return { ...disk, service, agents, counters: () => ({ builds, verifies, commands }) };
}
test('independent verifier finds intentional defect, keeps issue ID through rework and rechecks actual current code', async (t) => {
  const { service, agents, counters } = await fixture(t);
  const { runId } = await service.start({ requestId: 'rework', requirement: 'Timeout is 43', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  const run = await service.required(runId);
  assert.equal(run.status, 'completed', run.diagnostic);
  assert.deepEqual(counters(), { builds: 2, verifies: 2, commands: 2 });
  const finding = run.findings.find((entry) => entry.origin === 'verification');
  assert.equal(finding.status, 'resolved');
  assert.ok(run.tasks.some((task) => task.origin === 'rework' && task.findingIds.includes(finding.id)));
  const secondBuild = agents.calls.filter((call) => call.stageId === 'build')[1];
  assert.ok(secondBuild.inputs.findings.some((entry) => entry.id === finding.id));
  assert.ok(run.checkResults.some((result) => result.applicability === 'stale'));
  assert.match((await service.inspect(runId, 'report')).content, /返工：1\/2/);
});
for (const stage of ['build', 'verify']) test(`${stage} stage-tool completion remains effective when activation returns different text for the same identity`, async (t) => {
  const { service, agents } = await fixture(t, { machineFailure: true });
  service.commandRunner.run = async (spec) => ({ checkId: spec.id, outcome: 'passed', exitCode: 0, stdout: '# tests 1\n# pass 1\n# fail 0', stderr: '' });
  const start = agents.start; let first;
  agents.start = async (spec) => {
    const handle = await start(spec);
    if (spec.stageId !== stage) return handle;
    const received = await handle.result; first = received.envelope;
    // A real managed child's agent/created callback publishes this identity before stage-tool use.
    await service.mutate(spec.runId, 'child-identified-test', (run) => { run.executions.find((execution) => execution.executionId === spec.executionId).childSessionId = handle.childId; return null; });
    assert.equal((await service.submit(spec.runId, first, { sessionId: handle.childId, kind: 'stage-tool' })).applicability, 'current');
    const later = { ...first, result: { ...first.result, summary: 'Different activation summary for the same completion' } };
    return { ...handle, result: Promise.resolve({ raw: { structured: later, output: [], stopReason: 'completed' }, envelope: later }) };
  };
  const { runId } = await service.start({ requestId: `dual-channel-${stage}`, requirement: 'Implement timeout', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  const run = await service.required(runId);
  assert.equal(run.status, 'completed', run.diagnostic);
  const execution = run.executions.find((entry) => entry.executionId === first.executionId);
  assert.equal(execution.result.summary, first.result.summary); assert.equal(execution.applicability, 'current'); assert.equal(execution.processed, true);
  assert.deepEqual(run.artifacts.filter((artifact) => artifact.executionId === first.executionId).map((artifact) => artifact.applicability), ['current', 'stale']);
});
for (const stage of ['build', 'verify']) test(`${stage} activation with mismatched identity and no accepted completion still pauses`, async (t) => {
  const { service, agents } = await fixture(t, { machineFailure: true });
  service.commandRunner.run = async (spec) => ({ checkId: spec.id, outcome: 'passed', exitCode: 0, stdout: '# tests 1\n# pass 1\n# fail 0', stderr: '' });
  const start = agents.start;
  agents.start = async (spec) => {
    const handle = await start(spec); if (spec.stageId !== stage) return handle;
    const received = await handle.result;
    const mismatched = { ...received.envelope, decisionRevision: received.envelope.decisionRevision + 1 };
    return { ...handle, result: Promise.resolve({ raw: { structured: mismatched, output: [], stopReason: 'completed' }, envelope: mismatched }) };
  };
  const { runId } = await service.start({ requestId: `mismatched-${stage}`, requirement: 'Implement timeout', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  const run = await service.required(runId);
  assert.equal(run.status, 'paused'); assert.match(run.diagnostic, /mismatched input version/);
  const execution = run.executions.find((entry) => entry.executionId === run.activeExecutions[`${stage}:${stage === 'build' ? 'developer' : 'verifier'}`]);
  assert.equal(execution.workStatus, 'interrupted'); assert.equal(execution.applicability, 'stale');
});
test('failed required command creates machine finding and targeted rework, success resolves it', async (t) => {
  const { service, counters } = await fixture(t, { machineFailure: true });
  const { runId } = await service.start({ requestId: 'machine-rework', requirement: 'Timeout is 43', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  const run = await service.required(runId);
  assert.equal(run.status, 'completed', run.diagnostic);
  assert.deepEqual(counters(), { builds: 2, verifies: 1, commands: 2 });
  assert.equal(run.findings.find((entry) => entry.origin === 'machine').status, 'resolved');
});
test('automatic rework is bounded and preserves work until user chooses', async (t) => {
  const { service, counters } = await fixture(t, { permanentFailure: true });
  const { runId } = await service.start({ requestId: 'limit', requirement: 'Timeout is 43', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  const run = await service.required(runId);
  assert.equal(run.status, 'waiting_user', run.diagnostic); assert.equal(counters().builds, 3);
  const question = run.questions.find((question) => question.category === 'rework-limit'); assert.ok(question);
  await service.decide(runId, question.id, 'continue', { kind: 'user', sessionId: 'root' }, 'continue-rework'); await service.wait(runId);
  const continued = await service.required(runId);
  assert.equal(counters().builds, 4); assert.equal(continued.rework.max, 3); assert.equal(continued.status, 'waiting_user');
  assert.equal(continued.findings.filter((finding) => finding.origin === 'verification').length, 1, 'manual continuation preserves the original issue identity');
});
test('full requirement revision gets a fresh rework budget while preserving exhausted old history', async (t) => {
  const { service } = await fixture(t, { permanentFailure: true });
  const { runId } = await service.start({ requestId: 'full-revise-budget', requirement: 'First requirement', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  const previous = await service.required(runId); assert.equal(previous.status, 'waiting_user'); assert.equal(previous.rework.count, 2);
  const oldFindings = previous.findings.filter((finding) => finding.origin === 'verification').map((finding) => finding.id);
  const oldExecutions = previous.executions.map((execution) => execution.executionId);
  await service.revise(runId, { operationId: 'full-new-requirement', requirement: 'Second requirement with a new independent issue', reason: 'Replace requirement' }); await service.wait(runId);
  const next = await service.required(runId); assert.equal(next.requirementRevision, 2);
  assert.ok(next.tasks.some((task) => task.id === 'rework-2-1'), 'new requirement must receive its first automatic rework task');
  assert.equal(next.rework.count, 2); assert.equal(next.status, 'waiting_user');
  for (const id of oldFindings) assert.equal(next.findings.find((finding) => finding.id === id).applicability, 'stale');
  for (const id of oldExecutions) assert.equal(next.executions.find((execution) => execution.executionId === id).applicability, 'stale');
  assert.ok(next.history.length > previous.history.length);
});
test('impact revision reuses review and decision while rebuilding only affected implementation task', async (t) => {
  const { service, agents, counters } = await fixture(t, { machineFailure: true });
  const { runId } = await service.start({ requestId: 'impact', requirement: 'Timeout is 43', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  let run = await service.required(runId); assert.equal(run.status, 'completed', run.diagnostic);
  const beforeReview = agents.calls.filter((call) => ['intake', 'review', 'decide'].includes(call.stageId)).length;
  await service.revise(runId, { operationId: 'impact-revision', requirement: 'Timeout is 43 with clearer docs', reason: 'Target timeout module', impact: { taskIds: [run.tasks[0].id], paths: ['src/api/timeout.mjs'], review: 'reuse' } }); await service.wait(runId);
  run = await service.required(runId);
  assert.equal(run.status, 'completed', run.diagnostic); assert.equal(run.requirementRevision, 2);
  assert.equal(agents.calls.filter((call) => ['intake', 'review', 'decide'].includes(call.stageId)).length, beforeReview);
  assert.equal(run.revisionImpact.affectedTaskIds.includes(run.tasks[0].id), true);
  const reusedBuild = agents.calls.filter((call) => call.stageId === 'build').at(-1);
  assert.ok(reusedBuild.inputs.intake?.acceptance.length, 'reused intake acceptance remains available');
  const report = (await service.inspect(runId, 'report')).content;
  assert.match(report, /1:D-1/);
  assert.match(report, /task-1-1/);
  assert.match(report, /复用自需求版本 1/);
});
test('interrupted build reload inspects actual partial files and retry finishes from retained work', async (t) => {
  const { service, store, fs, agents, projectRoot } = await fixture(t);
  const original = agents.start; const published = deferred(); const pending = deferred(); let held = false;
  agents.start = async (spec) => {
    if (spec.stageId !== 'build' || held) return original(spec);
    held = true;
    await fs.writeText(await fs.resolve('src/api/timeout.mjs'), '// partial work retained\n');
    published.resolve();
    return { childId: 'interrupted-builder', result: pending.promise, async cancel() { pending.resolve({ raw: { output: [], stopReason: 'aborted' } }); } };
  };
  const { runId } = await service.start({ requestId: 'interrupt', requirement: 'Timeout is 43', mode: 'develop' }, { sessionId: 'root' }); await published.promise;
  await service.control(runId, 'stop', { operationId: 'stop-partial' }); await service.dispose();
  assert.equal((await store.load(runId)).status, 'paused');
  const replacement = new ReviewService({ store, agentRunner: agents, projectFiles: new DshProjectFiles(fs, projectRoot), commandRunner: service.commandRunner });
  t.after(() => replacement.dispose());
  await replacement.recover();
  assert.ok((await store.load(runId)).workspace.recoverySnapshotRef);
  assert.match(await fs.readText(await fs.resolve('src/api/timeout.mjs')), /partial work retained/);
  await replacement.control(runId, 'retry', { operationId: 'retry-partial' }); await replacement.wait(runId);
  const run = await store.load(runId); assert.equal(run.status, 'completed', run.diagnostic);
  assert.ok(run.workspace.resumeSnapshotRef); assert.ok(run.executions.some((execution) => execution.workStatus === 'interrupted'));
});
test('legacy accepted verifier without code fingerprint recovers and reports without starting another model', async (t) => {
  const { service, store, fs, agents, projectRoot, counters } = await fixture(t, { machineFailure: true });
  const { runId } = await service.start({ requestId: 'accepted-before-pause', requirement: 'Timeout is 43', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  assert.equal((await service.required(runId)).status, 'completed');
  const before = counters();
  await service.mutate(runId, 'legacy-pause', (run) => {
    run.status = 'paused'; delete run.executions.find((entry) => entry.executionId === run.activeExecutions['verify:verifier']).codeFingerprint;
    run.diagnostic = 'Old duplicate completion pause'; return null;
  });
  await service.dispose();
  const replacement = new ReviewService({ store, agentRunner: agents, projectFiles: new DshProjectFiles(fs, projectRoot), commandRunner: service.commandRunner });
  t.after(() => replacement.dispose());
  await replacement.recover();
  const recovered = await replacement.required(runId);
  assert.equal(recovered.executions.find((entry) => entry.executionId === recovered.activeExecutions['verify:verifier']).codeFingerprint, recovered.workspace.verifyBeforeFingerprint);
  await replacement.control(runId, 'resume', { operationId: 'legacy-resume-report' }); await replacement.wait(runId);
  assert.equal((await replacement.required(runId)).status, 'completed'); assert.deepEqual(counters(), before);
});
test('unknown command result pauses locally and resume reruns checks without another initial build', async (t) => {
  const { service, counters } = await fixture(t, { machineFailure: true });
  const command = service.commandRunner.run; let unavailable = true;
  service.commandRunner.run = async (spec) => unavailable ? { checkId: spec.id, outcome: 'unknown', exitCode: null, reason: 'timeout', summary: 'Command timed out', stdout: '', stderr: '' } : command(spec);
  const { runId } = await service.start({ requestId: 'unknown', requirement: 'Timeout is 43', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  let run = await service.required(runId); assert.equal(run.status, 'paused'); assert.equal(counters().builds, 1); assert.equal(counters().verifies, 0);
  assert.equal(run.findings.some((finding) => finding.origin === 'machine'), false);
  unavailable = false;
  await service.control(runId, 'resume', { operationId: 'resume-checks' }); await service.wait(runId);
  run = await service.required(runId); assert.equal(run.status, 'completed', run.diagnostic);
  assert.equal(run.checkResults[0].applicability, 'stale');
});
test('failed machine check followed by unknown waits without spending another rework round, then passed resumes', async (t) => {
  const { service, counters } = await fixture(t, { machineFailure: true }); let checks = 0; let restored = false;
  service.commandRunner.run = async (spec) => {
    checks++;
    const outcome = checks === 1 ? 'failed' : restored ? 'passed' : 'unknown';
    return { checkId: spec.id, outcome, exitCode: outcome === 'unknown' ? null : outcome === 'failed' ? 1 : 0,
      ...(outcome === 'unknown' ? { reason: 'tool-missing', summary: 'Test tool is missing' } : {}),
      stdout: `${outcome === 'failed' ? 'not ok 1 - boundary\n' : ''}# tests 1\n# pass ${outcome === 'passed' ? 1 : 0}\n# fail ${outcome === 'failed' ? 1 : 0}`, stderr: '' };
  };
  const { runId } = await service.start({ requestId: 'failed-unknown', requirement: 'Timeout is 43', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  let run = await service.required(runId);
  assert.equal(run.status, 'paused', run.diagnostic); assert.equal(counters().builds, 2); assert.equal(run.rework.count, 1);
  const finding = run.findings.find((entry) => entry.origin === 'machine'); assert.equal(finding.status, 'open');
  assert.equal(run.checkResults.at(-1).outcome, 'unknown');
  restored = true;
  await service.control(runId, 'resume', { operationId: 'restore-tool' }); await service.wait(runId);
  run = await service.required(runId);
  assert.equal(run.status, 'completed', run.diagnostic); assert.equal(counters().builds, 2); assert.equal(run.rework.count, 1);
  assert.equal(run.findings.find((entry) => entry.id === finding.id).status, 'resolved');
});
for (const replacement of ['renamed', 'optional', 'same-id-failed']) test(`machine finding follows active check configuration when ${replacement}`, async (t) => {
  const { service, fs, counters } = await fixture(t, { machineFailure: true });
  service.commandRunner.run = async (spec) => ({ checkId: spec.id, outcome: 'unknown', exitCode: null, summary: 'Wait for config repair', stdout: '', stderr: '' });
  const { runId } = await service.start({ requestId: `config-finding-${replacement}`, requirement: 'Timeout is 43', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  await service.mutate(runId, 'seed-prior-machine-finding', (run) => {
    run.findings.push({ id: 'check:1:unit', checkId: 'unit', sourceExecutionId: 'old-check', sourceFindingId: 'unit', severity: 'high', description: 'Old required check failed', basis: 'old config result', status: 'open', relatedFindingIds: [], origin: 'machine', taskIds: [run.tasks[0].id], requirementRevision: 1, applicability: 'current' }); return null;
  });
  const id = replacement === 'renamed' ? 'replacement' : 'unit';
  await fs.writeText(await fs.resolve('.review/config.json'), JSON.stringify({ schemaVersion: 1, checks: [{ id, argv: ['node', 'updated-check.mjs'], kind: 'command', parser: 'exit-code', required: replacement !== 'optional', inputs: ['src/**'] }] }));
  service.commandRunner.run = async (spec) => ({ checkId: spec.id, outcome: replacement === 'same-id-failed' ? 'failed' : 'passed', exitCode: replacement === 'same-id-failed' ? 1 : 0, stdout: '', stderr: '' });
  await service.control(runId, 'resume', { operationId: 'resume-config-check' }); await service.wait(runId);
  const run = await service.required(runId); const previous = run.findings.find((finding) => finding.id === 'check:1:unit');
  if (replacement === 'same-id-failed') { assert.equal(previous.applicability, 'current'); assert.equal(previous.status, 'open'); assert.ok(run.rework.count > 0); }
  else { assert.equal(run.status, 'completed', run.diagnostic); assert.equal(run.rework.count, 0); assert.equal(counters().builds, 1); assert.equal(previous.applicability, 'stale'); assert.equal(previous.status, 'open'); }
});
test('removing the final required check archives its failed finding while preserving empty-config pause', async (t) => {
  const { service, fs, counters } = await fixture(t, { machineFailure: true }); let commands = 0;
  service.commandRunner.run = async (spec) => {
    commands++;
    return commands === 1
      ? { checkId: spec.id, outcome: 'failed', exitCode: 1, stdout: 'not ok 1 - boundary\n# tests 1\n# pass 0\n# fail 1', stderr: '' }
      : { checkId: spec.id, outcome: 'unknown', exitCode: null, reason: 'tool-missing', summary: 'Tool missing', stdout: '', stderr: '' };
  };
  const { runId } = await service.start({ requestId: 'empty-check-config', requirement: 'Timeout is 43', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  const previous = await service.required(runId); const finding = previous.findings.find((entry) => entry.origin === 'machine');
  assert.equal(previous.status, 'paused'); assert.equal(finding.status, 'open'); assert.equal(finding.applicability, 'current');
  const before = { ...counters(), commands };
  await fs.writeText(await fs.resolve('.review/config.json'), JSON.stringify({ schemaVersion: 1, checks: [] }));
  await service.mutate(runId, 'empty-check-retry', (run) => { run.status = 'queued'; return null; });
  assert.equal(await service.develop.checks(runId), false);
  const current = await service.required(runId); const archived = current.findings.find((entry) => entry.id === finding.id);
  assert.equal(current.status, 'paused'); assert.match(current.diagnostic, /No machine checks configured/);
  assert.equal(archived.applicability, 'stale'); assert.equal(archived.status, 'open');
  assert.equal(current.rework.count, previous.rework.count); assert.deepEqual({ ...counters(), commands }, before);
});
test('initial failed required plan check waits before tasks and retries successfully on resume', async (t) => {
  const { service, fs } = await fixture(t, { machineFailure: true });
  await fs.writeText(await fs.resolve('.review/config.json'), JSON.stringify({ schemaVersion: 1, checks: [
    { id: 'preflight', argv: ['node', 'preflight.mjs'], phase: 'plan', required: true },
    { id: 'unit', argv: ['node', 'unit.mjs'], phase: 'implementation', required: true },
  ] }));
  let ready = false; let preflights = 0;
  service.commandRunner.run = async (spec) => {
    if (spec.id === 'preflight') preflights++;
    const passed = spec.id !== 'preflight' || ready;
    return { checkId: spec.id, outcome: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1, stdout: '', stderr: '' };
  };
  const { runId } = await service.start({ requestId: 'initial-plan-failed', requirement: 'Implement timeout', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  let run = await service.required(runId);
  assert.equal(run.status, 'paused'); assert.equal(run.tasks.length, 0); assert.equal(run.findings.length, 0); assert.equal(run.rework.count, 0);
  ready = true;
  await service.control(runId, 'resume', { operationId: 'resume-after-preflight' }); await service.wait(runId);
  run = await service.required(runId); assert.equal(run.status, 'completed', run.diagnostic); assert.ok(preflights >= 2);
  assert.equal(run.checkResults.find((result) => result.checkId === 'preflight').applicability, 'stale');
});
for (const refreshedOutcome of ['passed', 'unknown']) test(`required plan checks rerun against build changes and ${refreshedOutcome === 'passed' ? 'archive the old fingerprint' : 'wait locally on unknown'}`, async (t) => {
  const { service, fs } = await fixture(t, { machineFailure: true });
  await fs.writeText(await fs.resolve('src/api/timeout.mjs'), 'export const timeout = 1;\n');
  await fs.writeText(await fs.resolve('.review/config.json'), JSON.stringify({ schemaVersion: 1, checks: [
    { id: 'plan', kind: 'command', phase: 'plan', argv: ['node', 'plan.mjs'], inputs: ['src/**'], required: true },
    { id: 'unit', kind: 'command', phase: 'implementation', argv: ['node', 'unit.mjs'], inputs: ['src/**'], required: true },
  ] }));
  const observed = [];
  service.commandRunner.run = async (spec) => {
    if (spec.id === 'plan') observed.push(await fs.readText(await fs.resolve('src/api/timeout.mjs')));
    const outcome = spec.id === 'plan' && observed.length > 1 ? refreshedOutcome : 'passed';
    return { checkId: spec.id, outcome, exitCode: outcome === 'passed' ? 0 : null, stdout: '', stderr: '', summary: outcome };
  };
  const { runId } = await service.start({ requestId: `plan-${refreshedOutcome}`, requirement: 'Update timeout', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  const run = await service.required(runId);
  assert.equal(observed.length, 2, 'plan must execute again for the changed source');
  assert.match(observed[0], /timeout = 1/); assert.match(observed[1], /timeout = 42/);
  const plans = run.checkResults.filter((result) => result.checkId === 'plan');
  assert.equal(plans[0].applicability, 'stale'); assert.notEqual(plans[0].inputFingerprint, plans[1].inputFingerprint);
  assert.equal(run.status, refreshedOutcome === 'passed' ? 'completed' : 'paused', run.diagnostic);
});
test('changing check configuration during command reruns the updated argv and archives the previous result', async (t) => {
  const { service, fs } = await fixture(t, { machineFailure: true }); let first = true; const received = [];
  service.commandRunner.run = async (spec) => {
    received.push(spec.argv);
    if (first) { first = false; await fs.writeText(await fs.resolve('.review/config.json'), JSON.stringify({ schemaVersion: 1, checks: [{ id: 'unit', kind: 'test', parser: 'node-test', argv: ['node', '--test', 'new.test.mjs'] }] })); }
    return { checkId: spec.id, outcome: 'passed', exitCode: 0, stdout: '# tests 1\n# pass 1\n# fail 0', stderr: '' };
  };
  const { runId } = await service.start({ requestId: 'config-change', requirement: 'Timeout is 43', mode: 'develop' }, { sessionId: 'root' }); await service.wait(runId);
  const run = await service.required(runId); assert.equal(run.status, 'completed', run.diagnostic);
  assert.deepEqual(received[1], ['node', '--test', 'new.test.mjs']); assert.equal(run.checkResults[0].applicability, 'stale');
});
