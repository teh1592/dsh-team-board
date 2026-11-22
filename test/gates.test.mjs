/**
 * gates.test.mjs — 「任务完成门禁」的验收测试。
 *
 * 覆盖：状态转移表、四道关的逐条错误码、review 裁决路径、work 的宽松路径。
 * 每条错误码的用例名里都出现该码字符串，方便 --test-name-pattern 精确复跑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTORS,
  TRANSITIONS,
  ERROR_CODES,
  REVIEW_VERDICTS,
  COMPLETION_VERDICTS,
  REVIEW_SEVERITIES,
  BLOCKING_SEVERITIES,
  assertTransition,
  resolveReviewVerdict,
  evaluateCompletion,
} from '../src/gates.mjs';
// C-1（第 12 轮）：期望值必须来自 contract.mjs —— gates 自己不再持有 QUALITY_KINDS 副本。
import { KINDS, QUALITY_KINDS } from '../src/contract.mjs';

/* ------------------------------------------------------------------------- */
/* 夹具                                                                       */
/* ------------------------------------------------------------------------- */

const TEST_CMD = 'node --test plugin/test/gates.test.mjs';
const CRITERION = 'A1 门禁测试全绿';
/** review 任务的验收项：评审也要说清"用什么验证了这次评审"（D-8）。 */
const REVIEW_CRITERION = 'R1 评审覆盖本轮 blocker';
const REVIEW_CMD = 'node --test plugin/test/gates.test.mjs';

/** implementation 的通过态基准：四关全过。 */
function implBase() {
  return {
    task: {
      id: 'T1',
      kind: 'implementation',
      contract: {
        acceptance: [CRITERION],
        verify: [TEST_CMD],
        inScope: ['plugin/src/gates.mjs'],
        outOfScope: ['plugin/src/adapter.mjs'],
      },
    },
    meta: { attempt: 1, gate_version: 1 },
    payload: {
      acceptanceResults: [{ criterion: CRITERION, status: 'passed', evidence: 'receipt:r1' }],
      changedPaths: ['plugin/src/gates.mjs'],
    },
    receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }],
    diffPaths: ['plugin/src/gates.mjs'],
  };
}

/**
 * review 的通过态基准：没有代码改动，只带裁决。
 *
 * 自 W2-B（D-8）起，review 也是质量 kind：契约必须同时有 acceptance 与 verify，
 * 且验收结果要有本轮成功回执作证据 —— 所以这里比第 3 轮多了三项。
 */
function reviewBase() {
  return {
    task: {
      id: 'R1',
      kind: 'review',
      contract: {
        acceptance: [REVIEW_CRITERION],
        verify: [REVIEW_CMD],
        inScope: [],
        outOfScope: [],
      },
    },
    meta: { attempt: 1, gate_version: 1 },
    payload: {
      acceptanceResults: [{ criterion: REVIEW_CRITERION, status: 'passed', evidence: 'receipt:rr1' }],
      changedPaths: [],
      verdict: 'pass',
      findings: [],
    },
    receipts: [{ id: 'rr1', command: REVIEW_CMD, exit_code: 0 }],
    diffPaths: [],
  };
}

/** work 的基准：不需要验收与收据。 */
function workBase() {
  return {
    task: {
      id: 'W1',
      kind: 'work',
      contract: { acceptance: [], verify: [], inScope: [], outOfScope: [] },
    },
    meta: { attempt: 1, gate_version: 1 },
    payload: { acceptanceResults: [], changedPaths: [] },
    receipts: [],
    diffPaths: [],
  };
}

/** 浅合并 + task.contract / payload 定向合并。 */
function merge(base, patch = {}) {
  const out = { ...base, ...patch };
  if (patch.task) {
    out.task = { ...base.task, ...patch.task };
    out.task.contract = { ...base.task.contract, ...(patch.task.contract || {}) };
  }
  if (patch.payload) out.payload = { ...base.payload, ...patch.payload };
  return out;
}

const implInput = (patch) => merge(implBase(), patch);
const reviewInput = (patch) => merge(reviewBase(), patch);
const workInput = (patch) => merge(workBase(), patch);

const codes = (result) => result.errors.map((error) => error.code);
const countCode = (result, code) => codes(result).filter((item) => item === code).length;

/* ------------------------------------------------------------------------- */
/* 1. 状态转移表                                                              */
/* ------------------------------------------------------------------------- */

test('TRANSITIONS 是 "from->to" → actor 的映射，actor ∈ {worker, leader}', () => {
  const entries = Object.entries(TRANSITIONS);
  assert.ok(entries.length >= 6, '至少要有六条必备转移');
  for (const [key, actor] of entries) {
    assert.match(key, /^[a-z_]+->[a-z_]+$/, `键格式必须是 "from->to"，实际：${key}`);
    assert.ok(ACTORS.includes(actor), `${key} 的 actor 非法：${actor}`);
    assert.ok(Object.isFrozen(TRANSITIONS), '转移表必须冻结，防止运行时被改写');
  }
});

test('TRANSITIONS 覆盖验收要求的六条必备转移及 actor', () => {
  const required = {
    'pending->claimed': 'worker',
    'claimed->in_progress': 'worker',
    'in_progress->completed': 'worker',
    'in_progress->failed': 'worker',
    'pending->cancelled': 'leader',
    'claimed->cancelled': 'leader',
  };
  for (const [key, actor] of Object.entries(required)) {
    assert.equal(TRANSITIONS[key], actor, `${key} 的 actor 应为 ${actor}`);
  }
});

test('assertTransition 放行已登记且 actor 正确的转移', () => {
  assert.deepEqual(assertTransition({ from: 'pending', to: 'claimed', actor: 'worker' }), { ok: true });
  assert.deepEqual(assertTransition({ from: 'in_progress', to: 'completed', actor: 'worker' }), { ok: true });
  assert.deepEqual(assertTransition({ from: 'pending', to: 'cancelled', actor: 'leader' }), { ok: true });
});

test('assertTransition 对未列出的转移返回 E_ILLEGAL_TRANSITION', () => {
  const illegal = [
    { from: 'pending', to: 'completed', actor: 'worker' }, // 跳步
    { from: 'pending', to: 'in_progress', actor: 'worker' }, // 跳步
    { from: 'claimed', to: 'completed', actor: 'worker' }, // 跳步
    { from: 'in_progress', to: 'claimed', actor: 'worker' }, // 回退
    { from: 'failed', to: 'claimed', actor: 'worker' }, // 未登记
    { from: 'completed', to: 'in_progress', actor: 'leader' }, // 终态出边
    { from: 'cancelled', to: 'pending', actor: 'leader' }, // cancelled 是终态
    { from: 'claimed', to: 'claimed', actor: 'worker' }, // 自转移
  ];
  for (const transition of illegal) {
    const result = assertTransition(transition);
    assert.equal(result.ok, false, `${transition.from}->${transition.to} 不该被放行`);
    assert.equal(result.code, 'E_ILLEGAL_TRANSITION');
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 0);
  }
});

test('assertTransition 对 actor 不符返回 E_ILLEGAL_TRANSITION', () => {
  const byWorker = assertTransition({ from: 'pending', to: 'cancelled', actor: 'worker' });
  assert.equal(byWorker.ok, false);
  assert.equal(byWorker.code, 'E_ILLEGAL_TRANSITION');
  assert.match(byWorker.message, /leader/);

  const byLeader = assertTransition({ from: 'pending', to: 'claimed', actor: 'leader' });
  assert.equal(byLeader.ok, false);
  assert.equal(byLeader.code, 'E_ILLEGAL_TRANSITION');
  assert.match(byLeader.message, /worker/);
});

test('assertTransition 对残缺 / 未知 actor 的转移返回 E_ILLEGAL_TRANSITION', () => {
  const malformed = [
    undefined,
    null,
    {},
    { from: 'pending' },
    { to: 'claimed' },
    { from: '', to: 'claimed', actor: 'worker' },
    { from: 'pending', to: 'claimed', actor: 'human' },
    { from: 'pending', to: 'claimed' },
  ];
  for (const transition of malformed) {
    const result = assertTransition(transition);
    assert.equal(result.ok, false, `入参 ${JSON.stringify(transition)} 不该被放行`);
    assert.equal(result.code, 'E_ILLEGAL_TRANSITION');
  }
});

/* ------------------------------------------------------------------------- */
/* 2. 四道关                                                                  */
/* ------------------------------------------------------------------------- */

