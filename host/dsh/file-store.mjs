import { applyOperation } from '../../src/review/state.mjs';
import { protocolError, validateRun } from '../../src/review/schemas.mjs';

const safeId = (id) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw protocolError('INVALID_ID', String(id));
  return id;
};
const safeRef = (ref) => {
  if (typeof ref !== 'string' || ref.includes('\\') || ref.startsWith('/') || ref.split('/').some((part) => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9_.@-]+$/.test(part))) throw protocolError('INVALID_REFERENCE', String(ref));
  return ref;
};
/** Workspace-owned storage; fs owns canonical containment, atomic publication and version guards. */
export class FileRunStore {
  constructor(fs, projectRoot) { this.fs = fs; this.projectRoot = projectRoot; this.queues = new Map(); this.diagnostics = new Map(); }
  async projectIdentity() {
    const target = await this.fs.resolve(this.projectRoot);
    return { projectRoot: this.fs.processPath(target), projectKey: target.targetKey };
  }
  async target(relative) {
    const root = await this.fs.resolve(this.projectRoot);
    const target = await this.fs.resolve(relative, { cwd: this.projectRoot });
    if (!this.fs.contains(root, target)) throw protocolError('PATH_OUTSIDE_PROJECT', relative);
    return target;
  }
  path(runId, ref = 'run.json') { return `.review/runs/${safeId(runId)}/${safeRef(ref)}`; }
  async initialize() {
    const target = await this.target('.review/.gitignore');
    const current = await this.fs.stat(target);
    if (!current) { await this.fs.writeText(target, 'runs/\n', { kind: 'createIfAbsent' }); return; }
    const text = await this.fs.readText(target);
    if (!text.split(/\r?\n/).includes('runs/')) await this.fs.writeText(target, `${text.trimEnd()}\nruns/\n`, { kind: 'replaceIfVersion', version: current.version });
  }
  async readVersioned(runId) {
    const target = await this.target(this.path(runId));
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.fs.stat(target);
      if (!before) return undefined;
      const text = await this.fs.readText(target);
      const after = await this.fs.stat(target);
      if (after?.version === before.version) return { run: validateRun(JSON.parse(text)), version: before.version, target };
    }
    throw protocolError('REVISION_CONFLICT', `run ${runId} changed while reading`);
  }
  async load(runId) {
    safeId(runId);
    try {
      const run = (await this.readVersioned(runId))?.run;
      this.diagnostics.delete(runId);
      return run;
    } catch (error) {
      const diagnostic = { runId, code: error.code ?? (error instanceof SyntaxError ? 'INVALID_JSON' : 'RUN_READ_ERROR'), message: String(error.message ?? error), recordRef: this.path(runId), observedAt: new Date().toISOString() };
      this.diagnostics.set(runId, diagnostic);
      throw protocolError('RUN_READ_ERROR', `Run ${runId}: ${diagnostic.code}: ${diagnostic.message}`, diagnostic);
    }
  }
  async readDiagnostic(runId) {
    try { await this.load(runId); } catch (error) { if (error.code !== 'RUN_READ_ERROR') throw error; }
    return structuredClone(this.diagnostics.get(runId));
  }
  async listDiagnostics() { await this.list(); return [...this.diagnostics.values()].map((entry) => structuredClone(entry)); }
  async create(run) {
    validateRun(run);
    const target = await this.target(this.path(run.runId));
    await this.fs.writeText(target, `${JSON.stringify(run, null, 2)}\n`, { kind: 'createIfAbsent' });
    return structuredClone(run);
  }
  async serial(runId, action) {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    this.queues.set(runId, task);
    try { return await task; } finally { if (this.queues.get(runId) === task) this.queues.delete(runId); }
  }
  async commit(runId, expectedRevision, operation) {
    return this.serial(runId, async () => {
      const current = await this.readVersioned(runId);
      if (!current) throw protocolError('RUN_NOT_FOUND', runId);
      const result = applyOperation(current.run, expectedRevision, operation);
      if (!result.replayed) {
        try {
          await this.fs.writeText(current.target, `${JSON.stringify(result.run, null, 2)}\n`, { kind: 'replaceIfVersion', version: current.version });
        } catch (error) {
          if (error.code === 'FS_STALE_VERSION') throw protocolError('REVISION_CONFLICT', `run ${runId} changed before publication`, { currentRevision: (await this.load(runId))?.revision });
          throw error;
        }
      }
      return result;
    });
  }
  async writeArtifact(runId, ref, value) {
    const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    const target = await this.target(this.path(runId, ref));
    const exists = await this.fs.stat(target);
    if (exists) {
      if (await this.fs.readText(target) !== text) throw protocolError('ARTIFACT_CONFLICT', ref);
    } else await this.fs.writeText(target, text, { kind: 'createIfAbsent' });
    return ref;
  }
  async readArtifact(runId, ref) { return this.fs.readText(await this.target(this.path(runId, ref))); }
  async list() {
    const target = await this.target('.review/runs');
    if (!await this.fs.stat(target)) return [];
    const entries = await this.fs.listDir(target);
    const runs = [];
    const runIds = new Set();
    for (const entry of entries) {
      if (entry.type !== 'directory' || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
      runIds.add(entry.name);
      try { const run = await this.load(entry.name); if (run) runs.push(run); }
      catch (error) { if (error.code !== 'RUN_READ_ERROR') throw error; }
    }
    for (const runId of this.diagnostics.keys()) if (!runIds.has(runId)) this.diagnostics.delete(runId);
    return runs;
  }
  async writeReport(runId, revision, markdown) {
    // A versioned report is the state reference. report.md is a convenience view regenerated from run.json.
    const ref = await this.writeArtifact(runId, `reports/report-${revision}.md`, markdown);
    const target = await this.target(this.path(runId, 'report.md'));
    const info = await this.fs.stat(target);
    await this.fs.writeText(target, markdown, info ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' });
    return ref;
  }
}
