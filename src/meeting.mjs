/**
 * meeting.mjs — 会议状态机。
 *
 * **纯函数，零 IO。** 这一层只回答三个问题：
 *   1. 现在该跑哪个阶段、第几轮？（`nextStage`）
 *   2. 整场会开到哪了、能不能收？（`meetingState`）
 *   3. 换个档位行不行？（`canUpgrade` —— 转给 `preset.mjs` 的判据）
 *
 * 真正建子会话、发消息、写账本的是 `host/meeting.js`。它只做搬运。
 *
 * ## 为什么状态机必须独立成一个纯模块
 *
 * 因为"跑到哪了"这个问题**一旦由有 IO 的那一层回答，就再也测不动了**。
 * 本项目反复在治的病是"同一个事实写在 N 处，漂移时静默" ——
 * 如果"当前阶段"既能在账本里读、又能在某个内存变量里算，
 * 两者迟早分叉，而分叉的那天没人知道该信哪个。
 * 所以：**账本是唯一真相，本模块是唯一算法。**
 *
 * ## 四条硬规矩（都是方案里被明确拍过的）
 *
 * 1. **不猜测、不重来。** 账本读不出来 → `E_LEDGER_UNREADABLE`，
 *    **绝不从第一阶段重跑**。重跑会把已经做完的活全部作废，
 *    而且没有任何痕迹说明作废过 —— 那是最坏的一种"看起来好了"。
 * 2. **幂等。** 同一 `(meetingId, stageId, attempt)` 重复提交 = 1 次。
 *    判据是这条三元组，不是"内容是否相同"：内容可以合法地被修订，
 *    而同一次尝试的重复提交不该产生第二份产物。
 * 3. **必过阶段不可跳。** 声称收工时，每个必过阶段都必须有成功记录
 *    （`E_PRESET_STAGE_SKIPPED`）。
 * 4. **轮次必须显式。** `attempt` 从 1 起，只在对同阶段的**失败**重试时 +1。
 *    缺省即第 1 轮 —— 但"缺省"与"写了 1"在账本上是两件事，本模块不合并它们
 *    （合并会让"这条回执属于哪一轮"永久失去答案）。
 *
 * ## 判不了什么（写清楚，不装作能判）
 *
 * - 判不了"这个阶段跑得对不对"。本模块只知道"有没有一张卡、几张"。
 *   卡的内容对不对，是 `artifact.mjs` 与门禁码的事。
 * - 判不了"该不该升档"。`canUpgrade` 只判"能不能升"（方向合法 + 补账齐），
 *   不判"值不值得升"—— 那是人的判断。
 * - 判不了"agent 是不是死了"。存活判定在 `resume.mjs`；
 *   本模块只看账本时间戳，不看任何运行时状态。
 */

import { KINDS } from './contract.mjs';
import { isMeetingCode } from './codes.mjs';
import { judgeShift, backfillGaps, parsePresetId } from './preset.mjs';

/** 会议状态白名单。 */
export const MEETING_STATUSES = Object.freeze(['running', 'paused', 'done', 'abandoned']);

/**
 * 可以继续往下跑的会议状态。
 *
 * `paused` 也算能跑：它只是"这一轮没人动"，不是"结束了"。
 * `done` / `abandoned` 不能再跑 —— 一个已收工的会再冒出新阶段，账本就自相矛盾了。
 */
const RUNNABLE_STATUSES = Object.freeze(['running', 'paused']);

/** 阶段记录状态白名单。 */
export const STAGE_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed']);

/**
 * 一条诊断。形状与 `preset.mjs` 的 `diag` / `delivery.mjs` 的 blocker 一致
 * （`code` + `message` + 可选 `stageId`），宿主那一层可以用同一套渲染。
 *
 * @param {string} code
 * @param {string} message
 * @param {string} [stageId]
 * @returns {{code: string, message: string, stageId?: string}}
 */
function diag(code, message, stageId) {
  return stageId === undefined ? { code, message } : { code, message, stageId };
}

/**
 * 幂等键。
 *
 * 用 `\u0000` 分隔而不是 `:` —— 因为 `:` 可能出现在 id 里，
 * 而 NUL 在 id 里不可能出现（`preset.mjs` 的 ID_PATTERN 与任务 id 的生成都排除它）。
 * 这不是洁癖：`a:b` + `c` 与 `a` + `b:c` 用 `:` 拼出来是同一个字符串，
 * 那种碰撞只会发生在生产环境的某个奇怪 id 上，然后极难查。
 *
 * @param {string} meetingId
 * @param {string} stageId
 * @param {number} attempt
 * @returns {string}
 */
