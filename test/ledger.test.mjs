/**
 * ledger.test.mjs — 会议账本落在任务树里的投影层（`src/ledger.mjs`）+ 行语法抽取。
 *
 * 每一组都对着一种**已经真实发生过**的病：
 *
 *   1  行语法被抄成第二套 → 漂移时没人报警（`KINDS` / `QUALITY_KINDS` 都被抄过）
 *   2  账本读不出来被当成"还没开始" —— 本项目点过名的硬红线
 *   3  没闭合的块被后面那个块的闭合"救"了 → 两块内容混成一份假账本
 *   4  账本层把解析诊断静默丢掉 → "产物清单少了一条却看起来一切正常"
 *   5  全量重放写入 → 拿机器的写去撞人正在手改的那张卡
 *   6  两个围栏互相看见 → A 方案会炸掉 D-14
 *
 * 纪律：**每条断言都必须先证明"改之前是红的"**（打回旧实现 / 去掉分支，报出变红的测试名，再恢复）。
 * 本项目已经抓到两次"测试绿但什么都没验"：
 *   一次是盲阶段让覆盖在边界之前就被拒（边界根本没被跑到），
 *   一次是断言 `Object.hasOwn(card,'__proto__')`（给普通对象赋 `__proto__` 本来就不产生自有属性）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseDeclaration, tokenizeFenceLines } from '../src/contract.mjs';
import {
  MEETING_FENCE_INFO,
  PARENT_BLOCK_KEYS,
  STAGE_BLOCK_KEYS,
  parseMeetingBlock,
  ledgerFromTasks,
  ledgerWritePlan,
  renderParentBlock,
  renderStageBlock,
  meetingBlockText,
  spliceMeetingBlock,
  isMeetingTask,
  isMeetingStageTask,
  isMeetingParentTask,
  stageTaskIds,
  stageTaskIssues,
  agentRoster,
} from '../src/ledger.mjs';
import { readLedger, meetingState } from '../src/meeting.mjs';
import { continueCount } from '../src/resume.mjs';
import { isMeetingCode } from '../src/codes.mjs';

/**
 * 期望值写字面量，**不从被测模块 import**：断言里的名字一旦从被测模块 import，
 * 那个名字写错了测试也跟着错，等于没断言。
 * （账本层也不再 export 这两个码名——导出码名会把"码表唯一事实源"变成两个入口。）
 */
const E_LEDGER_PARTIAL = 'E_LEDGER_PARTIAL';
const E_LEDGER_DROPPED = 'E_LEDGER_DROPPED';
const E_LEDGER_STRAY_STAGE = 'E_LEDGER_STRAY_STAGE';

/**
 * 发射了但**还没登记**进 `codes.mjs` 的码。
 *
 * 现在是空的 —— `E_LEDGER_DROPPED` 已在 `codes.mjs` 登记（batch 3 / warning），
 * `E_LEDGER_PARTIAL` 是 batch 2 / blocker。19b 会在某条码"登记了却没删干净"时红。
 * 19a 允许清单里的码暂时跳过登记检查；19b 要求这个清单不许过期。
 */
const PENDING_REGISTRATION = new Set([]);

/* ═══════════════════════════════════════════════════════════════════════════
 * 夹具
 * ═══════════════════════════════════════════════════════════════════════════ */

const FENCE = '```';

/** 拼一个账本块（块内每行原样给出）。 */
function meetingBlock(...lines) {
  return [`${FENCE}${MEETING_FENCE_INFO}`, ...lines, FENCE].join('\n');
}

/** 拼一个 `team-board` 声明块。 */
function declarationBlock(...lines) {
  return [`${FENCE}team-board`, ...lines, FENCE].join('\n');
}

const PARENT_LINES = [
  'meeting: m-2026-11-21-1',
  'preset: standard@1',
  'status: running',
  'upgrades:',
  '  - lite@1 -> standard@1',
];

const STAGE_LINES = [
  'meeting: m-2026-11-21-1',
  'stage: redteam',
  'attempt: 1',
  'status: done',
  'continues: 2',
  'produced:',
  '  - killScenarios',
  'at: 2026-11-21T12:00:00+08:00',
  'card.claim: 这条方案会先坏在并发写账本上',
  'card.killScenarios:',
  '  - 两个阶段同时提交把父块写回旧状态',
];

const MEETING_ID = 'm-2026-11-21-1';

/** 一棵最小的健康任务树：父任务 + 一个阶段子任务。 */
function healthyTasks() {
  return [
    { id: 'T-P', description: `这场会要决定 A 方案怎么落地。\n\n${meetingBlock(...PARENT_LINES)}` },
    { id: 'T-S', description: meetingBlock(...STAGE_LINES) },
  ];
}

function codesOf(list) {
  return list.map((item) => item.code);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. 行语法抽取：`tokenizeFenceLines` 只讲语法
 * ═══════════════════════════════════════════════════════════════════════════ */

test('1a. 行语法：`key: value` 取冒号后剩余并 trim；列表挂在"只有键"的那条上', () => {
  const result = tokenizeFenceLines([
    'kind: implementation',
    'objective : 目标', // 冒号前带空格 → 键名 trim 成 objective
    'acceptance:',
    '  - 第一条',
    '  -   第二条（多余缩进不影响）',
    '',
    'verify:',
    '  - node --test',
  ]);

  assert.deepEqual(result.entries, [
    { key: 'kind', inline: 'implementation', items: [] },
    { key: 'objective', inline: '目标', items: [] },
    { key: 'acceptance', inline: null, items: ['第一条', '第二条（多余缩进不影响）'] },
    { key: 'verify', inline: null, items: ['node --test'] },
  ]);
  assert.deepEqual(result.warnings, [], '正常块不该有任何语法 warning');
});

test('1b. 行语法：`-x`（没有空格）不是列表项；空行结束当前列表；行内有值的键不再开列表', () => {
  const result = tokenizeFenceLines([
    'list:',
    '  - 属于 list',
    '-没有空格，是散文',
    '',
    '  - 空行之后，成了孤儿',
    'inline: 值',
    '  - 这一条也是孤儿（inline 已经给了值）',
  ]);

  /* `-没有空格` 经 trim 后是 `-没有空格`，只认严格 `- ` 两字符前缀。 */
  assert.deepEqual(result.entries, [
    { key: 'list', inline: null, items: ['属于 list'] },
    { key: 'inline', inline: '值', items: [] },
  ]);
  assert.deepEqual(
    codesOf(result.warnings),
    ['E_FENCE_ORPHAN_ITEM', 'E_FENCE_ORPHAN_ITEM'],
    '空行后那条与 inline 后那条都必须被报成孤儿，而不是猜给谁',
  );
});

test('1c. 行语法：重复键**全部保留在 entries 里**，按出现顺序 —— "第一个生效"是策略层的事', () => {
  const result = tokenizeFenceLines(['kind: work', 'kind: review', 'acceptance:', '  - a', 'acceptance:', '  - b']);

  assert.deepEqual(
    result.entries.map((entry) => [entry.key, entry.inline, entry.items]),
    [
      ['kind', 'work', []],
      ['kind', 'review', []],
      ['acceptance', null, ['a']],
      ['acceptance', null, ['b']],
    ],
    'tokenizer 不许去重：去重是策略，写在这里就再也拿不到"重复了几次"',
  );
  /* 反例自检：若实现改成"重复键只留第一个"，上面的长度断言会立刻失败。 */
  assert.equal(result.entries.length, 4);
});

test('1d. 行语法：`key : value`（冒号前带空格）键名被 trim —— 否则一条写对的声明会被判成错键', () => {
  const result = parseDeclaration(declarationBlock('kind : work', 'objective : 目标'));
  assert.equal(result.kind, 'work');
  assert.equal(result.contract.objective, '目标');
  assert.deepEqual(result.warnings, []);
});

test('1e. 行语法：`: value`（冒号前为空）不跳过，原样产出 `key: ""`，由上层判**错键**', () => {
  const tokenized = tokenizeFenceLines([': 孤儿值']);
  assert.deepEqual(tokenized.entries, [{ key: '', inline: '孤儿值', items: [] }], '这一层不替上层抹掉它');

  const parsed = parseDeclaration(declarationBlock('kind: work', ': 孤儿值'));
  assert.deepEqual(codesOf(parsed.warnings), ['E_DECLARATION_UNKNOWN_KEY'], '声明层把它判成错键，与抽出前一致');
  assert.equal(parsed.kind, 'work', '一个空键不影响同块的其它键');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. 抽取之后 D-14 的行为必须**字节级不变**
 * ═══════════════════════════════════════════════════════════════════════════ */

test('2a. 抽取后 `parseDeclaration` 的落地结果不变（标量 / 列表 / 报告桶 / 空 vs 缺失）', () => {
  const parsed = parseDeclaration(declarationBlock(
    'kind: implementation',
    'objective: 让 /state 在 storage 不可用时如实返回 unavailable',
    'acceptance:',
    '  - 第一条',
    '  - 第二条',
    'openQuestions:',
    'answered:',
    'changed:',
    '  - plugin/src/ledger.mjs',
  ));

  assert.equal(parsed.kind, 'implementation');
  assert.equal(parsed.contract.objective, '让 /state 在 storage 不可用时如实返回 unavailable');
  assert.deepEqual(parsed.contract.acceptance, ['第一条', '第二条']);
  /* 「空 vs 缺失」最要紧的两条：写了键但零条目 → `[]`；没写 → 键不存在。 */
  assert.deepEqual(parsed.contract.openQuestions, []);
  assert.deepEqual(parsed.contract.answered, []);
  assert.equal(Object.hasOwn(parsed.contract, 'verify'), false, '没写 verify 就不许凭空造一个空数组');
  assert.deepEqual(parsed.changed, ['plugin/src/ledger.mjs'], '报告桶按列表收');
  assert.equal(Object.hasOwn(parsed.contract, 'changed'), false, 'changed 不许漏进契约桶');
  assert.deepEqual(parsed.warnings, []);
});

test('2b. 抽取后 `parseDeclaration` 的畸形输入行为不变（孤儿条目丢弃、不抛、不污染）', () => {
  const orphan = parseDeclaration(declarationBlock('  - 孤儿条目', 'kind: work', 'acceptance:', '  - 正常的'));
  assert.equal(orphan.kind, 'work');
  assert.deepEqual(orphan.contract, { acceptance: ['正常的'] });
  assert.deepEqual(orphan.warnings, [], 'D-14 15) 钉住：孤儿条目被丢弃且 warnings 为空');

  /* 空条目（`- ` 后面空、或只有缩进再减号）不许让整块作废，也不许把 key 变成"没申报"。 */
  const messy = parseDeclaration(declarationBlock('kind: implementation', 'changed:', '  - ', '  -  '));
  assert.deepEqual(messy.changed, [], '空条目丢掉，但"申报了零个改动"这个事实要留住');
});

test('2c. 抽取后"只认第一个块 + 嵌套开口判 unclosed"不变', () => {
  const twoBlocks = [declarationBlock('kind: implementation'), declarationBlock('kind: review')].join('\n\n');
  assert.equal(parseDeclaration(twoBlocks).kind, 'implementation', '只认第一个块');

  const nested = [
    `${FENCE}team-board`,
    'kind: implementation',
    `${FENCE}team-board`,
    'acceptance:',
    '  - 第二条的验收项',
    FENCE,
  ].join('\n');
  assert.deepEqual(
    codesOf(parseDeclaration(nested).warnings),
    ['E_DECLARATION_UNPARSEABLE'],
    '第一个块没闭合时不许让第二个块的闭合来救它',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. parseMeetingBlock：读全部块，但未闭合就停
 * ═══════════════════════════════════════════════════════════════════════════ */

test('3a. 会议头块 → header 有、stages 空；阶段回执块 → 反过来', () => {
  const parent = parseMeetingBlock(meetingBlock(...PARENT_LINES));
  assert.equal(parent.errors.length, 0);
  assert.notEqual(parent.header, null, '有 preset 的块是会议头');
  assert.equal(parent.stages.length, 0);

  const stage = parseMeetingBlock(meetingBlock(...STAGE_LINES));
  assert.equal(stage.errors.length, 0);
  assert.equal(stage.header, null);
  assert.equal(stage.stages.length, 1, '有 stage 的块是阶段回执');
});

test('3b. 一份 description 里的**全部**账本块都读到（这是与 `team-board` 只认第一个的关键差别）', () => {
  const text = [
    meetingBlock(...PARENT_LINES),
    '',
    meetingBlock('meeting: m-2026-11-21-1', 'stage: challenge', 'attempt: 1', 'status: done'),
    '',
    meetingBlock('meeting: m-2026-11-21-1', 'stage: confirm', 'attempt: 1', 'status: pending'),
  ].join('\n');

  const parsed = parseMeetingBlock(text);
  assert.equal(parsed.errors.length, 0);
  assert.notEqual(parsed.header, null);
  assert.equal(parsed.stages.length, 2, '两块回执都要读到 —— 只认第一个的话第二块会凭空消失');
});

test('3c. 没有账本块 → 空结果、零 error（"这块没写账本"不是失败，判"有没有开会"是 ledgerFromTasks 的事）', () => {
  const parsed = parseMeetingBlock(`普通说明，只有一个 ${FENCE}team-board 块：\n${declarationBlock('kind: work')}`);
  assert.deepEqual(parsed, { header: null, stages: [], warnings: [], errors: [] });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. 未闭合的块不许被下一块救（最坏的那一种错：两块内容混成一份假账本）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('4a. 第一块没闭合、后面还有一个好块 → 停下报 E_LEDGER_PARTIAL，那块好的**一个字段都不许读进来**', () => {
  const text = [
    `${FENCE}${MEETING_FENCE_INFO}`,
    'meeting: m-2026-11-21-1',
    'preset: standard@1', // 这一块没有闭合
    '',
    meetingBlock('meeting: m-2026-11-21-1', 'status: done'), // 后面这块是好的
  ].join('\n');

  const parsed = parseMeetingBlock(text);
  assert.deepEqual(codesOf(parsed.errors), [E_LEDGER_PARTIAL]);
  assert.equal(parsed.errors[0].reason, 'unclosed-block');
  assert.equal(parsed.header, null, '没闭合 → 一块都不认，绝不"尽量读"');
  assert.equal(parsed.stages.length, 0);
});

test('4b. 4a 的失败方向必须是"读不出来"，不是"零条"：ledger 为 null 且带 reason', () => {
  const text = [
    `${FENCE}${MEETING_FENCE_INFO}`,
    'meeting: m-2026-11-21-1',
    'preset: standard@1',
    meetingBlock('meeting: m-2026-11-21-1', 'status: done'),
  ].join('\n');

  const read = ledgerFromTasks([{ id: 'T1', description: text }]);
  assert.equal(read.ledger, null);
  assert.equal(read.reason, 'unclosed-block');
  assert.ok(read.errors.length > 0);
  /* 硬红线：**绝不能**是一个看着太平的账本（那就等于拿沉默冒充结论）。 */
  assert.equal(read.ledger === null || typeof read.ledger === 'object', true);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. 缺父块 / 一条块都没有 → E_LEDGER_PARTIAL，**绝不是空账**
 * ═══════════════════════════════════════════════════════════════════════════ */

test('5a. 只有阶段回执、没有会议头 → ledger:null + E_LEDGER_PARTIAL(no-parent-block)', () => {
  const read = ledgerFromTasks([
    { id: 'T-S', description: meetingBlock(...STAGE_LINES) },
  ]);

  assert.equal(read.ledger, null);
  assert.equal(read.reason, 'no-parent-block');
  assert.deepEqual(codesOf(read.errors), [E_LEDGER_PARTIAL]);
  assert.match(read.errors[0].message, /不是"会议还没开始"/, '文案必须点明这不是空态');
});

test('5b. 任务树上一条账本块都没有 → E_LEDGER_PARTIAL(no-meeting-block)，不许返回 {status:"not-started"}', () => {
  const read = ledgerFromTasks([
    { id: 'T1', description: '只有说明，没有账本' },
    { id: 'T2', description: declarationBlock('kind: work') },
  ]);

  assert.equal(read.ledger, null, '零个块 ≠ 一场还没开始的会');
  assert.equal(read.reason, 'no-meeting-block');
  assert.deepEqual(codesOf(read.errors), [E_LEDGER_PARTIAL]);
  assert.equal(Object.hasOwn(read, 'status'), false, '返回里根本不该有 status 这个键');
});

test('5c. tasks 不是数组 → E_LEDGER_PARTIAL(tasks-unreadable)，不许抛', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    const read = ledgerFromTasks(bad);
    assert.equal(read.ledger, null, `ledgerFromTasks(${String(bad)}) 必须是 null`);
    assert.equal(read.reason, 'tasks-unreadable');
    assert.deepEqual(codesOf(read.errors), [E_LEDGER_PARTIAL]);
  }
});

test('5d. 两个会议头 → E_LEDGER_PARTIAL(duplicate-parent)：不许挑一个信', () => {
  const read = ledgerFromTasks([
    { id: 'T1', description: meetingBlock(...PARENT_LINES) },
    { id: 'T2', description: meetingBlock('meeting: m-other', 'preset: lite@1', 'status: running') },
  ]);
  assert.equal(read.ledger, null);
  assert.equal(read.reason, 'duplicate-parent');
});

test('5e. 账本读不出来时 `cards` 必须是空数组 —— 不许把半截卡片带出去', () => {
  /* 要走到"已经读到一张卡、但账本仍然判死"的那个出口，得让错误发生在**读阶段的过程中**：
   * 前一块回执读成功（卡片进了 cards），后一块是同一阶段的重复回执 → 判死。
   * 于是"账本为 null 而 cards 有东西"是真的能出现的形状 —— 调用方拿着读不出来的账本
   * 加几张卡，两边根本不是同一件事。 */
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S1', description: meetingBlock(...STAGE_LINES) },
    { id: 'T-S2', description: meetingBlock(...STAGE_LINES) },
  ]);

  assert.equal(read.ledger, null);
  assert.equal(read.reason, 'duplicate-stage');
  assert.deepEqual(read.cards, [], '读不出来就没有卡：半截结果比没有结果更危险');

  /* 反例自检：这一堆任务在**不判死**的情形下确实会产出一张卡 ——
   * 否则上面那条 `cards === []` 可能只是因为"根本没读到卡"而恒真。 */
  const healthy = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S1', description: meetingBlock(...STAGE_LINES) },
  ]);
  assert.equal(healthy.cards.length, 1, '同一份回执在健康路径上必须真的产出一张卡');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. 键：不认识的键只出声；重复键取第一个；写到另一个块上的键只出声
 * ═══════════════════════════════════════════════════════════════════════════ */

test('6a. 不认识的键 → E_LEDGER_DROPPED 的 warning，errors 为空，且它的值**没落地**', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES, 'presett: standard@1', 'notes: 随手写的') },
  ]);

  assert.deepEqual(read.errors, [], '错键不拦 —— 它不该让整场会开不下去');
  const dropped = read.warnings.filter((warning) => warning.code === E_LEDGER_DROPPED);
  assert.equal(dropped.length, 2, '两个错键各报一次');
  /* **必须辨类别，不能只数条数。** 这条是变异自证时补的：
   * 原来只断言 `dropped.length === 2`，而"不认识的键"与"键写到了错误的块上"
   * 走的是同一个码，于是把 `isKnownBlockKey` 改成"什么都认"之后，
   * 两个键掉进"写错块"那一支，条数照样是 2 —— 断言绿着，什么都没验。 */
  assert.deepEqual(
    dropped.map((warning) => warning.reason).sort(),
    ['unknown-key', 'unknown-key'],
    '两个都是"不认识的键"，不许混进"键写到了错误的块上"那一类',
  );
  for (const warning of dropped) {
    assert.match(warning.message, /不认识的键/, '文案要让人知道是拼错了，而不是"值不合法"');
  }
  assert.equal(read.ledger.preset, 'standard@1', '拼错的键不许顶掉对的键');
  assert.equal(Object.hasOwn(read.ledger, 'notes'), false, '错键的值不许凭空出现在账本上');
});

test('6b. 属于另一种块的键 → 只出声，值不落地（把 preset 写到阶段回执块上）', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S', description: meetingBlock(...STAGE_LINES, 'preset: lite@1') },
  ]);

  assert.deepEqual(read.errors, [], '写错位置是人的手误，不该判死整份账本');
  assert.ok(
    read.warnings.some((warning) => warning.reason === 'wrong-block-key'),
    '必须报一条"键写到了错误的块上"',
  );
  assert.equal(read.ledger.preset, 'standard@1', '阶段块上的 preset 不许污染会议头');
});

