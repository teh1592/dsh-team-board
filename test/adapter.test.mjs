import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REQUIRED_CAPABILITIES,
  CAPABILITY_CHECKS,
  DELIVERY_RATIONALE,
  probeHost,
  pickDelivery,
  unsupported,
  requireCapabilities,
  describeHost,
} from '../src/adapter.mjs';

// ---------------------------------------------------------------------------
// 假宿主夹具：普通对象，方法全是可被调用的函数（但记录调用次数，用于反证「探测不调用」）
// ---------------------------------------------------------------------------

/** 造一组方法，调用即自增 calls 便于断言 */
function makeMethods(names, calls) {
  const bag = {};
  for (const name of names) {
    bag[name] = (...args) => {
      calls.push({ method: name, args });
      return { ok: true, method: name };
    };
  }
  return bag;
}

/** 完整的假宿主 ctx */
function fullCtx() {
  const calls = [];
  return {
    calls,
    ctx: {
      agentTeams: makeMethods(CAPABILITY_CHECKS.agentTeams.methods, calls),
      subagents: makeMethods(CAPABILITY_CHECKS.subagents.methods, calls),
      storageDomain: makeMethods(CAPABILITY_CHECKS.storageDomain.methods, calls),
      timer: makeMethods(CAPABILITY_CHECKS.timer.methods, calls),
      approval: makeMethods(CAPABILITY_CHECKS.approval.methods, calls),
      workspaceChanges: makeMethods(CAPABILITY_CHECKS.workspaceChanges.methods, calls),
      tools: makeMethods(CAPABILITY_CHECKS.tools.methods, calls),
    },
  };
}

/** 完整宿主但删掉某一项能力 */
function ctxWithout(capability) {
  const { ctx } = fullCtx();
  delete ctx[capability];
  return ctx;
}

// ---------------------------------------------------------------------------
// 1. 能力清单与 probeHost 返回结构
// ---------------------------------------------------------------------------

test('REQUIRED_CAPABILITIES 恰好列出 7 项且顺序稳定', () => {
  assert.equal(REQUIRED_CAPABILITIES.length, 7);
  assert.deepEqual([...REQUIRED_CAPABILITIES], [
    'agentTeams',
    'subagents',
    'storageDomain',
    'timer',
    'approval',
    'workspaceChanges',
    'tools',
  ]);
  assert.ok(Object.isFrozen(REQUIRED_CAPABILITIES));
});

test('probeHost 返回 {capabilities, missing} 且 key 集合与清单一致', () => {
  const probe = probeHost(fullCtx().ctx);
  assert.deepEqual(Object.keys(probe).sort(), ['capabilities', 'missing']);
  assert.deepEqual(Object.keys(probe.capabilities).sort(), [...REQUIRED_CAPABILITIES].sort());
  assert.ok(Array.isArray(probe.missing));
  for (const value of Object.values(probe.capabilities)) {
    assert.equal(typeof value, 'boolean');
  }
});

test('probeHost：全具备时 7 项全 true、missing 为空', () => {
  const probe = probeHost(fullCtx().ctx);
  for (const name of REQUIRED_CAPABILITIES) {
    assert.equal(probe.capabilities[name], true, `能力 ${name} 应判定为具备`);
  }
  assert.deepEqual(probe.missing, []);
});

// ---------------------------------------------------------------------------
// 2. 「只做存在性检查」的行为约束
// ---------------------------------------------------------------------------

test('probeHost 不调用任何宿主方法', () => {
  const { ctx, calls } = fullCtx();
  probeHost(ctx);
  assert.deepEqual(calls, [], 'probeHost 不得调用宿主方法');
});

test('probeHost 不调用宿主方法：方法体直接抛错也不会触发', () => {
  const exploding = {
    agentTeams: {
      spawnTeammate: () => {
        throw new Error('不得调用 spawnTeammate');
      },
      createTask: () => {
        throw new Error('不得调用 createTask');
      },
      updateTask: () => {
        throw new Error('不得调用 updateTask');
      },
      listTasks: () => {
        throw new Error('不得调用 listTasks');
      },
    },
  };
  const probe = probeHost(exploding);
  assert.equal(probe.capabilities.agentTeams, true);
});

