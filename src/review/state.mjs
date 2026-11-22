import { createHash } from 'node:crypto';
import { protocolError, validateRun, validateEnvelope } from './schemas.mjs';

export function stableJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
export const fingerprint = (value) => createHash('sha256').update(stableJson(value)).digest('hex');
export const slotKey = (stageId, role) => `${stageId}:${role}`;

/** @returns {import('./types.js').Run} */
export function createRun(request, now = new Date().toISOString()) {
  return validateRun({
    schemaVersion: 1, runId: request.runId, requestId: request.requestId, requestDigest: request.requestDigest,
    preset: request.preset ?? 'standard@2', mode: request.mode ?? 'review', rootSessionId: request.rootSessionId,
    projectRoot: request.projectRoot, requirement: request.requirement, materials: request.materials ?? [], ...(request.checks ? { configuredChecks: request.checks } : {}),
    requirementRevision: 1, decisionRevision: 0, revision: 0, status: 'queued', phase: 'intake', pauseRequested: false,
    activeExecutions: {}, executions: [], artifacts: [], findings: [], decisions: [], tasks: [], checks: [], checkResults: [],
    operations: [], history: [], notifications: [], questions: [], createdAt: now, updatedAt: now,
    ...(request.provenance ? { provenance: { ...request.provenance, importedAt: now } } : {}),
  });
}

/** Idempotency is checked before revision so a repeated accepted request can replay. */
export function applyOperation(current, expectedRevision, operation, now = new Date().toISOString()) {
  if (typeof operation.operationId !== 'string' || !operation.operationId.trim()) throw protocolError('INVALID_OPERATION', 'operationId');
  const requestDigest = fingerprint(operation.request);
  const previous = current.operations.find((op) => op.operationId === operation.operationId);
  if (previous) {
    if (previous.requestDigest !== requestDigest) throw protocolError('OPERATION_CONFLICT', operation.operationId);
    return { run: structuredClone(current), result: structuredClone(previous.result), replayed: true };
  }
  if (expectedRevision !== undefined && current.revision !== expectedRevision) throw protocolError('REVISION_CONFLICT', `expected ${expectedRevision}, current ${current.revision}`, { currentRevision: current.revision });
  const run = structuredClone(current);
  const result = operation.apply(run) ?? null;
  run.revision++;
  run.updatedAt = now;
  run.operations.push({ operationId: operation.operationId, requestDigest, expectedRevision: expectedRevision ?? null, revision: run.revision, result: structuredClone(result) });
  run.history.push({ revision: run.revision, operationId: operation.operationId, at: now });
  validateRun(run);
  return { run, result, replayed: false };
}

export function beginExecution(run, spec, now = new Date().toISOString()) {
  const key = slotKey(spec.stageId, spec.role);
  const previous = run.executions.filter((e) => e.stageId === spec.stageId && e.role === spec.role);
  if (previous.some((e) => e.workStatus === 'running')) throw protocolError('EXECUTION_ACTIVE', key);
  if (run.executions.some((e) => e.executionId === spec.executionId)) throw protocolError('DUPLICATE_EXECUTION', spec.executionId);
  const execution = {
    executionId: spec.executionId, stageId: spec.stageId, role: spec.role,
    attempt: previous.length ? Math.max(...previous.map((e) => e.attempt)) + 1 : 1,
    inputRevision: run.revision, requirementRevision: run.requirementRevision, decisionRevision: run.decisionRevision,
    inputFingerprint: spec.inputFingerprint, workStatus: 'running', applicability: 'current', startedAt: now,
  };
  run.executions.push(execution);
  run.activeExecutions[key] = execution.executionId;
  run.status = 'running';
  run.phase = spec.stageId;
  return execution;
}
export function resultApplicability(run, execution, envelope) {
  return run.status !== 'cancelled' && execution.workStatus !== 'cancelled' && execution.applicability === 'current'
    && run.activeExecutions[slotKey(execution.stageId, execution.role)] === envelope.executionId
    && run.requirementRevision === envelope.requirementRevision && run.decisionRevision === envelope.decisionRevision
    && execution.requirementRevision === envelope.requirementRevision && execution.decisionRevision === envelope.decisionRevision
    && execution.inputFingerprint === envelope.inputFingerprint ? 'current' : 'stale';
}
export function acceptResult(run, envelope, resultRef, now = new Date().toISOString()) {
  validateEnvelope(envelope);
  const execution = run.executions.find((e) => e.executionId === envelope.executionId);
  if (!execution) throw protocolError('EXECUTION_NOT_FOUND', envelope.executionId);
  if (execution.stageId !== envelope.kind) throw protocolError('RESULT_KIND_MISMATCH', envelope.kind);
  const digest = fingerprint(envelope);
  const completedArtifact = run.artifacts.find((artifact) => artifact.executionId === execution.executionId && artifact.applicability === 'current');
  const applicability = execution.workStatus === 'completed' && completedArtifact && completedArtifact.digest !== digest ? 'stale' : resultApplicability(run, execution, envelope);
  const prior = run.artifacts.find((a) => a.executionId === envelope.executionId && a.digest === digest);
  if (prior) return { executionId: execution.executionId, applicability: prior.applicability, duplicate: true };
  run.artifacts.push({ executionId: execution.executionId, resultRef, digest, applicability, receivedAt: now, requirementRevision: envelope.requirementRevision, decisionRevision: envelope.decisionRevision });
  // First applicable completion wins; conflicting later output remains available as an archived result.
  if (applicability === 'current' && execution.workStatus !== 'completed') {
    execution.workStatus = 'completed'; execution.result = envelope.result; execution.resultRef = resultRef; execution.endedAt = now;
    if (envelope.result.decision) execution.reviewDecision = envelope.result.decision;
  } else if (applicability === 'stale' && execution.workStatus === 'running') {
    execution.workStatus = 'interrupted'; execution.applicability = 'stale'; execution.endedAt = now;
  }
  return { executionId: execution.executionId, applicability, duplicate: false };
}
export function invalidate(run, reason) {
  run.requirementRevision++;
  for (const execution of run.executions) execution.applicability = 'stale';
  for (const artifact of run.artifacts) artifact.applicability = 'stale';
  for (const check of run.checkResults) check.applicability = 'stale';
  run.activeExecutions = {}; run.questions = []; run.phase = 'intake'; run.status = 'paused'; run.pauseRequested = false;
  if (run.rework) { run.rework.count = 0; run.rework.findingIds = []; delete run.rework.reason; delete run.rework.userContinuation; }
  run.diagnostic = reason;
}
