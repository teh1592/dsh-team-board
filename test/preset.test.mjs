/**
 * preset.test.mjs — `src/preset.mjs` 的测试。
 *
 * 这一层守四件事，每一件都对应方案里一条被明确拍过的决定：
 *   ① 绝不回退默认档（`E_PRESET_NOT_FOUND`）
 *   ② 只升不许降（`E_PRESET_DOWNGRADE`）
 *   ③ 版本钉死在 id 里（裸 `standard` 一律拒绝）
 *   ④ 升档要补账（`E_PRESET_BACKFILL_MISSING`）
 *
 * 另外有两组在守**预设数据本身**（四份 JSON 与注册表）：
 *   ⑤ 四份预设与注册表必须互相一致、且都通过校验
 *   ⑥ `standard@1` / `lite@1` 的阶段图必须与方案 §2 的表格逐格相符
 *
 * ⑥ 是这组里最有价值的一条：方案 §2 是给人读的规格，而预设是给机器读的实现。
 * 两者一旦分叉，"照文档理解这个系统"和"它实际怎么跑"就是两回事。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parsePresetId,
  qualifyPreset,
  validatePreset,
  findEntry,
  loadPreset,
  diffStages,
  backfillGaps,
  judgeShift,
} from '../src/preset.mjs';

/* ── 真实的注册表与四份预设（从磁盘读一次，全组共用） ───────────────────── */
const REGISTRY = JSON.parse(readFileSync(new URL('../presets/index.json', import.meta.url), 'utf8'));
const BODIES = Object.fromEntries(
  REGISTRY.presets.map((entry) => [
    qualifyPreset(entry.id, entry.version),
    JSON.parse(readFileSync(new URL(`../presets/${entry.file}`, import.meta.url), 'utf8')),
  ]),
);

