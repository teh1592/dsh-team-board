/**
 * delivery.test.mjs —— 交付判定（canDeliver）单元测试
 *
 * 第 3 轮（W3）新增/修订集中在 D7–D12；每条改动的旧断言都在用例注释里写了
 * 「原 → 新 → 为什么」，方便评审逐条核对是不是"改断言凑绿"。
 *
 * 本轮不动的既有防线（全 work 化、缺 sha256、借用他人评审、attempt 对齐四条绕过）保持原断言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
// C-2（第 12 轮）：账本"不许说谎"那条用例要读真实源码，剥掉码表后再看码有没有落点。
import { readFileSync } from 'node:fs';

import {
  canDeliver as canDeliverRaw,
  detectBlindLeak,
  describeDeliveryContract,
  separationOfDuties,
  DELIVERY_BLOCKER_CODES,
  DELIVERY_PLUGIN_LAYER_CODES,
  DELIVERY_WARNING_CODES,
} from '../src/delivery.mjs';
import {
  KINDS,
  QUALITY_KINDS,
  contractOf,
  validatePlan,
  describePathIllegal,
  PATH_ILLEGAL_REASONS,
  toEntryListStrict,
} from '../src/contract.mjs';
import { evaluateCompletion } from '../src/gates.mjs';

/* ------------------------------------------------------------------------- */
/* 夹具                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * task-22 测试垫片：开会是必须的。
 *
 * 新门禁（`E_MEETING_MISSING`）要求每条 `kind: implementation` 任务用 `proposalId`
 * 指向同一输入里的一条**已完成提案**。本文件所有实现类夹具都写于这条门禁之前，
 * 逐个补指针等于把上百处 `tasks: [...]` 都改一遍 —— 而每改一处都可能顺手改坏
 * 它原本要测的那件事。
 *
 * 所以垫一层：给**没有表态**的实现任务补上 `skipMeeting` 理由（走例外通道），
 * 再把垫片自己制造的那条 `E_MEETING_SKIPPED` 从结果里摘掉。
 *
 * 为什么选例外通道而不是补指针：补指针要连带造一条"已完成提案 + 指向它的评审"，
 * 那会同时污染 `blockers` 长度与 `tasks` 里的任务集合；例外通道只多一条 warning，
 * 而且这条 warning 的归属可以由垫片精确回收 —— 门禁自己该不该发它，由
 * `canDeliverRaw` 的专用用例去验，那是唯一有资格对它下结论的地方。
 *
 * 三条纪律：
 *   ① 已经显式写了 `proposalId` / `skipMeeting` 的任务**不动**（新门禁自己的用例靠这个绕过垫片）；
 *   ② **没有契约块**的任务不动 —— 门禁对这类任务本来就沉默（账归 E_CONTRACT_INCOMPLETE）；
 *      强行塞 `skipMeeting` 进去会把"没写契约"改写成"写了半份契约"，反而伪造出
 *      E_CONTRACT_INCOMPLETE / E_OUT_OF_SCOPE（D5 / D7 那几条用例就是这么红的）；
 *   ③ 垫片只影响本文具，不影响 `_gate-snapshot` 之类真实数据。
 *
 * 这是本项目"同一件事写在 N 处"的第六次复发，治法照旧：**集中一处，写清为什么**。
 */
const MEETING_SHIM_REASON = '（测试垫片：这条夹具写于开会门禁之前，按例外通道放行）';

function withMeetingShim(input) {
  if (input === null || typeof input !== 'object') return input;
  if (!Array.isArray(input.tasks)) return input;

  let touched = false;
  const tasks = input.tasks.map((task) => {
    if (task === null || typeof task !== 'object') return task;
    if (task.kind !== 'implementation') return task;

    // 与 delivery 内部同一判据：契约视图来自 `task.contract` 才算"写了契约块"
    const contract = contractOf(task);
    if (contract === task) return task;

    if (Object.hasOwn(contract, 'proposalId') || Object.hasOwn(contract, 'skipMeeting')) return task;

    touched = true;
    return { ...task, contract: { ...contract, skipMeeting: MEETING_SHIM_REASON } };
  });

  return touched ? { ...input, tasks } : input;
}

/**
 * 把垫片自己制造的 `E_MEETING_SKIPPED` 从结果里摘掉。
 *
 * 为什么不是"干脆别发这条警告"：这条警告在真实台账上必须存在（例外要留痕）。
 * 垫片的任务只是让**旧夹具**不因新门禁改判，所以它回收自己也造出来的那一条；
 * 本文具里没有任何用例声明 `skipMeeting`（要验门禁的都走 `canDeliverRaw`），
 * 于是"回收全部 E_MEETING_SKIPPED"不会误伤别的用例。
 */
function withoutShimWarnings(result) {
  if (result === null || typeof result !== 'object') return result;
  if (!Array.isArray(result.warnings)) return result;

  const kept = result.warnings.filter((w) => w?.code !== 'E_MEETING_SKIPPED');
  if (kept.length === result.warnings.length) return result;

  const next = { ...result };
  if (kept.length > 0) next.warnings = kept;
  else delete next.warnings;           // "只在有警告时出现"这条形状约定要保住
  return next;
}

/** 垫片版 `canDeliver`：既有用例走这条；新门禁的用例直接调 `canDeliverRaw`。 */
function canDeliver(input) {
  return withoutShimWarnings(canDeliverRaw(withMeetingShim(input)));
}

const FILE = 'plugin/src/delivery.mjs';
const FILE2 = 'plugin/src/other.mjs';
const SHA = 'sha-1111111111111111111111111111111111111111111111111111111111111111';
const SHA2 = 'sha-2222222222222222222222222222222222222222222222222222222222222222';

/** 宿主签发的交付记录（规格 §7：by 以 host: 开头 + 蛇形 call_id + evidence_digest）。 */
const DELIVERED = {
  by: 'host:actionCard',
  call_id: 'call-1',
  at: '2026-11-16T15:00:00+08:00',
  evidence_digest: 'sha-evidence-1',
};

/** 正常实现任务：completed，路径落在 inScope 内。 */
function implTask(over = {}) {
  return {
    id: 'impl-1',
    kind: 'implementation',
    status: 'completed',
    changedPaths: [FILE],
    contract: {
      inScope: ['plugin/src/'],
      outOfScope: ['plugin/secrets/'],
      acceptance: ['canDeliver 返回 ok/blockers'],
      verify: ['node --test plugin/test/delivery.test.mjs'],
    },
    ...over,
  };
}

/** 只读调研任务。 */
function workTask(over = {}) {
  return {
    id: 'work-1',
    kind: 'work',
    status: 'completed',
    changedPaths: [],
    contract: { inScope: ['plugin/src/'], outOfScope: [] },
    ...over,
  };
}

/** 正常评审任务：completed + pass，产物绑定到当前指纹，归属 impl-1。 */
function reviewTask(over = {}) {
  return {
    id: 'review-1',
    kind: 'review',
    status: 'completed',
    changedPaths: [],
    sourceTaskId: 'impl-1',
    contract: {
      reviewedTaskId: 'impl-1',
      inScope: [],
      outOfScope: [],
      acceptance: ['评审通过'],
      verify: ['node --test'],
    },
    reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: true, sha256: SHA }] },
    ...over,
  };
}

/** 全部满足的理想输入。 */
function baseInput(over = {}) {
  return {
    team: { phase: 'running', leaderMode: 'spawned', delivered: { ...DELIVERED }, base: { gitHead: 'abc1234' } },
    tasks: [implTask(), reviewTask()],
    currentDigests: { [FILE]: SHA },
    diffPaths: [FILE],
    ...over,
  };
}

/** 取出 blocker code 列表。 */
function codes(result) {
  return result.blockers.map((b) => b.code);
}

/** 断言结构契约：ok 是布尔、blockers 是数组、每条 code/message 都是非空字符串。 */
function assertShape(result) {
  assert.equal(typeof result.ok, 'boolean');
  assert.ok(Array.isArray(result.blockers));
  for (const blocker of result.blockers) {
    assert.equal(typeof blocker.code, 'string');
    assert.ok(blocker.code.length > 0);
    assert.equal(typeof blocker.message, 'string');
    assert.ok(blocker.message.length > 0);
  }
  // warnings 是"只在非空时出现"的可选字段（J-2 之后 legacy 团队也会有）
  if (result.warnings !== undefined) {
    assert.ok(Array.isArray(result.warnings), 'warnings 必须是数组');
    for (const warning of result.warnings) {
      assert.equal(typeof warning.code, 'string');
      assert.ok(warning.code.length > 0);
      assert.equal(typeof warning.message, 'string');
      assert.ok(warning.message.length > 0);
    }
  }
  assert.equal(result.ok, result.blockers.length === 0);
}

/** 便捷断言：结果被拒，且包含指定 code。 */
function assertBlocked(result, code, label = '') {
  assertShape(result);
  assert.equal(result.ok, false, `${label} 应被拒绝，实际 ${JSON.stringify(result.blockers)}`);
  assert.ok(
    codes(result).includes(code),
    `${label} 应包含 ${code}，实际 ${JSON.stringify(codes(result))}`,
  );
}

/* ------------------------------------------------------------------------- */
/* 基线：全部满足 → ok:true                                                   */
/* ------------------------------------------------------------------------- */

test('全部满足时 ok:true、blockers 为空（legacy 团队带一条独立性警告）', () => {
  // 第 7 轮修订（J-2 / J-5，形状变更）：
  // 原断言 `assert.deepEqual(result, { ok: true, blockers: [] })`。
  // 现在不能整体深比较了 —— legacy 团队（所有任务都没有 assignee）必须发出
  // `E_INDEPENDENCE_UNENFORCED` 警告，"跳过判定"不许静默。ok 语义不变：警告不阻断。
  const result = canDeliver(baseInput());
  assertShape(result);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(
    result.warnings.map((w) => w.code),
    ['E_INDEPENDENCE_UNENFORCED'],
    'legacy 团队必须有一条"独立性未生效"的警告，否则逃生门不可观测',
  );
  assert.match(result.warnings[0].message, /独立性判定未生效/);
  assert.match(result.warnings[0].message, /assignee/);
});

/* ------------------------------------------------------------------------- */
/* 收集全部 blocker，不短路                                                   */
/* ------------------------------------------------------------------------- */

test('收集全部 blocker：多类问题同时返回，不在第一个处短路', () => {
  const input = baseInput({
    team: { phase: 'halted', leaderMode: 'inline', delivered: undefined, base: { gitHead: 'abc1234' } },
    tasks: [
      implTask({ id: 'impl-1' }),
      reviewTask({ id: 'review-1', reviewed: { verdict: 'fail', artifacts: [] } }),
      implTask({ id: 'impl-2', status: 'failed', changedPaths: [] }),
      implTask({ id: 'impl-3', status: 'cancelled', changedPaths: [], cancelReason: '' }),
      implTask({ id: 'impl-4', status: 'pending', changedPaths: [] }),
    ],
    currentDigests: { [FILE]: SHA },
    diffPaths: [FILE],
  });

  const result = canDeliver(input);
  assertShape(result);
  assert.equal(result.ok, false);

  const found = codes(result);
  for (const expected of [
    'E_NOT_RUNNING',
    'E_TASK_INCOMPLETE',
    'E_FAILED_NO_FOLLOWUP',
    'E_VERDICT_REQUIRED',
    'E_NO_PASSING_REVIEW',
    'E_NEEDS_HUMAN_DELIVERY',
    'E_CANCELLED_NO_REASON',
    'E_UNBOUND_ARTIFACT',
  ]) {
    assert.ok(found.includes(expected), `blockers 应包含 ${expected}，实际：${found.join(',')}`);
  }
  assert.ok(result.blockers.length >= 8, `blockers 数量应 >= 8，实际 ${result.blockers.length}`);
});

/* ------------------------------------------------------------------------- */
/* M2：E_TASK_INCOMPLETE 只针对"仍在流程中"的状态，不双报                       */
/* ------------------------------------------------------------------------- */

test('E_TASK_INCOMPLETE：pending / claimed / in_progress 三种在流程状态都命中', () => {
  for (const status of ['pending', 'claimed', 'in_progress']) {
    const result = canDeliver(
      baseInput({ tasks: [implTask(), reviewTask(), implTask({ id: 'impl-2', status, changedPaths: [] })] }),
    );
    assertBlocked(result, 'E_TASK_INCOMPLETE', `status=${status}`);
    assert.ok(
      result.blockers.some((b) => b.code === 'E_TASK_INCOMPLETE' && b.message.includes('impl-2')),
      'message 应指出具体任务 id',
    );
  }
});

test('M2：failed 只报 E_FAILED_NO_FOLLOWUP，不再双报 E_TASK_INCOMPLETE', () => {
  const result = canDeliver(
    baseInput({ tasks: [implTask(), reviewTask(), implTask({ id: 'impl-2', status: 'failed', changedPaths: [] })] }),
  );
  assertShape(result);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_FAILED_NO_FOLLOWUP'], 'failed 的任务只应命中专项 blocker');
});

test('M2：cancelled 只报 E_CANCELLED_NO_REASON，不再双报 E_TASK_INCOMPLETE', () => {
  const result = canDeliver(
    baseInput({ tasks: [implTask(), reviewTask(), implTask({ id: 'impl-2', status: 'cancelled', changedPaths: [] })] }),
  );
  assertShape(result);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_CANCELLED_NO_REASON'], 'cancelled 的任务只应命中专项 blocker');
});

test('M2：cancelled 写了 cancelReason 时既不报未完成也不报无原因', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask(),
        reviewTask(),
        implTask({ id: 'impl-2', status: 'cancelled', changedPaths: [], cancelReason: '需求撤回，本迭代不做' }),
      ],
    }),
  );
  assertShape(result);
  assert.deepEqual(codes(result), []);
});

/* ------------------------------------------------------------------------- */
/* 其余专项 blocker                                                           */
/* ------------------------------------------------------------------------- */

test('E_NOT_RUNNING：phase 为 halted / archived 时阻塞交付', () => {
  // D8 修订：原用例把 staged 与 halted/archived 混在一起断言 E_NOT_RUNNING。
  // 现在 staged 是"还没批准"，语义与"已停止"不同 → 单独报 E_NEEDS_HUMAN_APPROVAL（见下一条用例）。
  for (const phase of ['halted', 'archived']) {
    const result = canDeliver(baseInput({ team: { ...baseInput().team, phase } }));
    assertShape(result);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ['E_NOT_RUNNING'], `phase=${phase} 应只报 E_NOT_RUNNING`);
    assert.match(result.blockers[0].message, new RegExp(phase));
  }
});

test('E_NEEDS_HUMAN_APPROVAL：phase=staged 是"还没批准"，与"已停止"区分开', () => {
  const result = canDeliver(baseInput({ team: { ...baseInput().team, phase: 'staged' } }));
  assertShape(result);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_NEEDS_HUMAN_APPROVAL']);
  assert.match(result.blockers[0].message, /staged/);
  assert.match(result.blockers[0].message, /批准|approval|人工/);
});

test('E_NOT_RUNNING：running 阶段本身不阻塞（由其他条件决定）', () => {
  const result = canDeliver(baseInput());
  assert.ok(!codes(result).includes('E_NOT_RUNNING'));
});

test('E_FAILED_NO_FOLLOWUP：有 sourceTaskId 或 sourceReviewId 的后续任务时解除', () => {
  const followUpByTask = canDeliver(
    baseInput({
      tasks: [
        implTask(),
        reviewTask(),
        implTask({ id: 'impl-2', status: 'failed', changedPaths: [] }),
        implTask({ id: 'impl-3', status: 'completed', changedPaths: [], sourceTaskId: 'impl-2' }),
      ],
    }),
  );
  assert.ok(!codes(followUpByTask).includes('E_FAILED_NO_FOLLOWUP'), 'sourceTaskId 指向失败任务时应解除');

  const followUpByReview = canDeliver(
    baseInput({
      tasks: [
        implTask(),
        reviewTask(),
        reviewTask({ id: 'review-2', status: 'failed', reviewed: { verdict: 'fail', artifacts: [] } }),
        implTask({ id: 'impl-3', status: 'completed', changedPaths: [], sourceReviewId: 'review-2' }),
      ],
    }),
  );
  assert.ok(!codes(followUpByReview).includes('E_FAILED_NO_FOLLOWUP'), 'sourceReviewId 指向失败评审时应解除');
});

test('E_VERDICT_REQUIRED：review 已完成但 verdict 不是 pass', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask(),
        reviewTask({ id: 'review-1', reviewed: { verdict: 'fail', artifacts: [] } }),
        reviewTask({ id: 'review-2' }),
      ],
    }),
  );
  assertShape(result);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_VERDICT_REQUIRED']);
  assert.ok(result.blockers[0].message.includes('review-1'));
});

test('E_VERDICT_REQUIRED：已完成 review 缺 reviewed.verdict 同样阻塞', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask(), reviewTask({ id: 'review-1', reviewed: undefined }), reviewTask({ id: 'review-2' })],
    }),
  );
  assert.ok(codes(result).includes('E_VERDICT_REQUIRED'));
});

test('E_NO_PASSING_REVIEW：有 completed 实现但没有任何 completed + pass 评审', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask(), reviewTask({ id: 'review-1', status: 'work', reviewed: undefined })],
    }),
  );
  assertShape(result);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('E_NO_PASSING_REVIEW'));
  assert.ok(result.blockers.some((b) => b.code === 'E_NO_PASSING_REVIEW' && b.message.includes('impl-1')));
});

test('E_NO_PASSING_REVIEW：实现未 completed 时不触发此条', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask({ status: 'work' }), reviewTask({ status: 'work', reviewed: undefined })],
      diffPaths: [FILE],
    }),
  );
  assert.ok(!codes(result).includes('E_NO_PASSING_REVIEW'));
});

test('E_OUT_OF_SCOPE：申报路径不在 inScope 或命中 outOfScope', () => {
  const undeclared = 'plugin/test/leak.test.mjs';
  const outOfScopePath = 'plugin/secrets/key.pem';
  const digests = { [FILE]: SHA, [undeclared]: 'sha-b', [outOfScopePath]: 'sha-c' };

  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ changedPaths: [FILE, undeclared, outOfScopePath] }),
        reviewTask({
          reviewed: {
            verdict: 'pass',
            artifacts: [
              { path: FILE, present: true, sha256: SHA },
              { path: undeclared, present: true, sha256: 'sha-b' },
              { path: outOfScopePath, present: true, sha256: 'sha-c' },
            ],
          },
        }),
      ],
      currentDigests: digests,
      diffPaths: [FILE, undeclared, outOfScopePath],
    }),
  );

  assertShape(result);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('E_OUT_OF_SCOPE'));
  const message = result.blockers.find((b) => b.code === 'E_OUT_OF_SCOPE').message;
  assert.ok(message.includes(undeclared), 'message 应包含未声明路径');
  assert.ok(message.includes(outOfScopePath), 'message 应包含 outOfScope 命中路径');
});

test('E_BINDING_STALE：记录的 sha256 与当前工作区不一致', () => {
  const result = canDeliver(baseInput({ currentDigests: { [FILE]: 'sha-CHANGED' } }));
  assertBlocked(result, 'E_BINDING_STALE', 'sha 不一致');
  assert.ok(result.blockers.some((b) => b.code === 'E_BINDING_STALE' && b.message.includes(FILE)));
  assert.ok(
    !codes(result).includes('E_BINDING_UNVERIFIABLE'),
    '有指纹但不一致只报 STALE，不得混成"不可验证"',
  );
});

test('E_BINDING_STALE：记录为 present:false 但现在存在', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: false }] } })],
    }),
  );
  assertBlocked(result, 'E_BINDING_STALE', 'present:false 但现在存在');
});

test('E_BINDING_STALE：记录存在但现在缺失', () => {
  const result = canDeliver(baseInput({ currentDigests: {} }));
  assertBlocked(result, 'E_BINDING_STALE', '产物现在缺失');
  assert.ok(result.blockers.some((b) => b.code === 'E_BINDING_STALE' && b.message.includes('缺失')));
});

test('E_NEEDS_HUMAN_DELIVERY：delivered 缺失', () => {
  const missing = canDeliver(baseInput({ team: { phase: 'running', leaderMode: 'spawned' } }));
  assertShape(missing);
  assert.equal(missing.ok, false);
  assert.deepEqual(codes(missing), ['E_NEEDS_HUMAN_DELIVERY']);
});

test('E_CANCELLED_NO_REASON：cancelled 任务缺 cancelReason', () => {
  const missingReason = canDeliver(
    baseInput({
      tasks: [implTask(), reviewTask(), implTask({ id: 'impl-2', status: 'cancelled', changedPaths: [] })],
    }),
  );
  assertBlocked(missingReason, 'E_CANCELLED_NO_REASON', 'cancelled 缺原因');
  assert.ok(
    missingReason.blockers.some((b) => b.code === 'E_CANCELLED_NO_REASON' && b.message.includes('impl-2')),
  );
});

/* ------------------------------------------------------------------------- */
/* D1 [B1] 关掉「全 work 化」绕过                                             */
/* ------------------------------------------------------------------------- */

