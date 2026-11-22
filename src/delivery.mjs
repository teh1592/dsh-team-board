/**
 * 交付判定（delivery gate）——纯函数。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 设计要点（第 3 轮修订）
 * ─────────────────────────────────────────────────────────────────────────────
 * 1) 收集全部 blocker 后一次性返回，绝不在第一个 blocker 处短路。
 * 2) 纯函数：不读写文件、不改入参、无副作用、零依赖（唯一依赖 contract.mjs）。
 * 3) **契约字段只有一个读取入口**：contractOf(task)。本模块不再逐字段回退顶层。
 *    理由（D7）：contractOf 的语义是"contract 是非空普通对象就以它为唯一来源，**不与顶层合并**"。
 *    以前这里用 field(key) 逐字段回退，等于在最后一道门上把两套声明合并起来读 ——
 *    同一份"混合写法"任务，validatePlan 拒、evaluateCompletion 放行、canDeliver 也放行，
 *    信息最全的那个判定最松，方向正好反了。现在三个模块读同一份契约，答案必须同向。
 * 4) phase 是**正向白名单**（D8）：只有 "running" 才能交付。
 *    负列表（staged/halted/archived 之外全放行）会把缺失、空串、大小写不符、拼错一并放过 ——
 *    "只有运行中的团队才能交付"这句话就变成了"除了三个坏值之外都能交付"。
 * 5) attempt 统一不变量「缺省即第 1 轮」（D-7）：`round = contractOf(task).attempt ?? task.attempt ?? 1`，
 *    缺省显式落在 1（`ROUND_BOOTSTRAP`）；非正整数（'2' / 2.5 / 0 / true）一律 E_INPUT_INVALID，
 *    不许静默降级成"不做新旧判定"。attempt 是**任务记录字段**（与 gates 的 meta.attempt 同一语义），
 *    不是契约字段，所以它保留"契约优先、任务记录兜底"这条显式取值链；其余契约字段没有这条链。
 *    链路顺序与 gates 完全一致：`meta` 与任务侧的一致性由 gates 校验，delivery 采信其结果。
 * 6) 区分但不双报（D10）：审后篡改只报 E_BINDING_STALE（刺眼的篡改信号），
 *    不再顺手叠加一条 E_UNBOUND_ARTIFACT（那会让人以为"漏审"，把真正该看的"文件被改了"稀释掉）。
 *
 * 唯一外部依赖是同目录的 contract.mjs：
 *   contractOf(task)            契约唯一取值入口（{} / null / 非对象 → 回退 task 本身）
 *   contractAmbiguity(task)     两处同时出现且值不同的契约字段名
 *   toEntryList(value)          inScope/outOfScope 的条目展开（'src/' 保留目录语义）
 *   toEntryListStrict(value)    { entries, illegal:[{raw, reason}] }
 *   describePathIllegal(reason) 非法原因码 → 中文人话（**唯一一份**，本模块不自带中文表）
 *   PATH_ILLEGAL_REASONS        非法原因码的冻结枚举（跨模块契约）
 *   classifyPath(path, inScope, outOfScope) -> 'in_scope' | 'out_of_scope' | 'undeclared'
 *   normalizePath(p)            非法路径返回 null
 *
 * 接口探测：contractOf 的修订语义、contractAmbiguity、toEntryListStrict 是 W1 在 contract.mjs
 * 交付的。公共导出到位就用公共实现（单一语义），未到位就用**逐字同义**的本地实现，
 * 并在 describeDeliveryContract().contractSource 里如实标明当前用的是哪一边 ——
 * 绝不出现"两套语义各跑各的"。契约接口本身是锁定件：缺了就直接在装载期炸掉。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 模块层已知缺口（记账，不在本模块伪造 actor）
 * ─────────────────────────────────────────────────────────────────────────────
 *   E_SELF_REVIEW        需要"谁提交、谁评审"的身份。四个纯函数模块只拿到
 *                        kind/status/changedPaths/contract/reviewed，没有任何可信的 actor 来源。
 *                        属于插件层 / agent 身份层职责：调用 canDeliver 之前独立比对
 *                        reviewerSessionId !== implSessionId。
 *   E_SELF_REVIEW 登记在 describeDeliveryContract().pluginLayer 里（第 12 轮后这张表只剩它一个），
 *   禁止在本模块硬造假 actor 参数。
 *
 * 第 12 轮（C-2）删除 E_NO_ARTIFACT_BINDING，理由写在这里而不是只写在提交信息里：
 *   它原本记的是"某实现任务声称改了文件、却没有任何评审绑定这些文件"。这个条件已经被
 *   E_UNBOUND_ARTIFACT 以 **blocker** 级强制（见 canDeliver 第 14 段：按 (owner, path) 建索引，
 *   要求 reviewedTaskId/sourceTaskId 指向申报者本人、artifacts 里该 path 的 sha256 等于当前指纹）。
 *   再补一个 warning 级同义码，就是"同一缺陷两个码"——本模块在 coveredElsewhere 的
 *   E_BINDING_OWNER_MISMATCH 上已经定过这条规矩，缺口表没有理由例外。
 *   真正判不了的那半截是"这个任务**本应**产生几个产物"（下界），它要宿主把 diffPaths /
 *   currentDigests 当审计输入喂进来，属于插件层的审计接线；模块层不该靠一个码名暗示"我们会查"。
 *   因此它不再出现在 pluginLayer（缺口）里，而是登记进 coveredElsewhere（谁在替它把关）。
 */

import * as contractModule from './contract.mjs';

/* ------------------------------------------------------------------------- */
/* 契约依赖：公共实现优先，语义相同的本地实现只在公共导出缺失时启用             */
/* ------------------------------------------------------------------------- */

/** 契约接口是锁定件；缺失/改名必须在装载期就炸，而不是运行时静默少一条判定。 */
function requiredExport(name) {
  const value = contractModule[name];
  if (typeof value !== 'function') {
    throw new TypeError(
      `contract.mjs 必须导出 ${name}（交付判定的唯一契约入口）；当前缺失或不是函数。`,
    );
  }
  return value;
}

const publicContractOf = requiredExport('contractOf');
const publicToEntryList = requiredExport('toEntryList');
const publicNormalizePath = requiredExport('normalizePath');
const publicNormalizeIdentity = requiredExport('normalizeIdentity');
const publicClassifyPath = requiredExport('classifyPath');
const publicContractAmbiguity = typeof contractModule.contractAmbiguity === 'function'
  ? contractModule.contractAmbiguity
  : null;
const publicToEntryListStrict = typeof contractModule.toEntryListStrict === 'function'
  ? contractModule.toEntryListStrict
  : null;
/**
 * 非法原因 → 中文人话的唯一来源（W3-1）。契约导出到位就用它，本模块**不再自带一份中文表**：
 * 两份中文串必然漂移，而 E_PATH_UNSAFE 的 message 是运维唯一能看到的修法指引。
 */
const publicDescribePathIllegal = typeof contractModule.describePathIllegal === 'function'
  ? contractModule.describePathIllegal
  : null;
/** 非法原因的冻结枚举（跨模块契约）。缺失时只是少一层漂移自检，不影响判定。 */
const publicPathIllegalReasons = Array.isArray(contractModule.PATH_ILLEGAL_REASONS)
  ? contractModule.PATH_ILLEGAL_REASONS
  : null;

/** @returns {boolean} */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 契约唯一取值入口。契约字段一律从这里读，不直接摸 task.contract，也不回退 task[key]。
 *
 * **只有一个实现**：`contract.contractOf`。`requiredExport` 保证它在装载期就存在，
 * 缺了/改名了模块直接装不上 —— 那才是正确行为。
 *
 * F8（已删）：这里曾有一份"本地修订版副本" `contractOfStrict`，外加加载期嗅探
 * `publicContractOfIsStrict()` + 常量 `CONTRACT_OF_IS_STRICT` 决定用哪一份，且嗅探带
 * `catch { return false }`。三重问题：
 *   1. 那份副本**没有任何测试覆盖**（实测把它改成恒 `return {}` 仍 137 条全绿）；
 *   2. 任何一次抛错（包括上游临时 bug）都会把 delivery 静默切到那份没人测过的实现；
 *   3. gates/board 用公共实现、delivery 用副本 → 同一任务两种契约解读，
 *      "校验器放行、交付器拒绝"，且**没有任何日志**。
 * 契约只能有一个实现：缺了就装不上，不要静默兜底（台账第 5 条同一形态）。
 * @param {unknown} task
 * @returns {object} 永远是普通对象
 */
function contractOf(task) {
  const resolved = publicContractOf(task);
  // 形状兜底只防"公共实现返回非对象"这种接口违约，不再承载任何语义分支
  return isPlainObject(resolved) ? resolved : {};
}

/** 值相等判定（用于"两处声明值是否不同"）。 */
function sameValue(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** 参与 E_CONTRACT_AMBIGUOUS 判定的契约字段。attempt 不在其中（它有显式取值链，见文件头）。 */
const CONTRACT_FIELDS = Object.freeze([
  'acceptance',
  'verify',
  'inScope',
  'outOfScope',
  'objective',
  'reviewedTaskId',
]);

/**
 * contractAmbiguity 的本地等价实现：contract 是非空对象、且同一字段在顶层也出现、且值不同。
 * 只列字段名，不选边 —— 选边就是"自作聪明"，两边都可能对，唯一正确的做法是拒绝。
 * @param {unknown} task
 * @returns {string[]}
 */
function localContractAmbiguity(task) {
  if (!isPlainObject(task)) return [];
  const declared = task.contract;
  if (!isPlainObject(declared) || Object.keys(declared).length === 0) return [];
  const names = [];
  for (const field of CONTRACT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(declared, field)) continue;
    if (!Object.prototype.hasOwnProperty.call(task, field)) continue;
    if (!sameValue(declared[field], task[field])) names.push(field);
  }
  return names;
}

/**
 * 两处同时存在且值不同的契约字段名。公共实现优先（保证与 validatePlan 同一口径）。
 * @param {unknown} task
 * @returns {string[]}
 */
function contractAmbiguityOf(task) {
  if (publicContractAmbiguity) {
    try {
      const names = publicContractAmbiguity(task);
      if (Array.isArray(names)) return names.filter((name) => typeof name === 'string' && name !== '');
    } catch {
      // 公共实现抛错：退回本地等价实现，绝不让"探测失败"变成"没有歧义"
    }
  }
  return localContractAmbiguity(task);
}

/* ------------------------------------------------------------------------- */
/* 常量                                                                       */
/* ------------------------------------------------------------------------- */

/** 团队阶段白名单（D8）：只有 running 具备交付资格。其余一律拒绝，包括拼错。 */
const PHASE_RUNNING = 'running';
const PHASE_STAGED = 'staged';
/** 明确的两个"已停"阶段：报 E_NOT_RUNNING（不是"等批准"，是真的停了）。 */
const PHASE_STOPPED = new Set(['halted', 'archived']);

/**
 * 会改动工作区内容的任务种类：需要做范围校验、路径认领与产物绑定校验。
 * 只有 implementation。repair 不在 contract.mjs 的 KINDS（implementation|review|work）里，
 * 过不了 validatePlan，留着就是不可达分支；"修复轮"用 implementation + sourceTaskId 表达。
 */
const CODE_CHANGING_KINDS = new Set(['implementation']);

/**
 * 需要质量声明（acceptance / verify）的 kind；work 只是纯执行项，不设门禁。
 *
 * C-1（第 12 轮）：这里**不再有副本**。以前是 `new Set(['implementation','review'])`，
 * 与 contract.mjs:55 的冻结数组、gates.mjs 的字面量三份并存，且**形态不同**
 * （gates 用 `.includes`、本模块用 `.has`）——加第三个 kind 时漏一处**不报错、只静默少判**。
 * 现在读 contract.mjs 的同一份数组，判定形态也统一成 `.includes`：
 * 两处同形，连"漏改时两边一起错"的可能性都只剩一种。
 *
 * 契约件缺失/未冻结 → 装载期抛错（与上面 requiredExport 同一条原则：
 * 交付判定宁可装不上，也不要带着"少判一个 kind"跑）。
 */
const { QUALITY_KINDS } = contractModule;
if (!Array.isArray(QUALITY_KINDS) || !Object.isFrozen(QUALITY_KINDS)) {
  throw new TypeError(
    'contract.mjs 必须导出冻结数组 QUALITY_KINDS（质量声明的唯一口径）；'
      + '当前缺失、不是数组或未冻结。交付判定拒绝以"少判一条"的方式启动。',
  );
}

/** 只读调研类任务：不产生工作区变更，申报 changedPaths 本身就是伪造。 */
const READ_ONLY_KIND = 'work';

/** 评审类任务。 */
const REVIEW_KIND = 'review';

/**
 * 提案类任务（task-21 开会与方案流程）：产出一份方案，可以只写文档、不改代码。
 *
 * 与 `READ_ONLY_KIND` / `REVIEW_KIND` 同一族：这些是**判定里要比较的字面量**，
 * 集中在这里，不在各处散写 `'proposal'`。注意 kind **白名单**不在这里
 * （那份已改为从 `contract.mjs` 的 `KINDS` 派生，见上面），这里只是"判定时要比的常量"。
 */
const PROPOSAL_KIND = 'proposal';

/**
 * 实现类任务（task-22 开会是必须的）：**唯一**被要求先开会的 kind。
 *
 * 为什么只认它：`work` 是纯执行项（不设门禁）、`review` 是判定别人已经做完的活、
 * `proposal` 本身就是会。要求这三类"先开会"会变成循环 —— 提案要先开一个会来产出提案。
 * `implementation` 是唯一"会真的改动工作区、且值得先商量"的类别。
 */
const IMPLEMENTATION_KIND = 'implementation';

/** `proposalId` 的字面量例外：声明"这次跳过开会"。必须同时给 `skipMeeting` 理由。 */
const SKIP_MEETING = 'skip';

