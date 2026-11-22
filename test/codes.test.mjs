/**
 * codes.test.mjs — `src/codes.mjs` 的机械校验。
 *
 * 这张表是本项目的"唯一真相"之一，所以它自己必须被钉住。
 * 每一组断言都在防一种**已经真实发生过**的病，不是为了凑覆盖率：
 *
 *   ① 码表漏码 —— `delivery.mjs` 里 add() 了、码表里没有 → 页面上显示"未知门禁"
 *   ② 文案缺一半 —— zh 有 en 没有（或反过来）→ 英文用户看到码名
 *   ③ "判不了什么" 被敷衍 —— 这个字段一空，读的人就会以为门禁全判了
 *   ④ 批分布漂移 —— 上线节奏是"每批限期达标否则整批回滚"，批号错了就等于期限错了
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import {
  MEETING_CODES,
  MEETING_CODE_NAMES,
  MEETING_BLOCKER_CODES,
  MEETING_WARNING_CODES,
  MEETING_CODES_BY_BATCH,
  MEETING_CODE_BATCHES,
  MEETING_CODE_SEVERITIES,
  meetingCodeOf,
  isMeetingCode,
  meetingCodeText,
} from '../src/codes.mjs';

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. 形状：每条码的每个字段都要真的能用
 * ═══════════════════════════════════════════════════════════════════════════ */

test('1a. 码名唯一、格式统一、且按 batch → code 稳定排序', () => {
  /* 唯一性：重名会让 `MEETING_CODES_BY_BATCH` 与查表分叉，
   * 而查表是 `Map`，后写的那条会静默覆盖先写的 —— 一个码的文案会凭空消失。 */
  assert.equal(new Set(MEETING_CODE_NAMES).size, MEETING_CODE_NAMES.length, '码名必须唯一');

  for (const name of MEETING_CODE_NAMES) {
    assert.match(name, /^E_[A-Z0-9_]+$/, `码名格式不对：${name}`);
  }

  /* 排序稳定：生成的文案文件才稳定，`git diff` 只在真加码时才动。
   * 如果不钉住，随手往中间插一条会让整段文案文件的 diff 变成噪声。 */
  for (let i = 1; i < MEETING_CODES.length; i += 1) {
    const prev = MEETING_CODES[i - 1];
    const cur = MEETING_CODES[i];
    const ordered = prev.batch < cur.batch || (prev.batch === cur.batch && prev.code <= cur.code);
    assert.ok(ordered, `顺序必须 batch 升序、同批内 code 升序；${prev.code} 排在了 ${cur.code} 之前`);
  }
});

test('1b. severity 与 batch 都是白名单值，且 MEETING_CODE_BATCHES 覆盖所有用到的批号', () => {
  for (const entry of MEETING_CODES) {
    assert.ok(MEETING_CODE_SEVERITIES.includes(entry.severity), `${entry.code} 的 severity 非法：${entry.severity}`);
    assert.ok([1, 2, 3].includes(entry.batch), `${entry.code} 的 batch 非法：${entry.batch}`);
    /* 批号必须能在 MEETING_CODE_BATCHES 里查到一句话 —— 否则台账上这一批没有名字，
     * "批 2 达标了吗"这个问题就没法问。 */
    assert.equal(typeof MEETING_CODE_BATCHES[entry.batch], 'string');
    assert.notEqual(MEETING_CODE_BATCHES[entry.batch].trim(), '');
  }
});

