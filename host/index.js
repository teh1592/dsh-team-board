/**
 * @local/team-board —— DSH Host 外壳（第 7 轮 W7）
 *
 * 这个文件的全部职责，是**把已经写好的纯模块接上宿主**，一行判定都不重写：
 *   - 判定（状态折叠、@me 归属、写域警告透传、净化、按显示宽度截断）都在 `src/board.mjs`；
 *   - 缺能力的结构化错误在 `src/adapter.mjs`（`unsupported`）；
 *   - 本文件只做三件事：注册工具、**从宿主取身份**、把数据交给 `renderBoard`。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全边界（本插件唯一一条红线）
 * ═══════════════════════════════════════════════════════════════════════════
 * `me` 只能取自 `ctx.agentTeams.membership(exec.agent).name`，**绝不能作为工具参数**。
 *
 * 理由：`ownerName` 是宿主 CAS 写入的归属信息，模型改不动；一旦让模型自己传 `me`，
 * 它就能假装自己是别人 —— 于是 `@me` 标记（"这条是你在做"）与依赖它的自审检测
 * 同时失效。这是 J-1 钉住的"身份不是调用方说的"在外壳这一层唯一的落地点。
 *
 * 落地方式是两层，缺一不可：
 *   1. 参数 schema 根上 `additionalProperties: false`：想塞 `me` 的调用在 schema 层
 *      就失败，而不是被静默忽略（被忽略的话，调用方会以为自己成功冒充了别人）；
 *   2. `execute` **从不读** `args` 里除三个整数以外的任何键 —— 不 spread、不透传，
 *      只逐键取值。即使某条执行路径不校验 schema，身份也伪造不了。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 关于 `inject`（一处**有意的偏离**，见交付报告 §5）：
 *   `inject` 只硬依赖 `tools`（注册面），`agentTeams` 用 `ctx.get('agentTeams')` 软读。
 *   原因：本 profile（desktop）**没有挂载** Agent Teams 服务（profile 的 bundles 里
 *   没有 `@deepseek-ai/dsh-experimental-agent-team-profile`，而该 bundle 的 patch 会
 *   把 `tool-subagent` 关掉 —— 这里 `subagent` 工具仍在，可反证该层未应用）。
 *   如果照派工书硬 `inject: ['tools', 'agentTeams']`，插件在本 profile 里**永不激活**，
 *   工具不出现在任何清单里，连一次真实调用都无法验证。
 *   所以：服务在 → 严格按 Team 成员门控；服务不在 → 工具仍注册，调用时给出
 *   `E_HOST_UNSUPPORTED`（宿主缺少 agentTeams），而不是让调用方看到一块空板
 *   以为"队里没人有活"（空板与真相长得一样，这是派工书点名要避免的失败态）。
 *   要改成严格门控，只改 `whenToolIsVisible` 里的一句 return false。
 */

import { renderBoard } from '../src/board.mjs';
import { unsupported } from '../src/adapter.mjs';
import { roleStats } from '../src/roles.mjs';
import { canDeliver } from '../src/delivery.mjs';
/* D-14：`kind` 的来源。真实 TeamTaskView 没有 kind/contract，声明写在 description 的
 * `team-board` 围栏块里；解析规则（只认第一个块、键集、永不抛错）全在 contract.mjs，
 * 这一层只搬运。**不要在这里重写解析**——那份实现有 23 条自己的测试守着。 */
/* 第 14 轮：`normalizeIdentity` 是**身份规范形的唯一实现**（SD-2）。结构化 payload 里的
 * `mine` 必须和板上的 `@me` 判成同一件事，所以这里也走它，不另写一套。 */
import { parseDeclaration, normalizeIdentity, KINDS, QUALITY_KINDS } from '../src/contract.mjs';
/* P0（第 15 轮）：把 `gates.mjs` 真正接进生产，但**只算不拦**（两态 shadow）。
 *
 * 为什么是 shadow 而不是 enforce：`gates.mjs` 有 940 行、18 个码，此前**没有任何生产
 * 代码 import 它**（`contract.test.mjs:1716` 那条测试就是按这个前提写的）。一次性
 * 切 enforce，等于让一套从没对真实任务跑过的判据直接决定收不收活 —— 这正是自举红队
 * 标出的 K1 致命场景：存量 21 条任务会瞬间一片红，而没人知道那些红是真的还是接线错了。
 *
 * 所以这一轮只做两件事：让它跑起来，把它的结论**原样**放进 payload 的 `shadow` 块。
 * `ok` 一个字节都不受影响 —— shadow 里的码不参与任何判定。
 *
 * 第二个理由与"空 ≠ 不可用"同源：宿主这一侧**没有** `payload` / `receipts` /
 * `diffPaths`（见下面 1407 行那段注释），四项输入全缺。全缺时 gates 的结论是
 * "判不动"，不是"没问题"。所以 shadow 必须**同时**报出"交了哪几项输入"，
 * 否则一屏"零个码"会被读成"全部通过"—— 那是这个项目最不能犯的错。
 * `shadow.inputs` 就是为此存在的，它与 `rows` 同等重要，不许省。 */
import { evaluateCompletion, judgeCoverage } from '../src/gates.mjs';
import { ledgerFromTasks, isMeetingTask, ledgerWritePlan, stageTaskIds, agentRoster } from '../src/ledger.mjs';
import { applyUpgrade, recordSubmission, meetingState } from '../src/meeting.mjs';
import { loadPreset } from '../src/preset.mjs';
import { driveMeeting, createSubagentDeliver } from './meeting.js';
import { judgeArtifact } from '../src/artifact.mjs';
import { installReview } from './review-plugin.mjs';
import { z } from 'zod';

/** Patch 行 id 与包名同名，便于在 Loader 输出里对照。 */
export const name = 'team-board';

/**
 * 硬依赖只有工具注册表。
 * 不写 `agentTeams` 的原因见文件头注释（软读 + 调用时诊断）。
 */
export const inject = ['tools'];

export const Config = z.object({
  reviewStageTimeoutMs: z.number().int().positive().optional().describe('每个评审阶段的最长执行时间，默认20分钟。'),
});

const TOOL_NAME = 'team_board';

const TOOL_DESCRIPTION = [
  '读取本队的任务板：每个任务是谁的、什么状态、卡在哪个依赖上，以及团队成员的运行状态。',
  '答案来自宿主的 Team 任务板（唯一真相源），插件不另存任务。',
  '身份由宿主从调用方 Agent 解析，不能由参数指定。',
  /* ── 开会纪律（第 18 轮）──────────────────────────────────────────────────
   *
   * 为什么这段必须写在这里：`E_PROPOSAL_UNREVIEWED` / `E_QUESTIONS_UNANSWERED`
   * 那两条判据**只在"存在 proposal 任务"时才可能触发**。模型若拿到任务直接开干、
   * 一条提案都不建，两条判据永远不会看一眼 —— 判定层就白做了。
   *
   * 为什么只能写在这两个常量里：本插件往系统提示词注入内容的**唯一**通道是
   * `ctx.systemPrompt.tools(...)`，工具描述跟着工具一起进提示词。于是用户关掉总开关时
   * 工具不注册、描述一起消失，规则**不可能泄漏到关着开关的会话里**。
   * 若写进 preset 或任何别处，开关就管不住它了。
   *
   * 这里不写任何**数字门槛**（"超过 N 个文件才提案"之类）：开关本身就是例外机制，
   * 再叠一个阈值等于给模型一个钻空子的口径。例外只按"是不是显然的小改动"描述。 */
  '【拿到任务先别开工】先建一条 kind: proposal 任务，派 2–3 名成员各自独立写一份提案：',
  '提案之间互不可见（各写各的，不是一起改）——互相看得见就会互相附和，那等于只有一份方案。',
  '提案里必须列 openQuestions：真正需要用户拍板的问题；确实没有问题就写空数组。',
  '空数组与不写这个字段不是一回事：空数组 =「我想过了，没有问题」，不写 =「我根本没想过」。',
  '【然后收敛】建一条 kind: review 任务，reviewedTaskId 指向那份提案，',
  'answered 逐条写「<问题原文> → <用户答复>」。用户答不上来的部分如实写进决议，别假装答过。',
  '【之后才开工】这一步走完，才建 kind: implementation 任务去改文件。',
  '上面两步没走完时 team_deliver 会以 E_PROPOSAL_UNREVIEWED / E_QUESTIONS_UNANSWERED 阻断；',
  '但别把它读成「先做再补」——那两条判据只认单据，不认你心里想没想。',
  '【例外】改动小到不需要商量（改个错字、调一个数字、修一处显然的 bug）可以直接做，',
  '但要在任务描述里写明为什么跳过提案。硬走一遍流程是浪费；反过来，',
  '什么都拿「太小了」当理由，这套流程就变成了形式主义。',
  /* ── 成员被中断是常态（第 19 轮 task-11）──────────────────────────────────
   *
   * 这不是安慰话，是这套协作的**运行前提**。本地环境不稳，成员随时可能被环境
   * 打断（实测一晚中断过七八次）。带头的人若把"没消息"读成"它失败了/它死了"，
   * 会做出两个都很贵的误判：重派（和它自己撞写域）或放弃（其实活已经做完了）。
   *
   * 只写在这里的原因与开会纪律相同：工具描述是进系统提示词的唯一通道，
   * 关掉总开关就一起消失。 */
  '【成员被中断是常态，与它干得好不好无关】本地环境不稳，成员随时可能被环境打断。',
  '看到一次「无消息失败」不要判定它失败，更不要立刻重派——重派会和它自己撞写域，',
  '两个人在改同一批文件比慢一点糟得多。',
  '恢复的方式就是发一句「继续」：不需要重述任务、不需要附上下文，成员记得自己手上的活。',
].join('');

/**
 * 参数只有三个**可选整数**。`additionalProperties: false` 是故意的：
 * 有人想塞 `me` 进来，要让它在 schema 层就失败，而不是被忽略。
 *
 * 第 8 轮 W7-B：不写 `minimum` / `maximum`。
 * `dsh-tools` 的 JSON Schema 子集只认 type/oneOf/properties/required/
 * additionalProperties/items/enum/const + 注解（`assertSupportedJsonSchema`），
 * `minimum` 会被判成 "is not a supported keyword"。默认执行器当前不校验
 * `parameters` 所以带着也能跑，但切到 PTC executor 那一刻就会被拒。
 * 范围本来就由 `board.mjs` 的 `toSafeInt` 夹紧，删掉不丢任何保证。
 */
const PARAMETERS = {
  type: 'object',
  properties: {
    maxLines: {
      type: 'integer',
      description: '最多显示多少条任务（夹紧到 1–200）',
    },
    includeCompleted: {
      type: 'integer',
      description: '额外显示多少条已完成，默认 0（已完成的会淹掉在跑的；夹紧到 0–200）',
    },
    maxSubjectLength: {
      type: 'integer',
      description: '标题列最多几个字符（夹紧到 3–400）',
    },
  },
  additionalProperties: false,
};

/** 工具返回值形状（`render` 与执行器都用它校验）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    board: { type: 'string' },
    me: { type: 'string' },
    taskCount: { type: 'integer' },
    memberCount: { type: 'integer' },
    /* 第 14 轮：结构化任务行。形状就是 `projectPayloadTask()` 那一份
     * （id / kind? / status / subject / owner / mine / scopes / blockedBy / warnings），
     * `plugin/client.js:562` 的 `boardRows()` 在等它。
     *
     * **不在 `required` 里**，这是有意的：宿主读不出任务（`listTasks` 给了非数组）
     * 或走委派花名册那条路（那就没有 Team 任务板）时**不带这个键** ——
     * 页面据此说「没有结构化数据」，而 `tasks: []` 会被读成「读到了，就是零条」。
     * 两种状态必须可区分（本项目红线）。
     *
     * `items` 只写 `{ type: 'object' }`：逐字段展开在这里没有收益（执行器不校验，
     * `client.js` 自己逐字段按 typeof 判），而写窄了会在将来加字段时把真数据拒掉。 */
    tasks: {
      type: 'array',
      description:
        '可选。结构化任务行（页面任务板用）。宿主读不出来时**不带这个键**，'
        + '与 `[]`（读到了、确实是零条）可区分。',
      items: { type: 'object' },
    },
  },
  required: ['board', 'me', 'taskCount', 'memberCount'],
};

/**
 * 取 Agent Teams 服务，取不到返回 `undefined`（永不抛）。
 *
 * 委托 `resolveService`（第 12 轮收口）：服务的取用口径**只有一处**，
 * 否则"get 会不会抛"这件事会被两段代码各自漏一次。
 */
function resolveTeams(ctx) {
  return resolveService(ctx, 'agentTeams');
}

/**
 * 造一个 `when(context)`：这一步这个工具该不该出现。
 *
 * - 宿主有 Agent Teams：**只有 Team 成员看得见**（`tryMembership` 不抛，非成员得到 undefined）。
 * - 宿主没有 Agent Teams：仍然注册，调用时报 `E_HOST_UNSUPPORTED`（见文件头注释）。
 *
 * 服务是**每次求值时**才解析的，不是在 apply 里抓一次：
 * 本插件没有 `inject: ['agentTeams']`，所以不保证 Agent Teams 先于本插件挂载；
 * 抓一次会把"晚到的服务"永久判成"没有"。
 *
 * **`when` 抛错 = 整个模型步失败（F6，实测确认）**：
 * `dsh-tools/lib/index.js:552-555` 把 `when` 的异常转成 `ToolActivationError`，
 * 而那个错误**中止步骤准备**——不是"把这个工具藏起来"。
 * 于是 `agentTeams` 只要处于「已登记但未就绪」（`tryMembership` 一调用就抛），
 * **每一个模型步**都会以 `TOOL_ACTIVATION_FAILED` 失败。
 * 所以这里 fail-closed 到"隐藏"：拿不准就当没这个工具，绝不把一次查询失败升级成整步失败。
 */
function whenToolIsVisible(ctx) {
  return (context) => {
    try {
      const teams = resolveTeams(ctx);
      if (teams === undefined) return true;
      return context !== undefined && context !== null && teams.tryMembership(context.agent) !== undefined;
    } catch (error) {
      warnOptional(ctx, 'agentTeams', error);
      return false; // fail-closed：宁可这一步看不见板，也不许这一步直接失败
    }
  };
}

/**
 * 从参数里**逐键**取一个整数，取不到返回 undefined。
 *
 * - 只认 number；字符串一律当没给（schema 说的是 integer，宽容解析会让
 *   `"3abc"` 之类的东西变成另一个语义，而这里没有收益）。
 * - 不做范围夹紧：夹紧是 `board.mjs` 的 `toSafeInt` 已经做好的事，不写第二遍。
 */
