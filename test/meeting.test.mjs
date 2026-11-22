/* ===========================================================================
 * task-22：开会是必须的 —— 专用行为测试
 * ===========================================================================
 *
 * 为什么单独一个文件：`delivery.test.mjs` / `adversarial.test.mjs` 里那层垫片
 * （给旧夹具补 `skipMeeting`）会掩盖这条门禁的真实行为，而这条门禁的判据有七种出口。
 * 这里一律走 `canDeliverRaw`，不经垫片。
 *
 * 门禁要说清的那件事（用户原话：「嗯，开会是必须的。」）：
 *   15a / 15b 都以"提案存在"为前提 —— 于是不写提案的人可以从它们下面整个穿过去。
 *   这一条补的正是那个洞：**实现类任务必须指认它的方案来自哪次商量**。
 *
 * 同时钉住它的**边界**，因为它很容易被当成比实际更强的保证：
 *   `proposalId` 只证明"指了"，不证明"指得对"，更不证明"真的问过用户"。
 *   最后一条用例就是把这个局限固化成断言 —— 否则半年后有人会拿它当合规证明用。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canDeliver,
  DELIVERY_BLOCKER_CODES,
  DELIVERY_WARNING_CODES,
} from '../src/delivery.mjs';

/* ------------------------------------------------------------------------- */
/* 夹具                                                                       */
/* ------------------------------------------------------------------------- */

const FILE = 'plugin/src/delivery.mjs';
const SHA = 'sha-1111111111111111111111111111111111111111111111111111111111111111';

const DELIVERED = {
  by: 'host:actionCard',
  call_id: 'call-1',
  at: '2026-11-16T15:00:00+08:00',
  evidence_digest: 'sha-evidence-1',
};

/**
 * 实现任务。默认**不带** `proposalId` —— 每个用例自己表态，谁都别想白拿通过。
 * 带 assignee 且与评审不同人，避免 E_INDEPENDENCE_UNENFORCED 混进断言。
 */
function impl(contractExtra = {}, over = {}) {
  return {
    id: 'impl-1',
    kind: 'implementation',
    status: 'completed',
    assignee: 'worker-a',
    changedPaths: [FILE],
    contract: {
      inScope: ['plugin/src/'],
      outOfScope: ['plugin/secrets/'],
      acceptance: ['canDeliver 返回 ok / blockers'],
      verify: ['node --test plugin/test/meeting.test.mjs'],
      ...contractExtra,
    },
    ...over,
  };
}

