import { slotKey } from './state.mjs';
export function currentExecution(run, stageId, role) {
  const id = run.activeExecutions[slotKey(stageId, role)];
  return run.executions.find((execution) => execution.executionId === id && execution.applicability === 'current');
}
export function nextWork(run, preset) {
  for (const stage of preset.stages) {
    if (stage.id === 'report') return { stage, roles: [] };
    const roles = stage.roles.filter((role) => {
      const execution = currentExecution(run, stage.id, role);
      return !execution || (execution.workStatus !== 'completed' && !(stage.id === 'review' && execution.workStatus === 'error'));
    });
    if (roles.length) return { stage, roles };
    if (stage.id === 'review' && stage.roles.every((role) => currentExecution(run, 'review', role)?.workStatus === 'error') && !run.questions.some((question) => question.id === 'review-unavailable' && question.status === 'answered' && question.answer === 'continue')) return { degraded: true };
    if (stage.id === 'intake') {
      const execution = currentExecution(run, 'intake', 'lead');
      if (execution?.result?.questions?.length && run.questions.some((q) => q.status === 'open')) return { waiting: true };
    }
    if (stage.id === 'decide' && run.questions.some((q) => q.status === 'open')) return { waiting: true };
  }
  return { done: true };
}
/** Sequential stages; independent reviewers settle separately within one stage. */
export async function driveReview({ load, preset, execute, report, checkpoint, onDevelop, onVerify, onReviewUnavailable }) {
  while (true) {
    const run = await load();
    if (['cancelled', 'paused', 'completed', 'error', 'waiting_user'].includes(run.status)) return;
    if (run.pauseRequested) { await checkpoint('paused'); return; }
    const work = nextWork(run, preset);
    if (work.degraded) { await onReviewUnavailable(); return; }
    if (work.waiting) { await checkpoint('waiting_user'); return; }
    if (work.done || work.stage.id === 'report') { await report(); return; }
    if (work.stage.id === 'build') { await onDevelop(); continue; }
    if (work.stage.id === 'verify') { await onVerify(); continue; }
    const settled = await Promise.allSettled(work.roles.map((role) => execute(work.stage.id, role)));
    const failure = settled.find((entry) => entry.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
