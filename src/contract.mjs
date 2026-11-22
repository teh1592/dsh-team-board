/**
 * DSH 团队插件 —— 任务单（plan）校验
 *
 * 纯函数模块：零依赖、纯 ESM、不做任何 I/O。
 * 对外契约（其他模块按此实现，勿改）：
 *   KINDS / validatePlan(tasks, ctx) / contractOf(task) / toEntryList(value)
 *   / normalizePath(p) / classifyPath(path, inScope, outOfScope)
 * 新增（第二轮评审 C2 / C4 的产物，可增量使用）：
 *   contractAmbiguity(task) → string[]            contract 与顶层异值的字段名
 *   toEntryListStrict(value) → { entries, illegal }  toEntryList 的诊断版
 * 冻结导出的常量（第 4 轮 W1-1 / W1-2，跨模块口径的唯一来源，勿改内容）：
 *   PATH_ILLEGAL_REASONS                          toEntryListStrict 的 illegal[].reason 枚举
 *   describePathIllegal(reason) → string           该枚举的中文人话（拼错误信息用）
 *   CONTRACT_FIELDS                               契约字段清单（E_CONTRACT_AMBIGUOUS 的覆盖面）
 *   QUALITY_KINDS                                 需要质量门禁的 kind（gates / delivery 共用）
 * 跨模块口径的唯一实现（第 7 轮 A-3 / SD-2，兄弟模块必须 import，不许抄副本）：
 *   normalizeIdentity(value) → string              身份规范形：trim + 内部空白折叠，保留大小写
 * D-14（kind 从哪来）：
 *   parseDeclaration(text) → { kind?, contract?, warnings }  解析 description 里的 team-board 声明块
 *
 * 两条硬性质：
 *   1. validatePlan 收集**全部**错误后一次性返回，绝不在第一条错误处短路。
 *   2. 每条规则上方的注释都标注了它对应的错误码，方便评审逐条核对。
 *
 * 契约字段的唯一取值入口是 contractOf(task)：
 *   - 新写法（规格 §3.2）：acceptance / verify / inScope / outOfScope / reviewedTaskId / objective
 *     写在 task.contract 下，且 **contract 至少含 1 个自有键**；
 *   - 旧写法：同样的字段直接写 task 顶层，仍然兼容；
 *   - `contract: {}` / `contract: null` / `contract` 非对象 **等于没声明**，一律回退 task 本身
 *     （空对象是零信息，把它当成"声明了一份空契约"只会让三行之外的字段凭空消失）；
 *   - 两处**都写了同名字段且取值不同**时，取值仍然只用 contract 那份（不合并），
 *     但 `contractAmbiguity(task)` 会把字段名点出来，validatePlan 报 E_CONTRACT_AMBIGUOUS。
 *   - id / kind 不是契约字段，永远读 task 本身；objective 是契约字段，读 contractOf(task)。
 *
 * acceptance ↔ verify 的映射约定（E_ACCEPTANCE_UNVERIFIABLE 依赖它）——**显式契约，不做词元猜测**：
 *   只有两条通道，任一满足即算映射：
 *     1. `[ACn]` 标签通道：acceptance 里的 `[AC1]` 与某个 verify 项里的 `[AC1]` 命中
 *        （标签只认数字：`[ACx]` 不是标签；`[AC1]` 不能靠 verify 的 `[AC2]` 蒙过去）。
 *     2. 逐字包含通道：acceptance 文本**完整包含**某个 verify 项的原文。
 *        比较前两边统一做：trim、折叠连续空白、小写化、去掉尾部标点 —— 确定性判定，不是模糊匹配。
 *   除此之外一律 E_ACCEPTANCE_UNVERIFIABLE，错误信息直接写出修法。
 *   不再有"共享词元权重"之类调参设施：那套东西既会误判合法输入（中文验收 + 英文命令），
 *   也会让验收项靠提到命令名蒙过去。
 */

/**
 * 合法的任务 `kind` 全集。
 *
 * **冻结导出（跨模块口径，勿改内容）**：这张表是"有哪几类活"的唯一真相源。
 * 补冻结的理由（D-14）：`delivery.mjs` 里曾有一份逐字重抄的
 * `const KNOWN_KINDS = new Set(['implementation','review','work'])`，注释还自写"与 contract.mjs
 * 的 KINDS 同口径"——**同口径是靠人记着的，不是靠代码保证的**。全仓四份 kind 相关清单，
 * 漂移时没有任何东西报警。冻结是最便宜的一道：至少"有人顺手 push 一个新 kind 进来"
 * 会当场抛 TypeError，而不是让某一处悄悄变成唯一不认它的地方。
 * 需要扩展时只改这里；兄弟模块一律 `import { KINDS } from './contract.mjs'`。
 */
export const KINDS = Object.freeze(['implementation', 'review', 'work', 'proposal']);

/**
 * 需要质量门禁（objective / acceptance）的 kind；work 只是纯执行项，不设门禁。
 *
 * **冻结导出（跨模块口径，勿改内容）**：这张表的语义是"哪些 kind 必须过契约完整性检查"，
 * gates（完成门禁）与 delivery（交付裁决）必须与它**同一份**——不是各写一份字面量副本。
 * 三份副本的后果是：以后新增一个 kind，必漏一处，而漏掉的那一处就是一条新的 fail-open
 * （第 6 轮"gates 查 review 契约、delivery 不查"就是这么来的）。
 * 需要扩展时只改这里；兄弟模块一律 `import { QUALITY_KINDS } from './contract.mjs'`。
 */
export const QUALITY_KINDS = Object.freeze(['implementation', 'review']);

/* ------------------------------------------------------------------------- */
/* 身份规范化（SD-2：身份规则只允许这一个实现，且与显示消毒彻底分离）        */
/* ------------------------------------------------------------------------- */

/**
 * 身份（`ownerName` / `assignee` / `me` …）的**规范形**：`trim` + 把内部连续空白折叠成
 * 单个半角空格；**保留大小写**；**不降级、不清除任何字符**。
 *
 * 为什么需要它（SD-2 的裁决）：身份规则原来有两套实现——board 的 `clean()`（顺带做了
 * 显示降级）和 delivery 的 `assigneeOf()`（只 trim）。两套实现必然在某条轴上分岔，
 * 当时漏的那条是**内部连续空白**：`'a  b'` 在板上算同一人、在门禁里算两个人，
 * 于是一个内部双空格就能让 `E_SELF_REVIEW` 不触发。所以：**只允许这一个实现**，
 * 兄弟模块一律 `import { normalizeIdentity } from './contract.mjs'`，不许再抄一份。
 *
 * 三条边界（都很容易被人"顺手"改坏）：
 *   1. **不折叠大小写**。宿主 id 大小写敏感（`Alice`/`alice` 是两个成员）；这里宽容会把
 *      一次合法的他人评审误判成自审（假阳），代价比漏判大。
 *   2. **空白敏感无意义、必须折叠**。多敲一个空格就换成"另一个人"＝绕开自审检测，
 *      这条防线是 delivery 那边论证过的，不能拆。
 *   3. **这不是显示消毒**。`@`→`＠`、`：`→`：`、`!`→`！`、ANSI/控制符清除都是 `board.mjs`
 *      里 `clean()` 的活。若这里也做，等于把显示规则搬回身份层——这轮修完下轮再犯。
 *      控制符留在规范形里只会让两个名字不相等，方向是安全的（fail-closed）。
 *
 * 非字符串（`null` / `undefined` / 数字 / 对象 / 符号）一律返回 `''`，**永不抛错**：
 * 规范形为空 = 没有归属，调用方据此报"缺声明"，而不是在这里炸掉。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeIdentity(value) {
  if (typeof value !== 'string') return '';
  // `\s` 已覆盖半角空格、\t、\n、\r、\u00a0、\ufeff 与全角空格 \u3000。
  return value.replace(/\s+/g, ' ').trim();
}

/** E_TEAM_NOT_JUSTIFIED 的阈值：任务数 ≤ 2、inScope 路径数 ≤ 2、且没有 review 任务。 */
const SMALL_TEAM_TASKS = 2;
const SMALL_TEAM_FILES = 2;

/* ------------------------------------------------------------------------- */
/* 通用小工具                                                                 */
/* ------------------------------------------------------------------------- */

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function describeValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function truncate(text, max = 48) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 是否是"普通对象"（排除 null / 数组）。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 契约字段清单（歧义判定只看这些键，id/kind/subject/assignee 属于任务元数据）。
 *
 * **冻结导出（跨模块契约，勿改）**：`contractAmbiguity` 与 `E_CONTRACT_AMBIGUOUS` 的覆盖面
 * 完全由这张表决定。**新增契约字段必须同步这里**，否则新字段在两处写不同值时会被静默漏检
 * （delivery / gates 也可能按这张表判断"哪些键算契约"）。
 * 顺序即歧义检测的遍历顺序；导出的是冻结数组，运行时不可被 push / 改写。
 */