test('evaluateCompletion 四关全过返回 ok，errors 为空', () => {
  const result = evaluateCompletion(implInput());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('evaluateCompletion 对空输入不抛错', () => {
  assert.deepEqual(evaluateCompletion(), { ok: true, errors: [] });
  assert.deepEqual(evaluateCompletion({}), { ok: true, errors: [] });
});

test('关① 回执 exit_code!==0 返回 E_VERIFY_FAILED_BY_RUNTIME', () => {
  const result = evaluateCompletion(
    implInput({ receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 1 }] }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_VERIFY_FAILED_BY_RUNTIME'), 1);
  assert.match(
    result.errors.find((error) => error.code === 'E_VERIFY_FAILED_BY_RUNTIME').message,
    /exit_code/,
  );
});

test('关① 回执缺 exit_code 视为未通过并返回 E_VERIFY_FAILED_BY_RUNTIME', () => {
  const result = evaluateCompletion(implInput({ receipts: [{ id: 'r1', command: TEST_CMD }] }));
  assert.equal(countCode(result, 'E_VERIFY_FAILED_BY_RUNTIME'), 1);
});

test('关① 合同 verify 项没有对应回执返回 E_VERIFY_MISSING', () => {
  const result = evaluateCompletion(
    implInput({
      task: { contract: { verify: [TEST_CMD, 'node --check plugin/src/gates.mjs'] } },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_VERIFY_MISSING'), 1);
  assert.match(
    result.errors.find((error) => error.code === 'E_VERIFY_MISSING').message,
    /node --check/,
  );
});

test('关① 完全没有回执时每条 verify 都报 E_VERIFY_MISSING', () => {
  const result = evaluateCompletion(
    implInput({
      task: { contract: { verify: ['cmd-a', 'cmd-b'] } },
      receipts: [],
    }),
  );
  assert.equal(countCode(result, 'E_VERIFY_MISSING'), 2);
});

test('关② acceptance 缺 acceptanceResults 返回 E_ACCEPTANCE_MISMATCH', () => {
  const result = evaluateCompletion(implInput({ payload: { acceptanceResults: [] } }));
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_ACCEPTANCE_MISMATCH'), 1);
  assert.match(
    result.errors.find((error) => error.code === 'E_ACCEPTANCE_MISMATCH').message,
    /验收项/,
  );
});

test('关② 部分验收项缺失只报缺的那条 E_ACCEPTANCE_MISMATCH', () => {
  const result = evaluateCompletion(
    implInput({
      task: { contract: { acceptance: [CRITERION, 'A2 边界用例'] } },
    }),
  );
  assert.equal(countCode(result, 'E_ACCEPTANCE_MISMATCH'), 1);
  assert.match(
    result.errors.find((error) => error.code === 'E_ACCEPTANCE_MISMATCH').message,
    /A2 边界用例/,
  );
});

test('关② status!==passed 返回 E_ACCEPTANCE_MISMATCH', () => {
  const result = evaluateCompletion(
    implInput({
      payload: {
        acceptanceResults: [{ criterion: CRITERION, status: 'failed', evidence: 'receipt:r1' }],
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_ACCEPTANCE_MISMATCH'), 1);
  assert.equal(countCode(result, 'E_EVIDENCE_UNBACKED'), 0, '证据本身是有效的，不该报 E_EVIDENCE_UNBACKED');
});

test('关② evidence 不是 receipt:<id> 形式返回 E_EVIDENCE_UNBACKED', () => {
  const result = evaluateCompletion(
    implInput({
      payload: {
        acceptanceResults: [
          { criterion: CRITERION, status: 'passed', evidence: 'file:plugin/test/gates.test.mjs' },
        ],
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_EVIDENCE_UNBACKED'), 1);
});

test('关② evidence 缺失或为空返回 E_EVIDENCE_UNBACKED', () => {
  for (const evidence of [undefined, '', 'trust me']) {
    const result = evaluateCompletion(
      implInput({
        payload: { acceptanceResults: [{ criterion: CRITERION, status: 'passed', evidence }] },
      }),
    );
    assert.equal(countCode(result, 'E_EVIDENCE_UNBACKED'), 1, `evidence=${JSON.stringify(evidence)}`);
  }
});

test('关② evidence 指向不存在的回执返回 E_EVIDENCE_UNBACKED', () => {
  const result = evaluateCompletion(
    implInput({
      payload: {
        acceptanceResults: [{ criterion: CRITERION, status: 'passed', evidence: 'receipt:ghost' }],
      },
    }),
  );
  assert.equal(countCode(result, 'E_EVIDENCE_UNBACKED'), 1);
  assert.match(
    result.errors.find((error) => error.code === 'E_EVIDENCE_UNBACKED').message,
    /ghost/,
  );
});

test('关② evidence 指向失败回执返回 E_EVIDENCE_UNBACKED', () => {
  const result = evaluateCompletion(
    implInput({
      receipts: [
        { id: 'r1', command: TEST_CMD, exit_code: 0 },
        { id: 'r9', command: 'npm run lint', exit_code: 2 },
      ],
      payload: {
        acceptanceResults: [{ criterion: CRITERION, status: 'passed', evidence: 'receipt:r9' }],
      },
    }),
  );
  assert.equal(countCode(result, 'E_EVIDENCE_UNBACKED'), 1);
  assert.equal(countCode(result, 'E_VERIFY_FAILED_BY_RUNTIME'), 1);
});

test('关③ 实际改动未申报返回 E_UNREPORTED_CHANGES', () => {
  const result = evaluateCompletion(
    implInput({ diffPaths: ['plugin/src/gates.mjs', 'plugin/test/gates.test.mjs'] }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_UNREPORTED_CHANGES'), 1);
  assert.match(
    result.errors.find((error) => error.code === 'E_UNREPORTED_CHANGES').message,
    /gates\.test\.mjs/,
  );
});

test('关③ 申报了但实际没改返回 E_PHANTOM_CHANGES', () => {
  const result = evaluateCompletion(
    implInput({
      task: { contract: { inScope: ['plugin/src/', 'plugin/test/'] } },
      payload: {
        changedPaths: ['plugin/src/gates.mjs', 'plugin/test/gates.test.mjs'],
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_PHANTOM_CHANGES'), 1);
  assert.equal(countCode(result, 'E_OUT_OF_SCOPE'), 0, '两条路径都在 inScope 内');
});

test('关③ 申报路径命中 outOfScope 返回 E_OUT_OF_SCOPE', () => {
  const result = evaluateCompletion(
    implInput({
      payload: { changedPaths: ['plugin/src/gates.mjs', 'plugin/src/adapter.mjs'] },
      diffPaths: ['plugin/src/gates.mjs', 'plugin/src/adapter.mjs'],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_OUT_OF_SCOPE'), 1);
  assert.equal(countCode(result, 'E_PHANTOM_CHANGES'), 0);
  assert.match(
    result.errors.find((error) => error.code === 'E_OUT_OF_SCOPE').message,
    /out_of_scope/,
  );
});

test('关③ 申报路径不在 inScope 内返回 E_OUT_OF_SCOPE', () => {
  const result = evaluateCompletion(
    implInput({
      payload: { changedPaths: ['plugin/src/gates.mjs', 'docs/notes.md'] },
      diffPaths: ['plugin/src/gates.mjs', 'docs/notes.md'],
    }),
  );
  assert.equal(countCode(result, 'E_OUT_OF_SCOPE'), 1);
  assert.match(
    result.errors.find((error) => error.code === 'E_OUT_OF_SCOPE').message,
    /undeclared/,
  );
});

test('关④ implementation 的 changedPaths 为空返回 E_CHANGED_PATHS_REQUIRED', () => {
  const result = evaluateCompletion(
    implInput({ payload: { changedPaths: [] }, diffPaths: [] }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_CHANGED_PATHS_REQUIRED'), 1);
  assert.equal(countCode(result, 'E_ACCEPTANCE_MISMATCH'), 0, '验收已覆盖，不该因此报错');
});

test('四关全跑完：关①→④ 的错误一次全部返回（不 early return）', () => {
  const result = evaluateCompletion(
    implInput({
      task: {
        contract: {
          verify: [TEST_CMD, 'node --check plugin/src/gates.mjs'],
        },
      },
      receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 1 }],
      payload: {
        acceptanceResults: [
          { criterion: CRITERION, status: 'failed', evidence: 'file:report.txt' },
          { criterion: 'A2 额外', status: 'passed', evidence: 'receipt:ghost' },
        ],
        changedPaths: ['plugin/src/gates.mjs', 'plugin/src/ghost.mjs', 'plugin/src/adapter.mjs'],
      },
      diffPaths: ['plugin/src/gates.mjs', 'plugin/test/gates.test.mjs'],
    }),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), [
    'E_VERIFY_FAILED_BY_RUNTIME',
    'E_VERIFY_MISSING',
    'E_ACCEPTANCE_MISMATCH',
    'E_EVIDENCE_UNBACKED',
    'E_EVIDENCE_UNBACKED',
    'E_UNREPORTED_CHANGES',
    'E_PHANTOM_CHANGES',
    'E_PHANTOM_CHANGES',
    'E_OUT_OF_SCOPE',
    'E_OUT_OF_SCOPE',
  ]);
  for (const error of result.errors) {
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0, `${error.code} 必须带可读 message`);
  }
});

/* ------------------------------------------------------------------------- */
/* 3. review 裁决路径                                                         */
/* ------------------------------------------------------------------------- */

test('review 缺 verdict 返回 E_VERDICT_REQUIRED', () => {
  const result = evaluateCompletion(reviewInput({ payload: { verdict: undefined } }));
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_VERDICT_REQUIRED'), 1);
  assert.equal(countCode(result, 'E_FINDINGS_REQUIRED'), 0, '没给 verdict 时不谈 findings');
});

test('review verdict=pass 且无 open findings 通过（review.deliverable=true）', () => {
  const result = evaluateCompletion(reviewInput());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.review.verdict, 'pass');
  assert.equal(result.review.recognized, true);
  assert.equal(result.review.deliverable, true, 'pass + 无 open finding 是唯一可交付的评审裁决');
});

test('review verdict=pass 但有 open blocker 返回 E_OPEN_FINDINGS', () => {
  const result = evaluateCompletion(
    reviewInput({
      payload: {
        verdict: 'pass',
        findings: [
          { severity: 'blocker', title: '并发写入会丢回执', status: 'open' },
          { severity: 'low', title: '措辞问题', status: 'open' },
        ],
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_OPEN_FINDINGS'), 1);
  assert.match(
    result.errors.find((error) => error.code === 'E_OPEN_FINDINGS').message,
    /并发写入/,
  );
});

test('review verdict=pass 但有 open high 返回 E_OPEN_FINDINGS', () => {
  const result = evaluateCompletion(
    reviewInput({ payload: { verdict: 'pass', findings: [{ severity: 'high', title: '缺边界用例' }] } }),
  );
  assert.equal(countCode(result, 'E_OPEN_FINDINGS'), 1);
});

test('review verdict=pass 且 blocker 已解决不报 E_OPEN_FINDINGS', () => {
  const result = evaluateCompletion(
    reviewInput({
      payload: {
        verdict: 'pass',
        findings: [{ severity: 'blocker', title: '已修', status: 'resolved' }],
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.review.deliverable, true);
});

test('review verdict=needs_revision 且 findings 为空返回 E_FINDINGS_REQUIRED', () => {
  const result = evaluateCompletion(
    reviewInput({ payload: { verdict: 'needs_revision', findings: [] } }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_VERDICT_REQUIRED'), 1);
  assert.equal(countCode(result, 'E_FINDINGS_REQUIRED'), 1);
});

test('review verdict=reject 且 findings 为空返回 E_FINDINGS_REQUIRED', () => {
  const result = evaluateCompletion(reviewInput({ payload: { verdict: 'reject', findings: [] } }));
  assert.equal(countCode(result, 'E_FINDINGS_REQUIRED'), 1);
  assert.equal(countCode(result, 'E_VERDICT_REQUIRED'), 1);
});

test('review verdict=needs_revision 带 findings 只报 E_VERDICT_REQUIRED', () => {
  const result = evaluateCompletion(
    reviewInput({
      payload: { verdict: 'needs_revision', findings: [{ severity: 'medium', title: '补一条测试' }] },
    }),
  );
  assert.deepEqual(codes(result), ['E_VERDICT_REQUIRED']);
});

/* ------------------------------------------------------------------------- */
/* 4. work 的宽松路径                                                         */
/* ------------------------------------------------------------------------- */

test('work 任务缺 acceptance 与 receipts 也不报错', () => {
  const result = evaluateCompletion(workInput());
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(countCode(result, 'E_ACCEPTANCE_MISMATCH'), 0);
  assert.equal(countCode(result, 'E_VERIFY_MISSING'), 0);
});

test('work 任务不要求 changedPaths：不报 E_CHANGED_PATHS_REQUIRED', () => {
  const result = evaluateCompletion(workInput({ payload: { changedPaths: [] } }));
  assert.equal(countCode(result, 'E_CHANGED_PATHS_REQUIRED'), 0);
});

test('work 任务仍跑关③：未申报的实际改动报 E_UNREPORTED_CHANGES', () => {
  const result = evaluateCompletion(
    workInput({ diffPaths: ['plugin/src/gates.mjs'], payload: { changedPaths: [] } }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_UNREPORTED_CHANGES'), 1);
  assert.equal(countCode(result, 'E_CHANGED_PATHS_REQUIRED'), 0);
});

test('work 任务仍跑关③：越界申报报 E_OUT_OF_SCOPE', () => {
  const result = evaluateCompletion(
    workInput({
      task: { contract: { inScope: ['plugin/src/gates.mjs'] } },
      payload: { changedPaths: ['plugin/src/contract.mjs'] },
      diffPaths: ['plugin/src/contract.mjs'],
    }),
  );
  assert.equal(countCode(result, 'E_OUT_OF_SCOPE'), 1);
});

/* ------------------------------------------------------------------------- */
/* 5. G1 契约取值统一：顶层写法 ≡ contract 写法                                */
/* ------------------------------------------------------------------------- */

/**
 * 同一份契约字段分别以「写在 task.contract」与「直接写在 task 顶层」承载，
 * 其余入参完全相同。两种写法的判定必须逐字一致（G1 / B2）。
 */
function equivalentPair(contractFields, patch = {}) {
  const base = implBase();
  const shared = {
    meta: base.meta,
    payload: patch.payload ?? base.payload,
    receipts: patch.receipts ?? base.receipts,
    diffPaths: patch.diffPaths ?? base.diffPaths,
  };
  return {
    viaContract: { ...shared, task: { id: 'T1', kind: 'implementation', contract: { ...contractFields } } },
    viaTopLevel: { ...shared, task: { id: 'T1', kind: 'implementation', ...contractFields } },
  };
}

const FULL_FIELDS = {
  acceptance: [CRITERION],
  verify: [TEST_CMD],
  inScope: ['plugin/src/gates.mjs'],
  outOfScope: ['plugin/src/adapter.mjs'],
};

test('G1 顶层写法与 contract 写法判定完全一致（全过）', () => {
  const { viaContract, viaTopLevel } = equivalentPair(FULL_FIELDS);
  assert.deepEqual(evaluateCompletion(viaTopLevel), { ok: true, errors: [] });
  assert.deepEqual(evaluateCompletion(viaTopLevel), evaluateCompletion(viaContract));
});

test('G1 顶层写法与 contract 写法判定完全一致（越界申报）', () => {
  const patch = {
    payload: { acceptanceResults: implBase().payload.acceptanceResults, changedPaths: ['plugin/src/leak.mjs'] },
    diffPaths: ['plugin/src/leak.mjs'],
  };
  const { viaContract, viaTopLevel } = equivalentPair(FULL_FIELDS, patch);
  const top = evaluateCompletion(viaTopLevel);
  const nested = evaluateCompletion(viaContract);
  assert.equal(top.ok, false);
  assert.deepEqual(top.errors, nested.errors, '两种写法的错误码与顺序必须一致');
  assert.equal(countCode(top, 'E_OUT_OF_SCOPE'), 1);
});

test('G1 顶层写法与 contract 写法判定完全一致（缺回执 + 缺验收）', () => {
  const fields = { acceptance: [CRITERION, 'A2 边界'], verify: ['cmd-a', 'cmd-b'], inScope: ['plugin/src/gates.mjs'] };
  const { viaContract, viaTopLevel } = equivalentPair(fields, {
    payload: { acceptanceResults: [], changedPaths: ['plugin/src/gates.mjs'] },
    receipts: [],
    diffPaths: ['plugin/src/gates.mjs'],
  });
  const top = evaluateCompletion(viaTopLevel);
  const nested = evaluateCompletion(viaContract);
  assert.deepEqual(top.errors, nested.errors);
  assert.deepEqual(codes(top), [
    'E_VERIFY_MISSING',
    'E_VERIFY_MISSING',
    'E_ACCEPTANCE_MISMATCH',
    'E_ACCEPTANCE_MISMATCH',
  ]);
});

test('G1 顶层写法的 outOfScope 不再被当成空（命中即 E_OUT_OF_SCOPE）', () => {
  const fields = { acceptance: [CRITERION], verify: [TEST_CMD], inScope: ['plugin/src/'], outOfScope: ['plugin/src/legacy/'] };
  const { viaTopLevel } = equivalentPair(fields, {
    payload: { acceptanceResults: implBase().payload.acceptanceResults, changedPaths: ['plugin/src/legacy/key.mjs'] },
    diffPaths: ['plugin/src/legacy/key.mjs'],
  });
  const result = evaluateCompletion(viaTopLevel);
  assert.equal(countCode(result, 'E_OUT_OF_SCOPE'), 1);
  assert.match(result.errors.find((error) => error.code === 'E_OUT_OF_SCOPE').message, /out_of_scope/);
});

/* ------------------------------------------------------------------------- */
/* 6. G2 空契约 fail-closed                                                   */
/* ------------------------------------------------------------------------- */

test('G2 contract={} 且申报了 changedPaths → E_SCOPE_UNDECLARED + E_CONTRACT_INCOMPLETE（范围审计不再整段跳过）', () => {
  const result = evaluateCompletion({
    task: { id: 'task-1', kind: 'implementation', contract: {} },
    meta: { attempt: 1, gate_version: 1 },
    payload: { changedPaths: ['plugin/src/gates.mjs'], acceptanceResults: [] },
    receipts: [],
    diffPaths: ['plugin/src/gates.mjs'],
  });
  assert.equal(result.ok, false);
  // G8 起空契约同时报"契约里没声明 acceptance"：这是根因，E_SCOPE_UNDECLARED 是同一根因的范围侧表现。
  assert.deepEqual(codes(result), ['E_CONTRACT_INCOMPLETE', 'E_SCOPE_UNDECLARED']);
});

test('G2 空契约 + ../../etc/passwd → 被拒：E_SCOPE_UNDECLARED 与 E_PATH_UNSAFE（f3 攻击关闭）', () => {
  const result = evaluateCompletion({
    task: { id: 'task-1', kind: 'implementation', contract: {} },
    meta: { attempt: 1, gate_version: 1 },
    payload: { changedPaths: ['../../etc/passwd'], acceptanceResults: [] },
    receipts: [],
    diffPaths: ['../../etc/passwd'],
  });
  assert.equal(result.ok, false, '没有声明范围时不得放行任何路径');
  assert.deepEqual(codes(result), ['E_CONTRACT_INCOMPLETE', 'E_PATH_UNSAFE', 'E_SCOPE_UNDECLARED']);
});

test('G2 work 任务不申报 changedPaths：不因缺 inScope 报 E_SCOPE_UNDECLARED', () => {
  const result = evaluateCompletion(workInput());
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(countCode(result, 'E_SCOPE_UNDECLARED'), 0);
});

test('G2 work 任务申报了路径却没声明范围 → E_SCOPE_UNDECLARED', () => {
  const result = evaluateCompletion(
    workInput({
      payload: { changedPaths: ['plugin/src/gates.mjs'] },
      diffPaths: ['plugin/src/gates.mjs'],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_SCOPE_UNDECLARED'), 1);
  assert.equal(countCode(result, 'E_CHANGED_PATHS_REQUIRED'), 0, 'work 本来就不要求申报 changedPaths');
});

test('G2 已声明范围时非法路径报 E_PATH_UNSAFE（不是 E_OUT_OF_SCOPE，诊断要准确）', () => {
  const result = evaluateCompletion(
    implInput({
      payload: { changedPaths: ['../../etc/passwd'] },
      diffPaths: ['../../etc/passwd'],
    }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_PATH_UNSAFE']);
  assert.equal(countCode(result, 'E_OUT_OF_SCOPE'), 0);
});

test('G2 normalizePath 判 null 的路径不回退原值伪造 in_scope（plugin/src/../secret.txt）', () => {
  const path = 'plugin/src/../secret.txt';
  const result = evaluateCompletion(
    implInput({ payload: { changedPaths: [path] }, diffPaths: [path] }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_PATH_UNSAFE'), 1, '非法路径必须报 E_PATH_UNSAFE');
  assert.equal(countCode(result, 'E_OUT_OF_SCOPE'), 0, '不回退原值后不能再被当成"范围外"糊过去');
  assert.match(result.errors.find((error) => error.code === 'E_PATH_UNSAFE').message, /\.\./);
});

/* ------------------------------------------------------------------------- */
/* 7. G3 attempt 维度贯通                                                     */
/* ------------------------------------------------------------------------- */

test('G3 上一 attempt 的成功回执不能给本轮背书（E_STALE_ATTEMPT 汇总一条，不误报 E_VERIFY_MISSING）', () => {
  const result = evaluateCompletion(
    implInput({
      meta: { attempt: 2, gate_version: 1 },
      receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 1 }],
    }),
  );
  assert.equal(result.ok, false, '上一 attempt 的回执不得为本 attempt 背书');
  const staleMessages = result.errors
    .filter((error) => error.code === 'E_STALE_ATTEMPT')
    .map((error) => error.message);
  // G6/L-2 起：同一「原因 + attempt 值」只汇总一条（原断言是 >= 2：过期汇总 + verify 项各一条）。
  assert.equal(
    staleMessages.length,
    1,
    `一条过期回执只该汇总出一条 E_STALE_ATTEMPT，实际 ${JSON.stringify(codes(result))}`,
  );
  const [message] = staleMessages;
  assert.match(message, /attempt=1/, '要点名这条回执属于哪一轮');
  assert.match(message, /attempt=2/, '要点名本轮是哪一轮');
  assert.match(message, /r1/, '要列出涉及的 receipt id');
  assert.match(message, /verify 项/, '受影响的 verify 项要并入同一条消息（不能丢诊断）');
  assert.equal(countCode(result, 'E_VERIFY_MISSING'), 0, '过期 ≠ 缺失');
  assert.equal(countCode(result, 'E_EVIDENCE_UNBACKED'), 0, '回执确实存在，只是不能当本轮证据');
});

test('G3 同一 attempt 的回执正常覆盖（正例）', () => {
  const result = evaluateCompletion(
    implInput({
      meta: { attempt: 2, gate_version: 1 },
      receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 2 }],
    }),
  );
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('G3 meta 缺失 / attempt 未声明：按第 1 轮（引导轮）处理，无标回执可用', () => {
  const degradations = [undefined, {}, { attempt: null }, { gate_version: 1 }];
  for (const meta of degradations) {
    const result = evaluateCompletion(implInput({ meta }));
    assert.equal(
      result.ok,
      true,
      `meta=${JSON.stringify(meta)} 是"未声明 attempt"，按第 1 轮放行，实际 ${JSON.stringify(codes(result))}`,
    );
    assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 0);
    assert.equal(countCode(result, 'E_INPUT_INVALID'), 0);
  }
});

test("G3 meta.attempt 不是正整数（'1' / 0 / -3 / 1.5 / true）→ E_INPUT_INVALID，不再静默降级", () => {
  const malformed = ['1', 0, -3, 1.5, true];
  for (const attempt of malformed) {
    const result = evaluateCompletion(implInput({ meta: { attempt } }));
    assert.equal(result.ok, false, `meta.attempt=${JSON.stringify(attempt)} 不能被当成"没有 attempt"`);
    assert.deepEqual(codes(result), ['E_INPUT_INVALID'], `实际 ${JSON.stringify(codes(result))}`);
    assert.match(
      result.errors[0].message,
      /attempt/,
      '消息要点名是 meta.attempt 的形态问题',
    );
  }
});

/* ------------------------------------------------------------------------- */
/* 7b. G6 attempt 卫生（blocker L-11 + major L-10 + minor L-2）                 */
/* ------------------------------------------------------------------------- */

/**
 * G6 的九组验收用例。每条都刻意写成"改回旧行为就红"：
 *   - 旧行为：attempt 缺失/非法一律"不判新旧"，无标回执永远算本轮 → 这五条会全部变绿（放行）。
 */
test('G6 attempt=1 + 回执无 attempt 标 → 通过（引导轮没有"上一轮"可言）', () => {
  const result = evaluateCompletion(
    implInput({ meta: { attempt: 1 }, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }] }),
  );
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 0);
});

test('G6 attempt=2 + 回执无 attempt 标 → E_STALE_ATTEMPT（blocker L-11 验收核心）', () => {
  // 攻击链：reaper 把 failed→pending 让 attempt+1，第二轮不跑任何东西、
  // 只把第一轮的回执原样放回列表（不带 attempt 字段）→ 旧实现四关全过。
  const result = evaluateCompletion(
    implInput({ meta: { attempt: 2 }, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }] }),
  );
  assert.equal(result.ok, false, '第二轮不得用未打标的回执给本轮背书');
  assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 1, `实际 ${JSON.stringify(codes(result))}`);
  const message = result.errors.find((error) => error.code === 'E_STALE_ATTEMPT').message;
  assert.match(message, /没有 attempt 标/, '消息要说清"无标"是原因');
  assert.match(message, /第 2 轮/, '消息要点名本轮是第 2 轮');
  assert.equal(countCode(result, 'E_VERIFY_MISSING'), 0, '过期 ≠ 缺失');
  assert.equal(countCode(result, 'E_EVIDENCE_UNBACKED'), 0, '回执存在，只是不能当本轮证据');
});

test('G6 attempt=2 + 回执标 attempt=1 → E_STALE_ATTEMPT（已有行为，保留）', () => {
  const result = evaluateCompletion(
    implInput({ meta: { attempt: 2 }, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 1 }] }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 1, `实际 ${JSON.stringify(codes(result))}`);
});

test('G6 attempt=2 + 回执标 attempt=2 → 通过', () => {
  const result = evaluateCompletion(
    implInput({ meta: { attempt: 2 }, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 2 }] }),
  );
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('G6 attempt=1 + 回执标 attempt=2 → E_STALE_ATTEMPT（异常输入也拦）', () => {
  const result = evaluateCompletion(
    implInput({ meta: { attempt: 1 }, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 2 }] }),
  );
  assert.equal(result.ok, false, '回执标注晚于当前轮，无法证明它属于本轮');
  assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 1, `实际 ${JSON.stringify(codes(result))}`);
});

test("G6 meta.attempt 形态非法（'2' / 2.5 / 0 / -1 / true）→ E_INPUT_INVALID（L-10：不许静默关闭判定）", () => {
  for (const attempt of ['2', 2.5, 0, -1, true]) {
    const result = evaluateCompletion(
      implInput({ meta: { attempt }, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 1 }] }),
    );
    assert.equal(result.ok, false, `meta.attempt=${JSON.stringify(attempt)} 不能成为关闭过期检查的开关`);
    assert.deepEqual(codes(result), ['E_INPUT_INVALID'], `实际 ${JSON.stringify(codes(result))}`);
  }
});

test('G6 meta 整体缺失 → 视为 attempt 1，无标回执通过', () => {
  const result = evaluateCompletion(
    implInput({ meta: undefined, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }] }),
  );
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('G6 一条过期回执只产生 1 条 E_STALE_ATTEMPT（L-2：每个 attempt 值汇总一条）', () => {
  // 该回执同时"覆盖 verify 项"并被"验收证据"引用：修前会从三处各报一条。
  const result = evaluateCompletion(
    implInput({ meta: { attempt: 2 }, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 1 }] }),
  );
  assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 1, `实际 ${JSON.stringify(codes(result))}`);
  const message = result.errors.find((error) => error.code === 'E_STALE_ATTEMPT').message;
  assert.match(message, /A1 门禁测试全绿/, '受影响的验收项要并入同一条消息');
});

test('G6 两个不同 attempt 值的过期回执 → 各汇总一条（不是每条回执一条）', () => {
  const result = evaluateCompletion(
    implInput({
      meta: { attempt: 3 },
      receipts: [
        { id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 1 },
        { id: 'r2', command: TEST_CMD, exit_code: 0, attempt: 1 },
        { id: 'r3', command: TEST_CMD, exit_code: 0, attempt: 2 },
      ],
    }),
  );
  assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 2, `实际 ${JSON.stringify(codes(result))}`);
  const messages = result.errors.filter((error) => error.code === 'E_STALE_ATTEMPT').map((error) => error.message);
  assert.ok(messages.some((message) => /r1/.test(message) && /r2/.test(message)), '同 attempt 的回执要合并列出');
});

test('G6 work 任务同样受 attempt 卫生约束（不是只有 implementation/review 才查）', () => {
  const result = evaluateCompletion(
    workInput({ meta: { attempt: 4 }, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }] }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 1, `实际 ${JSON.stringify(codes(result))}`);
});

/* ------------------------------------------------------------------------- */
/* 7c. G7 作用域声明本身的非法条目（minor Q4-1 / L-6）                          */
/* ------------------------------------------------------------------------- */

test('G7 inScope 声明非法（../etc）→ E_PATH_UNSAFE，且不再报 E_OUT_OF_SCOPE（码指对修法）', () => {
  const result = evaluateCompletion(implInput({ task: { contract: { inScope: ['../etc'] } } }));
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_PATH_UNSAFE'], `实际 ${JSON.stringify(codes(result))}`);
  assert.match(result.errors[0].message, /作用域声明/, '消息要说的是"声明本身非法"');
  assert.match(result.errors[0].message, /inScope/, '要点名是哪个声明写的');
});

test('G7 outOfScope 声明非法同样报 E_PATH_UNSAFE', () => {
  const result = evaluateCompletion(implInput({ task: { contract: { outOfScope: ['/abs/path'] } } }));
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_PATH_UNSAFE']);
  assert.match(result.errors[0].message, /outOfScope/);
});

test('G7 声明非法 + 申报路径非法：两条 E_PATH_UNSAFE 各报一次（不同根因，不合并）', () => {
  const result = evaluateCompletion(
    implInput({
      task: { contract: { inScope: ['../etc'] } },
      payload: { changedPaths: ['../../etc/passwd'] },
      diffPaths: ['../../etc/passwd'],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_PATH_UNSAFE'), 2, `实际 ${JSON.stringify(codes(result))}`);
  assert.equal(countCode(result, 'E_OUT_OF_SCOPE'), 0, '声明坏掉时不再逐个路径报"越界"');
});

test('G7 合法声明不因新增校验而被误报（inScope/outOfScope 全合规 → 无 E_PATH_UNSAFE）', () => {
  const result = evaluateCompletion(implInput());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('G7 非字符串的作用域声明条目也报 E_PATH_UNSAFE（声明条目必须是路径字符串）', () => {
  const result = evaluateCompletion(implInput({ task: { contract: { inScope: [42] } } }));
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_PATH_UNSAFE'), 1, `实际 ${JSON.stringify(codes(result))}`);
  assert.match(result.errors[0].message, /不是路径字符串/);
});

test('G7 非法声明沿用 toEntryListStrict 的 reason：穿越与绝对路径能分开说', () => {
  const traversal = evaluateCompletion(implInput({ task: { contract: { inScope: ['../etc'] } } }));
  assert.match(traversal.errors[0].message, /\.\./);

  const absolute = evaluateCompletion(implInput({ task: { contract: { inScope: ['/etc/passwd'] } } }));
  assert.deepEqual(codes(absolute), ['E_PATH_UNSAFE']);
  assert.match(absolute.errors[0].message, /绝对路径/);

  // 同一条非法声明写在两侧 → 只报一次，但要点明两处都写了
  const both = evaluateCompletion(
    implInput({ task: { contract: { inScope: ['../etc'], outOfScope: ['../etc'] } } }),
  );
  assert.equal(countCode(both, 'E_PATH_UNSAFE'), 1, `实际 ${JSON.stringify(codes(both))}`);
  assert.match(both.errors[0].message, /inScope/);
  assert.match(both.errors[0].message, /outOfScope/);
});

test('G7 目录声明（结尾 /）与重复声明都算合法，不误报 E_PATH_UNSAFE', () => {
  const result = evaluateCompletion(
    implInput({
      task: { contract: { inScope: ['plugin/src/', 'plugin/src/', 'plugin/src/gates.mjs'] } },
    }),
  );
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(countCode(result, 'E_PATH_UNSAFE'), 0);
});

/* ------------------------------------------------------------------------- */
/* 7d. G8 契约完整性：没声明验收 ≠ 验收没覆盖（minor L-5）                        */
/* ------------------------------------------------------------------------- */

test('G8 contract:{} 且顶层也没字段 → E_CONTRACT_INCOMPLETE（不是 E_ACCEPTANCE_MISMATCH）', () => {
  const result = evaluateCompletion({
    task: { id: 'T1', kind: 'implementation', contract: {} },
    meta: { attempt: 1 },
    payload: {
      changedPaths: ['plugin/src/gates.mjs'],
      acceptanceResults: [{ criterion: 'A1', status: 'passed', evidence: 'receipt:r1' }],
    },
    receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }],
    diffPaths: ['plugin/src/gates.mjs'],
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('E_CONTRACT_INCOMPLETE'), `实际 ${JSON.stringify(codes(result))}`);
  assert.ok(
    !codes(result).includes('E_ACCEPTANCE_MISMATCH'),
    `真实原因是"压根没声明验收"，不该说"验收没覆盖"：${JSON.stringify(codes(result))}`,
  );
  const message = result.errors.find((error) => error.code === 'E_CONTRACT_INCOMPLETE').message;
  // W2-B 起同一根因要一次说完缺哪些：空契约缺的是 acceptance 与 verify 两项。
  assert.match(message, /缺少 acceptance 与 verify/, '缺两项要一起点名');
  assert.match(message, /kind=implementation/);
});

test('G8 acceptance 显式声明为空数组 → 同样 E_CONTRACT_INCOMPLETE', () => {
  const result = evaluateCompletion(
    implInput({ task: { contract: { acceptance: [] } }, payload: { acceptanceResults: [] } }),
  );
  assert.deepEqual(codes(result), ['E_CONTRACT_INCOMPLETE']);
});

test('G8 work 豁免契约完整性：没有任何声明也不报 E_CONTRACT_INCOMPLETE', () => {
  assert.equal(countCode(evaluateCompletion(workInput()), 'E_CONTRACT_INCOMPLETE'), 0);
  assert.deepEqual(evaluateCompletion(workInput()), { ok: true, errors: [] });

  const emptyWork = evaluateCompletion({
    task: { id: 'W1', kind: 'work', contract: {} },
    meta: { attempt: 1 },
    payload: { changedPaths: [], acceptanceResults: [] },
    receipts: [],
    diffPaths: [],
  });
  assert.deepEqual(emptyWork, { ok: true, errors: [] }, 'work 不要求 acceptance/verify');
});

test('G8 契约里有 acceptance 时不报 E_CONTRACT_INCOMPLETE（正例，防误报把正常任务堵死）', () => {
  const result = evaluateCompletion(implInput());
  assert.equal(countCode(result, 'E_CONTRACT_INCOMPLETE'), 0);
});

/* ------------------------------------------------------------------------- */
/* 7e. W2-A 契约歧义（F4-2）：门禁不替调用方选边                                */
/* ------------------------------------------------------------------------- */

/** 一份"两处同名异值"的实现任务。 */
function ambiguousImpl() {
  return {
    id: 'T1',
    kind: 'implementation',
    contract: {
      acceptance: [CRITERION],
      verify: [TEST_CMD],
      inScope: ['plugin/src/gates.mjs'],
      outOfScope: [],
    },
    inScope: ['docs/'], // ← 与契约里的 inScope 异值
  };
}

test('W2-A 契约与顶层同名字段异值 → E_CONTRACT_AMBIGUOUS（message 点名字段）', () => {
  const result = evaluateCompletion({
    task: ambiguousImpl(),
    meta: { attempt: 1 },
    payload: {
      changedPaths: ['plugin/src/gates.mjs'],
      acceptanceResults: [{ criterion: CRITERION, status: 'passed', evidence: 'receipt:r1' }],
    },
    receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }],
    diffPaths: ['plugin/src/gates.mjs'],
  });
  assert.equal(result.ok, false, '歧义任务不得放行（validatePlan 拒的东西，门禁不能放）');
  assert.equal(countCode(result, 'E_CONTRACT_AMBIGUOUS'), 1, `实际 ${JSON.stringify(codes(result))}`);
  const message = result.errors.find((error) => error.code === 'E_CONTRACT_AMBIGUOUS').message;
  assert.match(message, /inScope/, '要点名是哪一个字段歧义');
});

test('W2-A 两处同值不算歧义（重复但一致不值得报）', () => {
  const task = {
    ...ambiguousImpl(),
    inScope: ['plugin/src/gates.mjs'], // ← 与契约同值
  };
  const result = evaluateCompletion({
    task,
    meta: { attempt: 1 },
    payload: {
      changedPaths: ['plugin/src/gates.mjs'],
      acceptanceResults: [{ criterion: CRITERION, status: 'passed', evidence: 'receipt:r1' }],
    },
    receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }],
    diffPaths: ['plugin/src/gates.mjs'],
  });
  assert.equal(result.ok, true, `同值不是歧义：${JSON.stringify(codes(result))}`);
  assert.equal(countCode(result, 'E_CONTRACT_AMBIGUOUS'), 0);
});

test('W2-A contract:{} 回退顶层 → 不算歧义（只有一个来源，没有"两处"）', () => {
  const result = evaluateCompletion({
    task: {
      id: 'T1',
      kind: 'implementation',
      contract: {},
      acceptance: [CRITERION],
      verify: [TEST_CMD],
      inScope: ['plugin/src/gates.mjs'],
      outOfScope: [],
    },
    meta: { attempt: 1 },
    payload: {
      changedPaths: ['plugin/src/gates.mjs'],
      acceptanceResults: [{ criterion: CRITERION, status: 'passed', evidence: 'receipt:r1' }],
    },
    receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }],
    diffPaths: ['plugin/src/gates.mjs'],
  });
  assert.equal(result.ok, true, `contract:{} 回退顶层后字段只有一个来源：${JSON.stringify(codes(result))}`);
  assert.equal(countCode(result, 'E_CONTRACT_AMBIGUOUS'), 0);
});

test('W2-A 非质量 kind（work）不判契约歧义（work 没有契约可比）', () => {
  const result = evaluateCompletion({
    task: {
      id: 'W1',
      kind: 'work',
      contract: { inScope: ['plugin/src/'] },
      inScope: ['docs/'],
    },
    meta: { attempt: 1 },
    payload: { changedPaths: [], acceptanceResults: [] },
    receipts: [],
    diffPaths: [],
  });
  assert.equal(countCode(result, 'E_CONTRACT_AMBIGUOUS'), 0, `work 不判歧义：${JSON.stringify(codes(result))}`);
  assert.equal(result.ok, true);
});

test('W2-A 歧义与完整性可以同时命中（同一份坏契约的两面，都要说）', () => {
  const result = evaluateCompletion({
    task: {
      id: 'T1',
      kind: 'implementation',
      contract: { inScope: ['plugin/src/gates.mjs'] }, // 缺 acceptance 与 verify
      inScope: ['docs/'], // 且与契约异值
    },
    meta: { attempt: 1 },
    payload: { changedPaths: ['plugin/src/gates.mjs'], acceptanceResults: [] },
    receipts: [],
    diffPaths: ['plugin/src/gates.mjs'],
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('E_CONTRACT_AMBIGUOUS'), JSON.stringify(codes(result)));
  assert.ok(codes(result).includes('E_CONTRACT_INCOMPLETE'), JSON.stringify(codes(result)));
});

/* ------------------------------------------------------------------------- */
/* 7f. W2-B 契约完整性：没有 verify 的 implementation 不能完成（F4-4 / D-8）      */
/* ------------------------------------------------------------------------- */

test('W2-B verify:[] 的 implementation + 任意成功回执 → E_CONTRACT_INCOMPLETE（F4-4 主洞）', () => {
  // 修前：关① 没有 verify 项可对账 → 整段跳过 → 一条任意成功回执就能完成，
  // 而 delivery 侧要求 acceptance+verify → "能完成但永远不可交付"的死结。
  const result = evaluateCompletion(implInput({ task: { contract: { verify: [] } } }));
  assert.equal(result.ok, false, '不写 verify 不能成为"关掉关①"的开关');
  assert.ok(codes(result).includes('E_CONTRACT_INCOMPLETE'), `实际 ${JSON.stringify(codes(result))}`);
  const message = result.errors.find((error) => error.code === 'E_CONTRACT_INCOMPLETE').message;
  assert.match(message, /verify/);
  assert.match(message, /kind=implementation/);
});

test('W2-B contract:{} 的 review + verdict:pass → 拒（review 也要说清通过什么）', () => {
  const result = evaluateCompletion({
    task: { id: 'R1', kind: 'review', contract: {} },
    meta: { attempt: 1 },
    payload: { verdict: 'pass', findings: [], changedPaths: [], acceptanceResults: [] },
    receipts: [],
    diffPaths: [],
  });
  assert.equal(result.ok, false, '没有任何契约声明的 review 不得完成');
  assert.ok(codes(result).includes('E_CONTRACT_INCOMPLETE'), `实际 ${JSON.stringify(codes(result))}`);
  assert.match(result.errors.find((error) => error.code === 'E_CONTRACT_INCOMPLETE').message, /kind=review/);
});

test('W2-B review 只缺 verify → 同样 E_CONTRACT_INCOMPLETE（review 是质量 kind）', () => {
  const result = evaluateCompletion({
    task: { id: 'R1', kind: 'review', contract: { acceptance: [REVIEW_CRITERION] } },
    meta: { attempt: 1 },
    payload: {
      verdict: 'pass',
      findings: [],
      changedPaths: [],
      acceptanceResults: [{ criterion: REVIEW_CRITERION, status: 'passed', evidence: 'receipt:rr1' }],
    },
    receipts: [{ id: 'rr1', command: REVIEW_CMD, exit_code: 0 }],
    diffPaths: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_CONTRACT_INCOMPLETE'], `实际 ${JSON.stringify(codes(result))}`);
  assert.match(result.errors[0].message, /缺少 verify/);
});

test('W2-B verify 全是空条目（["", "  "]）等于没有 verify', () => {
  const result = evaluateCompletion(
    implInput({ task: { contract: { verify: ['', '  '] } } }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_CONTRACT_INCOMPLETE'), 1, `实际 ${JSON.stringify(codes(result))}`);
});

test('W2-B 合法 implementation（acceptance + verify 齐）→ 通过（防误伤）', () => {
  assert.deepEqual(evaluateCompletion(implInput()), { ok: true, errors: [] });
});

test('W2-B 合法 review（acceptance + verify 齐 + 本轮证据）→ 通过（防误伤）', () => {
  const result = evaluateCompletion(reviewInput());
  assert.equal(result.ok, true, `实际 ${JSON.stringify(codes(result))}`);
  assert.deepEqual(result.errors, []);
  assert.equal(result.review.deliverable, true);
});

test('W2-B 质量 kind 的完整性判定与 delivery 同码同义（都叫 E_CONTRACT_INCOMPLETE）', () => {
  // 同一份"缺 verify"的实现任务：gates 与 delivery 的码必须一致，否则成员要处理两种事实。
  const task = {
    id: 't1',
    kind: 'implementation',
    status: 'completed',
    changedPaths: ['plugin/src/gates.mjs'],
    contract: { acceptance: [CRITERION], inScope: ['plugin/src/'] },
  };
  const result = evaluateCompletion({
    task,
    meta: { attempt: 1 },
    payload: {
      changedPaths: ['plugin/src/gates.mjs'],
      acceptanceResults: [{ criterion: CRITERION, status: 'passed', evidence: 'receipt:r1' }],
    },
    receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }],
    diffPaths: ['plugin/src/gates.mjs'],
  });
  assert.ok(codes(result).includes('E_CONTRACT_INCOMPLETE'), JSON.stringify(codes(result)));
});

/* ------------------------------------------------------------------------- */
/* 7g. W2-C 轮次解析链统一（F4-5 / D-7）                                        */
/* ------------------------------------------------------------------------- */

test('W2-C task.attempt={n:2} + meta 缺省 + 无标回执 → E_STALE_ATTEMPT（blocker 核心）', () => {
  // 修前：round 只读 meta.attempt，漏写 meta 就退回第 1 轮 → 无标回执再次可用（L-11 第二条入口）。
  const result = evaluateCompletion(
    implInput({
      task: { attempt: { n: 2 } },
      meta: {},
      receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }],
    }),
  );
  assert.equal(result.ok, false, '任务记录说这是第 2 轮时，不能拿无标回执过关');
  assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 1, `实际 ${JSON.stringify(codes(result))}`);
  assert.match(result.errors.find((error) => error.code === 'E_STALE_ATTEMPT').message, /第 2 轮/);
});

test('W2-C task.attempt=2 + meta:{attempt:2} + 无标回执 → E_STALE_ATTEMPT（两侧一致）', () => {
  const result = evaluateCompletion(
    implInput({
      task: { attempt: 2 },
      meta: { attempt: 2 },
      receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 1, `实际 ${JSON.stringify(codes(result))}`);
});

test('W2-C task.attempt={n:2} + meta:{attempt:2} + 回执标 2 → 通过（正例，别把"带标"当罪）', () => {
  const result = evaluateCompletion(
    implInput({
      task: { attempt: { n: 2 } },
      meta: { attempt: 2 },
      receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 2 }],
    }),
  );
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('W2-C meta:{attempt:2} + task.attempt=3 → E_INPUT_INVALID（轮次歧义，不许选边）', () => {
  for (const taskAttempt of [3, { n: 3, id: 'a3' }]) {
    const result = evaluateCompletion(
      implInput({
        task: { attempt: taskAttempt },
        meta: { attempt: 2 },
        receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 2 }],
      }),
    );
    assert.equal(result.ok, false, `task.attempt=${JSON.stringify(taskAttempt)} 与 meta 冲突时必须拒`);
    assert.equal(countCode(result, 'E_INPUT_INVALID'), 1, `实际 ${JSON.stringify(codes(result))}`);
    assert.match(result.errors[0].message, /轮次歧义/);
    assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 0, '歧义时不选边：不做新旧判定');
  }
});

test('W2-C 全缺失 → 视为第 1 轮，无标回执通过', () => {
  const result = evaluateCompletion(
    implInput({ task: { attempt: undefined }, meta: {}, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }] }),
  );
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("W2-C 标量形态非法（'2' / 2.5 / 0 / -1 / true）→ E_INPUT_INVALID，meta 侧与任务侧各查一遍", () => {
  for (const attempt of ['2', 2.5, 0, -1, true]) {
    const viaMeta = evaluateCompletion(implInput({ meta: { attempt } }));
    assert.equal(viaMeta.ok, false, `meta.attempt=${JSON.stringify(attempt)} 必须拒`);
    assert.deepEqual(codes(viaMeta), ['E_INPUT_INVALID'], `实际 ${JSON.stringify(codes(viaMeta))}`);

    const viaTask = evaluateCompletion(implInput({ task: { attempt }, meta: {} }));
    assert.equal(viaTask.ok, false, `task.attempt=${JSON.stringify(attempt)} 必须拒`);
    assert.deepEqual(codes(viaTask), ['E_INPUT_INVALID'], `实际 ${JSON.stringify(codes(viaTask))}`);
  }
});

test('W2-C 任务侧记录形态畸形（{n:0} / {n:"2"} / {n:{}} / {}）→ E_INPUT_INVALID', () => {
  for (const attempt of [{ n: 0 }, { n: '2' }, { n: {} }, {}]) {
    const result = evaluateCompletion(implInput({ task: { attempt }, meta: {} }));
    assert.equal(result.ok, false, `task.attempt=${JSON.stringify(attempt)} 必须拒`);
    assert.deepEqual(codes(result), ['E_INPUT_INVALID'], `实际 ${JSON.stringify(codes(result))}`);
  }

  // 对照：`{n:null}` 与标量 null 同义 —— JSON 往返里"没写"的样子，按缺失（第 1 轮）处理。
  const nullRecord = evaluateCompletion(
    implInput({ task: { attempt: { n: null } }, meta: {}, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }] }),
  );
  assert.deepEqual(nullRecord, { ok: true, errors: [] }, '{n:null} 是"没写"，不是"写错了"');
});

test('W2-C meta.attempt 只认标量：{n:2} → E_INPUT_INVALID（记录形态只在任务侧放宽）', () => {
  const result = evaluateCompletion(implInput({ meta: { attempt: { n: 2 } }, task: { attempt: { n: 2 } } }));
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_INPUT_INVALID'], `实际 ${JSON.stringify(codes(result))}`);
  assert.match(result.errors[0].message, /meta\.attempt/);
});

test('W2-C 解析链顺序：contract.attempt 优先于顶层 task.attempt', () => {
  // 契约里写 attempt:2、顶层写 1 → 按契约那份（2）判：无标回执 = 过期。
  const result = evaluateCompletion({
    task: {
      id: 'T1',
      kind: 'implementation',
      attempt: 1,
      contract: {
        acceptance: [CRITERION],
        verify: [TEST_CMD],
        inScope: ['plugin/src/gates.mjs'],
        outOfScope: [],
        attempt: 2,
      },
    },
    meta: {},
    payload: {
      changedPaths: ['plugin/src/gates.mjs'],
      acceptanceResults: [{ criterion: CRITERION, status: 'passed', evidence: 'receipt:r1' }],
    },
    receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }],
    diffPaths: ['plugin/src/gates.mjs'],
  });
  assert.equal(result.ok, false, '契约说第 2 轮 → 无标回执不能用');
  assert.equal(countCode(result, 'E_STALE_ATTEMPT'), 1, `实际 ${JSON.stringify(codes(result))}`);
});

test('W2-C 解析链：两侧都有值时只允许相等，不等即轮次歧义（meta 不该"盖过"任务侧）', () => {
  const same = evaluateCompletion(
    implInput({
      task: { attempt: { n: 2 } },
      meta: { attempt: 2 },
      receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 2 }],
    }),
  );
  assert.deepEqual(same, { ok: true, errors: [] });

  // 任务侧停在 2、meta 说 3 → 不是"以 meta 为准"，而是拒绝：门禁不替调用方选边。
  const conflict = evaluateCompletion(
    implInput({
      task: { attempt: { n: 2 } },
      meta: { attempt: 3 },
      receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 2 }],
    }),
  );
  assert.equal(conflict.ok, false);
  assert.deepEqual(codes(conflict), ['E_INPUT_INVALID'], `实际 ${JSON.stringify(codes(conflict))}`);
  assert.match(conflict.errors[0].message, /轮次歧义/);
  assert.equal(countCode(conflict, 'E_STALE_ATTEMPT'), 0, '歧义时不判新旧（不选边就没有"本轮"）');
});

/* ------------------------------------------------------------------------- */
/* 8. G4 负向判断一律改白名单                                                  */
/* ------------------------------------------------------------------------- */

test('G4 verdict 拼错 → E_INPUT_INVALID（不静默当作非 pass 放行，也不当成缺失）', () => {
  for (const verdict of ['aprove', 'PASS', 'needs-revision', 'done']) {
    const result = evaluateCompletion(reviewInput({ payload: { verdict, findings: [] } }));
    assert.equal(result.ok, false, `verdict=${verdict} 不该被放行`);
    assert.ok(codes(result).includes('E_INPUT_INVALID'), `verdict=${verdict} 应报 E_INPUT_INVALID，实际 ${JSON.stringify(codes(result))}`);
    assert.equal(result.review.recognized, false);
    assert.equal(result.review.verdict, '', '拼错的裁决不落盘');
    assert.equal(result.review.deliverable, false);
  }
});

test('G4 finding severity 拼错 / 缺失 → E_INPUT_INVALID；critical 与 blocker 同级', () => {
  for (const severity of ['HIGH', 'blocking', 'critical!!', '', undefined]) {
    const result = evaluateCompletion(
      reviewInput({ payload: { verdict: 'pass', findings: [{ severity, title: '未解决的严重问题' }] } }),
    );
    assert.equal(result.ok, false, `severity=${JSON.stringify(severity)} 不该被当成低危忽略`);
    assert.ok(codes(result).includes('E_INPUT_INVALID'), `实际 ${JSON.stringify(codes(result))}`);
  }

  const critical = evaluateCompletion(
    reviewInput({ payload: { verdict: 'pass', findings: [{ severity: 'critical', title: '越权写库' }] } }),
  );
  assert.equal(countCode(critical, 'E_OPEN_FINDINGS'), 1, 'critical 必须与 blocker 同级阻止 pass');

  const resolvedCritical = evaluateCompletion(
    reviewInput({
      payload: { verdict: 'pass', findings: [{ severity: 'critical', title: '越权写库', status: 'resolved' }] },
    }),
  );
  assert.equal(resolvedCritical.ok, true);

  assert.ok(REVIEW_SEVERITIES.includes('medium'));
  assert.ok(BLOCKING_SEVERITIES.includes('critical'));
  assert.ok(!BLOCKING_SEVERITIES.includes('medium'));
});

test('G4 ERROR_CODES 覆盖本模块产出的全部错误码（码表已登记，拼错无处藏身）', () => {
  const samples = [
    assertTransition({ from: 'pending', to: 'completed', actor: 'worker' }),
    evaluateCompletion(implInput()),
    evaluateCompletion(implInput({ receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 1 }] })),
    evaluateCompletion(implInput({ meta: { attempt: 2 }, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: 1 }] })),
    evaluateCompletion(reviewInput({ payload: { verdict: 'needs_revision', findings: [] } })),
    evaluateCompletion({
      task: { id: 'task-1', kind: 'implementation', contract: {} },
      payload: { changedPaths: ['../../etc/passwd'], acceptanceResults: [] },
      receipts: [],
      diffPaths: ['../../etc/passwd'],
    }),
    // G6 三个产出点：形态非法 / 无标过期 / 非法标注过期
    evaluateCompletion(implInput({ meta: { attempt: '2' } })),
    evaluateCompletion(implInput({ meta: { attempt: 2 }, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }] })),
    evaluateCompletion(implInput({ meta: { attempt: 2 }, receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0, attempt: '1' }] })),
    // G7 声明非法
    evaluateCompletion(implInput({ task: { contract: { inScope: ['../etc'] } } })),
    // W2-A 契约歧义
    evaluateCompletion({
      task: ambiguousImpl(),
      meta: { attempt: 1 },
      payload: {
        changedPaths: ['plugin/src/gates.mjs'],
        acceptanceResults: [{ criterion: CRITERION, status: 'passed', evidence: 'receipt:r1' }],
      },
      receipts: [{ id: 'r1', command: TEST_CMD, exit_code: 0 }],
      diffPaths: ['plugin/src/gates.mjs'],
    }),
    // W2-C 轮次歧义
    evaluateCompletion(implInput({ task: { attempt: 3 }, meta: { attempt: 2 } })),
    // (G8 / W2-B 的 E_CONTRACT_INCOMPLETE 由上面 contract:{} 的样本产出)
  ];
  for (const result of samples) {
    const list = result.errors ?? [];
    for (const error of list) {
      assert.ok(ERROR_CODES.includes(error.code), `${error.code} 没有登记进 ERROR_CODES`);
    }
    if (result.code) assert.ok(ERROR_CODES.includes(result.code), `${result.code} 没有登记进 ERROR_CODES`);
  }
  assert.ok(Object.isFrozen(ERROR_CODES));
  assert.ok(ERROR_CODES.includes('E_STALE_ATTEMPT'));
  assert.ok(ERROR_CODES.includes('E_SCOPE_UNDECLARED'));
  // 本轮新增码必须在表里（G8 / W2-A），否则"码表漂移"会从这里开始
  assert.ok(ERROR_CODES.includes('E_CONTRACT_INCOMPLETE'), 'E_CONTRACT_INCOMPLETE 必须登记');
  assert.ok(ERROR_CODES.includes('E_CONTRACT_AMBIGUOUS'), 'W2-A 新增的 E_CONTRACT_AMBIGUOUS 必须登记');
  assert.ok(ERROR_CODES.includes('E_PATH_UNSAFE'), 'G7 复用的 E_PATH_UNSAFE 必须登记');
  assert.ok(ERROR_CODES.includes('E_INPUT_INVALID'), 'G6 复用的 E_INPUT_INVALID 必须登记');
});

