/**
 * gates.mjs — 任务完成门禁：状态转移表 + 完成时的四道关（一次返回全部错误）。
 *
 * 设计约束：
 *   - 纯 ESM、零依赖、无副作用：不读文件、不跑进程、不写状态。
 *   - 只做判定，不做 I/O；调用方拿到 {ok, errors} 自行决定置 completed 还是 failed。
 *   - 四关顺序执行，**任何一关失败都不早退**：规格要求「一次返回全部错误」，
 *     否则成员要改一轮跑一轮、每轮只看见一条错误。
 *   - 容错入参：缺字段按「没有」处理，绝不因为 payload 残缺而抛异常（抛异常会让门禁变成随机失败）。
 *
 * 契约取值口径（G1）：accepance / verify / inScope / outOfScope 一律经 contractOf(task) 取，
 * 因此「字段写在 task.contract」与「字段直接写在 task 顶层」判定完全一致；
 * 本模块不再直接读 task.inScope 之类的裸字段，杜绝两套口径。
 *
 * 失败方向（G2）：一侧是"申报了什么"，另一侧是"凭什么放行"。任何缺失都不许被解释成放行——
 * 申报了改动却没有范围声明 → E_SCOPE_UNDECLARED；路径不是安全的工作区相对路径 → E_PATH_UNSAFE。
 *
 * attempt 维度（G3）：回执带 attempt 标注时必须与本轮轮次对齐；对不上的回执不计入覆盖统计，
 * 并且单独报 E_STALE_ATTEMPT（而不是把"过期"混成"缺失"）。
 *
 * 轮次解析链（W2-C / F4-5 / D-7）：`round = meta.attempt ?? contractOf(task).attempt ?? task.attempt ?? 1`。
 * **三个模块同一个顺序**。只看 meta 就等于"插件层漏写一个字段 = 宣布这是第 1 轮"，
 * 于是上一轮的回执全部变成"本轮可用"（L-11 的第二条入口）。两处都有值且不同 = 轮次歧义，
 * 报 E_INPUT_INVALID，门禁不替调用方选边。
 *
 * attempt 卫生（G6，blocker L-11 + major L-10）：
 *   - attempt 只认正整数；缺失（undefined/null）算第 1 轮（引导轮），
 *     其它任何形态（'2' / 2.5 / 0 / -1 / true）都是坏输入 → E_INPUT_INVALID，不许静默降级成"不判新旧"。
 *   - 分档：round===1 允许无标回执（没有"上一轮"可言）；round>1 无标回执一律 E_STALE_ATTEMPT
 *     —— 否则第二轮只要把第一轮的回执原样带上、不打标，就能白嫖本轮通过（reaper failed→pending 攻击链）。
 *   - 汇总：同一「原因 + attempt 值」的过期回执只报一条（L-2），消息里列出涉及的 receipt id 与受影响项。
 *
 * 作用域声明合法性（G7 / minor L-6）：inScope / outOfScope 里的非法条目报 E_PATH_UNSAFE
 * （问题在声明本身），此时不再对申报路径逐个报 E_OUT_OF_SCOPE —— 那会把成员引去改范围。
 *
 * 契约可判定性（关⓪，W2-A / W2-B）：
 *   - 质量 kind（implementation / review）的契约字段在两处声明且异值 → E_CONTRACT_AMBIGUOUS（不选边）。
 *   - 质量 kind 必须同时声明 acceptance 与 verify → 缺任一 E_CONTRACT_INCOMPLETE。
 *     没有 verify 时关① 会整段跳过，那等于"少写一个字段就能关掉门禁"（F4-4）。
 *   - work 豁免以上两条。
 *
 * 错误码全部登记在 ERROR_CODES（导出）里，新增判定必须先登记。
 */

import * as contractKit from './contract.mjs';

/**
 * 契约模块的取值面用**命名空间导入**而不是具名导入：
 * gates 只依赖 contractOf / classifyPath / normalizePath 三个锁定接口，
 * 而 G7 想优先用 W1 新增的 `toEntryListStrict`（诊断版）。用属性访问可以在那个导出
 * 尚未落地/改名时自动退回本地判定，而不是让整个模块在 import 阶段就炸掉。
 */
const { contractOf, classifyPath, normalizePath } = contractKit;

/** W1 的严格版作用域解析（`{entries, illegal:[{raw,reason}]}`）；没落地时为 undefined。 */
const toEntryListStrict =
  typeof contractKit.toEntryListStrict === 'function' ? contractKit.toEntryListStrict : null;

/** 契约歧义检测（W1 的 `contractAmbiguity(task) → string[]`）；没落地时为 undefined。 */
const contractAmbiguityOf =
  typeof contractKit.contractAmbiguity === 'function' ? contractKit.contractAmbiguity : null;

/**
 * 质量 kind：**必须有可执行的验收依据**的任务类型。集合的唯一来源是 contract.mjs。
 *
 * C-1（第 12 轮）：这里**不再有字面量副本**。以前三处各写一份
 * （`contract.mjs:55` 冻结数组 / 本文件 / `delivery.mjs` 的 `new Set`），
 * 加第三个 kind 时必漏一处；而漏掉的那一处**不报错、只静默少判**——
 * 该走质量门禁的任务会整段跳过关⓪ 与关①（fail-open，界面上一切正常）。
 * 所以现在只留 contract.mjs 那一份，gates 与 delivery 读同一个绑定。
 *
 * 写法说明：这里用**解构读取**而不是 `const QUALITY_KINDS = ...` 重新赋值。
 * 前者是"读导入的同一个数组"，后者哪怕内容一样也是第二份定义；
 * contract.test.mjs 的闭合扫描正是按"是否出现给 QUALITY_KINDS 赋值的行"判定的。
 *
 * 契约件缺失时**装载期**就抛：宁可门禁模块装不上，也不要它在运行时随机少判一条。
 */
const { QUALITY_KINDS } = contractKit;
if (!Array.isArray(QUALITY_KINDS) || !Object.isFrozen(QUALITY_KINDS)) {
  throw new TypeError(
    'contract.mjs 必须导出冻结数组 QUALITY_KINDS（质量门禁的唯一口径）；'
      + '当前缺失、不是数组或未冻结。门禁拒绝以"少判一条"的方式启动。',
  );
}

/** 允许发起状态转移的两个角色。 */
export const ACTORS = Object.freeze(['worker', 'leader']);

/**
 * 本模块可能产出的全部错误码。
 *
 * 导出它是为了让插件层/测试能机械核对：任何一条 message 的 code 都必须在这张表里，
 * 拼错一个码（E_VERIFY_MISSING → E_VERIFY_MISSIN）就等于让调用方漏处理，
 * 属于"静默放行"的另一种形态。新增判定请先在这里登记。
 */
export const ERROR_CODES = Object.freeze([
  // 状态机
  'E_ILLEGAL_TRANSITION',
  // 关① 运行时 verify
  'E_VERIFY_FAILED_BY_RUNTIME',
  'E_VERIFY_MISSING',
  'E_STALE_ATTEMPT',
  // 关② 验收对账
  'E_ACCEPTANCE_MISMATCH',
  'E_EVIDENCE_UNBACKED',
  // 关⓪ 契约可判定性（G8 / W2-A / W2-B）
  'E_CONTRACT_INCOMPLETE',
  'E_CONTRACT_AMBIGUOUS',
  // 关③ diff 对账
  'E_UNREPORTED_CHANGES',
  'E_PHANTOM_CHANGES',
  'E_OUT_OF_SCOPE',
  'E_PATH_UNSAFE',
  'E_SCOPE_UNDECLARED',
  // 关④ 字节绑定
  'E_CHANGED_PATHS_REQUIRED',
  // review 裁决
  'E_VERDICT_REQUIRED',
  'E_FINDINGS_REQUIRED',
  'E_OPEN_FINDINGS',
  // 入参（白名单外/拼错的枚举值）
  'E_INPUT_INVALID',
]);