export const CONTRACT_FIELDS = Object.freeze([
  'acceptance',
  'verify',
  'inScope',
  'outOfScope',
  'reviewedTaskId',
  'objective',
  /* task-21（开会与方案流程）：这两条是**真契约条款**，不是交付报告。
   *
   *   - `openQuestions` —— **开工前**就声明的承诺：这个需求里有哪几件事必须用户拍板。
   *   - `answered`      —— 决议里逐条对应上面对每个问题的用户答复。
   *
   * 为什么它们进 `CONTRACT_FIELDS` 而 `changed` 不进：
   *   `changed` 是**干完之后**才有的报告（我改了哪些文件）；这两条是**动手之前**就立下的条款
   *   （我要问这些 / 我已答这些）。条款参与验收判定，报告不参与。
   *
   * 「空 vs 缺失」对这两条是**命脉级**的区别（见 `DECLARATION_LIST_FIELDS` 的注释）。 */
  'openQuestions',
  'answered',
  /* task-22（开会是必须的）：这两条把"开会"从可选变成不可跳过。
   *
   *   - `proposalId`  —— 实现类任务**指向**产出它的那份提案（`task-NN`），或字面量 `skip`。
   *   - `skipMeeting` —— 跳过开会时**必写**的理由。
   *
   * 为什么 `proposalId` 必须是**指针**而不是"团队里存在某份提案就算"：
   * 这与 `reviewedTaskId` 是同一条治法 —— 关系要能精确对上，不能靠"有个东西在旁边"。
   * 只要允许模糊覆盖，一个 AI 写一份空提案就能给所有实现任务放行，
   * 而那正是"开会"这件事唯一要防的。
   *
   * 为什么 `skipMeeting` 也进契约：它是**开工前**的声明（我要绕过一件事，理由是X），
   * 不是干完之后的报告。它不阻断（可见性优先于强制），但必须能被台账看见。 */
  'proposalId',
  'skipMeeting',
]);

/**
 * 声明块里**按列表理解**的契约字段：行内写法当单元素列表，且「写了键但零条目」要保留成 `[]`。
 *
 * 为什么需要这个特例（与其余契约字段的"没有值 = 没写这个键"不同）：
 * 对 `openQuestions` / `answered` 来说，
 *
 *   - **没有这个键** = 「我没想过这件事」
 *   - **`[]`**        = 「我想过了，没有需要用户拍板的问题」
 *
 * 这两句话的差别是整条开会流程的命脉（规格 §三「第 4 段的可以为空是关键」）。
 * 若沿用"零条目 = 键不出现"，那"我想过了、没有问题"就永远表达不出来 ——
 * 提案人只好要么不写（被读成没想过），要么硬编一个问题（撒谎）。
 * 同一条红线本项目已经点过名：**读不出来 ≠ 零条**。
 */
const DECLARATION_LIST_FIELDS = Object.freeze(['openQuestions', 'answered']);

/**
 * 声明块里**可以有、但不是契约条款**的键：它们是**交付报告**，不是开工前的约定。
 *
 * 为什么必须分开（task-18，这是一个设计判断，别合并回去）：
 *   - `CONTRACT_FIELDS` 回答的是「这活开工前约定了什么」，门禁拿它判「够不够格验收」；
 *     `changed` 回答的是「干完之后你动了哪些文件」，那是一份**报告**。
 *   - 把报告塞进条款有两个实际后果：① `contractAmbiguity` 会拿它跟任务顶层比冲突 ——
 *     **一份报告不该有"歧义"这回事**；② gates 以后可能把"没申报改动"判成
 *     "契约不完整"，等于把交付报告混进验收标准。
 *   - `W1-2 CONTRACT_FIELDS 冻结导出` 那条断言存在的意义就是拦住"顺手往契约里加字段"，
 *     它当时红得对。所以这里**另开一个名单**，而不是放宽那个断言。
 *
 * 它仍然**不是未知键**（`DECLARATION_KEYS` 派生时把它算进去），所以写 `changed:`
 * 不会报 `E_DECLARATION_UNKNOWN_KEY`。
 *
 * 另：`changed` 与 `delivery.mjs` 的 `changedPaths` **永不合并**。后者是审计输入，
 * 要与真实 diff 对账；前者是自我申报。混用会把"自己说"读成"已核实"。
 */
export const DECLARATION_REPORT_FIELDS = Object.freeze(['changed']);

/**
 * 判定"这份 contract 到底算不算已声明"时认的键 = 契约字段 + `attempt`。
 *
 * 为什么单独加 `attempt`：D-9 让 attempt 走 `contractOf(task).attempt ?? task.attempt` 的**链式兜底**，
 * 故意不参与歧义判定，所以它不在 `CONTRACT_FIELDS` 里；但它确实只可能写在契约里，
 * 若把它排除在"是否已声明"之外，`contract: { attempt: 2 }` 会被当成没写契约 → attempt 凭空丢失。
 */
const CONTRACT_DECLARATION_KEYS = Object.freeze([...CONTRACT_FIELDS, 'attempt']);

/**
 * `task.contract` 是否**真的**声明了东西：至少含 1 个契约键（或 attempt）。
 *
 * 门槛必须是"含契约键"而不是"含任意键"（F4-1）：`contract: { note: 'x' }` 是零信息，
 * 它若被当成"已声明"，顶层那份完整契约（连非法 inScope 一起）就全部不可见，
 * 于是报出 E_OBJECTIVE_REQUIRED / E_ACCEPTANCE_REQUIRED / E_SCOPE_VERIFY_REQUIRED——
 * 字段就在三行之上，诊断方向完全错。这正是 D-2 的原意：零信息 = 未声明。
 */
function declaresContract(declared) {
  for (const key of CONTRACT_DECLARATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(declared, key)) return true;
  }
  return false;
}

/**
 * 契约唯一取值入口（其他三个模块都走这里，保证同一口径）。
 *   - task 非对象（null / 数组 / 原始值）→ 返回 {}
 *   - task.contract 是普通对象**且至少含 1 个契约键**（见 CONTRACT_DECLARATION_KEYS）
 *     → 返回 task.contract 本身（**不与顶层合并**：避免同一字段双份声明时两边打架、漂移）
 *   - 否则（contract 缺失 / `{}` / 只有无关键如 `{note:'x'}` / null / 数组 / 原始值）
 *     → 返回 task 本身（零信息视为**未声明**，回退顶层写法）
 * 永不抛错，永不返回 null/undefined。
 * @param {unknown} task
 * @returns {object}
 */
export function contractOf(task) {
  if (!isPlainObject(task)) return {};
  const declared = task.contract;
  if (isPlainObject(declared) && declaresContract(declared)) return declared;
  return task;
}

/**
 * 值的稳定规范化字符串（仅用于"两处取值是否不同"的比较）。
 * 永不抛错：循环引用沿路径检测（回溯时移出 seen），超深结构截断。
 */