/* ------------------------------------------------------------------------- */
/* 9. G5 review 完成定义：needs_revision 可表达但不可交付                        */
/* ------------------------------------------------------------------------- */

test('G5 needs_revision 是合法裁决但未完成：不得进入可交付集合', () => {
  const result = evaluateCompletion(
    reviewInput({
      payload: { verdict: 'needs_revision', findings: [{ severity: 'blocker', title: '越界写库' }] },
    }),
  );
  assert.equal(result.ok, false, 'needs_revision 不得判为完成');
  assert.ok(codes(result).includes('E_VERDICT_REQUIRED'));
  assert.equal(result.review.verdict, 'needs_revision', '裁决原样回传，供调用方落盘到 task.reviewed.verdict');
  assert.equal(result.review.recognized, true);
  assert.equal(result.review.deliverable, false);
  assert.ok(!COMPLETION_VERDICTS.includes('needs_revision'));
});

test('G5 reject 同样可表达、同样不可交付', () => {
  const result = evaluateCompletion(
    reviewInput({ payload: { verdict: 'reject', findings: [{ severity: 'high', title: '方案不可行' }] } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.review.verdict, 'reject');
  assert.equal(result.review.deliverable, false);
  assert.ok(!COMPLETION_VERDICTS.includes('reject'));
});

test('G5 resolveReviewVerdict 是裁决的唯一出口：pass 才 deliverable', () => {
  const pass = resolveReviewVerdict({ verdict: 'pass', findings: [] });
  assert.deepEqual(
    { verdict: pass.verdict, recognized: pass.recognized, deliverable: pass.deliverable, errors: pass.errors },
    { verdict: 'pass', recognized: true, deliverable: true, errors: [] },
  );

  const needsRevision = resolveReviewVerdict({
    verdict: 'needs_revision',
    findings: [{ severity: 'medium', title: '补一条边界用例' }],
  });
  assert.equal(needsRevision.verdict, 'needs_revision');
  assert.equal(needsRevision.recognized, true);
  assert.equal(needsRevision.deliverable, false);
  assert.deepEqual(needsRevision.errors.map((error) => error.code), ['E_VERDICT_REQUIRED']);

  const passWithOpenBlocker = resolveReviewVerdict({
    verdict: 'pass',
    findings: [{ severity: 'blocker', title: '并发丢回执' }],
  });
  assert.equal(passWithOpenBlocker.deliverable, false);
  assert.deepEqual(passWithOpenBlocker.blockingFindings, [{ severity: 'blocker', title: '并发丢回执' }]);

  assert.deepEqual([...COMPLETION_VERDICTS], ['pass']);
  assert.deepEqual([...REVIEW_VERDICTS], ['pass', 'needs_revision', 'reject']);
});

/* ------------------------------------------------------------------------- */
/* C-1：质量 kind 口径只有一个来源（第 12 轮）                                 */
/* ------------------------------------------------------------------------- */

test('C-1 质量 kind 只有一份口径：关⓪ 的判定与 contract.mjs 的 QUALITY_KINDS 对每个 kind 逐一相同', () => {
  // 第 12 轮（C-1）：gates.mjs 原有一份 `const QUALITY_KINDS = Object.freeze(['implementation','review'])`，
  // 与 contract.mjs 的那份是两个互不相干的字面量。失败模式不是"现在就错"，而是
  // **以后加第三个 kind 时漏改一处不会报错，只会静默少判**：gates 会放行一个没写验收条件的任务。
  // 这条用例的期望值取自 contract.mjs（唯一真相源），逐个 kind 对账：
  // 质量 kind 缺 acceptance/verify → 恰好 1 次 E_CONTRACT_INCOMPLETE；非质量 kind → 0 次。
  // 只要 gates 又长出字面量副本，加第三个 kind 后这里立刻红。
  for (const kind of KINDS) {
    const result = evaluateCompletion({
      task: { id: `T-${kind}`, kind, contract: {} },
      meta: { attempt: 1, gate_version: 1 },
      payload: { changedPaths: [] },
      receipts: [],
      diffPaths: [],
    });
    const expected = QUALITY_KINDS.includes(kind) ? 1 : 0;
    assert.equal(
      countCode(result, 'E_CONTRACT_INCOMPLETE'),
      expected,
      `kind=${kind}：期望 E_CONTRACT_INCOMPLETE ${expected} 次。`
        + `QUALITY_KINDS=${JSON.stringify(QUALITY_KINDS)}。`
        + '不一致说明 gates.mjs 没有从 contract.mjs 读同一份清单（多半又冒出了一份字面量副本）。',
    );
  }

  // 顺带钉住"这份清单真的是冻结数组"：非冻结数组可以被任何持有者改写，
  // 那等于又变回"每个模块各有一份"，只是藏得更深。
  assert.ok(Array.isArray(QUALITY_KINDS));
  assert.ok(Object.isFrozen(QUALITY_KINDS));
  assert.ok(QUALITY_KINDS.length > 0);
  for (const kind of QUALITY_KINDS) {
    assert.ok(KINDS.includes(kind), `QUALITY_KINDS 里的 ${kind} 不在 KINDS 里：清单越界了`);
  }
});
