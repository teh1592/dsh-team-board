/**
 * Client 侧测试（第 9 轮 W8）：只测**纯函数**，不测渲染、不碰 DOM。
 *
 * 做法：把 `plugin/client.js` 当源码读进来，在假的 `window.__ModuleLoader__` 里执行它的
 * factory，拿到模块导出的 `pure`。这样测的是**真正会跑在浏览器里的那份代码**，
 * 不是为测试另写一份影子实现。
 *
 * `t` 直接用 `locale/zh.json` 建 —— 于是"文案 key 写错"这类错在这一层就会红。
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
const EN = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'));

/** 用某个字典造一个 `t`：支持 `{name}` 插值，缺 key 时回落成 key 本身。 */
function makeT(dict) {
  return (key, vars) => {
    const raw = dict[key];
    if (typeof raw !== 'string') return key;
    if (vars === undefined) return raw;
    return raw.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
  };
}

/** `t` 解析用的字典。**它不是 locale/zh.json 的副本，而是运行时的合表。**
 *
 * 理由：`apply` 里有一句 `ctx.locale.register(NS, { zh, en })`，把 `client.js` 自带的
 * 补充文案并进**同一个命名空间**。所以用户看到的 `t('board.undeclared')` 能解析出
 * 「未声明」；而如果测试的 `t` 只建在 locale/zh.json 上，同一个调用会回落成 key 本身 ——
 * 于是测试通过、页面却是「board.undeclared」。那正是本项目栽过的那类"看着对"。
 *
 * `makeT` 闭包读的是这个对象本身，所以下面用 `Object.assign` 把客户端表并进来即可，
 * 不需要重新造 `t`。 */
const DICT = { ...ZH };
const t = makeT(DICT);

/** 执行 client.js，返回模块导出。 */
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

/** 把 `client.js` 自带的那两张表取出来（apply 时通过 ctx.locale.register 交出）。 */
function captureClientDicts() {
  let captured = { zh: {}, en: {} };
  MODULE.apply({
    effect(execute) { const inner = execute(); return () => { if (typeof inner === 'function') inner(); }; },
    locale: { register(_ns, value) { captured = value; return () => {}; }, bind() { return t; } },
    slots: { inject(_key, factory) { factory(); }, register() { return () => {}; } },
  });
  return captured;
}
const CLIENT_DICTS = captureClientDicts();
/* 并进 `t` 的字典 —— 从此 `t` 解析的就是运行时那张合表。 */
Object.assign(DICT, CLIENT_DICTS.zh);

/* ------------------------------------------------------------------------- */
/* 7. 数据源 → 标题文案；不可用不得显示成"0 个成员"                              */
/* ------------------------------------------------------------------------- */

test('7a. 三种数据源各有一句标题，且互不相同', () => {
  const teams = P.sourceTitle('agentTeams', t);
  const roster = P.sourceTitle('roster', t);
  const none = P.sourceTitle('unavailable', t);
  assert.equal(teams, ZH['source.agentTeams']);
  assert.equal(roster, ZH['source.roster']);
  assert.equal(none, ZH['source.unavailable']);
  assert.equal(new Set([teams, roster, none]).size, 3, '三态必须长得不一样');
});

test('7b. 不可用：没有数字、不出现"0 个"，与"0 条数据"可区分', () => {
  const detail = P.sourceDetail({ kind: 'unavailable' }, t);
  assert.equal(detail.count, null, '不可用时不许给出计数');
  assert.doesNotMatch(detail.text, /0\s*个/, '不可用不能显示成 0 个成员');
  assert.match(detail.text, /不可用|拿不到数据/);

  const zero = P.sourceDetail({ kind: 'roster', total: 0, running: 0 }, t);
  assert.equal(zero.count, 0, '空名册仍然是可用的 0');
  assert.match(zero.text, /0\s*个/, '可用的 0 必须显示成 0 个（空与不可用可区分）');
  assert.notEqual(zero.text, detail.text);
});

test('7c. total 读不出来 → 不可用（绝不显示成 0）；真的 total: 0 仍然显示 0 个', () => {
  /* 宿主读花名册失败时给的是 `{ kind }`，**没有 total**（`host/index.js:552-555`：
   * 只有读成功才填 total/running）。原来 client.js 写
   * `Number.isInteger(source.total) ? source.total : 0`，把"没读到"变成「0 个（0 在跑）」
   * —— 违反本页自己的红线「空 ≠ 不可用」。 */
  const unreadable = [
    { kind: 'roster' },                                  // 读失败 → 只有 kind
    { kind: 'roster', total: null },
    { kind: 'roster', running: 0 },                       // total 缺失
    { kind: 'agentTeams', total: '3', running: 0 },       // 不是整数
    { kind: 'agentTeams', total: 5 },                     // running 缺失：不许默认成「0 在跑」
    { kind: 'roster', status: 'unavailable', reason: 'read' },
  ];
  for (const bad of unreadable) {
    const detail = P.sourceDetail(bad, t);
    assert.equal(detail.count, null, `读不出来时不许给计数：${JSON.stringify(bad)}`);
    assert.doesNotMatch(detail.text, /\d+\s*个/, `读不出来时不许出现「N 个」：${detail.text}`);
  }
  /* 宿主给了 reason 就把它露出来（否则运维不知道是哪一段读不到），但仍然没有数字。 */
  assert.match(P.sourceDetail({ kind: 'roster', status: 'unavailable', reason: 'read' }, t).text, /read/);

  /* 真的零个：读到了，就是 0 —— 必须照常显示「0 个（0 在跑）」。 */
  const zero = P.sourceDetail({ kind: 'roster', total: 0, running: 0 }, t);
  assert.equal(zero.count, 0, '真的 0 条仍然是可用的 0');
  assert.match(zero.text, /0\s*个（0 在跑）/);

  /* 有数照搬。 */
  const some = P.sourceDetail({ kind: 'roster', total: 4, running: 2 }, t);
  assert.equal(some.count, 4);
  assert.match(some.text, /4\s*个（2 在跑）/);

  /* 两种「零」必须长得不一样：知道是零 vs 根本读不到。 */
  assert.notEqual(P.sourceDetail({ kind: 'roster' }, t).text, zero.text);
});

/* ------------------------------------------------------------------------- */
/* 8. 花名册行：label 缺失 → (未命名)；activity 两种字形                          */
/* ------------------------------------------------------------------------- */

test('8a. label 缺失或空白 → (未命名)', () => {
  assert.match(P.rosterLine({ activity: 'running' }, t), /\(未命名\)/);
  assert.match(P.rosterLine({ label: '   ', activity: 'inactive' }, t), /\(未命名\)/);
  assert.match(P.rosterLine({ label: null }, t), /\(未命名\)/);
});

test('8b. activity 两种字形分别是 🔄 与 ·', () => {
  const running = P.rosterLine({ label: '写迁移脚本', activity: 'running', depth: 1 }, t);
  const idle = P.rosterLine({ label: '写迁移脚本', activity: 'inactive', depth: 1 }, t);
  assert.match(running, /🔄/);
  assert.match(idle, /·/);
  assert.doesNotMatch(idle, /🔄/);
  assert.match(running, /写迁移脚本/);
  assert.match(P.rosterLine({ label: '子派生', activity: 'inactive', depth: 3 }, t), /深度 3/);
});

/* ------------------------------------------------------------------------- */
/* 9. 台账行：五个数字都在；0 也要显示 0                                         */
/* ------------------------------------------------------------------------- */

test('9a. 五个数字一个不少，全零时也必须显示 0（不许省略）', () => {
  const row = P.ledgerLine(
    { id: 'w3', stats: { completed: 0, abortedWithOutput: 0, abortedWithoutOutput: 0, failed: 0, failedWithoutOutput: 0 }, pitfalls: '' },
    t,
  );
  for (const label of ['完成 0', '有产出中止 0', '空转 0', '失败 0', '空手失败 0']) {
    assert.ok(row.head.includes(label), `台账行必须出现「${label}」，实际：${row.head}`);
  }
  assert.ok(row.head.startsWith('w3'));
  assert.match(row.pitfalls, /—/, '没有坑时给破折号，不是空串');
});

test('9b. 有数字时逐字照搬，坑也照搬', () => {
  const row = P.ledgerLine(
    { id: 'w3', stats: { completed: 3, abortedWithOutput: 0, abortedWithoutOutput: 0, failed: 1, failedWithoutOutput: 1 }, pitfalls: '改一半没跑测试' },
    t,
  );
  assert.match(row.head, /完成 3/);
  assert.match(row.head, /失败 1/);
  assert.match(row.head, /空手失败 1/);
  assert.match(row.head, /空转 0/);
  assert.match(row.pitfalls, /改一半没跑测试/);
});

test('9c. 缺字段/畸形数字一律当 0，不出现 NaN', () => {
  const row = P.ledgerLine({ id: 'w9', stats: { completed: 'x', failed: Number.NaN } }, t);
  assert.doesNotMatch(row.head, /NaN/);
  assert.match(row.head, /完成 0/);
  assert.match(row.head, /失败 0/);
  assert.equal(P.count(undefined), '0');
  assert.equal(P.count(Number.NaN), '0');
});

/* ------------------------------------------------------------------------- */
/* 10. 门禁结论分组：blocker 与 warning 不混                                    */
/* ------------------------------------------------------------------------- */

test('10a. blocker 与 warning 各自成组，绝不互相串', () => {
  /* 这里必须用一个**确实没有译文**的码。原来用的是 `E_CONTRACT_INCOMPLETE`，
   * 但第 12 轮 locale 成员把 33 条码补上译文之后（`gates.code.*` 从 2 条变成 35 条），
   * 那个码已经有中文名了 —— 例子失效，断言于是变红。
   * 教训：拿"当前恰好没译文"的码当固定例子，会随别人的补译而烂。
   * 所以改成用自造的码，并在下面**先断言它确实没译文**，让这条测试自己守住前提。 */
  const untranslated = 'E_NOT_A_REAL_CODE_10A';
  assert.equal(ZH[`gates.code.${untranslated}`], undefined, '前提：这个码必须没有译文，否则本条测不到「无译文」');
  const groups = P.gateGroups(
    {
      status: 'ok',
      ok: false,
      phaseKnown: true,
      blockers: [{ code: untranslated, message: '缺验收项' }],
      warnings: [{ code: 'E_INDEPENDENCE_UNENFORCED', taskId: '', message: '独立性未生效' }],
    },
    t,
  );
  assert.equal(groups.status, 'ok');
  assert.equal(groups.ok, false);
  assert.deepEqual(groups.blockers.map((r) => r.code), [untranslated]);
  assert.deepEqual(groups.warnings.map((r) => r.code), ['E_INDEPENDENCE_UNENFORCED']);
  /* 原断言写的是 `label === 'E_CONTRACT_INCOMPLETE'`（原样吐裸 code），
   * 那等于给「E_XXX E_XXX」盖了章。没有专门文案时 label 必须是 null。 */
  assert.equal(groups.blockers[0].label, null, '没有专门文案 → label 为 null（绝不是裸 code）');
  assert.match(groups.warnings[0].label, /独立性未生效/);
  /* message 必须穿过 gateGroups：以前实现保留、但没有任何断言钉住它，
   * 于是"哪天被顺手删掉"是无声的（第 12 轮 B-2 第 3 条的缺口就在这里）。 */
  assert.equal(groups.blockers[0].message, '缺验收项', 'message 不许在分组时丢掉');
  assert.equal(groups.warnings[0].message, '独立性未生效');
  assert.equal(groups.blockerGroups.hard[0].message, '缺验收项', '分组视图也必须带着 message');
});

test('10b. 两条必看的 code 都有文案（E_INDEPENDENCE_UNENFORCED / E_DECLARATION_MISSING）', () => {
  for (const code of ['E_INDEPENDENCE_UNENFORCED', 'E_DECLARATION_MISSING']) {
    assert.equal(typeof ZH[`gates.code.${code}`], 'string');
    assert.equal(typeof EN[`gates.code.${code}`], 'string');
    assert.notEqual(P.codeKey(code, t), null, `${code} 必须映射到文案，而不是 null`);
    assert.notEqual(P.codeKey(code, t), code, `${code} 的 label 不许是 code 本身`);
  }
});

test('10c. 没有译文的 code：页面上只出现一次（原断言给「E_XXX E_XXX」盖了章）', () => {
  const code = 'E_SOMETHING_NEW';
  const groups = P.gateGroups(
    { status: 'ok', ok: true, blockers: [{ code, message: '这条没登记文案' }], warnings: [] },
    t,
  );
  const row = groups.blockers[0];

  assert.equal(row.code, code, '码本身就是数据，不许在分组时丢掉');
  /* 原断言是 `assert.ok(row.label.includes('E_SOMETHING_NEW'))` ——
   * 它把"label 里再写一遍裸 code"写成了期望值，于是渲染层把码铺两遍也没人红。
   * 正确形状：没有译文时 label 为 null，码只在渲染层出现一次。 */
  assert.equal(row.label, null, '没有译文时 label 必须是 null，不许回落成裸 code');
  assert.equal(P.codeKey(code, t), null, 'codeKey 不许把裸 code 当文案返回');

  const shown = P.gateRowText(row);
  assert.equal(shown.split(code).length - 1, 1, `一行里这个码只许出现一次，实际渲染：${shown}`);
  assert.equal(shown, code, `没有文案时这一行就是码本身（不留尾随空格／空 span），实际：${shown}`);
  assert.ok(!shown.includes(`${code}  ${code}`), '绝不出现「E_XXX  E_XXX」');
});

test('10c2. 有译文的 code：仍然是「码 + 人话」，且码同样只出现一次', () => {
  const code = 'E_DECLARATION_MISSING';
  const row = P.gateGroups({ status: 'ok', ok: true, blockers: [{ code, message: 'x' }], warnings: [] }, t).blockers[0];
  const shown = P.gateRowText(row);
  assert.equal(shown.split(code).length - 1, 1, `一行里这个码只许出现一次，实际渲染：${shown}`);
  assert.match(shown, /任务未声明 kind/, '人话文案要在这一行里');
  assert.equal(shown, `${code}  任务未声明 kind`);
  /* taskId 有值时接在尾部，仍然不带第二个码。 */
  const withTask = P.gateGroups(
    { status: 'ok', ok: true, blockers: [{ code, taskId: 'T3', message: 'x' }], warnings: [] },
    t,
  ).blockers[0];
  assert.equal(P.gateRowText(withTask), `${code}  任务未声明 kind · T3`);
  assert.equal(P.gateRowText(withTask).split(code).length - 1, 1);
});

test('10d. 不可用时两组都空，且给出 reason（不是伪装成"没有阻断"）', () => {
  const groups = P.gateGroups({ status: 'unavailable', reason: 'agentTeams' }, t);
  assert.equal(groups.status, 'unavailable');
  assert.equal(groups.ok, null, '不可用不许写成 ok:true');
  assert.deepEqual(groups.blockers, []);
  assert.deepEqual(groups.warnings, []);
  assert.equal(groups.reason, 'agentTeams');
});

test('10e. 畸形输入不抛', () => {
  for (const value of [undefined, null, 'x', 42, {}, { status: 'ok' }, { status: 'ok', blockers: [null, 1, {}] }]) {
    const groups = P.gateGroups(value, t);
    assert.ok(Array.isArray(groups.blockers));
    assert.ok(Array.isArray(groups.warnings));
    assert.ok(Array.isArray(groups.blockerGroups.hard));
    assert.ok(Array.isArray(groups.blockerGroups.precondition));
  }
});

/* ------------------------------------------------------------------------- */
/* 10f/10g. 阻断分两组（第 11 轮裁决）：真阻断要改代码 / 前提缺失要补信息            */
/* ------------------------------------------------------------------------- */

test('10f. 阻断按「改代码能否解决」分两组，且两组之和等于全部阻断（不丢一条）', () => {
  const groups = P.gateGroups(
    {
      status: 'ok',
      ok: false,
      phaseKnown: false,
      blockers: [
        { code: 'E_INPUT_INVALID', message: 'kind 拼错' },
        { code: 'E_NEEDS_HUMAN_DELIVERY', message: '没有宿主签发的交付记录' },
        { code: 'E_NOT_RUNNING', message: '阶段未知' },
        { code: 'E_TASK_INCOMPLETE', message: '任务还没结论' },
        { code: 'E_SELF_REVIEW', message: '自审' },
      ],
      warnings: [],
    },
    t,
  );
  /* E_INPUT_INVALID 归「前提缺失」（第 12 轮 B-2）：它说的是"你没给对东西"（kind 拼错、
   * round 传了字符串），不是"这活不合格"，改代码解决不了 —— 重传一份合法入参才解决。 */
  assert.deepEqual(groups.blockerGroups.hard.map((r) => r.code), ['E_TASK_INCOMPLETE', 'E_SELF_REVIEW']);
  assert.deepEqual(groups.blockerGroups.precondition.map((r) => r.code), [
    'E_INPUT_INVALID',
    'E_NEEDS_HUMAN_DELIVERY',
    'E_NOT_RUNNING',
  ]);
  assert.equal(groups.blockerGroups.precondition[0].precondition, true, '归组要反映到行上的 precondition 标记');
  assert.equal(groups.blockerGroups.precondition[0].message, 'kind 拼错', '分组视图不许丢 message');
  assert.equal(
    groups.blockerGroups.hard.length + groups.blockerGroups.precondition.length,
    groups.blockers.length,
    '分组不许吞掉任何一条阻断',
  );
  /* 扁平数组仍是原序（第 10a 条与页面计数都靠它），分组只是视图。 */
  assert.deepEqual(groups.blockers.map((r) => r.code), [
    'E_INPUT_INVALID',
    'E_NEEDS_HUMAN_DELIVERY',
    'E_NOT_RUNNING',
    'E_TASK_INCOMPLETE',
    'E_SELF_REVIEW',
  ]);
});

test('10g. 未登记的新 code 落在「真阻断」，不许藏进「前提缺失」', () => {
  const groups = P.gateGroups(
    { status: 'ok', ok: false, blockers: [{ code: 'E_BRAND_NEW', message: 'x' }], warnings: [] },
    t,
  );
  assert.deepEqual(groups.blockerGroups.hard.map((r) => r.code), ['E_BRAND_NEW']);
  assert.deepEqual(groups.blockerGroups.precondition, []);
  assert.equal(groups.blockers[0].precondition, false);
});

test('10h. 两组都有文案（zh + en），且标题互不相同', () => {
  for (const dict of [ZH, EN]) {
    assert.equal(typeof dict['gates.group.hard'], 'string');
    assert.equal(typeof dict['gates.group.precondition'], 'string');
    assert.equal(typeof dict['gates.group.preconditionHint'], 'string');
    assert.notEqual(dict['gates.group.hard'], dict['gates.group.precondition']);
  }
});