function canonicalValue(value, seen = new Set(), depth = 0) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'symbol') return 'symbol';
  if (typeof value === 'number') return `number:${value}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value !== 'object') return typeof value;
  if (depth > 6) return '…';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  let text;
  if (Array.isArray(value)) {
    text = `array:[${value.map((item) => canonicalValue(item, seen, depth + 1)).join(',')}]`;
  } else {
    const keys = Object.keys(value).sort();
    text = `object:{${keys.map((key) => `${key}=${canonicalValue(value[key], seen, depth + 1)}`).join(',')}}`;
  }
  seen.delete(value);
  return text;
}

/**
 * 契约歧义检测：`task.contract` 与任务顶层**同时**写了同一个契约字段、且**取值不同**的字段名。
 *
 * 语义说明（对应 L-5 修订）：
 *   - `contract: {}` / 缺失 / 非对象 → 未声明，不算歧义（此时只用顶层）；
 *   - 两处同值 → 不是歧义（重复但一致，不值得报）；
 *   - 两处异值 → 歧义：取值仍只用 contract 那份，但必须点名告诉人删哪一处。
 * 返回**排序去重**后的字段名数组；永不抛错（任何异常都退化成 []）。
 * @param {unknown} task
 * @returns {string[]}
 */
export function contractAmbiguity(task) {
  try {
    if (!isPlainObject(task)) return [];
    const declared = task.contract;
    // 与 contractOf 同一道门槛：没声明（含只有无关键）就没有"两处"可比，不算歧义。
    if (!isPlainObject(declared) || !declaresContract(declared)) return [];

    const fields = [];
    for (const field of CONTRACT_FIELDS) {
      const inContract = Object.prototype.hasOwnProperty.call(declared, field);
      const inTask = Object.prototype.hasOwnProperty.call(task, field);
      if (!inContract || !inTask) continue;
      if (canonicalValue(declared[field]) !== canonicalValue(task[field])) fields.push(field);
    }
    return [...new Set(fields)].sort();
  } catch {
    return [];
  }
}

/**
 * 把 acceptance / verify / inScope 之类的字段统一成"原始条目数组"（内部用，保留非法条目）。
 * 单个字符串按单元素数组处理（宽松，但不改变语义）；其余非数组返回空数组。
 * E_PATH_UNSAFE 需要看到非法条目，所以这里**不**做解析过滤。
 */
function rawEntries(value) {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value;
}

/** 同上，但只保留非空字符串（用于 objective/acceptance/verify 这类文本字段）。 */
function toStringArray(value) {
  return rawEntries(value).filter(isNonEmptyString);
}

/* ------------------------------------------------------------------------- */
/* 路径：normalizePath / classifyPath 的底座                                  */
/* ------------------------------------------------------------------------- */

/**
 * 路径非法的原因枚举（**冻结导出**，跨模块契约，勿改）。
 *
 * 谁在用：
 *   - `toEntryListStrict` 返回的 `illegal[].reason` 取值**只能**来自这张表；
 *   - delivery / gates 的错误信息按 `describePathIllegal(reason)` 映射中文，
 *     不要再自己写一份中文 reason 串（两份实现必然漂移，第 3 轮就差点踩到）。
 * **新增原因必须同步这里**：`PATH_ILLEGAL_REASON_TEXT` 与枚举完整性测试会一起检查
 * （每个枚举项都要有人话输出、每个 diagnosePattern 能产出的 reason 都要在表内）。
 * 顺序 = diagnosePattern 的拒绝顺序（越靠前越先命中，因此一个值只有一种原因）。
 */
export const PATH_ILLEGAL_REASONS = Object.freeze([
  'not-string',
  'empty',
  'home',
  'control-char',
  'encoded-traversal',
  'absolute',
  'traversal',
  'colon',
]);

/** 非法原因 → 中文人话（私有；对外只经 describePathIllegal 暴露）。 */
const PATH_ILLEGAL_REASON_TEXT = Object.freeze({
  'not-string': '不是字符串（路径声明必须是字符串）',
  empty: '是空路径（空串 / 纯空白 / 只有 . 段）',
  home: '以 ~ 开头（家目录展开，指向工作区之外）',
  'control-char': '含控制字符（NUL / 换行等，可截断路径或伪造多行声明）',
  'encoded-traversal': '含百分号编码的 . / / / \\（解码后才显形的穿越）',
  absolute: '是绝对路径（POSIX /、UNC //server/share、Windows 盘符 C:/x）',
  traversal: '含 .. 穿越段（不允许跳出工作区）',
  colon: '段内含冒号（NTFS 数据流 a.txt:stream，或盘符变体 C:x）',
});

/**
 * `PATH_ILLEGAL_REASONS` 里的每个原因 → 一句中文人话，直接拼进错误信息。
 *
 * 永不抛错：未知 / 残缺的 reason 返回可读兜底——兜底里也不会出现裸的 `undefined`
 * 或 `[object Object]`（`undefined` 说"未提供"，对象说"object"）。
 * 容错：除字符串外也接受 `{ reason }` 对象，便于调用方直接把 `illegal[0]` 丢进来。
 * @param {unknown} reason
 * @returns {string}
 */
export function describePathIllegal(reason) {
  const token = typeof reason === 'string'
    ? reason
    : (isPlainObject(reason) && typeof reason.reason === 'string' ? reason.reason : undefined);
  if (token !== undefined && Object.prototype.hasOwnProperty.call(PATH_ILLEGAL_REASON_TEXT, token)) {
    return PATH_ILLEGAL_REASON_TEXT[token];
  }
  return `未知的非法原因（${describeReasonInput(reason)}）：不是安全的工作区相对路径`;
}

/** 兜底文本里"收到的到底是什么"（不给调用方看裸 undefined / [object Object]）。 */
function describeReasonInput(value) {
  if (value === undefined) return '未提供';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (isPlainObject(value)) return 'object';
  return typeof value;
}

const WINDOWS_DRIVE = /^[A-Za-z]:/;
/** 控制字符（含 NUL / 换行）：既能截断底层字符串，也能伪造多行声明。 */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
/** 百分号编码的 `.` / `/` / `\`：解码后才显形的穿越与分隔符。 */
const ENCODED_TRAVERSAL_RE = /%(2e|2f|5c)/i;

/**
 * 解析一条路径/路径模式的**诊断版**：返回 `{ ok: true, path, isDir }` 或 `{ ok: false, reason }`。
 *
 * 拒绝（原因码与拒绝顺序严格一致，reason 就是给 E_PATH_UNSAFE 用的）：
 *   - `not-string`：非字符串
 *   - `empty`：空串 / 纯空白 / 归约后没有段（`.`、`./`）
 *   - `home`：以 `~` 开头
 *   - `control-char`：含控制字符（NUL / 换行）——既能截断底层字符串，也能伪造多行声明
 *   - `encoded-traversal`：百分号编码的 `.` / `/` / `\`（解码后才显形）
 *   - `absolute`：绝对路径（POSIX `/`、UNC `//server/share`、Windows 盘符 `C:/x` 与 `C:x`）
 *   - `traversal`：任何 `..` 段（反斜杠写法 `..\..\x` 先转 `/` 再判，同样被拒）
 *   - `colon`：段内冒号（Windows 盘符相对写法、NTFS 数据流 `a.txt:stream`）
 * 归一化：反斜杠统一转 POSIX、去掉 `.` 段与空段、去掉结尾 `/`（isDir 单独记录）。
 */
function diagnosePattern(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-string' };

  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (trimmed.startsWith('~')) return { ok: false, reason: 'home' };
  if (CONTROL_CHAR_RE.test(trimmed)) return { ok: false, reason: 'control-char' };
  if (ENCODED_TRAVERSAL_RE.test(trimmed)) return { ok: false, reason: 'encoded-traversal' };

  const posix = trimmed.replace(/\\/g, '/');
  // 绝对路径 / UNC（\\server\share → //server/share）
  if (posix.startsWith('/')) return { ok: false, reason: 'absolute' };
  if (WINDOWS_DRIVE.test(posix)) return { ok: false, reason: 'absolute' }; // C:/x、C:x

  const isDir = posix.endsWith('/');
  const segments = posix.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (segments.length === 0) return { ok: false, reason: 'empty' }; // '.'、'./' 归约到工作区根
  if (segments.includes('..')) return { ok: false, reason: 'traversal' }; // 哪怕最终没逃出工作区
  if (segments.some((seg) => seg.includes(':'))) return { ok: false, reason: 'colon' };

  return { ok: true, path: segments.join('/'), isDir };
}

/** 解析一条路径/路径模式。返回 { path, isDir } 或 null（null = 不安全 / 非法）。 */
function parsePattern(raw) {
  const diagnosis = diagnosePattern(raw);
  return diagnosis.ok ? { path: diagnosis.path, isDir: diagnosis.isDir } : null;
}

/**
 * 规范化工作区相对 POSIX 路径。
 * 非法（绝对路径 / `..` 段 / `~` 开头 / 空串 / 非字符串）→ null。
 * 注意：结尾 `/` 会被去掉，目录语义请用原始模式（classifyPath 内部自己判断）。
 */
export function normalizePath(p) {
  const parsed = parsePattern(p);
  return parsed ? parsed.path : null;
}

/**
/** 由已解析的模式 + 原始声明拼出条目（toEntryList / toEntryListStrict 共用，保证两者同形）。 */
function entryFromParsed(parsed, rawValue, isDirOverride, rawText) {
  const isDir = typeof isDirOverride === 'boolean' ? isDirOverride : parsed.isDir;
  const key = isDir ? `${parsed.path}/` : parsed.path;
  // raw 必须是路径字符串（不能是 String(对象) 的 "[object Object]"）：
  // 调用方会把它当模式直接传给 classifyPath。
  const declared = typeof rawText === 'string' && rawText.trim() !== ''
    ? rawText
    : (typeof rawValue === 'string' ? rawValue : parsed.path);
  return { path: parsed.path, isDir, raw: declared, key };
}

/** 把 value 展开成声明条目列表（单条字符串 = 单元素数组；已解析对象条目原样保留）。 */
function declarationList(value) {
  return Array.isArray(value) ? value : [value];
}

/**
 * 把 inScope / outOfScope 这类声明统一成"已解析条目数组"（跨模块锁定接口，**返回形状不要改**）。
 *
 * 接受：单条字符串 | 字符串数组 | 已解析条目数组 `[{ path, isDir?, raw? }]` | 其它（→ []）。
 * 返回：`Array<{ path: string, isDir: boolean, raw: string, key: string }>`
 *   - `path` 归一化后的工作区相对 POSIX 路径（无结尾 `/`，与 normalizePath 同口径）
 *   - `isDir` 目录语义：原始写法以 `/` 结尾（或条目显式给出 isDir）
 *   - `raw`  **始终是可直接喂给 classifyPath 的原始模式字符串**（保留结尾 `/`，
 *            也就是目录语义仍在）；这样调用方拿 raw 还是 path 都能工作
 *   - `key`  去重键：目录为 `${path}/`（即 `'src/'`），文件为 `path`
 *            （目录与同名文件是两条声明，key 保留这个区分）
 * 顺序稳定（按声明顺序）、按 key 去重、永不抛错。
 *
 * 非法条目（绝对路径 / `..` 段 / `~` 开头 / 空串 / 非字符串）**被静默跳过**。
 * 需要区分"非法"与"没写"的调用方用 `toEntryListStrict`（E_PATH_UNSAFE 就是这么做的）。
 * @param {unknown} value
 */
export function toEntryList(value) {
  const entries = [];
  const seen = new Set();
  for (const item of declarationList(value)) {
    const isObject = isPlainObject(item);
    const parsed = parsePattern(isObject ? item.path : item);
    if (!parsed) continue;
    const entry = entryFromParsed(parsed, isObject ? item.path : item, isObject ? item.isDir : undefined, isObject ? item.raw : undefined);
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }
  return entries;
}