test('D1 全 work 化攻击：全部 kind=work + status=completed + 自报路径 → 拒绝且 blockers 非空', () => {
  const result = canDeliver(
    baseInput({
      tasks: [workTask({ id: 'w1', changedPaths: [FILE] }), workTask({ id: 'w2', changedPaths: [] })],
    }),
  );

  assertShape(result);
  assert.equal(result.ok, false, '全 work 化必须被拒绝');
  assert.ok(result.blockers.length > 0);
  const found = codes(result);
  assert.ok(found.includes('E_WORK_DECLARED_CHANGES'), `应命中 E_WORK_DECLARED_CHANGES，实际 ${found.join(',')}`);
  assert.ok(found.includes('E_UNREPORTED_CHANGES'), `应命中 E_UNREPORTED_CHANGES，实际 ${found.join(',')}`);
  assert.ok(
    result.blockers.some((b) => b.code === 'E_WORK_DECLARED_CHANGES' && b.message.includes('w1')),
    'message 应指出伪造申报的 work 任务',
  );
});

test('D1 work 任务申报的路径不认领 diffPaths（认领只认 completed 的代码变更任务）', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask({ status: 'work' }), workTask({ id: 'w1', changedPaths: [FILE] })],
    }),
  );
  assertBlocked(result, 'E_UNREPORTED_CHANGES', 'work 认领 diffPaths');
  assertBlocked(result, 'E_WORK_DECLARED_CHANGES', 'work 申报变更');
});

test('D1 work 申报空数组时 E_WORK_DECLARED_CHANGES 不触发（只读任务合法）', () => {
  const result = canDeliver(
    baseInput({ tasks: [implTask(), reviewTask(), workTask({ id: 'w1', changedPaths: [] })], diffPaths: [FILE] }),
  );
  assertShape(result);
  assert.ok(!codes(result).includes('E_WORK_DECLARED_CHANGES'));
  assert.deepEqual(codes(result), []);
});

test('D1 work 任务不能豁免绑定检查：它的申报路径永远进不了绑定集合', () => {
  // 攻击者的第二跳：把 impl-2 降级成 work，再用 work 申报路径 + 借别人的评审。
  const result = canDeliver(
    baseInput({
      tasks: [implTask({ id: 'impl-1' }), workTask({ id: 'w2', changedPaths: [FILE2] }), reviewTask()],
      currentDigests: { [FILE]: SHA, [FILE2]: SHA2 },
      diffPaths: [FILE, FILE2],
    }),
  );
  assertBlocked(result, 'E_WORK_DECLARED_CHANGES', 'work 申报');
  assertBlocked(result, 'E_UNREPORTED_CHANGES', 'work 申报路径不算认领');
});

/* ------------------------------------------------------------------------- */
/* D2 [B6] artifact 缺 sha256 不得跳过指纹比对                                */
/* ------------------------------------------------------------------------- */

test('D2 省略 sha256 → E_BINDING_UNVERIFIABLE（且绑定不成立）', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: true }] } })],
    }),
  );
  assertBlocked(result, 'E_BINDING_UNVERIFIABLE', '缺 sha256');
  assertBlocked(result, 'E_UNBOUND_ARTIFACT', '缺指纹的绑定不算绑定');
  assert.ok(
    result.blockers.some((b) => b.code === 'E_BINDING_UNVERIFIABLE' && b.message.includes(FILE)),
    'message 应指出具体产物路径',
  );
});

test('D2 sha256 为空白串 / 非字符串 → E_BINDING_UNVERIFIABLE', () => {
  for (const sha256 of ['', '   ', null, undefined, 42, {}, []]) {
    const result = canDeliver(
      baseInput({
        tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: true, sha256 }] } })],
      }),
    );
    assertBlocked(result, 'E_BINDING_UNVERIFIABLE', `sha256=${JSON.stringify(sha256)}`);
  }
});

test('D2 有指纹且一致时不报任何绑定问题', () => {
  const result = canDeliver(baseInput());
  assert.deepEqual(codes(result), []);
});

/* ------------------------------------------------------------------------- */
/* D3 绑定按归属，不用全局路径集合                                            */
/* ------------------------------------------------------------------------- */

test('D3 impl-2 借 impl-1 的评审 → E_UNBOUND_ARTIFACT', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask({ id: 'impl-1' }), implTask({ id: 'impl-2' }), reviewTask({ sourceTaskId: 'impl-1' })],
    }),
  );
  assertBlocked(result, 'E_UNBOUND_ARTIFACT', 'impl-2 借评审');
  const message = result.blockers.find((b) => b.code === 'E_UNBOUND_ARTIFACT').message;
  assert.ok(message.includes('impl-2'), 'message 应指出未被评审的归属任务');
  assert.ok(message.includes('归属不符'), 'message 应说明别的任务的评审不能背书');
  assert.ok(!message.includes('impl-1 申报'), 'impl-1 自己的绑定成立，不应被牵连');
});

test('D3 归属正确（contract.reviewedTaskId）→ 通过', () => {
  // 夹具修订（D7）：contract 现在必须自带 acceptance/verify，否则会命中 E_CONTRACT_INCOMPLETE。
  // 断言本身不变：归属正确就放行。
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1' }),
        reviewTask({
          id: 'review-1',
          sourceTaskId: undefined,
          contract: { reviewedTaskId: 'impl-1', acceptance: ['评审通过'], verify: ['node --test'] },
        }),
      ],
    }),
  );
  assert.deepEqual(codes(result), []);
});

test('D3 兼容老写法：只有 sourceTaskId 时按 sourceTaskId 归属', () => {
  // 夹具修订（D7）：同上，契约里补上 acceptance/verify；归属仍只靠 sourceTaskId。
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1' }),
        reviewTask({
          id: 'review-1',
          contract: { inScope: [], outOfScope: [], acceptance: ['评审通过'], verify: ['node --test'] },
        }),
      ],
    }),
  );
  assert.deepEqual(codes(result), []);
});

test('D3 评审没有归属声明时不能给任何任务背书', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1' }),
        reviewTask({
          id: 'review-1',
          sourceTaskId: undefined,
          contract: { inScope: [], outOfScope: [], acceptance: ['评审通过'], verify: ['node --test'] },
          reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: true, sha256: SHA }] },
        }),
      ],
    }),
  );
  assertBlocked(result, 'E_UNBOUND_ARTIFACT', '无归属评审');
});

/* ------------------------------------------------------------------------- */
/* D4 attempt 对齐（E_STALE_ATTEMPT）                                         */
/* ------------------------------------------------------------------------- */

test('D4 reviewed.attempt 与被审任务当前 attempt 不一致 → E_STALE_ATTEMPT', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1', attempt: 2 }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: 1, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assertBlocked(result, 'E_STALE_ATTEMPT', 'attempt 不一致');
  assert.ok(result.blockers.some((b) => b.code === 'E_STALE_ATTEMPT' && b.message.includes('review-1')));
});

test('D4 attempt 一致（对象形态 {n} 与数字混用）→ 不报 E_STALE_ATTEMPT', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1', attempt: { n: 3, id: 'impl-1#3' } }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: 3, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assertShape(result);
  assert.deepEqual(codes(result), []);
});

test('D4 评审没记 attempt 但任务已经在第 5 轮 → E_STALE_ATTEMPT（缺省即第 1 轮）', () => {
  // D9 修订：原用例断言"评审没记 attempt 时不拒绝"，理由是"不能凭空拒绝"。
  // 现在不行：未标注 = 第 1 轮，任务在第 5 轮时它就是上一轮的评审 —— 这正是 L-11 的攻击链
  // （第二轮不跑任何东西，只把第一轮的回执原样带上）。
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1', attempt: 5 }),
        reviewTask({ reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assertBlocked(result, 'E_STALE_ATTEMPT', '未标注按第 1 轮处理');
  const message = result.blockers.find((b) => b.code === 'E_STALE_ATTEMPT').message;
  assert.match(message, /未标注/);
  assert.match(message, /第 1 轮/);
});

test('D4 引导轮：任务在第 1 轮 + 评审未标注 attempt → 放行', () => {
  // 缺省即第 1 轮的另一半：只有第 1 轮才允许"没标注"。
  const result = canDeliver(baseInput());
  assert.deepEqual(codes(result), []);

  const explicit = canDeliver(baseInput({ tasks: [implTask({ id: 'impl-1', attempt: 1 }), reviewTask()] }));
  assert.deepEqual(codes(explicit), [], '显式写 attempt=1 与缺省必须同义');
});

test('D4 任务在第 1 轮 + 评审声称第 7 轮 → E_STALE_ATTEMPT', () => {
  // D9 修订：原用例断言"任务侧没有 attempt 时无从比较，只允许放行"。
  // 现在：任务缺 attempt = 第 1 轮；评审记 7 → 声称来自第 7 轮，而任务在第 1 轮 → 陈旧。
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1' }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: 7, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assertBlocked(result, 'E_STALE_ATTEMPT', '任务缺失视为第 1 轮');
  const message = result.blockers.find((b) => b.code === 'E_STALE_ATTEMPT').message;
  assert.match(message, /未提供，按第 1 轮处理/);
});

test('D4 attempt 从 contract.attempt 读也算数（与顶层写法等价）', () => {
  const viaContract = canDeliver(
    baseInput({
      tasks: [
        implTask({
          id: 'impl-1',
          contract: {
            inScope: ['plugin/src/'],
            outOfScope: ['plugin/secrets/'],
            acceptance: ['A'],
            verify: ['node --test'],
            attempt: 2,
          },
        }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: 1, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assertBlocked(viaContract, 'E_STALE_ATTEMPT', 'contract.attempt 不一致');
});

/* ------------------------------------------------------------------------- */
/* D5 contractOf 接入：顶层写法与 contract 写法等价                            */
/* ------------------------------------------------------------------------- */

test('D5 等价性：顶层 inScope 与 contract.inScope 对范围内路径判定一致', () => {
  const topLevel = {
    ...implTask(),
    contract: undefined,
    inScope: ['plugin/src/'],
    outOfScope: ['plugin/secrets/'],
    acceptance: ['canDeliver 返回 ok/blockers'],
    verify: ['node --test'],
  };
  const nested = implTask();

  const a = canDeliver(baseInput({ tasks: [topLevel, reviewTask()] }));
  const b = canDeliver(baseInput({ tasks: [nested, reviewTask()] }));
  assert.deepEqual(codes(a), codes(b));
  assert.deepEqual(codes(a), []);
});

test('D5 等价性：顶层 outOfScope 与 contract.outOfScope 对越界路径判定一致', () => {
  const outPath = 'plugin/secrets/key.pem';
  const digests = { [FILE]: SHA, [outPath]: 'sha-secret' };
  const artifacts = [
    { path: FILE, present: true, sha256: SHA },
    { path: outPath, present: true, sha256: 'sha-secret' },
  ];

  // 夹具修订（D7）：旧写法任务也要自带 acceptance/verify，否则命中的是"缺声明"而不是"越界"。
  const topLevel = {
    ...implTask(),
    contract: undefined,
    changedPaths: [FILE, outPath],
    inScope: ['plugin/src/'],
    outOfScope: ['plugin/secrets/'],
    acceptance: ['canDeliver 返回 ok/blockers'],
    verify: ['node --test'],
  };
  const nested = implTask({ changedPaths: [FILE, outPath] });

  const a = canDeliver(
    baseInput({ tasks: [topLevel, reviewTask({ reviewed: { verdict: 'pass', artifacts } })], currentDigests: digests, diffPaths: [FILE, outPath] }),
  );
  const b = canDeliver(
    baseInput({ tasks: [nested, reviewTask({ reviewed: { verdict: 'pass', artifacts } })], currentDigests: digests, diffPaths: [FILE, outPath] }),
  );

  assert.deepEqual(codes(a), codes(b));
  assert.ok(codes(a).includes('E_OUT_OF_SCOPE'), '两种写法都必须拦下 outOfScope 命中');
});

test('D5 契约对象存在时不与顶层合并：只读 contract（顶层声明漂移不影响判定）', () => {
  // contract.inScope 只覆盖 plugin/docs/，顶层却写 plugin/src/ —— 契约优先，FILE 必须越界。
  const result = canDeliver(
    baseInput({
      tasks: [implTask({ inScope: ['plugin/src/'], contract: { inScope: ['plugin/docs/'], outOfScope: [] } }), reviewTask()],
    }),
  );
  assertBlocked(result, 'E_OUT_OF_SCOPE', '契约优先、不合并顶层');
  // 而且这种"两处都写、值还不同"的输入还要被 E_CONTRACT_AMBIGUOUS 单独点名（见 D7 用例）
  assertBlocked(result, 'E_CONTRACT_AMBIGUOUS', '同字段两处不同值');
});

/* ------------------------------------------------------------------------- */
/* D6 缺口记账（第 6 轮：E_SELF_REVIEW 收归 enforced；第 12 轮 C-2：           */
/* E_NO_ARTIFACT_BINDING 从"缺口"改为"由 E_UNBOUND_ARTIFACT 覆盖"）            */
/* ------------------------------------------------------------------------- */

test('D6 describeDeliveryContract：E_NO_ARTIFACT_BINDING 已移出 pluginLayer，改记 coveredElsewhere', () => {
  // 第 6 轮（D-13）：原断言是「E_SELF_REVIEW 出现在 pluginLayer、且不在 enforced」→ 已翻面，
  // 判独立性只需要归属关系（assignee ← 宿主 ownerName），不需要 session 身份。
  //
  // 第 12 轮（C-2）翻面：原断言 `pluginCodes.includes('E_NO_ARTIFACT_BINDING')`。
  // 为什么翻：它在缺口表里躺着的那些轮次，全仓**没有任何 add() 调用**产生过这个码 ——
  // 缺口表于是成了"我们知道自己缺这个"的一句自述，而真正该看的是"谁在替它把关"。
  // 判据本身（申报了改动、却没有任何评审绑定这些文件）已经由 E_UNBOUND_ARTIFACT 以 blocker 级
  // 强制；再补一个 warning 级同义码就是同一缺陷两个码。所以它现在属于 coveredElsewhere。
  const description = describeDeliveryContract();
  const pluginCodes = description.pluginLayer.map((entry) => entry.code);
  const coveredCodes = description.coveredElsewhere.map((entry) => entry.code);

  assert.ok(!pluginCodes.includes('E_NO_ARTIFACT_BINDING'), '它已经不是缺口，别再记在 pluginLayer');
  assert.ok(pluginCodes.includes('E_ASSIGNEE_PROJECTION'), '要记账"assignee 由插件层灌入"这条前提');
  assert.ok(!pluginCodes.includes('E_SELF_REVIEW'), 'E_SELF_REVIEW 不再是插件层缺口');

  const covered = description.coveredElsewhere.find((entry) => entry.code === 'E_NO_ARTIFACT_BINDING');
  assert.ok(covered, '账不能一删了事：必须落在 coveredElsewhere，否则半年后又有人来"实现"一遍');
  assert.equal(covered.coveredBy, 'E_UNBOUND_ARTIFACT', '替它把关的是谁，必须点名');
  assert.ok(covered.reason.length > 0);

  for (const entry of description.pluginLayer) {
    assert.equal(typeof entry.owner, 'string');
    assert.ok(entry.owner.length > 0, `${entry.code} 的 owner 不能是空串：缺口必须有负责人`);
    assert.ok(entry.reason.length > 0);
  }

  assert.ok(description.enforced.includes('E_SELF_REVIEW'), 'E_SELF_REVIEW 必须出现在 enforced 里');
  assert.ok(description.enforced.includes('E_NO_ASSIGNEE'));
  assert.ok(!description.enforced.includes('E_NO_ARTIFACT_BINDING'), '它没有被实现，就不许出现在 enforced');
  assert.ok(!description.warnings.includes('E_NO_ARTIFACT_BINDING'), '也没有被实现成 warning');
  assert.deepEqual(description.enforced, [...DELIVERY_BLOCKER_CODES]);
  assert.deepEqual(description.pluginLayer.map((e) => e.code), DELIVERY_PLUGIN_LAYER_CODES.map((e) => e.code));
  // warning 码单独一张表：调用方按 severity 分流，不从码名猜
  assert.deepEqual(description.warnings, [...DELIVERY_WARNING_CODES]);
  // task-22 起是三条：E_MEETING_SKIPPED 也是"不阻断但必须留痕"的同类。
  // 它进的是 warnings 表而不是 blockers 表 —— 例外通道允许存在，只是不能隐形。
  assert.deepEqual(description.warnings, [
    'E_REVIEW_STAGNATION',
    'E_INDEPENDENCE_UNENFORCED',
    'E_MEETING_SKIPPED',
  ]);
  assert.ok(!DELIVERY_BLOCKER_CODES.includes('E_REVIEW_STAGNATION'), 'warning 不算 blocker');
  assert.ok(!DELIVERY_BLOCKER_CODES.includes('E_INDEPENDENCE_UNENFORCED'), 'legacy 警告也不算 blocker');
  assert.ok(!DELIVERY_BLOCKER_CODES.includes('E_MEETING_SKIPPED'), '跳过开会留痕是 warning，不是 blocker');
});

test('C-2 行为侧：E_NO_ARTIFACT_BINDING 描述的条件确实被 blocker 级 E_UNBOUND_ARTIFACT 拦住，且没有幽灵 warning', () => {
  // 这是 (b) 裁决的**行为**依据，而不是只改账本：同一输入下
  //   1) 交付被拒（ok:false），且 blockers 里有 E_UNBOUND_ARTIFACT；
  //   2) blockers 与 warnings 里都**没有** E_NO_ARTIFACT_BINDING —— 删掉的是"记了但没实现"的码，
  //      不是把它换成第二个名字继续报同一件事。
  // 输入：实现任务申报了 FILE，评审给出了 pass，但 reviewed.artifacts 为空（"看完没绑字节"）。
  const result = canDeliver(
    baseInput({
      tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [] } })],
    }),
  );
  assertShape(result);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('E_UNBOUND_ARTIFACT'), `实际 blockers: ${JSON.stringify(codes(result))}`);
  assert.ok(
    !codes(result).includes('E_NO_ARTIFACT_BINDING'),
    'E_NO_ARTIFACT_BINDING 不许以任何形式出现在输出里（它没有 add() 落点）',
  );
  assert.deepEqual(
    (result.warnings ?? []).map((w) => w.code).filter((code) => code === 'E_NO_ARTIFACT_BINDING'),
    [],
    '也不许退化成一条同义 warning：同一缺陷两个码',
  );

  // 空 artifacts 之外的那半截（"该审几个产物"的下界）本模块判不了，是因为它只看得到传进来的东西：
  // 一个根本没申报 changedPaths 的实现任务不会触发任何绑定类 blocker。
  // 把它固定成断言，避免以后有人以为"模块层其实查得到"。
  const empty = canDeliver(baseInput({ tasks: [implTask({ changedPaths: [] }), workTask()] }));
  assertShape(empty);
  assert.ok(
    !codes(empty).includes('E_UNBOUND_ARTIFACT'),
    '没有任何申报路径时模块层无从"下界校验"——这正是格子留在插件层的原因',
  );
  assert.ok(!codes(empty).includes('E_NO_ARTIFACT_BINDING'));
});

test('C-2 账本有牙：enforced / warnings 里的每个码都必须在判定代码里真的被发出', () => {
  // 结构断言，不是行为断言的替代（行为侧见上一条）：它守的是**账本不许说谎**。
  // 旧 bug 的形状是"码名在表里、实现没有"；这条用例把这种形状变成红的。
  //
  // 做法：读真实的 delivery.mjs，切掉两段**非判定代码**后得到 body：
  //   1) 文件头注释（里面会提到码名，解释性文字不算发出）；
  //   2) `自描述：错误码归属` 之后整段（三张码表 + describeDeliveryContract —— 码名出现在
  //      表里恰恰是我们要排除的那种"只记账不实现"）。
  // 剩下的 body 就是所有 add()/warnings.push() 都在的地方。
  const source = readFileSync(new URL('../src/delivery.mjs', import.meta.url), 'utf8');
  const withoutHeader = source.replace(/^\/\*\*[\s\S]*?\*\/\n/, '');
  assert.notEqual(withoutHeader, source, '文件头注释没被切掉：这条用例会误报');
  const selfDescriptionAt = withoutHeader.indexOf('/* 自描述：错误码归属');
  assert.notEqual(selfDescriptionAt, -1, '找不到"自描述：错误码归属"分节：切分会静默失效，断言随之失去意义');
  const body = withoutHeader.slice(0, selfDescriptionAt);

  for (const code of [...DELIVERY_BLOCKER_CODES, ...DELIVERY_WARNING_CODES]) {
    assert.ok(
      body.includes(`'${code}'`),
      `${code} 只出现在码表里、没有任何一处报出它 —— 这正是 E_NO_ARTIFACT_BINDING 当初的毛病。`
        + '要么给它一个 add()/warnings.push()，要么把它从表里拿掉并去 coveredElsewhere 记账。',
    );
  }

  // 反向：缺口表里的码**不得**被本模块报出（否则"缺口"是假的）。
  for (const entry of DELIVERY_PLUGIN_LAYER_CODES) {
    assert.ok(!body.includes(`'${entry.code}'`), `${entry.code} 记为缺口，却真的被报出了：账本自相矛盾`);
  }
  for (const entry of describeDeliveryContract().coveredElsewhere) {
    // coveredBy 不以 E_ 开头的，指的是**另一个模块**的同码（如 E_CONTRACT_INCOMPLETE → "gates 同名码"）：
    // 那种情况下本模块确实还会自己报这个码，不能说它"被覆盖掉了"。
    if (!entry.coveredBy.startsWith('E_')) continue;
    assert.ok(!body.includes(`'${entry.code}'`), `${entry.code} 已由别的码覆盖，不该再被本模块报出`);
  }
});

test('C-1 质量 kind 只有一份口径：canDeliver 的"质量 kind 必须声明 acceptance/verify"与 contract.mjs 完全一致', () => {
  // 第 12 轮（C-1）：delivery.mjs 原有一份 `QUALITY_KINDS = new Set(['implementation','review'])` 副本。
  // 危险不是"现在不一致"，而是**以后加第三个 kind 时漏改一处不会报错，只会静默少判**：
  // 少判的那一侧会放行一个没写验收条件的任务。这条用例把"两个模块对同一份清单的判定"钉在一起：
  // 期望值来自 contract.mjs 的 QUALITY_KINDS（唯一真相源），不看 delivery 自己怎么想。
  // 若有人把字面量副本塞回来，加第三个 kind 后这里就会红。
  for (const kind of KINDS) {
    const result = canDeliver(
      baseInput({
        tasks: [{ id: `t-${kind}`, kind, status: 'completed', changedPaths: [], contract: {} }],
        currentDigests: {},
        diffPaths: [],
      }),
    );
    assertShape(result);
    const hits = codes(result).filter((code) => code === 'E_CONTRACT_INCOMPLETE').length;
    const expected = QUALITY_KINDS.includes(kind) ? 1 : 0;
    assert.equal(
      hits,
      expected,
      `kind=${kind}：E_CONTRACT_INCOMPLETE 命中 ${hits} 次，期望 ${expected} 次。`
        + `QUALITY_KINDS=${JSON.stringify(QUALITY_KINDS)}；`
        + '不一致说明 delivery.mjs 没有从 contract.mjs 读同一份清单（又出现了字面量副本）。',
    );
  }
});

test('D6 自审场景：模块层现在自己拦（原断言已翻面，见注释）', () => {
  // 第 6 轮修订（D-13）：原断言是「result.ok === true，模块层无 actor 概念，自审只能由插件层拦」。
  // 为什么翻面：`assignee` 是宿主权威的归属字段（ownerName，claim 由宿主 CAS 写入），
  // 判"同一个人既实现又评审"只需要这个字段，不需要 session。
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1', assignee: 'impl-a' }),
        reviewTask({
          assignee: 'impl-a',
          reviewed: { by: 'impl-a', verdict: 'pass', artifacts: [{ path: FILE, present: true, sha256: SHA }] },
        }),
      ],
    }),
  );
  assertBlocked(result, 'E_SELF_REVIEW', '同 assignee 的自审');
  assert.match(
    result.blockers.find((b) => b.code === 'E_SELF_REVIEW').message,
    /impl-1/,
    'message 要点名被审任务',
  );
});

