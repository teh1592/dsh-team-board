import { currentTasks } from './checks.mjs';
import { protocolError } from './schemas.mjs';
export function implementationFindings(run) {
  return run.findings.filter((finding) => finding.applicability !== 'stale' && ['machine', 'verification'].includes(finding.origin) && !['resolved', 'dismissed'].includes(finding.status));
}
export function recordCheckFindings(run, config, phases = ['plan', 'implementation', 'delivery']) {
  const required = new Set(config.checks.filter((check) => check.required).map((check) => check.id));
  for (const finding of run.findings.filter((entry) => entry.origin === 'machine' && entry.applicability !== 'stale')) {
    if (!required.has(finding.checkId)) finding.applicability = 'stale';
  }
  for (const spec of config.checks.filter((check) => check.required && phases.includes(check.phase))) {
    const result = run.checkResults.findLast((entry) => entry.checkId === spec.id && !entry.baseline && entry.applicability === 'current' && entry.requirementRevision === run.requirementRevision && (config.digest === undefined || entry.configDigest === config.digest));
    const existing = run.findings.find((finding) => finding.origin === 'machine' && finding.checkId === spec.id && finding.applicability !== 'stale');
    if (result?.outcome === 'passed') { if (existing) { existing.status = 'resolved'; existing.resolvedByExecutionId = result.executionId; } continue; }
    if (result?.outcome !== 'failed') continue;
    if (existing) { existing.status = 'open'; existing.basis = `${result.summary}; log ${result.logRef}`; continue; }
    run.findings.push({ id: `check:${run.requirementRevision}:${spec.id}`, sourceExecutionId: result.executionId, sourceFindingId: spec.id, severity: 'high', description: `Required check ${spec.id} failed`, basis: `${result.summary}; log ${result.logRef}`, status: 'open', relatedFindingIds: [], origin: 'machine', checkId: spec.id, taskIds: spec.taskIds.length ? spec.taskIds : currentTasks(run).map((task) => task.id), requirementRevision: run.requirementRevision, applicability: 'current' });
  }
}
export function recordVerification(run, execution) {
  const result = execution.result;
  const previous = implementationFindings(run).filter((finding) => finding.origin === 'verification');
  const unresolved = new Set(previous.map((finding) => finding.id));
  for (const id of result.resolvedFindingIds ?? []) {
    const finding = previous.find((entry) => entry.id === id);
    if (!finding) throw protocolError('FINDING_NOT_FOUND', id);
    finding.status = 'resolved'; finding.resolvedByExecutionId = execution.executionId; unresolved.delete(id);
  }
  for (const input of result.findings) {
    let finding = previous.find((entry) => entry.id === input.id || entry.sourceFindingId === input.id || entry.description.trim() === input.description.trim());
    if (finding) { finding.status = 'open'; finding.basis = input.basis; finding.severity = input.severity; }
    else {
      finding = { ...input, id: `${execution.executionId}:${input.id}`, sourceFindingId: input.id, sourceExecutionId: execution.executionId, status: 'open', relatedFindingIds: [], origin: 'verification', taskIds: input.taskIds?.length ? input.taskIds : currentTasks(run).map((task) => task.id), requirementRevision: run.requirementRevision, applicability: 'current' };
      if (finding.taskIds.some((id) => !currentTasks(run).some((task) => task.id === id))) throw protocolError('TASK_NOT_FOUND', input.id);
      run.findings.push(finding);
    }
  }
  if (result.decision !== 'accept' && !result.findings.length && !previous.some((finding) => finding.status !== 'resolved')) throw protocolError('VERIFY_FINDINGS_REQUIRED', execution.executionId);
  // An accept result must explicitly account for every previously repaired issue.
  if (result.decision === 'accept' && [...unresolved].length) throw protocolError('VERIFY_UNRESOLVED_FINDINGS', [...unresolved].join(', '));
}
export function scheduleRework(run, findings, reason) {
  if (!findings.length) return false;
  const state = run.rework ??= { count: 0, max: 2, findingIds: [] };
  if (state.count >= state.max) {
    run.status = 'waiting_user';
    const id = `rework-limit-${state.count}`;
    if (!run.questions.some((question) => question.id === id && question.status === 'open')) run.questions.push({ id, question: `Automatic rework reached ${state.max} rounds. Choose whether to continue repairing the remaining issues.`, findingIds: findings.map((finding) => finding.id), options: [{ id: 'continue', label: '继续返工', description: '再允许一轮定向返工。' }, { id: 'pause', label: '保留成果', description: '保留代码和问题，暂停等待处理。' }], sourceExecutionId: findings[0].sourceExecutionId, requirementRevision: run.requirementRevision, status: 'open', category: 'rework-limit' });
    return false;
  }
  state.count++; state.findingIds = findings.map((finding) => finding.id); state.reason = reason;
  const tasks = currentTasks(run); const affected = new Set(findings.flatMap((finding) => finding.taskIds ?? tasks.map((task) => task.id)));
  const sourceTasks = tasks.filter((task) => affected.has(task.id));
  const decisionIds = [...new Set(sourceTasks.flatMap((task) => task.decisionIds))];
  const taskId = `rework-${run.requirementRevision}-${state.count}`;
  run.tasks.push({ id: taskId, decisionIds, findingIds: state.findingIds, objective: `Resolve ${state.findingIds.join(', ')}`, acceptance: findings.map((finding) => `${finding.id}: ${finding.description}`), writeScopes: [...new Set(sourceTasks.flatMap((task) => task.writeScopes))], dependsOn: sourceTasks.map((task) => task.id), workStatus: 'pending', origin: 'rework', requirementRevision: run.requirementRevision, applicability: 'current' });
  for (const stage of ['build:developer', 'verify:verifier']) {
    const execution = run.executions.find((entry) => entry.executionId === run.activeExecutions[stage]);
    if (execution) execution.applicability = 'stale';
    delete run.activeExecutions[stage];
  }
  run.status = 'queued'; run.phase = 'build';
  return true;
}
