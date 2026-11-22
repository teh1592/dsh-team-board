/**
 * `judgeCoverage` —— 「判了什么 / 没判什么」（P2-0 补）。
 *
 * 这一组钉的是一件事：`{ok:true, errors:[]}` 曾经同时意味着
 *   - 「六条判定路径都核过了，都没查出问题」 → 该交付；
 *   - 「六条里没有任何一条拿得到输入，压根没核」 → 不能算交付。
 * 两者字节相同。实测 21 条真实形状的任务里 18 条落在后者，全部"通过"了。
 *
 * 现在 `judgeCoverage` 把这两件事分开，而 `evaluateCompletion` 的返回形状一个字节没动
 * （那个形状被 19 条既有断言整对象比对过，不该为"看得见"去逼它们挪位）。
 *
 * 判据是 `judged === false`，**不是** `ok === true` —— 用 `ok` 当判据就把假象请回来了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCompletion, judgeCoverage } from '../src/gates.mjs';

/** 六条判定路径。用稳定 ASCII id，不用中文序号：这组 id 是要被下游代码读的。 */
const ALL_GATES = ['contract', 'verify', 'acceptance', 'diff', 'binding', 'review'];

test('J-1. 什么输入都没给：两个轴必须能分开 —— ok 是 true，judged 是 false', () => {
  const completion = evaluateCompletion({});
  const coverage = judgeCoverage({});

  assert.equal(completion.ok, true, '没有输入时旧语义确实是 ok:true —— 这条不是要它变红');
  assert.deepEqual(completion.errors, []);

  assert.equal(coverage.judged, false, '一条都没核过，judged 必须是 false');
  assert.deepEqual(coverage.judgedGates, [], '没核过就不许有"已核"的关');
  assert.equal(coverage.notJudged.length, ALL_GATES.length, '六条路径都要给出"没核"的理由');

  /* 这一条是整组的存在理由：`ok === true` 与 `judged === false` 在同一个输入上同时成立。
   * 任何把两者合并的改法（让 ok 变三态、或让 judged 不 false）都会把这条打红。 */
  assert.equal(
    completion.ok === true && coverage.judged === false,
    true,
    '「没查出问题」与「根本没核」必须是两个可分辨的轴',
  );
});

test('J-2. judgedGates 与 notJudged 必须恰好划分六条路径（不相交、不重复、不遗漏）', () => {
  const inputs = [
    {},
    { task: { kind: 'work' } },
    { task: { kind: 'implementation' } },
    { task: { kind: 'proposal' } },
    { task: { kind: 'review' } },
    { task: { kind: 'work' }, payload: { changedPaths: ['a/b.mjs'] }, diffPaths: ['a/b.mjs'] },
  ];

  for (const input of inputs) {
    const { judgedGates, notJudged } = judgeCoverage(input);
    const notJudgedIds = notJudged.map((item) => item.gate);
    const label = JSON.stringify(input);

    assert.equal(new Set(judgedGates).size, judgedGates.length, `${label}：judgedGates 不许有重复`);
    assert.equal(new Set(notJudgedIds).size, notJudgedIds.length, `${label}：notJudged 不许有重复`);
    assert.deepEqual(
      judgedGates.filter((id) => notJudgedIds.includes(id)),
      [],
      `${label}：同一关不许既算"核过"又算"没核"`,
    );
    assert.deepEqual(
      [...judgedGates, ...notJudgedIds].sort(),
      ALL_GATES.slice().sort(),
      `${label}：六条路径必须被完整覆盖（漏掉一条就等于那一关既不判也不出声）`,
    );
  }
});