export function idempotencyKey(meetingId, stageId, attempt) {
  return `${meetingId}\u0000${stageId}\u0000${attempt}`;
}

/**
 * 把幂等键拆回去。形态不对 → null（不抛）。
 * @param {unknown} key
 * @returns {{meetingId: string, stageId: string, attempt: number}|null}
 */
export function parseIdempotencyKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split('\u0000');
  if (parts.length !== 3) return null;
  const [meetingId, stageId, rawAttempt] = parts;
  if (meetingId === '' || stageId === '') return null;
  if (!/^[1-9][0-9]*$/.test(rawAttempt)) return null;
  const attempt = Number(rawAttempt);
  if (!Number.isSafeInteger(attempt)) return null;
  return { meetingId, stageId, attempt };
}

/**
 * 取某阶段当前轮次。
 *
 * 没有记录 → 1（还没开始）。有记录 → 记录里的 attempt。
 *
 * @param {object} meeting
 * @param {string} stageId
 * @returns {number}
 */
export function stageAttempt(meeting, stageId) {
  const record = stageRecordOf(meeting, stageId);
  if (record === null) return 1;
  const attempt = record.attempt;
  return Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : 1;
}

/**
 * 取某阶段**下一轮该用第几轮**。
 *
 * 与 `stageAttempt` 是**两个值，不许合并**：
 *   - `stageAttempt` = **当前记录是第几轮**（给读的人看："这场会跑到第几轮了"）；
 *   - `nextAttempt`  = **下一次派工该用第几轮**（给驱动器用，进幂等键）。
 *
 * 合并成一个数，就再也分不清"现在跑到第几轮"和"下一轮编号" ——
 * 而幂等键 `(meetingId, stageId, attempt)` 要的正是后者。
 *
 * 四种状态的答案（判据只认 `status`）：
 *
 * | 记录 | 交出 | 为什么 |
 * |---|---|---|
 * | 没有记录（首跑） | `1` | 第 1 轮 |
 * | `running` | **同一个** `attempt` | 这一轮还在跑。当成新一轮会让"一次投递"被计成两轮 |
 * | `failed` | `attempt + 1` | 上一轮失败了，返工要走一个新轮次 |
 * | `done` | 同一个 `attempt` | 正常情况下 `meetingState` 已跳过它；这里保守返回原值 |
 *
 * **为什么必须是 `+1` 而不是重用旧值**：`recordSubmission` 的幂等键含 `attempt`，
 * 规则是"上一轮 `failed` 才允许推进"。交出旧值 ⇒ 同一个键 ⇒ 判 `duplicate` ⇒
 * **既不推进也不报错**，驱动器会一直空转到守卫上限。返工链整条走不通，
 * 于是 `agentpool` 的 `fork`（"本会议内返工"）除了人手改账本之外没有任何真路径。
 *
 * @param {object} meeting
 * @param {string} stageId
 * @returns {number}
 */
export function nextAttempt(meeting, stageId) {
  const record = stageRecordOf(meeting, stageId);
  const current = stageAttempt(meeting, stageId);
  if (record === null) return 1;
  if (record.status === 'failed') return current + 1;
  return current;
}

/**
 * 取某阶段的记录。非数组 / 找不到 → null。
 * @param {object} meeting
 * @param {string} stageId
 * @returns {object|null}
 */
function stageRecordOf(meeting, stageId) {
  const stages = Array.isArray(meeting?.stages) ? meeting.stages : [];
  for (const record of stages) {
    if (record !== null && typeof record === 'object' && record.stageId === stageId) return record;
  }
  return null;
}

/**
 * 会议账本能不能读。
 *
 * 这一层只做**形状**判断，不猜内容。返回 `{ok:false, error}` 时调用方必须
 * 走 `E_LEDGER_UNREADABLE` 那条路，**不许**把它当成"新会议"。
 *
 * @param {unknown} meeting
 * @returns {{ok: boolean, error: object|null}}
 */