/**
 * kind 白名单 —— **与 `QUALITY_KINDS` 同一治法：不再有副本，读 contract.mjs 的同一份数组**。
 *
 * 第 17 轮实测的缺陷：这里原来是 `new Set(['implementation','review','work'])` 的字面量，
 * 而 `contract.mjs` 的 `KINDS` 在 task-21 之后已经是四个（多了 `proposal`）。
 * 后果**不是报错**，而是 `kind: proposal` 的任务在真实交付判定里被 `E_INPUT_INVALID` 拒掉 ——
 * 一份提案永远无法交付。而且 `grep KNOWN_KINDS plugin/test/` **零匹配**：没有任何测试覆盖它。
 *
 * 这就是 `QUALITY_KINDS` 当初三份副本的同一个病，换了个变量名又犯了一次。
 * 治法也照抄：直接从 contract.mjs 取，读者只有一个，不给自己留副本的余地。
 *
 * 装载期校验与上面 `QUALITY_KINDS` 同一条原则：**宁可装不上，也不要带着"少判一个 kind"跑**。
 */
const { KINDS } = contractModule;
if (!Array.isArray(KINDS) || !Object.isFrozen(KINDS)) {
  throw new TypeError(
    'contract.mjs 必须导出冻结数组 KINDS（kind 白名单的唯一口径）；'
      + '当前缺失、不是数组或未冻结。交付判定拒绝以"少判一个 kind"的方式启动。',
  );
}

/** status 白名单（与 gates.mjs 状态机的节点同口径）。 */
const KNOWN_STATUSES = new Set([
  'pending',
  'claimed',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
]);

/** 仍在流程中的状态：只有这些才属于"任务未完成"。 */
const IN_FLIGHT_STATUS = new Set(['pending', 'claimed', 'in_progress']);

const COMPLETED = 'completed';

/** classifyPath 的合法三态。任何其它返回值都是编程错误，必须抛出而不是收敛。 */
const VERDICTS = new Set(['in_scope', 'out_of_scope', 'undeclared']);

/** 宿主签发记录的 by 前缀（规格 §7：delivered.by = "host:actionCard"）。 */
const HOST_ISSUER_PREFIX = 'host:';

/* ------------------------------------------------------------------------- */
/* 路径与取值小工具                                                            */
/* ------------------------------------------------------------------------- */

/**
 * 宽容路径键：反斜杠转正斜杠、去掉 "./" 前缀、折叠重复斜杠、去掉尾部斜杠。
 * 只用于**键**（currentDigests / changedPaths / diffPaths 的比对 token），不用于范围判定。
 * @param {unknown} input
 * @returns {string}
 */
