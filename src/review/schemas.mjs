import { Ajv } from 'ajv';

export const SCHEMA_VERSION = 1;
export const RUN_STATUSES = ['queued', 'running', 'waiting_user', 'paused', 'completed', 'cancelled', 'error'];
export const WORK_STATUSES = ['pending', 'running', 'completed', 'interrupted', 'error', 'cancelled'];
export const REVIEW_DECISIONS = ['accept', 'needs_revision', 'reject', 'abstain'];
export const CHECK_OUTCOMES = ['passed', 'failed', 'unknown', 'skipped'];
export const APPLICABILITIES = ['current', 'stale'];
const string = { type: 'string' };
const integer = { type: 'integer' };
export const array = (items) => ({ type: 'array', items });
export const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const strings = array(string);
const enumeration = (values) => ({ type: 'string', enum: values });
const record = { type: 'object', additionalProperties: true };
export const materialSchema = object({ name: string, content: string, source: string }, ['name', 'content']);
export const findingInputSchema = object({ id: string, severity: enumeration(['low', 'medium', 'high', 'critical']), description: string, basis: string, taskIds: strings }, ['id', 'severity', 'description', 'basis']);
export const implementationSchema = object({ objective: string, acceptance: strings, writeScopes: strings });
export const decisionInputSchema = object({ id: string, findingIds: strings, choice: enumeration(['adopt', 'defer', 'alternative', 'dismiss']), reason: string, implementation: implementationSchema, checks: strings }, ['id', 'findingIds', 'choice', 'reason', 'checks']);
const commandIdSchema = { type: 'string', description: '非空命令 slug：以英文字母或数字开头，其余仅英文字母、数字、下划线、连字符，例如 timeout-behavior、Q-1；不含空白。' };
export const questionSchema = object({ id: commandIdSchema, question: string, options: array(object({ id: commandIdSchema, label: string, description: string })), findingIds: strings }, ['id', 'question', 'options', 'findingIds']);
export const checkSpecSchema = object({ id: string, kind: enumeration(['command', 'test']), phase: enumeration(['plan', 'implementation', 'delivery']), required: { type: 'boolean' }, argv: strings, cwd: string, timeoutMs: integer, parser: enumeration(['exit-code', 'node-test']), inputs: strings, outputs: strings, taskIds: strings, onlyNewFailures: { type: 'boolean' } }, ['id', 'argv']);
export const referenceSchema = object({ target: string, kind: enumeration(['existing', 'planned']), symbol: string }, ['target', 'kind']);
export const projectConfigSchema = object({ schemaVersion: { type: 'integer', const: 1 }, checks: array(checkSpecSchema), references: array(referenceSchema), maxReworks: integer }, ['schemaVersion', 'checks']);
const resolvedVerificationIds = { ...strings, description: '仅填输入pendingVerificationFindingIds中已修复的完整ID（origin=verification）；初始review意见由decisions/tasks验收。列表为空填[]。' };
export const roleResultSchemas = {
  intake: object({ summary: string, acceptance: strings, questions: array(questionSchema) }),
  review: object({ decision: enumeration(REVIEW_DECISIONS), summary: string, findings: array(findingInputSchema), risks: strings, tests: strings }),
  decide: object({ summary: string, decisions: array(decisionInputSchema), questions: array(questionSchema) }),
  build: object({ summary: string, changed: strings, completedTaskIds: strings, resolvedFindingIds: resolvedVerificationIds }, ['summary', 'changed', 'completedTaskIds']),
  verify: object({ decision: enumeration(REVIEW_DECISIONS), summary: string, findings: array(findingInputSchema), risks: strings, tests: strings, resolvedFindingIds: resolvedVerificationIds }, ['decision', 'summary', 'findings', 'risks', 'tests']),
  report: object({ summary: string }),
};
export const envelopeSchema = object({ schemaVersion: { type: 'integer', const: 1 }, executionId: string, requirementRevision: integer, decisionRevision: integer, inputFingerprint: string, kind: enumeration(Object.keys(roleResultSchemas)), result: record });
export function outputSchema(kind) {
  if (!roleResultSchemas[kind]) throw protocolError('INVALID_KIND', kind);
  return { ...envelopeSchema, properties: { ...envelopeSchema.properties, kind: { type: 'string', const: kind }, result: roleResultSchemas[kind] } };
}
export const executionSchema = object({
  executionId: string, stageId: string, role: string, attempt: integer, inputRevision: integer,
  requirementRevision: integer, decisionRevision: integer, inputFingerprint: string,
  workStatus: enumeration(WORK_STATUSES), applicability: enumeration(APPLICABILITIES),
  childSessionId: string, acceptedMessageId: string, resultRef: string, rawResultRef: string, result: record,
  reviewDecision: enumeration(REVIEW_DECISIONS), diagnostic: string, startedAt: string, endedAt: string, provider: string, processed: { type: 'boolean' }, codeFingerprint: string, reusedForRevision: integer,
}, ['executionId', 'stageId', 'role', 'attempt', 'inputRevision', 'requirementRevision', 'decisionRevision', 'inputFingerprint', 'workStatus', 'applicability', 'startedAt']);
export const findingSchema = object({ id: string, sourceExecutionId: string, sourceFindingId: string, severity: string, description: string, basis: string, status: string, relatedFindingIds: strings, origin: string, checkId: string, taskIds: strings, requirementRevision: integer, applicability: enumeration(APPLICABILITIES), resolvedByExecutionId: string }, ['id', 'sourceExecutionId', 'sourceFindingId', 'severity', 'description', 'basis', 'status', 'relatedFindingIds']);
export const decisionSchema = object({ id: string, findingIds: strings, choice: enumeration(['adopt', 'defer', 'alternative', 'dismiss']), reason: string, owner: string, revision: integer, affectedTaskIds: strings, requirementRevision: integer, sourceExecutionId: string, checks: strings, applicability: enumeration(APPLICABILITIES), reusedForRevision: integer }, ['id', 'findingIds', 'choice', 'reason', 'owner', 'revision', 'affectedTaskIds', 'requirementRevision', 'checks']);
export const taskSchema = object({ id: string, decisionIds: strings, objective: string, acceptance: strings, writeScopes: strings, dependsOn: strings, workStatus: enumeration(WORK_STATUSES), findingIds: strings, origin: string, requirementRevision: integer, applicability: enumeration(APPLICABILITIES), reusedForRevision: integer }, ['id', 'decisionIds', 'objective', 'acceptance', 'writeScopes', 'dependsOn', 'workStatus']);
export const runSchema = object({
  schemaVersion: { type: 'integer', const: 1 }, runId: string, requestId: string, requestDigest: string, preset: string,
  mode: enumeration(['review', 'develop']), rootSessionId: string, projectRoot: string, requirement: string,
  materials: array(materialSchema), requirementRevision: integer, decisionRevision: integer, revision: integer,
  status: enumeration(RUN_STATUSES), phase: string, pauseRequested: { type: 'boolean' }, resumeWhenRootAvailable: { type: 'boolean' }, activeExecutions: record,
  executions: array(executionSchema), artifacts: array(record), findings: array(findingSchema), decisions: array(decisionSchema),
  tasks: array(taskSchema), checks: array(record), checkResults: array(record), operations: array(record), history: array(record),
  notifications: array(record), questions: array(record), createdAt: string, updatedAt: string, reportRef: string, summary: string, diagnostic: string, configuredChecks: array(checkSpecSchema), workspace: record, checkConfig: record, rework: record, revisionImpact: record, provenance: record,
}, ['schemaVersion', 'runId', 'requestId', 'requestDigest', 'preset', 'mode', 'rootSessionId', 'projectRoot', 'requirement', 'materials', 'requirementRevision', 'decisionRevision', 'revision', 'status', 'phase', 'pauseRequested', 'activeExecutions', 'executions', 'artifacts', 'findings', 'decisions', 'tasks', 'checks', 'checkResults', 'operations', 'history', 'notifications', 'questions', 'createdAt', 'updatedAt']);
export const startSchema = object({ requestId: { ...string, description: '同一启动请求重复使用同一个 ID。' }, requirement: string, preset: enumeration(['quick@2', 'standard@2']), mode: enumeration(['review', 'develop']), materials: array(materialSchema), checks: array(checkSpecSchema) }, ['requestId', 'requirement']);
export const statusSchema = object({ runId: string });
export const controlSchema = object({ runId: string, action: enumeration(['pause', 'resume', 'stop', 'cancel', 'retry']), operationId: string, expectedRevision: integer }, ['runId', 'action', 'operationId']);
export const readSchema = object({ runId: string, section: enumeration(['run', 'executions', 'findings', 'decisions', 'tasks', 'checks', 'checkSpecs', 'checkResults', 'usage', 'history', 'questions', 'report', 'artifact', 'diagnostics']), id: string, cursor: integer }, ['runId', 'section']);
export const impactSchema = object({ decisionIds: strings, taskIds: strings, checkIds: strings, paths: strings, review: enumeration(['reuse', 'rerun']) }, []);
export const reviseSchema = object({ runId: string, operationId: string, expectedRevision: integer, requirement: string, reason: string, impact: impactSchema }, ['runId', 'operationId', 'requirement', 'reason']);
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map();
export function protocolError(code, message, details = undefined) {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}
export function validate(schema, value) {
  let validator = validators.get(schema);
  if (!validator) { validator = ajv.compile(schema); validators.set(schema, validator); }
  if (!validator(value)) throw protocolError('INVALID_STRUCTURE', ajv.errorsText(validator.errors), validator.errors);
  return value;
}
export function validateEnvelope(value) {
  validate(envelopeSchema, value);
  validate(roleResultSchemas[value.kind], value.result);
  for (const field of ['requirementRevision', 'decisionRevision']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < (field === 'requirementRevision' ? 1 : 0)) throw protocolError('INVALID_VERSION', field);
  }
  if (!value.executionId.trim() || !value.inputFingerprint.trim()) throw protocolError('INVALID_ID', 'executionId/inputFingerprint');
  for (const list of [value.result.findings, value.result.decisions, value.result.questions].filter(Array.isArray)) {
    if (new Set(list.map((item) => item.id)).size !== list.length || list.some((item) => !item.id.trim())) throw protocolError('DUPLICATE_RESULT_ID', value.kind);
  }
  for (const question of value.result.questions ?? []) {
    for (const id of [question.id, ...question.options.map((option) => option.id)]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw protocolError('INVALID_COMMAND_ID', `Question/option id must be a nonempty command slug: ${JSON.stringify(id)}`);
    }
    if (question.options.length < 2 || new Set(question.options.map((option) => option.id)).size !== question.options.length || !question.question.trim()) throw protocolError('INVALID_QUESTION', question.id);
  }
  return value;
}
export function validateRun(value) {
  validate(runSchema, value);
  for (const field of ['revision', 'decisionRevision', 'requirementRevision']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < (field === 'requirementRevision' ? 1 : 0)) throw protocolError('INVALID_VERSION', field);
  }
  const ids = value.executions.map((e) => e.executionId);
  if (new Set(ids).size !== ids.length) throw protocolError('DUPLICATE_EXECUTION', 'executionId');
  for (const execution of value.executions) {
    if (!Number.isSafeInteger(execution.attempt) || execution.attempt < 1) throw protocolError('INVALID_ATTEMPT', execution.executionId);
  }
  return value;
}
