/**
 * agentpool.test.mjs — `src/agentpool.mjs`（复用模式）的测试。
 *
 * 这一层的价值全在**三条硬边界**上，所以测试的重心也在这里：
 * 边界必须是集合运算能判的、必须不能被领导覆盖、必须无条件跑。
 *
 * 另外两组：
 *   - 默认模式的四种情形（方案 §4 的表格逐行）
 *   - `seenIds` 为空**不证明**它没看过（这条是"判不了什么"的机械表达）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_MODES,
  STAGNATION_STREAK,
  intersect,
  defaultAgentMode,
  checkBoundaries,
  explainChoice,
  decideAgent,
  isAgentAllowed,
  checkStageRole,
} from '../src/agentpool.mjs';

/** design 阶段：非盲、architect。 */
const DESIGN = { id: 'design', order: 3, role: 'architect', kind: 'proposal', blind: false, mustProduce: ['decisions'] };
/** redteam 阶段：盲、critic。 */
const REDTEAM = { id: 'redteam', order: 4, role: 'critic', kind: 'proposal', blind: true, mustProduce: ['killScenarios'] };
/** verify 阶段：盲、qa、review。 */
const VERIFY = { id: 'verify', order: 6, role: 'qa', kind: 'review', blind: true, mustProduce: ['verdict'] };
/** confirm 阶段：非盲、architect（用来造"同角色连续非盲"）。 */
const CONFIRM = { id: 'confirm', order: 2, role: 'architect', kind: 'proposal', blind: false, mustProduce: ['requirements'] };

