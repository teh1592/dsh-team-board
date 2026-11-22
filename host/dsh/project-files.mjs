import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { fingerprint } from '../../src/review/state.mjs';
import { globMatches, normalizeChecks, snapshotDiff } from '../../src/review/checks.mjs';
import { protocolError, validate, projectConfigSchema } from '../../src/review/schemas.mjs';
const dependencyFiles = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']);
const defaultExclude = ['.git/', 'node_modules/', '.review/runs/', '.cache/', '.pnpm-store/', '__pycache__/'];
export class DshProjectFiles {
  constructor(fs, projectRoot) { this.fs = fs; this.projectRoot = projectRoot; }
  async target(file) {
    const root = await this.fs.resolve(this.projectRoot); const target = await this.fs.resolve(file, { cwd: this.projectRoot });
    if (!this.fs.contains(root, target)) throw protocolError('PATH_OUTSIDE_PROJECT', file);
    return target;
  }
  async read(file) { const target = await this.target(file); return await this.fs.stat(target) ? this.fs.readText(target) : undefined; }
  async configuration(overrides) {
    const text = await this.read('.review/config.json');
    const config = text ? JSON.parse(text) : { schemaVersion: 1, checks: [] };
    validate(projectConfigSchema, config);
    const checks = normalizeChecks(overrides ?? config.checks);
    if (!Number.isSafeInteger(config.maxReworks ?? 2) || (config.maxReworks ?? 2) < 0) throw protocolError('INVALID_REWORK_LIMIT', 'maxReworks must be a nonnegative safe integer');
    return { checks, references: config.references ?? [], source: overrides ? 'request' : '.review/config.json', digest: fingerprint({ checks, references: config.references ?? [] }), maxReworks: config.maxReworks ?? 2 };
  }
  async snapshot({ inputs = [], outputs = [] } = {}) {
    const files = {}; let bytes = 0; const excluded = [...defaultExclude, ...outputs];
    const root = await this.target('.'); const visited = new Set();
    const walk = async (target, relative = '') => {
      if (visited.has(target.targetKey)) return; visited.add(target.targetKey);
      for (const entry of await this.fs.listDir(target)) {
        const file = `${relative}${entry.name}`;
        if (excluded.some((glob) => globMatches(file, glob))) continue;
        if (!this.fs.contains(root, entry.target)) throw protocolError('PATH_OUTSIDE_PROJECT', file);
        const lstat = this.fs.lstat ? await this.fs.lstat(file, { cwd: this.projectRoot }) : undefined;
        if (lstat?.type === 'symlink') throw protocolError('PROJECT_SYMLINK', file);
        if (entry.type === 'directory') { await walk(entry.target, `${file}/`); continue; }
        if (entry.type !== 'file' || inputs.length && !inputs.some((glob) => globMatches(file, glob)) && file !== '.review/config.json' && !dependencyFiles.has(entry.name)) continue;
        if (Object.keys(files).length >= 20000) throw protocolError('SNAPSHOT_LIMIT', 'More than 20000 project files');
        const before = await this.fs.stat(entry.target);
        const content = this.fs.readBytes ? await this.fs.readBytes(entry.target, undefined, 67108864) : Buffer.from(await this.fs.readText(entry.target));
        const after = await this.fs.stat(entry.target);
        if (before?.version !== after?.version) throw protocolError('PROJECT_CHANGED', file);
        bytes += content.length; if (bytes > 268435456) throw protocolError('SNAPSHOT_LIMIT', 'Project input exceeds 256 MiB');
        files[file] = { digest: createHash('sha256').update(content).digest('hex'), size: content.length };
      }
    };
    await walk(root);
    return { digest: fingerprint(files), files, bytes, takenAt: new Date().toISOString(), inputs, outputs };
  }
  diff(before, after) { return snapshotDiff(before, after); }
  async readLog(file) { return this.fs.readText(await this.fs.resolve(file)); }
  async cwd(relative = '.') { return this.fs.processPath(await this.target(relative)); }
  async references(references, snapshot) {
    const entries = [];
    const packageText = await this.read('package.json'); const manifest = packageText ? JSON.parse(packageText) : {};
    for (const reference of references) {
      if (reference.kind === 'planned') { entries.push({ ...reference, outcome: 'skipped', reason: 'planned-interface' }); continue; }
      const specifier = reference.target;
      if (specifier.startsWith('node:') || builtinModules.includes(specifier)) { entries.push({ ...reference, outcome: 'passed', reason: 'node-builtin' }); continue; }
      if (specifier.startsWith('.') || /\.[cm]?[jt]sx?$/.test(specifier) || /^(src|test|tests|lib|app|packages|docs)\//.test(specifier) || specifier.includes('/') && Object.hasOwn(snapshot.files, specifier)) {
        const local = specifier.replace(/^\.\//, ''); const text = await this.read(local);
        const exists = text !== undefined && (!reference.symbol || text.includes(reference.symbol));
        entries.push({ ...reference, outcome: exists ? 'passed' : 'failed', reason: exists ? 'local-reference' : 'local-reference-missing' }); continue;
      }
      const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) throw protocolError('INVALID_PACKAGE_REFERENCE', packageName);
      const declared = manifest.dependencies?.[packageName] ?? manifest.devDependencies?.[packageName] ?? manifest.peerDependencies?.[packageName];
      const workspace = [];
      for (const file of Object.keys(snapshot.files).filter((file) => file.endsWith('package.json'))) {
        try { const body = JSON.parse(await this.read(file)); if (body.name === packageName) workspace.push(file); } catch { /* A malformed package is reported by its project checks. */ }
      }
      const installed = await this.read(`node_modules/${packageName}/package.json`);
      entries.push({ ...reference, outcome: installed || workspace.length ? 'passed' : 'unknown', reason: installed ? 'installed-package' : workspace.length ? 'workspace-package' : declared ? 'declared-package-needs-registry' : 'external-package-needs-registry', packageName, declared: declared ?? null });
    }
    return entries;
  }
}