/* ------------------------------------------------------------------------- */
/* 11. 注入降级：@me / blockedBy: / ! 不得以半角原样出现                          */
/* ------------------------------------------------------------------------- */

test('11a. label 里的 @me / blockedBy: / ! 全部降级成全角', () => {
  const evil = '@me blockedBy: T1 !important';
  const line = P.rosterLine({ label: evil, activity: 'running' }, t);
  assert.doesNotMatch(line, /@me/, '不许出现半角 @me');
  assert.doesNotMatch(line, /blockedBy:/, '不许出现半角 blockedBy:');
  assert.doesNotMatch(line, /!/, '不许出现半角感叹号');
  assert.match(line, /＠me/);
  assert.match(line, /blockedBy：/);
  assert.match(line, /！important/);
  assert.ok(line.includes('blockedBy'), '内容本身不丢，只是降级成全角');
});

test('11b. 台账 id 与坑同样降级（只读展示不该长得像任务行）', () => {
  const row = P.ledgerLine({ id: '@me', stats: {}, pitfalls: 'blockedBy: T1 | `x`' }, t);
  assert.doesNotMatch(row.head, /@me/);
  assert.doesNotMatch(row.pitfalls, /blockedBy:/);
  assert.doesNotMatch(row.pitfalls, /\|/);
  assert.doesNotMatch(row.pitfalls, /`/);
  assert.match(row.pitfalls, /｜/);
  assert.match(row.pitfalls, /｀/);
});

/* ------------------------------------------------------------------------- */
/* 12. 文案完整性：client.js 用到的 key 必须在 zh 与 en 里都在                    */
/* ------------------------------------------------------------------------- */

test('12a. client.js 里出现的每个 t(\'…\') 字面 key 都在 zh/en 里', () => {
  const keys = new Set();
  const pattern = /\bt\('([^'\\]+)'\)/g;
  let match;
  while ((match = pattern.exec(SOURCE)) !== null) keys.add(match[1]);
  assert.ok(keys.size >= 20, `至少要扫到 20 个 key，实际 ${keys.size}`);
  for (const key of keys) {
    assert.equal(typeof ZH[key], 'string', `zh.json 缺 ${key}`);
    assert.equal(typeof EN[key], 'string', `en.json 缺 ${key}`);
  }
});

test('12b. zh 与 en 的 key 集合完全一致（不留单边文案）', () => {
  const zhKeys = Object.keys(ZH).filter((k) => k !== 'meta').sort();
  const enKeys = Object.keys(EN).filter((k) => k !== 'meta').sort();
  assert.deepEqual(zhKeys, enKeys);
  for (const dict of [ZH, EN]) {
    assert.equal(typeof dict.meta.title, 'string');
    assert.equal(typeof dict.meta.description, 'string');
  }
  assert.equal(ZH['tab.ledger'], '台账');
  assert.equal(EN['tab.ledger'], 'Ledger');
});

/* ------------------------------------------------------------------------- */
/* 13. 挂点：注册到 conversation.view，排在「编队」(30) 之后                      */
/* ------------------------------------------------------------------------- */

test('13. apply 把页面注册到 conversation.view（order 40、id team-board、label=台账）', () => {
  const registered = [];
  let localeNamespace;
  const ctx = {
    effect(execute) {
      const inner = execute();
      return () => {
        if (typeof inner === 'function') inner();
      };
    },
    locale: {
      register(namespace) {
        localeNamespace = namespace;
        return () => {};
      },
      bind() {
        return t;
      },
    },
    slots: {
      inject(key, factory) {
        assert.equal(key, 'conversation.view');
        factory();
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  };
  MODULE.apply(ctx);
  assert.equal(localeNamespace, 'team-board');
  assert.equal(registered.length, 1);
  const { options } = registered[0];
  assert.equal(options.name, 'conversation.view');
  assert.equal(options.id, 'team-board');
  assert.equal(options.order, 40, '必须排在 dsh-context 的编队(30)之后');
  assert.equal(typeof options.label, 'function');
  assert.equal(options.label(), '台账');
  assert.equal(typeof options.inject, 'function', '会话作用域要拿到 sessionId');
  assert.equal(options.inject('session-1').sessionId, 'session-1');
  assert.equal(typeof registered[0].component, 'function');
});

/* ------------------------------------------------------------------------- */
/* 14. 导出形状：inject 只能是加载器服务名                                       */
/* ------------------------------------------------------------------------- */

/**
 * 这一条挡的是**静默**失败，值得单独说明：
 *
 * 客户端模块导出的 `inject` 里混着两种名字，**两种都要写**：
 *   - `'loader'` —— 加载器服务名（`dsh-client-modules/lib/client.js:999` 导出的就是 `["loader"]`）；
 *   - `'locale'` / `'slots'` —— apply 里真正用到的业务服务（`ctx.locale`、`ctx.slots`）。
 *
 * **少声明一个服务名不会报错，只会让条目永久停在 `loading`** —— cordis 里未声明
 * 的服务若尚未就绪，拿到的是未解析代理，`ctx.slots.inject(...)` 会挂在一次永不
 * settle 的等待上；审计词表里 `loading` 的定义正是「fiber 已存在、apply 在飞」。
 * 这就是这个 bug 能活下来的唯一原因：`node --check` 绿、纯函数测试绿、手动调
 * factory 也绿，只有真启动一个宿主才看得见。
 *
 * 所以这条断言钉的是**完整数组**，不是"包含 loader"：少一项就红。
 * 服务名合法性来源：`dsh-client-ui-conversation/lib/client.js:22547`、
 * `dsh-client-ui-sidebar/lib/client.js:666`、`dsh-client-ui-layout/lib/client.js:655`、
 * `dsh-client-locale/lib/client.js:1779` 都写着 "slots" 与 "locale"。
 */
test('14. 导出的 inject = 加载器服务名 + apply 用到的业务服务（少一项就静默停在 loading）', () => {
  assert.deepEqual(MODULE.inject, ['loader', 'locale', 'slots'], '少声明业务服务会让条目永久停在 loading');
  assert.equal(MODULE.inject.includes('loader'), true, '缺 loader：加载器根本不执行本模块');
  assert.equal(MODULE.inject.includes('locale'), true, 'apply 用了 ctx.locale，必须声明');
  assert.equal(MODULE.inject.includes('slots'), true, 'apply 用了 ctx.slots，必须声明');
  assert.equal(MODULE.inject.includes('@deepseek-ai/dsh-client-ui-conversation'), false, '包名属于 package.json 的 dsh.client.inject');
  // 导出形状的其余部分不能被这条改动带坏。
  assert.equal(typeof MODULE.apply, 'function');
  assert.equal(typeof MODULE.pure, 'object');
  assert.equal(typeof MODULE.pure.gateGroups, 'function');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 第 13 轮重做：以下全部是新增断言。测的是"页面形状"这件事本身，
 * 不是"样式写没写"。每一条都能真的红 —— 把对应逻辑改坏，它会报错。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 一组够复杂的门禁数据：同一个码 ×4、一个任务被两个根因打、一个根因不落在任务上。 */
function fixtureGates() {
  return {
    status: 'ok',
    ok: false,
    phaseKnown: true,
    blockers: [
      /* 同一件事的连带：4 条 blocker 都是 E_TASK_INCOMPLETE，只是任务不同。 */
      { code: 'E_TASK_INCOMPLETE', taskId: 'task-1', message: '任务 task-1 还没有结论' },
      { code: 'E_TASK_INCOMPLETE', taskId: 'task-2', message: '任务 task-2 还没有结论' },
      { code: 'E_TASK_INCOMPLETE', taskId: 'task-4', message: '任务 task-4 还没有结论' },
      { code: 'E_TASK_INCOMPLETE', taskId: 'task-7', message: '任务 task-7 还没有结论' },
      /* 另一个独立根因，落在 task-1 上 —— 于是 task-1 被两个根因同时打中。 */
      { code: 'E_SELF_REVIEW', taskId: 'task-1', message: '自审没过' },
      /* 不落在任何任务上（宿主没给阶段）→ 图上必须是「全局」节点，不许被删。 */
      { code: 'E_NOT_RUNNING', message: '团队阶段未知' },
    ],
    warnings: [{ code: 'E_INDEPENDENCE_UNENFORCED', taskId: 'task-2', message: '独立性未生效' }],
  };
}

/* ------------------------------------------------------------------------- */
/* 15. 客户端自带文案表：K 里的 key 两张表都有，且两张表 key 集合一致              */
/* ------------------------------------------------------------------------- */

test('15. K 里的每个 key 在客户端 zh/en 两张表里都在，且两张表 key 集合一致', () => {
  /* 为什么需要这条：K 这批 key 只有页面在用，暂住 `client.js` 自带的 zh/en 表
   * （`locale/*.json` 是另一个成员的写域）。第 12a 条只扫 `t('字面量')`，
   * 扫不到 `t(K.xxx)` —— 所以这里直接对着**运行时真正注册进去的那两张表**断言，
   * 比 12a 更强：12a 只能证明 locale 文件里有，证明不了运行时表里有。 */
  let dicts;
  const ctx = {
    effect(execute) { const inner = execute(); return () => { if (typeof inner === 'function') inner(); }; },
    locale: { register(_ns, value) { dicts = value; return () => {}; }, bind() { return t; } },
    slots: { inject(_key, factory) { factory(); }, register() { return () => {}; } },
  };
  MODULE.apply(ctx);
  assert.ok(dicts !== undefined, 'apply 必须把 zh/en 注册进 locale');
  const keys = Object.keys(P.K).map((name) => P.K[name]);
  assert.ok(keys.length >= 15, `K 里的 key 太少（${keys.length}），像是被顺手删了`);
  for (const key of keys) {
    assert.equal(typeof dicts.zh[key], 'string', `客户端 zh 表缺 ${key}`);
    assert.equal(typeof dicts.en[key], 'string', `客户端 en 表缺 ${key}`);
  }
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort(), '客户端两张表不许留单边文案');
});

/* ------------------------------------------------------------------------- */
/* 16. 按码聚合：同一个 code 只出现一次，带 ×N 与受影响任务                        */
/* ------------------------------------------------------------------------- */

test('16a. 四条同码阻断聚合成一组，count=4，任务清单去重且保序', () => {
  const groups = P.gateGroups(fixtureGates(), t);
  const issues = P.aggregateIssues(groups, t);
  const incomplete = issues.filter((issue) => issue.code === 'E_TASK_INCOMPLETE');
  assert.equal(incomplete.length, 1, '同一个 code 只许出现一次（这正是"十条看着像十件事"的病根）');
  assert.equal(incomplete[0].count, 4, '×4 必须对');
  assert.deepEqual(incomplete[0].taskIds, ['task-1', 'task-2', 'task-4', 'task-7'], '受影响任务按首次出现保序');
  assert.equal(incomplete[0].tone, 'hard');
  assert.equal(incomplete[0].messages.length, 4, '每一条的原文都要留着（展开才看单条）');
  assert.match(incomplete[0].label, /未声明|结论|完成/, '有译文时 label 是人话，不是裸码');
});

test('16b. 三档 tone 不混：hard / precondition / warning 各归各位，且按严重度排序', () => {
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  assert.deepEqual(issues.map((issue) => issue.tone), ['hard', 'hard', 'precondition', 'warning']);
  assert.deepEqual(issues.map((issue) => issue.code), [
    'E_TASK_INCOMPLETE', 'E_SELF_REVIEW', 'E_NOT_RUNNING', 'E_INDEPENDENCE_UNENFORCED',
  ]);
  /* 三条阻断 + 一条警告：警告排最后，绝不因为"先出现"就跑到阻断前面。 */
  assert.equal(issues[issues.length - 1].tone, 'warning');
});

/* ------------------------------------------------------------------------- */
/* 17. 关系图：根因 ↔ 受影响任务（这一块是"线表示关系"的落点）                      */
/* ------------------------------------------------------------------------- */

test('17a. 连线数正确；一个任务被 2 个根因打中就有 2 条线指向它', () => {
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  const layout = P.graphLayout(issues);

  /* 4（E_TASK_INCOMPLETE→1,2,4,7）+ 1（E_SELF_REVIEW→1）+ 0（E_NOT_RUNNING 不落在任务上）
   * + 1（warning→2）= 6 条 */
  assert.equal(layout.links.length, 6, `连线数不许算错，实际 ${layout.links.length}`);

  const task1 = layout.tasks.find((task) => task.id === 'task-1');
  assert.equal(task1.hits, 2, 'task-1 同时被 E_TASK_INCOMPLETE 与 E_SELF_REVIEW 打中');
  const into = layout.links.filter((link) => link.to === 'task-1');
  assert.equal(into.length, 2, '被两个根因打中 → 必须有两条线指向它（否则这个信息在页面上不存在）');
  assert.equal(new Set(into.map((link) => link.tone)).size, 1, '两条线都来自 hard 组');

  /* task-2 也被两个"不同组"的东西打中（阻断 + 警告）。 */
  const task2 = layout.tasks.find((task) => task.id === 'task-2');
  assert.equal(task2.hits, 2);
  assert.equal(new Set(layout.links.filter((link) => link.to === 'task-2').map((link) => link.tone)).size, 2,
    'task-2 的线来自两个不同颜色 —— 图上看得出"两种性质的问题同时压着它"');
});

test('17b. 不落在任何任务上的根因：留在图上、linkCount=0、标「全局」（不许静默丢弃）', () => {
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  const layout = P.graphLayout(issues);
  const global = layout.causes.filter((cause) => cause.code === 'E_NOT_RUNNING');
  assert.equal(global.length, 1, 'E_NOT_RUNNING 不落在任务上，但它是真阻断，不许从图上消失');
  assert.equal(global[0].linkCount, 0);
  assert.equal(global[0].global, true, '没有线的根因要标成「全局」，否则读者会以为漏画了线');
  assert.equal(layout.causes.length, issues.length, '每个根因都必须在图上有一个节点，一个不少');
});

test('17c. 任务封顶：超出时只画上限那么多，并把超出的条数如实写出来', () => {
  const blockers = [];
  for (let i = 0; i < 30; i += 1) blockers.push({ code: 'E_TASK_INCOMPLETE', taskId: `task-${i}`, message: 'x' });
  const issues = P.aggregateIssues(P.gateGroups({ status: 'ok', ok: false, blockers, warnings: [] }, t), t);
  const capped = P.graphLayout(issues, { maxTasks: 24 });
  assert.equal(capped.tasks.length, 24, '任务数必须封顶');
  assert.equal(capped.hiddenTasks, 6, '超出的 6 条必须被算出来（页面上要写「…还有 6 条」）');
  const all = P.graphLayout(issues, { maxTasks: 100 });
  assert.equal(all.tasks.length, 30);
  assert.equal(all.hiddenTasks, 0);
});

test('17d. 几何是索引算术：宽高与贝塞尔控制点都必须精确（不可测量 DOM，就得算死）', () => {
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  const layout = P.graphLayout(issues);
  const { nodeH, vGap, colW, gapX } = P.GRAPH;
  assert.equal(layout.width, colW * 2 + gapX, '总宽 = 两列 + 间距');
  const rows = Math.max(layout.causes.length, layout.tasks.length);
  assert.equal(layout.height, rows * (nodeH + vGap) - vGap, '总高按行数算，末尾不留一个 vGap');

  /* 第一条线的坐标逐字钉死：左出（x1=colW）、右入（x2=colW+gapX），
   * 控制点落在两端点的**水平线**上 —— 这样线绝不会斜穿节点。 */
  const first = layout.links[0];
  assert.equal(first.x1, colW);
  assert.equal(first.x2, colW + gapX);
  assert.equal(first.y1, 0 * (nodeH + vGap) + nodeH / 2, '根因节点在行 0 的垂直中点');
  const bend = Math.round(gapX * 0.55);
  assert.equal(first.path, `M ${first.x1} ${first.y1} C ${first.x1 + bend} ${first.y1}, ${first.x2 - bend} ${first.y2}, ${first.x2} ${first.y2}`);

  /* 每个节点的 y = 下标 * 行高：竖排不重叠，行距恒等。 */
  layout.causes.forEach((cause, index) => assert.equal(cause.y, index * (nodeH + vGap)));
  layout.tasks.forEach((task, index) => assert.equal(task.y, index * (nodeH + vGap)));
  assert.ok(layout.height > 0);
});

test('17e. 没有任何连线 → hasGeometry=false（组件整块不出现，不画一张空图）', () => {
  const issues = P.aggregateIssues(
    P.gateGroups({ status: 'ok', ok: false, blockers: [{ code: 'E_NOT_RUNNING', message: 'phase' }], warnings: [] }, t),
    t,
  );
  const layout = P.graphLayout(issues);
  assert.equal(layout.links.length, 0);
  assert.equal(layout.hasGeometry, false);
  assert.equal(layout.causes.length, 1, '根因本身还在，只是没有线');
  /* 畸形输入不抛。 */
  for (const bad of [undefined, null, 'x', 42, {}, [null, 1, {}]]) {
    const safe = P.graphLayout(bad);
    assert.ok(Array.isArray(safe.links));
    assert.equal(safe.hasGeometry, false);
  }
});

test('17f. fan-in：同一任务的 N 条线在节点边缘**分开接入**，不汇成一点', () => {
  /* 为什么单钉这一条：如果所有线都终结于同一个 (x2,y2)，那 88px 走廊里的线到末端
   * 就并成一根 —— 肉眼分不出 1 条还是 3 条。而"一个任务被几个根因同时卡住"
   * 恰好是这张图**唯一能给、版面文字给不出**的信息。汇成一点 = 这条信息消失。 */
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  const layout = P.graphLayout(issues);
  const into = layout.links.filter((link) => link.to === 'task-1');
  assert.equal(into.length, 2);
  assert.notEqual(into[0].y2, into[1].y2, '两条线必须落在一个节点的不同高度上，否则读起来像一条');

  const task = layout.tasks.find((item) => item.id === 'task-1');
  for (const link of into) {
    assert.ok(link.y2 >= task.y + 2, `接入点不许出节点上边缘：${link.y2} < ${task.y + 2}`);
    assert.ok(link.y2 <= task.y + task.h - 2, `接入点不许出节点下边缘：${link.y2} > ${task.y + task.h - 2}`);
  }

  /* 打中 3 个根因时同样要分开，且仍然不出框。 */
  const three = P.aggregateIssues(
    P.gateGroups({
      status: 'ok',
      ok: false,
      blockers: [
        { code: 'E_A', taskId: 'task-1', message: '' },
        { code: 'E_B', taskId: 'task-1', message: '' },
        { code: 'E_C', taskId: 'task-1', message: '' },
      ],
      warnings: [],
    }, t),
    t,
  );
  const trio = P.graphLayout(three).links.map((link) => link.y2);
  assert.equal(new Set(trio).size, 3, '三条线三个落点');
});