test('J-3. 质量任务把契约 / 验证 / 验收 / diff 对账 / 字节绑定都真核了', () => {
  const coverage = judgeCoverage({
    task: {
      id: 'T1',
      kind: 'implementation',
      contract: {
        acceptance: ['a 成立'],
        verify: ['node -e "process.exit(0)"'],
        inScope: ['plugin/src/x.mjs'],
      },
    },
    payload: { changedPaths: ['plugin/src/x.mjs'] },
    diffPaths: ['plugin/src/x.mjs'],
    receipts: [],
    meta: {},
  });

  for (const id of ['contract', 'verify', 'acceptance', 'diff', 'binding']) {
    assert.ok(coverage.judgedGates.includes(id), `质量任务的 ${id} 应该被核过`);
  }
  assert.equal(coverage.judged, true);

  const judged = new Set(coverage.judgedGates);
  assert.equal(
    coverage.notJudged.some((item) => judged.has(item.gate)),
    false,
    '已经核过的关不许再出现在 notJudged 里',
  );
});

test('J-4. 没声明 kind 时六条路径一条都不许被算作"核过"，且每条都要给理由', () => {
  const coverage = judgeCoverage({
    task: { id: 'T2' },
    payload: {},
    receipts: [],
    diffPaths: [],
  });

  assert.equal(coverage.judged, false, '没 kind、没契约、没 diff → 什么都没核');
  assert.deepEqual(coverage.judgedGates, []);

  const reasons = coverage.notJudged.map((item) => item.reason);
  assert.ok(
    reasons.every((reason) => typeof reason === 'string' && reason.trim() !== ''),
    '每条"没核"都必须给出可读的理由，不许留空',
  );
  assert.ok(
    reasons.some((reason) => reason.includes('kind')),
    '其中至少一条要点明是 kind 未声明导致的',
  );
});

test('J-5. work 任务：verify 与验收不许被算作核过，理由要点明 work 豁免', () => {
  const coverage = judgeCoverage({
    task: { id: 'T3', kind: 'work', contract: { inScope: ['plugin/src/x.mjs'] } },
    payload: { changedPaths: ['plugin/src/x.mjs'] },
    diffPaths: ['plugin/src/x.mjs'],
  });

  assert.equal(coverage.judgedGates.includes('verify'), false, 'work 不要求 verify');
  assert.equal(coverage.judgedGates.includes('acceptance'), false, 'work 不要求验收');

  const byGate = new Map(coverage.notJudged.map((item) => [item.gate, item.reason]));
  assert.match(byGate.get('verify'), /work/);
  assert.match(byGate.get('acceptance'), /work/);
  assert.ok(coverage.judgedGates.includes('diff'), 'work 任务照样要对账 diff —— 它不是"什么都不判"');
});

test('J-6. 两侧都没路径时，"没核 diff"的理由必须点明它不等于"没有越权改动"', () => {
  const coverage = judgeCoverage({ task: { id: 'T4', kind: 'work' } });
  const diff = coverage.notJudged.find((item) => item.gate === 'diff');

  assert.ok(diff !== undefined, 'diff 这一关必须出现在"没核"里');
  assert.match(diff.reason, /不等于/, '这一条最容易被读成"没有越权改动"，理由里必须挡掉这种读法');
});

test('J-7. 只声明 kind=review：裁决路径被算作核过，字节绑定不算', () => {
  const coverage = judgeCoverage({ task: { id: 'T5', kind: 'review' }, payload: {} });

  assert.ok(coverage.judgedGates.includes('review'), 'review 任务必须走裁决路径');
  assert.equal(coverage.judgedGates.includes('binding'), false, '字节绑定只对 implementation 有意义');
});

test('J-8. 纯函数：同一输入两次调用结果完全相同，且不改入参', () => {
  const input = {
    task: { id: 'T6', kind: 'implementation', contract: { acceptance: ['x'], verify: ['y'] } },
    payload: { changedPaths: ['p/q.mjs'] },
    diffPaths: ['p/q.mjs'],
    receipts: [],
    meta: {},
  };
  const before = JSON.stringify(input);

  const first = judgeCoverage(input);
  const second = judgeCoverage(input);

  assert.deepEqual(first, second, '同一输入两次调用必须逐字段相同（无隐藏状态）');
  assert.equal(JSON.stringify(input), before, '不许改写入参');
});