export function readLedger(meeting) {
  if (meeting === null || typeof meeting !== 'object' || Array.isArray(meeting)) {
    return {
      ok: false,
      error: diag(
        'E_LEDGER_UNREADABLE',
        '会议账本不是一个对象 —— **无法判断跑到哪了**。'
          + '绝不许从第一阶段重来：那会把已经做完的活全部作废，而且没有任何痕迹说明作废过。'
          + '先修账本，或交人。',
      ),
    };
  }
  if (typeof meeting.id !== 'string' || meeting.id.trim() === '') {
    return {
      ok: false,
      error: diag('E_LEDGER_UNREADABLE', '会议账本缺少 id —— 没有 id 就无法把回执对回这场会，也就无法续跑。'),
    };
  }
  const parsed = parsePresetId(meeting.preset);
  if (parsed === null) {
    return {
      ok: false,
      error: diag(
        'E_LEDGER_UNREADABLE',
        `会议账本里的 preset 是 ${JSON.stringify(meeting.preset)}，不是 id@version 形式 —— `
          + '"按哪个档位跑的"这件事读不出来，就没法判断该跑哪些阶段。',
      ),
    };
  }
  if (!MEETING_STATUSES.includes(meeting.status)) {
    return {
      ok: false,
      error: diag(
        'E_LEDGER_UNREADABLE',
        `会议账本里的 status 是 ${JSON.stringify(meeting.status)}，不在 ${MEETING_STATUSES.join('/')} 之内 —— `
          + '状态读不出来就无法判断能不能续跑。',
      ),
    };
  }
  if (meeting.stages !== undefined && !Array.isArray(meeting.stages)) {
    return {
      ok: false,
      error: diag('E_LEDGER_UNREADABLE', '会议账本的 stages 不是数组 —— 阶段记录读不出来。'),
    };
  }
  return { ok: true, error: null };
}

/**
 * 整场会开到哪了。
 *
 * 这是 `resume.mjs` 与 `agentpool.mjs` 都要问的那个问题，所以它必须
 * 一次说清三件事：跑到哪个阶段、第几轮、前面哪些已经真的完成了。
 *
 * @param {object} input
 *   { meeting, preset }
 * @returns {{ok: boolean, phase: string, currentStage: object|null,
 *            attempt: number, completed: string[], pending: string[],
 *            errors: Array<object>, warnings: Array<object>}}
 */