test('probeHost 不改写宿主对象、不新增属性（无 defineProperty）', () => {
  const { ctx } = fullCtx();
  const beforeKeys = Object.keys(ctx).sort();
  const beforeDescriptors = Object.fromEntries(
    Object.entries(Object.getOwnPropertyDescriptors(ctx)).map(([k, d]) => [
      k,
      { configurable: d.configurable, enumerable: d.enumerable, writable: d.writable, hasGetter: Boolean(d.get), hasSetter: Boolean(d.set) },
    ]),
  );

  probeHost(ctx);

  assert.deepEqual(Object.keys(ctx).sort(), beforeKeys);
  const afterDescriptors = Object.fromEntries(
    Object.entries(Object.getOwnPropertyDescriptors(ctx)).map(([k, d]) => [
      k,
      { configurable: d.configurable, enumerable: d.enumerable, writable: d.writable, hasGetter: Boolean(d.get), hasSetter: Boolean(d.set) },
    ]),
  );
  assert.deepEqual(afterDescriptors, beforeDescriptors);
  assert.equal(Object.isExtensible(ctx), true);
  assert.equal(Object.getOwnPropertySymbols(ctx).length, 0, '不应挂 symbol');
});

// ---------------------------------------------------------------------------
// 3. 各缺一项：7 个用例
// ---------------------------------------------------------------------------

const CAPABILITY_CASES = [
  ['agentTeams', ['spawnTeammate', 'createTask', 'updateTask', 'listTasks']],
  ['subagents', ['startActivation', 'sendMessage', 'interrupt']],
  ['storageDomain', ['open']],
  ['timer', ['interval', 'timeout']],
  ['approval', ['request']],
  ['workspaceChanges', ['summary']],
  ['tools', ['register', 'restrict', 'guard']],
];

for (const [name, methods] of CAPABILITY_CASES) {
  test(`probeHost：缺 ${name} 时只有该项进 missing`, () => {
    const probe = probeHost(ctxWithout(name));
    assert.equal(probe.capabilities[name], false);
    assert.deepEqual(probe.missing, [name]);
    for (const other of REQUIRED_CAPABILITIES) {
      if (other === name) continue;
      assert.equal(probe.capabilities[other], true, `${other} 不应被牵连`);
    }
    // 关键方法不在也算缺
    const { ctx } = fullCtx();
    const crippled = { ...ctx, [name]: { ...ctx[name] } };
    delete crippled[name][methods[0]];
    const probe2 = probeHost(crippled);
    assert.equal(probe2.capabilities[name], false, `${name} 缺 ${methods[0]} 时必须判缺`);
    assert.ok(probe2.missing.includes(name));
  });
}

test('probeHost：主属性存在但关键方法非 function 也判缺', () => {
  const { ctx } = fullCtx();
  const broken = {
    ...ctx,
    tools: { register: 'not-a-function', restrict: () => {}, guard: () => {} },
  };
  assert.equal(probeHost(broken).capabilities.tools, false);

  const notAnObject = { ...ctx, timer: 'timer-service' };
  assert.equal(probeHost(notAnObject).capabilities.timer, false);

  const nullCapability = { ...ctx, approval: null };
  assert.equal(probeHost(nullCapability).capabilities.approval, false);
});

// ---------------------------------------------------------------------------
// 4. 空 ctx / 空值：7 项全缺
// ---------------------------------------------------------------------------

test('probeHost：ctx 为 {} 时 7 项全缺', () => {
  const probe = probeHost({});
  assert.deepEqual(probe.missing, [...REQUIRED_CAPABILITIES]);
  assert.equal(probe.missing.length, 7);
  for (const name of REQUIRED_CAPABILITIES) {
    assert.equal(probe.capabilities[name], false);
  }
});

