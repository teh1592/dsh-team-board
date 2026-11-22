export class DshCommandRunner {
  constructor(subprocess) { this.subprocess = subprocess; this.active = new Set(); }
  async run(spec, signal) {
    if (!Array.isArray(spec.argv) || spec.argv.length === 0 || spec.argv.some((part) => typeof part !== 'string' || !part)) throw new Error('Command requires a complete argv array');
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let handle;
    let timedOut = false;
    let timer;
    try {
      const executable = await this.subprocess.resolveExecutable(spec.argv[0], spec.env, controller.signal);
      handle = this.subprocess.spawn({ argv: [executable, ...spec.argv.slice(1)], cwd: spec.cwd, graceMs: 1000, signal: controller.signal, ...(spec.env ? { env: spec.env } : {}), stdio: { stdin: 'ignore', stdout: { maxBytes: 65536, spill: { maxBytes: 1048576 } }, stderr: { maxBytes: 65536, spill: { maxBytes: 1048576 } } } });
      this.active.add(handle);
      timer = setTimeout(() => { timedOut = true; handle.terminate(); }, spec.timeoutMs ?? 180000);
      const outcome = await handle.done;
      await handle.waitForExit();
      const stdout = handle.collected.stdout?.readFrom(0);
      const stderr = handle.collected.stderr?.readFrom(0);
      return { checkId: spec.id, outcome: timedOut || controller.signal.aborted || outcome.exitCode === null ? 'unknown' : outcome.exitCode === 0 ? 'passed' : 'failed', exitCode: outcome.exitCode, signal: outcome.signal ?? null, timedOut, stdout: stdout?.text ?? '', stderr: stderr?.text ?? '', truncated: Boolean(stdout?.lossy || stderr?.lossy), logRefs: [stdout?.spillPath, stderr?.spillPath].filter(Boolean), startedAt, endedAt: new Date().toISOString() };
    } catch (error) {
      if (handle) { handle.terminate(); await handle.waitForExit(); }
      return { checkId: spec.id, outcome: 'unknown', exitCode: null, reason: error.code === 'ENOENT' || /not found|not installed|找不到/i.test(error.message ?? '') ? 'tool-missing' : controller.signal.aborted ? 'cancelled' : 'execution-error', summary: String(error.message ?? error), startedAt, endedAt: new Date().toISOString() };
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); if (handle) this.active.delete(handle);
    }
  }
  async dispose() {
    const handles = [...this.active];
    const outcomes = await Promise.allSettled(handles.map(async (handle) => { try { handle.terminate(); } finally { await handle.waitForExit(); } }));
    const errors = outcomes.filter((entry) => entry.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map((entry) => entry.reason), 'Command cleanup failed');
  }
}
