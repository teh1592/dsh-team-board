/**
 * adapter.mjs — DSH 宿主的唯一耦合面。
 *
 * 职责只有三件事：
 *   1. 探测宿主 ctx 上存在哪些能力（纯属性/方法存在性检查，绝不调用、不 defineProperty、不改写宿主对象）；
 *   2. 依据「成员会话是否存在 / 是否 idle」把一次投递分流到三种投递形态；
 *   3. 把缺失能力转成带 code 的结构化错误，供上层统一处理。
 *
 * 设计约束：
 *   - 纯 ESM、零依赖，不 import 任何 @deepseek-ai/* 包；一切通过传入的 ctx 做鸭子类型判断。
 *   - 不 monkey-patch、不 try/catch 吞错，探测失败就让异常向上冒。
 */

/**
 * 插件运转所需的宿主能力清单（顺序即展示顺序）。
 * 缺任意一项，插件对应的功能维度就降级。
 */
export const REQUIRED_CAPABILITIES = Object.freeze([
  'agentTeams',
  'subagents',
  'storageDomain',
  'timer',
  'approval',
  'workspaceChanges',
  'tools',
]);

/**
 * 每项能力的判定规格：宿主对象上必须存在的主属性 + 必须为 function 的关键方法。
 * 这是 probeHost 的单一事实来源。
 */
export const CAPABILITY_CHECKS = Object.freeze({
  agentTeams: { key: 'agentTeams', methods: ['spawnTeammate', 'createTask', 'updateTask', 'listTasks'] },
  subagents: { key: 'subagents', methods: ['startActivation', 'sendMessage', 'interrupt'] },
  storageDomain: { key: 'storageDomain', methods: ['open'] },
  timer: { key: 'timer', methods: ['interval', 'timeout'] },
  approval: { key: 'approval', methods: ['request'] },
  workspaceChanges: { key: 'workspaceChanges', methods: ['summary'] },
  tools: { key: 'tools', methods: ['register', 'restrict', 'guard'] },
});

/** 投递分流的理由说明，供日志 / team_status / 文档直接引用。 */
export const DELIVERY_RATIONALE = Object.freeze({
  startActivation: 'startActivation：成员会话还不存在（冷启动或尚未落盘），必须先拉起一次激活把会话建出来，再把消息交给它。',
  queue: 'queue：成员会话存在且 idle === true，走 agent.followup() 排队投递；followup 会唤醒空闲 agent 并为它起一轮，消息不会丢。',
  steer:
    'steer：成员会话存在且 idle === false（正在跑），把消息并入目标当前回合最近的一个 step；代价是这次派工摊成两个 turn，派工边界与目标正在做的工作混在一起，事后无法归属。分档结论成立的原因是准入条件——这一档只在目标正忙时才会进入。',
  summary:
    '投递顺序：不存在 → startActivation；存在且空闲 → queue（agent.followup() 唤醒空闲 agent 并起一轮）；存在且在跑 → steer（并入当前回合最近的一个 step，代价是派工摊成两个 turn、边界无法归属）。',
});

/**
 * 判定一个值能否作为「能力容器」被读取。
 * 用 typeof 而非 instanceof，避免跨 realm / Proxy 误判。
 */
