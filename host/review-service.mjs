import { randomUUID } from 'node:crypto';
import { createRun, fingerprint, beginExecution, acceptResult, invalidate } from '../src/review/state.mjs';
import { protocolError, validate, startSchema, validateEnvelope } from '../src/review/schemas.mjs';
import { loadReviewPreset } from '../src/review/preset.mjs';
import { buildExecutionSpec } from '../src/review/inputs.mjs';
import { collectFindings, applyDecisionResult, recordDecision } from '../src/review/decisions.mjs';
import { driveReview } from '../src/review/runner.mjs';
import { runSummary, renderReport } from '../src/review/report.mjs';
import { decodeAgentResult } from './dsh/agent-runner.mjs';
import { DevelopController } from './develop-controller.mjs';
import { currentTasks } from '../src/review/checks.mjs';
import { recordVerification, implementationFindings, scheduleRework } from '../src/review/rework.mjs';
import { applyImpactRevision } from '../src/review/revisions.mjs';
import { usageSummary } from '../src/review/usage.mjs';

export class ReviewService {
  constructor({ store, agentRunner, notifier, commandRunner, projectFiles, isRootOnline = (_rootSessionId) => true, stageTimeoutMs = 1200000 }) {
    this.store = store; this.agentRunner = agentRunner; this.notifier = notifier; this.commandRunner = commandRunner;
    this.isRootOnline = isRootOnline; this.stageTimeoutMs = stageTimeoutMs;
    this.develop = projectFiles ? new DevelopController(this, projectFiles) : undefined;
    this.reads = new Set(); this.readLifetime = new AbortController();
    this.runners = new Map(); this.active = new Map(); this.notificationQueues = new Map(); this.startQueue = Promise.resolve(null); this.closing = false;
  }
  async required(runId) { const run = await this.store.load(runId); if (!run) throw protocolError('RUN_NOT_FOUND', runId); return run; }
  async mutate(runId, kind, apply, request = null, expectedRevision, operationId = `${kind}-${randomUUID()}`) {
    return this.store.commit(runId, expectedRevision, { operationId, request: { kind, data: request }, apply });
  }
  projectOperation(apply) {
    const operation = this.startQueue.catch(() => {}).then(apply);
    this.startQueue = operation;
    return operation;
  }
  async assertProjectWriter(runId) {
    const other = (await this.store.list()).find((run) => run.runId !== runId && run.mode === 'develop' && !['completed', 'cancelled'].includes(run.status));
    if (other) throw protocolError('PROJECT_WRITER_BUSY', other.runId);
  }
  async start(request, actor, { provenance } = { provenance: undefined }) {
    validate(startSchema, request);
    if (!request.requestId.trim() || !request.requirement.trim()) throw protocolError('INVALID_REQUEST', 'requestId and requirement require text');
    return this.projectOperation(async () => {
      if (this.closing) throw protocolError('SERVICE_CLOSING', 'Review service is closing');
      const project = await this.store.projectIdentity?.() ?? { projectRoot: this.store.projectRoot, projectKey: this.store.projectRoot };
      const normalized = { ...request, preset: request.preset ?? 'standard@2', mode: request.mode ?? 'review', materials: request.materials ?? [], rootSessionId: actor.sessionId, projectRoot: project.projectRoot, ...(provenance ? { provenance } : {}) };
      const requestDigest = fingerprint(normalized);
      const runId = `run-${fingerprint({ project: project.projectKey, root: actor.sessionId, requestId: request.requestId }).slice(0, 24)}`;
      const existing = await this.store.load(runId);
      if (existing) {
        if (existing.requestDigest !== requestDigest) throw protocolError('REQUEST_CONFLICT', request.requestId);
        return runSummary(existing);
      }
      if (normalized.mode === 'develop') await this.assertProjectWriter(runId);
      await loadReviewPreset(normalized.preset, normalized.mode);
      await this.store.initialize?.();
      const run = createRun({ ...normalized, requestDigest, runId });
      await this.store.writeArtifact(runId, 'inputs/1/request.json', normalized);
      await this.store.create(run);
      this.kick(runId);
      return runSummary(run);
    });
  }
  async listRuns(rootSessionId, cursor = 0) {
    const runs = (await this.store.list()).filter((run) => run.rootSessionId === rootSessionId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.runId.localeCompare(b.runId));
    const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    return { projectRoot: this.store.projectRoot, items: runs.slice(offset, offset + 20).map((run) => ({ ...runSummary(run), mode: run.mode, preset: run.preset, requirementRevision: run.requirementRevision, updatedAt: run.updatedAt, imported: Boolean(run.provenance) })), total: runs.length, nextCursor: offset + 20 < runs.length ? offset + 20 : null };
  }
  async importHistory(request, item, actor) {
    if (actor.kind !== 'user') throw protocolError('USER_COMMAND_REQUIRED', 'History import');
    if (!item?.source || typeof item.content !== 'string' || typeof item.digest !== 'string') throw protocolError('HISTORY_SOURCE_REQUIRED', 'Expected a read-only historical source');
    const start = { requestId: request.requestId, requirement: request.requirement?.trim() || item.title || 'Continue imported task', preset: request.preset ?? 'standard@2', mode: request.mode ?? 'review', materials: [{ name: `Imported ${item.id}`, content: item.content, source: `session:${item.source.sessionId}/task:${item.source.taskId}` }] };
    return this.start(start, actor, { provenance: { source: item.source, digest: item.digest, importedBy: actor.sessionId, status: 'imported', evidence: 'unknown' } });
  }
  kick(runId) {
    if (this.closing || this.runners.has(runId)) return;
    const task = Promise.resolve().then(async () => {
      const run = await this.required(runId);
      if (!this.isRootOnline(run.rootSessionId)) { await this.checkpoint(runId, 'paused', 'Root session is offline'); return; }
      if (run.mode === 'develop' && this.develop) await this.develop.initialize(runId);
      const preset = await loadReviewPreset(run.preset, run.mode);
      await driveReview({ load: () => this.required(runId), preset,
        execute: (stageId, role) => this.execute(runId, stageId, role),
        report: () => this.finish(runId), checkpoint: (status) => this.checkpoint(runId, status),
        onReviewUnavailable: () => this.reviewUnavailable(runId),
        onDevelop: () => this.develop ? this.develop.build(runId) : this.checkpoint(runId, 'paused', 'Develop requires the project filesystem capability.'),
        onVerify: () => this.develop.beforeVerify(runId),
      });
    }).catch(async (error) => {
      await this.checkpoint(runId, 'error', String(error.message ?? error));
    }).finally(() => { if (this.runners.get(runId) === task) this.runners.delete(runId); });
    task.catch(() => {});
    this.runners.set(runId, task);
  }
  async reviewUnavailable(runId) {
    await this.mutate(runId, 'review-unavailable', (run) => {
      if (run.questions.some((question) => question.id === 'review-unavailable' && question.status === 'open')) return null;
      const source = run.executions.findLast((execution) => execution.stageId === 'review' && execution.applicability === 'current');
      run.questions.push({ id: 'review-unavailable', question: '两位独立评审均执行失败，选择重试或继续形成降级决议。', findingIds: [], options: [{ id: 'retry', label: '重试评审', description: '停止旧执行后创建新的独立评审会话。' }, { id: 'continue', label: '继续形成决议', description: '保留失败记录，由lead独立形成方案并在报告中注明缺少有效评审。' }], sourceExecutionId: source.executionId, requirementRevision: run.requirementRevision, status: 'open' });
      run.status = 'waiting_user'; return null;
    });
    await this.notify(runId);
  }
  async checkpoint(runId, status, diagnostic) {
    const changed = await this.mutate(runId, 'checkpoint', (run) => {
      if (run.status === 'cancelled' || (run.status === 'completed' && status !== 'completed')) return null;
      run.status = status;
      if (diagnostic) run.diagnostic = diagnostic;
      if (status === 'paused' && ['Root session is offline', 'Root session left runtime or was archived'].includes(diagnostic)) run.resumeWhenRootAvailable = true;
      return { status: run.status };
    }, { status, diagnostic: diagnostic ?? null });
    if (['completed', 'waiting_user', 'error'].includes(changed.run.status)) await this.notify(runId);
  }
  async execute(runId, stageId, role) {
    const run = await this.required(runId);
    if (this.closing || run.status !== 'running' && run.status !== 'queued') return;
    if (!this.isRootOnline(run.rootSessionId)) { await this.checkpoint(runId, 'paused', 'Root session is offline'); return; }
    const executionId = `exec-${randomUUID()}`;
    const spec = buildExecutionSpec(run, stageId, role, executionId);
    await this.store.writeArtifact(runId, `inputs/${run.requirementRevision}/${executionId}.json`, spec.inputs);
    await this.mutate(runId, 'execution-start', (next) => {
      if (next.requirementRevision !== run.requirementRevision || ['paused', 'cancelled'].includes(next.status)) throw protocolError('INPUT_CHANGED', runId);
      beginExecution(next, spec); return { executionId };
    }, spec);
    const controller = new AbortController();
    const entry = { runId, executionId, controller, handle: undefined, released: Promise.resolve(), timedOut: false };
    this.active.set(executionId, entry);
    const timer = setTimeout(() => {
      entry.timedOut = true; controller.abort();
      if (entry.handle) { entry.released = entry.handle.cancel(); entry.released.catch(() => {}); }
    }, this.stageTimeoutMs);
    try {
      entry.handle = await this.agentRunner.start({ ...spec, signal: controller.signal });
      if (controller.signal.aborted) await entry.handle.cancel();
      await this.mutate(runId, 'execution-accepted', (next) => {
        const execution = next.executions.find((e) => e.executionId === executionId);
        execution.childSessionId = entry.handle.childId;
        if (entry.handle.messageId) execution.acceptedMessageId = entry.handle.messageId;
        if (entry.handle.provider) execution.provider = entry.handle.provider;
        return { executionId, childSessionId: entry.handle.childId };
      });
      const received = await entry.handle.result;
      const ref = `artifacts/${executionId}/raw-${fingerprint(received.raw ?? received)}.json`;
      await this.store.writeArtifact(runId, ref, received.raw ?? received);
      await this.mutate(runId, 'raw-result', (next) => { next.executions.find((e) => e.executionId === executionId).rawResultRef = ref; return { ref }; });
      if (received.envelope && !entry.timedOut) {
        const submitted = await this.submit(runId, received.envelope, { sessionId: entry.handle.childId, kind: 'activation' });
        if (submitted.applicability === 'stale' && ['build', 'verify'].includes(stageId)) await this.mutate(runId, 'execution-input-mismatch', (current) => {
          const execution = current.executions.find((item) => item.executionId === executionId);
          if (!execution || current.activeExecutions[`${stageId}:${role}`] !== executionId || !['running', 'queued'].includes(current.status)) return null;
          const completed = execution.workStatus === 'completed' && execution.applicability === 'current' && execution.processed
            && current.artifacts.some((artifact) => artifact.executionId === executionId && artifact.applicability === 'current' && artifact.resultRef === execution.resultRef);
          const envelope = received.envelope;
          const mismatched = envelope.requirementRevision !== execution.requirementRevision || envelope.decisionRevision !== execution.decisionRevision
            || envelope.inputFingerprint !== execution.inputFingerprint || envelope.requirementRevision !== current.requirementRevision || envelope.decisionRevision !== current.decisionRevision;
          if (!completed && mismatched) {
            current.status = 'paused'; current.diagnostic = 'Execution returned a mismatched input version; inspect the archived result before retry.';
          }
          return { completed: Boolean(completed), mismatched };
        });
      }
      else await this.failExecution(runId, executionId, received.parseError ?? received.raw?.diagnostic ?? received.raw?.stopReason ?? 'Missing structured result', ref, controller.signal.aborted || entry.timedOut);
    } catch (error) {
      await this.failExecution(runId, executionId, String(error.message ?? error), undefined, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
      try { if (entry.handle) await entry.handle.cancel(); await entry.released; }
      catch (error) { await this.checkpoint(runId, 'error', `Execution cleanup: ${error.message ?? error}`); }
      this.active.delete(executionId);
    }
  }
  async failExecution(runId, executionId, diagnostic, rawRef, interrupted = false) {
    await this.mutate(runId, 'execution-error', (run) => {
      const execution = run.executions.find((e) => e.executionId === executionId);
      if (!execution || execution.workStatus === 'completed') return null;
      execution.workStatus = run.status === 'cancelled' ? 'cancelled' : interrupted ? 'interrupted' : 'error';
      execution.diagnostic = diagnostic; execution.endedAt = new Date().toISOString();
      if (rawRef) execution.resultRef = rawRef;
      if (execution.applicability === 'current' && !['cancelled', 'paused'].includes(run.status) && (interrupted || execution.stageId !== 'review')) { run.status = interrupted ? 'paused' : 'error'; run.diagnostic = diagnostic; }
      return { executionId, workStatus: execution.workStatus };
    }, { executionId, diagnostic, rawRef: rawRef ?? null });
  }
  async submit(runId, envelope, actor) {
    validateEnvelope(envelope);
    const before = await this.required(runId);
    const execution = before.executions.find((e) => e.executionId === envelope.executionId);
    if (!execution) throw protocolError('EXECUTION_NOT_FOUND', envelope.executionId);
    if (execution.childSessionId !== actor.sessionId && actor.kind !== 'recovery') throw protocolError('EXECUTION_OWNER_MISMATCH', envelope.executionId);
    const ref = `artifacts/${envelope.executionId}/result-${fingerprint(envelope)}.json`;
    await this.store.writeArtifact(runId, ref, envelope);
    const committed = await this.mutate(runId, 'submit', (run) => {
      const result = acceptResult(run, envelope, ref);
      const updated = run.executions.find((e) => e.executionId === envelope.executionId);
      if (result.applicability === 'current' && !updated.processed) {
        if (updated.stageId === 'review') collectFindings(run, updated);
        if (updated.stageId === 'intake') {
          run.summary = updated.result.summary;
          run.questions = updated.result.questions.map((question) => ({ ...question, sourceExecutionId: updated.executionId, requirementRevision: run.requirementRevision, status: 'open' }));
          if (run.questions.length) run.status = 'waiting_user';
        }
        if (updated.stageId === 'decide') applyDecisionResult(run, updated);
        if (updated.stageId === 'build') {
          const tasks = currentTasks(run);
          const completed = new Set(updated.result.completedTaskIds);
          if (updated.result.completedTaskIds.some((id) => !tasks.some((task) => task.id === id))) throw protocolError('TASK_NOT_FOUND', 'Build completion references a non-current task');
          if (tasks.some((task) => task.workStatus !== 'completed' && !completed.has(task.id))) throw protocolError('BUILD_TASKS_INCOMPLETE', 'Build must account for every assigned implementation task');
          for (const task of tasks) if (completed.has(task.id)) task.workStatus = 'completed';
          for (const findingId of updated.result.resolvedFindingIds ?? []) {
            const finding = run.findings.find((entry) => entry.id === findingId);
            if (!finding) throw protocolError('FINDING_NOT_FOUND', findingId);
            if (finding.origin === 'verification') finding.status = 'fixed_pending_verification';
          }
        }
        if (updated.stageId === 'verify') recordVerification(run, updated);
        updated.processed = true;
      }
      return result;
    }, envelope, undefined, `submit-${envelope.executionId}-${fingerprint(envelope)}`);
    if (committed.run.status === 'waiting_user') await this.notify(runId);
    return committed.result;
  }
  async status(runId) {
    const run = await this.required(runId);
    const diagnostics = await this.store.listDiagnostics?.() ?? [];
    return { ...runSummary(run), storageDiagnostics: diagnostics.slice(0, 20), storageDiagnosticCount: diagnostics.length };
  }
  async probe(runId) {
    const run = await this.required(runId);
    if (!this.commandRunner) throw protocolError('COMMAND_RUNNER_UNAVAILABLE', 'Subprocess service is unavailable');
    const executionId = `probe-${randomUUID()}`;
    const spec = { id: executionId, requirementRevision: run.requirementRevision, kind: 'command', phase: 'plan', required: false, argv: ['node', '-e', 'console.log(JSON.stringify({reviewProbe:true,node:process.version}))'], cwd: run.projectRoot, timeoutMs: 10000 };
    const result = await this.commandRunner.run(spec);
    const logRef = await this.store.writeArtifact(runId, `logs/${executionId}/result.json`, result);
    await this.mutate(runId, 'probe', (next) => { next.checks.push(spec); next.checkResults.push({ ...result, executionId, logRef, applicability: 'current', inputFingerprint: fingerprint(spec), summary: result.summary ?? `${result.outcome}: Node runtime probe` }); return { logRef }; });
    return { runId, ...result, logRef };
  }
  async control(runId, action, options = {}) {
    return this.projectOperation(async () => {
      const run = await this.required(runId);
      if (run.mode === 'develop' && ['resume', 'retry'].includes(action) && !run.operations.some((operation) => operation.operationId === options.operationId)) await this.assertProjectWriter(runId);
      return this.controlOwned(runId, action, options);
    });
  }
  async controlOwned(runId, action, options = {}) {
    const accepted = await this.mutate(runId, 'control', (run) => {
      run.resumeWhenRootAvailable = false;
      if (action === 'pause') { if (run.status === 'running' || run.status === 'queued') run.pauseRequested = true; }
      else if (action === 'cancel') { run.status = 'cancelled'; run.pauseRequested = false; }
      else if (action === 'stop') { if (run.status !== 'completed') run.status = 'paused'; run.pauseRequested = false; }
      else if (action === 'resume' || action === 'retry') {
        if (['cancelled', 'completed'].includes(run.status)) throw protocolError('RUN_TERMINAL', run.status);
        if (run.questions.some((q) => q.status === 'open')) throw protocolError('USER_CHOICE_REQUIRED', runId);
        run.status = 'paused'; run.pauseRequested = false;
      } else throw protocolError('INVALID_CONTROL', action);
      return { accepted: true, action };
    }, { action }, options.expectedRevision, options.operationId);
    if (accepted.replayed) return runSummary(await this.required(runId));
    if (['cancel', 'stop', 'resume', 'retry'].includes(action)) {
      await this.stopActive(runId);
      const run = await this.required(runId);
      for (const execution of run.executions.filter((e) => e.workStatus === 'running' || e.workStatus === 'interrupted')) {
        if (!this.active.has(execution.executionId)) await this.agentRunner.stopRecovered?.(run, execution);
      }
      if (['resume', 'retry'].includes(action) && this.develop && run.mode === 'develop') await this.develop.inspectResume(runId);
      await this.mutate(runId, 'control-settled', (next) => {
        for (const execution of next.executions.filter((e) => e.workStatus === 'running')) execution.workStatus = action === 'cancel' ? 'cancelled' : 'interrupted';
        if (action === 'resume' || action === 'retry') { next.status = 'queued'; next.pauseRequested = false; }
        return null;
      });
      if (action === 'resume' || action === 'retry') { await this.runners.get(runId); this.kick(runId); }
    }
    return this.status(runId);
  }
  async stopActive(runId) {
    const entries = [...this.active.values()].filter((entry) => entry.runId === runId);
    const checks = [...this.develop?.activeChecks.values() ?? []].filter((entry) => entry.runId === runId);
    for (const entry of checks) entry.controller.abort();
    const outcomes = await Promise.allSettled([
      ...checks.map((entry) => entry.done),
      ...entries.map(async (entry) => { entry.controller.abort(); if (entry.handle) await entry.handle.cancel(); }),
      ...(this.runners.has(runId) ? [this.runners.get(runId)] : []),
    ]);
    const failures = outcomes.filter((entry) => entry.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), `Review run ${runId} cleanup failed`);
  }
  async decide(runId, questionId, optionId, actor, operationId, expectedRevision) {
    if (actor.kind !== 'user') throw protocolError('USER_COMMAND_REQUIRED', questionId);
    const result = await this.mutate(runId, 'user-decision', (run) => {
      const question = run.questions.find((q) => q.id === questionId && q.status === 'open');
      if (!question) throw protocolError('QUESTION_NOT_FOUND', questionId);
      const option = question.options.find((entry) => entry.id === optionId);
      if (!option) throw protocolError('OPTION_NOT_FOUND', optionId);
      question.status = 'answered'; question.answer = optionId; question.answeredBy = actor.sessionId;
      if (question.category === 'rework-limit') {
        if (optionId === 'continue') { run.rework.max++; run.rework.userContinuation = true; scheduleRework(run, implementationFindings(run), 'User requested another rework round'); }
        else { run.status = 'paused'; run.diagnostic = 'User preserved current work and paused remaining rework'; }
      }
      if (questionId === 'review-unavailable' && optionId === 'retry') {
        for (const execution of run.executions.filter((entry) => entry.stageId === 'review' && entry.applicability === 'current')) { execution.applicability = 'stale'; delete run.activeExecutions[`review:${execution.role}`]; }
      }
      recordDecision(run, { id: `user-${questionId}-${question.sourceExecutionId}`, findingIds: question.category === 'rework-limit' ? [] : question.findingIds, choice: 'alternative', reason: `用户选择 ${option.label}：${option.description}`, checks: [] }, `user:${actor.sessionId}`, question.sourceExecutionId);
      run.decisionRevision++;
      if (!run.questions.some((q) => q.status === 'open') && !(question.category === 'rework-limit' && optionId === 'pause')) {
        run.status = 'queued';
        const source = run.executions.find((entry) => entry.executionId === question.sourceExecutionId);
        if (source?.stageId === 'decide') {
          // The next decide receives the user's answer and turns it into concrete implementation/check requirements.
          source.applicability = 'stale';
          delete run.activeExecutions['decide:lead'];
        }
      }
      return { questionId, optionId };
    }, { questionId, optionId }, expectedRevision, operationId);
    this.kick(runId); return runSummary(result.run);
  }
  async revise(runId, change) {
    return this.projectOperation(async () => {
      const run = await this.required(runId);
      if (run.mode === 'develop' && !run.operations.some((operation) => operation.operationId === change.operationId)) await this.assertProjectWriter(runId);
      return this.reviseOwned(runId, change);
    });
  }
  async reviseOwned(runId, change) {
    const result = await this.mutate(runId, 'revise', (run) => {
      if (run.status === 'cancelled') throw protocolError('RUN_TERMINAL', run.status);
      if (change.impact) return applyImpactRevision(run, change);
      invalidate(run, change.reason); run.requirement = change.requirement;
      for (const finding of run.findings) finding.applicability = 'stale';
      for (const decision of run.decisions) decision.applicability = 'stale';
      for (const task of run.tasks) task.applicability = 'stale';
      return { requirementRevision: run.requirementRevision };
    }, change, change.expectedRevision, change.operationId);
    if (!result.replayed) { await this.stopActive(runId); if (this.develop) await this.develop.inspectResume(runId); await this.mutate(runId, 'revision-ready', (run) => { run.status = 'queued'; return null; }); this.kick(runId); }
    return this.status(runId);
  }
  async finish(runId) {
    if ((await this.required(runId)).mode === 'develop' && this.develop && !await this.develop.deliveryReady(runId)) return;
    const before = await this.required(runId);
    const markdown = renderReport({ ...before, status: 'completed', phase: 'report' });
    const reportRef = this.store.writeReport ? await this.store.writeReport(runId, before.revision, markdown) : await this.store.writeArtifact(runId, `reports/report-${before.revision}.md`, markdown);
    await this.mutate(runId, 'finish', (run) => { run.status = 'completed'; run.phase = 'report'; run.reportRef = reportRef; return { reportRef }; }, { reportRef }, before.revision);
    await this.notify(runId);
  }
  async notify(runId, notificationId) {
    const previous = this.notificationQueues.get(runId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.deliverNotification(runId, notificationId));
    this.notificationQueues.set(runId, task);
    try { await task; } finally { if (this.notificationQueues.get(runId) === task) this.notificationQueues.delete(runId); }
  }
  async deliverNotification(runId, requestedNotificationId) {
    const run = await this.required(runId);
    const notificationId = requestedNotificationId ?? `${runId}:${run.requirementRevision}:${run.status}:${run.phase}:${run.decisionRevision}`;
    if (run.notifications.some((entry) => entry.notificationId === notificationId && entry.messageId)) return;
    await this.mutate(runId, 'notification-queued', (next) => {
      if (!next.notifications.some((entry) => entry.notificationId === notificationId)) next.notifications.push({ notificationId, revision: run.revision, status: 'pending', summary: runSummary(run) });
      return null;
    });
    const pending = (await this.required(runId)).notifications.find((entry) => entry.notificationId === notificationId);
    let messageId;
    try { messageId = await this.notifier?.enqueue(run.rootSessionId, pending); }
    catch (error) { await this.mutate(runId, 'notification-pending', (next) => { next.notifications.find((item) => item.notificationId === notificationId).diagnostic = String(error.message ?? error); return null; }); }
    if (messageId) await this.mutate(runId, 'notification-sent', (next) => { const entry = next.notifications.find((item) => item.notificationId === notificationId); entry.messageId = messageId; entry.status = 'sent'; return { messageId }; });
  }
  async recover() {
    for (const run of await this.store.list()) {
      if (['completed', 'cancelled'].includes(run.status)) { if (run.notifications.some((n) => n.status === 'pending')) await this.notify(run.runId); continue; }
      for (const execution of run.executions.filter((e) => e.workStatus === 'running')) {
        let recovered;
        try {
          if (execution.rawResultRef) {
            const raw = JSON.parse(await this.store.readArtifact(run.runId, execution.rawResultRef));
            if (raw.stopReason === 'completed') recovered = { kind: 'result', envelope: decodeAgentResult(raw), childId: execution.childSessionId };
          }
          recovered ??= await this.agentRunner.recover?.(run, execution);
          if (recovered?.kind === 'result') {
            if (recovered.envelope.executionId !== execution.executionId || recovered.envelope.requirementRevision !== execution.requirementRevision || recovered.envelope.decisionRevision !== execution.decisionRevision || recovered.envelope.inputFingerprint !== execution.inputFingerprint) {
              throw protocolError('RECOVERY_IDENTITY_MISMATCH', 'Recovered output did not match its execution identity');
            }
            if (recovered.childId) await this.mutate(run.runId, 'recovered-child', (next) => { next.executions.find((e) => e.executionId === execution.executionId).childSessionId = recovered.childId; return null; });
            await this.submit(run.runId, recovered.envelope, { kind: 'recovery', sessionId: recovered.childId });
          } else await this.failExecution(run.runId, execution.executionId, recovered?.diagnostic ?? 'Activation handle was lost', undefined, true);
        } catch (error) {
          // Invalid saved output belongs to this execution; other runs must remain available.
          await this.failExecution(run.runId, execution.executionId, `${error.code ?? 'RECOVERY_ERROR'}: ${error.message ?? error}`, execution.rawResultRef);
        }
      }
      if (run.mode === 'develop' && this.develop) {
        try { await this.develop.reconcileRecovery(run.runId); }
        catch (error) {
          if (error.code !== 'DEVELOP_RECOVERY_INPUT_ERROR') throw error;
          await this.mutate(run.runId, 'develop-recovery-paused', (next) => {
            if (!['completed', 'cancelled'].includes(next.status)) {
              next.status = 'paused'; next.resumeWhenRootAvailable = false;
              next.diagnostic = `${error.code}: ${error.message ?? error}`;
            }
            return { status: next.status };
          });
          await this.stopActive(run.runId);
        }
      }
      const current = await this.required(run.runId);
      if (current.executions.some((e) => e.workStatus === 'interrupted' && e.applicability === 'current' && current.activeExecutions[`${e.stageId}:${e.role}`] === e.executionId)) await this.checkpoint(run.runId, 'paused', 'Interrupted execution requires inspection and retry');
      else if (this.isRootOnline(current.rootSessionId) && ['running', 'queued'].includes(current.status)) this.kick(run.runId);
      if (current.notifications.some((n) => n.status === 'pending')) await this.notify(run.runId);
    }
  }
  async rootAvailable(rootSessionId) {
    if (this.closing || !this.isRootOnline(rootSessionId)) return;
    for (const run of await this.store.list()) {
      if (run.rootSessionId !== rootSessionId) continue;
      for (const notification of run.notifications.filter((entry) => entry.status === 'pending')) await this.notify(run.runId, notification.notificationId);
      if (run.status === 'paused' && run.resumeWhenRootAvailable) {
        const interrupted = run.executions.some((execution) => execution.workStatus === 'interrupted' && execution.applicability === 'current' && run.activeExecutions[`${execution.stageId}:${execution.role}`] === execution.executionId);
        if (interrupted || run.questions.some((question) => question.status === 'open')) continue;
        await this.mutate(run.runId, 'root-available', (next) => { next.status = 'queued'; next.resumeWhenRootAvailable = false; return null; });
        this.kick(run.runId);
      } else if (['running', 'queued'].includes(run.status)) this.kick(run.runId);
    }
  }
  async rootUnavailable(rootSessionId) {
    for (const run of await this.store.list()) if (run.rootSessionId === rootSessionId && ['queued', 'running'].includes(run.status)) { await this.checkpoint(run.runId, 'paused', 'Root session left runtime or was archived'); await this.stopActive(run.runId); }
  }
  inspect(runId, section, cursor = 0, id, signal) {
    const combined = signal ? AbortSignal.any([signal, this.readLifetime.signal]) : this.readLifetime.signal;
    const task = this.inspectOwned(runId, section, cursor, id, combined); this.reads.add(task);
    task.finally(() => this.reads.delete(task)).catch(() => {});
    return task;
  }
  async inspectOwned(runId, section, cursor = 0, id, signal) {
    if (signal.aborted) throw protocolError('REQUEST_ABORTED', 'Review read cancelled');
    if (section === 'diagnostics') {
      const diagnostics = await this.store.listDiagnostics?.() ?? [];
      const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
      const items = id ? diagnostics.filter((entry) => entry.runId === id) : diagnostics;
      return { runId, section, projectRoot: this.store.projectRoot, items: items.slice(offset, offset + 20), total: items.length, nextCursor: offset + 20 < items.length ? offset + 20 : null };
    }
    const run = await this.required(runId);
    if (section === 'report' || section === 'artifact') {
      const content = section === 'report' ? renderReport(run) : await this.store.readArtifact(runId, id);
      const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
      return { runId, section, projectRoot: run.projectRoot, content: content.slice(offset, offset + 16000), totalCharacters: content.length, truncated: offset + 16000 < content.length, nextCursor: offset + 16000 < content.length ? offset + 16000 : null };
    }
    if (section === 'run') return { ...runSummary(run), mode: run.mode, preset: run.preset, requirementRevision: run.requirementRevision, diagnostic: run.diagnostic ?? null, provenance: run.provenance ?? null, requirement: run.requirement, materials: run.materials.map((m) => ({ name: m.name, ...(m.source === undefined ? {} : { source: m.source }) })), projectRoot: run.projectRoot, ...(run.reportRef === undefined ? {} : { reportRef: run.reportRef }) };
    if (section === 'usage') {
      const observed = new Map();
      for (const execution of run.executions) {
        if (signal?.aborted) throw protocolError('REQUEST_ABORTED', 'Usage read cancelled');
        try { const usage = await this.agentRunner.readUsage?.(execution, signal); if (usage) observed.set(execution.executionId, usage); }
        catch (error) { if (signal?.aborted) throw error; /* Usage availability never changes a run or invents a zero value. */ }
      }
      const summary = usageSummary(run, observed); const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
      return { runId, section, projectRoot: run.projectRoot, ...summary, executions: summary.executions.slice(offset, offset + 20), total: summary.executions.length, nextCursor: offset + 20 < summary.executions.length ? offset + 20 : null };
    }
    const list = section === 'checks' ? [...run.checks, ...run.checkResults] : section === 'checkSpecs' ? run.checks : run[section];
    if (!Array.isArray(list)) throw protocolError('INVALID_SECTION', section);
    const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    const filtered = id ? list.filter((item) => item.id === id || item.executionId === id) : list;
    return { runId, section, projectRoot: run.projectRoot, items: filtered.slice(offset, offset + 20), total: filtered.length, nextCursor: offset + 20 < filtered.length ? offset + 20 : null };
  }
  async wait(runId) { await this.runners.get(runId); }
  dispose() {
    this.closing = true;
    this.readLifetime.abort(new Error('Review service unloaded'));
    if (this.disposal) return this.disposal;
    const runIds = [...new Set([...this.runners.keys(), ...[...this.active.values()].map((entry) => entry.runId)])];
    // Cancellation starts independently of storage, projection, and other resources failing.
    this.disposal = (async () => {
      const outcomes = await Promise.allSettled([
        ...runIds.map((runId) => this.checkpoint(runId, 'paused', 'Plugin is unloading')),
        ...runIds.map((runId) => this.stopActive(runId)),
        Promise.resolve().then(() => this.develop?.dispose()),
        Promise.resolve().then(() => this.commandRunner?.dispose()),
        ...[...this.reads].map((read) => read.catch(() => undefined)),
        ...this.notificationQueues.values(),
      ]);
      const failures = outcomes.filter((entry) => entry.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), 'Review service cleanup failed');
    })();
    return this.disposal;
  }
}
