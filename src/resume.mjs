/**
 * resume.mjs — 「继续」的判据层。
 *
 * **纯函数，零 IO，也没有 `Date.now()`。**
 * 时间一律由调用方作为参数传进来。这不是洁癖：一个模块内部读时钟，
 * 它的输出就不可复现，而"这个 agent 到底死没死"这种判断**必须可复现** ——
 * 否则同一份账本隔一分钟算两次会给出两个答案，而没人能说清哪个对。
 *
 * ## 三层分工（方案 §5）
 *
 * | 层 | 谁做 | 做什么 |
 * |---|---|---|
 * | 判据 | **本模块** | 输出 `alive` / `stalled` / `dead` / `unknown`，以及"该等 / 该发继续 / 该换人 / 该交人" |
 * | 决策 | 领导（主对话 Agent） | 看判据，拍板 |
 * | 执行 | `host/meeting.js` | 真发消息、真写账本、真去重 |
 *
 * 本模块**不做决定**，只把证据摆全、把该说的说清。所以它同时输出
 * `reason`（为什么是这两个字）和 `cannotJudge`（这一次判不了什么）。
 *
 * ## 五条硬规矩（方案 §5「五条硬规矩」，逐条对应到函数）
 *
 * 1. **幂等** —— `recordContinue` 用 `(meetingId, stageId, attempt)` 去重。
 *    连发 N 次 = 1 次。（方案原话）
 * 2. **明确起点** —— `composeContinueMessage` 必须写出"从哪个阶段、第几轮、已完成几张卡"。
 *    只有两个字的「继续」等于让 agent 自己猜上下文。
 * 3. **空态显式** —— 没有未完成的会议 → `E_RESUME_NO_TARGET`，
 *    说"当前没有未完成的会议"，**不是**沉默。
 * 4. **不猜测不重来** —— 账本读不出来 → `E_LEDGER_UNREADABLE`，
 *    **绝不**从第一阶段重来。（判据来自 `meeting.mjs`，本模块只搬）
 * 5. **有限止损** —— 同阶段继续满 3 次仍无产物 → `E_RESUME_EXHAUSTED`，强制交人。
 *
 * ## 判不了什么（写清楚，不装作能判）
 *
 * - 判不了"agent 是死了还是只是慢"。`dead` 只意味着"超过阈值没有任何新产物"。
 *   一个跑 20 分钟长任务的 agent 与一个挂掉的 agent，在账本上**长得一样**。
 *   所以 `dead` 的处置建议是"交人看一眼"，不是"自动杀掉换人"。
 * - 判不了"它现在在干什么"。`lastToolCall` 是调用方告诉我的一条线索，
 *   我原样带出去，不解读工具名的语义。
 * - 判不了"继续一次值不值"。`E_RESUME_EXHAUSTED` 只数次数，不评内容。
 */

import { MEETING_STATUSES, nextStage, meetingState, idempotencyKey } from './meeting.mjs';

/**
 * 存活判定。四态，且**不许合并**。
 *
 * `unknown` 必须独立存在：没有时间戳时既不能说它还活着，也不能说它死了。
 * 把 `unknown` 折进 `dead` 会误杀，折进 `alive` 会让你永远等下去 ——
 * 两种合并都是拿沉默冒充结论。
 */
export const LIVENESS_STATES = Object.freeze(['alive', 'stalled', 'dead', 'unknown']);

/** 该做什么。四选一，不是"建议"而是"判据支持的四个动作"。 */
export const RESUME_ACTIONS = Object.freeze(['wait', 'continue', 'new-agent', 'hand-to-human']);

/**
 * 静默多久算 `stalled` / `dead`（毫秒）。
 *
 * **这两个数是**猜测，不是测量结果**。** 它们是我的选择，不是这个系统的发现。
 * 所以：调用方可以覆盖；文档里写着；判据输出里带着"我用了哪个阈值"。
 * 一个不说明自己用的什么阈值的"它死了"，等于一句没有依据的判决。
 *
 * 取值理由（也只能是理由，不是证据）：
 *   stailed 3 分钟 —— 一次长工具调用（跑测试、读大文件）常见在这个量级。
 *   dead 15 分钟 —— 远超任何单次工具调用，到这个点基本可以确定没有在推进。
 */