export function meetingState(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const errors = [];
  const warnings = [];

  const ledger = readLedger(source.meeting);
  if (!ledger.ok) {
    /* 关键：读不出来时返回 `phase: 'unreadable'`，**不是** 'not-started'。
     * 把读失败渲染成"还没开始"，就是拿沉默冒充结论 —— 本项目第一天起就在治这个。 */
    return {
      ok: false,
      phase: 'unreadable',
      currentStage: null,
      attempt: 0,
      completed: [],
      pending: [],
      errors: [ledger.error],
      warnings,
    };
  }

  const meeting = source.meeting;
  const stages = Array.isArray(source.preset?.stages) ? source.preset.stages : null;
  if (stages === null || stages.length === 0) {
    return {
      ok: false,
      phase: 'unreadable',
      currentStage: null,
      attempt: 0,
      completed: [],
      pending: [],
      errors: [diag(
        'E_LEDGER_UNREADABLE',
        `会议账本声明按 ${meeting.preset} 跑，但这份预设没有阶段（或没提供）—— `
          + '阶段图读不出来，就没法判断跑到哪了。',
      )],
      warnings,
    };
  }

  /* 账本里出现预设里没有的阶段 → 两份数据打架。**不选边**，
   * 但也不阻断推进（可能是升档前留下的历史记录）—— 记 warning 并如实列出。 */
  const presetStageIds = new Set(stages.filter((s) => s && typeof s.id === 'string').map((s) => s.id));
  const strayStages = (Array.isArray(meeting.stages) ? meeting.stages : [])
    .filter((r) => r && typeof r.stageId === 'string' && !presetStageIds.has(r.stageId))
    .map((r) => r.stageId);
  if (strayStages.length > 0) {
    warnings.push(diag(
      'E_LEDGER_STRAY_STAGE',
      `账本里有这些阶段，但它们不在 ${meeting.preset} 的阶段图里：${strayStages.join('、')}。`
        + '多半是升档/降档留下的历史记录 —— 保留它们，但不参与"跑到哪了"的计算。',
    ));
  }

  const completed = [];
  const pending = [];
  /** 第一个还没完成的阶段（按预设顺序）。 */
  let currentStage = null;

  for (const stage of stages) {
    if (stage === null || typeof stage !== 'object' || typeof stage.id !== 'string') continue;
    const record = stageRecordOf(meeting, stage.id);
    if (record !== null && record.status === 'done') {
      completed.push(stage.id);
      continue;
    }
    pending.push(stage.id);
    if (currentStage === null) currentStage = stage;
  }

  /* 阶段状态本身也要合法。一个 `status: 'finished'` 的拼错会让这个阶段
   * 永远算"没完成"，而没人知道为什么 —— 幽灵阶段的一种。 */
  for (const record of Array.isArray(meeting.stages) ? meeting.stages : []) {
    if (record === null || typeof record !== 'object') {
      errors.push(diag('E_LEDGER_UNREADABLE', '账本里有非对象的阶段记录 —— 读不出来。'));
      continue;
    }
    if (record.stageId !== undefined && !STAGE_STATUSES.includes(record.status)) {
      errors.push(diag(
        'E_LEDGER_UNREADABLE',
        `阶段 ${String(record.stageId)} 的 status 是 ${JSON.stringify(record.status)}，`
          + `不在 ${STAGE_STATUSES.join('/')} 之内 —— 拼错的 status 会让这个阶段永远算"没完成"，`
          + '而没人知道为什么。',
        typeof record.stageId === 'string' ? record.stageId : undefined,
      ));
    }
  }

  /* 阶段完成度必须与"会议是否声称收工"一致。
   *
   * `E_PRESET_STAGE_SKIPPED` 的判据就在这里：声称 done、但仍有必过阶段没完成。
   * 反过来（全完成了却没声称 done）不是错误 —— 那是"可以收工了"的正常状态。 */
  if (meeting.status === 'done' && pending.length > 0) {
    errors.push(diag(
      'E_PRESET_STAGE_SKIPPED',
      `会议账本声称已收工，但 ${meeting.preset} 的必过阶段没有完成记录：${pending.join('、')}。`
        + '必过就是必过 —— 缺了它，后面阶段的结论没有前提出处，'
        + '而"已收工"这三个字会让读的人以为整张图走完了。',
    ));
  }

  let phase;
  if (errors.length > 0) {
    phase = 'unreadable';
  } else if (meeting.status === 'done') {
    phase = 'done';
  } else if (meeting.status === 'abandoned') {
    phase = 'abandoned';
  } else if (pending.length === 0) {
    /* 所有阶段都完成了，但会议没标 done —— 这是"可以收工，还没收"。 */
    phase = 'ready-to-close';
  } else {
    phase = 'in-progress';
  }

  return {
    ok: errors.length === 0,
    phase,
    currentStage,
    attempt: currentStage === null ? 0 : stageAttempt(meeting, currentStage.id),
    completed,
    pending,
    errors,
    warnings,
  };
}

/**
 * 下一个该跑的阶段。
 *
 * 三种返回形态必须可分辨（这是本项目"空 ≠ 不可用"在状态机里的落点）：
 *   `{ stage, attempt }` —— 有活要干
 *   `{ done: true }`     —— 全部阶段都完成了
 *   `{ blocked, errors }` —— 判不了 / 不能跑（**不是** done）
 *
 * @param {object} input { meeting, preset }
 * @returns {{ok: boolean, stage?: object, attempt?: number, done?: boolean,
 *            blocked?: boolean, errors: Array<object>, warnings: Array<object>}}
 */