/**
 * `toEntryList` 的**诊断版**（跨模块 API，用于区分"非法"与"没写"的调用方）。
 * 返回 `{ entries, illegal }`
 *   - `entries`：与 `toEntryList(value)` **同形同序**（`{ path, isDir, raw, key }`，按 key 去重）
 *   - `illegal`：被丢弃的原始值与原因，形如 `{ raw, reason }`，顺序同声明顺序；
 *     `reason` 的值域就是冻结导出 `PATH_ILLEGAL_REASONS`，人话用 `describePathIllegal(reason)`。
 *
 * **"未声明"与"脏输入"是两件事，本函数在入口就分开**（这是 API 语义，不是实现细节）：
 *   | 输入                                   | 返回                                | 上游语义          |
 *   |----------------------------------------|-------------------------------------|-------------------|
 *   | 整值 undefined / null / '' / '   ' / [] | `{ entries: [], illegal: [] }`      | 没声明（缺声明）  |
 *   | 数组内的 undefined / null / '' / 42 …   | 每个脏元素一条 `illegal`            | 写了非法路径      |
 * 两者该走的错误码不同：没声明 → `E_SCOPE_UNDECLARED` / 缺声明；非法 → `E_PATH_UNSAFE`。
 * 所以整值缺席**绝不能**报成 `not-string`，否则每个没写 `outOfScope` 的任务都会凭空多一条
 * `E_PATH_UNSAFE`（第 3 轮 delivery 就是这么被炸出来的）。
 *
 * 为什么需要它：`toEntryList` 静默跳过非法条目，别的模块若直接拿它判范围，
 * 非法路径会退化成 `undeclared`（错误码指向"越界"而不是"声明非法"，修法被指错）。
 * 永不抛错。
 * @param {unknown} value
 * @returns {{entries: Array<{path: string, isDir: boolean, raw: string, key: string}>, illegal: Array<{raw: unknown, reason: string}>}}
 */
export function toEntryListStrict(value) {
  const entries = [];
  const illegal = [];
  const seen = new Set();
  // 整个值缺席 / 整值是空字符串 == "没声明"，不是"非法声明"：
  // 与 toEntryList(undefined) → []、toEntryList('') → [] 保持完全一致的输入口径。
  // （否则任何没写 outOfScope、或写了 outOfScope:'' 的任务都会凭空多出一条 E_PATH_UNSAFE）
  if (value === undefined || value === null) return { entries, illegal };
  if (typeof value === 'string' && value.trim() === '') return { entries, illegal };
  for (const item of declarationList(value)) {
    const isObject = isPlainObject(item);
    const rawValue = isObject ? item.path : item;
    const diagnosis = diagnosePattern(rawValue);
    if (!diagnosis.ok) {
      illegal.push({ raw: item, reason: diagnosis.reason });
      continue;
    }
    const entry = entryFromParsed(diagnosis, rawValue, isObject ? item.isDir : undefined, isObject ? item.raw : undefined);
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }
  return { entries, illegal };
}

/** 把 inScope/outOfScope 列表解析成 [{ path, isDir, raw, key }]（内部别名，保持调用点语义清晰）。 */
function parseList(list) {
  return toEntryList(list);
}

function patternMatches(target, pattern) {
  // 目录模式 = 前缀匹配，且必须落在 `/` 边界上（src/auth/ 不能匹配 src/authz.ts）
  if (pattern.isDir) return target === pattern.path || target.startsWith(`${pattern.path}/`);
  // 精确模式只匹配该文件
  return target === pattern.path;
}

function matchesAny(targetPath, patterns) {
  return parseList(patterns).some((pattern) => patternMatches(targetPath, pattern));
}

/**
 * 判定一个访问路径相对声明的归属：'in_scope' | 'out_of_scope' | 'undeclared'。
 * 规则：outOfScope 优先于 inScope；目录模式（以 `/` 结尾）走前缀匹配，精确模式只匹配该文件。
 * 非法路径（绝对路径、..、~、空串等）不匹配任何声明 → 'undeclared'。
 */
export function classifyPath(path, inScope, outOfScope) {
  const target = parsePattern(path);
  if (!target) return 'undeclared';
  if (matchesAny(target.path, outOfScope)) return 'out_of_scope'; // outOfScope 优先
  if (matchesAny(target.path, inScope)) return 'in_scope';
  return 'undeclared';
}

/**
 * 两个声明模式是否构成 E_SCOPE_CONFLICT。
 *
 * 判据**不是**「两条声明有交集」，而是「这条 inScope 声明是死的」——
 * 必须与 classifyPath 的运行时语义（outOfScope 优先于 inScope）自洽：
 *   - 同一路径                         → 冲突（声明自己否定自己）
 *   - inScope 落在 outOfScope 目录里   → 冲突（整个 inScope 都被排除，写它没有意义）
 *   - outOfScope 落在 inScope 目录里   → **合法**，这就是「挖洞」，是 outOfScope 存在的意义：
 *                                        classifyPath 对洞里的路径返回 'out_of_scope'
 *   （因此这里**不能**用 "a.isDir && b.path.startsWith(a.path + '/')" 判冲突，
 *     那会把「挖洞」错判成「冲突」，导致 outOfScope 除了「完全不相交」之外无法使用。）
 */
function patternsOverlap(a, b) {
  if (a.path === b.path) return true; // 同一个路径（无论目录/文件）
  if (b.isDir && a.path.startsWith(`${b.path}/`)) return true; // inScope 在 outOfScope 目录内 → 死声明
  return false;
}

/* ------------------------------------------------------------------------- */
/* acceptance → verify 映射                                                   */
/* ------------------------------------------------------------------------- */

/**
 * [ACn] 标签：`AC1` / `AC-1` / `acceptance#1` / `[AC 1]` 都算，**只认数字**。
 * `[ACx]`、`[AC]` 不是标签（没有数字就没有可核对的身份）。
 * `\b` 前缀：`MAC1`、`TAC2` 这种把 ac 粘在拉丁词中间的不算标签——
 * 标签通道是主要通道，不能让"单词里恰好有 ac+数字"又变成一条猜的路。
 */