test('D6 自描述：被别处覆盖的码登记了覆盖关系（E_BINDING_OWNER_MISMATCH / E_SCOPE_UNDECLARED）', () => {
  const description = describeDeliveryContract();
  const covered = new Map(description.coveredElsewhere.map((entry) => [entry.code, entry.coveredBy]));
  assert.equal(covered.get('E_BINDING_OWNER_MISMATCH'), 'E_UNBOUND_ARTIFACT');
  assert.equal(covered.get('E_SCOPE_UNDECLARED'), 'E_OUT_OF_SCOPE');
});

test('原有 9 个 blocker 码全部仍在码表里（语义不回归的机械保险）', () => {
  const required = [
    'E_NOT_RUNNING',
    'E_TASK_INCOMPLETE',
    'E_FAILED_NO_FOLLOWUP',
    'E_VERDICT_REQUIRED',
    'E_NO_PASSING_REVIEW',
    'E_OUT_OF_SCOPE',
    'E_BINDING_STALE',
    'E_NEEDS_HUMAN_DELIVERY',
    'E_CANCELLED_NO_REASON',
  ];
  for (const code of required) {
    assert.ok(DELIVERY_BLOCKER_CODES.includes(code), `${code} 必须仍在码表里`);
  }
  assert.ok(DELIVERY_BLOCKER_CODES.includes('E_UNREPORTED_CHANGES'));
  assert.ok(DELIVERY_BLOCKER_CODES.includes('E_UNBOUND_ARTIFACT'));
});

/* ------------------------------------------------------------------------- */
/* M1 repair 移出代码变更集合                                                  */
/* ------------------------------------------------------------------------- */

test('M1 repair 不再算代码变更任务：申报路径改由 E_UNREPORTED_CHANGES 拦截', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask(),
        reviewTask(),
        {
          id: 'repair-1',
          kind: 'repair',
          status: 'completed',
          changedPaths: [FILE2],
          sourceTaskId: 'impl-1',
          contract: { inScope: ['plugin/src/'], outOfScope: [] },
        },
      ],
      currentDigests: { [FILE]: SHA, [FILE2]: SHA2 },
      diffPaths: [FILE, FILE2],
    }),
  );
  assertBlocked(result, 'E_UNREPORTED_CHANGES', 'repair 申报的路径不算认领');
  assert.ok(!codes(result).includes('E_UNBOUND_ARTIFACT'), 'repair 已不是代码变更任务，不参与绑定检查');
  // L-7：repair 不在 kind 白名单里，同时要被 E_INPUT_INVALID 点名（不再"凭空消失"）
  assertBlocked(result, 'E_INPUT_INVALID', 'kind=repair 是白名单外取值');
});

/* ------------------------------------------------------------------------- */
/* M3 inScope 字符串形态                                                       */
/* ------------------------------------------------------------------------- */

test('M3 inScope 写字符串 "plugin/src/" 被接受（与 contract.toEntryList 口径一致）', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask({ contract: { inScope: 'plugin/src/', outOfScope: [], acceptance: ['A'], verify: ['node --test'] } }), reviewTask()],
    }),
  );
  assertShape(result);
  assert.deepEqual(codes(result), [], '字符串形态的 inScope 不得被当成空数组');
});

test('M3 字符串目录模式保留 / 边界语义（plugin/src/ 命中子目录，不命中 plugin/srcx/）', () => {
  const nested = 'plugin/src/nested/deep.mjs';
  const neighbor = 'plugin/srcx/deep.mjs';
  const digests = { [nested]: SHA, [neighbor]: SHA2 };
  const artifacts = [
    { path: nested, present: true, sha256: SHA },
    { path: neighbor, present: true, sha256: SHA2 },
  ];
  // 夹具修订（D7）：contract 里补 acceptance/verify（缺了会先命中 E_CONTRACT_INCOMPLETE）。
  const contract = { inScope: 'plugin/src/', outOfScope: '', acceptance: ['A'], verify: ['node --test'] };

  const insideOk = canDeliver(
    baseInput({
      tasks: [implTask({ changedPaths: [nested], contract }), reviewTask({ reviewed: { verdict: 'pass', artifacts } })],
      currentDigests: digests,
      diffPaths: [nested],
    }),
  );
  assert.deepEqual(codes(insideOk), [], '子目录文件必须落在 plugin/src/ 内');

  const outside = canDeliver(
    baseInput({
      tasks: [implTask({ changedPaths: [neighbor], contract }), reviewTask({ reviewed: { verdict: 'pass', artifacts } })],
      currentDigests: digests,
      diffPaths: [neighbor],
    }),
  );
  assertBlocked(outside, 'E_OUT_OF_SCOPE', 'plugin/srcx/ 不得被 plugin/src/ 命中');
});

/* ------------------------------------------------------------------------- */
/* M5 delivered 记录必须像宿主签发                                             */
/* ------------------------------------------------------------------------- */

test('M5 by 不是 host: 前缀 → E_NEEDS_HUMAN_DELIVERY', () => {
  for (const delivered of [
    { by: 'leader' },
    { by: 'leader', call_id: 'c-1', evidence_digest: 'sha-e' },
    { by: 'host' },
    { call_id: 'x' },
    { by: 'host:actionCard' },
    {},
  ]) {
    const result = canDeliver(baseInput({ team: { phase: 'running', leaderMode: 'spawned', delivered } }));
    assertBlocked(result, 'E_NEEDS_HUMAN_DELIVERY', `delivered=${JSON.stringify(delivered)}`);
  }
});

test('M5 缺 call_id 或 evidence_digest → E_NEEDS_HUMAN_DELIVERY', () => {
  const missingCallId = { by: 'host:actionCard', at: 1, evidence_digest: 'sha-e' };
  assertBlocked(
    canDeliver(baseInput({ team: { phase: 'running', delivered: missingCallId } })),
    'E_NEEDS_HUMAN_DELIVERY',
    '缺 call_id',
  );

  const missingDigest = { by: 'host:actionCard', call_id: 'c-1', at: 1 };
  assertBlocked(
    canDeliver(baseInput({ team: { phase: 'running', delivered: missingDigest } })),
    'E_NEEDS_HUMAN_DELIVERY',
    '缺 evidence_digest',
  );

  const emptyDigest = { by: 'host:actionCard', call_id: 'c-1', evidence_digest: '   ' };
  assertBlocked(
    canDeliver(baseInput({ team: { phase: 'running', delivered: emptyDigest } })),
    'E_NEEDS_HUMAN_DELIVERY',
    '空白 evidence_digest',
  );
});

test('L-3：合法宿主签发（蛇形 call_id）通过；驼峰 callId 不再被接受', () => {
  // L-3 修订：原用例断言"过渡期兼容驼峰 callId"。
  // 现在删掉该别名：规格 §7 是蛇形 call_id，给过一轮过渡期就够；
  // 继续兼容等于让调用方可以凭一个规格里不存在的字段造出"宿主已交付"。
  const snake = canDeliver(baseInput());
  assert.deepEqual(codes(snake), []);

  const camel = canDeliver(
    baseInput({
      team: {
        phase: 'running',
        delivered: { by: 'host:actionCard', callId: 'c-2', at: 1, evidence_digest: 'sha-e' },
      },
    }),
  );
  assertBlocked(camel, 'E_NEEDS_HUMAN_DELIVERY', '驼峰 callId 不构成交付记录');
  assert.match(
    camel.blockers.find((b) => b.code === 'E_NEEDS_HUMAN_DELIVERY').message,
    /call_id/,
    'message 必须指出缺的是蛇形 call_id',
  );
});

/* ------------------------------------------------------------------------- */
/* 路径驱动 / 绑定：原有防线                                                  */
/* ------------------------------------------------------------------------- */

test('E_UNREPORTED_CHANGES：diffPaths 中有未被任何已完成任务申报的路径', () => {
  const ghost = 'plugin/src/ghost.mjs';
  const result = canDeliver(
    baseInput({ currentDigests: { [FILE]: SHA, [ghost]: 'sha-ghost' }, diffPaths: [FILE, ghost] }),
  );
  assertShape(result);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_UNREPORTED_CHANGES']);
  assert.ok(result.blockers[0].message.includes(ghost));
});

/* ── v1.1：E_REPORTED_UNCHANGED（报了没改）────────────────────────────────
 *
 * 这三条钉的是同一个洞：上面二十多条门禁全在判**卡的形状**，
 * 没有一条判**卡上说的那件事在磁盘上发生了没有**。
 * 自举跑 standard@1 时真实撞上过：build / verify / signoff 三份报告
 * 互相印证一份从没发生过的交付，形状门禁全绿，工作区一个字节没动。
 *
 * 而这三条里最容易被写错的是第 2 条 ——「没提供审计输入」与
 * 「提供了空的审计输入」必须分开：前者是"没查"，后者是"查了，确实没改动"。
 * 把它们合并成一个分支，就等于拿沉默冒充结论（本项目那条老红线）。
 */
test('v1.1 E_REPORTED_UNCHANGED：申报改了文件、diffPaths 里却没有它 → 阻断', () => {
  /* impl-1 申报改了 FILE，而工作区实际动的是 FILE2。
   * 这不是"改了没报"（那是 FILE2 的账，E_UNREPORTED_CHANGES），
   * 而是"报了没改"—— 两条方向相反，各自成码，不互相抵扣。 */
  const result = canDeliver(
    baseInput({ currentDigests: { [FILE2]: SHA2 }, diffPaths: [FILE2] }),
  );
  assertShape(result);
  assertBlocked(result, 'E_REPORTED_UNCHANGED', '报了没改必须阻断');
  assert.ok(
    codes(result).includes('E_UNREPORTED_CHANGES'),
    'FILE2 无人申报 → 同时必须报"改了没报"；两条是两份账，都要出现',
  );
});

test('v1.1 空 ≠ 不可用：diffPaths 没提供 → 本码沉默；提供了空数组 → 全报', () => {
  /* 左边：调用方压根没接线。此刻"申报的路径没在 diff 里"这件事**无从判断**，
   * 报出来就是假精确；该出声的是 E_AUDIT_UNWIRED，不是本码。 */
  const notWired = canDeliver(baseInput({ diffPaths: undefined }));
  assert.ok(
    !codes(notWired).includes('E_REPORTED_UNCHANGED'),
    '没提供审计输入时不许报——这一条判不了，不能拿沉默冒充结论',
  );

  /* 右边：接上线了，工作区确实没有任何改动，而 impl-1 说它改了 FILE。
   * 这就是那份"从没发生过的交付"的形状，必须报。 */
  const wiredButEmpty = canDeliver(baseInput({ diffPaths: [] }));
  assertBlocked(wiredButEmpty, 'E_REPORTED_UNCHANGED', '接了线且工作区没改动，申报即假');
});

test('v1.1 不误报：申报了、diffPaths 里也确实有 → 本码不出现', () => {
  /* 默认夹具：impl-1 申报 FILE，diffPaths 就是 [FILE]。正常情况必须干净。 */
  const result = canDeliver(baseInput());
  assert.ok(
    !codes(result).includes('E_REPORTED_UNCHANGED'),
    '正常申报不许被这条码误伤——误报一次，之后所有人都会去关掉它',
  );
});

test('E_UNREPORTED_CHANGES：非 completed 状态申报不算数（只有 completed 才认领）', () => {
  const ghost = 'plugin/src/ghost.mjs';
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask(),
        reviewTask(),
        implTask({ id: 'impl-2', status: 'in_progress', changedPaths: [ghost], contract: { inScope: ['plugin/src/'] } }),
      ],
      currentDigests: { [FILE]: SHA, [ghost]: 'sha-ghost' },
      diffPaths: [FILE, ghost],
    }),
  );
  assertBlocked(result, 'E_UNREPORTED_CHANGES', 'in_progress 申报不认领');
});

test('E_UNBOUND_ARTIFACT：implementation 申报的路径未被 pass 评审绑定', () => {
  const result = canDeliver(
    baseInput({ tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [] } })] }),
  );
  assertShape(result);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_UNBOUND_ARTIFACT']);
  assert.ok(result.blockers[0].message.includes(FILE));
});

test('E_UNREPORTED_CHANGES：diffPaths 为空且无人申报路径时两条路径驱动码都不命中', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask({ status: 'pending', changedPaths: [] }), reviewTask({ status: 'pending', reviewed: undefined })],
      diffPaths: [],
      currentDigests: {},
    }),
  );
  assertShape(result);
  assert.ok(!codes(result).includes('E_UNREPORTED_CHANGES'), 'diffPaths 为空不应报未申报变更');
  assert.ok(!codes(result).includes('E_UNBOUND_ARTIFACT'), '没有申报路径就不该报未绑定产物');
});

test('关键用例：把所有任务标成 work 且 diffPaths 非空，必须 ok=false', () => {
  const input = baseInput({
    tasks: [implTask({ status: 'work' }), reviewTask({ status: 'work', reviewed: undefined })],
  });

  const result = canDeliver(input);
  assertShape(result);
  assert.equal(result.ok, false, '全 work 化 + diffPaths 非空必须失败');
  const found = codes(result);
  assert.ok(found.includes('E_UNREPORTED_CHANGES'), `应命中 E_UNREPORTED_CHANGES，实际：${found.join(',')}`);
  assert.ok(found.includes('E_UNBOUND_ARTIFACT'), `应命中 E_UNBOUND_ARTIFACT，实际：${found.join(',')}`);
});

/* ------------------------------------------------------------------------- */
/* D7 单一契约入口：三个模块对同一份输入必须同向                               */
/* ------------------------------------------------------------------------- */

/** 三模块一致性只看"契约类"结论：gates 还要判回执/运行结果，那不是交付期能知道的事实。 */
const CONTRACT_CLASS_CODES = new Set([
  'E_CONTRACT_AMBIGUOUS',
  'E_CONTRACT_INCOMPLETE',
  'E_INPUT_INVALID',
  'E_PATH_UNSAFE',
  'E_OUT_OF_SCOPE',
  'E_SCOPE_UNDECLARED',
  'E_SCOPE_VERIFY_REQUIRED',
  'E_ACCEPTANCE_REQUIRED',
  'E_OBJECTIVE_REQUIRED',
  'E_ACCEPTANCE_UNVERIFIABLE',
  'E_SCOPE_CONFLICT',
]);

function contractClassOnly(result) {
  const list = result.errors ?? result.blockers ?? [];
  return list.filter((e) => CONTRACT_CLASS_CODES.has(e.code)).map((e) => e.code);
}

/**
 * 给 gates 造一份最小输入（只关心契约类结论）。
 * `meta` 可覆盖：默认 `{ attempt: 1 }`；需要探"meta 缺省时退回任务记录"的用例传 `{ meta: {} }`。
 */
function gateFor(task, over = {}) {
  const changedPaths = over.changedPaths ?? (Array.isArray(task.changedPaths) ? task.changedPaths : []);
  return evaluateCompletion({
    task,
    meta: over.meta ?? { attempt: 1 },
    payload: { changedPaths, acceptanceResults: over.acceptanceResults ?? [] },
    receipts: over.receipts ?? [],
    diffPaths: over.diffPaths ?? changedPaths,
  });
}

/** D7 主用例：acceptance/verify/objective 在顶层、inScope 在 contract —— 混合写法。 */
function mixedTaskTopDeclarations() {
  return {
    id: 'impl-1',
    kind: 'implementation',
    status: 'completed',
    changedPaths: [FILE],
    // 旧写法残留：这三项在顶层
    objective: '把交付器改成单一契约入口',
    acceptance: ['canDeliver 返回 ok/blockers'],
    verify: ['node --test plugin/test/delivery.test.mjs'],
    // 新写法：范围在契约里
    contract: { inScope: ['plugin/src/'], outOfScope: [] },
  };
}

test('D7 混合写法（声明在顶层、inScope 在 contract）→ canDeliver 不再 ok:true', () => {
  // 修前：field('inScope') 逐字段回退顶层/合同两侧，信息最全 → ok:true（三个模块里最松的一道门）。
  // 修后：只读 contractOf(task) → acceptance/verify 在契约视图里缺失 → E_CONTRACT_INCOMPLETE。
  const mixed = mixedTaskTopDeclarations();
  const result = canDeliver(baseInput({ tasks: [mixed, reviewTask()] }));

  assert.equal(result.ok, false, `混合写法不得放行，实际 ${JSON.stringify(result.blockers)}`);
  assert.ok(
    codes(result).includes('E_CONTRACT_INCOMPLETE'),
    `应报"读不到 acceptance/verify"，实际 ${JSON.stringify(codes(result))}`,
  );
  const message = result.blockers.find((b) => b.code === 'E_CONTRACT_INCOMPLETE').message;
  assert.match(message, /acceptance/);
  assert.match(message, /verify/);
  assert.match(message, /contract/, 'message 要说明契约字段只从 contract 读');
});

test('D7 混合写法（inScope 在顶层、契约里只有 acceptance/verify）→ 范围读不到 → 拒绝', () => {
  // 这条对应评审的 L-4 复现：校验器说"缺范围"、门禁说"没声明范围"、交付器却说可以交付。
  const mixed = {
    id: 'impl-1',
    kind: 'implementation',
    status: 'completed',
    changedPaths: [FILE],
    inScope: ['plugin/src/'],
    contract: { acceptance: ['canDeliver 返回 ok/blockers'], verify: ['node --test'] },
  };
  const result = canDeliver(baseInput({ tasks: [mixed, reviewTask()] }));
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('E_OUT_OF_SCOPE'), `缺范围声明必须判越界：${JSON.stringify(codes(result))}`);
});

/* ---- A-1 / A-2 专用夹具：只在这个矩阵里用，不动全局 implTask/reviewTask ---- */

/**
 * 合法实现契约（D-5 之后的最小合法形态）：
 * `'node --test 全绿'` 逐字包含 `'node --test'`，且 verify 项含空白 → 过 D-5；
 * 带 `objective` → 过 V3。
 */
const legalImplContract = () => ({
  objective: '实现的交付够不够',
  acceptance: ['node --test 全绿'],
  verify: ['node --test'],
  inScope: ['plugin/src/'],
  outOfScope: [],
});

/** 合法评审契约（review 也必须说清"用什么验证了这次评审"，D-8）。 */
const legalReviewContract = () => ({
  objective: '评审这次的实现',
  acceptance: ['node --test 全绿'],
  verify: ['node --test'],
  reviewedTaskId: 'impl-1',
  inScope: [],
  outOfScope: [],
});

const legalImpl = (over = {}) => ({
  id: 'impl-1',
  kind: 'implementation',
  status: 'completed',
  changedPaths: [FILE],
  contract: legalImplContract(),
  ...over,
});

const legalReview = (over = {}) => ({
  id: 'review-1',
  kind: 'review',
  status: 'completed',
  changedPaths: [],
  sourceTaskId: 'impl-1',
  contract: legalReviewContract(),
  reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: true, sha256: SHA }] },
  ...over,
});

