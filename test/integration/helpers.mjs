import { mkdtemp, readFile, writeFile, mkdir, stat, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { FileRunStore } from '../../host/dsh/file-store.mjs';
// Test implementation of the inspected fs seam, including version guards and atomic replacement.
export async function testStore() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
  const version = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
  let beforePublish;
  const fs = {
    async resolve(name, options = {}) { const full = path.resolve(options.cwd ?? projectRoot, name); return { targetKey: full, displayPath: full }; },
    processPath(target) { return target.targetKey; },
    contains(parent, child) { const relative = path.relative(parent.targetKey, child.targetKey); return !relative.startsWith('..') && !path.isAbsolute(relative); },
    async stat(target) { try { const info = await stat(target.targetKey); return { type: info.isDirectory() ? 'directory' : 'file', version: info.isDirectory() ? 'directory' : await version(target.targetKey) }; } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } },
    async readText(target) { return readFile(target.targetKey, 'utf8'); },
    async writeText(target, text, expected) {
      if (beforePublish) { const hook = beforePublish; beforePublish = undefined; await hook(target); }
      const current = await fs.stat(target);
      if (expected?.kind === 'createIfAbsent' && current || expected?.kind === 'replaceIfVersion' && current?.version !== expected.version) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' });
      await mkdir(path.dirname(target.targetKey), { recursive: true });
      const temporary = `${target.targetKey}.${randomUUID()}.tmp`;
      await writeFile(temporary, text);
      // Windows may briefly deny replacement while another test reader closes its handle.
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, target.targetKey); break; }
        catch (error) { if (!['EPERM', 'EACCES'].includes(error.code) || attempt >= 5) throw error; await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1))); }
      }
      return { version: await version(target.targetKey), operation: current ? 'update' : 'create', after: text, before: null };
    },
    async listDir(target) { return Promise.all((await readdir(target.targetKey, { withFileTypes: true })).map(async (entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', target: await fs.resolve(entry.name, { cwd: target.targetKey }) }))); },
  };
  return { store: new FileRunStore(fs, projectRoot), fs, projectRoot, setBeforePublish(hook) { beforePublish = hook; }, async cleanup() { await rm(projectRoot, { recursive: true, force: true }); } };
}
export function deferred() { return Promise.withResolvers(); }
export function automaticAgents({ failRole, hold, questions = false } = {}) {
  const calls = []; const handles = [];
  const runner = {
    calls, handles,
    async start(spec) {
      calls.push(spec);
      const childId = `child-${spec.executionId}`;
      const pending = deferred();
      const data = JSON.parse(spec.prompt.split('身份：')[1].split('\n\n')[0]);
      const findings = spec.stageId === 'review' ? [{ id: 'F-1', severity: 'medium', description: 'Handle timeout', basis: 'API requirement' }] : [];
      let result;
      if (spec.stageId === 'intake') result = { summary: 'Clear requirement', acceptance: ['Timeout is handled'], questions: [] };
      if (spec.stageId === 'review') result = { decision: 'needs_revision', summary: `${spec.role} reviewed`, findings, risks: ['Timeout may leave pending state'], tests: ['Timeout and cancellation test'] };
      if (spec.stageId === 'decide') {
        const inputs = spec.inputs;
        const ask = questions && !inputs.questions.some((question) => question.status === 'answered');
        result = { summary: 'Add timeout handling', decisions: ask ? [] : [{ id: 'D-1', findingIds: inputs.findings.map((f) => f.id), choice: 'adopt', reason: 'Match requirement and preserve errors', implementation: { objective: 'Implement timeout', acceptance: ['Timeout clears pending state'], writeScopes: ['src/api/'] }, checks: ['Test timeout', 'Test cancellation'] }], questions: ask ? [{ id: 'Q-1', question: 'Choose timeout behavior', findingIds: inputs.findings.map((f) => f.id), options: [{ id: 'retry', label: 'Retry', description: 'One retry' }, { id: 'stop', label: 'Stop', description: 'Return error' }] }] : [] };
      }
      const handle = { childId, result: pending.promise, async cancel() { handle.cancelled = true; pending.resolve({ raw: { output: [], stopReason: 'aborted' } }); }, cancelled: false, resolve: pending.resolve };
      handles.push(handle);
      if (hold?.(spec)) return handle;
      if (spec.role === failRole || Array.isArray(failRole) && failRole.includes(spec.role)) pending.resolve({ raw: { output: [], stopReason: 'error', diagnostic: 'provider unavailable' } });
      else pending.resolve({ raw: { output: [], structured: { ...data, result }, stopReason: 'completed' }, envelope: { ...data, result } });
      return handle;
    },
    async recover() { return { kind: 'interrupted', diagnostic: 'No saved output' }; },
    async stopRecovered() {},
  };
  return runner;
}
