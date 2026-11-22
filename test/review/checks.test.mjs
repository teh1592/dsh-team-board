import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChecks, judgeCommand, parseNodeTests, globMatches, snapshotDiff } from '../../src/review/checks.mjs';
const spec = normalizeChecks([{ id: 'tests', kind: 'test', argv: ['node', '--test'], parser: 'node-test' }])[0];
const raw = (stdout, exitCode = 0) => ({ outcome: exitCode === 0 ? 'passed' : 'failed', exitCode, stdout, stderr: '' });
test('node parser distinguishes passed, zero tests, failures, missing summary and known baseline differences', () => {
  assert.equal(judgeCommand(spec, raw('# tests 0\n# pass 0\n# fail 0')).reason, 'zero-tests');
  assert.equal(judgeCommand(spec, raw('# tests 2\n# pass 2\n# fail 0')).outcome, 'passed');
  assert.equal(judgeCommand(spec, raw('tool missing')).outcome, 'unknown');
  const failing = raw('not ok 1 - old bug\n# tests 1\n# pass 0\n# fail 1', 1);
  const baseline = judgeCommand(spec, failing);
  assert.equal(baseline.outcome, 'failed');
  assert.equal(judgeCommand({ ...spec, onlyNewFailures: true }, failing, baseline).reason, 'known-baseline-failures');
  assert.equal(judgeCommand({ ...spec, onlyNewFailures: true }, raw('not ok 1 - new bug\n# tests 1\n# pass 0\n# fail 1', 1), baseline).outcome, 'failed');
  assert.equal(judgeCommand(spec, { ...raw(''), outcome: 'unknown', timedOut: true }).reason, 'timeout');
});
test('check specs reject invalid settings and snapshot diff includes newly created files', () => {
  assert.throws(() => normalizeChecks([{ id: 'bad id', argv: ['node'] }]), { code: 'INVALID_CHECK_ID' });
  assert.throws(() => normalizeChecks([{ id: 'bad', argv: [] }]), { code: 'INVALID_CHECK_SPEC' });
  assert.equal(globMatches('src/nested/a.mjs', 'src/**/*.mjs'), true);
  assert.equal(globMatches('.review/runs/r/run.json', '.review/runs/'), true);
  assert.equal(globMatches('src/a.mjs', 'test/**'), false);
  assert.deepEqual(snapshotDiff({ files: {} }, { files: { 'src/a.mjs': { digest: 'd' } } }), [{ path: 'src/a.mjs', kind: 'added', before: null, after: 'd' }]);
});
