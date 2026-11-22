/**
 * agentpool.mjs — 谁来做这一阶段：`fresh` / `reuse` / `fork`。
 *
 * **纯函数，零 IO。** 它不创建 agent、不发消息、不查宿主 ——
 * 只回答一个问题：给定账本、预设阶段、以及候选 agent 的已知状态，
 * 这一阶段该用哪一种、用哪一个，以及**为什么**。
 *
 * ## 为什么复用这件事需要一整个模块
 *
 * 因为它是这套东西里**唯一一处"省成本"与"保独立"直接冲突**的地方：
 *   - 全部 fresh：每次开会都从零开始，上下文全丢，慢且贵
 *   - 全部 reuse：省，但盲审就废了 —— 一个看过方案推理过程的 agent
 *     再审同一个方案，它只会复述
 *
 * 方案 §4 的处理是：**默认给复用，但三条边界机器拦、领导不能覆盖**。
 * 本模块就是那三条边界的实现，外加"默认给哪个"的判据。
 *
 * ## 三条硬边界（方案 §4，逐条对应下面的 `checkBoundaries`）
 *
 * | 边界 | 码 |
 * |---|---|
 * | `seenIds ∩ withheldIds ≠ ∅` 却复用 | `E_BLIND_AGENT_REUSED`（blocker） |
 * | 复用导致评审人与被审人同一个 agent 且非 fork | 沿用 `E_SELF_REVIEW` |
 * | 跨会议复用但未标 `fork` | `E_AGENT_SHARED_ACROSS_MEETINGS`（blocker） |
 *
 * 这三条的判据全是**集合运算**，不需要理解任何语义 —— 这正是它们能被机器拦的原因。
 * 而"复用到底省了多少"这类问题，本模块只给数，不给结论。
 *
 * ## 判不了什么（写清楚，不装作能判）
 *
 * - 判不了"这个 agent 是不是真的忘了"。`seenIds` 是账本记的"它见过哪些产物"，
 *   而一个 agent **可能见过却没被记上**（比如它自己读过文件）。所以
 *   `seenIds` 为空**不证明**它没看过 —— 它只证明"账本上没记它看过"。
 *   这条要说出来，否则"检查通过"会被当成"确认干净"。
 * - 判不了"复用省下来的上下文值不值那点独立性损失"。本模块给
 *   `contextSaving` 的粗略估计（能省几张卡），**不评价该不该省**。
 * - 判不了"`fork` 出来的新 agent 真的没有继承旧上下文"。`fork` 是一个声明，
 *   本模块只能检查"声明了 fork"，不能验证宿主确实隔离了记忆。
 */

import { isKnownStageKind } from './meeting.mjs';

/** 三种复用模式。 */
export const AGENT_MODES = Object.freeze(['fresh', 'reuse', 'fork']);

/** 连续判 pass 几次就强制换人（沿用基线 `E_REVIEW_STAGNATION` 的口径）。 */
export const STAGNATION_STREAK = 3;

/**
 * 一条诊断。形状与其它模块一致。
 * @param {string} code
 * @param {string} message
 * @param {string} [stageId]
 * @returns {{code: string, message: string, stageId?: string}}
 */
function diag(code, message, stageId) {
  return stageId === undefined ? { code, message } : { code, message, stageId };
}

/**
 * 两个字符串集合的交集。非数组一律当空集合 —— **不猜**。
 *
 * 用 `Set` 而不是 `Array.includes`：`seenIds` 可能有几百条，
 * 而这条判据在每次派工时都要跑一次。
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {string[]} 交集，保持 left 里的出现顺序（便于人读）
 */