function readInteger(args, key) {
  if (args === null || typeof args !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(args, key)) return undefined;
  const raw = args[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return raw;
}

/**
 * 组装 `renderBoard` 的渲染参数。
 *
 * `includeCompleted` 在这里**显式写 0**。`board.mjs` 的模块默认值现在也是 0
 * （第 12 轮由 6 改成 0），所以这不是覆盖模块行为，而是**同一口径的重申**：
 * 把"工具契约（参数说明）对模型承诺默认 0"钉在本文件里，模块默认值以后若再变，承诺也不跟着漂。
 * 为什么 0：已完成的会淹掉在跑的。
 */
function renderOptions(args) {
  const options = { includeCompleted: 0 };
  const maxLines = readInteger(args, 'maxLines');
  if (maxLines !== undefined) options.maxLines = maxLines;
  const includeCompleted = readInteger(args, 'includeCompleted');
  if (includeCompleted !== undefined) options.includeCompleted = includeCompleted;
  const maxSubjectLength = readInteger(args, 'maxSubjectLength');
  if (maxSubjectLength !== undefined) options.maxSubjectLength = maxSubjectLength;
  return options;
}

/**
 * `ContentBlock[]` 渲染。形状取自 `@deepseek-ai/dsh-llm` 的
 * `TextBlock { type: 'text'; text: string }`（`ContentBlock = ContentBlockMap[ContentBlockType]`）。
 *
 * `render` 会在**回放**里被调用（历史参数可能是旧版本），所以它绝不抛：
 * 拿不到板就给一行降级文案，而不是让会话渲染崩在别人脸上。
 */
function renderBoardBlocks(_args, value) {
  const text =
    value !== null && typeof value === 'object' && typeof value.board === 'string' && value.board !== ''
      ? value.board
      : '团队板（本回合没有可渲染的内容）';
  return [{ type: 'text', text }];
}

/**
 * 注册 `team_board`。
 *
 * @param ctx 宿主上下文
 * @param _config patch 行的 `config`（本插件无配置项）
 * @returns effect 的 disposer：调用它会注销工具
 */
/* ═══════════════════════════════════════════════════════════════════════════
 * 第 9 轮（W8）：开关状态 + 页面数据通道 + 角色台账读写
 *
 * 这一段的职责边界，和 W7 一样窄：
 *   - 「开关」只决定 `team_board` 对模型可不可见（`when`），不碰别的工具、
 *     不碰 profile 的 `cordis.patch.yml`、不做卸载；
 *   - 「页面数据」只把**宿主已有的事实**整理成一个 JSON 信封，判定仍归 src/ 六个模块；
 *   - 「台账」只读 / 只写 storage 里的一份文档，不自己算成功率（`roleStats` 算）。
 *
 * 为什么不用 `@Remote`：`@deepseek-ai/dsh-api-remotes` 的能力集在构建期固定
 * （它的 README 写明 "The capability set is fixed by explicit build-time value imports"），
 * 纯 JS 第三方插件无法追加 Remote 命名空间。所以走 `dsh-context` 的同一条骨架：
 * `ctx.connection.fetch.register({ path, methods:['POST'], requestBody:'buffered', fetch })`，
 * 浏览器侧 `fetch('/api/team-board/state', { method:'POST' })`。
 * 信封形状与它一致：成功 `{ ok:true, value }`，失败 `{ ok:false, error:{ code, message } }`。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 页面数据路由（唯一一条）。 */
const STATE_PATH = '/api/team-board/state';

/**
 * 拍板路由。
 *
 * 为什么它必须是**第二条路由**而不是复用 `state`：
 * `state` 是一条读路由（顺带写开关），它没有"这次请求是谁发的"这个概念；
 * 而拍板是一次**有权限的写**（Req5：仅本人可写 status=已拍板，管理员/机器人/代理
 * 一律 403），把它塞进读路由等于让"读快照"和"改决议"共用同一个判据 ——
 * 那条判据迟早会为了读的部分放宽，然后写这边一声不响地跟着放宽。
 *
 * 信封形状与 `state` 一致：成功 `{ ok:true, value }`，失败 `{ ok:false, error:{code,message} }`。
 * **HTTP 状态码是事实的一部分**：403 必须真是 403（Req5 断言的是接口层，不是界面层）。
 */
const DECIDE_PATH = '/api/team-board/decide';

/** 存储里待拍板行的键前缀（与 `enabled` 同表，不新开表，避免版本迁移）。 */
const DECISION_KEY_PREFIX = 'decision:';

/** 回写超时：5s。超时算失败并留痕，不无线等。 */
const WRITEBACK_TIMEOUT_MS = 5000;

/**
 * 调用者身份种类（Req5 的枚举）。
 *
 * **这里是本实现最诚实的一处妥协**：`fetch.register` 的 `request` 只带
 * 一个标准 `Request`（`dsh-client-connection` 用 `new Request(url, { headers })` 构造），
 * 而那道浏览器信任栅栏的注释写得很清楚 —— "this fence never establishes identity"。
 * 也就是说传输层**不提供**调用者身份，`kind` 只能由调用方在 body 里声明。
 *
 * 所以权限被拆成两半，各说各的实话：
 *   - **`kind` 是声明**（客户端说"我是机器人/管理员/代理"），宿主据此拒；
 *   - **"本人"是宿主真相**（`teams.membership(agent).name`），`samePerson` 比对，
 *     客户端伪造不了这一半。
 * 恶意客户端当然可以自称 `kind: 'user'` —— 那时它能拿到的也只有"以本人身份拍自己的板"，
 * 而不是"替别人拍板"。这条边界写在这里，不藏在注释外。
 */
const ACTOR_KINDS = Object.freeze(['user', 'admin', 'bot', 'proxy']);

/** storage 单位描述：一张 `state` 表（开关）+ 一张 `ledger` 表（角色台账）。 */
const STORAGE_UNIT = { name: 'team-board', version: 1, tables: ['state', 'ledger'], hasGlobal: false };

/**
 * 取任意可选服务，取不到返回 `undefined`（**永不抛**）。
 *
 * 第 12 轮事故教训：`ctx.get(name)` 本身可能抛 —— cordis 在服务「已登记但未就绪」
 * 或代理拒绝访问时会直接抛（`probe` profile 就是这么死的）。
 * 所以 **`get` 也必须在 try 里**，不能假定"可选依赖的读取是安全的"。
 * 三个来源逐层降级：`ctx.get` → 属性访问 → `undefined`。
 */
function resolveService(ctx, key) {
  if (ctx === null || typeof ctx !== 'object') return undefined;
  if (typeof ctx.get === 'function') {
    try {
      const viaGet = ctx.get(key);
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    } catch {
      /* 服务未就绪：当成"没有"，继续往下兜底。 */
    }
  }
  try {
    return ctx[key] ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取这个会话的 Agent。取不到就是 `undefined` —— **永不抛、永不回落**。
 *
 * 为什么单独提出来：`gates()`（页面门禁）与 `identity()`（拍板鉴权）必须**同一套取法**。
 * 两处各写一遍的话，迟早出现"页面认为这个会话有 Agent、拍板接口认为没有"这种
 * 谁也解释不清的局面；而这正是第 12 轮 `agents.roots()[0]` 回落那次事故的形状 ——
 * 那次是"拿别人的数据冒充自己的"，这次会是"两处身份来源不一致"。
 */
function resolveAgent(ctx, sessionId) {
  const agents = resolveService(ctx, 'agents');
  if (agents === undefined || typeof agents.get !== 'function') return undefined;
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  try {
    return agents.get(sessionId);
  } catch {
    return undefined;
  }
}

/**
 * 可选能力缺失/抛错时留一条诊断。
 *
 * 为什么值得写：`probe` profile 那次故障**一个字都没留下**，只能靠一行
 * "did not activate" 反推。可选依赖降级是正常行为，但**降级的理由不该是隐形的**。
 * 日志本身也不许抛（logger 可能没有）。
 */
function warnOptional(ctx, what, error) {
  const text = `team-board: ${what} 不可用，已降级（${error instanceof Error ? error.message : String(error)}）`;
  try {
    ctx?.logger?.warn?.(text);
  } catch {
    /* 连日志都写不了：放弃，但绝不因此让 apply 失败。 */
  }
}

/**
 * 数据源判定：页面顶栏必须显式说出这块数据是从哪来的。
 *
 * 三态，缺一不可（上一轮的教训：一块板不说来源，就没人能判断它是真数据还是降级产物）：
 *   'agentTeams'  → 宿主有 Agent Teams 任务板
 *   'roster'      → 只有 subagents（委派花名册）
 *   'unavailable' → 两者都没有（**必须与"空板"可区分**）
 *
 * @param {object} ctx 宿主上下文
 * @returns {'agentTeams'|'roster'|'unavailable'}
 */
export function dataSourceOf(ctx) {
  if (resolveService(ctx, 'agentTeams') !== undefined) return 'agentTeams';
  if (resolveService(ctx, 'subagents') !== undefined) return 'roster';
  return 'unavailable';
}

/**
 * 打开 storage 的 kv 形态。取不到返回 `Promise<null>`（不是 reject，也**永不抛**）。
 *
 * 契约（`cordis_inspect_query` host/Service/storage）只有 `backend` / `mount` / `form`，
 * 而 `StorageForms` 投影为空 —— 所以这里**逐层试探**，任何一层不成立就当"没有持久化"，
 * 只把开关留在内存里：配置坏了不该让插件起不来。
 *
 * 第 12 轮事故：整段（含第一行取服务）必须在 try 里。`probe` profile 里
 * `ctx.get('storage')` 直接抛，而它当时在 try 之外 —— 那就是 entry 不激活的入口。
 */
function openKvUnit(ctx) {
  try {
    const storage = resolveService(ctx, 'storage');
    if (storage === null || storage === undefined || typeof storage !== 'object') return Promise.resolve(null);
    if (typeof storage.form !== 'function') return Promise.resolve(null);
    const kv = storage.form('kv');
    if (kv === null || kv === undefined || typeof kv.open !== 'function') return Promise.resolve(null);
    return Promise.resolve(kv.open(STORAGE_UNIT)).catch(() => null);
  } catch (error) {
    warnOptional(ctx, 'storage', error);
    return Promise.resolve(null);
  }
}

/**
 * 造一份开关 / 台账状态机。
 *
 * 设计要点（都是为了可测试 + 可预期）：
 *   - `enabled()` **同步**返回当前值：`when` 每一步求值，测试也要能同步断言；
 *   - `hydrate()` 异步把持久化值读回来，失败保持默认 `true` 且**不抛**；
 *   - `setEnabled()` **先改内存再落盘**：切换立刻生效（下一步就看不见工具），
 *     落盘失败也不回滚 —— 回滚会让"我点了关闭但它还在"这种事发生；
 *   - `stats().persistCalls` 让测试能断言"持久化恰好被调用一次"。
 *
 * @param {object} ctx 宿主上下文
 */
export function createBoardState(ctx) {
  /**
   * 开关的默认值：**关**（第 16 轮 task-19，用户直接要求）。
   *
   * 为什么默认必须是关 —— 这条理由比"保守一点比较好"具体得多：
   *
   * 用户对这个开关的定义是「**我不让你用这个，它就不会去用**」。如果默认是开，
   * 这句话就变成了空话：**"我没主动让它用"和"它已经在用"同时成立**，
   * 那个开关也就没表达任何东西。默认开等于"用户从没同意，插件已经在生效"。
   *
   * 而这个插件不是零成本的存在：它往模型提示里加两个工具，并且影响模型**每一步**的行为。
   * **一个默认就生效的插件，等于没经用户同意就占据了他的工具面。**
   *
   * 与 `hydrate()` 的关系（改这个默认值时别把它弄反）：
   *   - 存储里**有**记录 → **按记录**（用户主动开过，就该是开；默认值不许覆盖它）；
   *   - 存储里**没有**记录 → 保持默认 = **关**（这才是"未经开启不生效"）；
   *   - 读失败 / 存储还没就绪 → 同样保持默认 = **关**（fail-closed：拿不准就当没开）。
   *
   * 换句话说：**默认值只在"用户没表态"时才说话，而用户表过态就以用户为准。**
   */
  let enabled = false;
  let persistCalls = 0;
  let persistFailures = 0;
  let unitPromise;
  let hydrated = false;
  /** 用户在本进程里手动改过开关：此后磁盘只写不读（见 `hydrate` 的第 3 条修正）。 */
  let dirty = false;

  function unit() {
    if (unitPromise === undefined) {
      /* 第 12 轮 D-4：**不许缓存失败**。
       * 原来这里 `unitPromise = openKvUnit(ctx)` 把 promise 本身存下来，而 `openKvUnit`
       * 打不开时 resolve `null`（永不 reject）—— 于是启动那一刻存储没就绪，
       * 这个进程就**永远**没有存储，哪怕一毫秒后它就好了。
       * 这正是"用户关掉开关，重启后自己变回开"的根：关的动作被静默丢进了一个失败的缓存里。 */
      unitPromise = openKvUnit(ctx).then(
        (kv) => {
          if (kv === null || kv === undefined) {
            unitPromise = undefined; // 这一秒没存储 ≠ 以后没有：下次重新取
            return null;
          }
          return kv;
        },
        (error) => {
          unitPromise = undefined; // 抛错同样不缓存
          throw error;
        },
      );
    }
    return unitPromise;
  }

  /**
   * 开关自己的状态。**关掉时只报 `enabled`，不报 `dataSource`。**
   *
   * 为什么这里也要短路：`dataSourceOf(ctx)` 里两次 `resolveService` **就是 `ctx.get`**。
   * 关掉之后还去探两次宿主，就破了"关掉＝完全不参与（不读）" —— 而这一处最容易被
   * 当成"开关自报状态、不算读取"放过，因为它长得像控制面。
   *
   * 返回 `{enabled:false}` 而不是 `{enabled:false, dataSource:{kind:'unavailable'}}`：
   * 后者会把"你关了"报成"它坏了"。**省略这个字段是刻意的**，消费方必须自己认
   * `Object.hasOwn(·,'dataSource') === false` 这种情况（`client.js` 的 `sourceDetail`
   * 有一条 disabled 分支接它）。
   */
  function getState() {
    if (enabled === false) return { enabled: false };
    return { enabled, dataSource: dataSourceOf(ctx) };
  }

  function stats() {
    return { persistCalls, persistFailures, hydrated };
  }

  /**
   * 读回持久化的开关。任何异常都吞掉：默认值就是"开"。
   *
   * 第 12 轮 D-4 三条修正（原实现让"关掉开关"在一次冷启动里凭空消失）：
   *   1. `hydrated = true` **挪到最后**：原来它写在 `await unit()` 之前，
   *      等于"读了但没读到"也算读过了 —— 那次失败之后永远不再读；
   *   2. 拿不到存储单元（`null`）**不算读过**：存储可能只是晚一步就绪；
   *   3. 用户手动改过（`dirty`）以后**不再用磁盘覆盖内存**：
   *      否则一次迟到的 hydrate 会把用户刚点的关闭翻回旧值。
   */
  async function hydrate() {
    if (hydrated || dirty) return enabled;
    let kv;
    try {
      kv = await unit();
    } catch {
      return enabled; // 取存储就炸了：保持默认开，下次再试（不标记已读）
    }
    if (kv === null || typeof kv.loadAll !== 'function') return enabled; // 存储还没就绪：下次再试
    let loaded;
    try {
      loaded = await kv.loadAll();
    } catch {
      return enabled; // 读失败：下次再试
    }
    const table = loaded === null || typeof loaded !== 'object' ? undefined : loaded.tables?.state;
    const record = table === null || typeof table !== 'object' ? undefined : table.enabled;
    if (record !== null && typeof record === 'object' && typeof record.enabled === 'boolean') {
      /* 迟到的读回不许覆盖用户的决定：读盘期间用户可能刚点了关闭。 */
      if (!dirty) enabled = record.enabled;
    }
    /* 只有"真的读到了一份能用的表"才收工。表里没有记录也是读成功（= 默认开）。 */
    hydrated = true;
    return enabled;
  }

  /** 落盘。失败只记账，不抛、不回滚。 */
  async function persist() {
    persistCalls += 1;
    let kv;
    try {
      kv = await unit();
    } catch {
      persistFailures += 1;
      return false;
    }
    if (kv === null || typeof kv.putRecord !== 'function') {
      /* D-4：**拿不到存储单元也是失败**，必须计数。原来这里直接 `return false`，
       * 于是"没保存成功"和"保存成功"在 `stats()` 上一模一样 —— 用户关掉的开关
       * 就这样消失在一次安静的 return 里（重启后自己变回开）。 */
      persistFailures += 1;
      return false;
    }
    try {
      await kv.putRecord('state', 'enabled', { enabled });
      return true;
    } catch {
      persistFailures += 1;
      return false;
    }
  }

  async function setEnabled(next) {
    enabled = next === true;
    dirty = true; // 用户的决定优先于磁盘上的旧值（D-4）
    await persist();
    return getState();
  }
  /**
   * 台账文档 → 每角色一行统计。
   *
   * 三态必须可区分（页面据此说真话）：
   *   'ok'          有记录
   *   'empty'       storage 能用，但一条记录都没有 → 页面写「无历史」，五个数字仍显示 0
   *   'unavailable' storage 打不开 / 读失败 → 页面写「不可用」
   */
  async function readLedger() {
    /* P3-14 防御性短路：关掉就不读存储。
     * 正常路径已经被 `snapshot()` 的早退挡住，这里再挡一次是因为**它是唯一一处
     * 为"角色统计"去读 storage 的地方** —— 将来若有人绕开 snapshot 直接调它
     * （比如新加一条路由），"关掉不读"不能靠调用方的自觉。
     * 返回的不是 `unavailable`：那是"打不开/读失败"，与"你关了"是两件事。 */
    if (enabled === false) return { status: 'disabled', reason: 'userDisabled', roles: [] };

    /* `unit()` 必须在 try 里：`openKvUnit` 已经无抛，但"取服务"这一层的意外
     * 不该让台账读取把调用方（页面路由）带崩。 */
    let kv;
    try {
      kv = await unit();
    } catch {
      return { status: 'unavailable', reason: 'storage', roles: [] };
    }
    if (kv === null || typeof kv.loadAll !== 'function') {
      return { status: 'unavailable', reason: 'storage', roles: [] };
    }
    let loaded;
    try {
      loaded = await kv.loadAll();
    } catch {
      return { status: 'unavailable', reason: 'read', roles: [] };
    }
    const table = loaded === null || typeof loaded !== 'object' ? undefined : loaded.tables?.ledger;
    const rows = table === null || typeof table !== 'object' ? [] : Object.values(table);
    const roles = [];
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const id = typeof row.id === 'string' && row.id !== '' ? row.id : undefined;
      if (id === undefined) continue;
      roles.push({
        id,
        // 五个数字由 roleStats 产出，这里不数第二遍。
        stats: roleStats(row.history),
        pitfalls: typeof row.pitfalls === 'string' ? row.pitfalls : '',
      });
    }
    roles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return roles.length === 0 ? { status: 'empty', roles: [] } : { status: 'ok', roles };
  }

  /** 写台账（供后续轮次/工具落账用；本轮页面只读）。 */
  async function writeLedger(roles) {
    let kv;
    try {
      kv = await unit();
    } catch {
      persistFailures += 1;
      return false;
    }
    if (kv === null || typeof kv.putRecord !== 'function') {
      persistFailures += 1; // D-4：口径与 persist 一致（拿不到存储单元 = 一次失败）
      return false;
    }
    const list = Array.isArray(roles) ? roles : [];
    try {
      for (const role of list) {
        if (role === null || typeof role !== 'object') continue;
        if (typeof role.id !== 'string' || role.id === '') continue;
        await kv.putRecord('ledger', `role:${role.id}`, {
          id: role.id,
          history: Array.isArray(role.history) ? role.history : [],
          pitfalls: typeof role.pitfalls === 'string' ? role.pitfalls : '',
        });
      }
      return true;
    } catch {
      persistFailures += 1;
      return false;
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
   * 待拍板：存储 / 身份 / 回写（第 ⑤ 轮 build）
   *
   * 三件事各一个函数，共同的纪律是**不猜**：
   *   读不到 → `unavailable`（不是"没有待办"）；
   *   身份   → 只来自 `teams.membership(agent).name`；
   *   回写   → 没有适配器就**如实失败**（不假装成功，也不回退决议）。
   *
   * 为什么行落在 `state` 表的 `decision:` 前缀下、而不是新开一张表：
   * `STORAGE_UNIT.tables` 是存储单元的**版本化描述**（`version: 1`），加一张表要动版本，
   * 而版本一变，老 profile 里已有的开关与台账就可能读不出来。键前缀不动版本，
   * 代价只是 `loadAll` 会把这几行一起端回来（已经在下面按前缀滤掉）。
   * ═════════════════════════════════════════════════════════════════════════ */

  /**
   * 读全部待拍板行。三态与台账同口径：
   *   'ok'          读到了，至少一行
   *   'empty'       存储能用，但一行都没有（**与"读不到"不是一件事**）
   *   'unavailable' 存储打不开 / 读失败
   */
  async function readDecisions() {
    let kv;
    try {
      kv = await unit();
    } catch {
      return { status: 'unavailable', reason: 'storage', rows: [] };
    }
    if (kv === null || typeof kv.loadAll !== 'function') {
      return { status: 'unavailable', reason: 'storage', rows: [] };
    }
    let loaded;
    try {
      loaded = await kv.loadAll();
    } catch {
      return { status: 'unavailable', reason: 'read', rows: [] };
    }
    const table = loaded === null || typeof loaded !== 'object' ? undefined : loaded.tables?.state;
    const rows = [];
    if (table !== null && typeof table === 'object') {
      for (const [key, row] of Object.entries(table)) {
        if (key.startsWith(DECISION_KEY_PREFIX) !== true) continue;
        if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
        if (typeof row.id !== 'string' || row.id === '') continue;
        rows.push(row);
      }
    }
    /* 按 id 排序：不是给读者看的顺序（页面会按 due_at 重排并冻结 seq），
     * 而是为了让**同一份存储每次返回同一个数组** —— 否则页面每次重拉都可能换序，
     * D3 的"算一次并冻结"就变成了"每次算一次"。 */
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows.length === 0 ? { status: 'empty', rows: [] } : { status: 'ok', rows };
  }

  /** 落一行。失败只记账、不抛：写不进去不该让一次请求变成 500 之外的第二次事故。 */
  async function writeDecision(row) {
    let kv;
    try {
      kv = await unit();
    } catch {
      persistFailures += 1;
      return false;
    }
    if (kv === null || typeof kv.putRecord !== 'function') {
      persistFailures += 1;
      return false;
    }
    try {
      await kv.putRecord('state', `${DECISION_KEY_PREFIX}${row.id}`, row);
      return true;
    } catch {
      persistFailures += 1;
      return false;
    }
  }

  /** 按 id 找一行。读不到返回 `undefined`（调用方据此回 404 / 409，而不是猜）。 */
  async function findDecision(id) {
    const all = await readDecisions();
    if (all.status === 'unavailable') return undefined;
    for (const row of all.rows) if (row.id === id) return row;
    return undefined;
  }

  /**
   * 宿主真相里的"我"。
   *
   * **故意没有回落**：`agents.get(sessionId)` 拿不到就只有 unavailable 这一条路
   * （与 `gates()` 第 12 轮那条修正是同一条纪律 —— 拿别人的数据冒充自己的，
   * 比"读不出来"危险得多）。身份读不出来时，拍板接口回 409，不是 403：
   * "我认不出你是谁"和"你不许"是两件事。
   */
  async function identity(sessionId) {
    const teams = resolveTeams(ctx);
    if (teams === undefined) return { status: 'unavailable', reason: 'agentTeams' };
    const agent = resolveAgent(ctx, sessionId);
    if (agent === undefined) return { status: 'unavailable', reason: 'agent' };
    try {
      const name = teams.membership(agent).name;
      if (typeof name !== 'string' || name === '') return { status: 'unavailable', reason: 'membership' };
      return { status: 'ok', name };
    } catch {
      return { status: 'unavailable', reason: 'membership' };
    }
  }

  /**
   * 把决议回写给来源系统（Req6）。
   *
   * 两条通道，按优先级：
   *   ① 宿主注入的 `teamBoardWriteback` 服务（`write(payload)`）—— 真适配器；
   *   ② 行上声明的 `source_ref`（一个 URL），POST 一份 JSON —— 降级通道。
   * 两条都没有 → `failed` + `no-writeback-adapter`。
   *
   * **失败绝不影响决议本身**：调用方先落"已拍板"，再调这里，失败只往行上补
   * `writeback_state: 'failed'`。于是"回写失败"的行仍然在、仍然显示已拍板、
   * 仍然可以重试 —— 这正是 Req6 的"不回退不消失"。
   */
  async function writeback(row) {
    const payload = {
      id: row.id,
      verdict: row.verdict,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      decisionValue: row.decision_value,
      sourceSystem: row.source_system,
    };
    const adapter = resolveService(ctx, 'teamBoardWriteback');
    if (adapter !== undefined && adapter !== null && typeof adapter.write === 'function') {
      try {
        const result = await adapter.write(payload);
        if (result === false) return { status: 'failed', message: 'adapter-rejected' };
        return { status: 'ok', message: '' };
      } catch (error) {
        return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
    }
    const target = typeof row.source_ref === 'string' ? row.source_ref.trim() : '';
    if (target === '' || typeof fetch !== 'function') {
      return { status: 'failed', message: 'no-writeback-adapter' };
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), WRITEBACK_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(controller === undefined ? {} : { signal: controller.signal }),
      });
      const status = response === null || response === undefined ? 0 : response.status;
      if (response === null || response === undefined || response.ok !== true) {
        return { status: 'failed', message: `http-${status}` };
      }
      return { status: 'ok', message: '' };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 页面用的待拍板投影。
   *
   * 两个来源，都**只认已声明的东西**：
   *   ① 存储里已存在的行（上一轮拍过 / 上游写进来的）；
   *   ② 任务对象上显式挂着的 `decision` 块（上游把待拍板随任务一起报上来）。
   * 绝不从 `subject` / `status` / `blockedBy` 反推一条待拍板 —— 那样"编出来的待办"
   * 会混进"请你现在决定"的位置，而读者无从分辨哪条是真的。
   *
   * `mine` 走宿主真相（`samePerson`），与板上 `@me` 同一个判据。
   */
  async function projectDecisions(tasks, me) {
    const stored = await readDecisions();
    if (stored.status === 'unavailable') {
      return { status: 'unavailable', reason: stored.reason, rows: [] };
    }
    const rows = [];
    const seen = new Set();
    for (const row of stored.rows) {
      rows.push({ ...row, mine: samePerson(row.owner, me) });
      seen.add(row.id);
    }
    if (Array.isArray(tasks)) {
      for (const task of tasks) {
        if (task === null || typeof task !== 'object') continue;
        const declared = task.decision;
        if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) continue;
        const id = typeof declared.id === 'string' && declared.id !== ''
          ? declared.id
          : typeof task.id === 'string' && task.id !== '' ? `task:${task.id}` : '';
        if (id === '' || seen.has(id)) continue;
        const owner = typeof declared.owner === 'string' && declared.owner !== ''
          ? declared.owner
          : typeof task.ownerName === 'string' ? task.ownerName : '';
        rows.push({
          ...declared,
          id,
          owner,
          mine: samePerson(owner, me),
          source_system: typeof declared.source_system === 'string' && declared.source_system !== ''
            ? declared.source_system
            : typeof task.kind === 'string' ? task.kind : '',
        });
        seen.add(id);
      }
    }
    return rows.length === 0 ? { status: 'empty', rows: [] } : { status: 'ok', rows };
  }

  /**
   * 委派花名册计数：**只用来数"几个在跑"**，不铺表格（花名册已经在「编队」标签里了）。
   * 宿主目录是唯一真相源，这里不记账。
   *
   * 第 10 轮：改成复用 `listDescendantsOf` 这一个访问口（口径只写一次）。
   *
   * 第 12 轮 D-3：**返回形状改成三态可分辨**。原来失败一律 `undefined`，
   * `snapshot` 拿到 `undefined` 就只写 `{ kind }`，而页面侧把"没有 total"读成 0
   * （`plugin/client.js:74`：`Number.isInteger(source.total) ? source.total : 0`）——
   * 于是"读不出来"在页面上长得和"真的 0 个"一模一样，
   * 正好违反 `plugin/client.js:56` 自己写的那条红线「空 ≠ 不可用」。
   *
   * 现在失败也带 `status`，页面（和任何下游）有判据：
   *   { status: 'ok', total, running }   ← 真的数出来了（total 允许是 0）
   *   { status: 'unavailable', reason }  ← 数不出来（'read' 读时抛 / 'service' 没有服务或 sessionId 非法）
   */
  async function roster(sessionId) {
    /* P3-14 防御性短路：关掉就不列子会话。
     * **必须在 `listDescendantsOf` 之前** —— 它第一件事就是 `ctx.get`，
     * 放在它之后就等于"读了一次再说不读"。 */
    if (enabled === false) return { status: 'disabled', reason: 'userDisabled' };

    let listed;
    try {
      listed = await listDescendantsOf(ctx, sessionId);
    } catch {
      return { status: 'unavailable', reason: 'read' };
    }
    if (listed === undefined) return { status: 'unavailable', reason: 'service' };
    const { entries } = listed;
    return {
      status: 'ok',
      total: entries.length,
      running: entries.filter((entry) => entry.activity === 'running').length,
    };
  }

  /**
   * 门禁结论：`canDeliver` 的 blockers / warnings 原样搬给页面，**不在这一层重排严重度**。
   *
   * 三种结果必须可区分：
   *   'ok'          → 有任务、判得动（ok/blockers/warnings 都在）
   *   'unavailable' → 没有 Agent Teams，或这个会话没有活着的 Agent（reason 说明是哪一种）
   */
  async function gates(sessionId) {
    /* P3-14 防御性短路：关掉就**不探宿主、不读任务板**。
     *
     * 位置要求在 `resolveTeams(ctx)`（也就是第一处 `ctx.get`）之前。
     * `gates()` 内部的读取顺序是：`resolveTeams` → `resolveAgent` → `listTasks`
     * → `listMembers` → `membership` —— 四个被 spy 的调用全在后面，
     * 所以短路只要在这条函数体第一句，调用次数必然是 0。
     *
     * 返回 `disabled` 而不是 `unavailable`：后者是"没有 Agent Teams / 没有活着的
     * Agent"，是**它坏了**；前者是**你关了**。混成一个，页面就会对着用户的决定
     * 说"数据源不可用"。
     * 这里**不挂 `ledger`**：会议账本在关掉时是**缺席**，不是 `unavailable`。 */
    if (enabled === false) return { status: 'disabled', reason: 'userDisabled' };

    const teams = resolveTeams(ctx);
    /* 三条 unavailable 出口都必须带 `ledger`（第四态）。理由见 `ledgerUnavailable`。 */
    if (teams === undefined) {
      return { status: 'unavailable', reason: 'agentTeams', ledger: ledgerUnavailable('agentTeams') };
    }
    const agent = resolveAgent(ctx, sessionId);
    /* 第 12 轮 D-2：这里**原来有一段 `agents.roots()[0]` 回落**——`agents.get(sessionId)`
     * 拿不到就随便挑一个根 Agent 顶上。实测后果：门禁显示 `ok`，而板里是**别的会话**的
     * 任务，且没有任何来源标记。拿别人的数据冒充自己的，比"读不出来"危险得多。
     *
     * 所以现在**故意没有回落**：这个会话的 Agent 找不到，就只有 unavailable 这一条路，
     * 由页面如实说「这个会话没有活着的 Agent」。要恢复回落必须同时给出可见的来源标记，
     * 否则不许加回来。 */
    if (agent === undefined) {
      return { status: 'unavailable', reason: 'agent', ledger: ledgerUnavailable('agent') };
    }

    try {
      /* D-14：**页面门禁与工具走同一条映射**。原来这里直接把裸 `TeamTaskView` 塞给
       * `canDeliver` —— 那些任务没有 kind（判不动）、也没有 assignee（`ownerName` 没映射，
       * 独立性判定退化成 legacy 模式）。两个后果都不会响：一个 fail-open、一个静默降级。
       * 所以声明解析与 `ownerName → assignee` 必须在**取数的这一层**就发生，只修一个入口
       * 等于页面和工具在讲两个不同的故事。 */
      const tasks = mapHostTaskList(teams.listTasks(agent));
      const members = teams.listMembers(agent);
      const pendingPhase = readTeamPhase(teams, agent);
      /* D-1：页面门禁同样只能给"不知道"。它以前也直接把 `{ team, tasks }` 塞进去，
       * 于是页面上会挂着三条假 blocker（见 AUDIT_* 那段注释）。
       * 这里用 `NO_AUDIT`（两项都缺），结论里会自曝 `E_AUDIT_UNWIRED`。 */
      const verdict = applyAuditWiring(canDeliver({ team: pendingPhase === undefined ? {} : { phase: pendingPhase }, tasks }), NO_AUDIT);
      const payload = {
        status: 'ok',
        ok: verdict.ok,
        blockers: verdict.blockers,
        warnings: verdict.warnings,
        /** 审计是否真的接线（页面可以据此说明"这些结论的底数有多少"）。 */
        auditWired: verdict.wired,
        phaseKnown: pendingPhase !== undefined,
      };
      /* 身份**只**来自宿主，且**先取出来**（第 14 轮）：`board` 与 `tasks` 必须用
       * 同一个 `me` —— 否则"板上这一行是 @me、payload 里 mine:false"就会同时成立。
       * 取值位置没变实质：`membership` 原来也是在 `renderBoard(...)` 的实参里求值，
       * 同样发生在 `listTasks` / `listMembers` 之后；只是多留了个名字。
       * membership 会为冒充者抛错，这正是我们要的（外层 try 接住 → unavailable/error）。 */
      const me = teams.membership(agent).name;
      try {
        payload.board = renderBoard({
          tasks,
          members,
          me,
          includeCompleted: 0,
        });
      } catch {
        // 板渲染失败不影响门禁结论：它是可选块（第 ④ 块优先于它）。
      }
      /* 第 14 轮：**页面**这条路径的结构化任务板。
       *
       * 与 `payload.board` 吃的是**同一个 `tasks` 变量、同一个 `me`、同一次
       * `teams.listTasks(agent)`** —— 绝不为了某个字段好看而二次读宿主：
       * 那会造出"表里 5 条、文本板里 4 条"这种两份数据互相打脸的局面。
       *
       * 之前这一段不存在，于是页面永远显示「宿主没有提供结构化任务数据」，
       * 而 `client.js` 里那套结构化表格（有测试、有实现）一次都跑不到。
       *
       * 读不出来（`tasks` 不是数组）时不挂这个键，见 `projectPayloadTasks` 的理由。 */
      const payloadTasks = projectPayloadTasks(tasks, me);
      if (payloadTasks !== undefined) payload.tasks = payloadTasks;
      /* ③ 待拍板（第 ⑤ 轮 build）。与 `payload.tasks` 吃**同一次取数、同一个 `me`**。
       *
       * 三条形状纪律：
       *   - 读不到 → `{ status:'unavailable', reason }`（页面写「读不到」，绝不写「没有待办」）；
       *   - 真的一条都没有 → `{ status:'empty', rows:[] }`（**这是"零条"，不是"读不到"**）；
       *   - 有 → `{ status:'ok', rows:[...] }`，每行带 `mine`（宿主真相算的）。
       * 抛错也只降级这一块，不许把整页门禁带成 unavailable —— 拍板读不出来
       * 不代表"能不能交付"这个结论也读不出来。 */
      try {
        payload.decisions = await projectDecisions(tasks, me);
      } catch (error) {
        payload.decisions = {
          status: 'unavailable',
          reason: 'error',
          message: error instanceof Error ? error.message : String(error),
          rows: [],
        };
      }
      /* P0（第 15 轮）：`gates.mjs` 的 shadow 结论。
       *
       * 位置固定在 ⑤ 之后、`return` 之前，且**不 try**：`shadowCompletion`
       * 自己是逐条 try/catch 的、结构上不会抛（非数组入参也返回 unavailable）。
       * 在这里再包一层 try 等于承认它会抛，那读代码的人就会以为 `status:'unavailable'`
       * 有两个来源、分不清是"没任务"还是"炸了"。只有一个来源，才不会有人猜。
       *
       * 它放在 payload 上而不是塞进 blockers：**shadow 的码一个字都不许进 blockers**。
       * 一旦混进去，页面上的"能不能交付"就被一个从没验收过的判据改写了。 */
      payload.shadow = shadowCompletion(tasks);
      /* P3-9：重名已经消掉了，这里留一段"为什么曾经要警告"的记录。
       *
       * 曾经两样完全不同的东西都叫 `ledger`，只差一层路径：
       *   - 顶层 `payload.ledger`（`snapshot()` 里 `await readLedger()`）=
       *     插件的**角色台账**（每角色一行统计，落 `storage` 的 `ledger` 表）；
       *   - 这里的 `payload.gates.ledger` = **会议账本**，从任务树的
       *     `team-board-meeting` 围栏块投影出来。
       *
       * 顶层那个已改名为 **`roleLedger`** —— 改名的理由不是"避重名"这么笼统，
       * 而是原来那个名字在**撒谎**：它读的是角色统计，而 `state`/`enabled`/`paused`
       * 那些开关状态在 `payload.enabled` 里，根本不在它身上。叫 `stateLedger` 会把
       * "角色台账"说成"状态账本"，下一个人照样会找错地方。
       *
       * 会议账本这一侧**没有改名**：`gates.ledger` 已经被四态、`readable`、页面渲染
       * 和 `task-19` 的清单同时引用，改它代价远大于改顶层。 */

      /* P2-3：会议账本（任务树里的 `team-board-meeting` 围栏块）。
       *
       * 这一块**单独 try**，与上面 shadow 那段"故意不包 try"不矛盾：`shadowCompletion`
       * 的契约是"结构上不抛"，而这里认了"可能抛"，于是把降级写成
       * `state:'unreadable' + reason:'threw'`。账本读不出来只降级这一块 ——
       * **不许**把整页门禁带成 unavailable，那正是本项目反复在治的病：
       * 局部读不出来被放大成整体不可用。 */
      try {
        payload.ledger = ledgerPayload(tasks);
        /* P3-12：在**既有槽**上补进度计划。
         *
         * 为什么不像原来那样再赋一次值：`P3-7 ③` 的护栏要求
         * **每一个产出点的右侧都一眼看得出是哪个构造点**，且"手写对象字面量"必须 0 处。
         * `payload.ledger = await withStagePlan(...)` 会让右侧第一个 token 不再是构造点名，
         * 于是被记成 `<literal>` —— **护栏是对的**，它拦的正是"产出点变得认不出来"。
         * 所以这里不产生第二个产出点：槽仍由 `ledgerPayload` 造，只是**就地**多挂一个键。 */
        await attachStagePlan(payload.ledger);
      } catch (error) {
        /* 门禁是好的（tasks 已经取到手），只是这一块的投影抛了 —— 那是 `'unreadable'`
         * 而不是 `'unavailable'`：成因不同，处置也不同（一个去修块，一个去修宿主）。 */
        payload.ledger = ledgerSlot({
          state: 'unreadable',
          reason: 'threw',
          message: error instanceof Error ? error.message : String(error),
          meetingTasks: null,
        });
      }
      return payload;
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
        ledger: ledgerUnavailable('error'),
      };
    }
  }

  /**
   * 给会议账本的 `ok` 槽补一个**进度计划**（`stagePlan`）。
   *
   * ## 为什么要这个字段
   * `ledgerFromTasks` 的 `stages` 只包含**已经写进块**的阶段 —— 页面因此看得出
   * "已经到哪"，看不出"还差几关"。而"还差哪几个"这件事**不能从已写入的阶段推**：
   * 推出来的剩余在预设升版时会错得很自然（看着完全合理，实际错位）。
   * 所以来源只有一个：**预设自己**（`preset.stages[]`）。
   *
   * ## 缺席，而不是 `0/0`
   * 三种情况都让这个字段**彻底不出现**（`Object.hasOwn === false`）：
   *   1. 不是 `ok` 态（`none`/`unreadable`/`unavailable` 连阶段表都没有）；
   *   2. 预设读不出来（读不到 ≠ 零个阶段）；
   *   3. **账本里有预设外的阶段**（详见下）。
   * `null` 是"没数过"、`0` 是"数过、是空的" —— 这是同一条红线。
   *
   * ## 升版错位这件事：不另写判据
   * `preset` 会升版，一场会可能在 `standard@1` 下跑过 `redteam`、而当前预设里没有它。
   * 这时用 `presetStages - doneStages` 硬算，会得出一个看着合理、实际错位的"还差"，
   * 甚至负数。
   *
   * **这条判断已经有人做了**：`meeting.mjs` 的 `meetingState` 会算出 `strayStages`
   * 并推一条 `E_LEDGER_STRAY_STAGE`。所以这里**不重算集合差**，只问它要结论 ——
   * 见到那条码就不给 `stagePlan`。造第二份判断的代价是两份里总有一份先漂移，
   * 而没人知道是哪一份。
   *
   * @param {object} slot `ledgerPayload(...)` 的产物
   * @returns {Promise<object>} 原槽（可能已带上 `stagePlan`）
   */
  async function attachStagePlan(slot) {
    if (slot === null || typeof slot !== 'object' || slot.state !== 'ok') return;

    const meeting = slot.meeting;
    const qualified = meeting !== null && typeof meeting === 'object' ? meeting.preset : undefined;
    if (typeof qualified !== 'string' || qualified === '') return;

    const body = await readPresetBody(qualified);
    if (body === null) return;

    const loaded = loadPreset({
      registry: await readPresetRegistry(),
      qualified,
      bodies: { [qualified]: body },
    });
    if (loaded.ok !== true || loaded.preset === null || typeof loaded.preset !== 'object') return;

    /* 把"账本阶段与预设对不上"这件事交给既有判据（`E_LEDGER_STRAY_STAGE`）。 */
    const state = meetingState({ meeting, preset: loaded.preset });
    const stray = (Array.isArray(state.warnings) ? state.warnings : [])
      .some((warning) => warning !== null && typeof warning === 'object' && warning.code === 'E_LEDGER_STRAY_STAGE');
    if (stray) return;

    const presetStageIds = loaded.preset.stages
      .filter((stage) => stage !== null && typeof stage === 'object' && typeof stage.id === 'string')
      .map((stage) => stage.id);
    if (presetStageIds.length === 0) return;

    const rows = Array.isArray(meeting.stages) ? meeting.stages : [];
    const done = new Set(
      rows
        .filter((row) => row !== null && typeof row === 'object' && row.status === 'done' && typeof row.stageId === 'string')
        .map((row) => row.stageId),
    );

    const remaining = presetStageIds.filter((id) => !done.has(id));
    /* **就地**挂上去，不另造一个槽对象：槽的来源始终是 `ledgerPayload`。
     * 另造一个 `{...slot, stagePlan}` 会让"这个账本是谁造的"多出一个答案。 */
    slot.stagePlan = {
      preset: qualified,
      stages: presetStageIds,
      total: presetStageIds.length,
      done: presetStageIds.length - remaining.length,
      remaining,
    };
  }

  /** 团队阶段：宿主若有专门读取入口就用，没有就返回 undefined（页面标注"阶段未知"）。 */
  function readTeamPhase(teams, agent) {
    for (const method of ['teamView', 'team', 'describeTeam', 'phaseOf']) {
      if (typeof teams[method] !== 'function') continue;
      try {
        const value = teams[method](agent);
        const phase = value !== null && typeof value === 'object' ? value.phase : undefined;
        if (typeof phase === 'string' && phase !== '') return phase;
      } catch {
        // 这个入口不收这一套参数，试下一个。
      }
    }
    return undefined;
  }

  /**
   * 页面一次的完整快照。路由和 `when` 共用同一个状态机，切换后不需要重启。
   */
  async function snapshot(body) {
    /* 第 12 轮 D-4：页面读快照时补一次读回。
     * 为什么必须在这里补：启动那一刻存储常常还没就绪（`apply` 期间不许做 IO，
     * 读回是推迟到微任务里做的），那一次失败之后**没有人会再读第二次** ——
     * 于是磁盘上写着"关"，页面却一直显示"开"。
     * `hydrate` 自己管住三个条件（已读成功过 / 用户手动改过 / 存储还没有），
     * 所以这条既不会覆盖用户刚点的开关，也不会每个请求都打一次磁盘。 */
    await hydrate();
    // The review page reads only its switch; no team or ledger capability is involved.
    if (body !== null && typeof body === 'object' && body.settingsOnly === true) return { enabled };

    /* ═══════════════════════════════════════════════════════════════════════
     * P3-14：用户关掉了 ⇒ 这一页**什么派生数据都不给**。
     *
     * ## 为什么早退必须正好站在这里
     *
     * 不是"顺手放前面"。下面这段 body 里对 `dataSource` 有**两次**赋值、对 `gates`
     * 有一次**无条件**读取：
     *   - `dataSource: { kind }`（初值，其中 `dataSourceOf` 会 `ctx.get` 两次）；
     *   - `payload.dataSource = …`（`kind` 属于 roster/agentTeams 时**重新赋值**，
     *     它前面还有一次 `await roster(sessionId)`）；
     *   - `payload.gates = await gates(sessionId)` —— **无条件**，而 `gates()` 里就是
     *     `listTasks` / `listMembers` / `membership`。
     *
     * 所以把早退放在 `dataSource` 初值附近，`roster()` 和 `gates()` 都会照常跑：
     * spy 会数到调用，功能表现上却"什么都没变" —— 正是那种"看起来生效、实际读了一次"
     * 的失效形状。早退必须落在**第一条宿主调用之前**。
     *
     * ## `hydrate()` 为什么允许（这是唯一的例外）
     *
     * 它读的是 `state` 表里的 `enabled` 记录本身 —— 也就是**开关自己的状态**，
     * 不是派生数据。不禁用它，开关才可能被打开；禁用它，开关会把自己锁死在"关"上，
     * 而且外面永远看不到原因。**看到这里在读存储，不要"顺手补上"。**
     *
     * ## 形状：保留容器，四个派生键**缺席**
     *
     * `gates.status = 'disabled'` 留着，是为了让页面有一个**确定的东西**可说：
     * 连 `gates` 都缺席的话，"你关了"与"数据还没到"在页面上长得一模一样，
     * 空白又会看起来像正常。
     * `blockers` / `warnings` / `shadow` / `ledger` 一个都不挂 —— 是**缺席**，
     * 不是空数组：空数组会被读成"核过了，一条都没有"。
     *
     * `disabled` 是**开关**的第五态，不是会议账本的第五个态值：账本的四态
     * （`none|ok|unreadable|unavailable`）一个都不改，它在这里是**缺席**。两个轴不许混。
     * ═══════════════════════════════════════════════════════════════════════ */
    if (enabled === false) {
      return {
        enabled: false,
        gates: { status: 'disabled', reason: 'userDisabled' },
      };
    }

    const input = body !== null && typeof body === 'object' ? body : {};
    const sessionId = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : undefined;
    const kind = dataSourceOf(ctx);
    const payload = {
      enabled,
      dataSource: { kind },
      /* P3-9：**角色台账**（`{status, roles[]}`，落 `storage` 的 `ledger` 表）。
       *
       * 曾经叫 `ledger`，与 `gates.ledger`（会议账本）同名，只差一层路径 ——
       * 页面作者极易拿错，而拿错**不会报错**，只会对着角色统计断言"这场会还没开始"。
       * 现在两侧不同名；这里选 `roleLedger` 而不是 `stateLedger`/`switchLedger`：
       * 它装的是**每个角色的五个计数**，开关/暂停那些状态在 `payload.enabled` 上，
       * 根本不在它身上 —— 叫"状态账本"会让下一个人照样找错地方。 */
      roleLedger: await readLedger(),
      gates: { status: 'unavailable', reason: 'agentTeams' },
    };

    if (kind === 'roster' || kind === 'agentTeams') {
      const counted = await roster(sessionId);
      /* D-3：成功失败**都要带足字段**。成功给 total（可以是 0），失败给 status + reason；
       * 绝不再出现"既没有 total 也没有 status"的中间态 —— 那正是"读不出来看起来像 0 个"。 */
      payload.dataSource =
        counted.status === 'ok'
          ? { kind, status: 'ok', total: counted.total, running: counted.running }
          : { kind, status: 'unavailable', reason: counted.reason };
    }
    payload.gates = await gates(sessionId);
    return payload;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * P2-4：账本写路径 —— 全插件**唯一**一段往任务树写账本的 IO
   *
   * 三个硬约束，每一条都对应一个可证明的后果：
   *
   * 1. **差量写**。算差量的判据只有一份：`ledger.mjs` 的 `ledgerWritePlan`。
   *    一次阶段完成 = 1 次子任务 update + 0~1 次父任务 update。全量重放会让每次写都变成
   *    一次 revision bump，必和人正在手改的那张卡撞。
   *
   * 2. **revision 冲突 → 重读 + 重算，不拿旧 revision 硬写**。
   *    宿主的 `updateTask` 是 compare-and-set（`expectedRevision`，见 DSH 的
   *    `UpdateTeamTaskRequest`），stale 的写会被拒。这里**不靠匹配错误文案**判断冲突 ——
   *    那要靠猜它的错误码。判据是可观察的事实：抛了 → 重读最新任务树、重新算一次差量、
   *    再写一次；仍失败才算真的失败。
   *    重算而不是重试同一份计划：上一轮已经写成功的那几条必须从计划里消失。差量写天然
   *    自愈，全量重放会写第二遍。
   *
   * 3. **最终失败 → `E_LEDGER_WRITE_FAILED`，绝不重发这个阶段。**
   *    写失败的行**留在结果里**并显示为失败态，不许过滤掉：一屏"什么都没发生"
   *    会被读成"账本是干净的"。重发阶段会让同一阶段执行两次而账本只记第二次 ——
   *    那是无法从账本上复原的事故。
   *
   * 为什么不做"写失败就回滚"：回滚也是一次写，同样会撞 revision；而账本是 append-only
   * 的历史，把已经写成功的那半截擦掉，比留下一份可读的半截更坏。
   */

  /** 首写 + 一次"重读后重算"。再失败就不是冲突了，是真的写不进去。 */
  const MAX_LEDGER_WRITE_ATTEMPTS = 2;

  /* 「阶段 → 任务 id」这张表**只许走** `ledger.mjs` 的 `stageTaskIds(tasks)`。
   *
   * 这里曾经有一份本地实现 `mapStageToTaskId`，靠 `parseMeetingBlock().stages[].fields`
   * 是 `Map` 这个**内部表示**逐条取值。它当时不会静默降级（取不到就判 create 失败并写明
   * 原因），但形状抄了第二份 —— 那正是本项目最常栽的那类违规：内部表示一改，抄的人不会红，
   * 只会开始悄悄少几个 id。`ledger.mjs` 已经把这张表作为**契约**导出（文件头第 13 行），
   * 现在改用它。 */

  /** 从一串诊断里收出码集（保序去重）。没有码时交回 `[]`，由调用方决定兜底。 */
  const codesOf = (list) => {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const code = typeof item?.code === 'string' ? item.code : '';
      if (code !== '' && !out.includes(code)) out.push(code);
    }
    return out;
  };

  /**
   * 把目标账本写进任务树。**只写差量。**
   *
   * @param {string} sessionId 调用方会话（用来解析本会话活着的 Agent）
   * @param {object} nextLedger 目标账本（`meeting.mjs` 的形状）
   * @returns {Promise<{ok: boolean, attempted: boolean, attempts: number, reason: string|null,
   *            rows: Array<object>, errors: Array<object>, warnings: Array<object>,
   *            codes: string[], message?: string}>}
   */
  async function writeMeetingLedger(sessionId, nextLedger) {
    /** @type {Array<object>} */
    const rows = [];
    /** @type {Array<object>} */
    const errors = [];
    /** @type {Array<object>} */
    const warnings = [];
    let attempts = 0;
    let thrownMessage = null;

    const fail = (reason, extra = {}) => {
      const codes = codesOf(errors);
      return {
        ok: false,
        attempted: rows.length > 0,
        attempts: extra.attempts === undefined ? attempts : extra.attempts,
        reason,
        rows,
        errors,
        warnings,
        codes: codes.length > 0 ? codes : [E_LEDGER_WRITE_FAILED],
        ...(thrownMessage === null ? {} : { message: thrownMessage }),
      };
    };

    /** 每条目标只保留**最后一次尝试**的结论，其余历史行标"已被后续尝试覆盖"。
     *
     * 不这样做的话，"冲突两次"会留下两行同目标的失败，读的人会以为两件不同的事都坏了。
     * 历史照留（过程要能看），但当前结论只有一行 —— 这才是"一屏能读懂"。
     * 定义在函数作用域：收口要在 `while` 之外也能调。 */
    const finalizeTargets = () => {
      const lastOf = new Map();
      const keyOf = (row) => `${row.action}:${row.action === 'create' ? row.stageId : row.taskId}`;
      for (const row of rows) lastOf.set(keyOf(row), row);
      for (const row of rows) {
        if (lastOf.get(keyOf(row)) !== row) row.superseded = true;
      }
    };

    const teams = resolveTeams(ctx);
    if (teams === undefined) return fail('agentTeams');
    const agent = resolveAgent(ctx, sessionId);
    if (agent === undefined) return fail('agent');

    while (attempts < MAX_LEDGER_WRITE_ATTEMPTS) {
      attempts += 1;

      /* 每一轮都从宿主**重读**：revision 必须来自最新的一份。缓存上一轮的等于硬写旧值。 */
      let tasks;
      try {
        tasks = mapHostTaskList(teams.listTasks(agent));
      } catch (error) {
        thrownMessage = error instanceof Error ? error.message : String(error);
        return fail('read');
      }

      const plan = ledgerWritePlan(tasks, nextLedger);
      for (const warning of Array.isArray(plan.warnings) ? plan.warnings : []) warnings.push(warning);

      if (Array.isArray(plan.errors) && plan.errors.length > 0) {
        /* 算不出差量就**一次都不许写**（`ledgerWritePlan` 已写明理由：猜一个目标状态写下去，
         * 等于把账本改成没人要求的样子；而建出第二个会议头会让整份账本读不出来）。 */
        for (const error of plan.errors) errors.push(error);
        return fail('plan');
      }

      const creates = Array.isArray(plan.creates) ? plan.creates : [];
      const updates = Array.isArray(plan.updates) ? plan.updates : [];

      if (creates.length === 0 && updates.length === 0) {
        /* 已经是目标状态：**不写**。这就是幂等的全部机制 ——
         * 重复提交不会产生第二次写，也不会产生第二次 revision bump。 */
        return {
          ok: true, attempted: false, attempts, reason: 'no-change', rows, errors, warnings, codes: [],
        };
      }

      const revisionById = new Map();
      for (const task of tasks) {
        if (typeof task?.id === 'string' && Number.isSafeInteger(task.revision)) {
          revisionById.set(task.id, task.revision);
        }
      }

      const stageTaskId = stageTaskIds(tasks);
      /* 计划里的 update 本来就带 taskId，先并进去：省掉对整棵树的一次解析。 */
      for (const update of updates) {
        if (typeof update.stageId === 'string' && typeof update.taskId === 'string') {
          if (!stageTaskId.has(update.stageId)) stageTaskId.set(update.stageId, update.taskId);
        }
      }

      /** 后面成功的那一条把前面同目标的失败行标成"已被重试覆盖"，免得被读成仍在失败。 */
      const markSuperseded = (row) => {
        for (const other of rows) {
          if (other === row || other.status !== 'failed' || other.superseded === true) continue;
          if (other.action !== row.action) continue;
          const sameTarget = row.action === 'create'
            ? other.stageId === row.stageId
            : other.taskId === row.taskId;
          if (sameTarget) other.superseded = true;
        }
      };

      let conflict = false;
      let hardFailed = false;

      for (const create of creates) {
        const blockedBy = [];
        let unresolved = null;
        for (const stageId of Array.isArray(create.blockedByStages) ? create.blockedByStages : []) {
          const id = stageTaskId.get(stageId);
          if (typeof id === 'string' && id !== '') blockedBy.push(id);
          else unresolved = stageId;
        }
        if (unresolved !== null) {
          /* 阶段链接不上：宁可这一条失败，也不许**静默丢掉**阻塞关系 ——
           * 丢掉之后任务照样建出来，但顺序没了，看板上它看起来"可以随便开工"。 */
          rows.push({
            attempt: attempts,
            action: 'create',
            role: create.role,
            stageId: create.stageId === undefined ? null : create.stageId,
            taskId: null,
            status: 'failed',
            code: E_LEDGER_WRITE_FAILED,
            message: `建这条任务需要先知道阶段「${unresolved}」的任务 id，但树上找不到它`,
          });
          hardFailed = true;
          continue;
        }
        try {
          const created = await teams.createTask(agent, {
            subject: create.subject,
            description: create.description,
            ...(blockedBy.length > 0 ? { blockedBy } : {}),
            /* **故意不给 writeScopes**：会议任务不是代码任务，给了写域会触发
             * `E_DECLARATION_MISSING`（"有写域却没声明块"）—— 那是给代码任务用的判据，
             * 用在这里会每天给每一张会议卡报一条假警告。 */
          });
          const taskId = typeof created?.id === 'string' && created.id !== '' ? created.id : null;
          const row = {
            attempt: attempts,
            action: 'create',
            role: create.role,
            stageId: create.stageId === undefined ? null : create.stageId,
            taskId,
            status: taskId === null ? 'failed' : 'ok',
            ...(taskId === null
              ? { code: E_LEDGER_WRITE_FAILED, message: '宿主没有返回新任务的 id —— 这条卡在建，但认不回来' }
              : {}),
          };
          rows.push(row);
          if (taskId === null) {
            hardFailed = true;
            continue;
          }
          markSuperseded(row);
          if (typeof create.stageId === 'string' && create.stageId !== '') stageTaskId.set(create.stageId, taskId);
        } catch (error) {
          rows.push({
            attempt: attempts,
            action: 'create',
            role: create.role,
            stageId: create.stageId === undefined ? null : create.stageId,
            taskId: null,
            status: 'failed',
            code: E_LEDGER_WRITE_FAILED,
            message: error instanceof Error ? error.message : String(error),
          });
          thrownMessage = error instanceof Error ? error.message : String(error);
          conflict = true;
        }
      }

      for (const update of updates) {
        const expectedRevision = revisionById.get(update.taskId);
        if (expectedRevision === undefined) {
          rows.push({
            attempt: attempts,
            action: 'update',
            role: update.role,
            stageId: update.stageId === undefined ? null : update.stageId,
            taskId: update.taskId,
            status: 'failed',
            code: E_LEDGER_WRITE_FAILED,
            message: '这条任务在刚读到的任务树上找不到 revision —— 它可能已经被删了',
          });
          hardFailed = true;
          continue;
        }
        try {
          const written = await teams.updateTask(agent, {
            taskId: update.taskId,
            expectedRevision,
            action: 'edit',
            description: update.description,
          });
          const row = {
            attempt: attempts,
            action: 'update',
            role: update.role,
            stageId: update.stageId === undefined ? null : update.stageId,
            taskId: update.taskId,
            status: 'ok',
            revision: Number.isSafeInteger(written?.revision) ? written.revision : null,
          };
          rows.push(row);
          markSuperseded(row);
        } catch (error) {
          rows.push({
            attempt: attempts,
            action: 'update',
            role: update.role,
            stageId: update.stageId === undefined ? null : update.stageId,
            taskId: update.taskId,
            status: 'failed',
            code: E_LEDGER_WRITE_FAILED,
            message: error instanceof Error ? error.message : String(error),
          });
          thrownMessage = error instanceof Error ? error.message : String(error);
          conflict = true;
        }
      }

      if (!conflict && !hardFailed) {
        finalizeTargets();
        return { ok: true, attempted: true, attempts, reason: null, rows, errors, warnings, codes: [] };
      }
      /* 不是冲突（缺 id / 任务没了）→ 重读也没用，直接收工。 */
      if (hardFailed) break;
      /* 冲突 → 下一轮重读 + 重算；上一轮写成功的那几条会因为差量而从计划里消失。 */
    }

    finalizeTargets();

    /* 把仍未解决的失败行折成诊断。已被重试覆盖的行不再重复入账 ——
     * 它们留在 `rows` 里供人看过程，但不该被读成"现在还在失败"。 */
    for (const row of rows) {
      if (row.status !== 'failed' || row.superseded === true) continue;
      const message = typeof row.message === 'string' && row.message !== '' ? row.message : '写账本失败';
      if (errors.some((item) => item?.message === message)) continue;
      errors.push({
        code: E_LEDGER_WRITE_FAILED,
        message,
        reason: thrownMessage === null ? 'write-failed' : 'conflict',
        ...(typeof row.stageId === 'string' && row.stageId !== '' ? { stageId: row.stageId } : {}),
      });
    }

    return fail(thrownMessage === null ? 'write-failed' : 'conflict');
  }

  /**
   * 换档：把「换到哪」和「谁换的」一起落到账本上（P2-8）。
   *
   * 这是 `applyUpgrade` 的**唯一生产调用方**。在它之前，`upgrades[].by` 这一格
   * 零生产者：`ledger.mjs` 能编码 `| by=<发起人>`、`ledger.test.mjs` 的 20a 也有往返测试，
   * 但没有任何东西喂它。于是五个字段里有一个永远缺席 —— 账面看起来完整、实际少一格，
   * 比缺一个显眼的字段更坏。
   *
   * 三条纪律：
   *
   * 1. **身份只从宿主取**：`identity()` 内部走 `teams.membership(agent).name`，
   *    这是全项目写死的来源（文件头第 12 行那条注释）。`by` **绝不许**作为入参传进来 ——
   *    那等于让换档人自证，而"换档权归人类"这条原则的记录就交到了被记录的人手上。
   *
   * 2. **拿不到身份就不挂 `by`**，并在 `notes` 里如实说"这次没记下是谁换的"。
   *    绝不编 `unknown` / `system` / `n/a`：编出来的 `by` 与真的 `by` 在页面上
   *    长得一模一样，可信度却差一个数量级。
   *
   * 3. **换完立刻写回账本**：只在内存里升档而不落盘，等于这场会下次启动又回到旧档，
   *    而"升过档"这件事只活在这一个函数的返回值里。
   *
   * @param {string} sessionId 调用方会话（身份与任务树都用它）
   * @param {{toQualified?: string, reason?: string, at?: string}} input
   *   **`by` 不在入参里**（见上）。`at` 缺省则不挂这个键。
   * @returns {Promise<{ok: boolean, reason: string|null, identity: object|null,
   *            notes: string[], upgrade?: object, written?: object|null,
   *            meeting?: object, errors?: Array<object>, message?: string}>}
   */
  async function upgradeMeeting(sessionId, input) {
    const source = input !== null && typeof input === 'object' ? input : {};
    const notes = [];

    const teams = resolveTeams(ctx);
    if (teams === undefined) return { ok: false, reason: 'agentTeams', identity: null, notes, written: null };
    const agent = resolveAgent(ctx, sessionId);
    if (agent === undefined) return { ok: false, reason: 'agent', identity: null, notes, written: null };

    let tasks;
    try {
      tasks = mapHostTaskList(teams.listTasks(agent));
    } catch (error) {
      return {
        ok: false,
        reason: 'read',
        message: error instanceof Error ? error.message : String(error),
        identity: null,
        notes,
        written: null,
      };
    }

    /* 升档的前提是**读得出现有账本**：读不出来就不知道当前档位，
     * 也就不知道这次算不算"向上"。`applyUpgrade` 自己也会再判一次（`readLedger`），
     * 但这里先拦是因为连 meeting 都拿不出来。 */
    const projected = ledgerFromTasks(tasks);
    if (projected.ledger === null) {
      return {
        ok: false,
        reason: 'ledger',
        errors: Array.isArray(projected.errors) ? projected.errors : [],
        identity: null,
        notes,
        written: null,
      };
    }

    const who = await identity(sessionId);

    /* 方向判据**不在这里**（P2-11）：`applyUpgrade` 自己判。
     *
     * 上一版这里先调 `judgeShift` 再进 `applyUpgrade` —— 唯一的调用方是对的，
     * 但判据落到了调用方身上，于是函数本身对任何新调用方都不安全。
     * 现在这一层只负责把 registry 交过去：注册表是数据，读得到就读得到，
     * 读不到就是 `null`，`applyUpgrade` 会拒绝并说清"这次没判方向"。 */
    const upgraded = applyUpgrade({
      meeting: projected.ledger,
      registry: await readPresetRegistry(),
      toQualified: source.toQualified,
      ...(source.reason === undefined ? {} : { reason: source.reason }),
      ...(source.at === undefined ? {} : { at: source.at }),
      /* **只有真拿到身份才挂 `by`**。拿不到就让它缺席，不编占位名。 */
      ...(who !== null && who.status === 'ok' && typeof who.name === 'string' && who.name !== ''
        ? { by: who.name }
        : {}),
    });

    if (!upgraded.ok) {
      return {
        ok: false,
        reason: 'upgrade',
        /* `direction` 由 `applyUpgrade` 给：`down` / `same` / `unknown` 三种成因
         * 在这一层必须还能分辨 —— 页面要能说"你要求的是降档"而不是"换档失败"。 */
        direction: upgraded.direction,
        upgradedReason: upgraded.reason ?? null,
        message: typeof upgraded.message === 'string' ? upgraded.message : null,
        errors: Array.isArray(upgraded.errors) ? upgraded.errors : [],
        identity: who,
        notes,
        written: null,
        meeting: upgraded.meeting,
      };
    }

    /* 拿不到身份：换档照做（挡在这里等于让"记不下是谁"变成"不许换档"，那更坏），
     * 但必须在响应里说出来。**这是本函数唯一允许"少一格"的情形**，
     * 而且是明说的少一格，不是默认的少一格。 */
    if (who === null || who.status !== 'ok') {
      const why = who === null ? 'unknown' : who.reason;
      notes.push(
        `这次没记下是谁换的档：拿不到本会话的身份（${why}）。`
          + '换档本身已执行，账本上这一条**没有 by** —— '
          + '不编占位名，因为编出来的和真的一样长得像，而它们不是一回事。',
      );
    }

    const written = await writeMeetingLedger(sessionId, upgraded.meeting);
    return {
      ok: written.ok,
      reason: written.ok ? null : 'write',
      direction: upgraded.direction,
      identity: who,
      notes,
      upgrade: {
        ok: upgraded.ok,
        /* 原样透传：`E_UPGRADE_NO_REASON` 在 `errors` 里但 `ok` 恒 true（它出声不拦），
         * `E_PRESET_UPGRADED` 在 `warnings` 里。这一层不改它们的含义。 */
        errors: Array.isArray(upgraded.errors) ? upgraded.errors : [],
        warnings: Array.isArray(upgraded.warnings) ? upgraded.warnings : [],
      },
      written,
      meeting: upgraded.meeting,
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * P3-2：连杆 —— 起一场会并把它跑到"需要人的地方"为止
   *
   * 在这之前整条流水线是"发动机装好、没有油门"：驱动器能被调，但它的 `deliver`
   * 是注入的空壳，也没有任何东西按得动它。这一段把两头接上：
   *   ① 用**真实的** `subagents` 能力投递（分档只问 `pickDelivery`）；
   *   ② 挂成模型真能按的工具 `team_meeting_start`。
   * ═══════════════════════════════════════════════════════════════════════ */

  /**
   * 起一场会，并对它跑到需要人的地方为止。
   *
   * 四种收场全部由驱动器判定（阶段全完 / 判不了 / 死了 3 次 / 需要拍板）。
   * 这一层只做：读预设 → 建账本 → 接线 → 交回结果。**不判任何一条。**
   */
  async function startMeeting(sessionId, input) {
    const source = input !== null && typeof input === 'object' ? input : {};

    const agent = resolveAgent(ctx, sessionId);
    if (agent === undefined) {
      return { ok: false, status: 'blocked', stop: 'agent', trace: [], errors: [], pending: [] };
    }
    const teams = resolveTeams(ctx);

    /** 名册要靠任务树；读不出来就交空表 —— 名册空 ≠ "没人干过"，只是这次没读到。 */
    const safeListTasks = () => {
      if (teams === undefined) return [];
      try {
        return mapHostTaskList(teams.listTasks(agent));
      } catch {
        return [];
      }
    };

    const qualified = typeof source.preset === 'string' && source.preset !== '' ? source.preset : 'lite@1';

    /* 预设必须**加载并校验**：`loadPreset` 会拦下"登记了但没实现"的档位与不合法的阶段，
     * 而"回退到默认档"是本项目明令禁止的行为（那会让一场写着 X 档的会按 Y 档跑完）。 */
    const registry = await readPresetRegistry();
    const body = await readPresetBody(qualified);
    const loaded = loadPreset({
      registry,
      qualified,
      bodies: body === null ? {} : { [qualified]: body },
    });
    if (loaded.ok !== true) {
      return {
        ok: false,
        status: 'blocked',
        stop: 'preset',
        trace: [],
        pending: [],
        errors: Array.isArray(loaded.errors) ? loaded.errors : [],
      };
    }

    const meeting = {
      id: `m-${Date.now().toString(36)}`,
      preset: qualified,
      status: 'running',
      stages: [],
      upgrades: [],
      /* 会议的问题存在账本上，驱动器会把它喂进每一条投递消息 —— 否则这个入参
       * 就是个死输入，和"支持了但没人喂"是同一类缺口。 */
      question: typeof source.question === 'string' ? source.question : '',
    };

    /* 先写会议头（父任务 + 阶段子任务链）再开跑：不写就跑，一场会跑到一半崩掉时
     * 账本上连"有过这场会"都没有。 */
    const created = await writeMeetingLedger(sessionId, meeting);
    if (created.ok !== true) {
      return { ok: false, status: 'blocked', stop: 'create', trace: [], pending: [], errors: [], written: created, meeting };
    }

    const subagents = resolveService(ctx, 'subagents');
    const collectArtifact = subagents !== undefined && typeof subagents.readArtifact === 'function'
      /* 产物回收是**读**，不是第二条投递通道。宿主没有这个能力时返回 `null`，
       * 驱动器于是如实走"没拿到 → 存活/继续 → 交人"，绝不假装收到了卡。 */
      ? ({ childId }) => subagents.readArtifact(childId)
      : null;

    const rawDeliver = createSubagentDeliver({
      subagents,
      parent: agent,
      source: { kind: 'meeting-stage', meetingId: meeting.id },
      collectArtifact,
      /* "子会话在不在、忙不忙"只问宿主：有目录能力就用它，
       * 没有就交给 `pickDelivery` 按"状态未知"处理（它的规定，不是这里补的）。 */
      readChildren: subagents !== undefined && typeof subagents.listChildren === 'function'
        /* 契约：`listChildren(parentSessionId: SessionId, signal?)` —— 要的是**字符串 id**。
         * 曾经这里传的是 `agent`（一个对象），宿主当场报
         * `session "[object Object]" not found` 并 **fatal exit 1**，整个宿主进程死掉。
         * 假对象什么都收，所以测试全绿；真宿主按契约校验，一按就崩。 */
        ? () => subagents.listChildren(agent.id)
        : null,
    });
    /* 记住这一段投给了谁：「继续」要发回同一个目标。 */
    let lastTarget = null;
    const deliver = async (asked) => {
      const result = await rawDeliver(asked);
      if (typeof result?.childId === 'string' && result.childId !== '') lastTarget = result.childId;
      return result;
    };

    return driveMeeting(
      {
        preset: loaded.preset,
        deliver,
        /* 落盘只有一条路：`writeMeetingLedger`。驱动器不另写一套。 */
        writeLedger: (next) => writeMeetingLedger(sessionId, next),
        /* 时钟只在 host 这一层读。`src` 里读时钟是禁止的。 */
        now: () => Date.now(),
        /* 「该用谁」的**唯一**来源：账本里我们自己写下的 `agent` 那格。
         * 宿主没有"列出子会话"的接口，所以候选只能靠名册 —— 不许在这里另写
         * 一份"谁存在"的判断（那就是判据的第二份副本）。
         * **不传 `candidate`**：传了会盖掉名册，等于让"该用谁"回到一个常量。 */
        roster: agentRoster(safeListTasks()).entries,
        sendContinue: async ({ message }) => {
          if (subagents === undefined || typeof subagents.sendMessage !== 'function') return;
          /* 「继续」也走同一条投递通道（宿主按目标实际状态并入/起一轮）。 */
          await subagents.sendMessage(agent, lastTarget ?? agent.id, message);
        },
      },
      { meeting, meetingId: meeting.id },
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * P2-9：提交阶段结果的入口
   *
   * 在它之前，`writeMeetingLedger` 只被测试调用 —— 账本写路径的反证只证明了
   * "它能写对"，没证明"它会被用"。**测试绿不等于功能可用。**
   *
   * 链路：`recordSubmission`（定幂等与记录形状）→ 挂卡 → `writeMeetingLedger`（差量写）。
   * 每一步都调既有的纯函数，这一层只做取数与串联。
   * ═══════════════════════════════════════════════════════════════════════ */

  /** 预设标识的白名单：只许 `id@版本`。**这不是格式洁癖，是路径安全** ——
   * 预设体要从 `presets/<qualified>.json` 读，`../../etc/passwd` 这种值拼进路径就是任意读。 */
  const PRESET_QUALIFIED_RE = /^[a-z0-9-]+@[0-9]+$/;

  /** 预设体缓存（一次进程只读一次）。 */
  let presetBodies = null;

  /**
   * 读一份预设体。**任何失败都返回 `null`**，由调用方把它翻译成"判不了"。
   *
   * 为什么这一层要有文件 IO：卡片判据（`judgeArtifact`）需要**当前阶段的定义**
   * （必产字段、`minCount`），而那份定义只存在于预设里。不读它，`judgeArtifact`
   * 只能拿到 `stage: null` 然后永远回一句"判不了" —— 那就是装饰。
   *
   * `presets/*.json` 随包发布（`package.json` 的 `files` 里有）。
   */
  async function readPresetBody(qualified) {
    if (typeof qualified !== 'string' || !PRESET_QUALIFIED_RE.test(qualified)) return null;
    if (presetBodies === null) presetBodies = new Map();
    if (presetBodies.has(qualified)) return presetBodies.get(qualified);

    let body = null;
    try {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const path = await import('node:path');
      const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets');
      body = JSON.parse(readFileSync(path.join(dir, `${qualified}.json`), 'utf8'));
    } catch {
      body = null; // 读不到就是读不到，不许编一份出来
    }
    presetBodies.set(qualified, body);
    return body;
  }

  /** 预设注册表缓存（一次进程读一次）。读不到返回 `null` —— 由调用方判成"判不出方向"。 */
  let presetRegistry;

  async function readPresetRegistry() {
    if (presetRegistry !== undefined) return presetRegistry;
    let registry = null;
    try {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const path = await import('node:path');
      const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets');
      registry = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    } catch {
      registry = null;
    }
    presetRegistry = registry;
    return registry;
  }

  /**
   * 判一张卡够不够。**判据一行都不在这里**：调 `artifact.mjs` 的 `judgeArtifact`，
   * 把它的 `errors` / `warnings` / `cannotJudge` 原样带出去。
   *
   * 拿不到阶段定义时**如实说判不了**，绝不"没判就报绿"。
   */
  async function judgeSubmittedCard(qualified, stageId, card) {
    const body = await readPresetBody(qualified);
    if (body === null) {
      return {
        status: 'cannot-judge',
        errors: [],
        warnings: [],
        cannotJudge: `读不到预设 ${qualified} 的定义 —— 不知道阶段 ${stageId} 要求哪些字段，这张卡**判不了**（不是"没问题"）。`,
      };
    }
    const stages = Array.isArray(body.stages) ? body.stages : [];
    const stage = stages.find((item) => item !== null && typeof item === 'object' && item.id === stageId) ?? null;
    if (stage === null) {
      return {
        status: 'cannot-judge',
        errors: [],
        warnings: [],
        cannotJudge: `预设 ${qualified} 里没有阶段 ${stageId} —— 这张卡不属于这个档位，**判不了**（不是"没问题"）。`,
      };
    }
    /* 传 `raw` 而不是 `card`：`judgeArtifact` 只有在 `card === undefined` 时才做规范化，
   * 直接给 `card` 会跳过规范化、拿到一张没有 `claimCount` 的对象，于是每条卡都被判"缺 claim"。 */
    const judged = judgeArtifact({ stage, raw: card });
    return {
      status: judged.ok === true ? 'ok' : 'failed',
      errors: Array.isArray(judged.errors) ? judged.errors : [],
      warnings: Array.isArray(judged.warnings) ? judged.warnings : [],
      cannotJudge: typeof judged.cannotJudge === 'string' ? judged.cannotJudge : null,
    };
  }

  /** 把卡挂到某阶段的记录上。`recordSubmission` 不管卡（它的记录里没有这一格），
   * 而 `ledgerWritePlan` 会把 `record.card` 渲染成 `card.*` 那几行。 */
  function withStageCard(meeting, stageId, card) {
    const stages = Array.isArray(meeting?.stages)
      ? meeting.stages.map((record) => (
        record !== null && typeof record === 'object' && record.stageId === stageId
          ? { ...record, card }
          : record
      ))
      : [];
    return { ...meeting, stages };
  }

  /**
   * 提交一个阶段的结果。
   *
   * 四条纪律：
   *   1. **身份只从宿主取**（`identity()` → `membership().name`）。拿不到就如实失败 ——
   *      一次署不了名的提交不许被当成正常提交，也不许编个占位名顶上。
   *   2. **幂等**：`recordSubmission` 对同一 `(meetingId, stageId, attempt)` 返回
   *      `duplicate: true`，此时**一次都不写** —— 幂等的全部机制就在这一句。
   *   3. **写失败如实返回**，行留在 `written.rows` 里；**绝不重发这个阶段** ——
   *      重发会让同一阶段执行两次而账本只记第二次。
   *   4. 卡片的判据调 `judgeArtifact`（**不在这一层重写**）。判不了就说判不了。
   *
   * @param {string} sessionId
   * @param {{stageId?: string, attempt?: number, status?: string,
   *          produced?: string[], card?: object, at?: string}} input
   */
  async function submitStage(sessionId, input) {
    const source = input !== null && typeof input === 'object' ? input : {};

    const teams = resolveTeams(ctx);
    if (teams === undefined) return { ok: false, reason: 'agentTeams', identity: null, written: null, duplicate: false };
    const agent = resolveAgent(ctx, sessionId);
    if (agent === undefined) return { ok: false, reason: 'agent', identity: null, written: null, duplicate: false };

    const who = await identity(sessionId);
    if (who === null || who.status !== 'ok') {
      const why = who === null ? 'unknown' : who.reason;
      return {
        ok: false,
        reason: 'identity',
        identity: who,
        duplicate: false,
        written: null,
        message: `拿不到本会话的身份（${why}），无法署名这次提交 —— 不编占位名，也不记一笔署不了名的账。`,
      };
    }

    let tasks;
    try {
      tasks = mapHostTaskList(teams.listTasks(agent));
    } catch (error) {
      return {
        ok: false,
        reason: 'read',
        identity: who,
        duplicate: false,
        written: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    /* 提交的前提是**读得出现有账本**：读不出来就不知道这是第几轮、这一阶段有没有记过，
     * 于是既算不出幂等也写不了差量。 */
    const projected = ledgerFromTasks(tasks);
    if (projected.ledger === null) {
      return {
        ok: false,
        reason: 'ledger',
        identity: who,
        duplicate: false,
        written: null,
        errors: Array.isArray(projected.errors) ? projected.errors : [],
      };
    }

    /* 卡先判、再记：判不了也要把"判不了"带出去，别让它看起来像"判过了"。 */
    const cardJudgment = source.card === undefined
      ? null
      : await judgeSubmittedCard(projected.ledger.preset, source.stageId, source.card);

    const recorded = recordSubmission({
      meeting: projected.ledger,
      stageId: source.stageId,
      attempt: source.attempt,
      status: source.status,
      ...(source.produced === undefined ? {} : { produced: source.produced }),
      ...(source.at === undefined ? {} : { at: source.at }),
    });

    if (recorded.ok !== true) {
      return {
        ok: false,
        reason: 'record',
        identity: who,
        duplicate: false,
        written: null,
        card: cardJudgment,
        errors: Array.isArray(recorded.errors) ? recorded.errors : [],
      };
    }

    /* 幂等命中：这一轮已经记过了。**一次都不许写** —— 这是"重复提交不产生第二次写"
     * 的唯一实现点，不靠调用方自觉。 */
    if (recorded.duplicate === true) {
      return {
        ok: true,
        reason: 'duplicate',
        duplicate: true,
        identity: who,
        card: cardJudgment,
        written: null,
        errors: [],
      };
    }

    const target = source.card === undefined
      ? recorded.meeting
      : withStageCard(recorded.meeting, source.stageId, source.card);
    const written = await writeMeetingLedger(sessionId, target);

    return {
      ok: written.ok,
      reason: written.ok ? null : 'write',
      duplicate: false,
      identity: who,
      stage: {
        stageId: source.stageId,
        attempt: source.attempt,
        status: source.status,
      },
      card: cardJudgment,
      written,
    };
  }

  return {
    enabled: () => enabled,
    getState,
    stats,
    hydrate,
    setEnabled,
    readLedger,
    writeLedger,
    roster,
    gates,
    snapshot,
    /* 待拍板（第 ⑤ 轮 build）：读 / 写 / 找 / 身份 / 回写，五件都交出去 ——
     * 路由是唯一调用方，但**测试必须能从这一层直接调**，否则测的就只是 HTTP 壳子。 */
    readDecisions,
    writeDecision,
    findDecision,
    identity,
    /* P2-4：账本写路径。与 `writeback` 并列交出去 —— 同上，测试必须能从这一层直接调。 */
    writeMeetingLedger,
    /* P2-8：换档入口。`by` 的**唯一生产调用方** —— 没有它，`upgrades[].by` 这一格永远空着。 */
    upgradeMeeting,
    /* P2-9：提交阶段结果。在它之前，`writeMeetingLedger` 只被测试调用过。 */
    submitStage,
    /* P3-2：连杆。起一场会并跑到需要人的地方 —— 在它之前没有任何东西按得动驱动器。 */
    startMeeting,
    writeback,
    projectDecisions,
  };
}

/**
 * 注册页面数据路由。取不到 `connection` 就返回 `undefined`（不是错误）。
 *
 * 生命周期跟着 `apply` 的 effect：路由随插件卸载一起撤掉。
 *
 * @returns {(() => void)|undefined} 撤销函数
 */
/**
 * 把一条 POST 路由挂到宿主的 fetch 桥上（两条路由共用这一份挂载逻辑）。
 *
 * 为什么抽出来：`/state` 与 `/decide` 的挂法必须**一模一样** —— 取连接、判断
 * `fetch.register` 是否可用、失败就返回 `undefined`（不是抛）、随 `apply` 一起撤。
 * 抄两遍的话，将来只改一条（比如给某条加 requestBody 模式）就会造出
 * "一条路由收得到 body、另一条收不到"这种极难查的差异。
 *
 * **注册失败不是错误**：没有 `connection` 服务只意味着这台宿主没有页面数据通道，
 * 不许因此让插件不激活。
 *
 * @returns {(() => void)|undefined} 撤销函数
 */
function mountFetchRoute(ctx, path, handler) {
  const register = (connection) => {
    if (connection === null || connection === undefined) return undefined;
    const fetch = connection.fetch;
    if (fetch === null || fetch === undefined || typeof fetch.register !== 'function') return undefined;
    try {
      const disposer = fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handler,
      });
      return typeof disposer === 'function' ? disposer : undefined;
    } catch {
      return undefined;
    }
  };

  const readConnection = (owner) => {
    if (owner === null || owner === undefined) return undefined;
    if (typeof owner.get === 'function') {
      try {
        const viaGet = owner.get('connection');
        if (viaGet !== undefined && viaGet !== null) return viaGet;
      } catch {
        // 没有这个服务，继续兜底。
      }
    }
    try {
      return owner.connection ?? undefined;
    } catch {
      return undefined;
    }
  };

  if (typeof ctx.inject === 'function') {
    try {
      const disposer = ctx.inject(['connection'], (scoped) => register(readConnection(scoped)));
      if (typeof disposer === 'function') return disposer;
    } catch {
      // 这个上下文不支持条件注入，退回直接读。
    }
  }
  return register(readConnection(ctx));
}

/**
 * 注册页面数据路由（`/api/team-board/state`）。
 *
 * 生命周期跟着 `apply` 的 effect：路由随插件卸载一起撤掉。
 *
 * @returns {(() => void)|undefined} 撤销函数
 */
export function registerStateRoute(ctx, state) {
  return mountFetchRoute(ctx, STATE_PATH, async (request) => {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    /* 第 12 轮 D-5：**写开关也算这次请求的一部分**，必须在同一个 try 里。
     * 原来这三行在 try 之外：一次写盘异常会直接从 `fetch` 里逃出去，
     * 变成宿主侧的裸 500（页面只看到"请求失败"，看不到是存储的问题），
     * 而且 `body` 已经收下了、开关已经在内存里改了 —— 调用方无法知道这件事。 */
    try {
      if (body !== null && typeof body === 'object' && typeof body.enabled === 'boolean') {
        await state.setEnabled(body.enabled);
      }
      const value = await state.snapshot(body);
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json(
        { ok: false, error: { code: 'team-board/internal', message } },
        { status: 500, headers: { 'cache-control': 'no-store' } },
      );
    }
  });
}

/**
 * 注册拍板路由（`/api/team-board/decide`）。
 *
 * 一次请求只做**一件事**，四种意图互斥、按顺序判定：
 *   ① `{ id, verdict }`      拍板 —— 仅本人；非本人 / 非 user 种类 → **403**；
 *   ② `{ id, suggestion }`   提建议 —— 任何人（含管理员/机器人/代理）都可，**只写 suggestion，
 *                             status 一个字节都不动**（Req5 的后半句）；
 *   ③ `{ id, retry: true }`  重发回写 —— 仅本人；不改决议，只重试通道（Req6）；
 *   ④ 其余                    → 400（不猜调用方想干什么）。
 *
 * 状态码是**接口层事实**，不是界面上的颜色：
 *   400 入参不成立 · 403 不是本人 / 不是本人账号 · 404 行不存在
 *   409 宿主认不出"我"（这是"不知道"，不是"不许"）· 500 内部错误 · 200 成功
 *
 * @returns {(() => void)|undefined} 撤销函数
 */
export function registerDecideRoute(ctx, state) {
  const reply = (payload, status) => Response.json(payload, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
  const fail = (code, message, status) => reply({ ok: false, error: { code, message } }, status);

  return mountFetchRoute(ctx, DECIDE_PATH, async (request) => {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};

    try {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      if (id === '') return fail('team-board/invalid', '缺少 id：不知道要拍哪一条', 400);

      const kind = typeof input.kind === 'string' && input.kind !== '' ? input.kind : 'user';
      if (!ACTOR_KINDS.includes(kind)) {
        return fail('team-board/invalid', `kind 不认识：${kind}（只认 ${ACTOR_KINDS.join(' / ')}）`, 400);
      }

      const wantsVerdict = input.verdict !== undefined;
      const wantsRetry = input.retry === true;
      const wantsSuggestion = typeof input.suggestion === 'string';
      if (!wantsVerdict && !wantsRetry && !wantsSuggestion) {
        return fail('team-board/invalid', '没有可执行的动作（verdict / suggestion / retry 三选一）', 400);
      }
      if (wantsVerdict) {
        const verdict = typeof input.verdict === 'string' ? input.verdict : '';
        if (verdict !== 'approve' && verdict !== 'reject' && verdict !== 'hold') {
          return fail('team-board/invalid', `verdict 不认识：${verdict}`, 400);
        }
      }

      /* 身份：**只认宿主真相**。读不到 → 409。
       * 为什么不是 403：409 说的是"我现在不知道你是谁"，403 说的是"我知道，但你不许"。
       * 把两者混成一个码，前端就再也分不清"该去登录"还是"该找负责人"。 */
      const who = await state.identity(input.sessionId);
      if (who === undefined || who.status !== 'ok') {
        const reason = who === undefined ? 'identity' : who.reason;
        return fail('team-board/identity', `宿主认不出这次请求的身份（${reason}）`, 409);
      }
      const me = who.name;

      const row = await state.findDecision(id);
      if (row === undefined) return fail('team-board/not-found', `没有这一条待拍板：${id}`, 404);

      /* ── ① 拍板：仅本人账号（Req5）。两道闸，缺一不可 ───────────────────
       *   闸 A：`kind` 必须是 `user` —— 管理员 / 机器人 / 代理账号一律 403，
       *         它们只能走下面的 suggestion 分支；
       *   闸 B：`samePerson(me, row.owner)` —— 宿主真相里的"我"必须是这条的归属人。
       * 两道闸的**判据不同**：A 判"你是什么身份"，B 判"这条是不是你的"。 */
      if (wantsVerdict || wantsRetry) {
        if (kind !== 'user') {
          return fail(
            'team-board/forbidden',
            `只有本人账号可以写拍板状态；${kind} 账号只允许写 suggestion 字段`,
            403,
          );
        }
        if (!samePerson(me, row.owner)) {
          return fail('team-board/forbidden', `这条待拍板属于 ${row.owner || '（无归属）'}，不是本人`, 403);
        }
      }

      /* ── ② 建议：任何人可写，且**只写 suggestion**（status / verdict 不动）── */
      if (wantsSuggestion) {
        const text = input.suggestion.trim();
        if (text === '') return fail('team-board/invalid', 'suggestion 是空串', 400);
        const nextSuggestion = {
          ...row,
          suggestion: text,
          suggestion_by: kind === 'user' ? me : kind,
          suggestion_at: new Date().toISOString(),
        };
        const saved = await state.writeDecision(nextSuggestion);
        if (saved !== true) return fail('team-board/internal', '建议没写进去（存储不可用）', 500);
        return reply({ ok: true, value: { row: nextSuggestion } }, 200);
      }

      /* ── ③ 重发回写：先落"已拍板"再回写，失败留痕，决议不回退（Req6）── */
      if (wantsRetry) {
        /* 判据必须是**白名单**，不是"等于 null"。
         *
         * 曾经的写法是 `row.verdict === null && row.verdict !== 'approve' && …`——
         * 左边成立时右边恒真，整个条件退化成 `row.verdict === null`。
         * 于是 `verdict` 字段根本不存在（undefined）或是个垃圾串时，判据为 false，
         * 请求被放行：一条**从未拍板**的行会真调一次 writeback、把来源系统写成"已批准"，
         * 还把 `writeback_state` 落成 'ok' —— 在页面上伪装成功。
         *
         * 退化的原因不是笔误，是**判据方向选错**：想问"它没有决议吗"，
         * 写成"它等于 null 吗"。凡是描述"合法值集合"的判据，一律枚举合法值，
         * 不要枚举非法值 —— 非法值的形态永远比你想到的多一个（undefined / '' / 大小写）。
         *
         * 白名单同时挡住了 null / undefined / '' / 'APPROVE' / 任意串，不用逐个列举。 */
        if (row.verdict !== 'approve' && row.verdict !== 'reject' && row.verdict !== 'hold') {
          return fail('team-board/invalid', '这一条还没有决议，没什么可回写的', 400);
        }
        const written = await state.writeback(row);
        const retried = {
          ...row,
          writeback_state: written.status === 'ok' ? 'ok' : 'failed',
          writeback_error: written.message === undefined ? '' : written.message,
        };
        await state.writeDecision(retried);
        return reply({ ok: true, value: { row: retried, writeback: written } }, 200);
      }

      /* ── ④ 拍板：先落决议，再回写 ────────────────────────────────────────
       * 顺序不能反：先回写再落盘，一旦落盘失败就会出现"来源系统已经知道、
       * 页面还显示待拍板"的分叉；而反过来（先落盘）最坏只是"页面已拍板、来源还没收到"，
       * 那是**可重试**的失败，且用户看得见（`回写失败` + 重试按钮）。 */
      const decidedAt = new Date().toISOString();
      const next = {
        ...row,
        status: 'decided',
        verdict: input.verdict,
        decided_by: me,
        decided_at: decidedAt,
        decision_value: input.verdict,
        writeback_state: 'pending',
        writeback_error: '',
      };
      const saved = await state.writeDecision(next);
      if (saved !== true) return fail('team-board/internal', '决议没写进去（存储不可用）', 500);

      const written = await state.writeback(next);
      const withWriteback = {
        ...next,
        writeback_state: written.status === 'ok' ? 'ok' : 'failed',
        writeback_error: written.message === undefined ? '' : written.message,
      };
      await state.writeDecision(withWriteback);
      return reply({ ok: true, value: { row: withWriteback, writeback: written } }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail('team-board/internal', message, 500);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 第 10 轮（W7）：`team_deliver` —— 让 137 条 delivery 测试第一次有出口
 *
 * 职责边界和 `team_board` 一样窄，而且这里更严：
 *   - **一行判定都不写**。收不收活全由 `delivery.mjs` 的 `canDeliver({ team, tasks })`
 *     决定（137 条测试保护它）。本层只做三件事：取数据、调它、排版。
 *   - 唯一做的"数据加工"是 `ownerName → assignee`：`delivery.mjs:840` 与 `:1307`
 *     两处明文写着「插件层应从宿主 ownerName 灌入 assignee」。不做这一步，
 *     真实宿主数据会被判成 legacy（E_INDEPENDENCE_UNENFORCED），
 *     而归属信息其实就在另一个字段里——那是我们自己造的假警告。
 *     除此之外**不造任何字段**：kind / contract / phase 缺就是缺（D-14 还没实现）。
 *
 * 双源（派工书第 10 轮 §一）：
 *   有 agentTeams                → listTasks(exec.agent)，宿主是唯一真相源
 *   没有、但调用方传了 tasks     → 用调用方的，**并在第二行写明未经宿主核对**
 *   都没有                        → E_HOST_UNSUPPORTED（不许给"可以交付"）
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
 * 会议的两个**动作**工具（P2-9）
 *
 * 为什么必须是工具、而不能只挂在 state 上：本项目的主注入通道是
 * `ctx.systemPrompt.tools(...)`，工具是模型唯一能主动按的按钮。只挂 state
 * 等于"能力有了、没人能按" —— 那正是 `writeMeetingLedger` 此前的状态。
 * ═══════════════════════════════════════════════════════════════════════════ */

const SUBMIT_NAME = 'team_meeting_submit';
const UPGRADE_NAME = 'team_meeting_upgrade';
const SUBMIT_DESCRIPTION = [
  '提交一个阶段的会议结果，写进任务树里的会议账本（父任务存会议头，阶段子任务存回执）。',
  '幂等：同一 (阶段, 轮次) 重复提交是空操作，不会写第二次 —— 所以放心重试，'
    + '不要为了"覆盖"去改 attempt。',
  '署名只来自宿主成员身份，不能作为参数传进来；拿不到身份时提交会失败，'
    + '而不是记一笔署不了名的账。',
  '写失败会如实返回 E_LEDGER_WRITE_FAILED 并保留失败行，且**绝不重发这个阶段**：'
    + '账本没记上 ≠ 阶段没跑，重发会让同一阶段执行两次。',
  '卡片判据来自 artifact.mjs；判不了会明确说"判不了"，不会报绿。',
].join('');

const SUBMIT_PARAMETERS = {
  type: 'object',
  properties: {
    stageId: {
      type: 'string',
      description: '阶段 id（如 challenge / confirm / design / redteam / build / verify / signoff）。',
    },
    attempt: {
      type: 'integer',
      description: '轮次，正整数。返工要换一个更大的轮次；同一轮重复提交是空操作。',
    },
    status: {
      type: 'string',
      description: '这一阶段的状态：pending / running / done / failed。',
    },
    produced: {
      type: 'array',
      description: '可选。这一阶段实际交了哪些产物（键名）。省略 = 没申报；空数组 = 申报了零个。'
        + '这两件事不同，别用空数组冒充"没想过"。',
      items: { type: 'string' },
    },
    card: {
      type: 'object',
      description: '可选。方案卡（至少要有 claim）。省略 = 这一阶段没有卡。',
    },
    at: {
      type: 'string',
      description: '可选。这一阶段完成的时间。原样存进账本，不解析、不格式化。',
    },
  },
  additionalProperties: false,
};

const SUBMIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    report: { type: 'string' },
    ok: { type: 'boolean' },
    duplicate: { type: 'boolean' },
    writtenCount: { type: 'integer' },
  },
};

const UPGRADE_DESCRIPTION = [
  '把一场会的档位**向上**换一档，并把这次换档连「谁换的」一起写进账本。',
  '**这是人的动作，不是优化手段。** 换档权归人类：机器不许为了让流程"跑得更顺"自己调它；'
    + '需要升档时应当说明理由、由人按这个按钮。',
  '只许升不许降：降档会失败并说明为什么 —— 降档等于"已经怀疑过的部分不再怀疑了"，'
    + '而那些怀疑的结论还留在账本里，账本会和档位对不上。换到同一档是空操作，不会写假历史。',
  '换档人只从宿主成员身份取，不能作为参数传；拿不到身份时换档照做，'
    + '但账本上这一条**没有 by**，响应里会明说"这次没记下是谁换的"。',
].join('');

const UPGRADE_PARAMETERS = {
  type: 'object',
  properties: {
    toQualified: {
      type: 'string',
      description: '目标档位，必须是 id@版本（如 standard@1）。不接受裸 id —— '
        + '预设会改，改了之后旧任务按新定义判会静默漂移。',
    },
    reason: {
      type: 'string',
      description: '为什么升档。省略会让账本上出现"不知道为什么多跑了几个阶段"（E_UPGRADE_NO_REASON）。',
    },
    at: {
      type: 'string',
      description: '可选。换档时间。原样存进账本，不解析。',
    },
  },
  additionalProperties: false,
};

const UPGRADE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    report: { type: 'string' },
    ok: { type: 'boolean' },
    direction: { type: 'string' },
    writtenCount: { type: 'integer' },
  },
};

/* ── P3-2：起一场会（连杆的按钮）──────────────────────────────────────────── */

const START_NAME = 'team_meeting_start';

const START_DESCRIPTION = [
  '起一场会，并把它**跑到需要人的地方为止**：阶段全完 / 某阶段判不了 / 连续 3 次没回执 / 需要人拍板。',
  '它做的事是把预设的阶段**真的按顺序派出去**：每个阶段按盲/非盲剥好该看的东西，收产物，判卡，记账。',
  '判据一条都不在这个工具里：阶段顺序、代理选择、判卡、存活、记账全部来自既有模块。',
  '拿不到产物时它如实交人 —— **不会自己重试**，也不会把"没拿到"当成"通过"。',
  '换档不归它管：升档是人的动作，用 team_meeting_upgrade。',
].join('');

const START_PARAMETERS = {
  type: 'object',
  properties: {
    preset: {
      type: 'string',
      description: '档位，必须是 id@版本（如 lite@1 / standard@1）。省略按 lite@1。'
        + '不接受裸 id —— 预设会改，裸 id 会让旧会议按新定义静默漂移。',
    },
    question: {
      type: 'string',
      description: '这场会要回答的问题。它会进到每一条阶段投递消息里。',
    },
  },
  additionalProperties: false,
};

const START_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    report: { type: 'string' },
    ok: { type: 'boolean' },
    status: { type: 'string' },
    stop: { type: 'string' },
    stageCount: { type: 'integer' },
    pendingCount: { type: 'integer' },
  },
};

const DELIVER_NAME = 'team_deliver';

const DELIVER_DESCRIPTION = [
  '判定「这批活现在能不能收」：自审、缺归属、契约缺验收、任务未完成、改动越界、评审停滞等。',
  '判定全部来自 delivery.mjs（137 条测试），本工具只负责取数据与排版。',
  '第一行是结论，第二行是数据来源：有 Agent Teams 时读宿主任务板；否则用你显式声明的 tasks，并在第二行标注「未经宿主核对」。',
  '审计输入（diffPaths / currentDigests）宿主侧没有，只能由调用方显式声明；不声明时其中「字节绑定」与「diff 对账」两项不跑，',
  '报告会以警告 E_AUDIT_UNWIRED 自曝，并把缺输入时无法成立的结论降级为警告——不要把「报告里没提」读成「查过没问题」。',
  /* 开会纪律的正文只写在 team_board 的描述里（见该常量上方的长注释）。
   * 这里只留一句指路：同一条事实说两遍，将来改的时候必漏一遍。 */
  '其中「提案无人评审」与「问题没逐条作答」两条属于开会纪律'
  + '（E_PROPOSAL_UNREVIEWED / E_QUESTIONS_UNANSWERED）：'
  + '板子上 proposal → review → implementation 的先后关系与例外，见 team_board，这里不复述。',
  /* ── 判断"做完没有"的方法（第 19 轮 task-11）─────────────────────────────
   *
   * 这一条与上面那句「别把『报告里没提』读成『查过没问题』」是同一类知识：
   * **怎么在没有可靠消息的情况下读出一个可信结论**。所以写在一起，读着才顺。
   *
   * 为什么它必须写在交付判定这个工具里：判定时最容易犯的错就是把"没报告"
   * 读成"没做"。实测撞过——三条任务其实已经做完，看板上却全是 pending，
   * 本工具如实报 E_TASK_INCOMPLETE：**判得完全正确，是人没更新单据。**
   * 唯一的真相源在说谎，而它说的不是"没做"，是"我不知道做完了"。 */
  '成员可能被环境中断（发一句「继续」就能让它接着干），所以判断「它到底做完没有」不要看有没有消息：',
  '先看盘再看进程——看相关文件的 mtime，再跑那个文件对应的测试。',
  '测试绿了 = 活已经干完了（可能只是没来得及报告）；红了再看是不是半截改动。',
  '对成员的要求：每完成一个可交付的小步就立刻落盘并更新任务状态，不要攒到最后——',
  '中途被中断时，磁盘上的东西才是唯一成果。',
  '（所以本工具报 E_TASK_INCOMPLETE 时，先去看盘：那常常是「人没更新单据」，不是「没做」。）',
].join('');

/** 参数：`tasks?` / `maxIssues?` / 两个审计输入（都可选）。同样不写 minimum/maximum（schema 子集不支持）。 */
const DELIVER_PARAMETERS = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description:
        '可选。宿主没有 Agent Teams 时，由调用方显式声明任务数组；结构与宿主 TeamTaskView 相同'
        + '（额外支持 delivery 需要的 kind / assignee / contract / reviewed / changedPaths）。'
        + '省略时从宿主任务板读取。',
      items: { type: 'object' },
    },
    maxIssues: {
      type: 'integer',
      description: '可选。阻断与警告**各自**最多显示几条，默认 20；范围由实现夹紧到 1–200。',
    },
    diffPaths: {
      type: 'array',
      description:
        '可选。工作区当前改动过的路径（相对工作区根）。显式传入即视为「我查过」——'
        + '传空数组意思是「查过，一个都没有」，与省略（不知道）**不是**一回事。'
        + '省略时 diff 对账不跑，报告会给出警告 E_AUDIT_UNWIRED。',
      items: { type: 'string' },
    },
    currentDigests: {
      type: 'object',
      description:
        '可选。路径 → 文件指纹。显式传入即视为「我查过」（空对象 = 查过且都不存在）。'
        + '省略时字节绑定不跑：E_BINDING_STALE / E_UNBOUND_ARTIFACT 这类结论会被降级为警告，'
        + '因为缺指纹时它们分不清「文件坏了」和「没查」。',
      additionalProperties: { type: 'string' },
    },
  },
  additionalProperties: false,
};

const DELIVER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    report: { type: 'string' },
    ok: { type: 'boolean' },
    blockerCount: { type: 'integer' },
    warningCount: { type: 'integer' },
  },
  required: ['report', 'ok', 'blockerCount', 'warningCount'],
};

