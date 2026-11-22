/**
 * ledger.mjs — 会议账本落在**任务树**里的纯投影层。
 *
 * 铁律一：本文件零 IO、不读时钟、不碰宿主 API。所有函数都是纯的，
 * 「同一输入两次调用结果完全一致」这条测试直接钉在这里。
 *
 * ## 导出清单与「公开契约已冻结」
 *
 * **冻结** —— `host/index.js` 已经在用。改形状之前必须先在回报里说清楚，不许顺手改：
 *
 *   `ledgerFromTasks(tasks)` → `{ledger, cards, errors, warnings, reason}`   读侧总入口
 *   `ledgerWritePlan(prevTasks, nextLedger)` → `{creates, updates, errors, warnings}`   写侧差量
 *   `stageTaskIds(tasks)` → `Map<stageId, taskId>`   **把 `blockedByStages` 翻成真任务 id 只许走它**
 *   `agentRoster(tasks)` → `{entries, issues}`       **"有哪些可用的人"只许走它**（见第 10 节）
 *   `isMeetingTask(task)` / `isMeetingStageTask(task)` / `isMeetingParentTask(task)` → boolean
 *   `parseMeetingBlock(description)` → `{header, stages, warnings, errors}`
 *   `MEETING_FENCE_INFO` = `'team-board-meeting'`
 *
 * **导出但不冻结**（渲染/写回用，成对出现才安全）：
 *   `renderParentBlock` / `renderStageBlock` / `meetingBlockText` / `spliceMeetingBlock`
 *   `stageTaskIssues(tasks)` —— `stageTaskIds` 的发声通道（一张 `Map` 说不出"选了哪条"）
 *
 * **只给测试与文档用**：`PARENT_BLOCK_KEYS` / `STAGE_BLOCK_KEYS` / `STAGE_CARD_PREFIX`
 *
 * ### 账本块的**编码扩展**记账（每加一类，这段就要跟着动一次）
 *
 * 这一层是"文本块 + 纯投影"，每给块里加一类信息，就多一组"写得出 / 读得回 / 老账本不炸"的约束。
 * 到现在加过**三类**，都在 `test/ledger.test.mjs` 里各有专组钉着：
 *
 *   1. `continues` **标量**（第 5 节，`7a`–`7d`）：块里一个数字 ↔ `meeting.resumes[]` 数组。
 *      代价：**失去每次继续的时间与发起人**。
 *   2. `upgrades` 行的 `at` / `by` / `reason`（第 5、6 节，`20a`–`20j`）：
 *      `旧档位 -> 新档位 | at=… | by=… | reason=…`，值里的 `\` 与 `|` 转义。
 *   3. `agent` 阶段键（第 5 节 + 第 10 节，`22a`–`22k`）：记录"这一步实际由哪个子会话做的"，
 *      是 `agentRoster` 的唯一数据源。老账本没有它 → 读回**缺席**（不是空串）。
 *
 * **`parseMeetingBlock` 返回的 `stages[].fields` 是内部表示，不是契约。**
 * 它现在是一个 `Map<string, {inline, items}>`（`tokenizeFenceLines` 的条目形状），
 * 而"这一层怎么表示块内字段"随时可能变 —— 谁在 `ledger.mjs` 外面读 `fields`，
 * 这一层一改内部结构，他那边就变成"永远解析不到"（**静默**降级成"这棵树上没有这个阶段"）。
 * 要阶段 id → 用 `stageTaskIds`；要阶段回执 → 用 `ledgerFromTasks` 的 `ledger.stages`。
 * 这条不是一个风格偏好：`host/index.js` 曾经自己写了一份 `fields instanceof Map` 的判据，
 * 就是本项目反复栽的"判据/形状抄了第二份"。
 *
 * ## 为什么账本不在 `team-board` 声明块里
 *
 * `contract.mjs` 的声明块键集是冻结的 12 个键（`kind` + 10 个契约字段 + `changed`），
 * 而且 `parseDeclaration` **只认第一个** `team-board` 围栏、闭合前又冒出一个同名开口直接判
 * `E_DECLARATION_UNPARSEABLE`。所以账本既塞不进那个块，也不能在同一份 description 里
 * 再写第二段 `team-board`。
 *
 * 解法是换一个围栏标：`team-board-meeting`。`contract.mjs` 的定位函数对 info 不是
 * `team-board` 的围栏一律 `continue`（那是它的规则 3），所以 **`parseDeclaration` 物理上看不见这里**。
 * 这条隔离不是靠"小心"，是靠那个 `continue` —— `test/ledger.test.mjs` 有一条专门的
 * 交叉隔离断言：同一份 description 同时含两块时，`parseDeclaration` 的结果必须与
 * 只含 `team-board` 时逐字段相同。
 *
 * ## 任务的形状（一棵树，不是一个巨大 JSON）
 *
 *   父任务 1 个          块里放会议头：`meeting` / `preset` / `status` / `upgrades`
 *   阶段子任务 N 个      块里放该阶段回执：`meeting` / `stage` / `attempt` / `status` /
 *                       `continues` / `produced` / `at` / `agent` / `card.*`
 *
 * `agent` 是**可选**键：只有真值才挂，老账本没有它。
 *
 * 阶段顺序由任务树的 `blockedBy` 承担（宿主本来就执行那条链），所以本文件**不需要**知道
 * 预设的阶段顺序：`meeting.mjs` 的顺序判据来自 `preset.stages`，账本的顺序只影响"先扫到谁"。
 *
 * ## 这一层只判结构，不判值域
 *
 *   - 这里判：块在不在、认不认得出是头还是回执、整数能不能读、块闭没闭合、同一个阶段是不是
 *     来了两块回执。
 *   - 这里**不**判：`status` 拼对了吗、`preset` 加载得到吗、这个阶段在不在预设里。
 *     那些是 `meeting.mjs`（`readLedger` / `meetingState`）与 `preset.mjs` 的活。
 *     判两次就会分叉，而分叉的两个判据里总有一个是错的、且没人知道是哪个。
 *
 * ## 两条必须写在明面上的损失（这块是文本，不是无损序列化）
 *
 *   1. **`continues` 存标量**（`continues: 2`），不是每次继续的数组。代价：**失去每次继续的
 *      时间与发起人**。下游 `resume.mjs` 读的是 `meeting.resumes` 数组，所以
 *      `ledgerFromTasks` 会把标量**具体化**成 `{key, stageId, attempt, seq}` 的条目
 *      （`key` 用 `resume.mjs` 的 `continueKey` 算，不在这里重抄一遍格式 —— 抄了就会漂移）。
 *      具体化出来的条目没有 `at` / `by`：这就是那条代价的落点，不许假装没有。
 *   2. **卡片里的换行被压成一行**。这不只是排版：`card.claim` 里真带一个换行，压平之后
 *      不可能把 `stage: challenge` 这种行注入进块里改写账本。压平是**安全边界**，不是美容。
 *
 * `upgrades` 曾经是第三条损失（只存 `FROM -> TO`，`at` / `by` / `reason` 落盘即丢）。
 * **那条已经不算损失了 —— 它是假的：** `meeting.mjs` 的 `applyUpgrade` 在 JSDoc 里承诺
 * 「任何时候回头看，都必须能回答"这场会什么时候从哪个档升到哪个档、为什么"」。
 * 只存 `FROM -> TO` 的账本回答不了"什么时候""为什么"，于是那句注释是一条**它自己做不到的承诺**，
 * 而下一个读注释的人会以为这件事已经被保证了。现在升级行承载三个可选字段：
 *
 *     旧档位 -> 新档位 | at=<时间> | by=<发起人> | reason=<理由>
 *
 * 编码规则（改这里之前先读完）：
 *   - **`->` 左边右边是档位**，两端都必须是 `id@version`（`parsePresetId` 判），否则那条不入账；
 *   - **`|` 是分隔符，值里的 `\` 与 `|` 一律转义成 `\\` / `\|`**（`escapeUpgradeValue`）。
 *     所以理由里带 `|`、带 `\` 都不串位；换行按 `flatten` 压平（压缩之后也不会伪造出字段行）；
 *   - **三个字段名固定（`at` / `by` / `reason`），顺序按这个顺序渲染，但解析不依赖顺序**
 *     （每段按 `key=value` 认，认不出就出声）；
 *   - **写了键但值为空（`reason=`）与完全没写这个键，是两件事**：前者落成 `{reason: ''}`
 *     （"升档时没写理由"），后者干脆没有这个键（"老账本根本没这个字段"）。
 *     这是本文件里**唯一**一处有意偏离"只给真值才挂键"的地方 —— 与 `openQuestions: []`
 *     同一类：这个区别在下游含义不同，抹平就再也分不回来了；
 *   - **老格式（只有 `a -> b`）必须照读**：三个字段全缺席、零 error。旧账本还在用；
 *   - **`at` 由调用方给，这一层绝不自己取时间**（零 IO / 不读时钟）。
 *     `applyUpgrade` 会写出一个 `at: undefined` 的键 —— 渲染时跳过它，不把 `undefined` 写成 `at=`。
 *   - **值一律是文本**：`at` 就算传进来是数字（毫秒时间戳），写进块里再读回来也是十进制**字符串**。
 *     这是"块是文本"的必然，不是 bug；消费方要知道"这是个时间"就自己用 `resume.mjs` 的 `toMillis` 解析。
 *   - **压平（换行 → 空格）只在 `renderLines` 那一处发生**，`escapeUpgradeValue` 只管转义。
 *
 * ## 码的两级（这一层发三种码）
 *
 *   - `E_LEDGER_PARTIAL` —— **已登记在 `src/codes.mjs`**，拦人的那一种（块缺失 / 认不出 /
 *     整数读不出来 / 同阶段两块回执 / 块没闭合）。它出现时 `ledger` 是 `null`，
 *     调用方必须走"先修账本，或交人"，**绝不许**当成"还没开始"。
 *   - `E_LEDGER_DROPPED` —— 本文件私有，只出声不拦：账本块里有东西**没落地**
 *     （不认识的键、属于另一种块的键、畸形的升级条目、档位里已经没有的阶段任务）。
 *     一个键静默丢掉就是"账本少了一条却看起来一切正常"，那正是「读不出来 ≠ 零条」换了个轴。
 *   - `E_FENCE_ORPHAN_ITEM` —— 来自 `contract.mjs` 的 `tokenizeFenceLines`，**原样透传**。
 *     账本块里一个孤儿的 `- xxx` 最可能的来源是 `produced:` 那一行没对齐，而 `produced`
 *     决定了"这个阶段到底交了什么"。声明层可以丢掉这条（D-14 15) 钉住了那个行为），
 *     账本层**绝不许**丢。
 *
 * 码名的来路分三种，**没有任何一种靠"在别处抄一份"**：
 *
 *   - `E_LEDGER_PARTIAL` —— **已登记**在 `src/codes.mjs`。本文件只留一份发射用的字面量
 *     （`codes.mjs` 不按码名导出常量，所以 import 不到它；见常量那段注释）。
 *   - `E_LEDGER_DROPPED` —— **已登记**在 `src/codes.mjs`（batch 3 / warning）。本文件只留一份
 *     发射用的字面量，不 `export`（出口两个就等于没有唯一事实源）。登记状态由
 *     `test/ledger.test.mjs` 每轮机械核对：
 *     19a 要求"本文件发射的每个码都要 `isMeetingCode` 认得，或在明确的待注册清单里"；
 *     19b 要求"待注册清单不许过期"（某个码一旦登记，名字必须从清单里删掉，否则那条豁免
 *     会烂成永久放行 —— 本项目在"债务清单自洽"那条断言上吃过这个亏）。
 *   - `E_FENCE_ORPHAN_ITEM` —— 由 `contract.mjs` 的 `tokenizeFenceLines` 产出，**原样透传**，
 *     本文件既不定它也不吃它。账本块里一个孤儿的 `- xxx` 最可能的来源是 `produced:`
 *     那一行没对齐，而 `produced` 决定了"这个阶段到底交了什么"。声明层可以丢掉这条
 *     （D-14 15) 钉住了那个行为），账本层**绝不许**丢。
 *
 * ## 写入顺序的硬规矩
 *
 * 账本块**必须写在 `team-board` 块之后**。原因：闭栏的判据是"纯反引号且个数不少于开口"，
 * 4 个反引号能闭合 3 个反引号，所以两种围栏之间没有长度上的隔离，只有顺序上的。
 * `spliceMeetingBlock` 追加时永远追加到**末尾**，就是为了满足这条。
 */