test('probeHost：ctx 为 null/undefined 时不炸，按全缺处理', () => {
  for (const value of [null, undefined]) {
    const probe = probeHost(value);
    assert.deepEqual(probe.missing, [...REQUIRED_CAPABILITIES]);
  }
});

// ---------------------------------------------------------------------------
// 5. unsupported + requireCapabilities
// ---------------------------------------------------------------------------

test('unsupported 返回带 code 的 Error，message 含能力名', () => {
  const error = unsupported('timer');
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'E_HOST_UNSUPPORTED');
  assert.match(error.message, /timer/);
  assert.equal(error.capability, 'timer');
});

test('probeHost 的缺失项能逐项转成 unsupported 错误', () => {
  const probe = probeHost(ctxWithout('workspaceChanges'));
  assert.deepEqual(probe.missing, ['workspaceChanges']);

  let thrown;
  assert.throws(
    () => requireCapabilities(probe, probe.missing),
    (error) => {
      thrown = error;
      return true;
    },
  );
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.code, 'E_HOST_UNSUPPORTED');
  assert.match(thrown.message, /workspaceChanges/);
});

test('requireCapabilities：缺项抛 E_HOST_UNSUPPORTED，全具备返回 undefined', () => {
  const partial = probeHost({ timer: { interval: () => {}, timeout: () => {} } });

  assert.throws(
    () => requireCapabilities(partial, ['timer', 'approval']),
    (error) => error instanceof Error && error.code === 'E_HOST_UNSUPPORTED' && /approval/.test(error.message),
  );

  assert.throws(
    () => requireCapabilities(partial, ['agentTeams']),
    (error) => error.code === 'E_HOST_UNSUPPORTED' && /agentTeams/.test(error.message),
  );

  const full = probeHost(fullCtx().ctx);
  assert.equal(requireCapabilities(full, [...REQUIRED_CAPABILITIES]), undefined);
  assert.equal(requireCapabilities(full), undefined, '默认检查全部能力');

  // 单个字符串也接受
  assert.equal(requireCapabilities(full, 'tools'), undefined);
});