export function nextStage(input) {
  const state = meetingState(input);
  /* 账本本身（`meetingState` 已经把畸形输入吃掉了，这里是同一个来源，不另取一份语义）。 */
  const meeting = input !== null && typeof input === 'object' ? input.meeting : undefined;

  if (!state.ok) {
    /* 读不出来 → blocked，**绝不** done，也绝不返回第一阶段。
     * 返回第一阶段就是"从第一阶段重跑"，那是最坏的一种失败：
     * 它看起来像在工作。 */
    return { ok: false, blocked: true, errors: state.errors, warnings: state.warnings };
  }

  if (state.phase === 'abandoned') {
    return {
      ok: false,
      blocked: true,
      errors: [diag(
        'E_MEETING_ABANDONED',
        '这场会议已被放弃（abandoned），不再推进任何阶段。要接着做请开一场新的会，'
          + '并把这场会的产物作为输入带过去 —— 那样至少账本上说得清哪一场做了什么。',
      )],
      warnings: state.warnings,
    };
  }

  if (state.phase === 'ready-to-close' || state.phase === 'done') {
    return { ok: true, done: true, errors: [], warnings: state.warnings };
  }

  if (state.currentStage === null) {
    /* 状态说 in-progress，却没有当前阶段 —— 账本自相矛盾。 */
    return {
      ok: false,
      blocked: true,
      errors: [diag(
        'E_LEDGER_UNREADABLE',
        '会议状态是进行中，但算不出下一个该跑哪个阶段 —— 账本与预设的阶段图对不上。'
          + '这时**不许**拿第一阶段顶上，先修账本。',
      )],
      warnings: state.warnings,
    };
  }

  return {
    ok: true,
    stage: state.currentStage,
    /* **下一轮编号**，不是"当前记录是第几轮"（`state.attempt`）。
     * 两者只在 `failed` 上不同：那里要 `+1`，否则幂等键会撞上上一轮、
     * 被判成 `duplicate` —— 不推进也不报错。见 `nextAttempt` 的表。 */
    attempt: nextAttempt(meeting, state.currentStage.id),
    errors: [],
    warnings: state.warnings,
  };
}

/**
 * 记一次阶段提交，返回新账本。**纯函数：不改编本。**
 *
 * 幂等的落点就在这里：同一 `(meetingId, stageId, attempt)` 已经有记录时，
 * **原样返回账本**，不追加第二条。重复提交不产生第二份产物。
 *
 * 与"内容是否相同"无关：内容可以合法地被修订，而同一次尝试的重复提交
 * 不该让账本多出一条 —— 那样"第 2 轮交了几张卡"就永远数不清。
 *
 * @param {object} input
 *   { meeting, stageId, attempt, status, produced }
 * @returns {{ok: boolean, meeting: object, duplicate: boolean, errors: Array<object>}}
 */
export function recordSubmission(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const ledger = readLedger(source.meeting);
  if (!ledger.ok) return { ok: false, meeting: source.meeting, duplicate: false, errors: [ledger.error] };

  const meeting = source.meeting;
  const stageId = typeof source.stageId === 'string' ? source.stageId : '';
  if (stageId === '') {
    return {
      ok: false,
      meeting,
      duplicate: false,
      errors: [diag('E_ARTIFACT_MALFORMED', '记提交时缺少 stageId —— 不知道这是哪个阶段的产物。')],
    };
  }
  if (!Number.isSafeInteger(source.attempt) || source.attempt < 1) {
    return {
      ok: false,
      meeting,
      duplicate: false,
      errors: [diag(
        'E_ARTIFACT_MALFORMED',
        `记提交时 attempt 必须是正整数，收到 ${JSON.stringify(source.attempt)} —— `
          + '轮次不明确时，回执无法与正确的那一轮对上。',
        stageId,
      )],
    };
  }
  if (!STAGE_STATUSES.includes(source.status)) {
    return {
      ok: false,
      meeting,
      duplicate: false,
      errors: [diag(
        'E_ARTIFACT_MALFORMED',
        `阶段 ${stageId} 的 status 必须是 ${STAGE_STATUSES.join('/')} 之一，收到 ${JSON.stringify(source.status)}`,
        stageId,
      )],
    };
  }

  const existing = stageRecordOf(meeting, stageId);
  if (existing !== null) {
    /* 已经有这一阶段的记录 —— 分三种情况。
     * 只有"同一轮"的重复提交才是 no-op；不同轮是**另一个回合**，要追加。 */
    const existingAttempt = Number.isSafeInteger(existing.attempt) && existing.attempt >= 1 ? existing.attempt : 1;
    if (existingAttempt === source.attempt) {
      return { ok: true, meeting, duplicate: true, errors: [] };
    }
    if (source.attempt < existingAttempt) {
      /* 更旧的一轮回来了 —— 迟到。不许覆盖新记录，也不许当成新回合。 */
      return {
        ok: false,
        meeting,
        duplicate: false,
        errors: [diag(
          'E_STALE_ATTEMPT',
          `阶段 ${stageId} 已经记到第 ${existingAttempt} 轮，这次提交标的是第 ${source.attempt} 轮 —— `
            + '这是迟到的一份回执，不属于当前轮次。不改写账本。',
          stageId,
        )],
      };
    }
    /* 更新的轮次：只有在上一次是 failed 时才允许推进。
     * 上一轮已经 done 了还来一轮新的 —— 那是"重做已完成的阶段"，
     * 要么是账本被改了，要么是重复执行。两种情况都必须说出来。 */
    if (existing.status === 'done') {
      return {
        ok: false,
        meeting,
        duplicate: false,
        errors: [diag(
          'E_STALE_ATTEMPT',
          `阶段 ${stageId} 第 ${existingAttempt} 轮已经完成，但现在要记第 ${source.attempt} 轮 —— `
            + '已完成的阶段不该有新轮次。先确认这条是重复执行还是账本被改过。',
          stageId,
        )],
      };
    }
  }

  const stages = Array.isArray(meeting.stages) ? meeting.stages.slice() : [];
  const nextRecord = {
    stageId,
    attempt: source.attempt,
    status: source.status,
    produced: Array.isArray(source.produced) ? source.produced.slice() : [],
  };
  /* `at` 只有真给了才挂这个键。
   * 写成 `at: undefined` 会真的产生一个键：于是"没记时间"与"记了个 undefined"
   * 在序列化前后表现不一致（JSON 会丢掉它），而账本一旦序列化再读回来就与内存里不一样了。
   * 本项目的老规矩：只有真值才给键。 */
  if (typeof source.at === 'string' && source.at !== '') nextRecord.at = source.at;

  const index = stages.findIndex((record) => record !== null && typeof record === 'object' && record.stageId === stageId);
  if (index === -1) stages.push(nextRecord);
  else stages[index] = nextRecord;

  return { ok: true, meeting: { ...meeting, stages }, duplicate: false, errors: [] };
}