/** 评审：completed + pass，产物绑到当前指纹，指向 impl-1。 */
function review(over = {}) {
  return {
    id: 'review-1',
    kind: 'review',
    status: 'completed',
    assignee: 'reviewer-b',
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

/** 提案。`status` 默认 completed —— 用例要测"还没开完"就自己改成 in_progress。 */
function proposal(over = {}) {
  return {
    id: 'proposal-1',
    kind: 'proposal',
    status: 'completed',
    assignee: 'worker-a',
    changedPaths: [],
    contract: {
      inScope: [],
      outOfScope: [],
      // 空列表 = "想过、没问题"（与"没想过"是两件事，见 18-4）。
      // 这里刻意不留真实问题：15b（E_QUESTIONS_UNANSWERED）的答复匹配规则不是本文件要测的东西，
      // 掺进来只会让每条断言都多一条与会议门禁无关的 blocker。
      openQuestions: [],
      answered: [],
    },
    ...over,
  };
}

/**
 * 指向提案的评审。存在的理由：15a（E_PROPOSAL_UNREVIEWED）要求"已完成的提案必须有人读过"，
 * 没有它，每条用例都会混进一条和本文件无关的 blocker，把断言搅浑。
 * 它不是在替本门禁打掩护 —— 本门禁根本不看提案有没有被审（那是 15a 的活）。
 */
function proposalReview(over = {}) {
  return {
    id: 'preview-1',
    kind: 'review',
    status: 'completed',
    assignee: 'reviewer-b',
    changedPaths: [],
    sourceTaskId: 'proposal-1',
    contract: {
      reviewedTaskId: 'proposal-1',
      inScope: [],
      outOfScope: [],
      acceptance: ['提案的取舍有据'],
      verify: ['人工复核'],
    },
    reviewed: { verdict: 'pass', artifacts: [] },
    ...over,
  };
}

function input(over = {}) {
  return {
    team: {
      phase: 'running',
      leaderMode: 'spawned',
      delivered: { ...DELIVERED },
      base: { gitHead: 'abc1234' },
    },
    tasks: [impl({ proposalId: 'proposal-1' }), proposal(), proposalReview(), review()],
    currentDigests: { [FILE]: SHA },
    diffPaths: [FILE],
    ...over,
  };
}

function codes(result) {
  return result.blockers.map((b) => b.code);
}

function warnCodes(result) {
  return (result.warnings ?? []).map((w) => w.code);
}

/* ------------------------------------------------------------------------- */
/* 七种出口                                                                   */
/* ------------------------------------------------------------------------- */

test('M-1 什么提案都没指 → E_MEETING_MISSING，交付不通过', () => {
  const result = canDeliver(input({ tasks: [impl(), review()] }));

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_MEETING_MISSING']);
  assert.match(result.blockers[0].message, /开会这一步被跳过了/);
  assert.equal(result.blockers[0].taskId, 'impl-1', '必须打在实现任务上，不是别的任务');
});

test('M-1 错误信息必须给出三条出路：写 proposalId、或 skip + 理由', () => {
  const message = canDeliver(input({ tasks: [impl(), review()] })).blockers[0].message;

  assert.match(message, /proposalId: task-NN/);
  assert.match(message, /proposalId: skip/);
  assert.match(message, /skipMeeting/);
});

test('M-2 proposalId: skip 但没写理由 → E_MEETING_SKIP_UNEXPLAINED（例外也要留痕）', () => {
  const result = canDeliver(input({ tasks: [impl({ proposalId: 'skip' }), review()] }));

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_MEETING_SKIP_UNEXPLAINED']);
  // 这条必须是 blocker 而不是 warning：没有理由的例外汇总起来就等于没有这条门禁。
  assert.ok(DELIVERY_BLOCKER_CODES.includes('E_MEETING_SKIP_UNEXPLAINED'));
  assert.ok(!DELIVERY_WARNING_CODES.includes('E_MEETING_SKIP_UNEXPLAINED'));
});

test('M-3 proposalId: skip + 有理由 → 放行，但留一条 E_MEETING_SKIPPED 警告', () => {
  const result = canDeliver(input({
    tasks: [impl({ proposalId: 'skip', skipMeeting: '这是 1 行文案修正，不需要商量' }), review()],
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(warnCodes(result), ['E_MEETING_SKIPPED']);
  assert.match(result.warnings[0].message, /1 行文案修正/);
  // 例外是允许的，所以它不许进 blocker 表；但它不许隐形，所以必须在 warning 表里。
  assert.ok(DELIVERY_WARNING_CODES.includes('E_MEETING_SKIPPED'));
  assert.ok(!DELIVERY_BLOCKER_CODES.includes('E_MEETING_SKIPPED'));
});

test('M-3 历史写法兼容：只写 skipMeeting 不写 proposalId → 同样按例外处理', () => {
  // 门禁上线之前，契约里只可能有一句理由。把它当"没表态"再拦一次等于让人写两遍同一句话。
  const result = canDeliver(input({
    tasks: [impl({ skipMeeting: '沿用旧写法的理由' }), review()],
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(warnCodes(result), ['E_MEETING_SKIPPED']);
});

test('M-4 指针落空 → E_PROPOSAL_UNKNOWN（写错的 id 不许被当成"开过会"）', () => {
  const result = canDeliver(input({ tasks: [impl({ proposalId: 'proposal-404' }), proposal(), proposalReview(), review()] }));

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['E_PROPOSAL_UNKNOWN']);
  assert.match(result.blockers[0].message, /proposal-404/);
});

test('M-5 指向的不是提案 → E_PROPOSAL_KIND（自己给自己批方案不算开会）', () => {
  const selfReview = review({ id: 'review-9', reviewedTaskId: 'impl-1' });
  const result = canDeliver(input({
    tasks: [impl({ proposalId: 'review-9' }), selfReview],
  }));

  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('E_PROPOSAL_KIND'), `实际：${JSON.stringify(codes(result))}`);
  assert.match(
    result.blockers.find((b) => b.code === 'E_PROPOSAL_KIND').message,
    /review/,
  );
});

test('M-6 提案还没开完 → E_PROPOSAL_NOT_READY（会没开完就开工）', () => {
  const result = canDeliver(input({
    tasks: [
      impl({ proposalId: 'proposal-1' }),
      proposal({ status: 'in_progress' }),
      review(),
    ],
  }));

  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('E_PROPOSAL_NOT_READY'), `实际：${JSON.stringify(codes(result))}`);
});

test('M-7 指向一份已完成的提案 → 通过，且会议码一个都不出现', () => {
  const result = canDeliver(input());

  assert.equal(result.ok, true, `blockers: ${JSON.stringify(codes(result))}`);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(warnCodes(result).filter((c) => c.startsWith('E_MEETING')), []);
  assert.deepEqual(warnCodes(result).filter((c) => c.startsWith('E_PROPOSAL')), []);
});

/* ------------------------------------------------------------------------- */
/* 适用范围与边界                                                             */
/* ------------------------------------------------------------------------- */

test('M-8 只管实现类：work / review / proposal 不要求与会', () => {
  const work = {
    id: 'work-1',
    kind: 'work',
    status: 'completed',
    assignee: 'worker-a',
    changedPaths: [],
    contract: { inScope: [], outOfScope: [] },
  };
  const result = canDeliver(input({ tasks: [impl({ proposalId: 'proposal-1' }), proposal(), proposalReview(), work, review()] }));

  assert.equal(result.ok, true, `blockers: ${JSON.stringify(codes(result))}`);
  assert.ok(!codes(result).includes('E_MEETING_MISSING'));
});

test('M-9 没写契约块 → 本条沉默（账归 E_CONTRACT_INCOMPLETE，不许一件事说两遍）', () => {
  // 连 contract 都没有：15c 不许再补一条"没开会"，那会让人以为有两个独立问题。
  const noContract = {
    id: 'impl-1',
    kind: 'implementation',
    status: 'completed',
    assignee: 'worker-a',
    changedPaths: [FILE],
  };
  const result = canDeliver(input({ tasks: [noContract, review()] }));

  assert.equal(result.ok, false, '该拦的还是要拦');
  assert.ok(!codes(result).includes('E_MEETING_MISSING'), '会议门禁对"没写契约"保持沉默');
  assert.ok(codes(result).length > 0, '沉默不等于放行：别的门禁必须已经扣住它');

  // 空对象同理（D7：`contract: {}` 视为没写契约 → 回退顶层）。
  const emptyContract = { ...noContract, contract: {} };
  const emptyResult = canDeliver(input({ tasks: [emptyContract, review()] }));
  assert.ok(!codes(emptyResult).includes('E_MEETING_MISSING'));
  assert.equal(emptyResult.ok, false);
});

test('M-10 边界固化：指针只证明"指了"，不证明"指得对"', () => {
  /* 一份内容全空的提案（没问题、没方案）照样能解开这条门禁。
   * 这不是漏洞，是这条门禁的**已知极限**，写进断言免得有人拿它当合规证明：
   *   - "提案里到底商量了什么" → 15a（E_PROPOSAL_UNREVIEWED）管审阅；
   *   - "问了用户什么、答了没有" → 15b（E_QUESTIONS_UNANSWERED）管逐条答复；
   *   - "AI 是否真的把问题问出口了" → **机器判不了**，只有人能判。
   */
  const hollow = proposal({
    id: 'proposal-1',
    contract: { inScope: [], outOfScope: [], openQuestions: [], answered: [] },
  });
  const result = canDeliver(input({ tasks: [impl({ proposalId: 'proposal-1' }), hollow, proposalReview(), review()] }));

  assert.equal(codes(result).filter((c) => c.startsWith('E_MEETING')).length, 0, '本门禁不该拦它');
  assert.equal(codes(result).filter((c) => c.startsWith('E_PROPOSAL_')).length, 0);
});

test('M-11 一个任务同时犯两件事时两个码都在（不短路）', () => {
  // 指向不存在的提案 + 提案未完成，分属两条任务，各自该报。
  const result = canDeliver(input({
    tasks: [
      impl({ proposalId: 'nope' }, { id: 'impl-1' }),
      impl({ proposalId: 'proposal-2' }, { id: 'impl-2', changedPaths: [FILE] }),
      proposal({ id: 'proposal-2', status: 'pending' }),
      review(),
    ],
  }));

  const meeting = codes(result).filter((c) => c === 'E_PROPOSAL_UNKNOWN' || c === 'E_PROPOSAL_NOT_READY');
  assert.deepEqual(meeting.sort(), ['E_PROPOSAL_NOT_READY', 'E_PROPOSAL_UNKNOWN']);
});

test('M-12 码表登记：五个 blocker + 一个 warning，一个不多一个不少', () => {
  for (const code of [
    'E_MEETING_MISSING',
    'E_MEETING_SKIP_UNEXPLAINED',
    'E_PROPOSAL_UNKNOWN',
    'E_PROPOSAL_KIND',
    'E_PROPOSAL_NOT_READY',
  ]) {
    assert.ok(DELIVERY_BLOCKER_CODES.includes(code), `${code} 必须登记在 DELIVERY_BLOCKER_CODES`);
  }
  assert.ok(DELIVERY_WARNING_CODES.includes('E_MEETING_SKIPPED'));

  // 前缀纪律：E_PROPOSAL_* 属"指向与审阅问题"，E_MEETING_* 属"该不该开会"，不许互相顶替。
  const meeting = DELIVERY_BLOCKER_CODES.filter((c) => c.startsWith('E_MEETING'));
  const proposal = DELIVERY_BLOCKER_CODES.filter((c) => c.startsWith('E_PROPOSAL'));
  assert.deepEqual(meeting, ['E_MEETING_MISSING', 'E_MEETING_SKIP_UNEXPLAINED']);
  assert.deepEqual(proposal, [
    // 15a 原来那条"提案必须被审过"没被这几条取代 —— 两条门禁各管一件事：
    // 一条管"会开过没有"，一条管"会开完有没有人读"。
    'E_PROPOSAL_UNREVIEWED',
    'E_PROPOSAL_UNKNOWN',
    'E_PROPOSAL_KIND',
    'E_PROPOSAL_NOT_READY',
  ]);
});