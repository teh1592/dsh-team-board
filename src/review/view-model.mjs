const LIMIT = 100;
const text = (value, max = 1200) => typeof value === 'string' ? value.slice(0, max) : 'unknown';
export function reviewViewModel(run, section = 'run', page = {}) {
  if (!run || typeof run !== 'object') return { state: 'empty', rows: [], nextCursor: null };
  const list = Array.isArray(page.items) ? page.items : [];
  const rows = list.slice(0, LIMIT).map((item, index) => reviewRow(item, section, (page.cursor ?? 0) + index));
  return { state: 'ready', runId: text(run.runId, 180), revision: Number.isSafeInteger(run.revision) ? run.revision : null, requirementRevision: Number.isSafeInteger(run.requirementRevision) ? run.requirementRevision : null, status: text(run.status, 80), phase: text(run.phase, 80), mode: text(run.mode, 40), preset: text(run.preset, 80), summary: text(run.summary, 1600), diagnostic: typeof run.diagnostic === 'string' ? run.diagnostic.slice(0, 2000) : null, requirement: text(run.requirement, 60000), provenance: run.provenance ?? null, pending: Array.isArray(run.pending) ? run.pending.slice(0, 30) : [], section, rows, content: typeof page.content === 'string' ? page.content : null, nextCursor: Number.isSafeInteger(page.nextCursor) ? page.nextCursor : null, total: Number.isSafeInteger(page.total) ? page.total : null, truncated: list.length > LIMIT || page.truncated === true, usage: run.usage ?? null };
}
const strings = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
/** Explicit projection: links never depend on truncated JSON or a title match. */
export function reviewRow(item, section, index = 0) {
  const refs = [];
  const add = (target, ids) => { for (const id of strings(ids)) if (!refs.some((ref) => ref.section === target && ref.id === id)) refs.push({ section: target, id }); };
  add('findings', item.findingIds); add('findings', item.relatedFindingIds);
  add('decisions', item.decisionIds); add('tasks', item.affectedTaskIds); add('tasks', item.dependsOn); add('tasks', item.taskIds);
  if (item.sourceExecutionId) add(item.origin === 'machine' ? 'checkResults' : 'executions', [item.sourceExecutionId]);
  if (item.resolvedByExecutionId) add(item.origin === 'machine' ? 'checkResults' : 'executions', [item.resolvedByExecutionId]);
  if (item.executionId && !['executions', 'checkResults'].includes(section)) add('executions', [item.executionId]);
  if (section === 'checkResults' && item.checkId) add('checkSpecs', [item.checkId]);
  const recordId = item.id ?? item.executionId ?? null;
  const identity = recordId ?? `${item.checkId ?? section}:${item.executionId ?? item.commandId ?? item.startedAt ?? index}`;
  return {
    id: text(recordId ?? item.checkId, 180), key: section === 'artifacts' ? `${identity}:${item.digest ?? item.resultRef ?? index}` : String(identity), recordId, section,
    title: text(item.objective ?? item.description ?? item.result?.summary ?? item.reason ?? item.summary ?? item.question ?? item.role ?? item.id ?? item.checkId, 1200),
    status: text(item.workStatus ?? item.status ?? item.outcome ?? item.choice, 80),
    applicability: text(item.applicability ?? (item.imported ? 'imported' : undefined), 40),
    role: item.role ?? item.owner ?? '', stageId: item.stageId ?? '', attempt: item.attempt ?? null,
    requirementRevision: item.requirementRevision ?? null, decisionRevision: item.decisionRevision ?? item.revision ?? null,
    reviewDecision: item.reviewDecision ?? item.result?.decision ?? null, basis: item.basis ?? '',
    acceptance: strings(item.acceptance), scopes: strings(item.writeScopes), refs,
    get detail() { return JSON.stringify(item, null, 2); }, raw: item,
    logRef: typeof item.logRef === 'string' ? item.logRef : null,
    resultRef: typeof item.resultRef === 'string' ? item.resultRef : null,
  };
}
/** Only join explicit IDs in the pages already read. No all-run graph or guessed relations. */
export function discussionView(findings = [], decisions = [], tasks = []) {
  const current = (entry) => entry.applicability !== 'stale';
  const issues = findings.filter(current).map((finding) => {
    const linked = decisions.filter((decision) => current(decision) && strings(decision.findingIds).includes(finding.id));
    return { finding: reviewRow(finding, 'findings'), decisions: linked.map((decision) => ({ decision: reviewRow(decision, 'decisions'), tasks: tasks.filter((task) => current(task) && strings(task.decisionIds).includes(decision.id)).map((task) => reviewRow(task, 'tasks')) })) };
  });
  const visibleFindingIds = new Set(findings.filter(current).map((entry) => entry.id));
  return { issues, otherDecisions: decisions.filter((decision) => current(decision) && !strings(decision.findingIds).some((id) => visibleFindingIds.has(id))).map((entry) => reviewRow(entry, 'decisions')) };
}
export function roleLedgerMessageKey(ledger) {
  if (ledger?.status === 'ok') return null;
  if (ledger?.status === 'empty') return 'ledger.empty';
  if (ledger?.status === 'disabled') return 'source.disabledHint';
  return 'ledger.unavailable';
}
export const boardTabs = ['overview', 'discussion', 'tasks', 'results'];
export function reviewControls(run) {
  const status = run?.status; const terminal = ['completed', 'cancelled'].includes(status);
  const questions = (run?.pending ?? []).some((question) => question.status === 'open');
  return { pause: ['running', 'queued'].includes(status), stop: ['running', 'queued', 'waiting_user', 'error'].includes(status), resume: status === 'paused' && !questions, retry: ['paused', 'error'].includes(status) && !questions, cancel: Boolean(status) && !terminal };
}
export function createReviewRequestGate() {
  let generation = 0; let current;
  return { begin(key) { current?.controller.abort(); const token = { key, generation: ++generation, controller: new AbortController() }; current = token; return token; }, accepts(token) { return current === token && !token.controller.signal.aborted; }, cancel() { current?.controller.abort(); current = undefined; generation++; } };
}
export function decodeReviewResponse(envelope) {
  if (!envelope?.ok) throw new Error(envelope?.error?.message ?? 'Review request failed');
  const execution = envelope.value;
  if (execution?.result?.kind !== 'success') throw new Error(execution?.result?.text ?? 'Review command did not succeed');
  try { return JSON.parse(execution.result.text); } catch { throw new Error('Review command returned invalid JSON'); }
}
