/**
 * gates-batch3.test.mjs — 批 3（7 条 warning）的**逐码三态账**，以及本轮唯一补上的那条判据。
 *
 * ## 这个文件为什么长这样
 *
 * 「批 3 达标了吗」这个问题，原本的答案是"7 条码都在 codes.mjs 里" —— 一条都不缺。
 * 但审计（见下）查出来的事实是：**7 条里有 5 条要么从不发声，要么发出的声音
 * 和它自己的文案说的不是一回事。** 也就是说"码在"和"码在干活"是两件事，
 * 而前者不能推出后者。
 *
 * 所以这里不写"批 3 全绿"这种话，改成**逐码登记三态**，并且把登记做成机械可判定的：
 *
 *   1. **本轮回声**：有真的发射点，本轮补上/确认过。
 *   2. **仍不发声**：登记为 knowingly silent，并写清它在等什么条件。
 *   3. **在发但发错通道 / 冒名**：有发射点，但判的条件与文案不符。
 *
 * 第 2、3 类**不是缺陷报告就完事** —— 它们被钉在 `BATCH3_STATE` 这张表里：
 * 谁将来给一条银态的码接上发射点，`B3-2a` 立刻变红，逼着他回来把这张表改对。
 * 这就是"宁可说我没查，也不要让空看起来像绿"的机械版本：
 * **沉默必须被登记，否则沉默会被读成通过。**
 *
 * ## 本轮实际交付
 *
 * 只有一条：`E_PRESET_UPGRADED` —— 由 `meeting.mjs` 的 `applyUpgrade` 在**真升档时**发声。
 * `E_SUGGEST_UPGRADE` **本轮不做**，理由写在 `BATCH3_STATE` 的注释里（不是"没空"，
 * 是"找不到不靠编的阈值"，详见那里的说明）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MEETING_CODES, meetingCodeOf } from '../src/codes.mjs';
import { applyUpgrade } from '../src/meeting.mjs';
import { resumeState } from '../src/resume.mjs';
import { validatePreset } from '../src/preset.mjs';

/* P2-11：`applyUpgrade` 现在**自己判方向**，registry 成了必填参数。
 * 用真注册表，不手写 rank 表 —— 手写的那份会和 index.json 漂移，而漂移的判据
 * 正是这一轮要消灭的东西。 */
const REGISTRY = JSON.parse(readFileSync(new URL('../presets/index.json', import.meta.url), 'utf8'));

/** 升档的统一入口：补上 registry，其余原样。 */
const upgrade = (input) => applyUpgrade({ registry: REGISTRY, ...input });