const DELIVER_DEFAULT_MAX_ISSUES = 20;
const DELIVER_MAX_ISSUES_CEILING = 200;

/* ═══════════════════════════════════════════════════════════════════════════
 * D-1（第 12 轮）：审计输入的接线 —— 「不知道」不许冒充「查过了没问题」
 *
 * 事实（实测）：`canDeliver` 吃两个审计参数，而**宿主这一侧根本没有它们** ——
 * 插件拿不到工作区 diff，也拿不到文件指纹。原来的调用点只传 `{ team, tasks }`，
 * 模块就各自取了默认值：`diffPaths = []`、`currentDigests = {}`。后果是三层假话：
 *   - 空 `currentDigests` → 每个 present 的 artifact 都被判成"文件已经不在了"
 *     → 假 `E_BINDING_STALE`（blocker）；
 *   - 空 `currentDigests` → 绑定表恒空 → 每条 code-changing 任务的每个 changedPath
 *     都挂一条 blocker 级 `E_UNBOUND_ARTIFACT`；
 *   - 空 `diffPaths` → diff 对账那一段**什么都不说**（没条目就不报），
 *     于是"没查"在报告里长得像"查过，没问题"。
 *
 * 修法：调用点显式区分「已知为空」与「不知道」，并且把这件事印在报告里。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 审计未接线时的 warning 级 code。**绝不进 blockers**：它是"没跑"，不是"发现"。 */