/** 对照组自己的 gate 输入：不传空数组，否则 gates 会因自己的理由拒（对组就不是"三边全过"）。 */
const CONTROL_GATE_INPUT = {
  acceptanceResults: [{ criterion: 'node --test 全绿', status: 'passed', evidence: 'receipt:r1' }],
  receipts: [{ id: 'r1', command: 'node --test', exit_code: 0 }],
};

test('D7 三模块一致性：validatePlan / evaluateCompletion 判契约有问题时，canDeliver 不得放行', () => {
  // A-2：每条用例的契约都补成**合法形态**，让它只因为要测的那个理由被拒；
  // 否则夹具被任何理由拒都算数，「前者拒 ⇒ 后者不得放行」就退化成同义反复。
  const cases = [
    {
      name: '混合写法（顶层的 acceptance/verify + 契约里的 inScope）',
      // 契约视图里只剩 inScope → 读不到 objective/acceptance/verify
      tasks: [
        legalImpl({
          contract: { inScope: ['plugin/src/'], outOfScope: [] },
          objective: '实现的交付够不够',
          acceptance: ['node --test 全绿'],
          verify: ['node --test'],
        }),
        legalReview(),
      ],
      expectPlan: ['E_ACCEPTANCE_REQUIRED'],
      forbidPlan: ['E_ACCEPTANCE_UNVERIFIABLE'],
    },
    {
      name: '混合写法（顶层的 inScope + 契约里的 acceptance/verify）',
      tasks: [
        legalImpl({
          contract: { objective: '实现的交付够不够', acceptance: ['node --test 全绿'], verify: ['node --test'] },
          inScope: ['plugin/src/'],
        }),
        legalReview(),
      ],
      expectPlan: ['E_SCOPE_VERIFY_REQUIRED'],
      forbidPlan: ['E_ACCEPTANCE_UNVERIFIABLE'],
    },
    {
      name: '同字段两处不同值（inScope）',
      tasks: [
        legalImpl({ inScope: ['plugin/docs/'], contract: legalImplContract() }),
        legalReview(),
      ],
      expectPlan: ['E_CONTRACT_AMBIGUOUS'],
      forbidPlan: ['E_ACCEPTANCE_UNVERIFIABLE', 'E_OBJECTIVE_REQUIRED', 'E_ACCEPTANCE_REQUIRED'],
    },
    {
      name: '契约里的路径声明非法（../etc）',
      tasks: [
        legalImpl({ contract: { ...legalImplContract(), inScope: ['../etc'] } }),
        legalReview(),
      ],
      expectPlan: ['E_PATH_UNSAFE'],
      forbidPlan: ['E_ACCEPTANCE_UNVERIFIABLE', 'E_OBJECTIVE_REQUIRED'],
    },
    {
      // F4-4：verify:[] 不能变成"把门禁关掉"，也不能把「没有可对账项」误报成「验收没映射」
      name: 'F4-4 implementation 的 verify 为空',
      tasks: [legalImpl({ contract: { ...legalImplContract(), verify: [] } }), legalReview()],
      expectPlan: ['E_SCOPE_VERIFY_REQUIRED'],
      expectDelivery: ['E_CONTRACT_INCOMPLETE'],
      expectGate: ['E_CONTRACT_INCOMPLETE'],
    },
    {
      // F4-5：任务记录写了 attempt，评审还是上一轮。
      // 这里 **meta 必须缺省**：meta:{attempt:1} 会先命中"两处轮次不一致"的 E_INPUT_INVALID，
      // 那样测的就不是"退回任务记录"这条链了。
      name: 'F4-5 任务记录 attempt={n:2} 而评审未标注',
      tasks: [legalImpl({ attempt: { n: 2 } }), legalReview()],
      gateInput: { ...CONTROL_GATE_INPUT, meta: {} },
      expectGate: ['E_STALE_ATTEMPT'],
      expectDelivery: ['E_STALE_ATTEMPT'],
    },
    {
      // 对照：契约完整的合法任务 —— 三边都必须放行
      name: '对照：契约完整的合法任务',
      tasks: [legalImpl(), legalReview()],
      expectAllPass: true,
    },
  ];

  let planRejected = 0;
  let gateRejected = 0;
  let allPassed = 0;

  for (const item of cases) {
    const plan = validatePlan(item.tasks);
    const gate = gateFor(item.tasks[0], item.gateInput ?? CONTROL_GATE_INPUT);
    const delivery = canDeliver(
      baseInput({ tasks: item.tasks, currentDigests: { [FILE]: SHA }, diffPaths: [FILE] }),
    );

    if (item.expectAllPass) {
      // 对照组：如果连这一条都是"三边都拒"，那上面的不变量就是同义反复
      assert.equal(plan.ok, true, `${item.name}：validatePlan 不该拒（${JSON.stringify(plan.errors.map((e) => e.code))}）`);
      assert.equal(gate.ok, true, `${item.name}：evaluateCompletion 不该拒（${JSON.stringify(gate.errors.map((e) => e.code))}）`);
      assert.equal(delivery.ok, true, `${item.name}：canDeliver 不该拒（${JSON.stringify(codes(delivery))}）`);
      allPassed += 1;
      continue;
    }

    // A-2 的核心：拒的**码**必须是预期那个，不能是"被别的理由顺手拒了"
    const planCodes = contractClassOnly(plan);
    for (const expected of item.expectPlan ?? []) {
      assert.ok(
        planCodes.includes(expected),
        `${item.name}：validatePlan 应含 ${expected}，实际 ${JSON.stringify(planCodes)}`,
      );
    }
    for (const forbidden of item.forbidPlan ?? []) {
      assert.ok(
        !planCodes.includes(forbidden),
        `${item.name}：不该出现 ${forbidden}（那是夹具不合法造成的假拒绝），实际 ${JSON.stringify(planCodes)}`,
      );
    }

    if (!plan.ok) {
      planRejected += 1;
      assert.equal(
        delivery.ok,
        false,
        `${item.name}：validatePlan 拒（${planCodes.join(',')}）但 canDeliver 放行 —— 最后一道门不得更松`,
      );
    }
    if (!gate.ok) {
      gateRejected += 1;
      assert.equal(
        delivery.ok,
        false,
        `${item.name}：evaluateCompletion 拒（${contractClassOnly(gate).join(',')}）但 canDeliver 放行`,
      );
    }
    for (const expected of item.expectGate ?? []) {
      assert.ok(
        gate.errors.map((e) => e.code).includes(expected),
        `${item.name}：gates 应含 ${expected}，实际 ${JSON.stringify(gate.errors.map((e) => e.code))}`,
      );
    }
    for (const expected of item.expectDelivery ?? []) {
      assert.ok(
        codes(delivery).includes(expected),
        `${item.name}：delivery 应含 ${expected}，实际 ${JSON.stringify(codes(delivery))}`,
      );
    }
    assertShape(delivery);
  }

  // 断言不是空转：既有"前者拒"的用例，也有"三边都放行"的对照
  assert.ok(planRejected >= 5, `validatePlan 至少要在 5 个用例上拒，实际 ${planRejected}`);
  assert.ok(gateRejected >= 5, `evaluateCompletion 至少要在 5 个用例上拒，实际 ${gateRejected}`);
  assert.equal(allPassed, 1, '对照组必须真的全绿');
});

test('D7 契约字段两处不同值 → E_CONTRACT_AMBIGUOUS（不替调用方选边）', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({
          inScope: ['plugin/src/'],
          outOfScope: ['plugin/secrets/'],
          contract: {
            inScope: ['plugin/docs/'],
            outOfScope: ['plugin/secrets/'],
            acceptance: ['A'],
            verify: ['node --test'],
          },
        }),
        reviewTask(),
      ],
    }),
  );
  assertBlocked(result, 'E_CONTRACT_AMBIGUOUS', '同字段两处不同值');
  const message = result.blockers.find((b) => b.code === 'E_CONTRACT_AMBIGUOUS').message;
  assert.match(message, /inScope/);
  assert.match(message, /contract/);
});

test('D7 两处同值重复声明不算歧义（不误伤过渡期的双写）', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({
          inScope: ['plugin/src/'],
          outOfScope: ['plugin/secrets/'],
          contract: {
            inScope: ['plugin/src/'],
            outOfScope: ['plugin/secrets/'],
            acceptance: ['A'],
            verify: ['node --test'],
          },
        }),
        reviewTask(),
      ],
    }),
  );
  assert.deepEqual(codes(result), [], `同值双写应放行，实际 ${JSON.stringify(codes(result))}`);
});

test('D7 contract: {} 视为"没写契约"→ 字段从顶层读（L-5 兼容，不报缺声明）', () => {
  const legacy = {
    id: 'impl-1',
    kind: 'implementation',
    status: 'completed',
    changedPaths: [FILE],
    inScope: ['plugin/src/'],
    outOfScope: ['plugin/secrets/'],
    acceptance: ['A'],
    verify: ['node --test'],
    contract: {},
  };
  const result = canDeliver(baseInput({ tasks: [legacy, reviewTask()] }));
  assert.deepEqual(codes(result), [], `contract:{} + 顶层字段必须按顶层读，实际 ${JSON.stringify(codes(result))}`);
});

test('D7 质量类任务读不到 acceptance/verify → E_CONTRACT_INCOMPLETE（work 免）', () => {
  const noAcceptance = canDeliver(
    baseInput({
      tasks: [implTask({ contract: { inScope: ['plugin/src/'], outOfScope: [], verify: ['node --test'] } }), reviewTask()],
    }),
  );
  assertBlocked(noAcceptance, 'E_CONTRACT_INCOMPLETE', 'implementation 缺 acceptance');
  assert.match(
    noAcceptance.blockers.find((b) => b.code === 'E_CONTRACT_INCOMPLETE').message,
    /acceptance/,
  );

  const noVerify = canDeliver(
    baseInput({
      tasks: [implTask({ contract: { inScope: ['plugin/src/'], outOfScope: [], acceptance: ['A'] } }), reviewTask()],
    }),
  );
  assertBlocked(noVerify, 'E_CONTRACT_INCOMPLETE', 'implementation 缺 verify');

  const work = canDeliver(
    baseInput({
      tasks: [implTask(), reviewTask(), workTask({ id: 'w1', changedPaths: [], contract: { inScope: ['plugin/src/'] } })],
    }),
  );
  assert.deepEqual(codes(work), [], 'work 是纯执行项，不要求 acceptance/verify');
});

/* ------------------------------------------------------------------------- */
/* D8 phase 正向白名单                                                        */
/* ------------------------------------------------------------------------- */

test('D8 phase 决策表：7 种输入逐个断言', () => {
  const cases = [
    { phase: 'running', expect: [] },
    { phase: 'staged', expect: ['E_NEEDS_HUMAN_APPROVAL'] },
    { phase: 'halted', expect: ['E_NOT_RUNNING'] },
    { phase: 'archived', expect: ['E_NOT_RUNNING'] },
    { phase: undefined, expect: ['E_NOT_RUNNING'] },
    { phase: '', expect: ['E_NOT_RUNNING'] },
    { phase: 'running2', expect: ['E_NOT_RUNNING'] },
  ];

  for (const { phase, expect } of cases) {
    const result = canDeliver(
      baseInput({ team: { phase, leaderMode: 'spawned', delivered: { ...DELIVERED } } }),
    );
    assertShape(result);
    assert.deepEqual(codes(result), expect, `phase=${JSON.stringify(phase)} 的判定不对`);
  }
});

test('D8 拼写变体不得靠 toLowerCase 蒙过去（RUNNING / 尾空格 / runing）', () => {
  for (const phase of ['RUNNING', 'running ', 'runing', 'Running', ' running']) {
    const result = canDeliver(
      baseInput({ team: { phase, leaderMode: 'spawned', delivered: { ...DELIVERED } } }),
    );
    assert.equal(result.ok, false, `phase=${JSON.stringify(phase)} 不是严格小写 running，不得放行`);
    assert.deepEqual(codes(result), ['E_NOT_RUNNING'], `phase=${JSON.stringify(phase)} 应报 E_NOT_RUNNING`);
  }
});

test('D8 message 点明收到的值与允许的值（运维要知道改什么）', () => {
  const result = canDeliver(
    baseInput({ team: { phase: 'RUNNING', leaderMode: 'spawned', delivered: { ...DELIVERED } } }),
  );
  const message = result.blockers.find((b) => b.code === 'E_NOT_RUNNING').message;
  assert.match(message, /RUNNING/, '要回显收到的值');
  assert.match(message, /"running"/, '要写明允许的值');
  assert.match(message, /大小写敏感/);
});

test('D8 phase 非字符串（null / 数字 / 对象）一律不放行', () => {
  for (const phase of [null, 0, 1, {}, [], true]) {
    const result = canDeliver(
      baseInput({ team: { phase, leaderMode: 'spawned', delivered: { ...DELIVERED } } }),
    );
    assert.equal(result.ok, false, `phase=${JSON.stringify(phase)} 不得被视为运行中`);
    assert.ok(codes(result).includes('E_NOT_RUNNING'));
  }
});

test('D8 码表包含 E_NEEDS_HUMAN_APPROVAL（新增码必须登记，拼错码=静默放行）', () => {
  assert.ok(DELIVERY_BLOCKER_CODES.includes('E_NEEDS_HUMAN_APPROVAL'));
  assert.ok(!DELIVERY_BLOCKER_CODES.includes('E_PHASE_UNKNOWN'));
});

/* ------------------------------------------------------------------------- */
/* D9 attempt 对齐：缺省即第 1 轮                                             */
/* ------------------------------------------------------------------------- */

test('D9 组1：任务 attempt 有效正整数 + 评审不符 → E_STALE_ATTEMPT', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1', attempt: 3 }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: 2, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assertBlocked(result, 'E_STALE_ATTEMPT', '3 vs 2');
  assert.ok(!codes(result).includes('E_INPUT_INVALID'), '合法正整数不该被当成非法形态');
});

test('D9 组2：任务 attempt 缺失（视为 1）+ 评审声称 2 → E_STALE_ATTEMPT', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1' }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: 2, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assertBlocked(result, 'E_STALE_ATTEMPT', '任务缺失视为第 1 轮，评审声称第 2 轮');
  assert.match(
    result.blockers.find((b) => b.code === 'E_STALE_ATTEMPT').message,
    /未提供，按第 1 轮处理/,
  );
});

test('D9 reviewed.attempt 只认标量：{n:2} 这类记录形态 → E_INPUT_INVALID', () => {
  // 形态放宽只针对"任务记录"（团队存储确实把 attempt 记成 {n,id}，gates 夹具也这么写）；
  // 评审签名来自 gates 的 meta.attempt，是标量，写成对象就是坏输入。
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1', attempt: 2 }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: { n: 2 }, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assertBlocked(result, 'E_INPUT_INVALID', '{n:2} 不是标量正整数');
});

test('D9 组3：评审 attempt 缺失（视为 1）—— 任务在第 1 轮放行，任务在第 2 轮拒绝', () => {
  const bootstrap = canDeliver(baseInput({ tasks: [implTask({ attempt: 1 }), reviewTask()] }));
  assert.deepEqual(codes(bootstrap), [], '第 1 轮允许评审不标注 attempt');

  const later = canDeliver(baseInput({ tasks: [implTask({ attempt: 2 }), reviewTask()] }));
  assertBlocked(later, 'E_STALE_ATTEMPT', '第 2 轮不得用未标注（=第 1 轮）的评审');
});

test('D9 组4：reviewed.attempt 非正整数（"2" / 2.5 / 0）→ E_INPUT_INVALID，且不混成 STALE', () => {
  for (const attempt of ['2', 2.5, 0, -1, true, {}, []]) {
    const result = canDeliver(
      baseInput({
        tasks: [
          implTask({ id: 'impl-1', attempt: 2 }),
          reviewTask({ reviewed: { verdict: 'pass', attempt, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
        ],
      }),
    );
    assertBlocked(result, 'E_INPUT_INVALID', `reviewed.attempt=${JSON.stringify(attempt)}`);
    assert.ok(
      !codes(result).includes('E_STALE_ATTEMPT'),
      `非法形态应当报 E_INPUT_INVALID 而不是含糊的 STALE：${JSON.stringify(codes(result))}`,
    );
  }
});

test('D9 任务侧 attempt 非法（"2" / 2.5 / 0）→ E_INPUT_INVALID（不得静默当缺失）', () => {
  for (const attempt of ['2', 2.5, 0, -1]) {
    const result = canDeliver(baseInput({ tasks: [implTask({ attempt }), reviewTask()] }));
    assertBlocked(result, 'E_INPUT_INVALID', `任务 attempt=${JSON.stringify(attempt)}`);
  }
});

test('D9 任务记录形态 { n } 与评审标量混用时按值比较（不因形态差异误判）', () => {
  const aligned = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1', attempt: { n: 4, id: 'impl-1#4' } }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: 4, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assert.deepEqual(codes(aligned), []);

  const mismatched = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1', attempt: { n: 4, id: 'impl-1#4' } }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: 3, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assertBlocked(mismatched, 'E_STALE_ATTEMPT', '{n:4} vs 3');
});

test('D9 JSON 往返：attempt=2 经 JSON.stringify/parse 后仍按正整数比较', () => {
  const tasks = JSON.parse(JSON.stringify([
    implTask({ id: 'impl-1', attempt: 2 }),
    reviewTask({ reviewed: { verdict: 'pass', attempt: 2, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
  ]));
  const result = canDeliver(baseInput({ tasks }));
  assert.deepEqual(codes(result), []);
});

test('D9 引导轮（attempt 全缺失）不因缺省而阻塞正常交付', () => {
  const result = canDeliver(
    baseInput({ tasks: [implTask(), reviewTask(), implTask({ id: 'impl-2', changedPaths: [], sourceTaskId: 'impl-1' })] }),
  );
  assert.deepEqual(codes(result), []);
});

test('D9 码表包含 E_INPUT_INVALID 与 E_STALE_ATTEMPT', () => {
  assert.ok(DELIVERY_BLOCKER_CODES.includes('E_INPUT_INVALID'));
  assert.ok(DELIVERY_BLOCKER_CODES.includes('E_STALE_ATTEMPT'));
});

/* ------------------------------------------------------------------------- */
/* D10 区分但不双报：STALE 单独出现，UNBOUND 只在"完全没记录"时出现            */
/* ------------------------------------------------------------------------- */

test('D10 审后篡改只报 E_BINDING_STALE，不再叠加 E_UNBOUND_ARTIFACT', () => {
  // 修前：指纹不符 → E_BINDING_STALE + E_UNBOUND_ARTIFACT（"指纹不符的绑定不算绑定"）。
  // 运维看到两条码会先怀疑"漏审"，而真正该看的是"文件被改了"。STALE 必须刺眼、不许被稀释。
  const result = canDeliver(baseInput({ currentDigests: { [FILE]: 'sha-CHANGED' } }));
  assertShape(result);
  assert.deepEqual(codes(result), ['E_BINDING_STALE'], `只允许 STALE 单独出现，实际 ${JSON.stringify(codes(result))}`);
});

test('D10 present:false 但现在存在 → 只报 STALE', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: false }] } })],
    }),
  );
  assert.deepEqual(codes(result), ['E_BINDING_STALE']);
});

test('D10 记录存在但现在缺失 → 只报 STALE', () => {
  const result = canDeliver(baseInput({ currentDigests: {} }));
  assert.deepEqual(codes(result), ['E_BINDING_STALE']);
});

test('D10 完全没有绑定记录 → 才报 E_UNBOUND_ARTIFACT（且没有 STALE 噪声）', () => {
  const result = canDeliver(
    baseInput({ tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [] } })] }),
  );
  assert.deepEqual(codes(result), ['E_UNBOUND_ARTIFACT']);
  assert.ok(!codes(result).includes('E_BINDING_STALE'));
});

test('D10 缺指纹仍然双报 UNVERIFIABLE + UNBOUND（它从未给出可验证的绑定）', () => {
  // 这是刻意的 carve-out，不是漏改：缺 sha256 没有"字节被改"这个信号，
  // 有的是"记录本身不完整"，所以 UNVERIFIABLE（记录不合格）与 UNBOUND（绑定不成立）都要说，
  // 而且绝不会冒出一条会误导成"被篡改"的 E_BINDING_STALE。
  const result = canDeliver(
    baseInput({
      tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: true }] } })],
    }),
  );
  const found = codes(result);
  assert.ok(found.includes('E_BINDING_UNVERIFIABLE'));
  assert.ok(found.includes('E_UNBOUND_ARTIFACT'));
  assert.ok(!found.includes('E_BINDING_STALE'), '缺指纹不是篡改信号');
});

test('D10 多路径混合：被篡改的那条只报 STALE，没被记录的那条才报 UNBOUND', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ changedPaths: [FILE, FILE2] }),
        reviewTask({ reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
      currentDigests: { [FILE]: 'sha-TAMPERED', [FILE2]: SHA2 },
      diffPaths: [FILE, FILE2],
    }),
  );
  const found = codes(result);
  assert.ok(found.includes('E_BINDING_STALE'), JSON.stringify(found));
  assert.ok(found.includes('E_UNBOUND_ARTIFACT'), JSON.stringify(found));
  const unbound = result.blockers
    .filter((b) => b.code === 'E_UNBOUND_ARTIFACT')
    .map((b) => b.message)
    .join('\n');
  assert.ok(unbound.includes(FILE2), 'FILE2 从未被记录 → UNBOUND 应点名它');
  assert.ok(!unbound.includes(FILE), 'FILE 已被记录（只是被改）→ 不得再报 UNBOUND');
});