import { tokenizeFenceLines } from './contract.mjs';
import { parsePresetId, qualifyPreset } from './preset.mjs';
import { continueCount, continueKey } from './resume.mjs';

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. 常量：围栏标、两套键白名单、本地诊断码
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 账本块的 info 字符串。**恰好相等**才认（大小写敏感、不许带附加词），
 * 与 `contract.mjs` 认 `team-board` 的口径一致。
 */
export const MEETING_FENCE_INFO = 'team-board-meeting';

/** 会议头块的键（父任务）。 */
export const PARENT_BLOCK_KEYS = Object.freeze(['meeting', 'preset', 'status', 'upgrades']);

/** 阶段回执块的键（子任务）。`status` 与 `meeting` 两边都有。 */
export const STAGE_BLOCK_KEYS = Object.freeze([
  'meeting',
  'stage',
  'attempt',
  'status',
  'continues',
  'produced',
  'at',
  /* 这一阶段**实际由哪个子会话做的**（宿主子会话 id）。可选键：老账本没有它。
   * 它是"有哪些可用的人"的唯一数据源 —— 见 `agentRoster`。 */
  'agent',
]);

/**
 * 卡片字段的前缀。`card.claim` / `card.killScenarios` / …
 *
 * 用前缀而不是固定键集：卡片字段的权威名单在 `artifact.mjs`（`FIELD_RULES`），
 * 在这里抄一份就会漂移；而账本的职责是"把作者写的卡片原样带出来"，
 * 不是"判断这张卡合法不合法"——那是 `judgeArtifact` 的活。
 */
export const STAGE_CARD_PREFIX = 'card.';

/**
 * 块里出现的"不是会议账本该有的键"时用的码（只出声不拦）。
 *
 * **已登记**在 `src/codes.mjs`（batch 3 / warning）。本文件只留一份**发射用的字面量**，
 * 不 `export`：导出一个码名等于邀请别的模块从这里 import，那会把"码表的唯一事实源"
 * 变成两个入口。它到底有没有登记，由 `test/ledger.test.mjs` 19a 每轮扫源码逐条问
 * `isMeetingCode` 来盯（19b 另外盯"已登记的码不许还挂在待注册清单里"）。
 */
const E_LEDGER_DROPPED = 'E_LEDGER_DROPPED';

/**
 * 拦人的那一种。**已登记**（`isMeetingCode('E_LEDGER_PARTIAL') === true`）。
 *
 * 为什么不 `import { E_LEDGER_PARTIAL } from './codes.mjs'`（有人提过这个改法）：
 * `codes.mjs` **不按码名导出常量**，它导出的是表（`MEETING_CODES` / `MEETING_BLOCKER_CODES` /
 * `meetingCodeOf` / `isMeetingCode` …）。那样 import 拿到的是 `undefined` —— 不是"少了一个副本"，
 * 而是**发射一个没有名字的码**，页面上每一行都会变成"未知门禁"。
 *
 * 所以这里留一份**发射用的字面量**，与 `meeting.mjs` / `preset.mjs` / `resume.mjs` 完全同一做法
 * （它们也是直接写 `'E_...'`；`codes.test.mjs` 6a 正是靠扫这些字面量来查"发射了但没登记"）。
 * 区别在于我多做了一步机械自检：`test/ledger.test.mjs` 19a 会把本文件定义的每个码拿去问
 * `isMeetingCode`，没登记又没在待注册清单里 → 红。
 */
const E_LEDGER_PARTIAL = 'E_LEDGER_PARTIAL';

/** 开围栏：3 个以上反引号 + info 字符串（info 里不许再有反引号）。 */
const FENCE_OPEN_RE = /^(`{3,})([^`]*)$/;

/** 块内两种角色。 */
const ROLE_PARENT = 'parent';
const ROLE_STAGE = 'stage';

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. 小工具
 * ═══════════════════════════════════════════════════════════════════════════ */

function diag(code, message, extra) {
  const out = { code, message };
  if (extra !== undefined && extra !== null && typeof extra === 'object') {
    if (typeof extra.reason === 'string' && extra.reason !== '') out.reason = extra.reason;
    if (typeof extra.stageId === 'string' && extra.stageId !== '') out.stageId = extra.stageId;
  }
  return out;
}

/** 只给真值才挂键（`at: undefined` 这种键会让 JSON 落盘后与内存不一致）。 */
function attach(target, key, value) {
  if (value === undefined || value === null || value === '') return target;
  target[key] = value;
  return target;
}

/** 把任意入参收敛成要解析的文本。与 `contract.mjs` 同口径，但那一份是私有的。 */
function textOf(value) {
  if (typeof value === 'string') {
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  }
  if (value === null || value === undefined) return '';
  const forced = String(value);
  return forced.charCodeAt(0) === 0xfeff ? forced.slice(1) : forced;
}

