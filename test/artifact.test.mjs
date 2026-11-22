/**
 * artifact.test.mjs — `src/artifact.mjs`（方案卡与收敛规则）的测试。
 *
 * 这一层补齐了批 1 剩下的四个码：
 *   `E_CLAIM_MULTIPLE` / `E_NO_CHALLENGE` / `E_NO_KILL_SCENARIO` / `E_NO_SIGNOFF`
 *
 * 测试重心在三处：
 *   ① 字段门槛是**数据**（同一字段不同档位门槛不同：standard ≥3、lite ≥2）
 *   ② 四条收敛规则的四条硬规矩，特别是 R2 空交集**不许改写成 R4**
 *   ③ 本层的局限必须被断言钉住（"形状对但内容错的卡在这里全绿"）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BASIS_KINDS,
  CONFLICT_KINDS,
  RESOLUTION_RULES,
  normalizeArtifact,
  judgeArtifact,
  detectConflicts,
  hasVerifyEvidence,
  suggestRule,
  checkResolution,
  resolveConflict,
  conservativeStreak,
  judgeBatch,
} from '../src/artifact.mjs';

const STANDARD = JSON.parse(readFileSync(new URL('../presets/standard@1.json', import.meta.url), 'utf8'));
const LITE = JSON.parse(readFileSync(new URL('../presets/lite@1.json', import.meta.url), 'utf8'));

/** 按 id 取阶段。 */
function stageOf(preset, id) {
  const found = preset.stages.find((s) => s.id === id);
  assert.notEqual(found, undefined, `预设里没有 ${id} 阶段`);
  return found;
}

const codes = (result) => result.errors.map((e) => e.code);

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. 规范化
 * ═══════════════════════════════════════════════════════════════════════════ */

test('C1a. 规范化后每个已知字段都在（下游好取值）', () => {
  const { card } = normalizeArtifact({ id: 'c1', claim: 'A' });
  for (const field of ['basis', 'risks', 'needsHuman', 'conflictsWith', 'dropped']) {
    assert.ok(Array.isArray(card[field]), `${field} 必须是数组`);
  }
  assert.equal(card.id, 'c1');
  assert.equal(card.claim, 'A');
  assert.equal(card.claimCount, 1);
});

test('C1b. claim 三种写法：字符串 / 单元素数组 / 多元素数组', () => {
  assert.equal(normalizeArtifact({ id: 'c', claim: 'A' }).card.claimCount, 1);
  assert.equal(normalizeArtifact({ id: 'c', claim: ['A'] }).card.claimCount, 1);
  assert.equal(normalizeArtifact({ id: 'c', claim: ['A', 'B'] }).card.claimCount, 2);
  /* 空串与空数组都算"没有主张" */
  assert.equal(normalizeArtifact({ id: 'c', claim: '' }).card.claimCount, 0);
  assert.equal(normalizeArtifact({ id: 'c', claim: [] }).card.claimCount, 0);
  assert.equal(normalizeArtifact({ id: 'c', claim: ['', '  '] }).card.claimCount, 0);
});

test('C1c. 其余字段必须原样带过去（第一版漏了这一步，全判"缺字段"）', () => {
  /* 这是实测挖出来的 bug：`normalizeArtifact` 原本只复制固定几个字段，
   * 于是 `questions` / `killScenarios` / `decision` 压根没进 card，
   * `judgeArtifact` 里 `card[field]` 恒为 undefined —— **每一张卡都判缺字段**，
   * 交齐 3 条 killScenarios 也照报"数量不够"。
   * 一个把所有正确输入都判成错的判据，比没有判据更坏。 */
  const { card } = normalizeArtifact({
    id: 'c1',
    claim: 'A',
    questions: ['q1'],
    killScenarios: ['k1', 'k2', 'k3'],
    decision: 'accept',
    verdict: 'pass',
    findings: ['f1'],
    changed: ['x'],
  });
  assert.deepEqual(card.questions, ['q1']);
  assert.deepEqual(card.killScenarios, ['k1', 'k2', 'k3']);
  assert.equal(card.decision, 'accept');
  assert.equal(card.verdict, 'pass');
  assert.deepEqual(card.changed, ['x']);
});

