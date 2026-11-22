import { randomUUID } from 'node:crypto';
import { checkFingerprint, currentTasks, inScopes, judgeCommand, snapshotDiff } from '../src/review/checks.mjs';
import { protocolError } from '../src/review/schemas.mjs';
import { implementationFindings, recordCheckFindings, scheduleRework } from '../src/review/rework.mjs';

export class DevelopController {
  constructor(service, files) { this.service = service; this.files = files; this.activeChecks = new Map(); this.registryCache = new Map(); this.closed = false; }
  async config(run) { return this.files.configuration(run.configuredChecks); }
  async references(config, snapshot, runId) {
    const results = await this.files.references(config.references, snapshot);
    for (const reference of results.filter((entry) => entry.reason?.endsWith('needs-registry'))) {
      if (this.closed || this.service.closing) break;
      const run = await this.service.required(runId);
      if (this.closed || this.service.closing || !['queued', 'running'].includes(run.status)) break;
      const key = `${reference.packageName}:${reference.declared ?? 'latest'}`;
      if (!this.registryCache.has(key)) {
        const controller = new AbortController(); let release = () => {};
        const done = new Promise((resolve) => { release = () => resolve(undefined); }); const id = `registry-${randomUUID()}`;
        this.activeChecks.set(id, { runId, controller, done });
        try {
          const raw = this.service.commandRunner ? await this.service.commandRunner.run({ id, argv: [process.platform === 'win32' ? 'cmd.exe' : 'npm', ...(process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd'] : []), 'view', reference.packageName, 'version', '--json'], cwd: this.files.projectRoot, timeoutMs: 10000 }, controller.signal) : undefined;
          if (controller.signal.aborted || this.closed || this.service.closing) { Object.assign(reference, { outcome: 'unknown', reason: 'registry-cancelled' }); break; }
          let registry = { outcome: 'unknown', reason: 'registry-unavailable' };
          if (raw?.outcome === 'passed') {
            try { registry = { outcome: 'passed', reason: 'registry-package-found', version: JSON.parse(raw.stdout.trim()) }; } catch { registry = { outcome: 'unknown', reason: 'registry-output-unparsed' }; }
          }
          this.registryCache.set(key, registry);
        } finally { this.activeChecks.delete(id); release(); }
      }
      Object.assign(reference, this.registryCache.get(key));
    }
    return results;
  }
  async snapshot(config, spec) {
    // Project baselines ignore generated outputs; a check still reads other steps' generated inputs.
    return this.files.snapshot({ inputs: spec?.inputs ?? [], outputs: spec ? spec.outputs ?? [] : [...new Set(config.checks.flatMap((check) => check.outputs))] });
  }
  async initialize(runId) {
    const service = this.service; const run = await service.required(runId);
    if (!this.files) throw protocolError('PROJECT_FILES_UNAVAILABLE', 'Develop requires the project filesystem capability');
    const config = await this.config(run);
    const snapshot = await this.snapshot(config);
    const ref = await service.store.writeArtifact(runId, `inputs/${run.requirementRevision}/workspace-${snapshot.digest}-${randomUUID()}.json`, snapshot);
    if (!run.workspace) {
      await service.mutate(runId, 'develop-baseline', (next) => {
        next.workspace = { baselineRef: ref, baselineFingerprint: snapshot.digest, latestRef: ref, latestFingerprint: snapshot.digest, changes: [] };
        next.checkConfig = config;
        next.rework = { count: 0, max: config.maxReworks, findingIds: [] };
        return { ref };
      });
    }
    if (!await this.ensureCheckBaselines(runId, config)) return { config, snapshot, ref };
    for (const spec of config.checks.filter((check) => check.phase === 'plan')) {
      const current = await service.required(runId);
      const digest = checkFingerprint(await this.snapshot(config, spec), spec, config.digest);
      if (!current.checkResults.some((result) => result.checkId === spec.id && !result.baseline && result.applicability === 'current' && result.inputFingerprint === digest && result.outcome === 'passed')) await this.runCheck(runId, spec, config);
    }
    const current = await service.required(runId);
    const pending = config.checks.filter((check) => check.required && check.phase === 'plan').filter((spec) => !current.checkResults.some((result) => result.checkId === spec.id && !result.baseline && result.requirementRevision === current.requirementRevision && result.applicability === 'current' && result.outcome === 'passed'));
    if (pending.length && ['queued', 'running'].includes(current.status)) await service.checkpoint(runId, 'paused', `Required plan checks need attention: ${pending.map((check) => check.id).join(', ')}`);
    return { config, snapshot, ref };
  }
  baselineResult(run, spec, config) {
    return run.checkResults.findLast((result) => result.checkId === spec.id && result.baseline === true && result.requirementRevision === run.requirementRevision && result.configDigest === config.digest && result.applicability === 'current'
      && ['passed', 'failed'].includes(result.outcome) && result.testSummary?.parsed && result.testSummary.tests > 0
      && (result.testSummary.fail === 0 || result.testSummary.failures.length >= result.testSummary.fail));
  }
  async ensureCheckBaselines(runId, config) {
    const service = this.service;
    for (const spec of config.checks.filter((check) => check.onlyNewFailures)) {
      let run = await service.required(runId);
      if (this.closed || service.closing || !['queued', 'running'].includes(run.status)) return false;
      let baseline = this.baselineResult(run, spec, config);
      const buildStarted = run.workspace.buildRequirementRevision === run.requirementRevision || run.executions.some((execution) => execution.stageId === 'build' && (execution.requirementRevision === run.requirementRevision || execution.reusedForRevision === run.requirementRevision));
      if (!baseline && buildStarted) {
        await service.mutate(runId, 'baseline-unavailable-after-build', (next) => {
          next.workspace.checkBaselines ??= {};
          next.workspace.checkBaselines[spec.id] = { status: 'waiting', configDigest: config.digest, requirementRevision: run.requirementRevision, reason: 'missing-trusted-original-baseline' };
          next.status = 'paused'; next.diagnostic = `Trusted original baseline is missing after build started: ${spec.id}. Preserve the original result before continuing.`;
          return { checkId: spec.id };
        }); return false;
      }
      if (!baseline) {
        await service.mutate(runId, 'baseline-collecting', (next) => {
          next.workspace.checkBaselines ??= {};
          next.workspace.checkBaselines[spec.id] = { status: 'collecting', configDigest: config.digest, requirementRevision: run.requirementRevision };
          return { checkId: spec.id };
        });
        await this.runCheck(runId, spec, config, true);
        run = await service.required(runId); baseline = this.baselineResult(run, spec, config);
      }
      await service.mutate(runId, 'baseline-state', (next) => {
        next.workspace.checkBaselines ??= {};
        next.workspace.checkBaselines[spec.id] = { status: baseline ? 'ready' : 'waiting', configDigest: config.digest, requirementRevision: run.requirementRevision, ...(baseline ? { executionId: baseline.executionId, inputFingerprint: baseline.inputFingerprint } : { reason: 'baseline-unknown-or-unparsed' }) };
        if (!baseline && ['queued', 'running'].includes(next.status)) { next.status = 'paused'; next.diagnostic = `Original check baseline needs attention: ${spec.id}. Restore the tool or parser and resume before build.`; }
        return { checkId: spec.id, ready: Boolean(baseline) };
      });
      if (!baseline) return false;
    }
    return true;
  }
  async build(runId) {
    const service = this.service;
    const { config, snapshot, ref } = await this.initialize(runId);
    let run = await service.required(runId);
    if (!['queued', 'running'].includes(run.status) || service.closing) return;
    const tasks = currentTasks(run).filter((task) => task.workStatus !== 'completed');
    if (!tasks.length) { await service.checkpoint(runId, 'paused', 'No current implementation task; revise the decision or provide implementation requirements'); return; }
    const expected = run.workspace.latestFingerprint;
    if (expected !== snapshot.digest && !run.workspace.resumeInspected) {
      await service.mutate(runId, 'workspace-conflict', (next) => { next.workspace.pendingSnapshotRef = ref; next.workspace.pendingFingerprint = snapshot.digest; next.status = 'paused'; next.diagnostic = 'Project files changed outside the last execution. Inspect workspace before retry.'; return null; }); return;
    }
    await service.mutate(runId, 'build-ready', (next) => {
      next.workspace.buildBeforeRef = ref; next.workspace.buildBeforeFingerprint = snapshot.digest; next.workspace.buildRequirementRevision = next.requirementRevision; delete next.workspace.resumeInspected;
      next.checkConfig = config;
      for (const task of currentTasks(next).filter((task) => task.workStatus !== 'completed')) task.workStatus = 'running';
      return { taskIds: tasks.map((task) => task.id) };
    });
    await service.execute(runId, 'build', 'developer');
    run = await service.required(runId);
    const execution = run.executions.find((entry) => entry.executionId === run.activeExecutions['build:developer']);
    const afterConfig = await this.config(run); const after = await this.snapshot(afterConfig);
    const afterRef = await service.store.writeArtifact(runId, `artifacts/${execution?.executionId ?? 'build-interrupted'}/workspace-${after.digest}-${randomUUID()}.json`, after);
    const changes = snapshotDiff(snapshot, after);
    const baseline = JSON.parse(await service.store.readArtifact(runId, run.workspace.baselineRef));
    const totalChanges = snapshotDiff(baseline, after);
    await service.mutate(runId, 'build-files', (next) => {
      if (next.requirementRevision !== run.requirementRevision) return { archived: true };
      next.workspace.latestRef = afterRef; next.workspace.latestFingerprint = after.digest; next.workspace.changes = totalChanges; next.workspace.lastBuildChanges = changes;
      next.workspace.codeChanged = changes.length > 0;
      const scopes = [...new Set(tasks.flatMap((task) => task.writeScopes))];
      const outside = changes.filter((change) => !inScopes(change.path, scopes));
      const declared = execution?.result?.changed ?? [];
      const missing = changes.filter((change) => !declared.includes(change.path));
      next.workspace.scopeWarnings = outside.map((change) => change.path);
      next.workspace.unreportedChanges = missing.map((change) => change.path);
      if (outside.length && execution?.workStatus === 'completed') { next.status = 'paused'; next.diagnostic = `Changes outside task write scopes: ${outside.map((change) => change.path).join(', ')}`; }
      const updated = next.executions.find((entry) => entry.executionId === execution?.executionId);
      if (updated) updated.codeFingerprint = after.digest;
      return { changes: changes.map((change) => change.path), outside: outside.map((change) => change.path) };
    });
    run = await service.required(runId);
    if (execution?.workStatus !== 'completed' || !['running', 'queued'].includes(run.status)) return;
    await this.checks(runId, ['implementation']);
  }
  async runCheck(runId, spec, config, baseline = false) {
    const service = this.service; const run = await service.required(runId);
    if (this.closed || service.closing || !['queued', 'running'].includes(run.status)) return undefined;
    const executionId = `check-${randomUUID()}`;
    const controller = new AbortController(); this.activeChecks.set(executionId, { runId, controller });
    try {
      const before = await this.snapshot(config, spec);
      const inputFingerprint = checkFingerprint(before, spec, config.digest);
      const cwd = await this.files.cwd(spec.cwd);
      const previous = baseline ? undefined : this.baselineResult(run, spec, config);
      const raw = service.commandRunner ? await service.commandRunner.run({ ...spec, cwd }, controller.signal) : { checkId: spec.id, outcome: 'unknown', exitCode: null, reason: 'missing-command-runner', summary: 'Subprocess capability is unavailable', stdout: '', stderr: '', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
      const judged = judgeCommand(spec, raw, previous);
      const logTexts = [];
      for (const log of raw.logRefs ?? []) {
        try { logTexts.push(await this.files.readLog(log)); } catch (error) { logTexts.push(`Log import error: ${error.message ?? error}`); }
      }
      const logRef = await service.store.writeArtifact(runId, `logs/${executionId}/output.txt`, logTexts.length ? logTexts.join('\n') : `STDOUT\n${raw.stdout ?? ''}\nSTDERR\n${raw.stderr ?? ''}`);
      const resultRef = await service.store.writeArtifact(runId, `logs/${executionId}/result.json`, { spec: { ...spec, cwd }, raw, judged });
      const afterConfig = await this.config(await service.required(runId));
      const after = await this.snapshot(afterConfig, spec);
      const applicability = afterConfig.digest === config.digest && before.digest === after.digest ? 'current' : 'stale';
      const result = { ...judged, checkId: spec.id, executionId, requirementRevision: run.requirementRevision, baseline, inputFingerprint, codeFingerprint: after.digest, configDigest: config.digest, applicability, logRef, resultRef };
      // Log bodies stay in workspace artifacts; status and role context carry summaries and references.
      delete result.stdout; delete result.stderr; delete result.logRefs;
      await service.mutate(runId, 'check-result', (next) => {
        if (!baseline) for (const old of next.checkResults.filter((entry) => entry.checkId === spec.id && !entry.baseline && entry.applicability === 'current')) old.applicability = 'stale';
        const final = { ...result, applicability: next.requirementRevision === run.requirementRevision && next.status !== 'cancelled' ? applicability : 'stale' };
        next.checkResults.push(final);
        if (!next.checks.some((check) => check.id === spec.id && check.configDigest === config.digest && check.requirementRevision === run.requirementRevision)) next.checks.push({ ...spec, cwd, requirementRevision: run.requirementRevision, configDigest: config.digest });
        return { checkId: spec.id, outcome: final.outcome, applicability: final.applicability, logRef };
      });
      return result;
    } finally { this.activeChecks.delete(executionId); }
  }
  async checks(runId, phases = ['implementation', 'delivery'], refreshes = 0) {
    const service = this.service; let run = await service.required(runId); const config = await this.config(run);
    if (!config.checks.length) {
      await service.mutate(runId, 'checks-empty-config', (next) => {
        if (next.requirementRevision !== run.requirementRevision) return null;
        recordCheckFindings(next, config, phases); next.checkConfig = config;
        return { removedChecks: true };
      });
      await service.checkpoint(runId, 'paused', 'No machine checks configured. Add .review/config.json checks or start with checks.'); return false;
    }
    for (const spec of config.checks.filter((check) => phases.includes(check.phase))) {
      run = await service.required(runId); if (!['running', 'queued'].includes(run.status) || service.closing) return false;
      if (spec.onlyNewFailures && !await this.ensureCheckBaselines(runId, config)) return false;
      const before = await this.snapshot(config, spec); const digest = checkFingerprint(before, spec, config.digest);
      const latest = run.checkResults.findLast((result) => result.checkId === spec.id && !result.baseline && result.requirementRevision === run.requirementRevision);
      if (latest?.applicability === 'current' && latest.inputFingerprint === digest && latest.outcome === 'passed') continue;
      if (latest?.applicability === 'current' && latest.inputFingerprint !== digest) await service.mutate(runId, 'check-input-stale', (next) => {
        for (const entry of next.checkResults) if (entry.checkId === spec.id && !entry.baseline && entry.applicability === 'current') entry.applicability = 'stale';
        return { checkId: spec.id };
      });
      let result = await this.runCheck(runId, spec, config);
      if (result?.applicability === 'stale') {
        if (refreshes < 1) return this.checks(runId, phases, refreshes + 1);
        await service.checkpoint(runId, 'paused', `Check inputs keep changing: ${spec.id}`); return false;
      }
    }
    run = await service.required(runId);
    if ((await this.config(run)).digest !== config.digest) {
      if (refreshes < 1) return this.checks(runId, phases, refreshes + 1);
      await service.checkpoint(runId, 'paused', 'Check configuration keeps changing'); return false;
    }
    const failed = config.checks.filter((check) => check.required && phases.includes(check.phase)).filter((spec) => !run.checkResults.some((result) => result.checkId === spec.id && !result.baseline && result.applicability === 'current' && result.requirementRevision === run.requirementRevision && result.configDigest === config.digest && result.outcome === 'passed'));
    const references = await this.references(config, await this.snapshot(config), runId);
    const changed = await service.mutate(runId, 'checks-summary', (next) => {
      if (!['running', 'queued'].includes(next.status) || next.requirementRevision !== run.requirementRevision) return { failed: [], rework: false, stopped: true };
      next.workspace.referenceResults = references; next.checkConfig = config;
      recordCheckFindings(next, config, phases);
      const actionable = implementationFindings(next).filter((finding) => {
        if (finding.origin !== 'machine' || !config.checks.some((spec) => spec.id === finding.checkId && spec.required && phases.includes(spec.phase))) return false;
        const current = next.checkResults.findLast((entry) => entry.checkId === finding.checkId && !entry.baseline && entry.applicability === 'current' && entry.requirementRevision === next.requirementRevision && entry.configDigest === config.digest);
        return current?.outcome === 'failed';
      });
      if (actionable.length) scheduleRework(next, actionable, 'Required machine check failed');
      return { failed: failed.map((check) => check.id), rework: actionable.length > 0 };
    });
    if (changed.result.stopped) return false;
    if (changed.result.rework) { if (changed.run.status === 'waiting_user') await service.notify(runId); return false; }
    if (failed.length) { await service.checkpoint(runId, 'paused', `Required checks need attention: ${failed.map((check) => check.id).join(', ')}`); return false; }
    if (references.some((reference) => reference.outcome === 'failed')) { await service.checkpoint(runId, 'paused', 'Local references are missing; inspect workspace referenceResults'); return false; }
    return true;
  }
  async beforeVerify(runId) {
    const service = this.service;
    if (!await this.checks(runId, ['plan', 'implementation', 'delivery'])) return;
    const run = await service.required(runId); const config = await this.config(run); const snapshot = await this.snapshot(config);
    const reference = await service.store.writeArtifact(runId, `inputs/${run.requirementRevision}/verify-files-${randomUUID()}.json`, snapshot);
    await service.mutate(runId, 'verify-files', (next) => { next.workspace.verifyBeforeFingerprint = snapshot.digest; next.workspace.verifySnapshotRef = reference; return null; });
    await service.execute(runId, 'verify', 'verifier');
    const after = await this.snapshot(await this.config(await service.required(runId)));
    const current = await service.required(runId);
    const execution = current.executions.find((entry) => entry.executionId === current.activeExecutions['verify:verifier']);
    if (!execution || execution.workStatus !== 'completed' || !['running', 'queued'].includes(current.status)) return;
    if (snapshot.digest !== after.digest) {
      await service.mutate(runId, 'verify-code-changed', (next) => { next.executions.find((entry) => entry.executionId === execution.executionId).applicability = 'stale'; delete next.activeExecutions['verify:verifier']; return null; });
      await service.checkpoint(runId, 'paused', 'Project code changed during independent verification. Recheck before continuing.'); return;
    }
    const settled = await service.mutate(runId, 'verify-outcome', (next) => {
      if (!['running', 'queued'].includes(next.status) || next.requirementRevision !== current.requirementRevision) return { findingIds: [] };
      next.executions.find((entry) => entry.executionId === execution.executionId).codeFingerprint = after.digest;
      const findings = implementationFindings(next);
      if (findings.length || execution.reviewDecision !== 'accept') {
        if (findings.length) scheduleRework(next, findings, 'Independent verification found defects');
        else { next.status = 'paused'; next.diagnostic = 'Independent verification did not accept this implementation'; }
      }
      return { findingIds: findings.map((finding) => finding.id) };
    });
    if (settled.run.status === 'waiting_user') await service.notify(runId);
  }
  async deliveryReady(runId) {
    const service = this.service;
    if (!await this.checks(runId, ['plan', 'implementation', 'delivery'])) return false;
    const run = await service.required(runId); const config = await this.config(run);
    const snapshot = await this.snapshot(config);
    const verifier = run.executions.find((execution) => execution.executionId === run.activeExecutions['verify:verifier'] && execution.applicability === 'current');
    if (!verifier || verifier.workStatus !== 'completed' || verifier.reviewDecision !== 'accept' || verifier.codeFingerprint !== snapshot.digest) {
      await service.mutate(runId, 'delivery-verification-stale', (next) => { if (verifier) next.executions.find((entry) => entry.executionId === verifier.executionId).applicability = 'stale'; delete next.activeExecutions['verify:verifier']; next.status = 'paused'; next.diagnostic = 'Independent verification is missing or stale for current code'; return null; }); return false;
    }
    const tasks = currentTasks(run);
    if (!tasks.length || tasks.some((task) => task.workStatus !== 'completed')) { await service.checkpoint(runId, 'paused', 'Implementation tasks remain incomplete'); return false; }
    if (implementationFindings(run).length) { await service.checkpoint(runId, 'paused', 'Implementation findings remain open'); return false; }
    for (const spec of config.checks.filter((check) => check.required)) {
      const digest = checkFingerprint(await this.snapshot(config, spec), spec, config.digest);
      const current = run.checkResults.findLast((result) => result.checkId === spec.id && !result.baseline && result.requirementRevision === run.requirementRevision && result.applicability === 'current');
      if (!current || current.outcome !== 'passed' || current.inputFingerprint !== digest) { await service.checkpoint(runId, 'paused', `Required check is missing or stale: ${spec.id}`); return false; }
    }
    return true;
  }
  async inspectResume(runId) {
    const run = await this.service.required(runId); if (!run.workspace) return;
    const config = await this.config(run); const snapshot = await this.snapshot(config);
    const previous = JSON.parse(await this.service.store.readArtifact(runId, run.workspace.latestRef));
    const baseline = JSON.parse(await this.service.store.readArtifact(runId, run.workspace.baselineRef));
    const ref = await this.service.store.writeArtifact(runId, `inputs/${run.requirementRevision}/resume-files-${randomUUID()}.json`, snapshot);
    await this.service.mutate(runId, 'resume-files-inspected', (next) => {
      next.workspace.resumeDiff = snapshotDiff(previous, snapshot);
      next.workspace.resumeSnapshotRef = ref; next.workspace.resumeInspected = true;
      next.workspace.latestRef = ref; next.workspace.latestFingerprint = snapshot.digest; next.workspace.changes = snapshotDiff(baseline, snapshot);
      return { changed: next.workspace.resumeDiff.map((change) => change.path) };
    });
  }
  async reconcileRecovery(runId) {
    const service = this.service; const run = await service.required(runId); if (!run.workspace) return;
    const builder = run.executions.find((entry) => entry.executionId === run.activeExecutions['build:developer']);
    let snapshot; let latest; let baseline; let buildBefore;
    try {
      const config = await this.config(run); snapshot = await this.snapshot(config);
      latest = JSON.parse(await service.store.readArtifact(runId, run.workspace.latestRef));
      baseline = JSON.parse(await service.store.readArtifact(runId, run.workspace.baselineRef));
      if (builder?.workStatus === 'completed' && !builder.codeFingerprint && run.workspace.buildBeforeRef) buildBefore = JSON.parse(await service.store.readArtifact(runId, run.workspace.buildBeforeRef));
    } catch (error) {
      throw protocolError('DEVELOP_RECOVERY_INPUT_ERROR', `${error.code ?? (error instanceof SyntaxError ? 'INVALID_JSON' : 'PROJECT_READ_ERROR')}: ${error.message ?? error}`);
    }
    // Publication failures remain project storage failures and must propagate to the caller.
    const ref = await service.store.writeArtifact(runId, `inputs/${run.requirementRevision}/recovered-files-${randomUUID()}.json`, snapshot);
    const updated = await service.mutate(runId, 'recovery-files-inspected', (next) => {
      next.workspace.recoveryDiff = snapshotDiff(latest, snapshot);
      next.workspace.recoverySnapshotRef = ref; next.workspace.latestRef = ref; next.workspace.latestFingerprint = snapshot.digest;
      next.workspace.changes = snapshotDiff(baseline, snapshot);
      if (latest.digest !== snapshot.digest) for (const result of next.checkResults) if (!result.baseline) result.applicability = 'stale';
      if (buildBefore) {
        const changes = snapshotDiff(buildBefore, snapshot); const scopes = currentTasks(next).flatMap((task) => task.writeScopes);
        const outside = changes.filter((change) => !inScopes(change.path, scopes));
        next.executions.find((entry) => entry.executionId === builder.executionId).codeFingerprint = snapshot.digest;
        next.workspace.scopeWarnings = outside.map((change) => change.path);
        if (outside.length) { next.status = 'paused'; next.diagnostic = 'Recovered build changed files outside task write scopes'; }
      }
      const verifier = next.executions.find((entry) => entry.executionId === next.activeExecutions['verify:verifier'] && entry.applicability === 'current' && entry.workStatus === 'completed');
      if (verifier) {
        const verifiedCode = verifier.codeFingerprint ?? next.workspace.verifyBeforeFingerprint;
        if (verifiedCode !== snapshot.digest) { verifier.applicability = 'stale'; delete next.activeExecutions['verify:verifier']; next.status = 'paused'; next.diagnostic = 'Recovered verification refers to older project files'; }
        else {
          verifier.codeFingerprint = snapshot.digest;
          const findings = implementationFindings(next);
          if (findings.length && ['running', 'queued'].includes(next.status)) scheduleRework(next, findings, 'Recovered verification requires rework');
        }
      }
      return { changed: next.workspace.recoveryDiff.map((change) => change.path) };
    });
    if (updated.run.status === 'waiting_user') await service.notify(runId);
  }
  async dispose() {
    this.closed = true;
    const active = [...this.activeChecks.values()];
    for (const entry of active) entry.controller.abort();
    await Promise.all(active.map((entry) => entry.done));
  }
}
