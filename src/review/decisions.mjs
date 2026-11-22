import { protocolError, validate, decisionInputSchema } from './schemas.mjs';
export function collectFindings(run, execution) {
  for (const finding of execution.result?.findings ?? []) {
    const id = `${execution.executionId}:${finding.id}`;
    if (run.findings.some((entry) => entry.id === id)) continue;
    const related = run.findings.filter((entry) => entry.description.trim().toLowerCase() === finding.description.trim().toLowerCase());
    run.findings.push({ ...finding, id, sourceExecutionId: execution.executionId, sourceFindingId: finding.id, status: 'open', relatedFindingIds: related.map((entry) => entry.id) });
    for (const entry of related) entry.relatedFindingIds.push(id);
  }
}
export function recordDecision(run, input, owner, sourceExecutionId) {
  validate(decisionInputSchema, input);
  if (!input.reason.trim()) throw protocolError('DECISION_REASON_REQUIRED', input.id);
  const decisionId = `${run.requirementRevision}:${input.id}`;
  if (run.decisions.some((decision) => decision.id === decisionId)) throw protocolError('DUPLICATE_DECISION', input.id);
  for (const id of input.findingIds) if (!run.findings.some((finding) => finding.id === id)) throw protocolError('FINDING_NOT_FOUND', id);
  if (input.choice === 'adopt' && (!input.implementation?.objective.trim() || !input.implementation.acceptance.length || !input.checks.length)) throw protocolError('IMPLEMENTATION_REQUIRED', input.id);
  const taskId = `task-${run.requirementRevision}-${run.tasks.length + 1}`;
  const decision = { id: decisionId, findingIds: input.findingIds, choice: input.choice, reason: input.reason, owner, revision: run.decisionRevision + 1, affectedTaskIds: input.choice === 'adopt' ? [taskId] : [], requirementRevision: run.requirementRevision, ...(sourceExecutionId ? { sourceExecutionId } : {}), checks: input.checks };
  run.decisions.push(decision);
  if (input.choice === 'adopt') run.tasks.push({ id: taskId, decisionIds: [decisionId], ...input.implementation, dependsOn: [], workStatus: 'pending', requirementRevision: run.requirementRevision, applicability: 'current' });
  for (const id of input.findingIds) run.findings.find((finding) => finding.id === id).status = input.choice === 'adopt' ? 'accepted' : input.choice === 'defer' ? 'deferred' : 'resolved';
  return decision;
}
export function applyDecisionResult(run, execution) {
  const result = execution.result;
  if (!result) throw protocolError('DECISION_RESULT_MISSING', execution.executionId);
  const currentFindings = run.findings.filter((finding) => run.executions.some((e) => e.executionId === finding.sourceExecutionId && e.applicability === 'current'));
  const referenced = new Set([...run.decisions.filter((decision) => decision.requirementRevision === run.requirementRevision).flatMap((d) => d.findingIds), ...result.decisions.flatMap((d) => d.findingIds), ...result.questions.flatMap((q) => q.findingIds)]);
  const missing = currentFindings.filter((finding) => !referenced.has(finding.id));
  if (missing.length) throw protocolError('UNHANDLED_FINDINGS', missing.map((finding) => finding.id).join(', '));
  for (const question of result.questions) {
    if (question.options.length < 2 || new Set(question.options.map((option) => option.id)).size !== question.options.length) throw protocolError('INVALID_QUESTION', question.id);
    for (const findingId of question.findingIds) if (!currentFindings.some((finding) => finding.id === findingId)) throw protocolError('FINDING_NOT_FOUND', findingId);
  }
  for (const decision of result.decisions) recordDecision(run, decision, execution.childSessionId ?? execution.executionId, execution.executionId);
  run.decisionRevision++;
  const answered = run.questions.filter((question) => question.status === 'answered');
  run.questions = [...answered, ...result.questions.map((question) => ({ ...question, sourceExecutionId: execution.executionId, requirementRevision: run.requirementRevision, status: 'open' }))];
  run.summary = result.summary;
  if (run.questions.some((question) => question.status === 'open')) run.status = 'waiting_user';
}