/** 只带一个阶段的合法预设，用来做"改动一处"的最小夹具。 */
function tinyPreset(over = {}) {
  return {
    id: 'tiny',
    version: 1,
    implemented: true,
    stages: [
      {
        id: 'gate-check',
        order: 1,
        role: 'critic',
        kind: 'proposal',
        mustProduce: ['claim'],
        blind: true,
        gate: 'E_NO_CHALLENGE',
      },
    ],
    ...over,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. id 解析：版本必须钉死
 * ═══════════════════════════════════════════════════════════════════════════ */

test('1a. parsePresetId 只认 id@version，裸 id 一律 null', () => {
  assert.deepEqual(parsePresetId('standard@1'), { id: 'standard', version: 1 });
  assert.deepEqual(parsePresetId('lite@12'), { id: 'lite', version: 12 });
  assert.deepEqual(parsePresetId('hot-fix@3'), { id: 'hot-fix', version: 3 });

  /* 裸 id 必须拒绝。允许它等于允许"用最新版" —— 而预设一旦改过，
   * 旧任务就会按新定义被判，且账本上没有任何痕迹说明它原本按哪一版跑。 */
  assert.equal(parsePresetId('standard'), null, '裸 id 必须拒绝');
  assert.equal(parsePresetId('Standard@1'), null, '大写 id 必须拒绝');
  assert.equal(parsePresetId('standard@0'), null, 'version 从 1 起');
  assert.equal(parsePresetId('standard@01'), null, '前导零必须拒绝');
  assert.equal(parsePresetId('standard@1.5'), null, '非整数版本必须拒绝');
  assert.equal(parsePresetId('@1'), null);
  assert.equal(parsePresetId('standard@'), null);
  assert.equal(parsePresetId('standard@1@2'), null);

  /* 非字符串不许抛 —— 上游可能把 undefined 直接传进来。 */
  for (const bad of [undefined, null, 1, {}, [], true]) {
    assert.equal(parsePresetId(bad), null, `parsePresetId(${String(bad)}) 必须是 null`);
  }
});

test('1b. qualifyPreset 与 parsePresetId 互为逆运算', () => {
  for (const entry of REGISTRY.presets) {
    const qualified = qualifyPreset(entry.id, entry.version);
    assert.deepEqual(parsePresetId(qualified), { id: entry.id, version: entry.version });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. validatePreset：一次报全部问题
 * ═══════════════════════════════════════════════════════════════════════════ */

test('2a. 合法预设通过，且不报 warning', () => {
  const result = validatePreset(tinyPreset());
  assert.equal(result.ok, true, `不该有错：${JSON.stringify(result.errors)}`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('2b. 非对象入参不抛，返回一条畸形诊断', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const result = validatePreset(bad);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'E_ARTIFACT_MALFORMED');
  }
});

test('2c. order 必须从 1 连续：跳号、重复、错位都要报', () => {
  const spaced = tinyPreset({
    stages: [
      { id: 'a', order: 1, role: 'critic', kind: 'proposal', mustProduce: ['x'], blind: true, gate: 'E_NO_CHALLENGE' },
      { id: 'b', order: 3, role: 'qa', kind: 'review', mustProduce: ['y'], blind: true, gate: 'E_NO_PASSING_REVIEW' },
    ],
  });
  const result = validatePreset(spaced);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.message.includes('order 应是 2')),
    `跳号必须被点名：${JSON.stringify(result.errors.map((e) => e.message))}`,
  );
});

test('2d. mustProduce 为空数组 = 这个阶段的门禁永远不可能触发', () => {
  const result = validatePreset(tinyPreset({
    stages: [
      { id: 'a', order: 1, role: 'critic', kind: 'proposal', mustProduce: [], blind: true, gate: 'E_NO_CHALLENGE' },
    ],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_ARTIFACT_MISSING');
  assert.match(result.errors[0].message, /永远不可能触发/);
});

test('2e. 门禁码必须是已登记的：会议码表 ∪ 基线码表', () => {
  /* 会议码表里的码要通过 */
  assert.equal(validatePreset(tinyPreset({
    stages: [{ id: 'a', order: 1, role: 'critic', kind: 'proposal', mustProduce: ['x'], blind: true, gate: 'E_NO_KILL_SCENARIO' }],
  })).ok, true);

  /* 基线码表里的码也要通过 —— 方案的七阶段表格本来就把两族混用
   * （build 用 E_MEETING_MISSING、verify 用 E_NO_PASSING_REVIEW），
   * 那不是笔误：那两个阶段的判定逻辑本来就在 delivery.mjs 里。
   *
   * 夹具里必须配一个盲阶段：否则会被"一个盲阶段都没有"那条校验正确拦下，
   * 于是这条测试就测不到门禁码判据了。这是夹具的约束，不是实现的让步。 */
  assert.equal(validatePreset(tinyPreset({
    stages: [
      { id: 'build', order: 1, role: 'dev', kind: 'implementation', mustProduce: ['x'], blind: false, gate: 'E_MEETING_MISSING' },
      { id: 'check', order: 2, role: 'qa', kind: 'review', mustProduce: ['y'], blind: true, gate: 'E_NO_PASSING_REVIEW' },
    ],
  })).ok, true, '基线码必须被接受，否则方案的表格自己就过不了校验');

  /* 编出来的码必须被拒 —— 它会在页面上显示成"未知门禁" */
  const bogus = validatePreset(tinyPreset({
    stages: [{ id: 'a', order: 1, role: 'critic', kind: 'proposal', mustProduce: ['x'], blind: true, gate: 'E_MADE_UP' }],
  }));
  assert.equal(bogus.ok, false);
  assert.match(bogus.errors[0].message, /未知门禁/);
});

test('2f. 一个盲阶段都没有的档位不是档位', () => {
  /* 没有盲阶段 = 没有独立复核 = 这条流水线只是把一个人的想法拆成几段说出来。
   * 这是整条流水线存在的理由，所以是 error 而不是 warning。 */
  const result = validatePreset({
    id: 'noblind',
    version: 1,
    implemented: true,
    stages: [
      { id: 'a', order: 1, role: 'dev', kind: 'implementation', mustProduce: ['x'], blind: false, gate: 'E_MEETING_MISSING' },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_PRESET_NO_BLIND_STAGE');
  assert.match(result.errors[0].message, /独立复核/);
  /* 「没有盲阶段」是**设计缺陷**，不是什么"未实现" —— 这条断言钉住收窄：
   * 这个判据以前挂在 `E_PRESET_NOT_IMPLEMENTED`（warning）名下却真阻断，
   * 于是页面上一条 warning 码在拦路，批 3 的达标率永远算不对。
   * 现在它有自己的 blocker 码，那个码只剩"档位 implemented:false"一个意思。 */
  assert.equal(
    result.errors.some((e) => e.code === 'E_PRESET_NOT_IMPLEMENTED'),
    false,
    '没有盲阶段不许再借用"未实现"那条码',
  );
});

test('2g. design 与 redteam 不许同一角色（预设层的 E_SELF_REVIEW）', () => {
  /* 如果预设把这两个阶段都写成 architect，那么无论运行时怎么派 agent，
   * 自己砍自己都是注定的 —— 这是 E_SELF_REVIEW 在预设层面的同一种病。 */
  const result = validatePreset({
    id: 'selfcut',
    version: 1,
    implemented: true,
    stages: [
      { id: 'design', order: 1, role: 'architect', kind: 'proposal', mustProduce: ['d'], blind: false, gate: 'E_PROPOSAL_UNREVIEWED' },
      { id: 'redteam', order: 2, role: 'architect', kind: 'proposal', mustProduce: ['k'], blind: true, gate: 'E_NO_KILL_SCENARIO' },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'E_SELF_REVIEW'));
});

test('2h. blind 与 withheld 是两根正交的轴 —— 非盲阶段可以 withheld 别人的产物', () => {
  /* 这条是回归：第一版我把两根轴当成一根，写了"非盲阶段声明 withheld 是自相矛盾"，
   * 结果对 standard@1 的 build 阶段产生了**误报** ——
   * 而 build 恰恰是全表里最必须的一处：它要完整看 design 的 decisions 才能动手，
   * 但必须看不见 redteam 的 killScenarios（否则会照着剧本写实现）。
   * 一条对正确数据报警的检查比没有检查更坏：它会教人忽略警告。 */

  /* 非盲 + withheld 别人的东西 → 合法（同样要配一个盲阶段，理由见 2e） */
  const legal = validatePreset({
    id: 'axes',
    version: 1,
    implemented: true,
    stages: [
      { id: 'design', order: 1, role: 'architect', kind: 'proposal', mustProduce: ['d'], blind: false, gate: 'E_PROPOSAL_UNREVIEWED' },
      { id: 'build', order: 2, role: 'dev', kind: 'implementation', mustProduce: ['c'], blind: false, gate: 'E_MEETING_MISSING', withheld: ['design.reasoning'] },
      { id: 'verify', order: 3, role: 'qa', kind: 'review', mustProduce: ['v'], blind: true, gate: 'E_NO_PASSING_REVIEW' },
    ],
  });
  assert.equal(legal.ok, true, `非盲阶段 withheld 别人的产物必须合法：${JSON.stringify(legal.errors)}`);
  assert.deepEqual(legal.warnings, [], '而且不许报警 —— 误报会教人忽略警告');

  /* 非盲 + withheld 自己的东西 → 自相矛盾，必须报 */
  const contradictory = validatePreset({
    id: 'axes2',
    version: 1,
    implemented: true,
    stages: [
      { id: 'build', order: 1, role: 'dev', kind: 'implementation', mustProduce: ['c'], blind: false, gate: 'E_MEETING_MISSING', withheld: ['build.changed'] },
      { id: 'verify', order: 2, role: 'qa', kind: 'review', mustProduce: ['v'], blind: true, gate: 'E_NO_PASSING_REVIEW' },
    ],
  });
  assert.equal(contradictory.ok, false);
  assert.match(contradictory.errors[0].message, /自相矛盾/);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. loadPreset：绝不回退默认档
 * ═══════════════════════════════════════════════════════════════════════════ */

test('3a. 加载不到就是加载不到，不许回退', () => {
  const result = loadPreset({ registry: REGISTRY, qualified: 'nope@1', bodies: BODIES });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_PRESET_NOT_FOUND');
  /* **关键**：失败时不返回任何 preset。回退的实现会在这里塞一个默认档，
   * 于是调用方无从分辨"加载成功"和"加载失败后拿了默认"。 */
  assert.equal(result.preset, undefined, '加载失败不许返回任何预设');
  assert.match(result.errors[0].message, /不会回退到默认档/);
});

test('3b. 注册表读不出来时同样不回退，且说清"无法判断"', () => {
  for (const broken of [undefined, null, {}, { presets: 'x' }, { presets: [] }]) {
    const result = loadPreset({ registry: broken, qualified: 'standard@1', bodies: BODIES });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'E_PRESET_NOT_FOUND');
    assert.equal(result.preset, undefined);
  }
});

test('3c. 注册表有、本体没给 → 报"两份数据对不上"，不拿默认档顶上', () => {
  const result = loadPreset({ registry: REGISTRY, qualified: 'standard@1', bodies: {} });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /注册表与实际文件对不上/);
  assert.equal(result.preset, undefined);
});

test('3d. 裸 id 在加载层被拒绝，理由说得清楚', () => {
  const result = loadPreset({ registry: REGISTRY, qualified: 'standard', bodies: BODIES });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_PRESET_NOT_FOUND');
  assert.match(result.errors[0].message, /id@version/);
});

test('3e. 注册表与本体的身份打架时不选边', () => {
  const tampered = { ...BODIES['lite@1'], id: 'standard' };
  const result = loadPreset({
    registry: REGISTRY,
    qualified: 'lite@1',
    bodies: { 'lite@1': tampered },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes('两份数据打架')));
});

test('3f. 未实现的档位：加载成功，但如实说明"跑不完"', () => {
  /* 这不是失败 —— 数据是合法的、注册表也登记了。它只是跑不了。
   * 用 warning 而不是 error，因为"存在但未实现"与"声称存在却不存在"是两件事。 */
  const result = loadPreset({ registry: REGISTRY, qualified: 'hotfix@1', bodies: BODIES });
  assert.equal(result.ok, true);
  assert.equal(result.implemented, false);
  assert.ok(result.warnings.some((w) => w.code === 'E_PRESET_NOT_IMPLEMENTED'));
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. 换挡：只升不许降
 * ═══════════════════════════════════════════════════════════════════════════ */

test('4a. 方向判定：up / same / down', () => {
  const up = judgeShift({ registry: REGISTRY, fromQualified: 'lite@1', toQualified: 'standard@1' });
  assert.equal(up.ok, true);
  assert.equal(up.direction, 'up');

  const same = judgeShift({ registry: REGISTRY, fromQualified: 'standard@1', toQualified: 'standard@1' });
  assert.equal(same.ok, true);
  assert.equal(same.direction, 'same');

  const down = judgeShift({ registry: REGISTRY, fromQualified: 'standard@1', toQualified: 'lite@1' });
  assert.equal(down.ok, false, '降档必须被拒');
  assert.equal(down.direction, 'down');
  assert.equal(down.errors[0].code, 'E_PRESET_DOWNGRADE');
});

test('4b. 判不出方向时不许放行', () => {
  /* "判不出方向"绝不能因为"没判出是降档"就当成允许 ——
   * 那正是 fail-open 的形状。 */
  const unknown = judgeShift({ registry: REGISTRY, fromQualified: 'lite@1', toQualified: 'ghost@1' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.direction, 'unknown');

  const noRank = judgeShift({
    registry: { presets: [{ id: 'a', version: 1 }, { id: 'b', version: 1 }] },
    fromQualified: 'a@1',
    toQualified: 'b@1',
  });
  assert.equal(noRank.ok, false, 'rank 缺失时必须拒绝，不许当成"不算降档"');
  assert.equal(noRank.direction, 'unknown');
});

test('4c. 同档位换版本不是换挡', () => {
  const registry = {
    presets: [
      { id: 'standard', version: 1, rank: 3, implemented: true, file: 'x' },
      { id: 'standard', version: 2, rank: 3, implemented: true, file: 'y' },
    ],
  };
  const result = judgeShift({ registry, fromQualified: 'standard@1', toQualified: 'standard@2' });
  assert.equal(result.ok, true, '同一档位的新版本必须允许 —— 预设改了本来就必须 version+1');
  assert.equal(result.direction, 'up');

  const backwards = judgeShift({ registry, fromQualified: 'standard@2', toQualified: 'standard@1' });
  assert.equal(backwards.ok, false, '往回用旧版本要拦');
  assert.equal(backwards.direction, 'down');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. 升档补账
 * ═══════════════════════════════════════════════════════════════════════════ */

test('5a. diffStages 逐项列出增加/减少/字段变化', () => {
  const before = tinyPreset();
  const after = {
    id: 'tiny',
    version: 2,
    implemented: true,
    stages: [
      { id: 'gate-check', order: 1, role: 'critic', kind: 'review', mustProduce: ['claim', 'verdict'], blind: true, gate: 'E_NO_PASSING_REVIEW' },
      { id: 'brand-new', order: 2, role: 'qa', kind: 'review', mustProduce: ['x'], blind: true, gate: 'E_NO_PASSING_REVIEW' },
    ],
  };
  const diff = diffStages(before, after);
  assert.deepEqual(diff.addedStages, ['brand-new']);
  assert.deepEqual(diff.removedStages, []);
  assert.deepEqual(diff.addedFields, [{ stageId: 'gate-check', field: 'verdict' }]);
  assert.deepEqual(diff.changedKinds, [{ stageId: 'gate-check', from: 'proposal', to: 'review' }]);
});

test('5b. lite@1 → standard@1 的真实缺口必须被算出来', () => {
  /* 这是本组最重要的一条：用**真实的两份预设**算，不是夹具。
   * 结果同时暴露两件不同的事，都必须报：
   *   - 两个已有阶段多了必产字段（challenge.claim / design.claim）
   *   - 三个阶段压根没跑过（redteam / build / signoff）
   * 前者是"字段缺失"，后者是"阶段缺失" —— 混成一条会让修的人只去补字段。 */
  const result = backfillGaps({
    from: BODIES['lite@1'],
    to: BODIES['standard@1'],
    artifacts: {
      challenge: ['questions'],
      confirm: ['requirements', 'answered'],
      design: ['decisions', 'killScenarios'],
      verify: ['verdict', 'findings'],
    },
  });
  assert.equal(result.ok, false);

  const codes = result.errors.map((e) => e.code);
  assert.deepEqual(codes, ['E_PRESET_BACKFILL_MISSING', 'E_PRESET_BACKFILL_MISSING']);

  const text = result.errors.map((e) => e.message).join('\n');
  assert.match(text, /challenge\.claim/, '字段缺口必须点名到 stage.field');
  assert.match(text, /design\.claim/);
  assert.match(text, /redteam/, '没跑过的阶段必须单独说');
  assert.match(text, /signoff/);
});

test('5c. 字段都补齐、阶段都跑过 → 不报', () => {
  const result = backfillGaps({
    from: BODIES['lite@1'],
    to: BODIES['standard@1'],
    artifacts: {
      challenge: new Set(['questions', 'claim']),
      confirm: ['requirements', 'answered'],
      design: ['decisions', 'killScenarios', 'claim'],
      redteam: ['killScenarios'],
      build: ['changed'],
      verify: ['verdict', 'findings'],
      signoff: ['decision'],
    },
  });
  assert.equal(result.ok, true, `不该有缺口：${JSON.stringify(result.errors)}`);
  assert.deepEqual(result.gaps, []);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. 预设数据本身：四份与注册表必须互相一致
 * ═══════════════════════════════════════════════════════════════════════════ */

test('6a. 注册表登记的每一份预设都能加载', () => {
  for (const entry of REGISTRY.presets) {
    const qualified = qualifyPreset(entry.id, entry.version);
    const result = loadPreset({ registry: REGISTRY, qualified, bodies: BODIES });
    assert.equal(result.ok, true, `${qualified} 加载失败：${JSON.stringify(result.errors)}`);
    assert.equal(result.qualified, qualified);
    assert.equal(result.implemented, entry.implemented, `${qualified} 的 implemented 必须与注册表一致`);
  }
});

test('6b. 每份预设的 rank 唯一且为正整数（rank 决定"什么算升档"）', () => {
  const ranks = REGISTRY.presets.map((entry) => entry.rank);
  for (const rank of ranks) {
    assert.ok(Number.isSafeInteger(rank) && rank >= 1, `rank 必须是正整数，收到 ${JSON.stringify(rank)}`);
  }
  assert.equal(new Set(ranks).size, ranks.length, 'rank 必须唯一 —— 两个档位同 rank 会让升/降无从判断');
});

test('6c. 未实现的档位必须真的没有阶段，实现的必须有阶段', () => {
  /* 这条防的是"半成品被当成能跑"：注册表说 implemented:true、本体却是空壳。
   * 反向也防：说没实现却写满了阶段，等于藏了一份没被验收过的设计。 */
  for (const entry of REGISTRY.presets) {
    const body = BODIES[qualifyPreset(entry.id, entry.version)];
    const stageCount = Array.isArray(body.stages) ? body.stages.length : 0;
    if (entry.implemented) {
      assert.ok(stageCount > 0, `${entry.id}@${entry.version} 声称已实现，却零阶段`);
    } else {
      assert.equal(stageCount, 0, `${entry.id}@${entry.version} 声称未实现，却有 ${stageCount} 个阶段 —— 那份设计没被任何人验收过`);
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. 阶段图 vs 方案 §2 的表格（规格与实现不许分叉）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('7a. standard@1 的七阶段与方案 §2 表格逐格相符', () => {
  /* 这张表是从方案 v1.0 §2 **手抄**下来的。手抄是故意的：
   * 如果这里改成"从预设读出来再比预设"，就变成了自己跟自己比。
   * 抄错会红，而红了就得回去看方案原文 —— 这正是我们要的。 */
  const expected = [
    { id: 'challenge', role: 'critic', kind: 'proposal', mustProduce: ['questions', 'claim'], blind: true, gate: 'E_NO_CHALLENGE' },
    { id: 'confirm', role: 'client', kind: 'proposal', mustProduce: ['requirements', 'answered'], blind: false, gate: 'E_QUESTIONS_UNANSWERED' },
    { id: 'design', role: 'architect', kind: 'proposal', mustProduce: ['decisions', 'claim'], blind: false, gate: 'E_PROPOSAL_UNREVIEWED' },
    { id: 'redteam', role: 'critic', kind: 'proposal', mustProduce: ['killScenarios'], blind: true, gate: 'E_NO_KILL_SCENARIO' },
    { id: 'build', role: 'dev', kind: 'implementation', mustProduce: ['changed'], blind: false, gate: 'E_MEETING_MISSING' },
    { id: 'verify', role: 'qa', kind: 'review', mustProduce: ['verdict', 'findings'], blind: true, gate: 'E_NO_PASSING_REVIEW' },
    { id: 'signoff', role: 'client', kind: 'review', mustProduce: ['decision'], blind: true, gate: 'E_NO_SIGNOFF' },
  ];

  const actual = BODIES['standard@1'].stages;
  assert.equal(actual.length, expected.length, '阶段数必须相等');

  for (const [index, want] of expected.entries()) {
    const got = actual[index];
    assert.equal(got.id, want.id, `第 ${index + 1} 阶段 id`);
    assert.equal(got.order, index + 1, `${want.id} 的 order`);
    assert.equal(got.role, want.role, `${want.id} 的 role`);
    assert.equal(got.kind, want.kind, `${want.id} 的 kind`);
    assert.deepEqual(got.mustProduce, want.mustProduce, `${want.id} 的 mustProduce`);
    assert.equal(got.blind, want.blind, `${want.id} 的 blind`);
    assert.equal(got.gate, want.gate, `${want.id} 的 gate`);
  }
});

test('7b. lite@1 的四阶段与方案 §2 表格逐格相符，且如实标注缺了什么', () => {
  const expected = [
    { id: 'challenge', role: 'critic', kind: 'proposal', mustProduce: ['questions'], blind: true, gate: 'E_NO_CHALLENGE' },
    { id: 'confirm', role: 'client', kind: 'proposal', mustProduce: ['requirements', 'answered'], blind: false, gate: 'E_QUESTIONS_UNANSWERED' },
    { id: 'design', role: 'architect', kind: 'proposal', mustProduce: ['decisions', 'killScenarios'], blind: false, gate: 'E_NO_KILL_SCENARIO' },
    { id: 'verify', role: 'qa', kind: 'review', mustProduce: ['verdict', 'findings'], blind: true, gate: 'E_NO_PASSING_REVIEW' },
  ];

  const actual = BODIES['lite@1'].stages;
  assert.equal(actual.length, 4);
  for (const [index, want] of expected.entries()) {
    const got = actual[index];
    assert.equal(got.id, want.id, `第 ${index + 1} 阶段 id`);
    assert.equal(got.role, want.role);
    assert.equal(got.kind, want.kind);
    assert.deepEqual(got.mustProduce, want.mustProduce);
    assert.equal(got.blind, want.blind);
    assert.equal(got.gate, want.gate);
  }

  /* lite 必须**自己声明**自己少了什么 —— 方案 §2 原话：
   * "账本按档位分区展示，不假装与 standard 同质"。
   * 不声明就等于让读账本的人以为 lite 也走过红队和签收。 */
  const declares = BODIES['lite@1'].declaresMissing;
  assert.ok(Array.isArray(declares) && declares.length >= 2, 'lite 必须声明它缺了哪些东西');
  const text = declares.join('\n');
  assert.match(text, /红队/, '必须声明无独立红队');
  assert.match(text, /签收/, '必须声明无客户签收');
});

test('7c. 有盲阶段这件事：standard 三处、lite 一处，且都是真盲', () => {
  /* 盲阶段是这条流水线唯一的低成本独立性来源。
   * 数量不是目标，但**一处都没有**就等于没开会 —— 上一组已经在 validatePreset 里拦了。
   * 这里钉住的是具体分布，防止有人"为了省事"把某处盲改成非盲。 */
  const blindOf = (qualified) => BODIES[qualified].stages
    .filter((stage) => stage.blind === true)
    .map((stage) => stage.id);

  assert.deepEqual(blindOf('standard@1'), ['challenge', 'redteam', 'verify', 'signoff']);
  assert.deepEqual(blindOf('lite@1'), ['challenge', 'verify']);
});