export const DEFAULT_SILENCE_THRESHOLDS = Object.freeze({
  stalledMs: 3 * 60 * 1000,
  deadMs: 15 * 60 * 1000,
});

/** 同阶段最多继续几次就强制交人（方案 §5 规矩 5）。 */
export const MAX_CONTINUES_PER_ATTEMPT = 3;

/**
 * 一条诊断。形状与 `meeting.mjs` / `preset.mjs` 的 `diag` 一致。
 * @param {string} code
 * @param {string} message
 * @param {string} [stageId]
 * @returns {{code: string, message: string, stageId?: string}}
 */
function diag(code, message, stageId) {
  return stageId === undefined ? { code, message } : { code, message, stageId };
}

/**
 * 把各种时间写法归一成毫秒数。
 *
 * 接受：
 *   - 数字（已经是毫秒时间戳）
 *   - ISO 字符串（`new Date(...).getTime()` 能解析的）
 *   - `Date` 实例
 * 其余一律 `null` —— **不猜**。
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function toMillis(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) && time > 0 ? time : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const time = Date.parse(value);
    return Number.isFinite(time) && time > 0 ? time : null;
  }
  return null;
}

/**
 * 从账本里取"最后一次有产物的时间"。
 *
 * 取所有阶段记录里 `at` 的最大值。**没有就返回 null** ——
 * 返回 0 或 now 都会让 `silenceMs` 变成一个编出来的数。
 *
 * @param {unknown} meeting
 * @returns {number|null}
 */
export function lastArtifactAt(meeting) {
  const stages = Array.isArray(meeting?.stages) ? meeting.stages : [];
  let latest = null;
  for (const record of stages) {
    if (record === null || typeof record !== 'object') continue;
    const time = toMillis(record.at);
    if (time === null) continue;
    if (latest === null || time > latest) latest = time;
  }
  return latest;
}

/**
 * 判定存活。
 *
 * @param {object} input
 *   { meeting, now, stalledMs, deadMs, lastToolCall }
 *   `now` **必须**由调用方给（数字或可解析的时间）。缺了就返回 `unknown`。
 * @returns {{status: string, silenceMs: number|null, lastArtifactAt: number|null,
 *            thresholds: {stalledMs: number, deadMs: number},
 *            reason: string, cannotJudge: string, lastToolCall: string|null}}
 */