test('17g. 两列的 y 网格**互相独立**（同高不等于配对，配对只由线表达）', () => {
  /* 如果两列都从 y=0 起排、行距相同，读者会把"同一水平线"读成配对关系。
   * 一旦线连的不是同序号的对象，线就明显上拐/下拐，与那个直觉打架 —— 图开始撒谎。
   * 所以两列各自在自己的列内垂直居中，块贴中线而不贴顶。 */
  const issues = P.aggregateIssues(
    P.gateGroups({
      status: 'ok',
      ok: false,
      blockers: [
        { code: 'E_A', taskId: 'task-1', message: '' },
        { code: 'E_B', taskId: 'task-2', message: '' },
      ],
      warnings: [],
    }, t),
    t,
  );
  /* 造 5 个任务 / 2 个根因：多的那边是任务列。 */
  const wide = P.graphLayout([
    { code: 'E_A', label: null, tone: 'hard', count: 1, taskIds: ['task-1'], messages: [] },
    { code: 'E_B', label: null, tone: 'hard', count: 1, taskIds: ['task-2', 'task-3', 'task-4', 'task-5'], messages: [] },
  ]);
  assert.equal(wide.causes.length, 2);
  assert.equal(wide.tasks.length, 5);
  const { nodeH, vGap } = P.GRAPH;
  const step = nodeH + vGap;
  /* 任务列 5 行占满 → 从 0 起；根因列只有 2 行 → 居中，往下让 1.5 行。 */
  assert.equal(wide.tasks[0].y, 0);
  assert.equal(wide.causes[0].y, ((5 - 2) * step) / 2, '根因列垂直居中，不与任务列共用 y 网格');
  assert.equal(wide.height, 5 * step - vGap, '高度仍按多的一列算');
  assert.ok(issues.length === 2, '（顺带确认上面的 fixture 形状没变）');
});

/* ------------------------------------------------------------------------- */
/* 18. 总判：能交付 / 不能交付 / 判不了 —— 三态在**结构上**就不同                  */
/* ------------------------------------------------------------------------- */

test('18a. 不能交付：危险色 + 有三个数字（阻断数 / 独立根因数 / 警告数）', () => {
  const view = P.verdictOf(fixtureGates(), t);
  assert.equal(view.tone, 'danger');
  assert.equal(view.headline, ZH['gates.blocked']);
  assert.deepEqual(view.stats.map((stat) => stat.value), ['6', '3', '1'], '阻断 6 · 独立根因 3 · 警告 1');
  assert.equal(view.stats[1].label, '独立根因', '「几个根因」是这个页面新增的那个数字');
});

test('18b. 空态 vs 不可用态：一个有大号数字行，一个一条数字都没有（不许长得一样）', () => {
  const clean = P.verdictOf({ status: 'ok', ok: true, blockers: [], warnings: [] }, t);
  const unknown = P.verdictOf({ status: 'unavailable', reason: 'agentTeams' }, t);

  /* ① 能交付 → 正常色，而且三个 0 **必须显示出来**：那是"读到了，就是零"，是测量结果。 */
  assert.equal(clean.tone, 'ok');
  assert.equal(clean.headline, ZH['gates.ok']);
  assert.equal(clean.stats.length, 3);
  assert.deepEqual(clean.stats.map((stat) => stat.value), ['0', '0', '0']);
  assert.equal(clean.reason, null, '能判定的时候没有"为什么判不了"这句话');

  /* ② 判不了 → 中性色，**stats 恒为空**：读不出来的时候没有资格给测量结果。
   * 这就是本项目的红线「空态与不可用态必须长得不一样」—— 落在结构上，不是落在文案上。 */
  assert.equal(unknown.tone, 'unknown');
  assert.deepEqual(unknown.stats, [], '判不了时一个数字都不许出现（连 0 也不许）');
  assert.equal(unknown.reason, ZH['gates.unavailable']);
  assert.doesNotMatch(unknown.reason, /\d/, '不可用的解释里不许出现数字');
  assert.equal(unknown.headline, '无法判定');
  assert.notEqual(unknown.headline, clean.headline);

  /* ③ 两种状态在结构上可分辨（不是靠"两句不同的话"，是靠有没有数字行）。 */
  assert.notEqual(clean.stats.length, unknown.stats.length);
  assert.notEqual(clean.tone, unknown.tone);
});

test('18c. 判不了的三种原因各说各的（没有活 Agent / 宿主没板 / 判定报错）', () => {
  const reasons = ['agent', 'agentTeams', 'error'].map((reason) => P.verdictOf({ status: 'unavailable', reason }, t));
  for (const view of reasons) {
    assert.equal(view.tone, 'unknown');
    assert.deepEqual(view.stats, []);
    assert.ok(typeof view.reason === 'string' && view.reason.length > 0);
  }
  assert.equal(new Set(reasons.map((view) => view.reason)).size, 3, '三种原因必须三句话，不许合并成一句');
  assert.equal(reasons[2].reason, ZH['gates.error']);
});

test('18d. 阶段未知：不是阻断，但出现在总判里（不许散到角落）', () => {
  const view = P.verdictOf({ status: 'ok', ok: true, phaseKnown: false, blockers: [], warnings: [] }, t);
  assert.equal(view.tone, 'ok');
  assert.equal(view.note, ZH['gates.phaseUnknown'], '阶段未知必须和总判同一块');
  const known = P.verdictOf({ status: 'ok', ok: true, phaseKnown: true, blockers: [], warnings: [] }, t);
  assert.equal(known.note, null);
});

/* ------------------------------------------------------------------------- */
/* 19. kind 未声明 → 「未声明」，不是 ? 也不是空白                                 */
/* ------------------------------------------------------------------------- */

test('19a. kind 读不出来时明确显示「未声明」', () => {
  for (const missing of [undefined, null, '', '   ', 'unknown']) {
    const badge = P.kindBadge(missing, t);
    assert.equal(badge.text, '未声明', `kind=${JSON.stringify(missing)} 必须显示「未声明」`);
    assert.equal(badge.declared, false);
    assert.notEqual(badge.text, '?', '? 读起来像"无所谓"，未声明读起来像"有人该去声明"');
  }
  const declared = P.kindBadge('impl', t);
  assert.equal(declared.text, 'impl');
  assert.equal(declared.declared, true);
});

test('19b. kind 也是自由文本：@me / ! 之类要降级成半角以外的形式', () => {
  assert.doesNotMatch(P.kindBadge('@me', t).text, /@me/);
  assert.match(P.kindBadge('@me', t).text, /＠me/);
});

test('19c. 状态徽章：已知状态有语义色，不认识的状态原样显示且不着色', () => {
  assert.equal(P.statusBadge('in_progress', t).tone, 'active');
  assert.equal(P.statusBadge('completed', t).tone, 'success');
  assert.equal(P.statusBadge('failed', t).tone, 'danger');
  const weird = P.statusBadge('quarantined', t);
  assert.equal(weird.tone, 'mute', '认不出来的状态保持不显眼，不硬塞进某个已知桶给它错误的语义色');
  assert.equal(weird.text, 'quarantined');
});

/* ------------------------------------------------------------------------- */
/* 20. 任务板结构化行：拿不到结构化数据就返回 null（诚实降级），空数组是 []            */
/* ------------------------------------------------------------------------- */

test('20a. boardRows：非数组 → null（"拿不到"），空数组 → []（"读到了，就是零"）', () => {
  assert.equal(P.boardRows(undefined), null, '没有结构化数据 → null，由页面走"诚实降级"');
  assert.equal(P.boardRows(null), null);
  assert.equal(P.boardRows('团队板（3 个任务）'), null, '**绝不解析那段定宽文本**');
  assert.deepEqual(P.boardRows([]), [], '空数组是"读到了，就是零条"，与 null 必须可分辨');
  assert.notDeepEqual(P.boardRows([]), P.boardRows(undefined));
});

