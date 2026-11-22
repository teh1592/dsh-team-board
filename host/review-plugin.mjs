import { FileRunStore } from './dsh/file-store.mjs';
import { DshAgentRunner } from './dsh/agent-runner.mjs';
import { DshCommandRunner } from './dsh/command-runner.mjs';
import { DshNotifier } from './dsh/notifier.mjs';
import { registerReviewTools, submitDefinition } from './dsh/tools.mjs';
import { registerReviewCommand } from './dsh/commands.mjs';
import { ReviewService } from './review-service.mjs';
import { sessionIndexDefinition } from './dsh/session-index.mjs';
import { DshProjectFiles } from './dsh/project-files.mjs';
import { registerReviewRoute } from './dsh/review-route.mjs';
import { createHistoryReader } from './dsh/history.mjs';
import { runSummary } from '../src/review/report.mjs';

const REVIEW_DEPENDENCIES = ['tools', 'fs', 'subagents', 'agents', 'workingDirectory'];

export function installStageToolPolicy(ctx, agent, stageId) {
  const readable = /^(read|read_image|glob|grep|skill|research|web_fetch|web_search|advanced_search|multi_search|platform_search|domain_search|cache_search|list_mcp_resources|list_mcp_resource_templates|read_mcp_resource|cordis_inspect_list|cordis_inspect_query)$/;
  const writable = /^(write|edit|str_replace_editor|pwsh|bash|terminal|working_directory)$/;
  const allowed = (name) => readable.test(name) || stageId === 'build' && writable.test(name);
  const transport = new Set(['review_submit', 'structured_output', 'run_code']);
  const disposers = [];
  const cleanup = () => {
    const errors = [];
    for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Stage tool policy cleanup failed');
  };
  try {
    for (const { name } of ctx.tools.definitions(agent)) {
      if (allowed(name) || transport.has(name)) continue;
      try { disposers.push(agent.ctx.tools.restrict({ deny: [name] })); }
      catch (error) {
        // Own tools are exempt from restriction. The public guard still denies them.
        if (!String(error.message ?? '').startsWith(`tools.restrict() names unknown global tool ${JSON.stringify(name)}; known global tools:`)) throw error;
      }
    }
    disposers.push(agent.ctx.tools.guard((execution) => allowed(execution.name) || transport.has(execution.name) ? undefined : 'This stage uses only its role tools; orchestration is managed by the review runner.'));
    return cleanup;
  } catch (error) {
    try { cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Stage tool policy setup failed'); }
    throw error;
  }
}

/** Keep the historical board active while Cordis owns review dependency readiness and withdrawal. */
export function installReview(ctx, options = {}) {
  if (typeof ctx.inject === 'function') {
    try {
      const fiber = ctx.inject(REVIEW_DEPENDENCIES, (scoped) => mountReview(scoped, options));
      return () => typeof fiber === 'function' ? fiber() : fiber?.dispose();
    } catch {
      // Non-Cordis embedding contexts may expose an unsupported injection stub.
    }
  }
  // Lightweight callers without Cordis injection can mount an already-ready scope.
  return mountReview(ctx, options);
}

function mountReview(ctx, { enabled = () => true, stageTimeoutMs = 1200000 } = {}) {
  const optional = (name) => { try { return ctx.get(name); } catch { return undefined; } };
  const fs = optional('fs'); const subagents = optional('subagents'); const agents = optional('agents');
  const workingDirectory = optional('workingDirectory');
  if (!fs || !subagents || !agents || !workingDirectory) return undefined;
  const managed = new Map(); const services = new Map(); const serviceInstances = new Set(); const childDisposers = new Map(); const archived = new Set();
  let closed = false;
  const warn = (error) => { try { const logger = typeof ctx.logger === 'function' ? ctx.logger('review') : ctx.logger; logger?.warn?.(error); } catch { /* Diagnostics must not reject a detached cleanup chain. */ } };
  const indexReady = optional('sessionProjections')?.register(sessionIndexDefinition);
  indexReady?.catch(warn);
  const recovering = new WeakMap();
  const prepared = new WeakSet();
  const prepare = async (pending, readOnly) => {
    const service = await pending;
    if (closed) throw new Error('Review plugin is unloading');
    if (!readOnly && !prepared.has(service)) {
      let ready = recovering.get(service);
      if (!ready) {
        ready = service.recover().then(() => { prepared.add(service); }); recovering.set(service, ready);
        ready.finally(() => recovering.delete(service)).catch(warn);
      }
      await ready;
    }
    return service;
  };
  const resolveService = async (agent, runId, fixedRoot, { readOnly = false } = {}) => {
    if (closed) throw new Error('Review plugin is unloading');
    const indexed = runId && indexReady ? (await indexReady).stateOf(agent.session)[runId] : undefined;
    const root = fixedRoot ?? indexed ?? workingDirectory.get(agent.session);
    if (runId && !indexed && !fixedRoot) {
      for (const pending of services.values()) {
        const service = await pending;
        try { if (await service.store.load(runId)) return prepare(service, readOnly); }
        catch (error) { if (error.code === 'RUN_READ_ERROR') return prepare(service, readOnly); throw error; }
      }
    }
    const rootTarget = await fs.resolve(root);
    const key = rootTarget.targetKey;
    if (!services.has(key)) {
      const promise = (async () => {
        const service = new ReviewService({
          store: new FileRunStore(fs, fs.processPath(rootTarget)),
          projectFiles: new DshProjectFiles(fs, fs.processPath(rootTarget)),
          agentRunner: new DshAgentRunner(subagents, agents, optional('sessionQuery'), managed),
          notifier: new DshNotifier(agents),
          commandRunner: optional('subprocess') ? new DshCommandRunner(optional('subprocess')) : undefined,
          isRootOnline: (sessionId) => Boolean(agents.get(sessionId)) && !archived.has(sessionId), stageTimeoutMs,
        });
        serviceInstances.add(service);
        return service;
      })();
      services.set(key, promise);
      promise.catch(() => { if (services.get(key) === promise) services.delete(key); });
    }
    return prepare(services.get(key), readOnly);
  };
  const visible = (agent) => !closed && !managed.has(agent.id) && enabled();
  const disposers = [registerReviewTools(ctx, (agent, runId, options) => resolveService(agent, runId, undefined, options), visible)];
  const listRuns = async (agent, cursor = 0) => {
    const roots = new Set([workingDirectory.get(agent.session)]);
    if (indexReady) for (const root of Object.values((await indexReady).stateOf(agent.session))) roots.add(root);
    const found = new Map(); const errors = [];
    for (const root of roots) {
      try {
        const service = await resolveService(agent, undefined, root, { readOnly: true });
        for (const run of (await service.store.list()).filter((run) => run.rootSessionId === agent.id)) found.set(run.runId, { ...runSummary(run), mode: run.mode, preset: run.preset, requirementRevision: run.requirementRevision, updatedAt: run.updatedAt });
        for (const diagnostic of await service.store.listDiagnostics()) errors.push({ projectRoot: root, message: `${diagnostic.runId}: ${diagnostic.message}` });
      } catch (error) { errors.push({ projectRoot: root, message: String(error.message ?? error) }); }
    }
    const items = [...found.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.runId.localeCompare(b.runId));
    const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    return { items: items.slice(offset, offset + 20), total: items.length, nextCursor: offset + 20 < items.length ? offset + 20 : null, errors };
  };
  const commands = optional('commands');
  if (commands) {
    disposers.push(registerReviewCommand(commands, async (agent, runId, options) => {
      if (!visible(agent)) throw new Error('Enable the team-board plugin switch before starting review');
      return resolveService(agent, runId, undefined, options);
    }, { readHistory: createHistoryReader(optional('agentTeams')), listRuns, checkCaller: (agent) => { if (!visible(agent) || !agents.roots().some((root) => root === agent)) throw new Error('Review commands require an enabled plugin and the exact live root Agent'); } }));
    const route = registerReviewRoute(ctx, commands, agents); if (route) disposers.push(route);
  }
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('agent/created', async ({ agent }) => {
      const spec = managed.get(agent.id);
      if (spec) {
        const service = await resolveService(agents.get(spec.rootSessionId), spec.runId, spec.projectRoot, { readOnly: true });
        await service.mutate(spec.runId, 'child-identified', (run) => {
          const execution = run.executions.find((entry) => entry.executionId === spec.executionId);
          if (execution) execution.childSessionId = agent.id;
          return { executionId: spec.executionId, childSessionId: agent.id };
        });
        const childCtx = agent.ctx;
        const policy = installStageToolPolicy(ctx, agent, spec.stageId);
        const submit = childCtx.tools.register(submitDefinition(service, spec.runId, spec.executionId, agent.id));
        const cleanup = () => {
          const failures = [];
          for (const dispose of [submit, policy]) { try { dispose(); } catch (error) { failures.push(error); } }
          childDisposers.delete(agent.id);
          if (failures.length) throw new AggregateError(failures, 'Review child scope cleanup failed');
        };
        childDisposers.set(agent.id, cleanup);
      } else if (agents.roots().some((entry) => entry === agent)) {
        archived.delete(agent.id);
        // Only setup and persisted recovery are awaited here; model work stays in the background runner.
        await resolveService(agent);
        if (indexReady) for (const projectRoot of new Set(Object.values((await indexReady).stateOf(agent.session)))) await resolveService(agent, undefined, projectRoot);
        for (const pending of services.values()) await (await pending).rootAvailable(agent.id);
      }
      return undefined;
    }));
    disposers.push(ctx.on('agent/disposed', ({ agent }) => {
      childDisposers.get(agent.id)?.();
      for (const promise of services.values()) promise.then((service) => service.rootUnavailable(agent.id)).catch(warn);
    }));
    disposers.push(ctx.on('workspace/session-stop', async ({ sessionId }) => {
      archived.add(sessionId);
      for (const promise of services.values()) await (await promise).rootUnavailable(sessionId);
    }));
  }
  // Hot installation also initializes already-live roots without introducing a foreground dependency.
  for (const agent of agents.roots()) {
    (async () => {
      await resolveService(agent);
      if (indexReady) for (const projectRoot of new Set(Object.values((await indexReady).stateOf(agent.session)))) await resolveService(agent, undefined, projectRoot);
      for (const pending of services.values()) await (await pending).rootAvailable(agent.id);
    })().catch(warn);
  }
  let disposal;
  return () => {
    closed = true;
    for (const service of serviceInstances) service.closing = true;
    return disposal ??= (async () => {
      const outcomes = await Promise.allSettled([
        ...disposers.slice().reverse().map((dispose) => Promise.resolve().then(dispose)),
        ...[...childDisposers.values()].map((cleanup) => Promise.resolve().then(cleanup)),
        ...(indexReady ? [Promise.resolve(indexReady).then((handle) => handle.dispose())] : []),
        ...services.values(),
        ...[...serviceInstances].map((service) => Promise.resolve().then(() => service.dispose())),
      ]);
      const failures = outcomes.filter((entry) => entry.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), 'Review cleanup failed');
    })();
  };
}