export function assessLiveness(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const stalledMs = Number.isFinite(source.stalledMs) && source.stalledMs > 0
    ? source.stalledMs
    : DEFAULT_SILENCE_THRESHOLDS.stalledMs;
  const deadMs = Number.isFinite(source.deadMs) && source.deadMs > 0
    ? source.deadMs
    : DEFAULT_SILENCE_THRESHOLDS.deadMs;
  const thresholds = { stalledMs, deadMs };

  const lastAt = lastArtifactAt(source.meeting);
  const now = toMillis(source.now);
  const lastToolCall = typeof source.lastToolCall === 'string' && source.lastToolCall !== ''
    ? source.lastToolCall
    : null;

  /* 时间不够 → unknown。三种情况都算"不够"：没 now、没 lastArtifactAt、
   * now 比 lastArtifactAt 还早（时钟不一致 / 账本来自未来）。 */
  if (now === null) {
    return {
      status: 'unknown',
      silenceMs: null,
      lastArtifactAt: lastAt,
      thresholds,
      reason: '调用方没有给"现在是什么时候"，所以算不出静默了多久。',
      cannotJudge: '判不了它是慢还是死 —— 没有时钟就没有静默时长。',
      lastToolCall,
    };
  }
  if (lastAt === null) {
    return {
      status: 'unknown',
      silenceMs: null,
      lastArtifactAt: null,
      thresholds,
      reason: '账本里没有任何阶段产物的时间戳，算不出静默了多久。',
      cannotJudge: '判不了它是慢还是死 —— 账本上根本没有时间可算。'
        + '注意这与"刚开完会、还什么都没交"是两件事：那种情况下账本也该有 createdAt。',
      lastToolCall,
    };
  }
  if (now < lastAt) {
    return {
      status: 'unknown',
      silenceMs: null,
      lastArtifactAt: lastAt,
      thresholds,
      reason: `"现在"（${now}）比最后一次产物（${lastAt}）还早 —— 时钟不一致或账本来自未来。`,
      cannotJudge: '判不了静默时长 —— 两个时间点的先后关系本身就不成立。',
      lastToolCall,
    };
  }

  const silenceMs = now - lastAt;
  if (silenceMs >= deadMs) {
    return {
      status: 'dead',
      silenceMs,
      lastArtifactAt: lastAt,
      thresholds,
      reason: `已经 ${Math.round(silenceMs / 1000)} 秒没有任何新产物，超过 dead 阈值 ${Math.round(deadMs / 1000)} 秒。`,
      cannotJudge: '判不了它是真的挂了还是卡在一个很长的任务里 —— '
        + '账本只看得到"没有新产物"，看不到它内部在干什么。所以建议是"交人看一眼"，不是"自动杀掉换人"。',
      lastToolCall,
    };
  }
  if (silenceMs >= stalledMs) {
    return {
      status: 'stalled',
      silenceMs,
      lastArtifactAt: lastAt,
      thresholds,
      reason: `已经 ${Math.round(silenceMs / 1000)} 秒没有新产物，超过 stalled 阈值 ${Math.round(stalledMs / 1000)} 秒，但还没到 dead。`,
      cannotJudge: '判不了它是在想还是在等 —— 这个区间里"慢"与"停"分不开。',
      lastToolCall,
    };
  }

  return {
    status: 'alive',
    silenceMs,
    lastArtifactAt: lastAt,
    thresholds,
    reason: `距最后一次产物 ${Math.round(silenceMs / 1000)} 秒，未超过 stalled 阈值。`,
    cannotJudge: '判不了它接下来会不会卡住 —— 活着不等于会推进。',
    lastToolCall,
  };
}

/**
 * 「继续」的幂等键。
 *
 * **比提交的幂等键多一段 `seq`**（第几次继续），这不是随便加的 —— 见下面
 * `recordContinue` 上方那段关于"规矩 1 与规矩 5 打架"的说明。
 *
 * 用 `\u0000` 分隔，理由同 `meeting.mjs`：`a:b`+`c` 与 `a`+`b:c` 用 `:` 拼会撞。
 *
 * @param {string} meetingId
 * @param {string} stageId
 * @param {number} attempt
 * @param {number} seq
 * @returns {string}
 */
export function continueKey(meetingId, stageId, attempt, seq) {
  return `${meetingId}\u0000${stageId}\u0000${attempt}\u0000${seq}`;
}

/**
 * 取某个 `(stageId, attempt)` 已经继续过几次。
 *
 * **只数不同的 `seq`**。同一条继续被重复投递（网络重试、调用方重发）
 * 不会让它变成两次 —— 那是规矩 1（幂等）的地盘；
 * 而"催了第 1 次、第 2 次、第 3 次"是三个不同的事件，那是规矩 5（止损）的地盘。
 *
 * @param {unknown} meeting
 * @param {string} stageId
 * @param {number} attempt
 * @returns {number}
 */
export function continueCount(meeting, stageId, attempt) {
  const resumes = Array.isArray(meeting?.resumes) ? meeting.resumes : [];
  const seqs = new Set();
  for (const item of resumes) {
    if (item === null || typeof item !== 'object') continue;
    if (item.stageId !== stageId) continue;
    if (item.attempt !== attempt) continue;
    if (!Number.isSafeInteger(item.seq) || item.seq < 1) continue;
    seqs.add(item.seq);
  }
  return seqs.size;
}

