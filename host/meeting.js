/**
 * `host/meeting.js` — 会议驱动器的**唯一 IO 层**（P3-1）。
 *
 * ## 它是什么 / 不是什么
 *
 * 它是"油门"：在这之前整个插件是"发动机装好了、没有油门" —— 纯逻辑全齐、账本读通了、
 * 写能力有了，但**没有任何东西按顺序把阶段跑一遍**。
 *
 * 它**只做编排**。每一条判据都下沉到 `src/*.mjs`：
 *
 *   | 问什么             | 问谁                                    |
 *   |--------------------|-----------------------------------------|
 *   | 下一个阶段跑哪个   | `meeting.mjs` 的 `nextStage`            |
 *   | 代理怎么选         | `agentpool.mjs` 的 `decideAgent`        |
 *   | 卡够不够           | `artifact.mjs` 的 `judgeArtifact`       |
 *   | 活没活着           | `resume.mjs` 的 `assessLiveness`        |
 *   | 「继续」说什么     | `resume.mjs` 的 `composeContinueMessage`|
 *   | 记录怎么变         | `meeting.mjs` 的 `recordSubmission`     |
 *   | 账本怎么落盘       | **注入**（`host/index.js` 的 `writeMeetingLedger`）|
 *
 * 在这个文件里重写任何一条判据都算违规 —— 那正是本项目反复栽的"抄第二份"。
 *
 * ## 全部外部能力都是注入的
 *
 * 没有 `ctx`、没有 `teams`、没有 `fs`、**没有 `Date.now()`**。测试因此不需要假宿主：
 * 给它一个 `deliver` / `writeLedger` 就够了。真实接线在 `host/index.js` 里做。
 *
 * ## 三条最容易写错的纪律（都写进了代码）
 *
 * 1. **盲阶段不许复用**。判据在 `decideAgent`；但驱动器是最终写账本的人，所以它拿到
 *    答案后还要核一次这条**事实**（`stage.blind && mode === 'reuse'`）。用的是同一个码
 *    `E_BLIND_AGENT_REUSED` —— 这不是第二份判据，是把同一件事在信任边界上再断言一次。
 * 2. **判不了就不放行**。卡片不过 = 停在这里，绝不"自动降低要求把它当通过"。
 * 3. **写失败必须停，且绝不重发这个阶段**。重发会让同一阶段执行两次，而账本只记第二次。
 */
import { nextStage, recordSubmission } from '../src/meeting.mjs';
import { judgeArtifact } from '../src/artifact.mjs';
import { decideAgent } from '../src/agentpool.mjs';
import { pickDelivery } from '../src/adapter.mjs';
import { detectBlindLeak } from '../src/delivery.mjs';
import {
  assessLiveness,
  composeContinueMessage,
  MAX_CONTINUES_PER_ATTEMPT,
} from '../src/resume.mjs';

/** 值是不是"能当容器读"的对象（与 `adapter.mjs` 同一条判据，不另造）。 */
const isObjectLike = (value) => (typeof value === 'object' && value !== null) || typeof value === 'function';

/** 宿主那条"按 tier 投递"的内部通道。`Symbol.for` 是进程稳定的，不是每进程新造一个。 */
const DELIVER_PROMPT = Symbol.for('dsh.subagent.deliverPrompt');

/**
 * 真实投递：把驱动器组好的消息交给某个子会话，并把它这一阶段的产物收回来。
 *
 * ## 分档只有一处来源
 *
 * `pickDelivery({ exists, idle })` —— `src/adapter.mjs` 的三档（`startActivation` /
 * `queue` / `steer`）与它们的取舍写在 `DELIVERY_RATIONALE` 里。这里**不新造**
 * "先看 idle 再决定"那套：tier 算完就照它执行，并把算出来的 tier 原样返回，
 * 让轨迹上能看见"这一次凭什么这么投"。
 *
 * ## 执行上的一处如实说明
 *
 * `queue` 与 `steer` 都走 `subagents.sendMessage(sender, targetId, content)` ——
 * 宿主文档写明它会**按目标的实际状态**决定"并入最近一个 step"还是"起一轮"。
 * 我们自己再分一次反而会和宿主的真实状态打架（我们手里的 `idle` 是读出来的猜测，
 * 它手里的是事实）。所以：**tier 是决策与留痕，`sendMessage` 是执行**，
 * 两者不一致时以宿主为准，`via` 字段如实记录实际走了哪条路。
 *
 * ## 三条不许越过去的线
 *
 * 1. **不许往 `message` 里加任何字**。驱动器已经按 `blind` 剥了推理、按 `withheld`
 *    藏了产物；在这里补一句"帮它理解"就等于把剥掉的推理又塞回去。本函数对
 *    `message` 只做一件事：原样交给宿主。
 * 2. **复用/新建只在 `decideAgent` 里决定**。这里只执行 `fresh|reuse|fork` 的结论，
 *    不重新判断该不该复用。
 * 3. **拿不到产物就如实说"没拿到"**。不在这里重试第 4 次 —— 上限在 `resume.mjs`，
 *    那是它唯一该待的地方。返回 `artifact: null`，让驱动器走存活/「继续」那条路。
 *
 * @param {object} input
 *   - `subagents`：宿主能力容器（`startActivation` / `sendMessage`）。
 *   - `parent`：**精确的活着的**父 Agent（宿主会校验身份，不是随便一个 id）。
 *   - `readChildren`：可选，`() => Array<{id, idle}>`，用来回答"在不在 / 忙不忙"。
 *   - `collectArtifact`：可选，`({childId}) => artifact|null`，从子会话取回产物。
 * @returns {(delivery: {stage: object, attempt: number, message: string,
 *   mode: string, agentId: string|null}) => Promise<object>}
 */