/* ------------------------------------------------------------------------- */
/* D11 路径安全：E_PATH_UNSAFE                                                */
/* ------------------------------------------------------------------------- */

test('D11 声明非法（contract.inScope 里的 ../etc）→ E_PATH_UNSAFE，且不叠加越界', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({
          contract: { inScope: ['../etc'], outOfScope: [], acceptance: ['A'], verify: ['node --test'] },
        }),
        reviewTask(),
      ],
    }),
  );
  assertShape(result);
  assert.deepEqual(codes(result), ['E_PATH_UNSAFE'], `只应报声明非法，实际 ${JSON.stringify(codes(result))}`);
  const message = result.blockers[0].message;
  assert.match(message, /inScope/);
  assert.match(message, /\.\./);
});

test('D11 outOfScope 里的绝对路径同样报 E_PATH_UNSAFE', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({
          contract: { inScope: ['plugin/src/'], outOfScope: ['/abs'], acceptance: ['A'], verify: ['node --test'] },
        }),
        reviewTask(),
      ],
    }),
  );
  assert.ok(codes(result).includes('E_PATH_UNSAFE'), JSON.stringify(codes(result)));
  assert.match(
    result.blockers.find((b) => b.code === 'E_PATH_UNSAFE').message,
    /outOfScope/,
  );
});

test('D11 审计对象（changedPaths）非法 → E_PATH_UNSAFE（同时保留越界判定）', () => {
  const evil = '../../etc/passwd';
  const result = canDeliver(
    baseInput({
      tasks: [implTask({ changedPaths: [evil] })],
      currentDigests: { [evil]: 'sha-evil' },
      diffPaths: [evil],
    }),
  );
  assertShape(result);
  assert.ok(codes(result).includes('E_PATH_UNSAFE'), `changedPaths 非法应报 PATH_UNSAFE：${JSON.stringify(codes(result))}`);
  assert.ok(codes(result).includes('E_OUT_OF_SCOPE'), '越界判定保留（fail-closed 不能因为报了 PATH_UNSAFE 就放松）');
});

test('D11 审计对象（diffPaths）非法 → E_PATH_UNSAFE', () => {
  const evil = '../escape.mjs';
  const result = canDeliver(
    baseInput({
      tasks: [implTask({ changedPaths: [] })],
      currentDigests: { [FILE]: SHA },
      diffPaths: [evil],
    }),
  );
  assert.ok(codes(result).includes('E_PATH_UNSAFE'), JSON.stringify(codes(result)));
  assert.match(
    result.blockers.filter((b) => b.code === 'E_PATH_UNSAFE').map((b) => b.message).join('\n'),
    /diffPaths/,
  );
});

test('D11 码表包含 E_PATH_UNSAFE（诊断码必须登记，否则调用方会漏处理）', () => {
  assert.ok(DELIVERY_BLOCKER_CODES.includes('E_PATH_UNSAFE'));
});

/* ------------------------------------------------------------------------- */
/* D12 代码卫生                                                               */
/* ------------------------------------------------------------------------- */

test('L-7 未知 kind / 未知 status 不再让记录凭空消失（E_INPUT_INVALID）', () => {
  const ghostKind = canDeliver(
    baseInput({ tasks: [implTask({ kind: 'Impl' }), reviewTask()], diffPaths: [] }),
  );
  assert.equal(ghostKind.ok, false, 'kind 拼错不得让任务消失');
  assertBlocked(ghostKind, 'E_INPUT_INVALID', 'kind=Impl');

  const ghostStatus = canDeliver(
    baseInput({ tasks: [implTask({ status: 'Done' }), reviewTask()], diffPaths: [] }),
  );
  assert.equal(ghostStatus.ok, false, 'status 拼错不得让任务消失');
  assertBlocked(ghostStatus, 'E_INPUT_INVALID', 'status=Done');
});

test('L-13 cancelled 没有隐式豁免：仍不认领 diff、申报路径仍要求绑定', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask(),
        reviewTask(),
        implTask({ id: 'impl-2', status: 'cancelled', cancelReason: '需求撤回', changedPaths: [FILE2] }),
      ],
      currentDigests: { [FILE]: SHA, [FILE2]: SHA2 },
      diffPaths: [FILE, FILE2],
    }),
  );
  const found = codes(result);
  assert.ok(!found.includes('E_CANCELLED_NO_REASON'), '写了原因就不该报缺原因');
  assert.ok(found.includes('E_UNREPORTED_CHANGES'), 'cancelled 不受理 diff：没人认领 FILE2');
  assert.ok(found.includes('E_UNBOUND_ARTIFACT'), 'cancelled 申报的路径同样不能被评审豁免');
});

test('D12 describeDeliveryContract 如实标明当前契约入口来源', () => {
  const description = describeDeliveryContract();
  assert.ok(description.contractSource);
  for (const key of ['contractOf', 'contractAmbiguity', 'toEntryList', 'toEntryListStrict', 'classifyPath', 'normalizePath']) {
    assert.ok(key in description.contractSource, `contractSource 必须交代 ${key} 取自哪里`);
    assert.ok(typeof description.contractSource[key] === 'string' && description.contractSource[key].length > 0);
  }
  assert.equal(description.contractSource.classifyPath, 'contract.mjs');
  assert.equal(description.contractSource.normalizePath, 'contract.mjs');
});

test('码表自洽：describeDeliveryContract().enforced 与 DELIVERY_BLOCKER_CODES 完全一致且无重复', () => {
  const description = describeDeliveryContract();
  assert.deepEqual(description.enforced, [...DELIVERY_BLOCKER_CODES]);
  assert.equal(new Set(DELIVERY_BLOCKER_CODES).size, DELIVERY_BLOCKER_CODES.length, '码表不得有重复项');
  for (const code of DELIVERY_BLOCKER_CODES) assert.match(code, /^E_[A-Z0-9_]+$/);
});

test('每个 blocker 都有非空 message，且 message 不含 undefined / [object Object]', () => {
  const input = baseInput({
    team: { phase: 'weird', delivered: undefined },
    tasks: [
      implTask({ status: 'bogus', kind: 'Impl' }),
      reviewTask({ reviewed: { verdict: 'pass', attempt: '2', artifacts: [{ path: FILE, present: true, sha256: 'x' }] } }),
    ],
    currentDigests: {},
    diffPaths: ['docs/x.md'],
  });
  const result = canDeliver(input);
  assertShape(result);
  assert.equal(result.ok, false);
  for (const blocker of result.blockers) {
    assert.ok(!blocker.message.includes('undefined'), `${blocker.code}: message 泄漏 undefined`);
    assert.ok(!blocker.message.includes('[object Object]'), `${blocker.code}: message 泄漏 [object Object]`);
  }
});

/* ------------------------------------------------------------------------- */
/* W3-A（第 5 轮 / D-7）：轮次解析链显式化                                     */
/* ------------------------------------------------------------------------- */

/** 造一份带 attempt 的合法契约（把默认契约替换掉时必须补齐质量声明）。 */
function implContractWith(attempt) {
  return {
    inScope: ['plugin/src/'],
    outOfScope: ['plugin/secrets/'],
    acceptance: ['canDeliver 返回 ok/blockers'],
    verify: ['node --test plugin/test/delivery.test.mjs'],
    attempt,
  };
}

test('W3-A 链顺序：contract.attempt 优先于任务记录 attempt（contract ?? task ?? 1）', () => {
  // 契约写 2、任务记录写 3 → 按契约的 2 算（链的第一段）
  const alignedWithContract = canDeliver(
    baseInput({
      tasks: [
        implTask({ attempt: 3, contract: implContractWith(2) }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: 2, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assert.deepEqual(codes(alignedWithContract), [], '按契约的 2 算，评审标注 2 应当通过');

  const alignedWithRecord = canDeliver(
    baseInput({
      tasks: [
        implTask({ attempt: 3, contract: implContractWith(2) }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: 3, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assertBlocked(alignedWithRecord, 'E_STALE_ATTEMPT', '若按任务记录的 3 算就会放行 → 说明链的顺序错了');
});

test('W3-A 错误信息点明轮次来源：任务记录 → "任务的记录 attempt → 第 N 轮"', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask({ attempt: { n: 5, id: 'impl-1#5' } }), reviewTask()],
    }),
  );
  assertBlocked(result, 'E_STALE_ATTEMPT', '记录形态 {n:5} 应按第 5 轮');
  const message = result.blockers.find((b) => b.code === 'E_STALE_ATTEMPT').message;
  assert.match(message, /任务的记录 attempt → 第 5 轮/, `要说明 5 是从记录读出来的：${message}`);
  assert.match(message, /评审未标注 attempt，按第 1 轮处理/, '评审侧缺省要单独说明');
});

test('W3-A 错误信息点明轮次来源：契约 → "任务的契约 attempt → 第 N 轮"', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ contract: implContractWith(3) }),
        reviewTask({ reviewed: { verdict: 'pass', attempt: 2, artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
    }),
  );
  assertBlocked(result, 'E_STALE_ATTEMPT', '3 vs 2');
  assert.match(
    result.blockers.find((b) => b.code === 'E_STALE_ATTEMPT').message,
    /任务的契约 attempt → 第 3 轮/,
  );
});

test('W3-A 记录形态缺 n / n 非法 → E_INPUT_INVALID（"记了但读不懂" ≠ "没记"）', () => {
  for (const bad of [{ id: 'impl-1#2' }, {}, { n: '2' }, { n: 0 }, { n: 2.5 }, { n: -1 }, { n: true }]) {
    const result = canDeliver(baseInput({ tasks: [implTask({ attempt: bad }), reviewTask()] }));
    assertBlocked(result, 'E_INPUT_INVALID', `attempt=${JSON.stringify(bad)}`);
    assert.ok(
      !codes(result).includes('E_STALE_ATTEMPT'),
      `非法形态只报 E_INPUT_INVALID，不该混成 STALE：${JSON.stringify(codes(result))}`,
    );
  }
});

test('W3-A 缺省即第 1 轮：null 视为缺失；空串是非法形态（D-3：要表达"没有"必须省略字段）', () => {
  const nullIsMissing = canDeliver(baseInput({ tasks: [implTask({ attempt: null }), reviewTask()] }));
  assert.deepEqual(codes(nullIsMissing), [], 'null = 没写 = 第 1 轮');

  const emptyStringIsInvalid = canDeliver(baseInput({ tasks: [implTask({ attempt: '' }), reviewTask()] }));
  assertBlocked(emptyStringIsInvalid, 'E_INPUT_INVALID', '空串不是"缺失"');
});

/* ------------------------------------------------------------------------- */
/* W3-B（第 5 轮 / D-8）：review 也要查契约完整性                              */
/* ------------------------------------------------------------------------- */

test('W3-B review 缺 acceptance → E_CONTRACT_INCOMPLETE（与 gates 同码同义）', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask(),
        reviewTask({
          contract: { reviewedTaskId: 'impl-1', inScope: [], outOfScope: [], verify: ['node --test'] },
        }),
      ],
    }),
  );
  assertBlocked(result, 'E_CONTRACT_INCOMPLETE', 'review 缺 acceptance');
  const message = result.blockers.find((b) => b.code === 'E_CONTRACT_INCOMPLETE').message;
  assert.match(message, /acceptance/);
  assert.match(message, /review 也要说清/, 'review 的 message 要说明"用什么验证了这次评审"');
  assert.match(message, /压根没声明/, '措辞与 gates 对齐：这不是"验收没覆盖"');
});

test('W3-B review 缺 verify → E_CONTRACT_INCOMPLETE', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask(),
        reviewTask({
          contract: { reviewedTaskId: 'impl-1', inScope: [], outOfScope: [], acceptance: ['评审通过'] },
        }),
      ],
    }),
  );
  assertBlocked(result, 'E_CONTRACT_INCOMPLETE', 'review 缺 verify');
  assert.match(
    result.blockers.find((b) => b.code === 'E_CONTRACT_INCOMPLETE').message,
    /verify/,
  );
});

test('W3-B review 两个都缺 → 只报一条，且两个字段都点名', () => {
  const result = canDeliver(
    baseInput({
      tasks: [implTask(), reviewTask({ contract: { reviewedTaskId: 'impl-1' } })],
    }),
  );
  assert.equal(
    result.blockers.filter((b) => b.code === 'E_CONTRACT_INCOMPLETE').length,
    1,
    `同一任务只报一条：${JSON.stringify(codes(result))}`,
  );
  const message = result.blockers.find((b) => b.code === 'E_CONTRACT_INCOMPLETE').message;
  assert.match(message, /acceptance/);
  assert.match(message, /verify/);
});

test('W3-B review 的 contract:{} 按"没写"处理 → E_CONTRACT_INCOMPLETE（不许因 verdict=pass 放行）', () => {
  const result = canDeliver(baseInput({ tasks: [implTask(), reviewTask({ contract: {} })] }));
  assert.equal(result.ok, false, '空契约的 review 不能靠 verdict=pass 过关');
  assert.deepEqual(codes(result), ['E_CONTRACT_INCOMPLETE'], `应只报契约不完整：${JSON.stringify(codes(result))}`);
});

test('W3-B 合法 review（acceptance + verify 齐）不误伤；work 仍然豁免', () => {
  const legal = canDeliver(baseInput());
  assert.deepEqual(codes(legal), [], '合法 review 不得被新判定误伤');

  const workWithoutDeclarations = canDeliver(
    baseInput({
      tasks: [
        implTask(),
        reviewTask(),
        workTask({ id: 'w1', changedPaths: [], contract: { inScope: ['plugin/src/'] } }),
      ],
    }),
  );
  assert.deepEqual(codes(workWithoutDeclarations), [], 'work 是纯执行项，不要求 acceptance/verify');
});

test('W3-B 与 gates 共用同一句核心措辞（同码同义，不能有两种说法）', () => {
  const task = implTask({ contract: { inScope: ['plugin/src/'], outOfScope: [], acceptance: ['A'] } });
  const deliveryMessage = canDeliver(baseInput({ tasks: [task, reviewTask()] }))
    .blockers.find((b) => b.code === 'E_CONTRACT_INCOMPLETE').message;
  const gateMessage = evaluateCompletion({
    task,
    meta: { attempt: 1 },
    payload: { changedPaths: [FILE], acceptanceResults: [] },
    receipts: [],
    diffPaths: [FILE],
  }).errors.find((e) => e.code === 'E_CONTRACT_INCOMPLETE').message;

  const shared = '质量任务的"完成"必须同时有验收项和验证命令';
  assert.ok(deliveryMessage.includes(shared), `delivery 缺核心句：${deliveryMessage}`);
  assert.ok(gateMessage.includes(shared), `gates 缺核心句：${gateMessage}`);
  // 两边都必须点出缺的字段名，否则运维还得自己猜是哪一份
  for (const message of [deliveryMessage, gateMessage]) assert.match(message, /verify/);
});

/* ------------------------------------------------------------------------- */
/* W3-1（第 4 轮）：非法原因的中文只有契约那一份                               */
/* ------------------------------------------------------------------------- */

/**
 * 每种 reason 码对应的一个"能触发它"的声明值。
 * 这张表就是 delivery 与 contract 的接口面：reason 枚举加了新成员，这里会立刻缺项。
 */
const ILLEGAL_VECTORS = [
  ['not-string', 42],
  ['empty', '.'],
  ['home', '~/x'],
  ['control-char', 'src/a\u0000.ts'],
  ['encoded-traversal', 'src/%2e%2e/x'],
  ['absolute', '/abs'],
  ['traversal', '../etc'],
  ['colon', 'src/a.ts:stream'],
];

test('W3-1 声明侧：E_PATH_UNSAFE 的 reason 逐字取自 contract.describePathIllegal（8 种原因全覆盖）', () => {
  for (const [code, bad] of ILLEGAL_VECTORS) {
    const result = canDeliver(
      baseInput({
        tasks: [
          implTask({ contract: { inScope: [bad], outOfScope: [], acceptance: ['A'], verify: ['node --test'] } }),
          reviewTask(),
        ],
      }),
    );
    assertBlocked(result, 'E_PATH_UNSAFE', `inScope=${JSON.stringify(bad)}`);
    const message = result.blockers.find((b) => b.code === 'E_PATH_UNSAFE').message;

    // 逐字包含契约给的那句话 —— 这是"只有一份中文"的证明，不是"看起来意思差不多"
    assert.ok(
      message.includes(describePathIllegal(code)),
      `${code} 的中文必须逐字等于契约的 describePathIllegal：\n  期望片段：${describePathIllegal(code)}\n  实际消息：${message}`,
    );
    // 漂移哨兵：reason 码不在 PATH_ILLEGAL_REASONS 里时，契约会返回"未知的非法原因"
    assert.ok(!message.includes('未知的非法原因'), `${code} 不在 contract 的枚举里，说明两边枚举漂移了：${message}`);
    assert.ok(message.includes(code === 'empty' ? 'inScope' : 'inScope'), 'message 必须点名是哪个字段非法');
  }
});

test('W3-1 审计对象侧：changedPaths / diffPaths 用同一句中文，不出现第二套诊断', () => {
  const vectors = [
    ['traversal', '../../etc/passwd'],
    ['absolute', '/etc/passwd'],
    ['home', '~/secrets'],
    ['colon', 'src/a.ts:stream'],
  ];
  for (const [code, evil] of vectors) {
    const result = canDeliver(
      baseInput({
        tasks: [implTask({ changedPaths: [evil] })],
        currentDigests: { [evil]: 'sha-evil' },
        diffPaths: [evil],
      }),
    );
    const message = result.blockers
      .filter((b) => b.code === 'E_PATH_UNSAFE')
      .map((b) => b.message)
      .join('\n');
    assert.ok(message.length > 0, `${JSON.stringify(evil)} 必须被 E_PATH_UNSAFE 点名`);
    assert.ok(
      message.includes(describePathIllegal(code)),
      `${code}：审计对象侧也必须用契约那句中文，实际 ${message}`,
    );
    assert.ok(!message.includes('未知的非法原因'), `${code}：审计对象侧枚举漂移`);
  }
});

test('W3-1 表格完整性：ILLEGAL_VECTORS 覆盖 PATH_ILLEGAL_REASONS 的每一项', () => {
  // 契约新增一个 reason 而这里没补向量 → 立刻红，逼着两边一起更新
  const covered = new Set(ILLEGAL_VECTORS.map(([code]) => code));
  const missing = PATH_ILLEGAL_REASONS.filter((code) => !covered.has(code));
  assert.deepEqual(missing, [], `这些 reason 还没有测试向量：${JSON.stringify(missing)}`);
  assert.ok(Object.isFrozen(PATH_ILLEGAL_REASONS), '原因枚举必须是冻结的');
});

test('W3-1 delivery 不再自带中文 reason 表：contractSource 指向 contract.mjs', () => {
  const source = describeDeliveryContract().contractSource;
  assert.equal(source.describePathIllegal, 'contract.mjs', '中文 reason 必须来自契约，不许本模块再抄一份');
  assert.equal(source.pathIllegalReasons, 'contract.mjs');
});

test('W3-1 整值缺席 / 空串的声明不算非法（契约源头已修，本模块的过滤只是防御）', () => {
  // 第 3 轮我踩到过：契约把"没写"也塞进 illegal，导致每个任务凭空多一条 E_PATH_UNSAFE。
  // W1 已在源头改成 {entries:[], illegal:[]}；这里同时锁住两侧，任一侧回退都会红。
  for (const absent of [undefined, null, '', '   ']) {
    assert.deepEqual(
      toEntryListStrict(absent),
      { entries: [], illegal: [] },
      `contract.toEntryListStrict(${JSON.stringify(absent)}) 必须视为"没声明"`,
    );
    const result = canDeliver(
      baseInput({
        tasks: [
          implTask({ contract: { inScope: ['plugin/src/'], outOfScope: absent, acceptance: ['A'], verify: ['node --test'] } }),
          reviewTask(),
        ],
      }),
    );
    assert.deepEqual(codes(result), [], `outOfScope=${JSON.stringify(absent)} 不该报任何 blocker`);
  }
});

/* ------------------------------------------------------------------------- */
/* W3-2（第 4 轮）：STALE 与 UNBOUND 的区分是"真的"，不是"看着对"             */
/* ------------------------------------------------------------------------- */

/** 一条 blocker 的消息里是否点了这条路径。 */
function mentions(blockers, code, path) {
  return blockers.some((b) => b.code === code && b.message.includes(path));
}

test('W3-2 最小对照：同一份篡改后的工作区，只改"有没有记录"这一个事实', () => {
  // 两边 currentDigests 相同（都被改过）；唯一差异是评审有没有记录过这条产物。
  const tampered = { [FILE]: 'sha-TAMPERED' };

  const withRecord = canDeliver(baseInput({ currentDigests: tampered }));
  const withoutRecord = canDeliver(
    baseInput({
      currentDigests: tampered,
      tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [] } })],
    }),
  );

  // 有记录 + 指纹不符 → 只有"被改了"
  assert.deepEqual(codes(withRecord), ['E_BINDING_STALE'], `有记录应只报 STALE，实际 ${JSON.stringify(codes(withRecord))}`);
  // 没记录（哪怕工作区同样被动过）→ 只有"没审过"
  assert.deepEqual(
    codes(withoutRecord),
    ['E_UNBOUND_ARTIFACT'],
    `没记录应只报 UNBOUND，实际 ${JSON.stringify(codes(withoutRecord))}`,
  );

  // 两侧各不出现对方的码：这就是"区分成立"的可执行定义
  assert.ok(!codes(withRecord).includes('E_UNBOUND_ARTIFACT'));
  assert.ok(!codes(withoutRecord).includes('E_BINDING_STALE'));
});