/**
 * 能不能换档。判据全在 `preset.mjs`，这里只负责把"当前会议的账本"翻译成它的入参。
 *
 * **不判"值不值得升"** —— 那是人的判断。本函数只回答"能不能"。
 *
 * @param {object} input
 *   { meeting, registry, fromPreset, toPreset, toQualified, artifacts }
 * @returns {{ok: boolean, direction: string, errors: Array<object>, gaps: Array<object>}}
 */
export function canUpgrade(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const meeting = source.meeting;

  const ledger = readLedger(meeting);
  if (!ledger.ok) return { ok: false, direction: 'unknown', errors: [ledger.error], gaps: [] };

  const shift = judgeShift({
    registry: source.registry,
    fromQualified: meeting.preset,
    toQualified: source.toQualified,
  });
  if (!shift.ok) {
    return { ok: false, direction: shift.direction, errors: shift.errors, gaps: [] };
  }

  /* 方向合法之后才有"补账"这一步。顺序是有意的：
   * 降档根本不该算缺口 —— 先告诉他"不许降"，而不是先报一堆缺字段。 */
  const backfill = backfillGaps({
    from: source.fromPreset,
    to: source.toPreset,
    artifacts: source.artifacts,
  });

  return {
    ok: backfill.ok,
    direction: shift.direction,
    errors: backfill.errors,
    gaps: backfill.gaps,
  };
}

/**
 * 升档之后的新账本。**只加记录，不改历史。**
 *
 * 历史不许改写：`upgrades` 是 append-only 的。
 * 任何时候回头看，都必须能回答"这场会什么时候从哪个档升到哪个档、为什么"。
 *
 * @param {object} input { meeting, registry, toQualified, reason, at, by }
 *   - `registry`：**必填**，`presets/index.json` 的内容。缺了它判不出方向 → `ok:false`（不写）。
 *     方向判据在本函数内部（调 `judgeShift`），调用方不需要、也不许自己再判一遍。
 *   - `by` = **谁按了换档杆**，由宿主身份来源灌入（`membership().name`）；缺省不挂这个键。
 * @returns {{ok: boolean, meeting: object, direction: 'up'|'same'|'down'|'unknown',
 *            errors: Array<object>, warnings: Array<object>, reason?: string, message?: string}}
 *   `ok:false` 的四种成因在 `direction` 上分得开：`down`（降档）/ `same`（同档，空操作）/
 *   `unknown`（判不出方向，含缺 registry）。除 `same` 外都带 errors 码。
 * @returns {{ok: boolean, meeting: object, errors: Array<object>, warnings: Array<object>}}
 */