test('C1d. 危险键必须挡在门外（原型不许被改）', () => {
  /* 这条测试第一版没有实际约束力：我用 `Object.hasOwn(card, '__proto__')` 断言，
   * 而给普通对象赋 `__proto__` **不会**产生自有属性 —— 无论有没有拦，那个断言都过。
   * 真正的危害是**原型被换掉**：`card.__proto__ = {hacked:true}` 之后
   * `card.hacked === true`，于是任何 `card.hacked` 的读取都会拿到攻击者的值。
   * 所以断言必须落在 `card.hacked` 上。 */
  const raw = JSON.parse('{"id":"c","claim":"A","__proto__":{"hacked":true}}');
  const { card } = normalizeArtifact(raw);
  assert.equal(Object.hasOwn(card, '__proto__'), false, '__proto__ 不许被复制进来');
  assert.equal(card.hacked, undefined, '原型不许被改 —— 这是真正的危害');
  assert.equal({}.hacked, undefined, '全局原型必须没有被污染');

  /* `constructor` / `prototype` 同理：它们能改到原型链上的东西。 */
  const raw2 = JSON.parse('{"id":"c","claim":"A","constructor":{"bad":1},"prototype":{"bad":2}}');
  const second = normalizeArtifact(raw2);
  assert.equal(Object.hasOwn(second.card, 'constructor'), false);
  assert.equal(Object.hasOwn(second.card, 'prototype'), false);
});