test('requireCapabilities：未知能力名按缺失处理', () => {
  const full = probeHost(fullCtx().ctx);
  assert.throws(
    () => requireCapabilities(full, ['teleporter']),
    (error) => error.code === 'E_HOST_UNSUPPORTED' && /teleporter/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// 6. pickDelivery 三档分流
// ---------------------------------------------------------------------------

test('pickDelivery：成员会话不存在 → startActivation', () => {
  assert.equal(pickDelivery({ exists: false, idle: false }), 'startActivation');
  assert.equal(pickDelivery({ exists: false, idle: true }), 'startActivation');
  assert.equal(pickDelivery({ exists: false }), 'startActivation');
  assert.equal(pickDelivery({}), 'startActivation');
});

test('pickDelivery：存在且 idle === true → queue', () => {
  assert.equal(pickDelivery({ exists: true, idle: true }), 'queue');
});

test('pickDelivery：存在且 idle === false → steer', () => {
  assert.equal(pickDelivery({ exists: true, idle: false }), 'steer');
});

test('pickDelivery：只从三档里取值', () => {
  const allowed = new Set(['startActivation', 'queue', 'steer']);
  for (const exists of [true, false, 1, 0, undefined]) {
    for (const idle of [true, false, undefined, null]) {
      assert.ok(allowed.has(pickDelivery({ exists, idle })), `exists=${exists} idle=${idle}`);
    }
  }
});

test('DELIVERY_RATIONALE 说明了 queue/steer/startActivation 各自的理由', () => {
  assert.match(DELIVERY_RATIONALE.queue, /agent\.followup\(\)/);
  assert.match(DELIVERY_RATIONALE.queue, /空闲/);
  assert.match(DELIVERY_RATIONALE.steer, /最近.*step|最近的一个 step/);
  assert.match(DELIVERY_RATIONALE.steer, /在跑/);
  assert.match(DELIVERY_RATIONALE.startActivation, /冷启动|不存在/);
  assert.deepEqual(Object.keys(DELIVERY_RATIONALE).sort(), ['queue', 'startActivation', 'steer', 'summary']);
});

// ---------------------------------------------------------------------------
// 7. describeHost 摘要
// ---------------------------------------------------------------------------

test('describeHost：全具备时摘要含 7/7 与缺失 0 项', () => {
  const line = describeHost(probeHost(fullCtx().ctx));
  assert.equal(typeof line, 'string');
  assert.equal(line.includes('\n'), false, '应为一行的摘要');
  assert.match(line, /7\/7/);
  assert.match(line, /缺失 0 项：无/);
  for (const name of REQUIRED_CAPABILITIES) {
    assert.doesNotMatch(line, new RegExp(name), '全具备时不应列出缺失名单');
  }
});

test('describeHost：部分缺失时同时给出已具备/缺失数量与缺失名单', () => {
  const ctx = ctxWithout('timer');
  delete ctx.approval;
  const line = describeHost(probeHost(ctx));
  assert.match(line, /5\/7/, '已具备数量应为 5');
  assert.match(line, /缺失 2 项/);
  assert.match(line, /timer/);
  assert.match(line, /approval/);
});

test('describeHost：全缺时给出 0/7 与全部 7 项名', () => {
  const line = describeHost(probeHost({}));
  assert.match(line, /0\/7/);
  assert.match(line, /缺失 7 项/);
  for (const name of REQUIRED_CAPABILITIES) {
    assert.match(line, new RegExp(name));
  }
});

// ---------------------------------------------------------------------------
// 8. 文案正确性：锁住「steer 的真实代价是派工边界，不是不唤醒 idle」
//
// 实测事实（不可协商）：
//   - 向一个空闲（idle）的 agent 发消息，会把它唤醒并起一轮。
//   - steer 的真实代价是：消息并入目标当前回合，这次派工摊成两个 turn，
//     派工边界与目标正在做的工作混在一起，事后无法归属。
//   - 三档分流结论依然正确，靠的是 steer 的准入条件（只允许 idle === false）。
// 因此任何把 steer 描述成「不唤醒 / 不惊动 / 不新起一轮」的措辞都是事实错误。
// ---------------------------------------------------------------------------

/** 已实测证伪的错误前提：凡是断言 steer 对 idle 不产生唤醒/回合的表述都命中这里。 */
const WRONG_WAKE_PREMISE = /不唤醒|不会唤醒|无法唤醒|不产生唤醒|不新起一轮|不惊动/;

/** 递归收集一个值里所有字符串（当前取值是扁平字符串，仍保险处理嵌套）。 */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) collectStrings(inner, out);
  }
  return out;
}

test('DELIVERY_RATIONALE：任何字符串值都不得断言 steer 不唤醒 idle / 不新起一轮', () => {
  const strings = collectStrings(DELIVERY_RATIONALE);
  assert.ok(strings.length >= 4, '应当逐字段扫描到全部字符串值');
  for (const text of strings) {
    const hit = text.match(WRONG_WAKE_PREMISE);
    assert.equal(hit, null, `文案含错误前提「${hit?.[0]}」：${text}`);
  }
});

test('DELIVERY_RATIONALE.steer：理由必须落在「并入当前回合 → 摊成两个 turn → 无法归属」', () => {
  const steer = DELIVERY_RATIONALE.steer;
  assert.match(steer, /并入|并进/, '必须说明 steer 会把消息并入目标当前回合');
  assert.match(steer, /回合/);
  assert.match(steer, /两个 turn/, '必须说明这次派工摊成两个 turn');
  assert.match(steer, /归属/, '必须说明派工边界无法事后归属');
  // 分档为什么仍然成立，只能是准入条件，不能是"更安静"
  assert.match(steer, /准入|只在|idle === false/);
});

/**
 * 模块在运行时**真正吐出来**的文案：导出常量 + 函数返回值。
 *
 * 这不是"再读一遍源码"：`unsupported()` 的 message 与 `describeHost()` 的摘要
 * 是模型和日志直接看到的那一层，取它们等于取行为结果；改文案就会改这里。
 */