test('1c. 表是冻结的：任何一层都不许在下游偷偷改这条码', () => {
  assert.ok(Object.isFrozen(MEETING_CODES), 'MEETING_CODES 必须冻结');
  for (const entry of MEETING_CODES) {
    assert.ok(Object.isFrozen(entry), `${entry.code} 必须冻结`);
  }
  assert.ok(Object.isFrozen(MEETING_CODE_NAMES));
  assert.ok(Object.isFrozen(MEETING_BLOCKER_CODES));
  assert.ok(Object.isFrozen(MEETING_WARNING_CODES));
  assert.ok(Object.isFrozen(MEETING_CODES_BY_BATCH));
  assert.ok(Object.isFrozen(MEETING_CODES_BY_BATCH[1]));

  /* 真试一次写：冻结在非严格模式下是静默失败，`assert.throws` 会误判成"没抛"。
   * 这个文件是 ESM（自动严格模式），所以这里必定抛。 */
  assert.throws(() => {
    MEETING_CODES[0].code = 'E_HACKED';
  }, '改写必须抛错');
  assert.notEqual(MEETING_CODES[0].code, 'E_HACKED');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. 文案：中英必须成对，且都是**人话**
 * ═══════════════════════════════════════════════════════════════════════════ */

test('2a. 每条码都有 zh 与 en，两边都不许只有码名兜底', () => {
  for (const entry of MEETING_CODES) {
    assert.equal(typeof entry.zh, 'string');
    assert.equal(typeof entry.en, 'string');
    /* 长度下限不是凑字数：一条只说"参数不合法"的文案，读的人还得去翻源码。
     * 本项目的要求是**文案里就写着下一步该做什么**。 */
    assert.ok(entry.zh.length >= 30, `${entry.code} 的 zh 太短（${entry.zh.length}），大概率没写清下一步`);
    assert.ok(entry.en.length >= 60, `${entry.code} 的 en 太短（${entry.en.length}）`);
    /* 不许拿码名本身当文案 —— 那等于没写。 */
    assert.notEqual(entry.zh, entry.code);
    assert.notEqual(entry.en, entry.code);
    assert.equal(entry.zh.includes(entry.code), false, `${entry.code} 的 zh 文案里不该出现码名本身`);
  }
});

test('2b. 中文文案里必须有中文，英文文案里不许有中文（防止一边是另一边的拷贝）', () => {
  const cjk = /[\u4e00-\u9fff]/;
  for (const entry of MEETING_CODES) {
    assert.ok(cjk.test(entry.zh), `${entry.code} 的 zh 里没有中文，八成是把 en 抄过来了`);
    assert.equal(cjk.test(entry.en), false, `${entry.code} 的 en 里还有中文，翻译没做完`);
  }
});

test('2c. 文案里不许出现"报平安"的说法（空 ≠ 不可用那条红线的文案面）', () => {
  /* 这是本项目最反复的一条：一条门禁的文案如果读起来像"没事"，
   * 那么它在页面上的效果就是让人放心地往下走。
   * 这里只拦最直白的几种；语义层面的"报平安"只能靠人 review。 */
  const forbiddenZh = ['一切正常', '没有问题', '无需处理', '可以放心'];
  const forbiddenEn = ['all clear', 'no issues', 'nothing to worry'];
  for (const entry of MEETING_CODES) {
    for (const bad of forbiddenZh) {
      assert.equal(entry.zh.includes(bad), false, `${entry.code} 的 zh 出现了报平安的说法「${bad}」`);
    }
    for (const bad of forbiddenEn) {
      assert.equal(entry.en.toLowerCase().includes(bad), false, `${entry.code} 的 en 出现了「${bad}」`);
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. `cannotJudge`：每条码都必须承认自己判不了什么
 * ═══════════════════════════════════════════════════════════════════════════ */

test('3a. 每条码的 cannotJudge 都非空、且明显在说"判不了"', () => {
  for (const entry of MEETING_CODES) {
    const text = entry.cannotJudge;
    assert.equal(typeof text, 'string', `${entry.code} 缺 cannotJudge`);
    assert.ok(text.length >= 15, `${entry.code} 的 cannotJudge 太短（${text.length}）：敷衍等于没写`);
    /* 必须真的在承认边界。用"判不了"或"只判"开头都算 —— 两种写法都是在划界。 */
    assert.match(
      text,
      /判不了|只判|只记录|只数|只看|只回答|只知道|只说明|只判有没有写|不由|两种都/,
      `${entry.code} 的 cannotJudge 没有划出边界：${text}`,
    );
  }
});

test('3b. cannotJudge 不许三条码共用同一句话（共用等于批量敷衍）', () => {
  const seen = new Map();
  for (const entry of MEETING_CODES) {
    const key = entry.cannotJudge.trim();
    if (seen.has(key)) {
      assert.fail(`${seen.get(key)} 与 ${entry.code} 用了同一句 cannotJudge：「${key}」`);
    }
    seen.set(key, entry.code);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. 派生视图与 §7 的账目
 * ═══════════════════════════════════════════════════════════════════════════ */

test('4a. 批分布必须与方案 §7 记账一致（11 / 13 / 11）', () => {
  /* 数字是**故意写死**的。方案 §7 原文说"新增 23 个、批 1=8 / 批 2=8 / 批 3=7"，
   * 而实测对不上，原因记在 codes.mjs 头部：
   *   - §7 的 23 里含 E_QUESTIONS_UNANSWERED，它早就在 delivery.mjs 里 → 实际新增 22
   *   - §2 用了 E_NO_CHALLENGE / E_NO_SIGNOFF，§7 从未定义 → 补 2 条
   *   - 账本改存任务树之后多出 E_LEDGER_PARTIAL / E_LEDGER_WRITE_FAILED → 再补 2 条
   *   - 清掉"一码两义"又多出 7 条（一条码只管一件事）→ 再补 7 条
   *   - 同档换档原来 `ok:false` 却 `errors:[]`（页面渲染不出来）→ 补 E_UPGRADE_SAME_TIER
   * 于是批 1 = 11、批 2 = 13、批 3 = 11，总数 = 35（34 新增 + 1 复用）。
   *
   * 这条断言的作用：任何人要改这些数字，必须同时改这里和 codes.mjs 的头部账目，
   * 也就是**被迫把出入说清楚**，而不是悄悄改一个数。 */
  assert.equal(MEETING_CODES_BY_BATCH[1].length, 11, '批 1 应是 11 条（§7 的 8 条中 7 条新增 + 2 条补定义 + 1 条复用 + 1 条拆冒名）');
  assert.equal(MEETING_CODES_BY_BATCH[2].length, 13, '批 2 应是 13 条（§7 的 8 条 + 账本 2 条 + 拆冒名 2 条 + 同档换档 1 条）');
  assert.equal(MEETING_CODES_BY_BATCH[3].length, 11, '批 3 应是 11 条（§7 的 7 条 + 冒名拆出来的 4 条）');
  assert.equal(MEETING_CODES.length, 35, '总码数应是 35（34 新增 + 1 复用）');

  /* 批 3 全是 warning、批 1/2 全是 blocker —— 方案 §7 的标题就是这么写的
   * （"批 3（7 个 warning）—— 出声但不拦"）。批号与严重度混了，
   * "每批限期达标否则整批回滚"这个机制就判不了。 */
  for (const code of MEETING_CODES_BY_BATCH[3]) {
    assert.ok(MEETING_WARNING_CODES.includes(code), `${code} 在批 3，必须是 warning`);
  }
  for (const code of [...MEETING_CODES_BY_BATCH[1], ...MEETING_CODES_BY_BATCH[2]]) {
    assert.ok(MEETING_BLOCKER_CODES.includes(code), `${code} 在批 1/2，必须是 blocker`);
  }
});

test('4b. blocker / warning 两个派生列表正好覆盖全表，且互不相交', () => {
  assert.equal(MEETING_BLOCKER_CODES.length + MEETING_WARNING_CODES.length, MEETING_CODES.length);
  const inter = MEETING_BLOCKER_CODES.filter((code) => MEETING_WARNING_CODES.includes(code));
  assert.deepEqual(inter, [], '同一条码不许既是 blocker 又是 warning');
  assert.equal(MEETING_BLOCKER_CODES.length, 24);
  assert.equal(MEETING_WARNING_CODES.length, 11);
});

test('4c. 方案 §2 表格里点名的码，必须在表里查得到', () => {
  /* 这条防的是"表格里承诺了一个门禁，实现里根本没这个码" ——
   * 七阶段表格是给人读的规格，读的人会照着它期待行为。 */
  const stageTableCodes = [
    'E_NO_CHALLENGE',
    'E_NO_KILL_SCENARIO',
    'E_NO_SIGNOFF',
    'E_QUESTIONS_UNANSWERED',
    'E_ARTIFACT_MISSING',
    'E_PRESET_STAGE_SKIPPED',
    'E_CLAIM_MULTIPLE',
    'E_CONFLICT_UNRULED',
    'E_BLIND_AGENT_REUSED',
    'E_RESUME_EXHAUSTED',
  ];
  for (const code of stageTableCodes) {
    assert.notEqual(meetingCodeOf(code), undefined, `§2/§5/§6 点名的 ${code} 不在码表里`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. 查询 API：查不到就是查不到，绝不兜底
 * ═══════════════════════════════════════════════════════════════════════════ */

test('5a. 未知码返回 undefined —— 不许拿码名或英文当兜底', () => {
  /* 兜底看着友好，实际是把"未知门禁"这个事实藏起来：
   * 页面上会显示一句通顺的外文，而没有人知道这条码是什么时候加进来的。
   * 本项目要的是"未知"必须可见。 */
  assert.equal(meetingCodeOf('E_NOT_A_REAL_CODE'), undefined);
  assert.equal(meetingCodeText('E_NOT_A_REAL_CODE', 'zh'), undefined);
  assert.equal(meetingCodeText('E_NOT_A_REAL_CODE', 'en'), undefined);
  assert.equal(isMeetingCode('E_NOT_A_REAL_CODE'), false);

  /* 非字符串一律 false / undefined，不许抛 —— 上游可能把 undefined 直接传进来。 */
  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.equal(meetingCodeOf(bad), undefined, `meetingCodeOf(${String(bad)}) 必须是 undefined`);
    assert.equal(isMeetingCode(bad), false);
    assert.equal(meetingCodeText(bad, 'zh'), undefined);
  }
});

test('5b. 查得到的码，文案与表里逐字相同', () => {
  for (const entry of MEETING_CODES) {
    assert.equal(isMeetingCode(entry.code), true);
    assert.equal(meetingCodeText(entry.code, 'zh'), entry.zh);
    assert.equal(meetingCodeText(entry.code, 'en'), entry.en);
    /* lang 只能是 'zh' / 'en'；非法值的当前行为是返回中文（`lang === 'en'` 不成立）。
     * 写出来是为了让这个"默认"变成有意的选择，而不是碰巧。 */
    assert.equal(meetingCodeText(entry.code, 'fr'), entry.zh);
    assert.equal(meetingCodeText(entry.code, undefined), entry.zh);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. 码表 ⊇ 实际发射集合（本组随会议模块落地而生效）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('6a. 会议模块源码里 add()/emit()/diag() 的每个码，都必须在码表里', async () => {
  /* 这一条防的是"发射了但没登记"：码被 add() 出去、码表里没有 →
   * 页面上显示成"未知门禁"，一句没有下一步的话。
   *
   * **为什么不留一个"会议模块还没落地所以先红"的断言**：
   * 一个长期红的测试会被当噪声忽略，而噪声是这种东西最大的敌人。
   * 所以这里分两步：
   *   ① 用一段**人造源码**证明扫描器真的有牙（不依赖任何真实文件，永远可跑）
   *   ② 对**已存在**的会议模块真扫一遍（文件还没落地时天然扫不到东西，
   *      但一旦 `preset.mjs` / `meeting.mjs` 出现，它立刻开始生效 —— 无需改测试）
   * 这样它现在就是绿的、也确实在干活，而不是一条等着被人想起的备注。 */
  const meetingSources = [
    '../src/meeting.mjs',
    '../src/preset.mjs',
    '../src/resume.mjs',
    '../src/agentpool.mjs',
    '../src/artifact.mjs',
    '../src/conflict.mjs',
    '../src/ledger.mjs',
  ];

  /**
   * 从一段源码里抽出所有被发射的码。
   *
   * **码名在这个仓库里有两种写法，两种都必须认**，否则扫描器会整块看不见一个模块：
   *
   *   1. 直接写字面量：`diag('E_X', msg)` —— `meeting.mjs` / `preset.mjs` / `resume.mjs` 的写法；
   *   2. 先定义同名常量再调用：`const E_X = 'E_X'; diag(E_X, msg)` —— `ledger.mjs` 的写法。
   *
   * 第二种是补上来的。起因（有据）：`ledger.mjs` 用的是 `diag(E_LEDGER_PARTIAL, …)`
   * （常量），而扫描器当时只认字面量 —— 于是那个文件里**每一处发射都扫不到**，
   * 它有没有登记全靠它自己写的 `19a`。这就是本项目抓到过两次的"绿着空转"，
   * 只不过这次是"扫到了文件、抽出了 0 个码"。所以：把它加进清单的同时必须放宽扫描器，
   * 两件事要么一起做，要么都不做。
   *
   * 只认**常量名与码名完全相同**的那种（`const E_X = 'E_X'`）：`const A = 'E_B'` 不是
   * "A 是码名"，而是别名，这里不做名字推导 —— 猜名字会把扫描器变成一个小解释器。
   *
   * 第三种写法（`import { E_X } from './codes.mjs'`）**不存在**，因为 `codes.mjs`
   * 不按码名导出常量，它导出的是表。硬 import 拿到的是 `undefined` ——
   * 那会发射一个没有名字的码，比扫不到更坏。这条理由写在 `ledger.mjs` 的注释里。
   */
  function emittedCodes(source) {
    /** 本文件里"常量名 === 码名"的那些名字。 */
    const names = new Set();
    for (const match of source.matchAll(/\bconst\s+(E_[A-Z0-9_]+)\s*=\s*'(E_[A-Z0-9_]+)'/g)) {
      if (match[1] === match[2]) names.add(match[1]);
    }

    const found = [];
    const pick = (raw) => {
      const quoted = /^'(E_[A-Z0-9_]+)'$/.exec(raw);
      if (quoted !== null) return quoted[1];
      return names.has(raw) ? raw : undefined;
    };

    for (const match of source.matchAll(/\b(?:add|emit|diag)\s*\(\s*('E_[A-Z0-9_]+'|[A-Za-z_$][\w$]*)/g)) {
      const code = pick(match[1]);
      if (code !== undefined) found.push(code);
    }
    for (const match of source.matchAll(/\bpush\s*\(\s*[A-Za-z_$][\w$.]*\s*,\s*('E_[A-Z0-9_]+'|[A-Za-z_$][\w$]*)/g)) {
      const code = pick(match[1]);
      if (code !== undefined) found.push(code);
    }
    return found;
  }

  /* ① 牙口自检：这段人造源码里两种码名写法、四种调用形式各一条，逐条都必须被抓到。
   *
   * 最后三条是**不许被抓**的反例，它们各自防一种"扫描器变成小解释器"的滑坡：
   *   - 函数名不是上面几个（`symbol`）→ 不算发射；
   *   - 第一参是普通变量 → 约定只认字面量与同名常量；
   *   - 常量名与码名不一致（`const A = 'E_B'`）→ 这是别名，不猜。 */
  const probe = [
    "add('E_NO_CHALLENGE', 'x');", // 写法 1：字面量 + add
    "emit('E_PRESET_NOT_FOUND', {});", // 写法 1：字面量 + emit
    "diag('E_PRESET_DOWNGRADE', 'msg');", // 写法 1：字面量 + diag（preset.mjs 的写法）
    "push(gateErrors, 'E_RESUME_EXHAUSTED', 'msg');", // 写法 1：码在第二参
    "const E_LEDGER_PARTIAL = 'E_LEDGER_PARTIAL';", // 写法 2 的定义行
    "diag(E_LEDGER_PARTIAL, 'msg');", // 写法 2：同名常量调用（ledger.mjs 的写法）
    "push(warnings, E_LEDGER_PARTIAL, 'msg');", // 写法 2：第二参是同名常量
    "const E_ALIAS = 'E_ALIASED_TARGET';", // 别名常量 —— 名与码不一致
    "diag(E_ALIAS, 'x');", // 别名调用 —— 不猜，不许被抓
    "const notEmitted = symbol('E_NOT_EMITTED');", // 函数名不是上面几个 —— 不该抓
    "add(codeVariable, 'x');", // 第一参不是字面量也不是同名常量 —— 扫不到是**有意**的
  ].join('\n');
  assert.deepEqual(
    emittedCodes(probe),
    /* 顺序是**按调用形式分组**的（先把 add/emit/diag 全扫一遍，再扫 push），不是源码行序。 */
    [
      'E_NO_CHALLENGE',
      'E_PRESET_NOT_FOUND',
      'E_PRESET_DOWNGRADE',
      'E_LEDGER_PARTIAL',
      'E_RESUME_EXHAUSTED',
      'E_LEDGER_PARTIAL',
    ],
    '扫描器必须认两种码名写法（字面量 / 同名常量）、码在第一参与第二参两种位置，'
      + '并且**不许**把别名常量、普通变量、别的函数名当成发射点',
  );

  /* 这条断言的意义：下面那一步即便扫到 0 个文件，
   * "扫描器有没有牙"这件事已经被独立证明了 —— 不靠文件存在与否。 */
  assert.ok(emittedCodes(probe).length > 0);

  /* ② 对真实存在的会议模块跑一遍。
   *
   * 判据是**会议码表 ∪ 基线码表**，与 `preset.mjs` 的 `isKnownGateCode` 同一口径：
   * 预设会合法地引用基线码（`E_SELF_REVIEW` / `E_MEETING_MISSING` 等），
   * 它们不是"未知门禁"。只认会议码表会把这些**正确**的引用判成错误。 */
  const { DELIVERY_BLOCKER_CODES, DELIVERY_WARNING_CODES } = await import('../src/delivery.mjs');
  const baselineCodes = new Set([...DELIVERY_BLOCKER_CODES, ...DELIVERY_WARNING_CODES]);
  const known = (code) => isMeetingCode(code) || baselineCodes.has(code);

  const unknown = [];
  let scanned = 0;
  let totalCodes = 0;
  for (const relative of meetingSources) {
    if (!existsSync(new URL(relative, import.meta.url))) continue;
    scanned += 1;
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    for (const code of emittedCodes(source)) {
      totalCodes += 1;
      if (!known(code)) unknown.push(`${relative}: ${code}`);
    }
  }
  assert.deepEqual(
    unknown,
    [],
    `这些码被发射了但不在任何已登记的码表里（页面上会显示成"未知门禁"）：\n  ${unknown.join('\n  ')}`,
  );

  /* ③ 覆盖面自检：**扫到文件不等于扫到了码**。
   *
   * 这一条是补上来的，因为第一版在这里翻过车：`preset.mjs` 被扫到了，
   * 但它用的是 `diag(...)`，而扫描器当时只认 add/emit/push ——
   * 于是 7 个码一个都没被检查，测试却绿着。
   * "绿着的空转"比红更危险，所以这里额外要求：
   * 已落地的模块必须真的贡献出一些码，否则说明扫描器又不认识新写法了。 */
  if (scanned > 0) {
    assert.ok(
      totalCodes > 0,
      `扫到了 ${scanned} 个会议模块，却一条码都没抽出来 —— `
        + '八成是模块用了扫描器不认识的发射写法。这种情况必须红，不许绿着空转',
    );
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. 生成物与码表一致（本组是"四处同步靠生成"这句话的守门员）
 *
 * 这一组做的事只有一件：**把生成器重新跑一遍（内存里），与磁盘上现有的三份产物逐字比对**。
 * 不一致就红。
 *
 * 为什么这样就算守住了：手改 `locale/zh.json` 里的一条会议码文案，
 * 生成器重算出来的结果就与磁盘不同 → 红，并指出是哪个文件。
 * 这也顺带证明"没有人绕过码表往文案里塞东西" —— 塞进去的会被重算抹掉，
 * 而测试会先说这件事。
 *
 * 三份产物各自的标记方式不同（JSON 无注释能力，走"整份比"；
 * client.js 用 `@meeting-codes` 标记夹区块），理由见生成器头部注释。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('7a. 三份生成物必须与 src/codes.mjs 完全一致（手改生成区块 → 红）', async () => {
  const { plan, generatedCodes } = await import('../tools/gen-meeting-codes.mjs');

  const generated = generatedCodes();
  /* 生成条数必须等于"会议码减去基线已拥有的"。目前基线拥有 E_QUESTIONS_UNANSWERED，
   * 所以 34 - 1 = 33。数字写死是故意的：它逼着"要不要把某个复用码也纳管"
   * 这件事必须被人明确决定一次，而不是随缘。 */
  assert.equal(generated.length, 34, `应生成 34 条（35 条会议码 − 1 条基线已有），实际 ${generated.length}`);
  assert.equal(
    generated.some((entry) => entry.code === 'E_QUESTIONS_UNANSWERED'),
    false,
    'E_QUESTIONS_UNANSWERED 的文案源头是基线 delivery.mjs，这里不许再生成一份（否则一个码两份文案）',
  );

  const stale = [];
  for (const { relative, current, next } of plan()) {
    if (current !== next) stale.push(relative);
  }
  assert.deepEqual(
    stale,
    [],
    `这些文件与 src/codes.mjs 不一致 —— 跑 \`node plugin/tools/gen-meeting-codes.mjs\`，不要手改生成区块：${stale.join('、')}`,
  );
});

test('7b. 生成是幂等的：连跑两次结果完全相同', async () => {
  const { regenerateLocale, regenerateClient } = await import('../tools/gen-meeting-codes.mjs');

  /* 幂等不是洁癖：如果第二次跑会再改一次，那"跑生成器"就变成一个不能重复执行的动作，
   * 而 CI / 提交前钩子这类地方必须能重复执行。 */
  const zhOnce = regenerateLocale({}, 'zh');
  const zhTwice = regenerateLocale(zhOnce, 'zh');
  assert.deepEqual(zhTwice, zhOnce, 'zh 生成第二遍不该再有变化');

  const enOnce = regenerateLocale({}, 'en');
  assert.deepEqual(regenerateLocale(enOnce, 'en'), enOnce, 'en 生成第二遍不该再有变化');
});

test('7c. 复用码（基线已有）在 codes.mjs 里的文案必须与 locale 逐字相同', async () => {
  /* 这是本组唯一的"允许重复但必须相等"的地方。
   *
   * `E_QUESTIONS_UNANSWERED` 的文案源头是基线，`codes.mjs` 里也写了一 份 ——
   * 因为会议侧的测试要能脱离 locale 文件独立拿到文案。允许重复，不许漂移：
   * 一旦有人只改了其中一边，两边说的就不是同一件事，而页面上显示哪一边
   * 取决于运行时哪份先加载 —— 这种分叉最难查。
   */
  const { MEETING_CODES } = await import('../src/codes.mjs');
  const { DELIVERY_BLOCKER_CODES, DELIVERY_WARNING_CODES } = await import('../src/delivery.mjs');

  const baseline = new Set([...DELIVERY_BLOCKER_CODES, ...DELIVERY_WARNING_CODES]);
  const reused = MEETING_CODES.filter((entry) => baseline.has(entry.code));
  assert.ok(reused.length > 0, '应当至少有一条复用码（E_QUESTIONS_UNANSWERED）；一条都没有说明判据写错了');

  const zhLocale = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'));
  const enLocale = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'));

  for (const entry of reused) {
    const key = `gates.code.${entry.code}`;
    assert.equal(
      zhLocale[key],
      entry.zh,
      `${entry.code} 的 zh 在 codes.mjs 与 locale/zh.json 之间漂移了 —— 一个码两份文案`,
    );
    assert.equal(
      enLocale[key],
      entry.en,
      `${entry.code} 的 en 在 codes.mjs 与 locale/en.json 之间漂移了`,
    );
  }
});

test('7d. 生成器缺标记时必须抛错，不许"顺手追加到文件末尾"', async () => {
  const { regenerateClient } = await import('../tools/gen-meeting-codes.mjs');

  /* 这条防的是一种很难查的坏结果：标记被人删了，生成器"友好地"把键追加到末尾，
   * 于是键跑到对象字面量外面 —— 变成语法错误，而报错位置指向一个
   * 跟生成器毫无关系的行。宁可现在就抛一句能被读懂的话。 */
  assert.throws(
    () => regenerateClient('const A = {\n};\n'),
    /@meeting-codes/,
    '没有标记时必须抛，且错误信息里要点到标记',
  );
  assert.throws(
    () => regenerateClient('/* @meeting-codes:begin */\n/* @meeting-codes:end */\n'),
    /2 组/,
    '只找到 1 组标记（应为 2 组：中英各一）时必须抛',
  );
});