const AUDIT_UNWIRED_CODE = 'E_AUDIT_UNWIRED';

/** 只有这两条结论是"缺 currentDigests"的产物：拿不到指纹时它们必然假红。 */
const AUDIT_DIGEST_CODES = ['E_BINDING_STALE', 'E_UNBOUND_ARTIFACT'];

/** 「宿主什么都不知道」：页面门禁（`gates`）永远用这一份。 */
const NO_AUDIT = { diffPaths: undefined, currentDigests: undefined, diffKnown: false, digestsKnown: false, declared: false };

/** 纯记录判定（宿主侧没有 lodash；这里只用一次，自己写比引依赖划算）。 */
function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 调用方声明的审计输入 → 显式三态。
 *
 * 返回的 `diffKnown` / `digestsKnown` 是"调用方到底有没有交底"，**与内容是否为空无关**：
 *   `diffPaths: []` + `currentDigests: {}` 是"我查过，一个都没有"（known，允许为空）；
 *   没有这两个键，或类型不对，就是"宿主不知道"（unknown）。
 * 这两种情况对结论的影响完全不同，所以分不出来就等于没修。
 *
 * @param {unknown} args 工具参数
 * @returns {{diffPaths: string[]|undefined, currentDigests: Record<string,string>|undefined, diffKnown: boolean, digestsKnown: boolean, declared: boolean}}
 */
