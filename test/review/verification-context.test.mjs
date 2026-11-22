import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun } from '../../src/review/state.mjs';
import { executionInputs, buildExecutionSpec } from '../../src/review/inputs.mjs';
import { outputSchema } from '../../src/review/schemas.mjs';
import { recordVerification } from '../../src/review/rework.mjs';
test('build and verify enumerate only pending verification IDs and describe review-task acceptance separately', () => {
  const run = createRun({ runId: 'context', requestId: 'context', requestDigest: 'd', rootSessionId: 'root', projectRoot: 'fixture', requirement: 'Fix boundary' });
  const finding = (id, origin, status = 'open', applicability = 'current') => ({ id, origin, sourceExecutionId: 'old', sourceFindingId: id, severity: 'high', description: id, basis: 'fixture', status, applicability, relatedFindingIds: [], taskIds: [] });
  run.findings.push(finding('review-id', 'review'), finding('check-id', 'machine'), finding('verify-id', 'verification', 'fixed_pending_verification'), finding('resolved-id', 'verification', 'resolved'), finding('stale-id', 'verification', 'open', 'stale'));
  for (const stage of ['build', 'verify']) {
    const input = executionInputs(run, stage, stage === 'build' ? 'developer' : 'verifier');
    assert.deepEqual(input.pendingVerificationFindingIds, ['verify-id']);
    const spec = buildExecutionSpec(run, stage, stage === 'build' ? 'developer' : 'verifier', 'execution');
    assert.match(spec.prompt, /origin=verification/); assert.match(spec.prompt, /初始review意见通过decisions\/tasks验收/); assert.match(spec.prompt, /列表为空则填\[\]/);
    const parameter = outputSchema(stage).properties.result.properties.resolvedFindingIds;
    assert.match(parameter.description, /pendingVerificationFindingIds/); assert.match(parameter.description, /初始review意见/);
  }
  assert.equal('pendingVerificationFindingIds' in executionInputs(run, 'decide', 'lead'), false);
  assert.throws(() => recordVerification(run, { executionId: 'verify', result: { decision: 'accept', findings: [], resolvedFindingIds: ['review-id'] } }), { code: 'FINDING_NOT_FOUND' });
  recordVerification(run, { executionId: 'verify', result: { decision: 'accept', findings: [], resolvedFindingIds: ['verify-id'] } });
  assert.deepEqual(executionInputs(run, 'verify', 'verifier').pendingVerificationFindingIds, []);
});