function emittedStrings() {
  const out = [];
  collectStrings(DELIVERY_RATIONALE, out);
  collectStrings(CAPABILITY_CHECKS, out);

  for (const name of [...REQUIRED_CAPABILITIES, 'timer', 'nonexistent', '', undefined]) {
    out.push(unsupported(name).message);
  }

  const probes = [
    probeHost(fullCtx().ctx), // 7/7
    probeHost({}), // 0/7
    probeHost(ctxWithout('timer')), // 6/7
    { capabilities: { timer: true }, missing: [] }, // 部分给、缺失名单空
  ];
  for (const probe of probes) out.push(describeHost(probe));

  return out.filter((text) => typeof text === 'string');
}

test('对外文案（运行时取出，不是源码文本）无「steer 不唤醒」残留', () => {
  const strings = emittedStrings();
  // 覆盖不到位的绿没有意义：先确认真的取到了一批文案
  assert.ok(strings.length >= 12, `应取到多条对外文案，实际只有 ${strings.length} 条`);

  for (const text of strings) {
    assert.notEqual(text, '', '对外文案不该是空串（空串等于没交代）');
    const hit = text.match(WRONG_WAKE_PREMISE);
    assert.equal(hit, null, `对外文案含错误前提「${hit?.[0]}」：${text}`);
  }

  /* 这条替换掉的是「对 adapter.mjs 源码跑同一个正则」（原 :386-390）。
   * 那条断言只能证明"文件里没有这些字"，证明不了任何运行时行为：把函数体改坏、
   * 注释保持正确，它照样绿；反过来只在注释里写错一句、代码没动，它却红。
   * 注释不是行为 —— 现在只锁运行时真正被读到的文案。
   *
   * 「idle 会被唤醒 / steer 只准在 idle === false 时进入」这类真正的行为，
   * 由 :454 的三档回归表与 :287 的 steer 用例负责，不靠文案。 */
});

test('DELIVERY_RATIONALE 是深度冻结：不可改值、不可加键', () => {
  assert.ok(Object.isFrozen(DELIVERY_RATIONALE), 'DELIVERY_RATIONALE 必须冻结');
  assert.equal(Object.isExtensible(DELIVERY_RATIONALE), false);
  // 值全为原始字符串 → 不存在嵌套可变对象，浅冻结即等价于深度冻结
  for (const [key, value] of Object.entries(DELIVERY_RATIONALE)) {
    assert.equal(typeof value, 'string', `${key} 应为字符串（原始值不可变）`);
  }
  assert.throws(
    () => {
      DELIVERY_RATIONALE.steer = 'mutated';
    },
    TypeError,
  );
  assert.throws(
    () => {
      DELIVERY_RATIONALE.extra = 'extra';
    },
    TypeError,
  );
  assert.notEqual(DELIVERY_RATIONALE.steer, 'mutated');
  assert.equal(Object.hasOwn(DELIVERY_RATIONALE, 'extra'), false);
});

test('回归固化：pickDelivery 三档结论零变化（改文案不得改分流）', () => {
  const table = [
    [{ exists: true, idle: false }, 'steer'],
    [{ exists: true, idle: true }, 'queue'],
    [{ exists: true }, 'queue'],
    [{ exists: true, idle: null }, 'queue'],
    [{ exists: false }, 'startActivation'],
    [{ exists: false, idle: false }, 'startActivation'],
    [{ exists: false, idle: true }, 'startActivation'],
    [{}, 'startActivation'],
    [undefined, 'startActivation'],
  ];
  for (const [input, expected] of table) {
    assert.equal(pickDelivery(input), expected, `pickDelivery(${JSON.stringify(input)}) 应为 ${expected}`);
  }
  // steer 的准入条件不得被改宽：状态未知/空闲都进不了 steer
  assert.equal(pickDelivery({ exists: true }), 'queue');
  assert.equal(pickDelivery({ exists: true, idle: undefined }), 'queue');
  assert.equal(pickDelivery({ exists: true, idle: 0 }), 'queue');
});