const AC_TAG_RE = /\b(?:ac|acceptance)[\s#:._-]*(\d+)/gi;

function acTags(text) {
  const tags = new Set();
  for (const match of String(text ?? '').matchAll(AC_TAG_RE)) tags.add(Number(match[1]));
  return tags;
}

/** 尾部标点：逐字包含比较前两边都去掉（避免「跑完 npm test。」与「npm test」因句号判不等）。 */
const TRAILING_PUNCT_RE = /[\s.,;:!?、。；：！？…"'`）)】」』\]}]+$/u;

/**
 * 逐字包含比较前的归一化（**只做确定的字符串变换，不做任何语义/词元推断**）：
 * trim → 折叠连续空白 → 小写化 → 去掉尾部标点 → 再 trim。
 */
function normalizeForContainment(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(TRAILING_PUNCT_RE, '')
    .trim();
}

/**
 * 逐字包含通道对 verify 项的**最低资格线**（D-5）：归一化后长度 ≥ 3。
 * 一个字符的子串能"证明"任何包含它的验收（`verify:['a']` + `acceptance:['abc']`），
 * 那等于把刚关掉的"猜"从词元换成了子串。
 */
const MIN_CONTAINMENT_LENGTH = 3;

/**
 * 「命令特征字符」（D-5）：空白 / `\` `/` `|` `&` `;` `<` `>` `=` `(` `)` `{` `}` `$` `.` `-`。
 * **verify 项是你要执行的命令，不是一个词。** 裸词（`npm`、`make`、`测试`）一个都不含，
 * 它只能在语义上"看起来相关"，那就回到了猜。
 */
const COMMAND_CHAR_RE = /[\s\/\\|&;<=>(){}$.-]/;

/**
 * 一条 verify 文本是否够格当"逐字包含"的匹配目标（D-5：**必须像一条命令**）：
 *   1. 归一化后长度 ≥ 3；**且**
 *   2. 含至少一个命令特征字符。
 * 两条都满足才有资格；否则它只是个词，不参与逐字包含通道。
 * 注意 `make` 这种"单字真命令"会被拒——**这是有意的**：请写 `make test`，或改用 `[ACn]` 标签。
 */
function isContainmentTarget(verifyText) {
  const normalized = normalizeForContainment(verifyText);
  if (normalized.length < MIN_CONTAINMENT_LENGTH) return false;
  return COMMAND_CHAR_RE.test(normalized);
}

/**
 * 解析一条 acceptance 的映射结果。**只有两条通道**，都不猜：
 *   1. `[ACn]` 标签通道：acceptance 的标签集合与某个 verify 项的标签集合有交集。
 *      （标签只认数字；`[AC1]` 不能靠 verify 的 `[AC2]` 蒙过去）
 *   2. 逐字包含通道：归一化后，acceptance 文本**完整包含**某个 verify 项的原文。
 *      方向是单向的：验收项必须包含整条 verify 命令，**半边匹配不算**
 *      （acceptance 写 `curl /login`、verify 写 `curl /login 返回 200` → 拒）。
 *      并且该 verify 项必须**像一条命令**（见 isContainmentTarget，D-5）。
 *
 * **D-6（裁决，别顺手收紧）**：**多条验收共享同一个 `[ACn]` 标签是合法的。**
 * 一条命令证明多条验收是真实且正当的——`npm test` 通过同时证明了「登录成功」「登出成功」
 * 「会话不泄漏」三条；强制标签一一对应只会逼作者编造三条假命令。
 * "一条命令其实证明不了那三条"是**语义质量**问题，归"人批计划"负责（D-1 的既定代价），
 * 不由程序判断。V5 只查结构完整性。
 *
 * @param {string} acceptanceText
 * @param {string[]} verifyTexts
 * @returns {{covered: boolean, weakTargets: string[]}}
 *   weakTargets = 因"太短或不像命令"而没资格当匹配目标的 verify 原文（按声明顺序）。
 *   只有**全部** verify 项都 weak 时，调用方才该提示"verify 项太短或不像命令"。
 */
function resolveAcceptanceMapping(acceptanceText, verifyTexts) {
  // 通道 1：标签。一个标签可以覆盖多条验收（D-6），这里不做"一一对应"检查。
  const acceptanceTags = acTags(acceptanceText);
  if (acceptanceTags.size > 0) {
    for (const verifyText of verifyTexts) {
      const verifyTags = acTags(verifyText);
      for (const tag of acceptanceTags) {
        if (verifyTags.has(tag)) return { covered: true, weakTargets: [] };
      }
    }
  }

  // 通道 2：逐字包含，且 verify 项必须像一条命令（D-5）。
  const needle = normalizeForContainment(acceptanceText);
  const weakTargets = [];
  if (needle !== '') {
    for (const verifyText of verifyTexts) {
      if (!isContainmentTarget(verifyText)) {
        weakTargets.push(verifyText);
        continue;
      }
      if (needle.includes(normalizeForContainment(verifyText))) return { covered: true, weakTargets: [] };
    }
  }
  return { covered: false, weakTargets };
}

/* ------------------------------------------------------------------------- */
/* 主校验函数                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * 校验任务单，一次返回全部错误。
 *
 * @param {Array<object>} tasks 待校验的任务单数组
 * @param {object} ctx { existingTasks?: Array<object>, roster?: string[], gitBase?: string|null }
 * @returns {{ok: boolean, errors: Array<{code: string, taskId?: string, message: string}>}}
 */
export function validatePlan(tasks, ctx = {}) {
  const errors = [];
  const push = (code, message, taskId) => {
    const error = { code, message };
    if (isNonEmptyString(taskId)) error.taskId = taskId;
    errors.push(error);
  };

  if (!Array.isArray(tasks)) {
    // 防御性扩展（不在 10 个错误码清单内）：入参类型错误只能短路。
    push('E_INPUT_INVALID', 'validatePlan: tasks 必须是数组');
    return { ok: false, errors };
  }

  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const existingTasks = Array.isArray(context.existingTasks) ? context.existingTasks : [];

  // 已存在任务的 id：既参与重复检测，也参与 reviewedTaskId 解析。
  const existingIds = new Set();
  for (const task of existingTasks) {
    if (task && typeof task === 'object' && isNonEmptyString(task.id)) existingIds.add(task.id);
  }

  // 本任务单声明的全部 id（先扫一遍，review 才能指向数组里更靠后的任务）。
  const declaredIds = new Set();
  for (const task of tasks) {
    if (task && typeof task === 'object' && !Array.isArray(task) && isNonEmptyString(task.id)) {
      declaredIds.add(task.id);
    }
  }

  const seenIds = new Set();
  const planTasks = [];

  tasks.forEach((task, index) => {
    const label = `任务#${index + 1}`;

    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      // 结构损坏，无法继续逐字段检查；归入 id 维度。
      push('E_ID_INVALID', `${label}: 任务必须是对象，无法读取 id 等字段`);
      return;
    }
    planTasks.push(task);

    // 契约字段的唯一取值入口：新写法读 task.contract（非空才算声明），否则回退 task 本身。
    const contract = contractOf(task);

    const rawId = task.id;
    const taskId = isNonEmptyString(rawId) ? rawId : undefined;

    // ---- E_CONTRACT_AMBIGUOUS：contract 与顶层同名字段取值不同 -------------
    // 只有"两处同时存在且值不同"才是歧义（contract:{} 已按未声明处理，不会走到这里）。
    const ambiguousFields = contractAmbiguity(task);
    if (ambiguousFields.length > 0) {
      push(
        'E_CONTRACT_AMBIGUOUS',
        `${label}: 契约字段在 task.contract 与任务顶层同时出现且取值不同：${ambiguousFields.join('、')}。`
          + '本次校验只保留 contract 里的那份（顶层同名值被忽略）；请删掉重复声明，让一处成为唯一来源',
        taskId,
      );
    }

    // ---- E_ID_INVALID：id 缺失 / 非字符串 / 空串 / 重复 -------------------
    if (rawId === undefined || rawId === null) {
      push('E_ID_INVALID', `${label}: 缺少 id`);
    } else if (typeof rawId !== 'string') {
      push('E_ID_INVALID', `${label}: id 必须是字符串，收到 ${describeValue(rawId)}`);
    } else if (rawId.trim() === '') {
      push('E_ID_INVALID', `${label}: id 不能是空字符串`);
    } else if (seenIds.has(rawId)) {
      push('E_ID_INVALID', `${label}: id "${rawId}" 在本任务单内重复`, rawId);
    } else if (existingIds.has(rawId)) {
      push('E_ID_INVALID', `${label}: id "${rawId}" 与 ctx.existingTasks 中的任务冲突`, rawId);
    } else {
      seenIds.add(rawId);
    }

    // ---- E_KIND_INVALID：kind 必须是 KINDS 之一 ---------------------------
    const kindValid = typeof task.kind === 'string' && KINDS.includes(task.kind);
    if (!kindValid) {
      push(
        'E_KIND_INVALID',
        `${label}: kind 必须是 ${KINDS.join(' | ')} 之一，收到 ${describeValue(task.kind)}`,
        taskId,
      );
    }

    const acceptanceItems = toStringArray(contract.acceptance);
    const verifyItems = toStringArray(contract.verify);
    const isQualityKind = kindValid && QUALITY_KINDS.includes(task.kind);

    // ---- E_OBJECTIVE_REQUIRED：质量 kind 必须有非空 objective -------------
    // objective 属于契约字段（规格 §3.2 把它放在 contract 下），因此读 contract。
    if (isQualityKind && !isNonEmptyString(contract.objective)) {
      push(
        'E_OBJECTIVE_REQUIRED',
        `${label}: kind=${task.kind} 必须提供非空 objective`,
        taskId,
      );
    }

    // ---- E_ACCEPTANCE_REQUIRED：质量 kind 必须有非空 acceptance -----------
    if (isQualityKind && acceptanceItems.length === 0) {
      push(
        'E_ACCEPTANCE_REQUIRED',
        `${label}: kind=${task.kind} 必须提供非空 acceptance（可验收条件）`,
        taskId,
      );
    }

    // ---- E_ACCEPTANCE_UNVERIFIABLE：每条 acceptance 都要映射到 verify -----
    // 只有两条显式通道（[ACn] 标签 / 逐字包含），不做词元猜测；错误信息直接给出修法。
    // 两条不同的文案（D-5）：
    //   - 全部 verify 项都"太短或不像命令" → 提示问题出在 verify 侧（否则作者会以为是验收写错了）
    //   - 否则 → 通用文案（验收没映射上，可能是没写标签、也没逐字包含）
    if (acceptanceItems.length > 0) {
      acceptanceItems.forEach((item) => {
        const mapping = resolveAcceptanceMapping(item, verifyItems);
        if (mapping.covered) return;

        const allTargetsWeak = verifyItems.length > 0 && mapping.weakTargets.length === verifyItems.length;
        if (allTargetsWeak) {
          push(
            'E_ACCEPTANCE_UNVERIFIABLE',
            `${label}: 验收项「${truncate(item)}」没有映射到任何 verify 项——`
              + `verify 项「${truncate(mapping.weakTargets[0])}」太短或不像命令，`
              + '不能作为逐字包含的匹配目标；请改用 [ACn] 标签，或写出完整命令'
              + '（像 make 这种单词命令也会被拒：请写成 make test，或改用 [ACn] 标签）',
            taskId,
          );
          return;
        }

        push(
          'E_ACCEPTANCE_UNVERIFIABLE',
          `${label}: 验收项「${truncate(item)}」没有映射到任何 verify 项。修法二选一：`
            + '在该验收项里写 [AC1] 并在对应的 verify 项里也标 [AC1]；'
            + '或在验收项里逐字写出该 verify 项的命令'
            + '（比较时两边只做 trim / 折叠空白 / 小写化 / 去尾部标点，不做词元推断）',
          taskId,
        );
      });
    }

    // ---- E_SCOPE_VERIFY_REQUIRED：implementation 必须同时有 inScope/verify -
    if (kindValid && task.kind === 'implementation') {
      const missing = [];
      if (toStringArray(contract.inScope).length === 0) missing.push('inScope');
      if (verifyItems.length === 0) missing.push('verify');
      if (missing.length > 0) {
        push(
          'E_SCOPE_VERIFY_REQUIRED',
          `${label}: implementation 任务缺少 ${missing.join(' 与 ')}`,
          taskId,
        );
      }
    }

    // ---- E_REVIEWED_TARGET_REQUIRED：review 必须指明且真实存在的被审任务 --
    if (kindValid && task.kind === 'review') {
      const target = contract.reviewedTaskId;
      if (!isNonEmptyString(target)) {
        push(
          'E_REVIEWED_TARGET_REQUIRED',
          `${label}: review 任务必须提供非空 reviewedTaskId`,
          taskId,
        );
      } else if (!declaredIds.has(target) && !existingIds.has(target)) {
        push(
          'E_REVIEWED_TARGET_REQUIRED',
          `${label}: reviewedTaskId "${target}" 在任务单与 ctx.existingTasks 中都不存在`,
          taskId,
        );
      }
    }

    // ---- E_PATH_UNSAFE：inScope / outOfScope 里每条路径都必须可规范化 ----
    // 注意这里用 rawEntries（保留非法条目）：非法值正是要报出来的东西，不能被过滤掉。
    // 逐条走 toEntryListStrict 拿 reason（traversal / absolute / home / control-char /
    // encoded-traversal / empty / not-string / colon），message 直接告诉人为什么被拒。
    for (const field of ['inScope', 'outOfScope']) {
      rawEntries(contract[field]).forEach((entry, entryIndex) => {
        const { illegal } = toEntryListStrict([entry]);
        if (illegal.length === 0) return; // 合法条目（含已解析的 { path } 对象条目）
        push(
          'E_PATH_UNSAFE',
          `${label}: ${field}[${entryIndex}] 不是安全的工作区相对路径`
            + `（原因：${illegal[0].reason}）：${describeValue(entry)}`,
          taskId,
        );
      });
    }

    // ---- E_SCOPE_CONFLICT：inScope 不得是死声明（被 outOfScope 完全覆盖）---
    // 注意：outOfScope 落在 inScope 目录里是「挖洞」，合法（见 patternsOverlap 注释）。
    const inScopePatterns = parseList(contract.inScope);
    const outOfScopePatterns = parseList(contract.outOfScope);
    for (const inside of inScopePatterns) {
      const hit = outOfScopePatterns.find((outside) => patternsOverlap(inside, outside));
      if (hit) {
        push(
          'E_SCOPE_CONFLICT',
          `${label}: inScope "${inside.raw}" 被 outOfScope "${hit.raw}" 完全覆盖，这条声明是死声明`,
          taskId,
        );
        break; // 同一任务只报一次，避免噪声
      }
    }
  });

  // ---- E_TEAM_NOT_JUSTIFIED：小任务单必须能证明"需要团队" ---------------
  const teamIssue = checkTeamJustified(planTasks, existingTasks);
  if (teamIssue) push('E_TEAM_NOT_JUSTIFIED', teamIssue);

  return { ok: errors.length === 0, errors };
}

/**
 * E_TEAM_NOT_JUSTIFIED 的判据：
 * 任务总数（含 ctx.existingTasks）≤ 2、inScope 覆盖的路径数 ≤ 2、且没有任何 review 任务
 * → 这个规模单 agent 就能做，组建团队没有依据。
 * 空任务单不判（没有可校验内容）。
 *
 * 路径计数用条目的 `key`（目录 = `'src/'`、文件 = `'src'`）：`src/` 与 `src` 是两条不同声明
 * （目录全量 vs 同名文件），用去尾斜杠的 path 做键会把它们并成 1 条，少算文件数。
 */
function checkTeamJustified(planTasks, existingTasks) {
  const allTasks = [
    ...planTasks,
    ...existingTasks.filter((task) => task && typeof task === 'object' && !Array.isArray(task)),
  ];
  if (allTasks.length === 0 || allTasks.length > SMALL_TEAM_TASKS) return null;

  const files = new Set();
  for (const task of allTasks) {
    // 契约字段统一走 contractOf：existingTasks 里可能也是新写法（contract 下）。
    for (const pattern of parseList(contractOf(task).inScope)) files.add(pattern.key);
  }
  if (files.size > SMALL_TEAM_FILES) return null;
  if (allTasks.some((task) => task.kind === 'review')) return null;

  return `任务单只有 ${allTasks.length} 个任务、inScope 只涉及 ${files.size} 个路径且没有 review 任务：`
    + '这个规模用单个 agent 即可，不需要组建团队（请补充任务/review，或改走单 agent）';
}

/* ========================================================================== */
/* D-14：声明块解析                                                            */
/*                                                                            */
/* 宿主任务对象是 `.strict()` 的十个字段，没有 kind、没有契约字段。声明只能写在  */
/* `description` 这个自由文本里，格式是 info 字符串为 `team-board` 的围栏块。     */
/* 本节的唯一职责是"把那段文本读成 {kind?, contract?}"；它不判断该不该报缺失，    */
/* 也不改写 kind 的取值——那是 gates / delivery 的活。                            */
/* ========================================================================== */

/** 声明块里唯一的非契约键（`kind` 不是契约字段：id / kind 永远读任务本身）。 */
const DECLARATION_KIND_KEY = 'kind';

/** 声明块围栏的 info 字符串。**恰好相等**才认（大小写敏感、不许带附加词）。 */
const DECLARATION_FENCE_INFO = 'team-board';

/**
 * 声明块认的键集 = `kind` + `CONTRACT_FIELDS` + `DECLARATION_REPORT_FIELDS`。
 *
 * **必须是派生，不许抄字面量副本**：抄副本正是本项目反复栽的那个坑（`delivery.mjs` 曾逐字
 * 重抄 KINDS、`QUALITY_KINDS` 曾有三份副本，漂移时没有任何东西报警）。派生之后，以后往
 * 任一名单里加一个字段，声明块的键集自动跟上；一旦这里改成字面量数组，新字段
 * 就会在每次声明里被当成"不认识的键"警告掉——这条链必须有测试钉住（见 contract.test.mjs）。
 *
 * 两个名单在这里合流，但**落地时分开**（`contract` vs `report`）：认不认这个键
 * 与它算不算契约条款是两件事。
 */
const DECLARATION_KEYS = Object.freeze([DECLARATION_KIND_KEY, ...CONTRACT_FIELDS, ...DECLARATION_REPORT_FIELDS]);

/**
 * 一个声明键该落到哪个桶。三个桶的语义完全不同，别合并：
 *   - `kind`     → 标量，单独一个字段；
 *   - `contract` → **开工前的条款**，参与验收判定与歧义检测；
 *   - `report`   → **干完后的报告**，不参与验收判定、不参与歧义检测。
 * @param {string} key 已经在 `DECLARATION_KEYS` 里的键
 * @returns {'kind'|'contract'|'report'}
 */
function declarationBucketOf(key) {
  if (key === DECLARATION_KIND_KEY) return 'kind';
  if (DECLARATION_REPORT_FIELDS.includes(key)) return 'report';
  return 'contract';
}

/**
 * 解析层**只发这两个** warning 码。
 *
 * `E_DECLARATION_MISSING` 不在这里：那是调用方（host 的 `mapHostTask`）的判断——它才知道
 * 任务的 `writeScopes` 是不是空、块是不是真的缺席。解析层连"有没有块"都只回答事实，
 * 不回答该不该警告（否则一条读文档的任务也会被按着头声明 kind）。
 */
const E_DECLARATION_UNKNOWN_KEY = 'E_DECLARATION_UNKNOWN_KEY';
const E_DECLARATION_UNPARSEABLE = 'E_DECLARATION_UNPARSEABLE';

/**
 * 行语法层唯一的 warning：列表项没有归属。
 *
 * 它**不往 `parseDeclaration` 外面走**（D-14 15) 钉住：孤儿条目被丢弃、`warnings` 为空）。
 * 放在这一层是因为它讲的是行语法，而不是某条声明的条款——账本块（`team-board-meeting`）
 * 用的是同一个 tokenizer，它需要看见这条，好让人知道自己的账本少了一条回执。
 */
const E_FENCE_ORPHAN_ITEM = 'E_FENCE_ORPHAN_ITEM';

/** 开围栏：3 个以上反引号 + info 字符串（info 里不许再有反引号）。 */
const DECLARATION_FENCE_OPEN_RE = /^(`{3,})([^`]*)$/;

