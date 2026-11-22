import { protocolError } from './schemas.mjs';
import { currentTasks, globMatches } from './checks.mjs';
export function applyImpactRevision(run, change) {
  const impact = { decisionIds: [], taskIds: [], checkIds: [], paths: [], review: 'reuse', ...change.impact };
  const tasks = currentTasks(run);
  const decisions = run.decisions.filter((decision) => decision.requirementRevision === run.requirementRevision || decision.reusedForRevision === run.requirementRevision);
  for (const id of impact.decisionIds) if (!decisions.some((decision) => decision.id === id)) throw protocolError('DECISION_NOT_FOUND', id);
  for (const id of impact.taskIds) if (!tasks.some((task) => task.id === id)) throw protocolError('TASK_NOT_FOUND', id);
  const checks = run.checkConfig?.checks ?? run.configuredChecks ?? [];
  for (const id of impact.checkIds) if (!checks.some((check) => check.id === id)) throw protocolError('CHECK_NOT_FOUND', id);
  const affected = new Set(impact.taskIds);
  for (const task of tasks) if (task.decisionIds.some((id) => impact.decisionIds.includes(id)) || task.writeScopes.some((scope) => impact.paths.some((file) => globMatches(file, scope) || globMatches(scope, file)))) affected.add(task.id);
  let previous;
  do { previous = affected.size; for (const task of tasks) if (task.dependsOn.some((id) => affected.has(id))) affected.add(task.id); } while (previous !== affected.size);
  if (impact.review === 'reuse' && affected.size === 0 && impact.checkIds.length === 0) throw protocolError('EMPTY_REVISION_IMPACT', 'Specify affected tasks, decisions, paths or checks');
  const fromRevision = run.requirementRevision;
  run.requirementRevision++; run.requirement = change.requirement; run.diagnostic = change.reason;
  run.revisionImpact = { ...impact, affectedTaskIds: [...affected], fromRevision, toRevision: run.requirementRevision, reason: change.reason };
  for (const decision of decisions) decision.reusedForRevision = run.requirementRevision;
  for (const task of tasks) {
    task.reusedForRevision = run.requirementRevision;
    if (affected.has(task.id)) task.workStatus = 'pending';
  }
  for (const execution of run.executions.filter((entry) => entry.applicability === 'current')) {
    const rerun = impact.review === 'rerun' || ['build', 'verify'].includes(execution.stageId) && (affected.size > 0 || execution.stageId === 'verify');
    if (rerun) { execution.applicability = 'stale'; delete run.activeExecutions[`${execution.stageId}:${execution.role}`]; }
    else execution.reusedForRevision = run.requirementRevision;
  }
  if (impact.review === 'rerun') {
    for (const decision of decisions) decision.applicability = 'stale';
    for (const task of tasks) task.applicability = 'stale';
  }
  for (const artifact of run.artifacts) if (run.executions.find((entry) => entry.executionId === artifact.executionId)?.applicability === 'stale') artifact.applicability = 'stale';
  for (const finding of run.findings) {
    if (impact.review === 'rerun' || finding.taskIds?.some((id) => affected.has(id))) finding.applicability = 'stale';
  }
  const affectedChecks = new Set(impact.checkIds);
  for (const check of checks) if (check.taskIds?.some((id) => affected.has(id)) || !check.inputs?.length || check.inputs.some((pattern) => impact.paths.some((file) => globMatches(file, pattern)))) affectedChecks.add(check.id);
  for (const result of run.checkResults) {
    if (affectedChecks.has(result.checkId) || impact.review === 'rerun') result.applicability = 'stale';
    else { result.reusedFromRevision ??= result.requirementRevision; result.requirementRevision = run.requirementRevision; }
  }
  run.questions = []; run.status = 'paused'; run.pauseRequested = false; run.phase = impact.review === 'rerun' ? 'intake' : affected.size ? 'build' : 'verify';
  if (run.rework) { run.rework.count = 0; run.rework.findingIds = []; }
  return { requirementRevision: run.requirementRevision, affectedTaskIds: [...affected], affectedCheckIds: [...affectedChecks] };
}