test('C1e. basis 逐条校验：kind 白名单 + ref 非空', () => {
  assert.deepEqual([...BASIS_KINDS], ['verify', 'file', 'test', 'assert']);

  const bad = normalizeArtifact({
    id: 'c',
    claim: 'A',
    basis: [{ kind: 'guess', ref: 'x' }, { kind: 'file', ref: '' }, { kind: 'verify', ref: 'ok' }],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2, '两条坏依据各报一条');
  assert.deepEqual(bad.card.basis, [{ kind: 'verify', ref: 'ok' }], '只有合法那条留下');
});

test('C1f. 非对象入参不抛', () => {
  for (const bad of [null, undefined, 1, 'x', []]) {
    const result = normalizeArtifact(bad);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'E_ARTIFACT_MALFORMED');
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. 字段级门禁（批 1 那四个码）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('C2a. E_CLAIM_MULTIPLE：一张卡两个主张', () => {
  const result = judgeArtifact({
    stage: stageOf(STANDARD, 'challenge'),
    raw: { id: 'c1', claim: ['把右栏置顶', '顺便改个颜色'], questions: ['q'] },
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('E_CLAIM_MULTIPLE'));
  const error = result.errors.find((e) => e.code === 'E_CLAIM_MULTIPLE');
  assert.match(error.message, /把右栏置顶/);
  assert.match(error.message, /顺便改个颜色/, '必须把两个主张都列出来');
  assert.match(error.message, /拆成两张卡/);
});

test('C2b. E_NO_CHALLENGE：反方一个问题都没提', () => {
  const stage = stageOf(STANDARD, 'challenge');
  assert.deepEqual(codes(judgeArtifact({ stage, raw: { id: 'c', claim: 'A', questions: [] } })), ['E_NO_CHALLENGE']);
  assert.deepEqual(codes(judgeArtifact({ stage, raw: { id: 'c', claim: 'A', questions: ['q'] } })), []);
});

test('C2c. E_NO_KILL_SCENARIO：门槛来自预设数据，不是硬编码', () => {
  /* 同一个字段，两个档位门槛不同：
   *   standard@1 的 redteam → ≥3
   *   lite@1 的 design     → ≥2
   * 门槛写死在逻辑里就意味着"加一档要改代码"，而方案第一条原则是"加一档 = 加一个文件"。 */
  const standard = stageOf(STANDARD, 'redteam');
  const lite = stageOf(LITE, 'design');
  assert.equal(standard.minCount.killScenarios, 3);
  assert.equal(lite.minCount.killScenarios, 2);

  const two = ['a', 'b'];
  const three = ['a', 'b', 'c'];

  assert.ok(codes(judgeArtifact({ stage: standard, raw: { id: 'c', claim: 'A', killScenarios: two } })).includes('E_NO_KILL_SCENARIO'),
    'standard 门槛 3，交 2 条必须报');
  assert.deepEqual(codes(judgeArtifact({ stage: standard, raw: { id: 'c', claim: 'A', killScenarios: three } })), []);

  assert.deepEqual(codes(judgeArtifact({ stage: lite, raw: { id: 'c', claim: 'A', decisions: ['d'], killScenarios: two } })), [],
    'lite 门槛 2，交 2 条应当通过 —— 同字段不同档位门槛不同');
});

test('C2d. E_NO_SIGNOFF：结论必须是明确的要 / 不要', () => {
  const stage = stageOf(STANDARD, 'signoff');
  for (const bad of ['maybe', 'ok', '', undefined, 1, null]) {
    const result = judgeArtifact({ stage, raw: { id: 'c', claim: 'A', decision: bad } });
    assert.ok(codes(result).includes('E_NO_SIGNOFF'), `decision=${JSON.stringify(bad)} 必须报`);
  }
  for (const good of ['accept', 'reject']) {
    assert.deepEqual(codes(judgeArtifact({ stage, raw: { id: 'c', claim: 'A', decision: good } })), []);
  }
});

test('C2e. E_ARTIFACT_MISSING：必产字段没交（与"交了个空列表"不是一回事）', () => {
  const stage = stageOf(STANDARD, 'verify');

  /* findings 缺键 → 没交 */
  assert.ok(codes(judgeArtifact({ stage, raw: { id: 'c', claim: 'A', verdict: 'pass' } })).includes('E_ARTIFACT_MISSING'));
  /* findings 是空数组 → 也是"没交"（这个字段没有数量门槛，空数组等于空） */
  assert.ok(codes(judgeArtifact({ stage, raw: { id: 'c', claim: 'A', verdict: 'pass', findings: [] } })).includes('E_ARTIFACT_MISSING'));
  /* 有一条就不是缺 */
  assert.deepEqual(codes(judgeArtifact({ stage, raw: { id: 'c', claim: 'A', verdict: 'pass', findings: ['f'] } })), []);
});

test('C2f. 缺 claim 单独报 E_ARTIFACT_MISSING，且文案说清为什么', () => {
  const result = judgeArtifact({ stage: stageOf(STANDARD, 'challenge'), raw: { id: 'c', questions: ['q'] } });
  const error = result.errors.find((e) => e.code === 'E_ARTIFACT_MISSING' && e.message.includes('没有 claim'));
  assert.notEqual(error, undefined);
  assert.match(error.message, /说不出主张的卡等于什么都没说/);
});

test('C2g. 一次报全部，不 early return', () => {
  /* 一张卡同时犯三样错，三类码都要出来 —— 否则改一处跑一次。 */
  const result = judgeArtifact({
    stage: stageOf(STANDARD, 'challenge'),
    raw: { id: 'c', claim: ['A', 'B'], questions: [] },
  });
  assert.equal(new Set(codes(result)).size >= 2, true, `应当报多个码：${JSON.stringify(codes(result))}`);
});

test('C2h. 每次判定都带 cannotJudge，且点明"形状对但内容错的卡在这里全绿"', () => {
  const result = judgeArtifact({ stage: stageOf(STANDARD, 'challenge'), raw: { id: 'c', claim: 'A', questions: ['q'] } });
  assert.equal(result.ok, true);
  assert.match(result.cannotJudge, /形状/);
  assert.match(result.cannotJudge, /错的卡/);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. 冲突配对
 * ═══════════════════════════════════════════════════════════════════════════ */

test('C3a. 按 conflictsWith 配成对，双向只算一条', () => {
  const { conflicts, errors } = detectConflicts({
    cards: [
      { id: 'a', claim: 'A', conflictsWith: ['b'], basis: [] },
      { id: 'b', claim: 'B', conflictsWith: ['a'], basis: [] },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(conflicts.length, 1, '双向互指只算一条');
  assert.deepEqual(conflicts[0].between.sort(), ['a', 'b']);
});

test('C3b. 指不存在的 id → 报错（指错与没指一样，但更易被误读）', () => {
  const { conflicts, errors } = detectConflicts({ cards: [{ id: 'a', claim: 'A', conflictsWith: ['ghost'] }] });
  assert.equal(conflicts.length, 0);
  assert.equal(errors[0].code, 'E_ARTIFACT_MALFORMED');
  assert.match(errors[0].message, /ghost/);
});

test('C3c. 自己指自己 → 报 E_CONFLICT_UNRESOLVED', () => {
  const { errors } = detectConflicts({ cards: [{ id: 'a', claim: 'A', conflictsWith: ['a'] }] });
  assert.equal(errors[0].code, 'E_CONFLICT_UNRESOLVED');
  assert.match(errors[0].message, /自己与自己的冲突没有裁定对象/);
});

test('C3d. 类别只按可机械判定的证据猜，猜不出记 gap', () => {
  assert.deepEqual([...CONFLICT_KINDS], ['contradiction', 'gap', 'risk']);

  const contradiction = detectConflicts({
    cards: [
      { id: 'a', claim: 'A', conflictsWith: ['b'], basis: [{ kind: 'verify', ref: 'x' }] },
      { id: 'b', claim: 'B', basis: [] },
    ],
  });
  assert.equal(contradiction.conflicts[0].kind, 'contradiction', '一方有证据一方没有');

  const gap = detectConflicts({
    cards: [
      { id: 'a', claim: 'A', conflictsWith: ['b'], basis: [] },
      { id: 'b', claim: 'B', basis: [] },
    ],
  });
  assert.equal(gap.conflicts[0].kind, 'gap');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. 四条收敛规则与四条硬规矩
 * ═══════════════════════════════════════════════════════════════════════════ */

test('C4a. 规则白名单与建议顺序：先证据、再类别、最后升级', () => {
  assert.deepEqual([...RESOLUTION_RULES], [
    'R1-evidence-wins',
    'R2-intersection',
    'R3-scope-take-smaller',
    'R4-escalate',
  ]);

  const cardsById = new Map([
    ['a', { id: 'a', basis: [{ kind: 'verify', ref: 'x' }] }],
    ['b', { id: 'b', basis: [] }],
  ]);

  /* build 之前 R1 不触发 —— 那时"可复核的依据"只能是设想 */
  assert.equal(
    suggestRule({ between: ['a', 'b'], kind: 'contradiction' }, { cardsById, fromBuildStage: false }).rule,
    'R3-scope-take-smaller',
  );
  /* build 起 R1 才出现，且优先于类别判断 */
  assert.equal(
    suggestRule({ between: ['a', 'b'], kind: 'contradiction' }, { cardsById, fromBuildStage: true }).rule,
    'R1-evidence-wins',
  );

  assert.equal(suggestRule({ between: ['a', 'b'], kind: 'gap' }, {}).rule, 'R2-intersection');
  assert.equal(suggestRule({ between: ['a', 'b'], kind: 'risk' }, {}).rule, 'R4-escalate');
});

test('C4b. hasVerifyEvidence 只认 kind=verify 且 ref 非空', () => {
  assert.equal(hasVerifyEvidence({ basis: [{ kind: 'verify', ref: 'x' }] }), true);
  assert.equal(hasVerifyEvidence({ basis: [{ kind: 'verify', ref: '' }] }), false);
  assert.equal(hasVerifyEvidence({ basis: [{ kind: 'file', ref: 'x' }] }), false);
  assert.equal(hasVerifyEvidence({ basis: [] }), false);
  assert.equal(hasVerifyEvidence(null), false);
});

test('C4c. 硬规矩 1：没有 resolution 又没标 needsHuman → 两条都要报', () => {
  const check = checkResolution({ id: 'x', needsHuman: false });
  assert.equal(check.ok, false);
  assert.equal(check.errors[0].code, 'E_CONFLICT_UNRESOLVED');
  assert.equal(check.needsHuman, true, '"没有规则可裁"这件事必须传到页面，而不只是变成一条码');
});

test('C4d. 硬规矩 2：rule / decided / reason 缺一不可', () => {
  const base = { id: 'x', needsHuman: false };

  const noDecided = checkResolution({ ...base, resolution: { rule: 'R4-escalate', reason: 'r' } });
  assert.ok(noDecided.errors.some((e) => e.message.includes('没有 decided')));

  const noReason = checkResolution({ ...base, resolution: { rule: 'R4-escalate', decided: ['a'] } });
  assert.ok(noReason.errors.some((e) => e.message.includes('没有 reason')));

  const badRule = checkResolution({ ...base, resolution: { rule: 'R9-magic', decided: ['a'], reason: 'r' } });
  assert.ok(badRule.errors.some((e) => e.code === 'E_CONFLICT_UNRULED'));
  assert.match(badRule.errors.find((e) => e.code === 'E_CONFLICT_UNRULED').message, /写不出规则的局面一律 needsHuman/);
});

test('C4e. 硬规矩 3：R2 / R3 必须记 dropped[]', () => {
  for (const rule of ['R2-intersection', 'R3-scope-take-smaller']) {
    const missing = checkResolution({ id: 'x', resolution: { rule, decided: ['a'], reason: 'r' } });
    assert.equal(missing.ok, false, `${rule} 缺 dropped[] 必须报`);
    assert.ok(missing.errors.some((e) => e.message.includes('dropped')));

    const ok = checkResolution({ id: 'x', resolution: { rule, decided: ['a'], reason: 'r', dropped: ['被删的原文'] } });
    assert.equal(ok.ok, true, `${rule} 记了 dropped[] 就通过：${JSON.stringify(ok.errors)}`);
  }
});

test('C4f. 硬规矩 4：R2 交集为空 → 保留 rule=R2 与 decided=[]，不许改写成 R4', () => {
  /* 这条是四条规矩里最容易被"顺手优化掉"的一条。
   * 把空交集判成 R4 看起来很合理，但它抹掉了一个事实：
   * 我们确实试过 R2、它给出了空集。改写成 R4 之后账本上只剩"升级给人"，
   * 看不出"这条规则在这里失效了"。 */
  const result = resolveConflict({
    conflict: { id: 'c1', between: ['a', 'b'], kind: 'gap' },
    rule: 'R2-intersection',
    decided: [],
    reason: '两边要的东西完全不重叠',
    dropped: ['A 的全部', 'B 的全部'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.needsHuman, true, '空交集必须升级给人');
  assert.equal(result.conflict.resolution.rule, 'R2-intersection', '**保留 R2**，不许改写成 R4');
  assert.deepEqual(result.conflict.resolution.decided, [], '保留 decided=[] —— 那是"交集为空"的记录');
  assert.ok(result.errors.some((e) => e.message.includes('不要改写成 R4')));
});

test('C4g. resolveConflict 不替人做决定（decided 必须由调用方给）', () => {
  const noDecided = resolveConflict({
    conflict: { id: 'c1', between: ['a', 'b'], kind: 'risk' },
    rule: 'R4-escalate',
    reason: '三条都不适用',
  });
  assert.equal(noDecided.ok, false, '没给 decided 就不成立');
  assert.ok(noDecided.errors.some((e) => e.message.includes('没有 decided')));
});

test('C4h. conservativeStreak 从最新往回数连续 R2/R3', () => {
  const make = (rule) => ({ resolution: { rule } });
  assert.equal(conservativeStreak([]), 0);
  assert.equal(conservativeStreak([make('R1-evidence-wins'), make('R3-scope-take-smaller'), make('R2-intersection')]), 2);
  assert.equal(conservativeStreak([make('R3-scope-take-smaller'), make('R4-escalate'), make('R2-intersection')]), 1,
    '中间断了一次就重新数');
  assert.equal(conservativeStreak([make('R2-intersection'), make('R3-scope-take-smaller')]), 2);
  /* 非数组不抛 */
  for (const bad of [undefined, null, 'x', 1]) assert.equal(conservativeStreak(bad), 0);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. 批次总装
 * ═══════════════════════════════════════════════════════════════════════════ */

test('C5a. judgeBatch：必过阶段没交卡要报', () => {
  const result = judgeBatch({
    stages: STANDARD.stages,
    raws: { challenge: { id: 'c1', claim: 'A', questions: ['q'] } },
  });
  assert.equal(result.ok, false);
  const missing = result.errors.filter((e) => e.code === 'E_ARTIFACT_MISSING');
  assert.ok(missing.length >= 6, `其余六个阶段没交卡，都要报：${JSON.stringify(result.errors.map((e) => e.message))}`);
});

test('C5b. judgeBatch：全套合格卡 → ok，且 conflicts 空', () => {
  const raws = {
    challenge: { id: 'c1', claim: 'A', questions: ['q'] },
    confirm: { id: 'c2', claim: 'B', requirements: ['r'], answered: ['q → 答复'] },
    design: { id: 'c3', claim: 'C', decisions: ['d'] },
    redteam: { id: 'c4', claim: 'D', killScenarios: ['k1', 'k2', 'k3'] },
    build: { id: 'c5', claim: 'E', changed: ['x'] },
    verify: { id: 'c6', claim: 'F', verdict: 'pass', findings: ['f'] },
    signoff: { id: 'c7', claim: 'G', decision: 'accept' },
  };
  const result = judgeBatch({ stages: STANDARD.stages, raws });
  assert.deepEqual(result.errors, [], `不该有错：${JSON.stringify(result.errors)}`);
  assert.equal(result.ok, true);
  assert.equal(result.cards.length, 7);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.conservativeStreak, 0);
});

test('C5c. judgeBatch 一次报全部：卡错 + 冲突未裁 + 保守连续数', () => {
  const raws = {
    challenge: { id: 'c1', claim: ['A', 'B'], questions: [] },
    confirm: { id: 'c2', claim: 'B', requirements: ['r'], answered: ['x'] },
    design: { id: 'c3', claim: 'C', decisions: ['d'], conflictsWith: ['c2'] },
    redteam: { id: 'c4', claim: 'D', killScenarios: ['k1'] },
    build: { id: 'c5', claim: 'E', changed: ['x'] },
    verify: { id: 'c6', claim: 'F', verdict: 'pass', findings: ['f'] },
    signoff: { id: 'c7', claim: 'G', decision: 'accept' },
  };
  const result = judgeBatch({ stages: STANDARD.stages, raws });
  const set = new Set(result.errors.map((e) => e.code));
  assert.ok(set.has('E_CLAIM_MULTIPLE'));
  assert.ok(set.has('E_NO_CHALLENGE'));
  assert.ok(set.has('E_NO_KILL_SCENARIO'));
  assert.ok(set.has('E_CONFLICT_UNRESOLVED'), 'design 指了 c2 冲突但没裁定');
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].needsHuman, true, '未裁定的冲突必须升级给人');
});

test('C5d. judgeBatch 的 cannotJudge 必须点明"没标冲突就发现不了"', () => {
  const result = judgeBatch({ stages: [], raws: {} });
  assert.match(result.cannotJudge, /没在 conflictsWith 里互指/);
  assert.match(result.cannotJudge, /全绿/);
});