function declarationWarning(code, message) {
  return { code, message };
}

/**
 * "这条描述我没读懂"的唯一出口。**返回一个正常结果对象，不抛错**：
 * 一条烂 `description` 不该让整个团队的判定崩掉（fail-soft，但带一条 warning 让它可见）。
 */
function unparseableDeclaration(message) {
  return { warnings: [declarationWarning(E_DECLARATION_UNPARSEABLE, message)] };
}

/** 去掉 BOM：Windows 侧复制粘贴来的描述经常带 U+FEFF，不去掉第一个字符就不是反引号了。 */
function stripByteOrderMark(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/**
 * 把入参收敛成"要解析的文本"。
 *
 * 非字符串的三种处置，差别是有意的：
 *   - `null` / `undefined` → `''`：宿主没给描述 = **没有块**（不是畸形），不该冒 warning；
 *   - 其余怪值 → `String(value)` 强制一次：`description` 的类型不由我们控制，强制转换
 *     可能抛（`String(Object.create(null))` → TypeError），那一抛由 `parseDeclaration`
 *     的 catch 兜成 `E_DECLARATION_UNPARSEABLE`；
 *   - 字符串 → 只去 BOM，别的字节一个不动。
 * @param {unknown} text
 * @returns {string}
 */
function declarationSourceOf(text) {
  if (typeof text === 'string') return stripByteOrderMark(text);
  if (text === null || text === undefined) return '';
  return stripByteOrderMark(String(text));
}

/**
 * 定位声明块在行数组里的范围。
 *
 * 三条硬规则：
 *   1. **只认第一个** info 为 `team-board` 的围栏（后面的同名块整块忽略——否则谁都能在
 *      正文末尾追加一段"补充声明"把原意覆盖掉）；
 *   2. 围栏必须**闭合**：闭合行只能是纯反引号且个数不少于开口。找不到闭合 → unclosed，
 *      **不再往后找第二个块**（否则"第一个块忘写结尾"会静默退化成"第二个块说了算"）；
 *   3. 别的围栏（info 不是 `team-board` 的）**不影响**定位：宁可多认一个把例子当声明
 *      （人会看见，描述本身就摆在那儿），也不要因为前面某处漏了个闭合反引号就整份读不出来——
 *      **读不出来是这条功能最危险的失败方向**，D-14 存在的理由就是消灭它。
 * @param {string[]} lines
 * @returns {{lines: string[]|null, unclosed: boolean, startLine: number}}
 */
function findDeclarationBlock(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const open = DECLARATION_FENCE_OPEN_RE.exec(lines[index].trim());
    if (!open) continue;
    if (open[2].trim() !== DECLARATION_FENCE_INFO) continue;

    const closeRe = new RegExp(`^\`{${open[1].length},}$`);
    for (let end = index + 1; end < lines.length; end += 1) {
      const candidate = lines[end].trim();
      if (closeRe.test(candidate)) {
        return { lines: lines.slice(index + 1, end), unclosed: false, startLine: index + 1 };
      }
      // 闭合之前又冒出一个 `team-board` 开口 ⇒ 第一个块**其实没闭合**。
      // 若不管这条，第二个块的闭合并不会来"救"第一个块，而是把第二个块整段当成第一个块的内容
      // （它的 `acceptance` 会直接漏进第一个块的契约里）——那正是最坏的一种错：块 1 的 kind
      // 配上块 2 的验收项，两条断言各自看着都对。判 unclosed 才是安全的那一边。
      const nestedOpen = DECLARATION_FENCE_OPEN_RE.exec(candidate);
      if (nestedOpen && nestedOpen[2].trim() === DECLARATION_FENCE_INFO) {
        return { lines: null, unclosed: true, startLine: index + 1 };
      }
    }
    return { lines: null, unclosed: true, startLine: index + 1 };
  }
  return { lines: null, unclosed: false, startLine: 0 };
}