test('20b. boardRows 逐字段消毒，没有 id 的条目丢弃（与 renderBoard 同口径）', () => {
  const rows = P.boardRows([
    { id: 'task-1', kind: 'impl', status: 'in_progress', subject: '@me 干这个', owner: 'bob', scopes: ['src/x'], blockedBy: ['task-2'], warnings: [] },
    { kind: 'impl' },                       // 没有 id → 丢弃
    { id: 'task-3', kind: 'unknown' },       // kind 未声明
    42, null,                                // 非对象 → 丢弃
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'task-1');
  assert.doesNotMatch(rows[0].subject, /@me/, '自由文本同样要消毒（只读页面不该长得像任务行）');
  assert.match(rows[0].subject, /＠me/);
  assert.deepEqual(rows[0].blockedBy, ['task-2']);
  assert.deepEqual(rows[0].scopes, ['src/x']);
  /* kind='unknown' 是渲染器的占位符，不是宿主声明的类型 → 页面显示「未声明」。 */
  assert.equal(P.kindBadge(rows[1].kind, t).text, '未声明');
});

/* ------------------------------------------------------------------------- */
/* 21. 角色台账：五个桶各自成格（能纵向比较），失败出过事才上色                     */
/* ------------------------------------------------------------------------- */

test('21a. ledgerStats：五个桶一个不少、顺序固定、数字是字符串但保留原始值', () => {
  const view = P.ledgerStats({ id: 'w3', stats: { completed: 3, abortedWithOutput: 0, abortedWithoutOutput: 2, failed: 1, failedWithoutOutput: 0 }, pitfalls: '改一半没跑测试' }, t);
  assert.deepEqual(view.cells.map((cell) => cell.key), ['completed', 'abortedWithOutput', 'abortedWithoutOutput', 'failed', 'failedWithoutOutput']);
  assert.deepEqual(view.cells.map((cell) => cell.value), ['3', '0', '2', '1', '0'], '0 也要显示成 0，不许省');
  assert.deepEqual(view.cells.map((cell) => cell.raw), [3, 0, 2, 1, 0]);
  assert.match(view.pitfalls, /改一半没跑测试/);
});

test('21b. 只有真的出过事才有颜色（颜色 = 严重度，不是分类）', () => {
  const clean = P.ledgerStats({ id: 'w1', stats: { completed: 9, failed: 0, abortedWithoutOutput: 0 } }, t);
  assert.ok(clean.cells.every((cell) => cell.tone === 'plain'), '全 0 的角色不该有任何颜色');
  const failed = P.ledgerStats({ id: 'w2', stats: { failed: 2 } }, t);
  assert.equal(failed.cells.find((cell) => cell.key === 'failed').tone, 'danger');
  const idle = P.ledgerStats({ id: 'w2', stats: { abortedWithoutOutput: 1 } }, t);
  assert.equal(idle.cells.find((cell) => cell.key === 'abortedWithoutOutput').tone, 'warn');
});

test('21c. ledgerLine 由 ledgerStats 派生：两条出口不许漂移', () => {
  const role = { id: 'w3', stats: { completed: 3, abortedWithOutput: 0, abortedWithoutOutput: 0, failed: 1, failedWithoutOutput: 1 }, pitfalls: '' };
  const view = P.ledgerStats(role, t);
  const line = P.ledgerLine(role, t);
  assert.equal(line.head, `${view.id}  ${view.cells.map((cell) => `${cell.label} ${cell.value}`).join(' · ')}`);
  assert.equal(line.id, view.id);
  assert.equal(line.pitfalls, view.pitfalls);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 第 14 轮：观感两处（13 条阻断全红堆叠 / warning 与 blocker 区分度）
 *
 * 这两条的验收不能靠"我觉得好看点了"。所以下面钉的是**可断言的结构**：
 * 排序、折叠数量、以及**非颜色通道**的差异。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 模拟 lead 截图里那个局面：一条 ×9、一条 ×2、若干 ×1，外加两条 warning。
 *
 * **顺序是故意这样排的**：三个 ×1 的 hard 码（E_SELF_REVIEW / E_FAILED_NO_FOLLOWUP /
 * E_NO_ASSIGNEE）**出现在 ×2 的 E_TASK_INCOMPLETE 之前**。
 * 这样"按 count 降序"与"按首次出现"会给出**不同**的答案 —— 否则排序断言是空断言
 * （去掉排序它照样绿）。第一版 fixture 就犯了这个错，在这里记一笔。 */
function fixtureCrowded() {
  const blockers = [
    { code: 'E_SELF_REVIEW', message: 'c' },
    { code: 'E_FAILED_NO_FOLLOWUP', message: 'd' },
    { code: 'E_NO_ASSIGNEE', message: 'e' },
    { code: 'E_TASK_INCOMPLETE', taskId: 'task-1', message: 'a' },
    { code: 'E_TASK_INCOMPLETE', taskId: 'task-2', message: 'b' },
  ];
  for (let i = 0; i < 9; i += 1) blockers.push({ code: 'E_INPUT_INVALID', message: `坏入参 ${i}` });
  return {
    status: 'ok',
    ok: false,
    phaseKnown: true,
    blockers,
    warnings: [
      { code: 'E_AUDIT_UNWIRED', message: 'w1' },
      { code: 'E_INDEPENDENCE_UNENFORCED', message: 'w2' },
    ],
  };
}

test('22a. 根因按「严重度分区 → 区内 count 降序」排：多的在上，但警告不许压过阻断', () => {
  const issues = P.aggregateIssues(P.gateGroups(fixtureCrowded(), t), t);
  const ordered = P.orderIssues(issues);

  /* E_INPUT_INVALID 有 9 条，但它属于 precondition 档，必须排在 hard 档之后。 */
  assert.equal(ordered[0].tone, 'hard', '阻断永远在最上面');
  assert.equal(ordered[0].code, 'E_TASK_INCOMPLETE',
    '同一档内 count 大的在前 —— 它在输入里排第 4，靠排序才到第一');
  assert.equal(ordered[0].count, 2);

  const hardCodes = ordered.filter((item) => item.tone === 'hard').map((item) => item.code);
  assert.deepEqual(hardCodes, ['E_TASK_INCOMPLETE', 'E_SELF_REVIEW', 'E_FAILED_NO_FOLLOWUP', 'E_NO_ASSIGNEE'],
    'hard 区内部按 count 降序；count 相同的回落到首次出现（稳定）');

  /* 全部 count 的序列：hard 区内递减，跨档时才允许回升（因为档优先）。 */
  const inHard = ordered.filter((item) => item.tone === 'hard').map((item) => item.count);
  for (let i = 1; i < inHard.length; i += 1) {
    assert.ok(inHard[i - 1] >= inHard[i], `hard 区内 count 必须非递增，实际 ${inHard.join(',')}`);
  }

  /* 最后一定是警告档。 */
  assert.equal(ordered[ordered.length - 1].tone, 'warning');
  /* 排序不许丢东西、不许加东西。 */
  assert.equal(ordered.length, issues.length);
  assert.deepEqual(ordered.map((item) => item.code).sort(), issues.map((item) => item.code).sort());
});

test('22b. 折叠：默认只展开 top 3，其余进汇总行，且**其中几条是阻断**必须算准', () => {
  const issues = P.aggregateIssues(P.gateGroups(fixtureCrowded(), t), t);
  const parts = P.partitionIssues(issues, 3);

  assert.equal(parts.collapsed, true, '6 个根因时默认必须折叠');
  assert.equal(parts.shown.length, 3, '默认只展开 top 3');
  assert.equal(parts.hiddenCount, issues.length - 3, '汇总行的数字必须等于真正被收起来的个数');
  assert.equal(parts.shown.length + parts.hidden.length, parts.ordered.length, '折叠不许吞掉任何一条');
  /* 被折叠的部分里还有 2 条 non-warning（E_NO_ASSIGNEE 与 E_INPUT_INVALID）——
   * 这个数字要能被看见，否则"折叠"会把严重性藏起来。 */
  assert.equal(parts.hiddenBlockers, 2, `被折叠的阻断数必须准确，实际 ${parts.hiddenBlockers}`);
  assert.equal(parts.hiddenCount, 4, '7 个根因里收起 4 个');
  /* 展开的 top 3 里必须是最重的那三个。 */
  assert.deepEqual(parts.shown.map((item) => item.code), ['E_TASK_INCOMPLETE', 'E_SELF_REVIEW', 'E_FAILED_NO_FOLLOWUP']);

  /* 少于上限时不折叠、没有汇总行。 */
  const few = P.partitionIssues(issues.slice(0, 2), 3);
  assert.equal(few.collapsed, false);
  assert.equal(few.hiddenCount, 0);
  assert.equal(few.shown.length, 2);
  /* 空输入：安静，不折叠，没有任何 hard。 */
  const empty = P.partitionIssues([], 3);
  assert.equal(empty.collapsed, false);
  assert.deepEqual(empty.shown, []);
  assert.equal(empty.ordered.some((item) => item.tone === 'hard'), false);
});

test('22c. 三档 tone 的颜色之外还有**两条**通道：色条宽度 与 形状，且三者互不相同', () => {
  /* 这条是第 14 轮的直接产物。lead 在缩放截图里看到 warning 与阻断像同一个色，
   * 我取到的实测值证明色相分离是够的：
   *   hard #f25a5a(H0°) / precondition #f59e0b(H38°) / warning #7aaaff(H218°)
   * 但 hard↔precondition 的 ΔE 只有 57，且都是暖色 —— 所以不赌颜色，加第二通道。 */
  const tones = ['hard', 'precondition', 'warning'];
  const metas = tones.map((tone) => P.toneMeta(tone));

  const bars = metas.map((meta) => meta.bar);
  const glyphs = metas.map((meta) => meta.glyph);
  const ranks = metas.map((meta) => meta.rank);

  assert.equal(new Set(bars).size, 3, `色条宽度必须三档不同（灰度下唯一的量感通道），实际 ${bars.join('/')}`);
  assert.equal(new Set(glyphs).size, 3, `形状必须三档不同（色弱/缩放截图下的唯一通道），实际 ${glyphs.join(' ')}`);
  assert.equal(new Set(ranks).size, 3, '排序权重必须三档不同');
  assert.deepEqual(ranks, [0, 1, 2], '阻断的 rank 必须最小（排最上）');

  /* 宽度随严重度递减，不是随手拍的三个数。 */
  assert.ok(bars[0] > bars[1] && bars[1] > bars[2], `色条应随严重度变细，实际 ${bars.join(' > ')}`);

  /* 同样的元数据必须由 `aggregateIssues` 带给页面 —— 页面与测试共用一份，
   * 否则"测试断言了宽度、页面画的却是另一值"这种漂移没人拦得住。 */
  const issues = P.aggregateIssues(P.gateGroups(fixtureCrowded(), t), t);
  const hard = issues.find((item) => item.tone === 'hard');
  const warn = issues.find((item) => item.tone === 'warning');
  assert.equal(hard.bar, P.toneMeta('hard').bar);
  assert.equal(hard.glyph, P.toneMeta('hard').glyph);
  assert.equal(warn.bar, P.toneMeta('warning').bar);
  assert.equal(warn.glyph, P.toneMeta('warning').glyph);
  assert.notEqual(hard.bar, warn.bar, '阻断与警告的色条宽度必须真的不同');
  assert.notEqual(hard.glyph, warn.glyph, '阻断与警告的形状必须真的不同');

  /* 不认识的 tone 不许抛，也不许变成"无样式" —— fail-closed 当成阻断。 */
  assert.deepEqual(P.toneMeta('nonsense'), P.toneMeta('hard'));
  assert.deepEqual(P.toneMeta(undefined), P.toneMeta('hard'));
});

test('22d. 零问题：那一块是安静的 —— 没有根因、没有阻断、不会渲染任何红色元素', () => {
  const clean = P.gateGroups({ status: 'ok', ok: true, blockers: [], warnings: [] }, t);
  const issues = P.aggregateIssues(clean, t);
  assert.deepEqual(issues, [], '零问题时根本没有根因可画');
  const parts = P.partitionIssues(issues, 3);
  assert.deepEqual(parts.shown, []);
  assert.equal(parts.hiddenCount, 0);
  const view = P.verdictOf({ status: 'ok', ok: true, blockers: [], warnings: [] }, t);
  assert.equal(view.tone, 'ok', '能交付时 banner 用正常色，不是危险色');
  assert.equal(view.issues.length, 0);

  /* 对照：同一套流水线在有阻断时必须产出 hard —— 否则上一条就是空断言。 */
  const crowded = P.aggregateIssues(P.gateGroups(fixtureCrowded(), t), t);
  assert.ok(crowded.some((item) => item.tone === 'hard'), '有阻断时必须出现 hard 根因');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 23. 开关（用户原话：「关闭和开始那个按钮也画的巨丑，还是歪的」）
 *
 * "歪"是算术错，所以验收也用算术：几何等式 + 直接从**发布的 CSS 字符串**里
 * 解析出两个状态的配色。不靠看截图。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('23a. 开关几何：竖直正中、左右留白对称、位移 = 宿主口径的 16px', () => {
  const geo = P.switchGeometry();

  /* 宿主自己的开关是 36×20 / padding 2 / thumb 16 / translate(16px)。
   * 我们照它的口径，所以这四个数必须对得上（对不上就是又自己发明了一套）。 */
  assert.equal(geo.trackW, 36);
  assert.equal(geo.trackH, 20);
  assert.equal(geo.pad, 2);
  assert.equal(geo.knob, 16);
  assert.equal(geo.travel, 16, '位移必须等于宿主的 16px');

  /* ① 竖直居中：内高恰好等于圆点直径 → 余量为 0，top 必须正好等于 padding。
   * 上一版内高 19（没算边框）、圆点 13，该留 3px 却写了 2px → 偏上 1px。 */
  assert.equal(geo.innerH, geo.knob, '内高必须正好等于圆点，否则竖直方向必然有偏移');
  assert.equal(geo.top, geo.pad, '竖直居中时 top 必须等于内边距');
  assert.equal(geo.centered, true);

  /* ② 关态"左"留白 === 开态"右"留白 === padding。
   * 上一版关态左 2 / 开态右 4 —— 一开就偏左 2px，这就是用户看到的"歪"。 */
  assert.equal(geo.offLeft, geo.pad, '关态圆点左沿必须贴住内边距');
  assert.equal(geo.trackW - geo.onLeft - geo.knob, geo.pad, '开态圆点右沿必须贴住内边距');
  assert.equal(geo.offLeft, geo.trackW - geo.onLeft - geo.knob, '两侧留白必须相等（否则来回切都在飘）');

  /* ③ 位移 = 内宽 − 圆点，且两端都不出内区。 */
  assert.equal(geo.travel, geo.innerW - geo.knob);
  assert.ok(geo.onLeft + geo.knob <= geo.trackW - geo.pad + 1e-9, '开态圆点不许溢出轨道');
  assert.ok(geo.offLeft >= geo.pad - 1e-9, '关态圆点不许溢出轨道');

  /* 圆点大于内区时自动收缩，绝不溢出（溢出就是"歪"的另一种形态）。 */
  const tiny = P.switchGeometry({ trackW: 20, trackH: 12, pad: 2, knob: 40 });
  assert.ok(tiny.knob <= Math.min(tiny.innerW, tiny.innerH), '圆点必须被夹进内区');
  assert.equal(tiny.travel, tiny.innerW - tiny.knob);
  /* 畸形输入不抛。 */
  for (const bad of [undefined, null, 'x', 42, {}, { trackW: -5 }]) {
    const safe = P.switchGeometry(bad);
    assert.ok(Number.isFinite(safe.travel) && safe.travel >= 0, `几何必须永远给出有限非负的位移：${JSON.stringify(bad)}`);
  }
});

test('23b. 开关配色：关态轨道**必须与卡片底不同**，两种状态的轨道色不许是同一个 token', () => {
  /* 从发布的 CSS 里解析，而不是读常量 —— 这样"改了样式表但没改常量"也会被抓到。 */
  const block = (selector) => {
    const at = SOURCE.indexOf(selector);
    assert.notEqual(at, -1, `样式表里找不到选择器 ${selector}`);
    const open = SOURCE.indexOf('{', at);
    const close = SOURCE.indexOf('}', open);
    return SOURCE.slice(open, close);
  };
  const off = block('.tb-track ');
  const on = block('.tb-track[data-on="true"] ');
  const bg = (text) => {
    const m = text.match(/background:\s*([^;]+);/);
    return m === null ? '' : m[1].trim();
  };
  const offBg = bg(off);
  const onBg = bg(on);

  assert.ok(offBg !== '', '关态轨道必须有 background（否则闭着只剩一圈边，等于看不见）');
  assert.ok(onBg !== '', '开态轨道必须有 background');
  assert.match(offBg, /^var\(--dsw-/, `轨道色必须走主题 token，实际 ${offBg}`);
  assert.match(onBg, /^var\(--dsw-/, `轨道色必须走主题 token，实际 ${onBg}`);
  assert.notEqual(offBg, onBg, '开态与关态的轨道色必须是两个不同的 token，否则开关没有状态可言');

  /* 核心缺陷回归：上一版关态用 bg-layer-2，而卡片/内嵌块也是 bg-layer-2 → 关态隐形。 */
  assert.notEqual(offBg, 'var(--dsw-alias-bg-layer-2)', '关态轨道不许再用 bg-layer-2：那是卡片自己的底色，闭着就看不见');
  assert.notEqual(offBg, 'var(--dsw-alias-bg-layer-1)', '关态轨道不许用卡片底 bg-layer-1');

  /* 开态不许再铺亮绿：那是 34×19 一整块高饱和实心，和整页灰阶不搭。 */
  assert.doesNotMatch(onBg, /state-success/, '开态轨道不该是亮绿实心（宿主口径是品牌色）');
  assert.equal(onBg, P.SWITCH_TOKENS.trackOn, '开态轨道必须与 SWITCH_TOKENS 一致（页面和断言共用一份）');
  assert.equal(offBg, P.SWITCH_TOKENS.trackOff, '关态轨道必须与 SWITCH_TOKENS 一致');

  /* 圆点两态也必须是两个不同的 token（开态用前景色、关态用 switch-thumb）。 */
  assert.notEqual(P.SWITCH_TOKENS.knobOff, P.SWITCH_TOKENS.knobOn);
  for (const value of Object.values(P.SWITCH_TOKENS)) {
    assert.match(value, /^var\(--dsw-/, `开关配色必须全部走主题 token，实际 ${value}`);
  }
});

test('23c. 开关的位移来自纯函数而不是 CSS 里的硬编码像素', () => {
  /* 上一版的病根就是 `translateX(15px)` 这种手写数字：轨道一改就歪。
   * 现在 CSS 只写 `var(--tb-travel)`，值由 switchGeometry() 提供。 */
  const onBlock = (() => {
    const at = SOURCE.indexOf('.tb-track[data-on="true"] .tb-knob');
    assert.notEqual(at, -1, '找不到开态圆点规则');
    const open = SOURCE.indexOf('{', at);
    return SOURCE.slice(open, SOURCE.indexOf('}', open));
  })();
  assert.match(onBlock, /translateX\(var\(--tb-travel/, '位移必须取变量，不许写死像素');
  assert.doesNotMatch(onBlock, /translateX\(\s*\d+px\s*\)/, 'CSS 里不许出现硬编码的 translateX(Npx)');
  /* 盒模型必须显式声明，否则 width 的含义随容器而变（这就是"歪"的第一个来源）。 */
  assert.match(SOURCE, /\.tb-track\s*\{[^}]*box-sizing:\s*border-box/, '轨道必须显式 box-sizing:border-box');
  assert.match(SOURCE, /\.tb-track\s*\{[^}]*border:\s*0/, '轨道必须 border:0（否则边框会挤占内区，切换时尺寸跳变）');
});


/* ═══════════════════════════════════════════════════════════════════════════
 * 24. 图节点可点（用户原话：「不可以点击」）
 *
 * 上一版整张图是 role='img' —— 那张图在语义上是"一张图片"，里面的圆角方块
 * 看起来能点、点了没反应。现在节点是真按钮，点一下只亮它牵连的部分。
 * 高亮集合抽成纯函数 focusSet()，所以"点了之后该亮哪些"能被断言。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('24a. 点一个根因：只点亮它连出的线与它牵连的任务', () => {
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  const layout = P.graphLayout(issues);
  /* fixtureGates: E_TASK_INCOMPLETE → task-1/2/4/7，E_SELF_REVIEW → task-1，
   * E_NOT_RUNNING 无线，warning E_INDEPENDENCE_UNENFORCED → task-2。 */
  const target = layout.causes.find((cause) => cause.code === 'E_TASK_INCOMPLETE');
  const focus = P.focusSet(layout, target.key);

  assert.equal(focus.active, true, '点到了就必须是选中态');
  assert.equal(focus.key, target.key);
  assert.equal(focus.links.size, 4, 'E_TASK_INCOMPLETE 连出 4 条线');
  assert.deepEqual([...focus.tasks].sort(), ['task-1', 'task-2', 'task-4', 'task-7'], '只点亮它牵连的任务');

  /* E_SELF_REVIEW 的线和 warning 的线都不许被点亮。 */
  const selfReview = layout.causes.find((cause) => cause.code === 'E_SELF_REVIEW');
  for (const key of focus.links) {
    assert.equal(key.startsWith(selfReview.key), false, '别的根因的线不许亮');
  }
  /* task-1 虽然同时被两个根因打中，但在这里它只因为被 E_TASK_INCOMPLETE 牵连才亮。 */
  assert.equal(focus.tasks.has('task-1'), true);
});

test('24b. 没选 / 点了不存在的节点：不压暗任何东西（不许把全图变暗）', () => {
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  const layout = P.graphLayout(issues);

  for (const empty of [null, undefined, '', 'no-such-key', 42]) {
    const focus = P.focusSet(layout, empty);
    assert.equal(focus.active, false, `未选中时 active 必须是 false（输入 ${JSON.stringify(empty)}）`);
    assert.equal(focus.key, null);
    assert.equal(focus.links.size, 0, '未选中不许点亮任何线');
    assert.equal(focus.tasks.size, 0);
  }
  /* 畸形 layout 也不抛。 */
  for (const bad of [undefined, null, 'x', {}, { causes: [null], links: [null] }]) {
    const safe = P.focusSet(bad, 'anything');
    assert.equal(safe.active, false);
    assert.equal(safe.links.size, 0);
  }
});

test('24c. 选「全局」根因（一条线都没有）：选中态成立，但没有任何东西被点亮', () => {
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  const layout = P.graphLayout(issues);
  const global = layout.causes.find((cause) => cause.global === true);
  const focus = P.focusSet(layout, global.key);
  assert.equal(focus.active, true, '全局根因也是可点的节点，点了要进选中态');
  assert.equal(focus.links.size, 0, '它没有线，所以什么也不亮');
  assert.equal(focus.tasks.size, 0);
});

test('24d. 图的语义不再是"一张图片"：节点是按钮，且压暗用 data-dim 属性', () => {
  /* 静态检查发布出去的标记：这三条任何一条退回旧写法，用户就又会说"不可以点击"。 */
  const graphStart = SOURCE.indexOf('function CauseGraph');
  assert.notEqual(graphStart, -1);
  const graphEnd = SOURCE.indexOf('\n    }\n', graphStart);
  const body = SOURCE.slice(graphStart, graphEnd);

  assert.doesNotMatch(body, /role: 'img'/, "整张图不许再声明 role='img'（那会让它读成一张图片）");
  assert.match(body, /role: 'button'/, '根因节点必须是 button 角色');
  assert.match(body, /tabIndex: 0/, '必须可键盘聚焦');
  assert.match(body, /onKeyDown/, '键盘要能触发（Enter / Space）');
  assert.match(body, /aria-pressed/, '选中态要能被辅助技术读到');
  /* 必须**三处**都有：线、任务节点、根因节点。
   * 只写 /data-dim/ 会漏掉"根因节点忘了压暗"—— 上一版就是这样漏过去的：
   * 把根因那行的 data-dim 删掉，任务节点那处仍能匹配，断言照样绿。 */
  const dimCount = (body.match(/'data-dim':/g) || []).length;
  assert.ok(dimCount >= 3, `线、任务、根因三处都要押暗（data-dim），实际只有 ${dimCount} 处`);

  /* CSS 侧：指针与焦点环必须真的存在。 */
  assert.match(SOURCE, /\.tb-node-hit\s*\{[^}]*cursor:\s*pointer/, '节点必须有 cursor:pointer');
  assert.match(SOURCE, /\.tb-node-hit:focus-visible[^{]*\{[^}]*stroke/, '键盘焦点必须有可见描边');
  assert.match(SOURCE, /\[data-dim="true"\]\s*\{[^}]*opacity:/, '压暗必须有对应规则');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 25. 每张卡都要有副标题（用户原话：「人家基本上都有解释啊之类的，摘要啊之类的」）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('25a. 五个副标题 key 都在客户端两张表里，且中英不同', () => {
  const keys = [P.K.subAgent, P.K.subVerdict, P.K.subGates, P.K.subLedger, P.K.subBoard];
  assert.equal(new Set(keys).size, 5, '五个 key 必须互不相同');
  for (const key of keys) {
    assert.equal(typeof CLIENT_DICTS.zh[key], 'string', `客户端 zh 表缺 ${key}`);
    assert.equal(typeof CLIENT_DICTS.en[key], 'string', `客户端 en 表缺 ${key}`);
    assert.notEqual(CLIENT_DICTS.zh[key], CLIENT_DICTS.en[key], `${key} 的中英必须是两份不同的文案`);
    assert.ok(CLIENT_DICTS.zh[key].length >= 8, `${key} 的中文太短，不像是"解释"`);
  }
  /* 五句互不相同 —— 否则等于给每张卡贴同一句废话。 */
  assert.equal(new Set(keys.map((k) => CLIENT_DICTS.zh[k])).size, 5);
});

test('25b. 每张卡都真的把 sub 传给了 CardHead（不是只加文案不用）', () => {
  /* 静态检查发布出去的调用点：谁把 sub 漏了，这条就红。 */
  const calls = [...SOURCE.matchAll(/h\(CardHead,\s*\{([\s\S]{0,240}?)\}\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 3, `CardHead 的调用点太少（${calls.length}），像是漏了`);
  for (const call of calls) {
    assert.match(call, /sub:\s*t\(/, `这个 CardHead 调用没传 sub：${call.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  /* 顶栏与判决 banner 不走 CardHead，单独钉。 */
  assert.match(SOURCE, /tb-card-sub[^}]*\}[^\n]*\n/.source ? /tb-card-sub/ : /tb-card-sub/, '副标题的样式类必须存在');
  assert.ok(SOURCE.includes("t(K.subAgent)"), '顶栏必须渲染副标题');
  assert.ok(SOURCE.includes("t(K.subVerdict)"), '判决 banner 必须渲染副标题');
  assert.ok(SOURCE.includes("t(K.subGates)"), '门禁卡必须渲染副标题');
  assert.ok(SOURCE.includes("t(K.subLedger)"), '台账卡必须渲染副标题');
  assert.ok(SOURCE.includes("t(K.subBoard)"), '任务板卡必须渲染副标题');
  /* CSS：副标题必须是 11px、secondary、与标题有 4px 间距。 */
  assert.match(SOURCE, /\.tb-card-sub\s*\{[^}]*font-size:\s*11px/, '副标题字号必须是 11px');
  assert.match(SOURCE, /\.tb-card-sub\s*\{[^}]*label-secondary/, '副标题颜色必须是 secondary（弱于标题）');
  assert.match(SOURCE, /\.tb-card-head-text\s*\{[^}]*gap:\s*4px/, '标题与副标题间距必须是 4px');
});

test('25c. 副标题不会把标题挤走：操作区独立一列、标题区可收缩', () => {
  assert.match(SOURCE, /\.tb-card-head-text\s*\{[^}]*min-width:\s*0/, '标题区必须可收缩，否则长标题会顶出容器');
  assert.match(SOURCE, /\.tb-card-head-right\s*\{[^}]*flex:\s*0 0 auto/, '右侧操作区不许被挤压');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 26. 两个"颜色没生效"的真 bug（第 15 轮）
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 从发布的 CSS 文本里取出所有 .tb-badge[data-tone="X"] 的 X。 */
function badgeTones() {
  const tones = new Set();
  for (const m of SOURCE.matchAll(/\.tb-badge\[data-tone="([a-z]+)"\]/g)) tones.add(m[1]);
  return tones;
}

test('26a. statusBadge 返回的每一个 tone 都必须有对应的 CSS 规则（否则颜色根本不生效）', () => {
  /* 这就是那个真 bug：statusBadge 返回 plain/active/success/danger/mute，
   * 而 CSS 只写了 primary/warn/muted —— 四个状态色一次都没渲染出来。
   * 断言方式是**遍历状态词表**，而不是手写几个字符串：以后加状态也会被拦住。 */
  const statuses = ['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'deleted', 'running', '', 'quarantined'];
  const needed = new Set(statuses.map((status) => P.statusBadge(status, t).tone));
  const defined = badgeTones();
  for (const tone of needed) {
    assert.ok(defined.has(tone), `statusBadge 会返回 tone=${tone}，但 CSS 里没有 .tb-badge[data-tone="${tone}"] 规则`);
  }
  /* 被点名缺失的那四档必须在。 */
  for (const tone of ['success', 'danger', 'active', 'mute']) {
    assert.ok(defined.has(tone), `${tone} 这一档必须有 CSS（它以前整段缺失）`);
  }
  /* 数据源徽章的三档也不能丢。 */
  for (const tone of ['primary', 'warn', 'muted']) {
    assert.ok(defined.has(tone), `数据源徽章用的 ${tone} 档被弄丢了`);
  }
});

test('26b. kind 徽章：短标签放得下、长 kind 不许溢出被邻座盖掉', () => {
  /* 真缺陷：implementation 在 74px 格里溢出，末尾字形被右侧「已完成」徽章的背景盖住。
   * 修法两条一起上：短标签 + CSS 裁切兜底。 */
  const impl = P.kindBadge('implementation', t);
  assert.equal(impl.text, 'impl', 'implementation 必须显示成短标签');
  assert.equal(impl.full, 'implementation', '完整名字要留在 title 里可悬停查看');
  assert.notEqual(impl.text, impl.full, '短标签与完整名必须是两个字段，别混成一个');

  /* 所有已知 kind 的短标签都必须 <= 8 个字符（74px 格子的容量上限）。 */
  const kinds = ['implementation', 'review', 'work', 'investigation', 'delivery', 'unknown', 'Implementation', 'REVIEW'];
  for (const kind of kinds) {
    const badge = P.kindBadge(kind, t);
    assert.ok(badge.text.length <= 8, `kind=${kind} 的徽章文本太长（${badge.text.length} 字符）：${badge.text}`);
  }
  /* 未声明优先于一切：'未声明' 只有 3 个字，放得下。 */
  assert.equal(P.kindBadge('unknown', t).text, '未声明');

  /* CSS 兜底：徽章必须可收缩 + 裁切，否则长文本又会盖到邻座底下。 */
  assert.match(SOURCE, /\.tb-badge\s*\{[^}]*min-width:\s*0/, '徽章必须允许收缩（min-width:0）');
  assert.match(SOURCE, /\.tb-badge\s*\{[^}]*overflow:\s*hidden/, '徽章必须裁切溢出');
  assert.match(SOURCE, /\.tb-badge\s*\{[^}]*text-overflow:\s*ellipsis/, '裁切要给省略号，不是硬切');
});

test('26c. 四种状态色彼此不同（不许四档同一个颜色）', () => {
  const pick = (tone) => {
    const m = SOURCE.match(new RegExp('\\.tb-badge\\[data-tone="' + tone + '"\\]\\s*\\{([^}]*)\\}'));
    return m === null ? '' : m[1].trim();
  };
  const success = pick('success');
  const danger = pick('danger');
  const active = pick('active');
  assert.ok(success && danger && active, '三档都必须有规则体');
  assert.notEqual(success, danger, '完成与失败不许同色');
  assert.notEqual(success, active, '完成与进行中不许同色');
  assert.notEqual(danger, active, '失败与进行中不许同色');
  /* 而且必须走主题 token。 */
  for (const body of [success, danger, active]) {
    assert.match(body, /var\(--dsw-/, '状态色必须走主题 token');
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 27. 右列空白 + 动效降级
 * ═══════════════════════════════════════════════════════════════════════════ */

test('27a. 右列不再靠 align-items:start 悬在顶部（空白不许读成"没加载完"）', () => {
  /* 原来 align-items:start 让台账卡只有约 120px 高，下面约 460px 纯空白（1:3.9）。
   * 现在网格用 stretch，右栏是可撑满的 flex 列，有角色时台账卡 flex:1 撑满。 */
  assert.match(SOURCE, /\.tb-grid\s*\{[^}]*align-items:\s*stretch/, '网格必须 stretch，否则右卡会悬在顶部');
  assert.doesNotMatch(SOURCE, /\.tb-grid\s*\{[^}]*align-items:\s*start/, '不许退回 align-items:start');
  assert.match(SOURCE, /\.tb-rail\s*\{[^}]*display:\s*flex/, '右栏必须是 flex 列');
  assert.match(SOURCE, /\.tb-rail\s*\{[^}]*flex-direction:\s*column/, '右栏必须竖排');
  assert.match(SOURCE, /data-fill="true"\]\s*\{[^}]*flex:\s*1/, '有角色时台账卡必须撑满右栏');
  /* 支撑"有角色才撑"的标记必须真的挂在 section 上。 */
  assert.match(SOURCE, /'data-fill': hasRoles \? 'true' : 'false'/, 'data-fill 必须按"有没有角色"来决定');
});

test('27b. 动效降级：prefers-reduced-motion 必须无条件存在', () => {
  assert.match(SOURCE, /@media \(prefers-reduced-motion: reduce\)/, '必须有 prefers-reduced-motion 媒体查询');
  const block = (() => {
    const at = SOURCE.indexOf('@media (prefers-reduced-motion: reduce)');
    assert.notEqual(at, -1);
    return SOURCE.slice(at, at + 420);
  })();
  assert.match(block, /animation:\s*none\s*!important/, '必须关掉 animation');
  assert.match(block, /transition:\s*none\s*!important/, '必须关掉 transition');
  /* 覆盖范围必须是整棵子树（含伪元素），不能只挑几个类。 */
  assert.match(block, /\.tb-root \*/, '降级必须覆盖整棵子树');
  assert.match(block, /::before/, '伪元素也要降级');
  assert.match(block, /::after/, '伪元素也要降级');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 28. 译文必须真的到页面（用户看到的 E_TASK_INCOMPL… 裸码就是这么来的）
 *
 * 病根：ctx.locale.register(NS, {zh,en}) 注册的是 client.js 里**手写内联**的字典，
 * 不是 locale/*.json。所以 locale 成员翻了 32 条码名，页面上一条都没生效；
 * 而 943 条测试全绿 —— 因为本文件第 21-22 行是拿 zh.json 造 t 的，
 * **测试验的是另一份数据**。这就是"看着对、其实抓不住"的教科书案例。
 *
 * 下面这条断言把两份数据钉死：键集合双向相等 + 每个值逐字相等。
 * 以后谁改一边（加码 / 改译文 / 漏镜像）都会红。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('28a. 内联字典的 gates.code.* 必须与 locale/*.json 逐键逐值一致（双向）', () => {
  for (const [lang, json] of [['zh', ZH], ['en', EN]]) {
    const inline = CLIENT_DICTS[lang];
    assert.ok(inline !== undefined, '内联字典必须存在');
    const jsonKeys = Object.keys(json).filter((k) => k.startsWith('gates.code.')).sort();
    const inlineKeys = Object.keys(inline).filter((k) => k.startsWith('gates.code.')).sort();

    assert.ok(jsonKeys.length >= 30, `locale/${lang}.json 里的门禁码文案太少（${jsonKeys.length}），像是被清空了`);
    /* 双向：JSON 有而内联缺 → 页面显示裸码；内联有而 JSON 缺 → 两边漂移。
     * 用 deepEqual 一次抓两个方向，报错时能直接看出差哪几个。 */
    assert.deepEqual(inlineKeys, jsonKeys, `[${lang}] 内联字典与 locale 的门禁码键集合必须完全一致`);

    /* 逐值相等：键一样但译文不同，是更隐蔽的漂移（页面显示旧译文，测试拿新译文）。 */
    for (const key of jsonKeys) {
      assert.equal(inline[key], json[key], `[${lang}] ${key} 的译文两边必须逐字相同`);
    }
  }
});

test('28b. 页面上不许再出现裸码：有译文的码，codeKey 必须给出人话', () => {
  /* 这条是"用户看到的东西"层面的断言：凡 locale 里有的码，页面都必须能翻成人话。 */
  const codes = Object.keys(ZH).filter((k) => k.startsWith('gates.code.'));
  for (const key of codes) {
    const code = key.slice('gates.code.'.length);
    const label = P.codeKey(code, t);
    assert.notEqual(label, null, `${code} 有译文，codeKey 不该返回 null`);
    assert.notEqual(label, code, `${code} 的 label 不许是码本身（那就是裸码）`);
    assert.equal(label, ZH[key], `${code} 必须显示 locale 里的那句中文`);
  }
});

test('28c. t 解析的是"运行时合表"——这条防的是测试又验另一份数据', () => {
  /* 如果哪天有人把 t 改回"只读 zh.json"，页面上那 32 条译文就又不会生效，
   * 而 28a 只比对两份数据、发现不了 t 用错表。所以这里直接钉 t 的行为。 */
  for (const lang of ['zh', 'en']) {
    const key = 'gates.code.E_TASK_INCOMPLETE';
    if (CLIENT_DICTS[lang][key] === undefined) continue;
    const tt = makeT({ ...ZH, ...CLIENT_DICTS[lang] });
    assert.equal(tt(key), CLIENT_DICTS[lang][key], 't 必须能解析出内联字典里的译文');
  }
  /* 当前测试用的 t 必须已经合了内联表（否则本文件其余测试都在验另一份数据）。 */
  assert.notEqual(t('gates.code.E_TASK_INCOMPLETE'), 'gates.code.E_TASK_INCOMPLETE',
    't 解析不出 E_TASK_INCOMPLETE 的译文 —— 说明测试的 t 没合内联字典');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 29. 图节点必须带"这是什么"（用户原话：「task一，我知道那是个啥吗？」）
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 造一份带 subject 的任务板数据。 */
function fixtureTasksWithSubject() {
  return [
    { id: 'task-1', subject: '把登录校验挪到中间件里', kind: 'implementation', status: 'in_progress', owner: 'bob' },
    { id: 'task-2', subject: '重写审计对账脚本并补回归', status: 'completed' },
  ];
}

test('29a. taskSubjects：从 tasks 抽 id → subject，畸形输入给出空 Map（不抛）', () => {
  const map = P.taskSubjects(fixtureTasksWithSubject());
  assert.equal(map.get('task-1'), '把登录校验挪到中间件里');
  assert.equal(map.get('task-2'), '重写审计对账脚本并补回归');
  assert.equal(map.size, 2);

  /* 非数组 / 脏数据一律不抛，且不能凭空造条目。 */
  for (const bad of [undefined, null, 'x', 42, {}, [null, 1, {}, { id: '' }]]) {
    const safe = P.taskSubjects(bad);
    assert.equal(safe instanceof Map, true);
    assert.equal(safe.size, 0, `畸形输入不许产出条目：${JSON.stringify(bad)}`);
  }
  /* 只有 id 没有 subject 的任务：不进映射（图上只显示 id，不显示空行）。 */
  const onlyId = P.taskSubjects([{ id: 'task-9' }]);
  assert.equal(onlyId.size, 0);
});

test('29b. 任务节点必须带上标题，不能只有 task-N', () => {
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  const subjects = P.taskSubjects(fixtureTasksWithSubject());
  const layout = P.graphLayout(issues, undefined, subjects);

  const task1 = layout.tasks.find((task) => task.id === 'task-1');
  assert.notEqual(task1, undefined);
  assert.equal(task1.subject, '把登录校验挪到中间件里', '任务节点必须把标题透传上来');
  assert.ok(task1.subject.startsWith('把登录校验'), '标题必须是宿主给的那句，不许改写');

  /* 没有标题的任务：subject 是空串（页面只画 id），而不是 undefined 或 'undefined'。 */
  const task4 = layout.tasks.find((task) => task.id === 'task-4');
  assert.equal(task4.subject, '');

  /* 不传 subjects 也不许抛（图照画，只是没标题）。 */
  const bare = P.graphLayout(issues);
  assert.ok(bare.tasks.every((task) => task.subject === ''));
  /* 传普通对象（非 Map）也要工作。 */
  const asObject = P.graphLayout(issues, undefined, { 'task-2': '对象形式也要认' });
  assert.equal(asObject.tasks.find((task) => task.id === 'task-2').subject, '对象形式也要认');
});

test('29b2. 页面调用点必须真的把 subjects 送进图里（否则纯函数对了、页面还是没标题）', () => {
  /* 这条存在的原因很具体：29b 测的是 graphLayout，把 CauseGraph 调用点的 subjects 删掉
   * 它照样绿 —— 那正是本轮要修的病（测试验的是另一条路径）。所以这里直接扫调用点。 */
  assert.match(SOURCE, /h\(CauseGraph, \{[^}]*subjects:\s*taskSubjects\(gates\.tasks\)/,
    'GateCard 必须把 taskSubjects(gates.tasks) 传给 CauseGraph');
  assert.match(SOURCE, /function CauseGraph\(\{ issues, subjects, t \}\)/,
    'CauseGraph 必须接收 subjects');
  assert.match(SOURCE, /graphLayout\(issues, undefined, subjects\)/,
    'CauseGraph 必须把 subjects 交给 graphLayout');
});

test('29c. 根因节点：有中文名时必须用中文名，且不许出现截断的残码', () => {
  /* 病根：上一版把主行 clampText(..., 15)，于是页面上出现 'E_TASK_INCOMPL…'。
   * 现在主行是中文名，完整码降为次行小字；两行放得下靠的是 nodeH 加到 40。 */
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  const incomplete = issues.find((item) => item.code === 'E_TASK_INCOMPLETE');
  assert.equal(typeof incomplete.label, 'string', '做完镜像之后这个码必须有中文名');
  assert.notEqual(incomplete.label, incomplete.code, 'label 不许是码本身');

  /* 渲染层用的是 label；clamp 的宽度必须容得下中文名，不许把中文名也截断成残句。 */
  const graphStart = SOURCE.indexOf('function CauseGraph');
  const graphEnd = SOURCE.indexOf('\n    }\n', graphStart);
  const body = SOURCE.slice(graphStart, graphEnd);
  assert.match(body, /cause\.label === null \? cause\.code : cause\.label/,
    '根因主行必须优先用中文名，只有没译文时才退回码');
  /* 次行必须是**完整的码**，不许再 clamp —— 9.5px 等宽下 18 字符约 103px，
   * 208px 的节点放得下，所以不截断才是正确做法（上一版 clamp 到 15 产生残码）。 */
  assert.match(body, /\}, cause\.code\)/, '次行必须直接显示完整的门禁码，不许再截断');
  assert.doesNotMatch(body, /clampText\(cause\.code/, '不许对门禁码做截断（那是残码的来源）');
  /* 主行的截断宽度必须 >= 中文名常见长度（11），否则中文名自己又被截。 */
  const mainClamp = body.match(/clampText\(cause\.label === null \? cause\.code : cause\.label, (\d+)\)/);
  assert.notEqual(mainClamp, null, '找不到根因主行的渲染');
  assert.ok(Number(mainClamp[1]) >= 11, `中文名截断宽度太小（${mainClamp[1]}），会把中文名也截成残句`);
});

test('29d. 节点加高到两行放得下：nodeH 必须容得下"主行 + 次行"', () => {
  /* 放不下就会靠截断，而截断正是用户看到残码的来源。所以把高度钉住。 */
  assert.ok(P.GRAPH.nodeH >= 38, `nodeH=${P.GRAPH.nodeH} 放不下两行（主行 11.5px + 次行 10px + 行距）`);
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  const layout = P.graphLayout(issues, undefined, P.taskSubjects(fixtureTasksWithSubject()));
  for (const node of [...layout.tasks, ...layout.causes]) {
    assert.equal(node.h, P.GRAPH.nodeH, '每个节点都必须用同一个高度');
  }
  /* 行距仍然等于 nodeH + vGap（索引算术没被破坏）。 */
  const step = P.GRAPH.nodeH + P.GRAPH.vGap;
  layout.causes.forEach((cause, index) => {
    const expected = ((layout.causes.length >= layout.tasks.length ? 0 : (layout.tasks.length - layout.causes.length) * step / 2)) + index * step;
    assert.equal(cause.y, expected, '根因节点仍按索引算术排布');
  });
});
﻿/* ═══════════════════════════════════════════════════════════════════════════
 * 30. 说明折两行 + 节点 52px（用户拍板选 C）
 *
 * 用户原话：「说明被截得比较早」，举例 开关漏了一半：team_del… —— 关键信息
 * deliver 没有 when 正好被切掉。
 * ═══════════════════════════════════════════════════════════════════════════ */

﻿test('30a. wrapLabel：短文本一行、长文本两行、超长第二行带省略号', () => {
  const max = P.GRAPH.subMaxUnits;

  /* 短：原样一行，不加省略号。 */
  const short = P.wrapLabel('改登录', max);
  assert.equal(short.length, 1);
  assert.equal(short[0], '改登录');

  /* 中等：正好两行，第二行不加省略号。用汉字（每字 2 单位）拼满两行。 */
  const twoLines = P.wrapLabel('甲'.repeat(max), max);
  assert.equal(twoLines.length, 2, '超出一行宽度就必须折成两行');
  assert.equal(twoLines[1].endsWith('…'), false, '放得下就不许加省略号');

  /* 长：两行 + 第二行省略号。 */
  const long = P.wrapLabel('丙'.repeat(max * 2), max);
  assert.equal(long.length, 2, '永远最多两行');
  assert.equal(long[1].endsWith('…'), true, '放不下时第二行必须以省略号收尾');
});

test('30b. 折行后每行宽度都不超过上限（否则照样溢出节点框）', () => {
  const max = P.GRAPH.subMaxUnits;
  const samples = [
    'a'.repeat(200),
    '中'.repeat(200),
    '混排 mixed 文本 with ASCII 和中文混在一起的那种特别长的说明',
    'x',
    '',
  ];
  for (const text of samples) {
    const lines = P.wrapLabel(text, max);
    assert.ok(lines.length <= 2, `最多两行，实际 ${lines.length}（${text.slice(0, 8)}…）`);
    for (const line of lines) {
      /* 宽度口径：汉字算 2 个单位。字符数会高估英文、低估汉字。 */
      const units = P.textUnits(Array.from(line));
      assert.ok(units <= max, `这一行超宽：${units} > ${max}（${line}）`);
    }
  }
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.deepEqual(P.wrapLabel(bad, max), []);
  }
});

test('30c. 三行文本的基线全部落在节点框内（52px 放得下主行 + 2 行说明）', () => {
  const G = P.GRAPH;
  assert.ok(G.nodeH >= 52, `nodeH=${G.nodeH}，放不下三行`);
  /* 基线 + 下伸部必须仍在框内。留 6px 给文字下伸与内边距。 */
  const descender = 6;
  for (const [name, baseline] of [['lineMain', G.lineMain], ['lineSub1', G.lineSub1], ['lineSub2', G.lineSub2]]) {
    assert.ok(baseline > 0, `${name}=${baseline} 必须在节点顶边以下`);
    assert.ok(baseline + descender <= G.nodeH, `${name}=${baseline} + ${descender} 溢出了 nodeH=${G.nodeH}`);
  }
  /* 根因节点两行，同样要在框内。 */
  for (const [name, baseline] of [['lineCause1', G.lineCause1], ['lineCause2', G.lineCause2]]) {
    assert.ok(baseline > 0 && baseline + descender <= G.nodeH, `${name}=${baseline} 溢出 nodeH=${G.nodeH}`);
  }
  /* 行序必须递增，否则两行说明会叠在一起。 */
  assert.ok(G.lineMain < G.lineSub1 && G.lineSub1 < G.lineSub2, '任务节点三行的基线必须递增');
  assert.ok(G.lineCause1 < G.lineCause2, '根因节点两行的基线必须递增');
});

test('30d. graphLayout 的总高度按 nodeH 算进去了（加高后行距必须跟着变）', () => {
  const G = P.GRAPH;
  const issues = P.aggregateIssues(P.gateGroups(fixtureGates(), t), t);
  const layout = P.graphLayout(issues, undefined, P.taskSubjects(fixtureTasksWithSubject()));
  const step = G.nodeH + G.vGap;
  const rows = Math.max(layout.causes.length, layout.tasks.length);
  assert.equal(layout.height, rows * step - G.vGap, '总高必须用新的 nodeH 算');
  for (const node of [...layout.tasks, ...layout.causes]) assert.equal(node.h, G.nodeH);
  /* 第二个节点必须比第一个低 "nodeH + vGap"，否则三行会互相压。 */
  if (layout.tasks.length >= 2) {
    assert.equal(layout.tasks[1].y - layout.tasks[0].y, step);
  }
});

test('30e. 任务节点渲染：说明必须走 wrapLabel 生成的多行，不许退回单行 clamp', () => {
  const graphStart = SOURCE.indexOf('function CauseGraph');
  const graphEnd = SOURCE.indexOf('\n    }\n', graphStart);
  const body = SOURCE.slice(graphStart, graphEnd);
  assert.match(body, /wrapLabel\(task\.subject, G\.subMaxUnits\)/, '任务说明必须经 wrapLabel 折行');
  assert.match(body, /\.map\(\(line, lineIndex\)/, '折出来的每一行都要单独画一个 text');
  assert.match(body, /lineIndex === 0 \? G\.lineSub1 : G\.lineSub2/, '两行的 y 必须分别取两个基线常量');
  assert.doesNotMatch(body, /clampText\(task\.subject/, '不许再对说明做单行 clamp（那就是"截得早"的原因）');
  /* 根因节点保持两行，不许趁机加第三行。 */
  assert.doesNotMatch(body, /lineCause3/, '根因节点不许出现第三行基线');
});
﻿/* ═══════════════════════════════════════════════════════════════════════════
 * 31. E_AUDIT_UNWIRED 必须有译文，且语义必须是"没查"而不是"没事"
 * ═══════════════════════════════════════════════════════════════════════════ */

test('31a. E_AUDIT_UNWIRED 在 locale 与内联表里都有译文，且不是裸码', () => {
  const KEY = 'gates.code.E_AUDIT_UNWIRED';
  const code = 'E_AUDIT_UNWIRED';
  assert.equal(typeof ZH[KEY], 'string', 'locale/zh.json 缺这条');
  assert.equal(typeof EN[KEY], 'string', 'locale/en.json 缺这条');
  assert.equal(typeof CLIENT_DICTS.zh[KEY], 'string', '内联 zh 表缺这条（页面用的就是它）');
  assert.equal(typeof CLIENT_DICTS.en[KEY], 'string', '内联 en 表缺这条');
  /* 页面层面：codeKey 必须给出人话，而不是 null（null 就退回裸码）。 */
  assert.notEqual(P.codeKey(code, t), null, '有译文就该翻出来，不许回退成裸码');
  assert.notEqual(P.codeKey(code, t), code, 'label 不许是码本身');
  /* 截图里它显示成 E_AUDIT_UNI... —— 那是因为没译文、退回码又被截断。这条钉住不再发生。 */
  assert.equal(P.codeKey(code, t), CLIENT_DICTS.zh[KEY]);
});

test('31b. 这条文案的语义必须是「没查」，不是「没事」（本项目第一天起的红线）', () => {
  const zhText = CLIENT_DICTS.zh['gates.code.E_AUDIT_UNWIRED'];
  const enText = CLIENT_DICTS.en['gates.code.E_AUDIT_UNWIRED'];

  /* 必须点明"没拿到审计输入"与"结论不成立"。 */
  for (const word of ['审计', '不成立']) {
    assert.ok(zhText.includes(word), `zh 文案必须含「${word}」，实际：${zhText}`);
  }
  assert.ok(/没查|未查/.test(zhText), 'zh 文案必须说清"没查"');
  for (const word of ['audit', 'cannot be concluded', 'not checked']) {
    assert.ok(enText.toLowerCase().includes(word.toLowerCase()), `en 文案必须含「${word}」，实际：${enText}`);
  }

  /* 反向：不许把"没查"写成"没事"。 */
  const forbidden = ['没有问题', '没有越权改动：', '一切正常', '通过', '无风险'];
  for (const bad of forbidden) {
    assert.ok(zhText.includes(bad) === false, `zh 文案出现了"报平安"的说法「${bad}」：${zhText}`);
  }
  for (const bad of ['no issues', 'all clear', 'safe', 'passed']) {
    assert.ok(enText.toLowerCase().includes(bad) === false, `en 文案出现了报平安的说法「${bad}」：${enText}`);
  }

  /* 必须给出"该谁做什么"：补输入，或按"没查"读。 */
  assert.ok(/补审计输入|补上审计输入/.test(zhText), 'zh 文案必须给出下一步动作（补审计输入）');
});

test('31c. 加了这些键之后，两边仍然是 81 条且逐字相等', () => {
  const codeKeys = Object.keys(ZH).filter((k) => k.startsWith('gates.code.'));
  /* 36 → 44（task-20 / 21 / 22）。多出来的 8 条不是一次新增：`E_PROPOSAL_UNREVIEWED`、
   * `E_QUESTIONS_UNANSWERED` 是前两轮就写好的门禁，只是**从来没进过词典** ——
   * 也就是说那两条阻断此前在页面上只能显示成"未知门禁"，写着"提案没人读"的码
   * 到达用户面前时是一句无从下手的话。
   * 所以这次一口气补齐：先让旧的两条能说人话，再带上 task-22 的六条。
   *
   * 44 → 45：v1.1 第一条新门禁 `E_REPORTED_UNCHANGED`（报了没改）。
   * 它和已有的 `E_UNREPORTED_CHANGES`（改了没报）是一对反向的账，两条都在
   * `DELIVERY_BLOCKER_CODES` 里——所以它必须有自己的文案，否则页面上又是一句
   * "未知门禁"。这个数字断言就是逼着新增门禁同时落地三份拷贝（两个 locale
   * 文件 + client.js 内联表），少一份这里就红。
   *
   * 45 → 47：v1.1 另外两条 —— `E_BASIS_FABRICATED`（引用的依据 id 不存在）、
   * `E_ARTIFACT_UNVERIFIED`（申报的产物在磁盘上拿不到指纹）。这两条堵的是同一个洞的
   * 另外两个方向：前一条管"卡上引用的东西",后一条管"卡上声称存在的东西"，
   * 而原有的二十多条门禁全都在判**卡的形状**。
   *
   * 47 → 71：会议流水线那 24 条新码。**这 24 条不是手抄进来的** ——
   * 它们由 `tools/gen-meeting-codes.mjs` 从 `src/codes.mjs` 生成进
   * 两个 locale 文件与 `client.js` 的中英两段内联表（带 `@meeting-codes` 标记）。
   * 所以从这一轮起，本组的数字断言守的不再是"人有没有抄全四处"，
   * 而是"生成器有没有跑过" —— 后者是可机械保证的，前者不是。
   * 真正守"码表与文案一致"的是 `codes.test.mjs` 的第 7 组（重新生成一遍再逐字比对）。
   *
   * 71 → 73：账本改存任务树之后的两条新码 `E_LEDGER_PARTIAL`（账本只写进去一半）
   * 与 `E_LEDGER_WRITE_FAILED`（写这条路失败）。它们同样是生成进来的，
   * 但这个数字仍然必须有人手动改一次 —— 作用就在这儿：逼着"确实该加这两条"
   * 被明确决定一次。人手抄漏一处时这里会红，而生成器漏跑时 `codes.test.mjs` 7a 会红，
   * 两处红的分工不同，合起来才盖住。
   *
   * 73 → 80：清"一码两义"那一轮拆出来的 7 条新码（`E_PRESET_EMPTY_IMPLEMENTED`、
   * `E_PRESET_NO_BLIND_STAGE`、`E_MEETING_ABANDONED`、`E_LEDGER_DROPPED`、
   * `E_LEDGER_STRAY_STAGE`、`E_RESUME_LIVENESS_UNKNOWN`、`E_AGENT_OVERRIDE_NO_REASON`）。
   * 一条码只管一件事之后，总条数必然会涨 —— 这个数字涨是**修对了**的证据，不是退步。
   *
   * 数字断言的作用就是这种时刻：一口气加了 8 个键，得有人确认"确实该加这些"。 */
  assert.equal(codeKeys.length, 81, `gates.code.* 应该是 81 条，实际 ${codeKeys.length}`);

  /* **en 必须有自己的一条独立计数钉子。**
   * 上面那句只从 `ZH` 算，`en` 靠下面的键集比对 + `28a` + `35a` 守 —— 够用，
   * 但"删掉一条 en 键而**条数**断言毫无反应"这件事成立：哪天有人把下面的循环改成只跑 `zh`，
   * `en` 就只剩 `28a`/`35a`，而那两把尺的覆盖面不同（`28a` 只管 `gates.code.*`）。
   * 一句话：**en 的条数不该由"别人还守着它"来保证。** */
  assert.equal(
    Object.keys(EN).filter((key) => key.startsWith('gates.code.')).length,
    81,
    'en 的码条数必须独立计数（不许只靠键集比对兜）',
  );
  for (const lang of ['zh', 'en']) {
    const json = lang === 'zh' ? ZH : EN;
    const inlineKeys = Object.keys(CLIENT_DICTS[lang]).filter((k) => k.startsWith('gates.code.')).sort();
    assert.deepEqual(inlineKeys, codeKeys.slice().sort(), `[${lang}] 内联与 locale 键集合必须一致`);
    for (const key of codeKeys) {
      assert.equal(CLIENT_DICTS[lang][key], json[key], `[${lang}] ${key} 译文必须逐字相同`);
    }
  }
});
﻿/* ═══════════════════════════════════════════════════════════════════════════
 * 32. 语义色不许上字形（可读性红线）
 *
 * 起因：实测琥珀色 state-warn-primary 在浅色主题白底上对比度只有 2.15:1，
 * 连大字门槛 3:1 都不到，而它当时被画在 9.5-11.5px 的小字上。
 * 不能靠"我记得别这么写"来保证 —— 所以下面这条断言是机械可判定的。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 取出 STYLES 里所有 CSS 规则（去掉注释）。 */
function cssRules() {
  const start = SOURCE.indexOf('const STYLES = ' + String.fromCharCode(96)) + 17;
  const end = SOURCE.indexOf('\n' + String.fromCharCode(96) + ';', start);
  const css = SOURCE.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}@]+)\{([^}]*)\}/g)].map((m) => ({
    selector: m[1].replace(/\s+/g, ' ').trim(),
    body: m[2],
  }));
}

const SEMANTIC = /var\(--tb-tone|var\(--dsw-alias-state-/;

test('32a. 任何规则的 color 都不许用语义色（语义只上形状：条 / 边框 / 描边 / 填充）', () => {
  const bad = [];
  for (const rule of cssRules()) {
    const cm = rule.body.match(/(?:^|;)\s*color:\s*([^;]+)/);
    if (cm === null) continue;
    if (SEMANTIC.test(cm[1])) bad.push(rule.selector + ' → ' + cm[1].trim());
  }
  assert.deepEqual(bad, [],
    '语义色画在字形上：浅色主题下琥珀对白底只有 2.15:1，读不清。改法是把语义搬到 border-color / background / stroke / fill。');
});

test('32b. 语义色必须仍然存在（搬走之后不许把严重度也一起丢掉）', () => {
  /* 反向断言：32a 逼我把 color 里的语义色全删了，但如果顺手把
   * border-color / stroke / fill 里的一起删掉，页面就变成"全灰、无严重度"。
   * 这一条守住"颜色还在，只是不在字上"。 */
  const props = new Set();
  for (const rule of cssRules()) {
    for (const m of rule.body.matchAll(/([a-z-]+)\s*:\s*([^;]*)/g)) {
      if (SEMANTIC.test(m[2])) props.add(m[1].trim());
    }
  }
  for (const need of ['border-color', 'stroke', 'fill']) {
    assert.ok(props.has(need), `语义色必须还出现在 ${need} 上（实际：${[...props].sort().join(', ')}）`);
  }
  assert.ok(props.has('--tb-tone'), '严重度的语义变量 --tb-tone 必须还在用');
});

test('32c. 三档的非颜色通道仍然互不相同（条宽 4/3/2 与形状三种）', () => {
  /* 32a 把颜色从字上搬走之后，形状通道就成了唯一区分依据 —— 必须确认它还成立。 */
  const bars = ['hard', 'precondition', 'warning'].map((tone) => P.toneMeta(tone).bar);
  const glyphs = ['hard', 'precondition', 'warning'].map((tone) => P.toneMeta(tone).glyph);
  assert.equal(new Set(bars).size, 3, `色条宽度必须三档不同，实际 ${bars.join('/')}`);
  assert.equal(new Set(glyphs).size, 3, `形状必须三档不同，实际 ${glyphs.join(' ')}`);
  assert.ok(bars[0] > bars[1] && bars[1] > bars[2], '条宽必须随严重度递减');
});

test('32d. 小字规则（font-size < 12px）与徽章都不再依赖颜色传达状态', () => {
  const smalls = cssRules().filter((rule) => {
    const fm = rule.body.match(/font-size:\s*([\d.]+)px/);
    return fm !== null && Number(fm[1]) < 12;
  });
  assert.ok(smalls.length >= 6, `小于 12px 的规则太少（${smalls.length}），扫描逻辑可能坏了`);
  for (const rule of smalls) {
    const cm = rule.body.match(/(?:^|;)\s*color:\s*([^;]+)/);
    if (cm === null) continue;
    assert.doesNotMatch(cm[1], /var\(--dsw-alias-state-/, `小字 ${rule.selector} 仍在用状态色`);
  }
  /* 徽章的语义必须落在边框上（否则状态色就彻底消失了）。 */
  const successRule = cssRules().find((rule) => rule.selector.includes('.tb-badge[data-tone="success"]'));
  assert.notEqual(successRule, undefined, '找不到 success 徽章规则');
  assert.match(successRule.body, /border-color:\s*var\(--dsw-alias-state-success-primary\)/, '徽章状态必须由边框色承担');
  /* 注意：必须排除 border-color —— 上一版的正则把 border-color 里的 color 也算进来了，
   * 于是"边框上有状态色"反而被判成违规。用否定后顾避开连字符。 */
  assert.doesNotMatch(successRule.body, /(?<![-\w])color:\s*var\(--dsw-alias-state-/, '徽章文字不许再用状态色');
});
﻿/* ═══════════════════════════════════════════════════════════════════════════
 * 33. 「申报改动」必须和「事实」分得开（本项目红线）
 *
 * 手上只有成员的一句话，事实要靠 diff 对账 —— 那是判定层的活。
 * 所以页面上不能出现「改了这些文件」，只能出现「申报改了这些文件」。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('33a. 有申报时 chip 出现且带申报标记；原文逐条照搬', () => {
  const rows = P.boardRows([
    { id: 'task-1', subject: 'x', declaredChanges: ['src/a.mjs', 'src/b.mjs'] },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].declaredChanges, ['src/a.mjs', 'src/b.mjs'], '申报路径必须逐条照搬');

  /* 渲染层：必须有 ✎ 前缀与「申报改动」说明文字。
   * 必须只看**函数体**：✎ 在注释里也出现一次，只查 SOURCE 会被注释满足 ——
   * 那样"把渲染里的 ✎ 删掉"就不会红（我第一版正好是这样，变异没咬住）。 */
  const fnAt = SOURCE.indexOf('function DeclaredChanges(');
  assert.notEqual(fnAt, -1, '找不到 DeclaredChanges');
  const fnBody = SOURCE.slice(fnAt, SOURCE.indexOf('\n    }\n', fnAt));
  assert.ok(fnBody.includes('✎'), '渲染出来的申报 chip 必须带 ✎ 前缀标记');
  assert.match(fnBody, /t\(K\.declaredCaption\)/, '必须有「申报改动」这一句说明');
  assert.match(fnBody, /className: 'tb-chip tb-chip-declared'/, '申报 chip 必须有自己的类名');
});

test('33b. undefined 与空数组都不渲染（不许显示「无」）', () => {
  /* 三种空：键不存在、null、空数组 —— 都不能画出任何东西。 */
  const cases = [
    { id: 'task-1' },
    { id: 'task-1', declaredChanges: null },
    { id: 'task-1', declaredChanges: [] },
    { id: 'task-1', declaredChanges: ['', '   '] },
    { id: 'task-1', declaredChanges: 'src/a.mjs' },
  ];
  for (const task of cases) {
    const rows = P.boardRows([task]);
    const value = rows[0].declaredChanges;
    assert.ok(value === undefined || (Array.isArray(value) && value.length === 0),
      `空输入不许变成可渲染的内容：${JSON.stringify(task.declaredChanges)} → ${JSON.stringify(value)}`);
  }
  /* 组件层面：空列表必须返回 null（不是画一个空 span 或一个「无」）。 */
  assert.match(SOURCE, /if \(list\.length === 0\) return null;/, '申报为空时必须整块不渲染');
  /* 只检查组件函数体本身：上一版正则扫了整份源码，把注释里的字也匹配进来，
   * 于是"断言写得太钝"反而会误报。 */
  const fnAt = SOURCE.indexOf('function DeclaredChanges(');
  assert.notEqual(fnAt, -1, '找不到 DeclaredChanges');
  const fnBody = SOURCE.slice(fnAt, SOURCE.indexOf('\n    }\n', fnAt));
  assert.doesNotMatch(fnBody, /'无'|"无"|'none'|"none"/, '申报为空时不许显示「无」/none');
});

test('33c. 文案必须是「申报」，且绝不出现「已核实 / 已验证 / 改了」这类断言', () => {
  const zhText = CLIENT_DICTS.zh['board.declaredCaption'];
  const enText = CLIENT_DICTS.en['board.declaredCaption'];
  assert.equal(typeof zhText, 'string');
  assert.equal(typeof enText, 'string');
  assert.ok(zhText.includes('申报'), `中文必须出现「申报」二字，实际：${zhText}`);
  assert.match(enText.toLowerCase(), /declared/, `英文必须是 declared 而不是 changed，实际：${enText}`);

  /* 反向：不许把申报写成已核实。 */
  for (const bad of ['已核实', '已验证', '确认改', '实际改', '改了这些']) {
    assert.ok(zhText.includes(bad) === false, `文案出现了断言式说法「${bad}」`);
  }
  for (const bad of ['verified', 'confirmed', 'changed these']) {
    assert.ok(enText.toLowerCase().includes(bad) === false, `英文出现了断言式说法「${bad}」`);
  }
  /* 悬停提示也必须带「申报」（悬停常常是唯一被读到的地方）。 */
  assert.match(SOURCE, /title: `\$\{t\(K\.declaredCaption\)\}：/, 'chip 的 title 必须以「申报改动：」开头');
});

test('33d. 关系图这轮不加申报项（节点已经很挤）', () => {
  const graphStart = SOURCE.indexOf('function CauseGraph');
  const graphEnd = SOURCE.indexOf('\n    }\n', graphStart);
  const body = SOURCE.slice(graphStart, graphEnd);
  assert.doesNotMatch(body, /declaredChanges/, '关系图节点不许加申报改动（这轮明确不做）');
  /* 图节点的数据来源也不该带它。 */
  assert.doesNotMatch(SOURCE, /graphLayout\([^)]*declaredChanges/, 'graphLayout 不许接收申报改动');
});
﻿/* ═══════════════════════════════════════════════════════════════════════════
 * 34. 英文单词不许被劈开（用户截图里 team_del | er 那个缺陷）
 *
 * 根因有两层，缺一条都修不好：
 *   ① **按字符数当宽度**：team_deliver 是 12 个字符，10px 下只有约 6.6 个汉字宽；
 *      按字符数算等于把它当 12 个汉字宽，于是被顶到下一行；
 *   ② **切点落在词中间**：即使位置算对了，也要在切之前退让到词边界。
 * 所以既有 breakPoint 的词边界逻辑，也有 charUnits 的宽度口径。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('34a. 用户截图里的那句：team_deliver 必须完整落在某一行里', () => {
  const text = '开关漏了一半：team_deliver 没有 when，用户关掉开关后 team_deliver 仍然可用';
  const lines = P.wrapLabel(text, P.GRAPH.subMaxUnits);
  assert.ok(lines.length >= 1 && lines.length <= 2);

  const joined = lines.join('\n');
  assert.ok(joined.includes('team_deliver'), 'team_deliver 必须完整出现在某一行里');

  /* 最直接的判法：任何一行都不许以"词的一半"结尾。
   * 上一版的第 1 行是 '开关漏了一半：team_deliv'，第 2 行是 'er 没有…'。 */
  for (const line of lines) {
    const tail = line.replace(/…$/, '').trimEnd();
    assert.doesNotMatch(tail, /team_del$/, `第一行不许停在 team_del 中间：${tail}`);
    assert.doesNotMatch(tail, /team_deli$/, `不许停在 team_deli：${tail}`);
    assert.doesNotMatch(tail, /team_deliv$/, `不许停在 team_deliv：${tail}`);
  }
  /* 第二行不许以被切剩的半截词开头。 */
  if (lines.length === 2) {
    assert.doesNotMatch(lines[1], /^er\b/, `第二行不许以 'er' 开头（那是 team_deliver 被劈开的后半）：${lines[1]}`);
  }
});

test('34b. 纯中文长文本：仍然按宽度折行，不会因为找不到空格就整句一行', () => {
  const text = '这是一段纯中文的说明，用来确认没有空格时仍然按宽度正常折行，不会因为找不到空格就把整句塞进一行';
  const lines = P.wrapLabel(text, P.GRAPH.subMaxUnits);
  assert.equal(lines.length, 2, '纯中文超出一行宽度就必须折两行');
  for (const line of lines) {
    assert.ok(P.textUnits(Array.from(line)) <= P.GRAPH.subMaxUnits + 2, `中文行超宽：${line}`);
  }
  /* 不许把整句塞进一行。 */
  assert.ok(lines[0].length < text.length, '第一行不该等于全文');
});

test('34c. 单个超长英文单词：允许劈开，但不许返回空、不许抛', () => {
  const word = 'supercalifragilisticexpialidocious_and_then_some_more_letters_here';
  const lines = P.wrapLabel(word, P.GRAPH.subMaxUnits);
  assert.equal(lines.length, 2, '放不下就是两行（允许劈词，因为别无选择）');
  assert.ok(lines[0].length > 0 && lines[1].length > 0, '两行都不许为空');
  assert.equal((lines[0] + lines[1].replace(/…$/, '')).replace(/\s/g, ''), word.replace(/…$/, ''),
    '劈开归劈开，字符不许丢');
  /* 畸形输入不抛。 */
  for (const bad of [undefined, null, 42, {}, []]) assert.deepEqual(P.wrapLabel(bad, 34), []);
});

test('34d. breakPoint：切点落在空格上时，不产生前导/尾随空格', () => {
  const chars = Array.from('abc def ghi');
  const cut = P.breakPoint(chars, 4);            // 宽度 4 → 'abc ' 之后就是 d
  assert.equal(chars.slice(0, cut).join(''), 'abc', '空格不许留在第一行行尾');
  const wrapped = P.wrapLabel('abc def ghi', 4);
  assert.equal(wrapped[0], 'abc', `第一行不许有尾随空格：${JSON.stringify(wrapped[0])}`);
  assert.equal(wrapped[1].startsWith(' '), false, `第二行不许有前导空格：${JSON.stringify(wrapped[1])}`);

  /* 连字符：留在第一行行尾，不要跑到第二行开头。 */
  const hy = Array.from('self-review');
  const hyCut = P.breakPoint(hy, 6);             // 'self-r' 宽度 6，落在词中 → 退到连字符之后
  assert.equal(hy.slice(0, hyCut).join(''), 'self-', '连字符应留在第一行行尾');

  /* 宽度口径：汉字 2 单位、ASCII 1 单位。 */
  assert.equal(P.charUnits('中'), 2);
  assert.equal(P.charUnits('a'), 1);
  assert.equal(P.textUnits(Array.from('中a')), 3);
});
﻿test('34e. 通用规则：切点不许落在两个 ASCII 词字符之间（除非整个词放不下）', () => {
  /* 为什么需要这条而不是只测 team_deliver：
   * team_deliver 那句现在能完整，**靠的是按宽度算而不是找词边界**（31 单位 < 34，切点正好落在空格上）。
   * 去掉词边界逻辑后，它会变成 "...没有 wh" / "en，用户..." —— team_deliver 仍然完整，
   * 但 when 被劈开。只测一个词抓不到这个回归，所以要断言规则本身。 */
  const WORD = /[A-Za-z0-9_-]/;
  const samples = [
    '开关漏了一半：team_deliver 没有 when，用户关掉开关后 team_deliver 仍然可用',
    'the quick brown fox jumps over 中文 the lazy dog 再跳一次',
    'averylongunbrokentoken_that_should_break_somewhere_here 尾巴',
  ];
  for (const text of samples) {
    const chars = Array.from(text);
    const firstCut = P.breakPoint(chars, P.GRAPH.subMaxUnits);
    if (firstCut <= 0 || firstCut >= chars.length) continue;
    const left = chars[firstCut - 1];
    const right = chars[firstCut];
    const bothWordChars = WORD.test(left) && WORD.test(right);
    if (!bothWordChars) continue;
    /* 落在词中间时：必须是"真的找不到更好的切点"（前面没有任何空格/连字符），
     * 否则就说明倒着找那一步没生效。 */
    const hasEarlierBreak = chars.slice(0, firstCut).some((ch) => ch === ' ' || ch === '-');
    assert.equal(hasEarlierBreak, false,
      `切点落在词中间（${JSON.stringify(left)}|${JSON.stringify(right)}），而前面存在可用的空格/连字符 —— 词边界逻辑没生效：${text}`);
  }

  /* 正例：确实存在"词中间但前面没有空格"的合法情形（单个超长词），必须仍能切。 */
  const longWord = Array.from('x'.repeat(80));
  const cut = P.breakPoint(longWord, P.GRAPH.subMaxUnits);
  assert.ok(cut > 0 && cut < longWord.length, '单个超长词必须允许劈开，否则会死循环');
});

test('34f. 宽度口径本身：汉字 2 单位、ASCII 1 单位，字符数不等于宽度', () => {
  /* 这条钉住根因：把 charUnits 改回恒等 1，就是回到"12 个字符当成 12 个汉字宽"的老毛病。 */
  assert.equal(P.charUnits('中'), 2);
  assert.equal(P.charUnits('，'), 2);
  assert.equal(P.charUnits('a'), 1);
  assert.equal(P.charUnits('_'), 1);
  assert.equal(P.textUnits(Array.from('team_deliver')), 12, 'ASCII 词按 1 单位算');
  assert.equal(P.textUnits(Array.from('开关漏了一半：')), 14, '7 个全角字符 = 14 单位');
  /* 关键对比：team_deliver 的宽度远小于同长度的汉字串。 */
  assert.ok(
    P.textUnits(Array.from('team_deliver')) < P.textUnits(Array.from('汉字汉字汉字汉字汉字汉')),
    'ASCII 的宽度必须小于同字符数的汉字 —— 否则又会把英文当成汉字宽顶到下一行',
  );
});
﻿/* ═══════════════════════════════════════════════════════════════════════════
 * 35. 一致性断言必须覆盖**全部键**，不能只覆盖 gates.code.*
 *
 * 起因：switch.hint 已经漂了 —— JSON 还写着「只影响这一个工具」（那正是我们
 * 花整晚修掉的缺陷），而 client.js 内联表已经改成「两个工具都不可见」。
 * 28a 只比 gates.code.* 这 36 个键，所以 83 个键里这一处自由漂移、断言没红。
 *
 * 这就是"样例绕开了唯一会破的形状"：断言写了，但范围划小了。
 * 下面这条把范围扩到全部键。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('35a. locale/*.json 与内联表的全部键必须一致（双向），且每个值相等', () => {
  for (const [lang, json] of [['zh', ZH], ['en', EN]]) {
    const inline = CLIENT_DICTS[lang];
    assert.ok(inline !== undefined && typeof inline === 'object', `内联 ${lang} 表必须存在`);

    /* meta 单独处理（见 35b）：它是插件清单的 title/description，只该在 JSON 里。 */
    const jsonKeys = Object.keys(json).filter((key) => key !== 'meta').sort();
    const inlineKeys = Object.keys(inline).filter((key) => key !== 'meta').sort();

    const onlyJson = jsonKeys.filter((key) => !inlineKeys.includes(key));
    const onlyInline = inlineKeys.filter((key) => !jsonKeys.includes(key));
    assert.deepEqual(onlyJson, [],
      `[${lang}] 这些键只在 locale/${lang}.json 里有、内联表没镜像：${onlyJson.join(', ')}`);
    assert.deepEqual(onlyInline, [],
      `[${lang}] 这些键只在内联表里有、locale/${lang}.json 没有：${onlyInline.join(', ')}`);
    assert.deepEqual(inlineKeys, jsonKeys, `[${lang}] 键集合必须完全一致`);

    /* 值逐字相等 —— 键一样但文案不同是更隐蔽的漂移：
     * 页面显示旧话、断言拿新话，两边都"绿"。switch.hint 就栽在这里。 */
    const drifted = jsonKeys.filter((key) => inline[key] !== json[key]);
    assert.deepEqual(drifted, [],
      `[${lang}] 这些键两边文案不一致：${drifted.map((key) => `${key}（JSON=${JSON.stringify(json[key])} 内联=${JSON.stringify(inline[key])}）`).join(' | ')}`);
  }
});

test('35b. meta 是插件清单，只该在 locale 里（内联表不需要它），且两份都在', () => {
  /* 边界说明：locale/*.json 的 meta.title / meta.description 是宿主插件清单读的展示信息，
   * 页面渲染用不到（页面上显示的是 page.title），所以内联表不镜像它 —— 这是**有意的例外**，
   * 不是漏镜像。所以 35a 把它排除在键集合比较之外，这里单独钉住它必须存在且非空。 */
  for (const [lang, json] of [['zh', ZH], ['en', EN]]) {
    assert.equal(typeof json.meta, 'object', `locale/${lang}.json 必须有 meta`);
    assert.equal(typeof json.meta.title, 'string', `${lang} meta.title 必须是字符串`);
    assert.equal(typeof json.meta.description, 'string', `${lang} meta.description 必须是字符串`);
    assert.ok(json.meta.title.length > 0 && json.meta.description.length > 0, `${lang} meta 不许为空`);
    assert.equal(CLIENT_DICTS[lang].meta, undefined, '内联表**不该**有 meta（它是插件清单，不是页面文案）');
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 36. 会议账本四态 / 门禁覆盖三分母 / 声明警告（P3-4）
 *
 * 这一组只有一句中心思想：**`unreadable` 与 `none` 绝不许长得一样。**
 * 36a 是它的执行版本 —— 断言两者视图**深度不等**，而不是断言"文案不同"。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('36a. 四态：none 与 unreadable 必须结构可分（红线在本层的执行版本）', () => {
  const none = P.meetingView({ state: 'none', readable: true, reason: null, meeting: null }, t);
  const unreadable = P.meetingView({ state: 'unreadable', readable: false, reason: 'no-parent-block' }, t);

  assert.equal(none.state, 'none');
  assert.equal(unreadable.state, 'unreadable');
  assert.equal(none.readable, true, '`none` 是**结论**：板上没有围栏，这件事读得出来');
  assert.equal(unreadable.readable, false);

  /* 结构差异 ①：`unreadable` 必须带成因，`none` 不许带。 */
  assert.equal(none.reason, null);
  assert.equal(unreadable.reason, 'no-parent-block');
  /* 结构差异 ②：语气色不同。 */
  assert.equal(none.tone, 'plain');
  assert.equal(unreadable.tone, 'warn');
  /* 结构差异 ③（总）：两者不许相等 —— 这条就是红线本身。 */
  assert.notDeepEqual(none, unreadable);
  assert.notEqual(none.headline, unreadable.headline);

  /* 装饰之外的差异：`tone` / class / 颜色都是装饰，`meetingCardText` 里**一个都不带**，
   * 所以这条比的是纯正文。剥完装饰仍然不同，才叫"结构可分"。 */
  assert.notEqual(
    P.meetingCardText(none, t),
    P.meetingCardText(unreadable, t),
    '剥掉装饰后仍必须不同 —— 只差颜色或 CSS class 不算可分',
  );
});

test('36b. 四态各给一份：每态只出自己那句，另三句都不许出现', () => {
  const cases = [
    { state: 'none', readable: true },
    { state: 'ok', readable: true, meeting: { id: 'm1', preset: 'lite@1', status: 'running', stages: [] } },
    { state: 'unreadable', readable: false, reason: 'unclosed-block' },
    { state: 'unavailable', readable: false, reason: 'agentTeams' },
  ];
  /* 12 条排除断言（4 态 × 另外 3 态），逐条对**卡上印出来的正文**做 `doesNotMatch`。
   * 只断言"自己那句出现了"是弱断言：一个把四态文案**全渲染**出来的实现也能通过。
   * 也不用"输出长度变了"这种间接信号 —— 它分不清"少了一句"和"换了一句"。 */
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const slot of cases) {
    const view = P.meetingView(slot, t);
    const text = P.meetingCardText(view, t);
    assert.equal(view.state, slot.state);

    /* 该出现的：自己那句必须出现。 */
    assert.match(text, new RegExp(escapeRe(view.headline)), `${slot.state} 自己那句必须出现在卡上`);

    /* 另外三态：一句都不许出现。 */
    for (const other of P.MEETING_STATES) {
      if (other === slot.state) continue;
      assert.doesNotMatch(
        text,
        new RegExp(escapeRe(t(P.MEETING_HEADLINE[other]))),
        `${slot.state} 的卡上不许出现 ${other} 的文案`,
      );
    }
  }
});

test('36c. 认不出来的 state 一律落 unavailable —— 绝不许当 none', () => {
  for (const bad of [undefined, null, '', 'bogus', 'OK', 'ok ']) {
    const view = P.meetingView({ state: bad }, t);
    assert.equal(view.state, 'unavailable', `state=${JSON.stringify(bad)} 必须落到 unavailable`);
    assert.equal(view.readable, false);
    assert.notEqual(view.headline, t('meeting.state.none'), '认不出来绝不许渲染成「确实没有」');
    assert.equal(view.known, false);
  }
  assert.equal(P.meetingView(undefined, t).state, 'unavailable', '整块 ledger 没给也一样');
  assert.equal(P.meetingView(null, t).readable, false);
});

test('36d. ok：阶段行逐条铺出来，读不出 stageId 的那条也上屏（不许静默丢）', () => {
  const view = P.meetingView({
    state: 'ok',
    readable: true,
    meeting: {
      id: 'm-1',
      preset: 'lite@1',
      status: 'running',
      stages: [
        { stageId: 'challenge', attempt: 1, status: 'done', produced: ['questions'] },
        { attempt: 1, status: 'done' },
      ],
    },
  }, t);

  assert.equal(view.rows.length, 2, '两条都要上屏 —— 丢掉那条等于把"读到了但认不出"渲染成零条');
  assert.equal(view.rows[0].named, true);
  assert.deepEqual(view.rows[0].produced, ['questions']);
  assert.equal(view.rows[1].named, false);
  assert.equal(view.rows[1].text, t('meeting.stageUnknown'), '认不出的那条要有明确占位，不是空白');
  assert.equal(view.meta.length, 3, 'id / 档位 / 状态 三个都要给');

  /* A-② 列头：四个列名必须真的进正文。上一版投影不带列头（组件自己印），
   * 于是"投影 ≠ 卡片"的第一个缺口就在这里。 */
  const text = P.meetingCardText(view, t);
  for (const key of ['meeting.col.stage', 'meeting.col.attempt', 'meeting.col.status', 'meeting.col.produced']) {
    assert.ok(text.includes(t(key)), `列头「${t(key)}」没进正文（A-②）`);
  }

  /* A-④ 空产物：必须印 `noProduced`，不许印空串。第二行正好没有 produced。 */
  assert.ok(text.includes(t('meeting.noProduced')), '空产物必须印「未申报产物」（A-④），不许印空串');
});

test('36e. shadow：两个分母必须并排、且是两个不同的数（合并就红）', () => {
  const view = P.shadowView({ status: 'ok', judgedTasks: 3, withInput: 0, meetingTasks: 5 }, t);

  assert.equal(view.blind, false);
  assert.deepEqual(view.stats.map((stat) => stat.value), ['3', '0', '5'], '三个数各占一格，顺序固定');
  assert.equal(new Set(view.stats.map((stat) => stat.key)).size, 3, '三个不同的键');
  assert.notEqual(view.stats[0].label, view.stats[1].label, '「进了判定」与「真拿到输入」必须是两个标签');
  /* 合成一个的写法（只报 judgedTasks）会让这条红：3 与 0 同时在场的断言。 */
  const values = view.stats.map((stat) => stat.value);
  assert.ok(values.includes('3') && values.includes('0'));
});

test('36f. shadow：读不出来时一个数字都不给；零条 / 没进判定时照给', () => {
  const blind = P.shadowView({ status: 'unavailable', reason: 'tasks', judgedTasks: 0, withInput: 0, meetingTasks: 0 }, t);
  assert.equal(blind.blind, true);
  assert.deepEqual(blind.stats, [], '读不出来时连 0 都不许出现');
  assert.equal(blind.reason, t('shadow.reason.tasks'));

  const zero = P.shadowView({ status: 'unavailable', reason: 'no-tasks', judgedTasks: 0, withInput: 0, meetingTasks: 0 }, t);
  assert.equal(zero.blind, false, '「板上零条」是测量结果，不是读不出来');
  assert.equal(zero.stats.length, 3, '零条也要给数字');
  assert.equal(zero.reason, t('shadow.reason.noTasks'));

  const noneJudged = P.shadowView({ status: 'unavailable', reason: 'no-judged', judgedTasks: 0, withInput: 0, meetingTasks: 2 }, t);
  assert.equal(noneJudged.blind, false, '「有条目但一条都没进判定」同样是测量结果');
  assert.equal(noneJudged.reason, t('shadow.reason.noJudged'));

  assert.equal(P.shadowView(null, t), null, '宿主没给 shadow → 整块不渲染，不是渲染成空块');
});

test('36g. declarationWarnings 挂在每条任务上；一条都没有时返回 null（整块不渲染）', () => {
  assert.equal(P.declarationWarningsOf([]), null, '零条 → null，不许是空数组');
  assert.equal(P.declarationWarningsOf([{ id: 'T1' }]), null, '任务上没这个键 → 还是 null');
  assert.equal(P.declarationWarningsOf([{ id: 'T1', declarationWarnings: [] }]), null);
  assert.equal(P.declarationWarningsOf(undefined), null, 'tasks 不是数组 → null（读不出来由 BoardCard 去说）');

  const list = P.declarationWarningsOf([
    { id: 'T1', declarationWarnings: [{ code: 'E_DECLARATION_MISSING', message: '没写块' }] },
    { id: 'T2' },
    { id: 'T3', declarationWarnings: [{ code: 'E_DECLARATION_UNKNOWN_KEY', message: '错键' }] },
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((item) => item.taskId), ['T1', 'T3'], '每条都要能指到是哪张任务');
});

test('36i. 投影完备性（只验投影自身，不验组件）：view 上每个"卡上会印"的字段都必须出现在正文里（防两处漂移）', () => {
  const view = P.meetingView({
    state: 'ok',
    readable: true,
    reason: null,
    meeting: {
      id: 'm-9',
      preset: 'standard@1',
      status: 'paused',
      stages: [{ stageId: 'design', attempt: 2, status: 'failed', produced: ['decisions', 'reasoning'] }],
    },
  }, t);
  const text = P.meetingCardText(view, t);

  assert.ok(view.meta.length > 0 && view.rows.length > 0, '夹具必须同时有 meta 与阶段行');
  for (const item of view.meta) {
    assert.ok(text.includes(item.label), `meta「${item.label}」的标签没进正文`);
    assert.ok(text.includes(item.value), `meta「${item.label}」的值没进正文`);
  }
  for (const row of view.rows) {
    assert.ok(text.includes(row.text), '阶段名没进正文');
    /* 投影印的是**徽章译文**（A-③：组件不再自己算一遍），所以这里断言译文。
     * 上一版断言的是 raw row.status —— 那是**编码了旧投影行为**的断言；改造后该改的是它。 */
    const badgeText = P.statusBadge(row.status, t).text;
    assert.ok(text.includes(badgeText), '阶段状态（徽章译文）没进正文');
    for (const name of row.produced) assert.ok(text.includes(name), `产物 ${name} 没进正文`);
  }

  /* 读不出来那两态的全部信息就在 reason / message 这两行上，
   * 它们必须能被印出来 —— 否则"读不出来"等于没解释。 */
  const broken = P.meetingView({ state: 'unreadable', readable: false, reason: 'unclosed-block', message: '这块没闭合' }, t);
  const brokenText = P.meetingCardText(broken, t);
  assert.ok(brokenText.includes('unclosed-block'), '成因必须进正文');
  assert.ok(brokenText.includes('这块没闭合'), '原文说明（如解析异常）也要进正文');
});

test('36h. 本轮新文案两套齐全：中英都不许回落成 key 本身', () => {
  const heads = Object.keys(P.MEETING_HEADLINE).map((state) => P.MEETING_HEADLINE[state]);
  const extras = [
    'meeting.title', 'meeting.sub', 'meeting.cause',
    'meeting.meta.id', 'meeting.meta.preset', 'meeting.meta.status',
    'meeting.col.stage', 'meeting.col.attempt', 'meeting.col.status', 'meeting.col.produced',
    'meeting.stageUnknown', 'meeting.noProduced',
    'shadow.title', 'shadow.sub', 'shadow.judged', 'shadow.withInput', 'shadow.meeting',
    'shadow.judgedHint', 'shadow.withInputHint', 'shadow.meetingHint',
    'shadow.reason.tasks', 'shadow.reason.noTasks', 'shadow.reason.noJudged',
    'meeting.state.noCriterion', 'meeting.state.unknownState',
    'declaration.title',
  ];
  for (const [lang, dict] of [['zh', CLIENT_DICTS.zh], ['en', CLIENT_DICTS.en]]) {
    for (const key of [...heads, ...extras]) {
      assert.equal(typeof dict[key], 'string', `[${lang}] 缺文案 ${key}`);
      assert.notEqual(dict[key].trim(), '', `[${lang}] ${key} 不许为空`);
    }
  }
});
test('P3-9 C-1. 页面读的是 `payload.roleLedger`，不再读顶层的 `payload.ledger`', () => {
  /* 这一条钉的是**页面侧不许回退**。host 那边已经把顶层改名；如果 client 还读
   * `value.ledger`，它拿到 `undefined` —— 而 `LedgerCard` 会把 undefined 渲染成
   * "无历史"，页面看起来一切正常。那正是本项目最怕的那种静默失效。
   *
   * 本文件是**源码级**测试（`SOURCE` 是 client.js 的全文），所以这里也按源码钉：
   * 判据是"客户端里存不存在对顶层旧名字的读取"。 */
  const reads = [...SOURCE.matchAll(/value\.(ledger|roleLedger)\b/g)].map((m) => m[1]);

  assert.equal(reads.includes('roleLedger'), true, 'client.js 必须读 `value.roleLedger`（角色台账的新名字）');
  assert.equal(reads.includes('ledger'), false, 'client.js 不许再读 `value.ledger` —— 那个键已经不存在了');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 37. 判据的单一来源（C）—— **让两个来源吵架**
 *
 * 正常 payload 永远自洽（宿主 `ledgerSlot` 保证 `state` 与 `readable` 一致），
 * 所以任何"端到端跑一遍"都测不出渲染层私藏了一份判据副本。
 * 唯一抓法：喂一份**矛盾 payload**，看渲染层跟谁走。
 * 这三条在改造前都是红的 —— 那时 `readable` 由本地 `state === 'none' || state === 'ok'` 推出来，
 * `payload.readable` 在渲染层是装饰。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('37a. 矛盾 payload：state=ok 但 readable=false → 必须渲染成**不可读**', () => {
  const view = P.meetingView({ state: 'ok', readable: false, meeting: { id: 'm1', stages: [] } }, t);

  assert.equal(view.readable, false, '`payload.readable` 必须在渲染层说了算，不许被本地推导覆盖');
  assert.equal(view.state, 'unreadable', '不可读就必须渲染成不可读那一态，不能仍叫 ok');
  assert.equal(view.headline, t('meeting.state.unreadable'));
  assert.doesNotMatch(P.meetingCardText(view, t), new RegExp(t('meeting.state.ok')), '卡上不许出现"可读"那句');
});

test('37b. 矛盾 payload：state=unreadable 但 readable=true → 必须渲染成**可读**', () => {
  const view = P.meetingView({ state: 'unreadable', readable: true, reason: 'x' }, t);

  assert.equal(view.readable, true, '同理：readable 为准');
  assert.equal(view.state, 'ok', '可读就必须渲染成可读那一态');
  assert.equal(view.headline, t('meeting.state.ok'));
  assert.doesNotMatch(P.meetingCardText(view, t), new RegExp(t('meeting.state.unreadable')), '卡上不许出现"读不出来"那句');
});

test('37c. 没给判据（readable 不是布尔）→ 落 unavailable 并说明"没给判据"，不许猜', () => {
  for (const bad of [undefined, null, 'true', 1, 0]) {
    const view = P.meetingView({ state: 'ok', readable: bad }, t);
    assert.equal(view.readable, false, `readable=${JSON.stringify(bad)} 不是布尔，不许采信`);
    assert.equal(view.criterionMissing, true, '要能分辨"没给判据"与"判了不可用"');
    assert.equal(view.state, 'unavailable');
    assert.equal(view.headline, t('meeting.state.noCriterion'), '文案必须说"这一块没给判据"');
    assert.notEqual(view.headline, t('meeting.state.none'), '绝不许落成"确实没有"');
    assert.notEqual(view.headline, t('meeting.state.unavailable'), '也不许说成"门禁整体起不来"');
  }
});

/** 取出某个具名函数的函数体（从第一个左花括号到配平的右花括号）。 */
function functionBody(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `源码里找不到 ${header}`);
  /* 必须跳过**参数表**里的花括号：`function X({ a, b }) {` 的第一个 `{` 是解构，
   * 从那里配对会得到一个只有参数的"函数体"，扫描就永远扫不到真正的正文。
   * 所以先找到参数表的 `)`，再往右找函数体的 `{`。 */
  const closeParen = source.indexOf(')', start);
  assert.notEqual(closeParen, -1, `${header} 的参数表没有右括号`);
  const open = source.indexOf('{', closeParen);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${header} 的花括号没有配平`);
}

test('37d. 结构性守卫：MeetingCard 写不出自己拼的正文（源码扫描，与 codes.test 6a 同一套路）', () => {
  const body = functionBody(SOURCE, 'function MeetingCard');

  /* 这四个字符串正是 A 项里"组件自己拼"的那四处。它们一旦重新出现在组件里，
   * 「投影 ≠ 卡片」就又变成可能 —— 而那种漂移**没有任何测试抓得住**：
   * 卡片在本 harness 里取不到（createElement 返回 null）。
   *
   * 所以守卫是**结构性**的：让组件写不出那段正文。
   * 这不是"投影与组件是否一致"的比较测试 —— 那种测试只在夹具覆盖到的输入上成立，
   * 而构造保证在所有输入上成立；这里查的是**组件的正文来源**。 */
  const forbidden = [
    "t('meeting.cause')",
    "t('meeting.col.",
    "t('meeting.noProduced')",
    'statusBadge(',
  ];
  for (const needle of forbidden) {
    assert.equal(body.includes(needle), false,
      `MeetingCard 不许自己拼正文（发现 ${needle}）—— 正文只能来自 meetingCardLines`);
  }
  assert.ok(body.includes('meetingCardLines'), 'MeetingCard 的正文必须来自投影');

  /* 卡头的 title/sub 允许走 t()：那是卡头，不是投影负责的正文。 */
  assert.ok(body.includes("t('meeting.title')") && body.includes("t('meeting.sub')"),
    '卡头仍应由组件给（它不属于投影负责的正文）');
});

test('37e. `readable` **整个缺失**（不是"不是布尔"）→ 同样落保守侧：unavailable + 没给判据', () => {
  /* 复核者的原话：**"缺失"这件事属于"没验"，不是"验过没问题"。**
   * `37c` 钉的是"给了但**不是布尔**"；`{state:'ok'}` 完全没有这个键是**另一种形状** ——
   * 代码走同一个分支（`typeof slot.readable === 'boolean'` 为假），但形状不同就该有自己的钉。
   * 而**手写 payload 最可能出现的恰恰是这种**（人不会主动写 `readable: undefined`）。
   *
   * 为什么值得单钉：如果以后有人把判据简化成 `slot.readable !== false`
   * （一种看起来非常自然、而且更短的写法），缺失会从"保守 = 不可读"翻成"可读"——
   * **方向翻成危险，而 37c 那组一例都不会红**（它给的要么是非布尔真值、要么是非布尔假值）。
   * 这就是"缺失 fixture 不存在"真正的代价。 */
  const slot = { state: 'ok' };
  assert.equal(Object.hasOwn(slot, 'readable'), false, '夹具必须真的**没有**这个键');

  const view = P.meetingView(slot, t);
  assert.equal(view.readable, false, '缺失必须落**保守侧**（不可读），不许默认成可读');
  assert.equal(view.criterionMissing, true, '要能分辨"没给判据"与"判了不可用"');
  assert.equal(view.state, 'unavailable');
  assert.equal(view.headline, t('meeting.state.noCriterion'), '要明确说"这一块没给判据"');
  assert.notEqual(view.headline, t('meeting.state.none'), '绝不许落成"确实没有"');

  /* 反方向的第二道门：**给了 `meeting` 也不许把缺失的判据补成"可读"**。
   * 上面那条挡 `readable !== false` 的简化；这条挡"有数据就当成读得出来"的简化。 */
  const withMeeting = P.meetingView({ state: 'ok', meeting: { id: 'm1', stages: [] } }, t);
  assert.equal(withMeeting.readable, false, '有 meeting 也不许把缺失的判据补成可读');
  assert.equal(withMeeting.state, 'unavailable');
  assert.equal(withMeeting.criterionMissing, true);
});

test('P3-14 C-2. 关掉时页面说"已关闭"，**不**说"数据源不可用"', () => {
  /* 这一条钉的是**两处消费点都得改**：
   *   - `:3345` 的回落（缺 `dataSource` 时不许回落成 `unavailable`）；
   *   - `sourceDetail` 的兜底网（`kind` 不认识时默认说"不可用"）。
   *
   * 只改前者的话，`disabled` 落进后者那个 `if`，页面照样写"不可用" ——
   * 看起来修好了、实际没修。所以判据直接看源码两处都在位。 */
  assert.match(SOURCE, /source\.disabledHint/, '必须有一条"已关闭"的文案键');
  assert.match(SOURCE, /'source\.disabledHint': '[^']*已关闭/, '中文文案要写清「已关闭」，不能只写「不可用」');

  /* ① 兜底网：`disabled` 必须有自己的分支，且**排在** unavailable 那条前面。 */
  const detailAt = SOURCE.indexOf('function sourceDetail');
  const disabledAt = SOURCE.indexOf("if (source.kind === 'disabled')", detailAt);
  const unavailableAt = SOURCE.indexOf("source.kind !== 'agentTeams'", detailAt);
  assert.equal(disabledAt > 0, true, 'sourceDetail 里必须有 disabled 分支');
  assert.equal(disabledAt < unavailableAt, true, 'disabled 分支必须排在 unavailable 兜底之前，否则永远走不到它');

  /* ② 回落处：缺 `dataSource` 时按 `gates.status === 'disabled'` 分流，不许一律 unavailable。 */
  assert.match(
    SOURCE,
    /switchOff \? \{ kind: 'disabled' \} : \{ kind: 'unavailable' \}/,
    '缺 dataSource 时要按"是不是关掉了"分流，不许一律回落成 unavailable',
  );
  assert.doesNotMatch(
    SOURCE,
    /value\.dataSource !== null && typeof value\.dataSource === 'object'\s*\?\s*value\.dataSource\s*:\s*\{ kind: 'unavailable' \}/,
    '原来那行"一律回落 unavailable"必须已被替换掉',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P3-12：进度行「已完成 N/M，还差 a、b」
 *
 * 判据全在 payload 上（`Object.hasOwn(slot,'stagePlan')`）：宿主在"预设读不出"
 * 与"账本与预设不一致"两种情况下都会让这个字段缺席，所以渲染层**不需要、也不许**
 * 自己算一遍剩余 —— 那会是第二份判据。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('P3-12 C-3. ok + stagePlan 在 → 卡片印出「已完成 2/4，还差 design、verify」', () => {
  const slot = {
    state: 'ok',
    readable: true,
    reason: null,
    meeting: { id: 'm-1', preset: 'lite@1', status: 'running', stages: [] },
    stagePlan: { preset: 'lite@1', total: 4, done: 2, remaining: ['design', 'verify'] },
  };
  const view = P.meetingView(slot, t);
  const text = P.meetingCardText(view, t);

  assert.equal(view.stagePlan.total, 4);
  assert.deepEqual(view.stagePlan.remaining, ['design', 'verify']);
  assert.match(text, /已完成 2\/4/, '进度数字必须印出来');
  assert.match(text, /design/, '还差哪几个必须印出来');
  assert.match(text, /verify/);
});

test('P3-12 C-4. stagePlan **缺席** → 卡片上没有进度行（不是 0/0）', () => {
  /* 两种缺席成因都用同一形状喂：宿主让它缺席，渲染层就不许自己编。 */
  for (const label of ['预设读不出', '账本与预设不一致']) {
    const slot = {
      state: 'ok',
      readable: true,
      reason: null,
      meeting: { id: 'm-1', preset: 'lite@1', status: 'running', stages: [] },
    };
    const view = P.meetingView(slot, t);
    const text = P.meetingCardText(view, t);

    assert.equal(Object.hasOwn(view, 'stagePlan'), false, `${label}：view 上不许有 stagePlan`);
    assert.doesNotMatch(text, /已完成\s*\d+\/\d+/, `${label}：卡片上不许出现进度行 —— 显示 0/0 会把"没数过"说成"数过、是空的"`);
  }
});

test('P3-12 C-5. 另外三态即使 payload 里**带了** stagePlan 也不印（它连阶段表都没有）', () => {
  /* 防御性：宿主将来若误在三态上挂了 stagePlan，渲染层也不许印。
   * 没有这一条，"只在 ok 里印"这件事就没有牙 —— 三态本来就不会带，
   * 于是那段 `if (state === 'ok')` 删掉也无人发现。 */
  for (const state of ['none', 'unreadable', 'unavailable']) {
    const view = P.meetingView({
      state,
      readable: state === 'none',
      reason: 'x',
      stagePlan: { preset: 'lite@1', total: 4, done: 2, remaining: ['design'] },
    }, t);
    const text = P.meetingCardText(view, t);
    assert.equal(Object.hasOwn(view, 'stagePlan'), false, `${state} 态不许有 stagePlan`);
    assert.doesNotMatch(text, /已完成/, `${state} 态不许出现进度行`);
  }
});