test('W3-2 单 owner 多路径：被改的那条只出 STALE，没记录的那条只出 UNBOUND（各一条）', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ changedPaths: [FILE, FILE2] }),
        reviewTask({ reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
      ],
      currentDigests: { [FILE]: 'sha-TAMPERED', [FILE2]: SHA2 },
      diffPaths: [FILE, FILE2],
    }),
  );

  assert.equal(result.blockers.filter((b) => b.code === 'E_BINDING_STALE').length, 1, JSON.stringify(codes(result)));
  assert.equal(result.blockers.filter((b) => b.code === 'E_UNBOUND_ARTIFACT').length, 1, JSON.stringify(codes(result)));

  assert.ok(mentions(result.blockers, 'E_BINDING_STALE', FILE), 'STALE 应点名被改的 FILE');
  assert.ok(!mentions(result.blockers, 'E_BINDING_STALE', FILE2), 'FILE2 没被记录，不该出 STALE');
  assert.ok(mentions(result.blockers, 'E_UNBOUND_ARTIFACT', FILE2), 'UNBOUND 应点名没记录的 FILE2');
  assert.ok(!mentions(result.blockers, 'E_UNBOUND_ARTIFACT', FILE), 'FILE 是被改了而不是没审，不该出 UNBOUND');
});

test('W3-2 矩阵不变量：同一条路径不会同时出现在 STALE 与 UNBOUND 的消息里', () => {
  const matrix = [
    { name: '正确绑定', over: {} },
    { name: '审后篡改', over: { currentDigests: { [FILE]: 'sha-CHANGED' } } },
    { name: '产物被删', over: { currentDigests: {} } },
    {
      name: '记录为不存在但现在存在',
      over: { tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: false }] } })] },
    },
    {
      name: '从未记录',
      over: { tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [] } })] },
    },
    {
      name: '两条路径：一条被改、一条没记录',
      over: {
        tasks: [
          implTask({ changedPaths: [FILE, FILE2] }),
          reviewTask({ reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: true, sha256: SHA }] } }),
        ],
        currentDigests: { [FILE]: 'sha-CHANGED', [FILE2]: SHA2 },
        diffPaths: [FILE, FILE2],
      },
    },
  ];

  let staleSeen = 0;
  let unboundSeen = 0;
  for (const item of matrix) {
    const result = canDeliver(baseInput(item.over));
    assertShape(result);
    for (const path of [FILE, FILE2]) {
      const stale = mentions(result.blockers, 'E_BINDING_STALE', path);
      const unbound = mentions(result.blockers, 'E_UNBOUND_ARTIFACT', path);
      assert.ok(
        !(stale && unbound),
        `${item.name}：路径 ${path} 同时被 STALE 与 UNBOUND 点名（双报）：${JSON.stringify(result.blockers)}`,
      );
      if (stale) staleSeen += 1;
      if (unbound) unboundSeen += 1;
    }
  }
  // 不变量不能靠"一个都没出现"来成立
  assert.ok(staleSeen >= 3, `矩阵里 STALE 至少出现 3 次，实际 ${staleSeen}`);
  assert.ok(unboundSeen >= 2, `矩阵里 UNBOUND 至少出现 2 次，实际 ${unboundSeen}`);
});

test('W3-2 抑制是"按 (owner, path)"而不是"按路径全局静音"', () => {
  // impl-1 有记录但被改 → 只吃 STALE；impl-2 从未被评审 → 同一路径仍然要吃 UNBOUND。
  // 两者同时出现是**正确**的：它们是两个任务的两件事，不是同一事实的两条码。
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ id: 'impl-1' }),
        implTask({ id: 'impl-2' }),
        reviewTask({ sourceTaskId: 'impl-1' }),
      ],
      currentDigests: { [FILE]: 'sha-TAMPERED' },
    }),
  );

  const found = codes(result);
  assert.ok(found.includes('E_BINDING_STALE'), JSON.stringify(found));
  assert.ok(found.includes('E_UNBOUND_ARTIFACT'), JSON.stringify(found));

  const unboundMessages = result.blockers.filter((b) => b.code === 'E_UNBOUND_ARTIFACT').map((b) => b.message);
  assert.equal(unboundMessages.length, 1, '只有 impl-2 没被绑定，应恰好一条');
  // 断言"未绑定任务列表"而不是整段消息：提示里合法地会点名 impl-1（"该路径只被任务 impl-1 记录过，归属不符"）
  assert.match(unboundMessages[0], /代码变更任务 impl-2 申报的路径/, `UNBOUND 的未绑定任务必须只有 impl-2：${unboundMessages[0]}`);
  assert.ok(!/代码变更任务[^。]*impl-1/.test(unboundMessages[0]), `impl-1 是被改了（STALE），不该被算成未绑定：${unboundMessages[0]}`);
  assert.match(unboundMessages[0], /归属不符/, '提示应说明 impl-1 的评审不能给 impl-2 背书');

  const staleMessages = result.blockers.filter((b) => b.code === 'E_BINDING_STALE');
  assert.equal(staleMessages.length, 1, JSON.stringify(staleMessages));
  assert.ok(staleMessages[0].message.includes('review-1'), 'STALE 要点名是哪条评审记录的绑定失效了');
});

test('W3-2 "记录为不存在"也属于有记录：改成删掉这条记录，码就从 STALE 变成 UNBOUND', () => {
  const presentFalse = canDeliver(
    baseInput({
      tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: false }] } })],
    }),
  );
  const noArtifact = canDeliver(
    baseInput({ tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [] } })] }),
  );

  assert.deepEqual(codes(presentFalse), ['E_BINDING_STALE'], '记录过（哪怕是记录"不存在"）→ 篡改信号');
  assert.deepEqual(codes(noArtifact), ['E_UNBOUND_ARTIFACT'], '连记录都没有 → 覆盖不足');
});

test('W3-2 篡改被修好后两个码一起消失（不留下"习惯性 UNBOUND"）', () => {
  const fixed = canDeliver(baseInput({ currentDigests: { [FILE]: SHA } }));
  assert.deepEqual(codes(fixed), [], '把文件改回去，绑定重新成立，两个码都必须消失');

  // 反向确认：不是"所有输入都没码"造成的假绿
  const tampered = canDeliver(baseInput({ currentDigests: { [FILE]: 'sha-OTHER' } }));
  assert.deepEqual(codes(tampered), ['E_BINDING_STALE']);
});

/* ------------------------------------------------------------------------- */
/* W3-F（第 7 轮）：separationOfDuties 的 11 条 + J-1 两条                     */
/* ------------------------------------------------------------------------- */

/**
 * 造一条 completed + pass 的评审（可指定 id / assignee / revision / verdict）。
 * 契约带 reviewedTaskId，保证归属可解析（否则判不了自审）。
 */
function sodReview(over = {}) {
  return {
    id: 'review-1',
    kind: 'review',
    status: 'completed',
    changedPaths: [],
    contract: {
      reviewedTaskId: 'impl-1',
      inScope: [],
      outOfScope: [],
      acceptance: ['评审通过'],
      verify: ['node --test'],
    },
    reviewed: { verdict: 'pass', artifacts: [{ path: FILE, present: true, sha256: SHA }] },
    ...over,
  };
}

/** 取出 separationOfDuties 里某个码的违规项。 */
function sodOf(result, code) {
  return result.violations.filter((v) => v.code === code);
}

test('W3-F 1：自审 → E_SELF_REVIEW，ok:false（canDeliver 与 separationOfDuties 双入口一致）', () => {
  const tasks = [implTask({ assignee: 'impl-a' }), sodReview({ assignee: 'impl-a' })];

  const direct = sodOf(separationOfDuties({ tasks }), 'E_SELF_REVIEW');
  assert.equal(direct.length, 1, '独立入口必须自己就能报出来');
  assert.equal(direct[0].severity, 'blocker');
  assert.match(direct[0].message, /impl-a/, 'message 要点名那个 assignee');
  assert.match(direct[0].message, /impl-1/);
  assert.match(direct[0].message, /review-1/);

  const result = canDeliver(baseInput({ tasks }));
  assertBlocked(result, 'E_SELF_REVIEW', '同 assignee 的自审');
  assert.ok(!codes(result).includes('E_NO_ASSIGNEE'), '都有归属时不该再报缺归属');
});

test('W3-F 2：非自审（不同 assignee）→ ok:true、无违规、无 warnings 字段', () => {
  const tasks = [implTask({ assignee: 'impl-a' }), sodReview({ assignee: 'rev-b' })];
  assert.deepEqual(separationOfDuties({ tasks }).violations, [], '不同人评审不是违规');

  const result = canDeliver(baseInput({ tasks }));
  assertShape(result);
  assert.equal(result.ok, true);
  assert.deepEqual(codes(result), []);
  assert.ok(!('warnings' in result), '有归属且无停滞时，不要凭空加 warnings 字段（保持 {ok, blockers} 兼容）');
});

test('W3-F 3：混合制 A（impl 有、review 无）→ E_NO_ASSIGNEE', () => {
  const tasks = [implTask({ assignee: 'impl-a' }), sodReview()];

  const direct = sodOf(separationOfDuties({ tasks }), 'E_NO_ASSIGNEE');
  assert.equal(direct.length, 1);
  assert.equal(direct[0].severity, 'blocker');
  assert.match(direct[0].message, /review-1/);

  assertBlocked(canDeliver(baseInput({ tasks })), 'E_NO_ASSIGNEE', 'review 缺归属');
});

test('W3-F 4：混合制 B（只给 review 填、impl 无）→ E_NO_ASSIGNEE（评审点名的攻击面）', () => {
  // 攻击者的算盘：只要"至少有一个任务带 assignee"，就想让系统认为归属信息齐全。
  // 混合制的判据是"有任意一个就必须全有"，所以这条必须被拦住。
  const tasks = [implTask(), sodReview({ assignee: 'rev-b' })];

  const direct = sodOf(separationOfDuties({ tasks }), 'E_NO_ASSIGNEE');
  assert.equal(direct.length, 1);
  assert.match(direct[0].message, /impl-1/, '缺的是 impl-1，message 要点名它');

  const result = canDeliver(baseInput({ tasks }));
  assertBlocked(result, 'E_NO_ASSIGNEE', '只有 review 有归属');
  assert.ok(!codes(result).includes('E_SELF_REVIEW'), 'impl 没有归属，判不了自审');
});

test('W3-F 5：legacy（全无 assignee）→ 判据层静默、裁决层发一条警告', () => {
  // 分层修正（S-6 / J-2 原文「canDeliver 返回一条 warning」）：
  //   separationOfDuties = 判据层，只报"违反了哪条判据"，不报"我没有判据可用" → legacy 返回 []；
  //   canDeliver        = 裁决层，负责报"这一轮我判不了" → E_INDEPENDENCE_UNENFORCED。
  const tasks = [implTask(), sodReview()];
  const direct = separationOfDuties({ tasks });

  assert.deepEqual(direct.violations, [], 'legacy 下判据层一条都不报（逃生门仍在，但痕迹在裁决层）');

  const result = canDeliver(baseInput({ tasks }));
  assert.equal(result.ok, true, '警告不阻断');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings.map((w) => w.code), ['E_INDEPENDENCE_UNENFORCED']);

  // 文案必须点明**两条**判定一起失效（JN-1）：只提自审会让运维以为还有停滞检测在兜
  const message = result.warnings[0].message;
  assert.match(message, /独立性判定未生效/);
  assert.match(message, /assignee|归属/);
  assert.match(message, /停滞|stagnation|注意力/, '必须说明停滞检测也一并失效');

  // 码表归属：warning，不是 blocker
  assert.ok(DELIVERY_WARNING_CODES.includes('E_INDEPENDENCE_UNENFORCED'));
  assert.ok(!DELIVERY_BLOCKER_CODES.includes('E_INDEPENDENCE_UNENFORCED'));
});

test('W3-F 6：空串 / 纯空白 / null 都不算"有 assignee"', () => {
  for (const blank of ['', '   ', null, undefined]) {
    // 全是空值 → 仍然算 legacy：判据层静默，但裁决层必须发"判不了"的警告
    const soloTasks = [implTask({ assignee: blank }), sodReview({ assignee: blank })];
    const solo = separationOfDuties({ tasks: soloTasks });
    assert.equal(sodOf(solo, 'E_NO_ASSIGNEE').length, 0, `assignee=${JSON.stringify(blank)} 不该被当成有归属`);
    assert.equal(sodOf(solo, 'E_SELF_REVIEW').length, 0, '两个空值不能被当成"同一个人"');
    assert.deepEqual(
      canDeliver(baseInput({ tasks: soloTasks })).warnings.map((w) => w.code),
      ['E_INDEPENDENCE_UNENFORCED'],
      `assignee=${JSON.stringify(blank)} 仍属 legacy → 裁决层要发警告`,
    );

    // 但一旦别的任务有真归属，这些空值就算"缺"
    const mixed = separationOfDuties({ tasks: [implTask({ assignee: 'impl-a' }), sodReview({ assignee: blank })] });
    assert.equal(
      sodOf(mixed, 'E_NO_ASSIGNEE').length,
      1,
      `assignee=${JSON.stringify(blank)} 在混合制下必须算缺归属`,
    );
    // 有归属信息时就不是 legacy，不该再发"判不了"的警告
    assert.ok(
      !canDeliver(
        baseInput({ tasks: [implTask({ assignee: 'impl-a' }), sodReview({ assignee: blank })] }),
      ).warnings?.some((w) => w.code === 'E_INDEPENDENCE_UNENFORCED'),
      '混合制下不是 legacy，不该发 E_INDEPENDENCE_UNENFORCED',
    );
  }
});

test('W3-F 7：reviewedTaskId 指向自己 → E_SELF_REVIEW', () => {
  const selfReview = sodReview({ id: 'review-1', assignee: 'solo' });
  selfReview.contract = { ...selfReview.contract, reviewedTaskId: 'review-1' };

  const violations = sodOf(separationOfDuties({ tasks: [selfReview] }), 'E_SELF_REVIEW');
  assert.equal(violations.length, 1, '自己审自己，归属必然相同');
  assert.match(violations[0].message, /review-1/);
});

test('W3-F 8：同一人同一路径连续 3 次 pass → 有 warning 且 ok 仍为 true', () => {
  const tasks = [
    implTask({ assignee: 'impl-a' }),
    sodReview({ id: 'review-1', assignee: 'rev-b', revision: 1 }),
    sodReview({ id: 'review-2', assignee: 'rev-b', revision: 2 }),
    sodReview({ id: 'review-3', assignee: 'rev-b', revision: 3 }),
  ];

  const direct = sodOf(separationOfDuties({ tasks }), 'E_REVIEW_STAGNATION');
  assert.equal(direct.length, 1);
  assert.equal(direct[0].severity, 'warning');
  assert.match(direct[0].message, /3 次 pass/);

  const result = canDeliver(baseInput({ tasks }));
  assert.equal(result.ok, true, 'warning 不阻断交付');
  assert.deepEqual(codes(result), [], 'warning 不得混进 blockers');
  assert.deepEqual(result.warnings.map((w) => w.code), ['E_REVIEW_STAGNATION']);
});

test('W3-F 9：连续 2 次 pass → 无停滞 warning', () => {
  const tasks = [
    implTask({ assignee: 'impl-a' }),
    sodReview({ id: 'review-1', assignee: 'rev-b', revision: 1 }),
    sodReview({ id: 'review-2', assignee: 'rev-b', revision: 2 }),
  ];

  assert.equal(sodOf(separationOfDuties({ tasks }), 'E_REVIEW_STAGNATION').length, 0);

  const result = canDeliver(baseInput({ tasks }));
  assert.equal(result.ok, true);
  assert.ok(!('warnings' in result), '没到阈值就不该有 warnings 字段');
});

test('W3-F 10：4 次 pass 中间夹 1 次 needs_revision → 不报停滞（连续计数被打断）', () => {
  const tasks = [
    implTask({ assignee: 'impl-a' }),
    sodReview({ id: 'review-1', assignee: 'rev-b', revision: 1 }),
    sodReview({ id: 'review-2', assignee: 'rev-b', revision: 2 }),
    sodReview({
      id: 'review-3',
      assignee: 'rev-b',
      revision: 3,
      status: 'completed',
      reviewed: { verdict: 'needs_revision', artifacts: [{ path: FILE, present: true, sha256: SHA }] },
    }),
    sodReview({ id: 'review-4', assignee: 'rev-b', revision: 4 }),
    sodReview({ id: 'review-5', assignee: 'rev-b', revision: 5 }),
  ];

  const violations = sodOf(separationOfDuties({ tasks }), 'E_REVIEW_STAGNATION');
  assert.equal(violations.length, 0, 'needs_revision 意味着有人看出了问题，连续计数必须归零');
});

test('W3-F 11：canDeliver 集成 —— warning 不进 blockers，warnings 只在有警告时出现', () => {
  const clean = canDeliver(
    baseInput({ tasks: [implTask({ assignee: 'impl-a' }), sodReview({ assignee: 'rev-b' })] }),
  );
  assert.equal(clean.ok, true);
  assert.ok(!('warnings' in clean), '没有警告时保持 {ok, blockers} 形状');
  assert.deepEqual(Object.keys(clean).sort(), ['blockers', 'ok']);

  const legacy = canDeliver(baseInput());
  assert.equal(legacy.ok, true);
  assert.ok(Array.isArray(legacy.warnings));
  assert.equal(legacy.warnings.length, 1);
  assert.ok(!legacy.blockers.some((b) => b.code === 'E_INDEPENDENCE_UNENFORCED'), '警告不许出现在 blockers 里');
});

test('W3-F J-1：assignee 比较大小写敏感 —— impl-a 与 IMPL-A 不是同一个人', () => {
  // ownerName 是标识符不是显示名（J-1）：宿主按名字寻址（interrupt/sendMessage），
  // 用它做身份比较必须精确。宽容大小写会同时造成"误伤"与"放过"两个方向的错。
  const tasks = [implTask({ assignee: 'impl-a' }), sodReview({ assignee: 'IMPL-A' })];

  assert.equal(sodOf(separationOfDuties({ tasks }), 'E_SELF_REVIEW').length, 0);
  const result = canDeliver(baseInput({ tasks }));
  assert.deepEqual(codes(result), [], '大小写不同的两个 assignee 不构成自审');
});

test('W3-F J-1b：trim 仍然保留 —— " impl-a " 与 "impl-a" 是同一个人', () => {
  // 精确比较是"trim 后逐字"：多一个空格不是另一个身份，否则空格就成了绕开自审的手段。
  const tasks = [implTask({ assignee: 'impl-a' }), sodReview({ assignee: ' impl-a ' })];
  const violations = sodOf(separationOfDuties({ tasks }), 'E_SELF_REVIEW');
  assert.equal(violations.length, 1, 'trim 后相同 → 判自审');
  assert.match(violations[0].message, /"impl-a"/, 'message 里的 assignee 应当是 trim 后的形态');
});

test('W3-F 12：畸形输入不抛错（tasks 非数组 / 元素非对象 / 契约与 reviewed 畸形）', () => {
  for (const input of [
    undefined,
    null,
    0,
    'x',
    { tasks: null },
    { tasks: 'nope' },
    { tasks: [null, 0, 'x', []] },
    { tasks: [{ id: 42, kind: 'review', assignee: 7, contract: [], reviewed: 'nope' }] },
  ]) {
    assert.doesNotThrow(() => separationOfDuties(input), `separationOfDuties(${JSON.stringify(input)}) 不得抛错`);
    const result = separationOfDuties(input);
    assert.ok(Array.isArray(result.violations));
    for (const violation of result.violations) {
      assert.equal(typeof violation.code, 'string');
      assert.ok(violation.severity === 'blocker' || violation.severity === 'warning');
      assert.equal(typeof violation.message, 'string');
      assert.ok(violation.message.length > 0);
    }
  }
});

test('W3-F 13：E_NO_ASSIGNEE 与 E_INDEPENDENCE_UNENFORCED 互斥（同一份输入不会两者都报）', () => {
  // 判据层只看 E_NO_ASSIGNEE；裁决层只在"完全没有归属"时发 E_INDEPENDENCE_UNENFORCED。
  const legacyTasks = [implTask(), sodReview()];
  assert.equal(sodOf(separationOfDuties({ tasks: legacyTasks }), 'E_NO_ASSIGNEE').length, 0);
  const legacy = canDeliver(baseInput({ tasks: legacyTasks }));
  assert.equal(legacy.warnings.filter((w) => w.code === 'E_INDEPENDENCE_UNENFORCED').length, 1);
  assert.ok(!codes(legacy).includes('E_NO_ASSIGNEE'));

  const hybridTasks = [implTask({ assignee: 'impl-a' }), sodReview()];
  assert.equal(sodOf(separationOfDuties({ tasks: hybridTasks }), 'E_NO_ASSIGNEE').length, 1);
  const hybrid = canDeliver(baseInput({ tasks: hybridTasks }));
  assertBlocked(hybrid, 'E_NO_ASSIGNEE', '混合制');
  assert.ok(
    !(hybrid.warnings ?? []).some((w) => w.code === 'E_INDEPENDENCE_UNENFORCED'),
    '有归属信息时不是 legacy 模式，不该发"判不了"的警告',
  );
});