function lenientPathKey(input) {
  if (typeof input !== 'string') return '';
  let s = input.trim();
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * 严格归一化：非法返回 null。契约里 normalizePath 是锁定导出，不存在"缺失"分支
 * （L-12 删掉的死代码就是那个 `!contractNormalizePath` 兜底判断）。
 * @param {unknown} input
 * @returns {string|null}
 */
function strictNormalize(input) {
  try {
    const normalized = publicNormalizePath(input);
    return typeof normalized === 'string' && normalized !== '' ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * diffPaths / changedPaths / artifacts[].path / currentDigests 的 key 统一走这里。
 *
 * 先问契约的严格版（非法返回 null）；契约判定为不安全的路径（绝对路径、`..`、`~`）
 * 仍然保留为宽容键继续参与比对 —— 绝不能因为"规范化失败"就把它静默丢弃，
 * 丢弃等于 fail-open（`../../etc/passwd` 会凭空消失）。
 * 非法这件事由 E_PATH_UNSAFE 单独点名（D11），不再靠"越界"暗示。
 * @param {unknown} input
 * @returns {string}
 */
function normalizePath(input) {
  const lenient = lenientPathKey(input);
  if (!lenient) return '';
  return strictNormalize(input) ?? lenient;
}

/**
 * 一条路径/模式非法时的原因**码**。返回 null = 安全。
 *
 * 产出的是 contract.mjs `PATH_ILLEGAL_REASONS` 里的 token（顺序 = diagnosePattern 的拒绝顺序），
 * 中文人话统一由 `describePathIllegal` 提供（见下）。这里只做"审计对象"（changedPaths /
 * diffPaths）的分类——它们不经过 toEntryListStrict，但必须报同一个码、同一句话，
 * 否则同一类非法路径会因为"写在哪一侧"而给出两套诊断。
 * @param {unknown} raw
 * @returns {string|null}
 */
function pathIssueCode(raw) {
  if (typeof raw !== 'string') return 'not-string';
  const trimmed = raw.trim();
  if (trimmed === '') return 'empty';
  if (trimmed.startsWith('~')) return 'home';
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return 'control-char';
  if (/%(2e|2f|5c)/i.test(trimmed)) return 'encoded-traversal';
  const posix = trimmed.replace(/\\/g, '/');
  if (posix.startsWith('/')) return 'absolute';
  if (/^[A-Za-z]:/.test(posix)) return 'absolute';
  const segments = posix.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (segments.length === 0) return 'empty';
  if (segments.includes('..')) return 'traversal';
  if (segments.some((seg) => seg.includes(':'))) return 'colon';
  return null;
}

/**
 * 非法原因码 → 中文人话。**只有一份实现**（契约的 describePathIllegal）。
 *
 * 契约导出缺失时的兜底是**一句不带分类**的通用话，不是第二张中文表：
 * 通用话不会与契约漂移（它不含任何 reason 语义），而且装载期就能从
 * describeDeliveryContract().contractSource.describePathIllegal 看出来降级了。
 * @param {unknown} code
 * @returns {string}
 */
function illegalReasonText(code) {
  if (publicDescribePathIllegal) {
    try {
      const text = publicDescribePathIllegal(code);
      if (typeof text === 'string' && text !== '') return text;
    } catch {
      // 契约实现抛错 → 走通用兜底，绝不让错误消息生成失败
    }
  }
  return '不是安全的工作区相对路径';
}

/** toEntryList 的安全调用（契约实现抛错时按空处理，绝不因展开失败而放行）。 */
function safeToEntryList(value) {
  try {
    const entries = publicToEntryList(value);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

/**
 * toEntryListStrict 的本地等价实现：`{ entries, illegal:[{raw, reason}] }`。
 * entries 与 toEntryList 同形；illegal 的 raw 是原始条目、reason 是原因码，
 * 与 contract.mjs 的同名导出同一形状、同一套原因码。
 * @param {unknown} value
 * @returns {{entries:Array<object>, illegal:Array<{raw:unknown, reason:string}>}}
 */
function localToEntryListStrict(value) {
  const entries = safeToEntryList(value);
  const illegal = [];
  const list = value === undefined || value === null
    ? []
    : (Array.isArray(value) ? value : [value]);

  for (const item of list) {
    const rawValue = isPlainObject(item) ? item.path : item;
    const code = pathIssueCode(rawValue);
    if (code) illegal.push({ raw: item, reason: code });
  }
  return { entries, illegal };
}

/**
 * 展开范围声明并同时拿到非法条目。
 * @param {unknown} value
 * @returns {{entries:Array<object>, illegal:Array<{raw:unknown, reason:string}>}}
 */
function toEntryListStrict(value) {
  if (publicToEntryListStrict) {
    try {
      const result = publicToEntryListStrict(value);
      if (result && Array.isArray(result.entries) && Array.isArray(result.illegal)) {
        return { entries: result.entries, illegal: result.illegal };
      }
    } catch {
      // 公共实现异常 → 本地等价实现兜底，绝不让"探测失败"变成"没有非法声明"
    }
  }
  return localToEntryListStrict(value);
}

/**
 * 把 `illegal` 收敛成"确实写了一条非法声明"的条目：
 *   - 字段整个没写（undefined / null）→ 不是非法声明，只是没声明（这个区别很关键：
 *     "没写 outOfScope" 与 "outOfScope: ['../etc']" 是完全不同的两件事，混在一起会让
 *     每个任务都凭空多一条 E_PATH_UNSAFE）；
 *   - 空串 / 纯空白 → 视为没写（toEntryList 自己也是这么跳过的）；
 *   - 其余（.. 穿越、绝对路径、~、控制字符、编码穿越、冒号、非字符串、'.'）→ 真非法。
 *
 * 说明：contract.mjs 已在源头把"整值缺席/整值空串"处理成 `{entries:[], illegal:[]}`
 * （第 4 轮 W1-1 的连带修复）。这里这两条 continue 是**防御**——若哪天契约实现回退成
 * "undefined 也算非法"，本模块不会因此给每个任务刷 E_PATH_UNSAFE。
 * @param {unknown} value
 * @param {'inScope'|'outOfScope'} field
 * @returns {Array<{field:string, raw:unknown, reason:string}>}
 */
function declaredIllegal(value, field) {
  const { illegal } = toEntryListStrict(value);
  const shaped = [];
  const seen = new Set();
  for (const item of illegal) {
    const raw = isPlainObject(item.raw) ? item.raw.path : item.raw;
    if (raw === undefined || raw === null) continue; // 没写 ≠ 非法（契约已修，这里是防御）
    if (typeof raw === 'string' && raw.trim() === '') continue; // 空串 = 没写（同上）
    const key = `${field}\u0000${typeof raw}\u0000${String(raw)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    shaped.push({ field, raw, reason: illegalReasonText(item.reason) });
  }
  return shaped;
}

/** 非法的"审计对象"路径（changedPaths / diffPaths）→ 原因。null = 安全。 */
function auditPathIssue(raw) {
  const code = pathIssueCode(raw);
  return code ? illegalReasonText(code) : null;
}

/**
 * 单条路径是否落在任务声明的范围内。
 * 严格三态：classifyPath 返回别的东西说明契约被改坏了，直接抛（编程错误要暴露）。
 * @param {string} path
 * @param {string[]} inScope
 * @param {string[]} outOfScope
 * @returns {'in_scope'|'out_of_scope'|'undeclared'}
 */
function scopeVerdict(path, inScope, outOfScope) {
  const verdict = publicClassifyPath(path, inScope, outOfScope);
  if (!VERDICTS.has(verdict)) {
    throw new TypeError(
      `classifyPath 返回了非三态值 ${JSON.stringify(verdict)}（path=${JSON.stringify(path)}）；`
        + '契约只允许 in_scope / out_of_scope / undeclared',
    );
  }
  return verdict;
}

/** @param {unknown} value @returns {string|undefined} */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 一条 blocker 的「右端点」能不能用：只认**非空字符串**。
 *
 * 为什么不是 `!== ''` 就够：`'  '` 这种空白串在宿主任务板上不对应任何任务，把它当端点
 * 等于给一条不存在的归属造句。这里只判"能不能用"，**不改写值** —— 端点必须与
 * `task.id` 逐字相同，页面才能按 id 匹配到节点。
 * @param {unknown} value
 * @returns {string|null} null = 没有可用归属（调用方不许再兜一个猜的值）
 */
function attributableId(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * 归一化任务身上**可当端点**的 id：任务在输入里真的写了 id 才算。
 *
 * `normalizeTask` 在任务没有 id 时会造一个 `#0` / `#1` 的占位 id —— 那个 id 只是本模块
 * 内部用来指代的，宿主任务板上并不存在同名任务。把它当端点会画出一条指向空节点的线，
 * 那比"没有线"更坏（把不知道说成知道）。
 * @param {any} task
 * @returns {string} 空串 = 这条任务没有可用的端点
 */
function taskIdOf(task) {
  return task?.idDeclared === true ? task.id : '';
}

/**
 * 把"可能有多条候选"的归属收敛成唯一端点：**恰好一个**候选才算明确。
 *
 * 0 个候选 → 这条 blocker 根本不针对某一条任务（团队阶段不对、宿主没签交付）；
 * ≥2 个候选 → 分不清是哪一条（两条实现任务抢同一条路径）；
 * 候选里出现空串 → 有一条被命中的任务叫不出名字。
 * 三种情况一律返回空串（= 不传这个键）。猜一个 id 会让图上出现一条"看起来有归属、
 * 其实没有"的线 —— 那是不如不画的，因为它把不知道说成知道。
 * @param {Iterable<string>} ids
 * @returns {string} 空串 = 无法唯一归属
 */
function soleTaskId(ids) {
  const unique = new Set();
  for (const id of ids) {
    const usable = attributableId(id);
    if (usable === null) return ''; // 有一条被命中的任务叫不出名字 → 整体不许点名
    unique.add(usable);
    if (unique.size > 1) return ''; // 两条以上 → 分不清，不猜
  }
  return unique.size === 1 ? [...unique][0] : '';
}

/**
 * 一组归一化任务的端点收敛（口径同 soleTaskId）。
 * @param {Iterable<object>} tasks
 * @returns {string}
 */
function soleOfTasks(tasks) {
  return soleTaskId([...tasks].map(taskIdOf));
}

/** 文本型列表：单字符串算一条，其余数组保留非空字符串。 */
function textList(value) {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim() !== '');
}

/**
 * 把一个值渲染成可读片段（错误消息用）。
 * undefined / null / 空串各有专门说法：它们在本模块里代表不同的"缺失形态"。
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
  if (value === undefined) return '缺失';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.trim() === '' ? '空字符串' : JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------------- */
/* attempt / 轮次                                                             */
/* ------------------------------------------------------------------------- */

/** attempt 统一不变量：缺省即第 1 轮（D-7）。这个名字就是"1"的来源，别处不许写裸 1。 */
const ROUND_BOOTSTRAP = 1;

/**
 * 单个标量的形态判定（D-7）。
 *   - undefined / null（JSON 往返里"没写"的两种样子）→ missing
 *   - 正整数 number                                  → ok
 *   - 其余（'2' / 2.5 / 0 / -1 / true / {} / []）     → invalid（E_INPUT_INVALID，不许降级）
 * @param {unknown} value
 * @returns {{status:'missing'|'ok'|'invalid', round:number|null}}
 */
function classifyRoundScalar(value) {
  if (value === undefined || value === null) return { status: 'missing', round: null };
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return { status: 'ok', round: value };
  }
  return { status: 'invalid', round: null };
}

/**
 * 任务记录形态：`{ n, id }` 取 `n`（团队存储与 gates 夹具都这么写），标量原样判定。
 * 对象但没有 `n` → invalid："记了 attempt 但读不懂" ≠ "没记"，后者才是第 1 轮。
 * @param {unknown} value
 * @returns {{status:'missing'|'ok'|'invalid', round:number|null}}
 */
function classifyTaskAttempt(value) {
  if (isPlainObject(value)) {
    if (!Object.prototype.hasOwnProperty.call(value, 'n')) return { status: 'invalid', round: null };
    return classifyRoundScalar(value.n);
  }
  return classifyRoundScalar(value);
}

/**
 * D-7 的轮次解析链（delivery 侧）：
 *
 *     round = contractOf(task).attempt ?? task.attempt ?? 1
 *
 * canDeliver 的入参里没有 `meta`，所以这条链只读任务侧；`meta.attempt` 与任务侧的一致性
 * 由 gates 侧校验（D-7 的第 3 条），delivery 采信那个结果。链路顺序与 gates 完全一致，
 * 因此"任务写 `{n:2}`、插件层没传 meta"这种情况两边都按第 2 轮算，不会各算一套。
 *
 * 返回 `{ status, round, source, raw }`：
 *   - status 'ok'      → `round` 是最终轮次，**缺省时显式给出 1**（不留 undefined 让调用方自己兜）
 *   - status 'invalid' → `round` 为 null，调用方报 E_INPUT_INVALID 且不做新旧判定
 *   - source           → 'contract' | 'task-record' | 'default'，让错误信息能说清"这个 1 是哪来的"
 * @param {unknown} task
 */
function resolveTaskRound(task) {
  const src = isPlainObject(task) ? task : {};
  const contract = contractOf(src);
  // contractOf 在没有 contract 对象时返回 task 本身：此时"契约 attempt"就是任务记录的 attempt，
  // 不要把它标成来自契约（那会让诊断指错地方）。
  const fromContract = contract === src ? undefined : contract.attempt;
  const fromTask = src.attempt;
  const hasContractValue = fromContract !== undefined && fromContract !== null;
  const raw = hasContractValue ? fromContract : fromTask;
  const classified = classifyTaskAttempt(raw);
  const source = hasContractValue
    ? 'contract'
    : (classified.status === 'missing' ? 'default' : 'task-record');
  return { ...classified, source, raw };
}

/**
 * 评审记录上的轮次：只认标量（gates 的 `meta.attempt` 写进来），缺省即第 1 轮。
 * 写成 `{n:2}` 这类记录形态是坏输入 —— 形态放宽只针对"任务记录"，不针对"评审签名"。
 * @param {unknown} reviewed
 */
function resolveReviewRound(reviewed) {
  const raw = isPlainObject(reviewed) ? reviewed.attempt : undefined;
  const classified = classifyRoundScalar(raw);
  return { ...classified, source: classified.status === 'missing' ? 'default' : 'review', raw };
}

/**
 * 让错误信息说清"这个轮次是从哪读出来的"。
 * 两种"缺省"用词刻意不同：评审侧是"未标注"（该写没写），任务侧是"未提供"（本来就允许省略）。
 * @param {{status:string, round:number|null, source:string}} resolved
 * @param {'评审'|'任务'} who
 */
function describeRoundSource(resolved, who) {
  if (resolved.status === 'missing' || resolved.source === 'default') {
    return who === '评审'
      ? '评审未标注 attempt，按第 1 轮处理'
      : '任务 attempt 未提供，按第 1 轮处理';
  }
  if (resolved.source === 'review') return `评审标注 attempt=${resolved.round}`;
  if (resolved.source === 'contract') return `任务的契约 attempt → 第 ${resolved.round} 轮`;
  return `任务的记录 attempt → 第 ${resolved.round} 轮`;
}

/* ------------------------------------------------------------------------- */
/* 任务归一化                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * 规范化一条 task：缺失字段补默认值，保证后续逻辑不用到处判空。
 *
 * 契约字段（inScope/outOfScope/acceptance/verify/objective/reviewedTaskId）**一律走 contractOf**，
 * 不再逐字段回退顶层（D7）。attempt 是任务记录字段，按 D-7 的链式取值：
 * `contractOf(task).attempt ?? task.attempt ?? 1`（见 resolveTaskRound）。
 *
 * @param {any} task
 * @param {number} index
 */
function normalizeTask(task, index) {
  const src = isPlainObject(task) ? task : {};
  const contract = contractOf(src);

  /* `contractDeclared`：这条任务**到底有没有写契约块**。
   *
   * 判据直接借 `contractOf` 的返回身份：`contract !== src` 就是"契约视图来自 task.contract
   * 而不是回退顶层"，也就是 `declaresContract()` 成立。
   * 不另写一套 `Object.keys(contract).length > 0` —— 那会与 `CONTRACT_DECLARATION_KEYS`
   * 的口径漂移（`contract: {note:'x'}` 零个契约键，两种写法给出相反结论），
   * 而"同一个事实写在 N 处，漂移时静默"正是本项目反复踩的坑。
   *
   * 为什么 15c 需要这个标记：空契约的 `proposalId` 读不到，但**那不是"没开会"**，
   * 那是"连契约都没写"，那笔账归 E_CONTRACT_INCOMPLETE / E_INPUT_INVALID。
   * 两处都报等于把一件事说成两件，还会让人以为会议门禁可以靠"不写契约"绕过——
   * 绕不过去：不写契约本身就已经被拦死了。 */
  const contractDeclared = contract !== src;

  const inScopeInfo = toEntryListStrict(contract.inScope);
  const outOfScopeInfo = toEntryListStrict(contract.outOfScope);
  const illegalDeclared = [
    ...declaredIllegal(contract.inScope, 'inScope'),
    ...declaredIllegal(contract.outOfScope, 'outOfScope'),
  ];

  return {
    // `idDeclared`：这个 id 是输入里**真的写了**，还是我刚造的占位（见 taskIdOf）。
    // 关系图的端点只认前者 —— 占位 id 在宿主任务板上不存在。
    idDeclared: nonEmptyString(src.id) !== undefined,
    id: nonEmptyString(src.id) ?? `#${index}`,
    kind: typeof src.kind === 'string' ? src.kind : '',
    status: typeof src.status === 'string' ? src.status : '',
    changedPaths: Array.isArray(src.changedPaths)
      ? src.changedPaths.filter((p) => typeof p === 'string')
      : [],
    cancelReason: src.cancelReason,
    sourceTaskId: nonEmptyString(src.sourceTaskId),
    sourceReviewId: nonEmptyString(src.sourceReviewId),
    // 范围声明：只保留契约视图里的合法条目（raw 保留 'src/' 的目录语义）
    inScope: inScopeInfo.entries.map((entry) => entry.raw),
    outOfScope: outOfScopeInfo.entries.map((entry) => entry.raw),
    illegalDeclared,
    // 质量声明：delivery 不判定它们"够不够好"，只判定"在不在"——读不到就拒绝（D7/D-8）
    acceptanceCount: textList(contract.acceptance).length,
    verifyCount: textList(contract.verify).length,
    /* task-21（开会与方案流程）：`proposal` 的两个契约字段。
     *
     *   - `openQuestions`  提案里**要向用户确认**的问题（开工前就声明的承诺）
     *   - `answered`       决议里**逐条对应的答复**（`<问题原文> → <用户答复>`）
     *
     * 「空 vs 缺失」在解析层已经分开（`[]` = 想过、没问题；键不存在 = 没想过），
     * 但**到了这一层两者都落成 `[]`** —— 因为交付判定只需要知道"有哪些问题"，
     * 而"有没有想过"这件事由 gates 的契约完整性去管，不该在这里再造一个维度。
     * 用 `textList` 与 acceptance/verify 同一口径：`undefined` / 非数组 → `[]`，
     * 单字符串算一条（宽松，但不改语义）。 */
    openQuestions: textList(contract.openQuestions),
    answered: textList(contract.answered),
    /* task-22：开会这件事的两个字段。
     * 用 `nonEmptyString` 而不是 `textList`：它们是**标量**（一个指针 / 一句理由）。
     * 写成列表是坏输入，但这里不报错 —— 契约完整性的报错归 gates，
     * 交付层只判"有没有指向一份真的提案"，形态问题由解析层的 warning 说。 */
    proposalId: nonEmptyString(contract.proposalId),
    skipMeeting: nonEmptyString(contract.skipMeeting),
    contractDeclared,
    // 轮次：D-7 的解析链 `contractOf(task).attempt ?? task.attempt ?? 1`，缺省显式落在 1
    round: resolveTaskRound(src),
    reviewedTaskId: nonEmptyString(contract.reviewedTaskId),
    reviewed: isPlainObject(src.reviewed) ? src.reviewed : undefined,
    ambiguity: contractAmbiguityOf(src),
    declarationBroken: false,
  };
}

/**
 * 评审记录里的产物清单。
 * @param {any} task
 * @returns {Array<any>}
 */
function artifactsOf(task) {
  const list = task?.reviewed?.artifacts;
  return Array.isArray(list) ? list.filter((a) => isPlainObject(a)) : [];
}

/**
 * 该任务是否是一条 "completed + pass" 的评审。
 * @param {any} task
 */
function isPassingReview(task) {
  return task.kind === REVIEW_KIND && task.status === COMPLETED && task.reviewed?.verdict === 'pass';
}

/**
 * 评审实际归属的被审任务：契约的 reviewedTaskId 优先，兼容老的 sourceTaskId。
 * 归属是绑定可信度的根：没有归属的评审不能给任何任务背书。
 * @param {any} task
 * @returns {string}
 */
function reviewedTargetId(task) {
  return task.reviewedTaskId ?? task.sourceTaskId ?? '';
}

/**
 * artifact 记录的指纹是否可用于比对（D2）：必须是**非空字符串**。
 * 缺指纹的绑定等于没有绑定，不能因为"没记录"就跳过比对。
 * @param {any} artifact
 * @returns {string} 空串 = 不可用
 */
function artifactDigest(artifact) {
  return typeof artifact.sha256 === 'string' ? artifact.sha256.trim() : '';
}

/**
 * delivered 记录是否真的是宿主签发（规格 §7：by:"host:actionCard" + call_id + evidence_digest）。
 * callId 驼峰别名已删除（L-3）：规格是蛇形，过渡期给过一轮，继续兼容等于给伪造凭据留一个后门。
 * @param {unknown} delivered
 * @returns {string|null} null = 合格；否则为不合格原因
 */
function deliveryRecordIssue(delivered) {
  if (!isPlainObject(delivered)) return 'team.delivered 缺失或不是对象';

  const by = typeof delivered.by === 'string' ? delivered.by.trim() : '';
  if (!by) return 'team.delivered.by 缺失';
  if (!by.startsWith(HOST_ISSUER_PREFIX)) {
    return `team.delivered.by=${JSON.stringify(by)} 不是宿主签发（必须以 "${HOST_ISSUER_PREFIX}" 开头，例如 "host:actionCard"）`;
  }

  const callIdValue = nonEmptyString(delivered.call_id) ?? '';
  if (!callIdValue) {
    return 'team.delivered.call_id 缺失（规格 §7 为蛇形 call_id，驼峰 callId 不再接受）；调用方不能凭空写一条交付记录';
  }

  if (!nonEmptyString(delivered.evidence_digest)) {
    return 'team.delivered.evidence_digest 缺失：无法证明这次交付对应的是被评审过的那份证据';
  }

  return null;
}

/**
 * 团队阶段 → 交付资格（D8 正向白名单）。
 *
 *   phase === 'running'            → null（继续走后面的判定）
 *   phase === 'staged'             → E_NEEDS_HUMAN_APPROVAL（还没批准，不是"停了"）
 *   phase === 'halted' | 'archived'→ E_NOT_RUNNING
 *   其余一切（缺失 / 空串 / 'RUNNING' / 'runing' / 'running ' / 非字符串）
 *                                  → E_NOT_RUNNING，message 点明收到的值与允许的值
 *
 * 严格匹配小写 running：phase 由插件层写入，写错就是错。用 toLowerCase 去"宽容"
 * 只会把 'RUNNING' 与 'running' 之间的真实分歧藏起来。
 * @param {object} team
 * @returns {{code:string, message:string}|null}
 */
function phaseVerdict(team) {
  const phase = team.phase;
  if (phase === PHASE_RUNNING) return null;

  const allowed = `允许的值只有 "${
    PHASE_RUNNING
  }"（大小写敏感；"staged" 需人工批准后转 running，"halted"/"archived" 已停止）`;

  if (phase === PHASE_STAGED) {
    return {
      code: 'E_NEEDS_HUMAN_APPROVAL',
      message: `团队当前处于 ${PHASE_STAGED} 阶段：方案还没被人工批准，不能宣布交付。${allowed}。`,
    };
  }

  if (PHASE_STOPPED.has(phase)) {
    return {
      code: 'E_NOT_RUNNING',
      message: `团队当前处于 ${phase} 阶段，只有运行中的团队才能宣布交付。${allowed}。`,
    };
  }

  return {
    code: 'E_NOT_RUNNING',
    message: `团队 phase 不是可识别的运行状态：收到 ${describeValue(phase)}。只有运行中的团队才能宣布交付，${allowed}。`,
  };
}

/* ------------------------------------------------------------------------- */
/* 主判定函数                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * 判定一个团队现在能不能宣布交付。
 * @param {object} input
 *   {
 *     team:    { phase, leaderMode:'spawned'|'inline',
 *                delivered?:{ by:'host:actionCard', call_id, at, evidence_digest },
 *                base?:{gitHead} },
 *     tasks:   Array<{ id, kind, status, changedPaths:string[], cancelReason?, sourceTaskId?, sourceReviewId?,
 *                      contract?:{ inScope, outOfScope, acceptance, verify, objective?, attempt?, reviewedTaskId? },
 *                      reviewed?:{ verdict, attempt?, artifacts:Array<{path,present,sha256}> } }>,
 *     currentDigests: Record<string,string>,
 *     diffPaths: string[]
 *   }
 * @returns {{ok:boolean, blockers:Array<{code:string,message:string,taskId?:string}>}}
 */
export function canDeliver(input) {
  const blockers = [];
  /**
   * 收一条阻断。
   *
   * 第三参 `taskId`：这条阻断**明确**打在哪条任务上（关系图的右端点）。
   * 传一个猜的 id 比不传更坏 —— 不传时输出里没有这个键，页面把它画成「全局」根因，
   * 这个表达是诚实的；硬塞一个则会在图上多一条"看起来有归属、其实没有"的线。
   * 所以这里只接受**非空字符串**，其余（undefined / '' / 空白串 / 非字符串）一律当没有归属。
   * @param {string} code
   * @param {string} message
   * @param {string} [taskId]
   */
  const add = (code, message, taskId) => {
    const endpoint = attributableId(taskId);
    if (endpoint === null) {
      blockers.push({ code, message });
      return;
    }
    blockers.push({ code, message, taskId: endpoint });
  };

  const team = isPlainObject(input?.team) ? input.team : {};
  const rawTasks = Array.isArray(input?.tasks) ? input.tasks : [];
  const tasks = rawTasks.map((t, i) => normalizeTask(t, i));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  /**
   * 绑定类阻断（E_BINDING_* / E_STALE_ATTEMPT）的端点：**优先被审任务** ——
   * 被这条阻断挡住可交付性的是它（产物不可验证），不是那条已经 pass 的评审。
   * 归属缺失、或指向一条不在任务表里（/ 只有占位 id）的任务时，退回评审任务自身：
   * 那条记录是它写的，它确实是已知的、被牵连的任务。
   * @param {any} reviewTask
   * @param {string} ownerId
   * @returns {string}
   */
  const bindingEndpoint = (reviewTask, ownerId) => (
    taskById.get(ownerId)?.idDeclared === true ? ownerId : taskIdOf(reviewTask)
  );

  // ── 0. 契约必须可判定：同一字段两处声明且值不同 → 拒绝（不选边）───────────
  // 与 validatePlan 的 E_CONTRACT_AMBIGUOUS 同码同义。最后一道门不能替调用方挑一个值：
  // 挑对了是运气，挑错了就是"校验器拒、交付器放行"。
  for (const task of tasks) {
    if (task.ambiguity.length === 0) continue;
    add(
      'E_CONTRACT_AMBIGUOUS',
      `任务 ${task.id} 的契约字段在 contract 与顶层各写了一份且值不同：${task.ambiguity.join('、')}。`
        + '两套声明只能留一套（contract 优先、不合并）；交付判定不替调用方选值。',
      taskIdOf(task),
    );
  }

  // ── 0b. 形态白名单：拼错的 kind/status 会让记录凭空消失（幽灵任务）────────
  for (const task of tasks) {
    if (!KINDS.includes(task.kind)) {
      add(
        'E_INPUT_INVALID',
        /* 白名单**从 KINDS 拼**，不再手写第三份 —— 原来这里硬编码
         * 「（implementation / review / work）」，与 `KNOWN_KINDS` 的字面量、与
         * `contract.mjs` 的 `KINDS` 一共三份。三份的下场是：`proposal` 加进 KINDS 之后，
         * 这条错误消息会对着一个**合法 kind** 说"不在白名单"，报错本身就撒谎。 */
        `任务 ${task.id} 的 kind=${describeValue(task.kind)} 不在白名单（${KINDS.join(' / ')}）：`
          + '拼错的 kind 既不会被当成代码任务、也不会被当成未完成，等于让这条记录从所有判定里消失。',
        taskIdOf(task),
      );
    }
    if (!KNOWN_STATUSES.has(task.status)) {
      add(
        'E_INPUT_INVALID',
        `任务 ${task.id} 的 status=${describeValue(task.status)} 不在白名单`
          + '（pending / claimed / in_progress / completed / failed / cancelled）：道理同上，拼错即坏输入。',
        taskIdOf(task),
      );
    }
    const round = task.round;
    if (round.status === 'invalid') {
      add(
        'E_INPUT_INVALID',
        `任务 ${task.id} 的 attempt=${describeValue(round.raw)} 不是正整数：`
          + '非法形态不能成为"跳过 attempt 对齐"的开关（只有缺失才按第 1 轮处理，'
          + '记录形态请写 { n: 2 } 或直接写 2）。',
        taskIdOf(task),
      );
    }
  }

  // ── 0c. 分工独立性（D-13）：自审 / 缺归属 是 blocker，停滞与"判不了"是 warning ──
  // 判据全部在 separationOfDuties 里（可单独调用、单独测试），这里做两件**裁决层**的事：
  //   ① severity 分流：blocker 进 blockers，warning 进 warnings（不进 ok，ok 语义不变）
  //   ② 报"这一轮我判不了"：legacy 模式（全团队没有任何 assignee）时独立性判定整体失效。
  //     这条**必须由裁决层发**，不能塞进 separationOfDuties —— 判据层只报"违反了哪条判据"，
  //     不报"我没有判据可用"（S-6：legacy 下 separationOfDuties 本身一条都不报）。
  const warnings = [];
  const duties = separationOfDuties({ tasks: rawTasks });
  for (const violation of duties.violations) {
    if (violation.severity === 'warning') {
      warnings.push({ code: violation.code, taskId: violation.taskId, message: violation.message });
      continue;
    }
    add(violation.code, violation.message, violation.taskId);
  }

  // legacy：一条团队只发一条（H-1），不随任务数增殖
  const hasAnyAssignee = rawTasks.some((task) => assigneeOf(task) !== '');
  if (!hasAnyAssignee) {
    warnings.push({
      code: 'E_INDEPENDENCE_UNENFORCED',
      taskId: '',
      message: '独立性判定未生效：团队没有任何归属信息（所有任务都没有 assignee），'
        // JN-1：必须点明**两条**判定一起失效，否则运维会以为只丢了自审这一条。
        + '评审与被审是否同一人无法判定，评审停滞检测也无法分组'
        + '（停滞判据的分组键就是 assignee，没有归属就没有分组，注意力衰减查不出来）。'
        + '插件层应从宿主 ownerName 灌入 assignee；否则只要把 assignee 清空，'
        + 'E_SELF_REVIEW 与 E_REVIEW_STAGNATION 都会静默失效'
        + '（这是一条可见的逃生门，不是不存在：警告可以被忽略）。',
    });
  }

  // ── 1. 团队阶段：只有 running 具备交付资格（正向白名单）──────────────────
  const phaseIssue = phaseVerdict(team);
  // 这里**不传** taskId：团队阶段不对是整个团队的状态，不针对任何一条任务。
  // 硬填一个任务 id 会在关系图上画出一条假边（"这条根因打中了某条任务"），
  // 而页面把无端点的阻断画成「全局」根因，那才是这段事实的诚实表达。
  if (phaseIssue) add(phaseIssue.code, phaseIssue.message);

  // ── 2. 契约完整性：读不到 acceptance/verify 就是"没有验收依据"（D-8 / F4-4）──
  // delivery 不评价验收写得好不好（那是 gates 与"人批计划"的活），只要求这两份声明在
  // **契约视图**里存在。与 gates 的 E_CONTRACT_INCOMPLETE **同码同义**：
  //   implementation → 必须有非空 acceptance 且非空 verify
  //   review         → 同样要求（"用什么验证了这次评审"必须说清）
  //   work           → 豁免（纯执行项，不设门禁）
  // 没有这一条，gates 侧的"完成"与 delivery 侧的"可交付"会对同一份记录给出相反结论。
  for (const task of tasks) {
    if (!QUALITY_KINDS.includes(task.kind)) continue;
    const missing = [];
    if (task.acceptanceCount === 0) missing.push('acceptance');
    if (task.verifyCount === 0) missing.push('verify');
    if (missing.length === 0) continue;
    const why = task.kind === REVIEW_KIND
      ? 'review 也要说清"用什么验证了这次评审"'
      : 'implementation 的"完成"就是它的验收项';
    add(
      'E_CONTRACT_INCOMPLETE',
      // 核心句与 gates 逐字一致（D-8「统一 message 措辞」）：两边同码，就不该有两种说法。
      `契约里缺少 ${missing.join(' 与 ')}（kind=${task.kind}）：质量任务的"完成"必须同时有验收项和验证命令——`
        + `这不是"验收没覆盖"，而是压根没声明（${why}）。`
        + '请把 acceptance / verify 写进 task.contract —— contract 为非空对象时不再回退顶层，'
        + '写在顶层等于没写；交付期读不到这两份声明，就无法说明这次交付被验证过。',
      taskIdOf(task),
    );
  }

  // ── 3. 任务未完成：仍在流程中的状态（pending / claimed / in_progress）─────
  // failed 归第 4 条、cancelled 归第 11 条，各自只报一次，避免同一事实两条码。
  for (const task of tasks) {
    if (IN_FLIGHT_STATUS.has(task.status)) {
      add(
        'E_TASK_INCOMPLETE',
        `任务 ${task.id}（kind=${task.kind || 'unknown'}）仍处于 ${task.status} 状态，还没有结论。`,
        taskIdOf(task),
      );
    }
  }

  // ── 4. 失败任务没有后续任务（sourceTaskId / sourceReviewId 都没有指向它）──
  const followUpTargets = new Set();
  for (const task of tasks) {
    if (task.sourceTaskId) followUpTargets.add(task.sourceTaskId);
    if (task.sourceReviewId) followUpTargets.add(task.sourceReviewId);
  }
  for (const task of tasks) {
    if (task.status === 'failed' && !followUpTargets.has(task.id)) {
      add(
        'E_FAILED_NO_FOLLOWUP',
        `任务 ${task.id} 已失败，但没有任何后续任务以它为 sourceTaskId 或 sourceReviewId。`,
        taskIdOf(task),
      );
    }
  }

  /* ── 4b. 依据必须真的存在（v1.1）：卡片指向的 id 在任务表里查不到 → E_BASIS_FABRICATED ─
   *
   * 洞在哪：`sourceTaskId` / `sourceReviewId` / `contract.reviewedTaskId` 这三个字段
   * 全项目只被**读出来做过匹配**，从来没有被**要求存在**。
   * 第 4 段把 sourceTaskId 收进 followUpTargets 判断"失败任务有没有人来接"，
   * 第 14 段拿 reviewedTaskId 去比对上号 —— 两处都是"如果这个串刚好等于某条任务 id"，
   * 也就是**对得上就生效、对不上就静默**。
   * 于是 `sourceTaskId: 'task-99'`（task-99 根本不存在）在页面上和
   * "这条返工确实来自 task-99"长得一模一样：都是"来源不明"或"来源正确"，
   * 系统分不出来。这不是缺个提示，这是把**编造的依据**当成了事实引用。
   *
   * 为什么不复用 E_PROPOSAL_UNKNOWN：那条只管 `proposalId`（第 15c 段）。
   * 三个字段管的是不同的事 —— 返工链（source*）和评审归属（reviewedTaskId）。
   * 一个码盖两件事，会让人修复时只看 proposalId。
   *
   * 判不了什么（写清楚，不装作能判）：
   * - 这个 id 存在、但**内容上**不是本该引用它的那条（张冠李戴，对不上也拦不住）
   * - 自指（sourceTaskId === 自己的 id）本条不报 —— 那是另一种畸形，
   *   留到身份规范化那一层，不要在这里顺手合并
   * - `proposalId` 指向存在的任务但那条任务还没完成 → E_PROPOSAL_NOT_READY 管
   */
  const declaredRefs = [
    ['sourceTaskId', (t) => t.sourceTaskId],
    ['sourceReviewId', (t) => t.sourceReviewId],
    ['reviewedTaskId', (t) => t.reviewedTaskId],
  ];
  for (const task of tasks) {
    const dangling = [];
    for (const [field, read] of declaredRefs) {
      const ref = read(task);
      if (typeof ref !== 'string' || ref === '') continue;
      if (taskById.has(ref)) continue;
      dangling.push(`${field} = ${ref}`);
    }
    if (dangling.length === 0) continue;
    add(
      'E_BASIS_FABRICATED',
      `任务 ${task.id} 引用的依据在任务表里不存在：${dangling.join('、')}。`
        + '这些字段只在对得上号时才起作用，对不上号时没有任何声音 —— '
        + '所以一条编造的来源在页面上和一条真实的来源长得一样。改成真实存在的任务 id，或删掉这个字段。',
      taskIdOf(task),
    );
  }

  // ── 5. 评审已完成但结论不是 pass ─────────────────────────────────────────
  for (const task of tasks) {
    if (task.kind === REVIEW_KIND && task.status === COMPLETED) {
      const verdict = task.reviewed?.verdict;
      if (verdict !== 'pass') {
        add(
          'E_VERDICT_REQUIRED',
          `评审任务 ${task.id} 已完成，但结论是 ${verdict === undefined || verdict === null ? '缺失' : verdict}，需要 pass。`,
          taskIdOf(task),
        );
      }
    }
  }

  // ── 6. 有实现完成，但没有任何 completed + pass 的评审 ────────────────────
  const completedImplementations = tasks.filter((t) => t.kind === 'implementation' && t.status === COMPLETED);
  const passingReviews = tasks.filter(isPassingReview);
  if (completedImplementations.length > 0 && passingReviews.length === 0) {
    const ids = completedImplementations.map((t) => t.id).join('、');
    // 端点：只有**恰好一条**已完成的实现任务时才知道"这条根因打中的是哪一条"。
    // 两条以上时这条阻断说的是评审集合整体（"没有任何 pass"），分不清该连哪条 ——
    // 猜一个会让图上出现一条只指向其中一条的线，把另一半事实藏掉。
    add(
      'E_NO_PASSING_REVIEW',
      `实现任务 ${ids} 已 completed，但不存在任何 completed + pass 的评审任务。`,
      soleOfTasks(completedImplementations),
    );
  }

  // ── 7. 路径安全：非法的"声明"与"审计对象"各自点名（D11）──────────────────
  // 以前非法路径只能表现为 E_OUT_OF_SCOPE / E_UNREPORTED_CHANGES，运维会去改范围声明，
  // 而该改的是路径本身。方向是 fail-closed 的，但码指错了修法。
  for (const task of tasks) {
    if (task.illegalDeclared.length === 0) continue;
    const detail = task.illegalDeclared
      .map((item) => `${item.field} 里的 ${JSON.stringify(item.raw)}：${item.reason}`)
      .join('；');
    add(
      'E_PATH_UNSAFE',
      `任务 ${task.id} 的范围声明里有非法路径：${detail}。声明非法时只报这一条（不叠加"越界"）——`
        + '该改的是声明，不是把路径往 inScope 里塞。',
      taskIdOf(task),
    );
    task.declarationBroken = true; // 声明本身坏了，范围审计没有可信依据，跳过以免误报越界
  }

  const diffPathsRaw = Array.isArray(input?.diffPaths)
    ? input.diffPaths.filter((p) => typeof p === 'string')
    : [];

  const illegalAudit = [];
  const seenIllegalAudit = new Set();
  /** @param {string} label @param {string} raw @param {any} [ownerTask] 申报者（diffPaths 没有主人） */
  const noteIllegalAudit = (label, raw, ownerTask) => {
    const key = `${label}\u0000${raw}`;
    if (seenIllegalAudit.has(key)) return;
    seenIllegalAudit.add(key);
    illegalAudit.push({ label, raw, ownerTask });
  };
  for (const task of tasks) {
    for (const raw of task.changedPaths) {
      if (!raw.trim()) continue;
      if (strictNormalize(raw) === null) noteIllegalAudit(`任务 ${task.id} 的 changedPaths`, raw, task);
    }
  }
  for (const raw of diffPathsRaw) {
    if (!raw.trim()) continue;
    if (strictNormalize(raw) === null) noteIllegalAudit('diffPaths', raw);
  }
  if (illegalAudit.length > 0) {
    const detail = illegalAudit
      .map((item) => `${item.label} ${JSON.stringify(item.raw)}（${auditPathIssue(item.raw)}）`)
      .join('；');
    // 端点：这条阻断是**聚合**出来的（任务申报 + diffPaths）。只有当全部非法条目都来自
    // 同一条任务时才点它的名；混进 diffPaths（无主）或跨多条任务就整条不点名。
    const endpoint = soleTaskId(
      illegalAudit.map((item) => (item.ownerTask === undefined ? '' : taskIdOf(item.ownerTask))),
    );
    add(
      'E_PATH_UNSAFE',
      `审计对象里有非法路径：${detail}。工作区变更路径必须是安全的工作区相对路径`
        + '（不允许绝对路径、.. 穿越、~ 前缀、盘符与控制字符）。',
      endpoint,
    );
  }

  // ── 8. 越界：实现申报的路径不在 inScope 或命中 outOfScope ────────────────
  for (const task of tasks) {
    if (!CODE_CHANGING_KINDS.has(task.kind)) continue;
    if (task.declarationBroken) continue; // 已由 E_PATH_UNSAFE 点名，不再叠加误导性的"越界"
    const offending = [];
    for (const raw of task.changedPaths) {
      const path = normalizePath(raw);
      if (!path) continue;
      const verdict = scopeVerdict(path, task.inScope, task.outOfScope);
      if (verdict !== 'in_scope') offending.push(`${path}（${verdict}）`);
    }
    if (offending.length > 0) {
      add('E_OUT_OF_SCOPE', `任务 ${task.id} 申报了契约范围外的路径：${offending.join('、')}。`, taskIdOf(task));
    }
  }

  // ── 8b. work 是只读调研类，申报工作区变更本身就是伪造 ────────────────────
  for (const task of tasks) {
    if (task.kind !== READ_ONLY_KIND) continue;
    const declared = task.changedPaths.map(normalizePath).filter(Boolean);
    if (declared.length > 0) {
      add(
        'E_WORK_DECLARED_CHANGES',
        `work 任务 ${task.id} 申报了工作区变更路径（${declared.join('、')}）：work 是只读调研类，`
          + '不产生代码变更；把实现降级成 work 不能豁免范围与绑定校验。',
        taskIdOf(task),
      );
    }
  }

  // ── 9. 绑定指纹：pass 评审记录的产物必须可验证 ───────────────────────────
  const currentDigests = isPlainObject(input?.currentDigests) ? input.currentDigests : {};
  const digestByPath = new Map();
  for (const [key, digest] of Object.entries(currentDigests)) {
    const path = normalizePath(key);
    if (path) digestByPath.set(path, digest);
  }

  /**
   * 被 STALE 命中的 (owner, path)：这是"篡改信号"，D10 要求它单独出现 ——
   * 有记录但指纹不符时不再叠加 E_UNBOUND_ARTIFACT，否则运维会先怀疑"漏审"。
   */
  const staleByOwnerPath = new Set();
  const staleKey = (ownerId, path) => `${ownerId}\u0000${path}`;

  for (const task of passingReviews) {
    const ownerId = reviewedTargetId(task);
    for (const artifact of artifactsOf(task)) {
      const path = normalizePath(artifact.path);
      if (!path) continue;
      const existsNow = digestByPath.has(path);

      if (artifact.present === false) {
        if (existsNow) {
          add(
            'E_BINDING_STALE',
            `评审 ${task.id} 记录产物 ${path} 为不存在（present:false），但它现在存在。`,
            bindingEndpoint(task, ownerId),
          );
          if (ownerId) staleByOwnerPath.add(staleKey(ownerId, path));
        }
        continue; // 记录为"不存在"的产物本来就没有指纹，不要求 sha256
      }

      if (!existsNow) {
        add(
          'E_BINDING_STALE',
          `评审 ${task.id} 记录的产物 ${path} 现在已缺失。`,
          bindingEndpoint(task, ownerId),
        );
        if (ownerId) staleByOwnerPath.add(staleKey(ownerId, path));
        continue;
      }

      const recorded = artifactDigest(artifact);
      if (!recorded) {
        add(
          'E_BINDING_UNVERIFIABLE',
          `评审 ${task.id} 记录的产物 ${path} 没有 sha256 指纹：没有指纹的绑定无法证明审后未被篡改，`
            + '省略字段不能跳过比对。',
          bindingEndpoint(task, ownerId),
        );
        continue;
      }

      const actual = digestByPath.get(path);
      if (recorded !== actual) {
        add(
          'E_BINDING_STALE',
          `评审 ${task.id} 记录的产物 ${path} 指纹与当前工作区不一致（记录 ${recorded}，当前 ${actual}）。`,
          bindingEndpoint(task, ownerId),
        );
        if (ownerId) staleByOwnerPath.add(staleKey(ownerId, path));
      }
    }
  }

  // ── 10. 交付未登记：delivered 缺失、非宿主签发或缺关键字段 ───────────────
  const deliveryIssue = deliveryRecordIssue(team.delivered);
  if (deliveryIssue) {
    // 不传 taskId：这是**宿主有没有签发交付记录**，是团队级事实，不是哪条任务的毛病。
    // 硬塞一条任务 id 会让图上多一条"这条根因打中了某条任务"的假边。
    add('E_NEEDS_HUMAN_DELIVERY', `团队尚未登记有效的交付记录：${deliveryIssue}。`);
  }

  // ── 11. 取消任务没有写明原因 ─────────────────────────────────────────────
  // cancelled 是终态（gates 的 TRANSITIONS 里没有 cancelled 的出边），它既不认领 diff、
  // 也不算"未完成"；本模块对它的唯一要求就是"写清为什么取消"，不留隐式分支。
  for (const task of tasks) {
    if (task.status === 'cancelled') {
      const reason = typeof task.cancelReason === 'string' ? task.cancelReason.trim() : '';
      if (!reason) {
        add('E_CANCELLED_NO_REASON', `任务 ${task.id} 已取消，但没有填写 cancelReason。`, taskIdOf(task));
      }
    }
  }

  // ── 12. 轮次对齐：缺省即第 1 轮（D-7）──────────────────────────────────
  for (const task of tasks) {
    if (task.kind !== REVIEW_KIND) continue;

    const reviewRound = resolveReviewRound(task.reviewed);
    if (reviewRound.status === 'invalid') {
      add(
        'E_INPUT_INVALID',
        `评审 ${task.id} 的 reviewed.attempt=${describeValue(reviewRound.raw)} 不是正整数：`
          + '非法形态不能静默降级成"不做新旧判定"（那正好是上一轮评审给下一轮背书的入口）。'
          + '评审签名只认标量（2），记录形态 { n: 2 } 也不行。',
        taskIdOf(task),
      );
      continue;
    }

    const ownerId = reviewedTargetId(task);
    const owner = ownerId ? taskById.get(ownerId) : undefined;
    // owner 不在任务列表里时退回本任务的轮次（与归属解析同一取舍：没有归属就没有更可信的来源）
    const ownerRound = owner ? owner.round : task.round;

    // 任务侧轮次非法已在 0b 报过，这里不重复报；也不把它当成"无可比较"
    if (ownerRound.status === 'invalid') continue;

    const effectiveOwner = ownerRound.status === 'ok' ? ownerRound.round : ROUND_BOOTSTRAP;
    const effectiveReview = reviewRound.status === 'ok' ? reviewRound.round : ROUND_BOOTSTRAP;

    if (effectiveOwner !== effectiveReview) {
      add(
        'E_STALE_ATTEMPT',
        `评审 ${task.id} 记录的是被审任务 ${ownerId || '（未指明）'} 的 attempt=${effectiveReview}，`
          + `但该任务当前是第 ${effectiveOwner} 轮：上一 attempt 的评审不能为这一次背书。`
          + `（${describeRoundSource(reviewRound, '评审')}；${describeRoundSource(ownerRound, '任务')}）`,
        bindingEndpoint(task, ownerId),
      );
    }
  }

  // ── 13. 路径驱动（防 "全 work 化" 绕过）：diffPaths 必须被已完成代码任务申报 ─
  const reportedByCompleted = new Set();
  for (const task of tasks) {
    if (task.status !== COMPLETED) continue;
    if (!CODE_CHANGING_KINDS.has(task.kind)) continue; // work / review 不再能"认领"
    for (const raw of task.changedPaths) {
      const path = normalizePath(raw);
      if (path) reportedByCompleted.add(path);
    }
  }

  const seenDiff = new Set();
  for (const raw of diffPathsRaw) {
    const path = normalizePath(raw);
    if (!path || seenDiff.has(path)) continue;
    seenDiff.add(path);
    if (!reportedByCompleted.has(path)) {
      // 不传 taskId：这条恰恰是"**没有**任何任务申报过它"，天然无主。
      // 给它编一个任务 id 会把"没人认领"说成"某人认领了但有问题"，方向都反了。
      add(
        'E_UNREPORTED_CHANGES',
        `工作区变更路径 ${path} 没有被任何 completed 的代码变更任务（${[...CODE_CHANGING_KINDS].join('/')}）申报过。`,
      );
    }
  }

  // ── 13b. 反向路径驱动（v1.1）：申报了改动、磁盘却没变 → E_REPORTED_UNCHANGED ─
  //
  // 与上一段是一对，方向正好相反：
  //   13  段：diffPaths 里有、changed[] 里没有 → 「改了没报」（E_UNREPORTED_CHANGES）
  //   13b 段：changed[] 里有、diffPaths 里没有 → 「报了没改」（E_REPORTED_UNCHANGED）
  //
  // 为什么后者必须单独成码、而且必须是 blocker：
  // 上面所有门禁判的都是**卡的形状**（字段在不在、claim 是不是一个、验收项写没写），
  // 没有一条判**卡上说的那件事在磁盘上发生了没有**。于是一份逐字编造的交付报告
  // ——申报 7 个文件、每个都带看起来像真的行号与理由——可以完美通过全部形状门禁，
  // 而工作区一个字节都没动。这不是假想：本项目自举时就跑出过一次，
  // 三份报告（build / verify / signoff）互相印证，单看任何一份都看不出问题。
  //
  // 判据只在**审计输入确实提供了**时成立，这是"空 ≠ 不可用"那条红线在这里的落点：
  //   `diffPaths` 是 undefined → 调用方没接线，本码沉默（"没查"由 E_AUDIT_UNWIRED 出声）；
  //   `diffPaths` 是 []        → 接线了、工作区确实没改动，则所有申报都是假的，全报。
  // 把"没接线"当成"没有改动"报出来，等于拿沉默冒充结论；反过来把"确实没改动"
  // 当成"没接线"而沉默，就是给编造的报告放行。两个方向都不能糊。
  const auditWired = input !== undefined && input !== null && Array.isArray(input.diffPaths);
  if (auditWired) {
    const seenReported = new Set();
    for (const task of tasks) {
      if (task.status !== COMPLETED) continue;
      if (!CODE_CHANGING_KINDS.has(task.kind)) continue;
      for (const raw of task.changedPaths) {
        const path = normalizePath(raw);
        if (!path || seenReported.has(path)) continue;
        seenReported.add(path);
        if (seenDiff.has(path)) continue; // 磁盘上真变了，正常
        add(
          'E_REPORTED_UNCHANGED',
          `任务 ${task.id} 申报改了 ${path}，但工作区的变更路径里没有它 —— `
            + '这条改动要么从来没发生，要么发生在别的地方。'
            + '（「改了没报」报 E_UNREPORTED_CHANGES，「报了没改」报本条，两条不互相替代）',
          taskIdOf(task),
        );
      }
    }
  }

  // ── 14. 绑定必须按归属：路径 p 属于任务 T → 必须有一条针对 T 的 pass 评审绑定它 ─
  // 全局路径集合求交会让 impl-2 借 impl-1 的评审过关，所以这里按 (owner, path) 建索引。
  const boundByOwner = new Map(); // ownerId -> Set<path>（只有指纹校验通过的才算绑上）
  const attemptedByOwner = new Map(); // ownerId -> Set<path>（提交过绑定记录即算，无论是否通过校验）
  const holdersByPath = new Map(); // path -> Set<ownerId>（诊断用：谁记过这条路径）

  const touch = (map, ownerId, path) => {
    if (!map.has(ownerId)) map.set(ownerId, new Set());
    map.get(ownerId).add(path);
  };

  for (const review of passingReviews) {
    const ownerId = reviewedTargetId(review);
    for (const artifact of artifactsOf(review)) {
      const path = normalizePath(artifact.path);
      if (!path) continue;
      if (!holdersByPath.has(path)) holdersByPath.set(path, new Set());
      if (ownerId) {
        holdersByPath.get(path).add(ownerId);
        touch(attemptedByOwner, ownerId, path); // D10：提交过记录就算"试过绑定"
      }

      if (!ownerId) continue; // 没有归属的评审不能给任何任务背书
      if (artifact.present === false) continue;
      const recorded = artifactDigest(artifact);
      const actual = digestByPath.get(path);
      // D2：缺指纹 → 未通过校验，不算绑定；指纹不一致 → 也不算绑定
      if (!recorded || !digestByPath.has(path) || recorded !== actual) continue;

      touch(boundByOwner, ownerId, path);
    }
  }

  const claimedByCodeTasks = new Map(); // path -> Set<taskId>
  for (const task of tasks) {
    if (!CODE_CHANGING_KINDS.has(task.kind)) continue;
    for (const raw of task.changedPaths) {
      const path = normalizePath(raw);
      if (!path) continue;
      if (!claimedByCodeTasks.has(path)) claimedByCodeTasks.set(path, new Set());
      claimedByCodeTasks.get(path).add(task.id);
    }
  }

  for (const [path, ids] of claimedByCodeTasks) {
    const unbound = [...ids].filter((id) => {
      if (boundByOwner.get(id)?.has(path)) return false;
      // D10：已经报过 E_BINDING_STALE 的 (owner, path) 不再报"未绑定"——篡改信号必须刺眼、不许被稀释
      if (staleByOwnerPath.has(staleKey(id, path))) return false;
      return true;
    });
    if (unbound.length === 0) continue;

    const holders = [...(holdersByPath.get(path) ?? [])];
    let hint = '没有任何 pass 评审的 reviewed.artifacts 记录过该路径。';
    if (holders.length > 0) {
      hint = `该路径只被任务 ${holders.join('、')} 的评审记录过，归属不符：别的任务的评审不能为本次变更背书。`;
    }
    add(
      'E_UNBOUND_ARTIFACT',
      `代码变更任务 ${unbound.join('、')} 申报的路径 ${path} 没有被针对该任务自身的 pass 评审绑定`
        + `（要求 reviewedTaskId/sourceTaskId 等于该任务 id，且 artifact 的 sha256 与当前指纹一致）。${hint}`,
      // 端点：这条阻断点名的是**申报了该路径却没被绑定的任务**（unbound 就是它们）。
      // 恰好一条时才画线；两条以上抢同一条路径时"该连哪条"没有答案 —— 不猜。
      soleOfTasks(unbound.map((id) => taskById.get(id))),
    );
  }

  /* ── 14b. 申报的产物必须真的在磁盘上（v1.1）：文件根本不存在 → E_ARTIFACT_UNVERIFIED ─
   *
   * 洞在哪：上面三段（9 / 14）都以"评审记录过这个路径"为前提 ——
   *   9  段：评审记了产物、现在指纹不符或缺失 → E_BINDING_STALE
   *   14 段：评审没绑定这条路径 → E_UNBOUND_ARTIFACT
   * 两条都在说**评审与申报的关系**，都不直接回答一个更基础的问题：
   * **这个文件现在到底在不在磁盘上。**
   *
   * 后果不是文案不好，是**指错了修法**：一条申报了 `src/ghost.mjs` 的任务，
   * 如果没有任何评审记过它，用户看到的是"没有被评审绑定"——于是他去补一条评审；
   * 但文件不存在，评审算不出 sha256，补多少条都绑不上。他在一个假的方向上返工。
   * 所以这条要做的唯一一件事，是把这个事实**单独说出来**：文件不在。
   *
   * 判据（"空 ≠ 不可用"那条红线在这里的落点）：
   * - `currentDigests` 不是对象 → 审计输入没接线，本码沉默（"没查"由 E_AUDIT_UNWIRED 出声）
   * - `currentDigests` 是 `{}` → 接线了、磁盘上什么都没有 → 所有申报都落空，全报
   * - 已被 E_BINDING_STALE 点过的 (owner, path) 不再报本条 —— 那条已经说了"现在已缺失"，
   *   同一个事实说两遍会把真正的信号稀释掉（与 D10 处理 E_UNBOUND_ARTIFACT 同一口径）
   *
   * 判不了什么（写清楚，不装作能判）：
   * - 文件在、但内容是错的 / 是空壳 —— 本条只看存在性，内容由 sha256 那一段管
   * - 文件在、但不是我方生成的（越权改动）—— E_OUT_OF_SCOPE / E_UNREPORTED_CHANGES 管
   * - 磁盘读取本身失败（权限、编码）与"确实不存在"在这里**分不开**：`currentDigests`
   *   只告诉我们"有没有拿到指纹"。—— 所以文案只能说"不在或读不出来"，不许说"不存在"
   */
  if (isPlainObject(input?.currentDigests)) {
    for (const task of tasks) {
      if (task.status !== COMPLETED) continue;
      if (!CODE_CHANGING_KINDS.has(task.kind)) continue;
      const missing = [];
      for (const raw of task.changedPaths) {
        const path = normalizePath(raw);
        if (!path) continue;
        if (digestByPath.has(path)) continue; // 在磁盘上，这条不关我事
        if (staleByOwnerPath.has(staleKey(task.id, path))) continue; // STALE 已经说了
        if (missing.includes(path)) continue;
        missing.push(path);
      }
      if (missing.length === 0) continue;
      add(
        'E_ARTIFACT_UNVERIFIED',
        `任务 ${task.id} 申报的产物在工作区里查不到：${missing.join('、')}。`
          + '（本条只说"没拿到指纹"——不在、或者读不出来，两种情况在这里分不开，所以不替磁盘下结论。）'
          + '先确认这个文件该不该存在：该存在就把它补回工作区，不该存在就从申报里删掉。',
        taskIdOf(task),
      );
    }
  }

  // ── 15. 提案必须被独立评审读过（task-21 开会流程）───────────────────────────
  /*
   * 判据（照 `E_UNBOUND_ARTIFACT` 同一条道理：「申报了东西、却没有任何针对它的评审」）：
   *
   *   存在一条 **已完成的** `kind: proposal`，但**没有任何一条** `kind: review`
   *   的 `reviewedTaskId` 指向它 → `E_PROPOSAL_UNREVIEWED`。
   *
   * 为什么一条没人读过的方案等于没提案：
   *   开会流程的全部价值在"多份独立方案 + 一个人收敛"。若方案写完就没人读，
   *   那它只是一个人自言自语，**而用户会以为团队已经商量过了** —— 这比不开会更糟。
   *   这与 `E_UNBOUND_ARTIFACT`（"改了文件却没人针对这些文件评审"）是同一形状：
   *   产出必须被**针对它的**评审绑定，别的任务的评审不能替它背书。
   *
   * 只要求**已完成**的 proposal：还在 `in_progress` 的方案不要求已被评审
   *   （它可能正在写，要求"写一半就得被审"只会制造假的阻断）。
   *
   * ── 边界（不许假装判住了）────────────────────────────────────────────────
   * 这条判据只能证明"**存在一条 review 记录指向它**"，证明不了：
   *   - 那条 review 是否真的认真读了方案；
   *   - 决议的质量如何（机器判不了"这个决议是否明智"）。
   * 一个不诚实的 AI 可以写一条空评审来满足它。**这条边界要一直这么说，不许省略。**
   */
  const proposalIdsWithReview = new Set(
    tasks
      .filter((task) => task.kind === REVIEW_KIND)
      .map((task) => task.reviewedTaskId)
      .filter((id) => id !== undefined),
  );
  for (const proposal of tasks) {
    if (proposal.kind !== PROPOSAL_KIND) continue;
    if (proposal.status !== COMPLETED) continue;
    if (proposalIdsWithReview.has(proposal.id)) continue;
    add(
      'E_PROPOSAL_UNREVIEWED',
      `提案 ${proposal.id} 已完成，但**没有任何一条评审指向它**`
        + '（要求存在一条 review 任务的 reviewedTaskId 等于这条 proposal 的 id）。'
        + '一份没人读过的方案等于没提案：开会流程的价值在于"独立提案 + 有人收敛"，'
        + '方案写完没人读，用户却会以为团队已经商量过了。',
      taskIdOf(proposal),
    );
  }

  // ── 15b. 提案里的待确认项必须被逐条答复（task-21 开会流程）──────────────────
  /*
   * 判据：
   *   一条**已完成**的 `kind: proposal`，它的 `contract.openQuestions` **非空**，
   *   但**没有逐条被答复** → `E_QUESTIONS_UNANSWERED`。
   *
   * "被答复"的可判形式：
   *   取所有 `kind: review` 且 `reviewedTaskId === <这条 proposal 的 id>` 的任务，
   *   把它们的 `contract.answered` 合并，然后——**每一条问题都必须存在某条答复
   *   以它的文本开头**。`answered` 的形态是 `"<问题原文> → <用户答复>"`，所以用前缀匹配。
   *
   * **必须逐条匹配，绝不能数条数。**
   *   "3 个问题、3 条答复，但其中一条答的是别的问题" 是**没有答**，不是答了。
   *   数条数会让"配错了"看起来像"答全了"，那正是这条判据唯一要防的事。
   *   测试里第 3 条（`2 个问题、2 条答复但第 2 条答的是别的问题 → 必须报`）就是钉这个的。
   *
   * 为什么这比"没人读过方案"更严重：
   *   方案里写了"要问用户"，结果没问就开工 —— **这是把用户的决定权偷偷拿走**。
   *   这是本项目最不能容忍的一类错。
   *
   * **答复只认评审任务上的 `answered`，不认提案自己写的。**
   * 读法在下一段代码里，但必须有这句话，因为踩过：把答复填进提案自己的声明块，
   * 机器一个字都读不到 —— 板上照样报"决议里没有对应的答复"，而填的人以为"我明明写上了"。
   * 填错位置和没填，在门禁眼里完全一样。那才是"字段摆在那儿却不生效"最坏的一种。
   * （同理反过来：评审的 `answered` 只对**它指向的那一份提案**有效，别的任务的答复不能替它回答。）
   *
   * 两种**不报**的情形，都是有意的：
   *   - `openQuestions: []`（想过、没有需要用户拍板的问题）→ 没问题要答，不该报。
   *   - 字段**不存在**（根本没想过）→ 也**不报**。那是解析层/gates 契约完整性的事，
   *     不是这条判据的事。在这里顺手加一条"没想过也报"会误伤那些本来就不需要问用户的活。
   *
   * ── 边界（不许假装判住了）────────────────────────────────────────────────
   * **机器判不了"AI 是不是真的问过用户"。**
   * 它只能判：**方案里列了哪些待确认项、决议里有没有逐条对应上**。
   * 一个不诚实的 AI 可以自己编答案来满足这条判据。
   * 所以错误消息一律用「决议里没有对应的答复」，**绝不写「用户未确认」** ——
   * 后者暗示我们核查过用户，而那是假的。
   */
  for (const proposal of tasks) {
    if (proposal.kind !== PROPOSAL_KIND) continue;
    if (proposal.status !== COMPLETED) continue;
    if (proposal.openQuestions.length === 0) continue; // 想过、没问题 → 不报

    /* 只收**指向这条提案**的评审的答复：别的任务的答复不能替它回答。 */
    const answers = tasks
      .filter((task) => task.kind === REVIEW_KIND && task.reviewedTaskId === proposal.id)
      .flatMap((task) => task.answered);

    /* 逐条判：每条问题都必须有某条答复**以它的原文开头**。
     * 不用全文相等 —— 答复后面还跟着 `→` 和用户的原话。 */
    const unanswered = proposal.openQuestions.filter(
      (question) => !answers.some((answer) => answer.startsWith(question)),
    );
    if (unanswered.length === 0) continue;

    add(
      'E_QUESTIONS_UNANSWERED',
      `提案 ${proposal.id} 列了 ${proposal.openQuestions.length} 个待确认项，`
        + `但决议里没有对应的答复的那几条是：${unanswered.map((q) => `「${q}」`).join('、')}。`
        + '这是**逐条比对**的结果，不是数条数：答复必须逐条以问题原文开头才算答上。'
        + '方案里写了"要问用户"却没问就开工，等于把用户的决定权拿走。'
        + '（说明：本条只核对"方案列了哪些待确认项、决议里有没有逐条对应"，'
        + '机器无法确认用户是否真的被问过、答复是否真实——不要把它读成"用户已经同意"。）',
      taskIdOf(proposal),
    );
  }

  // ── 15c. 开会是必须的（task-22）：实现类任务必须指向一份真的提案 ──────────────
  /*
   * 为什么这条必须存在（用户原话：「嗯，开会是必须的。」）：
   *   15a/15b 管的是"提案写完必须有人读、问题必须被答"，它们**都以提案存在为前提**。
   *   所以在那两条之下，一个 AI 完全可以一辈子不开会直接派工 —— 板上全绿，
   *   而"收到任务先商量"这件事从来没发生过。15a/15b 拦的是"会开得敷衍"，
   *   这一条拦的是"会根本没开"。
   *
   * 判据（`kind: implementation` 的任务，逐条）：
   *   0. **没写契约块**（`contract` 不是含契约键的对象）→ 本条沉默。
   *      那不是"没开会"，那是"连契约都没写"，账归 E_INPUT_INVALID / E_CONTRACT_INCOMPLETE。
   *      沉默也不构成绕路：不写契约的任务本来就被那两条扣死，交付资格根本到不了这里。
   *   1. `proposalId` 缺失，且没有 `skipMeeting` 理由 → `E_MEETING_MISSING`（blocker）
   *   2. `proposalId: skip`，且没有 `skipMeeting` 理由 → `E_MEETING_SKIP_UNEXPLAINED`（blocker）
   *   3. `proposalId: skip` + 有理由        → `E_MEETING_SKIPPED`（**warning**，留痕不阻断）
   *   4. `proposalId` 指向不存在的任务      → `E_PROPOSAL_UNKNOWN`（blocker）
   *   5. `proposalId` 指向的不是 proposal   → `E_PROPOSAL_KIND`（blocker）
   *   6. 提案还没完成                       → `E_PROPOSAL_NOT_READY`（blocker）
   *   7. 提案已完成 → 不报；它自己是否"被读过/问题是否被答"由 15a/15b 各自负责，
   *      **不在这里复述**（同一条事实只判一处，否则两份结论会漂）。
   *
   * 边界（不许假装判住了）：
   *   `proposalId` 只证明"这条任务声明了它的方案来源"，**不证明**那份提案真的商量过它。
   *   一个不诚实的 AI 可以给任意提案塞一个指针。能判住的是"有没有指"，判不住的是"指得对不对"。
   */
  const tasksById = new Map();
  for (const task of tasks) {
    if (task.idDeclared) tasksById.set(task.id, task);
  }
  for (const task of tasks) {
    if (task.kind !== IMPLEMENTATION_KIND) continue;
    /* 没写契约块 → 本门禁沉默（判据见 normalizeTask 的 `contractDeclared`）。
     * 沉默不等于放行：这类任务已被 E_INPUT_INVALID / E_CONTRACT_INCOMPLETE 扣住。 */
    if (!task.contractDeclared) continue;

    const isSkip = task.proposalId === SKIP_MEETING
      || (task.proposalId === undefined && task.skipMeeting !== undefined);

    if (isSkip) {
      if (task.skipMeeting === undefined) {
        add(
          'E_MEETING_SKIP_UNEXPLAINED',
          `任务 ${task.id} 用 proposalId: skip 声明跳过开会，但没写 skipMeeting 理由。`
            + '例外可以开，但必须留痕：把"为什么这件活不必先商量"写进 skipMeeting ——'
            + '没有理由的例外汇总起来就等于没有这条门禁。',
          taskIdOf(task),
        );
        continue;
      }
      warnings.push({
        code: 'E_MEETING_SKIPPED',
        taskId: taskIdOf(task),
        message: `任务 ${task.id} 跳过了开会，理由：${task.skipMeeting}。`
          + '（不阻断：例外本来就是允许的。但这条会留在台账上，'
          + '复盘时能看出哪些活是没商量就动手的。）',
      });
      continue;
    }

    if (task.proposalId === undefined) {
      add(
        'E_MEETING_MISSING',
        `任务 ${task.id} 是实现类（kind=implementation），但没有指向任何提案：`
          + '开会这一步被跳过了。开工前先产出一份 kind: proposal 的任务（它负责商量'
          + '"要不要扩展、要问用户什么、按什么方案做"），然后在这里写 proposalId: task-NN。'
          + '确认这件活确实不需要商量，就写 proposalId: skip 加 skipMeeting 理由 ——'
          + '例外允许，无声跳过不允许。',
        taskIdOf(task),
      );
      continue;
    }

    const proposal = tasksById.get(task.proposalId);
    if (!proposal) {
      add(
        'E_PROPOSAL_UNKNOWN',
        `任务 ${task.id} 的 proposalId=${JSON.stringify(task.proposalId)} 指向一条不存在的任务：`
          + '这个指针落空了。写错的 id 与没写一样，但更容易被误读成"已经开过会"——'
          + '所以这里必须报，不能当成缺失放过。',
        taskIdOf(task),
      );
      continue;
    }
    if (proposal.kind !== PROPOSAL_KIND) {
      add(
        'E_PROPOSAL_KIND',
        `任务 ${task.id} 的 proposalId 指向 ${proposal.id}，但那条任务的 kind=`
          + `${proposal.kind === '' ? '空字符串' : proposal.kind}，不是 ${PROPOSAL_KIND}。`
          + '指一条实现任务或评审任务当"方案"等于自己给自己批方案。',
        taskIdOf(task),
      );
      continue;
    }
    if (proposal.status !== COMPLETED) {
      add(
        'E_PROPOSAL_NOT_READY',
        `任务 ${task.id} 指向的提案 ${proposal.id} 还没完成（status=${proposal.status || '空'}）：`
          + '会还没开完就开工了。等提案完成（方案定下来）再派实现。',
        taskIdOf(task),
      );
      continue;
    }
  }

  // 返回形状：`warnings` **只在非空时出现**。
  // 理由：现有调用方（包括评审的验收基线）对 `{ok, blockers}` 做整体深比较，无条件加字段会
  // 把所有这样的断言变成红；而 `ok` 语义不变（warning 不阻断）。有空 warnings 时再出现，
  // 既保住向后兼容，又不会让 warning 悄悄消失。
  const result = { ok: blockers.length === 0, blockers };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

/* ------------------------------------------------------------------------- */
/* 分工独立性（D-13）                                                          */
/* ------------------------------------------------------------------------- */

/** 同一人同一路径的 pass 次数达到这个值 → 注意力衰减警告。 */
const STAGNATION_THRESHOLD = 3;

/**
 * 归属字段的规范化：规范形非空才算"有归属"。
 *
 * 为什么要规范化（大小写敏感、空白不敏感）：
 *   - 宿主 id 是大小写敏感的，大小写不同就是不同的人 —— 不能 toLowerCase 蒙过去（J-1）；
 *   - 但"差一个空格"不是另一个人，若按原文比较，多敲一个空格就成了绕开自审检测的手段。
 *
 * 实现统一在 `contract.normalizeIdentity`（trim + 内部连续空白折叠、保留大小写），
 * 这里**不再本地 trim**。本地 trim 漏掉的正是"内部连续空白"这条轴：`'a  b'` 与 `'a b'`
 * 会被当成两个人，于是一个内部双空格就能让 E_SELF_REVIEW 不触发（SD-2）。
 * 显示层消毒（`@`→`＠` 等）仍归 board.mjs，不在身份层做。
 * @param {unknown} task
 * @returns {string} 空串 = 没有归属
 */
function assigneeOf(task) {
  const raw = isPlainObject(task) ? task.assignee : undefined;
  return publicNormalizeIdentity(raw); // 空串 = 没有归属
}

/**
 * 分工独立性判定（D-13）—— 三条判据，可独立于 canDeliver 单独调用。
 *
 * 为什么 `assignee` 够用：它来自宿主 `TeamTaskView.ownerName`，claim 由宿主 CAS 写入、
 * 模型改不动。所以这里判的是**归属关系**，不是身份认证 —— 不需要 session。
 * （第 3 轮把"需要归属"错判成"需要 session"，才让 E_SELF_REVIEW 挂账了六轮。）
 *
 * 1) `E_SELF_REVIEW`（blocker）：review 的 assignee 与被审任务相同
 * 2) `E_NO_ASSIGNEE`（blocker，混合制）：团队里只要有任意任务带 assignee，
 *    所有质量 kind（implementation / review）都必须带 —— 归属存在时 fail-closed；
 *    完全不存在时进 legacy 模式（否则存量数据全红，而且"部分有归属"本身就是强信号）
 * 3) `E_REVIEW_STAGNATION`（warning，不阻断）：同一 (assignee, 制品路径) **连续** ≥3 次 pass
 *
 * 关于"连续"：用任务自带的 `revision` 排序（宿主提供，越大越新），缺失时退回数组顺序；
 * 中间夹一次非 pass 评审就断（`needs_revision` 意味着有人看出了问题，衰减计数应当归零）。
 * 没有 revision 也不谎报"连续"——那种情况下按输入顺序算，这是本判据的已知近似。
 *
 * 永不抛错：`tasks` 不是数组 / 元素不是对象 → 空 violations。
 * @param {{tasks?: Array<object>}} [input]
 * @returns {{violations: Array<{code:string, taskId:string, message:string, severity:'blocker'|'warning'}>}}
 */
export function separationOfDuties(input = {}) {
  const list = Array.isArray(input?.tasks) ? input.tasks.filter(isPlainObject) : [];
  const violations = [];

  const byId = new Map();
  list.forEach((task, index) => {
    const id = nonEmptyString(task.id);
    if (id && !byId.has(id)) byId.set(id, task);
    void index;
  });

  // 判据层只报"违反了哪条判据"；"我判不了"（legacy 模式）是**裁决层**的事，
  // 由 canDeliver 发 E_INDEPENDENCE_UNENFORCED —— 所以 legacy 时这里自然返回 []
  // （S-6：separationOfDuties 本身一条都不报，逃生门仍在，但会在裁决层留下痕迹）。

  // ── 1. 自审：同一个 assignee 既实现又评审 ──────────────────────────────
  for (const task of list) {
    if (task.kind !== REVIEW_KIND) continue;
    const targetId = nonEmptyString(contractOf(task).reviewedTaskId) ?? nonEmptyString(task.sourceTaskId);
    if (!targetId) continue; // 没指明被审对象：那是 E_REVIEWED_TARGET_REQUIRED 的事
    const target = byId.get(targetId);
    if (!target) continue; // 指向不存在的任务：不在这里断言自审（也没有可比对的 assignee）
    const reviewer = assigneeOf(task);
    const implementer = assigneeOf(target);
    // 任一侧没有归属就无法判自审；缺归属本身由 E_NO_ASSIGNEE 兜（混合制）
    if (!reviewer || !implementer) continue;
    if (reviewer !== implementer) continue;
    violations.push({
      code: 'E_SELF_REVIEW',
      taskId: String(task.id ?? ''),
      severity: 'blocker',
      message: `评审任务 ${task.id} 与被审任务 ${targetId} 的 assignee 都是 ${JSON.stringify(reviewer)}：`
        + '同一人既提交又评审，独立性不成立（请换一个 assignee 来评审；'
        + 'assignee 应来自宿主 ownerName，模型改不了它）。',
    });
  }

  // ── 2. 混合制：有归属信息时，所有质量 kind 都必须有归属 ─────────────────
  // 判据本身就要用这个标志（混合制），所以它在这里算一次；legacy 的"判不了"由裁决层另算。
  const hasAnyAssignee = list.some((task) => assigneeOf(task) !== '');
  if (hasAnyAssignee) {
    for (const task of list) {
      if (!QUALITY_KINDS.includes(task.kind)) continue;
      if (assigneeOf(task)) continue;
      violations.push({
        code: 'E_NO_ASSIGNEE',
        taskId: String(task.id ?? ''),
        severity: 'blocker',
        message: `本团队已有归属信息（其他任务带了 assignee），但任务 ${task.id}（kind=${task.kind}）缺失 assignee：`
          + '归属要么全填、要么全不填 —— 只填一部分会让独立性判定只覆盖一部分任务，'
          + '剩下的就是逃生门。插件层应从宿主 ownerName 灌入 assignee。',
      });
    }
  }

  // ── 3. 注意力衰减：同一人同一路径连续 pass（warning，不阻断）────────────
  /** 逐条评审记录（一个评审 × 一个制品路径算一条），带排序键。 */
  const stamps = [];
  list.forEach((task, index) => {
    if (task.kind !== REVIEW_KIND) return;
    const reviewer = assigneeOf(task);
    if (!reviewer) return;
    const revision = typeof task.revision === 'number' && Number.isFinite(task.revision)
      ? task.revision
      : null;
    const verdict = task.reviewed?.verdict;
    for (const artifact of artifactsOf(task)) {
      const path = normalizePath(artifact.path);
      if (!path) continue;
      stamps.push({
        assignee: reviewer,
        path,
        verdict,
        taskId: String(task.id ?? ''),
        revision,
        index,
      });
    }
  });

  const groups = new Map(); // `${assignee}\u0000${path}` -> stamps[]
  for (const stamp of stamps) {
    const key = `${stamp.assignee}\u0000${stamp.path}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(stamp);
  }

  for (const group of groups.values()) {
    // 有 revision 就按 revision 升序（旧 → 新）；缺失的排到后面，用数组顺序兜底
    group.sort((a, b) => {
      const ra = a.revision === null ? Number.POSITIVE_INFINITY : a.revision;
      const rb = b.revision === null ? Number.POSITIVE_INFINITY : b.revision;
      if (ra !== rb) return ra - rb;
      return a.index - b.index;
    });

    let run = 0;
    let lastTaskId = '';
    let maxRun = 0;
    for (const stamp of group) {
      if (stamp.verdict === 'pass') {
        run += 1;
        lastTaskId = stamp.taskId;
        if (run > maxRun) maxRun = run;
        continue;
      }
      run = 0; // 中间出现非 pass（例如 needs_revision）→ 连续计数归零
    }

    if (maxRun < STAGNATION_THRESHOLD) continue;
    violations.push({
      code: 'E_REVIEW_STAGNATION',
      taskId: lastTaskId,
      severity: 'warning',
      message: `${JSON.stringify(group[0].assignee)} 对 ${group[0].path} 连续 ${maxRun} 次 pass 评审：`
        + '同一人反复看同一处，注意力衰减的风险随次数上升 —— 这是提醒，不阻断交付；'
        + '换一个评审人，或让中间的评审给出非 pass 结论，这条就会消失。',
    });
  }

  return { violations };
}

/* ------------------------------------------------------------------------- */
/* 自描述：错误码归属                                                          */
/* ------------------------------------------------------------------------- */

/** 本模块会主动报出的 blocker 码。 */
export const DELIVERY_BLOCKER_CODES = Object.freeze([
  'E_NOT_RUNNING',
  'E_NEEDS_HUMAN_APPROVAL',
  'E_INPUT_INVALID',
  'E_CONTRACT_AMBIGUOUS',
  'E_CONTRACT_INCOMPLETE',
  'E_SELF_REVIEW',
  'E_NO_ASSIGNEE',
  'E_TASK_INCOMPLETE',
  'E_FAILED_NO_FOLLOWUP',
  'E_VERDICT_REQUIRED',
  'E_NO_PASSING_REVIEW',
  'E_PATH_UNSAFE',
  'E_OUT_OF_SCOPE',
  'E_WORK_DECLARED_CHANGES',
  'E_BINDING_STALE',
  'E_BINDING_UNVERIFIABLE',
  'E_NEEDS_HUMAN_DELIVERY',
  'E_CANCELLED_NO_REASON',
  'E_STALE_ATTEMPT',
  'E_UNREPORTED_CHANGES',
  'E_UNBOUND_ARTIFACT',
  /* task-21（开会与方案流程）：提案必须被独立评审读过。
   * 登记在这里是硬要求 —— C-2「账本不许说谎」那条测试会扫源码里 add() 的码，
   * 逐个核对它在本表里；不登记会红，而不是"漏了也没人知道"。 */
  'E_PROPOSAL_UNREVIEWED',
  /* task-21：提案的待确认项必须被决议逐条答复。
   * 边界与上面那条一致 —— 本码只判"列了哪些、有没有逐条对应"，
   * 判不了"用户是不是真的被问过"。 */
  'E_QUESTIONS_UNANSWERED',
  /* task-22（开会是必须的）：实现类任务必须先有一份提案。
   * 这一族码存在的理由：15a/15b 都以"提案存在"为前提，所以它们拦的是
   * "会开得敷衍"，拦不住"会根本没开"。下面五条堵的就是那个洞。 */
  'E_MEETING_MISSING',
  'E_MEETING_SKIP_UNEXPLAINED',
  'E_PROPOSAL_UNKNOWN',
  'E_PROPOSAL_KIND',
  'E_PROPOSAL_NOT_READY',
  /* v1.1（2026-11-21）：申报了改动、磁盘却没变。
   *
   * 与 E_UNREPORTED_CHANGES 是一对反向判据，两条不互相替代：
   *   有 diff 没申报 → E_UNREPORTED_CHANGES（改了没报）
   *   申报了没 diff → 本条（报了没改）
   *
   * 这一族码存在的理由，是上面二十多条全都在判**卡的形状**，没有一条判
   * **卡上说的那件事在磁盘上发生了没有**。本项目自举跑 standard@1 时真实撞上过：
   * build / verify / signoff 三份报告互相印证一份"从没发生过的交付"，
   * 单看任何一份都看不出问题。形状门禁全绿，工作区一个字节没动。
   *
   * 边界（必须一直写出来）：它只证明"申报的路径在 diff 里找不到"，
   * 不证明"这个任务没干活" —— 活可能干在了没申报的文件上（那是另一条账）。 */
  'E_REPORTED_UNCHANGED',
  /* v1.1（2026-11-21）：卡片指向的依据 id 在任务表里查不到。
   *
   * sourceTaskId / sourceReviewId / reviewedTaskId 这三个字段此前只被**读出来做匹配**，
   * 从来不被**要求存在**：对得上就生效，对不上就静默。于是编造的来源与真实的来源
   * 在页面上长得一样。
   *
   * 为什么不合进 E_PROPOSAL_UNKNOWN：那条只管 proposalId。一个码盖两件事，
   * 修复时只会去看 proposalId，另外三个字段继续无人过问。
   *
   * 边界：本条只判"这个 id 在不在任务表里"，判不了"内容上是不是本该引用它的那条"。 */
  'E_BASIS_FABRICATED',
  /* v1.1（2026-11-21）：申报的产物在磁盘上查不到指纹（不在、或读不出来，两者分不开）。
   *
   * 与 E_UNBOUND_ARTIFACT / E_BINDING_STALE 的分工：
   *   14 段 E_UNBOUND_ARTIFACT   —— 没有针对它的评审（说的是"没人审"）
   *    9 段 E_BINDING_STALE      —— 评审说有、现在指纹不符或缺失（说的是"审后被动了"）
   *   本条                        —— 谁都没说，但文件本身拿不到（说的是"这东西不存在"）
   *
   * 这第三条必须单独存在，因为前两条的修法都是"补评审"，而文件不在的时候补评审永远绑不上 ——
   * 那会把用户推到一个假的方向上返工。
   *
   * 边界：「不在」与「读不出来」在 currentDigests 这一层没有区别，所以文案不许写"不存在"。 */
  'E_ARTIFACT_UNVERIFIED',
]);

/**
 * 本模块会主动报出的 **warning** 码（不阻断交付，`ok` 不受影响）。
 * 单独一张表：调用方按 severity 分流，而不是从码名去猜"这个码要不要拦"。
 */
export const DELIVERY_WARNING_CODES = Object.freeze([
  'E_REVIEW_STAGNATION',
  'E_INDEPENDENCE_UNENFORCED',
  /* task-22：声明了跳过开会、并且写了理由。不阻断 —— 例外本来就允许；
   * 但必须有码可查，否则"哪些活没商量就动手"在台账上不存在。 */
  'E_MEETING_SKIPPED',
]);

/**
 * 属于插件层（agent 身份层）职责、模块层结构上判不了的码。
 * 这里如实记账，不硬造 actor 参数。
 *
 * 第 6 轮（D-13）更新：`E_SELF_REVIEW` 已从这张表移到 enforced ——
 * 它不需要 session 身份，只需要**归属关系**，而 `assignee`（宿主 ownerName）就够。
 *
 * 第 12 轮（C-2）更新：`E_NO_ARTIFACT_BINDING` 已从这张表删除。它当时记的条件
 * （"申报了改动、却没有任何评审绑定这些文件"）其实已经由 `E_UNBOUND_ARTIFACT` 以 blocker 级
 * 强制；留在这里的后果是**一个从来没有 add() 的码**：它不出现在任何输出里，却让
 * "缺口已经记账"看起来像有人负责。真相是没人能从模块层补上它 —— 剩下的只有"该有几个产物"
 * 这个下界，而它需要宿主喂 diffPaths/currentDigests（插件层的审计接线）。
 * 它改为登记在 coveredElsewhere（coveredBy: E_UNBOUND_ARTIFACT），账还在、但不能被误读成
 * "本模块迟早会报它"。
 */
export const DELIVERY_PLUGIN_LAYER_CODES = Object.freeze([
  {
    code: 'E_ASSIGNEE_PROJECTION',
    owner: 'plugin/host-adapter',
    reason:
      '本模块按 assignee 判独立性（E_SELF_REVIEW / E_NO_ASSIGNEE），而 assignee 必须由插件层'
      + '从宿主 `TeamTaskView.ownerName` 灌入（claim 是宿主 CAS 写的，模型改不动）。'
      + '插件层一旦漏灌，全部任务都没有 assignee → 判定退化为 legacy 模式（不报 E_NO_ASSIGNEE），'
      + '独立性等于没接。生产环境必须保证"每个任务都有 assignee"。',
  },
]);

/**
 * 交给插件层集成的自描述：本模块报哪些码、哪些码不归本模块、几个契约依赖当前取自哪里。
 * @returns {{module:string, enforced:string[], pluginLayer:Array<object>, coveredElsewhere:Array<object>, contractSource:object}}
 */
export function describeDeliveryContract() {
  return {
    module: 'plugin/src/delivery.mjs',
    enforced: [...DELIVERY_BLOCKER_CODES],
    warnings: [...DELIVERY_WARNING_CODES],
    pluginLayer: DELIVERY_PLUGIN_LAYER_CODES.map((entry) => ({ ...entry })),
    coveredElsewhere: [
      {
        code: 'E_BINDING_OWNER_MISMATCH',
        coveredBy: 'E_UNBOUND_ARTIFACT',
        reason:
          '评审记录过该路径、但归属任务不是申报者，属于"未被针对该任务绑定"的一种，'
          + '统一报 E_UNBOUND_ARTIFACT（message 里点出实际归属），避免同一缺陷两个码。',
      },
      {
        code: 'E_SCOPE_UNDECLARED',
        coveredBy: 'E_OUT_OF_SCOPE',
        reason:
          'inScope/outOfScope 都为空时 classifyPath 一律返回 undeclared ≠ in_scope，'
          + '所以空契约在本模块本来就 fail-closed，不需要额外码。',
      },
      {
        code: 'E_CONTRACT_INCOMPLETE',
        coveredBy: 'gates 同名码',
        reason:
          '与 gates 的 E_CONTRACT_INCOMPLETE 同码同义（契约缺少质量声明）。范围差异：'
          + 'delivery 侧把 verify 一并要求，因为交付时"没有 verify"同样无法说明这份交付被验证过；'
          + 'gates 侧只要求 acceptance（它自己负责 verify 覆盖对账）。',
      },
      {
        code: 'E_BINDING_OWNER_UNTESTED',
        coveredBy: 'E_UNBOUND_ARTIFACT + E_BINDING_STALE',
        reason:
          'D10 之后：有绑定记录但指纹不符只报 E_BINDING_STALE（篡改信号单独出现），'
          + '完全没有记录才报 E_UNBOUND_ARTIFACT。两者不再同时出现在同一条路径上。',
      },
      {
        code: 'E_NO_ARTIFACT_BINDING',
        coveredBy: 'E_UNBOUND_ARTIFACT',
        reason:
          '第 12 轮（C-2）从 pluginLayer 移到这里。它想表达的"某实现任务声称改了文件、'
          + '却没有任何评审绑定这些文件"，正是 E_UNBOUND_ARTIFACT 作为 blocker 已经在做的事：'
          + '第 14 段按 (owner, path) 建索引，要求 reviewedTaskId/sourceTaskId 指向申报者本人，'
          + '且 artifacts 里该 path 的 sha256 等于当前指纹。补一个 warning 级同义码＝同一缺陷两个码。'
          + '剩下的"该有几个产物"下界需要宿主把 diffPaths/currentDigests 当审计输入喂进来，'
          + '属插件层审计接线，不在本模块能力范围内。'
          + '对应规格 §5.3 那行（reviewed_artifacts 为空 → E_NO_ARTIFACT_BINDING）：判据没丢，'
          + '只是在本插件里以 E_UNBOUND_ARTIFACT 这个名字实现——读规格时要按 (condition) 而不是按码名对账。',
      },
    ],
    contractSource: {
      contractOf: 'contract.mjs',
      contractAmbiguity: publicContractAmbiguity ? 'contract.mjs' : 'local-equivalent',
      toEntryList: 'contract.mjs',
      toEntryListStrict: publicToEntryListStrict ? 'contract.mjs' : 'local-equivalent',
      classifyPath: 'contract.mjs',
      normalizePath: 'contract.mjs',
      // W3-1：中文 reason 只有契约那一份；本模块不保留第二份中文表
      describePathIllegal: publicDescribePathIllegal ? 'contract.mjs' : 'generic-fallback (无分类中文)',
      pathIllegalReasons: publicPathIllegalReasons ? 'contract.mjs' : 'missing',
    },
  };
}

/**
 * 作者推理的**分节标记**。出现在盲阶段的投递消息里 = 推理被拼进去了。
 *
 * 为什么用标记而不是关键词匹配：标记是**结构**信号（作者写"理由："是为了分节），
 * 而关键词（"因为""所以"）在正当的产物里也会出现 —— 那种判据会在正确的时候红。
 * 判据宁可窄而准：漏判一次是"没抓到"，误判一次是"把这条码变成噪音"，
 * 而一旦它时常误报，真泄漏也就没人看了。
 *
 * `authorReasoningMarkers` 可以由调用方覆盖；这里只是**默认口径**，不是唯一口径。
 */
export const AUTHOR_REASONING_MARKERS = Object.freeze(['理由：', '推理：', '作者推理：', '依据（推理）：']);

/* ═══════════════════════════════════════════════════════════════════════════
 * P3-11：盲阶段泄漏检测（`E_BLIND_LEAK` 的**唯一**发射点）
 *
 * ## 为什么这条函数必须存在
 *
 * `E_BLIND_LEAK` 是批 2 的 blocker，文案承诺「盲阶段看见了不该看见的东西」。
 * 但在它之前，全项目**没有任何代码路径**做这个判断：组装侧（`composeDelivery`）
 * 按 `blind` 剔推理、按 `withheld` 藏产物，**却不检查结果真的干净**。
 * 于是"盲阶段静默失效"是一种可能的现实：一次漏填、一次多拼，账本、门禁、页面
 * 全部显示正常，而整个对抗式评审的前提（审稿人没看过作者的推理）已经不成立了。
 *
 * 这是本项目第五次撞上同一个形状 —— `judgeArtifact.warnings` 空通道 /
 * `E_SUGGEST_UPGRADE` 空规则 / `writeMeetingLedger` 零调用方 / `agent` 只写不读 /
 * 现在的 `E_BLIND_LEAK` 零检测点。五次都是「**看起来两边都在，实际只有一侧**」。
 *
 * ## 两条判据都要可证伪
 *
 * 1. **产物 id 泄漏**：`forbiddenIds` 里任一 id 出现在消息文本里 → 报错并**点名是哪个**；
 * 2. **推理泄漏**：作者推理的分节标记（`理由：` / `推理：` …）出现在消息里 → 报错。
 *
 * **不用"消息长度"这类间接信号** —— 长度正常的消息照样可能带着一整段推理，
 * 而长度超标的正当消息（产物清单很长）会被误判。误报会把这条码变成噪音，
 * 而噪音是这类检测器最大的敌人（一旦它时常误报，真泄漏也就没人看了）。
 *
 * ## 非盲阶段不检测（这条最容易做错）
 *
 * 非盲阶段**本来就该**看见上一阶段的 claim 与产物，所以它直接 `ok: true` 返回，
 * 而且**不产生 warnings**（本项目禁令：不许留空通道）。不钉住这条，
 * 就会做出一个"全局扫描器"，然后在完全正确的时候满屏报错。
 *
 * @param {object} input `{ stage, message, forbiddenIds, authorReasoningMarkers }`
 * @returns {{ok: boolean, errors: Array<object>, warnings: Array<object>}}
 *   `errors[]` 的形状与全项目一致：`{ code: 'E_BLIND_LEAK', message, field? }`。
 */
export function detectBlindLeak(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const stage = source.stage !== null && typeof source.stage === 'object' ? source.stage : null;

  /* 非盲阶段：**不检测**，也不留空通道。 */
  if (stage === null || stage.blind !== true) return { ok: true, errors: [], warnings: [] };

  const stageId = typeof stage.id === 'string' && stage.id !== '' ? stage.id : undefined;
  const message = typeof source.message === 'string' ? source.message : '';

  /* 这两样都可以由调用方覆盖：默认值只保证"你没传时有个合理口径"，
   * 而不是"你必须接受我的口径"。 */
  const forbiddenIds = Array.isArray(source.forbiddenIds)
    ? source.forbiddenIds.filter((id) => typeof id === 'string' && id !== '')
    : [];
  const markers = Array.isArray(source.authorReasoningMarkers)
    ? source.authorReasoningMarkers.filter((item) => typeof item === 'string' && item !== '')
    : AUTHOR_REASONING_MARKERS;

  const errors = [];

  /* ① 产物 id 泄漏：逐个点名。一个 id 一条错 —— 合成一条会让人以为只漏了一个。 */
  for (const id of forbiddenIds) {
    if (!message.includes(id)) continue;
    errors.push({
      code: 'E_BLIND_LEAK',
      field: typeof stageId === 'string' ? stageId : undefined,
      message: `盲阶段 ${stageId ?? '（未知）'} 的投递消息里出现了本该扣住的产物 \`${id}\` —— `
        + '这是泄漏本身，不是复用的副作用：这一阶段已经没有"没看过"这个前提了，'
        + '它的质疑不再独立，结论只能作废重跑。',
    });
  }

  /* ② 推理泄漏：分节标记出现在消息里，说明作者的理由被拼进去了。 */
  for (const marker of markers) {
    if (!message.includes(marker)) continue;
    errors.push({
      code: 'E_BLIND_LEAK',
      field: typeof stageId === 'string' ? stageId : undefined,
      message: `盲阶段 ${stageId ?? '（未知）'} 的投递消息里出现了作者推理的分节标记「${marker}」—— `
        + '盲阶段只该拿到产物，不该拿到"为什么这么想"。',
    });
  }

  return { ok: errors.length === 0, errors, warnings: [] };
}