/**
 * 围栏块内的**行语法**：只回答"这一行长什么样"，不回答"这个键算不算数"。
 *
 * 抽出来不是为了分文件好看，是为了**不许有第二套语法**。`team-board-meeting` 账本块
 * 与 `team-board` 声明块读的是同一种行；各写一个循环，两边迟早分叉——本项目已经栽过
 * 三次（`KINDS` 被逐字重抄、`QUALITY_KINDS` 曾有三份副本、`delivery.mjs` 自己一套
 * `KNOWN_KINDS`），漂移时没有任何东西报警。所以账本那边必须 `import` 这个函数。
 *
 * 语法只有两种，其余一律跳过：
 *   - `key: value`   → `inline` 取冒号后同行剩余部分并 trim（不剥引号、不做 YAML 转义）；
 *   - `- item`       → 列表项，收进**上一个 `inline` 为空的**那条 entry 的 `items`；
 *   - 空行           → 结束当前列表；
 *   - 其它（散文 / 注释 / `key = value`）→ 跳过。**不让整块作废**：围栏块是 Markdown 正文的
 *     一部分，作者在里面写一句说明是常事，为此判死一份合法块并不划算。真正的畸形是围栏
 *     没闭合、结构读不出来，那是定位层的事，不是这一层。
 *
 * 四条刻意**不在这里决定**的事（留给策略层，避免这一层替上层猜）：
 *   - **重复键全部保留**，按出现顺序进 `entries`。"第一个生效"是策略；
 *   - **不认任何键名**：`kind:` / `openQuestions:` 在这一层都是普通键。于是
 *     `kind:` 下面挂 `- work` 会真的收进 `items`——由策略层决定"kind 不接受列表"；
 *   - 冒号前为空的 `: value` **不跳过**，原样产出 `key: ''` 的 entry。上层要么当场判它是
 *     不认识的键（声明层就是这么做的），要么自己决定；这一层不替它抹掉；
 *   - `key : value`（冒号前带空格）在**冒号处切**再 trim 键名，所以 `kind : work` 的键是
 *     `kind`。这不是"顺手容错"：不改的话一条写对了的声明会被判成错键警告掉。
 * @param {string[]} blockLines 已去掉围栏本身的行
 * @returns {{entries: Array<{key: string, inline: string|null, items: string[]}>,
 *            warnings: Array<{code: string, key: string|null, message: string}>}}
 */
export function tokenizeFenceLines(blockLines) {
  const entries = [];
  const warnings = [];
  const lines = Array.isArray(blockLines) ? blockLines : [];
  /** 当前"开着列表"的那条 entry。空行 / 非列表行 / 带行内值的行都会把它关掉。 */
  let open = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === '') {
      open = null;
      continue;
    }

    // 列表项：严格 `- `（`-x` / 制表符紧跟的都不算，与规格"以 `- ` 开头"逐字对齐）。
    if (line.startsWith('- ')) {
      const item = line.slice(2).trim();
      if (item === '') continue; // 空条目没有信息，收进来只会让下游多一条空字符串
      if (open === null) {
        /* 孤儿条目：前面没有开列表的键。**丢掉，不猜它属于谁。**
         * 猜错比丢掉坏得多：它会静默并进一个毫不相干的字段，而那个字段看着还挺合理，
         * 于是"这条回执少了"这件事永远没人发现。 */
        warnings.push({
          code: E_FENCE_ORPHAN_ITEM,
          key: null,
          message: `围栏块里有一条没有归属的列表项「${truncate(item, 32)}」：`
            + '它前面没有开列表的键，已丢弃，不会并进任何字段。'
            + '请检查是漏写了键名，还是缩进把上一条键挤跑了',
        });
        continue;
      }
      open.items.push(item);
      continue;
    }

    open = null; // 非列表行 → 前一个列表到此结束

    const separator = line.indexOf(':');
    if (separator === -1) continue; // 块内散文行

    const key = line.slice(0, separator).trim();
    const inlineValue = line.slice(separator + 1).trim();
    const entry = { key, inline: inlineValue === '' ? null : inlineValue, items: [] };
    entries.push(entry);
    /* 只有"键后面什么都没有"才可能是列表头。行内已经有值的键不再开列表——
     * 于是 `changed: a` 后面那行 `- b` 是孤儿（会报 warning），而不是静默追加成 `[a, b]`。 */
    if (entry.inline === null) open = entry;
  }

  return { entries, warnings };
}

/**
 * 在 `tokenizeFenceLines` 之上套**声明块策略**：认哪些键、每个键落哪个桶、
 * 重复键取第一个、空列表头要不要补 `[]`。
 *
 * 对外行为与抽出前**字节级相同** —— D-14 那 40 条测试就是这条的证明。两处容易被
 * 误当成"顺手能改"的地方，原因写在这里免得以后被当成 bug 修掉：
 *   - **tokenizer 的 `warnings` 在这一层被丢掉**。它们讲的是行语法（孤儿条目），
 *     而声明层的 warnings 只发 `E_DECLARATION_UNKNOWN_KEY` / `E_DECLARATION_UNPARSEABLE`
 *     两个码（见上面"解析层只发这两个 warning 码"那段）。D-14 15) 明确钉住
 *     "孤儿条目被丢弃 + `warnings` 为空"，所以这里不许透传。
 *     账本块（`parseMeetingBlock`）自己用 tokenizer 的 warnings，不经过这一层。
 *   - `kind` 是标量，**不接受列表**：`kind:` 下挂 `- work` 不算声明 kind。tokenizer 把那条
 *     item 收在 `kind` entry 的 `items` 里，这一层按桶把它丢掉。
 * 另外两条"看起来没人管"的默认：
 *   - **重复键取第一个**（与"只认第一个块"同一取向：后来者不能覆盖原意）；
 *   - 空列表头**不建空壳数组**（见循环里那段注释）。
 * @param {string[]} blockLines
 * @returns {{kind?: string, contract: object, warnings: Array<{code: string, message: string}>}}
 */
