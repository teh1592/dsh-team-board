import { protocolError } from './schemas.mjs';
import { currentDecisions, currentTasks, globMatches } from './checks.mjs';
export function applyImpactRevision(run, change) {
  const impact = { decisionIds: [], taskIds: [], checkIds: [], paths: [], review: 'reuse', ...change.impact };
  const tasks = currentTasks(run);
  const decisions = currentDecisions(run);
  const reviseDecision = impact.decisionIds.length > 0;
  for (const id of impact.decisionIds) if (!decisions.some((decision) => decision.id === id)) throw protocolError('DECISION_NOT_FOUND', id);
  for (const id of impact.taskIds) if (!tasks.some((task) => task.id === id)) throw protocolError('TASK_NOT_FOUND', id);
  const checks = run.checkConfig?.checks ?? run.configuredChecks ?? [];
  for (const id of impact.checkIds) if (!checks.some((check) => check.id === id)) throw protocolError('CHECK_NOT_FOUND', id);
  const affected = new Set(impact.taskIds);
  for (const task of tasks) if (task.decisionIds.some((id) => impact.decisionIds.includes(id)) || task.writeScopes.some((scope) => impact.paths.some((file) => globMatches(file, scope) || globMatches(scope, file)))) affected.add(task.id);
  // Keep dependent tasks and every task governed by their old decisions together.
  const staleDecisionIds = new Set(impact.decisionIds);
  let previous;
  do {
    previous = affected.size + staleDecisionIds.size;
    for (const task of tasks) {
      if (task.dependsOn.some((id) => affected.has(id)) || reviseDecision && task.decisionIds.some((id) => staleDecisionIds.has(id))) affected.add(task.id);
      if (reviseDecision && affected.has(task.id)) for (const id of task.decisionIds) staleDecisionIds.add(id);
    }
  } while (previous !== affected.size + staleDecisionIds.size);
  if (impact.review === 'reuse' && !reviseDecision && affected.size === 0 && impact.checkIds.length === 0) throw protocolError('EMPTY_REVISION_IMPACT', 'Specify affected tasks, decisions, paths or checks');
  const affectedFindingIds = new Set(decisions.filter((decision) => staleDecisionIds.has(decision.id)).flatMap((decision) => decision.findingIds));
  for (const decision of decisions) if (decision.owner.startsWith('user:') && decision.findingIds.some((id) => affectedFindingIds.has(id))) staleDecisionIds.add(decision.id);
  const fromRevision = run.requirementRevision;
  run.requirementRevision++; run.requirement = change.requirement; run.diagnostic = change.reason;
  const pending = impact.review === 'reuse' ? run.revisionImpact : null;
  const pendingDecisionIds = [...new Set([...(pending?.pendingDecisionIds ?? []), ...(reviseDecision ? staleDecisionIds : [])])];
  const pendingTaskIds = [...new Set([...(pending?.pendingTaskIds ?? []), ...(reviseDecision ? affected : [])])];
  run.revisionImpact = { ...impact, affectedTaskIds: [...affected], fromRevision, toRevision: run.requirementRevision, reason: change.reason, pendingDecisionIds, pendingTaskIds };
  for (const decision of decisions) {
    if (staleDecisionIds.has(decision.id)) { decision.applicability = 'stale'; delete decision.reusedForRevision; }
    else decision.reusedForRevision = run.requirementRevision;
  }
  for (const task of tasks) {
    if (reviseDecision && affected.has(task.id)) { task.applicability = 'stale'; delete task.reusedForRevision; }
    else { task.reusedForRevision = run.requirementRevision; if (affected.has(task.id)) task.workStatus = 'pending'; }
  }
  for (const execution of run.executions.filter((entry) => entry.applicability === 'current')) {
    const rerun = impact.review === 'rerun' || reviseDecision && ['decide', 'build', 'verify', 'report'].includes(execution.stageId) || ['build', 'verify'].includes(execution.stageId) && (affected.size > 0 || execution.stageId === 'verify');
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
  for (const question of run.questions.filter((entry) => entry.applicability !== 'stale')) {
    const source = run.executions.find((entry) => entry.executionId === question.sourceExecutionId);
    const stale = impact.review === 'rerun' || question.category === 'rework-limit' && Boolean(run.rework) || reviseDecision && (question.findingIds.some((id) => affectedFindingIds.has(id)) || (question.status === 'open' || !question.findingIds.length) && source?.applicability === 'stale');
    if (stale) {
      question.applicability = 'stale'; if (question.status === 'open') question.status = 'superseded'; delete question.reusedForRevision;
      for (const decision of decisions) if (decision.owner.startsWith('user:') && decision.id === `${decision.requirementRevision}:user-${question.id}-${question.sourceExecutionId}` && decision.sourceExecutionId === question.sourceExecutionId) { decision.applicability = 'stale'; delete decision.reusedForRevision; }
    }
    else question.reusedForRevision = run.requirementRevision;
  }
  delete run.reportRef; if (reviseDecision || impact.review === 'rerun') delete run.summary;
  run.status = 'paused'; run.pauseRequested = false; run.phase = impact.review === 'rerun' ? 'intake' : pendingDecisionIds.length ? 'decide' : run.mode === 'review' ? 'report' : affected.size ? 'build' : 'verify';
  if (run.rework) { run.rework.count = 0; run.rework.findingIds = []; }
  return { requirementRevision: run.requirementRevision, affectedTaskIds: [...affected], affectedCheckIds: [...affectedChecks] };
}