test('6c. 重复键：第一个生效（标量与列表都一样），且重复本身不留 warning', () => {
  const read = ledgerFromTasks([
    {
      id: 'T-P',
      description: meetingBlock(
        ...PARENT_LINES,
        'status: done', // 重复的 status → 第一个（running）生效
      ),
    },
    { id: 'T-S', description: meetingBlock(...STAGE_LINES) },
  ]);

  assert.equal(read.ledger.status, 'running', '重复键取第一个，后来者不许覆盖原意');
  assert.deepEqual(read.errors, []);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. `continues` 是标量，下游要的是 `resumes` 数组 —— 必须翻译，不能假设
 * ═══════════════════════════════════════════════════════════════════════════ */

test('7a. `continues: 2` 被具体化成 2 条 resumes 条目，`continueCount` 数得出 2', () => {
  const read = ledgerFromTasks(healthyTasks());

  assert.deepEqual(read.errors, []);
  assert.equal(read.ledger.stages[0].continues, undefined, '块里的标量不进 record（record 是 meeting.mjs 的形状）');
  assert.equal(read.ledger.resumes.length, 2);
  assert.deepEqual(
    read.ledger.resumes.map((item) => [item.stageId, item.attempt, item.seq]),
    [['redteam', 1, 1], ['redteam', 1, 2]],
  );
  /* 真叫下游算一遍：不翻译成 resumes 的话这里永远是 0，`E_RESUME_EXHAUSTED` 就成了死码。 */
  assert.equal(continueCount(read.ledger, 'redteam', 1), 2);
});

test('7b. `continues` 缺省 → 0 次继续，且**不许**凭空造 resumes', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S', description: meetingBlock('meeting: m-2026-11-21-1', 'stage: challenge', 'attempt: 1', 'status: pending') },
  ]);
  assert.deepEqual(read.errors, []);
  assert.equal(Object.hasOwn(read.ledger, 'resumes'), false, '零次继续不该留一个空数组的壳');
  assert.equal(continueCount(read.ledger, 'challenge', 1), 0);
});

test('7c. `continues` 不是非负整数 → E_LEDGER_PARTIAL(bad-continues)，不许默默按 0 算', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S', description: meetingBlock(...STAGE_LINES.slice(0, 4), 'continues: 两次', ...STAGE_LINES.slice(5)) },
  ]);

  assert.equal(read.ledger, null, '按 0 算等于让一个已经该交人的阶段继续跑');
  assert.equal(read.reason, 'bad-continues');
});

test('7d. 具体化出来的 resumes 条目**只承载 seq**：绝不许把时间/发起人编回来', () => {
  const read = ledgerFromTasks(healthyTasks());
  assert.equal(read.ledger.resumes.length, 2);

  /* 这条是 `continues` 存标量的**代价钉**：块里只有 `continues: 2` 一个数字，
   * 每次继续的时间与发起人在盘上根本不存在。投影为了让 `resume.mjs` 数得出 count，
   * 具体化出 2 条条目 —— 但它们只许有这 4 个键。
   *
   * 若哪天有人"顺手"补上 `at` / `by`（或从别处推一个时间出来），那就是**把丢掉的字段编回来**：
   * 调用方会以为这是两次真实记录的事件，于是去算"距上次继续多久"（`assessLiveness` 就吃时间），
   * 拿一个编出来的时间做止损判断。`7b` 钉的是"不许凭空造条目"，这条钉的是"造出来的不许带细节"。 */
  for (const entry of read.ledger.resumes) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['attempt', 'key', 'seq', 'stageId'],
      'resume 条目只许承载定位与序号；时间与发起人是被丢掉的代价，不许编回来',
    );
    assert.equal(Object.hasOwn(entry, 'at'), false);
    assert.equal(Object.hasOwn(entry, 'by'), false);
  }

  /* 反例自检：`JSON` 里也不许冒出别的东西（防止哪天用展开把 record 整个带进来）。 */
  assert.deepEqual(
    JSON.parse(JSON.stringify(read.ledger.resumes))[0],
    { key: `${MEETING_ID}\u0000redteam\u00001\u00001`, stageId: 'redteam', attempt: 1, seq: 1 },
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 8. 整数 / 身份 / 归属：读不出来就判死，不补默认值
 * ═══════════════════════════════════════════════════════════════════════════ */

test('8a. `attempt` 不是正整数 → E_LEDGER_PARTIAL(bad-attempt)', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S', description: meetingBlock('meeting: m-2026-11-21-1', 'stage: redteam', 'attempt: 第2轮', 'status: done') },
  ]);
  assert.equal(read.ledger, null);
  assert.equal(read.reason, 'bad-attempt');
});