test('W3-F 14（SD-2）：身份规范形折叠内部连续空白 —— "a  b" 与 "a b" 是同一个人', () => {
  // 这是真实缺陷（SD-2）：board 的 clean() 会折叠连续空格（板说同一人），
  // 而 assigneeOf 原来只 trim（门禁说两个人）→ 一个内部双空格就绕开自审检测，
  // 而 `assignee: 'a  b'` 看起来完全正常，没人会怀疑。攻击成本比清空 assignee 低得多。
  // 现在 assigneeOf 统一走 contract.normalizeIdentity（trim + 空白折叠 + 保留大小写）。
  const tasks = [implTask({ assignee: 'a  b' }), sodReview({ assignee: 'a b' })];
  const violations = sodOf(separationOfDuties({ tasks }), 'E_SELF_REVIEW');
  assert.equal(violations.length, 1, '内部双空格不能变成"另一个人"');
  assert.match(violations[0].message, /"a b"/, 'message 里是规范形');

  assertBlocked(canDeliver(baseInput({ tasks })), 'E_SELF_REVIEW', "assignee 'a  b' vs 'a b'");
  assert.ok(
    !(canDeliver(baseInput({ tasks })).warnings ?? []).some((w) => w.code === 'E_INDEPENDENCE_UNENFORCED'),
    '两边都有归属，不是 legacy',
  );
});

test('W3-F 15（SD-2）：制表/换行/全角空格同样折叠 —— "a\\tb" 与 "a b" 是同一个人', () => {
  // 空白类不止半角空格：\s 覆盖 \t \n \r \u00a0 \ufeff 与全角空格 \u3000。
  // 只要有一类没折叠，攻击者就换那一类来绕（这类"换一条轴"的绕过比清空字段便宜得多）。
  for (const variant of ['a\tb', 'a\nb', 'a\u00a0b', 'a\u3000b', '  a   b  ']) {
    const tasks = [implTask({ assignee: variant }), sodReview({ assignee: 'a b' })];
    assert.equal(
      sodOf(separationOfDuties({ tasks }), 'E_SELF_REVIEW').length,
      1,
      `assignee=${JSON.stringify(variant)} 折叠后与 'a b' 相同，必须判自审`,
    );
  }
});

test('W3-F 16（SD-2 边界）：规范化不折叠大小写 —— "A" 与 "a" 仍是两个人（J-1 不回退）', () => {
  // 空白必须折叠，但大小写**不许**折叠：宿主 id 大小写敏感，宽容会把一次合法的他人评审
  // 误判成自审（假阳）。这两条轴方向相反，必须分别钉住，否则以后有人"顺手统一一下"就回退了。
  const tasks = [implTask({ assignee: 'A' }), sodReview({ assignee: 'a' })];
  assert.equal(sodOf(separationOfDuties({ tasks }), 'E_SELF_REVIEW').length, 0, "'A' 与 'a' 不是同一个人");

  const result = canDeliver(baseInput({ tasks }));
  assert.equal(result.ok, true);
  assert.deepEqual(codes(result), []);
});

/* ------------------------------------------------------------------------- */
/* 健壮性与纯度                                                               */
/* ------------------------------------------------------------------------- */

test('纯函数：不修改入参，重复调用结果一致', () => {
  const input = baseInput({
    tasks: [implTask(), reviewTask(), implTask({ id: 'impl-2', status: 'failed', changedPaths: [] })],
  });
  const snapshot = JSON.stringify(input);

  const first = canDeliver(input);
  const second = canDeliver(input);

  assert.equal(JSON.stringify(input), snapshot, '入参不应被修改');
  assert.deepEqual(first, second, '相同输入应得到相同结果');
  assertShape(first);
});

test('健壮性：空输入不抛错，给出可读 blocker', () => {
  const result = canDeliver({});
  assertShape(result);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('E_NEEDS_HUMAN_DELIVERY'));
  assert.ok(codes(result).includes('E_NOT_RUNNING'), 'phase 缺失按"不是运行中"处理（D8）');
});

test('健壮性：脏输入（null / 标量 / 畸形字段）不抛错', () => {
  for (const input of [
    undefined,
    null,
    0,
    'x',
    { tasks: 'nope' },
    { tasks: [null, 0, 'x', [], { id: 42, kind: 7, status: {}, changedPaths: 'nope', contract: [] }] },
    {
      team: { delivered: [] },
      tasks: [{ id: 't', kind: 'review', status: 'completed', reviewed: { verdict: 'pass', artifacts: [null, 1, 'x', {}] } }],
    },
  ]) {
    const result = canDeliver(input);
    assertShape(result);
  }
});

test('健壮性：非法路径（绝对路径 / .. 穿越）不会被 normalizePath 静默丢弃', () => {
  const evil = '../../etc/passwd';
  const result = canDeliver(
    baseInput({
      tasks: [implTask({ changedPaths: [evil] })],
      currentDigests: { [evil]: 'sha-evil' },
      diffPaths: [evil],
    }),
  );
  // 关键：它必须仍然参与比对并触发 blocker，而不是因为"规范化失败"从集合里消失
  assertShape(result);
  assert.equal(result.ok, false, '穿越路径不得 fail-open');
  assert.ok(
    codes(result).includes('E_OUT_OF_SCOPE') || codes(result).includes('E_UNREPORTED_CHANGES'),
    `穿越路径必须被拒，实际 ${JSON.stringify(codes(result))}`,
  );
});

/* ------------------------------------------------------------------------- */
/* R-12：阻断的「右端点」—— 能唯一确定归属哪条任务时才带 taskId                */
/* ------------------------------------------------------------------------- */

/*
 * 关系图（根因 → 受影响任务）的右端点就是 `blocker.taskId`。这一组用例守的是同一条纪律：
 * **只说知道的事**。能唯一确定是哪条任务 → 带这个键；判不出来 → 不带这个键
 * （页面把它画成「全局」根因，这是诚实的表达）。
 *
 * 为什么"猜一个 id"必须被禁止：猜出来的端点会让图上出现一条**看起来有归属、其实没有**
 * 的线，那是把不知道说成知道 —— 比没有线更坏。
 */

/** 取指定 code 的全部 blocker。 */
function blockersByCode(result, code) {
  return result.blockers.filter((b) => b.code === code);
}

/** 这条 blocker 是否**带** taskId 键（注意：带一个空串也算带，那同样是错的）。 */
function carriesTaskId(blocker) {
  return Object.prototype.hasOwnProperty.call(blocker, 'taskId');
}

test('R-12 1：缺验收回执的阻断带 taskId，且就是那条任务的 id', () => {
  // impl-1 的契约只写了 verify、没写 acceptance → 第 2 段的 E_CONTRACT_INCOMPLETE。
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ contract: { inScope: ['plugin/src/'], outOfScope: [], verify: ['node --test'] } }),
        reviewTask(),
      ],
    }),
  );
  assertShape(result);

  const hits = blockersByCode(result, 'E_CONTRACT_INCOMPLETE');
  assert.equal(hits.length, 1, `应恰好一条缺验收的阻断，实际 ${JSON.stringify(codes(result))}`);
  assert.ok(carriesTaskId(hits[0]), `缺验收的阻断必须指出是哪条任务：${JSON.stringify(hits[0])}`);
  assert.equal(hits[0].taskId, 'impl-1');
  // 文案逐字不变（本轮只加字段，不改一个字）
  assert.match(hits[0].message, /^契约里缺少 acceptance（kind=implementation）：/);
});

test('R-12 2：团队阶段不对 → 阻断**不带** taskId（不是空串，是没有这个键）', () => {
  // 团队阶段是整个团队的状态，不针对任何一条任务。给它编一条任务 id，图上就会多一条
  // "这条根因打中了某条任务"的假边。
  const result = canDeliver(baseInput({ team: { phase: 'halted', leaderMode: 'inline' } }));
  assertShape(result);

  for (const code of ['E_NOT_RUNNING', 'E_NEEDS_HUMAN_DELIVERY']) {
    const hits = blockersByCode(result, code);
    assert.equal(hits.length, 1, `${code} 应恰好一条`);
    assert.equal(
      carriesTaskId(hits[0]),
      false,
      `${code} 不是针对某一条任务的，不许带 taskId：${JSON.stringify(hits[0])}`,
    );
    assert.equal(hits[0].taskId, undefined);
  }
});

test('R-12 3：一条任务被多个根因打中 → 多条阻断指向同一个 taskId', () => {
  // 这是关系图「多条线汇到一个任务」的数据基础：没有它，图上永远画不出汇合。
  const result = canDeliver(
    baseInput({
      // impl-1 同时踩中两条：未完成（E_TASK_INCOMPLETE）+ 契约缺 acceptance/verify
      tasks: [
        implTask({ status: 'in_progress', contract: { inScope: ['plugin/src/'], outOfScope: [] } }),
        reviewTask(),
      ],
    }),
  );
  assertShape(result);

  const toImpl1 = result.blockers.filter((b) => b.taskId === 'impl-1');
  assert.ok(toImpl1.length >= 2, `同一任务应被 ≥2 条阻断打中，实际 ${JSON.stringify(toImpl1)}`);

  const distinctCodes = new Set(toImpl1.map((b) => b.code));
  assert.ok(
    distinctCodes.size >= 2,
    `必须是**不同根因**汇到同一条任务，实际只有 ${[...distinctCodes].join('/')}`,
  );
});

test('R-12 4：两条任务各有各的根因 → 两条阻断分别指向自己的 taskId', () => {
  const result = canDeliver(
    baseInput({
      tasks: [
        implTask({ status: 'pending', changedPaths: [] }),
        implTask({ id: 'impl-2', status: 'pending', changedPaths: [] }),
        workTask(),
      ],
      currentDigests: {},
      diffPaths: [],
    }),
  );
  assertShape(result);

  const incomplete = blockersByCode(result, 'E_TASK_INCOMPLETE');
  assert.equal(incomplete.length, 2, `两条未完成任务应各报一条，实际 ${JSON.stringify(codes(result))}`);
  assert.deepEqual(
    incomplete.map((b) => b.taskId).sort(),
    ['impl-1', 'impl-2'],
    '每条阻断要指向它**自己**那条任务，不能都连到第一条',
  );
});

test('R-12 5：任务没有声明 id（模块造了占位 id）→ 不产生端点', () => {
  // normalizeTask 会给无 id 的任务造 `#0`；那个 id 在宿主任务板上并不存在，
  // 拿它当端点就是在图上画一条指向空节点的线。
  const result = canDeliver(
    baseInput({
      tasks: [{ kind: 'implementation', status: 'pending', changedPaths: [] }],
      currentDigests: {},
      diffPaths: [],
    }),
  );
  assertShape(result);
  assert.ok(codes(result).includes('E_TASK_INCOMPLETE'), '前提：这条输入确实会报阻断');

  const tagged = result.blockers.filter(carriesTaskId);
  assert.deepEqual(
    tagged,
    [],
    `占位 id（#0）不是宿主的任务，不许当端点：${JSON.stringify(tagged)}`,
  );
});

test('R-12 6：E_UNBOUND_ARTIFACT 单任务带 taskId；两条任务抢同一路径时不带', () => {
  const single = canDeliver(
    baseInput({ tasks: [implTask(), reviewTask({ reviewed: { verdict: 'pass', artifacts: [] } })] }),
  );
  const one = blockersByCode(single, 'E_UNBOUND_ARTIFACT');
  assert.equal(one.length, 1, `实际 ${JSON.stringify(codes(single))}`);
  assert.equal(one[0].taskId, 'impl-1', '只有一条任务申报该路径 → 归属明确，必须画线');

  const shared = canDeliver(
    baseInput({
      tasks: [
        implTask(),
        implTask({ id: 'impl-2' }),
        reviewTask({ reviewed: { verdict: 'pass', artifacts: [] } }),
      ],
    }),
  );
  const many = blockersByCode(shared, 'E_UNBOUND_ARTIFACT');
  assert.equal(many.length, 1);
  assert.equal(
    carriesTaskId(many[0]),
    false,
    `两条任务抢同一路径时无法唯一归属，不许猜：${JSON.stringify(many[0])}`,
  );
  assert.match(many[0].message, /impl-1/);
  assert.match(many[0].message, /impl-2/);
});

test('R-12 7：E_BINDING_STALE 指向被审任务，而不是那条已经 pass 的评审', () => {
  // 被挡住可交付性的是 impl-1（它的产物不可验证），不是 review-1（它已经 pass 了）。
  const result = canDeliver(baseInput({ currentDigests: { [FILE]: 'sha-TAMPERED' } }));
  const stale = blockersByCode(result, 'E_BINDING_STALE');
  assert.equal(stale.length, 1, `实际 ${JSON.stringify(codes(result))}`);
  assert.equal(stale[0].taskId, 'impl-1', '端点应是被审任务');
  assert.notEqual(stale[0].taskId, 'review-1', '不许连到那条已经 pass 的评审上');

  // 评审没有归属时退回评审自身：那条记录是它写的，这仍然是"知道"，不是猜。
  const ownerless = canDeliver(
    baseInput({
      currentDigests: { [FILE]: 'sha-TAMPERED' },
      tasks: [
        implTask(),
        reviewTask({
          sourceTaskId: undefined,
          contract: { inScope: [], outOfScope: [], acceptance: ['P'], verify: ['v'] },
        }),
      ],
    }),
  );
  const fallback = blockersByCode(ownerless, 'E_BINDING_STALE');
  assert.equal(fallback.length, 1, `实际 ${JSON.stringify(codes(ownerless))}`);
  assert.equal(fallback[0].taskId, 'review-1', '没有被审任务可指时，退回写这条记录的评审任务');
});

test('R-12 8：E_NO_PASSING_REVIEW 只有一条实现任务时才点名，两条以上不点名', () => {
  const one = canDeliver(
    baseInput({ tasks: [implTask(), workTask()], currentDigests: {}, diffPaths: [] }),
  );
  const single = blockersByCode(one, 'E_NO_PASSING_REVIEW');
  assert.equal(single.length, 1, `实际 ${JSON.stringify(codes(one))}`);
  assert.equal(single[0].taskId, 'impl-1', '只有一条实现缺 pass 评审 → 归属明确');

  const two = canDeliver(
    baseInput({
      tasks: [implTask(), implTask({ id: 'impl-2' }), workTask()],
      currentDigests: {},
      diffPaths: [],
    }),
  );
  const both = blockersByCode(two, 'E_NO_PASSING_REVIEW');
  assert.equal(both.length, 1);
  assert.equal(
    carriesTaskId(both[0]),
    false,
    `两条实现都缺 pass 评审时，这条说的是评审集合整体，不点名任一条：${JSON.stringify(both[0])}`,
  );
});

test('R-12 9：带 taskId 的阻断，其 taskId 必须是这次输入里真实存在的任务 id', () => {
  // 反伪造的总闸：任何一条带端点的阻断，端点都得能在输入的任务表里找到。
  const declaredIds = new Set(['impl-1', 'review-1', 'work-1']);
  const result = canDeliver(
    baseInput({
      team: { phase: 'halted', leaderMode: 'inline' },
      tasks: [
        implTask({ status: 'in_progress', contract: { inScope: ['plugin/src/'], outOfScope: [] } }),
        reviewTask({ reviewed: { verdict: 'fail', artifacts: [] } }),
        workTask({ status: 'cancelled', cancelReason: '' }),
      ],
      currentDigests: { [FILE]: 'sha-TAMPERED' },
      diffPaths: [FILE, 'plugin/src/unreported.mjs'],
    }),
  );
  assertShape(result);

  const tagged = result.blockers.filter(carriesTaskId);
  assert.ok(tagged.length >= 3, `应有若干条带端点的阻断，实际 ${JSON.stringify(codes(result))}`);
  for (const blocker of tagged) {
    assert.equal(typeof blocker.taskId, 'string', `${blocker.code} 的 taskId 必须是字符串`);
    assert.ok(blocker.taskId.trim() !== '', `${blocker.code} 的 taskId 不许是空串`);
    assert.ok(
      declaredIds.has(blocker.taskId),
      `${blocker.code} 的 taskId=${JSON.stringify(blocker.taskId)} 不在输入的任务里 —— 那是编出来的端点`,
    );
  }
});

/* =================================================================== */
/* task-21 / 第 17 轮：kind 白名单必须跟着 KINDS 走                      */
/* =================================================================== */

/**
 * 这一组守的是一条**只在真实环境里才显现**的缺陷。
 *
 * `delivery.mjs` 原来的 kind 白名单是自己抄的一份
 * `new Set(['implementation','review','work'])`，而 `contract.mjs` 的 `KINDS`
 * 在 task-21 之后是四个（多了 `proposal`）。后果不是崩溃，是**静默少判**：
 * 一条 `kind: proposal` 的任务会被 `E_INPUT_INVALID` 拒掉，提案永远无法交付。
 * 而当时 `grep KNOWN_KINDS plugin/test/` 零匹配 —— 没有任何测试覆盖它。
 *
 * 所以这里**按 KINDS 遍历**，而不是再写一份清单：以后往 KINDS 里加第五个 kind，
 * 只要判定层没跟上，这条立刻红。
 */
test('kind 白名单与 contract.mjs 的 KINDS 闭合：KINDS 里每个 kind 都不报 E_INPUT_INVALID', () => {
  assert.ok(KINDS.length >= 4, `KINDS 至少要有 4 类活（实际 ${KINDS.join(', ')}）`);
  assert.ok(KINDS.includes('proposal'), 'proposal 必须是一个合法 kind');

  for (const kind of KINDS) {
    /* 用最小任务：只验"这个 kind 认不认"，不验那个 kind 自己的判据
     * （proposal 的判据是 E_PROPOSAL_UNREVIEWED / E_QUESTIONS_UNANSWERED，另派）。 */
    const result = canDeliver({
      team: { phase: 'running' },
      tasks: [{ id: 'T1', kind, status: 'pending', changedPaths: [], contract: {} }],
    });
    assert.equal(
      codes(result).includes('E_INPUT_INVALID'),
      false,
      `kind=${kind} 被当成白名单外取值了：判定层的 kind 名单没跟上 contract.mjs 的 KINDS`
        + `（实际 blockers：${JSON.stringify(result.blockers.map((b) => b.code))}）`,
    );
  }

  /* 反例自检：真正白名单外的 kind 必须仍然被点名 —— 否则上面那个循环会被
   * "E_INPUT_INVALID 永远不报"满足。 */
  const bogus = canDeliver({
    team: { phase: 'running' },
    tasks: [{ id: 'T1', kind: 'repair', status: 'pending', changedPaths: [], contract: {} }],
  });
  assert.ok(
    codes(bogus).includes('E_INPUT_INVALID'),
    'kind=repair 仍然必须被 E_INPUT_INVALID 点名（检测不能松到什么都放过）',
  );
});

/* =================================================================== */
/* task-21：提案必须被独立评审读过（E_PROPOSAL_UNREVIEWED）              */
/* =================================================================== */

/**
 * 开会流程的价值在"多份独立方案 + 一个人收敛"。方案写完没人读，它就只是一个人自言自语，
 * **而用户会以为团队已经商量过了** —— 那比不开会更糟。
 *
 * 这与 `E_UNBOUND_ARTIFACT`（"改了文件却没人针对这些文件评审"）是同一形状：
 * 产出必须被**针对它的**评审绑定，别的任务的评审不能替它背书。
 *
 * ═══ 边界（不许假装判住了）═══════════════════════════════════════════════════
 * 这条判据只能证明"**存在一条 review 记录指向它**"，证明不了：
 *   - 那条 review 是否真的认真读了方案；
 *   - 决议的质量如何（机器判不了"这个决议是否明智"）。
 * 一个不诚实的 AI 可以写一条空评审来满足它。**这条边界要一直这么说，不许省略。**
 * ═══════════════════════════════════════════════════════════════════════════
 */
test('task-21 E_PROPOSAL_UNREVIEWED：已完成的提案必须有一条评审指向它', () => {
  const proposal = (over = {}) => ({
    id: 'proposal-1',
    kind: 'proposal',
    status: 'completed',
    changedPaths: [],
    contract: {
      objective: '给「台账页面接入动效」这件事出方案',
      openQuestions: [],
      inScope: [],
      outOfScope: [],
    },
    ...over,
  });

  /* 一条 pass 评审，reviewedTaskId 指向谁由参数决定。 */
  const reviewOf = (reviewedTaskId, over = {}) => ({
    id: 'review-1',
    kind: 'review',
    status: 'completed',
    changedPaths: [],
    contract: {
      reviewedTaskId,
      inScope: [],
      outOfScope: [],
      acceptance: ['评审通过'],
      verify: ['node --test'],
    },
    reviewed: { verdict: 'pass', artifacts: [] },
    ...over,
  });

  const run = (tasks) => canDeliver({ team: { phase: 'running' }, tasks });

  /* ── A：已完成的 proposal，**没有任何评审指向它** → 报 ─────────────────── */
  const unread = run([proposal()]);
  assert.ok(
    codes(unread).includes('E_PROPOSAL_UNREVIEWED'),
    `没人读过的方案必须被点名（实际 blockers：${JSON.stringify(codes(unread))}）`
    + ' —— 否则用户会以为团队已经商量过了',
  );
  /* 端点必须是那条 proposal：这条阻断挡住的是它，不是别人。 */
  const unreadBlocker = unread.blockers.find((b) => b.code === 'E_PROPOSAL_UNREVIEWED');
  assert.equal(unreadBlocker.taskId, 'proposal-1', '阻断必须点名那条提案（页面按它画根因）');

  /* ── B：同一条 proposal，加一条 reviewedTaskId 指向它的 pass 评审 → 不报 ── */
  const reviewed = run([proposal(), reviewOf('proposal-1')]);
  assert.equal(
    codes(reviewed).includes('E_PROPOSAL_UNREVIEWED'),
    false,
    '有评审指向它时不许再报 —— 否则"做对了也报"会让这条码失去意义',
  );

  /* 反例：评审指向的是**别的**任务 → 仍然要报。
   * 没有这条，"随便有一条 review 就算读过"会让 B 被满足而判据形同虚设。 */
  const pointedElsewhere = run([proposal(), reviewOf('impl-999')]);
  assert.ok(
    codes(pointedElsewhere).includes('E_PROPOSAL_UNREVIEWED'),
    '评审指向别的任务不能替这份提案背书（与 E_UNBOUND_ARTIFACT 同一条道理）',
  );

  /* ── C：proposal 还是 in_progress → 不报（写一半的方案不要求已被评审）──── */
  const inProgress = run([proposal({ status: 'in_progress' })]);
  assert.equal(
    codes(inProgress).includes('E_PROPOSAL_UNREVIEWED'),
    false,
    '还在写的方案不该被要求"已被评审" —— 那只会制造假的阻断',
  );
});

