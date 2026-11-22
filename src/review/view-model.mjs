const LIMIT = 100;
const text = (value, max = 1200) => typeof value === 'string' ? value.slice(0, max) : 'unknown';
export function reviewViewModel(run, section = 'run', page = {}) {
  if (!run || typeof run !== 'object') return { state: 'empty', rows: [], nextCursor: null };
  const list = Array.isArray(page.items) ? page.items : [];
  const rows = list.slice(0, LIMIT).map((item) => ({ id: text(item.id ?? item.executionId ?? item.checkId, 180), title: text(item.objective ?? item.description ?? item.summary ?? item.role ?? item.id ?? item.checkId, 1200), status: text(item.workStatus ?? item.status ?? item.outcome ?? item.choice, 80), applicability: text(item.applicability ?? (item.imported ? 'imported' : undefined), 40), detail: JSON.stringify(item, null, 2).slice(0, 18000), logRef: typeof item.logRef === 'string' ? item.logRef : null, resultRef: typeof item.resultRef === 'string' ? item.resultRef : null }));
  return { state: 'ready', runId: text(run.runId, 180), revision: Number.isSafeInteger(run.revision) ? run.revision : null, requirementRevision: Number.isSafeInteger(run.requirementRevision) ? run.requirementRevision : null, status: text(run.status, 80), phase: text(run.phase, 80), mode: text(run.mode, 40), preset: text(run.preset, 80), summary: text(run.summary, 1600), diagnostic: typeof run.diagnostic === 'string' ? run.diagnostic.slice(0, 2000) : null, requirement: text(run.requirement, 60000), provenance: run.provenance ?? null, pending: Array.isArray(run.pending) ? run.pending.slice(0, 30) : [], section, rows, content: typeof page.content === 'string' ? page.content : null, nextCursor: Number.isSafeInteger(page.nextCursor) ? page.nextCursor : null, total: Number.isSafeInteger(page.total) ? page.total : null, truncated: list.length > LIMIT || page.truncated === true, usage: run.usage ?? null };
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