/**
 * 记一次「继续」。
 *
 * **纯函数**：不改编本，返回新账本。
 *
 * ## 这里有一条规矩打架，必须说清楚（实测发现的）
 *
 * 方案 §5 同时给了两条规矩：
 *   规矩 1「幂等：连发 N 次 = 1 次，靠 `(meetingId, stageId, attempt)` 去重」
 *   规矩 5「有限止损：同阶段继续满 3 次仍无产物 → 强制交人」
 *
 * **按字面实现，这两条互相取消**：如果同一 `(meetingId, stageId, attempt)`
 * 的所有继续都折叠成 1 次，那么计数永远到不了 3，
 * `E_RESUME_EXHAUSTED` 就成了一个**永远不可能出现**的码。
 *
 * 实测确认过：连发 4 次，`count` 一直是 1。
 *
 * 所以正确的分解是：
 *   - **幂等保护的是"同一条继续被重复投递"**（网络重试、调用方重发同一份请求）→ 用 `seq` 去重
 *   - **止损数的是"真的催了第几次"**（每条之间隔着一次观察：等过、看过、还是没产物）
 *
 * 于是键里多一段 `seq`（第几次继续），由调用方给或自动取"下一个序号"。
 * `seq` 相同的重复投递是 no-op；`seq` 不同的分别计数，到 3 就止损。
 *
 * @param {object} input { meeting, stageId, attempt, seq, at, by }
 * @returns {{ok: boolean, meeting: object, duplicate: boolean, count: number,
 *            seq: number, errors: Array<object>}}
 */
export function recordContinue(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const meeting = source.meeting;

  if (meeting === null || typeof meeting !== 'object' || Array.isArray(meeting)) {
    return {
      ok: false,
      meeting,
      duplicate: false,
      count: 0,
      seq: 0,
      errors: [diag(
        'E_LEDGER_UNREADABLE',
        '记「继续」时账本不是一个对象 —— 连"发过几次"都记不下来。先修账本，或交人。',
      )],
    };
  }
  const stageId = typeof source.stageId === 'string' ? source.stageId : '';
  if (stageId === '') {
    return {
      ok: false,
      meeting,
      duplicate: false,
      count: 0,
      seq: 0,
      errors: [diag('E_ARTIFACT_MALFORMED', '记「继续」时缺少 stageId —— 不知道是往哪个阶段发的。')],
    };
  }
  if (!Number.isSafeInteger(source.attempt) || source.attempt < 1) {
    return {
      ok: false,
      meeting,
      duplicate: false,
      count: 0,
      seq: 0,
      errors: [diag(
        'E_ARTIFACT_MALFORMED',
        `记「继续」时 attempt 必须是正整数，收到 ${JSON.stringify(source.attempt)} —— `
          + '轮次不明确时，"这一轮发过几次继续"就没有答案。',
        stageId,
      )],
    };
  }

  const meetingId = typeof meeting.id === 'string' ? meeting.id : '';
  const resumes = Array.isArray(meeting.resumes) ? meeting.resumes.slice() : [];
  const used = continueCount(meeting, stageId, source.attempt);

  /* `seq` 的取法：
   *   调用方给了合法值 → 用它（重试同一条时必须给同一个 seq，那才是幂等）
   *   没给 → 取下一个序号（"再催一次"的自然语义）
   * 给了非法值（0 / 负数 / 小数 / 字符串）→ 报错，**不猜**。 */
  let seq;
  if (source.seq === undefined) {
    seq = used + 1;
  } else if (Number.isSafeInteger(source.seq) && source.seq >= 1) {
    seq = source.seq;
  } else {
    return {
      ok: false,
      meeting,
      duplicate: false,
      count: used,
      seq: 0,
      errors: [diag(
        'E_ARTIFACT_MALFORMED',
        `记「继续」时 seq 必须是正整数或干脆不给，收到 ${JSON.stringify(source.seq)} —— `
          + '序号不明确时，重复投递与"又催了一次"就分不开了。',
        stageId,
      )],
    };
  }

  const key = continueKey(meetingId, stageId, source.attempt, seq);
  const already = resumes.some((item) => item !== null && typeof item === 'object' && item.key === key);
  if (already) {
    return {
      ok: true,
      meeting,
      duplicate: true,
      count: used,
      seq,
      errors: [],
    };
  }

  const record = { key, stageId, attempt: source.attempt, seq };
  if (typeof source.at === 'string' && source.at !== '') record.at = source.at;
  if (typeof source.by === 'string' && source.by !== '') record.by = source.by;
  resumes.push(record);

  const next = { ...meeting, resumes };
  return {
    ok: true,
    meeting: next,
    duplicate: false,
    count: continueCount(next, stageId, source.attempt),
    seq,
    errors: [],
  };
}