/** 非负整数，别的形态一律 null（不猜）。 */
function parseCount(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** 压平成一行：块语法是按行的，值里带换行会伪造出新的字段行。 */
function flatten(value) {
  return String(value).replace(/\r\n|\n|\r/g, ' ').trim();
}

/* ── 升级行的编码（`旧档位 -> 新档位 | at=… | by=… | reason=…`）────────────────
 *
 * 这一小队函数只做一件事：让「什么时候 / 谁 / 为什么」能被写进一行、又原样读回来。
 * 格式与理由全在文件头"升级行编码规则"那段，这里是它的实现。
 */

/** 升级行里可选的三个字段，**顺序即渲染顺序**（解析不依赖顺序）。 */
const UPGRADE_OPTIONAL_KEYS = Object.freeze(['at', 'by', 'reason']);

/** 升级行的分隔符。 */
const UPGRADE_FIELD_SEP = '|';

/**
 * 把三个可选字段的值转成能安全放进升级行的形态：把 `\` 与 `|` 转义。
 *
 * 转义不是洁癖：`|` 是分隔符，理由里写「A|B」而不转义，读回来就变成两段，
 * 其中一段会被当成畸形字段丢掉 —— 数据没了，而且看起来只是"少了一个字段"。
 * 先把 `\` 转成 `\\` 再转 `|`，是为了让原本就含 `\` 的值也能原样回来（否则
 * 「值里有 `\|`」和「值里有个转义过的 `|`」在读的时候分不开）。
 *
 * **这里不 `flatten`**：压平只在一处发生 —— `renderLines` 对每一行做的那一次。
 * 这里再写一遍就是同一件事的两份代码（本项目反复栽的那个坑），而且两次压平的顺序
 * 会让"值里带换行"同时依赖两个地方，删掉任一处都看不出问题。
 * 代价是：调用方必须把渲染结果交给 `renderLines`（`renderUpgradeItem` 只被
 * `renderParentBlock` 用，而它一定走那道门）。
 * @param {unknown} value
 * @returns {string}
 */
function escapeUpgradeValue(value) {
  return String(value).replace(/[\\|]/g, (ch) => `\\${ch}`);
}

/**
 * 拆一段升级行：**只认没被转义的 `|`**。被转义的那一对原样留着，交给 `unescapeUpgradeValue`。
 * @param {string} text
 * @returns {string[]}
 */
function splitUpgradeFields(text) {
  const parts = [];
  let current = '';
  let escaped = false;
  for (const ch of String(text)) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === UPGRADE_FIELD_SEP) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * 还原 `escapeUpgradeValue` 的转义。只折叠 `\\` 与 `\|`；
 * 其它位置的单个 `\`（人手写进来的）原样留着，不猜。
 * @param {string} text
 * @returns {string}
 */
function unescapeUpgradeValue(text) {
  return String(text).replace(/\\([\\|])/g, '$1');
}

/**
 * 一条升级记录 → 升级行的正文（不含 `  - ` 前缀）。
 *
 * 三个字段只要**写了键**就写出去（哪怕值是空串）：`reason=` 与"根本没有 reason"是两件事，
 * 前者是"升档时没写理由"，后者是"老账本没这个字段"，抹平就再也分不回来。
 * `applyUpgrade` 会写出一个 `at: undefined` 的键 —— 跳过它：
 * 把 `undefined` 渲染成 `at=` 等于凭空断言"时间是空的"。
 * @param {{from: string, to: string, at?: unknown, by?: unknown, reason?: unknown}} item
 * @returns {string}
 */
function renderUpgradeItem(item) {
  const head = `${item?.from} -> ${item?.to}`;
  const fields = [];
  for (const key of UPGRADE_OPTIONAL_KEYS) {
    if (!Object.hasOwn(item, key)) continue;
    const raw = item[key];
    if (raw === undefined) continue;
    fields.push(`${key}=${escapeUpgradeValue(raw)}`);
  }
  if (fields.length === 0) return head;
  return [head, ...fields].join(` ${UPGRADE_FIELD_SEP} `);
}

/**
 * 一段升级行 → 一条升级记录。读不出来 → `null`（调用方出声，不许静默丢）。
 *
 * 老格式（只有 `a -> b`）走第一个分支、没有任何附加段 → `{from, to}`，零 warning：
 * **旧账本还在用，缺 `at` / `reason` 不是"读不出来"。**
 * @param {string} item
 * @param {number} startLine 给人看的行号
 * @param {Array<object>} warnings
 * @returns {{from: string, to: string, at?: string, by?: string, reason?: string}|null}
 */
function parseUpgradeItem(item, startLine, warnings) {
  const parts = splitUpgradeFields(item);
  const head = parts[0].trim();
  const arrow = head.indexOf('->');

  if (arrow === -1) {
    warnings.push(diag(
      E_LEDGER_DROPPED,
      `会议头块（第 ${startLine} 行起）里有一条读不出来的升级记录「${flatten(item).slice(0, 40)}」：`
        + '它的格式必须是 `旧档位 -> 新档位`（后面可以跟 `| at=… | reason=…`）。'
        + '这一条没有落进账本——"升过档"这件事会少一次留痕',
      { reason: 'bad-upgrade' },
    ));
    return null;
  }

  const parsedFrom = parsePresetId(head.slice(0, arrow).trim());
  const parsedTo = parsePresetId(head.slice(arrow + 2).trim());
  if (parsedFrom === null || parsedTo === null) {
    warnings.push(diag(
      E_LEDGER_DROPPED,
      `会议头块（第 ${startLine} 行起）里有一条升级记录的两端不是全限定档位名`
        + `「${flatten(item).slice(0, 40)}」：两端都必须写成 id@version。这一条没有落进账本`,
      { reason: 'bad-upgrade' },
    ));
    return null;
  }

  const entry = {
    from: qualifyPreset(parsedFrom.id, parsedFrom.version),
    to: qualifyPreset(parsedTo.id, parsedTo.version),
  };

  for (const part of parts.slice(1)) {
    const separator = part.indexOf('=');
    const rawKey = separator === -1 ? part.trim() : part.slice(0, separator).trim();
    if (separator === -1 || rawKey === '') {
      warnings.push(diag(
        E_LEDGER_DROPPED,
        `升级记录（第 ${startLine} 行起）里有一段不是 \`键=值\`：「${flatten(part).slice(0, 40)}」。`
          + `认得的键是 ${UPGRADE_OPTIONAL_KEYS.join(' / ')}；这一段的字没有落进账本`,
        { reason: 'bad-upgrade-field' },
      ));
      continue;
    }
    if (!UPGRADE_OPTIONAL_KEYS.includes(rawKey)) {
      warnings.push(diag(
        E_LEDGER_DROPPED,
        `升级记录（第 ${startLine} 行起）里有一个不认识的字段「${flatten(rawKey).slice(0, 32)}」：`
          + `只认 ${UPGRADE_OPTIONAL_KEYS.join(' / ')}。它的值没有落进账本`,
        { reason: 'bad-upgrade-field' },
      ));
      continue;
    }
    if (Object.hasOwn(entry, rawKey)) {
      warnings.push(diag(
        E_LEDGER_DROPPED,
        `升级记录（第 ${startLine} 行起）里 \`${rawKey}\` 写了两次：第一个生效，后一个丢掉了`,
        { reason: 'bad-upgrade-field' },
      ));
      continue;
    }
    /* 这里**会**留下空串（`reason=` → `{reason: ''}`）。见文件头那条唯一的例外：
     * "写了键但值是空"与"没写这个键"在下游含义不同（升档时没写理由 vs 老账本没这字段）。 */
    entry[rawKey] = unescapeUpgradeValue(part.slice(separator + 1).trim());
  }

  return entry;
}

function isKnownBlockKey(key) {
  if (typeof key !== 'string' || key === '') return false;
  if (PARENT_BLOCK_KEYS.includes(key)) return true;
  if (STAGE_BLOCK_KEYS.includes(key)) return true;
  return key.startsWith(STAGE_CARD_PREFIX) && key.length > STAGE_CARD_PREFIX.length;
}

/** 某个块允许出现的键：头块不许出现 `stage` / `attempt` / 卡片，回执块不许出现 `preset` / `upgrades`。 */
function isKeyAllowedIn(role, key) {
  if (key.startsWith(STAGE_CARD_PREFIX)) return role === ROLE_STAGE;
  if (key === 'preset' || key === 'upgrades') return role === ROLE_PARENT;
  if (key === 'stage' || key === 'attempt' || key === 'continues' || key === 'produced' || key === 'at') {
    return role === ROLE_STAGE;
  }
  return key === 'meeting' || key === 'status';
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. 定位块：读**全部** meeting 块，但遇到第一个未闭合就停
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 找出文本里每个 `team-board-meeting` 块的行号范围。
 *
 * 与 `contract.mjs` 的 `findDeclarationBlock`（只认第一个）**有意不同**：账本块可以有多段
 * （"单任务多块"那种排法下，一条 description 里可能有父块 + 若干回执块）。
 * 但有一条与它**完全一致**、且必须一致：
 *
 *   闭合之前又冒出一个同名开口 ⇒ 第一个块**其实没闭合**，立刻停下报 `E_LEDGER_PARTIAL`。
 *
 * 不许用后面那个块的闭合去"救"前面那块 —— `contract.mjs` 那段注释讲的正是这个最坏错法：
 * 块 1 的 `stage` 配上块 2 的 `produced`，两条各自看着都对，合起来是假的账本。
 *
 * @param {string[]} lines
 * @returns {{ranges: Array<{start: number, end: number, lines: string[], startLine: number}>,
 *            unclosedAt: number|null}}
 *   `start` / `end` 是围栏本身的行下标（0 基），供 `spliceMeetingBlock` 原样替换。
 *   `startLine` 是给人看的行号（1 基）。
 */
function findMeetingRanges(lines) {
  const ranges = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE_OPEN_RE.exec(lines[index].trim());
    if (!open) continue;
    if (open[2].trim() !== MEETING_FENCE_INFO) continue;

    const closeRe = new RegExp(`^\`{${open[1].length},}$`);
    let end = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor].trim();
      if (closeRe.test(candidate)) {
        end = cursor;
        break;
      }
      const nested = FENCE_OPEN_RE.exec(candidate);
      if (nested && nested[2].trim() === MEETING_FENCE_INFO) {
        return { ranges, unclosedAt: index + 1 };
      }
    }
    if (end === -1) return { ranges, unclosedAt: index + 1 };

    ranges.push({ start: index, end, lines: lines.slice(index + 1, end), startLine: index + 1 });
    index = end;
  }
  return { ranges, unclosedAt: null };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. parseMeetingBlock：读一份 description 里**全部**账本块
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 把块内的条目集收敛成"第一个生效"的字段表。
 *
 * 重复键取**第一个**，与 `contract.mjs` 声明块同一取向（后来者不能覆盖原意）。
 * 但 tokenizer 会把重复键全部保留下来 —— 谁是"第一个"是策略，不是语法。
 * @param {Array<{key: string, inline: string|null, items: string[]}>} entries
 */
function fieldsOf(entries) {
  const fields = new Map();
  for (const entry of entries) {
    if (fields.has(entry.key)) continue;
    fields.set(entry.key, entry);
  }
  return fields;
}

/**
 * 一个标量键：没有 / 只有列表头 → `undefined`。**行内单值不会被当成列表。**
 * @param {Map<string, {inline: string|null, items: string[]}>} fields
 * @param {string} key
 */
function scalarOf(fields, key) {
  const entry = fields.get(key);
  if (entry === undefined || entry.inline === null) return undefined;
  return entry.inline;
}

/**
 * 一个列表键：`inline` 有值 → 单元素数组（"只有一条"的简写）；只有列表头 → `items`。
 *
 * 行内值也包成数组，是因为下游 `recordSubmission` 只认数组
 * （`Array.isArray(source.produced) ? slice() : []`）—— 行内写 `produced: killScenarios`
 * 如果原样给字符串，那一条产物会被静默吞成 `[]`。
 * @param {Map<string, {inline: string|null, items: string[]}>} fields
 * @param {string} key
 * @returns {string[]}
 */
function listOf(fields, key) {
  const entry = fields.get(key);
  if (entry === undefined) return [];
  if (entry.inline !== null) return [entry.inline];
  return entry.items.slice();
}

/**
 * 从字段表里把 `card.*` 收成一张卡。没有卡片字段 → `null`（不是空对象：
 * "这张卡没写"与"写了但一个字段都没有"在页面上要能分开）。
 * @param {Map<string, {inline: string|null, items: string[]}>} fields
 * @returns {object|null}
 */