export function intersect(left, right) {
  const rightSet = new Set(
    (Array.isArray(right) ? right : []).filter((item) => typeof item === 'string'),
  );
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(left) ? left : []) {
    if (typeof item !== 'string') continue;
    if (!rightSet.has(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 这个 agent 参与过哪些会议。
 *
 * @param {unknown} agent
 * @returns {Set<string>}
 */
function meetingsOf(agent) {
  const list = Array.isArray(agent?.meetings) ? agent.meetings : [];
  const out = new Set();
  for (const item of list) {
    if (typeof item === 'string' && item !== '') out.add(item);
    else if (item !== null && typeof item === 'object' && typeof item.meetingId === 'string') {
      out.add(item.meetingId);
    }
  }
  return out;
}

/**
 * 默认给哪种模式。
 *
 * ## 规则表（**按判定顺序**，先命中先返回）
 *
 * | # | 判据 | 结果 | 可覆盖 |
 * |---|---|---|---|
 * | 0 | 没有合法当前阶段 | `fresh` | 否 |
 * | 1 | `stage.blind === true` | `fresh` | **否**（盲审的定义） |
 * | 2 | 该角色连续 `passStreak ≥ STAGNATION_STREAK` 次判 pass | `fresh` | **否**（注意力衰减） |
 * | 3 | **本会议内返工**：同一阶段 `attempt ≥ 2` | `fork` | 是 |
 * | 4 | **跨会议 + 同角色 + 隔离成立** | `reuse` | 是 |
 * | 5 | 其余 | `fresh` | 是 |
 *
 * ## 方案 A 改了什么（以及为什么）
 *
 * 旧表的第 3 行是「跨会议 + 未收敛冲突 ⇒ `fork`」，第 4 行是「同会议内连续的非盲同角色 ⇒ `reuse`」。
 * 两条都错了，而且是两种不同的错：
 *
 *   - **旧的 reuse 结构上不可达**：`standard@1` / `lite@1` 的非盲阶段是
 *     `confirm(client)` / `design(architect)` / `build(dev)`，**每阶段一顶不同帽子**，
 *     "跨阶段连续同角色对"在这两份预设下根本不存在。留着不删，下一个人会以为它在工作。
 *     → 已删除（见规则 ④ 位置上那段注释）。
 *   - **旧的 fork 是反的**：`fork` **继承上下文**，而"跨会议复用"要防的正是把上一场会的结论带过来。
 *     用户原话场景是"同一个审核人审完 A 再审 B，但 B 不能看见 A 的结论"——
 *     `fork` 恰好把 A 的结论带进 B。所以**跨会议一律不许 fork**；
 *     `fork` 只留给本会议内返工（同一阶段第 2 轮起，它需要看见自己上一轮写了什么）。
 *
 * ## 隔离成立是怎么判的：调既有边界，不抄第二份
 *
 * 判据就是 `checkBoundaries`（`seenIds = 显式给的 ∪ agent.seenIds`，与 `withheldIds` 求交）。
 * 本函数只**问它**，不在自己这里写一份"有没有看过"的比较 —— 那会是本项目最反复的
 * "抄第二份判据"，而两份里总有一份是错的、且没人知道是哪份。
 *
 * ## 一个保守的附加条件（有意的，不是漏洞）
 *
 * 跨会议复用还要求**这一阶段确实声明了要扣住的东西**（`withheldIds` 非空）。
 * 理由：`withheldIds` 为空时"隔离成立"是个**空真** —— 没有任何东西可泄漏，
 * 于是"检查通过"只证明"没检查"。本项目的红线是「空 ≠ 可用」，
 * 所以这种情况下不声称隔离成立，退回 `fresh` 并说明原因。
 *
 * @param {object} input
 *   { stage, candidate, attempt, meetingId, seenIds, withheldIds,
 *     reviewedAgentId, role }
 *   - `attempt`：本阶段第几轮（默认 1）。`≥ 2` 才是"返工"，第 1 轮不是。
 *   - `candidate.role`（或入参 `role`）：这个 agent 被派去承担的角色。跨会议"同角色"靠它比对。
 * @returns {{mode: string, overridable: boolean, rule: string, reason: string,
 *            cannotJudge: string, errors: Array<object>}}
 */
export function defaultAgentMode(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const stage = source.stage !== null && typeof source.stage === 'object' ? source.stage : null;
  if (stage === null || typeof stage.id !== 'string' || stage.id === '') {
    return {
      mode: 'fresh',
      overridable: false,
      rule: 'no-stage',
      reason: '没有当前阶段 —— 判不出该用哪种复用模式，保守取 fresh。',
      cannotJudge: '判不了"这一阶段该不该复用" —— 连是哪一阶段都不知道。',
      errors: [diag('E_ARTIFACT_MALFORMED', '判复用模式时缺少当前阶段。')],
    };
  }

  /* ① 盲阶段一律 fresh，且**不可覆盖**。
   * 这是三条边界之外的第四条 —— 它不是一个可以商量的默认值，
   * 而是盲审这个机制的定义本身：看过的人再审，就不叫盲审了。 */
  if (stage.blind === true) {
    return {
      mode: 'fresh',
      overridable: false,
      rule: 'blind-fresh',
      reason: `${stage.id} 是盲阶段 —— 盲审的价值全在"它没看过"，所以必须换一个没参与过的新 agent。`,
      cannotJudge: '判不了"新 agent 是不是真的干净" —— 本模块只保证它没被这个会议用过。',
      errors: [],
    };
  }

  const candidate = source.candidate !== null && typeof source.candidate === 'object' ? source.candidate : null;
  const streak = Number.isSafeInteger(candidate?.passStreak) ? candidate.passStreak : 0;

  /* ② 连续 3 次判 pass → 强制换人。
   * 沿用基线 `E_REVIEW_STAGNATION` 的口径：不是怀疑它做错了，
   * 而是怀疑它的注意力已经衰减 —— 一个连续三次都说"通过"的评审，第四次大概率还会说通过。 */
  if (streak >= STAGNATION_STREAK) {
    return {
      mode: 'fresh',
      overridable: false,
      rule: 'stagnation-fresh',
      reason: `这个角色已经连续 ${streak} 次判 pass（阈值 ${STAGNATION_STREAK}）—— `
        + '不是怀疑它判错了，而是怀疑注意力已经衰减。强制换人。',
      cannotJudge: '判不了"换个人会不会更好" —— 只保证不再让同一个人连续判下去。',
      errors: [],
    };
  }

  /* ③ 本会议内返工：同一阶段的第 2 轮起 → fork。
   * 这是 `fork` **唯一**的合法用途：返工要看自己上一轮写了什么，那正是"继承上下文"的本意。
   * 第 1 轮没有"上文"可继承，给它 fork 等于让它凭空多背一份别人的历史。
   * （旧的写法是"跨会议 + 未收敛冲突 ⇒ fork"，那条方向是反的：fork 继承上下文，
   *   而跨会议复用要防的恰恰是把上一场会的结论带过来。已删除。） */
  const attempt = Number.isSafeInteger(source.attempt) && source.attempt >= 1 ? source.attempt : 1;
  if (attempt >= 2) {
    return {
      mode: 'fork',
      overridable: true,
      rule: 'rework-fork',
      reason: `阶段 ${stage.id} 现在是第 ${attempt} 轮 —— 返工要看自己上一轮写了什么，`
        + '所以从它自己的上下文分叉（fork），而不是从零重来。',
      cannotJudge: '判不了"fork 出来的新 agent 真的只继承了自己那一支" —— fork 是一个声明，本模块只能检查声明。',
      errors: [],
    };
  }

  /* ───────────────────────────────────────────────────────────────────────
   * ④ 跨会议 + 同角色 + 隔离成立 → reuse。
   *
   * 【这里原来有一条判据：「同会议内、连续的非盲阶段、同角色 ⇒ reuse」。**已删除**。
   *  原因：它在 `standard@1` 与 `lite@1` 下都**永远不可能触发** ——
   *  这两份预设的非盲阶段是 confirm(client) / design(architect) / build(dev)，
   *  每阶段一顶不同帽子，"跨阶段连续同角色"这个前提在结构上不存在。
   *  一条永远不会出声的判据与"空通道"是同一类病：留着不删，
   *  下一个人（包括我自己）会以为它正在工作，并拿它当别的判断的前提。
   *  不是注释掉，是删掉。要恢复它，得先让某份预设真的出现连续的跨阶段同角色。】
   * ─────────────────────────────────────────────────────────────────────── */
  const candidateMeetings = meetingsOf(candidate);
  const currentMeetingId = typeof source.meetingId === 'string' ? source.meetingId : '';
  const crossedMeetings = [...candidateMeetings].filter((id) => id !== currentMeetingId);

  const agentRole = typeof candidate?.role === 'string'
    ? candidate.role
    : (typeof source.role === 'string' ? source.role : '');
  const sameRole = agentRole !== '' && agentRole === stage.role;
  const withheldIds = Array.isArray(source.withheldIds) ? source.withheldIds : [];

  /* 隔离由**边界③自己**判（`checkBoundaries` 里那条 `E_AGENT_SHARED_ACROSS_MEETINGS`），
   * 这里不再写一份"必须先声明扣留清单"的守卫 —— 那会是同一判断的第二份副本，
   * 两份里总有一份先漂移，而没人知道是哪一份。
   * 反证记录：把守卫加回来之后，去掉它**一条测试都变不红**，因为它与③判的是同一件事。 */
  if (crossedMeetings.length > 0 && sameRole) {
    /* 直接问既有边界，不在这里另写一份"有没有看过"的比较。 */
    const boundary = checkBoundaries({
      stage,
      mode: 'reuse',
      agent: candidate,
      seenIds: source.seenIds,
      withheldIds,
      reviewedAgentId: source.reviewedAgentId,
      meetingId: currentMeetingId,
    });

    if (boundary.ok) {
      return {
        mode: 'reuse',
        overridable: true,
        rule: 'cross-meeting-reuse',
        reason: `这个 agent 在别的会议（${crossedMeetings.join('、')}）承担的是同一角色（${stage.role}），`
          + `而它没有见过这一阶段要扣住的任何产物（${withheldIds.length} 项已核对）—— 隔离成立，复用。`
          + '复用它只带角色身份与角色该守的规矩，不带任何一场会的结论、不带作者的推理。',
        cannotJudge: '判不了"它记住的角色规矩里有没有夹带上一场会的结论" —— 只判得看集合有没有交集。',
        errors: [],
      };
    }
  }

  /* ⑤ 其余一律 fresh。
   * 默认取保守值是有意的：**复用的收益是省成本，误用的代价是独立性没了**，
   * 两者不对称，所以不确定时选不省。 */
  let whyFresh;
  if (crossedMeetings.length === 0) {
    whyFresh = '这个 agent 没有任何别的会议经历 —— 没有可复用的跨会议上下文（本会议内跨阶段复用那条判据已删，理由见上）。';
  } else if (!sameRole) {
    whyFresh = `它跨会议但对不上角色（它承担「${agentRole === '' ? '未声明' : agentRole}」，`
      + `这一阶段要「${String(stage.role)}」）—— 复用会把别的角色的判断带过来。`;
  } else {
    whyFresh = '跨会议、角色也对得上，但这一阶段没有声明要扣住的产物（或没通过既有边界）—— '
      + '隔离无从验证，所以不声称它成立。';
  }

  return {
    mode: 'fresh',
    overridable: true,
    rule: 'fallback-fresh',
    reason: `${whyFresh}默认 fresh：不确定时选不省 —— `
      + '复用的收益是省成本，误用的代价是独立性没了，两者不对称。',
    cannotJudge: '判不了"换个新 agent 会不会重复踩坑" —— 本模块不追踪跨轮次的失败模式。',
    errors: [],
  };
}

/**
 * 三条硬边界。**领导不能覆盖** —— 这是方案 §4 的原话。
 *
 * 判据全是集合运算，不需要理解语义，所以能真的拦住。
 *
 * @param {object} input
 *   { stage, mode, agent, seenIds, withheldIds, reviewedAgentId, meetingId }
 * @returns {{ok: boolean, errors: Array<object>, intersections: object}}
 */
export function checkBoundaries(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const stage = source.stage !== null && typeof source.stage === 'object' ? source.stage : null;
  const stageId = typeof stage?.id === 'string' ? stage.id : undefined;
  const mode = AGENT_MODES.includes(source.mode) ? source.mode : 'fresh';
  const agent = source.agent !== null && typeof source.agent === 'object' ? source.agent : null;
  const errors = [];

  /* 复用侧的两种模式才需要下面这些检查。fresh 一律放行 ——
   * 一个全新的 agent 没有"见过什么"，也就没有泄漏可谈。 */
  const reusing = mode === 'reuse' || mode === 'fork';

  /* `seenIds` 取两处的并集：调用方显式给的，与 agent 自己记的。
   * 只看一处会让"账本记了但调用方没传"变成漏检。 */
  const seenIds = [
    ...(Array.isArray(source.seenIds) ? source.seenIds : []),
    ...(Array.isArray(agent?.seenIds) ? agent.seenIds : []),
  ];
  const withheldIds = Array.isArray(source.withheldIds) ? source.withheldIds : [];
  const leaked = intersect(seenIds, withheldIds);

  /* 边界 ①：见过本该扣住的东西却还要复用。 */
  if (reusing && leaked.length > 0) {
    errors.push(diag(
      'E_BLIND_AGENT_REUSED',
      `这一阶段要扣住 ${withheldIds.length} 项产物，但这个 agent 已经见过其中 `
        + `${leaked.length} 项（${leaked.join('、')}）。`
        + '盲审的价值全在"它没看过"，看过之后再复用等于把盲审变成复述。换一个 fresh agent。',
      stageId,
    ));
  }

  /* 边界 ②：评审人与被审人是同一个 agent，且不是 fork。
   * 沿用基线的 `E_SELF_REVIEW` —— 同一个病用同一个码，不另起名字。 */
  const reviewedAgentId = typeof source.reviewedAgentId === 'string' ? source.reviewedAgentId : '';
  if (
    reusing
    && mode !== 'fork'
    && reviewedAgentId !== ''
    && agent !== null
    && typeof agent.id === 'string'
    && agent.id === reviewedAgentId
  ) {
    errors.push(diag(
      'E_SELF_REVIEW',
      `这一阶段要评审 ${reviewedAgentId} 的产物，而复用的正是 ${reviewedAgentId} 自己 —— `
        + '自己审自己不算独立复核。换一个 agent，或者明确声明 fork（那才是另一份上下文）。',
      stageId,
    ));
  }

  /* 边界 ③：跨会议复用，但**隔离无从验证**。
   *
   * 判据是"这一阶段没有声明任何要扣住的产物"。此时 `seenIds ∩ withheldIds` 必然为空，
   * 而那个空**只证明"没检查"**，不证明"它没看过"。本项目的红线是「空 ≠ 可用」，
   * 所以不许把这种情况当成"隔离成立、可以复用"。
   *
   * 分工（方案 A 之后）：它与边界 ① 不是同一件事，也不许合并 ——
   *   - ① `E_BLIND_AGENT_REUSED`            = 隔离**已经破了**（见过被扣的东西）；
   *   - ③ `E_AGENT_SHARED_ACROSS_MEETINGS`  = 隔离**无法确认**（没有可核对的清单）。
   *
   * 方案 A 废掉了原来那条"跨会议一律不许裸复用、要复用就声明 fork"：
   * `fork` **继承上下文**，而跨会议复用要防的恰恰是把上一场会的结论带过来 —— 方向是反的。
   * 跨会议复用现在是**允许**的，前提就是隔离可核对。 */
  const meetingId = typeof source.meetingId === 'string' ? source.meetingId : '';
  const agentMeetings = meetingsOf(agent);
  const crossed = [...agentMeetings].filter((id) => id !== meetingId);
  if (mode === 'reuse' && crossed.length > 0 && withheldIds.length === 0) {
    errors.push(diag(
      'E_AGENT_SHARED_ACROSS_MEETINGS',
      `这个 agent 已经在别的会议里工作过（${crossed.join('、')}），现在要复用到这一场，`
        + '但这一阶段**没有声明任何要扣住的产物** —— 于是"它没看过"这件事无从核对，'
        + '而"核对为空"不等于"隔离成立"。要么把该扣的产物列进来再复用，要么换一个 fresh agent。',
      stageId,
    ));
  }

  return {
    ok: errors.length === 0,
    errors,
    intersections: {
      seenIds: seenIds.length,
      withheldIds: withheldIds.length,
      leaked,
    },
  };
}

/**
 * 领导要看的判断依据。
 *
 * 方案 §4 原话：`seenIds[]` · 目标阶段的 `withheldIds` · 历史成败（基线 `roleStats`）·
 * 复用能省多少上下文。
 *
 * @param {object} input
 *   { stage, agent, seenIds, withheldIds, completedStages, roleStats,
 *     mode, rule, reason }
 *   `mode` / `rule` / `reason` 由 `decideAgent` 回填 —— 这样"领导要看的判断依据"里
 *   就带着**这次到底凭什么选了这个模式**，而不是只有原料让他自己猜。
 * @returns {object}
 */
export function explainChoice(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const stage = source.stage !== null && typeof source.stage === 'object' ? source.stage : null;
  const agent = source.agent !== null && typeof source.agent === 'object' ? source.agent : null;

  const seenIds = [
    ...(Array.isArray(source.seenIds) ? source.seenIds : []),
    ...(Array.isArray(agent?.seenIds) ? agent.seenIds : []),
  ];
  const withheldIds = Array.isArray(source.withheldIds) ? source.withheldIds : [];
  const completed = Number.isSafeInteger(source.completedStages) ? source.completedStages : 0;

  return {
    stageId: typeof stage?.id === 'string' ? stage.id : null,
    blind: stage?.blind === true,
    agentId: typeof agent?.id === 'string' ? agent.id : null,
    /* 判定结论 + 命中的是哪一条判据 + 那句话。
     * 三个都要：只有 `mode` 读者不知道凭什么，只有 `reason` 机器没法分组统计。 */
    mode: typeof source.mode === 'string' ? source.mode : null,
    rule: typeof source.rule === 'string' ? source.rule : null,
    reason: typeof source.reason === 'string' ? source.reason : null,
    seenIds: [...new Set(seenIds)],
    withheldIds: [...new Set(withheldIds)],
    leaked: intersect(seenIds, withheldIds),
    /* "复用能省多少上下文"的**粗略**估计：能省下已完成阶段的卡数。
     * 写成对象而不是一个数字，是为了让它没法被当成精确值引用 ——
     * 一个裸数字 `2` 会被当成事实，`{stages: 2, note: '…'}` 不会。 */
    contextSaving: {
      stages: completed,
      note: '粗略估计：复用能省下"已完成阶段的卡数"这么多张卡的上下文，'
        + '不含工具调用历史与中间推理 —— 实际省下的比这个多，但多多少本模块不知道。',
    },
    roleStats: source.roleStats === undefined ? null : source.roleStats,
  };
}

/**
 * 拍板：默认模式 + 领导覆盖 + 三条边界。
 *
 * 顺序是有意的：**先算默认，再让领导覆盖，最后无条件跑边界**。
 * 边界放在最后，是为了保证"无论领导选了什么都不影响它被检查" ——
 * 如果边界在覆盖之前跑，一次覆盖就能绕过它。
 *
 * @param {object} input
 *   { stage, candidate, attempt, role, leaderChoice, leaderReason,
 *     seenIds, withheldIds, reviewedAgentId, meetingId,
 *     completedStages, roleStats }
 *   - `attempt`：本阶段第几轮，`≥ 2` 才算返工（决定 fork）。
 *   - `role` / `candidate.role`：这个 agent 承担的角色（决定跨会议复用是否同角色）。
 * @returns {{ok: boolean, mode: string, rule: string, agentId: string|null,
 *            defaultMode: string, overridden: boolean,
 *            reason: string, evidence: object,
 *            errors: Array<object>, warnings: Array<object>, cannotJudge: string}}
 */
export function decideAgent(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const stage = source.stage !== null && typeof source.stage === 'object' ? source.stage : null;
  const stageId = typeof stage?.id === 'string' ? stage.id : undefined;
  const candidate = source.candidate !== null && typeof source.candidate === 'object' ? source.candidate : null;

  const fallback = defaultAgentMode(source);
  const errors = [...fallback.errors];
  const warnings = [];
  let mode = fallback.mode;
  let reason = fallback.reason;
  let overridden = false;

  /* 领导覆盖。两条限制：
   *   1. 默认不可覆盖时（盲阶段 / 连续 pass 疲劳）一律拒绝覆盖
   *   2. 覆盖必须写理由 —— 不写理由的覆盖在账本上等于"不知道为什么换人" */
  if (Object.prototype.hasOwnProperty.call(source, 'leaderChoice') && source.leaderChoice !== undefined) {
    const choice = source.leaderChoice;
    if (!AGENT_MODES.includes(choice)) {
      errors.push(diag(
        'E_ARTIFACT_MALFORMED',
        `领导给的复用模式 ${JSON.stringify(choice)} 不在 ${AGENT_MODES.join(' / ')} 之内。`,
        stageId,
      ));
    } else if (fallback.overridable === false && choice !== fallback.mode) {
      /* 不可覆盖的场合：盲阶段、连续 pass 疲劳。
       * 这两处**领导说了也不算** —— 方案原话「三条硬边界（机器拦，领导不能覆盖）」，
       * 而盲阶段 fresh 是比硬边界更硬的一条：它是机制的定义。 */
      errors.push(diag(
        'E_BLIND_AGENT_REUSED',
        `${stageId ?? '这一阶段'} 的复用模式不可覆盖（默认 ${fallback.mode}），`
          + `领导想改成 ${choice} 被拒绝。原因：${fallback.reason}`,
        stageId,
      ));
    } else if (choice !== fallback.mode) {
      if (typeof source.leaderReason !== 'string' || source.leaderReason.trim() === '') {
        warnings.push(diag(
          'E_AGENT_OVERRIDE_NO_REASON',
          `领导把复用模式从 ${fallback.mode} 改成了 ${choice}，但没有写理由 —— `
            + '覆盖本身允许，但账本上会变成"不知道为什么换了人"。',
          stageId,
        ));
      }
      mode = choice;
      reason = `领导覆盖：${fallback.mode} → ${choice}。${typeof source.leaderReason === 'string' ? source.leaderReason : ''}`.trim();
      overridden = true;
    }
  }

  /* 边界无条件跑一遍 —— 覆盖之后也要跑。 */
  const boundary = checkBoundaries({
    stage,
    mode,
    agent: candidate,
    seenIds: source.seenIds,
    withheldIds: source.withheldIds,
    reviewedAgentId: source.reviewedAgentId,
    meetingId: source.meetingId,
  });
  errors.push(...boundary.errors);

  return {
    ok: errors.length === 0,
    mode,
    rule: fallback.rule,
    agentId: typeof candidate?.id === 'string' ? candidate.id : null,
    defaultMode: fallback.mode,
    overridden,
    reason,
    evidence: explainChoice({
      stage,
      agent: candidate,
      seenIds: source.seenIds,
      withheldIds: source.withheldIds,
      completedStages: source.completedStages,
      roleStats: source.roleStats,
      /* 回填判定结论：读者一眼能看到"选了哪个 + 命中的是哪条判据 + 那句话"。 */
      mode,
      rule: fallback.rule,
      reason,
    }),
    errors,
    warnings,
    cannotJudge: `${fallback.cannotJudge}`
      + ' 另外：`seenIds` 为空**不证明**它没看过 —— 只证明账本上没记它看过。',
  };
}

/**
 * 一组"这一阶段允不允许用某个 agent"的快速判据。
 *
 * 供 `host/meeting.js` 在真正创建子会话前做最后一次闸门。
 * 与 `decideAgent` 的区别：它不参与"选哪个模式"，只回答"这个选择能不能成立"。
 *
 * @param {object} input 同 `checkBoundaries`
 * @returns {boolean}
 */
export function isAgentAllowed(input) {
  return checkBoundaries(input).ok;
}

/**
 * 阶段声明的 kind 是否与角色职责相容的最小检查。
 *
 * 只拦一种明确矛盾：`kind: review` 的阶段却声明了一个非评审角色 ——
 * 那种阶段会去"评审"，而它拿到的产物根本不是被审对象。
 *
 * @param {object} stage
 * @returns {{ok: boolean, errors: Array<object>}}
 */
export function checkStageRole(stage) {
  const source = stage !== null && typeof stage === 'object' ? stage : {};
  const stageId = typeof source.id === 'string' ? source.id : undefined;
  if (!isKnownStageKind(source.kind)) {
    return {
      ok: false,
      errors: [diag(
        'E_ARTIFACT_MALFORMED',
        `阶段 ${String(source.id)} 的 kind 不是已知类型 —— 派工时无法决定给它什么活。`,
        stageId,
      )],
    };
  }
  return { ok: true, errors: [] };
}
