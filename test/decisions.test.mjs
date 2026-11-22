/**
 * 待拍板（区块 ③）—— 六条需求与五条 kill scenario 的**可执行证据**。
 *
 * 这一份不是"顺手补的测试"，而是这次 build 的唯一交付凭据：K1–K5 的处置
 * 全部写成了断言。哪一条被改回旧形状，这里就红。
 *
 * 两部分：
 *   A. `selectDecisions` 纯函数（准入 / 六槽位 / 排序 / 容量 / 已拍板留位 / 0 条形状）
 *   B. 宿主 `decide` 路由（403 的三种来源、suggestion-only、回写失败与重试、状态码）
 *
 * 客户端部分用与 `client.test.mjs` **完全相同的方式**加载 `client.js` 源码
 * （在假 `window.__ModuleLoader__` 里执行 factory），所以测的是真会跑在浏览器里那份代码。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SOURCE = readFileSync(join(ROOT, 'client.js'), 'utf8');
const ZH = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'));

function makeT(dict) {
  return (key, vars) => {
    const raw = dict[key];
    if (typeof raw !== 'string') return key;
    if (vars === undefined) return raw;
    return raw.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
  };
}

const DICT = { ...ZH };
const t = makeT(DICT);

function loadModule() {
  let captured;
  const fakeWindow = {
    __ModuleLoader__: {
      load({ id, factory }) {
        const fakeRequire = (name) => {
          if (name === 'react') {
            return {
              createElement: () => null,
              useState: () => [undefined, () => {}],
              useEffect: () => {},
              useCallback: (fn) => fn,
              useMemo: (fn) => fn(),
            };
          }
          throw new Error(`unexpected require: ${name}`);
        };
        captured = { id, module: factory(fakeRequire) };
      },
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', SOURCE)(fakeWindow);
  assert.ok(captured !== undefined, 'client.js 必须调用 window.__ModuleLoader__.load');
  return captured.module;
}

const MODULE = loadModule();
const P = MODULE.pure;

/** 一条**准入全过**的合格条目（六个槽位齐备）。`patch` 用来逐项打坏。 */
function goodRow(patch) {
  return {
    id: 'd1',
    title: '把 staging 的灰度扩到 20%',
    owner: 'yg',
    mine: true,
    default_value: null,
    blocking: true,
    writeback: 'yes',
    options: ['准', '驳', '待定'],
    impact: '晚一天上线，约 12 万',
    source_ref: 'https://example.test/decisions/d1',
    due_at: '2026-11-24',
    source_system: 'ci',
    ...patch,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * A1. Req1：准入三条同时成立才进清单；分别缺一项 → 渲染 0 条
 * ═══════════════════════════════════════════════════════════════════════════ */

test('A1. 三条各缺一项的样本：一条都不进清单（渲染 0 条），且三条各自被记一次', () => {
  /* 三条样本，每条只缺一项 —— 这是 Req1 原话「构造分别缺一项的 3 条样本」。
   * 缺的分别是：default_value 非空 / blocking 不是 true / writeback 不是 yes。 */
  const samples = [
    goodRow({ id: 'missing-default', default_value: 'auto-approve' }),
    goodRow({ id: 'missing-blocking', blocking: false }),
    goodRow({ id: 'missing-writeback', writeback: 'no' }),
  ];
  const view = P.selectDecisions({ rows: samples });

  assert.equal(view.rows.length, 0, '缺任一项就一条都不许进清单（Req1）');
  assert.equal(view.visible.length, 0, '渲染出去的行必须是 0');
  assert.equal(view.pending, 0, '待办计数也必须是 0');
  assert.equal(view.filtered.admission, 3, '三条样本各被准入挡一次');
  /* 三个理由各记一次：这不只是计数好看 —— 它证明挡下来的是**各自不同的那一项**，
   * 不是某一条判据顺手把三条一起吞了。 */
  assert.deepEqual(
    { default: view.reasons.default, blocking: view.reasons.blocking, writeback: view.reasons.writeback },
    { default: 1, blocking: 1, writeback: 1 },
  );
  assert.equal(view.filtered.slots, 0, '这三条不是被槽位挡的（它们六槽都齐）');
});

test('A2. 三条全过 → 进清单；准入只认严格字面量（不许被"看起来像"混过去）', () => {
  assert.equal(P.selectDecisions({ rows: [goodRow()] }).rows.length, 1, '三条全过必须进');

  /* 不要宽容解释：`'true'` / `1` / `'Yes'` 都不是 `true` / `'yes'`。
   * 宽容解释的后果是"某项其实没声明，却被当成声明了"，而准入恰恰是拿来挡这个的。 */
  const lenient = [
    goodRow({ id: 'b', blocking: 'true' }),
    goodRow({ id: 'c', blocking: 1 }),
    goodRow({ id: 'd', writeback: 'Yes' }),
    goodRow({ id: 'e', writeback: true }),
  ];
  const view = P.selectDecisions({ rows: lenient });
  assert.equal(view.rows.length, 0, '`"true"` / `1` / `"Yes"` 一律不算通过准入');
  assert.equal(view.filtered.admission, 4);
});

test('A3. 空 default_value 的三种写法都算"空"；0 与 false 算"非空"（不替它抹平）', () => {
  const view = P.selectDecisions({ rows: [
    goodRow({ id: 'a', default_value: null }),
    goodRow({ id: 'b', default_value: '' }),
    goodRow({ id: 'c' }), // 字段不存在
  ] });
  assert.equal(view.rows.length, 3, 'null / 空串 / 缺字段 都是"没有默认值"');
  for (const row of view.rows) assert.equal(row.defaultValue === null || row.defaultValue === '', true);

  const nonEmpty = P.selectDecisions({ rows: [goodRow({ id: 'z', default_value: 0 })] });
  assert.equal(nonEmpty.rows.length, 0, '默认值 0 是**设过**的：不能当作"没有默认值"');
  assert.equal(nonEmpty.reasons.default, 1);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A4. Req2：六个槽位一个不少；"没写"物化成占位，"写错了"才被过滤（K1）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('A4. 合格条目恰好物化 6 个槽位，顺序与 DECISION_SLOTS 一致', () => {
  const view = P.selectDecisions({ rows: [goodRow()] });
  const slots = view.rows[0].slots;
  assert.equal(slots.length, 6, '六个槽位一个不能少');
  assert.deepEqual(slots.map((slot) => slot.key), P.DECISION_SLOTS.slice());
  assert.deepEqual(P.DECISION_SLOTS, ['title', 'options', 'impact', 'sourceRef', 'dueAt', 'default']);
  for (const slot of slots) assert.equal(slot.empty, false, `槽位 ${slot.key} 不许是空的`);
});

test('A5. 五个"真空"槽位任一为空 → 该条被过滤，且计入隐藏计数', () => {
  const broken = [
    goodRow({ id: 'no-title', title: '   ' }),
    goodRow({ id: 'no-options', options: [] }),
    goodRow({ id: 'no-impact', impact: '', impact_amount: undefined, due_at: null }),
    goodRow({ id: 'no-ref', source_ref: '' }),
  ];
  const view = P.selectDecisions({ rows: broken });
  assert.equal(view.rows.length, 0, '任一槽位为空 → 渲染前过滤（Req2）');
  assert.equal(view.filtered.slots, 4, '过滤数量必须写进隐藏计数');
  assert.equal(view.reasons.emptySlot, 4);
});

test('A6. 标题槽 ≤30 字：超出截断到 30 并留痕；不因"太长"被过滤', () => {
  const long = '把灰度扩到百分之二十并把回滚脚本一起上线这件事需要现在拍板决定';
  const view = P.selectDecisions({ rows: [goodRow({ title: long })] });
  assert.equal(view.rows.length, 1, '太长是**渲染问题**，不是准入问题');
  const slot = view.rows[0].slots.find((item) => item.key === 'title');
  assert.equal(Array.from(slot.text).length, 30, '截断后必须正好 30 个字（29 字 + 省略号）');
  assert.equal(slot.text.endsWith('…'), true);
  assert.equal(slot.truncated, true, '截断要留痕，别静默改字');
});

test('A7. 选项枚举 ≤3 项：超出取前三并留痕', () => {
  const view = P.selectDecisions({ rows: [goodRow({ options: ['准', '驳', '待定', '再议'] })] });
  const slot = view.rows[0].slots.find((item) => item.key === 'options');
  assert.equal(slot.text, '准 / 驳 / 待定', '只渲染前三项');
  assert.equal(slot.clamped, true, '截了要留痕');
});

test('A8. 影响一句必须含金额或截止日；三者都没有 → 槽位空 → 过滤', () => {
  /* 情形一：来源系统自己写了那句话 —— 直接用。 */
  const declared = P.selectDecisions({ rows: [goodRow({ impact: '错过这班要等两周', due_at: null, impact_amount: undefined })] });
  assert.equal(declared.rows.length, 1, '有来源文案就算"含截止日/金额"的意思表达');
  assert.equal(declared.rows[0].slots.find((item) => item.key === 'impact').text, '错过这班要等两周');

  /* 情形二：没有文案，用**金额**拼。 */
  const byAmount = P.selectDecisions({ rows: [goodRow({ impact: '', impact_amount: 120000, due_at: null })] });
  assert.equal(byAmount.rows[0].slots.find((item) => item.key === 'impact').source, 'amount');

  /* 情形三：金额与截止日都没有、文案也没有 —— 这句话说不出来，过滤。 */
  const none = P.selectDecisions({ rows: [goodRow({ impact: '', impact_amount: undefined, due_at: null })] });
  assert.equal(none.rows.length, 0, '说不出影响就不许占用"请你现在决定"的位置');
  assert.equal(none.filtered.slots, 1);
});

test('A9（K1 的处置）. 缺 due_at → 物化成占位、**通过**过滤并排到末尾；due_at 写错 → 才被过滤', () => {
  /* K1 指出：准入要求 default_value 为空，槽位表又要求六槽非空；同时 Req3 要求
   * "无 due_at 排末尾"而 Req2 说"任一槽位为空即过滤"。若判空直接对着原始字段做，
   * 这两条永远互斥。这里的处置是**先物化、后判空**：
   *   - 没写 due_at  → 物化成占位（"无截止日"），empty=false，能进排序、排末尾；
   *   - 写了但解析不出来 → empty=true，被过滤。 */
  const view = P.selectDecisions({ rows: [
    goodRow({ id: 'with-due', due_at: '2026-11-23' }),
    goodRow({ id: 'no-due', due_at: null, impact_amount: 5000 }),
  ] });
  assert.equal(view.rows.length, 2, '无 due_at 必须能活着进清单（否则 Req3 无法断言）');
  const noDue = view.rows.find((row) => row.id === 'no-due');
  const dueSlot = noDue.slots.find((item) => item.key === 'dueAt');
  assert.equal(dueSlot.placeholder, true, '没写 = 占位，不是空槽');
  assert.equal(dueSlot.empty, false);
  assert.equal(view.rows[1].id, 'no-due', '无 due_at 排末尾（Req3）');

  /* 写错了才是真缺陷：这时 Req2 的"槽位为空"才有对象可断言。 */
  const broken = P.selectDecisions({ rows: [goodRow({ due_at: '下周' })] });
  assert.equal(broken.rows.length, 0, 'due_at 有形但解析不出来 → 槽位不合格');
  assert.equal(broken.filtered.slots, 1);
  assert.equal(P.decisionDay('下周'), null);
});

test('A10（K1 的处置）. 准入要求 default_value 为空 + 槽位要求"默认值占位" → 两者由物化统一', () => {
  /* 准入挡掉"设过默认值"的行，所以走到槽位这一层的行**一定**是空默认值；
   * 空默认值物化成占位（"默认值：无"），于是槽位 6 永远非空。
   * 结论：两条判据不打架，且都不需要被放宽。 */
  const view = P.selectDecisions({ rows: [goodRow()] });
  const slot = view.rows[0].slots.find((item) => item.key === 'default');
  assert.equal(slot.placeholder, true, '空的默认值被物化成占位');
  assert.equal(slot.empty, false, '占位不等于空槽');
  assert.equal(view.rows[0].defaultValue, null, '原始字段如实保留为 null（不编一个默认值）');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A11–A13. Req3：排序 + 容量
 * ═══════════════════════════════════════════════════════════════════════════ */

test('A11. 排序：due_at 升序 → 同日金额降序 → 输入序兜底 → 无 due_at 排末尾', () => {
  const rows = [
    goodRow({ id: 'tail', due_at: null, impact_amount: 900 }),
    goodRow({ id: 'late', due_at: '2026-12-01', impact_amount: 100 }),
    goodRow({ id: 'same-day-small', due_at: '2026-11-24', impact_amount: 10 }),
    goodRow({ id: 'same-day-big', due_at: '2026-11-24', impact_amount: 99 }),
    goodRow({ id: 'early', due_at: '2026-11-22', impact_amount: 1 }),
  ];
  const ids = P.selectDecisions({ rows }).rows.map((row) => row.id);
  assert.deepEqual(ids, ['early', 'same-day-big', 'same-day-small', 'late', 'tail']);
});

test('A12. 容量 7 / 21：≤7 flat 不折叠；8–20 folded 显示前 7 + 还有 1 条；≥21 按 source_system 分组', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => goodRow({
    id: `r${i}`,
    due_at: `2026-11-${String((i % 27) + 1).padStart(2, '0')}`,
    impact_amount: 1000 - i,
    source_system: i % 2 === 0 ? 'ci' : 'crm',
  }));

  const flat = P.selectDecisions({ rows: make(7) });
  assert.equal(flat.mode, 'flat');
  assert.equal(flat.visible.length, 7, '≤7 条全展开');
  assert.equal(flat.hiddenCount, 0, '≤7 条不出现折叠行（因此也不会出现滚动条）');
  assert.equal(flat.groups.length, 0);

  const folded = P.selectDecisions({ rows: make(8) });
  assert.equal(folded.mode, 'folded');
  assert.equal(folded.visible.length, 7, '8–20 条显示前 7');
  assert.equal(folded.hiddenCount, 1, '「还有 N 条」的 N = 8 − 7');

  const twenty = P.selectDecisions({ rows: make(20) });
  assert.equal(twenty.mode, 'folded', '20 条仍然折叠（分组从 21 开始）');
  assert.equal(twenty.hiddenCount, 13);

  const grouped = P.selectDecisions({ rows: make(21) });
  assert.equal(grouped.mode, 'grouped', '>20 条必须分组');
  const keys = grouped.groups.map((group) => group.key);
  assert.deepEqual(keys, ['ci', 'crm'], '分组键是 source_system（不是日期）');
  assert.equal(grouped.groups[0].rows.length + grouped.groups[1].rows.length, 21, '分组不丢行');
  /* 组内再套同一条 7 条规则：ci 组 11 条 → 显示 7、收起 4。 */
  assert.equal(grouped.groups[0].rows.length, 11);
  assert.equal(grouped.groups[0].visible.length, 7);
  assert.equal(grouped.groups[0].hiddenCount, 4);
  assert.equal(grouped.hiddenCount, 4 + 3, '总收起数 = 各组收起数之和');
});

test('A13（K4 的处置）. 折叠计数与过滤计数是**两个数**，不许合并成一个"已隐藏"', () => {
  const rows = Array.from({ length: 9 }, (_, i) => goodRow({ id: `r${i}`, due_at: `2026-11-2${i % 10}` }));
  rows.push(goodRow({ id: 'bad', blocking: false }));
  const view = P.selectDecisions({ rows });
  assert.equal(view.total, 9, '9 条合格');
  assert.equal(view.filtered.admission, 1, '1 条被准入挡掉');
  assert.equal(view.hiddenCount, 2, '容量收起 9 − 7 = 2');
  assert.notEqual(view.hiddenCount, view.filtered.admission, '两个数必须能分开');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A14–A15. Req4 + K2：已拍板与回写失败的行留在原位
 * ═══════════════════════════════════════════════════════════════════════════ */

test('A14（Req4/K2）. 已拍板的行仍留在输出里，位置由 seq 冻结，待办计数 -1', () => {
  const before = P.selectDecisions({ rows: [
    goodRow({ id: 'a', due_at: '2026-11-22' }),
    goodRow({ id: 'b', due_at: '2026-11-23' }),
    goodRow({ id: 'c', due_at: '2026-11-24' }),
  ] });
  assert.equal(before.pending, 3);

  /* 把中间那条拍掉（宿主会写 decided_by / decided_at / decision_value）。 */
  const decidedRow = {
    ...before.rows[1],
    seq: before.rows[1].seq,
    status: 'decided',
    verdict: 'approve',
    decided_by: 'yg',
    decided_at: '2026-11-21T12:00:00.000Z',
    decision_value: 'approve',
  };
  const after = P.selectDecisions({ rows: [before.rows[0], decidedRow, before.rows[2]] });

  assert.equal(after.rows.length, 3, '拍过的行**不许消失**');
  assert.deepEqual(after.rows.map((row) => row.id), ['a', 'b', 'c'], '不许位移');
  assert.equal(after.rows[1].verdict, 'approve');
  assert.equal(after.rows[1].decidedBy, 'yg');
  assert.equal(after.rows[1].decidedAt, '2026-11-21T12:00:00.000Z');
  assert.equal(after.pending, 2, '区块待办计数 -1');
  assert.equal(after.decided, 1);

  /* 再跑一次（模拟重渲染）：seq 冻结 → 顺序还是同一个，不会因"已拍"重排。 */
  const again = P.selectDecisions({ rows: after.rows });
  assert.deepEqual(again.rows.map((row) => row.id), ['a', 'b', 'c']);
});

test('A15（K2/Req6）. 回写失败的条目：留在原位、仍显示已拍板、可重试；重试成功后位置不变', () => {
  const rows = [
    goodRow({ id: 'a', due_at: '2026-11-22', seq: 0 }),
    goodRow({ id: 'b', due_at: '2026-11-23', seq: 1, verdict: 'reject', status: 'decided',
      writeback_state: 'failed', writeback_error: 'http-502' }),
  ];
  const view = P.selectDecisions({ rows });
  assert.equal(view.rows.length, 2, '回写失败**不许**让它掉出清单');
  assert.equal(view.rows[1].writebackState, 'failed');
  assert.equal(view.rows[1].writebackError, 'http-502');
  assert.deepEqual(view.rows.map((row) => row.id), ['a', 'b']);

  const retried = P.selectDecisions({ rows: [rows[0], { ...rows[1], writeback_state: 'ok', writeback_error: '' }] });
  assert.deepEqual(retried.rows.map((row) => row.id), ['a', 'b'], '重试成功后仍留在原位');
  assert.equal(retried.rows[1].writebackState, 'ok');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A16（K5 的处置）. 0 条时返回完整形状 —— 区块可无条件挂载
 * ═══════════════════════════════════════════════════════════════════════════ */

test('A16（K5）. 空输入 / 全被过滤 → 返回完整形状（不是 null），隐藏计数照样可读', () => {
  for (const input of [undefined, null, {}, { rows: undefined }, { rows: [] }, { rows: 'nope' }]) {
    const view = P.selectDecisions(input);
    assert.equal(view.rows.length, 0, `${JSON.stringify(input)} 必须给 0 条`);
    assert.equal(view.mode, 'flat');
    assert.deepEqual(view.groups, []);
    assert.deepEqual(view.visible, []);
    assert.equal(view.hiddenCount, 0);
    assert.equal(view.filtered.admission + view.filtered.slots, 0);
    assert.equal(view.pending, 0);
    /* 形状齐 = 区块能挂载 = data-filtered-* 写得出来。 */
    assert.equal(typeof view.filtered.admission, 'number');
    assert.equal(typeof view.filtered.slots, 'number');
  }

  /* Req1 那三条样本的产物同样要"形状完整、计数为 3"——
   * 这正是"渲染 0 条"与"隐藏计数可读"能同时成立的地方。 */
  const three = P.selectDecisions({ rows: [
    goodRow({ id: 'x', default_value: 1 }),
    goodRow({ id: 'y', blocking: false }),
    goodRow({ id: 'z', writeback: 'no' }),
  ] });
  assert.equal(three.rows.length, 0);
  assert.equal(three.filtered.admission, 3);
});

test('A17. decisionSlot：待拍板 / 已拍板 / 无归属 三态，且只有本人能拍', () => {
  const pending = P.decisionSlot(goodRow(), t);
  assert.equal(pending.key, 'undecided');
  assert.equal(pending.canDecide, true);
  assert.equal(pending.text, DICT['decide.status.pending'], '语言面必须是「待拍板」');

  const decided = P.decisionSlot(goodRow({ verdict: 'approve' }), t);
  assert.equal(decided.key, 'approve');
  assert.equal(decided.text, DICT['decide.status.decided'], '拍完必须写「已拍板」');
  assert.equal(decided.value, DICT['decide.verdict.approve']);

  const others = P.decisionSlot(goodRow({ mine: false }), t);
  assert.equal(others.canDecide, false, '非本人不许拍（界面形态；403 在接口层）');

  const orphan = P.decisionSlot(goodRow({ owner: '' }), t);
  assert.equal(orphan.key, 'noOwner');
  assert.equal(orphan.canDecide, false);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * B. 宿主 decide 路由（Req5 / Req6 的接口层事实）
 * ═══════════════════════════════════════════════════════════════════════════ */

const { registerDecideRoute } = await import('../host/index.js');

/** 装一条假连接，把注册进来的 handler 抓出来直接调（不经网络）。 */
function mountRoute(state) {
  let registered;
  const ctx = {
    inject(_keys, factory) {
      return factory(ctx);
    },
    get(key) {
      if (key !== 'connection') return undefined;
      return {
        fetch: {
          register(config) {
            registered = config;
            return () => {};
          },
        },
      };
    },
  };
  const dispose = registerDecideRoute(ctx, state);
  assert.equal(typeof dispose, 'function', '成功注册必须返回撤销函数');
  assert.equal(registered.path, '/api/team-board/decide');
  assert.deepEqual(registered.methods, ['POST']);
  return registered.fetch;
}

/** 造一份最小 state：身份、查行、写行、回写都可控。 */
function makeState(options) {
  const opts = options === undefined ? {} : options;
  const rows = new Map();
  for (const row of opts.rows === undefined ? [] : opts.rows) rows.set(row.id, { ...row });
  const calls = { writeback: 0, written: [] };
  return {
    calls,
    rows,
    async identity() {
      return opts.identity === undefined ? { status: 'ok', name: 'yg' } : opts.identity;
    },
    async findDecision(id) {
      const row = rows.get(id);
      return row === undefined ? undefined : { ...row };
    },
    async writeDecision(row) {
      rows.set(row.id, { ...row });
      calls.written.push({ ...row });
      return true;
    },
    async writeback() {
      calls.writeback += 1;
      return opts.writeback === undefined ? { status: 'ok', message: '' } : opts.writeback;
    },
  };
}

const OWNED = {
  id: 'd1',
  title: '扩灰度',
  owner: 'yg',
  default_value: null,
  blocking: true,
  writeback: 'yes',
  source_ref: '',
};

async function post(handler, body) {
  const request = new Request('http://127.0.0.1/api/team-board/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await handler(request);
  return { status: response.status, payload: await response.json() };
}

test('B1（Req5）. 非 user 身份（管理员 / 机器人 / 代理）写 verdict → 403，且写着建议才让过', async () => {
  for (const kind of ['admin', 'bot', 'proxy']) {
    const state = makeState({ rows: [OWNED] });
    const handler = mountRoute(state);
    const denied = await post(handler, { id: 'd1', verdict: 'approve', kind, sessionId: 's1' });
    assert.equal(denied.status, 403, `${kind} 写拍板状态必须是 403（接口层事实）`);
    assert.equal(denied.payload.ok, false);
    assert.equal(denied.payload.error.code, 'team-board/forbidden');
    assert.equal(state.rows.get('d1').status, undefined, '被拒时**一个字节都不许落盘**');
    assert.equal(state.calls.writeback, 0, '被拒时也不许触发回写');

    /* 只写 suggestion：允许，且 status 不动（Req5 的后半句）。 */
    const suggested = await post(handler, { id: 'd1', suggestion: '建议先压测', kind, sessionId: 's1' });
    assert.equal(suggested.status, 200, `${kind} 可以提建议`);
    const row = state.rows.get('d1');
    assert.equal(row.suggestion, '建议先压测');
    assert.equal(row.status, undefined, '提建议不许改 status');
    assert.equal(row.verdict, undefined, '提建议不许改 verdict');
    assert.equal(row.suggestion_by, kind, '谁提的要留下是谁');
  }
});

test('B2（Req5）. user 身份但**不是这条的归属人** → 403；是归属人才 200', async () => {
  const state = makeState({ rows: [OWNED] });
  const handler = mountRoute(state);

  /* 身份 = 别人。宿主真相给的 `me`，客户端伪造不了这一半。 */
  const other = makeState({ rows: [OWNED], identity: { status: 'ok', name: 'someone-else' } });
  const otherHandler = mountRoute(other);
  const denied = await post(otherHandler, { id: 'd1', verdict: 'approve', sessionId: 's1' });
  assert.equal(denied.status, 403);
  assert.match(denied.payload.error.message, /不是本人|归属/);
  assert.equal(other.calls.writeback, 0);

  /* 归属比对走 `samePerson` → `normalizeIdentity`。**它只折叠空白、不做别的**（SD-2），
   * 所以这里把三件事一次说清：
   *   - 前后空白不是"另一个人"（' yg ' 就是 yg）；
   *   - `@yg` 与 `yg` **不是**同一个人（SD-2 明文：`'@a'` 与 `'＠a'` 不是一个人；
   *     同理，带不带 `@` 就是两个身份，判归属不许替它去掉）；
   *   - 空归属不等于空归属（"没人认领"不是"另一个人"）。 */
  const decorated = makeState({ rows: [{ ...OWNED, owner: '@yg' }] });
  const decoratedHandler = mountRoute(decorated);
  const rejected = await post(decoratedHandler, { id: 'd1', verdict: 'approve', sessionId: 's1' });
  assert.equal(rejected.status, 403, '`@yg` 与 `yg` 是两个身份（规范化不做 @ 去壳）');

  const spaced = makeState({ rows: [{ ...OWNED, owner: ' yg ' }] });
  const spacedHandler = mountRoute(spaced);
  const accepted = await post(spacedHandler, { id: 'd1', verdict: 'approve', sessionId: 's1' });
  assert.equal(accepted.status, 200, '前后空白是同一个人');
  assert.equal(accepted.payload.value.row.decided_by, 'yg', 'decided_by 写的是宿主真相里的名字');
});

test('B3（Req4/Req6）. 拍板成功：写 decided_by / decided_at / decision_value，并立即回写', async () => {
  const state = makeState({ rows: [OWNED] });
  const handler = mountRoute(state);
  const ok = await post(handler, { id: 'd1', verdict: 'hold', sessionId: 's1' });

  assert.equal(ok.status, 200);
  assert.equal(ok.payload.ok, true);
  const row = ok.payload.value.row;
  assert.equal(row.status, 'decided');
  assert.equal(row.verdict, 'hold');
  assert.equal(row.decision_value, 'hold');
  assert.equal(row.decided_by, 'yg');
  assert.match(row.decided_at, /^\d{4}-\d{2}-\d{2}T/, 'decided_at 必须是 ISO 时间');
  assert.equal(row.writeback_state, 'ok');
  assert.equal(row.writeback_error, '');
  assert.equal(state.calls.writeback, 1, '拍完必须**立即**回写一次');
});

test('B4（Req6）. 回写失败：决议照旧落盘，行标「回写失败」+ 错误，可 retry；retry 不改决议', async () => {
  const state = makeState({ rows: [OWNED], writeback: { status: 'failed', message: 'http-502' } });
  const handler = mountRoute(state);

  const failed = await post(handler, { id: 'd1', verdict: 'approve', sessionId: 's1' });
  assert.equal(failed.status, 200, '回写失败**不是**这次请求的失败：决议已经成立');
  const row = failed.payload.value.row;
  assert.equal(row.verdict, 'approve', '决议不许回退');
  assert.equal(row.status, 'decided');
  assert.equal(row.writeback_state, 'failed');
  assert.equal(row.writeback_error, 'http-502');
  assert.equal(state.rows.get('d1').writeback_state, 'failed', '失败状态必须落盘（不许只活在响应里）');

  /* 重试：只重发回写，不改 decided_*。 */
  const retried = await post(handler, { id: 'd1', retry: true, sessionId: 's1' });
  assert.equal(retried.status, 200);
  assert.equal(retried.payload.value.row.verdict, 'approve', 'retry 不许改决议');
  assert.equal(retried.payload.value.row.decided_at, row.decided_at, 'retry 不许改拍板时间');
  assert.equal(state.calls.writeback, 2, 'retry 必须真的再回写一次');
});

test('B5（Req5/Req6）. 状态码的四种失败各有其码：400 / 403 / 404 / 409 —— 不许一律 500', async () => {
  const handler = mountRoute(makeState({ rows: [OWNED] }));
  assert.equal((await post(handler, {})).status, 400, '缺 id');
  assert.equal((await post(handler, { id: 'd1' })).status, 400, '没有动作');
  assert.equal((await post(handler, { id: 'd1', verdict: 'maybe' })).status, 400, 'verdict 不认识');
  assert.equal((await post(handler, { id: 'd1', verdict: 'approve', kind: 'root' })).status, 400, 'kind 不认识');
  assert.equal((await post(handler, { id: 'nope', verdict: 'approve' })).status, 404, '行不存在');
  assert.equal((await post(handler, { id: 'd1', suggestion: '   ' })).status, 400, '空建议');

  /* 身份读不出来 → 409（"不知道你是谁"，不是"你不许"）。 */
  const blind = mountRoute(makeState({ rows: [OWNED], identity: { status: 'unavailable', reason: 'agent' } }));
  const blindRes = await post(blind, { id: 'd1', verdict: 'approve' });
  assert.equal(blindRes.status, 409);
  assert.equal(blindRes.payload.error.code, 'team-board/identity');
});

test('B6. 撤销函数与挂载失败都不炸：没有 connection 服务时返回 undefined（不是错误）', () => {
  const state = makeState({ rows: [] });
  const dispose = registerDecideRoute({ get: () => undefined }, state);
  assert.equal(dispose, undefined, '没有页面通道只是没有通道，不许因此让插件不激活');

  const noInject = {
    get(key) {
      if (key !== 'connection') return undefined;
      return { fetch: {} }; // 没有 register
    },
  };
  assert.equal(registerDecideRoute(noInject, state), undefined);
});

test('B7（Req6 补丁）. 没有合法决议的行发 retry → 400，且一次 writeback 都不许发生', async () => {
  /* 这条是 host/index.js 那个退化判据的回归钉。
   *
   * 旧判据 `row.verdict === null && row.verdict !== 'approve' && …`：
   * 左边成立时右边恒真，整个条件退化成 `row.verdict === null`。
   * 于是「字段根本不存在（undefined）」和「垃圾串」两种形态都会漏过去，
   * 真调一次 writeback 把来源系统写成"已批准"，还把 writeback_state 落成 'ok'
   * ——在页面上伪装成回写成功。B4 从"已拍板且已失败"的入口进，绕过了这条路。
   *
   * 判据方向：描述合法值集合时**枚举合法值**，不要枚举非法值。
   * 非法值的形态永远比你想到的多一个（undefined / null / '' / 大小写）。 */
  const shapes = [
    { name: 'verdict 字段缺失', row: { ...OWNED, id: 'd-missing' } },
    { name: 'verdict 是 null', row: { ...OWNED, id: 'd-null', verdict: null } },
    { name: 'verdict 是垃圾串（大小写不宽容）', row: { ...OWNED, id: 'd-junk', verdict: 'APPROVE' } },
    { name: 'verdict 是空串', row: { ...OWNED, id: 'd-empty', verdict: '' } },
  ];

  for (const shape of shapes) {
    const state = makeState({ rows: [shape.row] });
    const handler = mountRoute(state);
    const res = await post(handler, { id: shape.row.id, retry: true, sessionId: 's1' });

    assert.equal(res.status, 400, `${shape.name}：必须 400，不许放行`);
    assert.equal(
      state.calls.writeback,
      0,
      `${shape.name}：一次 writeback 都不许发生（放行等于把不存在的决议回写给来源系统）`,
    );
    assert.equal(state.calls.written.length, 0, `${shape.name}：一个字节都不许落盘`);
  }
});
/* ═══════════════════════════════════════════════════════════════════════════
 * C. K4 的结构断言：定高与"区块内不滚动"必须真写在规则上
 *
 * 这一节只读源码文本 —— 测不了浏览器里的 computed height（这个仓库没有 DOM），
 * 但能钉住"高度断言所依赖的那几条声明确实存在、且没有被 min-height 顶掉"。
 * 这是诚实的上限：**声明可断言，像素不可断言**（见 honestNote）。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 从 `client.js` 源码里取出一条规则的主体（按选择器字面找，找不到就红）。 */
function ruleBody(selector) {
  const index = SOURCE.indexOf(selector);
  assert.notEqual(index, -1, `源码里找不到规则 ${selector}`);
  const open = SOURCE.indexOf('{', index);
  const close = SOURCE.indexOf('}', open);
  assert.notEqual(open, -1);
  assert.notEqual(close, -1);
  return SOURCE.slice(open + 1, close);
}

test('C1（K4）. `.tb-drow` 是**定高** 92px（height，不是 min-height），且三段行高算得出来', () => {
  const body = ruleBody('.tb-drow {');
  assert.match(body, /height:\s*92px/, '必须是 height: 92px');
  assert.doesNotMatch(body, /min-height/, 'min-height 不是定高：内容一换行高度就变了，断言写不出来');
  assert.match(body, /box-sizing:\s*border-box/, 'border-box 才让 92px 包含内边距（算术才成立）');
  assert.match(body, /grid-template-rows:\s*34px\s+16px\s+24px/, '三段行高固定');
  assert.match(body, /overflow:\s*hidden/, '三段内容交给 overflow:hidden + 省略号，高度不让位');
});

test('C2（K4/D1）. 区块自身不设 max-height / overflow-y —— 7 条以内不出现滚动容器', () => {
  const body = ruleBody('.tb-decide {');
  assert.match(body, /max-height:\s*none/, '不许给区块设 max-height');
  assert.match(body, /overflow:\s*visible/, '不许给区块设滚动容器');
  assert.doesNotMatch(body, /overflow-y/, '一旦写了 overflow-y 就多了一个可滚动层');
});

test('C3（K4）. 窄窗口仍是两列 + 定高（改成三行会把 92px 破掉）', () => {
  const index = SOURCE.indexOf('@media (max-width: 780px)');
  const slice = SOURCE.slice(index, SOURCE.indexOf('}', SOURCE.indexOf('.tb-dbtn { padding: 1px 5px; }', index)));
  assert.match(slice, /\.tb-drow\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) 132px/, '窄窗口仍是两列');
  assert.doesNotMatch(slice, /grid-template-rows:\s*minmax\(0, 1fr\)/, '窄窗口不许退化成单列/多行');
});

test('C4（Req2/Req4）. 区块的计数只落 data-*：过滤、容量、待办、已拍板四个数都可机读', () => {
  assert.match(SOURCE, /'data-filtered-count':/, '过滤计数必须可读（Req2）');
  assert.match(SOURCE, /'data-filtered-admission':/, '准入挡下的条数');
  assert.match(SOURCE, /'data-filtered-slots':/, '槽位挡下的条数');
  assert.match(SOURCE, /'data-hidden-capacity':/, '容量收起数（与过滤数是两个数）');
  assert.match(SOURCE, /'data-pending':/, '待办计数（Req4 拍板后 -1）');
  assert.match(SOURCE, /'data-decided':/, '已拍板计数');
});

test('C5（Req2）. 六个槽位在渲染层也是可数的：每个都带 data-slot', () => {
  for (const key of ['title', 'options', 'impact', 'sourceRef', 'dueAt', 'default']) {
    assert.match(SOURCE, new RegExp(`'data-slot':\\s*'${key}'`), `渲染层缺槽位 ${key}`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * D. 端到端接线：真 createBoardState + 真 decide 路由
 *
 * 这一节挡的是这个仓库栽过好几次的那类事故 —— **代码写了、测了、线上走不到**
 * （`E_NO_ARTIFACT_BINDING` 记了七轮账、输出里一次都没出现）。
 * 所以这里不用 state 桩，而是用**真的状态机**：假 storage / agentTeams / agents，
 * 真 `createBoardState`，再真 `registerDecideRoute`，走一遍"落盘 → 路由 → 读回"。
 * ═══════════════════════════════════════════════════════════════════════════ */

const { createBoardState } = await import('../host/index.js');

function fakeCtx(adapter) {
  const tables = { state: {}, ledger: {} };
  const storage = {
    form() {
      return {
        open() {
          return Promise.resolve({
            async loadAll() {
              return { tables: { state: { ...tables.state }, ledger: { ...tables.ledger } } };
            },
            async putRecord(table, key, value) {
              tables[table][key] = value;
            },
          });
        },
      };
    },
  };
  const agentTeams = {
    membership() {
      return { name: 'yg' };
    },
    listTasks() {
      return [];
    },
    listMembers() {
      return [];
    },
  };
  const agents = { get: (id) => ({ id }) };
  const ctx = {
    tables,
    inject(_keys, factory) {
      return factory(ctx);
    },
    get(key) {
      if (key === 'storage') return storage;
      if (key === 'agentTeams') return agentTeams;
      if (key === 'agents') return agents;
      if (key === 'teamBoardWriteback') return adapter;
      if (key === 'connection') {
        return {
          fetch: {
            register(config) {
              ctx.registered = config;
              return () => {};
            },
          },
        };
      }
      return undefined;
    },
  };
  return ctx;
}

test('D1. 真状态机：写入 → 读回 → 投影，三态与 mine 都对；无适配器时回写如实失败', async () => {
  const ctx = fakeCtx();
  const state = createBoardState(ctx);

  const empty = await state.readDecisions();
  assert.equal(empty.status, 'empty', '一行都没有 = empty（**不是** unavailable）');

  await state.writeDecision({ ...OWNED, owner: 'yg' });
  await state.writeDecision({ ...OWNED, id: 'd2', owner: 'someone-else' });

  const read = await state.readDecisions();
  assert.equal(read.status, 'ok');
  assert.deepEqual(read.rows.map((row) => row.id), ['d1', 'd2'], '按 id 稳定排序（同一份存储每次同序）');
  assert.equal('enabled' in ctx.tables.state, false, '不该顺手写开关');

  const projected = await state.projectDecisions([], 'yg');
  assert.equal(projected.status, 'ok');
  assert.equal(projected.rows.find((row) => row.id === 'd1').mine, true);
  assert.equal(projected.rows.find((row) => row.id === 'd2').mine, false, '别人的行 mine=false（界面据此禁按钮）');

  const who = await state.identity('s1');
  assert.deepEqual(who, { status: 'ok', name: 'yg' });

  /* 行上没有 source_ref、宿主也没有 teamBoardWriteback 服务 → 如实失败，不假装成功。 */
  const written = await state.writeback({ ...OWNED, verdict: 'approve' });
  assert.equal(written.status, 'failed');
  assert.equal(written.message, 'no-writeback-adapter');
});

test('D2. 真路由 + 真状态机：拍板落盘、回写失败留痕、读回仍是已拍板（不消失）', async () => {
  /* 回写走**适配器通道**（第一条通道），且它必失败：这样这一条既测到"失败留痕"，
   * 又不会真的往外网打一个 POST（`source_ref` 是完整条目必须有的，不能拿掉）。 */
  const ctx = fakeCtx({
    async write() {
      throw new Error('adapter-down');
    },
  });
  const state = createBoardState(ctx);
  await state.writeDecision({ ...goodRow({ id: 'd1' }) });

  const dispose = registerDecideRoute(ctx, state);
  assert.equal(typeof dispose, 'function');
  assert.equal(ctx.registered.path, '/api/team-board/decide');
  const handler = ctx.registered.fetch;

  const response = await post(handler, { id: 'd1', verdict: 'approve', sessionId: 's1' });
  assert.equal(response.status, 200);
  assert.equal(response.payload.value.row.writeback_state, 'failed', '没有回写通道 → 失败（不是静默成功）');

  /* 关键：**从存储读回来**，不是只看响应里的对象。 */
  const read = await state.readDecisions();
  const persisted = read.rows.find((row) => row.id === 'd1');
  assert.equal(persisted.status, 'decided');
  assert.equal(persisted.verdict, 'approve');
  assert.equal(persisted.decided_by, 'yg');
  assert.equal(persisted.writeback_state, 'failed');
  assert.equal(persisted.writeback_error, 'adapter-down');

  /* 再把这份真实存储数据喂给客户端的判定函数：已拍板的行必须留在清单里。 */
  const projected = await state.projectDecisions([], 'yg');
  const view = P.selectDecisions(projected);
  assert.equal(view.rows.length, 1, '拍过 + 回写失败的行仍然在清单里');
  assert.equal(view.pending, 0, '待办计数 -1');
  assert.equal(view.rows[0].writebackState, 'failed');
});

test('D3. 任务上**显式声明**的 decision 会被投影进来；没声明的一点都不编', async () => {
  const ctx = fakeCtx();
  const state = createBoardState(ctx);
  const tasks = [
    { id: 't1', ownerName: 'yg', kind: 'implementation', decision: { title: '上线时间', blocking: true, writeback: 'yes', default_value: null, options: ['准', '驳'], impact: '晚一天', source_ref: 'https://x.test/1', due_at: '2026-11-25' } },
    { id: 't2', ownerName: 'yg', kind: 'review' },
  ];
  const projected = await state.projectDecisions(tasks, 'yg');
  assert.equal(projected.status, 'ok');
  assert.equal(projected.rows.length, 1, '只投影声明过的：t2 没声明，不许从 subject/status 反推一条');
  assert.equal(projected.rows[0].id, 'task:t1', '没给 id 时用 task:<id>，可被指认');
  assert.equal(projected.rows[0].mine, true);
  assert.equal(projected.rows[0].source_system, 'implementation', '分组键缺省取任务 kind');
});