export function applyUpgrade(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const meeting = source.meeting;

  const ledger = readLedger(meeting);
  if (!ledger.ok) return { ok: false, meeting, errors: [ledger.error], warnings: [] };

  const parsed = parsePresetId(source.toQualified);
  if (parsed === null) {
    return {
      ok: false,
      meeting,
      direction: 'unknown',
      errors: [diag('E_PRESET_NOT_FOUND', `升档目标 ${JSON.stringify(source.toQualified)} 不是 id@version 形式。`)],
      warnings: [],
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 方向判据在**这一层**，不在调用方（P2-11）。
   *
   * 曾经的做法是：`applyUpgrade` 只校验"目标是不是 id@version"，方向由调用方
   * （`host` 的 `upgradeMeeting`）先调 `judgeShift` 判完再进来。唯一的调用方是对的，
   * 但**函数本身不安全**：任何一个新调用方直接调它，就会把一次降档照单写进
   * append-only 的历史，而那条历史看起来完全合法。
   *
   * 这与"判据抄成两份"是同一件事的两面：那边是判据多了，这边是判据在外面。
   * 结论一样 —— **纯函数自己不许依赖调用方的自觉**。
   * ══════════════════════════════════════════════════════════════════════════ */

  if (source.registry === undefined || source.registry === null) {
    return {
      ok: false,
      meeting,
      direction: 'unknown',
      errors: [diag(
        'E_PRESET_NOT_FOUND',
        `这次**没有判方向，所以一条都不写**：调用方没给 registry，判不了 `
          + `${meeting.preset} → ${JSON.stringify(source.toQualified)} 的 rank。`
          + '判不出方向绝不许当成"不算降档所以放行" —— 那会让一次降档带着完整的历史活下去。',
      )],
      warnings: [],
    };
  }

  const shift = judgeShift({
    registry: source.registry,
    fromQualified: meeting.preset,
    toQualified: source.toQualified,
  });
  if (shift.ok !== true) {
    /* `down` 与 `unknown` 都在这里出局，错因来自 `judgeShift`（含 `E_PRESET_DOWNGRADE`）。
     * `unknown` 尤其不许放行：判不出的方向不是"没挡"，是"不知道"。 */
    return {
      ok: false,
      meeting,
      direction: shift.direction,
      errors: Array.isArray(shift.errors) ? shift.errors.slice() : [],
      warnings: [],
    };
  }
  if (shift.direction === 'same') {
    /* 同档不是"升档"，一次 `X → X` 会在 append-only 的历史里凭空多出一条
     * 看起来像"换过档"的记录。**不写**，并且明确说出来。
     *
     * 早先这里 `errors` 是空的而 `ok` 是 false —— 那与本项目"失败必带码"的口径冲突：
     * 一个 `ok:false` 却不在任何码列表里的状态，页面渲染不出来，读的人只能看见
     * 「失败了」三个字，既不知道是什么、也不知道该怎么改。所以现在它有自己的码
     * `E_UPGRADE_SAME_TIER`（批 2，blocker）。
     *
     * 注意它**不是** `E_PRESET_DOWNGRADE` 的变体：那个说的是"往下走"，
     * 这个说的是"根本没动"。两条成因不同，处置也不同（一个要改目标档位，
     * 一个是"这件事本来就不需要动"），所以是两条码而不是一条。 */
    return {
      ok: false,
      meeting,
      direction: 'same',
      errors: [diag(
        'E_UPGRADE_SAME_TIER',
        `从 ${meeting.preset} 换到 ${source.toQualified} 不是升档（同一个档位）—— `
          + '不写，也不记一条「X → X」的假历史。要么把目标改成更高的档位，要么承认这件事不用动。',
      )],
      warnings: [],
      reason: 'same-tier',
    };
  }

  const upgrades = Array.isArray(meeting.upgrades) ? meeting.upgrades.slice() : [];
  /* `reason` 恒定给出去（缺省空串）：账本层把「写了键但值是空」与「压根没这个键」
   * 当成两件事 —— 前者是"升档时没写理由"，后者是"老账本没有这个字段"。
   * 这里恰好是前者，所以必须落一个空串，而不是让键缺席。 */
  const record = {
    from: meeting.preset,
    to: source.toQualified,
    reason: typeof source.reason === 'string' ? source.reason : '',
  };
  /* `at` 只有真给了才挂这个键 —— 与 `recordSubmission` 同一条规矩（见那边第 498 行的注释）。
   * 写成 `at: undefined` 会真的产生一个键：JSON 序列化会丢掉它，于是"没记时间"在内存里
   * 与落盘后长得不一样。而现在这个键是要被账本渲染成 `| at=<时间>` 的 ——
   * 一个假的 `at=` 等于凭空断言"时间是空的"。 */
  if (typeof source.at === 'string' && source.at !== '') record.at = source.at;
  /* `by`（谁按了换档杆）—— 与 `at` 同一条规矩：**只给真值才挂这个键**。
   *
   * 为什么这一格不是装饰：本项目的核心原则之一是**换档权归人类、机器只许向上**，
   * 而"这一次是谁换的"就是那条原则的**记录本身**。少了它，账本上"有人升过档"
   * 这件事永远是匿名的 —— 账面看起来五格齐全，实际少一格，比缺一个显眼的字段更坏。
   *
   * **拿不到身份时绝不许编占位名**（`unknown` / `system` / `n/a` 之类）：
   * 编出来的 `by` 与真的 `by` 在页面上长得一模一样，可信度却差一个数量级。
   * 那时这条记录就是**没有** `by`，由调用方在响应里如实说明"这次没记下是谁换的"。
   * 这一层只负责"给了才挂"，不负责编、也不负责猜。
   *
   * 身份**只能**来自宿主（`teams.membership(agent).name`），不许由调用方自报 ——
   * 让换档人自证等于把这条原则的记录交给被记录的人。 */
  if (typeof source.by === 'string' && source.by !== '') record.by = source.by;
  upgrades.push(record);

  const errors = [];
  const warnings = [];
  /* 升档必须写理由 —— 但这是 warning 级事实，不阻断升档本身。
   * 方案把 `E_UPGRADE_NO_REASON` 放在批 3（出声但不拦），这里照办。 */
  if (typeof source.reason !== 'string' || source.reason.trim() === '') {
    errors.push(diag(
      'E_UPGRADE_NO_REASON',
      `从 ${meeting.preset} 升到 ${source.toQualified} 没有写理由 —— 升档本身允许，`
        + '但账本上会变成"不知道为什么多跑了几个阶段"。',
    ));
  }

  /* 「发生过升档」本身要留痕（`E_PRESET_UPGRADED`，批 3）。
   *
   * 为什么只推到 `upgrades[]` 不够、还要发一条码：`upgrades[]` 是**账本上的历史**，
   * 而这条码回答的是**这一次动作**的声音 —— 页面拿前者只能自己判断"要不要说这件事"，
   * 那等于把"要不要留痕"变成每个读者的私事。换档权在人手上，机器至少要让这件事
   * 在回应里出现一次，否则一次升档可以安静到没人知道。
   *
   * 通道是有意分开的：`warnings` 不会进入任何"能不能往下走"的判据。
   * 留痕挡路就荒唐了 —— 一次完全合法的升档被自己的留痕挡住。
   * 第一步 `judgeShift` 已判定"只许升"，走到这里说明升是合法的。 */
  warnings.push(diag(
    'E_PRESET_UPGRADED',
    `这场会议已经升过档：${meeting.preset} → ${source.toQualified}。`
      + '升档本身允许，但"升过档"这件事必须留在账本上，否则回头看会以为一路都是高档位。',
  ));

  return {
    ok: true,
    meeting: { ...meeting, preset: source.toQualified, upgrades },
    direction: 'up',
    errors,
    warnings,
  };
}

/**
 * 阶段声明里的 kind 是不是本模块认识的。
 *
 * 单独导出是因为 `resume.mjs` / `agentpool.mjs` 都要问，
 * 而它们不该各自再写一份 `KINDS.includes(...)`。
 *
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isKnownStageKind(kind) {
  return typeof kind === 'string' && KINDS.includes(kind);
}

/**
 * 阶段声明的门禁码是不是已登记。
 *
 * 与 `preset.mjs` 的判据同一口径：会议码表里的码都算已登记。
 * 基线码表在 `preset.mjs` 里已经并进校验，这里只判会议码表 ——
 * 因为预设里出现在这里的 gate 都该是这条流水线自己的码。
 *
 * @param {unknown} code
 * @returns {boolean}
 */
export function isKnownStageGate(code) {
  return isMeetingCode(code);
}

/**
 * 一组可继续推进的会议状态。
 * 导出是为了让 `resume.mjs` 与宿主共用同一份判据，不各写一遍。
 */
export { RUNNABLE_STATUSES };