test('8b. `attempt` 缺失 → 只 warning（不补 1：那会把"没写"和"第一轮"焊在一起）', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S', description: meetingBlock('meeting: m-2026-11-21-1', 'stage: redteam', 'status: done') },
  ]);
  assert.deepEqual(read.errors, []);
  assert.ok(read.warnings.some((warning) => warning.reason === 'attempt-missing'));
  assert.equal(read.ledger.stages[0].attempt, undefined, '不许补一个编出来的 1');
});

test('8c. 同一阶段两块回执 → E_LEDGER_PARTIAL(duplicate-stage)：账本里一个阶段只有一条记录', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S1', description: meetingBlock('meeting: m-2026-11-21-1', 'stage: redteam', 'attempt: 1', 'status: failed') },
    { id: 'T-S2', description: meetingBlock('meeting: m-2026-11-21-1', 'stage: redteam', 'attempt: 2', 'status: done') },
  ]);
  assert.equal(read.ledger, null);
  assert.equal(read.reason, 'duplicate-stage', '选一块信一把等于替人决定哪次尝试才算数');
});

test('8d. 阶段块写着别的会议 id → E_LEDGER_PARTIAL(meeting-mismatch)', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S', description: meetingBlock('meeting: m-别的会', 'stage: redteam', 'attempt: 1', 'status: done') },
  ]);
  assert.equal(read.ledger, null);
  assert.equal(read.reason, 'meeting-mismatch');
});

test('8e. 会议头没有 meeting: → E_LEDGER_PARTIAL(meeting-id-missing)', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock('preset: standard@1', 'status: running') },
  ]);
  assert.equal(read.ledger, null);
  assert.equal(read.reason, 'meeting-id-missing');
});

test('8f. 阶段块缺 `meeting:` → 只 warning（账本照读），因为"没法核对归属"不是读不出来', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S', description: meetingBlock('stage: redteam', 'attempt: 1', 'status: done', 'produced:', '  - killScenarios') },
  ]);

  assert.deepEqual(read.errors, [], '缺这一行不该让账本读不出来 —— 归属可以按父任务算');
  assert.equal(read.ledger.stages[0].stageId, 'redteam', '照样要读出来');
  assert.ok(
    read.warnings.some((warning) => warning.reason === 'meeting-missing'),
    '必须出声：把一张阶段卡贴错任务时，`meeting:` 是唯一能发现它的东西',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 9. 解析诊断一个都不许丢（lead 加的那条）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('9a. 账本块里有孤儿列表项 → warnings 里必须有它，errors 为空（不拦，但要出声）', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    {
      id: 'T-S',
      description: meetingBlock(
        'meeting: m-2026-11-21-1',
        'stage: redteam',
        'attempt: 1',
        'status: done',
        '  - 这一行没对齐，成了孤儿', // produced: 那一行漏了
      ),
    },
  ]);

  assert.deepEqual(read.errors, [], '孤儿条目不许拦会议');
  assert.ok(
    codesOf(read.warnings).includes('E_FENCE_ORPHAN_ITEM'),
    '账本层绝不许把 tokenizer 的语法警告静默丢掉 —— 那等于"产物清单少了一条却看起来一切正常"',
  );
});

test('9b. 9a 的反面：这条警告不许冒充 error（否则一个缩进错误会把整场会判死）', () => {
  const parsed = parseMeetingBlock([
    `${FENCE}${MEETING_FENCE_INFO}`,
    'meeting: m-2026-11-21-1',
    'preset: standard@1',
    '  - 孤儿',
    FENCE,
  ].join('\n'));

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(codesOf(parsed.warnings), ['E_FENCE_ORPHAN_ITEM']);
  assert.notEqual(parsed.header, null, '块本身照样要读出来');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 10. 投影对齐：`meeting.mjs` 一行不改就能吃下去
 * ═══════════════════════════════════════════════════════════════════════════ */

test('10a. `readLedger` 直接接受投影结果', () => {
  const read = ledgerFromTasks(healthyTasks());
  const ledger = readLedger(read.ledger);
  assert.equal(ledger.ok, true, `readLedger 不认这个形状：${JSON.stringify(ledger.error)}`);
  assert.equal(ledger.error, null);
});

test('10b. `meetingState` 能判出"跑到哪了"（这里用 lite@1 的四阶段图）', () => {
  const preset = {
    id: 'lite@1',
    stages: [{ id: 'challenge' }, { id: 'confirm' }, { id: 'design' }, { id: 'verify' }],
  };

  const read = ledgerFromTasks(healthyTasks());
  /* 账本里只有一个 redteam（不在 lite 图里）→ 该报"账本里有阶段不在图里"，但仍然是 in-progress。 */
  const state = meetingState({ meeting: read.ledger, preset });
  assert.equal(state.phase, 'in-progress');
  assert.equal(state.currentStage.id, 'challenge');

  /* **这里只钉事实，不钉码名。**
   *
   * 原来断言的是 `warning.code === 'E_ARTIFACT_PARTIAL'`。那个码的两义（"卡片字段缺" vs
   * "账本里有不在阶段图里的 stray 阶段"）正由码表的主人在拆（拆成一个新的 stray 专用码）。
   * 钉住别人的码名会带来两个后果：①别人改名我就红，而我的判据其实没变；
   * ②更糟，我这条会**替一个错的码名盖章**——名字错了，测试帮着说它对。
   *
   * 我的判据是"stray 阶段必须如实列出、不许被吃掉、且要点名是哪几个"。
   * 那件事用文案就能钉住，而且换名字时不用动我这一行。
   * 下面 10b-2 是自证：把 stray 阶段放进图里，这条判据必须**找不到**它 ——
   * 否则这个 find 永远能命中，断言就等于没写。 */
  /* **码名现在可以钉了**：`E_LEDGER_STRAY_STAGE` 已由码表的主人登记（batch 3 / warning），
   * `meeting.mjs` 的发射端也已切到它。之前那版只能钉文案，是因为码名正被拆解中
   * （`E_ARTIFACT_PARTIAL` 当时一码两义："卡片字段缺" 与 "账本里有不在阶段图里的阶段"）。
   * 现在钉码名 + 钉点名 + 钉 10b-2 的反面，三条一起才说明"stray 必须被如实列出"。 */
  const strayWarning = state.warnings.find((warning) => warning.code === E_LEDGER_STRAY_STAGE);
  assert.ok(strayWarning, 'redteam 不在 lite@1 里，必须作为 warning 如实列出而不是被吃掉');
  assert.match(strayWarning.message, /redteam/, '要点名是哪几个阶段不在图里，不能只说"有阶段不在图里"');
  assert.equal(state.ok, true, 'stray 是留痕，不拦路 —— 它不该让 state 变成 false');

  /* 换成含 redteam 的图，且标它 done：必须能算出来。 */
  const withRedteam = {
    id: 'standard@1',
    stages: [{ id: 'challenge' }, { id: 'confirm' }, { id: 'design' }, { id: 'redteam' }],
  };
  const state2 = meetingState({ meeting: read.ledger, preset: withRedteam });
  assert.deepEqual(state2.completed, ['redteam']);
  assert.deepEqual(state2.pending, ['challenge', 'confirm', 'design']);

  /* 10b-2 自证：同样一份账本、图里**包含** redteam 时，那条 stray 判据必须找不到东西。
   * 没有这一半，上面那个 `.find(...includes('阶段图'))` 可能是永远命中的，
   * 于是"stray 必须被列出"这件事实际上一次都没被验过。 */
  assert.equal(
    state2.warnings.find((warning) => warning.code === E_LEDGER_STRAY_STAGE),
    undefined,
    'redteam 已经在图里了，就不该再报 stray —— 否则上面那条断言是空转的',
  );
});

test('10c. 投影是规范形：`ledgerFromTasks` 只挂真值键（没有 `at: undefined` 这种）', () => {
  const read = ledgerFromTasks([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S', description: meetingBlock('meeting: m-2026-11-21-1', 'stage: challenge', 'attempt: 1', 'status: pending') },
  ]);

  const record = read.ledger.stages[0];
  assert.deepEqual(Object.keys(record).sort(), ['attempt', 'produced', 'stageId', 'status']);
  assert.equal(Object.hasOwn(record, 'at'), false, '没给时间就不许挂一个 at: undefined');

  /* JSON 往返必须一模一样 —— 这一条抓的是"内存里看着有、落盘后消失"的那种键。 */
  assert.deepEqual(JSON.parse(JSON.stringify(read.ledger)), read.ledger);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 11. 往返：渲染 → 解析 → 逐字段相等，且写计划退化成 0 次写
 * ═══════════════════════════════════════════════════════════════════════════ */

test('11a. 往返投影 deepEqual（父块 + 阶段块 + 卡片 + continues + upgrades + at）', () => {
  const original = ledgerFromTasks(healthyTasks());
  assert.deepEqual(original.errors, []);

  /* 用投影自己的渲染器造一份新任务树，再读回来。 */
  const rebuilt = [
    { id: 'T-P', description: `正文不许被动。\n\n${renderParentBlock(original.ledger)}` },
    {
      id: 'T-S',
      description: renderStageBlock(
        original.ledger,
        {
          ...original.ledger.stages[0],
          continues: continueCount(original.ledger, 'redteam', 1),
        },
        original.cards[0].card,
      ),
    },
  ];
  const again = ledgerFromTasks(rebuilt);

  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.ledger, original.ledger, '往返之后账本必须逐字段相同');
  assert.deepEqual(again.cards, original.cards, '卡片（含列表字段）必须逐字段相同');
});

test('11b. 投影是不动点：拿投影出来的账本去算写计划 → 零次写', () => {
  const tasks = healthyTasks();
  const read = ledgerFromTasks(tasks);
  const plan = ledgerWritePlan(tasks, read.ledger);

  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.creates, [], '没有新阶段就不许建任务');
  assert.deepEqual(plan.updates, [], '什么都没变就不许写 —— 每次写都是一次 revision bump');
});

test('11c. 「写了但零条」不许在写入后降级成「没写」：空数组必须留下 `key:` 那一行', () => {
  const text = renderStageBlock(
    { id: MEETING_ID },
    { stageId: 'redteam', attempt: 1, status: 'done', produced: [] },
    { killScenarios: [], claim: '只有一个主张' },
  );
  assert.match(text, /^produced:$/m, '空数组也要留一行 produced:');
  assert.match(text, /^card\.killScenarios:$/m, '卡片的空列表字段同样要留一行');

  const read = ledgerFromTasks([{ id: 'T-P', description: meetingBlock(...PARENT_LINES) }, { id: 'T-S', description: text }]);
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.cards[0].card.killScenarios, [], '读回来必须是"零条"，不是"没写这个字段"');
  assert.equal(Object.hasOwn(read.cards[0].card, 'killScenarios'), true);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 12. ledgerWritePlan：只产出必要的写
 * ═══════════════════════════════════════════════════════════════════════════ */

test('12a. 一个阶段完成 = **1 次子任务 update + 0 次父任务 update**', () => {
  const tasks = healthyTasks();
  const read = ledgerFromTasks(tasks);

  const next = {
    ...read.ledger,
    stages: [{ ...read.ledger.stages[0], status: 'failed' }],
  };
  const plan = ledgerWritePlan(tasks, next);

  assert.deepEqual(plan.errors, []);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1, '只许写那一张子任务，不许把整棵树重放一遍');
  assert.equal(plan.updates[0].role, 'stage');
  assert.equal(plan.updates[0].stageId, 'redteam');
  assert.equal(plan.updates[0].taskId, 'T-S');
});

test('12b. 会议状态变了 → 多出 1 次父任务 update（阶段没变就不碰阶段）', () => {
  const tasks = healthyTasks();
  const read = ledgerFromTasks(tasks);

  const plan = ledgerWritePlan(tasks, { ...read.ledger, status: 'done' });

  assert.deepEqual(plan.errors, []);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].role, 'parent');
  assert.equal(plan.updates[0].taskId, 'T-P');
  assert.equal(plan.creates.length, 0);
});

test('12c. 写进去的描述必须保住人的正文、卡片、continues（不许顺手把它们擦掉）', () => {
  const tasks = healthyTasks();
  const read = ledgerFromTasks(tasks);

  const plan = ledgerWritePlan(tasks, { ...read.ledger, status: 'done' });
  const parentDescription = plan.updates[0].description;
  assert.ok(parentDescription.startsWith('这场会要决定 A 方案怎么落地。'), '父任务上的正文必须原样留着');

  const stagePlan = ledgerWritePlan(tasks, {
    ...read.ledger,
    stages: [{ ...read.ledger.stages[0], status: 'failed' }],
  });
  const stageDescription = stagePlan.updates[0].description;
  assert.match(stageDescription, /card\.claim: 这条方案会先坏在并发写账本上/, '卡片不许被写没');
  assert.match(stageDescription, /card\.killScenarios:/, '卡片的列表字段不许被写没');
  assert.match(stageDescription, /continues: 2/, '继续次数不许被写没（它只存在块里）');
  assert.match(stageDescription, /at: 2026-11-21T12:00:00\+08:00/, '时间不许被写没');
});