function cardOf(fields) {
  const card = {};
  for (const [key, entry] of fields) {
    if (!key.startsWith(STAGE_CARD_PREFIX)) continue;
    const field = key.slice(STAGE_CARD_PREFIX.length);
    if (field === '') continue;
    if (entry.inline !== null) card[field] = entry.inline;
    else card[field] = entry.items.slice();
  }
  return Object.keys(card).length > 0 ? card : null;
}

/**
 * 把一串块行读成一个"块对象"。认不出的键只出声、不拦。
 * @param {{lines: string[], startLine: number}} range
 * @param {Array<object>} warnings
 */
function readBlock(range, warnings) {
  const tokenized = tokenizeFenceLines(range.lines);
  /* tokenizer 的诊断**原样透传**。声明层可以丢掉它们（D-14 15) 钉住了那个行为），
   * 账本层不行：孤儿 `- xxx` 最可能是 `produced:` 没对齐，而 produced 决定"交了什么"。 */
  for (const warning of tokenized.warnings) warnings.push(warning);

  const fields = fieldsOf(tokenized.entries);

  /* 先认角色，再按角色查键：一个键"认得"不等于"该出现在这个块里"。
   * 角色判据用 `stage` / `preset` 的存在性 —— 这是两套白名单唯一的区分点。 */
  const role = fields.has('stage') ? ROLE_STAGE : (fields.has('preset') ? ROLE_PARENT : null);

  if (role === null) {
    return {
      role: null,
      startLine: range.startLine,
      reason: 'unknown-block',
    };
  }

  for (const key of fields.keys()) {
    if (!isKnownBlockKey(key)) {
      warnings.push(diag(
        E_LEDGER_DROPPED,
        `会议账本块（第 ${range.startLine} 行起）里有一个不认识的键「${flatten(key).slice(0, 32)}」：`
          + '它的值没有落进账本。拼写错误不会报错，但会让账本少一条——'
          + `认得的键是 ${[...PARENT_BLOCK_KEYS, ...STAGE_BLOCK_KEYS].join(' / ')} 与 ${STAGE_CARD_PREFIX}*`,
        { reason: 'unknown-key' },
      ));
      continue;
    }
    if (!isKeyAllowedIn(role, key)) {
      warnings.push(diag(
        E_LEDGER_DROPPED,
        `会议账本块（第 ${range.startLine} 行起）里出现了 ${role === ROLE_PARENT ? '会议头' : '阶段回执'}`
          + `不该有的键「${flatten(key).slice(0, 32)}」：它的值没有落进账本。`
          + '多半是把键写到了错误的那个块上',
        { reason: 'wrong-block-key' },
      ));
    }
  }

  return { role, startLine: range.startLine, fields };
}

/**
 * 解析一份任务 `description` 里的**全部** `team-board-meeting` 块。
 *
 * 返回形状（三者必须可分辨，这是「空 ≠ 不可用」在解析层的落点）：
 *   - `header`   会议头块（最多一个；多于一个由 `ledgerFromTasks` 判死）
 *   - `stages`   阶段回执块，按出现顺序
 *   - `errors`   读不出来。**有 errors 时调用方必须走 `E_LEDGER_PARTIAL`**，
 *                不许把"读不出来"当成"没有块"（那就等于零条）
 *
 * 一份完全没有账本块的 description 返回 `{header:null, stages:[], warnings:[], errors:[]}` ——
 * **这不是失败**，只是"这块没写账本"。要不要把它当成"会议还没开始"，是 `ledgerFromTasks`
 * 的判断（那里的答案永远是"不许"）。
 *
 * @param {unknown} description
 * @returns {{header: object|null, stages: Array<object>,
 *            warnings: Array<object>, errors: Array<object>}}
 */