/* =================================================================== */
/* task-21：待确认项必须被**逐条**答复（E_QUESTIONS_UNANSWERED）         */
/* =================================================================== */

/**
 * 方案里写了"要问用户"，结果没问就开工 —— **这是把用户的决定权偷偷拿走**。
 * 这是本项目最不能容忍的一类错，所以这条判据宁可严，不许退化成"数数"。
 *
 * ═══ 边界（不许假装判住了）═══════════════════════════════════════════════════
 * **机器判不了"AI 是不是真的问过用户"。**
 * 它只能判：**方案里列了哪些待确认项、决议里有没有逐条对应上**。
 * 一个不诚实的 AI 可以自己编答案来满足这条判据。
 * 所以错误消息一律说「决议里没有对应的答复」，**绝不写「用户未确认」** ——
 * 后者暗示我们核查过用户，而那是假的。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 提案 + 一条指向它的评审（`answered` 由参数给）。 */
function proposalWithAnswers(openQuestions, answered, over = {}) {
  return {
    team: { phase: 'running' },
    tasks: [
      {
        id: 'proposal-1',
        kind: 'proposal',
        status: 'completed',
        changedPaths: [],
        contract: { objective: '给台账动效出方案', openQuestions, inScope: [], outOfScope: [] },
      },
      {
        id: 'review-1',
        kind: 'review',
        status: 'completed',
        changedPaths: [],
        contract: {
          reviewedTaskId: 'proposal-1',
          answered,
          inScope: [],
          outOfScope: [],
          acceptance: ['评审通过'],
          verify: ['node --test'],
        },
        reviewed: { verdict: 'pass', artifacts: [] },
      },
    ],
    ...over,
  };
}

const Q1 = '动效是必须的，还是"有更好、没有也能接受"？';
const Q2 = '卡片入场和连线流动，两个都要还是先做一个？';

test('task-21 ★ 防「数条数」：2 个问题、2 条答复但有一条答的是别的问题 → 必须报', () => {
  /* 这条是这一整步的**全部价值**。
   * 如果判据退化成 `answered.length >= openQuestions.length`，这条输入（2 vs 2）会被放过，
   * 而那正是"配错了看起来像答全了"——用户的问题被别人的答案顶掉，没人发现。 */
  const result = canDeliver(proposalWithAnswers(
    [Q1, Q2],
    [
      `${Q1} → 用户答复：必须有`,
      '要不要顺便加个深色模式？ → 用户答复：不要', // ← 答的是**别的问题**
    ],
  ));

  assert.ok(
    codes(result).includes('E_QUESTIONS_UNANSWERED'),
    `第 2 条答复答的是别的问题，必须报（实际 blockers：${JSON.stringify(codes(result))}）`
      + ' —— 放过它就说明这条判据在数条数，而不是在逐条比对',
  );

  /* 消息必须点名**是哪一条**没答上（说"有未答项"没用），且不许暗示我们问过用户。 */
  const blocker = result.blockers.find((b) => b.code === 'E_QUESTIONS_UNANSWERED');
  assert.match(blocker.message, /卡片入场和连线流动/, '必须点出没答上的那条问题的原文');
  assert.doesNotMatch(blocker.message, /用户未确认|用户已确认|已核实用户/, '不许暗示我们核查过用户（那是假的）');
  assert.match(blocker.message, /决议里没有对应的答复/, '要用「决议里没有对应的答复」这种说法');
});

test('task-21 E_QUESTIONS_UNANSWERED：逐条对上、想过没问题、没想过、未完成 → 都不报', () => {
  const run = (input) => canDeliver(input);
  const hasCode = (result, code) => codes(result).includes(code);

  /* ── 1：2 个问题、2 条正确答复 → 不报 ─────────────────────────────────── */
  const allAnswered = run(proposalWithAnswers(
    [Q1, Q2],
    [`${Q1} → 用户答复：必须有`, `${Q2} → 用户答复：先做卡片入场`],
  ));
  assert.equal(
    hasCode(allAnswered, 'E_QUESTIONS_UNANSWERED'),
    false,
    '全部答上时不许报 —— 否则"做对了也报"会让这条码失去意义',
  );

  /* ── 2：2 个问题、只答 1 条 → 报 ───────────────────────────────────────── */
  const partial = run(proposalWithAnswers([Q1, Q2], [`${Q1} → 用户答复：必须有`]));
  assert.ok(
    hasCode(partial, 'E_QUESTIONS_UNANSWERED'),
    `只答了 1 条必须报（实际 blockers：${JSON.stringify(codes(partial))}）`,
  );
  const partialBlocker = partial.blockers.find((b) => b.code === 'E_QUESTIONS_UNANSWERED');
  assert.match(partialBlocker.message, /卡片入场和连线流动/, '消息必须点名漏掉的那条问题');
  assert.doesNotMatch(partialBlocker.message, /动效是必须的/, '已答上的那条不该被算成未答');

  /* ── 4：`openQuestions: []`（想过、没有需要拍板的问题）→ 不报 ────────────── */
  const nothingToAsk = run(proposalWithAnswers([], []));
  assert.equal(
    hasCode(nothingToAsk, 'E_QUESTIONS_UNANSWERED'),
    false,
    '"我想过了、没有需要用户拍板的问题"不许被当成"没答"',
  );

  /* ── 5：根本没有 `openQuestions` 字段（没想过）→ 也不报 ────────────────────
   * 这是**解析层/契约完整性**的事，不是这条判据的事。
   * 在这里顺手加一条"没想过也报"会误伤那些本来就不需要问用户的活。 */
  const noField = canDeliver({
    team: { phase: 'running' },
    tasks: [
      {
        id: 'proposal-1',
        kind: 'proposal',
        status: 'completed',
        changedPaths: [],
        contract: { objective: '一个不需要问用户的方案', inScope: [], outOfScope: [] },
      },
      {
        id: 'review-1',
        kind: 'review',
        status: 'completed',
        changedPaths: [],
        contract: { reviewedTaskId: 'proposal-1', inScope: [], outOfScope: [], acceptance: ['通过'], verify: ['node --test'] },
        reviewed: { verdict: 'pass', artifacts: [] },
      },
    ],
  });
  assert.equal(
    hasCode(noField, 'E_QUESTIONS_UNANSWERED'),
    false,
    '没有 openQuestions 字段 = 没想过，这条判据不管它（别顺手加，会误伤）',
  );

  /* ── 6：方案还没完成（in_progress）→ 不报 ──────────────────────────────── */
  const draft = proposalWithAnswers([Q1], []);
  draft.tasks[0].status = 'in_progress';
  assert.equal(
    hasCode(canDeliver(draft), 'E_QUESTIONS_UNANSWERED'),
    false,
    '还在写的方案不该被要求"已答全" —— 那只会制造假的阻断',
  );

  /* ── 附加：答复前缀匹配确实是**前缀**，不是全文相等 ───────────────────────
   * 答复形态是 `<问题原文> → <用户答复>`，所以问题原文只是开头。
   * 若判据写成全文相等，这条正确的输入会被误报。 */
  const prefixOnly = run(proposalWithAnswers(
    ['要不要动效'],
    ['要不要动效 → 用户答复：必须有'],
  ));
  assert.equal(
    hasCode(prefixOnly, 'E_QUESTIONS_UNANSWERED'),
    false,
    '答复以问题原文开头就算答上（不许要求全文相等，否则正常答复会被误报）',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.1 批二：卡片说的那件事，磁盘上到底有没有
 *
 * 上面所有门禁（二十多条）判的都是**卡的形状**：字段缺不缺、类型对不对、
 * 归属是否自洽。没有一条回答"卡上写的东西在现实里存在吗"。
 * 自举跑 standard@1 时真实撞上过：build / verify / signoff 三份报告互相印证
 * 一份从没发生过的交付，单看任何一份都挑不出毛病 —— 形状门禁全绿。
 *
 * 这一批补两条，各管一个方向：
 *   E_BASIS_FABRICATED    —— 卡上**引用的**东西不存在（来源任务 / 来源评审 / 被审任务）
 *   E_ARTIFACT_UNVERIFIED —— 卡上**声称存在的**东西拿不到（申报的产物无指纹）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('v1.1 E_BASIS_FABRICATED：sourceTaskId 指向不存在的任务 → 阻断', () => {
  /* 形状完全合法：字段在、是非空字符串、类型对。只有它指向的那个 id 不存在。
   * 改门禁之前这条输入是**全绿**的 —— 因为 sourceTaskId 只被收进一个 Set
   * 用来判断"失败任务有没有后续"，从来没被要求存在。 */
  const input = baseInput({
    tasks: [implTask({ sourceTaskId: 'task-99' }), reviewTask()],
  });
  const result = canDeliver(input);
  assertBlocked(result, 'E_BASIS_FABRICATED', 'sourceTaskId 指向不存在的任务必须被点名');
  assert.match(
    result.blockers.find((b) => b.code === 'E_BASIS_FABRICATED').message,
    /task-99/,
    '文案必须写出那个落空的 id —— 只写"依据有问题"等于让用户自己去找',
  );
});

test('v1.1 E_BASIS_FABRICATED：reviewedTaskId 指向不存在的任务 → 阻断（不能只管 proposalId）', () => {
  /* 这一条是"为什么不合进 E_PROPOSAL_UNKNOWN"的证据：
   * proposalId 那条只管开会流程，reviewedTaskId 管评审归属，两者是不同的账。 */
  const input = baseInput({
    tasks: [implTask(), reviewTask({ contract: { ...reviewTask().contract, reviewedTaskId: 'ghost-7' }, sourceTaskId: undefined })],
  });
  const result = canDeliver(input);
  assertBlocked(result, 'E_BASIS_FABRICATED', 'reviewedTaskId 指向不存在的任务必须被点名');
  assert.equal(
    codes(result).includes('E_PROPOSAL_UNKNOWN'),
    false,
    'proposalId 那条不能替 reviewedTaskId 说话（它根本没读这个字段）',
  );
});

test('v1.1 E_BASIS_FABRICATED：依据都对得上 → 不出现（不误报理想输入）', () => {
  const result = canDeliver(baseInput());
  assert.equal(
    codes(result).includes('E_BASIS_FABRICATED'),
    false,
    'baseInput 里 sourceTaskId / reviewedTaskId 都指向真实存在的 impl-1，不该报',
  );
});

test('v1.1 E_BASIS_FABRICATED：依据字段是空串 / 非字符串 → 不算"编造"（那是形态问题）', () => {
  /* 边界：本条只判"指向的 id 在不在表里"。
   * 空串与非字符串根本没指向任何东西，属于形态问题，不在这里报 ——
   * 混进来会让"依据造假"这个码的含义变糊。 */
  const input = baseInput({
    tasks: [
      implTask({ sourceTaskId: '' }),
      reviewTask({ contract: { ...reviewTask().contract, reviewedTaskId: '' }, sourceTaskId: '' }),
    ],
  });
  assert.equal(
    codes(canDeliver(input)).includes('E_BASIS_FABRICATED'),
    false,
    '空串不是"伪造的依据"，是有问题的字段形态 —— 不要在这里顺手合并',
  );
});

test('v1.1 E_ARTIFACT_UNVERIFIED：申报的路径在 currentDigests 里没有 → 阻断', () => {
  /* 关键点：**没有任何评审记过这条路径**。
   * 所以 E_BINDING_STALE 不会响（它要求评审先记过），
   * E_UNBOUND_ARTIFACT 会响（说的是"没人审"）——
   * 但真正该先说的是"这个文件根本拿不到指纹"。
   * 用户照着"没人审"去补评审，文件不在，补多少条都绑不上。 */
  const input = baseInput({
    tasks: [
      implTask({ changedPaths: [FILE, 'plugin/src/ghost.mjs'] }),
      reviewTask(),
    ],
    currentDigests: { [FILE]: SHA },
    diffPaths: [FILE, 'plugin/src/ghost.mjs'],
  });
  const result = canDeliver(input);
  assertBlocked(result, 'E_ARTIFACT_UNVERIFIED', '申报了却拿不到指纹的路径必须被单独点名');
  const blocker = result.blockers.find((b) => b.code === 'E_ARTIFACT_UNVERIFIED');
  assert.match(blocker.message, /ghost\.mjs/, '文案必须写出具体哪个产物');
});

test('v1.1 E_ARTIFACT_UNVERIFIED：空 ≠ 不可用 —— 没提供 currentDigests 时本码沉默', () => {
  /* 红线：`undefined`（调用方没接线）与 `{}`（接线了、磁盘上什么都没有）
   * 必须走两条路。把两者都当"没事"就是报平安；
   * 把两者都当"全都不存在"就是制造一堆假阻断。 */
  const silent = canDeliver(baseInput({
    tasks: [implTask({ changedPaths: [FILE, 'plugin/src/ghost.mjs'] }), reviewTask()],
    currentDigests: undefined,
  }));
  assert.equal(
    codes(silent).includes('E_ARTIFACT_UNVERIFIED'),
    false,
    'currentDigests 没提供 = 没查，本码必须沉默（"没查"由 E_AUDIT_UNWIRED 出声）',
  );

  const wiredEmpty = canDeliver(baseInput({
    /* 用 FILE2 而不是 FILE：评审的 artifacts 记了 FILE，currentDigests 为空时
     * 那一条会先撞 E_BINDING_STALE 并被我自己的抑制规则挡掉 ——
     * 拿它来测本条就测不到了。FILE2 没有任何评审记过，是本条的干净入口。 */
    tasks: [implTask({ changedPaths: [FILE2] }), reviewTask()],
    currentDigests: {},
  }));
  assert.ok(
    codes(wiredEmpty).includes('E_ARTIFACT_UNVERIFIED'),
    'currentDigests 提供了但是空的 = 接线了、磁盘上确实什么都没有，申报就全是空的，必须报',
  );
});

test('v1.1 E_ARTIFACT_UNVERIFIED：已被 E_BINDING_STALE 点过的路径不重复报（不稀释信号）', () => {
  /* D10 同一条口径：同一个事实说两遍会把"篡改"这个刺眼信号稀释掉。
   * 这里的夹具让评审记过 FILE 且指纹吻合、但记过 FILE2 而 FILE2 已缺失 ——
   * 那正是 E_BINDING_STALE 的地盘，本条必须让开。 */
  const input = baseInput({
    tasks: [
      implTask({ changedPaths: [FILE, FILE2] }),
      reviewTask({
        reviewed: {
          verdict: 'pass',
          artifacts: [
            { path: FILE, present: true, sha256: SHA },
            { path: FILE2, present: true, sha256: SHA2 },
          ],
        },
      }),
    ],
    currentDigests: { [FILE]: SHA },
    diffPaths: [FILE, FILE2],
  });
  const result = canDeliver(input);
  assertBlocked(result, 'E_BINDING_STALE', '前置：这条夹具本来就要撞出 STALE');
  assert.equal(
    codes(result).includes('E_ARTIFACT_UNVERIFIED'),
    false,
    'STALE 已经说了"现在已缺失"，本条不许再说一遍',
  );
});

test('v1.1 E_ARTIFACT_UNVERIFIED：文案不许把"读不出来"写成"不存在"', () => {
  /* currentDigests 这一层只有"有没有拿到指纹"，分不清
   * 「文件不在」和「文件在但读不了（权限 / 编码 / 二进制）」。
   * 所以文案必须留出这个不确定性 —— 这是"不报平安"的对偶：
   * 也不许把一个没查清的事实说成确定的。 */
  const blocker = canDeliver(baseInput({
    tasks: [implTask({ changedPaths: [FILE, 'plugin/src/ghost.mjs'] }), reviewTask()],
    currentDigests: { [FILE]: SHA },
    diffPaths: [FILE, 'plugin/src/ghost.mjs'],
  })).blockers.find((b) => b.code === 'E_ARTIFACT_UNVERIFIED');

  assert.match(blocker.message, /读不出来/, '文案必须点明"读不出来"这个可能性');
  assert.equal(
    /不存在/.test(blocker.message),
    false,
    '不许把不确定的事实说成"不存在"——那是在替磁盘下结论',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P3-11：`E_BLIND_LEAK` 的检测器（此前全项目零发射点）
 *
 * 这一组钉的不是"函数能跑"，而是"两条判据各自能区分哪两个结果"，
 * 以及**非盲阶段不检测**——最后那条不做，就会有人做出一个全局扫描器，
 * 然后在完全正确的时候满屏报错。
 * ═══════════════════════════════════════════════════════════════════════════ */

const BLIND_STAGE = Object.freeze({ id: 'verify', blind: true });
const OPEN_STAGE = Object.freeze({ id: 'design', blind: false });

test('B-1. 盲阶段消息里出现被扣住的产物 id → 报错并**点名是哪个 id**', () => {
  const result = detectBlindLeak({
    stage: BLIND_STAGE,
    message: '已有的产物（阶段 design）：decisions、design.reasoning',
    forbiddenIds: ['design.reasoning'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'E_BLIND_LEAK');
  /* 文案必须点名 —— 只说"发生泄漏"的话，人还得自己去找是哪一个。 */
  assert.match(result.errors[0].message, /design\.reasoning/);
  assert.deepEqual(result.warnings, [], '不许留空通道');
});

test('B-2. 两个 id 都漏 → 两条错（各点各的名，不合并成一条）', () => {
  const result = detectBlindLeak({
    stage: BLIND_STAGE,
    message: 'a.design b.design 都在这',
    forbiddenIds: ['a.design', 'b.design', 'c.design'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2, '合成一条会让人以为只漏了一个');
  assert.match(result.errors[0].message, /a\.design/);
  assert.match(result.errors[1].message, /b\.design/);
});

test('B-3. 盲阶段消息里出现作者推理的分节标记 → 报错，并点名是哪一段标记', () => {
  const result = detectBlindLeak({
    stage: BLIND_STAGE,
    message: '阶段 verify\n必产字段：verdict\n理由：我选了 lerp，因为它更稳',
    forbiddenIds: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'E_BLIND_LEAK');
  assert.match(result.errors[0].message, /理由：/);
});

test('B-4. 干净消息 → ok:true 且 errors 为空（判据不许在正确的时候红）', () => {
  const result = detectBlindLeak({
    stage: BLIND_STAGE,
    message: '阶段 verify（角色 qa）—— 盲阶段\n必产字段：verdict、findings\n已有的产物（阶段 design）：decisions',
    forbiddenIds: ['design.reasoning', 'redteam.killScenarios'],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('B-5. **非盲阶段不检测**：消息里带着禁止 id 也必须 ok（它本来就该看见）', () => {
  /* 这条是防"把检测器做成全局扫描器"的钉子。
   * 非盲阶段看见上一阶段的产物是**设计意图**，不是泄漏。 */
  const result = detectBlindLeak({
    stage: OPEN_STAGE,
    message: '已有的产物（阶段 design）：design.reasoning\n理由：我选了 lerp',
    forbiddenIds: ['design.reasoning'],
  });

  assert.equal(result.ok, true, '非盲阶段本来就该看见 —— 这里报错就是误报');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [], '非盲分支也不许留空通道');
});

test('B-6. `forbiddenIds` 为空 → ok 且**不产生 warnings**（空通道禁令）', () => {
  const result = detectBlindLeak({ stage: BLIND_STAGE, message: '干净消息', forbiddenIds: [] });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [], '没有任何东西可泄漏时，"检查通过"不该变成一句警告');
});

test('B-7. 判据不是"消息长度"：长消息干净必须过，短消息带标记必须红', () => {
  /* 间接信号（长度 / 关键词密度）会在正确的时候红。这一条把那条路堵死。 */
  const longClean = detectBlindLeak({
    stage: BLIND_STAGE,
    message: '阶段 verify\n' + '必产字段：verdict\n'.repeat(200),
    forbiddenIds: ['design.reasoning'],
  });
  assert.equal(longClean.ok, true, '长 ≠ 泄漏');

  const shortDirty = detectBlindLeak({ stage: BLIND_STAGE, message: '推理：x', forbiddenIds: [] });
  assert.equal(shortDirty.ok, false, '短 ≠ 干净');
});

test('B-8. 标记表可由调用方覆盖（默认口径不是唯一口径）', () => {
  const result = detectBlindLeak({
    stage: BLIND_STAGE,
    message: 'WHY: 我选了 lerp',
    forbiddenIds: [],
    authorReasoningMarkers: ['WHY:'],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /WHY:/);
});