function agent(over = {}) {
  return { id: 'a1', role: 'architect', seenIds: [], meetings: [], ...over };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. 集合运算
 * ═══════════════════════════════════════════════════════════════════════════ */

test('A1a. intersect 只取两端都有的，去重，保持左序', () => {
  assert.deepEqual(intersect(['b', 'a', 'c'], ['a', 'b']), ['b', 'a'], '保持 left 的出现顺序');
  assert.deepEqual(intersect(['a', 'a'], ['a']), ['a'], '去重');
  assert.deepEqual(intersect([], ['a']), []);
  assert.deepEqual(intersect(['a'], []), []);

  /* 非数组 / 非字符串元素一律忽略，不抛 —— 上游可能把畸形账本直接传进来。 */
  for (const bad of [undefined, null, 'a', 1, {}]) {
    assert.deepEqual(intersect(bad, ['a']), [], `intersect(${String(bad)}, …) 必须是空数组`);
    assert.deepEqual(intersect(['a'], bad), []);
  }
  assert.deepEqual(intersect([1, null, 'a', {}], ['a']), ['a'], '元素里的非字符串要被跳过');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. 默认模式：方案 §4 的表格逐行
 * ═══════════════════════════════════════════════════════════════════════════ */

test('A2a. 盲阶段 → fresh，且不可覆盖', () => {
  for (const stage of [REDTEAM, VERIFY]) {
    const result = defaultAgentMode({ stage, candidate: agent() });
    assert.equal(result.mode, 'fresh', `${stage.id} 是盲阶段`);
    assert.equal(result.overridable, false, `${stage.id} 的 fresh 不可覆盖`);
    assert.match(result.reason, /盲审的价值全在/);
  }
});

test('A2b. 已删的判据不许复活：同会议内「连续非盲同角色」不再给 reuse', () => {
  /* 方案 A 删掉了这条判据，理由是它在 `standard@1` / `lite@1` 下**永远不可能触发** ——
   * 两份预设的非盲阶段是 confirm(client) / design(architect) / build(dev)，
   * 每阶段一顶不同帽子，"跨阶段连续同角色"这个前提在结构上不存在。
   *
   * 这条测试就是**删掉它的证据**：构造出它当年唯一能命中的形状
   * （同一 agent、同角色、上一阶段非盲），现在必须**不**给 reuse。
   * 换回旧实现时它会红 —— 那一红的意思就是"死判据被复活了"。 */
  const result = defaultAgentMode({
    stage: DESIGN,
    previousStage: CONFIRM,
    previousAgent: agent({ id: 'a1' }),
    candidate: agent({ id: 'a1' }),
    meetingId: 'meeting-1',
  });
  assert.notEqual(result.mode, 'reuse', '同会议内跨阶段复用那条判据已删，不许再给 reuse');
  assert.equal(result.mode, 'fresh');
  assert.equal(result.rule, 'fallback-fresh');
  assert.match(result.reason, /已删/, '理由里必须说明那条判据已经删了，否则读的人会以为它还在');
});

test('A2c. 跨会议 + 同角色 + 隔离成立 → reuse（方案 A 的正例）', () => {
  /* 用户原话场景：「同一个审核人审完 A 再审 B」。方案 A 允许这件事，
   * 前提是**隔离成立**：这个 agent 没有见过这一阶段要扣住的任何产物。 */
  const result = defaultAgentMode({
    stage: DESIGN, // architect
    candidate: agent({ id: 'a1', role: 'architect', meetings: ['meeting-0'] }),
    meetingId: 'meeting-1',
    withheldIds: ['a0.design.decisions'],
    seenIds: [],
  });
  assert.equal(result.mode, 'reuse');
  assert.equal(result.rule, 'cross-meeting-reuse');
  assert.equal(result.overridable, true, 'reuse 是可以被领导覆盖的');
  assert.match(result.reason, /隔离成立/);
  assert.match(result.reason, /不带任何一场会的结论/, '复用要带的只是角色与规矩，这句话必须说出来');
});

test('A2d. 跨会议 + 同角色 + 它见过那场会的产物 → 不许 reuse（隔离已经破了）', () => {
  const seen = ['a0.design.decisions'];
  const candidate = agent({ id: 'a1', role: 'architect', meetings: ['meeting-0'], seenIds: seen });

  const result = defaultAgentMode({
    stage: DESIGN,
    candidate,
    meetingId: 'meeting-1',
    withheldIds: ['a0.design.decisions'],
  });
  assert.notEqual(result.mode, 'reuse', '隔离破了就不许复用');
  assert.equal(result.mode, 'fresh');

  /* 而且"破了"这件事必须由既有边界说出来，不能只是"没命中"——
   * 否则读者分不清"检查过、不通过"和"根本没检查"。 */
  const boundary = checkBoundaries({
    stage: DESIGN,
    mode: 'reuse',
    agent: candidate,
    seenIds: [],
    withheldIds: ['a0.design.decisions'],
    meetingId: 'meeting-1',
  });
  assert.equal(boundary.ok, false);
  assert.ok(
    boundary.errors.some((e) => e.code === 'E_BLIND_AGENT_REUSED'),
    `隔离被突破必须报 E_BLIND_AGENT_REUSED：${JSON.stringify(boundary.errors)}`,
  );
});

test('A2j. 跨会议 + 同角色，但这一阶段没声明要扣什么 → fresh（隔离无从验证）', () => {
  /* 「空 ≠ 可用」：没有可核对的扣留清单时，`seenIds ∩ withheldIds` 必然为空，
   * 而那个空只证明**没检查**。所以不许据此声称隔离成立。 */
  const result = defaultAgentMode({
    stage: DESIGN,
    candidate: agent({ id: 'a1', role: 'architect', meetings: ['meeting-0'] }),
    meetingId: 'meeting-1',
    withheldIds: [],
  });
  assert.equal(result.mode, 'fresh');
  assert.equal(result.rule, 'fallback-fresh');
  assert.match(result.reason, /隔离无从验证/);
});

test('A2k. 本会议内返工（第 2 轮）→ fork，且理由说清是"返工要看自己上一轮"', () => {
  const result = defaultAgentMode({ stage: DESIGN, candidate: agent({ id: 'a1' }), attempt: 2 });
  assert.equal(result.mode, 'fork');
  assert.equal(result.rule, 'rework-fork');
  assert.match(result.reason, /第 2 轮/);
  assert.match(result.reason, /上一轮/);
});

test('A2l. 第 1 轮不是返工 → 不给 fork（fork 只留给"有上文可继承"的场合）', () => {
  const result = defaultAgentMode({ stage: DESIGN, candidate: agent({ id: 'a1' }), attempt: 1 });
  assert.notEqual(result.mode, 'fork');
});

test('A2f. 跨会议 + 未收敛冲突 → 不许 fork（方案 A 的核心：旧规则方向是反的）', () => {
  /* `fork` **继承上下文**，而跨会议复用要防的正是把上一场会的结论带过来。
   * 旧规则在这里返回 fork，等于把 A 会的结论正大光明地送进 B 会。 */
  const result = defaultAgentMode({
    stage: DESIGN,
    candidate: agent({ id: 'a1', meetings: ['other-meeting'] }),
    meetingId: 'meeting-1',
    otherMeetingConflicts: ['c1'],
  });
  assert.notEqual(result.mode, 'fork', 'fork 继承上下文，跨会议用它等于把上一场的结论带过来');
});

test('A2e. 连续 3 次判 pass → 强制换人，不可覆盖', () => {
  assert.equal(STAGNATION_STREAK, 3);
  const result = defaultAgentMode({ stage: DESIGN, candidate: agent({ passStreak: 3 }) });
  assert.equal(result.mode, 'fresh');
  assert.equal(result.overridable, false, '注意力衰减这件事不该由领导决定要不要管');
  assert.match(result.reason, /注意力已经衰减/);

  /* 2 次还不算 */
  assert.notEqual(defaultAgentMode({ stage: DESIGN, candidate: agent({ passStreak: 2, meetings: [] }) }).overridable, false);
});

test('A2g. 跨会议但没有未收敛冲突 → 不自动 fork', () => {
  const result = defaultAgentMode({
    stage: DESIGN,
    candidate: agent({ id: 'a1', meetings: ['other-meeting'] }),
    meetingId: 'meeting-1',
    otherMeetingConflicts: [],
  });
  assert.notEqual(result.mode, 'fork');
});

test('A2h. 其余一律 fresh，且理由里说明"不确定时选不省"', () => {
  const result = defaultAgentMode({ stage: DESIGN, candidate: agent({ id: 'a1' }) });
  assert.equal(result.mode, 'fresh');
  assert.match(result.reason, /不确定时选不省|没有命中任何复用条件/);
});

test('A2i. 没有阶段 → fresh 兜底并报错，不抛', () => {
  for (const stage of [undefined, null, {}, { id: '' }]) {
    const result = defaultAgentMode({ stage });
    assert.equal(result.mode, 'fresh');
    assert.equal(result.overridable, false);
    assert.ok(result.errors.length > 0);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. 三条硬边界
 * ═══════════════════════════════════════════════════════════════════════════ */

test('A3a. 边界①：seenIds ∩ withheldIds ≠ ∅ 却复用 → E_BLIND_AGENT_REUSED', () => {
  const result = checkBoundaries({
    stage: VERIFY,
    mode: 'reuse',
    agent: agent({ seenIds: ['design.reasoning', 'design.decisions'] }),
    withheldIds: ['design.reasoning'],
    meetingId: 'meeting-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_BLIND_AGENT_REUSED');
  assert.match(result.errors[0].message, /design\.reasoning/, '必须点名泄漏了哪一项');
  assert.deepEqual(result.intersections.leaked, ['design.reasoning']);
});

test('A3b. 边界①对 fork 也生效（fork 不是免死金牌）', () => {
  /* fork 解决的是"跨会议上下文隔离"，不是"看过的东西忘了"。
   * 见过被扣住的产物，无论 reuse 还是 fork 都不能用。 */
  const result = checkBoundaries({
    stage: VERIFY,
    mode: 'fork',
    agent: agent({ seenIds: ['design.reasoning'] }),
    withheldIds: ['design.reasoning'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_BLIND_AGENT_REUSED');
});

test('A3c. 边界②：评审人是被审人自己 → E_SELF_REVIEW（沿用基线码）', () => {
  const result = checkBoundaries({
    stage: VERIFY,
    mode: 'reuse',
    agent: agent({ id: 'a1' }),
    reviewedAgentId: 'a1',
    meetingId: 'meeting-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_SELF_REVIEW', '同一个病用同一个码，不另起名字');
});

test('A3d. 边界②：fork 时放行（fork 是另一份上下文）', () => {
  const result = checkBoundaries({
    stage: VERIFY,
    mode: 'fork',
    agent: agent({ id: 'a1', meetings: ['meeting-1'] }),
    reviewedAgentId: 'a1',
    meetingId: 'meeting-1',
  });
  assert.equal(result.ok, true, `fork 应当放行：${JSON.stringify(result.errors)}`);
});

test('A3e. 边界③：跨会议裸复用 → E_AGENT_SHARED_ACROSS_MEETINGS', () => {
  const result = checkBoundaries({
    stage: DESIGN,
    mode: 'reuse',
    agent: agent({ id: 'a1', meetings: ['other-meeting'] }),
    meetingId: 'meeting-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_AGENT_SHARED_ACROSS_MEETINGS');
  assert.match(result.errors[0].message, /other-meeting/, '必须点名是哪个会');
});

test('A3f. 边界③：同会议内复用不算跨会议', () => {
  const result = checkBoundaries({
    stage: DESIGN,
    mode: 'reuse',
    agent: agent({ id: 'a1', meetings: ['meeting-1'] }),
    meetingId: 'meeting-1',
  });
  assert.equal(result.ok, true);
});

test('A3g. fresh 一律放行（全新 agent 没有"见过什么"）', () => {
  const result = checkBoundaries({
    stage: VERIFY,
    mode: 'fresh',
    agent: agent({ id: 'a1', seenIds: ['design.reasoning'], meetings: ['other'] }),
    withheldIds: ['design.reasoning'],
    reviewedAgentId: 'a1',
    meetingId: 'meeting-1',
  });
  assert.equal(result.ok, true, 'fresh 不需要这些检查');
  /* 但 intersections 仍然算出来给调用方看 —— "它本来见过什么"仍是事实。 */
  assert.deepEqual(result.intersections.leaked, ['design.reasoning']);
});

test('A3h. seenIds 取两处并集：显式给的 + agent 自己记的', () => {
  /* 只看一处会让"账本记了但调用方没传"变成漏检。 */
  const result = checkBoundaries({
    stage: VERIFY,
    mode: 'reuse',
    agent: agent({ seenIds: ['b'] }),
    seenIds: ['a'],
    withheldIds: ['a', 'b'],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.intersections.leaked.sort(), ['a', 'b']);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. 拍板与覆盖
 * ═══════════════════════════════════════════════════════════════════════════ */

test('A4a. 领导不能覆盖不可覆盖的场合（盲阶段）', () => {
  /* 方案原话「三条硬边界（机器拦，领导不能覆盖）」。
   * 而盲阶段 fresh 比硬边界更硬 —— 它是盲审这个机制的定义。 */
  const result = decideAgent({
    stage: REDTEAM,
    candidate: agent({ id: 'a1' }),
    leaderChoice: 'reuse',
    leaderReason: '想省点上下文',
  });
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'fresh', '最终模式必须仍是 fresh');
  assert.equal(result.defaultMode, 'fresh');
  assert.equal(result.overridden, false, '不许记成"覆盖成功"');
  assert.equal(result.errors[0].code, 'E_BLIND_AGENT_REUSED');
  assert.match(result.errors[0].message, /不可覆盖/);
});

test('A4b. 可覆盖的场合：允许改，但没写理由要出声', () => {
  const noReason = decideAgent({ stage: DESIGN, candidate: agent({ id: 'a1' }), leaderChoice: 'reuse' });
  assert.equal(noReason.ok, true, '缺理由不阻断（方案把这类码放在批 3）');
  assert.equal(noReason.mode, 'reuse');
  assert.equal(noReason.overridden, true);
  assert.ok(noReason.warnings.some((w) => w.code === 'E_AGENT_OVERRIDE_NO_REASON'));
  /* 收窄的证据：换人没写理由**不许**再借用升档那条码 ——
   * 否则页面会对着一次换人说「不知道为什么多跑了几个阶段」。 */
  assert.equal(
    noReason.warnings.some((w) => w.code === 'E_UPGRADE_NO_REASON'),
    false,
    '覆盖复用模式不是升档，不许借升档的码',
  );

  const withReason = decideAgent({
    stage: DESIGN,
    candidate: agent({ id: 'a1' }),
    leaderChoice: 'reuse',
    leaderReason: '这活跟上一阶段是同一块代码',
  });
  assert.deepEqual(withReason.warnings, []);
  assert.match(withReason.reason, /领导覆盖：fresh → reuse/);
});

test('A4c. 边界在覆盖之后仍然无条件跑', () => {
  /* 顺序是有意的：先算默认 → 让领导覆盖 → 最后跑边界。
   * 如果边界跑在覆盖之前，一次覆盖就能绕过它。
   *
   * **这条测试第一版写错了**：我原本用 `VERIFY`（盲阶段），
   * 但盲阶段的覆盖在边界之前就被拒了，于是"边界有没有跑"这件事根本不成立 ——
   * 测试绿着，却什么都没验到。改成非盲的 `DESIGN`：覆盖真的成功，
   * 然后看边界是否仍然拦住泄漏。
   * 这就是"红不了就说明测试没牙"的价值。 */
  const result = decideAgent({
    stage: DESIGN,
    candidate: agent({ id: 'a1', seenIds: ['design.reasoning'], meetings: ['meeting-1'] }),
    seenIds: ['design.reasoning'],
    withheldIds: ['design.reasoning'],
    leaderChoice: 'reuse',
    leaderReason: '就它了',
  });
  assert.equal(result.overridden, true, '前置：非盲阶段的覆盖必须真的成功');
  assert.equal(result.mode, 'reuse');
  assert.equal(result.ok, false, '领导覆盖成功了，边界照样拦');
  assert.equal(result.errors[0].code, 'E_BLIND_AGENT_REUSED');
});

test('A4d. 非法 leaderChoice → 报错，不静默回退', () => {
  const result = decideAgent({ stage: DESIGN, candidate: agent(), leaderChoice: 'reus' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_ARTIFACT_MALFORMED');
});

test('A4e. 没给 leaderChoice 就不算覆盖', () => {
  const result = decideAgent({ stage: DESIGN, candidate: agent({ id: 'a1' }) });
  assert.equal(result.overridden, false);
  assert.equal(result.mode, result.defaultMode);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. 判断依据与"判不了什么"
 * ═══════════════════════════════════════════════════════════════════════════ */

test('A5a. explainChoice 给全四样依据（方案 §4 原话）', () => {
  const evidence = explainChoice({
    stage: DESIGN,
    agent: agent({ id: 'a1', seenIds: ['x', 'y'] }),
    withheldIds: ['y', 'z'],
    completedStages: 2,
    roleStats: { pass: 5, fail: 1 },
  });
  assert.equal(evidence.stageId, 'design');
  assert.equal(evidence.blind, false);
  assert.equal(evidence.agentId, 'a1');
  assert.deepEqual(evidence.seenIds.sort(), ['x', 'y']);
  assert.deepEqual(evidence.withheldIds.sort(), ['y', 'z']);
  assert.deepEqual(evidence.leaked, ['y'], '泄漏项要直接摆出来');
  assert.equal(evidence.contextSaving.stages, 2);
  assert.deepEqual(evidence.roleStats, { pass: 5, fail: 1 });
});

test('A5b. contextSaving 是对象不是裸数字（防止被当成事实引用）', () => {
  /* 一个裸数字 `2` 会被当成精确值，对象 + note 不会。 */
  const evidence = explainChoice({ stage: DESIGN, completedStages: 2 });
  assert.equal(typeof evidence.contextSaving, 'object');
  assert.match(evidence.contextSaving.note, /粗略估计/);
  assert.match(evidence.contextSaving.note, /不知道/);
});

test('A5c. seenIds 为空**不证明**它没看过 —— 这句话必须出现在 cannotJudge 里', () => {
  /* 这是本模块最重要的一条边界声明。
   * `seenIds` 是账本记的"它见过哪些产物"，而 agent **可能见过却没被记上**
   * （比如它自己读过文件）。所以空集合只证明"账本上没记"，
   * 不证明"确认干净" —— 不说出来，"检查通过"就会被当成"确认干净"。 */
  const result = decideAgent({ stage: DESIGN, candidate: agent({ id: 'a1', seenIds: [] }) });
  assert.match(result.cannotJudge, /不证明/);
  assert.match(result.cannotJudge, /账本上没记/);
});

test('A5d. 每次 decideAgent 都带 cannotJudge 与 evidence', () => {
  for (const input of [
    { stage: DESIGN, candidate: agent() },
    { stage: REDTEAM, candidate: agent() },
    { stage: undefined },
    { stage: VERIFY, mode: 'fresh' },
  ]) {
    const result = decideAgent(input);
    assert.equal(typeof result.cannotJudge, 'string');
    assert.ok(result.cannotJudge.length > 10, '判不了什么必须写清');
    assert.equal(typeof result.evidence, 'object');
  }
});

test('A5e. 三种模式各自都要说出"为什么复用/为什么没复用"，且判定依据里带着命中的判据', () => {
  /* 方案 A 第 4 条：`explainChoice` 跟着更新 —— 每种模式的理由必须能读。
   * 只给 `mode` 读者不知道凭什么；只给 `reason` 机器没法分组统计。所以三样都要，且都要非空。 */
  const cases = [
    { label: 'fresh（盲阶段）', input: { stage: VERIFY, candidate: agent({ id: 'a1' }) }, mode: 'fresh' },
    {
      label: 'reuse（跨会议 + 同角色 + 隔离成立）',
      input: {
        stage: DESIGN,
        candidate: agent({ id: 'a1', role: 'architect', meetings: ['meeting-0'] }),
        meetingId: 'meeting-1',
        withheldIds: ['a0.design.decisions'],
      },
      mode: 'reuse',
    },
    { label: 'fork（本会议内返工）', input: { stage: DESIGN, candidate: agent({ id: 'a1' }), attempt: 2 }, mode: 'fork' },
  ];

  for (const item of cases) {
    const result = decideAgent(item.input);
    assert.equal(result.mode, item.mode, item.label);
    assert.equal(typeof result.rule, 'string', `${item.label}：decideAgent 必须回报命中的判据名`);
    assert.notEqual(result.rule, '', `${item.label}：判据名不许空`);
    assert.equal(result.evidence.mode, item.mode, `${item.label}：evidence 里必须带着结论`);
    assert.equal(result.evidence.rule, result.rule, `${item.label}：evidence 与顶层不许分叉`);
    assert.equal(typeof result.evidence.reason, 'string', `${item.label}：evidence.reason 必须是字符串`);
    assert.ok(result.evidence.reason.length > 20, `${item.label}：理由要能读，不许一句"默认 fresh"`);
    assert.equal(result.evidence.reason, result.reason, `${item.label}：两处理由必须逐字相同`);
  }

  /* 反例：没有阶段时也必须给出 rule，不许留空让页面显示空白。 */
  const noStage = decideAgent({ stage: undefined });
  assert.equal(noStage.rule, 'no-stage');
  assert.equal(noStage.mode, 'fresh');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. 常量与快速闸门
 * ═══════════════════════════════════════════════════════════════════════════ */

test('A6a. AGENT_MODES 冻结且就是三档', () => {
  assert.deepEqual([...AGENT_MODES], ['fresh', 'reuse', 'fork']);
  assert.ok(Object.isFrozen(AGENT_MODES));
});

test('A6b. isAgentAllowed 是 checkBoundaries 的布尔投影', () => {
  assert.equal(isAgentAllowed({ stage: DESIGN, mode: 'reuse', agent: agent({ meetings: ['meeting-1'] }), meetingId: 'meeting-1' }), true);
  assert.equal(isAgentAllowed({ stage: DESIGN, mode: 'reuse', agent: agent({ meetings: ['other'] }), meetingId: 'meeting-1' }), false);
});

test('A6c. checkStageRole 只拦"kind 不是已知类型"这一种矛盾', () => {
  assert.equal(checkStageRole(DESIGN).ok, true);
  assert.equal(checkStageRole({ id: 'x', kind: 'frame' }).ok, false);
  assert.equal(checkStageRole({ id: 'x', kind: 'frame' }).errors[0].code, 'E_ARTIFACT_MALFORMED');
  assert.equal(checkStageRole(null).ok, false, '没有阶段也算不通过');
});

test('A6d. 边界①与②可以同时命中，一次全报（不 early return）', () => {
  /* 边界③（跨会议 + 隔离无从验证）**不在这一组里**，原因是它现在与①互斥 ——
   * 见 A6e。这里只证明"该同时报的确实同时报了"。 */
  const result = checkBoundaries({
    stage: VERIFY,
    mode: 'reuse',
    agent: agent({ id: 'a1', seenIds: ['design.reasoning'], meetings: [] }),
    withheldIds: ['design.reasoning'],
    reviewedAgentId: 'a1',
    meetingId: 'meeting-1',
  });
  assert.equal(result.ok, false);
  const codes = result.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ['E_BLIND_AGENT_REUSED', 'E_SELF_REVIEW'], '两条边界必须一次全报出来');
});

test('A6e. 边界①与③结构上互斥：一个判"破了"，一个判"无从验证"', () => {
  /* 方案 A 之后，③ 的判据是「跨会议复用 + 这一阶段**没有声明**要扣住的东西」。
   * 而 ① 的判据是「`seenIds ∩ withheldIds ≠ ∅`」。
   * 前者要求 withheld 为空、后者要求 withheld 非空 —— 同一个输入不可能两条同时成立。
   *
   * 这不是巧合，是分工：① 说"隔离已经破了"，③ 说"隔离根本没检查"。
   * 把它们合成一条，读者就分不清"检查过、不通过"和"没检查" ——
   * 那正是本项目反复治的病（空 ≠ 可用）。 */
  const crossed = agent({ id: 'a1', meetings: ['other-meeting'] });

  const verifiedNothing = checkBoundaries({
    stage: DESIGN,
    mode: 'reuse',
    agent: crossed,
    seenIds: [],
    withheldIds: [],
    meetingId: 'meeting-1',
  });
  assert.deepEqual(
    verifiedNothing.errors.map((e) => e.code),
    ['E_AGENT_SHARED_ACROSS_MEETINGS'],
    '没有可核对的扣留清单时只能报③，不许报①（①会说"你破了隔离"，而其实什么都没检查）',
  );

  const broken = checkBoundaries({
    stage: DESIGN,
    mode: 'reuse',
    agent: agent({ id: 'a1', meetings: ['other-meeting'], seenIds: ['x'] }),
    seenIds: [],
    withheldIds: ['x'],
    meetingId: 'meeting-1',
  });
  assert.deepEqual(
    broken.errors.map((e) => e.code),
    ['E_BLIND_AGENT_REUSED'],
    '隔离确实破了就报①，不许再叠一条③',
  );
});