/**
 * 组装「继续」消息。
 *
 * 方案的原话：**不能只有两个字**。一条只有「继续」的消息等于让 agent
 * 自己猜它在哪、该交什么 —— 而对一个刚被唤醒的 agent 来说，猜错的概率很高。
 *
 * 模板要素（方案 §5 已给定，这里逐项落实）：
 *   你在第 N 阶段 X（attempt M）
 *   上一张卡：<上一阶段> 的 claim 是「…」
 *   现在要交：<必产字段>，形状见 submit_artifact 参数说明
 *   已有产物不要重交
 *
 * **注入面**：`claim` 是模型写的文本，而这条消息会进另一个模型的提示词。
 * 所以换行压平、半角 `#` 去掉（防止伪造标题层级）、长度截断 ——
 * 与 `handoff` 的渲染纪律同一条。这里不追求"净化到绝对安全"（做不到），
 * 只保证它不能靠**换行与标题**改变消息的结构。
 *
 * @param {object} input
 *   { stage, attempt, completedCount, previousClaim, totalStages }
 * @returns {{ok: boolean, message: string, errors: Array<object>}}
 */
export function composeContinueMessage(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const stage = source.stage !== null && typeof source.stage === 'object' ? source.stage : null;
  if (stage === null || typeof stage.id !== 'string' || stage.id === '') {
    return {
      ok: false,
      message: '',
      errors: [diag('E_ARTIFACT_MALFORMED', '组装「继续」消息时没有当前阶段 —— 说不清"你在第几阶段"。')],
    };
  }
  const attempt = Number.isSafeInteger(source.attempt) && source.attempt >= 1 ? source.attempt : 1;

  /** 把一段模型写的文本压成一行、去掉能改变结构的东西、截断。 */
  const flatten = (text, limit) => {
    if (typeof text !== 'string') return '';
    const oneLine = text.replace(/[\r\n]+/g, ' ').replace(/#/g, '＃').replace(/\s+/g, ' ').trim();
    return oneLine.length > limit ? `${oneLine.slice(0, limit)}…（已截断）` : oneLine;
  };

  const mustProduce = Array.isArray(stage.mustProduce) ? stage.mustProduce.filter((f) => typeof f === 'string') : [];
  const producedText = mustProduce.length === 0 ? '（这一阶段没有声明必产字段）' : mustProduce.join(' + ');
  const role = typeof stage.role === 'string' ? stage.role : '（未声明角色）';
  const completed = Number.isSafeInteger(source.completedCount) && source.completedCount >= 0
    ? source.completedCount
    : 0;
  const total = Number.isSafeInteger(source.totalStages) && source.totalStages > 0
    ? source.totalStages
    : null;

  const lines = [];
  lines.push(`你在第 ${stage.order} 阶段 ${stage.id}（角色 ${role}，attempt ${attempt}）。`);
  if (total !== null) {
    lines.push(`整场会共 ${total} 个阶段，已完成 ${completed} 张卡。`);
  } else {
    lines.push(`已完成 ${completed} 张卡。`);
  }

  const claim = flatten(source.previousClaim, 120);
  if (claim !== '') {
    const from = typeof source.previousStageId === 'string' && source.previousStageId !== ''
      ? source.previousStageId
      : '上一阶段';
    lines.push(`上一张卡：${from} 的 claim 是「${claim}」。`);
  } else {
    lines.push('上一张卡：没有可引用的 claim（这是第一张卡，或上一张卡没交 claim）。');
  }

  lines.push(`现在要交：${producedText}，形状见 submit_artifact 的参数说明。`);
  lines.push('已有产物不要重交。');

  return { ok: true, message: lines.join('\n'), errors: [] };
}

/**
 * 判据总装：一场会议现在该等、该发继续、该换人，还是该交人。
 *
 * 这是领导要看的那个东西。它把三件事拼在一起：
 *   - `meeting.mjs` 的"跑到哪了"（不重算，直接用）
 *   - `assessLiveness` 的"它还在动吗"
 *   - `continueCount` 的"这一轮已经催过几次了"
 *
 * @param {object} input
 *   { meeting, preset, now, stalledMs, deadMs, lastToolCall, previousClaim, previousStageId }
 * @returns {{ok: boolean, action: string, liveness: object, stage: object|null,
 *            attempt: number, completedCount: number, continueCount: number,
 *            ledgerTail: Array<object>, message: string,
 *            errors: Array<object>, warnings: Array<object>, cannotJudge: string}}
 */
export function resumeState(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const errors = [];
  const warnings = [];

  const state = meetingState({ meeting: source.meeting, preset: source.preset });
  const liveness = assessLiveness({
    meeting: source.meeting,
    now: source.now,
    stalledMs: source.stalledMs,
    deadMs: source.deadMs,
    lastToolCall: source.lastToolCall,
  });

  /* 账本上最后 3 条（领导要看的：刚才发生了什么）。
   * 顺序是**新的在前** —— 领导扫一眼先看到最近的，而不是要往下翻。 */
  const allStages = Array.isArray(source.meeting?.stages) ? source.meeting.stages : [];
  const ledgerTail = allStages
    .filter((r) => r !== null && typeof r === 'object')
    .slice()
    .sort((a, b) => {
      const ta = toMillis(a.at) ?? 0;
      const tb = toMillis(b.at) ?? 0;
      return tb - ta;
    })
    .slice(0, 3)
    .map((r) => ({
      stageId: typeof r.stageId === 'string' ? r.stageId : '',
      attempt: Number.isSafeInteger(r.attempt) ? r.attempt : 1,
      status: typeof r.status === 'string' ? r.status : '',
      at: typeof r.at === 'string' ? r.at : null,
    }));

  /* 账本读不出来 —— 规矩 4：不猜测、不重来。
   * 这里返回 `hand-to-human`，**不是** continue。 */
  if (!state.ok) {
    return {
      ok: false,
      action: 'hand-to-human',
      liveness,
      stage: null,
      attempt: 0,
      completedCount: 0,
      continueCount: 0,
      ledgerTail,
      message: '',
      errors: state.errors,
      warnings,
      cannotJudge: '账本读不出来时，"该不该继续"这个问题本身没有答案 —— 先修账本或交人。',
    };
  }

  /* 规矩 3：空态显式。 */
  const finished = state.phase === 'done' || state.phase === 'abandoned' || state.phase === 'ready-to-close';
  if (finished) {
    const next = nextStage({ meeting: source.meeting, preset: source.preset });
    if (next.done === true || state.phase === 'abandoned') {
      return {
        ok: true,
        action: 'hand-to-human',
        liveness,
        stage: null,
        attempt: 0,
        completedCount: state.completed.length,
        continueCount: 0,
        ledgerTail,
        message: '',
        errors: [],
        warnings: [
          ...state.warnings,
          diag(
            'E_RESUME_NO_TARGET',
            state.phase === 'abandoned'
              ? '当前没有未完成的会议可以继续（这场会议已被放弃）。'
              : '当前没有未完成的会议可以继续（这场会议的阶段都跑完了）。',
          ),
        ],
        cannotJudge: '没有可继续的阶段，"继续"这条动作在这里没有对象。',
      };
    }
  }

  const stage = state.currentStage;
  const attempt = state.attempt;
  const used = continueCount(source.meeting, stage.id, attempt);

  /* 规矩 5：有限止损。3 次之后仍无产物 → 强制交人。
   * 注意判据是"**这一轮**已经催过几次"，不是"总共催过几次" ——
   * 换了轮次就该重新计数，否则第二轮一上来就已经用完了配额。 */
  if (used >= MAX_CONTINUES_PER_ATTEMPT) {
    return {
      ok: false,
      action: 'hand-to-human',
      liveness,
      stage,
      attempt,
      completedCount: state.completed.length,
      continueCount: used,
      ledgerTail,
      message: '',
      errors: [diag(
        'E_RESUME_EXHAUSTED',
        `${stage.id} 的第 ${attempt} 轮已经连续发过 ${used} 次「继续」，仍然没有产物 —— 止损，交人。`
          + '再发第 ' + (used + 1) + ' 次大概率只是让一个坏掉的 agent 多跑一轮。'
          + '交人时请把这一轮的三条线索一起带上：最后产物时间、静默时长、最后一次工具调用。',
        stage.id,
      )],
      warnings: state.warnings,
      cannotJudge: '判不了"是 agent 坏了还是这件事本身做不出来" —— 两种都要交人，所以不细分。',
    };
  }

  /* 到这里才轮到存活判定。
   * 顺序是有意的：**先问"还能不能催"，再问"它死没死"** ——
   * 因为催满 3 次之后，无论它死没死都该交人，不该再往下算。 */
  let action;
  if (liveness.status === 'alive') {
    action = 'wait';
  } else if (liveness.status === 'stalled') {
    action = 'continue';
  } else if (liveness.status === 'dead') {
    action = 'new-agent';
  } else {
    /* unknown：既不能说它在动，也不能说它死了。
     * 这时候发「继续」是**安全的**（幂等、且它确实没在推进），
     * 但必须让领导看见"我是因为不知道才发的"。 */
    action = 'continue';
    warnings.push(diag(
      'E_RESUME_LIVENESS_UNKNOWN',
      `存活判定是 unknown（${liveness.reason}）—— 判不出它是在跑还是停了。`
        + '这时发「继续」是安全的：幂等、且如果它真在跑，这一条不会产生第二个产物。'
        + '但请把"这是因为判不出来而发的"记住，别当成"确认它卡住了"。',
      stage.id,
    ));
  }

  const composed = composeContinueMessage({
    stage,
    attempt,
    completedCount: state.completed.length,
    previousClaim: source.previousClaim,
    previousStageId: source.previousStageId,
    totalStages: Array.isArray(source.preset?.stages) ? source.preset.stages.length : null,
  });

  return {
    ok: true,
    action,
    liveness,
    stage,
    attempt,
    completedCount: state.completed.length,
    continueCount: used,
    ledgerTail,
    /* 只有真要发的时候才给消息；`wait` / `new-agent` 不该拿一份要发的东西。
     * 给了会诱导调用方"反正消息有了，不如发了吧"。 */
    message: action === 'continue' ? composed.message : '',
    errors: [],
    /* 三处 warning 必须合并：meeting.mjs 的、本函数自己加的（unknown 那条）、
     * 以及组装消息时的报错。
     * 第一版这里写成了 `[...state.warnings, ...composed.errors]`，
     * 把局部 `warnings` 整个漏掉了 —— 于是"因为判不出来才发的继续"
     * 那条说明在最需要它的时候不会出现，而 R5b 抓到的就是这个。 */
    warnings: [...state.warnings, ...warnings, ...composed.errors],
    cannotJudge: liveness.cannotJudge,
  };
}

/**
 * 一组可以继续的会议状态 —— 从 `meeting.mjs` 转出，避免两处各写一份判据。
 */
export { MEETING_STATUSES };