function isObjectLike(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * 容器存在且列出的每个方法都是 function 才算具备。
 * 只读属性，不调用、不写回。
 */
function hasMethods(container, methods) {
  if (!isObjectLike(container)) return false;
  return methods.every((method) => typeof container[method] === 'function');
}

/**
 * 探测宿主能力。
 * 只做属性存在性 + 关键方法存在性检查：不调用宿主方法、不遍历 symbol 链、不修改 ctx。
 *
 * @param {object} ctx 宿主上下文（可以是普通对象假 ctx）
 * @returns {{capabilities: Record<string, boolean>, missing: string[]}}
 */
export function probeHost(ctx) {
  const host = isObjectLike(ctx) ? ctx : {};
  /** @type {Record<string, boolean>} */
  const capabilities = {};
  /** @type {string[]} */
  const missing = [];

  for (const name of REQUIRED_CAPABILITIES) {
    const check = CAPABILITY_CHECKS[name];
    const ok = hasMethods(host[check.key], check.methods);
    capabilities[name] = ok;
    if (!ok) missing.push(name);
  }

  return { capabilities, missing };
}

/**
 * 把 probe 结果归一成 {capabilities, missing}。
 * 传入完整 probe 时直接复用；传入裸 ctx（或空值）时现场探测；非法入参按「全缺」处理。
 */
function normalizeProbe(probe) {
  if (isObjectLike(probe) && isObjectLike(probe.capabilities)) {
    const capabilities = probe.capabilities;
    const missing = Array.isArray(probe.missing)
      ? probe.missing.filter((name) => typeof name === 'string')
      : REQUIRED_CAPABILITIES.filter((name) => capabilities[name] !== true);
    return { capabilities, missing };
  }
  return probeHost(probe);
}

/**
 * 依据成员会话状态选择投递形态。
 *
 * - 会话不存在        → 'startActivation'（冷启动 / 缺席，先激活）
 * - 存在且 idle=true  → 'queue'（agent.followup() 会把空闲 agent 唤醒并起一轮）
 * - 存在且 idle=false → 'steer'（并入目标当前回合最近的一个 step，用于在跑的目标）
 *
 * steer 的代价在派工边界，不在"是否惊动目标"：消息并入目标当前回合后，这次派工摊成
 * 两个 turn，与目标正在做的工作混在一起，事后无法归属。因此三档结论靠的是 steer 的
 * 准入条件（只允许 idle === false），而不是"steer 更安静"这类说法。
 *
 * idle 未给出（undefined/null）即"状态未知"：此时一律走 queue。queue 对空闲/在跑都不会
 * 丢消息，也不依赖对目标状态的猜测；在没有证据说目标正忙时，不该让派工去撞回合边界。
 *
 * @param {{exists?: boolean, idle?: boolean}} input
 * @returns {'startActivation' | 'queue' | 'steer'}
 */
export function pickDelivery({ exists, idle } = {}) {
  if (!exists) return 'startActivation';
  if (idle === false) return 'steer';
  return 'queue';
}

/**
 * 构造「宿主不支持某能力」的结构化错误。
 *
 * @param {string} name 能力名
 * @returns {Error & {code: 'E_HOST_UNSUPPORTED', capability: string}}
 */
export function unsupported(name) {
  const capability = typeof name === 'string' && name.length > 0 ? name : 'unknown';
  const error = new Error(
    `宿主缺少能力「${capability}」：插件在该宿主上无法使用 ${capability} 相关功能（E_HOST_UNSUPPORTED）`,
  );
  error.name = 'HostUnsupportedError';
  error.code = 'E_HOST_UNSUPPORTED';
  error.capability = capability;
  return error;
}

/**
 * 断言指定能力全部具备；缺任意一项就抛 unsupported(第一个缺失项)。
 *
 * @param {{capabilities: Record<string, boolean>, missing: string[]}} probe probeHost 的返回值
 * @param {string[] | string} names 需要的能力；缺省为 REQUIRED_CAPABILITIES
 * @returns {void}
 */
export function requireCapabilities(probe, names = REQUIRED_CAPABILITIES) {
  const { capabilities } = normalizeProbe(probe);
  const requested = Array.isArray(names) ? names : [names];

  for (const name of requested) {
    if (capabilities[name] !== true) throw unsupported(name);
  }
}

/**
 * 人类可读的一行摘要，用于 team_status 与日志。
 * 形如：宿主能力 6/7 已具备，缺失 1 项：timer
 *
 * @param {{capabilities: Record<string, boolean>, missing: string[]}} probe
 * @returns {string}
 */
export function describeHost(probe) {
  const { capabilities, missing } = normalizeProbe(probe);
  const total = REQUIRED_CAPABILITIES.length;
  const present = REQUIRED_CAPABILITIES.filter((name) => capabilities[name] === true).length;
  const parts = [`宿主能力 ${present}/${total} 已具备`, `缺失 ${missing.length} 项`];

  if (missing.length > 0) {
    parts[1] += `：${missing.join('、')}`;
  } else {
    parts[1] += '：无';
  }

  return parts.join('，');
}