/**
 * review 裁决的合法取值（正向白名单）。
 * 未知取值不得被当成"某种非 pass 状态"糊过去，而是 E_INPUT_INVALID：拼错就是坏输入。
 */
export const REVIEW_VERDICTS = Object.freeze(['pass', 'needs_revision', 'reject']);

/**
 * 唯一代表"评审已完成"的裁决。
 * needs_revision / reject 是**合法裁决但不是完成**：它们可以落盘（写进 reviewed.verdict 供审计），
 * 但任务不得进入 completed，也就进不了可交付集合（G5 / F-9）。
 */
export const COMPLETION_VERDICTS = Object.freeze(['pass']);

/** finding 严重度的合法取值（正向白名单，拼错即 E_INPUT_INVALID）。 */
export const REVIEW_SEVERITIES = Object.freeze([
  'critical',
  'blocker',
  'high',
  'medium',
  'low',
  'trivial',
  'info',
]);

/** 会阻止 verdict='pass' 的严重度。critical 与 blocker 同级——不许因为"没见过这个词"就降级。 */
export const BLOCKING_SEVERITIES = Object.freeze(['critical', 'blocker', 'high']);

/**
 * 状态转移表：(from, to) → actor。
 *
 * 键为 `"<from>-><to>"`，值为唯一有权发起该转移的角色。
 * **未列出的转移一律 E_ILLEGAL_TRANSITION**（规格 §4.5），所以这里只登记合法边，
 * 不要为了「宽容」往里补边——补一条边就等于开一条无审计的旁路。
 *
 * guard 不进表（那是调用方在发转移前自己满足的前置条件，例如必须带 reason、
 * 必须持当前 attempt_id、reopens < max_reopen）；本模块只裁决「这条边存不存在、
 * 该由谁发起」。
 */
export const TRANSITIONS = Object.freeze({
  // 成员推进自己的任务
  'pending->claimed': 'worker',
  'claimed->in_progress': 'worker',
  'in_progress->completed': 'worker',
  'in_progress->failed': 'worker',
  'claimed->failed': 'worker',

  // 领导撤销 / 重开
  'pending->cancelled': 'leader',
  'claimed->cancelled': 'leader',
  'in_progress->cancelled': 'leader',
  'failed->pending': 'leader',
  'completed->pending': 'leader',
});

/** 终态：出边只可能是领导发起的 completed->pending（契约修订）。 */
export const TERMINAL_STATUSES = Object.freeze(['completed', 'cancelled']);

/** 是否为合法对象（null / undefined / 标量都不算）。 */
function isObjectLike(value) {
  return typeof value === 'object' && value !== null;
}

/** 取字符串并 trim；非字符串返回空串。 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 正整数判定（attempt 只认这种形态）。 */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** 把值渲染成可读片段，用于错误消息。 */
function describeValue(value) {
  if (value === undefined) return '(缺失)';
  if (value === null) return '(null)';
  if (typeof value === 'string') return value.trim() === '' ? '(空字符串)' : value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 规范化一条路径，并**如实标注它是否安全**。
 *
 * 这里不再"normalizePath 返回 null 就退回原值"——那等于把非法路径洗成合法 token 继续往下走，
 * 是 fail-open 的一半来源。现在：normalizePath 认为不安全 → safe:false，token 保留原文只为了
 * 跟 diff 侧同一 token 对上（否则会额外冒出一条 E_UNREPORTED_CHANGES，把诊断带偏），
 * 由调用方直接报 E_PATH_UNSAFE 并拒绝。
 *
 * @param {unknown} raw
 * @returns {{token: string, raw: string, safe: boolean}|null} null = 空串/非字符串，直接忽略
 */
function normalizePathEntry(raw) {
  const value = text(raw);
  if (!value) return null;
  try {
    const normalized = normalizePath(value);
    if (typeof normalized === 'string' && normalized.length > 0) {
      return { token: normalized, raw: value, safe: true };
    }
  } catch {
    // 契约模块抛错 → 按不安全处理（与返回 null 同一条路径）
  }
  return { token: value, raw: value, safe: false };
}

/** 规范化路径列表：丢弃空串，按 token 去重，保留 safe 标记。 */
function normalizePathEntries(list) {
  const values = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const item of values) {
    const entry = normalizePathEntry(item);
    if (!entry || seen.has(entry.token)) continue;
    seen.add(entry.token);
    out.push(entry);
  }
  return out;
}

/**
 * 作用域模式列表：只 trim + 去空 + 去重，**不做路径规范化**。
 * 关键：`inScope: ['src/auth/']` 的结尾 `/` 是目录语义，交给 contract.mjs 的
 * classifyPath 自己解析；在这里先过一遍 normalizePath 会把 `/` 抹掉，
 * 于是目录声明退化成「只匹配该文件名」，范围审计就整片误判。
 */