test('12d. 目标账本里多出一个阶段 → 1 次 create，且 blockedBy 用**阶段名**表达（纯函数拿不到新任务 id）', () => {
  const tasks = healthyTasks();
  const read = ledgerFromTasks(tasks);

  const next = {
    ...read.ledger,
    stages: [
      ...read.ledger.stages,
      { stageId: 'build', attempt: 1, status: 'pending', produced: [] },
    ],
  };
  const plan = ledgerWritePlan(tasks, next);

  assert.deepEqual(plan.errors, []);
  assert.equal(plan.creates.length, 1, '只有一个新阶段');
  assert.equal(plan.creates[0].role, 'stage');
  assert.equal(plan.creates[0].stageId, 'build');
  assert.deepEqual(plan.creates[0].blockedByStages, ['redteam'], '链式排序交给宿主；这里只能给阶段名');
  assert.equal(plan.updates.length, 0, '既有阶段没变，就不许写它们');
});

test('12e. 完全没有任务树 → 先建父任务，子任务按链递进挡', () => {
  const plan = ledgerWritePlan([], {
    id: MEETING_ID,
    preset: 'standard@1',
    status: 'running',
    stages: [
      { stageId: 'challenge', attempt: 1, status: 'pending', produced: [] },
      { stageId: 'confirm', attempt: 1, status: 'pending', produced: [] },
    ],
  });

  assert.deepEqual(plan.errors, []);
  assert.equal(plan.creates.length, 3, '父 + 两个阶段');
  assert.deepEqual(
    plan.creates.map((create) => create.role),
    ['parent', 'stage', 'stage'],
  );
  assert.deepEqual(plan.creates[1].blockedByStages, [], '第一阶段没有前驱');
  assert.deepEqual(plan.creates[2].blockedByStages, ['challenge'], '第二阶段挡在第一阶段后面');
});

test('12f. 旧树上还有、目标账本里没有的阶段任务 → 只 warning，**不删**（删任务不可逆）', () => {
  const tasks = healthyTasks();
  const read = ledgerFromTasks(tasks);

  const plan = ledgerWritePlan(tasks, { ...read.ledger, stages: [] });
  assert.deepEqual(plan.errors, []);
  assert.ok(
    plan.warnings.some((warning) => warning.reason === 'orphan-stage-task' && warning.stageId === 'redteam'),
    '不删，但要出声：那张卡会一直挂在看板上而不再被推进',
  );
  assert.equal(
    plan.updates.some((update) => update.role === 'stage'),
    false,
    '不许"顺手把多余的任务清掉"——删除是不可逆动作',
  );
});

test('12g. 目标账本不是对象 / 没有 id → 报错且**一次都不写**', () => {
  for (const bad of [null, undefined, 'x', 42, [], { preset: 'standard@1' }]) {
    const plan = ledgerWritePlan(healthyTasks(), bad);
    assert.ok(plan.errors.length > 0, `target=${JSON.stringify(bad)} 必须报错`);
    assert.deepEqual(plan.creates, [], '猜一个目标状态写下去 = 把账本改成没人要求的样子');
    assert.deepEqual(plan.updates, []);
  }
});

test('12h. 现有账本块没闭合 → 拒绝替换（报错，不猜边界）', () => {
  const tasks = [
    { id: 'T-P', description: `${FENCE}${MEETING_FENCE_INFO}\nmeeting: ${MEETING_ID}\npreset: standard@1` },
  ];
  const plan = ledgerWritePlan(tasks, {
    id: MEETING_ID,
    preset: 'standard@1',
    status: 'done',
    stages: [],
  });

  assert.ok(plan.errors.some((error) => error.reason === 'unclosed-block'));
  assert.deepEqual(plan.updates, []);
});