function readDeclaredAudit(args) {
  const source = isPlainRecord(args) ? args : {};
  const hasDiffPaths = Object.prototype.hasOwnProperty.call(source, 'diffPaths');
  const hasDigests = Object.prototype.hasOwnProperty.call(source, 'currentDigests');

  let diffPaths;
  if (hasDiffPaths && Array.isArray(source.diffPaths)) {
    diffPaths = source.diffPaths.filter((path) => typeof path === 'string' && path !== '');
  }

  let currentDigests;
  if (hasDigests && isPlainRecord(source.currentDigests)) {
    currentDigests = {};
    try {
      for (const [path, digest] of Object.entries(source.currentDigests)) {
        if (typeof digest === 'string') currentDigests[path] = digest;
      }
    } catch {
      currentDigests = undefined; // 取值就炸（代理/getter）→ 当成没交底
    }
  }

  return {
    diffPaths,
    currentDigests,
    diffKnown: diffPaths !== undefined,
    digestsKnown: currentDigests !== undefined,
    declared: hasDiffPaths || hasDigests,
  };
}

/**
 * 判定结论 × 审计接线状态 → 可以印出来的结论。
 *
 * 两条硬规则（都为了"宁可说不知道，不许假装查过"）：
 *   1. `E_AUDIT_UNWIRED` **只进 warnings**：它是"这两项没跑"，不是一条发现；
 *   2. 缺 `currentDigests` 时，`E_BINDING_STALE` / `E_UNBOUND_ARTIFACT` 从 blockers
 *      降级为 warnings（缺输入时它们分不清"坏了"和"没查"），并**自己重算 ok**
 *      （模块的 ok 只看它自己产出的 blockers，降级之后不再成立）。
 *
 * 审计没接线时 `ok` 一定是 `false`：这种情况下"可以交付"这句话没有任何依据。
 */
function applyAuditWiring(verdict, audit) {
  const rawBlockers = Array.isArray(verdict?.blockers) ? verdict.blockers : [];
  const warnings = Array.isArray(verdict?.warnings) ? verdict.warnings.slice() : [];
  const blockers = [];
  let downgraded = 0;

  for (const issue of rawBlockers) {
    const code = foldText(issue?.code);
    if (audit?.digestsKnown === false && AUDIT_DIGEST_CODES.includes(code)) {
      warnings.push({
        code,
        taskId: issue?.taskId,
        message: `（审计未接线，本条无法与「没查」区分）${foldText(issue?.message)}`,
      });
      downgraded += 1;
      continue;
    }
    blockers.push(issue);
  }

  const missing = [];
  if (audit?.digestsKnown === false) missing.push('currentDigests（字节绑定没跑）');
  if (audit?.diffKnown === false) missing.push('diffPaths（diff 对账没跑）');
  if (missing.length > 0) {
    warnings.push({
      code: AUDIT_UNWIRED_CODE,
      message: `本次判定没有审计输入：${missing.join('、')}。缺这两项时产物绑定与改动对账都没有发生——`
        + '不要把「报告里没提」读成「已经查过没问题」。',
    });
  }

  return {
    ok: verdict?.ok === true && blockers.length === 0 && missing.length === 0,
    blockers,
    warnings,
    wired: missing.length === 0,
    downgraded,
  };
}

/** 一条 issue 消息里点名的任务 id（`任务 review-1 …` / `task impl-2 …`）。 */
const DELIVER_TASK_REF_RE = /(?:任务|task)\s+([A-Za-z0-9_][A-Za-z0-9_.:-]*)/;

/** 单条 issue 的正文上限。截断**只发生在正文尾部**：code 与 taskId 都在独立列里，永不丢。 */
const DELIVER_MESSAGE_CELL = 160;