function parseDeclarationLines(blockLines) {
  const warnings = [];
  const contract = {};
  /** 交付报告（目前只有 `changed`）。**与 `contract` 分开**：报告不参与验收判定。 */
  const report = {};
  const declaredKeys = new Set();
  let kindValue;

  const { entries } = tokenizeFenceLines(blockLines);

  for (const entry of entries) {
    const key = entry.key;

    if (!DECLARATION_KEYS.includes(key)) {
      if (declaredKeys.has(key)) continue; // 同一个错键写两遍只警告一次
      declaredKeys.add(key);
      warnings.push(declarationWarning(
        E_DECLARATION_UNKNOWN_KEY,
        `声明块里有不认识的键「${truncate(key, 32)}」（只认 ${DECLARATION_KEYS.join(' / ')}）：`
          + '这个键的值会被忽略；拼写错误不会报错，但会让这条声明凭空消失',
      ));
      continue;
    }

    if (declaredKeys.has(key)) continue; // 重复键：第一个生效
    declaredKeys.add(key);

    const bucketName = declarationBucketOf(key);

    if (entry.inline !== null) {
      if (bucketName === 'kind') kindValue = entry.inline;
      /* 报告字段一律按**列表**收（它是"改了哪些文件"）：行内写一个值就当成单元素列表。
       * 契约字段默认保持原样（行内就是标量），两者语义不同，别统一 ——
       * **但 `DECLARATION_LIST_FIELDS` 里那几个例外**（`openQuestions` / `answered`）：
       * 它们在规格里就是列表，行内写法只是"只有一条"的简写，所以也包成单元素数组。
       * 否则下游拿到的是字符串，得在三个模块里各写一次 `Array.isArray ? ... : [x]`。 */
      else if (bucketName === 'report') report[key] = [entry.inline];
      else if (DECLARATION_LIST_FIELDS.includes(key)) contract[key] = [entry.inline];
      else contract[key] = entry.inline;
      continue;
    }

    /* 键后面什么都没有：可能是列表头，也可能只是个空壳。`kind` 是标量，不接受列表。
     *
     * **零条目时不建数组**：普通契约字段（inScope 等）"没有值"与"没写这个键"在契约层是
     * 同一件事，下游 toStringArray 对两者给出同一个空数组，造个 `[]` 的空壳只是噪声；
     * 而 `DECLARATION_LIST_FIELDS`（openQuestions / answered）确实**要出现、值 `[]`**，
     * 那由下面那段单独补——两件事分开做，措辞不同才不会被谁顺手合并。 */
    if (bucketName !== 'kind' && entry.items.length > 0) {
      const bucket = bucketName === 'report' ? report : contract;
      bucket[key] = entry.items.slice();
    }
  }

  /* task-21：`openQuestions` / `answered` 的「空 vs 缺失」必须可分辨 —— 这是整条开会流程的命脉。
   *
   *   - 块里**没有**这个键 → 键不存在 = 「我根本没想过这件事」
   *   - 块里**写了**这个键但零条目 → `[]` = 「我想过了，没有需要用户拍板的问题」
   *
   * 没有这个区分，`E_QUESTIONS_UNANSWERED` 那条判据就写不出来：它分不清
   * "没问" 和 "问了没问题"。同一条红线本项目点过名 —— **读不出来 ≠ 零条**。
   *
   * 判据用 `declaredKeys.has(key)`（"这个键在块里出现过"），与 `changed` 完全同一套做法，
   * 不发明第二套机制。注意 `declaredKeys` 只在该键通过 `DECLARATION_KEYS` 认过之后才 add，
   * 所以拼错的 `openQuestion:`（少个 s）不会在这里被补成 `[]` —— 那是错键，走 UNKNOWN_KEY。
   */
  for (const key of DECLARATION_LIST_FIELDS) {
    if (!declaredKeys.has(key)) continue;
    /* 只在"这个键完全没有值"时补 `[]` —— 判据是 `=== undefined`，**不是** `!Array.isArray`。
     *
     * 差别很重要：`!Array.isArray` 会把一个意外的字符串**悄悄抹成 `[]`**（数据没了，还看不出来）。
     * 写 `=== undefined` 则只填"真的什么都没收到"那一种情形，别的形态原样留在那里等下游去发现。
     * 这一条是我在变异自证里发现的：把行内那条分支去掉之后，字符串被抹成 `[]`，
     * 于是"必须是数组"那条断言反而通过了 —— 抹数据能让断言变绿，那就是断言长得不对的信号。 */
    if (contract[key] === undefined) contract[key] = [];
  }

  const result = {};
  if (kindValue !== undefined) result.kind = kindValue;
  result.contract = contract;
  /* 交付报告字段（`changed`）：出现与否**按"键有没有被写进块里"判**，不按"有没有条目"判。
   *
   * 这是本文件里唯一一处有意偏离"没有值 = 没写这个键"（见上面契约字段那条注释）的地方：
   *   - 块里没有 `changed:`      → `result.changed` **不存在** = **没申报**；
   *   - 块里写了 `changed:` 但一条都没列 → `[]` = **申报了零个改动**。
   * 这两件事在下游含义完全不同（"没交报告"vs"交了报告说没改"），
   * 而契约字段那边没有这个需求，所以口径不必也不该跟着改。 */
  if (declaredKeys.has(DECLARATION_REPORT_FIELDS[0])) {
    result.changed = Array.isArray(report.changed) ? report.changed : [];
  }
  result.warnings = warnings;
  return result;
}

/**
 * 解析 `parseDeclaration` 的**可能抛错**的那一半；外层包 try/catch。
 *
 * 单独拆出来的理由：`parseDeclaration` 的"永不抛错"必须是**真兜底**而不是"我看不可能抛所以
 * 不写 catch"。把它拆开之后，删掉 catch 会立刻让 `Object.create(null)` 这类怪值把 TypeError
 * 抛给调用方——测试里有一条专门喂这种值，所以这条性质不是靠注释声明的，是靠变异会红证明的。
 * @param {unknown} text
 */
function parseDeclarationUnsafe(text) {
  const lines = declarationSourceOf(text).split(/\r\n|\n|\r/);
  const block = findDeclarationBlock(lines);

  if (block.unclosed) {
    return unparseableDeclaration(
      `第 ${block.startLine} 行的 \`${DECLARATION_FENCE_INFO}\` 声明块没有闭合（找不到结束的反引号行）：`
        + '声明范围无法确定，整块按"没有可用声明"处理',
    );
  }
  if (block.lines === null) return { warnings: [] };

  return parseDeclarationLines(block.lines);
}

/**
 * 从任务 `description` 里解析 D-14 声明块，返回 `{ kind?, contract?, warnings }`。
 *
 * 宿主任务的真实形状里没有 `kind` 也没有契约字段，所以声明写在 `description` 的
 * info 为 `team-board` 的围栏块里（只认第一个）：
 *
 * ```team-board
 * kind: implementation
 * acceptance:
 *   - storage.open 失败时 ledger.status === 'unavailable'
 * verify:
 *   - node --test plugin/test/host.test.mjs
 * inScope:
 *   - plugin/host/index.js
 * ```
 *
 * 六条语义（逐条对应 `裁决-D-14-kind从哪里来.md`）：
 *   1. 只认**第一个** `team-board` 块，后面的同名块整块忽略；
 *   2. 键集 = `kind` + `CONTRACT_FIELDS`，别的键 → `E_DECLARATION_UNKNOWN_KEY`（值不落地）；
 *   3. 标量取冒号后同行剩余部分 trim（不剥引号、不做 YAML 转义）；列表项以 `- ` 开头逐行收集，
 *      遇到非 `- ` 行或空行结束；
 *   4. `kind` 的取值**原样保留**，不在解析层对照 `QUALITY_KINDS` 校验/改写（交给 gates 报）；
 *   5. **永不抛错**：任何意外 → `{}` + `E_DECLARATION_UNPARSEABLE`；
 *   6. **不判断**要不要发 `E_DECLARATION_MISSING`（那是调用方的事，见第 2 条的注释）。
 *
 * 三种返回形状（调用方据此区分，别再自己猜）：
 *   - 找到块 → `{ kind?, contract, changed?, warnings }`，**`contract` 一定存在**（可能是 `{}`，
 *     即"块在、但里面没有能认的键"）；
 *   - 没有块 → `{ warnings: [] }`，**`contract` 键不存在**；
 *   - 读不懂 → `{ warnings: [{code: 'E_DECLARATION_UNPARSEABLE', …}] }`，无 `kind`/`contract`。
 * `warnings` 永远数组，元素形如 `{ code, message }`。
 *
 * `changed`（task-18）是**交付报告**，不是契约条款：它在 `result.changed` 上，**不进 `contract`**，
 * 因此不参与 `E_CONTRACT_INCOMPLETE`、不参与 `contractAmbiguity`、不属于 `CONTRACT_FIELDS`。
 * 它是 `string[]`，且**只有真的申报了才出现**——"没申报"不许用 `[]` 冒充，
 * 那两件事在下游有各自的含义。
 *
 * @param {unknown} text 任务的 `description`（非字符串也收，见 `declarationSourceOf`）
 * @returns {{kind?: string, contract?: object, changed?: string[], warnings: Array<{code: string, message: string}>}}
 */
export function parseDeclaration(text) {
  try {
    return parseDeclarationUnsafe(text);
  } catch (error) {
    // 走到这里的只有"入参根本不是能当文本读的东西"。仍然返回正常结果对象。
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : '未知错误';
    return unparseableDeclaration(
      `声明块解析失败（入参无法当作文本读取：${truncate(detail, 80)}），整块按"没有可用声明"处理`,
    );
  }
}
