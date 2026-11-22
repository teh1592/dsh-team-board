import { protocolError, validate, checkSpecSchema } from './schemas.mjs';
import { fingerprint } from './state.mjs';
export function normalizeChecks(checks = []) {
  const ids = new Set();
  return checks.map((check) => {
    const spec = { kind: 'command', phase: 'implementation', required: true, parser: 'exit-code', cwd: '.', timeoutMs: 180000, inputs: [], outputs: [], taskIds: [], onlyNewFailures: false, ...check };
    validate(checkSpecSchema, spec);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(spec.id) || ids.has(spec.id)) throw protocolError('INVALID_CHECK_ID', spec.id);
    ids.add(spec.id);
    if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.argv.length === 0 || spec.argv.some((part) => !part.trim())) throw protocolError('INVALID_CHECK_SPEC', spec.id);
    if (spec.kind === 'test' && spec.parser !== 'node-test') throw protocolError('INVALID_CHECK_PARSER', spec.id);
    if (spec.onlyNewFailures && spec.parser !== 'node-test') throw protocolError('INVALID_BASELINE_PARSER', spec.id);
    if (spec.outputs.some((output) => !output.trim() || ['.', '/', '**', '**/*', '.review/', '.review/config.json', 'package.json'].includes(output) || output.includes('..'))) throw protocolError('INVALID_CHECK_OUTPUTS', spec.id);
    return spec;
  });
}
export function globMatches(file, glob) {
  const normalized = glob.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.endsWith('/')) return file === normalized.slice(0, -1) || file.startsWith(normalized);
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replaceAll('\u0001', '(?:.*/)?').replaceAll('\u0002', '.*');
  return new RegExp(`^${escaped}$`).test(file) || file.startsWith(`${normalized}/`);
}
export function inScopes(file, scopes) { return scopes.some((scope) => globMatches(file, scope)); }
export function snapshotDiff(before, after) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort().filter((file) => before.files[file]?.digest !== after.files[file]?.digest).map((file) => ({ path: file, kind: !before.files[file] ? 'added' : !after.files[file] ? 'deleted' : 'modified', before: before.files[file]?.digest ?? null, after: after.files[file]?.digest ?? null }));
}
export function checkFingerprint(snapshot, spec, configDigest) { return fingerprint({ files: snapshot.digest, spec, configDigest }); }
export function parseNodeTests(text) {
  const number = (name) => {
    const values = [...text.matchAll(new RegExp(`(?:#|ℹ)\\s*${name}\\s+(\\d+)`, 'g'))];
    return values.length ? Number(values.at(-1)[1]) : undefined;
  };
  const tests = number('tests'); const fail = number('fail'); const pass = number('pass');
  const failures = [...text.matchAll(/^\s*(?:not ok\s+\d+\s*-?\s*|✖\s+)(.+)$/gm)].map((match) => match[1].replace(/\s*\([\d.]+ms\).*$/, '').trim());
  return { parsed: tests !== undefined && fail !== undefined, tests: tests ?? null, pass: pass ?? null, fail: fail ?? null, failures: [...new Set(failures)] };
}
export function judgeCommand(spec, raw, baseline) {
  if (raw.outcome === 'unknown') return { ...raw, reason: raw.reason ?? (raw.timedOut ? 'timeout' : 'execution-unknown'), summary: raw.summary ?? (raw.timedOut ? 'Command timed out' : 'Command did not complete') };
  if (spec.parser === 'exit-code') return { ...raw, reason: raw.exitCode === 0 ? 'exit-zero' : 'exit-nonzero', summary: `Exit ${raw.exitCode}` };
  const parsed = parseNodeTests(`${raw.stdout}\n${raw.stderr}`);
  if (!parsed.parsed) return { ...raw, outcome: 'unknown', reason: raw.truncated ? 'truncated-test-output' : 'test-output-unparsed', summary: 'Node test summary is missing', testSummary: parsed };
  if (parsed.tests === 0) return { ...raw, outcome: 'failed', reason: 'zero-tests', summary: 'Node discovered zero tests; check test paths and discovery rules', testSummary: parsed };
  const addedFailures = baseline?.testSummary ? parsed.failures.filter((failure) => !baseline.testSummary.failures.includes(failure)) : parsed.failures;
  const knownOnly = spec.onlyNewFailures && baseline?.testSummary?.parsed && parsed.fail > 0 && parsed.failures.length >= parsed.fail && addedFailures.length === 0;
  return { ...raw, outcome: knownOnly || raw.exitCode === 0 && parsed.fail === 0 ? 'passed' : 'failed', reason: knownOnly ? 'known-baseline-failures' : parsed.fail === 0 && raw.exitCode === 0 ? 'tests-passed' : 'tests-failed', summary: `${parsed.tests} tests, ${parsed.fail} failures${knownOnly ? ' (all present in baseline)' : ''}`, testSummary: parsed, baselineFailures: baseline?.testSummary?.failures ?? [], addedFailures };
}
export function currentDecisions(run) {
  return run.decisions.filter((decision) => decision.applicability !== 'stale' && (decision.requirementRevision === run.requirementRevision || decision.reusedForRevision === run.requirementRevision));
}
export function currentTasks(run) {
  const decisions = new Set(currentDecisions(run).map((decision) => decision.id));
  return run.tasks.filter((task) => task.applicability !== 'stale' && task.decisionIds.some((id) => decisions.has(id)));
}