/** 收起空白 + 去控制符，保证一条 issue 只占一行（否则一条消息能伪造出块标题）。 */
function foldText(value) {
  if (typeof value !== 'string') return value === undefined || value === null ? '' : String(value);
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按显示宽度截断（中文占 2 列），末尾补 `…`。这里只用于正文，不影响 code / taskId。 */
function clipText(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 一条 issue → 一行：`  CODE  [task-id]  正文`。
 *
 * `taskId` 优先取 issue 自带的（warnings 有 `taskId`），没有就从正文里认一个：
 * 派工书要求"每条至少带 code 和它点名的任务 id"，而 blockers 的
 * `{code, message}` 没有 taskId 字段——id 只在正文里。把它提到独立列，
 * 正文再怎么截断也不会把 id 截没。
 */
function formatIssue(issue) {
  const code = foldText(issue?.code) || 'E_UNKNOWN';
  const rawMessage = foldText(issue?.message);
  const ownId = foldText(issue?.taskId);
  const matched = ownId === '' ? DELIVER_TASK_REF_RE.exec(rawMessage) : null;
  const taskId = ownId !== '' ? ownId : matched === null ? '' : matched[1];
  const ref = taskId === '' ? '' : `[${taskId}] `;
  return `  ${code}  ${ref}${clipText(rawMessage, DELIVER_MESSAGE_CELL)}`.trimEnd();
}

/** 一个分组 → 行数组。空分组整段不打印（派工书 §二.3）。 */
function formatGroup(title, issues, maxIssues) {
  const list = Array.isArray(issues) ? issues : [];
  if (list.length === 0) return [];
  const shown = list.slice(0, maxIssues);
  const lines = [`${title}（${list.length}）`, ...shown.map(formatIssue)];
  const rest = list.length - shown.length;
  if (rest > 0) lines.push(`  …还有 ${rest} 条`);
  return lines;
}

/** 状态计数：`2 completed / 2 in_progress / 1 pending`（顺序固定，便于人眼比对）。 */
function formatStatusCounts(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    const status = foldText(task?.status) || 'unknown';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const order = ['completed', 'in_progress', 'claimed', 'pending', 'failed', 'cancelled'];
  const keys = [...counts.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a < b ? -1 : a > b ? 1 : 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return keys.map((key) => `${counts.get(key)} ${key}`).join(' / ');
}

/**
 * 声明块**缺席**时由插件层补发的码。解析层只发另外两个码
 * （`E_DECLARATION_UNKNOWN_KEY` / `E_DECLARATION_UNPARSEABLE`）：
 * 它连"要不要警告"都不回答，因为判断这件事需要 `writeScopes`，而那是任务字段。
 * 所以这三个码的发射点分别在两个模块里，**这不是漂移**，见 `contract.mjs:930-936`。
 */
const E_DECLARATION_MISSING = 'E_DECLARATION_MISSING';

/**
 * 用户在台账页把这个插件关掉了 → `execute` 层**结构化拒绝**的码（第 17 轮 task-20）。
 *
 * 为什么单独一个码，而不是复用现成的：
 *   - `E_HOST_UNSUPPORTED` 的意思是"**宿主**没有这个能力" —— 说的是环境，不是用户选择；
 *   - 权限类错误的意思是"**你**没资格" —— 说的是调用方；
 *   - 这个码说的是"**用户**不让你用"。三件事的责任人不同，糊成一个码，
 *     读错误的人就会去查错方向（去查宿主能力、去查权限），而真相是"去把开关打开"。
 */
const E_USER_DISABLED = 'E_USER_DISABLED';

/**
 * 造一个"用户关闭了这个插件"的拒绝错误。
 *
 * 形状与 `adapter.mjs` 的 `unsupported()` 同口径（`Error` + `.code`），
 * 因为这是同一类东西：**这次调用无法被满足**，而且原因必须一眼看懂。
 *
 * 为什么是**抛**、不是返回一个 `{ok:false}` 对象：
 *   两个工具的输出 schema 都是 `additionalProperties:false` 且字段全 required。
 *   返回一个"拒绝对象"只有两条路：破坏 schema，或者伪造一段看起来正常的
 *   `board` / `report` 文本 —— 后者正是"伪造一个看起来正常的结果"，任务书明令禁止。
 *   更要紧的是：`{ok:false}` 会被读成"**判定**为不可交付"，而这里的真相是
 *   "**根本没有判定**"。这两件事在同一个字段上共用一个值，就是这个项目最忌讳的那种混淆。
 *   抛错则不可能被读成结论（既有 `E_HOST_UNSUPPORTED` 也是这么处理的）。
 *
 * @param {string} toolName 哪个工具被拒
 * @returns {Error & {code: string}}
 */
function userDisabledError(toolName) {
  const error = new Error(
    `${toolName} 已被**用户**在台账页关闭，因此这次没有执行任何判定：`
    + '这是用户的选择，不是你没有权限，也不是宿主/服务出故障。'
    + '要恢复，请让用户在台账页把开关打开。'
    + `（${E_USER_DISABLED}）`,
  );
  error.code = E_USER_DISABLED;
  return error;
}

/**
 * 解析层的"读不懂"码。这里只用它**判断**（块写坏了就不再叠发 MISSING），不发射它：
 * 发射点是 `contract.mjs:951`（`unparseableDeclaration`），那是唯一该报它的地方。
 */
const E_DECLARATION_UNPARSEABLE = 'E_DECLARATION_UNPARSEABLE';

/**
 * 会议账本读不出来时的那一条码（P2-3）。
 *
 * 与上面两条**同一做法**：`codes.mjs` 不按码名导出常量（它导出的是表 ——
 * `MEETING_CODES` / `MEETING_BLOCKER_CODES` / `isMeetingCode` …），所以
 * `import { E_LEDGER_PARTIAL } from '../src/codes.mjs'` 拿到的是 `undefined`：
 * 那不是"少了一个副本"，而是**发射一个没有名字的码**，页面上每一行都变成"未知门禁"。
 * 所以发射端各留一份字面量，`codes.test.mjs` 6a 正是靠扫这些字面量查"发射了但没登记"。
 *
 * 这个码已登记（blocker / batch 2）。`ledger.mjs` 里有同一份字面量，两处都靠在
 * 那条扫描下 —— 谁改名字谁红，不靠记性。
 */
const E_LEDGER_PARTIAL = 'E_LEDGER_PARTIAL';

/**
 * 往任务树写账本失败时的那一条码（P2-4）。
 *
 * 与上面几条同一做法：`codes.mjs` 不按码名导出常量，发射端各留一份字面量，
 * `codes.test.mjs` 6a 靠扫这些字面量查"发射了但没登记"。这个码已登记（blocker / batch 2）。
 *
 * **这条码存在的全部理由，是"写失败绝不许被翻译成重发"**：账本没记上不等于阶段没跑，
 * 而重发会让同一个阶段执行两次、账本只记第二次 —— 那是一次无法从账本上复原的事故。
 */
const E_LEDGER_WRITE_FAILED = 'E_LEDGER_WRITE_FAILED';

/**
 * `mapped.contract` 是否已经有**可用的**宿主值。
 *
 * 口径与 `contract.mjs` 的 `contractOf` 对齐：非对象、`null`、`{}` 一律算"未声明"
 * （`contractOf` 对这三种都回落到任务顶层）。所以声明块**可以**填进一个空的 `{}`——
 * 否则宿主给个 `{}` 就等于把声明块静默吃掉，那正是 D-14 要消灭的 fail-open。
 * 读到一半抛错时返回 `true`（"宿主给了东西"）：宁可不填，也不许覆盖。
 */
function hasUsableContract(value) {
  if (value === null || typeof value !== 'object') return false;
  try {
    return Object.keys(value).length > 0;
  } catch {
    return true;
  }
}

/**
 * 宿主 `TeamTaskView` → delivery 的 task 形态。
 *
 * **两件事**：
 *   1. `ownerName → assignee`（`delivery.mjs` 两处明文要求插件层灌入）；
 *   2. **D-14**：解析 `task.description` 里的 `team-board` 声明块，把 `kind` 与契约字段
 *      填进来。真实 TeamTaskView 是 `.strict()` 十个字段，**没有 kind**；不填的话，
 *      `gates.mjs` / `delivery.mjs` 里那几十处按 kind 分流的地方全部走"不知道"分支，
 *      `evaluateCompletion()` 会对一条什么都没判的任务返回 `{ok:true, errors:[]}`。
 *
 * 三条取值纪律：
 *   - **宿主优先**：`mapped.kind` / `mapped.contract` 已有可用值时一律不覆盖
 *     （将来宿主真给了 kind，声明块不许把它盖掉）；
 *   - `warnings` 挂着带出去（`mapped.declarationWarnings`），让 `formatDelivery` 印出来。
 *     **一条没有任何地方印出来的警告码等于没接**——这个项目在这种"写了没人看"上栽过；
 *   - **不 try/catch 整个函数**：任务对象自身的 getter 抛错必须原样冒到调用方
 *     （第 43 条测试钉住"宁可报错，也不许给一个可以交付"）。"一条烂描述不许拖垮整块板"
 *     这条由 `parseDeclaration` 的**永不抛错**保证；在这里再补一层兜底会掩盖那个契约
 *     被破坏的事实（它的测试也就白写了）。
 *
 * **为什么导出**：D-14 的核心断言必须能"喂一个真实宿主形状 → 拿到映射结果 →
 * 交给 `gates.evaluateCompletion`"，而那条链的起点就是这里。不导出的话，测试只能
 * 隔着两个工具去间接验证，验不到"kind 有没有真的被填上"这件事本身。
 */
export function mapHostTask(task) {
  if (task === null || typeof task !== 'object') return task;
  const mapped = { ...task };
  const owner = task.ownerName;
  if ((mapped.assignee === undefined || mapped.assignee === '') && typeof owner === 'string' && owner !== '') {
    mapped.assignee = owner;
  }

  /* ── D-14：把 description 里的声明块接进判定 ───────────────────────────── */
  const declaration = parseDeclaration(task.description);
  /** 三种返回形状的判别式：**只有"找到块"才会有 `contract` 键**（可能是 `{}`）。 */
  const hasBlock = declaration.contract !== undefined;

  const declaredKind = declaration.kind;
  const currentKind = mapped.kind;
  if (
    (currentKind === undefined || currentKind === null || currentKind === '')
    && typeof declaredKind === 'string'
    && declaredKind !== ''
  ) {
    mapped.kind = declaredKind;
  }
  if (hasBlock && !hasUsableContract(mapped.contract)) {
    mapped.contract = declaration.contract;
  }

  /* 数组是**副本**（只为了能在末尾追加 `E_DECLARATION_MISSING` 而不改别人的返回值）；
   * 元素仍是同一批 warning 对象，所以"原样"体现在元素上。 */
  const warnings = Array.isArray(declaration.warnings) ? [...declaration.warnings] : [];

  /* `E_DECLARATION_MISSING` 的发射条件：**`writeScopes` 非空、且真的没有块**。
   *
   * 两个例外都是有意的：
   *   - 写域为空 → **不发**。读文档、跑调研这类活本来就没有 kind，按着头要声明是噪声。
   *   - 块**写坏了**（未闭合等）→ **不发**，只留 `E_DECLARATION_UNPARSEABLE`。
   *     那个码已经点名了真正的原因（第 N 行没闭合），再叠一条"缺声明"会把人引去
   *     补一个其实已经写了、只是写坏了的块。两个码各管一种原因，不重复计账。
   *     判据是"解析结果里带了 UNPARSEABLE" —— 两码的发射点本来就在两个模块，
   *     这里引用它的码名而不重跑一遍解析，见 `contract.mjs:930-936` 的注释。 */
  const scopes = Array.isArray(task.writeScopes) ? task.writeScopes : [];
  const unparseable = warnings.some((warning) => warning?.code === E_DECLARATION_UNPARSEABLE);
  if (!hasBlock && !unparseable && scopes.length > 0) {
    const shown = scopes.filter((item) => typeof item === 'string' && item.trim() !== '').join(' ');
    const where = shown === '' ? `${scopes.length} 条写域` : shown;
    warnings.push({
      code: E_DECLARATION_MISSING,
      message: `任务有写域（${where}）但 description 里没有 team-board 声明块：`
        + '它不会被判成实现还是评审，质量门禁对它一条都判不动（判定会 fail-open）',
    });
  }
  mapped.declarationWarnings = warnings;

  /* ── task-18：成员自己申报"我改了哪些文件" ──────────────────────────────
   *
   * **字段名是 `declaredChanges`，不是 `changedPaths`**，二者永不合流：
   *   - `changedPaths` 是 `delivery.mjs` 的**审计输入**，要与真实 diff 双向对账
   *     （`E_UNREPORTED_CHANGES` / `E_CHANGED_PATHS_REQUIRED` / 越界判定全靠它）；
   *   - `declaredChanges` 是**成员自己说的**，一个字都没被核实。
   * 把它们并进同一个字段，"我自己说改了 3 个文件"就会被下游读成
   * "已核实确实改了这 3 个文件"——那正是本项目一整晚在治的病。
   *
   * **没申报就不带这个键**（不是 `[]`）：`Object.hasOwn(mapped,'declaredChanges') === false`
   * 表示"这条任务没有报告过改动"，与"报告了零个改动"是两件事。下游据此区分
   * "没交报告"和"交了报告说没改"。 */
  const declaredChanges = changeReportOf(declaration.changed);
  if (declaredChanges !== undefined) mapped.declaredChanges = declaredChanges;

  return mapped;
}

/**
 * `declaration.changed` → `declaredChanges`（只保留非空字符串）。
 *
 * 三种输入 -> 两种结果，分界就是"有没有交报告"：
 *   - 不是数组（没申报）→ `undefined`（调用方据此**不挂这个键**）；
 *   - 数组 → `string[]`（可能是 `[]`：申报了但一条有效路径都没有，那也是"交了报告"）。
 *
 * 为什么在 host 侧再过一道：`parseDeclaration` 只保证"非空字符串逐条收进来"，
 * 而这里要保证的是**输出类型契约**（`declaredChanges: string[]`），那是本层的责任。
 * 不猜、不修路径：路径合法性归 `delivery.mjs` 的审计判定，这一层只是搬运申报。
 */
function changeReportOf(value) {
  if (!Array.isArray(value)) return undefined;
  const list = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text !== '') list.push(text);
  }
  return list;
}

/**
 * 批量版 `mapHostTask`：**保持非数组输入原样返回**。
 *
 * 三个取数点（`team_board` 工具、`gates` 页面、`team_deliver`）都不能因为宿主
 * 给了个非数组就换成 `[]`——"读不出来"与"一条任务都没有"必须可分辨（本项目红线），
 * 而 `listTasks` 真返回怪东西时，让下游按它原本的形态去处理/报错才是诚实的。
 */
function mapHostTaskList(tasks) {
  return Array.isArray(tasks) ? tasks.map(mapHostTask) : tasks;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 第 14 轮：结构化 `tasks` —— 让页面那块任务板真的能渲染出来
 *
 * 事实：`plugin/client.js:562` 的 `boardRows()` 早就写了一整套结构化任务板
 * （表头 ID/类型/状态/标题/归属 + 行 + `@name` 变灰 + 徽章 + 依赖/警告/写域标记 +
 * max-height 内部滚），它自己那边有一整套断言守着。但它**只在 payload 里有 `tasks`
 * 时才被调用**；而两条 payload（`team_board` 的返回值、页面的 `gates()`）里一直没有
 * 这个字段 —— 于是页面永远走降级路径，显示「宿主没有提供结构化任务数据」。
 * **代码写了、测了、线上走不到。**
 *
 * 这个项目在"写了但没接上线"上栽过不止一次（`E_NO_ARTIFACT_BINDING` 记了七轮账、
 * 输出里一次都没出现过；`E_AUDIT_UNWIRED` 最初也没有发射点）。所以两条路径一起加：
 * 只加一条等于没加。这一段**只加字段**，`renderBoard` 的文本输出一个字不动。
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 同一个人。
 *
 * **身份规则仍然只有一份实现**：`contract.normalizeIdentity`（SD-2）。这里只写比较，
 * 不写规范化，口径与 `board.mjs:522-526` 的私有 `samePerson()` 逐条相同：
 * 两侧都规范化、**空串不等于空串**（"没有归属"与"另一个人没有归属"不是同一个人）。
 *
 * 为什么不 import board 的那个：它是私有的（`board.mjs` 只导出 `renderBoard`），
 * 而 `board.mjs` 不在本任务的写域里。真正会被"抄成第二套"的是规范化规则，
 * 而那一条仍然只有 `normalizeIdentity` 一个实现。
 */
function samePerson(rawA, rawB) {
  const a = normalizeIdentity(rawA);
  const b = normalizeIdentity(rawB);
  return a !== '' && a === b;
}

/**
 * 一条映射过的任务 → payload 里的一行。非对象返回 `undefined`（它连 id 都给不出）。
 *
 * 四条纪律，每条都对应过一次事故：
 *
 * 1. **`kind` 读不出来就不给这个键。** `mapped.kind` 只有"声明块写了"或"宿主自带"才有。
 *    这里**绝不**塞 `'unknown'`：那是 `board.mjs` 的 `describeKind()` 产出的**显示占位符**
 *    （板上写 `?`），不是宿主声明的类型。把它当数据传出去，等于把"没声明"伪装成一个
 *    合法的 kind 值 —— 页面上的「未声明」徽章（`client.js:518` 按 falsy 判）就再也不会出现，
 *    而"谁该去补声明"这个唯一可行动的信号就此消失。
 *
 * 2. **原样透传，不判定、不清化、不重算。** `status` / `subject` / `owner` / `scopes` /
 *    `blockedBy` / `warnings` 一律照字段搬。这里若顺手 `clean()`（`board.mjs` 那个会把
 *    `@`→`＠`、截断到列宽），页面与文本板就会显示**不同的字符串**，而两份数据同源的
 *    唯一可验证证据就是"内容一致"。净化是渲染层各自的事（board 有 `clean()`、
 *    页面有 `sanitizeLabel()`）。
 *
 * 3. **三个数组字段只保证"是数组"**：宿主给非数组（畸形）时给 `[]`。
 *    不学 `board.mjs` 的 `describeBlockers()` 把单值包成一条依赖 —— 那是**渲染层**
 *    对畸形的宽容解释，payload 是数据面，不替宿主解释。数组做浅拷贝：调用方改
 *    payload 不许改到宿主对象上。
 *
 * 4. **`mine` 走身份轴**（`samePerson` → `normalizeIdentity`），与板上的 `@me` 同一个判据。
 *    注意它**不是**"ownerName 长得像 me"：`'@a'` 与 `'＠a'` 不是同一个人（SD-2）。
 *
 * @param {object} task 已过 `mapHostTask` 的任务
 * @param {string} me 宿主解析出来的调用者名字（**只来自 membership**）
 * @returns {object|undefined}
 */
function projectPayloadTask(task, me) {
  if (task === null || typeof task !== 'object') return undefined;
  /* 单条读不出来（getter/代理抛错）不许拖垮整块：与 `renderBoard` 的逐条隔离同口径。
   * 板上会由 `renderBoard` 自己留一行 `…N 条任务读取失败` 的痕，所以这里跳过不留痕 ——
   * 留两处痕会让同一条坏数据看起来像两次故障。 */
  try {
    const entry = {
      id: typeof task.id === 'string' ? task.id : '',
      status: typeof task.status === 'string' ? task.status : '',
      subject: typeof task.subject === 'string' ? task.subject : '',
      owner: typeof task.ownerName === 'string' ? task.ownerName : '',
      mine: samePerson(task.ownerName, me),
      scopes: Array.isArray(task.writeScopes) ? task.writeScopes.slice() : [],
      blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.slice() : [],
      warnings: Array.isArray(task.writeScopeWarnings) ? task.writeScopeWarnings.slice() : [],
    };
    /* 纪律 1：只有真值才给键。空串也算"没声明"（声明块的解析器不会产出空串，
     * 但宿主自带的 kind 可能是），于是这里与 `mapHostTask` 的取值口径一致。 */
    if (typeof task.kind === 'string' && task.kind !== '') entry.kind = task.kind;
    /* task-18：成员**自己申报**的改动。只有真申报过（`mapHostTask` 只在这种情况下
     * 才挂这个键）才原样带出去 —— **绝不在这里补 `[]`**：
     * "没申报"与"申报了零个改动"是两件事，`client.js:1833` 对两者的画法也不同
     * （不存在/非数组/空数组都"什么都不画"，但那是因为它另一种情况本来就无从画起；
     * 数据层不许把区别抹掉，抹掉之后想区分就再也没机会了）。
     * copy 一份：payload 是**出站**数据，不许让下游拿到一个能改到任务对象的引用。 */
    if (Array.isArray(task.declaredChanges)) entry.declaredChanges = task.declaredChanges.slice();
    /* P0（第 15 轮）：声明块的问题**必须到页面上**。
     *
     * 这一条原来只在 `formatDelivery`（工具路径）里印，页面这条路径把它丢了。
     * 后果实测：存量 21 条真实任务出 23 个阻断，其中 **14 个是「没有声明块」** ——
     * 也就是页面最爱报的那条原因，恰恰是页面上唯一看不见的那条。用户在页面上
     * 看到"该任务判不动"，在工具里才看得到"因为 description 里没写 team-board 块"。
     *
     * **不发 `description` 原文，只发解析结果。** 三个理由：
     *   1. 原文无界（用户可控，可以几 MB），而解析结果是有限几条 code+message；
     *   2. 声明块已经由宿主侧 `parseDeclaration` 解析成 `kind` / `contract` /
     *      `declaredChanges` —— 再把原文发到客户端，等于让客户端有机会长出**第二份解析器**，
     *      两份必然分叉，而分叉时没人知道该信哪份；
     *   3. 与 `declaredChanges` 同一条纪律：出站的是**判定用得到的事实**，不是原始材料。
     * 如果以后页面上真要展示原文，正确做法是宿主再开一个显式字段，
     * 而不是顺手把 unbounded 的字符串塞进每一条 task。
     *
     * 非数组 / 空数组 → 不带这个键（与 `declarationWarnings` 的产生口径一致：
     * `mapHostTask` 只在真有警告时才有内容，空数组就是"块写得没问题"）。 */
    if (Array.isArray(task.declarationWarnings) && task.declarationWarnings.length > 0) {
      entry.declarationWarnings = task.declarationWarnings.slice();
    }
    return entry;
  } catch {
    return undefined;
  }
}

/**
 * 一批映射过的任务 → payload 的 `tasks`。
 *
 * **非数组一律返回 `undefined`（调用方据此不挂这个键）**：宿主给了怪东西时
 * "读不出来"与"一条任务都没有"必须可分辨（本项目红线），而 `[]` 会被页面读成
 * 「板上没有任务（读到了，就是零）」。这条与 `mapHostTaskList` 的"非数组原样返回"同源。
 *
 * @param {unknown} tasks 调用方**刚刚喂给 `renderBoard` 的那个数组**（不许二次取数）
 * @param {string} me 同一次取数里的 `membership(agent).name`
 * @returns {Array<object>|undefined}
 */
function projectPayloadTasks(tasks, me) {
  if (!Array.isArray(tasks)) return undefined;
  const out = [];
  for (const task of tasks) {
    const entry = projectPayloadTask(task, me);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

/**
 * `gates.evaluateCompletion` **真的会判**哪些 kind。
 *
 * 这个集合是**从源头派生**的，不是手抄的：`gates.mjs` 里只有两个分支 ——
 * `isQuality = QUALITY_KINDS.includes(kind)` 与 `isWork = kind === 'work'`。
 * 不在两者之内的 kind（`proposal`）和**没有 kind** 的任务，gates 一条都不看。
 *
 * 为什么这个集合必须显式存在：`evaluateCompletion` 对一条什么都没判的任务返回
 * `{ ok: true, errors: [] }`（`host/index.js` 1674 行那段注释也记着这件事）。
 * 也就是说「判了、全过」和「压根没判」在返回值上**逐字相同**。
 * 实测代价：21 条真实形状的任务里有 18 条没有 kind，shadow 只看码数会报
 * 「9 条码」而把另外 18 条读成"没问题" —— 那是 fail-open，正是本项目最不能犯的错。
 * 所以 shadow 必须把"判不动的条数"当成一等公民报出来，而不是让零码自己说话。
 *
 * 派生方式：`KINDS` 是唯一真相（四个 kind），从中过滤出 gates 真会看的那几个。
 * 直接写 `['implementation','review','work']` 会造出第四份副本，`contract.test.mjs`
 * 的闭合扫描会抓。`'work'` 这一个字面量没法从别处派生 —— 它就是 gates 自己的分支条件。
 */
const GATES_JUDGED_KINDS = Object.freeze(
  KINDS.filter((kind) => QUALITY_KINDS.includes(kind) || kind === 'work'),
);

/**
 * P0（第 15 轮）：`gates.mjs` 的两态 shadow 结论。
 *
 * **它永远不参与判定。** `ok` / `blockers` / `warnings` 全部与它无关 ——
 * 这里返回的每一个码只说明"如果把 gates 切到 enforce，它会对这条任务说什么"。
 *
 * 四个必须同时成立的设计约束：
 *
 * 1. **不许抛**。一条任务把 gates 弄炸了，不许让整页门禁 unavailable ——
 *    那正好是本项目反复在治的病：局部读不出来被放大成整体不可用。
 *    所以逐条 try/catch，失败进 `skipped`（reason:'threw'）。
 *    这里**不发明错误码**：一个"shadow 自己炸了"的码会混进真正的门禁码集合里，
 *    让"存量阻断数"这个验收指标失去意义。
 *
 * 2. **必须报输入交了哪几项**（`inputs`）。宿主这一侧没有 payload / receipts /
 *    diffPaths / meta（`host/index.js` 1407 行那段已查实），四项全缺时 gates 的结论是
 *    "判不动"。不报输入状态，一屏"零个码"会被读成"全部通过"。
 *
 * 3. **必须报"判不动的条数"**（`judgedTasks` / `skippedTasks` / `skipped`）。
 *    理由见 `GATES_JUDGED_KINDS` 上方那段 —— 零码有两种成因，混在一起就是 fail-open。
 *
 * 4. **三态不许合并**（`status`）：
 *      'empty'       → **判过至少一条**，且一条码都没有（这是结论）
 *      'ok'          → 判过，有码
 *      'unavailable' → 一条都没判成（没任务 / 全都没有 kind）——**不许说成 empty**
 *
 * 5. **会议任务从两个分母里显式排除**（`meetingTasks`，P2-3）。
 *    会议任务的 `description` 里放的是账本围栏，不是 `team-board` 声明块：它们没有
 *    `kind`、没有契约，`evaluateCompletion` 对它们只能返回 `{ok:true, errors:[]}`。
 *    留在分母里会让"判了 N 条、零个码"这个结论被一堆**本来就判不了**的任务冲淡。
 *    所以它们被移出 `judgedTasks` 与 `skipped`，单独计数 —— **显式排除，不是静默跳过**：
 *    静默跳过会让读的人以为板上只有那么几条任务。
 *    判据用 `ledger.mjs` 的 `isMeetingTask`（**不许在这里重写一份**：抄判据 = 又一个
 *    漂移源，那正是本项目反复栽的坑）。
 *
 * 6. **两个分母不许合并**（`judgedTasks` 与 `withInput`，P2-3）。
 *    进入判定的条数（`judgedTasks`）不等于**真拿到输入的条数**（`withInput`）：
 *    `evaluateCompletion` 的 `ok` 是"一条错都没发"，于是"六关全核过、都没问题"与
 *    "六关没一关拿得到输入"字节相同。`judgeCoverage(input).judged` 才是"到底核没核"。
 *    两个数分开报，读的人才能看出"判了 3 条"里到底有几条真的核过东西。
 *
 * @param {unknown} tasks 已过 `mapHostTask` 的任务（可能不是数组）
 * @returns {{status: string, mode: string, reason?: string, inputs: object,
 *            rows: Array<object>, skipped: Array<object>,
 *            judgedTasks: number, skippedTasks: number, meetingTasks: number,
 *            failedTasks: number, totalTasks: number, withInput: number}}
 */
export function shadowCompletion(tasks) {
  if (!Array.isArray(tasks)) {
    return {
      status: 'unavailable',
      mode: 'shadow',
      reason: 'tasks',
      inputs: { payload: false, receipts: false, diffPaths: false, meta: false },
      rows: [],
      skipped: [],
      judgedTasks: 0,
      skippedTasks: 0,
      meetingTasks: 0,
      failedTasks: 0,
      totalTasks: 0,
      withInput: 0,
    };
  }

  const rows = [];
  const skipped = [];
  let failedTasks = 0;
  let judgedTasks = 0;
  /** 会议任务条数：被**移出分母**的，单独数出来（约束 5）。 */
  let meetingTasks = 0;
  /** 进了判定、且 `judgeCoverage` 说真的核过东西的条数（约束 6）。 */
  let withInput = 0;

  for (const task of tasks) {
    const taskId = typeof task?.id === 'string' ? task.id : '';
    const kind = typeof task?.kind === 'string' ? task.kind : '';

    /* 会议任务**先**排除。顺序有意义：它通常也没有 kind，若放到下面那两条判据之后，
     * 它会以 `no-kind` 的名义落进 `skipped` —— 计数看着像"判不动"，实际上它压根不属于
     * 这套门禁的判断对象。两种"不是它的事"必须分开报。 */
    if (isMeetingTask(task)) {
      meetingTasks += 1;
      continue;
    }

    /* 先判"这条会不会被判"。不判的进 skipped 并写清原因 ——
     * 静默跳过是这份实现里最容易重演的错误。 */
    if (kind === '') {
      skipped.push({ taskId, reason: 'no-kind' });
      continue;
    }
    if (!GATES_JUDGED_KINDS.includes(kind)) {
      skipped.push({ taskId, reason: 'kind-not-judged', kind });
      continue;
    }

    try {
      /* 四项输入全部**显式**给空值，而不是省略：
       * 省略会让 gates 走 `input = {}` 的默认分支，"没交"与"交了空"在语义上都成立，
       * 但写出来才能让读这段代码的人确信这是有意的、而不是漏传。 */
      const gateInput = {
        task,
        meta: {},
        payload: {},
        receipts: [],
        diffPaths: undefined,
      };
      const verdict = evaluateCompletion(gateInput);
      judgedTasks += 1;
      /* 第二个分母（约束 6）：这一条到底有没有真拿到输入。
       * 只认 `judged === true` —— 拿 `ok === true` 去数，就是把"没查也算绿"请回来。 */
      if (judgeCoverage(gateInput).judged === true) withInput += 1;
      const errors = Array.isArray(verdict?.errors) ? verdict.errors : [];
      for (const error of errors) {
        const code = typeof error?.code === 'string' ? error.code : '';
        if (code === '') continue; // 无码的条目进 shadow 就没法解释，宁可不进
        rows.push({
          taskId,
          code,
          message: typeof error?.message === 'string' ? error.message : '',
        });
      }
    } catch (error) {
      /* 炸了就计数 + 记一条 skipped，不伪造门禁码 —— 理由见上面第 1 条。 */
      failedTasks += 1;
      skipped.push({
        taskId,
        reason: 'threw',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /* 状态：**一条都没判成**绝不是 'empty'。这是整组的红线。 */
  let status;
  let reason;
  if (judgedTasks === 0) {
    status = 'unavailable';
    reason = tasks.length === 0 ? 'no-tasks' : 'no-judged';
  } else {
    status = rows.length === 0 ? 'empty' : 'ok';
  }

  return {
    status,
    mode: 'shadow',
    ...(reason === undefined ? {} : { reason }),
    inputs: { payload: false, receipts: false, diffPaths: false, meta: false },
    rows,
    skipped,
    judgedTasks,
    skippedTasks: skipped.length,
    meetingTasks,
    failedTasks,
    totalTasks: tasks.length,
    withInput,
  };
}

/**
 * 账本槽位的统一形状（四态共用）。
 *
 * 所有分支都必须带齐这几个键，否则消费方要为每个状态写一套取法 ——
 * 而"取不到就 undefined"正是最难看的第三种形态：渲染器不特判就静默显示成什么都没有。
 *
 * `readable` 的判据是**白名单**（只有 `'none'` / `'ok'` 为真），不是把某个状态排除掉：
 * 将来多一种"读不出来"，白名单会让它自动落到 `false`，黑名单会让它悄悄继承 `true`。
 *
 * @param {{state: string, reason?: string, meeting?: object|null, cards?: unknown,
 *          codes?: unknown, stages?: number, errors?: number, warnings?: number,
 *          meetingTasks?: number|null}} fields
 */
function ledgerSlot(fields) {
  const state = fields.state;
  return {
    state,
    /* `readable:true` 的意思**只是**"这件事我读得出来"，不是"账本可用"。
     * 在 `'none'` 上它说的是"板上有没有围栏，我数得出" —— 所以 `'none'` 是**结论**，
     * 不是失败。若有人拿 `readable` 当"账本可用"用，会在 `'none'` 上判出
     * "可用但没有"，那是把两件事读成了一件。 */
    readable: state === 'none' || state === 'ok',
    reason: typeof fields.reason === 'string' && fields.reason !== '' ? fields.reason : null,
    /* 只在"抛了"这一种情形有值。放在统一形状里而不是临时补一个键：
     * 四态字段完全一致，消费方才只需要写**一套**取法；少一个键就得特判一次。 */
    message: typeof fields.message === 'string' && fields.message !== '' ? fields.message : null,
    meeting: fields.meeting === undefined ? null : fields.meeting,
    cards: Array.isArray(fields.cards) ? fields.cards : [],
    codes: Array.isArray(fields.codes) ? fields.codes : [],
    counts: {
      stages: typeof fields.stages === 'number' ? fields.stages : 0,
      cards: Array.isArray(fields.cards) ? fields.cards.length : 0,
      errors: typeof fields.errors === 'number' ? fields.errors : 0,
      warnings: typeof fields.warnings === 'number' ? fields.warnings : 0,
    },
    /* **`null` 是"没数过"，`0` 是"数过、是空的"。** 两者不许合并：
     * 写 `0` 等于宣称"板上没有会议"，而在那些路径上我们压根没拿到任务列表。
     * 这与「空 ≠ 不可用」是同一条纪律 —— `0` 是断言，`null` 是承认没数过。 */
    meetingTasks: Number.isSafeInteger(fields.meetingTasks) ? fields.meetingTasks : null,
  };
}

/**
 * 第四态：`'unavailable'` —— 门禁整体起不来，会议账本这一块也**不许是 `undefined`**。
 *
 * `gates()` 有三条 unavailable 出口（`renderer` 拿不到 Agent Teams / 这个会话没有活着的
 * Agent / 整段取数抛了）。旧的无状态出口是 `{status:'unavailable', reason}`，
 * 里面**没有 `ledger` 键** —— 页面若写 `payload.gates.ledger.state` 会取到 `undefined`。
 *
 * `undefined` 是第三种最难看的形态：它既不是"空"（`'none'`）也不是"不可用"
 * （`readable:false` 的 `'unreadable'`），渲染器不特判就静默显示成什么都没有 ——
 * 那正是红线禁的那条，只是换了个入口。
 *
 * 与 `'unreadable'` 的分界：成因不同。`'unreadable'` 是"拿到了任务列表，但账本块读坏了"；
 * `'unavailable'` 是"连门禁都起不来，账本这件事根本没轮到"。所以两者**不许合并**。
 *
 * @param {string} reason 与 `gates()` 那条出口的 reason **同一个值**，不另造词
 */
function ledgerUnavailable(reason) {
  return ledgerSlot({ state: 'unavailable', reason });
}

/**
 * 会议账本 → `payload.ledger`（P2-3）。
 *
 * ## 三态，而且**三态在字段上就分得开**
 *
 * | state | readable | reason | meetingTasks | meeting | cards |
 * |---|---|---|---|---|---|
 * | `'none'`       | `true`  | `null`            | `0` | `null`  | `[]` |
 * | `'ok'`         | `true`  | `null`            | `≥1`| 账本对象 | 卡片 |
 * | `'unreadable'` | `false` | 读不出来的成因     | `≥1`| `null`  | 可能非空 |
 * | `'unavailable'`| `false` | **门禁出口的 reason**（同一个值） | `null` | `null` | `[]` |
 *
 * **为什么必须这样分**：`ledgerFromTasks` 在"板上一条会议块都没有"时**故意**返回
 * `ledger:null` + `E_LEDGER_PARTIAL`，理由写在它文件头 —— 它拒绝把"读不出来"说成
 * "还没开始"。那个拒绝是对的：在**它那一层**分不清"零块"与"块读坏了"以外的情形。
 * 但到了宿主这一层，"板上到底有没有一条账本围栏"是**读得出来的事实**（`isMeetingTask`
 * 逐条看围栏在不在，不依赖解析成功）。所以：
 *
 *   - `meetingTasks === 0` → `'none'`：**这是结论**，不是失败。信息是完整的。
 *   - 有围栏但 `ledger === null` → `'unreadable'`：信息**不**完整，`readable === false`。
 *
 * 判据绝不许写成"码列表为空就是没有会议"：`'ok'` 也可能带码（账本里有东西没落地 →
 * `E_LEDGER_DROPPED`）。用码当判据等于把"有毛病"读成"没开会"。
 *
 * ## 为什么 `readable` 与 `state` 都留着
 * 单看 `state` 就够用，但消费方（页面）最容易写出的错法是 `if (!ledger) 显示"还没开始"`。
 * `state` 是给人读的，`readable` 是给**代码**读的：`readable === false` 这一条能让
 * "不许渲染成空态"变成一个可直接断言的布尔，而不是一句注释。
 *
 * @param {unknown} tasks 已过 `mapHostTask` 的任务（可能不是数组）
 */
export function ledgerPayload(tasks) {
  const list = Array.isArray(tasks) ? tasks : null;

  /** 统一形状见模块级的 `ledgerSlot`：四态共用一张形状表，这里不再抄一份。 */
  const slot = ledgerSlot;

  if (list === null) {
    /* 拿不到任务列表 ⇒ **从来没数过**围栏，所以 `meetingTasks: null` 而不是 `0`。 */
    return slot({
      state: 'unreadable',
      reason: 'tasks-unreadable',
      codes: [E_LEDGER_PARTIAL],
      errors: 1,
      meetingTasks: null,
    });
  }

  /* 先数围栏，再解析。顺序有意义：`'none'` 这个结论只能由"围栏一条都没有"得出，
   * 不能由"解析结果里没有 ledger"反推 —— 后者把"块读坏了"也归进"没有"。 */
  let meetingTasks = 0;
  for (const task of list) {
    if (isMeetingTask(task)) meetingTasks += 1;
  }

  if (meetingTasks === 0) {
    return slot({ state: 'none', meetingTasks: 0 });
  }

  const projected = ledgerFromTasks(list);
  const codes = [];
  for (const item of Array.isArray(projected.errors) ? projected.errors : []) {
    if (typeof item?.code === 'string' && item.code !== '') codes.push(item.code);
  }
  for (const item of Array.isArray(projected.warnings) ? projected.warnings : []) {
    if (typeof item?.code === 'string' && item.code !== '') codes.push(item.code);
  }

  if (projected.ledger === null) {
    return slot({
      state: 'unreadable',
      reason: typeof projected.reason === 'string' ? projected.reason : 'unreadable',
      cards: projected.cards,
      codes: codes.length > 0 ? codes : [E_LEDGER_PARTIAL],
      errors: Array.isArray(projected.errors) ? projected.errors.length : 0,
      warnings: Array.isArray(projected.warnings) ? projected.warnings.length : 0,
      meetingTasks,
    });
  }

  const stages = Array.isArray(projected.ledger.stages) ? projected.ledger.stages : [];
  return slot({
    state: 'ok',
    meeting: projected.ledger,
    cards: projected.cards,
    codes,
    stages: stages.length,
    errors: 0,
    warnings: Array.isArray(projected.warnings) ? projected.warnings.length : 0,
    meetingTasks,
  });
}

/**
 * 取这份判定要用的任务 + 数据来源标签。
 *
 * @returns {{tasks: Array<object>, sourceLine: string}} 或抛 E_HOST_UNSUPPORTED
 */
function resolveDeliverInput(ctx, exec, args) {
  const declared = Array.isArray(args?.tasks) ? args.tasks : undefined;
  const kind = dataSourceOf(ctx); // 复用页面的同一份数据源判定，不写第二份

  if (kind === 'agentTeams') {
    const teams = resolveTeams(ctx);
    const agent = exec === undefined || exec === null ? undefined : exec.agent;
    if (agent === undefined) {
      throw new Error(
        'team_deliver 需要调用方的 Agent 身份：读宿主任务板要用它授权（无 Agent 的批处理里没有 Team 归属）',
      );
    }
    /* listTasks 的异常原样冒出去：宁可报错，也不许给一个"可以交付"。 */
    const tasks = teams.listTasks(agent);
    const list = Array.isArray(tasks) ? tasks.map(mapHostTask) : [];
    /* 团队阶段：TeamService 契约里**没有** phase（round-8 §〇.3 已查实），
     * 而 delivery 的 phase 闸门只能读 team.phase。这里按 running 判定并**在第二行写明**：
     * 一行工具调用只可能发生在活着的会话里，但这是个假设，不能藏起来。 */
    return {
      tasks: list,
      team: { phase: 'running' },
      sourceLine: `数据来源：宿主任务板（${list.length} 条任务；团队阶段未由宿主提供，按 running 判定）`,
    };
  }

  if (declared !== undefined) {
    return {
      tasks: declared.map(mapHostTask),
      /* 调用方声明的数据没有团队权威：不替它声明 phase，缺就是缺（E_NOT_RUNNING 会如实出现）。 */
      team: {},
      sourceLine: `数据来源：调用方声明（${declared.length} 条任务，未经宿主核对）`,
    };
  }

  /* 宿主既没有 Agent Teams，调用方也没给任务：这时任何结论都是编的。 */
  throw unsupported('agentTeams');
}

/**
 * 把任务上的 `declarationWarnings` 聚合成一段（D-14）。
 *
 * 为什么一定要印出来：只把警告挂在任务对象上、没有任何地方渲染它，等于造了一个
 * **永远不会出现在输出里的码** —— 这个项目在 `E_NO_ARTIFACT_BINDING` 上栽过同一跤
 * （账记了，输出里一次都不出现，于是"缺口已经有人负责"看起来成立）。
 *
 * 为什么要聚合、为什么带任务 id：
 *   - 同一个 `E_DECLARATION_MISSING` 挂 4 条任务时印 4 行逐字相同的话，读者只会学会
 *     跳过这一段（这正是台账页面被点名"很丑很丑"的那个毛病）；
 *   - 归属不能丢：把归属拍平之后，读者会把警告挂到**相邻**的那条任务上 ——
 *     `board.mjs` 的写域警告已经踩过这条线（H3 在真板上读错了自己的写域冲突）。
 *
 * @param {Array<object>} tasks 已映射过的任务（可能带 `declarationWarnings`）
 * @param {number} maxIssues 每个分组最多印几条
 * @returns {string[]} 空数组表示没有任何声明警告（整段不打印）
 */
function formatDeclarationWarnings(tasks, maxIssues) {
  const groups = new Map();
  const items = Array.isArray(tasks) ? tasks : [];

  for (const task of items) {
    let list;
    try {
      list = Array.isArray(task?.declarationWarnings) ? task.declarationWarnings : [];
    } catch {
      continue; // 单条任务读不出来不许让整段排版崩（它在上游已经报过一次了）
    }
    if (list.length === 0) continue;

    let taskId;
    try {
      taskId = foldText(task?.id) || '(无 id)';
    } catch {
      taskId = '(无 id)';
    }

    for (const warning of list) {
      const code = foldText(warning?.code) || 'E_UNKNOWN';
      const message = foldText(warning?.message);
      const key = `${code}\u0000${message}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { code, message, taskIds: [taskId] });
      } else if (!existing.taskIds.includes(taskId)) {
        existing.taskIds.push(taskId);
      }
    }
  }

  if (groups.size === 0) return [];
  const issues = [...groups.values()].map((group) => ({
    code: group.code,
    message: group.message,
    taskId: group.taskIds.join(' '),
  }));
  return formatGroup('声明警告', issues, maxIssues);
}

/**
 * `canDeliver` 的结论 → 固定版式文本。
 *
 * 版式（派工书 §二）：第一行结论，第二行数据来源，然后阻断、警告、统计。
 */
function formatDelivery({ verdict, sourceLine, tasks, maxIssues, audit }) {
  const blockers = Array.isArray(verdict?.blockers) ? verdict.blockers : [];
  const warnings = Array.isArray(verdict?.warnings) ? verdict.warnings : [];
  const ok = verdict?.ok === true;
  const wired = audit === undefined || audit.wired === true;

  /* D-1：第三态。审计没接线时"0 条阻断"不等于"可以交付" —— 那两项根本没跑，
   * 所以这里不许印"可以交付"，也不许印"不可交付（0 条阻断）"（两句都在撒谎）。 */
  const head = ok
    ? '交付判定：可以交付'
    : blockers.length === 0 && wired === false
      ? '交付判定：无法确认（0 条阻断，但审计未接线，见下方警告）'
      : `交付判定：不可交付（${blockers.length} 条阻断）`;
  const lines = [head, sourceLine];

  /* 审计输入是调用方声明的 → 单独一行标出来。
   * **有意不改第二行**：第二行是"数据来源"，它的逐字形状是既有契约
   * （例如 `数据来源：调用方声明（0 条任务，未经宿主核对）` 被测试按行尾锚定），
   * 往它后面粘东西会连带改掉一条已经钉死的对外契约。信息一样，位置更安全。 */
  if (audit !== undefined && audit.declared === true) {
    const parts = [];
    if (audit.diffKnown === true) parts.push(`diffPaths ${audit.diffPaths.length} 条`);
    if (audit.digestsKnown === true) parts.push(`currentDigests ${Object.keys(audit.currentDigests).length} 条`);
    if (parts.length > 0) lines.push(`审计输入：${parts.join(' / ')}（调用方声明，未经宿主核对）`);
  }

  const blockerLines = formatGroup('阻断', blockers, maxIssues);
  if (blockerLines.length > 0) lines.push('', ...blockerLines);

  const warningLines = formatGroup('警告', warnings, maxIssues);
  if (warningLines.length > 0) lines.push('', ...warningLines);

  /* D-14：声明块的警告段。放在「警告」之后、「统计」之前——
   * 位置有意：`test/host.test.mjs` 第 42 条用 `report.split('警告（')[0]` 切阻断段，
   * 所以这一段**必须**排在真正的「警告」分组后面，否则会连带改掉那条断言的判据。 */
  const declarationLines = formatDeclarationWarnings(tasks, maxIssues);
  if (declarationLines.length > 0) lines.push('', ...declarationLines);

  lines.push('', `统计：${tasks.length} 条任务（${formatStatusCounts(tasks)}）`);
  return { text: lines.join('\n'), ok, blockerCount: blockers.length, warningCount: warnings.length };
}

/* ------------------------------------------------------------------------- */
/* 委派花名册（第 8 轮 W7-A）：agentTeams 缺失时，subagents 仍然能说话            */
/* ------------------------------------------------------------------------- */

/**
 * 子智能体文本的保留字形：
 *   `@` 是名字列前缀、`:` 是结构分隔、`!` 是死进程标记 → 降级成全角，信息不丢但冒充不了；
 *   `⚠←→✅🔄⛔·` 是本层自己的结构字形 → 直接剥掉（否则一个 label 就能在花名册里
 *   装出"另一个子智能体在跑"的整行）。
 * 口径与 `board.mjs` 的 `clean()` 一致（那份是私有的，不导出，所以这里做同一件事的最小版）。
 */
const ROSTER_STRUCTURAL_RE = /[⚠←→✅🔄⛔·]/g;

function degradeRosterText(value) {
  const text = foldText(value).replace(ROSTER_STRUCTURAL_RE, ' ');
  return text.replace(/@/g, '＠').replace(/:/g, '：').replace(/!/g, '！').replace(/ {2,}/g, ' ').trim();
}

function rosterLabel(entry) {
  const label = degradeRosterText(entry?.label);
  return label === '' ? '(未命名)' : label;
}

/**
 * `listDescendants` 的**唯一**访问口。
 *
 * 为什么要有这一层：`roster()`（第 9 轮 W8）要的是计数，花名册要的是行；
 * 两边各自调一次 `listDescendants` 就会出现两个 `kind === 'child'` 过滤。
 * 所以口径只在这里，`roster()` 改成按这里的行数计数（行为不变，46 条测试守着）。
 *
 * @returns {Promise<{entries:Array<object>, diagnostics:Array<object>}|undefined>} 服务缺失时 undefined
 */
async function listDescendantsOf(ctx, sessionId) {
  const subagents = resolveService(ctx, 'subagents');
  if (subagents === undefined || typeof subagents.listDescendants !== 'function') return undefined;
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  const raw = await subagents.listDescendants(sessionId); // 抛错由调用方接住（roster 吞、花名册兜底）
  const list = Array.isArray(raw) ? raw : [];
  return {
    entries: list.filter((entry) => entry !== null && typeof entry === 'object' && entry.kind === 'child'),
    diagnostics: list.filter((entry) => entry !== null && typeof entry === 'object' && entry.kind === 'diagnostic'),
  };
}

/**
 * 委派花名册的排版。
 *
 * 标题必须点明**这不是 Team 任务板**：两者都会显示"谁在干什么"，
 * 但花名册没有任务、没有归属、没有依赖——混起来读会得出错误结论。
 *
 * @param {{entries:Array<object>, diagnostics:Array<object>}|undefined} listed
 * @param {string} [failure] listDescendants 整个抛错时的消息
 */
function renderRosterBoard(listed, failure) {
  const lines = ['委派花名册（不是 Team 任务板；本会话派出的子智能体，宿主没有 Agent Teams 任务板）'];

  /* 顺序有意：**读失败优先于"没有服务"**，否则整块目录抛错会被说成"服务缺失"，
   * 那是把两种不同的故障糊成一句。 */
  if (failure !== undefined) {
    lines.push(`…读取失败：${foldText(failure) || '未知错误'}`);
    return lines.join('\n');
  }

  if (listed === undefined) {
    lines.push('…读取失败：宿主没有 subagents 服务或缺少 listDescendants');
    return lines.join('\n');
  }

  const { entries, diagnostics } = listed;

  const running = entries.filter((entry) => entry.activity === 'running').length;
  lines.push(`  ${entries.length} 个子智能体（${running} 在跑 / ${entries.length - running} 在歇）`);

  for (const entry of entries) {
    const glyph = entry.activity === 'running' ? '🔄' : '·';
    const depth = Number.isFinite(Number(entry.depth)) ? `d${Number(entry.depth)}` : 'd?';
    lines.push(`  ${glyph}  ${depth}  ${rosterLabel(entry)}`);
  }
  if (entries.length === 0) lines.push('  （本会话还没有派出过子智能体）');

  /* 目录读不出来的分支必须留痕：静默丢掉等于"它从没存在过"。 */
  if (diagnostics.length > 0) lines.push(`  …${diagnostics.length} 条读取失败`);
  return lines.join('\n');
}

/** `ContentBlock[]`：team_deliver 的文本块。回放也可能是旧形状，所以绝不抛。 */
function renderDeliveryBlocks(_args, value) {
  const text =
    value !== null && typeof value === 'object' && typeof value.report === 'string' && value.report !== ''
      ? value.report
      : '交付判定（本回合没有可渲染的内容）';
  return [{ type: 'text', text }];
}

/** 写结果 → 几行摘要。**失败行留着就要说出来** —— 过滤掉等于"一屏什么都没发生"。 */
function describeWrites(written) {
  const rows = Array.isArray(written?.rows) ? written.rows : [];
  const failed = rows.filter((row) => row.status === 'failed' && row.superseded !== true);
  const okCount = rows.filter((row) => row.status === 'ok').length;
  const lines = [];
  if (written === null || written === undefined) {
    lines.push('本次没有写账本。');
  } else if (failed.length === 0) {
    lines.push(`账本已写入 ${okCount} 条。`);
  } else {
    lines.push(`账本写入 ${okCount} 条成功、${failed.length} 条失败（失败行留在结果里，没有被过滤掉）。`);
  }
  const codes = Array.isArray(written?.codes) ? written.codes : [];
  if (codes.length > 0) lines.push(`门禁码：${codes.join(' / ')}`);
  for (const row of failed) {
    const where = row.stageId === null || row.stageId === undefined ? '' : ` ${row.stageId}`;
    lines.push(`  ✗ ${row.action}${where}：${row.message ?? '（没有说明）'}`);
  }
  return lines;
}

function renderSubmitBlocks(_args, value) {
  const text =
    value !== null && typeof value === 'object' && typeof value.report === 'string' && value.report !== ''
      ? value.report
      : '会议提交（本回合没有可渲染的内容）';
  return [{ type: 'text', text }];
}

/** `state.submitStage` 的结果 → 工具输出。**只产出 schema 里声明的那四个键**。 */
function toSubmitValue(result) {
  const written = result === null || typeof result !== 'object' ? null : result.written;
  const rows = Array.isArray(written?.rows) ? written.rows : [];
  const lines = [];

  if (result?.duplicate === true) {
    lines.push('重复提交：这一阶段这一轮已经记过，本次一个字节都没写。');
  } else if (result?.ok === true) {
    lines.push('已记入账本。');
  } else {
    lines.push(`提交失败（原因：${result?.reason ?? 'unknown'}）。`);
  }
  if (typeof result?.message === 'string' && result.message !== '') lines.push(result.message);

  const card = result?.card;
  if (card !== null && card !== undefined) {
    if (card.status === 'cannot-judge') {
      lines.push(`卡片判不了：${card.cannotJudge ?? '（没说原因）'}`);
    } else if (card.status === 'failed') {
      const detail = (Array.isArray(card.errors) ? card.errors : [])
        .map((error) => `${error.code}：${error.message}`)
        .join('；');
      lines.push(`卡片不合格：${detail === '' ? '（没有说明）' : detail}`);
    } else {
      lines.push('卡片判据：通过。');
    }
  }

  for (const line of describeWrites(written)) lines.push(line);
  for (const error of Array.isArray(result?.errors) ? result.errors : []) {
    lines.push(`  ✗ ${error.code}：${error.message}`);
  }

  return {
    report: lines.join('\n'),
    ok: result?.ok === true,
    duplicate: result?.duplicate === true,
    writtenCount: rows.filter((row) => row.status === 'ok').length,
  };
}

function renderUpgradeBlocks(_args, value) {
  const text =
    value !== null && typeof value === 'object' && typeof value.report === 'string' && value.report !== ''
      ? value.report
      : '换档（本回合没有可渲染的内容）';
  return [{ type: 'text', text }];
}

/** `stop` → 人话。**不许把"停在某处"说成"完成了"。** */
function stopText(stop) {
  switch (stop) {
    case 'done': return '阶段全完';
    case 'preset': return '档位加载不了';
    case 'create': return '账本没建起来';
    case 'agent': return '拿不到调用方身份';
    case 'blocked': return '有阶段判不了（不能跳过）';
    case 'artifact': return '产物不合判据';
    case 'write': return '账本没记上';
    case 'exhausted': return '连续 3 次没回执';
    case 'blind-reuse': return '盲阶段被要求复用代理';
    case 'agent-select': return '代理选择失败';
    case 'record': return '记账失败';
    case 'continue': return '「继续」消息组不出来';
    case 'clock': return '缺时钟';
    case 'deps': return '驱动器缺依赖';
    default: return typeof stop === 'string' ? stop : '未知原因';
  }
}

function renderStartBlocks(_args, value) {
  const text =
    value !== null && typeof value === 'object' && typeof value.report === 'string' && value.report !== ''
      ? value.report
      : '开会（本回合没有可渲染的内容）';
  return [{ type: 'text', text }];
}

/** `state.startMeeting` 的结果 → 工具输出。只产出 schema 里声明的六个键。 */
function toStartValue(result) {
  const trace = Array.isArray(result?.trace) ? result.trace : [];
  const lines = [];

  if (result?.ok === true) {
    lines.push(`会议跑完了：${trace.length} 个阶段全部 done，账本已落盘。`);
  } else {
    lines.push(`会议停在「${stopText(result?.stop)}」—— 需要人接手。`);
  }

  for (const step of trace) {
    const judge = step?.judged === null || step?.judged === undefined
      ? '没判卡'
      : (step.judged.ok === true ? '通过' : `未通过（${(step.judged.codes ?? []).join('/')}）`);
    lines.push(
      `  阶段 ${step?.stageId} 第 ${step?.attempt} 轮 ｜ 代理 ${step?.mode}`
        + ` ｜ 投递 ${step?.tier ?? '未投出'}${step?.via === null || step?.via === undefined ? '' : `（${step.via}）`}`
        + ` ｜ 存活 ${step?.liveness} ｜ 判卡 ${judge}`
        + ` ｜ 写账本 ${step?.written?.ok === true ? `已记 ${step.written.okCount} 条` : '未记'}`,
    );
  }

  for (const error of Array.isArray(result?.errors) ? result.errors : []) {
    lines.push(`  ✗ ${error.code}：${error.message}`);
  }
  const pending = Array.isArray(result?.pending) ? result.pending : [];
  if (pending.length > 0) {
    lines.push(`待你拍板：${pending.map((item) => item.stageId).join('、')}`
      + '（冲突还没人裁定 —— 这里不会替你决定）');
  }

  return {
    report: lines.join('\n'),
    ok: result?.ok === true,
    status: typeof result?.status === 'string' ? result.status : 'unknown',
    stop: typeof result?.stop === 'string' ? result.stop : 'unknown',
    stageCount: trace.filter((step) => step?.written?.ok === true).length,
    pendingCount: pending.length,
  };
}

/** `state.upgradeMeeting` 的结果 → 工具输出。 */
function toUpgradeValue(result) {
  const written = result === null || typeof result !== 'object' ? null : result.written;
  const rows = Array.isArray(written?.rows) ? written.rows : [];
  const lines = [];

  if (result?.ok !== true && (result?.direction === 'down' || result?.direction === 'same' || result?.direction === 'unknown')) {
    const why = result.direction === 'down'
      ? '降档 —— 只许升不许降：降档等于"已经怀疑过的部分不再怀疑了"，而那些怀疑的结论还在账本里'
      : result.direction === 'same'
        ? '同档 —— 不是升档，所以不写，也不记一条「X → X」的假历史'
        : '判不出方向（含没拿到注册表）—— 判不出绝不许当成"不算降档所以放行"';
    lines.push(`换档被拒（方向：${result.direction}）：${why}。`);
  } else if (result?.ok === true) {
    lines.push('换档完成，账本已更新。');
  } else {
    lines.push(`换档失败（原因：${result?.reason ?? 'unknown'}）。`);
  }
  if (typeof result?.message === 'string' && result.message !== '') lines.push(result.message);

  for (const error of Array.isArray(result?.errors) ? result.errors : []) {
    lines.push(`  ✗ ${error.code}：${error.message}`);
  }
  /* `notes` 是"有话要说但码表里没有位置"的通道（见 lead 的登记）。
   * 它**进不了门禁列表** —— 所以这里必须原样印出来，否则它就白说了。 */
  for (const note of Array.isArray(result?.notes) ? result.notes : []) lines.push(`  · ${note}`);
  for (const line of describeWrites(written)) lines.push(line);

  const identity = result?.identity;
  if (identity !== null && identity !== undefined) {
    lines.push(
      identity.status === 'ok'
        ? `换档人：${identity.name}`
        : `换档人：读不出来（${identity.reason}）—— 账本上这一条没有 by`,
    );
  }

  return {
    report: lines.join('\n'),
    ok: result?.ok === true,
    direction: typeof result?.direction === 'string' ? result.direction : 'unknown',
    writtenCount: rows.filter((row) => row.status === 'ok').length,
  };
}

export function apply(ctx, config) {
  void config;
  const state = createBoardState(ctx);
  const baseWhen = whenToolIsVisible(ctx);
  /**
   * **只用用户开关**这一层门控（task-6）。
   *
   * 为什么单独抽出来：这个文件里其实有**两件不同的事**，当初被写成了一个 `when`：
   *
   *   1. **成员资格**（`baseWhen` / `whenToolIsVisible`）：不是 Team 成员就看不见板。
   *      这条**不该**管到 `team_deliver` —— 交付判定不需要成员身份，
   *      它只读调用方自己的数据。
   *   2. **用户开关**：用户在台账页上把开关关掉。这句的意思是**"别用它"**，
   *      所以**两个工具都该消失**。
   *
   * 两件事共用一个 `when` 的直接后果：第 2 条没落到 `team_deliver` 上，
   * 于是用户关掉开关之后 `team_board` 看不见了、`team_deliver` 照样能调
   * —— "我不让你用，它就不会去用"这句话当时是**不成立**的。
   *
   * **永不抛**（F6）：`when` 抛错会在 `dsh-tools` 里被转成 `ToolActivationError`
   * 并**中止整个模型步**（`dsh-tools/lib/index.js:552-555`），代价远大于"少一个工具"。
   * 所以这里 fail-closed：读不出来就当"用户不让用"。
   */
  const whenUserEnabled = () => {
    try {
      return state.enabled() !== false;
    } catch (error) {
      warnOptional(ctx, 'storage', error);
      return false; // fail-closed：拿不准就当用户关掉了
    }
  };

  /**
   * `team_board` 的门控 = **用户开关 且 成员资格**（语义与改造前逐字一致）。
   *
   * 两层各自兜底，这一层再兜一次是因为**任一层抛出都会中止整个模型步**。
   * `baseWhen` 与 `whenUserEnabled` 内部都已有 catch，所以这里的 catch 实际接不住什么；
   * 它存在是为了让"这一条链永不抛"成为**结构性质**而不是"我审过那两处"。
   */
  const when = (context) => {
    try {
      if (!whenUserEnabled()) return false;
      return baseWhen(context);
    } catch (error) {
      warnOptional(ctx, 'agentTeams', error);
      return false;
    }
  };
  /**
   * 异步读回上次的状态；失败保持默认开。
   *
   * 三条约束（第 12 轮）：
   *   1. **不 await**：注册不等存储（存储可能永远就绪不了，工具不该陪着等）。
   *   2. **不在这里同步发起 IO**：`hydrate()` 的第一行会 `open()` 存储单元 —— 那是 IO，
   *      而 `apply` 期间做 IO 等于把启动绑在存储上（`probe` profile 的故障面）。
   *      所以推迟到 `apply` 返回之后的微任务里再开始。
   *   3. **必须接住 rejection**：`void promise` 会留下浮空 promise，
   *      在宿主里就是 unhandledRejection —— 那同样是"entry 不激活"的入口。
   *
   * `queueMicrotask` 万一不存在（老运行时），退回 `setTimeout(…, 0)`；两者都失败就放弃读回，
   * 开关保持默认开 —— 这比让插件起不来划算得多。
   */
  const hydrateLater = () => {
    state.hydrate().catch((error) => warnOptional(ctx, 'storage', error));
  };
  try {
    if (typeof queueMicrotask === 'function') queueMicrotask(hydrateLater);
    else setTimeout(hydrateLater, 0);
  } catch (error) {
    warnOptional(ctx, 'storage', error);
  }

  const definition = {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderBoardBlocks,
    },

    /**
     * 取数据 → 渲染 → 返回。**这里没有任何判定逻辑**：判定在 `board.mjs` 里。
     *
     * 三条路径（第 8 轮 W7-A）：
     *   1. 有 agentTeams            → 原路径，一个字不改；
     *   2. 只有 subagents           → 委派花名册（标题写明这不是 Team 任务板）；
     *   3. 两者都没有               → `E_HOST_UNSUPPORTED`（**不给空板**：
     *      空板和"没人有活"看起来一样）。
     *
     * 错误一律向上抛，不 try/catch：
     * 静默返回空板比抛错更危险。
     */
    async execute(args, exec) {
      /* 第 17 轮 task-20：**第二道门**（与 `team_deliver` 完全对称，缺一边就等于没接）。
       *
       * 为什么两个工具都要有：只补一个正是 `E_AUDIT_UNWIRED` 当初的形状 ——
       * 一个入口守住了、另一个没有，于是"用户关掉了插件"这句话在某条路径上仍然不成立，
       * 而且**没有任何东西会响**。
       *
       * 位置在最外层、任何取数之前：被拒绝时不读任务、不读成员、不渲染板。 */
      if (!whenUserEnabled()) throw userDisabledError(TOOL_NAME);

      const agent = exec === undefined || exec === null ? undefined : exec.agent;
      const source = dataSourceOf(ctx);

      if (source === 'roster') {
        if (agent === undefined) {
          throw new Error(
            'team_board 需要调用方的 Agent 身份：委派花名册按会话读子智能体目录（无 Agent 的批处理里没有会话）',
          );
        }
        let listed;
        try {
          listed = await listDescendantsOf(ctx, agent.id);
        } catch (error) {
          /* 整块目录读失败：给一行兜底，不崩，也不假装"没有子智能体"。 */
          return {
            board: renderRosterBoard(undefined, error instanceof Error ? error.message : String(error)),
            me: '',
            taskCount: 0,
            memberCount: 0,
          };
        }
        const board = renderRosterBoard(listed);
        /* 第 14 轮：**花名册这条路径不带 `tasks`**，而且是有意的。
         * 花名册里没有任务（只有子智能体），带一个 `tasks: []` 会让页面读到
         * 「板上没有任务（读到了，确实为零）」—— 那句话在"宿主根本没有 Team 任务板"
         * 时是假的。所以这里连键都不给，让下游按"没有结构化数据"处理。 */
        return {
          board,
          me: '',
          taskCount: 0,
          memberCount: listed === undefined ? 0 : listed.entries.length,
        };
      }

      const teams = resolveTeams(ctx);
      if (teams === undefined) {
        // 宿主缺少 Agent Teams 且没有 subagents：给结构化错误，调用方知道是"没这个能力"，不是"没任务"。
        throw unsupported('agentTeams');
      }

      if (agent === undefined) {
        throw new Error(
          'team_board 需要调用方的 Agent 身份：它只能在一个会话里调用（无 Agent 的批处理里没有 Team 归属）',
        );
      }

      /* 身份**只**来自宿主：membership 会为冒充者抛错，这正是我们要的。 */
      const membership = teams.membership(agent);

      /* listTasks / listMembers 的异常原样冒到调用方（派工书 §四.10）。 */
      /* D-14：板上那一列 `kind` 以前永远是 `?` —— 因为 `renderBoard` 读的是
       * `task.kind`，而真实 TeamTaskView 没有这个字段。把声明解析放在取数这一层，
       * 板上的 `?` 才会变成 `impl` / `review` / `work`，人（和模型）才能一眼看出
       * "这条活到底该按什么标准判"。 */
      const tasks = mapHostTaskList(teams.listTasks(agent));
      const members = teams.listMembers(agent);

      const board = renderBoard({
        tasks,
        members,
        me: membership.name,
        ...renderOptions(args),
      });

      /* 第 14 轮：**工具这条路径**的结构化任务板。
       *
       * 三条与上面完全同源：同一个 `tasks`（`listTasks(agent)` 只调用了一次）、
       * 同一个 `membership.name`、同一个 `mapHostTask` 映射结果。
       * `renderBoard` 的文本输出**一个字都不变** —— 这里只是多带一份结构化数据出去，
       * 给页面那条路（`gates()`）之外的第二条出口用；两条路径少一条，
       * 就等于"代码写了、测了、线上走不到"（这正是本次要修的那个形状）。 */
      const payloadTasks = projectPayloadTasks(tasks, membership.name);
      const value = {
        board,
        me: membership.name,
        taskCount: Array.isArray(tasks) ? tasks.length : 0,
        memberCount: Array.isArray(members) ? members.length : 0,
      };
      if (payloadTasks !== undefined) value.tasks = payloadTasks;
      return value;
    },
  };

  /**
   * `team_deliver`（第 10 轮）：取数 → `canDeliver` → 排版。
   *
   * **不试、不修、不猜**：`canDeliver` 抛错就往外抛（派工书 §二.6：
   * 宁可报错，也不许给一个"可以交付"）。
   */
  const deliverDefinition = {
    name: DELIVER_NAME,
    description: DELIVER_DESCRIPTION,
    parameters: DELIVER_PARAMETERS,
    output: {
      schema: DELIVER_OUTPUT_SCHEMA,
      render: renderDeliveryBlocks,
    },

    async execute(args, exec) {
      /* 第 17 轮 task-20：**第二道门**。
       *
       * `when` 只保证这个工具不出现在**模型可见的工具清单**里 —— 模型看不见就不会调。
       * 但那句话（用户原话：「我不让你用这个，它就不会去用」）当时只在模型侧成立：
       * 绕过 `when` 直接调 `execute`，它照样跑完整判定、照样出报告。
       *
       * 这道门把它变成**结构性**的，而不是"取决于模型守规矩"。
       *
       * 位置在最外层、任何取数之前：被拒绝时**不读任务、不渲染、不产报告** ——
       * 拒绝路径上出现半点工作，都说明它不是短路而是"算完丢掉"（那既浪费又不诚实）。
       *
       * 与 `team_board` 的对称门必须同时存在：只补一个，正是 `E_AUDIT_UNWIRED` 当初的形状。 */
      if (!whenUserEnabled()) throw userDisabledError(DELIVER_NAME);

      const input = resolveDeliverInput(ctx, exec, args); // 取不到源就抛 E_HOST_UNSUPPORTED
      const maxIssues = readInteger(args, 'maxIssues');
      const cap = maxIssues === undefined
        ? DELIVER_DEFAULT_MAX_ISSUES
        : Math.min(DELIVER_MAX_ISSUES_CEILING, Math.max(1, Math.trunc(maxIssues)));

      /* D-1：审计输入只在**已知**时才挂上去。
       *
       * 三种情况必须走三条不同的路：
       *   - 没传            → 不挂（模块会用默认值 `[]`/`{}`，那会伪造结论），
       *                       结论里自曝一条 `E_AUDIT_UNWIRED`；
       *   - 显式传了空的     → 照挂（`diffPaths: []` / `currentDigests: {}` 是
       *                       "我查过，一个都没有"，不是"不知道"）；
       *   - 显式传了有内容的 → 照挂，报告里标"调用方声明，未经宿主核对"。
       * 之前是 `canDeliver({ team, tasks })` 一把梭 —— 于是 137 条 delivery 测试
       * 测的是一个生产里从未出现过的调用形态，而生产走的是"假装查过"那条。 */
      const audit = readDeclaredAudit(args);
      const verdictInput = { team: input.team, tasks: input.tasks };
      if (audit.diffKnown) verdictInput.diffPaths = audit.diffPaths;
      if (audit.digestsKnown) verdictInput.currentDigests = audit.currentDigests;

      const verdict = applyAuditWiring(canDeliver(verdictInput), audit);
      const formatted = formatDelivery({
        verdict,
        sourceLine: input.sourceLine,
        tasks: input.tasks,
        maxIssues: cap,
        audit,
      });

      return {
        report: formatted.text,
        ok: formatted.ok,
        blockerCount: formatted.blockerCount,
        warningCount: formatted.warningCount,
      };
    },
  };

  /**
   * 一个 effect 管三件事：两个工具注册 + 页面数据路由。
   *
   * 为什么还是一个 effect：`apply` 里的 `ctx.effect` 调用次数是既有测试断言过的契约
   * （第 2 条断言撤销时只记一个 label），所以新增工具不另起 effect，一起挂、一起撤。
   *
   * **注册顺序有含义**：`team_board` 在前（`registrations[0]` 是它，第 9 轮那批
   * 测试按位置读它），`team_deliver` 在后。
   *
   * **门控（第 15 轮 task-6 修正）**：
   *   - `team_board` → `when`（= 用户开关 **且** 成员资格）；
   *   - `team_deliver` → `whenUserEnabled`（**只有**用户开关）。
   *
   * 之前这里写的是"关掉观察不等于放弃裁决，所以 `team_deliver` 不套 `when`"——
   * 那句话把**成员资格**与**用户开关**混成了一件事。成员资格不该管到裁决（对），
   * 但用户开关**必须**管到它：用户说"别用它"，指的是这两个工具都别用。
   * 实测过：旧写法下关掉开关后 `team_deliver` 仍然调得到。
   */
  /* ═══════════════════════════════════════════════════════════════════════════
   * P2-9：会议的两个**动作**工具
   *
   * 为什么是工具而不是只挂 state：本项目的主注入通道是 `ctx.systemPrompt.tools(...)`，
   * 工具是模型唯一能主动按的按钮。只挂 state 等于"能力有了、没人能按" ——
   * 那正是 `writeMeetingLedger` 此前的状态（六段反证只证明它能写对，没证明它会被用）。
   *
   * 两个动作都不接 `me` / `owner` / `by` 这类身份参数：身份只能来自
   * `teams.membership(agent).name`（见文件头第 12 行）。让调用方自报身份，
   * 等于把"谁提交的/谁换的档"交给被记录的人自己填。
   * ═══════════════════════════════════════════════════════════════════════════ */

  const submitDefinition = {
    name: SUBMIT_NAME,
    description: SUBMIT_DESCRIPTION,
    parameters: SUBMIT_PARAMETERS,
    output: { schema: SUBMIT_OUTPUT_SCHEMA, render: renderSubmitBlocks },

    async execute(args, exec) {
      /* 第二道门：`when` 只保证这个工具不出现在**模型可见的工具清单**里；
       * 绕过 `when` 直接调 `execute` 仍然会跑。位置在最外层、任何取数之前 ——
       * 拒绝路径上出现半点工作，都说明它不是短路而是"算完丢掉"。 */
      if (!whenUserEnabled()) throw userDisabledError(SUBMIT_NAME);
      const agent = exec === undefined || exec === null ? undefined : exec.agent;
      const sessionId = agent === undefined || agent === null ? undefined : agent.id;
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error(`${SUBMIT_NAME} 需要调用方的 Agent 身份：没有会话就没有"这是谁提交的"`);
      }
      return toSubmitValue(await state.submitStage(sessionId, args));
    },
  };

  const upgradeDefinition = {
    name: UPGRADE_NAME,
    description: UPGRADE_DESCRIPTION,
    parameters: UPGRADE_PARAMETERS,
    output: { schema: UPGRADE_OUTPUT_SCHEMA, render: renderUpgradeBlocks },

    async execute(args, exec) {
      if (!whenUserEnabled()) throw userDisabledError(UPGRADE_NAME);
      const agent = exec === undefined || exec === null ? undefined : exec.agent;
      const sessionId = agent === undefined || agent === null ? undefined : agent.id;
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error(`${UPGRADE_NAME} 需要调用方的 Agent 身份：换档人只能从宿主身份取`);
      }
      return toUpgradeValue(await state.upgradeMeeting(sessionId, args));
    },
  };

  const startDefinition = {
    name: START_NAME,
    description: START_DESCRIPTION,
    parameters: START_PARAMETERS,
    output: { schema: START_OUTPUT_SCHEMA, render: renderStartBlocks },

    async execute(args, exec) {
      /* 第二道门：`when` 只让模型看不见它；绕过 `when` 直接调 `execute` 仍然会跑。
       * 这个工具**会建任务、会派活、会写账本** —— 开关关着时它必须比谁都先闭嘴。 */
      if (!whenUserEnabled()) throw userDisabledError(START_NAME);
      const agent = exec === undefined || exec === null ? undefined : exec.agent;
      const sessionId = agent === undefined || agent === null ? undefined : agent.id;
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error(`${START_NAME} 需要调用方的 Agent 身份：没有会话就没有"这是谁开的会"`);
      }
      return toStartValue(await state.startMeeting(sessionId, args));
    },
  };

  return ctx.effect(() => {
    const disposeReview = installReview(ctx, { enabled: whenUserEnabled, stageTimeoutMs: config?.reviewStageTimeoutMs });
    const disposeBoard = ctx.tools.register(definition, { when });
    const disposeDeliver = ctx.tools.register(deliverDefinition, { when: whenUserEnabled });
    /* P2-9：会议的两个动作工具。同样受用户开关管 —— 一个关不掉的**写**入口比没有它更坏：
     * 用户说"别用它"时，能改账本的那两个必须先闭嘴。 */
    const disposeSubmit = ctx.tools.register(submitDefinition, { when: whenUserEnabled });
    const disposeUpgrade = ctx.tools.register(upgradeDefinition, { when: whenUserEnabled });
    /* P3-2：连杆的按钮。同样受主开关管 —— 一个关不掉的"开会 + 派活"入口比没有它更坏。 */
    const disposeStart = ctx.tools.register(startDefinition, { when: whenUserEnabled });
    /* 路由是**可选能力**：注册失败只意味着没有页面数据通道，不许让 entry 不激活。
     * `registerStateRoute` 内部已经逐层 try，这里再兜一层是给"它意外抛了"留后路。 */
    let disposeRoute;
    try {
      disposeRoute = registerStateRoute(ctx, state);
    } catch (error) {
      warnOptional(ctx, 'connection', error);
      disposeRoute = undefined;
    }
    /* 拍板路由与读路由**同一个 effect**：一起挂、一起撤。
     * 分开挂的话，热重载时会出现"读路由还在、写路由已经撤了"的窗口 ——
     * 那窗口里页面上的拍板按钮会 404，而读者刚看到的是"加载正常"。
     * 两条路由各自 try：一条挂不上不许连累另一条（没有页面通道 ≠ 没有插件）。 */
    let disposeDecide;
    try {
      disposeDecide = registerDecideRoute(ctx, state);
    } catch (error) {
      warnOptional(ctx, 'connection', error);
      disposeDecide = undefined;
    }
    return () => {
      try {
        disposeBoard();
      } finally {
        try {
          if (typeof disposeDeliver === 'function') disposeDeliver();
        } finally {
          try {
            if (typeof disposeRoute === 'function') disposeRoute();
          } finally {
            if (typeof disposeSubmit === 'function') disposeSubmit();
            if (typeof disposeUpgrade === 'function') disposeUpgrade();
            if (typeof disposeStart === 'function') disposeStart();
            if (typeof disposeDecide === 'function') disposeDecide();
            return disposeReview?.();
          }
        }
      }
    };
  }, 'team-board.tools.register()');
}