test('12i. 旧树上已经有两个会议头 → 拒绝写（不许"只认第一个、把另一个当不存在"）', () => {
  const tasks = [
    { id: 'T-P1', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-P2', description: meetingBlock(...PARENT_LINES) },
  ];
  const plan = ledgerWritePlan(tasks, { id: MEETING_ID, preset: 'standard@1', status: 'done', stages: [] });

  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.updates, []);
  assert.equal(plan.errors[0].reason, 'duplicate-parent');
  assert.match(plan.errors[0].message, /T-P1、T-P2/, '要点名是哪两张，人才知道删哪一张');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 13. 分类：把会议任务从交付门禁的分母里显式排除
 * ═══════════════════════════════════════════════════════════════════════════ */

test('13a. `isMeetingStageTask` 正负例：阶段回执 true；会议头 false；普通任务 false', () => {
  const [parent, stage] = healthyTasks();

  assert.equal(isMeetingStageTask(stage), true);
  assert.equal(isMeetingStageTask(parent), false, '会议头不是子任务');
  assert.equal(isMeetingStageTask({ id: 'X', description: '普通任务' }), false);
  assert.equal(isMeetingStageTask({ id: 'X', description: declarationBlock('kind: work') }), false);
  assert.equal(isMeetingStageTask(null), false, '不许对非对象抛错');
  assert.equal(isMeetingStageTask(undefined), false);
});

test('13b. `isMeetingParentTask` 与 `isMeetingStageTask` 互斥，`isMeetingTask` 是并集', () => {
  const [parent, stage] = healthyTasks();
  assert.equal(isMeetingParentTask(parent), true);
  assert.equal(isMeetingParentTask(stage), false);
  assert.equal(isMeetingTask(parent), true);
  assert.equal(isMeetingTask(stage), true);
  assert.equal(isMeetingTask({ id: 'X', description: '普通任务' }), false);
});

test('13c. 读不出来的会议块仍算会议任务 —— 否则它会掉进交付门禁被判一遍', () => {
  const broken = {
    id: 'T-B',
    description: `${FENCE}${MEETING_FENCE_INFO}\nmeeting: ${MEETING_ID}\nstage: redteam`,
  };
  assert.equal(isMeetingTask(broken), true, '按围栏存在判，不按解析成功判');
  assert.equal(isMeetingStageTask(broken), true, '破的会议任务也必须被排出门禁分母');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 14. 两个围栏互相看不见（A 方案不炸掉 D-14 的护身符）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('14a. 同一 description 同时含两块时，`parseDeclaration` 的结果必须与只含 `team-board` 时**逐字段相同**', () => {
  const declaration = declarationBlock(
    'kind: implementation',
    'objective: 让账本落在任务树里',
    'acceptance:',
    '  - 账本块读不出来时 ledger 为 null',
    'openQuestions:',
  );

  const onlyDeclaration = parseDeclaration(`说明。\n\n${declaration}`);
  const withMeeting = parseDeclaration(`说明。\n\n${declaration}\n\n${meetingBlock(...PARENT_LINES)}`);

  assert.deepEqual(
    withMeeting,
    onlyDeclaration,
    '账本块只要漏一个字段进 parseDeclaration，A 方案就把 D-14 炸了',
  );
  assert.equal(withMeeting.kind, 'implementation', '顺便确认这不是"两边都读不出来"造成的假相等');
  assert.deepEqual(codesOf(withMeeting.warnings), []);
});

test('14b. 反过来也成立：账本块写在前面（且闭合）也不影响 `team-board` 的定位', () => {
  const declaration = declarationBlock('kind: review', 'reviewedTaskId: T1');
  const text = `${meetingBlock(...PARENT_LINES)}\n\n${declaration}`;
  const parsed = parseDeclaration(text);

  assert.equal(parsed.kind, 'review');
  assert.equal(parsed.contract.reviewedTaskId, 'T1');
  assert.deepEqual(codesOf(parsed.warnings), []);
});

test('14c. `MEETING_FENCE_INFO` 与声明块的 `team-board` 是不同的 info，且恰好相等才认', () => {
  assert.notEqual(MEETING_FENCE_INFO, 'team-board');
  /* 带附加词 / 大小写不同都不认（与 contract.mjs 的口径一致）。 */
  for (const info of ['team-board-meetings', 'Team-Board-Meeting', 'team-board-meeting extra']) {
    const parsed = parseMeetingBlock([`${FENCE}${info}`, 'meeting: x', 'preset: lite@1', FENCE].join('\n'));
    assert.deepEqual(parsed, { header: null, stages: [], warnings: [], errors: [] }, `${info} 不该被认`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 15. 值里的换行必须压平：它是一条安全边界，不是排版
 * ═══════════════════════════════════════════════════════════════════════════ */

test('15a. 卡片值里带换行 + 伪造字段行 → 读回来时状态没被改写', () => {
  const evil = '我先坏在 A 上\nstatus: done\nstage: signoff';
  const text = renderStageBlock(
    { id: MEETING_ID },
    { stageId: 'redteam', attempt: 1, status: 'running', produced: [] },
    { claim: evil },
  );

  const parsed = parseMeetingBlock(text);
  assert.deepEqual(parsed.errors, []);
  const read = ledgerFromTasks([{ id: 'T-P', description: meetingBlock(...PARENT_LINES) }, { id: 'T-S', description: text }]);

  assert.deepEqual(read.errors, []);
  assert.equal(read.ledger.stages[0].status, 'running', '值里的 status: done 不许改写账本状态');
  assert.equal(read.ledger.stages[0].stageId, 'redteam', '值里的 stage: signoff 不许改写阶段名');
  assert.equal(read.cards[0].card.claim, '我先坏在 A 上 status: done stage: signoff', '换行被压成一行');
});

test('15b. 值里的反引号不会把块提前闭合（闭栏判据要求整行是纯反引号）', () => {
  const text = renderStageBlock(
    { id: MEETING_ID },
    { stageId: 'redteam', attempt: 1, status: 'done', produced: [] },
    { claim: '这里是 ```js 一段代码引用' },
  );
  const read = ledgerFromTasks([{ id: 'T-P', description: meetingBlock(...PARENT_LINES) }, { id: 'T-S', description: text }]);

  assert.deepEqual(read.errors, []);
  assert.equal(read.cards[0].card.claim, '这里是 ```js 一段代码引用');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 16. 写入位置的规矩：追加永远追加到末尾
 * ═══════════════════════════════════════════════════════════════════════════ */

test('16a. 没有账本块时追加到**末尾**（这样它永远在 `team-board` 块之后）', () => {
  const description = `正文。\n\n${declarationBlock('kind: work')}`;
  const next = spliceMeetingBlock(description, meetingBlock(...PARENT_LINES));

  assert.notEqual(next, null);
  const lines = next.split('\n');
  const meetingAt = lines.findIndex((line) => line.trim() === `${FENCE}${MEETING_FENCE_INFO}`);
  const declarationAt = lines.findIndex((line) => line.trim() === `${FENCE}team-board`);
  assert.ok(declarationAt !== -1 && meetingAt !== -1);
  assert.ok(meetingAt > declarationAt, '账本块必须在声明块之后：闭栏没有长度隔离，只有顺序隔离');
});

test('16b. 已有账本块时原地替换，正文与块前后位置都不动', () => {
  const description = `前面的话。\n\n${meetingBlock(...PARENT_LINES)}\n\n后面的话。`;
  const next = spliceMeetingBlock(description, meetingBlock('meeting: m-2026-11-21-1', 'preset: standard@1', 'status: done'));

  assert.notEqual(next, null);
  assert.ok(next.startsWith('前面的话。'));
  assert.ok(next.trimEnd().endsWith('后面的话。'));
  assert.match(next, /status: done/);
  assert.equal(/status: running/.test(next), false, '旧块必须被整块换掉，不许叠加');
});

test('16c. 账本块没闭合 → `spliceMeetingBlock` 返回 null（不猜该替换到哪一行）', () => {
  const broken = `${FENCE}${MEETING_FENCE_INFO}\nmeeting: ${MEETING_ID}\nstatus: running`;
  assert.equal(spliceMeetingBlock(broken, meetingBlock('meeting: x', 'preset: lite@1')), null);
});

test('16d. `meetingBlockText` 取到的是块原文（含围栏），没有块 → null', () => {
  const description = `前言\n\n${meetingBlock(...PARENT_LINES)}\n\n后记`;
  assert.equal(meetingBlockText(description), meetingBlock(...PARENT_LINES));
  assert.equal(meetingBlockText('没有账本'), null);
  assert.equal(meetingBlockText(null), null);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 17. 铁律：纯函数（零 IO、不读时钟、同输入同输出）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('17a. 同一输入两次调用结果完全一致（没有隐藏状态）', () => {
  const a = ledgerFromTasks(healthyTasks());
  const b = ledgerFromTasks(healthyTasks());
  assert.deepEqual(a, b);

  const planA = ledgerWritePlan(healthyTasks(), a.ledger);
  const planB = ledgerWritePlan(healthyTasks(), b.ledger);
  assert.deepEqual(planA, planB, '两次算出来的写计划必须一样（含顺序）');
});

test('17b. 源码里不许出现时钟 / IO / 环境变量（铁律一的机械检查）', () => {
  const source = readFileSync(new URL('../src/ledger.mjs', import.meta.url), 'utf8');

  for (const forbidden of ['Date.now', 'new Date(', 'performance.now', 'process.env', 'readFile', 'writeFile', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, `ledger.mjs 里不许出现 ${forbidden}：账本层必须是纯的`);
  }

  /* 反例自检：检查器必须真的能命中，否则这条永远绿着空转。 */
  const probe = 'const t = Date.now();';
  assert.equal(probe.includes('Date.now'), true);
});

test('17c. 行语法必须从 `contract.mjs` 复用，不许抄第二套', () => {
  const source = readFileSync(new URL('../src/ledger.mjs', import.meta.url), 'utf8');

  assert.match(
    source,
    /import\s*\{\s*tokenizeFenceLines\s*\}\s*from\s*'\.\/contract\.mjs'/,
    '账本块必须 import 同一份 tokenizer —— 抄一个循环就是第二套语法，漂移时没人报警',
  );
  /* 自己再写一遍 `startsWith('- ')` 就是抄了一套。 */
  assert.equal(
    source.includes("startsWith('- ')"),
    false,
    'ledger.mjs 里不许自己判列表项前缀：那是 tokenizer 的活',
  );
  /* 顺便把 `continueKey` 也钉住：NUL 分隔的键格式只能有一份。 */
  assert.match(source, /import\s*\{[^}]*continueKey[^}]*\}\s*from\s*'\.\/resume\.mjs'/);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 18. 键白名单本身（两套分开定义，不许合并）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('18a. 父块 / 子块两套白名单的差异点就是 `stage` 与 `preset`（合并成一套就判不出角色）', () => {
  assert.deepEqual([...PARENT_BLOCK_KEYS], ['meeting', 'preset', 'status', 'upgrades']);
  assert.deepEqual([...STAGE_BLOCK_KEYS], [
    'meeting', 'stage', 'attempt', 'status', 'continues', 'produced', 'at', 'agent',
  ]);
  assert.ok(PARENT_BLOCK_KEYS.includes('preset'));
  assert.equal(PARENT_BLOCK_KEYS.includes('stage'), false);
  assert.ok(STAGE_BLOCK_KEYS.includes('stage'));
  assert.equal(STAGE_BLOCK_KEYS.includes('preset'), false);
  assert.ok(Object.isFrozen(PARENT_BLOCK_KEYS) && Object.isFrozen(STAGE_BLOCK_KEYS), '白名单必须冻结');

  /* 两张表都必须有 `meeting` 与 `status`：它们是父子之间唯一的共同语。 */
  for (const shared of ['meeting', 'status']) {
    assert.ok(PARENT_BLOCK_KEYS.includes(shared) && STAGE_BLOCK_KEYS.includes(shared));
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 19. 码名：发射的每个码都必须已登记，或者被显式记账为"待注册"
 *
 * 这一组替掉一个做不到的改法：`codes.mjs` 不按码名导出常量，所以
 * `import { E_LEDGER_PARTIAL } from './codes.mjs'` 会拿到 `undefined`
 * —— 那不是少一个副本，是发射一个没有名字的码。
 * 于是改成机械自检：本文件定义的每个码，拿去问 `isMeetingCode`。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 从源码里抽出本模块**定义**的码名（`const E_X = 'E_X';` 那一行）。 */
function definedCodes(source) {
  const found = [];
  for (const match of String(source).matchAll(/const\s+(E_[A-Z0-9_]+)\s*=\s*'(E_[A-Z0-9_]+)'/g)) {
    found.push({ name: match[1], value: match[2] });
  }
  return found;
}

test('19a. 本模块定义的每个码，要么已在 `codes.mjs` 登记，要么在待注册清单里（不许凭空发明码名）', () => {
  const source = readFileSync(new URL('../src/ledger.mjs', import.meta.url), 'utf8');
  const codes = definedCodes(source);

  /* 扫描器自检：一个都抽不出来 = 正则坏了，不是"没有问题"。 */
  assert.ok(codes.length >= 2, `只抽到 ${codes.length} 个码定义，扫描器坏了`);
  assert.deepEqual(
    codes.map((code) => code.value).sort(),
    ['E_LEDGER_DROPPED', 'E_LEDGER_PARTIAL'],
    '本模块现在只该发射这两个码；多一个就必须同时决定它登记到哪张表',
  );

  const unknown = [];
  for (const code of codes) {
    assert.equal(code.name, code.value, `定义与字面量不一致：${code.name} = '${code.value}'`);
    if (isMeetingCode(code.value)) continue;
    if (PENDING_REGISTRATION.has(code.value)) continue;
    unknown.push(code.value);
  }
  assert.deepEqual(
    unknown,
    [],
    `这些码既没登记在 codes.mjs、也不在待注册清单里（页面拿到会显示"未知门禁"）：${unknown.join('、')}`,
  );
});

test('19b. 待注册清单不许过期：某个码一旦登记了，名字必须从清单里删掉', () => {
  /* 这条防的是"债务清单永久豁免"——本项目在「债务清单自洽」那条断言上翻过车：
   * 旧版本断言 `hits.length <= 1`，等于给三份副本盖章说"允许存在"。
   * 这里反过来：清单里剩下的东西如果已经登记了，就必须红，逼着人把它删掉。 */
  const stale = [...PENDING_REGISTRATION].filter((code) => isMeetingCode(code));
  assert.deepEqual(
    stale,
    [],
    `这些码已经登记进 codes.mjs 了，请把它们从 PENDING_REGISTRATION 里删掉（否则这条豁免永久放行）：${stale.join('、')}`,
  );
});

test('19c. 扫描器自检：凭空多一个没登记的码 → 必须被抓；登记的名字 → 必须放过', () => {
  const withFake = "const E_LEDGER_FAKE = 'E_LEDGER_FAKE';\nconst E_LEDGER_PARTIAL = 'E_LEDGER_PARTIAL';";
  const found = definedCodes(withFake).map((code) => code.value);
  assert.deepEqual(found, ['E_LEDGER_FAKE', 'E_LEDGER_PARTIAL'], '扫描器必须真的抽得出来');

  const unregistered = definedCodes(withFake)
    .map((code) => code.value)
    .filter((value) => !isMeetingCode(value) && !PENDING_REGISTRATION.has(value));
  assert.deepEqual(unregistered, ['E_LEDGER_FAKE'], '凭空发明的码必须进 unknown，否则这条检查是空转的');

  /* 反例自检：`isMeetingCode` 对已登记 / 未登记要给出不同答案，否则上面两行都在比两个空数组。 */
  assert.equal(isMeetingCode('E_LEDGER_PARTIAL'), true);
  assert.equal(isMeetingCode('E_LEDGER_FAKE'), false);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 20. 升级行：`at` / `by` / `reason` 必须真能落盘
 *
 * 这一组守的是一条**承诺**。`meeting.mjs` 的 `applyUpgrade` 在 JSDoc 里写着：
 *   「任何时候回头看，都必须能回答"这场会什么时候从哪个档升到哪个档、为什么"」
 * 而升级行原来只编码成 `旧档位 -> 新档位` —— `at` / `reason` 在落盘那一刻就丢了，
 * 于是那句话是假的。本组钉的就是"那三个问题真的答得出来"。
 *
 * 曾经的写法是「把这条记成一条可接受的损失」。**那不是损失，那是假承诺**：
 * 下一个读注释的人会以为这件事已经被保证了。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 造一个只有会议头的任务树，返回渲染出来的块与块里的升级行。 */
function parentOnly(upgrades) {
  const description = renderParentBlock({
    id: MEETING_ID,
    preset: 'standard@1',
    status: 'running',
    upgrades,
  });
  const upgradeLines = description
    .split('\n')
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => line.trim());
  return { description, upgradeLines };
}

/** 渲染 → 读回，一步到位。 */
function readUpgrades(upgrades) {
  const { description, upgradeLines } = parentOnly(upgrades);
  const read = ledgerFromTasks([{ id: 'T-P', description }]);
  return { read, description, upgradeLines };
}

test('20a. 升级行的编码格式逐字钉住（老形状渲染出来必须与扩展前**逐字相同**）', () => {
  /* 老形状（只有 from/to）不许因为这次扩展被改写一次 —— 否则每一份已有账本
   * 都会在下一次写入时变成一次 diff，而人看不出为什么。 */
  assert.deepEqual(
    parentOnly([{ from: 'lite@1', to: 'standard@1' }]).upgradeLines,
    ['- lite@1 -> standard@1'],
  );
  assert.deepEqual(
    parentOnly([{ from: 'lite@1', to: 'standard@1', at: '2026-11-22T00:10:00+08:00' }]).upgradeLines,
    ['- lite@1 -> standard@1 | at=2026-11-22T00:10:00+08:00'],
  );
  assert.deepEqual(
    parentOnly([{ from: 'lite@1', to: 'standard@1', reason: '连续 3 轮判不动' }]).upgradeLines,
    ['- lite@1 -> standard@1 | reason=连续 3 轮判不动'],
  );
  /* 三个都有时按固定顺序 at / by / reason 渲染（解析不依赖顺序，但渲染必须稳定，
   * 不然每次写入都会因为键顺序不同而算成"变了"，白写一次）。 */
  assert.deepEqual(
    parentOnly([{
      from: 'lite@1', to: 'standard@1', at: 'T1', by: '我', reason: '理由',
    }]).upgradeLines,
    ['- lite@1 -> standard@1 | at=T1 | by=我 | reason=理由'],
  );
});

test('20b. 往返一趟逐字相同：from / to / at / by / reason 五个字段都回得来', () => {
  const original = [{
    from: 'lite@1',
    to: 'standard@1',
    at: '2026-11-22T00:10:00+08:00',
    by: '我',
    reason: '连续 3 轮判不动，冲突数超阈值',
  }];
  const { read } = readUpgrades(original);

  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.ledger.upgrades, original, '五个字段逐个必须回来');

  /* 再走一趟：渲染 → 读回 → 渲染，文本必须稳定（否则每次写都白写一次）。 */
  const again = readUpgrades(read.ledger.upgrades);
  assert.deepEqual(again.read.ledger.upgrades, original);
  assert.deepEqual(again.upgradeLines, parentOnly(original).upgradeLines);
});

test('20c. 老格式向后兼容：只有 `a -> b` 时 at / reason **缺席**，不许因此判账本读不出来', () => {
  const { read } = readUpgrades([{ from: 'lite@1', to: 'standard@1' }]);

  assert.deepEqual(read.errors, [], '旧账本还在用，缺字段不是"读不出来"');
  assert.deepEqual(read.warnings, [], '也不该为此报警 —— 那不是畸形，那是老格式');
  assert.equal(read.reason, 'ok');
  assert.deepEqual(read.ledger.upgrades, [{ from: 'lite@1', to: 'standard@1' }]);
  assert.equal(Object.hasOwn(read.ledger.upgrades[0], 'at'), false, '缺席就是缺席，不许补空串');
  assert.equal(Object.hasOwn(read.ledger.upgrades[0], 'reason'), false);

  /* 缺口径自检：手写的、完全没有附加段的老行也必须照读。 */
  const handWritten = [
    `${FENCE}${MEETING_FENCE_INFO}`,
    `meeting: ${MEETING_ID}`,
    'preset: standard@1',
    'status: running',
    'upgrades:',
    '  - lite@1 -> standard@1',
    FENCE,
  ].join('\n');
  const parsed = ledgerFromTasks([{ id: 'T-P', description: handWritten }]);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.ledger.upgrades, [{ from: 'lite@1', to: 'standard@1' }]);
});

test('20d. 理由里带 `|` 与 `\\`，字段一个都不许串位', () => {
  const reason = '因为 A|B 两种写法都行，而且路径里有个 \\ 反斜杠';
  const { read, upgradeLines } = readUpgrades([{ from: 'lite@1', to: 'standard@1', reason }]);

  assert.deepEqual(read.errors, []);
  assert.equal(read.ledger.upgrades[0].reason, reason, '`|` 与 `\\` 必须原样回来');

  /* 编码面上：分隔符只出现它该出现的次数（两段 = 一个分隔符）。
   * 不转义的话这一行会被切成 3 段，`B 两种写法都行…` 那段会被当成畸形字段丢掉。 */
  assert.equal(upgradeLines.length, 1);
  assert.equal(upgradeLines[0].split(/(?<!\\)\|/).length, 2, '未转义的分隔符只该有一个');
  assert.match(upgradeLines[0], /reason=因为 A\\\|B 两种写法都行/, '理由里的 `|` 必须被转义');

  /* 再走一趟仍然相同（转义不许逐次翻倍）。 */
  const again = readUpgrades(read.ledger.upgrades);
  assert.equal(again.read.ledger.upgrades[0].reason, reason);
  assert.deepEqual(again.upgradeLines, upgradeLines, '转义不许每走一趟就翻一倍');
});

test('20e. 理由里的换行被压平：不许多出一行、不许伪造出字段行', () => {
  const reason = '第一行\nstatus: done\nreason=伪造';
  const { read, description } = readUpgrades([{ from: 'lite@1', to: 'standard@1', reason }]);

  assert.deepEqual(read.errors, []);
  assert.equal(read.ledger.status, 'running', '理由里的 `status: done` 不许改写会议状态');
  assert.equal(read.ledger.upgrades.length, 1, '理由里的 `reason=` 不许伪造出第二条升级记录');
  assert.match(read.ledger.upgrades[0].reason, /^第一行 status: done reason=伪造$/);

  /* 行的层面：块里只许多出那一行升级行（围栏 + meeting/preset/status/upgrades/一条升级 + 围栏 = 7 行），
   * 理由里的两个换行不许把块撑长。判据必须按行首判 —— 上面那行升级行的**内容里**当然含有
   * `status: done` 这几个字（它是被压平的文本），但那是值，不是字段行。 */
  const lines = description.split('\n');
  assert.equal(lines.length, 7, '理由里的换行不许撑出新行');
  assert.equal(
    lines.some((line) => /^\s*status:\s*done/.test(line)),
    false,
    '理由里的 `status: done` 不许变成一行字段',
  );
});

test('20f. 「写了键但值是空」与「根本没写这个键」必须分得开', () => {
  /* 前者 = 升档时没写理由（`applyUpgrade` 写在 `reason: ''`）；
   * 后者 = 老账本根本没有这个字段。抹平就再也分不回来了。 */
  const empty = readUpgrades([{ from: 'lite@1', to: 'standard@1', reason: '' }]);
  assert.deepEqual(empty.read.errors, []);
  assert.deepEqual(empty.upgradeLines, ['- lite@1 -> standard@1 | reason=']);
  assert.deepEqual(empty.read.ledger.upgrades, [{ from: 'lite@1', to: 'standard@1', reason: '' }]);
  assert.equal(Object.hasOwn(empty.read.ledger.upgrades[0], 'reason'), true);

  const absent = readUpgrades([{ from: 'lite@1', to: 'standard@1' }]);
  assert.equal(Object.hasOwn(absent.read.ledger.upgrades[0], 'reason'), false);

  /* 再走一趟：空串仍然是空串，不许被"只给真值才挂键"那条规则顺手抹掉。 */
  assert.equal(Object.hasOwn(readUpgrades(empty.read.ledger.upgrades).read.ledger.upgrades[0], 'reason'), true);
});

test('20g. 畸形的附加段只出声：不是 `键=值`、不认识的键、重复的键，都不许判死账本', () => {
  const text = [
    `${FENCE}${MEETING_FENCE_INFO}`,
    `meeting: ${MEETING_ID}`,
    'preset: standard@1',
    'status: running',
    'upgrades:',
    '  - lite@1 -> standard@1 | 这段不是键值 | who=我 | at=T1 | at=T2',
    FENCE,
  ].join('\n');
  const read = ledgerFromTasks([{ id: 'T-P', description: text }]);

  assert.deepEqual(read.errors, [], '三个小毛病都不许让整份账本读不出来');
  const reasons = read.warnings.filter((warning) => warning.code === E_LEDGER_DROPPED).map((warning) => warning.reason);
  assert.deepEqual(reasons, ['bad-upgrade-field', 'bad-upgrade-field', 'bad-upgrade-field'],
    '三段各报一次：不是键值 / 不认识的键 / 重复的键');
  assert.deepEqual(read.ledger.upgrades, [{ from: 'lite@1', to: 'standard@1', at: 'T1' }],
    '重复的键第一个生效，后一个丢掉');
});

test('20h. `at` 缺失的键不许渲染成 `at=`（`applyUpgrade` 会留下 `at: undefined`）', () => {
  /* `meeting.mjs:582` 写的是 `at: source.at` —— 没给时间时那个键**存在**但值是 undefined。
   * 渲染成 `at=` 就等于凭空断言"时间是空的"，而真相是"这一层根本没有时间可用"。 */
  const { read, upgradeLines } = readUpgrades([{ from: 'lite@1', to: 'standard@1', at: undefined, reason: 'r' }]);

  assert.deepEqual(upgradeLines, ['- lite@1 -> standard@1 | reason=r'], '不许写出 at=');
  assert.deepEqual(read.errors, []);
  assert.equal(Object.hasOwn(read.ledger.upgrades[0], 'at'), false);
});

test('20j. 值一律走文本：数字的 `at` 写进去是十进制字符串，读回来也是字符串', () => {
  /* `applyUpgrade` 的 `at` 由调用方给，完全可能是毫秒数（数字）。块是文本，
   * 所以它落盘成 `at=1795000000000`，读回来是字符串 —— 消费方要当时间用，
   * 走 `resume.mjs` 的 `toMillis` 解析。这条不是"类型丢了"，是"这条通道是文本"。 */
  const epoch = 1795000000000;
  const { read, upgradeLines } = readUpgrades([{ from: 'lite@1', to: 'standard@1', at: epoch }]);

  assert.deepEqual(upgradeLines, [`- lite@1 -> standard@1 | at=${epoch}`]);
  assert.deepEqual(read.errors, []);
  assert.equal(read.ledger.upgrades[0].at, String(epoch), '读回来是字符串，而不是数字');
  assert.equal(typeof read.ledger.upgrades[0].at, 'string');
});

test('20i. 升级行只认 `键=值`：渲染出来的行自己必须能被读回去（编码自洽）', () => {
  /* 这条是给未来改格式的人准备的：任何新加的字段只要不在 `UPGRADE_OPTIONAL_KEYS` 里，
   * 20g 的判据会把它报成"不认识的键"，而 20a 会把新格式钉住。这里只确认
   * "渲染出来的每一个附加段都能被同一次读回吃下去" —— 也就是编码与解码没分家。 */
  const cases = [
    [{ from: 'lite@1', to: 'standard@1', at: 'T' }],
    [{ from: 'lite@1', to: 'standard@1', by: '人' }],
    [{ from: 'lite@1', to: 'standard@1', reason: '' }],
    [{ from: 'lite@1', to: 'standard@1', at: 'T', by: '人', reason: 'r' }],
  ];
  for (const ups of cases) {
    const { read } = readUpgrades(ups);
    assert.deepEqual(read.warnings, [], `渲染出来的行读回去不该有任何 warning：${JSON.stringify(ups)}`);
    assert.deepEqual(read.ledger.upgrades, ups, `编码/解码分家了：${JSON.stringify(ups)}`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 21. `stageTaskIds`：把"块内字段表"挡在导出契约之外
 *
 * 这组守的是一条**纪律**：`stages[].fields` 是本文件的内部表示，不是契约。
 * 谁在外面读 `fields`（`host/index.js` 曾经这么做），本文件一改内部结构，
 * 他那边就静默降级成"这棵树上没有这个阶段" —— 而错法看起来完全正常：
 * 每条 create 都判"找不到阶段 X 的任务 id"，没人会想到是形状不匹配。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 一条只带阶段回执的任务。 */
function stageTask(id, stageId, attempt = 1, status = 'done') {
  return {
    id,
    description: meetingBlock(
      `meeting: ${MEETING_ID}`,
      `stage: ${stageId}`,
      `attempt: ${attempt}`,
      `status: ${status}`,
    ),
  };
}

test('21a. 单阶段单任务：Map 里就是那一条，key/value 都对', () => {
  const tasks = healthyTasks();
  const map = stageTaskIds(tasks);

  assert.ok(map instanceof Map, '返回的必须是 Map（host 按 Map 用）');
  assert.equal(map.size, 1);
  assert.equal(map.get('redteam'), 'T-S', '阶段 redteam 的回执在任务 T-S 上');
  assert.deepEqual(stageTaskIssues(tasks), [], '健康树上没有任何要记账的事');
});

test('21b. 同阶段挂在两条任务上：取**第一条**，而且必须能看出"选了哪条"', () => {
  const tasks = [
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    stageTask('T-S1', 'redteam', 1, 'failed'),
    stageTask('T-S2', 'redteam', 2, 'done'),
  ];

  const map = stageTaskIds(tasks);
  assert.equal(map.get('redteam'), 'T-S1', '规则：按任务数组顺序，第一个生效');

  /* 一张 Map 看不出"选哪条"，所以发声的通道是 `stageTaskIssues` —— 这里必须两条都有。 */
  const issues = stageTaskIssues(tasks);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'duplicate-stage-task');
  assert.equal(issues[0].stageId, 'redteam');
  assert.deepEqual(issues[0].taskIds, ['T-S1', 'T-S2'], '全部候选按顺序列出，一个都不许吞掉');
  assert.equal(issues[0].taken, 'T-S1', '`taken` 必须等于实际生效的那一条，否则读的人还得自己推');
});

test('21c. 父任务的会议头块不产生条目（但同一条 description 里的阶段块照样产）', () => {
  const onlyParent = [{ id: 'T-P', description: meetingBlock(...PARENT_LINES) }];
  assert.equal(stageTaskIds(onlyParent).size, 0, '会议头没有 stage 键，不许凭空产一条');
  assert.deepEqual(stageTaskIssues(onlyParent), []);

  /* "单任务多块"那种排法：一条 description 里既有会议头又有阶段回执 —— 阶段那条要产出。 */
  const both = [{
    id: 'T-BOTH',
    description: [
      meetingBlock(...PARENT_LINES),
      '',
      meetingBlock(`meeting: ${MEETING_ID}`, 'stage: challenge', 'attempt: 1', 'status: done'),
    ].join('\n'),
  }];
  const map = stageTaskIds(both);
  assert.equal(map.size, 1);
  assert.equal(map.get('challenge'), 'T-BOTH');
});

test('21d. `tasks` 不是数组 → 空 Map，不抛（写路径上宁可拿不到 id 也不要炸）', () => {
  for (const bad of [null, undefined, 'x', 42, {}, new Map()]) {
    const map = stageTaskIds(bad);
    assert.ok(map instanceof Map, `stageTaskIds(${String(bad)}) 必须还是 Map`);
    assert.equal(map.size, 0);
    assert.deepEqual(stageTaskIssues(bad), [], '也不许解析出什么"问题"来');
  }
});

test('21e. 纯函数：同一输入两次调用 deepEqual（Map 也一样）', () => {
  const tasks = [
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    stageTask('T-S1', 'challenge'),
    stageTask('T-S2', 'confirm'),
    stageTask('T-S3', 'challenge'),
  ];
  assert.deepEqual(stageTaskIds(tasks), stageTaskIds(tasks));
  assert.deepEqual(stageTaskIssues(tasks), stageTaskIssues(tasks));

  /* 深浅各验一次：`deepEqual` 对 Map 是逐 entry 比的，但顺手钉住"结果不被调用方改坏源"。 */
  const first = stageTaskIds(tasks);
  assert.deepEqual([...first.keys()].sort(), ['challenge', 'confirm']);
  assert.deepEqual([...first.values()].sort(), ['T-S1', 'T-S2', 'T-S3'].filter((id) => id !== 'T-S3'));
});

test('21f. 账本块读不出来的任务 → 不出条目、不抛，但必须记账"为什么少了一条"', () => {
  const tasks = [
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-BAD', description: `${FENCE}${MEETING_FENCE_INFO}\nmeeting: ${MEETING_ID}\nstage: redteam` },
    stageTask('T-S', 'confirm'),
  ];

  const map = stageTaskIds(tasks);
  assert.equal(map.has('redteam'), false, '读不出来就不许猜 —— 猜错会把阶段链到别人的任务上');
  assert.equal(map.get('confirm'), 'T-S', '好的那条照样要出');

  const issues = stageTaskIssues(tasks);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'unreadable-block');
  assert.equal(issues[0].taskId, 'T-BAD', '必须点名是哪条任务，否则"找不到阶段"的人只能去猜');
  assert.deepEqual(issues[0].codes, [E_LEDGER_PARTIAL]);
});

test('21g. `stage:` 后面没有值（写成列表头）不算一条回执', () => {
  const tasks = [{
    id: 'T-X',
    description: meetingBlock(`meeting: ${MEETING_ID}`, 'stage:', 'attempt: 1', 'status: done'),
  }];
  assert.equal(stageTaskIds(tasks).size, 0, '猜一个 id 出来会把阶段链到别人的任务上');
});

test('21h. 两份防线是连着的：重复回执在 `ledgerFromTasks` 里本来就是 blocker', () => {
  /* `stageTaskIds` 的"取第一条"只是"实在要比时按什么比"，
   * 不是"我替你决定哪次尝试才算数" —— 真正的判决在账本层，它是判死。 */
  const tasks = [
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    stageTask('T-S1', 'redteam', 1, 'failed'),
    stageTask('T-S2', 'redteam', 2, 'done'),
  ];
  const read = ledgerFromTasks(tasks);
  assert.equal(read.ledger, null);
  assert.equal(read.reason, 'duplicate-stage');
  assert.equal(stageTaskIds(tasks).size, 1, '即便如此，id 翻译仍要给一个确定的答案（写路径不能因为账本坏掉就无从下手）');
});

test('21i. 不是对象 / 没有 id 的任务 → `bad-task`，不许静默当它不存在', () => {
  const tasks = [null, 42, { description: '没有 id' }, stageTask('T-S', 'redteam')];
  const map = stageTaskIds(tasks);

  assert.equal(map.size, 1);
  assert.equal(map.get('redteam'), 'T-S');
  const reasons = stageTaskIssues(tasks).map((issue) => issue.reason);
  assert.deepEqual(reasons, ['bad-task', 'bad-task', 'bad-task'],
    '三条坏任务各记一次；静默跳过就等于"这张表为什么少一条"永远没人说得清');
  assert.equal(stageTaskIssues(tasks)[0].taskId, null, '没有 id 就如实给 null，不许编一个');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 22. 阶段块记住 `agent` + `agentRoster`：真机的"子会话 id 从哪来"
 *
 * 这一组守的是真机跑不动的那半个问题：`decideAgent` 在**单候选**下把 agentId 判成
 * 调用方自己（`target=agent-me`），而宿主 `sendMessage(sender, targetId, …)` 要求
 * `targetId` 是**直接子会话**。根因不是判错 —— 是**候选目录根本不存在**。
 * 本组钉的就是"这个目录存在，而且读不出来的人不会被静默抹掉"。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 带 agent 的阶段回执块。 */
function agentStageBlock(meetingId, stageId, agentId, attempt = 1) {
  return meetingBlock(
    `meeting: ${meetingId}`,
    `stage: ${stageId}`,
    `attempt: ${attempt}`,
    'status: done',
    `agent: ${agentId}`,
  );
}

test('22a. `agent` 双向承载：渲染写得出、读回逐字相同，且往返稳定', () => {
  const text = renderStageBlock(
    { id: MEETING_ID },
    { stageId: 'redteam', attempt: 1, status: 'done', produced: [], agent: 'agent-critic-1' },
    null,
  );
  assert.match(text, /^agent: agent-critic-1$/m, '块里必须真有这一行');

  const read = ledgerFromTasks([{ id: 'T-P', description: meetingBlock(...PARENT_LINES) }, { id: 'T-S', description: text }]);
  assert.deepEqual(read.errors, []);
  assert.equal(read.ledger.stages[0].agent, 'agent-critic-1');

  /* 再走一趟：渲染 → 读回 → 渲染，文本必须稳定（否则每次写都白写一次）。 */
  const again = renderStageBlock({ id: MEETING_ID }, read.ledger.stages[0], null);
  assert.equal(again, text, '往返一次之后块文本必须逐字相同');
});

test('22b. 老账本（没有 `agent` 键）照读、零 error、零 warning，且读回是**缺席**不是空串', () => {
  /* `healthyTasks()` 的 STAGE_LINES 里没有 `agent` —— 它就是一份老账本。 */
  const read = ledgerFromTasks(healthyTasks());

  assert.deepEqual(read.errors, [], '缺这个可选键不是"读不出来"');
  assert.deepEqual(read.warnings, []);
  assert.equal(read.reason, 'ok');
  assert.equal(Object.hasOwn(read.ledger.stages[0], 'agent'), false,
    '没记过代理 → 键缺席；挂一个空串会让"没记过"和"记了个空"分不开');

  /* 渲染也不许多冒一行。 */
  assert.equal(
    renderStageBlock({ id: MEETING_ID }, read.ledger.stages[0], null).includes('agent:'),
    false,
    '没记过代理的阶段块里不许冒出 `agent:` 这一行',
  );
});

test('22c. 单阶段单代理 → 一条 entry，四个定位字段齐（`role` 故意不挂，见 22j）', () => {
  const tasks = [
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S', description: agentStageBlock(MEETING_ID, 'redteam', 'agent-critic-1') },
  ];
  const roster = agentRoster(tasks);

  assert.equal(roster.entries.length, 1);
  assert.deepEqual(roster.entries[0], {
    agentId: 'agent-critic-1',
    meetingId: MEETING_ID,
    stageId: 'redteam',
    taskId: 'T-S',
    attempt: 1,
  });
  assert.deepEqual(roster.issues, [], '健康的树上没有任何要记账的事');
});

test('22d. 同一个 agentId 跨多场会 → **全部保留、不去重**（那就是复用）', () => {
  /* 名字册回答的是"谁干过哪些活"。去重就回答不了"谁干过几件" —— 而那正是
   * `agentpool` 判"能不能复用 / 跨会议要不要 fork"要看的。 */
  const tasks = [
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-P2', description: meetingBlock('meeting: m-2', 'preset: standard@1', 'status: running') },
    { id: 'T-1', description: agentStageBlock(MEETING_ID, 'challenge', 'agent-critic-1', 1) },
    { id: 'T-2', description: agentStageBlock(MEETING_ID, 'redteam', 'agent-critic-1', 1) },
    { id: 'T-3', description: agentStageBlock('m-2', 'challenge', 'agent-critic-1', 2) },
  ];
  const roster = agentRoster(tasks);

  assert.equal(roster.entries.length, 3, '三处都要在册');
  assert.deepEqual(
    roster.entries.map((entry) => [entry.meetingId, entry.stageId, entry.attempt]),
    [[MEETING_ID, 'challenge', 1], [MEETING_ID, 'redteam', 1], ['m-2', 'challenge', 2]],
    '顺序按遇到顺序；不去重、不合并',
  );
  assert.equal(new Set(roster.entries.map((entry) => entry.agentId)).size, 1, '三条都是同一个人 —— 这正是"复用"');
  assert.deepEqual(roster.issues, []);
});

test('22e. 读不出来的块 → 进 issues，entries 里没有它，**不抛也不静默**', () => {
  const tasks = [
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-BAD', description: `${FENCE}${MEETING_FENCE_INFO}\nmeeting: ${MEETING_ID}\nstage: redteam\nagent: a-1` },
    { id: 'T-S', description: agentStageBlock(MEETING_ID, 'confirm', 'agent-client-1') },
  ];
  const roster = agentRoster(tasks);

  assert.equal(roster.entries.length, 1, '只有读得出来的那条入册');
  assert.equal(roster.entries[0].stageId, 'confirm');

  const bad = roster.issues.filter((issue) => issue.reason === 'unreadable-block');
  assert.equal(bad.length, 1, '读不出来必须出声 —— 静默丢掉等于"这个人不存在"');
  assert.equal(bad[0].taskId, 'T-BAD');
  assert.equal(bad[0].meetingId, null, '块都没读出来，这两件事实是"不知道"，键照给值为 null');
  assert.equal(bad[0].stageId, null);
  assert.deepEqual(bad[0].codes, [E_LEDGER_PARTIAL]);
});

test('22f. 没有 `agent` 的块 → 既不产 entry 也不产 issue（那不是"人不存在"，是"还没做"）', () => {
  /* 老账本、以及所有还没记过代理的阶段都会走这条。这里出声会把名册变成一片噪音。 */
  const roster = agentRoster(healthyTasks());
  assert.deepEqual(roster.entries, []);
  assert.deepEqual(roster.issues, []);
});

test('22g. `tasks` 不是数组 → 空 entries + 空 issues，不抛；纯函数两次 deepEqual', () => {
  for (const bad of [null, undefined, 'x', 42, {}, new Map()]) {
    const roster = agentRoster(bad);
    assert.deepEqual(roster, { entries: [], issues: [] }, `agentRoster(${String(bad)}) 必须是两个空数组`);
  }

  const tasks = [
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S', description: agentStageBlock(MEETING_ID, 'redteam', 'agent-critic-1') },
  ];
  assert.deepEqual(agentRoster(tasks), agentRoster(tasks));
});

test('22h. `agent:` 写成列表头（没有行内值）→ 不算记过代理', () => {
  const tasks = [{
    id: 'T-S',
    description: meetingBlock(
      `meeting: ${MEETING_ID}`,
      'stage: redteam',
      'attempt: 1',
      'status: done',
      'agent:',
      '  - agent-critic-1',
    ),
  }];

  const read = ledgerFromTasks([{ id: 'T-P', description: meetingBlock(...PARENT_LINES) }, ...tasks]);
  assert.equal(Object.hasOwn(read.ledger.stages[0], 'agent'), false, '列表头不是值，不许把它拼成一个 id');
  assert.deepEqual(agentRoster(tasks).entries, [], '猜一个 id 出来会把阶段链到别人的会话上');
});

test('22i. 块里没有 `meeting:` → 照样入册（meetingId: null），但要出声', () => {
  /* 丢掉它就是"这个人不存在"（红线）；而入一条没法按会议过滤的条目又必须让人知道。
   * 两件事一起做：entry 留着、issue 说出来。 */
  const tasks = [{
    id: 'T-S',
    description: meetingBlock('stage: redteam', 'attempt: 1', 'status: done', 'agent: agent-critic-1'),
  }];
  const roster = agentRoster(tasks);

  assert.equal(roster.entries.length, 1, '不许因为缺会议 id 就把人从名册里删掉');
  assert.equal(roster.entries[0].meetingId, null);
  assert.equal(roster.entries[0].agentId, 'agent-critic-1');

  const missing = roster.issues.filter((issue) => issue.reason === 'meeting-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].stageId, 'redteam', 'issue 要能指回是哪一条阶段');
  assert.equal(missing[0].meetingId, null);
});

test('22j. 写了 `agent` 但没有可读的 `stage` → 不入册，但必须记账（不许静默）', () => {
  const tasks = [{
    id: 'T-S',
    description: meetingBlock(`meeting: ${MEETING_ID}`, 'stage:', 'attempt: 1', 'agent: agent-critic-1'),
  }];
  const roster = agentRoster(tasks);

  assert.deepEqual(roster.entries, [], '一条 (null, agentId) 的条目对"该用谁"没有任何用处');
  assert.equal(roster.issues.length, 1);
  assert.equal(roster.issues[0].reason, 'stage-missing');
  assert.equal(roster.issues[0].agentId, 'agent-critic-1', '要说清是谁——否则"少了一条"永远查不下去');
  assert.equal(roster.issues[0].stageId, null);
});

test('22k. `role` 故意不挂：这一层不知道角色，挂个 null 等于让它看起来判过了', () => {
  /* 任务描述给的签名里有 `role`，但 critic / client / architect / dev / qa 只存在于
   * `presets/*.json` 的 `stages[].role`，阶段块里没有这个键，本文件也拿不到预设。
   * 挂一个永远 null 的 role，下游 chooseAgent 会看起来读到了一个真值。
   * 要角色 → 用 stageId 去查预设。所以这里断言"这个键**不存在**"。 */
  const roster = agentRoster([
    { id: 'T-P', description: meetingBlock(...PARENT_LINES) },
    { id: 'T-S', description: agentStageBlock(MEETING_ID, 'redteam', 'agent-critic-1') },
  ]);
  const entry = roster.entries[0];

  assert.equal(Object.hasOwn(entry, 'role'), false, '不许挂一个永远 null 的 role');
  assert.deepEqual(Object.keys(entry).sort(), ['agentId', 'attempt', 'meetingId', 'stageId', 'taskId']);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 22-补. `agent` 的**第三条腿**：写计划
 *
 * `agent` 有三条腿：写（`ledgerWritePlan`）/ 渲染（`renderStageBlock`）/
 * 读（`readStage` + `ledgerFromTasks`）+ 投影（`agentRoster`）。
 * `task-15` 的任务描述只写了"双向承载"两条腿，于是**写那条漏了一个字段**：
 * 读得回来、渲染得出来，写的时候不带它 —— `agent:` 永不落盘 → `agentRoster` 读到空名册 →
 * `decideAgent` 永远走 `fallback-fresh`，而整条链看起来"两边都接好了"。
 *
 * 这是本项目第四次撞上同一形状（只写不读 / 只读不写，两侧看起来都在）。
 * 所以除了修那一行，下面还有第 23 节：**逐键数腿**，让下一个人漏第 5 条时当场红。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('22l. 四步往返：写计划 → 块里有 `agent:` → 读回相同 → 名册里真有这一条', () => {
  /* 只验第一步（渲染分支）等于没验：渲染那一侧早就有牙了（A1 反证）。
   * 这条要从"写计划"一路走到"名册"，中间任何一环断掉都要红。 */
  const prev = [{ id: 'T-P', description: meetingBlock(...PARENT_LINES) }];
  const nextLedger = {
    id: MEETING_ID,
    preset: 'standard@1',
    status: 'running',
    /* `PARENT_LINES` 里有一条 `upgrades: - lite@1 -> standard@1`。目标账本必须与它一致，
     * 否则父块文本不等 → 多算一次父任务 update，下面"只该有 1 次写"就不是我们想验的那条了。 */
    upgrades: [{ from: 'lite@1', to: 'standard@1' }],
    stages: [{
      stageId: 'challenge',
      attempt: 1,
      status: 'done',
      produced: ['questions'],
      agent: 'child-9',
    }],
  };

  /* ① 写计划：新建阶段任务，块文本里必须真有 `agent: child-9` 这一行。 */
  const plan = ledgerWritePlan(prev, nextLedger);
  assert.deepEqual(plan.errors, []);
  const created = plan.creates.find((item) => item.role === 'stage');
  assert.notEqual(created, undefined, '缺阶段任务时应当建一条');
  assert.match(created.description, /^agent: child-9$/m, '写路径不许把 agent 丢掉');

  /* ② 读回：喂给 `ledgerFromTasks`，`ledger.stages[].agent` 必须相同。 */
  const tree = [...prev, { id: 'T-NEW', description: created.description }];
  const read = ledgerFromTasks(tree);
  assert.deepEqual(read.errors, []);
  assert.equal(read.ledger.stages[0].agent, 'child-9');

  /* ③ 投影：名册里真的有这一条（这才是驱动器"下次该用谁"的数据源）。 */
  assert.deepEqual(agentRoster(tree).entries, [{
    agentId: 'child-9',
    meetingId: MEETING_ID,
    stageId: 'challenge',
    taskId: 'T-NEW',
    attempt: 1,
  }]);

  /* ④ 更新路径也要走一遍：`creates` 与 `updates` 是两条代码路，都可能忘了带。 */
  const existingStage = {
    id: 'T-S',
    description: meetingBlock(
      `meeting: ${MEETING_ID}`,
      'stage: challenge',
      'attempt: 1',
      'status: done',
      'produced:',
      '  - questions',
    ),
  };
  const updatePlan = ledgerWritePlan([prev[0], existingStage], nextLedger);
  assert.deepEqual(updatePlan.creates, [], '阶段任务已经在树上了，不该再建一条');
  assert.equal(updatePlan.updates.length, 1);
  assert.match(updatePlan.updates[0].description, /^agent: child-9$/m, '更新路径同样不许把 agent 丢掉');
  assert.equal(
    ledgerFromTasks([prev[0], { id: 'T-S', description: updatePlan.updates[0].description }]).ledger.stages[0].agent,
    'child-9',
  );
});

test('22m. `record.agent` 缺席 → 块里没有 `agent:` 这一行，读回是**缺席**不是空串', () => {
  /* 缺席不许补默认值：补一个空串会让"没记过代理"和"记了个空"分不开，
   * 而 `agentRoster` 会把空串判成"没记过"，看起来一样 —— 于是这个区别永远查不出来。 */
  const prev = [{ id: 'T-P', description: meetingBlock(...PARENT_LINES) }];
  const nextLedger = {
    id: MEETING_ID,
    preset: 'standard@1',
    status: 'running',
    stages: [{ stageId: 'challenge', attempt: 1, status: 'done', produced: ['questions'] }],
  };

  const created = ledgerWritePlan(prev, nextLedger).creates.find((item) => item.role === 'stage');
  assert.equal(created.description.includes('agent:'), false, '缺席时不许冒出这一行');
  assert.equal(/\nagent: *$/m.test(created.description), false, '更不许冒出一个空的 `agent:`');

  const read = ledgerFromTasks([...prev, { id: 'T-NEW', description: created.description }]);
  assert.deepEqual(read.errors, []);
  assert.equal(Object.hasOwn(read.ledger.stages[0], 'agent'), false, '读回必须是缺席');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 23. 逐键数腿：`STAGE_BLOCK_KEYS` 里**每一个键**都必须三条腿都在
 *
 * 这一节是本项目同一形状的第四次之后的产物：**一个只写不读、或只读不写的接口，
 * 看起来两边都在。** 前三次是 `judgeArtifact.warnings`（永远是 `[]`、没人读）、
 * `E_SUGGEST_UPGRADE`（定义完整、判据永不触发）、`writeMeetingLedger`（有实现、零调用方）；
 * 第四次是 `agent` 的写那条 —— 渲染和读都在，写不带它，于是整套东西安静地什么都不做。
 *
 * 所以不再"补一条测试"，而是**让下一个人漏第 5 条时当场红**：
 * 对白名单里的每个键，逐一断言
 *   ① 写：`ledgerWritePlan` 走一遍之后，块文本里有 `<key>:` 这一行；
 *   ② 渲染：`renderStageBlock` 直接喂带该键的记录，输出里有 `<key>:`；
 *   ③ 读：`ledgerFromTasks` 从那段文本读回的值，与喂进去的值 **deepEqual**。
 *
 * 三条对每个键都跑。**注意**：不是每个键都是"用户给的字符串" ——
 * `attempt` / `continues` 是数字、`produced` 是列表、`meeting` 来自会议头。
 * 所以第 ③ 条一律用"读回来的值 deepEqual 喂进去的值"，而不是"文本里出现某个字面量"；
 * 后者对七种形态里的大部分都不成立。
 *
 * 两条防空转：白名单为空、或某个键没有对应夹具 → 直接红（"没扫到"不是"没有问题"）。
 * 这一节**不扫源码**（键名来自常量数组），所以不需要剥注释这一步 —— 见效于键，不生效于文本。
 *
 * ## 这台机器的**边界**（已定论，不要再往上加一层）
 *
 * 它守的是**有登记处的东西**：`STAGE_BLOCK_KEYS` 就是这类东西的登记处，所以"键漏了一条腿"
 * 能被机械发现。它**守不住没有登记处的通道** —— `judgeArtifact.warnings` 那种
 * "永远是 `[]`、没有任何地方读它"的空通道没有键表可数，这台机器看不见它。
 *
 * 所以它的能力边界是：**能挡同类型的第 5、6 条，挡不了换了形状的第 5 条。**
 *
 * 有人提议"再往上一层，对 `ledgerFromTasks` 的返回形状逐字段也数腿"。**定论是：不加。**
 * 两个理由：
 *   1. 那条路验的是**同一件事的第二种说法** —— `ledgerFromTasks` 的
 *      `{ledger, cards, errors, warnings, reason}` 与 `ledger` 各字段已经被冻结测试逐字段钉住了，
 *      再数一遍就是"判据抄第二份"，而副本漂移时没有任何东西报警（本项目栽过三次的那个坑）；
 *   2. 更根本的是：没有登记处的通道该由**"要么给它开一个登记处、要么删掉它"**来治，
 *      不该由"再写一个更通用的扫描器"来治 —— 后者会把"某个通道根本没有登记处"
 *      这个事实**藏起来**，而藏起来的正是下一次要炸的东西。
 *
 * 换句话说：这台机器的价值恰恰在它**只**守有登记处的地方。想让它管更多，
 * 先给那个通道开登记处（一张会被这条测试读到的键表），而不是先扩扫描器。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 块文本里有没有 `<key>:` 这一行（标量与列表的渲染都以 `键:` 开头）。 */
function hasKeyLine(text, key) {
  return String(text).split('\n').some((line) => line.startsWith(`${key}:`));
}

/** 一份"每个键都有真值"的阶段记录。逐键用例都从它出发，只挑该键的那一条腿来验。 */
const LEG_BASE_RECORD = {
  stageId: 'challenge',
  attempt: 3,
  status: 'done',
  produced: ['questions', 'claim'],
  at: '2026-11-22T10:00:00+08:00',
  agent: 'child-9',
  continues: 2,
};

test('23a. `STAGE_BLOCK_KEYS` 逐键数腿：写 / 渲染 / 读，三条缺一条就红', () => {
  /* 防空转第一道：白名单本身不许是空的或者一个键都没有。 */
  assert.ok(Array.isArray(STAGE_BLOCK_KEYS) && STAGE_BLOCK_KEYS.length > 0, '白名单为空 = 这一节空转');
  assert.ok(STAGE_BLOCK_KEYS.every((key) => typeof key === 'string' && key !== ''), '键名必须是非空字符串');

  const parentTask = { id: 'T-P', description: meetingBlock(...PARENT_LINES) };
  const nextLedger = {
    id: MEETING_ID,
    preset: 'standard@1',
    status: 'running',
    stages: [LEG_BASE_RECORD],
  };

  /**
   * 每个键一条夹具：`expected` 是喂进去的值，`readBack` 是"从哪里把它读回来"。
   * `meeting` 与 `continues` 的存在方式与其它键不同，单独说明：
   *   - `meeting` 不是 record 上的字段，它来自会议头的 id；读回来判"没有 meeting-mismatch"。
   *     它若没被写进块里，虽然读这一条仍会过（丢的是 ①② 两条腿的文本检查），
   *     所以三条腿合起来才拦得住。
   *   - `continues` 读回来落在 `meeting.resumes` 上（`record` 里没有这个字段），
   *     所以用 `continueCount` 数回来 —— 与 `recordContinue` 同一口径。
   */
  const legCases = [
    { key: 'meeting', expected: MEETING_ID, readBack: (read) => (read.errors.length === 0 ? MEETING_ID : 'mismatch') },
    { key: 'stage', expected: 'challenge', readBack: (read) => read.ledger.stages[0].stageId },
    { key: 'attempt', expected: 3, readBack: (read) => read.ledger.stages[0].attempt },
    { key: 'status', expected: 'done', readBack: (read) => read.ledger.stages[0].status },
    { key: 'continues', expected: 2, readBack: (read) => continueCount(read.ledger, 'challenge', 3) },
    { key: 'produced', expected: ['questions', 'claim'], readBack: (read) => read.ledger.stages[0].produced },
    { key: 'at', expected: '2026-11-22T10:00:00+08:00', readBack: (read) => read.ledger.stages[0].at },
    { key: 'agent', expected: 'child-9', readBack: (read) => read.ledger.stages[0].agent },
  ];

  /* 防空转第二道：白名单里的每个键都必须有夹具。新加一个键却忘了在这里数腿 → 红。 */
  assert.deepEqual(
    legCases.map((item) => item.key).sort(),
    [...STAGE_BLOCK_KEYS].sort(),
    '白名单里每个键都必须在这里有一条夹具，否则新加的键会静默不被数腿',
  );
  assert.equal(new Set(legCases.map((item) => item.key)).size, STAGE_BLOCK_KEYS.length, '夹具不许重复');

  const failures = [];
  for (const item of legCases) {
    /* ① 写：走一遍 `ledgerWritePlan`，块里必须有这个键。 */
    const plan = ledgerWritePlan([parentTask], nextLedger);
    const created = plan.creates.find((entry) => entry.role === 'stage');
    if (created === undefined) {
      failures.push(`${item.key} / 腿①（写）：连阶段任务都没建出来`);
      continue;
    }
    if (!hasKeyLine(created.description, item.key)) {
      failures.push(`${item.key} / 腿①（写）：块里没有 \`${item.key}:\` —— 写路径把它丢了`);
    }

    /* ② 渲染：直接调渲染器，输出里必须有这个键。 */
    const rendered = renderStageBlock({ id: MEETING_ID }, LEG_BASE_RECORD, null);
    if (!hasKeyLine(rendered, item.key)) {
      failures.push(`${item.key} / 腿②（渲染）：输出里没有 \`${item.key}:\``);
    }

    /* ③ 读：从写出来的那段文本读回，值必须与喂进去的 deepEqual。 */
    const read = ledgerFromTasks([parentTask, { id: 'T-S', description: created.description }]);
    if (read.ledger === null) {
      failures.push(`${item.key} / 腿③（读）：账本读不出来（${read.reason}）`);
      continue;
    }
    try {
      assert.deepEqual(item.readBack(read), item.expected);
    } catch (error) {
      failures.push(`${item.key} / 腿③（读）：读回的值与原值不同（${error.message.split('\n')[0]}）`);
    }
  }

  assert.deepEqual(failures, [], `这些键缺腿：\n  ${failures.join('\n  ')}`);
});