function normalizePatternList(value) {
  const values = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const item of values) {
    const pattern = text(item);
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

/** 规范化字符串列表：接受数组或单值，丢弃空串。 */
function normalizeTextList(value) {
  const values = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of values) {
    const normalized = text(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * 判定单个（已确认安全的）路径的作用域归属。
 * contract.mjs 的签名锁定为 'in_scope'|'out_of_scope'|'undeclared'；
 * 任何非预期返回（含抛错）都按 'undeclared' 处理——门禁宁可要求补申报，
 * 也不把不明归属当成 in_scope 放行。
 *
 * 注意：调用方必须先用 entry.safe 拦掉非法路径（那些报 E_PATH_UNSAFE）。
 * 非法路径在这里只会得到 'undeclared'，拿它报 E_OUT_OF_SCOPE 会把诊断带偏（F-12）。
 */
function classifyPathSafe(path, inScope, outOfScope) {
  try {
    const verdict = classifyPath(path, inScope, outOfScope);
    if (verdict === 'in_scope' || verdict === 'out_of_scope' || verdict === 'undeclared') return verdict;
  } catch {
    // 落到下面的保守判定
  }
  return 'undeclared';
}

/**
 * 断言一次状态转移是否被允许。
 *
 * @param {{from: string, to: string, actor: 'worker'|'leader'}} transition
 * @returns {{ok: boolean, code?: string, message?: string}}
 */
export function assertTransition(transition) {
  const t = isObjectLike(transition) ? transition : {};
  const from = text(t.from);
  const to = text(t.to);
  const actor = text(t.actor);

  if (!from || !to) {
    return {
      ok: false,
      code: 'E_ILLEGAL_TRANSITION',
      message: `转移缺少 from/to（from=${describeValue(t.from)}，to=${describeValue(t.to)}）`,
    };
  }

  const key = `${from}->${to}`;
  const required = TRANSITIONS[key];

  if (!required) {
    return {
      ok: false,
      code: 'E_ILLEGAL_TRANSITION',
      message: `未登记的转移「${key}」：状态转移表里没有这条边，一律拒绝`,
    };
  }

  if (actor !== required) {
    return {
      ok: false,
      code: 'E_ILLEGAL_TRANSITION',
      message: `转移「${key}」只能由 ${required} 发起，实际发起者是 ${actor || '(空)'}`,
    };
  }

  return { ok: true };
}

/** 从一条回执里取出可用于匹配「合同 verify 项」的键。 */
function receiptKeys(receipt) {
  const keys = [];
  for (const field of ['id', 'command', 'verify']) {
    const value = text(receipt[field]);
    if (value) keys.push(value);
  }
  return keys;
}

/** 合同 verify[] 的某一项在回执里对应的键（字符串直接用，对象取 id/command）。 */
function verifyItemKey(item) {
  if (typeof item === 'string') return item.trim();
  if (isObjectLike(item)) {
    const id = text(item.id);
    if (id) return id;
    return text(item.command);
  }
  return '';
}

/** 回执在消息里的可读标识。 */
function receiptLabel(receipt, index) {
  const id = text(receipt.id);
  if (id) return id;
  const command = text(receipt.command);
  if (command) return command;
  return `#${index}`;
}

/**
 * meta.attempt 归一化（G6 / major L-10）。
 *
 * 口径（唯一）：
 *   - 缺失（undefined / null）→ 1。存量夹具没有 attempt 字段，一律视为引导轮，向后兼容。
 *   - `Number.isInteger(x) && x > 0` → 原值。
 *   - 其它任何形态（'2'、2.5、0、-1、true、''、NaN、Infinity、对象…）→ E_INPUT_INVALID。
 *     绝不当成 1 或"忽略"，因为"attempt 形态非法"曾被当成关闭过期判定的开关（L-10）：
 *     JSON 往返把数字写成字符串是最常见的形态，静默降级等于把 blocker 留着。
 *
 * @param {unknown} value
 * @returns {{status: 'missing'|'ok'|'invalid', value: number|null}}
 */
function readAttemptScalar(value) {
  if (value === undefined || value === null) return { status: 'missing', value: null };
  if (isPositiveInteger(value)) return { status: 'ok', value };
  return { status: 'invalid', value: null };
}

/**
 * 任务侧（团队存储里的任务记录）的 attempt。
 *
 * 记录形态是 `{ n, id }`（见夹具 `attempt: { n: 2 }`）：只取 `n`，`id` 不参与轮次。
 * 形态放宽**只针对任务记录**，不针对 `meta.attempt`（那是门禁自己的入参，只认标量）。
 * @param {unknown} value
 * @returns {{status: 'missing'|'ok'|'invalid', value: number|null}}
 */
function readTaskAttempt(value) {
  if (isObjectLike(value) && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'n')) {
    return readAttemptScalar(value.n);
  }
  return readAttemptScalar(value);
}

/**
 * 轮次解析链（D-7 / F4-5）：**三个模块同一个顺序**
 *
 *     round = meta.attempt ?? contractOf(task).attempt ?? task.attempt ?? 1
 *
 * 为什么必须链式：`meta.attempt` 是插件层填的，任务记录上的 `attempt` 是团队存储写的。
 * 只看 `meta` 时，漏写一个字段就等于宣布"这是第 1 轮" → 上一轮的回执全部变成"本轮可用"
 * （L-11 的第二条入口）。任务记录说第 2 轮，就按第 2 轮判。
 *
 * 判错规则（都不许选边）：
 *   - 存在但不是正整数（'2' / 2.5 / 0 / -1 / true）→ E_INPUT_INVALID
 *   - `meta.attempt` 与任务侧同时存在且**不同** → E_INPUT_INVALID（轮次歧义）
 *   - 任何一条报错 → round = null（本轮不做新旧判定；整体必然 ok:false）
 *
 * 注：`contract.attempt` 与顶层 `task.attempt` 之间**不算歧义**（这是 contract.mjs 的既定裁决：
 * attempt 是任务记录字段，走链式兜底而不是契约字段，见 CONTRACT_DECLARATION_KEYS 的注释）。
 *
 * @param {unknown} meta
 * @param {object} task
 * @param {object} contract contractOf(task) 的结果
 * @returns {{round: number|null, errors: Array<{code:string,message:string}>, source: string}}
 */
function resolveRound(meta, task, contract) {
  const errors = [];

  const fromMeta = readAttemptScalar(isObjectLike(meta) ? meta.attempt : undefined);

  // contractOf(task) 在"契约未声明"时就返回 task 本身，因此这一步同时覆盖两种写法。
  const contractOwn = isObjectLike(contract) ? contract.attempt : undefined;
  const taskSideRaw = contractOwn === undefined || contractOwn === null
    ? (isObjectLike(task) ? task.attempt : undefined)
    : contractOwn;
  const fromTask = readTaskAttempt(taskSideRaw);

  if (fromMeta.status === 'invalid') {
    errors.push({
      code: 'E_INPUT_INVALID',
      message:
        `meta.attempt=${describeValue(isObjectLike(meta) ? meta.attempt : undefined)} 不是正整数：`
        + "attempt 只能是 1、2、3… 这样的整数（'2' / 2.5 / 0 / -1 / true 一律拒绝；"
        + '只有"缺失"才按第 1 轮处理）。它不是关闭 attempt 判定的开关',
    });
  }

  if (fromTask.status === 'invalid') {
    errors.push({
      code: 'E_INPUT_INVALID',
      message:
        `任务侧 attempt=${describeValue(taskSideRaw)} 不是正整数：任务记录的 attempt 接受正整数或记录形态 {n, id}（取 n）；`
        + '非法形态不能成为"跳过 attempt 判定"的开关（缺失才视为第 1 轮）',
    });
  }

  if (fromMeta.status === 'ok' && fromTask.status === 'ok' && fromMeta.value !== fromTask.value) {
    errors.push({
      code: 'E_INPUT_INVALID',
      message:
        `轮次歧义：meta.attempt=${fromMeta.value} 与任务侧 attempt=${fromTask.value} 不一致。`
        + '解析链是 meta.attempt ?? contractOf(task).attempt ?? task.attempt ?? 1，两处都有值时必须一致；'
        + '门禁不替调用方选边（选错就等于把某一轮的回执当成这一轮的）',
    });
  }

  if (errors.length > 0) return { round: null, errors, source: 'invalid' };

  if (fromMeta.status === 'ok') return { round: fromMeta.value, errors, source: 'meta' };
  if (fromTask.status === 'ok') return { round: fromTask.value, errors, source: 'task' };
  return { round: 1, errors, source: 'default' };
}

/**
 * 回执上标注的 attempt。
 * @returns {number|null} null = 没有标注（undefined / null / 空串同义）；NaN = 标了但不是正整数
 */
function receiptAttemptOf(receipt) {
  const raw = receipt.attempt;
  if (raw === undefined || raw === null || raw === '') return null;
  return isPositiveInteger(raw) ? raw : Number.NaN;
}

/**
 * 按 meta.attempt 把回执切成 active / stale（G6 分档，blocker L-11 的阻断点）。
 *
 * 决策表（attempt 为归一化后的正整数）：
 *   | meta.attempt | 回执带标 | 结果                                   |
 *   | 1（含缺失）  | 无标     | active —— 引导轮没有"上一轮"可言         |
 *   | 1（含缺失）  | =1       | active                                 |
 *   | 1（含缺失）  | >1 或非法| stale（异常输入，照样拦）               |
 *   | n>1          | 无标     | **stale** —— 无标回执无法证明属于本轮   |
 *   | n>1          | =n       | active                                 |
 *   | n>1          | ≠n 或非法| stale                                  |
 *
 * 注意最后两行的"非法标注"（NaN）走 stale 而不是 active：标了但看不懂 ≠ 没标。
 *
 * @param {Array<object>} receipts
 * @param {number|null} attempt 归一化后的 attempt；null = 形态非法（已在入参层报错，此处不判新旧）
 * @returns {{active: Array<object>, stale: Array<{receipt: object, marked: number|null, reason: string}>}}
 */
function splitReceiptsByAttempt(receipts, attempt) {
  if (attempt === null) return { active: receipts.slice(), stale: [] };

  const active = [];
  const stale = [];
  for (const receipt of receipts) {
    const marked = receiptAttemptOf(receipt);

    if (marked === null) {
      if (attempt === 1) {
        active.push(receipt); // 引导轮：无标回执可用
        continue;
      }
      stale.push({ receipt, marked: null, reason: 'unmarked' });
      continue;
    }

    if (Number.isNaN(marked)) {
      stale.push({ receipt, marked: null, reason: 'invalid' });
      continue;
    }

    if (marked === attempt) {
      active.push(receipt);
      continue;
    }

    stale.push({ receipt, marked, reason: 'mismatch' });
  }

  return { active, stale };
}

/**
 * 把 stale 列表按「原因 + attempt 值」汇总（minor L-2）。
 *
 * 修前：同一条过期回执会从三个地方各报一次 E_STALE_ATTEMPT（过期汇总 / verify 项 / 验收证据），
 * 一条回执刷三行，成员读不出"到底有几条过期回执"。
 * 修后：每个「原因 + attempt 值」只有一条消息，消息里列出涉及的 receipt id，
 * verify 项与验收项作为"受影响项"并入同一条消息（诊断信息不丢，只是不再重复报码）。
 *
 * @param {Array<{receipt: object, marked: number|null, reason: string}>} stale
 * @param {number|null} attempt
 * @returns {{groups: Array<object>, groupOf: (item: object) => object|null}}
 */
function groupStaleReceipts(stale, attempt) {
  /** @type {Map<string, {reason: string, marked: number|null, attempt: number|null, receipts: Array<object>, verifyKeys: Set<string>, criteria: Set<string>}>} */
  const groups = new Map();
  const byItem = new Map();

  for (const item of stale) {
    const key = `${item.reason}#${item.marked === null ? '' : item.marked}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        reason: item.reason,
        marked: item.marked,
        attempt,
        receipts: [],
        verifyKeys: new Set(),
        criteria: new Set(),
      };
      groups.set(key, group);
    }
    group.receipts.push(item.receipt);
    byItem.set(item, group);
  }

  return { groups: [...groups.values()], groupOf: (item) => byItem.get(item) ?? null };
}

/** 一组过期回执 → 一条 E_STALE_ATTEMPT（消息里交代原因、涉及的回执、受影响的 verify 项/验收项）。 */
function staleGroupError(group) {
  const labels = group.receipts.map((receipt, index) => `「${receiptLabel(receipt, index)}」`);

  const impact = [];
  if (group.verifyKeys.size > 0) {
    impact.push(`合同 verify 项${[...group.verifyKeys].map((key) => `「${key}」`).join('、')}只剩过期回执`);
  }
  if (group.criteria.size > 0) {
    impact.push(`验收项${[...group.criteria].map((item) => `「${item}」`).join('、')}引用了过期回执`);
  }
  const tail = impact.length > 0 ? `；${impact.join('；')}` : '';

  if (group.reason === 'unmarked') {
    return {
      code: 'E_STALE_ATTEMPT',
      message:
        `第 ${group.attempt} 轮必须有带 attempt 标的回执：${labels.join('、')}没有 attempt 标，` +
        `无法证明它属于本轮（无标回执只适用于第 1 轮/引导轮），不计入覆盖统计${tail}`,
    };
  }

  if (group.reason === 'invalid') {
    return {
      code: 'E_STALE_ATTEMPT',
      message:
        `${labels.join('、')}的 attempt 标注不是正整数，无法证明它属于本轮（attempt=${group.attempt}），` +
        `不计入覆盖统计${tail}`,
    };
  }

  return {
    code: 'E_STALE_ATTEMPT',
    message:
      `${labels.join('、')}属于别的 attempt（回执标 attempt=${group.marked}，本轮 attempt=${group.attempt}）：` +
      `过期回执不计入覆盖统计${tail}`,
  };
}

/**
 * `toEntryListStrict` 的 reason → 人话（消息里要让成员知道该删/该改什么）。
 * 取值集合来自 contract.mjs 的诊断版解析。
 */
const SCOPE_ILLEGAL_REASONS = Object.freeze({
  traversal: '".." 段（路径穿越，最终没逃出去也不接受）',
  absolute: '绝对路径 / UNC 路径',
  home: '"~" 开头的家目录路径',
  'control-char': '控制字符（能截断底层字符串或伪造多行声明）',
  'encoded-traversal': '百分号编码的 "." / "/" / "\\"（解码后才显形的穿越）',
  colon: '段内冒号（盘符相对写法 / NTFS 数据流）',
  empty: '空条目（写了但没有内容）',
  'not-string': '不是路径字符串',
});

/** reason → 可读描述；未知 reason 原样带出，不吞。 */
function scopeIllegalReasonText(reason) {
  return SCOPE_ILLEGAL_REASONS[reason] ?? `非法路径（${describeValue(reason)}）`;
}

/**
 * 检查 inScope / outOfScope 的**声明本身**是否合法（G7 / minor L-6）。
 *
 * 修前：`inScope: ['../etc']` 只会表现为"申报路径 undeclared → E_OUT_OF_SCOPE"，
 * 成员看到 E_OUT_OF_SCOPE 会去改范围声明之外的东西，而真正该改的是这条非法路径。
 * 修后：对声明里的非法条目先报 E_PATH_UNSAFE（问题在声明），并且不再对申报路径逐个报
 * E_OUT_OF_SCOPE —— 根因只有一个，码要指向它。
 *
 * 判定来源：优先用 contract.mjs 的 `toEntryListStrict`（`{entries, illegal:[{raw,reason}]}`，
 * 与 delivery 侧同一套 reason）。该导出不存在时退回 `normalizePath(raw) === null`，
 * 保证 gates 不因契约模块的导出面变动而整体不可用。
 *
 * @param {Array<{side: string, value: unknown}>} declarations
 * @returns {Array<{raw: string, reason: string, sides: string[]}>}
 */
function collectScopeDeclarationIssues(declarations) {
  /** @type {Map<string, {raw: string, reason: string, sides: Set<string>}>} */
  const issues = new Map();

  const note = (raw, reason, side) => {
    const known = issues.get(raw) ?? { raw, reason, sides: new Set() };
    known.sides.add(side);
    issues.set(raw, known);
  };

  /** 本地兜底判定：与 contract.mjs 的 parsePattern 同一底座（normalizePath 返回 null 即非法）。 */
  const fallbackDiagnose = (value) => {
    const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    /** @type {Array<{raw: unknown, reason: string}>} */
    const illegal = [];
    for (const item of list) {
      if (item === undefined || item === null) continue;
      if (typeof item !== 'string') {
        illegal.push({ raw: item, reason: 'not-string' });
        continue;
      }
      const raw = item.trim();
      if (!raw) {
        illegal.push({ raw: item, reason: 'empty' });
        continue;
      }
      let safe = false;
      try {
        safe = normalizePath(raw) !== null;
      } catch {
        safe = false;
      }
      if (!safe) illegal.push({ raw: item, reason: 'traversal' });
    }
    return illegal;
  };

  for (const declaration of declarations) {
    const side = declaration.side;
    const value = declaration.value;

    let illegal = [];
    if (toEntryListStrict) {
      try {
        illegal = toEntryListStrict(value).illegal ?? [];
      } catch {
        illegal = fallbackDiagnose(value);
      }
    } else {
      illegal = fallbackDiagnose(value);
    }

    for (const entry of illegal) {
      const raw = typeof entry.raw === 'string' ? entry.raw.trim() || entry.raw : describeValue(entry.raw);
      note(raw, scopeIllegalReasonText(entry.reason), side);
    }
  }

  return [...issues.values()].map((issue) => ({
    raw: issue.raw,
    reason: issue.reason,
    sides: [...issue.sides],
  }));
}

/**
 * 解析 acceptanceResults[].evidence，返回回执 id 列表。
 * 必须是 `receipt:<id>`（文件型证据 file:<path> 不再接受：文件存在 ≠ 跑过）。
 * 形式不合法时返回 null。
 */
function evidenceReceiptIds(evidence) {
  const values = Array.isArray(evidence) ? evidence : [evidence];
  const ids = [];
  for (const value of values) {
    if (typeof value !== 'string') return null;
    const match = /^receipt:(\S+)$/.exec(value.trim());
    if (!match) return null;
    ids.push(match[1].trim());
  }
  return ids;
}

/** finding 是否已被解决。缺 status 视为未解决（保守）。 */
function isResolvedFinding(finding) {
  if (finding.resolved === true) return true;
  const status = text(finding.status) || text(finding.state);
  return (
    status === 'resolved' ||
    status === 'closed' ||
    status === 'fixed' ||
    status === 'done' ||
    status === 'verified'
  );
}

/** finding 的可读标题。 */
function findingTitle(finding) {
  return text(finding.title) || text(finding.summary) || text(finding.message) || '(无标题)';
}

/**
 * 解析 review 裁决 —— gates 侧对「评审完成」的唯一出口。
 *
 * 语义（G5 / F-9）：
 *   - verdict='pass' + 无未解决的 blocker/high/critical → deliverable:true（评审算完成）；
 *   - verdict='needs_revision' / 'reject' → **合法裁决，但不是完成**：errors 里带
 *     E_VERDICT_REQUIRED（调用方据此拒绝 completed），同时 deliverable:false；
 *     该裁决本身要落盘到 `task.reviewed.verdict` 供审计与 delivery 复算，
 *     所以这里把 verdict 原样回传，不吞掉。
 *   - verdict 缺失 → E_VERDICT_REQUIRED；拼错（不在白名单）→ E_INPUT_INVALID。
 *   - finding.severity 缺失或拼错 → E_INPUT_INVALID（不许因为不认识的严重度就被当成低危放过）。
 *
 * @param {unknown} payload
 * @returns {{verdict: string, recognized: boolean, deliverable: boolean,
 *            findings: Array<object>, blockingFindings: Array<{severity:string,title:string}>,
 *            errors: Array<{code:string,message:string}>}}
 */
export function resolveReviewVerdict(payload) {
  const source = isObjectLike(payload) ? payload : {};
  const verdict = text(source.verdict);
  const findings = Array.isArray(source.findings) ? source.findings.filter(isObjectLike) : [];

  /** @type {Array<{code: string, message: string}>} */
  const errors = [];
  const push = (code, message) => errors.push({ code, message });

  const recognized = REVIEW_VERDICTS.includes(verdict);

  if (!verdict) {
    push('E_VERDICT_REQUIRED', "review 任务必须给出 verdict='pass' 才能完成（实际：(缺失)）");
  } else if (!recognized) {
    push(
      'E_INPUT_INVALID',
      `verdict="${verdict}" 不是合法裁决：必须是 ${REVIEW_VERDICTS.join(' | ')} 之一（拼错不当作任何非 pass 状态放行）`,
    );
  } else if (!COMPLETION_VERDICTS.includes(verdict)) {
    // needs_revision / reject：裁决成立，但它表示"评审没过"，任务不得 completed。
    push(
      'E_VERDICT_REQUIRED',
      `verdict='${verdict}' 表示评审未通过：该裁决视为未完成，任务不得进入 completed（要改什么写进 findings）`,
    );
    if (findings.length === 0) {
      push('E_FINDINGS_REQUIRED', `verdict='${verdict}' 必须至少给出一条 findings，说明要改什么`);
    }
  }

  /** @type {Array<{severity: string, title: string}>} */
  const blockingFindings = [];
  for (const finding of findings) {
    const severity = text(finding.severity);
    const title = findingTitle(finding);

    if (!severity) {
      push('E_INPUT_INVALID', `finding「${title}」缺 severity：无法判断是否阻止通过（缺失即报错，不按无关紧要放行）`);
      continue;
    }
    if (!REVIEW_SEVERITIES.includes(severity)) {
      push(
        'E_INPUT_INVALID',
        `finding「${title}」severity="${severity}" 不在 ${REVIEW_SEVERITIES.join(' | ')} 之内（拼错不得被当成低危忽略）`,
      );
      continue;
    }

    if (!BLOCKING_SEVERITIES.includes(severity)) continue;
    if (isResolvedFinding(finding)) continue;

    blockingFindings.push({ severity, title });
    if (verdict === 'pass') {
      push('E_OPEN_FINDINGS', `verdict='pass' 但存在未解决的 ${severity} finding：「${title}」`);
    }
  }

  return {
    verdict: recognized ? verdict : '',
    recognized,
    deliverable: errors.length === 0 && blockingFindings.length === 0,
    findings,
    blockingFindings,
    errors,
  };
}

/**
 * 完成门禁：依次执行四关（review 任务额外走裁决路径）。
 *
 * ⓪ 契约可判定性：
 *    ⓪-1 歧义：质量 kind 的契约字段两处声明且异值 → E_CONTRACT_AMBIGUOUS（W2-A）
 *    ⓪-2 完整性：质量 kind 缺 acceptance 或 verify → E_CONTRACT_INCOMPLETE（W2-B / D-8）
 * ① 运行时 verify：回执失败 / 合同 verify 项缺回执 / 只有过期轮次的回执
 * ② 验收对账：acceptance 逐条覆盖 / status=passed / evidence 必须是本轮成功回执
 * ③ diff 对账：实际 vs 申报双向比较 + 申报路径安全 + **作用域声明自身合法** + 落在 inScope 内
 * ④ 字节绑定：implementation 必须有非空 changedPaths
 *
 * 轮次解析链（W2-C / D-7）与 attempt 卫生（G6）都在四关之前：
 * 先判"这是第几轮、这些回执算不算本轮的"，再谈覆盖。
 *
 * work 任务（kind === 'work'）不需要验收与收据，只跑 ③④（以及 attempt 卫生检查）。
 * kind === 'review' 额外检查 verdict / findings，并把裁决挂在结果的 `review` 上。
 *
 * 错误顺序固定为：轮次入参 → 过期汇总 → ⓪-1 → ⓪-2 → ① → ② → ③ → ④ → review。
 * 顺序可预期才可测试；"一次返回全部错误"是本模块的硬要求，任何一关失败都不 early return。
 *
 * 返回值：`{ ok, errors }`；review 任务额外带 `review: {verdict, recognized, deliverable}`，
 * 便于调用方把裁决落盘到 `task.reviewed.verdict`，同时用 `ok === false` 阻止 completed。
 *
 * **`ok === true` 只说明"没查出问题"，不说明"核过"**。要分辨这两件事，用同模块的
 * `judgeCoverage(input)` —— 它回答"这一轮到底核了哪几关、哪几关没核、为什么没核"。
 * 判据是 `judged === false`，不是 `ok === true`。
 *
 * @param {object} input
 *   { task, meta, payload, receipts, diffPaths }
 * @returns {{ok: boolean, errors: Array<{code: string, message: string}>, review?: object}}
 */
/**
 * 这一轮到底核了哪几关、哪几关没核、为什么没核（P2-0 补）。
 *
 * ## 这条为什么必须存在
 *
 * `evaluateCompletion` 的 `ok` 定义一直是"一条错都没发"。它不区分两件事：
 *   - 六条判定路径都真核过了，而且都没查出问题 → **可以交付**；
 *   - 六条里没有任何一条拿得到输入，压根没核 → **不能算交付**。
 * 这两种在 `{ok, errors}` 里字节完全相同（都是 `{ok:true, errors:[]}`）。
 * 实测过：21 条真实形状的任务里 18 条没有 kind、没有契约、没有 diff 输入，
 * 于是它们全部"通过"了。这是本项目点过名的那条红线 —— **空 ≠ 不可用** ——
 * 在门禁层的同一个错误，只是换了个位置。
 *
 * ## 为什么不把这些字段塞进 `evaluateCompletion` 的返回值
 *
 * 那个形状被 19 条既有断言**整对象**比对过。为了"看得见"去逼 19 条断言挪位，
 * 是把代价推给别人；而且改完它们只有两条路：要么变成长得吓人的全量期望
 * （每加一关就 churn 一次），要么被削成一个"忽略新字段"的比较器 ——
 * 后者等于把这些断言**变弱**，而它们本来是能抓住"返回值多冒出一个键"的。
 * 所以做成独立纯函数：原函数的字节一个不动。
 *
 * ## 语义
 *
 * `ok` 说"有没有查出问题"，本函数说"到底核没核"。两者是独立的轴，别合并：
 * `judged === false` 时 `ok === true` 只等于"我没查"，不等于"全绿"。
 *
 * `judgedGates ∪ {每个 notJudged.gate}` 恒等于全部六条路径 —— 不相交、不重复、不遗漏。
 * 这条不变量由 `gates-judged.test.mjs` 的 J-2 钉住：漏掉一条就等于那一关既不判也不出声。
 *
 * @param {object} input 与 `evaluateCompletion` 同形状：{ task, meta, payload, receipts, diffPaths }
 * @returns {{judged: boolean, judgedGates: string[],
 *            notJudged: Array<{gate: string, reason: string}>}}
 */
export function judgeCoverage(input = {}) {
  const source = isObjectLike(input) ? input : {};
  const task = isObjectLike(source.task) ? source.task : {};
  const contract = contractOf(task);
  const payload = isObjectLike(source.payload) ? source.payload : {};
  const meta = isObjectLike(source.meta) ? source.meta : {};

  const kind = text(task.kind);
  const isWork = kind === 'work';
  const isQuality = QUALITY_KINDS.includes(kind);

  const acceptance = normalizeTextList(contract.acceptance);
  const verify = Array.isArray(contract.verify) ? contract.verify : [];
  const verifyKeyList = verify.map((item) => verifyItemKey(item)).filter((key) => key !== '');

  const roundInfo = resolveRound(meta, task, contract);
  const allReceipts = Array.isArray(source.receipts) ? source.receipts.filter(isObjectLike) : [];
  const { active: receipts } = splitReceiptsByAttempt(allReceipts, roundInfo.round);

  const actualPaths = normalizePathEntries(source.diffPaths);
  const declaredPaths = normalizePathEntries(payload.changedPaths);

  const judgedGates = [];
  /** @type {Array<{gate: string, reason: string}>} */
  const notJudged = [];

  // 关⓪（契约可判定性）只在质量类任务上有意义。
  if (isQuality) {
    judgedGates.push('contract');
  } else {
    notJudged.push({
      gate: 'contract',
      reason: kind === ''
        ? 'kind 未声明：契约歧义与契约完整性没有对象可判'
        : `kind=${kind} 不是质量类型，契约可判定性不适用`,
    });
  }

  // 关①（运行时 verify）要有回执或 verify 项才谈得上"核过"；两样都空时它扫的是两个空列表。
  if (!isWork && (receipts.length > 0 || verifyKeyList.length > 0)) {
    judgedGates.push('verify');
  } else if (isWork) {
    notJudged.push({ gate: 'verify', reason: 'work 任务不要求 verify，这一关不适用' });
  } else {
    notJudged.push({ gate: 'verify', reason: '既没有回执、契约也没有 verify 项：没有可对账项' });
  }

  // 关②（验收对账）要有 acceptance 才谈得上对账。
  if (!isWork && acceptance.length > 0) {
    judgedGates.push('acceptance');
  } else if (isWork) {
    notJudged.push({ gate: 'acceptance', reason: 'work 任务不要求验收，这一关不适用' });
  } else {
    notJudged.push({ gate: 'acceptance', reason: '契约没有 acceptance：没有"完成"的定义可对账' });
  }

  // 关③（diff 对账）两侧都空 = 没有任何可比较的东西。
  // 这条最容易被读成"没有越权改动"：没有输入时它确实什么都没说。
  if (declaredPaths.length > 0 || actualPaths.length > 0) {
    judgedGates.push('diff');
  } else {
    notJudged.push({
      gate: 'diff',
      reason: '申报与 diff 两侧都没有路径：没有可对账的东西（**这不等于"没有越权改动"**）',
    });
  }

  // 关④（字节绑定）只对 implementation 有意义。
  if (kind === 'implementation') {
    judgedGates.push('binding');
  } else {
    notJudged.push({ gate: 'binding', reason: 'kind≠implementation，字节绑定不适用' });
  }

  // review 裁决路径只对 review 任务。
  if (kind === 'review') {
    judgedGates.push('review');
  } else {
    notJudged.push({ gate: 'review', reason: 'kind≠review，裁决路径不适用' });
  }

  return { judged: judgedGates.length > 0, judgedGates, notJudged };
}

export function evaluateCompletion(input = {}) {
  const source = isObjectLike(input) ? input : {};
  const task = isObjectLike(source.task) ? source.task : {};
  // G1：契约唯一取值入口。contractOf 现在把 `{}` / null / 非对象一律视为"未声明"并回退 task 顶层，
  // 因此"缺省即未声明"的判定在 gates 侧不受影响（W1 的新语义）。
  const contract = contractOf(task);
  const payload = isObjectLike(source.payload) ? source.payload : {};
  const meta = isObjectLike(source.meta) ? source.meta : {};

  const kind = text(task.kind);
  const isWork = kind === 'work';
  const isQuality = QUALITY_KINDS.includes(kind);

  const acceptance = normalizeTextList(contract.acceptance);
  const verify = Array.isArray(contract.verify) ? contract.verify : [];
  /** 可用（非空）的 verify 项键：`verify: ['']` / `verify: [{}]` 等于没有 verify。 */
  const verifyKeyList = verify.map((item) => verifyItemKey(item)).filter((key) => key !== '');
  const inScope = normalizePatternList(contract.inScope);
  const outOfScope = normalizePatternList(contract.outOfScope);

  // ── 关⓪ 前置：轮次解析链（D-7 / W2-C）───────────────────────────────
  // round = meta.attempt ?? contractOf(task).attempt ?? task.attempt ?? 1
  // 只看 meta 就等于"漏写一个字段就宣布这是第 1 轮"，是 L-11 的第二条入口。
  const roundInfo = resolveRound(meta, task, contract);
  /** null = 轮次不可判定（已报 E_INPUT_INVALID），本轮不做新旧判定 */
  const attempt = roundInfo.round;

  const allReceipts = Array.isArray(source.receipts) ? source.receipts.filter(isObjectLike) : [];
  const { active: receipts, stale: staleReceipts } = splitReceiptsByAttempt(allReceipts, attempt);
  const { groups: staleGroups, groupOf } = groupStaleReceipts(staleReceipts, attempt);

  const actualPaths = normalizePathEntries(source.diffPaths);
  const declaredPaths = normalizePathEntries(payload.changedPaths);

  // 各段错误先各自累积，最后按固定顺序拼接：attempt 入参 → 过期汇总 → ⓪ → ① → ② → ③ → ④ → review。
  /** @type {Array<{code: string, message: string}>} */
  const attemptErrors = [];
  /** @type {Array<{code: string, message: string}>} */
  const contractErrors = [];
  /** @type {Array<{code: string, message: string}>} */
  const gate1Errors = [];
  /** @type {Array<{code: string, message: string}>} */
  const gate2Errors = [];
  /** @type {Array<{code: string, message: string}>} */
  const gate3Errors = [];
  /** @type {Array<{code: string, message: string}>} */
  const gate4Errors = [];
  /** @type {Array<{code: string, message: string}>} */
  const reviewErrors = [];
  const push = (bucket, code, message) => bucket.push({ code, message });

  for (const error of roundInfo.errors) attemptErrors.push(error);

  /** 过期回执按 id 索引：用于把"过期"和"不存在"区分开。 */
  const staleById = new Map();
  for (const item of staleReceipts) {
    const id = text(item.receipt.id);
    if (id && !staleById.has(id)) staleById.set(id, item);
  }

  // ── 关⓪-1 契约歧义（W2-A / F4-2）────────────────────────────────────
  // 同一契约字段在 `task.contract` 与任务顶层各写一份且取值不同 → 拒绝，不选边。
  // 与 validatePlan / canDeliver 的 E_CONTRACT_AMBIGUOUS 同码同义：
  // task_update 是独立入口，能绕过 task_propose，门禁不能是唯一"静默采用 contract 那份"的环节。
  if (isQuality && contractAmbiguityOf) {
    let ambiguousFields = [];
    try {
      ambiguousFields = contractAmbiguityOf(task) ?? [];
    } catch {
      ambiguousFields = [];
    }
    if (ambiguousFields.length > 0) {
      push(
        contractErrors,
        'E_CONTRACT_AMBIGUOUS',
        `契约字段在 task.contract 与任务顶层同时出现且取值不同：${ambiguousFields.join('、')}。`
          + '两套声明只能留一套（contract 优先、不合并）；门禁不替调用方选边——'
          + '选对了是运气，选错了就是"校验器拒、门禁放行"',
      );
    }
  }

  // ── 关⓪-2 契约完整性（W2-B / F4-4 / D-8）─────────────────────────────
  // 质量 kind 必须同时声明 acceptance 与 verify：
  //   - 没有 acceptance → 没有"完成"的定义（不是"验收没覆盖"，是压根没声明）
  //   - 没有 verify     → 关① 没有可对账项，整段跳过 = 门禁能被"不写 verify"关掉
  // 与 delivery 的 E_CONTRACT_INCOMPLETE 同码同义（work 豁免）。
  if (isQuality) {
    const missing = [];
    if (acceptance.length === 0) missing.push('acceptance');
    if (verifyKeyList.length === 0) missing.push('verify');
    if (missing.length > 0) {
      push(
        contractErrors,
        'E_CONTRACT_INCOMPLETE',
        `契约里缺少 ${missing.join(' 与 ')}（kind=${kind}）：质量任务的"完成"必须同时有验收项和验证命令——`
          + '没有 acceptance 就没有完成可判；没有 verify，关① 无项可对账、整段会被跳过，'
          + '等于门禁可以被"少写一个字段"关掉。请把两者写进 contract（或任务顶层）',
      );
    }
  }

  // ── 关① 运行时 verify ────────────────────────────────────────────────
  /** 只被过期回执覆盖的 verify 键 → 归到对应的过期分组（不另报 E_STALE_ATTEMPT/E_VERIFY_MISSING）。 */
  const staleKeys = new Map();
  if (!isWork) {
    const knownKeys = new Set();
    for (const receipt of receipts) {
      for (const key of receiptKeys(receipt)) knownKeys.add(key);
    }

    for (const item of staleReceipts) {
      for (const key of receiptKeys(item.receipt)) {
        if (!staleKeys.has(key)) staleKeys.set(key, item);
      }
    }

    receipts.forEach((receipt, index) => {
      if (receipt.exit_code !== 0) {
        push(
          gate1Errors,
          'E_VERIFY_FAILED_BY_RUNTIME',
          `回执「${receiptLabel(receipt, index)}」exit_code=${describeValue(receipt.exit_code)}，运行时 verify 未通过：任务只能置 failed`,
        );
      }
    });

    for (const item of verify) {
      const key = verifyItemKey(item);
      if (!key) continue;
      if (knownKeys.has(key)) continue;
      const stale = staleKeys.get(key);
      if (stale) {
        // 过期 ≠ 缺失：把受影响的 verify 项并入过期汇总消息（每组一条），不在这里重复报码。
        const group = groupOf(stale);
        if (group) group.verifyKeys.add(key);
        continue;
      }
      push(
        gate1Errors,
        'E_VERIFY_MISSING',
        `合同 verify 项「${key}」没有任何对应回执：无法证明它被运行过`,
      );
    }
  }

  // ── 关② 验收对账 ────────────────────────────────────────────────────
  if (!isWork) {
    const results = Array.isArray(payload.acceptanceResults)
      ? payload.acceptanceResults.filter(isObjectLike)
      : [];

    const receiptById = new Map();
    for (const receipt of receipts) {
      const id = text(receipt.id);
      if (id) receiptById.set(id, receipt);
    }

    for (const criterion of acceptance) {
      const covered = results.some((result) => text(result.criterion) === criterion);
      if (!covered) {
        push(
          gate2Errors,
          'E_ACCEPTANCE_MISMATCH',
          `验收项「${criterion}」在 acceptanceResults 里没有对应记录：合同验收必须逐条覆盖`,
        );
      }
    }

    for (const result of results) {
      const label = text(result.criterion) || '(未命名验收项)';

      if (result.status !== 'passed') {
        push(
          gate2Errors,
          'E_ACCEPTANCE_MISMATCH',
          `验收项「${label}」status=${describeValue(result.status)}，必须为 passed`,
        );
      }

      const ids = evidenceReceiptIds(result.evidence);
      if (ids === null || ids.length === 0) {
        push(
          gate2Errors,
          'E_EVIDENCE_UNBACKED',
          `验收项「${label}」的 evidence 不是 "receipt:<id>" 形式（实际：${describeValue(result.evidence)}）`,
        );
        continue;
      }

      for (const id of ids) {
        const receipt = receiptById.get(id);
        if (!receipt) {
          const stale = staleById.get(id);
          if (stale) {
            // 过期 ≠ 不存在：并入该组过期汇总消息，别在这里重复报第三条码（L-2）。
            const group = groupOf(stale);
            if (group) group.criteria.add(label);
            continue;
          }
          push(gate2Errors, 'E_EVIDENCE_UNBACKED', `验收项「${label}」引用的回执「receipt:${id}」不存在`);
          continue;
        }
        if (receipt.exit_code !== 0) {
          push(
            gate2Errors,
            'E_EVIDENCE_UNBACKED',
            `验收项「${label}」引用的回执「receipt:${id}」exit_code=${describeValue(receipt.exit_code)}，不是成功回执`,
          );
        }
      }
    }
  }

  // ── 过期回执汇总（G6 / L-2）─────────────────────────────────────────
  // 每组「原因 + attempt 值」一条，且放在四关之前：这是"本轮证据不成立"的根因。
  const staleErrors = staleGroups.map(staleGroupError);

  // ── 关③ diff 对账 ──────────────────────────────────────────────────
  const actualTokens = new Set(actualPaths.map((entry) => entry.token));
  const declaredTokens = new Set(declaredPaths.map((entry) => entry.token));

  for (const entry of actualPaths) {
    if (!declaredTokens.has(entry.token)) {
      push(gate3Errors, 'E_UNREPORTED_CHANGES', `路径「${entry.token}」实际被改动，但没有出现在 changedPaths 申报里`);
    }
  }

  for (const entry of declaredPaths) {
    if (!actualTokens.has(entry.token)) {
      push(gate3Errors, 'E_PHANTOM_CHANGES', `路径「${entry.token}」被申报改动，但实际 diff 里不存在`);
    }
  }

  // 路径安全：申报侧与 diff 侧都不许出现工作区外的路径（绝对路径 / .. 穿越 / ~ / 盘符 / 控制字符）。
  // 同一条路径只报一次（两侧都出现时在消息里点明），避免同一根因翻倍刷屏。
  const unsafePaths = new Map();
  const trackUnsafe = (entry, side) => {
    if (entry.safe) return;
    const known = unsafePaths.get(entry.token) ?? { raw: entry.raw, declared: false, actual: false };
    known[side] = true;
    unsafePaths.set(entry.token, known);
  };
  for (const entry of declaredPaths) trackUnsafe(entry, 'declared');
  for (const entry of actualPaths) trackUnsafe(entry, 'actual');
  for (const [token, info] of unsafePaths) {
    const side = info.declared && info.actual
      ? '申报与 diff 都出现'
      : info.declared
        ? '来自 changedPaths 申报'
        : '来自 diff';
    push(
      gate3Errors,
      'E_PATH_UNSAFE',
      `路径「${info.raw}」不是安全的工作区相对路径（绝对路径、".." 穿越、"~" 开头都不接受；${side}）`,
    );
  }

  // 作用域声明本身非法（G7 / minor L-6）：`inScope: ['../etc']` 的问题在声明，不在某个申报路径。
  // 先报 E_PATH_UNSAFE，并且不再对申报路径逐个报 E_OUT_OF_SCOPE —— 那会把成员引去改范围声明。
  const scopeIssues = collectScopeDeclarationIssues([
    { side: 'inScope', value: contract.inScope },
    { side: 'outOfScope', value: contract.outOfScope },
  ]);
  for (const issue of scopeIssues) {
    push(
      gate3Errors,
      'E_PATH_UNSAFE',
      `作用域声明「${issue.raw}」本身非法（写在 ${issue.sides.join(' / ')} 里）：${issue.reason}；`
        + '要改的是这条声明，不是别的路径的归属',
    );
  }

  // 范围审计：申报了改动就必须有范围依据；否则整段不能跳过（G2 / F-3）。
  // 声明本身非法时只报 E_PATH_UNSAFE：根因是声明，不是"越界"（诊断要指向该改的地方）。
  if (scopeIssues.length === 0) {
    if (declaredPaths.length > 0 && inScope.length === 0 && outOfScope.length === 0) {
      const sample = declaredPaths.slice(0, 3).map((entry) => entry.token).join('、');
      const more = declaredPaths.length > 3 ? ` 等 ${declaredPaths.length} 条` : '';
      push(
        gate3Errors,
        'E_SCOPE_UNDECLARED',
        `任务申报了改动（${sample}${more}），但契约没有声明任何 inScope / outOfScope：没有范围就没有审计依据，一律拒绝`,
      );
    } else if (inScope.length > 0 || outOfScope.length > 0) {
      for (const entry of declaredPaths) {
        // 已报 E_PATH_UNSAFE 的条目不再报"越界"：该改的是路径，不是范围声明（诊断要准确）。
        if (!entry.safe) continue;
        const verdict = classifyPathSafe(entry.token, inScope, outOfScope);
        if (verdict !== 'in_scope') {
          push(
            gate3Errors,
            'E_OUT_OF_SCOPE',
            `申报路径「${entry.token}」不在本任务 inScope 内（判定：${verdict}）`,
          );
        }
      }
    }
  }

  // ── 关④ 字节绑定（仅 implementation）────────────────────────────────
  if (kind === 'implementation' && declaredPaths.length === 0) {
    push(
      gate4Errors,
      'E_CHANGED_PATHS_REQUIRED',
      'implementation 任务必须申报非空 changedPaths：没有改动就没有可交付的字节',
    );
  }

  // ── review 裁决路径 ─────────────────────────────────────────────────
  let review = null;
  let reviewDeliverable = false;
  if (kind === 'review') {
    const outcome = resolveReviewVerdict(payload);
    for (const error of outcome.errors) reviewErrors.push(error);
    review = {
      verdict: outcome.verdict,
      recognized: outcome.recognized,
      // 可交付 = 裁决认账 + 无阻止性 finding + 本次门禁整体没问题（在拼完 errors 后回填）。
      deliverable: false,
      blockingFindings: outcome.blockingFindings,
    };
    reviewDeliverable = outcome.deliverable;
  }

  // 固定顺序拼接（顺序稳定才可测试、可读）：attempt 入参 → 过期汇总 → ⓪ → ① → ② → ③ → ④ → review。
  const errors = [
    ...attemptErrors,
    ...staleErrors,
    ...contractErrors,
    ...gate1Errors,
    ...gate2Errors,
    ...gate3Errors,
    ...gate4Errors,
    ...reviewErrors,
  ];

  if (review) review.deliverable = reviewDeliverable && errors.length === 0;

  const result = { ok: errors.length === 0, errors };
  if (review) result.review = review;
  return result;
}