/** 冷启动该用哪个 provider：从宿主**注册过的名字**里挑，`spawn` 优先。
 * 不许自己编一个名字 —— 那个名字会在宿主里变成
 * `no subagent provider registered for "…"`。 */
function pickProvider(subagents) {
  if (!isObjectLike(subagents) || typeof subagents.list !== 'function') return null;
  let names;
  try {
    names = subagents.list();
  } catch {
    return null;
  }
  if (!Array.isArray(names)) return null;
  const usable = names.filter((name) => typeof name === 'string' && name !== '');
  if (usable.length === 0) return null;
  const spawn = usable.find((name) => /spawn/i.test(name));
  return spawn ?? usable[0];
}

/** 激活标签：出事时轨迹上要认得出"这是哪场会的哪个阶段第几轮"。 */
function stageLabel(asked) {
  const stageId =
    isObjectLike(asked) && isObjectLike(asked.stage) && typeof asked.stage.id === 'string'
      ? asked.stage.id
      : 'stage';
  const attempt = isObjectLike(asked) && Number.isInteger(asked.attempt) ? asked.attempt : 1;
  return `meeting:${stageId}:${attempt}`;
}

export function createSubagentDeliver(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const subagents = source.subagents;
  const parent = source.parent;
  const readChildren = typeof source.readChildren === 'function'
    ? source.readChildren
    /* 调用方没单独给"列子会话"的函数时，直接问容器要 —— 这两个能力本来就长在
     * `subagents` 上，再让每个调用方各写一遍是没必要的重复。 */
    : (isObjectLike(subagents) && typeof subagents.listChildren === 'function'
      /* 契约要 `parentSessionId: SessionId`（字符串）。传对象会让宿主
       * `session "[object Object]" not found` 并 fatal，不是抛个能接住的错。 */
      ? () => subagents.listChildren(parent.id)
      : null);
  const collectArtifact = typeof source.collectArtifact === 'function'
    ? source.collectArtifact
    : (isObjectLike(subagents) && typeof subagents.readArtifact === 'function'
      ? ({ childId }) => subagents.readArtifact(childId)
      : null);

  /** 宿主没给目录时，"在不在"就是未知：于是 `exists` 交给 `pickDelivery` 按"不存在"处理
   * （先激活）。宁可多拉起一次激活，也不许把消息丢进一个不存在的会话。 */
  /**
   * 宿主目录：`async`。
   *
   * **这里曾经是同步 `try/catch` 包一个 `async` 函数** —— 那等于没包：
   * `readChildren()` 返回的是 Promise，同步 catch 永远看不到拒绝，
   * `Array.isArray(Promise)` 又是 false，于是函数若无其事返回 `null`，
   * 而拒绝留在那儿没人接。Node 默认 `--unhandled-rejections=throw`，
   * 于是**整个宿主进程 exit 1**（真机崩溃日志：
   * `dsh: fatal load failure: SessionQueryError: session "[object Object]" not found`）。
   *
   * 顺带一个更隐蔽的后果：因为 `Array.isArray(Promise)` 恒为 false，
   * 目录在**没崩的那些场合也永远是 null** —— 三档投递里的 `queue`/`steer`
   * 判断从来没真正看过宿主目录，一直是瞎的，只是安静所以没人发现。
   */
  const children = async () => {
    if (readChildren === null) return null;
    try {
      const list = await readChildren();
      return Array.isArray(list) ? list : null;
    } catch {
      /* 读不出来 = **状态未知**（返回 null），不是"不存在"。
       * `pickDelivery` 会按"未知"落档，不许在这里猜。 */
      return null;
    }
  };

  return async function deliver(delivery) {
    const asked = delivery !== null && typeof delivery === 'object' ? delivery : {};
    const artifactOf = (childId) => {
      if (collectArtifact === null) return null;
      try {
        return collectArtifact({ childId });
      } catch {
        return null;
      }
    };

    if (!isObjectLike(subagents) || !isObjectLike(parent)) {
      return {
        ok: false,
        artifact: null,
        lastToolCall: null,
        tier: null,
        via: null,
        reason: 'no-subagents',
        message: '宿主没有 subagents 能力（或没有拿到精确的父 Agent）—— 这一阶段投不出去。',
      };
    }

    const list = await children();
    const askedId = typeof asked.agentId === 'string' && asked.agentId !== '' ? asked.agentId : null;
    const found = list === null || askedId === null
      ? null
      : list.find((item) => isObjectLike(item) && item.id === askedId) ?? null;

    /* 三档的**决策**：只问 `pickDelivery`。`list === null` 表示"宿主没给目录"，
     * 那时 `exists` 归 `askedId !== null`（我们至少被指定过一个人），`idle` 留空
     * → `pickDelivery` 会把"状态未知"落到 `queue`（它自己的规定，不是这里补的）。 */
    const exists = list === null ? askedId !== null : found !== null;
    const idle = found === null || found.idle === undefined ? undefined : found.idle === true;
    const tier = pickDelivery({ exists, idle });

    try {
      if (tier === 'startActivation') {
        if (typeof subagents.startActivation !== 'function') {
          return {
            ok: false,
            artifact: null,
            lastToolCall: null,
            tier,
            via: null,
            reason: 'no-startActivation',
            message: '需要冷启动一个子会话，但宿主没有 startActivation。',
          };
        }
        /*
         * 真契约（`ctx.get('subagents')` 的 `Service` 文档，逐字段抄下来的）：
         *   startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
         *   SubagentActivationSpec = {
         *     provider: string,      // 必填：注册过的 provider 名
         *     label: string,         // 必填
         *     childId?: SessionId,   // 冷启动时省略
         *     request: Omit<SubagentStartRequest, 'label' | 'signal'>,
         *                            // 里面是 { parent, prompt: ContentBlock[], ... }
         *     signal: AbortSignal,   // 必填
         *     delivery: 'parent' | 'caller',
         *   }
         *
         * 上一版这一块是**照想象写的**：没有 `provider`（宿主报
         * `no subagent provider registered for "undefined"`）、`label`/`signal`/`delivery`
         * 全缺，而且把正文塞进 `request.task` —— 契约里根本没有 `task` 这个字段，
         * 正文要走 `prompt: ContentBlock[]`。假对象什么都收，真宿主逐字校验。
         */
        const providerName = pickProvider(subagents);
        if (providerName === null) {
          return {
            ok: false,
            artifact: null,
            lastToolCall: null,
            tier,
            via: null,
            reason: 'no-provider',
            message: '宿主没有注册任何 subagent provider —— 冷启动不可能发生（不是"投递失败"）。',
          };
        }
        const controller = new AbortController();
        const activation = await subagents.startActivation({
          provider: providerName,
          label: stageLabel(asked),
          ...(askedId === null ? {} : { childId: askedId }),
          request: {
            parent,
            prompt: [{ type: 'text', text: String(asked.message ?? '') }],
          },
          signal: controller.signal,
          delivery: 'parent',
        });
        const childId = (isObjectLike(activation) && (
          (typeof activation.childId === 'string' && activation.childId)
          || (isObjectLike(activation.identities) && typeof activation.identities.childId === 'string' && activation.identities.childId)
        )) || null;
        return {
          ok: childId !== null,
          artifact: childId === null ? null : artifactOf(childId),
          lastToolCall: null,
          tier,
          via: 'startActivation',
          childId,
          reason: childId === null ? 'no-child-id' : null,
        };
      }

      /* `queue` / `steer`：tier 是决策，执行交给 `sendMessage`（它按目标**实际**状态
       * 决定并入最近 step 还是起一轮）。内部通道在就先用它，把 tier 原样传下去；
       * 不在就退回公开的 `sendMessage`，`via` 字段如实记录走了哪条。 */
      const content = asked.message;
      if (typeof subagents[DELIVER_PROMPT] === 'function') {
        await subagents[DELIVER_PROMPT](parent, asked.agentId, content, source.source ?? null, undefined, tier);
        return {
          ok: true,
          artifact: artifactOf(asked.agentId),
          lastToolCall: null,
          tier,
          via: 'deliverPrompt',
          childId: asked.agentId,
          reason: null,
        };
      }
      if (typeof subagents.sendMessage !== 'function') {
        return {
          ok: false,
          artifact: null,
          lastToolCall: null,
          tier,
          via: null,
          reason: 'no-sendMessage',
          message: '宿主既没有内部投递通道也没有 sendMessage。',
        };
      }
      await subagents.sendMessage(parent, asked.agentId, content);
      return {
        ok: true,
        artifact: artifactOf(asked.agentId),
        lastToolCall: null,
        tier,
        via: 'sendMessage',
        childId: asked.agentId,
        reason: null,
      };
    } catch (error) {
      /* 投不出去就如实说投不出去 —— **不重试**，也不假装投过了。 */
      return {
        ok: false,
        artifact: null,
        lastToolCall: null,
        tier,
        via: null,
        reason: 'deliver-failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/**
 * 从名册里挑一个候选人交给 `decideAgent`。
 *
 * ## 三件事分开，各归各家
 * - **`agentId` 来自 `agentRoster(tasks)`** —— 宿主没有"列出子会话"的接口，
 *   所以"谁存在"这件事只能靠我们自己写进账本的那一格（阶段块的 `agent`）；
 * - **`role` 来自预设**（`preset.stages[].role`）—— 名册**故意不给 role**：
 *   角色只存在于预设，账本不替预设当第二份（`ledger.mjs` 里那段注释写着理由）；
 * - **该不该复用**仍然只问 `decideAgent`。本函数只组装数据，**不判任何一条**。
 *
 * 角色按**当前预设**查：跨档位时（如 `lite@1` 里没有 `redteam`）查不到就跳过，
 * **不猜**。跳过只意味着"这个人这次不进候选"，不是"它不合格"。
 *
 * @param {object} input `{ entries, preset, meetingId, stage }`
 * @returns {{id: string, role: string, meetings: string[]}|null}
 */
export function candidateFromRoster(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const entries = Array.isArray(source.entries) ? source.entries : [];
  const stages = Array.isArray(source.preset?.stages) ? source.preset.stages : [];
  const meetingId = typeof source.meetingId === 'string' ? source.meetingId : '';

  const roleOf = new Map();
  for (const stage of stages) {
    if (stage !== null && typeof stage === 'object' && typeof stage.id === 'string') {
      roleOf.set(stage.id, typeof stage.role === 'string' ? stage.role : null);
    }
  }
  const targetRole = roleOf.get(source.stage?.id) ?? null;
  if (targetRole === null) return null;

  /** agentId → 它待过的**别的**会议（同角色那些活）。 */
  const byAgent = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const agentId = typeof entry.agentId === 'string' ? entry.agentId : '';
    const entryMeeting = typeof entry.meetingId === 'string' ? entry.meetingId : '';
    /* 只要**跨会议**的：本会议内的复用判据已被删除（它在两份预设下都不可能触发），
     * 所以"本会议干过"不构成候选理由。 */
    if (agentId === '' || entryMeeting === '' || entryMeeting === meetingId) continue;
    if (roleOf.get(entry.stageId) !== targetRole) continue;
    const seen = byAgent.get(agentId) ?? new Set();
    seen.add(entryMeeting);
    byAgent.set(agentId, seen);
  }
  if (byAgent.size === 0) return null;

  /* 取法必须是确定的：名册顺序来自任务数组，换一次查询顺序就换一个候选人，
   * 会让"同一份账本两次跑出不同结果"——那种不确定最难查。 */
  const id = [...byAgent.keys()].sort()[0];
  return {
    id,
    role: targetRole,
    meetings: [...byAgent.get(id)].sort(),
  };
}

/** 诊断对象。码一律来自 `codes.mjs`（本文件**不发明**任何新码）。 */const diag = (code, message, stageId) => (
  stageId === undefined ? { code, message } : { code, message, stageId }
);

/** 把调用方给的时钟变成一个账本能存的时间字符串。给不出合法时间就返回 `undefined`
 * （于是那个键缺席）—— **绝不编一个时间**。 */
function isoOf(value) {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

/**
 * 组一条投递消息。**这是呈现，不是判据。**
 *
 * 两根轴是**正交**的，别合并：
 *   - `blind`：剥掉"作者的推理"（谁怎么想的、为什么这么想）；
 *   - `withheld`：藏掉**点名**的产物（如 `design.reasoning`）。
 * 一个非盲阶段照样可以藏某一项；一个盲阶段照样可以保留产物名。合成一根轴就会
 * 出现"因为盲所以连产物都没了"这种谁都解释不了的缺口。
 *
 * @param {object} input { stage, history, blind }
 * @returns {string}
 */
export function composeDelivery(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const stage = source.stage !== null && typeof source.stage === 'object' ? source.stage : {};
  const blind = source.blind === true || stage.blind === true;
  const history = Array.isArray(source.history) ? source.history : [];

  const lines = [];
  /* 会议的问题必须真的进到消息里 —— 否则工具那个 `question` 参数就是个死输入，
   * 和"支持了但没人喂"是同一类缺口。 */
  const question = typeof source.question === 'string' ? source.question.trim() : '';
  if (question !== '') lines.push(`会议问题：${question}`);
  lines.push(`阶段 ${stage.id ?? '?'}（角色 ${stage.role ?? '?'}）`
    + (blind ? '—— 盲阶段：你看不到作者的推理，只看得到产物。' : ''));

  const must = Array.isArray(stage.mustProduce) ? stage.mustProduce : [];
  if (must.length > 0) lines.push(`必产字段：${must.join('、')}`);
  const minCount = stage.minCount !== null && typeof stage.minCount === 'object' ? stage.minCount : null;
  if (minCount !== null) {
    const parts = Object.keys(minCount).map((key) => `${key} ≥ ${minCount[key]}`);
    if (parts.length > 0) lines.push(`数量门槛：${parts.join('、')}`);
  }

  const withheld = new Set(Array.isArray(stage.withheld) ? stage.withheld : []);
  for (const item of history) {
    const produced = Array.isArray(item.produced) ? item.produced : [];
    /* `withheld` 里的点名产物直接跳过；剩下的按 `blind` 决定"给不给推理"。 */
    if (item.producedKeys !== undefined && withheld.has(item.producedKeys)) continue;
    const keptProduced = produced.filter((key) => !withheld.has(`${item.stageId ?? '?'}.${key}`));
    if (keptProduced.length > 0) {
      lines.push(`已有的产物（阶段 ${item.stageId ?? '?'}）：${keptProduced.join('、')}`);
    }
    if (!blind && typeof item.claim === 'string' && item.claim !== '') {
      lines.push(`上一阶段 ${item.stageId ?? '?'} 的 claim：${item.claim}`);
    }
  }
  return lines.join('\n');
}

/** 依赖缺了就当场说清楚，不许以"跑不起来所以跳过"收场。 */
function normalizeDeps(deps) {
  const source = deps !== null && typeof deps === 'object' ? deps : {};
  const missing = [];
  for (const name of ['deliver', 'writeLedger']) {
    if (typeof source[name] !== 'function') missing.push(name);
  }
  if (source.preset === null || typeof source.preset !== 'object') missing.push('preset');
  return { deps: source, missing };
}

/**
 * 跑一场会。
 *
 * @param {object} deps
 *   - `preset`（必填）：预设体（`lite@1.json` 的内容）。阶段顺序只从这里来。
 *   - `deliver`（必填）：`async ({stage, attempt, message, mode, agentId}) => {artifact, lastToolCall, alive}`。
 *     真实实现会创建/复用子会话；测试给一个假的。
 *   - `writeLedger`（必填）：`async (meeting) => {ok, rows, codes, ...}` —— 真实实现是
 *     `host/index.js` 的 `writeMeetingLedger`，**不在这里另写一套落盘**。
 *   - `now`（必填，函数）：时钟。`src` 里不许读时钟，所以这里也不许。
 *   - `candidate` / `seenIds` / `chooseAgent` / `judgeCard`：可选，缺省用 src 里的真判据。
 * @param {object} input `{ meeting, meetingId? }`
 * @returns {Promise<{ok: boolean, status: string, stop: string, trace: Array<object>,
 *   meeting: object, pending: Array<object>, errors: Array<object>, warnings: Array<object>}>}
 */
export async function driveMeeting(deps, input) {
  const { deps: d, missing } = normalizeDeps(deps);
  const start = input !== null && typeof input === 'object' ? input : {};
  const trace = [];
  const errors = [];
  const warnings = [];

  if (missing.length > 0) {
    return {
      ok: false,
      status: 'blocked',
      stop: 'deps',
      trace,
      meeting: start.meeting ?? null,
      pending: [],
      errors: [diag('E_ARTIFACT_MALFORMED', `驱动器缺少依赖：${missing.join('、')} —— 缺一样都不许开跑。`)],
      warnings,
    };
  }
  if (typeof d.now !== 'function') {
    /* 时钟只能由调用方给：`src` 里读时钟会让"多久算死"变成不可测的东西。 */
    return {
      ok: false,
      status: 'blocked',
      stop: 'clock',
      trace,
      meeting: start.meeting ?? null,
      pending: [],
      errors: [diag('E_RESUME_LIVENESS_UNKNOWN', '驱动器没拿到 now() —— 判不了存活，所以不开跑。')],
      warnings,
    };
  }

  const preset = d.preset;
  const chooseAgent = typeof d.chooseAgent === 'function' ? d.chooseAgent : decideAgent;
  const judgeCard = typeof d.judgeCard === 'function' ? d.judgeCard : judgeArtifact;
  /** 已完成阶段的历史（喂下一阶段用）。 */
  const history = [];
  const seenIds = Array.isArray(d.seenIds) ? d.seenIds.slice() : [];
  let meeting = start.meeting;

  const stop = (reason, status, extra) => ({
    ok: status === 'done',
    status,
    stop: reason,
    trace,
    meeting,
    pending: [],
    errors,
    warnings,
    ...(extra ?? {}),
  });

  /* ── 逐阶段 ─────────────────────────────────────────────────────────────── */
  for (let guard = 0; guard < 64; guard += 1) {
    const next = nextStage({ meeting, preset });

    if (next.done === true) break;
    if (next.ok !== true || next.blocked === true) {
      /* `blocked` 是"判不了/不能跑"，**不是** done。绝不跳过它继续跑下一阶段：
       * 跳过 = 让一场会带着一个没跑的阶段走到收尾。 */
      errors.push(...(Array.isArray(next.errors) ? next.errors : []));
      return stop('blocked', 'blocked');
    }

    const stage = next.stage;
    const attempt = next.attempt;
    const stageId = stage.id;

    /* 代理模式：判据在 `agentpool.mjs`，这里只递料。
     *
     * **`attempt` 必须传**：`defaultAgentMode` 的第③条（返工 → fork）唯一的触发条件就是
     * `attempt >= 2`，缺省是 1，于是 fork 永远不会触发 —— 一条永不发声的判据与"空通道"
     * 是同一类病。同理 `candidate.role` 决定第④条（跨会议同角色 → reuse）能不能触发。
     *
     * **`role` 不填 `stage.role`**：`agentRole` 问的是"这个 agent **承担过**什么角色"，
     * 拿"这一阶段要什么角色"顶上去等于凭空断言它承担过 —— 那正是"编一个"。
     * 真值只能来自候选人自己（`candidate.role`）或 roster，本层一个都不编。 */
    /* 候选人：显式注入的优先（测试用），否则从名册现算。
     * `agentId` 来自账本里我们自己写的那格 `agent`，`role` 来自预设 —— 两者按 `stageId` 关联。 */
    const candidate = d.candidate
      ?? candidateFromRoster({
        entries: d.roster ?? [],
        preset,
        meetingId: start.meetingId ?? meeting?.id ?? '',
        stage,
      });

    const decision = chooseAgent({
      stage,
      attempt,
      candidate,
      previousStage: history.length > 0 ? history[history.length - 1].stageId : null,
      previousAgent: history.length > 0 ? history[history.length - 1].agentId : null,
      seenIds,
      withheldIds: Array.isArray(stage.withheld) ? stage.withheld : [],
      meetingId: start.meetingId ?? meeting?.id ?? null,
      completedStages: history.length,
    });

    if (decision.ok !== true) {
      errors.push(...(Array.isArray(decision.errors) ? decision.errors : []));
      return stop('agent', 'blocked');
    }

    /* 信任边界：驱动器是最终写账本的人。判据在 `decideAgent`，但拿到答案之后
     * 这条**事实**还要再核一次 —— 盲阶段没有"作者"可复用。码是同一个
     * `E_BLIND_AGENT_REUSED`：同一条事实，不是第二份判据。 */
    if (stage.blind === true && decision.mode === 'reuse') {
      errors.push(diag(
        'E_BLIND_AGENT_REUSED',
        `阶段 ${stageId} 是盲阶段，但代理选择给了 reuse —— 盲评不许复用被评的人，`
          + '否则"看不见作者的推理"就是一句空话。',
        stageId,
      ));
      return stop('blind-reuse', 'blocked');
    }

    const message = composeDelivery({
      stage,
      history,
      blind: stage.blind === true,
      question: typeof meeting?.question === 'string' ? meeting.question : '',
    });
    /* 组装完**立刻查一遍它真的干净**（P3-11，`E_BLIND_LEAK` 的生产发射点）。
     *
     * 在这之前这条 blocker 只有码名、没有任何检测点：`composeDelivery` 剔推理、藏产物，
     * 却不检查结果。一次漏填、一次多拼，盲阶段就静默失效了 ——
     * 而账本、门禁、页面全部正常显示。这是本项目第五次撞上"看起来两边都在、实际只有一侧"。
     *
     * 判据不由这里写：调 `delivery.mjs` 的 `detectBlindLeak`，它自己会在非盲阶段直接放行。 */
    const leak = detectBlindLeak({
      stage,
      message,
      forbiddenIds: Array.isArray(stage.withheld) ? stage.withheld : [],
    });
    if (leak.ok !== true) {
      errors.push(...leak.errors);
      return stop('blind-leak', 'blocked');
    }

    const reply = await d.deliver({
      stage,
      attempt,
      message,
      mode: decision.mode,
      agentId: decision.agentId,
    });

    /* 记下"这一阶段是谁干的"。宿主没有"列出子会话"的接口，所以这一格就是下一次
     * **唯一**的"谁存在"来源（`agentRoster` 从阶段块的 `agent` 读回来）。
     * 拿不到 id 就**不挂这个键** —— 绝不编一个占位 id。 */
    const childId = typeof reply?.childId === 'string' && reply.childId !== '' ? reply.childId : null;

    /* 投递本身失败（宿主拒绝目标 / 没有能力 / 拿不到子会话 id）：**如实停**。
     * 绝不静默退回 fresh 重跑一遍 —— 那会变成一个阶段跑两次、账本只记第二次，
     * 正是 `E_LEDGER_WRITE_FAILED` 那条码要防的事。 */
    if (reply?.ok === false) {
      errors.push(diag(
        'E_RESUME_NO_TARGET',
        `阶段 ${stageId} 没能投出去（${reply.reason ?? '未知原因'}）：`
          + `${typeof reply.message === 'string' ? reply.message : '（宿主没有给出原因）'} `
          + '**不会退回 fresh 重跑** —— 重跑会让同一阶段执行两次，而账本只记第二次。',
        stageId,
      ));
      trace.push({ stageId, attempt, mode: decision.mode, agentId: decision.agentId, rule: decision.rule ?? null, message, tier: reply.tier ?? null, via: reply.via ?? null, delivered: false, liveness: 'unknown', judged: null, recorded: null, written: null });
      return stop('deliver', 'blocked');
    }

    /* ── 死亡与「继续」──────────────────────────────────────────────────────
     * 存活判定的时间只从 `d.now()` 来。dead 时由**主对话**发一条「继续」
     * （五个必填要素由 `composeContinueMessage` 组，别自己拼）。 */
    const liveness = assessLiveness({
      meeting,
      now: d.now(),
      lastToolCall: reply?.lastToolCall,
    });
    const entry = {
      stageId,
      attempt,
      mode: decision.mode,
      agentId: decision.agentId,
      /* 凭**哪条规则**选出这个模式（`blind-fresh` / `rework-fork` / `cross-meeting-reuse` /
       * `fallback-fresh` …）。只记 `mode` 的话，"fork 真的触发了"与"恰好看起来像 fork"
       * 分不开 —— 那正是本轮抓到的"空断言"形状。 */
      rule: typeof decision.rule === 'string' ? decision.rule : null,
      message,
      /* 投递档位（`startActivation` / `queue` / `steer`）来自 `pickDelivery`，
       * 这里原样记下来 —— 验收要的"每阶段投递档位"就是这一格。 */
      tier: typeof reply?.tier === 'string' ? reply.tier : null,
      via: typeof reply?.via === 'string' ? reply.via : null,
      delivered: reply?.ok !== false,
      liveness: liveness.status,
      judged: null,
      recorded: null,
      written: null,
    };
    trace.push(entry);

    if (liveness.status === 'dead') {
      const continues = typeof d.continuesFor === 'function' ? d.continuesFor(stageId, attempt) : 0;
      if (continues >= MAX_CONTINUES_PER_ATTEMPT) {
        errors.push(diag(
          'E_RESUME_EXHAUSTED',
          `阶段 ${stageId} 第 ${attempt} 轮已经发过 ${continues} 次「继续」，`
            + '仍然没有回执 —— 交人，不许换人硬续。',
          stageId,
        ));
        return stop('exhausted', 'blocked');
      }
      const message2 = composeContinueMessage({
        stage,
        attempt,
        completedCount: history.length,
        previousClaim: history.length > 0 ? (history[history.length - 1].claim ?? '') : '',
        totalStages: Array.isArray(preset.stages) ? preset.stages.length : 0,
      });
      if (message2.ok !== true) {
        errors.push(...(Array.isArray(message2.errors) ? message2.errors : []));
        return stop('continue', 'blocked');
      }
      if (typeof d.sendContinue === 'function') {
        await d.sendContinue({ stage, attempt, message: message2.message });
      }
      /* 这一轮不算完成：不记账、不推进。同一 attempt 留在原地等回执。 */
      continue;
    }

    /* ── 判卡 ────────────────────────────────────────────────────────────────
     * **判不了绝不放行**：缺必须字段 / killScenarios 不够 / decision 不合法 ——
     * 一律停在这里。绝不"为了跑通自动降低要求"。 */
    const judged = judgeCard({ stage, raw: reply?.artifact });
    entry.judged = {
      ok: judged.ok === true,
      codes: [...new Set((Array.isArray(judged.errors) ? judged.errors : []).map((e) => e.code))],
      cannotJudge: typeof judged.cannotJudge === 'string' ? judged.cannotJudge : null,
    };
    if (judged.ok !== true) {
      errors.push(...(Array.isArray(judged.errors) ? judged.errors : []));
      return stop('artifact', 'blocked');
    }

    /* ── 记账 ──────────────────────────────────────────────────────────────── */
    /* 这一阶段实际交了哪些**必产**字段：拿 `mustProduce` ∩ 卡上真有值的键。
     * 不用 `Object.keys(card)` —— 那会把 `id` / `basis` 这类通用字段也报成交付物。 */
    const card = judged.card ?? {};
    const produced = (Array.isArray(stage.mustProduce) ? stage.mustProduce : []).filter((key) => {
      const value = card[key];
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'string') return value.trim() !== '';
      return value !== undefined && value !== null;
    });
    const recorded = recordSubmission({
      meeting,
      stageId,
      attempt,
      status: 'done',
      produced: typeof d.producedOf === 'function' ? d.producedOf({ stage, card }) : produced,
      /* 提交时**必须**记时间：下一阶段判存活靠的就是 `lastArtifactAt(meeting)`。
       * 不记时间的话 `assessLiveness` 永远只能说"判不了它慢还是死" —— 那会让
       * 「继续」这条通道在最需要它的时候完全失效。
       * 时间只从 `d.now()` 来（`src` 里读时钟是禁止的，这里格式化一下不违反）。 */
      at: isoOf(d.now()),
    });
    entry.recorded = recorded.ok === true ? { duplicate: recorded.duplicate === true } : { duplicate: false };
    if (recorded.ok !== true) {
      errors.push(...(Array.isArray(recorded.errors) ? recorded.errors : []));
      return stop('record', 'blocked');
    }

    /* 卡挂在阶段记录上（`recordSubmission` 不管卡），
     * 并把**这一阶段是谁干的**记进 `agent` 那一格（下一次的"谁存在"就从这里读回）。 */
    const withCard = {
      ...recorded.meeting,
      stages: (Array.isArray(recorded.meeting?.stages) ? recorded.meeting.stages : []).map((row) => (
        row !== null && typeof row === 'object' && row.stageId === stageId
          ? {
            ...row,
            card: reply?.artifact,
            ...(childId === null
              /* 这一次没拿到 id：**保留原值**（可能是上一次记下的），绝不覆盖成空、
               * 更不编一个。 */
              ? {}
              : { agent: childId }),
          }
          : row
      )),
    };

    const written = await d.writeLedger(withCard);
    entry.written = {
      ok: written?.ok === true,
      okCount: Array.isArray(written?.rows) ? written.rows.filter((row) => row.status === 'ok').length : 0,
      codes: Array.isArray(written?.codes) ? written.codes.slice() : [],
    };
    if (written?.ok !== true) {
      /* **写失败必须停，且绝不重发这个阶段。** 重发会让同一阶段执行两次，
       * 而账本只记第二次 —— 那是一场会最难查的一类账。 */
      for (const code of entry.written.codes) {
        errors.push(diag(code, `账本没记上阶段 ${stageId}：写失败。**不会重发这个阶段。**`, stageId));
      }
      if (entry.written.codes.length === 0) {
        errors.push(diag(
          'E_LEDGER_WRITE_FAILED',
          `账本没记上阶段 ${stageId}：写失败且没有给出码。**不会重发这个阶段。**`,
          stageId,
        ));
      }
      meeting = withCard; /* 内存里保留，便于报告读回 */
      return stop('write', 'blocked');
    }

    meeting = withCard;
    if (decision.agentId !== null && decision.agentId !== undefined) seenIds.push(decision.agentId);
    history.push({
      stageId,
      attempt,
      agentId: decision.agentId ?? null,
      claim: typeof judged.card?.claim === 'string' ? judged.card.claim : '',
      produced: Array.isArray(stage.mustProduce) ? stage.mustProduce.slice() : [],
    });
  }

  /* ── 收尾 ─────────────────────────────────────────────────────────────────
   * 全部阶段 done → `status: done`，并给出「待你拍板清单」。
   * 冲突项**不替人裁定**：`decided` 为空就是空，绝不改写成"已裁定"。 */
  const finishing = { ...meeting, status: 'done' };
  const written = await d.writeLedger(finishing);
  if (written?.ok !== true) {
    errors.push(diag('E_LEDGER_WRITE_FAILED', '收尾时账本没记上（会议状态改 done 失败）。'));
    return stop('write', 'blocked');
  }
  meeting = finishing;

  const pending = (Array.isArray(meeting.stages) ? meeting.stages : [])
    .filter((row) => row !== null && typeof row === 'object')
    /* 冲突挂在阶段记录的**卡**上（`row.card.conflictsWith`），不在阶段记录本身。
     * 读错一层就会永远得到一张空的「待你拍板清单」—— 那比不生成更坏：它看起来像"没有冲突"。 */
    .filter((row) => Array.isArray(row.card?.conflictsWith) && row.card.conflictsWith.length > 0)
    .map((row) => ({
      stageId: row.stageId,
      conflictsWith: row.card.conflictsWith.slice(),
      claim: typeof row.card.claim === 'string' ? row.card.claim : '',
      /* 空数组就是"没人裁定过"。这里绝不写 '已裁定'。 */
      decided: [],
    }));

  return {
    ok: true,
    status: 'done',
    stop: 'done',
    trace,
    meeting,
    pending,
    errors,
    warnings,
  };
}