/* ═══════════════════════════════════════════════════════════════════════════
 * 0. 夹具
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 一份能过 `readLedger` 的最小账本：id / preset / status / stages 四样都要合法。 */
function freshMeeting(overrides = {}) {
  return {
    id: 'm-2026-11-21-01',
    preset: 'lite@1',
    status: 'running',
    stages: [],
    upgrades: [],
    ...overrides,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. `E_PRESET_UPGRADED`：真升档就要留痕，没升成就一个字都不许说
 *
 * 文案（codes.mjs:308）说的是「本会议发生过升档。留痕用——升档本身是允许的，
 * 但"升过档"这件事必须留在账本上，否则回头看会以为一路都是高档位」。
 * 所以判据只有一条：**这一次调用真的改变了 meeting.preset 吗**。
 * 除此之外的任何失败路径都不许发它 —— 那会在账本上写下一次没发生过的升档。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('B3-1a. 正例：升档成功要在 warnings 里留一条 E_PRESET_UPGRADED，并念出起点与终点', () => {
  const result = upgrade({
    meeting: freshMeeting(),
    toQualified: 'standard@1',
    reason: '做到一半发现动了架构',
    at: '2026-11-21T00:00:00Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.meeting.preset, 'standard@1');

  /* 这是本组的核心断言：一条真的发生了的升档，必须在**这次调用**的返回值里
   * 就带着自己的声音。只往 `upgrades[]` 里推一条记录是不够的 ——
   * 那是历史，而"要不要在页面上说这件事"是这一次动作的回答。 */
  assert.ok(Array.isArray(result.warnings), 'applyUpgrade 必须返回 warnings 数组（哪怕为空）');
  assert.equal(result.warnings.length, 1, `应当只有一条升档留痕，实际 ${JSON.stringify(result.warnings)}`);
  assert.equal(result.warnings[0].code, 'E_PRESET_UPGRADED');

  /* 文案要求"念出那个数"的同类要求：这里必须念出**两个档位名**。
   * 一句"建议留痕"不能告诉人是从哪升到哪，回头看还是不知道。 */
  assert.ok(result.warnings[0].message.includes('lite@1'), 'message 必须念出起点档位');
  assert.ok(result.warnings[0].message.includes('standard@1'), 'message 必须念出终点档位');
});

test('B3-1b. 反例：目标不是 id@version（没真升档）→ 一条 warning 都不许发', () => {
  const result = upgrade({ meeting: freshMeeting(), toQualified: 'standard' });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_PRESET_NOT_FOUND');
  /* 关键：没有升成，就不许留"升过档"的痕。否则页面会说一场按 lite 跑的会升过档。 */
  assert.deepEqual(result.warnings, [], `没升成就不许发声，实际 ${JSON.stringify(result.warnings)}`);
  assert.deepEqual(result.meeting.upgrades, [], 'upgrades 也不许动');
  assert.equal(result.meeting.preset, 'lite@1');
});

test('B3-1c. 反例：账本本身读不出来 → 一条 warning 都不许发', () => {
  const result = upgrade({ meeting: null, toQualified: 'standard@1' });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_LEDGER_UNREADABLE');
  assert.deepEqual(result.warnings, [], '账本都读不出来，谈不上留升档的痕');
});

test('B3-1d. 它是 warning，不是 blocker：不许混进 errors、不许把 ok 打下去', () => {
  /* 批 3 的整个卖点是"出声但不拦"。如果留痕跑到 `errors` 里去，
   * 任何拿 `errors.length === 0` 判"能不能往下走"的地方都会因此卡住 ——
   * 一次完全合法的升档会被自己的留痕挡住。 */
  const result = upgrade({
    meeting: freshMeeting(),
    toQualified: 'standard@1',
    reason: '架构变了',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, [], '写了理由时 errors 必须是空的');
  assert.equal(result.warnings[0].code, 'E_PRESET_UPGRADED', '而 warning 仍然要在');
});

test('B3-1e. 与 E_UPGRADE_NO_REASON 共存：不写理由时两条各归各位', () => {
  /* 这两条说的不是一件事：一条是"升过档"（留痕），一条是"没写为什么"（缺件）。
   * 合成一条会丢掉其中一半信息，而丢的那一半恰好是回头看最需要的。 */
  const result = upgrade({ meeting: freshMeeting(), toQualified: 'standard@1' });

  assert.equal(result.ok, true);
  assert.equal(result.errors[0].code, 'E_UPGRADE_NO_REASON');
  assert.equal(result.warnings[0].code, 'E_PRESET_UPGRADED');
});

test('B3-1f. 逐次留痕：连升两次，每次的 warnings 只对应那一次，历史仍然 append-only', () => {
  const first = upgrade({
    meeting: freshMeeting(),
    toQualified: 'standard@1',
    reason: '第一步',
    at: '2026-11-21T00:00:00Z',
  });
  const second = upgrade({
    meeting: first.meeting,
    toQualified: 'full@1',
    reason: '第二步',
    at: '2026-11-21T01:00:00Z',
  });

  assert.equal(second.meeting.upgrades.length, 2, 'upgrades 必须 append-only');
  assert.equal(second.warnings.length, 1, '第二次调用的 warnings 只该有这一次那一条');
  assert.ok(second.warnings[0].message.includes('standard@1'), '第二次的起点是 standard@1');
  assert.ok(second.warnings[0].message.includes('full@1'));
  /* 入参账本不许被改 —— 纯函数。 */
  assert.equal(first.meeting.upgrades.length, 1);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1b. 冒名清理：两条从别处接手过来的判据
 *
 * 这两条不是新功能，是**把借来的码名还回去** —— 原来它们分别借用了
 * `E_MEETING_INTERRUPTED`（"有阶段没跑完就换轮次"）与
 * `E_PRESET_NOT_IMPLEMENTED`（"这个档位没实现"），页面会拿错的文案指路。
 * 换名字之后必须仍然有人钉住：否则下一次又会被随手借回去。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('B3-1g. 存活判不出来要发 E_RESUME_LIVENESS_UNKNOWN，不许再借"中断"那条', () => {
  /* 时间不够（没给 now、账本上也没有时间戳）→ 存活必须是 unknown。
   * 这一档的语义是"**因为判不出来**才发继续"，与"这个会议被中断过"毫无关系。 */
  const preset = JSON.parse(readFileSync(new URL('../presets/standard@1.json', import.meta.url), 'utf8'));
  const state = resumeState({
    meeting: { id: 'm-1', preset: 'standard@1', status: 'running', stages: [], upgrades: [] },
    preset,
  });

  assert.equal(state.liveness.status, 'unknown');
  assert.equal(state.action, 'continue', 'unknown 时发继续是安全的（幂等），这一点不许变');
  assert.ok(
    state.warnings.some((w) => w.code === 'E_RESUME_LIVENESS_UNKNOWN'),
    `必须发它自己的码：${JSON.stringify(state.warnings)}`,
  );
  assert.equal(
    state.warnings.some((w) => w.code === 'E_MEETING_INTERRUPTED'),
    false,
    '存活判不出来不是"被中断"，不许借中断那条码',
  );
});

test('B3-1h. 零阶段却称已实现要发 E_PRESET_EMPTY_IMPLEMENTED，不许再借"未实现"那条', () => {
  /* 原来这条用的是 `E_PRESET_NOT_IMPLEMENTED`。两者听着像、判的不是一件事：
   * 一条说"我还没做"，一条说"我做了，但做出来是个空壳"。 */
  const result = validatePreset({ id: 'empty', version: 1, implemented: true, stages: [] });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_PRESET_EMPTY_IMPLEMENTED');
  assert.equal(
    result.errors.some((e) => e.code === 'E_PRESET_NOT_IMPLEMENTED'),
    false,
    '空壳不是"未实现"，不许借那条码',
  );

  /* 反例：同样零阶段，但 `implemented: false` 是**合法**的（承认还没做完）—— 不许报错。 */
  const honest = validatePreset({ id: 'empty', version: 1, implemented: false, stages: [] });
  assert.equal(honest.ok, true, '零阶段 + implemented:false 是合法的，不许拦');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. 逐码三态账：沉默必须被登记
 *
 * 这一组不测行为，测的是**我们对这 7 条码的认知有没有过时**。
 * 它会在两种情况下变红，两种都是想要的：
 *   - 有人给一条"已登记为不发声"的码接上发射点 → 逼他回来把账改对（否则批 3 的
 *     达标率会被人以为了变了，而没人知道）；
 *   - 有人把一条"本轮回声"的码的发射点删了/注释掉了 → 死码复发。
 *
 * **它判的是源码文本里有没有这个发射点，不判那条路可不可达。**
 * `if (false) diag('E_X', ...)` 这种静态死路它看不见 —— 那一层由 B3-1* 的行为测试管。
 * 两组分工必须写清，否则后人会以为这一条证明了"码真的会响"。
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 批 3 这 11 条码的**登记态**。`true` = 源码里真的有发射点；`false` = knowingly silent。
 *
 * 每一条的裁决与理由（2026-11-21 审计 → 2026-11-21/22 P2-6 清冒名）：
 *
 * | 码 | 态 | 说明 |
 * |---|---|---|
 * | `E_AGENT_OVERRIDE_NO_REASON` | true | **本轮回声**（新码）：`agentpool.mjs` `decideAgent`，领导覆盖复用模式却没写理由。原先借用升档码 `E_UPGRADE_NO_REASON`。 |
 * | `E_ARTIFACT_PARTIAL` | **false** | **本轮仍不发声，而且不是"待办没空"**：它原先唯一的发射点在 `meeting.mjs:255`，报的是"stray 阶段"，与文案（卡片字段半缺）不是一回事 —— 冒名。冒名那处已换新码 `E_LEDGER_STRAY_STAGE`，于是它回到零发射点。**而它真正的判据填不进来**：仓库里没有"部分"的定义（预设只声明 `mustProduce`，没有可选字段；`judgeArtifact` 只判"本阶段要求产出的字段"，缺了走 `E_ARTIFACT_MISSING`、齐了没得缺，中间那一档不存在）。等：预设 schema 增加"可选/允许缺"的声明，或人裁定"部分"指什么。**不许为了让通道有东西而现编一个"部分"。** |
 * | `E_LEDGER_DROPPED` | true | **本轮回声**（新码，本轮才登记进码表）：`ledger.mjs`，会议块里有不认识的键 → 值不落地但要出声。**注意它的写法是常量**（`diag(E_LEDGER_DROPPED, …)`），所以本文件的扫描器必须认"同名常量"这种码名写法，否则会看不见它。 |
 * | `E_LEDGER_STRAY_STAGE` | true | **本轮回声**（新码）：`meeting.mjs` `meetingState`，账本阶段不在当前预设图里。接手了 `E_ARTIFACT_PARTIAL` 的冒名。 |
 * | `E_MEETING_INTERRUPTED` | **false** | **本轮仍不发声（登记在案的沉默，不是待办）**：两处冒名已清 —— `meeting.mjs:361`（abandoned）改用 `E_MEETING_ABANDONED`、`resume.mjs:623`（liveness unknown）改用 `E_RESUME_LIVENESS_UNKNOWN`。清完之后**它的真正义判不了**：文案说"有阶段没跑完就换了轮次"，而账本每个阶段只保留**最新一轮**的记录（`recordSubmission` 覆盖写），"上一轮没跑完"这件事在数据上根本不存在 —— 判不了，不是忘了判。等：账本改成保留轮次历史。 |
 * | `E_PRESET_NOT_IMPLEMENTED` | true | **本轮收窄到真正义**：只剩 `preset.mjs` `loadPreset` 那一处（`implemented === false`）。文案也一并改成对着"整个档位没实现"说话（旧文案说的是"其中某个阶段还没有执行器"，与它现在唯一会发的地方不符）。 |
 * | `E_PRESET_UPGRADED` | true | `meeting.mjs` `applyUpgrade`，真升档时发（上一轮补）。 |
 * | `E_RESUME_LIVENESS_UNKNOWN` | true | **本轮回声**（新码）：`resume.mjs`，存活判不出来 → 发「继续」是因为判不出。接手了 `E_MEETING_INTERRUPTED` 的冒名。 |
 * | `E_RESUME_NO_TARGET` | true | 对症：`resume.mjs`，已完成/已放弃时收到「继续」。 |
 * | `E_SUGGEST_UPGRADE` | false | **仍不发声**。找不到不靠编的阈值：要回答"该不该升档"，而仓库里没有任何常量是为这个判断定的（`STAGNATION_STREAK` 数派工、`MAX_CONTINUES_PER_ATTEMPT` 数继续、`conservativeStreak` 的注释明说"阈值是展示层的事"，方案给它定的 ≥2 用途是**标红**）。借数字不借含义。 |
 * | `E_UPGRADE_NO_REASON` | true | **本轮收窄到真正义**：只剩 `meeting.mjs` `applyUpgrade`（升档没写理由，在 `errors` 里但 `ok` 恒 true、实际不阻断）。`agentpool.mjs` 那处冒名已换新码。 |
 *
 * 两条**新码落在批 1/2**（`E_PRESET_EMPTY_IMPLEMENTED` / `E_PRESET_NO_BLIND_STAGE` / `E_MEETING_ABANDONED`）
 * 不在这张表里 —— 本表只管批 3。它们在 `codes.test.mjs` 的 4a/4b 里被计数钉子管着。
 */
const BATCH3_STATE = Object.freeze({
  E_AGENT_OVERRIDE_NO_REASON: true,
  E_ARTIFACT_PARTIAL: false,
  E_LEDGER_DROPPED: true,
  E_LEDGER_STRAY_STAGE: true,
  E_MEETING_INTERRUPTED: false,
  E_PRESET_NOT_IMPLEMENTED: true,
  E_PRESET_UPGRADED: true,
  E_RESUME_LIVENESS_UNKNOWN: true,
  E_RESUME_NO_TARGET: true,
  E_SUGGEST_UPGRADE: false,
  E_UPGRADE_NO_REASON: true,
});

/** 扫描的源文件集合：生产路径上所有可能发射码的地方。 */
function productionSources() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(here, '..');
  const files = [];
  for (const dir of ['src', 'host']) {
    const abs = path.join(pluginRoot, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (!/\.(mjs|js)$/.test(name)) continue;
      files.push(path.join(dir, name).split(path.sep).join('/'));
    }
  }
  return { pluginRoot, files };
}

/**
 * 从一段源码里抽出所有被发射的码。
 *
 * 三种约定都认（与 `codes.test.mjs` 6a 同一套口径），因为项目里三种都在用：
 *   `diag('E_X', ...)` / `add('E_X', ...)` / `emit('E_X', ...)` → 码在**第一参**
 *   `push(arr, 'E_X', ...)`                                   → 码在**第二参**
 *
 * 两件它**不会**当成发射点的事，都由 B3-2a 钉住：
 *   - `codes.mjs` 里写的是 `code: 'E_X'`（冒号，不是函数调用）—— 码表定义不算发射；
 *   - **整行被注释掉的调用**——`// diag('E_X', ...)` 与块注释里的行都不算。
 *     这一条是补上来的：反证演练时把发射行注释掉，第一版扫描器仍然把它数成发射点，
 *     于是"登记表"绿着，而实际上一个码都不会发出去。
 *
 * **它判的只是"源码里有没有这个发射点"，不判那个发射点可不可达。** 例如
 * `if (false) warnings.push(diag('E_X', ...))` 依然会被它数到 —— 这是文本审计的
 * 固有盲区，不打算用正则去猜控制流。**可达性由 B3-1* 那六条行为测试负责**，
 * 两组分工写在这里，免得后人以为 2b 证明了"这条码真的会响"。
 */
function emittedCodes(source) {
  /* 先把"整行注释"抹成空行，再在**整段文本**上匹配 —— 两件事都不能省：
   *
   *   - 抹注释：`// diag('E_X', ...)` 是停发，不是发射；不抹就会把一条已经
   *     被人注释掉的码继续算成"还在发"。
   *   - 抹完仍然在整段上匹配、而不是逐行匹配：这些文件里的调用是**跨行**的
   *     （`push(diag(\n  'E_X', ...)`、`resume.mjs` 的 `diag(\n  'E_RESUME_NO_TARGET',`）。
   *     第一版改成逐行之后，跨行调用全部漏掉，B3-2b 立刻红 —— 那次是测试自己抓到的，
   *     记在这里，免得以后有人为了"更严格"又改回逐行。
   *
   * 只按**行首**判注释，不去正文里抠 `//`：这些文件里有 `http://` 一类的字符串，
   * 动正文会误伤。
   */
  const masked = source
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') ? '' : line;
    })
    .join('\n');

  const found = [];
  /* 码名有两种写法，两种都要认：
   *   1. 字面量：`diag('E_X', …)`     —— `meeting.mjs` / `preset.mjs` / `resume.mjs` 的写法；
   *   2. 同名常量：`const E_X = 'E_X'; diag(E_X, …)` —— `ledger.mjs` 的写法。
   * 第二种是补上来的：只认字面量时，`ledger.mjs` 里每一处发射都扫不到，
   * 而**它照样发得出去**（`E_LEDGER_DROPPED` 就是这么写进 `BATCH3_STATE` 的）。
   * 别名常量（`const A = 'E_B'`）不猜 —— 那会把扫描器变成一个小解释器。 */
  const names = new Set();
  for (const match of masked.matchAll(/\bconst\s+(E_[A-Z0-9_]+)\s*=\s*'(E_[A-Z0-9_]+)'/g)) {
    if (match[1] === match[2]) names.add(match[1]);
  }
  const pick = (raw) => {
    const quoted = /^'(E_[A-Z0-9_]+)'$/.exec(raw);
    if (quoted !== null) return quoted[1];
    return names.has(raw) ? raw : undefined;
  };

  for (const match of masked.matchAll(/\b(?:add|emit|diag)\s*\(\s*('E_[A-Z0-9_]+'|[A-Za-z_$][\w$]*)/g)) {
    const code = pick(match[1]);
    if (code !== undefined) found.push(code);
  }
  for (const match of masked.matchAll(/\bpush\s*\(\s*[A-Za-z_$][\w$.]*\s*,\s*('E_[A-Z0-9_]+'|[A-Za-z_$][\w$]*)/g)) {
    const code = pick(match[1]);
    if (code !== undefined) found.push(code);
  }
  return found;
}

test('B3-2a. 扫描器先自检：认三种约定，不把码表 `code:` 定义当发射，也不把注释掉的调用当发射', () => {
  /* 一个没有牙的扫描器会让 B3-2b 变成"绿着空转" —— 本项目已经抓到过两次。
   * 所以先拿一段人造源码证明它看得见该看见的、也看不见不该看见的。 */
  const probe = [
    "diag('E_PRESET_UPGRADED', 'x');",
    "add('E_NO_CHALLENGE', 'x');",
    "emit('E_BLIND_LEAK', {});",
    "push(warnings, 'E_SUGGEST_UPGRADE', 'x');",
    "const E_LEDGER_DROPPED = 'E_LEDGER_DROPPED';", // 同名常量（ledger.mjs 的写法）
    "diag(E_LEDGER_DROPPED, 'x');", // 常量调用 —— 必须算发射
    "const E_ALIAS = 'E_ALIASED_TARGET';", // 别名 —— 不猜
    "diag(E_ALIAS, 'x');", // 别名调用 —— 不许算发射
    "code: 'E_DEFINITION_ONLY',", // 码表里的定义 —— 不许算发射
    "// diag('E_COMMENTED_OUT', 'x');", // 整行注释 —— 不许算发射
    " *   diag('E_INSIDE_BLOCK_COMMENT', 'x');", // 块注释里的行 —— 不许算发射
    "const f = (code) => diag(code, 'x');", // 变量 —— 约定只认字面量与同名常量
  ].join('\n');

  assert.deepEqual(
    emittedCodes(probe),
    /* 顺序是**按调用形式分组**的（先把 add/emit/diag 全扫一遍，再扫 push），
     * 不是源码行序 —— 这一点与 `codes.test.mjs` 6a 的实现一致，是既有行为。 */
    ['E_PRESET_UPGRADED', 'E_NO_CHALLENGE', 'E_BLIND_LEAK', 'E_LEDGER_DROPPED', 'E_SUGGEST_UPGRADE'],
    '扫描器必须认两种码名写法（字面量 / 同名常量）与两种参数位置，且不许把 `code:` 定义、'
      + '整行注释、块注释、别名常量、普通变量当成发射点',
  );
});

test('B3-2b. 批 3 每条 warning 的实际发射状态必须与 BATCH3_STATE 登记一致', () => {
  const { pluginRoot, files } = productionSources();
  assert.ok(files.length > 0, '一个源文件都没找到 —— 扫描路径写错了');

  const emitted = new Set();
  for (const relative of files) {
    const source = readFileSync(path.join(pluginRoot, relative), 'utf8');
    for (const code of emittedCodes(source)) emitted.add(code);
  }

  /* 前提自检：这 7 条码必须都还在码表里（本轮不许增删码）。 */
  for (const code of Object.keys(BATCH3_STATE)) {
    const entry = meetingCodeOf(code);
    assert.notEqual(entry, undefined, `${code} 不在码表里 —— 本轮的登记表过时了`);
    assert.equal(entry.severity, 'warning', `${code} 的 severity 不再是 warning`);
    assert.equal(entry.batch, 3, `${code} 不再属于批 3`);
  }

  const drifted = [];
  for (const [code, expected] of Object.entries(BATCH3_STATE)) {
    const actual = emitted.has(code);
    if (actual === expected) continue;
    drifted.push(
      actual
        ? `${code}：登记为「不发声」，但源码里**已经**有发射点 —— 请把 BATCH3_STATE 改成 true，`
            + '并在上方那条裁决里写清是谁在发、发的条件是不是它文案说的那件事'
        : `${code}：登记为「有发射点」，但源码里已经**找不到**了 —— 死码复发，`
            + '要么把发射点加回去，要么把登记改成 false 并写清在等什么',
    );
  }
  assert.deepEqual(
    drifted,
    [],
    `批 3 的登记态与源码不一致（沉默必须被登记，不许让空看起来像绿）：\n  ${drifted.join('\n  ')}`,
  );

  /* 反过来也要钉一次：这 7 条码一条都不许漏在登记表外。 */
  const batch3 = MEETING_CODES.filter((entry) => entry.batch === 3 && entry.severity === 'warning').map((e) => e.code);
  assert.deepEqual(
    batch3.slice().sort(),
    Object.keys(BATCH3_STATE).slice().sort(),
    '批 3 的 warning 码集合变了 —— 新增/删除了码就必须同步这张登记表',
  );
});