export function parseMeetingBlock(description) {
  const warnings = [];
  const errors = [];
  const source = textOf(description);
  const lines = source === '' ? [] : source.split(/\r\n|\n|\r/);
  const found = findMeetingRanges(lines);

  if (found.unclosedAt !== null) {
    errors.push(diag(
      E_LEDGER_PARTIAL,
      `第 ${found.unclosedAt} 行开始的 \`${MEETING_FENCE_INFO}\` 块没有闭合（找不到结束的反引号行）：`
        + '账本范围无法确定，整份账本按"读不出来"处理。'
        + '**不许**用后面那个块的闭合来救这一块——那样会把两块的内容混成一份假账本',
      { reason: 'unclosed-block' },
    ));
    /* 立刻停：后面的块一个都不读。读了就等于"用后面块的闭合去救前面那块"。 */
    return { header: null, stages: [], warnings, errors };
  }

  let header = null;
  const stages = [];

  for (const range of found.ranges) {
    const block = readBlock(range, warnings);

    if (block.role === null) {
      errors.push(diag(
        E_LEDGER_PARTIAL,
        `第 ${block.startLine} 行的会议账本块既没有 \`stage\` 也没有 \`preset\`：`
          + '认不出它是会议头还是阶段回执。认不出来就没法判断"缺的是哪一半"',
        { reason: 'unknown-block' },
      ));
      continue;
    }

    if (block.role === ROLE_PARENT) {
      if (header !== null) {
        errors.push(diag(
          E_LEDGER_PARTIAL,
          `第 ${header.startLine} 行与第 ${block.startLine} 行是两块会议头：`
            + '一份账本里有两个会议头，就没法说这场会是哪一个',
          { reason: 'duplicate-parent' },
        ));
        continue;
      }
      header = { startLine: block.startLine, fields: block.fields };
      continue;
    }

    stages.push({ startLine: block.startLine, fields: block.fields });
  }

  return { header, stages, warnings, errors };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. ledgerFromTasks：任务树 → `meeting.mjs` 已经消费的那个形状
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 把会议头块读成 `{id, preset, status, upgrades}` 的原料。
 * @param {{startLine: number, fields: Map<string, object>}} header
 * @param {Array<object>} errors
 * @param {Array<object>} warnings
 */
function readHeader(header, errors, warnings) {
  const fields = header.fields;
  const id = scalarOf(fields, 'meeting');
  if (typeof id !== 'string' || id.trim() === '') {
    errors.push(diag(
      E_LEDGER_PARTIAL,
      `第 ${header.startLine} 行的会议头块没有 \`meeting:\`（会议 id）：`
        + '没有 id 就无法把阶段回执对回这场会，也就无法续跑',
      { reason: 'meeting-id-missing' },
    ));
    return null;
  }

  const head = { id: id.trim() };

  /* `preset` 原样往下走：能不能用由 `readLedger` 判（它拿 `parsePresetId` 判，判不过就报
   * "按哪个档位跑的读不出来"）。这里只做"能规范化就规范化"，不替它下结论。 */
  const rawPreset = scalarOf(fields, 'preset');
  if (rawPreset === undefined) {
    warnings.push(diag(
      E_LEDGER_DROPPED,
      `第 ${header.startLine} 行的会议头块没有 \`preset:\`：档位读不出来。`
        + '这一条不在这里判死（`readLedger` 会判），但它一定会让账本变成"读不出来"',
      { reason: 'preset-missing' },
    ));
  } else {
    const parsed = parsePresetId(rawPreset);
    head.preset = parsed === null ? rawPreset : qualifyPreset(parsed.id, parsed.version);
  }

  const status = scalarOf(fields, 'status');
  if (status !== undefined) head.status = status;

  const upgrades = [];
  for (const item of listOf(fields, 'upgrades')) {
    const entry = parseUpgradeItem(item, header.startLine, warnings);
    if (entry !== null) upgrades.push(entry);
  }

  return { head, upgrades };
}

/**
 * 把一块阶段回执读成 record（`meeting.mjs` 的形状）+ 卡片。
 * @param {{startLine: number, fields: Map<string, object>}} stageBlock
 * @param {string} meetingId
 * @param {Array<object>} errors
 * @param {Array<object>} warnings
 */
function readStage(stageBlock, meetingId, errors, warnings) {
  const fields = stageBlock.fields;
  const stageId = scalarOf(fields, 'stage');
  if (typeof stageId !== 'string' || stageId.trim() === '') {
    errors.push(diag(
      E_LEDGER_PARTIAL,
      `第 ${stageBlock.startLine} 行的阶段回执块没有 \`stage:\`（阶段 id）：`
        + '这块回执对不上任何一个阶段，也就没法说"这一步做完了"',
      { reason: 'stage-id-missing' },
    ));
    return null;
  }
  const id = stageId.trim();

  const ownMeeting = scalarOf(fields, 'meeting');
  if (ownMeeting === undefined) {
    /* 缺这一行不是错：账本仍然能读（归属按父任务算）。但"没法核对"这件事必须出声 ——
     * 把一张阶段卡贴错任务时，`meeting:` 是唯一能发现它的东西。 */
    warnings.push(diag(
      E_LEDGER_DROPPED,
      `阶段 ${id} 的回执块（第 ${stageBlock.startLine} 行起）没有 \`meeting:\`：`
        + '没法核对它是不是这场会的回执，这一轮按"它属于父任务这场会"处理。'
        + '少的这一行不会让账本读不出来，但把卡贴错任务时就没有任何东西能发现',
      { reason: 'meeting-missing', stageId: id },
    ));
  } else if (ownMeeting.trim() !== meetingId) {
    errors.push(diag(
      E_LEDGER_PARTIAL,
      `第 ${stageBlock.startLine} 行的阶段回执块写着会议「${ownMeeting.trim()}」，`
        + `但会议头说的是「${meetingId}」：两句话对不上，没法说这块回执属于哪场会`,
      { reason: 'meeting-mismatch', stageId: id },
    ));
    return null;
  }

  const record = { stageId: id };

  const rawAttempt = scalarOf(fields, 'attempt');
  if (rawAttempt === undefined) {
    /* 不补默认值：`stageAttempt` 对"没有记录"和"记录里 attempt 是 1"给出同一个 1，
     * 补一个 1 就等于把"没写"和"第一轮"焊在一起。留空让它自己暴露。 */
    warnings.push(diag(
      E_LEDGER_DROPPED,
      `阶段 ${id} 的回执块（第 ${stageBlock.startLine} 行起）没有 \`attempt:\`：`
        + '第几轮读不出来。这一条不拦，但下游会把"没写轮次"当成第 1 轮',
      { reason: 'attempt-missing', stageId: id },
    ));
  } else {
    const attempt = parseCount(rawAttempt);
    if (attempt === null || attempt < 1) {
      errors.push(diag(
        E_LEDGER_PARTIAL,
        `阶段 ${id} 的回执块里 \`attempt\` 是 ${JSON.stringify(flatten(rawAttempt))}，不是正整数：`
          + '轮次读不出来，"这一轮交了什么"就没有答案',
        { reason: 'bad-attempt', stageId: id },
      ));
      return null;
    }
    record.attempt = attempt;
  }

  const status = scalarOf(fields, 'status');
  /* 值域（是不是 pending/running/done/failed）**不在这里判**：`meetingState` 已经判了，
   * 而且它给的文案比这里能给的准（它知道这个阶段该不该完成）。 */
  if (status !== undefined) record.status = status;

  record.produced = listOf(fields, 'produced');

  const at = scalarOf(fields, 'at');
  if (at !== undefined) record.at = at;

  /* `agent`：这一阶段实际由哪个子会话做的。与 `at` **同一条规矩** ——
   * 只有一个非空行内值才挂这个键；`agent:`（写成列表头或空值）读不出来，
   * 该键就**缺席**，不补空串（`Object.hasOwn` 为 false 才是"没记过"）。
   * 它是 `agentRoster` 的唯一数据源，也是真机上"子会话 id 从哪来"的答案。 */
  const agent = scalarOf(fields, 'agent');
  if (agent !== undefined) record.agent = agent;

  /* `continues` 是**标量**。这里不把它塞进 record（record 是 meeting.mjs 的形状，
   * 那边没有这个字段），而是在 ledgerFromTasks 里具体化成 resumes 条目。 */
  const rawContinues = scalarOf(fields, 'continues');
  let continues = 0;
  if (rawContinues !== undefined) {
    const parsed = parseCount(rawContinues);
    if (parsed === null) {
      errors.push(diag(
        E_LEDGER_PARTIAL,
        `阶段 ${id} 的 \`continues\` 是 ${JSON.stringify(flatten(rawContinues))}，不是非负整数：`
          + '"催过几次"读不出来，止损（满 3 次交人）就没法判——那等于让一个已经该交人的阶段继续跑',
        { reason: 'bad-continues', stageId: id },
      ));
      return null;
    }
    continues = parsed;
  }

  /* 卡片：`card.*` 原样带出来。行内单值是标量，列表头是数组 ——
   * 与 `normalizeArtifact` 的取向一致，但不在这里判"这张卡合法不合法"。 */
  const card = cardOf(fields);

  return { record, card, continues };
}

/**
 * 整棵任务树 → 账本。
 *
 * @param {unknown} tasks 宿主任务数组（只用到 `id` 与 `description`）
 * @returns {{ledger: object|null, cards: Array<{stageId: string, card: object}>,
 *            errors: Array<object>, warnings: Array<object>, reason: string}}
 *   `ledger` 为 `null` 时**一定**伴随 `errors`，且 `reason` 说明是哪一种读不出来 ——
 *   **绝不**返回 `{status:'not-started'}` 那种"看起来很太平"的东西。
 */
export function ledgerFromTasks(tasks) {
  const errors = [];
  const warnings = [];
  const cards = [];

  if (!Array.isArray(tasks)) {
    return {
      ledger: null,
      cards,
      errors: [diag(
        E_LEDGER_PARTIAL,
        '任务列表不是一个数组 —— 账本**读不出来**。'
          + '这不是"还没开始开会"：拿读失败冒充空态，后面每一个判断都会建立在假前提上',
        { reason: 'tasks-unreadable' },
      )],
      warnings,
      reason: 'tasks-unreadable',
    };
  }

  const parents = [];
  const stageBlocks = [];
  let blockCount = 0;

  for (const task of tasks) {
    if (task === null || typeof task !== 'object') {
      warnings.push(diag(
        E_LEDGER_DROPPED,
        '任务列表里有一条不是对象 —— 它没有 description，因此读不到账本块。这条任务被跳过',
        { reason: 'bad-task' },
      ));
      continue;
    }
    const parsed = parseMeetingBlock(task.description);
    for (const warning of parsed.warnings) warnings.push(warning);
    if (parsed.errors.length > 0) {
      for (const error of parsed.errors) errors.push(error);
      /* 一个任务块读不出来，整份账本就不可信：**不解剖、不"尽量读"**。
       * 继续读下去等于用半份账本判断进程，那比读不出来更坏（它看起来能跑）。 */
      continue;
    }
    if (parsed.header !== null) {
      blockCount += 1;
      parents.push({ taskId: typeof task.id === 'string' ? task.id : null, header: parsed.header });
    }
    for (const stage of parsed.stages) {
      blockCount += 1;
      stageBlocks.push({ taskId: typeof task.id === 'string' ? task.id : null, stage });
    }
  }

  if (errors.length > 0) {
    const first = errors[0];
    return { ledger: null, cards: [], errors, warnings, reason: first.reason ?? 'unreadable' };
  }

  if (blockCount === 0) {
    return {
      ledger: null,
      cards,
      errors: [diag(
        E_LEDGER_PARTIAL,
        '任务树上一条会议账本块都没有 —— 账本**读不出来**。'
          + '这个结果不许被当成"会议还没开始"：两者看起来一样，但一个是空、一个是缺件，'
          + '处置完全不同（一个是等，一个是去修）',
        { reason: 'no-meeting-block' },
      )],
      warnings,
      reason: 'no-meeting-block',
    };
  }

  if (parents.length === 0) {
    return {
      ledger: null,
      cards,
      errors: [diag(
        E_LEDGER_PARTIAL,
        `有 ${stageBlocks.length} 块阶段回执，但会议头块不在：`
          + '不知道这些回执属于哪场会、按哪个档位跑。**这不是"会议还没开始"**',
        { reason: 'no-parent-block' },
      )],
      warnings,
      reason: 'no-parent-block',
    };
  }

  if (parents.length > 1) {
    return {
      ledger: null,
      cards,
      errors: [diag(
        E_LEDGER_PARTIAL,
        `任务树上有 ${parents.length} 个会议头块：一份账本只能有一个会议头。`
          + '多于一个就没法说这场会是哪一个，也就没法判断跑到哪了',
        { reason: 'duplicate-parent' },
      )],
      warnings,
      reason: 'duplicate-parent',
    };
  }

  const headerRead = readHeader(parents[0].header, errors, warnings);
  if (headerRead === null) {
    return { ledger: null, cards: [], errors, warnings, reason: errors[0]?.reason ?? 'unreadable' };
  }
  const { head, upgrades } = headerRead;

  const ledger = { id: head.id };
  attach(ledger, 'preset', head.preset);
  attach(ledger, 'status', head.status);

  const stages = [];
  const seen = new Map();
  /** @type {Array<{stageId: string, attempt: number, seq: number}>} */
  const resumes = [];
  const continuesByStage = [];

  for (const block of stageBlocks) {
    const read = readStage(block.stage, head.id, errors, warnings);
    if (read === null) continue;

    const { record, card, continues } = read;
    const previous = seen.get(record.stageId);
    if (previous !== undefined) {
      /* 同一阶段来了两块回执：账本里一个阶段只能有一条 record（`recordSubmission` 会整条替换），
       * 所以第二块在账本里**没有位置**。选一块信一把等于替人决定"哪次尝试是真的" —— 判死。 */
      errors.push(diag(
        E_LEDGER_PARTIAL,
        `阶段 ${record.stageId} 有两块回执（第 ${previous.startLine} 行与第 ${block.stage.startLine} 行）：`
          + '账本里一个阶段只能有一条记录，第二块没有位置。'
          + '选一块信一把等于替人决定"哪次尝试才算数"',
        { reason: 'duplicate-stage', stageId: record.stageId },
      ));
      continue;
    }
    seen.set(record.stageId, block.stage);
    stages.push(record);
    continuesByStage.push({ stageId: record.stageId, attempt: record.attempt, continues });
    if (card !== null) cards.push({ stageId: record.stageId, card });
  }

  if (errors.length > 0) {
    return { ledger: null, cards: [], errors, warnings, reason: errors[0].reason ?? 'unreadable' };
  }

  ledger.stages = stages;
  if (upgrades.length > 0) ledger.upgrades = upgrades;

  /* `continues` 标量 → `meeting.resumes` 数组（见文件头"三条损失"第 1 条）。
   * `key` 用 `resume.mjs` 的 `continueKey` 算：在这里重抄一遍 NUL 分隔的格式就是第二个副本。 */
  for (const item of continuesByStage) {
    if (item.continues <= 0) continue;
    if (!Number.isSafeInteger(item.attempt) || item.attempt < 1) continue;
    for (let seq = 1; seq <= item.continues; seq += 1) {
      resumes.push({
        key: continueKey(head.id, item.stageId, item.attempt, seq),
        stageId: item.stageId,
        attempt: item.attempt,
        seq,
      });
    }
  }
  if (resumes.length > 0) ledger.resumes = resumes;

  return { ledger, cards, errors, warnings, reason: 'ok' };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. 渲染：账本 → 块文本（与第 4、5 节互逆，往返由测试钉住）
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 围栏行的长度。3 个反引号足够（块里不会出现纯反引号行，见 `renderLine`）。 */
const FENCE = '```';

/**
 * 渲染一条块内行。
 *
 * **值必须压平**：块语法是按行的，一个带换行的值会凭空造出新的字段行
 * （`card.claim` 里写 `\nstatus: done` 就能改写账本状态）。压平是安全边界，不是排版。
 * 压平之后一行里唯一可能出现反引号的位置是值，而闭合判据要求"整行是纯反引号"，
 * 所以值里的反引号不构成逃逸。
 * @param {string} key
 * @param {unknown} value
 * @returns {string[]}
 */
function renderLines(key, value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) {
    const items = value
      .filter((item) => item !== undefined && item !== null && flatten(item) !== '')
      .map((item) => `  - ${flatten(item)}`);
    /* **空数组要留下 `key:` 这一行**，不能什么都不写。
     * 「写了这个键但零条」与「根本没写这个键」是两件事（本项目点过名的红线），
     * 而 `key:`（只有列表头、没有条目）正是前者唯一能表达的写法。
     * 少写这一行，一次写入就把"我列过、是空的"降级成"我没列过"——数据没丢，意思丢了。 */
    if (items.length === 0) return [`${key}:`];
    return [`${key}:`, ...items];
  }
  const text = flatten(value);
  if (text === '') return [];
  return [`${key}: ${text}`];
}

/**
 * 会议头块文本（含围栏）。
 *
 * 升级行由 `renderUpgradeItem` 编码；**没有 `at` / `by` / `reason` 的老形状渲染出来
 * 与旧版本逐字相同**（`旧档位 -> 新档位`），所以已有账本不会因为这次扩展被改写一次。
 * @param {{id: string, preset?: string, status?: string,
 *          upgrades?: Array<{from: string, to: string, at?: string, by?: string, reason?: string}>}} ledger
 * @returns {string}
 */
export function renderParentBlock(ledger) {
  const lines = [`${FENCE}${MEETING_FENCE_INFO}`];
  lines.push(...renderLines('meeting', ledger?.id));
  lines.push(...renderLines('preset', ledger?.preset));
  lines.push(...renderLines('status', ledger?.status));
  const upgrades = Array.isArray(ledger?.upgrades)
    ? ledger.upgrades
      .filter((item) => item !== null && typeof item === 'object')
      .map(renderUpgradeItem)
    : [];
  lines.push(...renderLines('upgrades', upgrades));
  lines.push(FENCE);
  return lines.join('\n');
}

/**
 * 阶段回执块文本（含围栏）。
 * @param {{id: string}} ledger
 * @param {{stageId: string, attempt?: number, status?: string, produced?: string[],
 *          at?: string, continues?: number}} record
 * @param {object|null} card
 * @returns {string}
 */
export function renderStageBlock(ledger, record, card) {
  const lines = [`${FENCE}${MEETING_FENCE_INFO}`];
  lines.push(...renderLines('meeting', ledger?.id));
  lines.push(...renderLines('stage', record?.stageId));
  lines.push(...renderLines('attempt', record?.attempt));
  lines.push(...renderLines('status', record?.status));
  if (Number.isSafeInteger(record?.continues) && record.continues > 0) {
    lines.push(...renderLines('continues', record.continues));
  }
  lines.push(...renderLines('produced', record?.produced));
  lines.push(...renderLines('at', record?.at));
  /* `agent` 只在真值时才写：`renderLines` 对 `''` / `undefined` 返回 `[]`，
   * 所以"没记过代理"的阶段块里不会冒出一行 `agent:`。 */
  lines.push(...renderLines('agent', record?.agent));
  if (card !== null && typeof card === 'object' && !Array.isArray(card)) {
    for (const key of Object.keys(card)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      lines.push(...renderLines(`${STAGE_CARD_PREFIX}${key}`, card[key]));
    }
  }
  lines.push(FENCE);
  return lines.join('\n');
}

/**
 * 取出 description 里**第一个**账本块的原文（含围栏行）。没有 → `null`；没闭合 → `null`。
 *
 * 用来做"要不要写"的比较：只有渲染结果与现有原文**逐字不同**才写。
 * 手改过排版（比如把键对齐了）会因为这句话被规范化一次，之后不再动它。
 * @param {unknown} description
 * @returns {string|null}
 */
export function meetingBlockText(description) {
  const source = textOf(description);
  if (source === '') return null;
  const lines = source.split(/\r\n|\n|\r/);
  const found = findMeetingRanges(lines);
  if (found.unclosedAt !== null || found.ranges.length === 0) return null;
  const first = found.ranges[0];
  return lines.slice(first.start, first.end + 1).join('\n');
}

/**
 * 把新块**替换**进 description（保留围栏之外的所有人的正文）。
 *
 * - 已有账本块 → 原地替换第一块（位置不动）；
 * - 没有账本块 → **追加到末尾**。追加到末尾是硬规矩：闭栏判据没有长度隔离，
 *   账本块写在 `team-board` 块前面、又忘了闭合时，那一行纯反引号会被 `team-board` 当成自己的闭栏。
 * - 账本块没闭合 → 返回 `null`（不猜该替换到哪一行）。
 * @param {unknown} description
 * @param {string} blockText
 * @returns {string|null}
 */
export function spliceMeetingBlock(description, blockText) {
  const source = textOf(description);
  if (typeof blockText !== 'string' || !blockText.startsWith(FENCE)) return null;
  const blockLines = blockText.split(/\r\n|\n|\r/);
  if (source === '') return blockLines.join('\n');

  const lines = source.split(/\r\n|\n|\r/);
  const found = findMeetingRanges(lines);
  if (found.unclosedAt !== null) return null;

  if (found.ranges.length === 0) {
    return [...lines, ...(lines[lines.length - 1].trim() === '' ? [] : ['']), ...blockLines].join('\n');
  }

  const first = found.ranges[0];
  const next = [...lines.slice(0, first.start), ...blockLines, ...lines.slice(first.end + 1)];
  return next.join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. ledgerWritePlan：差量写（不许全量重放）
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 从旧任务树里按阶段 id 建索引。
 *
 * **读不出来的任务不参与写计划，而且会让整轮写计划作废**（见 `ledgerWritePlan`）：
 * 一块没闭合的任务既可能是父块也可能是子块，猜错一边就会建出第二个会议头 ——
 * 而"同一个会两个头"比"什么都不写"坏得多（`ledgerFromTasks` 会因此判 `duplicate-parent`，
 * 人就再也不信账本了）。
 * @param {unknown} prevTasks
 */
function indexPrevTasks(prevTasks) {
  const byStage = new Map();
  const parentTasks = [];
  const unreadable = [];
  const list = Array.isArray(prevTasks) ? prevTasks : [];

  for (const task of list) {
    if (task === null || typeof task !== 'object' || typeof task.id !== 'string') continue;
    const parsed = parseMeetingBlock(task.description);
    if (parsed.errors.length > 0) {
      unreadable.push({
        taskId: task.id,
        reason: parsed.errors[0].reason ?? 'unreadable',
        codes: parsed.errors.map((error) => error.code),
      });
      continue;
    }
    if (parsed.header !== null) parentTasks.push({ taskId: task.id, description: task.description });
    for (const stage of parsed.stages) {
      const stageId = scalarOf(stage.fields, 'stage');
      if (typeof stageId !== 'string' || stageId.trim() === '') continue;
      const key = stageId.trim();
      if (byStage.has(key)) continue;
      byStage.set(key, { taskId: task.id, description: task.description, card: cardOf(stage.fields) });
    }
  }

  return { byStage, parentTasks, unreadable };
}

/** 阶段任务的标题。纯函数只能给出机械标题，宿主可以覆盖。 */
function stageSubject(meetingId, stageId) {
  return `会议 ${meetingId} · 阶段 ${stageId}`;
}

/**
 * 算这一轮要写几次。
 *
 * **一次阶段完成 = 1 次子任务 update + 0~1 次父任务 update。** 不是"把整棵树重放一遍"：
 * 每次 update 都是一次 revision bump，全量重放会拿机器的写去撞人正在手改的那张卡。
 *
 * 父任务会不会被写，只看**渲染出来的头块文本与现有原文是否逐字相同**：
 *   会写 —— `status` 变了（running → paused / done / abandoned）、
 *           `preset` 变了（升档）、`upgrades` 追加了一条、
 *           或者根本没有父块（要补建）。
 *   不写 —— 上面四件事一件都没发生。一个阶段跑完时最常见的正是这一种。
 *
 * @param {unknown} prevTasks 现有任务树（只读 `id` / `description`）
 * @param {unknown} nextLedger 目标账本（`meeting.mjs` 的形状；阶段记录可带 `card`）
 * @returns {{creates: Array<object>, updates: Array<object>,
 *            errors: Array<object>, warnings: Array<object>}}
 */
export function ledgerWritePlan(prevTasks, nextLedger) {
  const errors = [];
  const warnings = [];
  const creates = [];
  const updates = [];

  if (nextLedger === null || typeof nextLedger !== 'object' || Array.isArray(nextLedger)) {
    return {
      creates,
      updates,
      errors: [diag(
        E_LEDGER_PARTIAL,
        '要写的账本不是对象 —— 不知道目标状态是什么，就没法算差量。'
          + '此时**一次都不许写**：猜一个目标状态写下去，等于把账本改成没人要求的样子',
        { reason: 'no-ledger' },
      )],
      warnings,
    };
  }

  const meetingId = typeof nextLedger.id === 'string' && nextLedger.id.trim() !== ''
    ? nextLedger.id.trim()
    : '';
  if (meetingId === '') {
    return {
      creates,
      updates,
      errors: [diag(
        E_LEDGER_PARTIAL,
        '要写的账本没有 id —— 建出来的任务没有归属，写下去就是一堆认不回来的卡',
        { reason: 'meeting-id-missing' },
      )],
      warnings,
    };
  }

  const prev = indexPrevTasks(prevTasks);
  if (prev.unreadable.length > 0) {
    /* 读不出来 → **一次都不写**。猜错一边就会建出第二个会议头，
     * 而"同一个会有两个头"会让 `ledgerFromTasks` 直接判死整份账本 —— 比不写坏得多。 */
    return {
      creates,
      updates,
      errors: prev.unreadable.map((broken) => diag(
        E_LEDGER_PARTIAL,
        `任务 ${broken.taskId} 的账本块读不出来（${broken.codes.join('、')}）：`
          + '算不出差量，所以这一轮一次都不写。'
          + '**不许**"照着一份能读出来的部分计划重建一遍"—— 那会把读不出来的那一块当成不存在，'
          + '于是同一个会多出一个会议头',
        { reason: broken.reason },
      )),
      warnings,
    };
  }

  /* ---- 父块 ---- */
  const parentText = renderParentBlock(nextLedger);
  if (prev.parentTasks.length > 1) {
    /* 旧树上已经有两个会议头：不许"只认第一个、把第二个当不存在"。
     * 那正是静默跳过的形状 —— 写完这一轮，第二个头还在，账本永远读不出来，
     * 而写的人以为一切都好。判死，交人去删那一张。 */
    return {
      creates,
      updates,
      errors: [diag(
        E_LEDGER_PARTIAL,
        `任务树上有 ${prev.parentTasks.length} 个会议头块（${prev.parentTasks.map((item) => item.taskId).join('、')}）：`
          + '一份账本只能有一个会议头。这一轮一次都不写 —— '
          + '静默只认第一个就等于把其余的当成不存在，而它们还在看板上',
        { reason: 'duplicate-parent' },
      )],
      warnings,
    };
  }
  if (prev.parentTasks.length === 0) {
    creates.push({
      role: ROLE_PARENT,
      stageId: null,
      subject: `会议 ${meetingId}`,
      description: parentText,
      blockedByStages: [],
    });
  } else {
    const currentText = meetingBlockText(prev.parentTasks[0].description);
    if (currentText !== parentText) {
      const next = spliceMeetingBlock(prev.parentTasks[0].description, parentText);
      if (next === null) {
        errors.push(diag(
          E_LEDGER_PARTIAL,
          `父任务 ${prev.parentTasks[0].taskId} 的账本块没闭合，替换不安全 —— 不知道边界在哪，一次都不许写`,
          { reason: 'unclosed-block' },
        ));
      } else {
        updates.push({
          taskId: prev.parentTasks[0].taskId,
          role: ROLE_PARENT,
          stageId: null,
          description: next,
        });
      }
    }
  }

  /* ---- 阶段块 ---- */
  const stages = Array.isArray(nextLedger.stages) ? nextLedger.stages : [];
  const wanted = new Set();
  let previousStageId = null;

  for (const record of stages) {
    if (record === null || typeof record !== 'object') continue;
    const stageId = typeof record.stageId === 'string' ? record.stageId.trim() : '';
    if (stageId === '') continue;
    wanted.add(stageId);

    const existing = prev.byStage.get(stageId);
    /* 卡片从哪来：目标账本这一条给了就用它；没给就沿用旧块里那张卡。
     * 阶段跑完时只有 status / produced 变，卡片必须原样活下来 —— 否则每完成一步就把方案卡擦掉。 */
    const card = existing === undefined ? (record.card ?? null) : (record.card ?? existing.card);

    /* `continues` 从哪来：块里存的标量已经被 `ledgerFromTasks` 折叠进 `meeting.resumes`
     * （那是 `resume.mjs` 的形状），所以目标账本这一条上**通常没有** `continues`。
     * 不把它从 `resumes` 反算回来的话，每次渲染都会漏掉 `continues:` 那一行 →
     * 与现有原文永远不相等 → 每次都被判成"变了" → 一个阶段跑完要写两次，
     * 而且写进去的还是把它删掉的版本。`continueCount` 与 `recordContinue` 同一口径，
     * 所以反算是无损的（丢的只有时间与发起人，见文件头"三条损失"第 1 条）。 */
    const continues = Number.isSafeInteger(record.continues) && record.continues > 0
      ? record.continues
      : continueCount(nextLedger, stageId, record.attempt);
    const rendered = renderStageBlock(nextLedger, {
      stageId,
      attempt: record.attempt,
      status: record.status,
      produced: Array.isArray(record.produced) ? record.produced : [],
      at: record.at,
      continues,
      /* `agent` 的**第三条腿**。前两条（`renderStageBlock` 写得出、`ledgerFromTasks` 读得回）
       * 曾经都在，唯独这里不带 —— 于是 `agent:` 永不落盘，`agentRoster` 永远读到空名册，
       * `decideAgent` 永远走 `fallback-fresh`，而整条链看起来"两边都接好了"。
       * 这是本项目第四次撞上同一形状（只写不读 / 只读不写，两侧看起来都在）。
       *
       * 照旧：**只在真值时才挂**。`record.agent` 缺席（`undefined`）时原样透传 ——
       * 不补默认值、不补空串；`renderLines` 对 `undefined` / `''` 返回 `[]`，
       * 所以块里不会冒出一行空的 `agent:`。 */
      agent: record.agent,
    }, card);

    if (existing === undefined) {
      creates.push({
        role: ROLE_STAGE,
        stageId,
        subject: stageSubject(meetingId, stageId),
        description: rendered,
        /* 链式排序交给宿主：纯函数拿不到"新任务的 id"，只能给"挡在哪个阶段后面"。 */
        blockedByStages: previousStageId === null ? [] : [previousStageId],
      });
    } else if (meetingBlockText(existing.description) !== rendered) {
      const next = spliceMeetingBlock(existing.description, rendered);
      if (next === null) {
        errors.push(diag(
          E_LEDGER_PARTIAL,
          `阶段 ${stageId} 的任务 ${existing.taskId} 账本块没闭合，替换不安全 —— 一次都不许写`,
          { reason: 'unclosed-block', stageId },
        ));
      } else {
        updates.push({
          taskId: existing.taskId,
          role: ROLE_STAGE,
          stageId,
          description: next,
        });
      }
    }

    previousStageId = stageId;
  }

  /* 旧树上还在、但目标账本里已经没有的阶段任务：**不删**（删任务是不可逆动作，
   * 而且那可能是升档前的历史）。只出声：这种任务会一直出现在看板上，却不再被推进。 */
  for (const [stageId, existing] of prev.byStage) {
    if (wanted.has(stageId)) continue;
    warnings.push(diag(
      E_LEDGER_DROPPED,
      `阶段 ${stageId} 的任务 ${existing.taskId} 还在，但目标账本里没有这个阶段：`
        + '这一轮不会动它。它会继续挂在看板上而不再被推进——要清掉得由人决定',
      { reason: 'orphan-stage-task', stageId },
    ));
  }

  return { creates, updates, errors, warnings };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 8. 分类：把会议任务从交付门禁的分母里**显式**排除
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 这条任务的 description 里有没有账本围栏（不管解析成不成功）。
 *
 * 判据用**围栏的存在**，不是"解析成功"：一个块没闭合的任务仍然是会议任务，
 * 它必须被排出门禁的分母，并由 `parseMeetingBlock` 报出它的毛病。
 * 若改成"解析成功才算"，坏的会议任务就会掉进门禁里被判一遍 —— 那正是"静默跳过"的镜像。
 * @param {unknown} task
 * @returns {boolean}
 */
export function isMeetingTask(task) {
  if (task === null || typeof task !== 'object') return false;
  const source = textOf(task.description);
  if (source === '') return false;
  for (const line of source.split(/\r\n|\n|\r/)) {
    const open = FENCE_OPEN_RE.exec(line.trim());
    if (open && open[2].trim() === MEETING_FENCE_INFO) return true;
  }
  return false;
}

/**
 * 会议**子任务**（阶段回执）。
 *
 * 干净的会议头任务返回 `false`；其余凡是带账本围栏的都返回 `true` —— 包括读不出来的。
 * 理由：把"读不出来的会议任务"留给交付门禁去判，等于让门禁对一个它根本不认识的形状发意见。
 * @param {unknown} task
 */
export function isMeetingStageTask(task) {
  if (!isMeetingTask(task)) return false;
  const parsed = parseMeetingBlock(task.description);
  if (parsed.header !== null) return false; /* 干净的会议头 */
  return true;
}

/**
 * 会议**父任务**（会议头）。
 * @param {unknown} task
 */
export function isMeetingParentTask(task) {
  if (!isMeetingTask(task)) return false;
  return parseMeetingBlock(task.description).header !== null;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 9. 阶段 → 任务 id：把"块内字段表"挡在导出契约之外
 *
 * 这一节存在的唯一理由，是让 `ledger.mjs` 外面**没有任何人需要读 `stages[].fields`**。
 * `host/index.js` 曾经自己写了一份 `fields instanceof Map` 的判据去取阶段 id ——
 * 那是把本文件的内部表示抄成第二份契约：本文件一改内部结构，他那边就静默变成
 * "这棵树上没有这个阶段"，而错法看起来完全正常（每条 create 都判"找不到阶段 X 的任务 id"）。
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 走一遍任务树，收出"哪条任务身上带着哪个阶段的回执"。
 *
 * 与 `ledgerFromTasks` 的分工：那边判**整份账本能不能读**（缺父块 / 重复回执 / 整数读不出来都是
 * blocker）；这里只回答"阶段 id 落在哪条任务上"，**不判死活**，因为它的用途是写路径上的 id 翻译，
 * 而那时账本已经过一次 `ledgerFromTasks` 的判断了。
 *
 * 三件如实记账的事（都是"为什么这张表里可能少一条"）：
 *   - 任务不是对象 / `id` 不是非空字符串 → `bad-task`（它没法作为 id 的承载者）；
 *   - 这个任务的账本块读不出来 → `unreadable-block`：它的阶段回执一个都读不到，
 *     于是这张表里会少它那几个阶段 —— 说出来，不然下一个"找不到阶段 X"的人要去猜；
 *   - 同一阶段挂在多条任务上 → 由 `stageTaskIssues` 报 `duplicate-stage-task`。
 *
 * **父任务的会议头块不产生任何条目**：会议头里没有 `stage` 键，条目只从 `parsed.stages` 来。
 * 一条 description 里同时有会议头和阶段块时，阶段块照样产出条目（"单任务多块"那种排法）。
 * @param {unknown} tasks
 * @returns {{receipts: Array<{taskId: string, stageId: string|null, meetingId: string|null,
 *                             agentId: string|null, attempt: number|null}>, issues: Array<object>}}
 */
function walkStageReceipts(tasks) {
  const receipts = [];
  const issues = [];

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || typeof task !== 'object') {
      issues.push({ reason: 'bad-task', taskId: null });
      continue;
    }
    const taskId = typeof task.id === 'string' ? task.id : '';
    if (taskId === '') {
      issues.push({ reason: 'bad-task', taskId: null });
      continue;
    }

    const parsed = parseMeetingBlock(task.description);
    if (parsed.errors.length > 0) {
      issues.push({
        reason: 'unreadable-block',
        taskId,
        /* 块都没读出来，这两件事实就是**不知道** —— 键照给、值是 `null`。
         * 少了这两个键，下游要按 `meetingId`/`stageId` 归类 issue 时就得先判"这个键在不在"。 */
        meetingId: null,
        stageId: null,
        codes: parsed.errors.map((error) => error.code),
      });
      continue;
    }

    for (const stage of parsed.stages) {
      /* 只认**读得出 stageId** 的块：`stage:` 后面没有值（写成了列表头）就不算一条可定位的回执 ——
       * 猜一个 id 出来会把一条阶段链到别人的任务上。
       * 但**条目本身仍然收**（`stageId: null`）：一块写了 `agent`、却没写阶段的块，
       * 是"这个人干过活、但不知道干的是哪一步"，那件事必须能被说出来，不能被丢掉。 */
      receipts.push({
        taskId,
        stageId: stageIdOf(stage.fields),
        meetingId: scalarIdOf(stage.fields, 'meeting'),
        agentId: scalarIdOf(stage.fields, 'agent'),
        attempt: attemptOf(stage.fields),
      });
    }
  }

  return { receipts, issues };
}

/** 一个块里某个"标识"字段的值：读得出非空字符串 → 它；否则 `null`（**不造**）。 */
function scalarIdOf(fields, key) {
  const value = scalarOf(fields, key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** 阶段 id：与 `scalarIdOf` 同规矩（`stage:` 写成列表头 → `null`）。 */
function stageIdOf(fields) {
  return scalarIdOf(fields, 'stage');
}

/** 轮次：只有正整数的数才照收，别的形态 `null`（读不出来就是读不出来，不补 1）。 */
function attemptOf(fields) {
  const raw = scalarOf(fields, 'attempt');
  if (raw === undefined) return null;
  const value = parseCount(raw);
  return value !== null && value >= 1 ? value : null;
}

/**
 * 阶段 id → 承载该阶段回执的任务 id。
 *
 * ## 重复回执：取**第一条**，并且不静默
 *
 * 规则是「按任务数组顺序，**第一个**带这个阶段的非空任务 id 生效，后到的整条忽略」
 * （与 `parseDeclaration` 的"重复键取第一个"、本文件"重复键取第一个"同一取向：
 * 后来者不能覆盖原意）。但**这条规则不是最终判决**，有两条防线：
 *   1. 本函数是纯函数、只返回一张表，**发声的通道是 `stageTaskIssues`** —— 调用方要判
 *      "有没有重复"就去问它，里面写着 `taskIds` 全量和 `taken`（被选中的那条）；
 *   2. 更要紧的是：同一阶段两块回执在 `ledgerFromTasks` 里是 **blocker**
 *      （`E_LEDGER_PARTIAL` / `duplicate-stage`）。所以任何走到"翻译 id"这一步的调用方，
 *      都已经先被账本层拦过一次了 —— 这里取第一条只是"实在要比时按什么比"，
 *      而不是"我替你决定哪次尝试才算数"。
 *
 * `tasks` 不是数组 → 空 `Map`，不抛（写路径上宁可拿不到 id 也不要炸）。
 * @param {unknown} tasks
 * @returns {Map<string, string>}
 */
export function stageTaskIds(tasks) {
  const map = new Map();
  for (const receipt of walkStageReceipts(tasks).receipts) {
    if (receipt.stageId === null) continue; /* 定位不到阶段的块不参与 id 翻译 */
    if (map.has(receipt.stageId)) continue; /* 第一个生效 */
    map.set(receipt.stageId, receipt.taskId);
  }
  return map;
}

/**
 * 这张"阶段 → 任务 id"表**可能缺条目**的全部原因，按遇到顺序列出。
 *
 * 只有一张 `Map` 的时候"选哪条"是看不见的，这个函数就是那个看得见的地方。
 * 三种 reason：
 *   `bad-task`              任务不是对象，或没有非空字符串 id —— 它不可能是 id 的承载者
 *   `unreadable-block`      这个任务的账本块读不出来 —— 它那几个阶段一定不在表里
 *   `duplicate-stage-task`  同一阶段挂在多条任务上；`taskIds` 是全部（按顺序去重），
 *                           `taken` 是**实际生效的那一条**（= `taskIds[0]`）
 *
 * 同一条任务里出现两块同一阶段回执**不算**这里的重复：它翻译出来的 id 是同一个，
 * 真正的问题是"账本里一个阶段只能有一条记录"，那由 `ledgerFromTasks` 判
 * （`duplicate-stage` / blocker）。
 * @param {unknown} tasks
 * @returns {Array<object>}
 */
export function stageTaskIssues(tasks) {
  const { receipts, issues } = walkStageReceipts(tasks);

  const byStage = new Map();
  for (const receipt of receipts) {
    if (receipt.stageId === null) continue; /* 定位不到阶段的块没有"重复"可言 */
    if (!byStage.has(receipt.stageId)) byStage.set(receipt.stageId, []);
    const taskIds = byStage.get(receipt.stageId);
    if (!taskIds.includes(receipt.taskId)) taskIds.push(receipt.taskId);
  }

  for (const [stageId, taskIds] of byStage) {
    if (taskIds.length < 2) continue;
    issues.push({
      reason: 'duplicate-stage-task',
      stageId,
      taskIds: taskIds.slice(),
      taken: taskIds[0],
    });
  }

  return issues;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 10. 代理名册：让「有哪些可用的人」这件事在数据上存在
 *
 * 这一节回答的是真机跑不动的那半个问题。`task-14` 的真跑轨迹里 `target=agent-me`
 * —— `decideAgent` 在**单候选**下把 agentId 判成调用方自己，而宿主
 * `sendMessage(sender, targetId, …)` 要求 `targetId` 是**直接子会话**。
 * 根因不是判错，是**候选目录根本不存在**：驱动器每阶段问"该用谁"，
 * 而"有哪些可用的人"没有任何数据源。这个目录就是从阶段块里长出来的数据源。
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 代理名册：阶段块里记下的"这一步实际由哪个子会话做的"。
 *
 * @param {unknown} tasks
 * @returns {{entries: Array<{agentId: string, meetingId: string|null, stageId: string,
 *                            taskId: string, attempt?: number}>, issues: Array<object>}}
 *
 * 条目形状说明（**没有 `role`**，这一条要在报告里说清）：
 * 任务描述里给的签名是 `{agentId, role, meetingId, stageId}`，但 `role`（critic / client /
 * architect / dev / qa）**只存在于预设**（`presets/*.json` 的 `stages[].role`），
 * 阶段块里没有这个键，本文件也拿不到预设 —— 这一层如果挂一个永远 `null` 的 `role`，
 * 下游的 `chooseAgent` 会看起来读到了一个真值，那正是本项目最忌讳的
 * "字段一空，读的人就以为它全判了"。所以宁可不挂：`Object.hasOwn(entry, 'role') === false`
 * 明确表示"这一层不知道角色"。要角色 → 用 `stageId` 去查 `preset.stages[].role`。
 *
 * 三条硬规矩：
 *   - **同一个 `agentId` 出现在多个 `(meetingId, stageId)` 上是正常的**（那就是复用），
 *     **全部保留、不去重** —— 名册回答"谁干过哪些活"，去重就回答不了"谁干过几件"；
 *   - **读不出来的块进 `issues`**，带上 `reason` / `meetingId` / `stageId`（不知道就给 `null`）。
 *     静默丢掉等于"这个人不存在"，而"读不出来 ≠ 不存在"是本项目红线；
 *   - `tasks` 不是数组 → `{entries: [], issues: []}`，不抛。
 *
 * 另外两种"名册里为什么会少一条"的如实记账（都是本函数自己加的，`issues` 里能看见）：
 *   `stage-missing`     块里写了 `agent`、却没有可读的 `stage` —— 不知道干的是哪一步，**不入册**
 *                       （一条 `(null, agentId)` 的条目对"该用谁"没有任何用处，而丢掉又不能说）；
 *   `meeting-missing`   块里没有 `meeting:` —— **照样入册**（`meetingId: null`），但要说出来：
 *                       这种条目没法按会议过滤，而且通常意味着这张卡被贴错了任务。
 *
 * 同一条任务里出现两块同一阶段回执**不在本函数表态**（那是 `duplicate-stage` / blocker，
 * 由 `ledgerFromTasks` 判 —— 判两次就会分叉）。
 */
export function agentRoster(tasks) {
  const { receipts, issues } = walkStageReceipts(tasks);
  const entries = [];

  for (const receipt of receipts) {
    /* 没有 `agent` 的块是**大多数**（老账本、以及所有还没记过代理的阶段）：
     * 既不产条目，也不产 issue —— 那不是"这个人不存在"，那是"这件事还没做"。
     * 在这里出声会把名册变成一片噪音，而噪音是这种东西最大的敌人。 */
    if (receipt.agentId === null) continue;

    if (receipt.stageId === null) {
      issues.push({
        reason: 'stage-missing',
        taskId: receipt.taskId,
        agentId: receipt.agentId,
        meetingId: receipt.meetingId,
        stageId: null,
      });
      continue;
    }

    if (receipt.meetingId === null) {
      issues.push({
        reason: 'meeting-missing',
        taskId: receipt.taskId,
        agentId: receipt.agentId,
        meetingId: null,
        stageId: receipt.stageId,
      });
    }

    const entry = {
      agentId: receipt.agentId,
      meetingId: receipt.meetingId,
      stageId: receipt.stageId,
      taskId: receipt.taskId,
    };
    /* 只给真值才挂键：轮次读不出来时不补 1（补了就把"没写"和"第一轮"焊在一起）。 */
    if (receipt.attempt !== null) entry.attempt = receipt.attempt;
    entries.push(entry);
  }

  return { entries, issues };
}