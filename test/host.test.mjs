/**
 * 外壳测试：直接调 `apply(ctx, config)`，不真装插件。
 *
 * 假 `agentTeams` 是普通对象，假 `tools` 记录 `register` 收到的 definition 并返回 disposer。
 * 这里断言的都是**外壳自己的契约**（身份来源、参数封闭、错误不被吞、透传），
 * 板子上长什么样是 `board.mjs` 的事，另有它自己的 79 条测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
/* P3-2：读真预设（`lite@1`）当夹具 —— 手写一份阶段表会和 `presets/*.json` 漂移。 */
import { readFileSync } from 'node:fs';

import { apply, inject, name as pluginName, mapHostTask, ledgerPayload } from '../host/index.js';
/* D-14 的核心断言必须能"喂真实宿主形状 → 映射 → 交给判定层"，
 * 所以这里直接引判定模块与板渲染器（**只读**，不改它们任何东西）。 */
import { evaluateCompletion } from '../src/gates.mjs';
import { renderBoard } from '../src/board.mjs';
/* P2-8：换档的往返必须能被断言 —— 只看"有没有写"不够，还要看写进去的 `by` 能不能读回来。 */
import { ledgerFromTasks, agentRoster } from '../src/ledger.mjs';

/* ------------------------------------------------------------------------- */
/* 夹具                                                                       */
/* ------------------------------------------------------------------------- */

const AGENT = { id: 'session-w7' };
const OTHER_AGENT = { id: 'session-w1' };

/** 三条任务：在跑 / 待开工 / 已完成，全部是宿主 TeamTaskView 的逐字形状。 */
function makeTasks() {
  return [
    {
      id: 'T1',
      revision: 1,
      subject: '登录校验',
      description: '实现登录校验',
      status: 'in_progress',
      blockedBy: [],
      writeScopes: ['src/auth/'],
      ownerName: 'alice',
      ready: true,
      writeScopeWarnings: [],
    },
    {
      id: 'T2',
      revision: 1,
      subject: '写迁移脚本',
      description: '写迁移脚本',
      status: 'pending',
      blockedBy: [],
      writeScopes: [],
      ownerName: 'bob',
      ready: true,
      writeScopeWarnings: [],
    },
    {
      id: 'T3',
      revision: 2,
      subject: '评审接口契约',
      description: '评审接口契约',
      status: 'completed',
      blockedBy: [],
      writeScopes: [],
      ownerName: 'alice',
      ready: true,
      writeScopeWarnings: [],
    },
  ];
}

/** 造 n 条 pending 任务，用来量 maxLines。 */
function makeManyTasks(n) {
  return Array.from({ length: n }, (_, index) => ({
    id: `T${index + 1}`,
    revision: 1,
    subject: `第 ${index + 1} 件活`,
    description: '',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ownerName: 'alice',
    ready: true,
    writeScopeWarnings: [],
  }));
}

function makeTeams({
  memberName = 'alice',
  role = 'lead',
  tasks = [],
  members = [],
  listTasksError,
  listMembersError,
  tryMembershipError,
} = {}) {
  const calls = [];
  const membershipOf = (agent) => ({ root: agent, id: 'team-1', role, name: memberName });
  const teams = {
    membership(agent) {
      calls.push(['membership', agent]);
      return membershipOf(agent);
    },
    tryMembership(agent) {
      calls.push(['tryMembership', agent]);
      if (tryMembershipError !== undefined) throw tryMembershipError;
      return role === 'outsider' ? undefined : membershipOf(agent);
    },
    listTasks(agent) {
      calls.push(['listTasks', agent]);
      if (listTasksError !== undefined) throw listTasksError;
      return tasks;
    },
    listMembers(agent) {
      calls.push(['listMembers', agent]);
      if (listMembersError !== undefined) throw listMembersError;
      return members;
    },
  };
  return { teams, calls };
}

function makeTools() {
  const registrations = [];
  return {
    registrations,
    register(definition, options = {}) {
      const entry = { definition, options, disposeCalls: 0 };
      registrations.push(entry);
      return () => {
        entry.disposeCalls += 1;
      };
    },
  };
}

/**
 * 假 ctx：`effect` 按 cordis 的语义实现 —— 跑 execute、拿到它的 disposer，
 * 返回一个"撤销时调用内层 disposer"的函数，于是 `apply` 的返回值可以被直接断言。
 *
 * 默认**有** agentTeams（`noTeam: true` 才模拟宿主没有这个服务）。
 */
function makeHost({
  noTeam = false,
  memberName = 'alice',
  role = 'lead',
  tasks = [],
  members = [],
  listTasksError,
  listMembersError,
  tryMembershipError,
  /* 第 16 轮 task-19：开关默认改成**关**之后，不测开关的测试必须能显式开启。
   * `enabled` 的三种取值都有含义：
   *   - `undefined`（默认）→ **不注入 storage**，走"宿主没有存储"那条路（开关停在默认值）；
   *   - `true` / `false`         → 注入一份带该记录的 kv，hydrate 之后开关就是它。 */
  enabled,
} = {}) {
  const tools = makeTools();
  /* `makeKv` 在下面才定义，但函数声明提升不适用于 const —— 所以这里用惰性取值：
   * 只有在真的需要 storage 时才调用它。 */
  const kv = enabled === undefined ? undefined : makeKv({ enabled });
  const team = noTeam
    ? { teams: undefined, calls: [] }
    : makeTeams({ memberName, role, tasks, members, listTasksError, listMembersError, tryMembershipError });
  const disposedLabels = [];
  const ctx = {
    tools,
    get(service) {
      if (service === 'agentTeams') return team.teams;
      if (service === 'storage') return kv === undefined ? undefined : kv.storage;
      return undefined;
    },
    effect(execute, label = 'anonymous') {
      const inner = execute();
      return () => {
        disposedLabels.push(label);
        if (typeof inner === 'function') inner();
      };
    },
  };
  return { ctx, tools, team, disposedLabels };
}

/**
 * 装好插件，返回 register 收到的那些定义。
 *
 * 第 10 轮：工具从 1 个变成 2 个（`team_board` + `team_deliver`），所以这里**按名字**取，
 * 不再假设下标。`entry` / `definition` 仍然指向 `team_board`（注册顺序在前），
 * 于是第 5–28 条不用动。
 */
/**
 * 装好插件，返回 register 收到的那些定义。
 *
 * **第 17 轮 task-19/20 起，这个夹具默认把开关"打开"**（存储里预置 `{enabled:true}`），
 * 因此它是 `async` 的：开关只能经 `hydrate()` 读到，而那是推迟到微任务里的。
 *
 * 为什么默认开而不是默认关：产品默认是**关**，但这两个工具绝大多数测试验的是
 * **工具本身的行为**（身份、透传、渲染、判定），那些行为在真实使用中发生在
 * "用户已经把开关打开"之后。用默认关的宿主去测它们，测到的其实是"被拒绝"，
 * 而不是它们声称要验的东西 —— 那就是把测试变成空转。
 *
 * 想测**默认值/开关语义**的，别用这个夹具：用 `createBoardState` 直连状态机，
 * 或用 `makePageHost` + `makeKv()` 造"全新宿主"（见 29 / 87 / 88 / 90 条）。
 */
async function install(options = {}) {
  const host = makeHost({ enabled: true, ...options });
  const disposer = apply(host.ctx, {});
  await flush();
  const board = host.tools.registrations.find((item) => item.definition.name === 'team_board');
  const deliver = host.tools.registrations.find((item) => item.definition.name === 'team_deliver');
  assert.ok(board !== undefined, 'team_board 必须被注册');
  assert.ok(deliver !== undefined, 'team_deliver 必须被注册');
  return { ...host, disposer, entry: board, definition: board.definition, deliverEntry: deliver, deliverDefinition: deliver.definition };
}

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/* ------------------------------------------------------------------------- */
/* ① 注册面                                                                    */
/* ------------------------------------------------------------------------- */

test('1. apply 注册了恰好五个工具，前两个是 team_board / team_deliver（P2-9 两个动作 + P3-2 开会）', async () => {
  const { tools, definition, deliverDefinition } = await install({ tasks: makeTasks() });
  /* 数字沿革：1（只有 team_board）→ 2（第 10 轮加 team_deliver）→ 4（P2-9 加会议两个动作）。
   * 「恰好」这层不变量**不放松**：仍然要求"不多不少、且顺序固定"，不是 >=4。
   * 顺序有含义：前两个是查阅/判定（只读），后两个是**动作**（会改账本）。 */
  assert.equal(tools.registrations.length, 5);
  assert.deepEqual(
    tools.registrations.map((item) => item.definition.name),
    ['team_board', 'team_deliver', 'team_meeting_submit', 'team_meeting_upgrade', 'team_meeting_start'],
  );
  assert.equal(definition.name, 'team_board');
  assert.equal(deliverDefinition.name, 'team_deliver');
  assert.equal(typeof definition.description, 'string');
  assert.ok(definition.description.length > 0);
  assert.equal(typeof deliverDefinition.description, 'string');
  assert.ok(deliverDefinition.description.length > 0);
  /* 新增的两个也必须带非空描述与参数表 —— 描述就是它们进模型提示词的**全部**内容。 */
  for (const item of tools.registrations.slice(2)) {
    assert.equal(typeof item.definition.description, 'string');
    assert.ok(item.definition.description.length > 0, `${item.definition.name} 的描述不许为空`);
    assert.equal(typeof item.definition.parameters, 'object');
    assert.equal(typeof item.definition.output.render, 'function', '必须自带 render，否则工具输出渲染不出来');
  }
});

test('2. apply 返回 disposer，调用它之后 register 收到的 disposer 被调用过', async () => {
  const { disposer, entry, disposedLabels } = await install({ tasks: makeTasks() });
  assert.equal(typeof disposer, 'function');
  assert.equal(entry.disposeCalls, 0);
  disposer();
  assert.equal(entry.disposeCalls, 1, '注销工具的 disposer 必须被调用');
  assert.equal(disposedLabels.length, 1);
});

test('3. apply 期间不取任务、不取成员（注册不做活）', async () => {
  const { team } = await install({ tasks: makeTasks() });
  assert.deepEqual(team.calls, [], '注册阶段不该调用任何 agentTeams 方法');
});

test('4. 模块导出 name / inject / apply，inject 含 tools', () => {
  assert.equal(pluginName, 'team-board');
  assert.equal(typeof apply, 'function');
  assert.ok(inject.includes('tools'), 'inject 必须包含 tools');
});

/* ------------------------------------------------------------------------- */
/* ② 身份：本插件唯一的安全边界                                                */
/* ------------------------------------------------------------------------- */

test('5. me 取自 membership：板上出现 @me，且不出现 @alice', async () => {
  const { definition } = await install({
    tasks: makeTasks(),
    memberName: 'alice',
    members: [{ id: 's1', name: 'alice', role: 'lead', status: 'running', diagnostics: [] }],
  });
  const result = await definition.execute({}, { agent: AGENT });
  assert.match(result.board, /@me/);
  assert.doesNotMatch(result.board, /@alice/, 'alice 自己那一行必须是 @me，不是 @alice');
  assert.equal(result.me, 'alice');
});

test('6. 模型传 me 不生效：参数 {me:"bob"} 不改变归属（本轮最重要的一条）', async () => {
  const { definition } = await install({
    tasks: makeTasks(),
    memberName: 'alice',
    members: [
      { id: 's1', name: 'alice', role: 'lead', status: 'running', diagnostics: [] },
      { id: 's2', name: 'bob', role: 'teammate', status: 'running', diagnostics: [] },
    ],
  });

  const honest = await definition.execute({}, { agent: AGENT });
  const forged = await definition.execute({ me: 'bob' }, { agent: AGENT });

  assert.equal(forged.board, honest.board, '塞 me 之后板必须逐字不变');
  assert.equal(forged.me, 'alice', '返回的 me 仍是宿主解析出来的身份');
  assert.equal(countOf(forged.board, '@me'), 1, '@me 只属于真正的调用者');
  assert.match(forged.board, /@bob/, 'bob 那一行仍然是 @bob，没有被顶成 @me');
  assert.doesNotMatch(forged.board, /@alice/);
});

test('7. 参数 schema 根上 additionalProperties:false，且没有 me/ownerName/assignee', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  const { parameters } = definition;
  assert.equal(parameters.additionalProperties, false, '额外属性必须在 schema 层就失败');
  for (const forbidden of ['me', 'ownerName', 'assignee']) {
    assert.equal(Object.hasOwn(parameters.properties, forbidden), false, `properties 不许出现 ${forbidden}`);
  }
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['includeCompleted', 'maxLines', 'maxSubjectLength']);
});

test('8. 三个参数都是可选整数，且只用 schema 子集内的关键字（原：断言带 range → 新：断言不带 range）', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  const props = definition.parameters.properties;
  /* 原断言：各属性带 minimum/maximum。
   * 新断言：**不许**带 —— 第 8 轮 W7-B：`minimum`/`maximum` 不在 `dsh-tools` 的
   * schema 子集里（`assertSupportedJsonSchema` 只认 type/oneOf/properties/required/
   * additionalProperties/items/enum/const + 注解），切 PTC executor 会被拒。
   * 范围本来由 `board.mjs` 的 `toSafeInt` 夹紧，删掉不丢保证。
   * 这条**没有放松**：从"有 range"变成"必须落在子集内且恰好是这几个键"，更严。 */
  for (const key of ['maxLines', 'includeCompleted', 'maxSubjectLength']) {
    assert.equal(props[key].type, 'integer', `${key} 必须是 integer`);
    assert.equal(typeof props[key].description, 'string');
    assert.equal('minimum' in props[key], false, `${key} 不许带 minimum（schema 子集不支持）`);
    assert.equal('maximum' in props[key], false, `${key} 不许带 maximum（schema 子集不支持）`);
    assert.deepEqual(Object.keys(props[key]).sort(), ['description', 'type'], `${key} 只许有 type + description`);
  }
  assert.equal(Object.hasOwn(definition.parameters, 'required'), false, '三个参数都可选');
});

test('8b. 参数 schema 整棵树都落在 dsh-tools 支持的子集内（不需要引依赖，自查关键字）', async () => {
  const { definition, deliverDefinition } = await install({ tasks: makeTasks() });
  const ALLOWED = new Set([
    'type',
    'oneOf',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'description',
    'title',
    'default',
    'examples',
  ]);
  const walk = (node, path, out) => {
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (!ALLOWED.has(key)) out.push(`${path}.${key}`);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.properties.${key}`, out);
    if (node.items !== undefined) walk(node.items, `${path}.items`, out);
  };
  for (const [name, schema] of [
    ['team_board.parameters', definition.parameters],
    ['team_deliver.parameters', deliverDefinition.parameters],
    ['team_board.output', definition.output.schema],
    ['team_deliver.output', deliverDefinition.output.schema],
  ]) {
    const offenders = [];
    walk(schema, name, offenders);
    assert.deepEqual(offenders, [], `${name} 出现了子集外的关键字`);
  }
});

test('9. execute 里 me 只可能来自 membership：把 membership 换成另一个名字，板跟着变', async () => {
  const asAlice = await install({ tasks: makeTasks(), memberName: 'alice' });
  const asBob = await install({ tasks: makeTasks(), memberName: 'bob' });
  const a = await asAlice.definition.execute({}, { agent: AGENT });
  const b = await asBob.definition.execute({}, { agent: AGENT });
  assert.equal(a.me, 'alice');
  assert.equal(b.me, 'bob');
  assert.notEqual(a.board, b.board, '身份不同，@me 落在不同行');
});

/* ------------------------------------------------------------------------- */
/* ③ 可见性                                                                    */
/* ------------------------------------------------------------------------- */

test('10. when：非 Team 成员（tryMembership 返回 undefined）为 false', async () => {
  const { entry } = await install({ tasks: makeTasks(), role: 'outsider' });
  const when = entry.options.when;
  assert.equal(typeof when, 'function');
  assert.equal(when({ agent: OTHER_AGENT }), false);
});

test('11. when：Team 成员为 true（本测试与开关无关，显式开启）', async () => {
  /* 第 16 轮 task-19：开关默认改成**关**。这条测的是**成员资格**，不是开关，
   * 所以必须显式开启 —— 否则它其实在测"默认关"，而它声称要测的那件事根本没跑到。
   * 开启的唯一通路是"存储里有 {enabled:true} 的记录"，与真实用户点开开关同一条路。 */
  const { entry } = await install({ tasks: makeTasks(), role: 'teammate', enabled: true });
  await flush(); // hydrate 是推迟到微任务的，等它把记录读回来
  assert.equal(entry.options.when({ agent: OTHER_AGENT }), true);
});

test('12. 宿主没有 Agent Teams 时：工具仍注册、when 为 true、调用报 E_HOST_UNSUPPORTED', async () => {
  /* 本条测"没有服务时工具仍要出现，否则连诊断都拿不到"——与开关无关，显式开启。 */
  const { entry, definition } = await install({ noTeam: true, enabled: true });
  await flush();
  assert.equal(entry.options.when({ agent: AGENT }), true, '没有服务时工具要出现，否则连诊断都拿不到');
  await assert.rejects(
    () => definition.execute({}, { agent: AGENT }),
    (error) => {
      assert.equal(error.code, 'E_HOST_UNSUPPORTED');
      assert.equal(error.capability, 'agentTeams');
      return true;
    },
  );
});

/* ------------------------------------------------------------------------- */
/* ④ 数据通路                                                                  */
/* ------------------------------------------------------------------------- */

test('13. execute 真的把 listTasks 的结果喂给了 renderBoard：在跑的标题在，已完成默认不在', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  const { board, taskCount } = await definition.execute({}, { agent: AGENT });
  assert.match(board, /登录校验/, '在跑那条的标题必须在板上');
  assert.match(board, /写迁移脚本/, '待开工那条的标题必须在板上');
  assert.doesNotMatch(board, /评审接口契约/, '默认不显示已完成（它会淹掉在跑的）');
  assert.equal(taskCount, 3);
});

test('14. includeCompleted:1 时已完成那条出现', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  const { board } = await definition.execute({ includeCompleted: 1 }, { agent: AGENT });
  assert.match(board, /评审接口契约/);
  assert.match(board, /登录校验/);
});

test('15. maxLines 透传：10 条任务、maxLines:3 → 只留 2 行 + 一句省略', async () => {
  const { definition } = await install({ tasks: makeManyTasks(10) });
  const { board } = await definition.execute({ maxLines: 3 }, { agent: AGENT });
  const lines = board.split('\n');
  assert.equal(lines.length, 4, '标题 1 行 + 正文 2 行 + 省略 1 行');
  assert.match(board, /…还有 8 条/);
  assert.doesNotMatch(board, /第 10 件活/);
});

test('16. maxSubjectLength 透传：标题按显示宽度截断', async () => {
  const tasks = [
    {
      id: 'T1',
      revision: 1,
      subject: '这是一个非常非常长的任务标题用来验证截断是否真的透传到了渲染层',
      description: '',
      status: 'pending',
      blockedBy: [],
      writeScopes: [],
      ownerName: 'alice',
      ready: true,
      writeScopeWarnings: [],
    },
  ];
  const { definition } = await install({ tasks });
  const { board } = await definition.execute({ maxSubjectLength: 8 }, { agent: AGENT });
  assert.match(board, /…/, '超宽标题必须被截断并带省略号');
  assert.doesNotMatch(board, /验证截断是否真的透传/);
});

test('17. 空的 agentTeams 调用顺序是 membership → listTasks → listMembers，且都用 exec.agent', async () => {
  const { definition, team } = await install({ tasks: makeTasks() });
  await definition.execute({}, { agent: AGENT });
  const ordered = team.calls.filter(([method]) => method !== 'tryMembership').map(([method]) => method);
  assert.deepEqual(ordered, ['membership', 'listTasks', 'listMembers']);
  for (const [, agent] of team.calls) assert.equal(agent, AGENT, '每个调用都必须用 exec.agent');
});

test('18. 两次调用各取一次任务：外壳不缓存宿主数据', async () => {
  const { definition, team } = await install({ tasks: makeTasks() });
  await definition.execute({}, { agent: AGENT });
  await definition.execute({}, { agent: AGENT });
  const listTaskCalls = team.calls.filter(([method]) => method === 'listTasks').length;
  assert.equal(listTaskCalls, 2);
});

/* ------------------------------------------------------------------------- */
/* ⑤ 失败必须看得见                                                            */
/* ------------------------------------------------------------------------- */

test('19. listTasks 抛错不被吞：错误冒到调用方', async () => {
  const boom = new Error('宿主任务板读不出来');
  const { definition } = await install({ tasks: [], listTasksError: boom });
  await assert.rejects(() => definition.execute({}, { agent: AGENT }), /宿主任务板读不出来/);
});

test('20. listMembers 抛错也不被吞', async () => {
  const boom = new Error('成员名单读不出来');
  const { definition } = await install({ tasks: makeTasks(), listMembersError: boom });
  await assert.rejects(() => definition.execute({}, { agent: AGENT }), /成员名单读不出来/);
});

test('21. 没有 exec.agent 时明确报错，而不是拿别人的身份凑一块板', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  await assert.rejects(() => definition.execute({}, {}), /需要调用方的 Agent 身份/);
});

/* ------------------------------------------------------------------------- */
/* ⑥ render / 返回形状 / 空态                                                  */
/* ------------------------------------------------------------------------- */

test('22. render 返回合法 ContentBlock[]，非空', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  const value = await definition.execute({}, { agent: AGENT });
  const blocks = definition.output.render({}, value);
  assert.ok(Array.isArray(blocks));
  assert.ok(blocks.length > 0);
  for (const block of blocks) {
    assert.equal(block.type, 'text');
    assert.equal(typeof block.text, 'string');
    assert.ok(block.text.length > 0);
  }
});

test('23. render 把 execute 的 board 逐字放进文本块', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  const value = await definition.execute({}, { agent: AGENT });
  const blocks = definition.output.render({}, value);
  assert.equal(blocks[0].text, value.board);
});

test('24. render 遇到畸形 value 也不抛（回放里可能有旧形状）', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  for (const value of [undefined, null, {}, { board: '' }, '不是对象', 42]) {
    const blocks = definition.output.render({}, value);
    assert.ok(Array.isArray(blocks) && blocks.length > 0);
    assert.equal(blocks[0].type, 'text');
    assert.ok(blocks[0].text.length > 0);
  }
});

test('25. 空团队有明确空态文案，不是空字符串', async () => {
  const { definition } = await install({ tasks: [], members: [], memberName: 'alice' });
  const { board, taskCount } = await definition.execute({}, { agent: AGENT });
  assert.equal(typeof board, 'string');
  assert.ok(board.trim().length > 0);
  assert.match(board, /0 个任务/);
  assert.equal(taskCount, 0);
});

test('26. 返回值形状符合 output.schema（additionalProperties:false，五个键齐全）', async () => {
  const { definition } = await install({ tasks: makeTasks(), members: [{ id: 's1', name: 'alice', role: 'lead', status: 'running', diagnostics: [] }] });
  const value = await definition.execute({}, { agent: AGENT });
  /* 原断言：四个键 `board/me/taskCount/memberCount`。
   * 第 14 轮之后多一个 `tasks`（结构化任务行，页面任务板在等它，见第 83–88 条）。
   * 这**不是放松**：仍然逐字钉住键集合，只是集合本身多了一个成员 ——
   * 而且 `additionalProperties: false` + 下面 `properties` 的逐字断言仍然要求
   * "返回里出现的每个键都必须在 schema 里声明过"，所以多出来的键不会蒙混过关。 */
  assert.deepEqual(Object.keys(value).sort(), ['board', 'me', 'memberCount', 'taskCount', 'tasks']);
  assert.equal(typeof value.board, 'string');
  assert.equal(typeof value.me, 'string');
  assert.equal(Number.isInteger(value.taskCount), true);
  assert.equal(Number.isInteger(value.memberCount), true);
  assert.equal(Array.isArray(value.tasks), true);
  assert.deepEqual(
    Object.keys(definition.output.schema.properties).sort(),
    ['board', 'me', 'memberCount', 'taskCount', 'tasks'],
  );
  assert.equal(definition.output.schema.additionalProperties, false);
  /* `required` **仍然是四个**，`tasks` 有意不进 required：
   * 宿主读不出来（`listTasks` 给非数组）或走委派花名册那条路时**不带这个键**，
   * 因为 `tasks: []` 会被页面读成「读到了，就是零条」。见第 88 条。 */
  assert.deepEqual([...definition.output.schema.required].sort(), ['board', 'me', 'memberCount', 'taskCount']);
});

/* ------------------------------------------------------------------------- */
/* ⑦ 参数宽容：脏参数不许把板搞崩                                              */
/* ------------------------------------------------------------------------- */

test('27. 畸形参数不崩：null / 字符串 / 数组都退回默认渲染', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  for (const args of [null, 'whatever', [], 42]) {
    const { board } = await definition.execute(args, { agent: AGENT });
    assert.match(board, /团队板/);
  }
});

test('28. 非整数参数被忽略（不变成 NaN 行数）', async () => {
  const { definition } = await install({ tasks: makeManyTasks(10) });
  const { board } = await definition.execute({ maxLines: '3', includeCompleted: -5, maxSubjectLength: null }, { agent: AGENT });
  const lines = board.split('\n');
  assert.equal(lines.length, 11, '10 条任务 + 标题：脏参数一律当没给，走默认 24');
  assert.doesNotMatch(board, /NaN/);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 第 9 轮（W8）追加：开关 / 持久化 / 数据源 / 台账 / 页面路由
 *
 * 这一批只断言**外壳自己的契约**：开关唯一可断言的效果是 `when` 的返回值；
 * 台账的五个数字是 `roleStats` 的事（它自己有一整套测试），这里只断言
 * "读回来了、三态分得清、失败不抛"。
 * ═══════════════════════════════════════════════════════════════════════════ */

import { createBoardState, dataSourceOf, registerStateRoute } from '../host/index.js';

const STATE_PATH = '/api/team-board/state';

/**
 * **打开开关**再返回同一个 state。
 *
 * ## 为什么需要它
 * 默认关闭是产品语义（新装即关）。P3-14 之后，"关掉"意味着**完全不参与** ——
 * `snapshot()` / `gates()` / `readLedger()` / `roster()` 一处都不读，于是
 * 所有**要测"读"**的用例都必须先"把开关打开"。这不是为了让测试变绿，
 * 而是这些用例的被测前提本来就包含"用户已经打开了它"。
 *
 * ## 为什么不用 `await`
 * `setEnabled()` 的实现是**先改内存再落盘**（注释写在 `host/index.js:448`），
 * 所以调用返回之前 `enabled` 已经是 `true`。这里不需要 await，也就不用把
 * 每一条用例的整条 `await` 链重排。
 *
 * ## 为什么吞掉 persist 的异常
 * 有些用例的 storage 是**故意坏的**（`failPut` / 没有 storage）——它们测的是
 * "存储坏了插件也要活着"。若这里把 persist 的拒绝放出去，会在那些用例里
 * 变成未处理的 rejection，测的就不是它们原本要测的东西了。
 */
function onSwitch(state) {
  const pending = state.setEnabled(true);
  if (pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {});
  return state;
}

/**
 * 假 storage 的 kv 形态。
 *
 * 契约（host/Service/storage）只给出 `form()` + `KvFacet.open()` + `KvUnit.loadAll/putRecord`，
 * 所以夹具就照这三层搭，并且**每一种失败都能单独注入**（开关最怕"存储坏了就起不来"）。
 */
function makeKv({ enabled, tables, failLoad = false, failOpen = false, failPut = false } = {}) {
  const counts = { form: 0, open: 0, loadAll: 0, putRecord: 0 };
  const store = tables ?? { state: {}, ledger: {} };
  if (enabled !== undefined) store.state.enabled = { enabled };
  const unit = {
    async loadAll() {
      counts.loadAll += 1;
      if (failLoad) throw new Error('loadAll 失败');
      return { tables: store, global: null };
    },
    async putRecord(table, key, value) {
      counts.putRecord += 1;
      if (failPut) throw new Error('putRecord 失败');
      if (store[table] === undefined) store[table] = {};
      store[table][key] = value;
    },
  };
  const storage = {
    form() {
      counts.form += 1;
      if (failOpen) throw new Error('没有 kv 形态');
      return {
        async open() {
          counts.open += 1;
          return unit;
        },
      };
    },
  };
  return { storage, store, counts };
}

/** 只带 `get` 的最小 ctx（状态机要的就是这个）。 */
function makeServiceCtx(services = {}) {
  return {
    get(key) {
      return services[key];
    },
  };
}

/** 假的 `connection`：只记路由，不碰 HTTP。 */
function makeConnection() {
  const routes = [];
  return {
    routes,
    fetch: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
}

/** apply 级的宿主：真注册表 + 真 effect 语义 + 可选 connection。 */
function makePageHost({ kv, teams, subagents, connection, agents } = {}) {
  const registrations = [];
  const routes = connection === undefined ? undefined : connection;
  const ctx = {
    tools: {
      register(definition, options = {}) {
        registrations.push({ definition, options });
        return () => {};
      },
    },
    effect(execute) {
      const inner = execute();
      return () => {
        if (typeof inner === 'function') inner();
      };
    },
    inject(_deps, callback) {
      const inner = callback(ctx);
      return typeof inner === 'function' ? inner : () => {};
    },
    get(key) {
      if (key === 'storage') return kv === undefined ? undefined : kv.storage;
      if (key === 'agentTeams') return teams;
      if (key === 'subagents') return subagents;
      if (key === 'connection') return routes;
      if (key === 'agents') return agents;
      return undefined;
    },
  };
  return { ctx, registrations };
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/* ------------------------------------------------------------------------- */
/* 29–33. 开关：默认开 / 关掉后 when 为 false / 持久化 / 重启读回 / 坏存储不抛      */
/* ------------------------------------------------------------------------- */

test('29. 开关**默认关**：没有存储记录时 when 为 false（真成员也看不见，两个工具都不可见）', async () => {
  /* ═══ 原断言与它为什么错（第 16 轮 task-19，用户直接要求）═══════════════════
   *
   * 原标题：「29. 开关默认开：没有存储记录时 when 仍按 Team 成员判（真成员 → true）」
   *
   * 它把"默认开"写成了期望值。而用户对这个开关的定义是
   * 「**我不让你用这个，它就不会去用**」——默认开让这句话变成空话：
   * "我没主动让它用"与"它已经在用"同时成立，开关就没表达任何东西。
   * 更严重的是这个插件会往模型提示里加两个工具、影响模型每一步的行为：
   * **一个默认就生效的插件，等于没经用户同意就占据了他的工具面。**
   *
   * 所以现在：全新宿主（存储里没有任何记录）→ 默认**关** → 两个工具都不可见。
   * 下面同时断言两个工具，因为"只关一个"正是 task-6 修掉的那个形状。
   * ═══════════════════════════════════════════════════════════════════════════ */
  const kv = makeKv();
  const { teams } = makeTeams({ role: 'teammate', tasks: makeTasks() });
  const host = makePageHost({ kv, teams });
  apply(host.ctx, {});
  await flush();

  assert.equal(host.registrations.length, 5, '注册了且没有多余的重复注册');
  assert.equal(host.registrations[0].definition.name, 'team_board');

  const board = host.registrations[0];
  const deliver = host.registrations[1];
  assert.equal(host.registrations[0].options.when({ agent: AGENT }), false, '默认关：**真成员**也看不见板');
  assert.equal(deliver.options.when({ agent: AGENT }), false, '默认关：裁决同样不可见（默认关 = 两个都不可见）');
  /* P2-9：两个**动作**工具更不能默认生效 —— 它们会改账本。 */
  assert.equal(host.registrations[2].options.when({ agent: AGENT }), false, '默认关：会议提交也不可见');
  assert.equal(host.registrations[3].options.when({ agent: AGENT }), false, '默认关：换档同样不可见');
  assert.equal(host.registrations[4].options.when({ agent: AGENT }), false, '默认关：开会更不可见（它会建任务、派活、写账本）');

  /* 反向自检：显式开启之后必须变 true，否则上面两条会被"when 永远 false"满足。 */
  const onKv = makeKv({ enabled: true });
  const onHost = makePageHost({ kv: onKv, teams });
  apply(onHost.ctx, {});
  await flush();
  assert.equal(onHost.registrations[0].options.when({ agent: AGENT }), true, '存储里 {enabled:true} → 板可见');
  assert.equal(onHost.registrations[1].options.when({ agent: AGENT }), true, '存储里 {enabled:true} → 裁决可用');
});

test('30. 关掉之后 when 返回 false —— 这是开关唯一可断言的效果（先显式开启再关）', async () => {
  /* 本条测的是**切换**（开 → 关），所以必须从"开"出发。
   * 默认值翻转之后不能再依赖默认值把开关放在"开"，得显式开启。 */
  const kv = makeKv({ enabled: true });
  const { teams } = makeTeams({ role: 'lead', tasks: makeTasks() });
  const connection = makeConnection();
  const host = makePageHost({ kv, teams, connection });
  apply(host.ctx, {});
  await flush();
  const when = host.registrations[0].options.when;
  assert.equal(when({ agent: AGENT }), true, '显式开启后可见（起点必须是"开"，否则测不到"关"）');

  const route = connection.routes.find((entry) => entry.path === STATE_PATH);
  assert.ok(route !== undefined, '页面数据路由必须挂上');
  const response = await route.fetch({ json: async () => ({ enabled: false }) });

  assert.equal(when({ agent: AGENT }), false, '关掉后模型根本看不见这个工具');
  assert.equal(when({ agent: OTHER_AGENT }), false, '对别的 Agent 也一样看不见');
});

test('31. setEnabled(false) 后 getState().enabled === false，且持久化恰好被调用一次', async () => {
  /* 测的是 true → false 的切换与落盘，起点必须先显式开启。 */
  const kv = makeKv({ enabled: true });
  const state = createBoardState(makeServiceCtx({ storage: kv.storage }));
  await state.hydrate();
  assert.equal(state.getState().enabled, true, '起点：存储里的 {enabled:true} 已读回');

  const next = await state.setEnabled(false);
  assert.equal(next.enabled, false);
  assert.equal(state.getState().enabled, false);
  assert.equal(kv.counts.putRecord, 1, '落盘恰好一次');
  assert.equal(kv.store.state.enabled.enabled, false, '落的是 { enabled:false }');
  assert.equal(state.stats().persistCalls, 1);
});

test('32. 重启模拟：新建一份状态机（重新 apply）读回上次的**开**', async () => {
  /* 第 16 轮 task-19：这一条原来存的是 `false` 并断言"读回 false"。
   * 默认值翻成 `false` 之后，那个形状**再也证明不了 hydrate 真的读了** ——
   * "读回 false" 与 "什么都没读、停在默认值" 结果完全相同。
   * 所以改成存**与默认相反的值**（`true`）：读到 true 只能是读来的。 */
  const kv = makeKv({ enabled: true });
  const first = createBoardState(makeServiceCtx({ storage: kv.storage }));
  await first.hydrate();
  assert.equal(first.getState().enabled, true, '起点：从磁盘读到 true');

  const second = createBoardState(makeServiceCtx({ storage: kv.storage }));
  assert.equal(second.getState().enabled, false, 'hydrate 之前是默认值（现在默认是**关**）');
  await second.hydrate();
  assert.equal(second.getState().enabled, true, '重新 apply 必须读回上次的状态（true 只可能是读来的）');

  /* 反例自检：磁盘上真的没有记录时，hydrate 之后**仍然是默认的 false**。
   * 没有这条，上面那条会被"hydrate 总是把开关设成 true"满足。 */
  const empty = createBoardState(makeServiceCtx({ storage: makeKv().storage }));
  await empty.hydrate();
  assert.equal(empty.getState().enabled, false, '没有记录 → 保持默认关');
});

test('33. 存储读失败 → 默认**关**且不抛（配置坏了不该让插件起不来，也不该偷偷生效）', async () => {
  /* 原断言是「读失败必须保持默认开」。默认值翻成关之后，正确结论是：
   * 读不出来 = 不知道用户想不想开 = **按默认（关）**，即 fail-closed。
   * 这与"配置坏了不该让插件起不来"并不冲突：不抛错这一点没变，变的只是读不到时算开还是关。 */
  for (const kv of [makeKv({ failLoad: true }), makeKv({ failOpen: true }), makeKv({ failPut: true })]) {
    const state = createBoardState(makeServiceCtx({ storage: kv.storage }));
    await assert.doesNotReject(() => state.hydrate(), '读失败绝不许让插件起不来');
    assert.equal(state.getState().enabled, false, '读失败 → 保持默认关（拿不准就别生效）');
    await assert.doesNotReject(() => state.setEnabled(false));
    assert.equal(state.getState().enabled, false, '落盘失败不回滚：用户点了关闭就该关');
  }

  // 连 storage 服务都没有：同样的结论。
  const bare = createBoardState(makeServiceCtx({}));
  await assert.doesNotReject(() => bare.hydrate());
  assert.equal(bare.getState().enabled, false, '没有存储服务 → 默认关');
  await assert.doesNotReject(() => bare.setEnabled(false));
  assert.equal(bare.getState().enabled, false);

  /* 反向自检：用户**主动开过**（存储里有 true），读失败也不许把已读到的值改掉。
   * 这条守的是"默认值只在用户没表态时说话"。 */
  const kept = createBoardState(makeServiceCtx({ storage: makeKv({ enabled: true }).storage }));
  await kept.hydrate();
  assert.equal(kept.getState().enabled, true);
  await kept.hydrate();
  assert.equal(kept.getState().enabled, true, '已读到 true 之后，再读一次不许被默认值翻回关');
});

/* ------------------------------------------------------------------------- */
/* 34. 数据源判定：有 agentTeams / 只有 subagents / 都没有                        */
/* ------------------------------------------------------------------------- */

test('34a. 有 agentTeams → agentTeams（Agent Teams 任务板）', () => {
  const { teams } = makeTeams({ tasks: makeTasks() });
  assert.equal(dataSourceOf(makeServiceCtx({ agentTeams: teams, subagents: {} })), 'agentTeams');
});

test('34b. 只有 subagents → roster（委派花名册）', () => {
  assert.equal(dataSourceOf(makeServiceCtx({ subagents: { listDescendants: async () => [] } })), 'roster');
});

test('34c. 都没有 → unavailable（与空板可区分）', () => {
  assert.equal(dataSourceOf(makeServiceCtx({})), 'unavailable');
  assert.equal(dataSourceOf(null), 'unavailable');
  assert.equal(dataSourceOf(undefined), 'unavailable');
});

test('34d. 快照里的数据源标识随宿主能力变化，且不可用时不带任何计数', async () => {
  const kv = makeKv();
  const bare = onSwitch(createBoardState(makeServiceCtx({ storage: kv.storage })));
  const snapshot = await bare.snapshot({});
  assert.deepEqual(snapshot.dataSource, { kind: 'unavailable' });
  assert.equal('total' in snapshot.dataSource, false, '不可用不许伪造 0 个');
  assert.equal(snapshot.roleLedger.status, 'empty', 'storage 能用但没有记录 → empty（不是 unavailable）');
  assert.equal(snapshot.gates.status, 'unavailable');
  assert.equal(snapshot.gates.reason, 'agentTeams');
});

/* ------------------------------------------------------------------------- */
/* 35. 台账：三态 + 五个数字来自 roleStats + 写回可读                            */
/* ------------------------------------------------------------------------- */

test('35a. 没有台账文档 → empty（不是 unavailable）', async () => {
  const kv = makeKv();
  const state = onSwitch(createBoardState(makeServiceCtx({ storage: kv.storage })));
  const ledger = await state.readLedger();
  assert.equal(ledger.status, 'empty');
  assert.deepEqual(ledger.roles, []);
});

test('35b. storage 打不开 → unavailable（与 empty 可区分）', async () => {
  const state = onSwitch(createBoardState(makeServiceCtx({ storage: makeKv({ failOpen: true }).storage })));
  const ledger = await state.readLedger();
  assert.equal(ledger.status, 'unavailable');
  assert.equal(ledger.roles.length, 0);
});

test('35c. 有记录 → ok，且五个数字就是 roleStats 的产物', async () => {
  const kv = makeKv({
    tables: {
      state: {},
      ledger: {
        'role:w3': {
          id: 'w3',
          pitfalls: '改一半没跑测试',
          history: [
            { outcome: 'completed', produced: ['a'] },
            { outcome: 'completed', produced: ['b'] },
            { outcome: 'failed', produced: [] },
            { outcome: 'aborted', produced: [] },
            { outcome: 'aborted', produced: ['c'] },
          ],
        },
      },
    },
  });
  const state = onSwitch(createBoardState(makeServiceCtx({ storage: kv.storage })));
  const ledger = await state.readLedger();
  assert.equal(ledger.status, 'ok');
  assert.deepEqual(ledger.roles[0].stats, {
    completed: 2,
    abortedWithOutput: 1,
    abortedWithoutOutput: 1,
    failed: 1,
    failedWithoutOutput: 1,
  });
  assert.equal(ledger.roles[0].pitfalls, '改一半没跑测试');
});

test('35d. writeLedger 写回的记录能被 readLedger 读回（台账闭环）', async () => {
  const kv = makeKv();
  const state = onSwitch(createBoardState(makeServiceCtx({ storage: kv.storage })));
  const ok = await state.writeLedger([{ id: 'w7', history: [{ outcome: 'failed', produced: [] }], pitfalls: '没跑测试' }]);
  assert.equal(ok, true);
  const ledger = await state.readLedger();
  assert.equal(ledger.status, 'ok');
  assert.equal(ledger.roles[0].id, 'w7');
  assert.equal(ledger.roles[0].stats.failed, 1);
  assert.equal(ledger.roles[0].stats.failedWithoutOutput, 1);
});

/* ------------------------------------------------------------------------- */
/* 36. 页面路由：路径 / 方法 / 信封 / 一次读一次写                               */
/* ------------------------------------------------------------------------- */

test('36a. 路由形状：POST + buffered + 固定路径', async () => {
  const kv = makeKv();
  const connection = makeConnection();
  const host = makePageHost({ kv, connection });
  apply(host.ctx, {});
  const route = connection.routes[0];
  assert.equal(route.path, STATE_PATH);
  assert.deepEqual(route.methods, ['POST']);
  assert.equal(route.requestBody, 'buffered');
  assert.equal(typeof route.fetch, 'function');
});

test('36b. 信封：成功 { ok:true, value }，value 里有开关/数据源/台账/门禁四块', async () => {
  const kv = makeKv();
  const connection = makeConnection();
  const host = makePageHost({ kv, connection });
  apply(host.ctx, {});
  const response = await connection.routes[0].fetch({
    json: async () => {
      throw new Error('body 不是 JSON');
    },
  });
  const envelope = await response.json();
  assert.equal(envelope.ok, true, 'body 坏了也要给一个有意义的快照，而不是 500');

  /* ── 默认关（全新宿主）：只有两格，**不问宿主任何事** ────────────────────
   * P3-14 之后"关掉 = 完全不参与"：不读、不算。所以这一档的核心断言不是
   * "值对不对"，而是"**派生块根本没有出现**" —— 用 `hasOwn` 而不是 `=== undefined`
   * （后者会被"显式赋 undefined"满足，那这条断言就没有牙了）。 */
  const offKeys = Object.keys(envelope.value).sort();
  assert.deepEqual(offKeys, ['enabled', 'gates'], `关掉时只该有 enabled 与 gates 两格，实际 ${JSON.stringify(offKeys)}`);
  assert.equal(envelope.value.enabled, false, '全新宿主：payload 的 enabled 必须是 false（与默认关一致）');
  assert.equal(envelope.value.gates.status, 'disabled', '第五态是 disabled —— 不是 unavailable（那是"它坏了"）');
  assert.equal(Object.hasOwn(envelope.value, 'dataSource'), false, '关掉时不许带 dataSource（带了就是在读宿主）');
  assert.equal(Object.hasOwn(envelope.value, 'roleLedger'), false, '关掉时不许带角色台账（带了就是读了 storage）');
  for (const key of ['blockers', 'warnings', 'shadow', 'ledger']) {
    assert.equal(
      Object.hasOwn(envelope.value.gates, key),
      false,
      `关掉时 gates.${key} 必须**缺席**（空数组会被读成"核过了，一条都没有"）`,
    );
  }

  /* ── 打开（存储里有 {enabled:true}）：四块齐全 ──────────────────────────
   * 没有这一段，上面那些"缺席"会被"什么都不产出"满足 —— 那就变成
   * "关掉时是对的、开着时也什么都不给"，而后者是坏掉。 */
  const onKv = makeKv({ enabled: true });
  const onConnection = makeConnection();
  const onHost = makePageHost({ kv: onKv, connection: onConnection });
  apply(onHost.ctx, {});
  await flush();
  const onEnvelope = await (await onConnection.routes[0].fetch({ json: async () => ({}) })).json();
  assert.equal(onEnvelope.value.enabled, true, 'payload 的 enabled 必须跟着真实状态走');
  const onKeys = Object.keys(onEnvelope.value).sort();
  /* P3-9：顶层那块叫 `roleLedger`（角色台账），仍然是**四块**，只是名字不再与 `gates.ledger` 重名。 */
  assert.deepEqual(onKeys, ['dataSource', 'enabled', 'gates', 'roleLedger'], `打开时四块齐全，实际 ${JSON.stringify(onKeys)}`);
});

test('36c. POST { enabled } 直接改开关（页面顶栏那颗开关走的就是这条路）', async () => {
  const kv = makeKv();
  const connection = makeConnection();
  const { teams } = makeTeams({ role: 'teammate', tasks: makeTasks() });
  const host = makePageHost({ kv, teams, connection });
  apply(host.ctx, {});
  const route = connection.routes[0];

  const off = await (await route.fetch({ json: async () => ({ enabled: false }) })).json();
  assert.equal(off.value.enabled, false);
  assert.equal(kv.store.state.enabled.enabled, false);

  const on = await (await route.fetch({ json: async () => ({ enabled: true }) })).json();
  assert.equal(on.value.enabled, true);
  assert.equal(kv.store.state.enabled.enabled, true);
});

test('36d. 没有 connection 时 apply 不抛，工具照注册（页面数据通道是可选能力）', () => {
  const kv = makeKv();
  const { teams } = makeTeams({ tasks: makeTasks() });
  const host = makePageHost({ kv, teams });
  assert.doesNotThrow(() => apply(host.ctx, {}));
  /* 原 `=== 1` → `=== 2`（第 10 轮加 team_deliver）→ `=== 4`（P2-9 加会议两个动作）。 */
  assert.equal(host.registrations.length, 5);
  assert.equal(typeof host.registrations[0].options.when, 'function');
});

test('36e. 没有 connection 时 registerStateRoute 返回 undefined（不是错误）', () => {
  const state = createBoardState(makeServiceCtx({}));
  assert.equal(registerStateRoute(makeServiceCtx({}), state), undefined);
  assert.equal(registerStateRoute({ get: () => ({}) }, state), undefined);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 第 10 轮（W7）：`team_deliver` —— 交付判定的唯一出口
 *
 * 这一批断言的是**外壳自己的契约**（双源、来源标注、不吞错、排版）；
 * "能不能收活"的判据全在 delivery.mjs（137 条测试），这里绝不重算。
 *
 * ⚠ 与派工书 §四.1 的差异（已在报告 §5 写明）：
 *   `canDeliver` 除了任务，还要求 `team.delivered` 是**宿主签发**的记录
 *   （`by` 以 "host:" 开头 + `call_id` + `evidence_digest`，见 delivery.mjs:683-700）。
 *   宿主 TeamService 契约里没有这个字段，**插件层也不许伪造**（那正是模块防的后门）。
 *   所以"可以交付"在真实宿主路径上不可达，最诚实的结论就是带着
 *   `E_NEEDS_HUMAN_DELIVERY` 的"不可交付"。第 1 条按**真实行为**断言，不按想象断言。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 造一批 delivery 形态的任务（宿主 TeamTaskView 里没有 kind/contract，这里补上）。 */
function makeDeliverTasks() {
  return [
    { id: 'T1', kind: 'work', status: 'completed', assignee: 'alice', changedPaths: [] },
    { id: 'T2', kind: 'work', status: 'completed', assignee: 'bob', changedPaths: [] },
    { id: 'T3', kind: 'work', status: 'completed', assignee: 'alice', changedPaths: [] },
  ];
}

/**
 * 装好插件并拿到 `team_deliver`，**显式把开关打开**。
 *
 * 第 17 轮 task-19/20：默认值改成"关"、且 `execute` 里补了第二道门之后，
 * 任何**不测开关**的测试都必须显式开启 —— 否则它拿到的是"被拒绝"，而不是
 * 它声称要验的判定结果。这一组（37–48、67–69）验的全是**判定逻辑**
 * （`canDeliver` 的结果、报告版式、审计接线），与开关无关。
 *
 * 为什么是 async：开启走的是**唯一真实通路**（存储里有 `{enabled:true}` 的记录），
 * 而 `hydrate()` 是推迟到微任务的，所以必须等它读完再返回。
 * 不给实现加测试缝（那会为了测试方便削弱实现），也不改默认值（那正是被测的东西）。
 */
const deliverOf = async (options = {}) => {
  const installed = await install({ enabled: true, ...options });
  await flush();
  return { ...installed, deliver: installed.deliverDefinition };
};

test('37. 有 agentTeams：第二行必须是「宿主任务板」，第一行必须是结论', async () => {
  const { deliver } = await deliverOf({ tasks: makeDeliverTasks() });
  const value = await deliver.execute({}, { agent: AGENT });
  const lines = value.report.split('\n');
  assert.match(lines[0], /^交付判定：/, '第一行必须是结论');
  assert.match(lines[1], /^数据来源：宿主任务板（3 条任务/, '第二行必须是数据来源');
  assert.match(value.report, /E_NEEDS_HUMAN_DELIVERY/, '缺宿主签发的交付记录必须如实报出来');
  assert.equal(value.ok, false);
  assert.ok(value.blockerCount >= 1);
});

test('38. 有 agentTeams 且存在自审对 → 不可交付，含 E_SELF_REVIEW 与被点名任务 id', async () => {
  const tasks = [
    {
      id: 'R1',
      kind: 'review',
      status: 'completed',
      assignee: 'alice',
      contract: { reviewedTaskId: 'I1', inScope: ['src/a.mjs'], outOfScope: [], acceptance: ['通过'], verify: ['node --test'] },
      reviewed: { verdict: 'pass', artifacts: [] },
    },
    {
      id: 'I1',
      kind: 'implementation',
      status: 'completed',
      assignee: 'alice',
      changedPaths: [],
      contract: { inScope: ['src/a.mjs'], outOfScope: [], acceptance: ['通过'], verify: ['node --test'] },
      reviewed: { verdict: 'pass' },
    },
  ];
  const { deliver } = await deliverOf({ tasks });
  const value = await deliver.execute({}, { agent: AGENT });
  assert.match(value.report.split('\n')[0], /不可交付/);
  assert.match(value.report, /E_SELF_REVIEW/);
  assert.match(value.report, /\[R1\]/, '被点名的任务 id 必须在独立列里，不许被正文截断吃掉');
});

test('39. 无 agentTeams + 调用方传 tasks → 第二行必须同时含「调用方声明」和「未经宿主核对」（本轮最重要）', async () => {
  const { deliver } = await deliverOf({ noTeam: true });
  const value = await deliver.execute({ tasks: makeDeliverTasks() }, { agent: AGENT });
  const sourceLine = value.report.split('\n')[1];
  assert.match(sourceLine, /^数据来源：调用方声明/);
  assert.match(sourceLine, /调用方声明/);
  assert.match(sourceLine, /未经宿主核对/, '人工声明的数据必须自曝可信度，否则没人能判断它是真数据还是降级产物');
  assert.doesNotMatch(sourceLine, /宿主任务板/);
  assert.match(sourceLine, /3 条任务/);
});

test('40. 无 agentTeams + 不传 tasks → E_HOST_UNSUPPORTED，绝不给「可以交付」', async () => {
  const { deliver } = await deliverOf({ noTeam: true });
  await assert.rejects(
    () => deliver.execute({}, { agent: AGENT }),
    (error) => {
      assert.equal(error.code, 'E_HOST_UNSUPPORTED');
      assert.equal(error.capability, 'agentTeams');
      return true;
    },
  );
});

test('41. 无 agentTeams + tasks: [] → 按 delivery.mjs 的真实行为走（不替它编结论）', async () => {
  const { deliver } = await deliverOf({ noTeam: true });
  const value = await deliver.execute({ tasks: [] }, { agent: AGENT });
  const lines = value.report.split('\n');
  assert.match(lines[0], /^交付判定：不可交付（\d+ 条阻断）$/);
  assert.match(lines[1], /^数据来源：调用方声明（0 条任务，未经宿主核对）$/);
  /* 空团队 + 没有 phase + 没有宿主签发记录 → 模块真实给出这两条（实测值，见报告）。 */
  assert.match(value.report, /E_NOT_RUNNING/);
  assert.match(value.report, /E_NEEDS_HUMAN_DELIVERY/);
  assert.match(value.report, /统计：0 条任务/);
  assert.equal(value.blockerCount, 2);
});

test('42. maxIssues: 1 + 3 条阻断 → 出现「还有 2 条」，数字是真的', async () => {
  /* caller 路径下恰好 3 条阻断：E_NOT_RUNNING + E_TASK_INCOMPLETE + E_NEEDS_HUMAN_DELIVERY。 */
  const tasks = [{ id: 'X1', kind: 'work', status: 'pending', assignee: 'alice', changedPaths: [] }];
  const { deliver } = await deliverOf({ noTeam: true });
  const value = await deliver.execute({ tasks, maxIssues: 1 }, { agent: AGENT });
  assert.equal(value.blockerCount, 3);
  assert.match(value.report, /…还有 2 条/);
  const blockerBlock = value.report.split('警告（')[0];
  assert.equal((blockerBlock.match(/^ {2}E_/gm) ?? []).length, 1, 'maxIssues:1 只许列 1 条，其余收成一行');
});

test('43. canDeliver 抛错不被吞：畸形任务（会抛的 getter）→ 工具报错，不返回「可以交付」', async () => {
  const evil = { id: 'X1' };
  Object.defineProperty(evil, 'kind', {
    enumerable: true,
    get() {
      throw new Error('取值就炸');
    },
  });
  const { deliver } = await deliverOf({ noTeam: true });
  await assert.rejects(() => deliver.execute({ tasks: [evil] }, { agent: AGENT }), /取值就炸/);
});

test('44. team_deliver 的参数 schema：没有 minimum/maximum，也没有 me/ownerName/assignee', async () => {
  const { deliverDefinition } = await install({ tasks: makeDeliverTasks() });
  const { parameters } = deliverDefinition;
  assert.equal(parameters.additionalProperties, false);
  /* 第 12 轮 D-1：这里从 ['maxIssues','tasks'] 变成四个键 —— 是派工书要求的
   * **schema 扩容**（新增两个可选审计输入），不是把断言改成迁就 bug。
   * 判据：两个新键都必须可选（不在 required 里），且 additionalProperties 仍是 false。 */
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['currentDigests', 'diffPaths', 'maxIssues', 'tasks']);
  for (const forbidden of ['me', 'ownerName', 'assignee']) {
    assert.equal(Object.hasOwn(parameters.properties, forbidden), false, `properties 不许出现 ${forbidden}`);
  }
  assert.equal('minimum' in parameters.properties.maxIssues, false);
  assert.equal('maximum' in parameters.properties.maxIssues, false);
  assert.equal(parameters.properties.tasks.type, 'array');
});

test('45. 开关关掉后**两个**工具都不激活；「只关观察不关裁决」是错的（原断言把缺陷写成了规格）', async () => {
  /* ═══ 原断言与它为什么错（第 15 轮 task-6）═══════════════════════════════════
   *
   * 原断言（逐字）：
   *     assert.equal(deliver.options.when, undefined, '裁决不能跟着关：关掉观察不等于放弃裁决');
   * 原标题：「45. 开关只管 team_board：关掉之后 team_deliver 仍然在，且没有 when」
   *
   * 它把 `team_deliver` 没有 `when` 这件事**写成了期望值**，于是这个缺陷被测试保护了起来：
   * 用户把台上的开关关掉之后，`team_board` 消失，`team_deliver` 照样能调 ——
   * 而用户的原话是「**我不让你用这个，它就不会去用**」。那句话当时是不成立的。
   *
   * 根源是把**两件不同的事**混成了一个 `when`：
   *   ① **成员资格**（不是 Team 成员就看不见板）—— 这条**不该**管到交付判定，
   *      交付只读调用方自己的数据，不需要成员身份；
   *   ② **用户开关**（"别用它"）—— 这条**必须**管到两个工具。
   * 原断言用 ① 的理由去支撑 ② 的结论，所以听起来有理，实际漏了一半。
   *
   * 现在：`team_board` 的 when = 开关 且 成员资格；`team_deliver` 的 when = 只有开关。
   * ═══════════════════════════════════════════════════════════════════════════ */

  const installWith = async ({ enabled, role }) => {
    /* 第 16 轮 task-19：`enabled` 必须**显式写进存储**，不能靠默认值。
     * 原来 `enabled: true` 那支什么都不做（指望默认开），默认值翻成关之后它就不成立了。 */
    const kv = makeKv({ enabled });
    const connection = makeConnection();
    const { teams } = makeTeams({ tasks: makeDeliverTasks(), role });
    const host = makePageHost({ kv, teams, connection });
    apply(host.ctx, {});
    await flush();
    const board = host.registrations.find((item) => item.definition.name === 'team_board');
    const deliver = host.registrations.find((item) => item.definition.name === 'team_deliver');
    return { board, deliver };
  };

  /* ① 开关关掉 → **两个都不激活**（本轮最重要的一条：用户说"别用它"就是都别用） */
  const off = await installWith({ enabled: false, role: 'lead' });
  assert.ok(off.board.options.when !== undefined, 'team_board 必须有 when（它受开关控制）');
  assert.ok(off.deliver.options.when !== undefined, 'team_deliver 必须有 when——原断言要求它"没有 when"，那是缺陷本身');
  assert.equal(off.board.options.when({ agent: AGENT }), false, '开关关 → team_board 不激活');
  assert.equal(
    off.deliver.options.when({ agent: AGENT }),
    false,
    '开关关 → team_deliver 也**必须**不激活（旧实现在这里返回 undefined，即"照样能调"）',
  );

  /* ② 开关开 + 非 Team 成员 → 只看板消失，裁决**仍然可用**。
   * 这一条守的是"成员资格不该管到裁决"，与 ① 的"用户开关必须管到裁决"是两件事，
   * 缺了 ② 就会有人用一刀切的办法把 ① 做掉，把裁决也一起关死。 */
  const outsider = await installWith({ enabled: true, role: 'outsider' });
  assert.equal(outsider.board.options.when({ agent: AGENT }), false, '非成员看不见板（成员资格）');
  assert.equal(
    outsider.deliver.options.when({ agent: AGENT }),
    true,
    '非成员**仍然可以**做交付判定：成员资格不该管到裁决',
  );

  /* ③ 开关开 + 是成员 → 两个都激活 */
  const member = await installWith({ enabled: true, role: 'lead' });
  assert.equal(member.board.options.when({ agent: AGENT }), true, '成员 + 开关开 → 看得见板');
  assert.equal(member.deliver.options.when({ agent: AGENT }), true, '成员 + 开关开 → 可以用裁决');
});

test('46. 真实宿主形状（TeamTaskView 没有 kind）→ 如实报 E_INPUT_INVALID，不假装判定通过', async () => {
  /* 这就是第 8 轮 §〇.3 的事实：真实 TeamTaskView 里没有 kind/contract。
   * 工具必须把这件事说出来，而不是给一个"可以交付"。 */
  const { deliver } = await deliverOf({ tasks: makeTasks() }); // makeTasks 是逐字 TeamTaskView
  const value = await deliver.execute({}, { agent: AGENT });
  assert.match(value.report, /E_INPUT_INVALID/);
  assert.match(value.report, /kind/);
  assert.equal(value.ok, false);
});

test('47. render 返回合法 ContentBlock[]；畸形 value 也不抛', async () => {
  /* 本条验的是渲染器对畸形 value 的容错，与开关无关 → 显式开启。 */
  const { deliverDefinition } = await install({ tasks: makeDeliverTasks(), enabled: true });
  await flush();
  const value = await deliverDefinition.execute({}, { agent: AGENT });
  const blocks = deliverDefinition.output.render({}, value);
  assert.ok(Array.isArray(blocks) && blocks.length > 0);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, value.report);
  for (const bad of [undefined, null, {}, { report: '' }, 7]) {
    const fallback = deliverDefinition.output.render({}, bad);
    assert.ok(Array.isArray(fallback) && fallback.length > 0);
    assert.ok(fallback[0].text.length > 0);
  }
});

test('48. 返回值形状符合 output.schema（四个键齐全、additionalProperties:false）', async () => {
  /* 验输出 schema 与真实返回值一致，与开关无关 → 显式开启。 */
  const { deliverDefinition } = await install({ tasks: makeDeliverTasks(), enabled: true });
  await flush();
  const value = await deliverDefinition.execute({}, { agent: AGENT });
  assert.deepEqual(Object.keys(value).sort(), ['blockerCount', 'ok', 'report', 'warningCount']);
  assert.equal(typeof value.report, 'string');
  assert.equal(typeof value.ok, 'boolean');
  assert.equal(Number.isInteger(value.blockerCount), true);
  assert.equal(Number.isInteger(value.warningCount), true);
  assert.deepEqual(
    Object.keys(deliverDefinition.output.schema.properties).sort(),
    ['blockerCount', 'ok', 'report', 'warningCount'],
  );
  assert.equal(deliverDefinition.output.schema.additionalProperties, false);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 第 8 轮 W7-A：`agentTeams` 缺失但 `subagents` 存在 → 委派花名册
 *
 * 这是本轮唯一能让插件在这台机器上真正有用的改动：不再只报
 * E_HOST_UNSUPPORTED，而是把「本会话派出去的子智能体」摊出来 ——
 * 但**标题必须说明它不是 Team 任务板**：两者都显示"谁在干什么"，
 * 花名册没有任务、没有归属、没有依赖，混着读会得出错误结论。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 假的 subagents：`entries` 原样返回；`throws` 让整个调用炸。 */
function makeSubagents({ entries = [], throws } = {}) {
  const calls = [];
  return {
    calls,
    async listDescendants(sessionId) {
      calls.push(sessionId);
      if (throws !== undefined) throw throws;
      return entries;
    },
  };
}

/**
 * 花名册那条路的夹具：一个**用户已开启**插件的正常宿主（与 `install()` 同一口径）。
 *
 * 第 17 轮 task-20：`execute` 补了第二道门之后，这个夹具必须显式开启 ——
 * 否则下面 6 条测到的全是"被拒绝"，而它们要验的是**花名册渲染**（/「没服务也要能诊断」）。
 * 注意"没有 agentTeams"与"用户关掉了插件"是**两件不同的事**：前者是降级路径，
 * 后者是用户的选择，不能混。
 */
const rosterHost = async (subagents) => {
  const kv = makeKv({ enabled: true });
  const host = makePageHost({ kv, subagents });
  apply(host.ctx, {});
  await flush();
  const entry = host.registrations.find((item) => item.definition.name === 'team_board');
  return { ...host, definition: entry.definition };
};

test('49. 只有 subagents：渲染委派花名册，标题写明不是 Team 任务板', async () => {
  const subagents = makeSubagents({
    entries: [
      { kind: 'child', id: 's1', activity: 'running', mode: 'continuable', label: 'Fix delivery phase 白名单', parentId: 'root', depth: 1, hasChildren: false },
      { kind: 'child', id: 's2', activity: 'inactive', mode: 'continuable', label: '第 10 轮测试', parentId: 'root', depth: 2, hasChildren: false },
    ],
  });
  const { definition } = await rosterHost(subagents);
  const value = await definition.execute({}, { agent: AGENT });
  const lines = value.board.split('\n');
  assert.match(lines[0], /委派花名册/);
  assert.match(lines[0], /不是 Team 任务板/, '标题必须点明它不是任务板');
  assert.match(value.board, /Fix delivery phase 白名单/);
  assert.match(value.board, /🔄/, '在跑要有字形');
  assert.match(value.board, /·/, '在歇要有字形');
  assert.match(value.board, /d1/);
  assert.match(value.board, /d2/);
  assert.equal(value.memberCount, 2);
  assert.deepEqual(subagents.calls, [AGENT.id], '必须按调用方自己的会话读目录');
});

test('50. 有 agentTeams 时走原路径，一个字节都不走花名册', async () => {
  const subagents = makeSubagents({ entries: [{ kind: 'child', id: 's1', activity: 'running', label: '不该出现', depth: 1 }] });
  /* 验"有 agentTeams 时走原路径"，与开关无关 → 显式开启（与 install() 同一口径）。 */
  const host = makePageHost({ kv: makeKv({ enabled: true }), subagents, teams: makeTeams({ tasks: makeTasks() }).teams });
  apply(host.ctx, {});
  await flush();
  const definition = host.registrations.find((item) => item.definition.name === 'team_board').definition;
  const value = await definition.execute({}, { agent: AGENT });
  assert.doesNotMatch(value.board, /委派花名册/);
  assert.match(value.board, /登录校验/, '走的仍是 Team 任务板');
  assert.equal(subagents.calls.length, 0, '有任务板就不该去读子智能体目录');
});

test('51. 两者都没有 → 保持 E_HOST_UNSUPPORTED，不许给空板', async () => {
  const { definition } = await install({ noTeam: true });
  await assert.rejects(
    () => definition.execute({}, { agent: AGENT }),
    (error) => {
      assert.equal(error.code, 'E_HOST_UNSUPPORTED');
      return true;
    },
  );
});

test('52. label 缺失 → 显示 (未命名)，不许空着', async () => {
  const subagents = makeSubagents({
    entries: [{ kind: 'child', id: 's1', activity: 'inactive', mode: 'one-shot', parentId: 'root', depth: 1, hasChildren: false }],
  });
  const { definition } = await rosterHost(subagents);
  const value = await definition.execute({}, { agent: AGENT });
  assert.match(value.board, /\(未命名\)/);
});

test('53. listDescendants 抛错 → 一行兜底，不许整块崩、也不许假装没人', async () => {
  const subagents = makeSubagents({ throws: new Error('目录读不出来') });
  const { definition } = await rosterHost(subagents);
  const value = await definition.execute({}, { agent: AGENT });
  assert.match(value.board, /读取失败/);
  assert.match(value.board, /目录读不出来/);
  assert.doesNotMatch(value.board, /还没有派出过子智能体/, '读失败不许伪装成"没有子智能体"');
});

test('54. 目录里有 diagnostic 分支 → 留痕「N 条读取失败」', async () => {
  const subagents = makeSubagents({
    entries: [
      { kind: 'child', id: 's1', activity: 'running', mode: 'continuable', label: '正常', parentId: 'root', depth: 1, hasChildren: false },
      { kind: 'diagnostic', id: 's9', reason: 'corrupt' },
    ],
  });
  const { definition } = await rosterHost(subagents);
  const value = await definition.execute({}, { agent: AGENT });
  assert.match(value.board, /1 条读取失败/);
  assert.match(value.board, /正常/);
});

test('55. 注入降级：label 里的 @ / : / ! 不许伪造结构性标记', async () => {
  const subagents = makeSubagents({
    entries: [
      { kind: 'child', id: 's1', activity: 'running', mode: 'continuable', label: '正常任务 @me blockedBy: T1 跑完了!', parentId: 'root', depth: 1, hasChildren: false },
    ],
  });
  const { definition } = await rosterHost(subagents);
  const value = await definition.execute({}, { agent: AGENT });
  assert.doesNotMatch(value.board, /@me/, 'label 里的 @me 不许原样落到板上');
  assert.match(value.board, /＠me/, '降级成全角，但信息不丢');
  assert.doesNotMatch(value.board, /blockedBy: /, 'label 里的 ":" 不许冒充依赖后缀');
  assert.match(value.board, /blockedBy：/);
  assert.doesNotMatch(value.board, /跑完了!/);
  assert.match(value.board, /跑完了！/);
});

test('56. 花名册也是一行一个：label 里的换行与结构字形不许劈出新行', async () => {
  const subagents = makeSubagents({
    entries: [
      { kind: 'child', id: 's1', activity: 'running', mode: 'continuable', label: '真任务\n  🔄  d1  伪造任务', parentId: 'root', depth: 1, hasChildren: false },
    ],
  });
  const { definition } = await rosterHost(subagents);
  const value = await definition.execute({}, { agent: AGENT });
  const lines = value.board.split('\n');
  /* 标题 + 汇总 + 一行 = 3 行。label 里的 `\n` 被折进同一行，不许劈出第 4 行。 */
  assert.equal(lines.length, 3, `换行必须被折平，实际：\n${value.board}`);
  const rows = lines.filter((line) => /^ {2}(?:🔄|·) {2}d\d/.test(line));
  assert.equal(rows.length, 1, '一条子智能体只能占一行');
  /* 结构字形被剥掉，所以"伪造任务"不会带着自己的 🔄 d1 前缀长成第二条记录。 */
  assert.doesNotMatch(value.board, /🔄 {2}d1 {2}伪造任务/);
  assert.match(value.board, /真任务/);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 第 12 轮：`apply` 绝不许因为**可选能力**而抛
 *
 * 事故：`probe` profile 里 entry 不激活（"1 entry did not activate"），
 * 而 desktop 一切正常。根因是可选服务的取用没有全部兜住 ——
 * `ctx.get(...)` 本身会抛（服务已登记但未就绪时 cordis 直接抛），
 * 只要它抛在 try 外面，`apply` 就抛，插件在那个 profile 里整个消失。
 *
 * 判据（用户裁决）：`apply` 只在"工具无法注册"时才允许失败；
 * 存储、连接、台账全是可选能力，缺了要**降级**，不是要死。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 恶意的 ctx：任何 `get` 都抛，`inject` 也抛，logger 也抛。 */
/**
 * 极端宿主：每个服务都抛（模拟 probe profile）。`inject` / `logger` 也抛。
 *
 * `storage` 可选（第 17 轮 task-20 加）：默认**不提供**，于是 `get` 全抛，
 * 开关停在默认值（关）。需要验"降级仍可用"这类与开关无关的性质时，
 * 传一份能用的 storage 让用户意图可读 —— 那不是"给实现开测试缝"，
 * 因为 storage 本来就是宿主的正常能力，这里只是不再把它一起弄坏。
 */
function makeHostileHost({ storage } = {}) {
  const registrations = [];
  const labels = [];
  const ctx = {
    tools: {
      register(definition, options = {}) {
        registrations.push({ definition, options });
        return () => {};
      },
    },
    effect(execute, label) {
      labels.push(label);
      const inner = execute();
      return () => {
        if (typeof inner === 'function') inner();
      };
    },
    inject() {
      throw new Error('inject 在这个 profile 不可用');
    },
    get(key) {
      if (storage !== undefined && key === 'storage') return storage;
      throw new Error(`service "${key}" 未就绪（模拟 probe profile）`);
    },
    logger: {
      warn() {
        throw new Error('连 logger 都不可用');
      },
    },
  };
  return { ctx, registrations, labels };
}

test('57. ctx 的 get/inject/logger 全部抛错时，apply 仍返回函数且两个工具都注册了', () => {
  const { ctx, registrations, labels } = makeHostileHost();
  let disposer;
  assert.doesNotThrow(() => {
    disposer = apply(ctx, {});
  }, '可选能力不可用绝不许让 apply 抛 —— 那会让插件在整个 profile 里消失');
  assert.equal(typeof disposer, 'function');
  assert.deepEqual(
    registrations.map((item) => item.definition.name),
    ['team_board', 'team_deliver', 'team_meeting_submit', 'team_meeting_upgrade', 'team_meeting_start'],
  );
  assert.equal(labels.length, 1, '仍然只开一个 effect');
  /* 第 16 轮 task-19：这条测的是"可选能力全坏时 apply 不抛"，**与开关值无关**。
   * 但它的宿主是 hostile 的（storage 一取就抛），**没法显式开启**——所以这里钉的是
   * 新语义：存储坏掉 → 开关停在默认值 → 现在默认是**关** → when 为 false。
   * 这不是"迁就 bug"，而是 fail-closed 的正面证据：读不到用户意图就别生效。 */
  assert.equal(typeof registrations[0].options.when, 'function', '开关门控仍要成立');
  assert.equal(registrations[0].options.when({ agent: AGENT }), false, '存储不可用 → 默认关 → 板不可见');
  assert.equal(typeof registrations[1].options.when, 'function', 'team_deliver 同样必须挂 when');
  assert.equal(registrations[1].options.when({ agent: AGENT }), false, '存储不可用 → 默认关 → 裁决也不可用');
  assert.doesNotThrow(() => disposer());
});

test('58. 可选能力全坏时，工具本身仍然能用（降级，不是死）', async () => {
  /* 第 17 轮 task-20：`execute` 补了第二道门之后，这条必须在**开关打开**的宿主上验。
   * 它要证明的是「agentTeams / subagents / connection 全坏 → 工具降级仍可用」，
   * 而"用户在台账页关掉了插件"是**另一件事**（那由 91/92 条验）。
   * 所以这里给一份能用的 storage（记录 `{enabled:true}`），其余服务照旧全抛。 */
  const kv = makeKv({ enabled: true });
  const { ctx, registrations } = makeHostileHost({ storage: kv.storage });
  apply(ctx, {});
  await flush();
  const board = registrations.find((item) => item.definition.name === 'team_board').definition;
  const deliver = registrations.find((item) => item.definition.name === 'team_deliver').definition;

  /* 没有 agentTeams 也没有 subagents → 仍然是那条结构性错误，不是"空板"。 */
  await assert.rejects(() => board.execute({}, { agent: AGENT }), /E_HOST_UNSUPPORTED|agentTeams/);
  /* 调用方自带 tasks 时，判定照样跑得动 —— 这正是双源的意义。 */
  const value = await deliver.execute(
    { tasks: [{ id: 'X1', kind: 'work', status: 'completed', assignee: 'a', changedPaths: [] }] },
    { agent: AGENT },
  );
  assert.match(value.report.split('\n')[0], /^交付判定：/);
  assert.match(value.report.split('\n')[1], /调用方声明/);
});

test('59. 台账在存储坏掉时是「不可用」；且 apply 期间**零存储 IO**（不把启动绑在存储上）', async () => {
  /* ① 真的存储：apply 期间必须一次 loadAll / putRecord 都没有。
   *    （`get('storage')` / `get('connection')` 是"探测有哪些服务"，不是 IO；
   *      hydrate 的那次读取发生在微任务里，是异步的、且不阻塞注册。） */
  const kv = makeKv();
  const host = makePageHost({ kv });
  apply(host.ctx, {});
  assert.equal(kv.counts.loadAll, 0, 'apply 期间不许读台账');
  assert.equal(kv.counts.putRecord, 0, 'apply 期间不许写台账');
  assert.equal(kv.counts.open, 0, 'apply 期间不许打开存储单元（IO 推迟到 apply 返回之后）');

  /* 推迟不等于不做：apply 返回后，hydrate 仍然会把上次的开关读回来。 */
  await flush();
  assert.ok(kv.counts.open >= 1, 'apply 之后必须真的去读一次（推迟 ≠ 放弃）');
  assert.ok(kv.counts.loadAll >= 1);

  /* ② 存储坏掉：台账给「不可用」（与「无历史」可区分），开关停在**默认关**，全程不抛。
   * 第 16 轮 task-19：原断言是"开关保持默认开"，默认值翻转之后那句要跟着改。
   * 这不是"把断言改绿"——它守的东西（存储坏了不许让插件起不来）没变，
   * 变的只是"读不到用户意图时算开还是关"，而那正是本次任务要改的语义。 */
  const { ctx } = makeHostileHost();

  /* ②a 开关**关着** + 存储坏掉 → `disabled`（"你关了"优先于"存储坏了"）。
   * 这一格必须单独立：把"关掉不读"和"存储坏了"混成一格，就再也分不清
   * 返回 `disabled` 是因为用户关了、还是因为读不出来。 */
  const closed = createBoardState(ctx);
  assert.equal(
    (await closed.readLedger()).status,
    'disabled',
    '关着 + 存储坏 → disabled（先看开关，再谈存储）',
  );
  assert.doesNotThrow(() => closed.getState());
  assert.equal(closed.getState().enabled, false, '开关默认**关**（未表态不生效）');
  await assert.doesNotReject(() => closed.hydrate(), '存储坏掉不许让插件起不来');
  assert.equal(closed.getState().enabled, false, 'hydrate 失败 → 保持默认关');

  /* ②b 开关**开着** + 存储坏掉 → `unavailable`（与"无历史"可区分）。 */
  const state = onSwitch(createBoardState(ctx));
  const ledger = await state.readLedger();
  assert.equal(ledger.status, 'unavailable', '存储读不出来 → 不可用（不是"无历史"）');
  assert.deepEqual(ledger.roles, []);
  assert.doesNotThrow(() => state.getState());
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 第 12 轮（D 组）：五条 P0
 *
 * 五条的共同病灶：**宿主侧"读不到"以前长得跟"读到 0 / 没问题"一模一样**，
 * 而下游（页面、报告）就照"0 / 没问题"渲染。所以每条断言都要求
 * 「不可用」与「真的是空」在**数据形状**上就能分开 —— 而不是靠读注释。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 前 `failures` 次取存储就炸、之后正常的 storage —— 模拟"存储晚一步才就绪"。 */
function flakyStorage(kv, { failures = 1 } = {}) {
  let remaining = failures;
  return {
    form() {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error('存储还没就绪');
      }
      return kv.storage.form();
    },
  };
}

test('60. D-2 门禁不再拿别人的 Agent 顶替：本会话没有活着的 Agent → unavailable/agent，一条任务都不读', async () => {
  const { teams, calls } = makeTeams({ tasks: makeTasks() });
  /* `roots()` 里明明有一个**别的会话**的 agent —— 这正是原来被拿来顶上的那个。 */
  const agents = { get: () => undefined, roots: () => [OTHER_AGENT] };
  const state = onSwitch(createBoardState(makeServiceCtx({ agentTeams: teams, agents })));

  const gates = await state.gates(AGENT.id);
  /* P2-4 第 0 项：这条出口**必须带 `ledger`（第四态 'unavailable'）**。
   * 原来它只有 `{status, reason}` —— 页面若写 `gates.ledger.state` 会取到 `undefined`，
   * 而 `undefined` 既不是"空"也不是"不可用"，渲染器不特判就静默显示成什么都没有。 */
  assert.deepEqual(
    Object.keys(gates).sort(),
    ['ledger', 'reason', 'status'],
    '这条出口的键集必须含 ledger —— 少它页面就会读到 undefined',
  );
  assert.equal(gates.status, 'unavailable');
  assert.equal(gates.reason, 'agent', '拿不到本会话的 Agent 就只许说不可用');
  assert.equal(gates.ledger.state, 'unavailable', '门禁起不来 → 账本是第四态，不是 undefined，也不是 none');
  assert.equal(gates.ledger.readable, false);
  assert.equal(gates.ledger.reason, 'agent', 'reason 与门禁那条出口**同一个值**，不另造词');
  assert.equal(gates.ledger.meetingTasks, null, '压根没数过 → null，不是 0（0 等于宣称"板上没有会议"）');
  assert.deepEqual(calls, [], '不许退化去读任何人的任务（那会把别人的数据当成你的）');

  /* 对照：本会话的 Agent 找得到时，门禁照常工作（删回落不许把正常路径一起删掉）。 */
  const okTeams = makeTeams({ tasks: makeTasks() });
  const okState = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: okTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined), roots: () => [OTHER_AGENT] },
  })));
  const ok = await okState.gates(AGENT.id);
  assert.equal(ok.status, 'ok', '正常路径必须还能用');
  assert.ok(
    okTeams.calls.every(([, agent]) => agent === AGENT),
    `只许拿本会话的 Agent 去问 Team（实际：${okTeams.calls.map(([m]) => m).join('/')}）`,
  );
  assert.ok(okTeams.calls.some(([method]) => method === 'listTasks'), '正常路径必须真的读了任务');
  assert.equal(ok.auditWired, false, '宿主没有审计输入 → 页面必须能看出这是"没接线"的结论');
});

test('61. D-3 花名册「读不出来」不许长得像「0 个」', async () => {
  /* ① 读时抛错 → unavailable/read，且**没有** total（不许伪造 0）。 */
  const boom = {
    listDescendants: async () => {
      throw new Error('目录炸了');
    },
  };
  const readFail = onSwitch(createBoardState(makeServiceCtx({ storage: makeKv().storage, subagents: boom })));
  const snapshot = await readFail.snapshot({ sessionId: AGENT.id });
  assert.deepEqual(snapshot.dataSource, { kind: 'roster', status: 'unavailable', reason: 'read' });
  assert.equal('total' in snapshot.dataSource, false, '读不出来不许写 total:0');

  /* ② 有服务但没给 sessionId → unavailable/service（原因也要分得开）。 */
  const empty = { listDescendants: async () => [] };
  const noSession = onSwitch(createBoardState(makeServiceCtx({ storage: makeKv().storage, subagents: empty })));
  const second = await noSession.snapshot({});
  assert.deepEqual(second.dataSource, { kind: 'roster', status: 'unavailable', reason: 'service' });

  /* ③ 真的一个都没有 → ok + total:0：这个 0 是**数出来的**，与上面两态可区分。 */
  const third = await noSession.snapshot({ sessionId: AGENT.id });
  assert.deepEqual(third.dataSource, { kind: 'roster', status: 'ok', total: 0, running: 0 });
});

test('62. D-4 存储第一次打不开不许永久判死：第二次必须真的去读', async () => {
  /* 第 16 轮 task-19：磁盘上的值从 `false` 改成 **`true`**（与默认值相反）。
   * 默认值翻成 false 之后，原来那个形状证明不了任何事：
   * "读到 false" 与 "什么都没读到、停在默认值" 结果一模一样。
   * 存 true 才能证明第二次**真的读了**。 */
  const kv = makeKv({ enabled: true });
  const state = createBoardState(makeServiceCtx({ storage: flakyStorage(kv, { failures: 1 }) }));

  /* `hydrate()` 返回的是**当前开关值**（不是"读成功了吗"）。第一次读不到 → 返回默认值 false。 */
  assert.equal(await state.hydrate(), false, '第一次读不到 → 返回默认值（关）');
  assert.equal(state.getState().enabled, false, '第一次读不到 → 开关是默认的 false');
  assert.equal(state.stats().hydrated, false, '没读到就**不许**标记已读（否则这台进程永远不再读）');
  assert.equal(kv.counts.loadAll, 0, '第一次连存储单元都没拿到，不该白读一次磁盘');

  assert.equal(await state.hydrate(), true, '第二次必须重新取存储，并读到磁盘上的 true');
  assert.equal(state.getState().enabled, true, '读到 true 只可能是真的读了盘（默认是 false）');
  assert.equal(state.stats().hydrated, true);
  assert.equal(kv.counts.loadAll, 1);
});

test('63. D-4 拿不到存储单元也是「一次写失败」：stats 必须记账（原来悄悄 return）', async () => {
  const bare = createBoardState(makeServiceCtx({}));
  await bare.setEnabled(false);
  assert.deepEqual(
    bare.stats(),
    { persistCalls: 1, persistFailures: 1, hydrated: false },
    '没保存成功必须记一次失败，否则「关」的丢失在 stats 上完全看不见',
  );
  assert.equal(bare.getState().enabled, false, '落盘失败不回滚内存');

  /* 存储晚一步就绪：同一台状态机再写一次就要真的落盘，失败数不再增长。 */
  const kv = makeKv();
  const state = createBoardState(makeServiceCtx({ storage: flakyStorage(kv, { failures: 1 }) }));
  await state.setEnabled(false);
  assert.equal(state.stats().persistFailures, 1);
  await state.setEnabled(false);
  assert.equal(state.stats().persistCalls, 2);
  assert.equal(state.stats().persistFailures, 1, '第二次成功了，失败数不许再涨');
  assert.equal(kv.store.state.enabled.enabled, false, '用户点的「关」必须真的落到磁盘上');
});

test('64. D-4 关掉开关 → 重启（且启动时存储短暂不可用）→ 页面读到的仍是「关」', async () => {
  /* 磁盘上写着关；这一次进程启动时存储"晚了一步"（第一次取存储会炸）。 */
  const kv = makeKv({ enabled: false });
  const connection = makeConnection();
  const host = makePageHost({ kv: { storage: flakyStorage(kv, { failures: 1 }) }, connection });
  apply(host.ctx, {});
  await flush();

  const value = (await (await connection.routes[0].fetch({ json: async () => ({}) })).json()).value;
  assert.equal(value.enabled, false, '启动那次没读到 ≠ 永远读不到：页面一读就必须读回关闭');
});

test('65. D-4 迟到的读回不许把用户刚点的「关」翻回「开」', async () => {
  const kv = makeKv({ enabled: true }); // 磁盘上是开（旧值）
  const state = createBoardState(makeServiceCtx({ storage: flakyStorage(kv, { failures: 1 }) }));

  await state.setEnabled(false); // 用户先点关闭，此时存储还没就绪 → 写失败被记账
  assert.equal(state.stats().persistFailures, 1);
  assert.equal(await state.hydrate(), false, '用户改过之后，hydrate 不许用磁盘旧值覆盖内存');
  assert.equal(state.getState().enabled, false);
});

test('66. D-5 写开关抛错 → 明确的 500 信封，不许把异常漏出 fetch', async () => {
  const connection = makeConnection();
  const state = {
    async setEnabled() {
      throw new Error('磁盘满了');
    },
    async snapshot() {
      return { enabled: true };
    },
  };
  registerStateRoute(makePageHost({ connection }).ctx, state);

  const response = await connection.routes[0].fetch({ json: async () => ({ enabled: false }) });
  assert.equal(response.status, 500, '写盘失败必须是一个能看懂的状态，不是裸异常');
  const envelope = await response.json();
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'team-board/internal');
  assert.match(envelope.error.message, /磁盘满了/, '错误正文要说清是存储的问题');
});

/** 带一条"有绑定记录"的评审 + 两条代码变更任务：故意让空审计输入踩出两条假结论。 */
function makeAuditTasks() {
  return [
    { id: 'I1', kind: 'implementation', status: 'completed', assignee: 'alice', changedPaths: ['src/a.mjs'] },
    {
      id: 'R1',
      kind: 'review',
      status: 'completed',
      assignee: 'bob',
      reviewedTaskId: 'I1',
      reviewed: { verdict: 'pass', artifacts: [{ path: 'src/a.mjs', sha256: 'aaaa' }] },
    },
    { id: 'I2', kind: 'implementation', status: 'completed', assignee: 'alice', changedPaths: ['src/b.mjs'] },
  ];
}

test('67. D-1 宿主路径没有审计输入 → 自曝 E_AUDIT_UNWIRED，缺指纹类结论降级为警告', async () => {
  const { deliver } = await deliverOf({ tasks: makeAuditTasks() });
  const value = await deliver.execute({}, { agent: AGENT });
  const [blockerBlock, warningBlock = ''] = value.report.split('警告（');

  assert.match(value.report, /E_AUDIT_UNWIRED/, '必须自曝"这两项没跑"');
  assert.match(value.report, /currentDigests/, '要说清缺的是哪一项');
  assert.doesNotMatch(blockerBlock, /E_AUDIT_UNWIRED/, 'E_AUDIT_UNWIRED 是"没跑"，不是一条发现，绝不进阻断段');
  assert.doesNotMatch(blockerBlock, /E_BINDING_STALE/, '缺指纹时这条分不清"文件坏了"和"没查"，不许当阻断');
  assert.doesNotMatch(blockerBlock, /E_UNBOUND_ARTIFACT/, '同理：没指纹时"未绑定"必然是假的');
  assert.match(warningBlock, /E_BINDING_STALE/, '降级不等于删掉：仍然要看得见');
  assert.match(warningBlock, /E_UNBOUND_ARTIFACT/);
  assert.equal(value.ok, false, '审计没接线时「可以交付」没有任何依据');
});

test('68. D-1 调用方声明的审计输入真的进了判定，并且标了来源', async () => {
  const { deliver } = await deliverOf({ tasks: makeAuditTasks() });
  const value = await deliver.execute({
    diffPaths: ['src/a.mjs', 'src/c.mjs'],
    currentDigests: { 'src/a.mjs': 'aaaa' },
  }, { agent: AGENT });

  assert.doesNotMatch(value.report, /E_AUDIT_UNWIRED/, '交底之后不该再自曝没接线');
  assert.match(
    value.report,
    /审计输入：diffPaths 2 条 \/ currentDigests 1 条（调用方声明，未经宿主核对）/,
    '来源必须写清：这是调用方说的，宿主没核过',
  );
  assert.match(value.report, /E_UNREPORTED_CHANGES/, 'diffPaths 必须真的传进 canDeliver，否则这条永远不出现');
  assert.doesNotMatch(value.report.split('警告（')[0], /E_BINDING_STALE/, '指纹对得上就不该有 stale');
});

test('69. D-1 「已知为空」与「不知道」必须分开：显式传空数组/空对象不再自曝未接线', async () => {
  const { deliver } = await deliverOf({ tasks: makeAuditTasks() });

  const declared = await deliver.execute({ diffPaths: [], currentDigests: {} }, { agent: AGENT });
  assert.doesNotMatch(declared.report, /E_AUDIT_UNWIRED/, '显式声明「查过，一个都没有」≠ 没查');
  assert.match(declared.report, /审计输入：diffPaths 0 条 \/ currentDigests 0 条（调用方声明，未经宿主核对）/);
  assert.match(
    declared.report.split('警告（')[0],
    /E_BINDING_STALE/,
    '调用方说查过了，结论就得按查过的算（哪怕结果是坏的）——降级只针对"不知道"',
  );

  const unknown = await deliver.execute({}, { agent: AGENT });
  assert.match(unknown.report, /E_AUDIT_UNWIRED/, '一个字都没声明 → 必须自曝');
});

test('70. D-1 两个审计参数都可选、类型正确，且没有多出别的入参', async () => {
  const { deliverDefinition } = await install({ tasks: makeDeliverTasks() });
  const { parameters } = deliverDefinition;
  assert.equal(parameters.additionalProperties, false);

  assert.equal(parameters.properties.diffPaths.type, 'array');
  assert.equal(parameters.properties.diffPaths.items.type, 'string');
  assert.equal(parameters.properties.currentDigests.type, 'object');
  assert.equal(parameters.properties.currentDigests.additionalProperties.type, 'string');
  assert.equal(
    'required' in parameters,
    false,
    '两个审计输入必须可选：宿主给不出它们，缺省就是"不知道"（报告会自曝）',
  );
});

/**
 * F6：`when` 抛错 = 整个模型步失败，不是"藏起这个工具"。
 *
 * `dsh-tools/lib/index.js:552-555` 会把 `when` 的异常转成 `ToolActivationError`，
 * 而 README 明写它**中止步骤准备**。于是 `agentTeams` 只要处于
 * 「已登记但未就绪」（`tryMembership` 一调就抛），**每一个模型步**都会
 * 以 `TOOL_ACTIVATION_FAILED` 失败 —— 这个插件会把整个会话拖死。
 *
 * 所以判据不是"少显示一个工具"，而是：**`when` 永不抛**，拿不准就当看不见。
 */
test('71. F6 agentTeams 未就绪（tryMembership 抛错）时 when 不许抛，只许 fail-closed 成 false', async () => {
  const { entry, definition } = await install({ tryMembershipError: new Error('service not ready') });

  /* 注册本身不受影响：能注册就注册，肉眼可见的失败比悄悄不注册好查。 */
  assert.equal(definition.name, 'team_board');

  let visible;
  assert.doesNotThrow(() => {
    visible = entry.options.when({ agent: AGENT });
  }, 'when 抛错会中止**整个模型步**：一次服务查询失败不许升级成整步失败');
  assert.equal(visible, false, 'fail-closed：服务拿不准就当这一步看不见板');

  /* 没有 agent 的上下文同样不许抛（回放/子调用里 agent 可能缺失）。 */
  assert.doesNotThrow(() => entry.options.when({}));
  assert.equal(entry.options.when({}), false);
  assert.doesNotThrow(() => entry.options.when(undefined));
  assert.equal(entry.options.when(undefined), false);

  /* 裁决不该因为"看不见板"而消失，但**必须**跟着用户开关走。
   *
   * 原断言要求 team_deliver 完全没有 when —— 那等于把"开关管不住交付"写成了期望值。
   * 两件事必须分开验：
   *   成员资格（tryMembership 抛）→ 裁决仍在，只是板没了
   *   用户开关（enabled=false）    → 裁决也消失
   *
   * 为什么要放在**同一个测试**里：这个缺陷的特征就是"两件事被写成一个门控"，
   * 只有把两条并排断言，才能证明现在它们真的分开了。只验一条的话，
   * 把两条门控又合回去（或者干脆全都不挂）都能让它绿。
   */
  const { deliverEntry } = await install({ tryMembershipError: new Error('service not ready'), enabled: true });
  await flush(); // hydrate 把存储里的 {enabled:true} 读回来（本测试与默认值无关，显式开启）
  assert.ok(
    deliverEntry.options !== undefined && deliverEntry.options.when !== undefined,
    'team_deliver 必须挂 when：用户开关要能真的关掉它（原断言要求"没有 when"，那正是缺陷）',
  );

  /* ① 成员资格不影响裁决：服务坏掉 + 开关默认开 → 裁决**仍在**。 */
  let deliverVisible;
  assert.doesNotThrow(() => {
    deliverVisible = deliverEntry.options.when({ agent: AGENT });
  }, 'agentTeams 坏掉时 team_deliver 的 when 同样不许抛（抛错会中止整个模型步）');
  assert.equal(deliverVisible, true, '服务坏掉不许连裁决一起关掉：交付判定不依赖成员资格');

  /* 没有 agent 的上下文（回放/子调用）：裁决照样可用，且不许抛。 */
  assert.doesNotThrow(() => deliverEntry.options.when(undefined));
  assert.equal(deliverEntry.options.when(undefined), true, '没有 agent 上下文时裁决仍然可用');

  /* ② 用户开关**影响**裁决：同一个 when，`enabled=false` 时必须返回 false。
   *
   * `install()` 那条夹具造不出 `enabled=false`（它的 ctx 没有 storage，开关停在默认值），
   * 所以这里必须走页面那条路：真 state 机 + 假 kv + 真路由，与第 45 条同一套。 */
  const kv = makeKv({ enabled: true }); // 先真开启，否则"关掉"这一步测不到任何东西
  const connection = makeConnection();
  const { teams } = makeTeams({ tasks: makeDeliverTasks() });
  const pageHost = makePageHost({ kv, teams, connection });
  apply(pageHost.ctx, {});
  await flush();

  const route = connection.routes.find((entry) => entry.path === STATE_PATH);
  await route.fetch({ json: async () => ({ enabled: false }) });

  const deliverOff = pageHost.registrations.find((item) => item.definition.name === 'team_deliver');
  assert.ok(deliverOff.options?.when !== undefined, '页面宿主注册的 team_deliver 同样必须挂 when');
  assert.equal(
    deliverOff.options.when({ agent: AGENT }),
    false,
    '用户关掉开关 → 裁决必须一起消失（这就是"我不让你用，它就不会去用"）',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 72–82. D-14 接线：`kind` 从 `description` 的 `team-board` 声明块里来（task-4）
 *
 * 为什么这一组值得存在：真实 `TeamTaskView` 是 `.strict()` 十个字段，
 * **没有 kind、也没有契约字段**。而 `gates.mjs` / `delivery.mjs` / `contract.mjs`
 * 里按 kind 分流的地方一共几十处。不接线的时候，`evaluateCompletion()` 对一条
 * 什么都没判的任务返回 `{ ok: true, errors: [] }` —— 那读作「这批活没问题，可以收」。
 * 判定层于是变成装饰品。第 78 条就是这条命的判据。
 *
 * 这一组**不重写解析规则**（那些在 `contract.test.mjs` 里有 23 条），
 * 只钉「宿主形状 → 映射结果 → 判定层」这条链真的接通了。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 围栏常量：写成变量是为了避免在模板串里转义反引号（那样读起来就没法核对了）。 */
const DECL_FENCE = '```';

/** 拼一个 `team-board` 声明块（逐行拼，块内内容与任务正文分开写）。 */
function declarationBlock(lines) {
  return [`${DECL_FENCE}team-board`, ...lines, DECL_FENCE].join('\n');
}

/**
 * 真实宿主形状：**逐字** `.strict()` 那十个字段（id/revision/subject/description/
 * status/blockedBy/writeScopes/ownerName/ready/writeScopeWarnings）。
 * `description` 可替换，用来放声明块或畸形文本。
 */
function hostTask(description, patch = {}) {
  return {
    id: 'T1',
    revision: 1,
    subject: '实现登录校验',
    description,
    status: 'in_progress',
    blockedBy: [],
    writeScopes: ['plugin/host/index.js'],
    ownerName: 'alice',
    ready: true,
    writeScopeWarnings: [],
    ...patch,
  };
}

/** 一份「完整声明」的质量类任务描述（implementation）。 */
const FULL_DECLARATION = declarationBlock([
  'kind: implementation',
  'acceptance:',
  "  - storage.open 失败时 ledger.status === 'unavailable'",
  'verify:',
  '  - node --test plugin/test/host.test.mjs',
  'inScope:',
  '  - plugin/host/index.js',
]);

/** warnings 数组 → 码数组（断言只关心码集合，正文另有断言盯着）。 */
const warningCodes = (warnings) => (Array.isArray(warnings) ? warnings.map((item) => item?.code) : []);

test('72. D-14 真实宿主形状 + 完整声明块 → mapped.kind 与 mapped.contract 真的被填上', () => {
  const raw = hostTask(`实现登录校验。\n\n${FULL_DECLARATION}`);
  /* 前提断言：这两个键在真实宿主形状里**根本不存在**，所以下面填上来的只能是解析来的。 */
  assert.equal(Object.hasOwn(raw, 'kind'), false, '前提：真实 TeamTaskView 没有 kind');
  assert.equal(Object.hasOwn(raw, 'contract'), false, '前提：真实 TeamTaskView 没有 contract');

  const mapped = mapHostTask(raw);
  assert.equal(mapped.kind, 'implementation');
  assert.deepEqual(mapped.contract, {
    acceptance: ["storage.open 失败时 ledger.status === 'unavailable'"],
    verify: ['node --test plugin/test/host.test.mjs'],
    inScope: ['plugin/host/index.js'],
  });
  assert.equal(mapped.assignee, 'alice', 'ownerName → assignee 那条老职责不许在接线时丢掉');
  assert.deepEqual(warningCodes(mapped.declarationWarnings), [], '有块且没写错 → 一条声明警告都不该有');
  /* 原始任务对象不许被就地改写：`listTasks` 的返回值还可能被别处用到。 */
  assert.equal(Object.hasOwn(raw, 'kind'), false, '映射必须返回新对象，不许就地改写宿主数据');
});

test('73. D-14 没有块但 writeScopes 非空 → E_DECLARATION_MISSING', () => {
  const mapped = mapHostTask(hostTask('实现登录校验，没有声明块'));
  assert.deepEqual(warningCodes(mapped.declarationWarnings), ['E_DECLARATION_MISSING']);
  const warning = mapped.declarationWarnings[0];
  assert.match(warning.message, /plugin\/host\/index\.js/, '警告必须带上是哪条写域，否则读者得自己去翻任务');
  assert.match(warning.message, /fail-open/, '警告必须说清后果：门禁对它判不动');
  assert.equal(mapped.kind, undefined, '没有块就是没有 kind（不猜）');
});

test('74. D-14 没有块且 writeScopes 为空 → 不发 E_DECLARATION_MISSING（读文档的活本来没有 kind）', () => {
  const mapped = mapHostTask(hostTask('读一遍 README，把结论写回给我', { writeScopes: [] }));
  assert.deepEqual(warningCodes(mapped.declarationWarnings), [], '写域为空时按着头要声明是噪声');
  assert.equal(mapped.kind, undefined);
});

test('75. D-14 `Kind:` 拼错 → 有 E_DECLARATION_UNKNOWN_KEY，且不会因此丢掉整份声明', () => {
  const description = declarationBlock(['Kind: implementation', 'acceptance:', '  - 一条验收', 'verify:', '  - node --test']);
  const mapped = mapHostTask(hostTask(description));

  assert.ok(
    warningCodes(mapped.declarationWarnings).includes('E_DECLARATION_UNKNOWN_KEY'),
    '拼错大小写必须留痕：静默丢掉整个声明比报错危险得多',
  );
  /* 关键：拼错一个键**不代表**整块作废 —— 同块里没拼错的字段必须照样落地。 */
  assert.deepEqual(mapped.contract, { acceptance: ['一条验收'], verify: ['node --test'] }, '拼错的只有 `Kind:`，另外两个键必须照常落地');
  assert.equal(mapped.kind, undefined, '拼成 `Kind:` 的值不许被当成 kind（那等于忽略拼写错误）');
  assert.equal(
    warningCodes(mapped.declarationWarnings).includes('E_DECLARATION_MISSING'),
    false,
    '块在、只是键拼错 → 不许再说"没有块"（那是两个不同的故障）',
  );
});

test('76. D-14 畸形描述（未闭合 / CRLF / 超长 / null / 非字符串）→ 不抛错，任务仍在板上', async () => {
  const tasks = [
    hostTask('没有闭合的块：\n```team-board\nkind: implementation\nacceptance:\n  - x', { id: 'BAD1' }),
    hostTask(FULL_DECLARATION.split('\n').join('\r\n'), { id: 'CRLF' }),
    hostTask(`${'x'.repeat(200000)}\n${FULL_DECLARATION}`, { id: 'HUGE' }),
    hostTask(null, { id: 'NULLDESC' }),
    hostTask(Object.assign(Object.create(null), { weird: true }), { id: 'EXOTIC' }),
  ];

  /* ① 逐条直接映射：一条都不许抛。 */
  for (const task of tasks) {
    assert.doesNotThrow(() => mapHostTask(task), `映射 ${task.id} 时抛了：一条烂描述不该拖垮整块板`);
  }

  /* ② CRLF 与超长的块必须**照常解析出来**（不同换行符不是"畸形"，只是另一种合法输入）。 */
  const crlf = mapHostTask(tasks[1]);
  assert.equal(crlf.kind, 'implementation', 'CRLF 的块必须照样认出来（Windows 侧粘贴的描述都是 CRLF）');
  assert.equal(mapHostTask(tasks[2]).kind, 'implementation', '正文超长不许让块失效');

  /* ③ 未闭合块：只留 UNPARSEABLE，**不叠发** MISSING（两个码各管一种原因）。 */
  assert.deepEqual(warningCodes(mapHostTask(tasks[0]).declarationWarnings), ['E_DECLARATION_UNPARSEABLE']);

  /* ④ 整个工具走一遍：五条任务一条都不许从板上消失。 */
  const { definition } = await install({ tasks });
  const value = await definition.execute({}, { agent: AGENT });
  assert.equal(value.taskCount, 5, '任务计数必须是 5：坏数据不许被悄悄丢掉');
  for (const id of ['BAD1', 'CRLF', 'HUGE', 'NULLDESC', 'EXOTIC']) {
    assert.match(value.board, new RegExp(id), `${id} 必须仍然在板上（丢掉等于"它从没存在过"）`);
  }
});

test('77. D-14 宿主优先：任务已自带 kind / contract 时，声明块不许覆盖它', () => {
  const raw = hostTask(FULL_DECLARATION, {
    kind: 'review',
    contract: { acceptance: ['宿主自己的验收'], verify: ['宿主自己的命令'] },
  });
  const mapped = mapHostTask(raw);
  assert.equal(mapped.kind, 'review', '宿主给了 kind 就以宿主为准');
  assert.deepEqual(mapped.contract, { acceptance: ['宿主自己的验收'], verify: ['宿主自己的命令'] });

  /* 反向的一条：宿主给的是**空** contract（`{}` 在 contract.mjs 里等于"未声明"），
   * 这时必须让声明块填进来 —— 否则宿主一个空对象就能把声明静默吃掉。 */
  const emptyContract = mapHostTask(hostTask(FULL_DECLARATION, { contract: {} }));
  assert.equal(emptyContract.kind, 'implementation');
  assert.deepEqual(emptyContract.contract.inScope, ['plugin/host/index.js'], '空的 `{}` 不算"宿主已声明"');
});

test('78. ★ D-14 核心：带完整声明的质量类任务交给 evaluateCompletion，不再返回 {ok:true, errors:[]}', () => {
  /* 这是 D-14 存在的**全部理由**。
   * 改前（未接线）：这条任务没有 kind → 关⓪②③④ 全走"不知道"分支 → 返回
   * `{ ok: true, errors: [] }`，读作「这批活没问题，可以收」，而它一条都没判。 */
  const mapped = mapHostTask(hostTask(FULL_DECLARATION));

  const verdict = evaluateCompletion({ task: mapped });

  assert.notDeepEqual(
    verdict,
    { ok: true, errors: [] },
    '仍然 fail-open：说明声明没有接进判定层（D-14 没生效，不是"测试通过"）',
  );
  assert.equal(verdict.ok, false, '声明了 acceptance/verify 却一条回执都没有 → 必须是不可完成');

  const codes = verdict.errors.map((error) => error.code);
  /* 这三条一一对应声明里的三件事：verify 没回执、acceptance 没对账、changedPaths 没申报。
   * 断言码集合（而不是"errors 非空"）是为了证明**判的是声明里写的那些东西**。 */
  assert.ok(codes.includes('E_VERIFY_MISSING'), `缺 verify 回执必须报（实际：${codes.join(',')}）`);
  assert.ok(codes.includes('E_ACCEPTANCE_MISMATCH'), `验收项没对账必须报（实际：${codes.join(',')}）`);
  assert.ok(codes.includes('E_CHANGED_PATHS_REQUIRED'), `implementation 没申报改动必须报（实际：${codes.join(',')}）`);

  /* 对照组：同一条任务、描述里**没有**声明块 → 仍然是 fail-open。
   * 这条断言是诚实的边界声明：D-14 只救"写了声明块的任务"。谁不写声明块，
   * 判定层依然对它一言不发 —— 别把「接线完成」读成「问题彻底解决」。 */
  const bare = evaluateCompletion({ task: mapHostTask(hostTask('实现登录校验')) });
  assert.deepEqual(bare, { ok: true, errors: [] }, '对照组：没写声明块的任务仍然 fail-open（这是 D-14 尚未覆盖的范围）');
});

test('79. D-14 gates 页面路径也吃上声明：与工具链给出同一个 kind、同一批阻断', async () => {
  const tasks = [hostTask(FULL_DECLARATION)];
  const { teams } = makeTeams({ tasks });

  /* ① 页面门禁（`state.gates`）—— 它原来直接把裸 TeamTaskView 塞进 canDeliver。 */
  const state = onSwitch(createBoardState(makeServiceCtx({ agentTeams: teams, agents: { get: () => AGENT } })));
  const gates = await state.gates(AGENT.id);
  assert.equal(gates.status, 'ok');

  const gateCodes = gates.blockers.map((item) => item.code);
  assert.equal(
    gateCodes.includes('E_INPUT_INVALID'),
    false,
    `页面上不该再出现"kind 读不出来"（实际：${gateCodes.join(',')}）—— 说明声明在页面路径没生效`,
  );

  /* ② 工具路径（`team_deliver`）对同一批任务必须给出**同一批 kind 判据**。
   *
   * 注意这里**只比 kind 相关的那些码**，不比全集：团队阶段在两个入口是**有意不同**的
   * （`resolveDeliverInput` 的宿主路径按 `phase:'running'` 判定并写在数据来源行，
   * 因为一次工具调用只可能发生在活着的会话里；页面路径拿不到 phase 就如实说不知道，
   * 于是页面会多一条 `E_NOT_RUNNING`）。那是既有裁决，不是 D-14 的问题，
   * 拿它来断言"两个入口完全一致"会把一条正确的差异读成 bug。 */
  const { deliver } = await deliverOf({ tasks });
  const report = (await deliver.execute({}, { agent: AGENT })).report;
  assert.doesNotMatch(report, /E_INPUT_INVALID/, '工具路径同样不许再出现"kind 读不出来"');
  assert.match(report, /E_TASK_INCOMPLETE\s+\[T1\]/, '工具路径必须判出这条任务还没结论');
  assert.match(
    gates.blockers.map((item) => item.message).join('\n'),
    /kind=implementation/,
    '页面上的判定必须读到 kind=implementation（不是 unknown）——这才是"声明接进判定层"的证据',
  );

  /* ③ 页面的板块也要吃到声明（板上的 kind 列是同一份映射的产物）。 */
  assert.match(gates.board, /impl/, '页面上的板块里 kind 列必须已经变成 impl');
});

test('80. D-14 板上那一列 kind 从 `?` 变成 impl / review / work', async () => {
  /* 这是用户直接看得见的那一处：`board.mjs` 读 `task.kind`，真实任务没有它 → 永远是 `?`。 */
  const tasks = [
    hostTask(FULL_DECLARATION, { id: 'IMPL' }),
    hostTask(declarationBlock(['kind: review', 'acceptance:', '  - 判据一条']), { id: 'REV' }),
    hostTask(declarationBlock(['kind: work']), { id: 'WORK' }),
    hostTask('没有声明块的活', { id: 'NONE', writeScopes: [] }),
  ];

  const { definition } = await install({ tasks });
  const { board } = await definition.execute({}, { agent: AGENT });

  /* 按**行**取，不按列序取：`board.mjs` 归 warnfix 改（写域警告归属那条任务），
   * 列序或分隔空白一变，`/IMPL\s+impl\s/` 这种写法就会红在一件与 D-14 无关的事情上。
   * 而这条测试要守的是"同一条任务的 kind 列从 `?` 变成了正确的词"——按行取就够，且更稳。 */
  /* 取"以这个 id 开头的任务行"（标题行 `团队板（4 个任务，你在 IMPL）` 里也有 IMPL，
   * 所以不能用 `includes`）。不假定列序与分隔空白，只假定 id 在行首——那是板上
   * 唯一的稳定锚点。 */
  const lineOf = (id) => board.split('\n').find((line) => new RegExp(`^\\s*${id}(\\s|$)`).test(line)) ?? '';
  assert.match(lineOf('IMPL'), /\bimpl\b/, `implementation → impl（实际行：${lineOf('IMPL')}）`);
  assert.match(lineOf('REV'), /\breview\b/, `review → review（实际行：${lineOf('REV')}）`);
  assert.match(lineOf('WORK'), /\bwork\b/, `work → work（实际行：${lineOf('WORK')}）`);
  assert.match(lineOf('NONE'), /\?/, `没写声明块的仍然是 \`?\`（不许编一个 kind 出来，实际行：${lineOf('NONE')}）`);
  assert.doesNotMatch(lineOf('NONE'), /\bimpl\b|\breview\b|\bwork\b/, 'NONE 那条不许被别人的声明串味');
});

test('81. D-14 声明警告必须真的被印出来（挂在任务上却没人渲染 = 一条永远不会出现的码）', async () => {
  /* `makeTasks()` 里 T1 有写域、描述里没有块；T2/T3 写域为空。 */
  const { deliver } = await deliverOf({ tasks: makeTasks() });
  const value = await deliver.execute({}, { agent: AGENT });

  assert.match(value.report, /声明警告（1）/, '这一段必须出现在报告里，否则本码等于没接');

  /* 断言必须**只落在「声明警告」这一段里**：阻断段里本来就有 `[T1]`/`[T2]`
   * （那是 canDeliver 自己的报法），拿整篇去匹配会把两件事混起来。 */
  const section = value.report.split('声明警告（')[1] ?? '';
  assert.match(section, /E_DECLARATION_MISSING/, '码名要露出来（不然读者不知道去查什么）');
  assert.match(section, /\[T1\]/, '归属必须带任务 id：把归属拍平之后读者会挂到相邻那条任务上');
  assert.doesNotMatch(section, /\[T2\]/, 'T2 写域为空，不该被算进来');

  /* 没写域的任务一条声明警告都没有时，整段不打印（空段是噪声）。 */
  const clean = await deliverOf({ tasks: [{ id: 'W1', kind: 'work', status: 'completed', assignee: 'a', changedPaths: [] }] });
  const cleanValue = await clean.deliver.execute({}, { agent: AGENT });
  assert.doesNotMatch(cleanValue.report, /声明警告/, '没有警告时不许印一个空标题');
});

test('82. R10 四个 includeCompleted 默认值口径：模块默认值必须等于工具实际产出的值', async () => {
  /* 这个 `0` 有四个副本（`:80` schema 说明、`:167` 工具路径、`:582` 页面路径、`board.mjs:78`
   * 模块默认）。**不合并它们**——它们对不同对象承诺（模型、页面、任意新调用方），
   * 合并会削掉其中一处该有的解释。但四处漂成不一样的值时，谁都不会响。
   * 所以这里钉一条**行为等价**：不传参数时，模块默认值产出的板 == 工具产出的板。 */
  const tasks = makeTasks();
  const members = [];
  const me = 'alice';

  const moduleDefault = renderBoard({ tasks, members, me });
  const { definition } = await install({ tasks, members, memberName: me });
  const { board: toolDefault } = await definition.execute({}, { agent: AGENT });

  assert.equal(toolDefault, moduleDefault, '模块默认值与工具实际产出的板必须逐字相同');
  assert.doesNotMatch(toolDefault, /评审接口契约/, '默认定值必须让"已完成"不出现在板上（已完成的会淹掉在跑的）');

  /* 变异等价物：**不写 `board.mjs`**（那个文件归 warnfix 正在改），改用"传 6"模拟
   * 它默认值漂成 6 的效果。这条对照证明上面那条 equal 不是"两个空字符串相等"：
   * 一旦默认值漂成 6，两份板立刻不同，那条 equal 就会红。 */
  const likeSix = renderBoard({ tasks, members, me, includeCompleted: 6 });
  assert.notEqual(likeSix, moduleDefault, '若 `board.mjs:78` 漂成 6，模块默认值那一侧就会变成这份 → equal 当场红');
  assert.match(likeSix, /评审接口契约/, '（顺带钉住：传 6 之后已完成确实会进来，对照才有意义）');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 第 14 轮：结构化 `tasks` —— 让页面那块任务板真的能渲染出来
 *
 * 改前的事实：`plugin/client.js` 里那套结构化任务板（表头 + 行 + `@name` 变灰 +
 * 徽章 + 依赖/警告/写域标记）有实现、有测试，但两条 payload 里都没有 `tasks`，
 * 于是它**只在降级文案后面活着**：「宿主没有提供结构化任务数据」。
 * 代码写了、测了、线上走不到 —— 和 `E_NO_ARTIFACT_BINDING`（记了七轮账、输出里
 * 一次都没出现）、`E_AUDIT_UNWIRED`（最初没有发射点）是同一个形状的病。
 *
 * 下面这一批的每一条都对着**这个形状**：只要有人把 `tasks` 从任一 payload 里去掉、
 * 或者开始"为了好看"二次读宿主，就必须红。
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 从 `renderBoard` 的文本里取**任务行的 id**（行首两空格 + id + 两空格）。
 *
 * 只取任务行：标题行没有缩进，`…还有 N 条` 以 `…` 开头，写域警告行以 `⚠` 开头，
 * 三者都匹配不上，所以不会被当任务。这条解析只用于**对账**（两份数据的 id 集合），
 * 不用于渲染 —— `client.js:543` 那条"绝不去拆 board 那段文本"的红线依然有效：
 * 页面拿到的是结构化数据，不是从这段文本里猜出来的。
 */
const boardRowIds = (board) => board
  .split('\n')
  .slice(1)
  .map((line) => /^ {2}(\S+) {2}/.exec(line))
  .filter((match) => match !== null)
  .map((match) => match[1]);

test('83. ★ 第 14 轮：team_board 的 payload 里必须有结构化 tasks（没有它，页面永远走降级）', async () => {
  /* fixture 全是 pending：没有任何一条会被"已完成默认不显示"或 maxLines 预算摘掉，
   * 于是"两份数据的 id 集合"可以严格相等地比对，不需要为截断开例外。 */
  const tasks = makeManyTasks(3);
  const { definition, team } = await install({ tasks, memberName: 'alice' });
  const value = await definition.execute({}, { agent: AGENT });

  assert.ok(
    Array.isArray(value.tasks),
    'payload 里必须有 tasks：缺了这个键，`client.js` 的 boardRows() 就拿不到东西，'
      + '页面只能显示「宿主没有提供结构化任务数据」——那正是本次要消灭的那句降级文案',
  );
  assert.equal(value.tasks.length, value.taskCount, 'tasks 条数必须等于 taskCount（同一个数组、同一个数，不许各数一遍）');
  assert.equal(value.tasks.length, 3);

  /* 「同一次取数」的**唯一机器判据**是调用次数：为了某个字段好看而二次读宿主，
   * 就会出现"表里 5 条、文本板里 4 条"这种两份数据互相打脸的局面。 */
  assert.equal(
    team.calls.filter((call) => call[0] === 'listTasks').length,
    1,
    'listTasks 只许被调用一次：tasks 与 board 必须来自同一次取数',
  );

  /* tasks 与 board 文本里的任务 id 集合一致（防漂）。 */
  const payloadIds = value.tasks.map((task) => task.id).sort();
  assert.deepEqual(boardRowIds(value.board).sort(), ['T1', 'T2', 'T3'], '前提：板上确实有这三行');
  assert.deepEqual(payloadIds, boardRowIds(value.board).sort(), '两份数据的任务 id 集合必须一致');

  /* 诚实边界：payload 是**宿主那份列表**的结构化镜像，而文本板还要过
   * `includeCompleted:0` + `maxLines` 的预算截断，所以真实关系是 payload ⊇ board。
   * 把这个方向也钉住，免得以后有人把它读成 bug（或者反过来把 board 改成"全都印"）。 */
  const mixed = await install({ tasks: makeTasks(), memberName: 'alice' }); // T1 在跑 / T2 待开工 / T3 已完成
  const mixedValue = await mixed.definition.execute({}, { agent: AGENT });
  assert.deepEqual(mixedValue.tasks.map((task) => task.id), ['T1', 'T2', 'T3'], 'payload 是宿主列表的镜像：已完成那条也在（预算截断是文本板的事）');
  assert.doesNotMatch(mixedValue.board, /评审接口契约/, '文本板仍然按 includeCompleted:0 摘掉已完成（一个字都没变）');
  assert.deepEqual(boardRowIds(mixedValue.board).sort(), ['T1', 'T2'], '方向单一且可预测：board ⊆ payload');
});

test('84. 第 14 轮：kind 如实反映"读不出来" —— 有声明块的透出真值，没有的**不带这个键**（不是 unknown）', async () => {
  const tasks = [
    hostTask(FULL_DECLARATION, { id: 'IMPL' }),
    hostTask(declarationBlock(['kind: review']), { id: 'REV' }),
    hostTask('没有声明块的活', { id: 'NONE', writeScopes: [] }),
    hostTask('宿主自己给了 kind', { id: 'HOST', kind: 'work', writeScopes: [] }),
  ];
  const { definition } = await install({ tasks });
  const value = await definition.execute({}, { agent: AGENT });
  const byId = new Map(value.tasks.map((task) => [task.id, task]));

  assert.equal(byId.get('IMPL').kind, 'implementation', '声明块里的 kind 必须透出来（不是 `?`、不是 `unknown`）');
  assert.equal(byId.get('REV').kind, 'review');
  assert.equal(byId.get('HOST').kind, 'work', '宿主自带的 kind 以宿主为准（与 mapHostTask 的"宿主优先"同一口径）');

  const none = byId.get('NONE');
  assert.equal(Object.hasOwn(none, 'kind'), false, '没有声明块就**不许有这个键**（页面按 falsy → 未声明，够了）');
  assert.equal(none.kind, undefined, '读不出来就是 undefined，不许被任何默认值顶上');
  assert.notEqual(none.kind, 'unknown', '**绝不**编一个 `unknown`：那是 board.mjs 的 describeKind() 的显示占位符，不是宿主声明的类型');
  for (const task of value.tasks) {
    assert.notEqual(task.kind, 'unknown', `${task.id} 的 kind 不许是 'unknown'：那会把"没声明"伪装成一个合法的 kind 值，页面上的「未声明」徽章就再也不会出现`);
  }
});

test('85. 第 14 轮：mine 用宿主身份判定 —— 自己那条 true、别人那条 false（与板上 @me 同一行）', async () => {
  const { definition } = await install({
    tasks: makeTasks(),
    memberName: 'alice',
    members: [
      { id: 's1', name: 'alice', role: 'lead', status: 'running', diagnostics: [] },
      { id: 's2', name: 'bob', role: 'teammate', status: 'running', diagnostics: [] },
    ],
  });
  const value = await definition.execute({}, { agent: AGENT });
  const byId = new Map(value.tasks.map((task) => [task.id, task]));

  assert.equal(byId.get('T1').mine, true, 'T1 的归属是 alice = 调用者自己');
  assert.equal(byId.get('T2').mine, false, 'T2 是 bob 的，不是我的');
  assert.deepEqual(
    value.tasks.filter((task) => task.mine === true).map((task) => task.id),
    ['T1', 'T3'],
    'alice 的两条（T1 在跑、T3 已完成）都是"我的"：状态不影响归属',
  );
  assert.equal(value.tasks.find((task) => task.id === 'T3').mine, true, 'T3 也是 alice 的（已完成不妨碍归属）');

  /* 与板上的 `@me` 对齐：**两份数据必须把"我"判成同一条任务**，
   * 否则会出现"板上说 T1 是 @me、payload 说 mine:false"这种自相矛盾。 */
  const meLine = value.board.split('\n').find((line) => line.includes('@me')) ?? '';
  assert.match(meLine, /T1/, `板上 @me 必须落在 T1 那一行（实际：${meLine}）`);

  /* 身份轴（SD-2）：这两条一起证明 mine **走的是 normalizeIdentity**，不是 `===`。
   *   - `'alice '`（内部/尾部多一个空格）→ **同一个人**；
   *   - `'Alice'`（只差大小写）→ **两个人**。 */
  const spacey = await install({ tasks: [{ ...hostTask('多一个空格', { id: 'SP' }), ownerName: 'alice ' }], memberName: 'alice' });
  assert.equal((await spacey.definition.execute({}, { agent: AGENT })).tasks[0].mine, true, '空白差异折叠后是同一个人（normalizeIdentity 的职责，不许用 === 顶替）');

  const cased = await install({ tasks: [{ ...hostTask('只差大小写', { id: 'CS' }), ownerName: 'Alice' }], memberName: 'alice' });
  assert.equal((await cased.definition.execute({}, { agent: AGENT })).tasks[0].mine, false, '大小写不同就是两个人（SD-2 明文裁决，宽容会把他人评审误判成自审）');
});

test('86. 第 14 轮：scopes / blockedBy / warnings 原样透传（不改写、不重算、不清化）', async () => {
  const rawTask = {
    ...hostTask('写域与依赖都要原样', { id: 'RAW' }),
    writeScopes: ['src/a/ b', 'plugin/host/index.js'],
    blockedBy: ['T1', 'GONE'],
    writeScopeWarnings: ['T9(@b) 与 T5(@d) 都声明了 src/', 'blockedBy: T1'],
  };
  const tasks = [rawTask, hostTask('依赖方', { id: 'T1', writeScopes: [], ownerName: 'bob' })];
  const { definition } = await install({ tasks });
  const value = await definition.execute({}, { agent: AGENT });
  const raw = value.tasks.find((task) => task.id === 'RAW');

  assert.deepEqual(raw.scopes, ['src/a/ b', 'plugin/host/index.js'], '写域原样：不截断、不合并、不改顺序');
  assert.deepEqual(raw.blockedBy, ['T1', 'GONE'], '依赖原样；`GONE` 这个不存在的 id 也照传——"已删除"是渲染层的说法，不是数据层的改写');
  assert.deepEqual(raw.warnings, ['T9(@b) 与 T5(@d) 都声明了 src/', 'blockedBy: T1'], '警告原样：不重算冲突、不聚合、不排序');

  /* 下面这两条才是"真的没被改写"的判据：`board.mjs` 的 clean() 会把 `@` 降级成全角 `＠`、
   * 把 `:` 降级成全角 `：`。payload 若也走一遍，页面与文本板就会显示**不同的字符串**，
   * 而"两份数据同源"的唯一可验证证据就是内容一致。 */
  assert.match(raw.warnings[0], /@b/, '警告里的 ASCII `@` 必须原样（clean() 会把它变成全角）');
  assert.doesNotMatch(raw.warnings[0], /＠/, 'payload 不许过 clean()：全角 `＠` 出现在这里就说明被渲染层改写过');
  assert.match(raw.warnings[1], /blockedBy: T1/, '警告里的 ASCII `:` 必须原样');

  /* 数组是**副本**：调用方改 payload 不许改到宿主对象上（`listTasks` 的返回值还可能被别处用）。 */
  assert.notEqual(raw.scopes, rawTask.writeScopes, '必须给副本，不许把宿主数组直接透出去');
  raw.scopes.push('bogus');
  assert.equal(rawTask.writeScopes.length, 2, '改 payload 不许改到宿主数据');
});

test('87. ★ 第 14 轮：gates 页面路径也带同一个 tasks（只加一条 = 没加，这正是 E_AUDIT_UNWIRED 的形状）', async () => {
  const hostTasks = [
    hostTask(FULL_DECLARATION, { id: 'impl-1' }),
    hostTask('没有声明块的活', { id: 'work-1', writeScopes: [], status: 'pending', ownerName: 'bob' }),
  ];
  const { teams, calls } = makeTeams({ tasks: hostTasks, memberName: 'alice' });

  const state = onSwitch(createBoardState(makeServiceCtx({ agentTeams: teams, agents: { get: () => AGENT } })));
  const gates = await state.gates(AGENT.id);
  assert.equal(gates.status, 'ok');

  assert.ok(
    Array.isArray(gates.tasks),
    '页面这条路径也必须带 tasks：只加工具那条，页面照样显示「宿主没有提供结构化任务数据」——'
      + '这正是 E_AUDIT_UNWIRED 当初的形状（码写了、没有发射点）',
  );
  assert.deepEqual(gates.tasks.map((task) => task.id), ['impl-1', 'work-1']);
  assert.equal(gates.tasks[0].kind, 'implementation', '页面上的 kind 必须已经解析出来（不是 `?`）');
  assert.equal(gates.tasks[0].mine, true);
  assert.equal(gates.tasks[1].mine, false);
  assert.match(gates.board, /impl/, '原有的 board 块一个字都不少');

  /* 两条路径必须讲同一个故事（D-14 的教训：只修一个入口，页面与工具就在讲两件事）。 */
  const tool = await install({ tasks: hostTasks, memberName: 'alice' });
  const toolValue = await tool.definition.execute({}, { agent: AGENT });
  assert.deepEqual(gates.tasks, toolValue.tasks, '页面与工具的结构化任务必须逐字段相同');

  /* 页面侧同样是**一次取数**：gates 只许读一次任务（board 与 tasks 同源）。 */
  assert.equal(calls.filter((call) => call[0] === 'listTasks').length, 1, 'gates 里 listTasks 只许一次');
});

test('88. 第 14 轮：「读不出来」与「零条」必须可区分：非数组时不带这个键，空板时给 []', async () => {
  /* ① 空板 = 读到了、确实零条 → 给 `[]`（页面：「板上没有任务」）。 */
  const empty = await install({ tasks: [], memberName: 'alice' });
  const emptyValue = await empty.definition.execute({}, { agent: AGENT });
  assert.deepEqual(emptyValue.tasks, [], '零条要给空数组：这才让页面敢说「读到了，就是零」');

  /* ② 宿主给了怪东西（非数组）= 读不出来 → **不带这个键**。
   * 若这里给 `[]`，页面上"拿不到"就长得和"零条"一模一样 —— 那是本项目点过名的红线。 */
  const garbage = await install({ tasks: 'not-an-array', memberName: 'alice' });
  const garbageValue = await garbage.definition.execute({}, { agent: AGENT });
  assert.equal(Object.hasOwn(garbageValue, 'tasks'), false, '读不出来就不许带 tasks（带 [] 会把"拿不到"伪装成"零条"）');
  assert.equal(garbageValue.taskCount, 0, '既有的 taskCount 口径不变（它不是数组就按 0 记）');

  /* ③ 页面路径同一条纪律。 */
  const garbageGates = onSwitch(createBoardState(
    makeServiceCtx({ agentTeams: makeTeams({ tasks: 'not-an-array', memberName: 'alice' }).teams, agents: { get: () => AGENT } }),
  )).gates(AGENT.id);
  const gateValue = await garbageGates;
  assert.equal(gateValue.status, 'ok');
  assert.equal(Object.hasOwn(gateValue, 'tasks'), false, '页面路径同样：读不出来就不带键');

  /* ④ 委派花名册那条路**没有任务板**，所以不带 `tasks`（`[]` 会说"零条"，而它其实没有板）。 */
  const subagents = makeSubagents({ entries: [{ kind: 'child', id: 's1', activity: 'running', label: 'x', depth: 1 }] });
  const { definition } = await rosterHost(subagents);
  const rosterValue = await definition.execute({}, { agent: AGENT });
  assert.match(rosterValue.board, /委派花名册/);
  assert.equal(Object.hasOwn(rosterValue, 'tasks'), false, '花名册没有任务板：不许带 tasks（哪怕是 []）');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * task-20：`execute` 里的**第二道门**
 *
 * 背景是 task-6 验收时我自己报出去的一条**对我不利**的证据：
 *   "`when` 返回 false 只保证执行器不把它放进模型可见清单。我实测绕过 `when`
 *    直接调 `execute`，它照样返回报告（ok=false / 阻断 1）。也就是说这是**一道**门，不是两道。"
 *
 * 用户那句话是「**我不让你用这个，它就不会去用**」。第一道门让它只在**模型侧**成立
 * （看不见就不调）；这一道门让它变成**结构性**的：绕过 `when` 也拒绝。
 *
 * ═══ 边界（必须和第 91/92 条一起读）═══════════════════════════════════════════
 * 它**防**：绕过 `when` 直接调 `execute`。
 * 它**不防**：
 *   - 有人直接改 `enabled` 那个变量（同一进程里的代码都能改）；
 *   - 有人改磁盘上的存储记录；
 *   - 宿主本身被篡改（那时"用户的意思"已经不是我们能读的东西了）。
 * 所以别把这个改动读成"现在安全了"——它把"取决于模型守规矩"降级成"取决于进程内没人改内存"，
 * 那是**强得多**的保证，但不是绝对保证。说准边界比多补一道门有用。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 造一个"用户关掉了插件"的宿主：真 apply + 存储里没有开启记录（= 默认关）。 */
async function disabledHost({ tasks = makeDeliverTasks() } = {}) {
  const kv = makeKv(); // 全新：没有任何记录 → 默认关
  const { teams, calls } = makeTeams({ tasks, role: 'lead' });
  const connection = makeConnection();
  const host = makePageHost({ kv, teams, connection });
  apply(host.ctx, {});
  await flush();
  /* 前提断言：这个宿主确实是"关"的状态，否则下面几条等于在测别的东西。 */
  const state = createBoardState(makeServiceCtx({ storage: kv.storage }));
  await state.hydrate();
  assert.equal(state.getState().enabled, false, '前提：这个宿主必须是"用户没开启"的状态');
  return { host, calls, kv, connection };
}

test('91. task-20 开关关着 → 直接调 `team_deliver.execute` 被**拒绝**（不是"判定为不可交付"）', async () => {
  const { host } = await disabledHost();
  const deliver = host.registrations.find((item) => item.definition.name === 'team_deliver').definition;

  /* 必须是**抛**，不能是返回一个 {ok:false} —— 后者会被读成"判定为不可交付"，
   * 而真相是"根本没有判定"。这两件事共用一个值，就是本项目最忌讳的混淆。 */
  await assert.rejects(
    () => deliver.execute({ tasks: makeDeliverTasks() }, { agent: AGENT }),
    (error) => {
      assert.equal(error.code, 'E_USER_DISABLED', `必须带明确的拒绝码（实际：${error.code}）`);
      assert.match(error.message, /用户/, '必须说清是**用户**关掉的，不是权限问题也不是服务坏了');
      assert.match(error.message, /台账页/, '必须指出去哪里恢复（回到台账页把开关打开）');
      return true;
    },
    '开关关着却仍然执行了判定：第二道门没生效',
  );
});

test('92. task-20 开关关着 → 直接调 `team_board.execute` 同样被拒绝（对称，缺一边就等于没接）', async () => {
  const { host } = await disabledHost();
  const board = host.registrations.find((item) => item.definition.name === 'team_board').definition;

  await assert.rejects(
    () => board.execute({}, { agent: AGENT }),
    (error) => {
      assert.equal(error.code, 'E_USER_DISABLED', `team_board 也必须用同一个码（实际：${error.code}）`);
      assert.match(error.message, /用户/);
      return true;
    },
    '只给 team_deliver 补门、board 没补 —— 那正是 E_AUDIT_UNWIRED 当初的形状',
  );
});

test('93. task-20 拒绝发生在**最外层**：`listTasks` 一次都没被调用', async () => {
  /* 这一条证明的是"短路"而不是"算完丢掉"。
   * 算完丢掉既浪费，也会让日志/计数看起来像"判定跑过了"，那是不诚实的。 */
  const { host, calls } = await disabledHost();
  const deliver = host.registrations.find((item) => item.definition.name === 'team_deliver').definition;
  const board = host.registrations.find((item) => item.definition.name === 'team_board').definition;

  await assert.rejects(() => deliver.execute({}, { agent: AGENT }));
  await assert.rejects(() => board.execute({}, { agent: AGENT }));

  const listCalls = calls.filter(([method]) => method === 'listTasks').length;
  assert.equal(listCalls, 0, `被拒绝的调用不许读任务（实际读了 ${listCalls} 次）`);

  /* 连 membership / listMembers 都不该碰：整条链在第一步就断了。 */
  assert.equal(
    calls.filter(([method]) => method !== 'listTasks').length,
    0,
    `被拒绝的调用不许碰宿主的任何其他方法（实际：${calls.map(([method]) => method).join(',') || '无'})`,
  );
});

test('94. task-20 开着的时候两个 `execute` 行为与改造前完全一致（别把正常路径改坏）', async () => {
  const { host, connection } = await disabledHost();
  const deliver = host.registrations.find((item) => item.definition.name === 'team_deliver').definition;
  const board = host.registrations.find((item) => item.definition.name === 'team_board').definition;

  /* 先在关着的宿主上确认拒绝…… */
  await assert.rejects(() => deliver.execute({}, { agent: AGENT }), (error) => error.code === 'E_USER_DISABLED');

  /* ……再用**同一个宿主**把开关打开，确认立刻恢复正常。这同时验证了
   * "内存状态先变、落盘随后"（`setEnabled` 的既有语义），以及门是**每次调用时**求值的，
   * 不是注册时抓一次的快照。 */
  const route = connection.routes.find((entry) => entry.path === STATE_PATH);
  await route.fetch({ json: async () => ({ enabled: true }) });

  const deliverValue = await deliver.execute({ tasks: makeDeliverTasks() }, { agent: AGENT });
  assert.deepEqual(Object.keys(deliverValue).sort(), ['blockerCount', 'ok', 'report', 'warningCount']);
  assert.match(deliverValue.report.split('\n')[0], /^交付判定：/, '开门之后必须回到正常判定');

  const boardValue = await board.execute({}, { agent: AGENT });
  assert.equal(typeof boardValue.board, 'string');
  assert.ok(boardValue.board.length > 0, '开门之后必须回到正常渲染');
  assert.equal(boardValue.taskCount, makeDeliverTasks().length);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * task-18：成员**申报**的改动 → `declaredChanges`
 *
 * 用户从第一天要的是「成员 A 和成员 B 互相知道他们在做什么」。①（任务板公开）
 * 与 ②（派活时贴整块板）已经在；这条补的是 ③：**干完告诉别人改了什么**。
 *
 * 整套设计只有一条红线：**申报绝不许混进 `changedPaths`**。
 * `changedPaths` 是 `delivery.mjs` 的审计输入，要与真实 diff 双向对账
 * （`E_UNREPORTED_CHANGES` / `E_CHANGED_PATHS_REQUIRED` / 越界判定全靠它）。
 * 混用之后，"我自己说改了 3 个文件"会被下游读成"已核实确实改了这 3 个文件"。
 * 这一组测试守的就是这条线。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 一份带申报改动的声明块（`changed` 两条）。 */
const CHANGED_BLOCK = declarationBlock([
  'kind: implementation',
  'changed:',
  '  - plugin/host/index.js',
  '  - plugin/test/host.test.mjs',
]);

test('83. task-18 `declaredChanges` 三态：有值 / `[]` / **不带键**（一律用 Object.hasOwn 判）', () => {
  /* 为什么必须用 `Object.hasOwn` 而不是 `!== undefined`：这两者在这里**不等价**。
   * `mapped` 是 `{ ...task }` 展开出来的，宿主若显式给了 `declaredChanges: undefined`，
   * 展开之后这个键**存在**（`hasOwn` 为真）而取值是 `undefined`（`!== undefined` 为假）。
   * 用 `!== undefined` 判，就会把"宿主给了个空壳键"与"真的没申报"混成一件。 */

  /* ① 有申报（2 条） */
  const declared = mapHostTask(hostTask(CHANGED_BLOCK));
  assert.equal(Object.hasOwn(declared, 'declaredChanges'), true, '申报了就必须有这个键');
  assert.deepEqual(declared.declaredChanges, ['plugin/host/index.js', 'plugin/test/host.test.mjs']);

  /* ② 申报了零个：键**必须在**，值是 `[]` —— 这是"交了报告说没改" */
  const declaredEmpty = mapHostTask(hostTask(declarationBlock(['kind: work', 'changed:'])));
  assert.equal(Object.hasOwn(declaredEmpty, 'declaredChanges'), true, '申报了零个也要有这个键');
  assert.deepEqual(declaredEmpty.declaredChanges, [], '申报了零个 → []');

  /* ③ 没申报：键**不许存在** —— 这是"没交报告"。两者含义完全不同，
   * 所以这里绝不接受 `[]` 兜底（`hasOwn` 为真而长度 0 也算错）。 */
  const notDeclared = mapHostTask(hostTask(declarationBlock(['kind: work'])));
  assert.equal(
    Object.hasOwn(notDeclared, 'declaredChanges'),
    false,
    `没申报时不许出现这个键（哪怕是 undefined 或 []），实际：${JSON.stringify(notDeclared.declaredChanges)}`,
  );

  /* ④ 连声明块都没有：同样不许带键 */
  const noBlock = mapHostTask(hostTask('就是一个普通任务，没有声明块'));
  assert.equal(Object.hasOwn(noBlock, 'declaredChanges'), false);
});

test('84. task-18 **`changedPaths` 始终不存在**：自我申报不许污染审计输入（本组命门）', () => {
  /* 反例形状：如果哪天有人"顺手"把申报写成 `changedPaths`，`delivery.mjs` 会拿它
   * 当真实 diff 去对账 —— 于是成员自己说改了 3 个文件，判定层就认为改的就是这 3 个。
   * 那正是《把自主申报当审计事实》这个病，所以下面逐条查所有可能带出 key 的路径。 */
  const cases = [
    ['带申报', mapHostTask(hostTask(CHANGED_BLOCK))],
    ['申报零个', mapHostTask(hostTask(declarationBlock(['kind: work', 'changed:'])))],
    ['没申报', mapHostTask(hostTask(declarationBlock(['kind: work'])))],
    ['无声明块', mapHostTask(hostTask('普通任务'))],
  ];
  for (const [label, mapped] of cases) {
    assert.equal(
      Object.hasOwn(mapped, 'changedPaths'),
      false,
      `${label}：映射结果不许带 changedPaths（那是 delivery.mjs 的审计输入，只能来自真实 diff）`,
    );
  }
});

test('85. task-18 两条路径都带 `declaredChanges`：`team_board` 工具 + `gates()` 页面', async () => {
  /* 为什么必须**两条都测**：「只修一个入口」正是 `E_AUDIT_UNWIRED` 当初的形状
   * （工具侧接了、页面侧没接，于是页面和工具在讲两个不同的故事，而且都不会响）。 */

  const tasks = [
    hostTask(CHANGED_BLOCK, { id: 'WITH' }),
    hostTask(declarationBlock(['kind: work', 'changed:']), { id: 'ZERO', writeScopes: [] }),
    hostTask(declarationBlock(['kind: work']), { id: 'NONE', writeScopes: [] }),
  ];

  /* ① 工具路径：`team_board` 输出的结构化 `tasks` */
  const toolHost = await install({ tasks });
  const toolValue = await toolHost.definition.execute({}, { agent: AGENT });
  assert.equal(Array.isArray(toolValue.tasks), true, '工具必须给出结构化 tasks（页面/调用方都读它）');

  const toolById = new Map(toolValue.tasks.map((entry) => [entry.id, entry]));
  assert.equal(Object.hasOwn(toolById.get('WITH'), 'declaredChanges'), true, '工具路径：有申报 → 带键');
  assert.deepEqual(toolById.get('WITH').declaredChanges, ['plugin/host/index.js', 'plugin/test/host.test.mjs']);
  assert.equal(Object.hasOwn(toolById.get('ZERO'), 'declaredChanges'), true, '工具路径：申报零个 → 带键且为 []');
  assert.deepEqual(toolById.get('ZERO').declaredChanges, []);
  assert.equal(Object.hasOwn(toolById.get('NONE'), 'declaredChanges'), false, '工具路径：没申报 → 不带键');

  /* `team_board` 的文本板也必须看得见申报（那是模型读的东西） */
  assert.match(toolValue.board, /✎申报 2/, '文本板上要有申报数量标记');

  /* ② 页面路径：`gates()` 的 payload.tasks，用的必须是**同一次** listTasks */
  const pageTeams = makeTeams({ tasks });
  const state = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: pageTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));
  const gates = await state.gates(AGENT.id);
  assert.equal(gates.status, 'ok');
  assert.equal(Array.isArray(gates.tasks), true, '页面路径同样要给出结构化 tasks');

  const pageById = new Map(gates.tasks.map((entry) => [entry.id, entry]));
  assert.equal(Object.hasOwn(pageById.get('WITH'), 'declaredChanges'), true, '页面路径：有申报 → 带键');
  assert.deepEqual(pageById.get('WITH').declaredChanges, ['plugin/host/index.js', 'plugin/test/host.test.mjs']);
  assert.equal(Object.hasOwn(pageById.get('ZERO'), 'declaredChanges'), true, '页面路径：申报零个 → 带键且为 []');
  assert.deepEqual(pageById.get('ZERO').declaredChanges, []);
  assert.equal(Object.hasOwn(pageById.get('NONE'), 'declaredChanges'), false, '页面路径：没申报 → 不带键');

  /* ③ `listTasks` 只许调一次：板、结构化 tasks、判定三者必须同一份快照。
   * 二次取数会造出"文本板 3 条、payload 2 条"这种两份数据互相打脸的局面。 */
  const listCalls = pageTeams.calls.filter(([method]) => method === 'listTasks').length;
  assert.equal(listCalls, 1, `gates() 只许读一次任务（实际 ${listCalls} 次）`);

  const toolListCalls = toolHost.team.calls.filter(([method]) => method === 'listTasks').length;
  assert.equal(toolListCalls, 1, `team_board 只许读一次任务（实际 ${toolListCalls} 次）`);

  /* ④ 两条路径给出的申报必须**逐字相同**（同源同口径的正面证据） */
  for (const id of ['WITH', 'ZERO', 'NONE']) {
    assert.deepEqual(
      pageById.get(id).declaredChanges,
      toolById.get(id).declaredChanges,
      `${id}：页面与工具给出的申报必须一致（两个入口讲两个故事比一个讲错更糟）`,
    );
  }
});

test('86. task-18 `declaredChanges` 不进 `contract`，且不改 `kind` 的既有口径', () => {
  const mapped = mapHostTask(hostTask(CHANGED_BLOCK));

  /* 报告不是条款：`contract` 里不许出现 `changed` */
  assert.equal(
    Object.hasOwn(mapped.contract, 'changed'),
    false,
    `declaredChanges 不许混进 contract（实际：${JSON.stringify(mapped.contract)}）`,
  );
  /* 同一份块里的 kind 必须照旧被填上：加申报不许把 D-14 的接线搞坏 */
  assert.equal(mapped.kind, 'implementation');

  /* 反例自检：真正的契约字段仍然必须落进 contract —— 否则上面那条会被"contract 永远空"满足 */
  const withContract = mapHostTask(hostTask(declarationBlock([
    'kind: implementation',
    'acceptance:',
    '  - 一条验收',
    'changed:',
    '  - a.js',
  ])));
  assert.deepEqual(withContract.contract, { acceptance: ['一条验收'] }, '契约字段照旧落地，且不含 changed');
  assert.deepEqual(withContract.declaredChanges, ['a.js']);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * task-19：开关**默认关**
 *
 * 用户的原话：「**而且应该是默认关闭。** 但是我们这个会话就不用了。」
 *
 * 为什么默认必须是关：用户对这个开关的定义是「**我不让你用这个，它就不会去用**」。
 * 默认开会让这句话变成空话 —— "我没主动让它用"与"它已经在用"同时成立，
 * 开关就没表达任何东西。而这个插件会往模型提示里加两个工具、影响模型每一步的行为：
 * **一个默认就生效的插件，等于没经用户同意就占据了他的工具面。**
 *
 * 这一组钉的是三件事，缺一条这个改动就不完整：
 *   ① 全新宿主 → 默认关（两个工具都不可见）
 *   ② 用户主动开过 → 持久化成 true，重启后**不许**被默认值盖掉
 *   ③ payload 的 `enabled` 与 `when` 的实际行为一致（页面显示不许和真实行为打架）
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 全新宿主（存储里没有任何记录）+ 真 apply + 真路由，用来问"默认到底是什么"。 */
async function freshHost({ teams } = {}) {
  const kv = makeKv(); // 没有任何 state 记录 = 全新安装
  const connection = makeConnection();
  const host = makePageHost({ kv, teams: teams ?? makeTeams({ role: 'lead', tasks: makeTasks() }).teams, connection });
  apply(host.ctx, {});
  await flush();
  const board = host.registrations.find((item) => item.definition.name === 'team_board');
  const deliver = host.registrations.find((item) => item.definition.name === 'team_deliver');
  return { kv, connection, host, board, deliver };
}

test('87. task-19 全新宿主（存储里没有任何记录）→ `enabled()` 是 **false**', async () => {
  const { kv } = await freshHost();
  assert.deepEqual(kv.store.state, {}, '前提：存储里确实没有任何记录（这才是"全新安装"）');

  /* 直接问状态机本身，不经过 when ——这是最接近"默认值是多少"的断言。
   * **这里故意不用 `onSwitch`**：这条测的就是"什么都不做时它是关的"，
   * 包一层就等于先把开关打开再断言它默认是关的 —— 自己把自己的前提消掉了。 */
  const state = createBoardState(makeServiceCtx({ storage: kv.storage }));
  await state.hydrate();
  assert.equal(
    state.getState().enabled,
    false,
    '默认必须是**关**：默认开会让"我不让你用，它就不会去用"这句话变成空话',
  );
});

test('88. task-19 全新宿主 → `team_board` 与 `team_deliver` 的 `when` **都**返回 false', async () => {
  const { board, deliver } = await freshHost();

  assert.equal(board.options.when({ agent: AGENT }), false, '默认关：板不可见（连真成员也看不见）');
  assert.equal(
    deliver.options.when({ agent: AGENT }),
    false,
    '默认关：裁决同样不可见 —— 只关一个正是 task-6 修掉的那个形状',
  );
});

test('89. task-19 用户主动开过 → 持久化成 true，重启后不许被默认值盖掉', async () => {
  /* 这条守的是"默认值只在用户没表态时说话"。如果 hydrate 写错了（比如每次都先设成默认），
   * 用户点开的开关会在每次重启后自己关掉——那比默认开还糟。 */
  const kv = makeKv(); // 全新
  const first = createBoardState(makeServiceCtx({ storage: kv.storage }));
  await first.hydrate();
  assert.equal(first.getState().enabled, false, '全新 → 关');

  await first.setEnabled(true); // 用户点了开
  assert.deepEqual(kv.store.state.enabled, { enabled: true }, '必须真的落盘（否则重启就丢）');

  const second = createBoardState(makeServiceCtx({ storage: kv.storage })); // 模拟重启
  await second.hydrate();
  assert.equal(second.getState().enabled, true, '重启后必须读回用户的"开"，默认值不许盖掉它');

  /* 反向自检：同一份磁盘，把记录改成 false 之后重启应当是 false。
   * 没有这条，上面那句会被"hydrate 总是设成 true"满足。 */
  kv.store.state.enabled = { enabled: false };
  const third = createBoardState(makeServiceCtx({ storage: kv.storage }));
  await third.hydrate();
  assert.equal(third.getState().enabled, false, '记录是 false → 读回 false（按记录，不按默认）');
});

test('90. task-19 payload 的 `enabled` 与 `when` 的实际行为必须一致（页面显示不许和真实行为打架）', async () => {
  /* 界面顶栏那颗开关读的就是这个 payload。如果 payload 说"开"而 when 说"不可见"，
   * 用户会看到一颗亮着的开关、而工具其实调不到 —— 那是最难查的一类不一致。 */
  const check = async ({ kv, connection, board, deliver }) => {
    const envelope = await (await connection.routes[0].fetch({ json: async () => ({}) })).json();
    const shown = envelope.value.enabled;
    assert.equal(
      board.options.when({ agent: AGENT }),
      shown,
      `payload.enabled=${shown}，但 team_board 的 when 给了相反答案：页面在说假话`,
    );
    assert.equal(
      deliver.options.when({ agent: AGENT }),
      shown,
      `payload.enabled=${shown}，但 team_deliver 的 when 给了相反答案`,
    );
    assert.deepEqual(kv.store.state, envelope.value.enabled === false ? {} : kv.store.state);
    return shown;
  };

  /* ① 全新宿主：payload 说关，两个工具都不可见 */
  assert.equal(await check(await freshHost()), false, '全新宿主 payload 必须是 false');

  /* ② 用户开启后：payload 说开，两个工具都可见 */
  const kv = makeKv({ enabled: true });
  const connection = makeConnection();
  const host = makePageHost({ kv, teams: makeTeams({ role: 'lead', tasks: makeTasks() }).teams, connection });
  apply(host.ctx, {});
  await flush();
  const onBoard = host.registrations.find((item) => item.definition.name === 'team_board');
  const onDeliver = host.registrations.find((item) => item.definition.name === 'team_deliver');
  assert.equal(
    await check({ kv, connection, board: onBoard, deliver: onDeliver }),
    true,
    '存储里 {enabled:true} → payload 必须说 true',
  );
});

/* ------------------------------------------------------------------------- */
/* ⑦ 提示词层：开会纪律（第 18 轮）                                            */
/*                                                                            */
/* 判定层 `E_PROPOSAL_UNREVIEWED` / `E_QUESTIONS_UNANSWERED` 只在"存在 proposal */
/* 任务"时才可能触发。模型若拿到任务直接开干、一条提案都不建，两条判据永远     */
/* 不会看一眼 —— 所以让模型知道"先提案"的那段文字，本身就是产品的一部分。     */
/*                                                                            */
/* 而它唯一的落点是工具描述：本插件进系统提示词的唯一通道是                    */
/* `ctx.systemPrompt.tools(...)`，描述跟着工具走。用户关掉总开关时工具不注册， */
/* 描述一起消失，规则**不可能泄漏到关着开关的会话里**。下面 91–93 钉住"写得对"， */
/* 94–95 钉住"没有扩散到别处"。                                                */
/* ------------------------------------------------------------------------- */

test('91. 开会纪律写进了 team_board 的描述，五个词必须逐字在场', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  /* 逐字断言，不接受"意思对就行"：这五个词是判定层真正读的字段名，
   * 模型照着描述建任务时打错的每一个字，都会变成一条判据看不见的僵尸任务。 */
  for (const word of ['proposal', 'openQuestions', 'reviewedTaskId', 'answered', 'implementation']) {
    assert.ok(
      definition.description.includes(word),
      `team_board 的描述里必须出现 \`${word}\`（逐字）`,
    );
  }
});

test('92. 例外条款在场：小改动可以直接做，但必须写明为什么跳过', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  /* 没有例外条款，这套流程会退化成形式主义：改个错字也要走三轮会议。
   * 有了例外却没有"写明理由"，它又会退化成一句万能的"太小了"。两句都要在。 */
  assert.ok(definition.description.includes('【例外】'), '必须有明确的例外段落');
  assert.ok(
    definition.description.includes('跳过提案'),
    '例外必须要求写明**为什么跳过提案**，否则例外就是后门',
  );
});

test('93. 开会纪律里没有任何数字门槛（开关本身就是例外机制）', async () => {
  const { definition } = await install({ tasks: makeTasks() });
  /* 用户明确反对再加一层阈值："超过 N 个文件才提案"这种口径会让模型去数文件，
   * 而不是判断这件事要不要商量；而且任何阈值都会立刻被当成钻空子的标准。 */
  assert.doesNotMatch(definition.description, /超过\s*\d/, '不许出现「超过 N」式门槛');
  assert.doesNotMatch(definition.description, /\d+\s*个文件/, '不许按文件数划线');
  assert.doesNotMatch(definition.description, /\d+\s*行以上/, '不许按行数划线');
});

test('94. team_deliver 只指路到 team_board，不复述流程', async () => {
  const { deliverDefinition } = await install({ tasks: makeTasks() });
  assert.ok(
    deliverDefinition.description.includes('team_board'),
    'team_deliver 提到开会纪律时必须指路到 team_board',
  );
  /* 同一条事实说两遍，将来改的时候必漏一遍 —— 这一条就是防那种漂移的。 */
  assert.ok(
    !deliverDefinition.description.includes('openQuestions'),
    'team_deliver 不许复述开会流程（字段名一个都不该出现）',
  );
});

test('95. 规则文本没有扩散到 patch / package.json / client.js', async () => {
  const { readFileSync } = await import('node:fs');
  /* 规则一旦被抄进 patch 或客户端，开关就管不住它了：那两个东西不随工具的
   * `when` 消失。这条测试守的是"总开关能关掉一切"这个性质本身。 */
  for (const relative of ['../cordis.patch.yml', '../package.json', '../client.js']) {
    const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.ok(!text.includes('先别开工'), `${relative} 里不许出现开会纪律正文`);
    assert.ok(!text.includes('跳过提案'), `${relative} 里不许出现例外条款`);
  }
});

/* ------------------------------------------------------------------------- */
/* 96–98（task-11）：成员被中断是常态，「继续」是恢复口令                        */
/*                                                                            */
/* 用户原话：「因为本地环境不是很稳定，我的建议是只要发**继续**，然后这一点也可以 */
/* 记在插件里。就是只是在**提示词层面**体现。」                                */
/*                                                                            */
/* 这不是安慰话，是这套协作的运行前提：实测一晚中断过七八次。带头的人若把        */
/* "没消息"读成"它死了"，会做出两个都很贵的误判——重派（和它自己撞写域）或放弃   */
/* （其实活已经做完了）。                                                      */
/* ------------------------------------------------------------------------- */

test('96. 两个描述里都必须有「继续」与「中断」——分开断言，防止只删一处', async () => {
  const { definition, deliverDefinition } = await install({ tasks: makeTasks() });

  /* **两个常量各查一遍**，不用一个循环合并：合并之后"只删掉其中一段"仍然可能
   * 因为另一段还在而变绿 —— 那这条断言的保护范围就缩水了一半。
   * 两处都该有的原因：`team_board` 是"要不要催/要不要重派"时读的；
   * `team_deliver` 是"它到底做完没有"时读的。两个场景都会撞上中断。 */
  assert.ok(
    definition.description.includes('继续'),
    'team_board 的描述里必须有恢复口令「继续」——没有它，成员一被中断就只剩"重派"这一条路',
  );
  assert.ok(
    definition.description.includes('中断'),
    'team_board 的描述里必须说明「中断」这件事，否则「继续」没有指代对象',
  );
  assert.ok(
    deliverDefinition.description.includes('继续'),
    'team_deliver 的描述里同样要有「继续」：判定"做完没有"时也要知道成员只是被打断了',
  );
  assert.ok(
    deliverDefinition.description.includes('中断'),
    'team_deliver 的描述里同样要说明「中断」',
  );

  /* 补：第 1 条的**后半段**（不要因为一次无消息失败就判死、更不要立刻重派）
   * 原来完全无人守 —— 独立验收用变异证明了：把 TOOL 里「看到一次『无消息失败』
   * 不要判定它失败，更不要立刻重派——重派会和它自己撞写域」整段删掉，
   * 119 条照样全绿。而这一段恰恰是代价最大的那条知识：
   * 重派会和成员自己撞写域，两个人在改同一批文件。
   * 断言「重派」这个词与「写域」这个后果都在 team_board 侧（交付侧不许有，见 98）。 */
  assert.ok(
    definition.description.includes('重派'),
    'team_board 的描述里必须出现「重派」这件事 —— 它是这条纪律唯一被制止的动作',
  );
  assert.ok(
    definition.description.includes('写域'),
    'team_board 的描述里必须说明重派的代价是「撞写域」，否则读者不知道为什么不能重派',
  );
});

test('97. 判断「做完没有」的方法在先看盘：mtime + 跑测试；要求立刻落盘并更新状态', async () => {
  const { deliverDefinition } = await install({ tasks: makeTasks() });
  const text = deliverDefinition.description;

  /* 第 3 条的可判据：**先看盘再看进程**。没有 mtime 这条，读者只会去猜"它是不是死了"。 */
  assert.ok(text.includes('mtime'), '必须给出「看文件 mtime」这个可操作口径');
  /* 这里**不能**只断言 `includes('测试')` —— 那条是空转的：DELIVER 描述里本来就有
   * 「判定全部来自 delivery.mjs（137 条测试）」，任一新句删掉它仍然满足。
   * （独立验收用变异证明了：把"再跑那个文件对应的测试"整句删掉，119 条照样全绿。）
   * 所以钉**可操作的那半句**：必须是"跑那个文件对应的测试"。 */
  assert.ok(
    text.includes('跑那个文件对应的测试'),
    '必须给出「跑那个文件对应的测试」这个可操作口径 —— 只说"测试"两个字会被旧文案里的「137 条测试」满足，等于没断言',
  );
  assert.ok(
    text.includes('先看盘'),
    '必须明确「先看盘再看进程」的顺序，否则读者还是会先去猜进程状态',
  );

  /* 第 4 条的可判据：对成员的要求 —— 立刻落盘 + 更新状态。
   * 这两件事分开测：只说"立刻落盘"会让看板继续停在 pending，
   * 只说"更新状态"会让磁盘上没有东西。 */
  assert.ok(text.includes('立刻落盘'), '必须要求"立刻落盘"（磁盘上的东西才是唯一成果）');
  assert.ok(
    text.includes('更新任务状态'),
    '必须要求"更新任务状态"——否则活做完了看板还停在 pending，判定层会如实报未完成',
  );
});

test('98. 四条内容不许跨常量串味：TOOL 不提 mtime，DELIVER 不复述重派纪律', async () => {
  const { definition, deliverDefinition } = await install({ tasks: makeTasks() });

  /* 这不是"两边都写一遍更保险"。同一条事实说两遍，将来改的时候必漏一遍 ——
   * 这个项目已经栽过五次（QUALITY_KINDS 三副本、KNOWN_KINDS 与 KINDS 逐字重复、
   * includeCompleted 四处 0、两份译文、board.mjs 的 verbatim 例外）。
   *
   * 「看 mtime」属于**交付判定时**该想的事；写进 team_board 会让读板的人去查文件，
   * 而那一步该发生在他要判断"能不能收"的时候。 */
  assert.ok(
    !definition.description.includes('mtime'),
    'team_board 的描述里不许出现 mtime —— 那是交付判定的口径，写在这里只会稀释开会纪律',
  );

  /* 「重派会撞写域」是 team_board 侧（要不要催、要不要重派）的纪律，DELIVER 侧不许复述。
   * 用"重派"这个词判断而不是长篇匹配：只要它在 DELIVER 里出现，
   * 就说明流程被抄了一遍。
   *
   * 但词面匹配能被同义词绕开（独立验收用变异证明过：把「重派」改写成「重新派工」
   * 抄进 DELIVER，98 照样全绿）。所以再钉一个**代价短语**「撞写域」：
   * 抄纪律的人几乎必然连代价一起抄，而这两个词同时换掉的成本远高于只换一个。 */
  assert.ok(
    !deliverDefinition.description.includes('重派'),
    'team_deliver 的描述里不许复述「重派」的纪律 —— 它只该指路，不该再讲一遍',
  );
  assert.ok(
    !deliverDefinition.description.includes('撞写域'),
    'team_deliver 的描述里不许出现「撞写域」——那是 team_board 侧的代价说明，抄过来就是复述',
  );
});



/* ═══════════════════════════════════════════════════════════════════════════
 * P0（第 15 轮）：`gates.mjs` 的两态 shadow
 *
 * `gates.mjs` 有 940 行 / 18 个码，此前没有任何生产代码 import 它 ——
 * 也就是说这些人写了两年的完成门禁，**从没对一条真实任务跑过**。
 * 这一轮把它接上，但只算不拦：结论原样进 `payload.shadow`，`ok` 一个字节不动。
 *
 * 下面这组测试守的不是"shadow 的结论对不对"（那要等 enforce 那一轮才有意义），
 * 而是三条**接线本身**的纪律：
 *   ① shadow 的码一个字都不许进 blockers —— 否则一个从没验收过的判据就在改收不收活
 *   ② 必须报「宿主交了哪几项输入」—— 四项全缺时结论是"判不动"，不是"没问题"
 *   ③ 三态不许合并 —— 'empty'（判了、零条码）与 'unavailable'（判不了）必须可分辨
 * ═══════════════════════════════════════════════════════════════════════════ */

test('P0-shadow ①：shadow 的码一个字都不许进 blockers（接线不许改写判定）', async () => {
  /* 夹具故意用一份**完整声明块**的实现类任务：这样 canDeliver 与 evaluateCompletion
   * 都会想说话。要点是两者说各自的话，谁也不许把自己的码倒进对方的桶里。 */
  const tasks = [hostTask(FULL_DECLARATION, { id: 'IMPL' })];
  const pageTeams = makeTeams({ tasks });
  const state = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: pageTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));

  const gates = await state.gates(AGENT.id);
  assert.equal(gates.status, 'ok');
  assert.ok(gates.shadow !== undefined, 'shadow 必须挂在 payload 上');

  const blockerCodes = new Set((Array.isArray(gates.blockers) ? gates.blockers : []).map((b) => b.code));
  const warningCodesInPayload = new Set((Array.isArray(gates.warnings) ? gates.warnings : []).map((w) => w.code));
  const shadowCodes = (gates.shadow.rows ?? []).map((row) => row.code);

  /* 这一条是整组测试里最重要的：如果 shadow 的码漏进 blockers，
   * 页面上的"能不能交付"就被一个从没验收过的判据改写了。 */
  for (const code of shadowCodes) {
    assert.equal(blockerCodes.has(code), false, `shadow 的码 ${code} 不许出现在 blockers 里`);
    assert.equal(warningCodesInPayload.has(code), false, `shadow 的码 ${code} 也不许混进 warnings —— shadow 是独立的一块`);
  }
});

test('P0-shadow ②：必须报「宿主交了哪几项输入」，四项全缺时不许被读成"没问题"', async () => {
  const tasks = [hostTask(FULL_DECLARATION, { id: 'IMPL' })];
  const pageTeams = makeTeams({ tasks });
  const state = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: pageTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));

  const { shadow } = await state.gates(AGENT.id);

  /* 形状：四项布尔，一个都不能省。省掉任何一项，读的人就得去翻源码才知道这一项有没有交底。 */
  assert.deepEqual(
    Object.keys(shadow.inputs).sort(),
    ['diffPaths', 'meta', 'payload', 'receipts'],
    'inputs 必须显式列出这四项 —— 少一项就分不清"没交"和"交了空"',
  );
  /* 现状真值：宿主这一侧四项全没有（见 host/index.js 里 1407 行那段已查实的注释）。
   * 写成断言是为了让"哪天真的接上了审计输入"这件事必须有人来改这条测试，
   * 而不是悄悄变绿。 */
  assert.deepEqual(
    shadow.inputs,
    { payload: false, receipts: false, diffPaths: false, meta: false },
    '宿主目前没有任何一项完成门禁的输入 —— 这是事实，不是缺陷，但要写出来',
  );

  /* 反例自检：`status` 与 `inputs` 必须**同时**被读到，
   * 否则一屏"零个码"会被读成"全部通过"——那正是本项目最不能犯的错。 */
  assert.equal(shadow.status === 'empty' || shadow.status === 'ok', true,
    `status 必须是 empty 或 ok（实际 ${shadow.status}）—— 有待判任务时不许报 unavailable`);
  if (shadow.status === 'empty') {
    assert.equal(
      shadow.inputs.diffPaths,
      false,
      '空的影子结论必然伴随"没交输入"——若出现"零个码 + 输入齐全"，说明这组夹具已经过时，需要重看',
    );
  }
});

test('P0-shadow ③：空 ≠ 不可用 —— 零条任务 / 读不出来，两种说法', async () => {
  /* 零条任务：**判了零条**，不是"判过且全过"。
   * 所以是 'unavailable' + reason='no-tasks'，不是 'empty'。
   * 'empty' 留给"判过至少一条、且一条码都没有"那一态 —— 那才是结论。
   * 两种说法必须分开，否则"板上什么都没有"会被页面读成"门禁通过"。 */
  const emptyTeams = makeTeams({ tasks: [] });
  const emptyState = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: emptyTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));
  const empty = await emptyState.gates(AGENT.id);
  assert.equal(empty.shadow.status, 'unavailable', '一条任务都没有 → 没判成，不许说 empty');
  assert.equal(empty.shadow.reason, 'no-tasks', 'reason 必须分清"没有任务"与"没有一条判得动"');
  assert.deepEqual(empty.shadow.rows, []);
  assert.equal(empty.shadow.totalTasks, 0);
  assert.equal(empty.shadow.judgedTasks, 0);

  /* 读不出来：listTasks 返回非数组 → tasks 为 []（mapHostTaskList 的口径），
   * 所以这里 shadow 仍是 'empty'。真正不可用的是"取数都失败了"那条路径，
   * 它由 gates() 外层的 unavailable 兜住 —— 两层不许混成一个说法。 */
  const brokenTeams = makeTeams({ tasks: null });
  const brokenState = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: brokenTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));
  const broken = await brokenState.gates(AGENT.id);
  if (broken.status === 'ok') {
    assert.equal(
      typeof broken.shadow.status,
      'string',
      '取数成功时必须给 shadow 一个明确状态',
    );
  } else {
    assert.equal(broken.shadow, undefined, '整块取数失败时不挂 shadow —— 页面读不到这个键就知道"没跑到这一步"');
  }
});

test('P0-shadow ④：shape 闭合 —— 每行都带 taskId / code / message，且 taskId 真能对上任务', async () => {
  const tasks = [
    hostTask(FULL_DECLARATION, { id: 'IMPL' }),
    hostTask(declarationBlock(['kind: work']), { id: 'WORK', writeScopes: [] }),
  ];
  const pageTeams = makeTeams({ tasks });
  const state = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: pageTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));

  const { shadow } = await state.gates(AGENT.id);
  const ids = new Set(tasks.map((t) => t.id));

  assert.equal(shadow.totalTasks, tasks.length, 'totalTasks 必须等于这一轮真正判过的条数');
  assert.equal(typeof shadow.failedTasks, 'number', 'failedTasks 必须是数字（0 也要写出来）');
  assert.equal(shadow.mode, 'shadow', 'mode 必须自曝是 shadow —— 读 payload 的人不用去翻源码');

  for (const row of shadow.rows) {
    assert.equal(typeof row.taskId, 'string', '每行必须带 taskId');
    assert.equal(ids.has(row.taskId), true, `taskId ${row.taskId} 必须真的对应一条任务，不许是猜的`);
    assert.equal(typeof row.code, 'string');
    assert.ok(row.code.length > 0, '空码进 shadow 就没法解释，源实现里已经过滤掉');
    assert.equal(typeof row.message, 'string');
  }
});

test('P0-shadow ⑤：判不动的任务不许被读成"没问题" —— 零码有两种成因', async () => {
  /* 这一条是实测挖出来的，不是推演出来的。
   *
   * `evaluateCompletion` 对一条"什么都没判"的任务返回 `{ ok: true, errors: [] }`，
   * 与"判了、全都过"**逐字相同**。实测语料（21 条真实形状）里：
   *   gates 真判了 3 条、判不动 18 条（都没有 kind）
   * 如果 shadow 只报"9 条码"，读的人会把另外 18 条当成"没问题" —— fail-open。
   *
   * 所以 `judgedTasks` / `skippedTasks` / `skipped` 与 `rows` 同等重要，缺一不可。 */

  /* 夹具：一条有 kind（judgable）、一条没有 kind（no-kind）。 */
  const tasks = [
    hostTask(FULL_DECLARATION, { id: 'JUDGED' }),
    hostTask('普通说明，没有 team-board 块', { id: 'NOKIND', writeScopes: ['plugin/host/index.js'] }),
  ];
  const pageTeams = makeTeams({ tasks });
  const state = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: pageTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));

  const { shadow } = await state.gates(AGENT.id);

  assert.equal(shadow.totalTasks, 2, '两条都要计入总数');
  assert.equal(shadow.judgedTasks, 1, '只有带 kind 的那条会被 gates 判');
  assert.equal(shadow.skippedTasks, 1, '没有 kind 的那条必须计入"判不动"，不许静默消失');
  assert.deepEqual(
    shadow.skipped.map((item) => [item.taskId, item.reason]),
    [['NOKIND', 'no-kind']],
    '跳过必须具名：哪一条、为什么',
  );

  /* 最关键的一条：判不动 ≠ 通过。 */
  assert.notEqual(
    shadow.status,
    'empty',
    '"判不动"与"判了零码"是两个结论，status 不许都落在 empty 上 —— empty 读起来像"没问题"',
  );

  /* 反向：judged + skipped 必须恒等于 total。
   * 少了任何一条都会让"18 条去哪了"无从回答。 */
  assert.equal(
    shadow.judgedTasks + shadow.skippedTasks,
    shadow.totalTasks,
    '判过的 + 判不动的必须等于总数 —— 否则有任务在账外',
  );
});

test('P0-shadow ⑥：全部判不动 → status 是 unavailable，不是 empty', async () => {
  /* 极端但真实的形状：整个板上一条有 kind 的任务都没有
   * （真实 21 条里 18 条如此，只差没人把 21 条全写成没声明）。 */
  const tasks = [
    hostTask('甲，无块', { id: 'A', writeScopes: ['x'] }),
    hostTask('乙，无块', { id: 'B', writeScopes: ['y'] }),
  ];
  const pageTeams = makeTeams({ tasks });
  const state = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: pageTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));

  const { shadow } = await state.gates(AGENT.id);
  assert.equal(shadow.status, 'unavailable', '一条都没判成 → unavailable');
  assert.equal(shadow.reason, 'no-judged', 'reason 必须说清是哪一种 unavailable（没任务 / 没一条判得动）');
  assert.equal(shadow.judgedTasks, 0);
  assert.equal(shadow.skippedTasks, 2);
  assert.deepEqual(shadow.rows, [], '一条都没判时 rows 必然为空 —— 但它的含义是"没判"，不是"全过"');
});

test('P0-shadow ⑦：proposal 类任务 gates 不判，必须如实算进"判不动"', async () => {
  /* `contract.mjs` 的 KINDS 有四个，但 gates 只分支 QUALITY_KINDS + work。
   * `proposal` 落在两者之外 —— 不判。这一条钉住"派生集合"这件事：
   * 如果哪天 gates 开始判 proposal，这条会红，提醒有人去改 shadow 的口径。 */
  const tasks = [
    hostTask(declarationBlock(['kind: proposal', 'acceptance:', '  - 方案讲清楚', 'verify:', '  - 人读一遍']), { id: 'PROP' }),
  ];
  const pageTeams = makeTeams({ tasks });
  const state = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: pageTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));

  const { shadow } = await state.gates(AGENT.id);
  assert.equal(shadow.judgedTasks, 0, 'proposal 目前不在 gates 的判定分支里');
  assert.equal(shadow.skippedTasks, 1);
  assert.equal(shadow.skipped[0].reason, 'kind-not-judged');
  assert.equal(shadow.skipped[0].kind, 'proposal', '必须写出是哪个 kind 没被判定 —— 否则说不清为什么跳过');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P2-3：会议账本接进 `/state`（任务树里的 `team-board-meeting` 围栏块）
 *
 * 这组守三件事，都**不是**"账本内容对不对"（那是 `ledger.mjs` 的 62 条测试）：
 *   ① 三态在**字段上**分得开 —— 'none'（板上真没有）与 'unreadable'（有但读不出来）
 *      绝不许靠"码列表为空"这种间接信号区分。那是本项目点过名的红线（空 ≠ 不可用）。
 *   ② 会议任务必须被**显式**移出 shadow 的两个分母 —— 不是静默跳过。
 *   ③ `judgedTasks` 与 `withInput` 是两个分母，不许合并。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 拼一个 `team-board-meeting` 账本块：与 `declarationBlock` 同一套拼法，只换 info 标。 */
function meetingBlock(lines) {
  return [`${DECL_FENCE}team-board-meeting`, ...lines, DECL_FENCE].join('\n');
}

/** 一份合法的会议头块。 */
const MEETING_PARENT = meetingBlock(['meeting: m-01', 'preset: standard@1', 'status: running']);

test('P2-3 ①：板上一条账本围栏都没有 → state=none，而它是**结论**不是失败', () => {
  const ledger = ledgerPayload([hostTask('普通说明，没有声明块', { id: 'N1' })]);

  assert.equal(ledger.state, 'none');
  assert.equal(ledger.readable, true, 'none 是可读的结论：信息完整，不是"读不出来"');
  assert.equal(ledger.reason, null, 'none 不该带"读不出来的成因"');
  assert.equal(ledger.meetingTasks, 0);
  assert.equal(ledger.meeting, null);
  assert.deepEqual(ledger.cards, []);
  assert.deepEqual(ledger.codes, []);
  assert.deepEqual(ledger.counts, { stages: 0, cards: 0, errors: 0, warnings: 0 });
});

test('P2-3 ②：有围栏但读不出来 → state=unreadable，且与 none 在**字段**上分得开', () => {
  /* 块没闭合：围栏在、解析不出来。这正是"读不出来"最典型的那种。 */
  const broken = hostTask(
    `${DECL_FENCE}team-board-meeting\nmeeting: m-01\npreset: standard@1`,
    { id: 'B1' },
  );
  const ledger = ledgerPayload([broken]);

  assert.equal(ledger.state, 'unreadable');
  assert.equal(ledger.readable, false, 'readable=false 是给**代码**读的判据：不许渲染成空态');
  assert.equal(typeof ledger.reason, 'string');
  assert.ok(ledger.reason.length > 0);
  assert.ok(ledger.meetingTasks >= 1, '围栏在 → 它算一条会议任务');
  assert.ok(ledger.codes.includes('E_LEDGER_PARTIAL'), '读不出来必须点名那个拦截码');
  assert.equal(ledger.meeting, null);

  /* 红线断言：三态必须靠字段区分。若某天有人把判据改成"码列表为空就是没有会议"，
   * 这四条会从不同角度一起红。 */
  const none = ledgerPayload([hostTask('什么都没有', { id: 'N2' })]);
  assert.notEqual(none.state, ledger.state);
  assert.notEqual(none.readable, ledger.readable);
  assert.notEqual(none.reason, ledger.reason);
  assert.notEqual(none.meetingTasks, ledger.meetingTasks);
});

test('P2-3 ③：父块 + 阶段回执齐全 → state=ok，账本与卡片都带出来', () => {
  const tasks = [
    hostTask(MEETING_PARENT, { id: 'MP' }),
    hostTask(meetingBlock([
      'meeting: m-01',
      'stage: challenge',
      'attempt: 1',
      'status: done',
      'produced:',
      '  - questions',
      'card.claim: 需求要先问清楚再动手',
    ]), { id: 'MS' }),
  ];
  const ledger = ledgerPayload(tasks);

  assert.equal(ledger.state, 'ok');
  assert.equal(ledger.readable, true);
  assert.equal(ledger.reason, null);
  assert.equal(ledger.meeting.id, 'm-01');
  assert.equal(ledger.meeting.preset, 'standard@1');
  assert.equal(ledger.counts.stages, 1);
  assert.equal(ledger.counts.cards, 1, '阶段块里的 card.* 必须被带出来');
  assert.equal(ledger.meetingTasks, 2, '头块 + 回执块各算一条会议任务');
  assert.equal(ledger.cards[0].stageId, 'challenge');
  assert.equal(ledger.cards[0].card.claim, '需求要先问清楚再动手');
});

test('P2-3 ④：会议任务必须被移出 shadow 的两个分母，并单独计数', async () => {
  const tasks = [
    hostTask(FULL_DECLARATION, { id: 'IMPL' }),
    hostTask(MEETING_PARENT, { id: 'MP' }),
    hostTask(meetingBlock(['meeting: m-01', 'stage: challenge', 'attempt: 1', 'status: done']), { id: 'MS' }),
  ];
  const pageTeams = makeTeams({ tasks });
  const state = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: pageTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));

  const gates = await state.gates(AGENT.id);
  const { shadow } = gates;

  assert.equal(shadow.meetingTasks, 2, '两条会议任务必须被单独数出来');
  assert.equal(shadow.totalTasks, 3);
  assert.equal(shadow.judgedTasks, 1, '只有那条实现任务该进判定');
  assert.equal(shadow.skippedTasks, 0);
  assert.equal(
    shadow.skipped.some((item) => item.taskId === 'MP' || item.taskId === 'MS'),
    false,
    '会议任务不许以 no-kind 之类的名义落进 skipped —— 那会把"不是它的事"记成"判不动"',
  );
  /* 恒等式：每条任务被恰好归进三类之一，没有一条凭空消失。 */
  assert.equal(
    shadow.judgedTasks + shadow.skippedTasks + shadow.meetingTasks,
    shadow.totalTasks,
    'judged + skipped + meeting 必须等于总数 —— 少一条就是静默跳过',
  );

  /* 账本那一块也必须在同一份 payload 上，且与 shadow 互不干扰。 */
  assert.equal(gates.ledger.state, 'ok');
  assert.equal(gates.ledger.meetingTasks, 2);
  const blockerCodes = new Set((Array.isArray(gates.blockers) ? gates.blockers : []).map((b) => b.code));
  for (const row of shadow.rows) {
    assert.equal(blockerCodes.has(row.code), false, `shadow 的码 ${row.code} 不许出现在 blockers 里`);
  }
});

test('P2-3 ⑤：judgedTasks 与 withInput 是两个分母 —— "判了"不等于"核过"', async () => {
  /* 决定性夹具：一条 `work` 任务，没有契约、没有申报、没有 diff。
   * `work` **在** gates 的判定分支里（`GATES_JUDGED_KINDS` 含它），所以它会被"判"；
   * 但六条路径一条都拿不到输入，`judgeCoverage.judged === false`。
   * 旧读法（只看码数）会把它报成 `status:'empty'` = "全绿"。 */
  const tasks = [hostTask(declarationBlock(['kind: work']), { id: 'WORK' })];
  const pageTeams = makeTeams({ tasks });
  const state = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: pageTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));

  const { shadow } = await state.gates(AGENT.id);

  assert.equal(shadow.status, 'empty', '旧读法在这里说"判过、零个码"');
  assert.equal(shadow.judgedTasks, 1);
  assert.equal(shadow.withInput, 0, '而真相是：这一条六关没一关拿得到输入');
  assert.ok(shadow.withInput <= shadow.judgedTasks, 'withInput 不可能超过进入判定的条数');

  /* 正例：一份完整的实现类声明 → 契约那两关真的核过了。 */
  const okTasks = [hostTask(FULL_DECLARATION, { id: 'IMPL' })];
  const okTeams = makeTeams({ tasks: okTasks });
  const okState = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: okTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));
  const okShadow = (await okState.gates(AGENT.id)).shadow;

  assert.equal(okShadow.judgedTasks, 1);
  assert.equal(okShadow.withInput, 1, '写了 acceptance/verify 的实现任务，契约与验收要对得上账，算真核过');
});

test('P2-3 ⑥：非数组入参 → unreadable/tasks-unreadable，绝不返回"没有会议"', () => {
  for (const bad of [null, undefined, 'tasks', 42]) {
    const ledger = ledgerPayload(bad);
    assert.equal(ledger.state, 'unreadable');
    assert.equal(ledger.readable, false);
    assert.equal(ledger.reason, 'tasks-unreadable');
    assert.ok(ledger.codes.includes('E_LEDGER_PARTIAL'));
  }
});

test('P2-3 ⑦：纯函数 —— 同一输入两次结果相同，且不改写入参', () => {
  const tasks = [hostTask(MEETING_PARENT, { id: 'MP' })];
  const before = JSON.stringify(tasks);

  const first = ledgerPayload(tasks);
  const second = ledgerPayload(tasks);

  assert.deepEqual(first, second, '同一输入两次调用必须逐字段相同（无隐藏状态）');
  assert.equal(JSON.stringify(tasks), before, '不许改写入参：`listTasks` 的返回值还可能被别处用到');
});

test('P2-3 ⑧：会议账本在 `gates.ledger`，顶层那块叫 `roleLedger` —— 名字与形状都不再撞', async () => {
  /* 这一条原来钉的是**重名**本身：两样东西都叫 `ledger`，只差一层路径，
   * 页面作者极易拿错，而拿错**不会报错**，只会对着角色统计断言"这场会还没开始"。
   *
   * P3-9 把顶层那块改名为 `roleLedger` 之后，重名消失了 —— 于是这条断言
   * **跟着被测事实一起变**：从"两个同名但形状不同"变成"名字不同、形状也不同"。
   * 两句都钉同一个目的：拿错了必须立刻看得出来，而不是悄悄读成另一个东西。 */
  const pageTeams = makeTeams({ tasks: [hostTask(MEETING_PARENT, { id: 'MP' })] });
  const state = onSwitch(createBoardState(makeServiceCtx({
    agentTeams: pageTeams.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  })));

  /* 必须带 sessionId：`snapshot({})` 里没有它时 `gates(...)` 会返回 unavailable（reason:'agent'），
   * 那就测不到"两个账本并存"这件事了。 */
  const payload = await state.snapshot({ sessionId: AGENT.id });

  assert.ok(payload.roleLedger !== undefined, '顶层那块必须还在（角色台账，别人的职责）');
  assert.ok(payload.gates.ledger !== undefined, '会议账本挂在 gates 下');

  /* ① 名字不再相同：顶层不许再出现 `ledger` 这个键 —— 这是 P3-9 的核心。 */
  assert.equal(
    Object.hasOwn(payload, 'ledger'),
    false,
    '顶层不许再叫 `ledger` —— 与 `gates.ledger` 重名正是被消掉的那个债',
  );

  /* ② 形状也不同：会议账本有四态 `state`，角色台账没有。 */
  assert.notEqual(payload.roleLedger, payload.gates.ledger, '两块不许是同一个对象');
  assert.equal(payload.gates.ledger.state, 'ok', '会议账本是四态的那个');
  assert.equal(
    Object.hasOwn(payload.roleLedger, 'state'),
    false,
    '角色台账没有 state 字段 —— 形状不同，拿错立刻能看出来',
  );
});

test('P2-4 ⑨：三条 unavailable 出口都必须带第四态，页面读 `.state` 拿不到 undefined', async () => {
  /* 三条出口各自要一个宿主：没有 Agent Teams / 没有活着的 Agent / 取数抛了。
   * 第三条最容易被漏掉 —— 它是 try/catch 兜出来的，不是一条 `return`。 */
  const throwingTeams = {
    spawnTeammate() {},
    createTask() {},
    updateTask() {},
    listTasks() {
      throw new Error('宿主炸了');
    },
    listMembers() {
      return [];
    },
    membership() {
      return { name: 'alice' };
    },
    tryMembership() {
      return { name: 'alice' };
    },
  };

  const cases = [
    ['agentTeams', makeServiceCtx({ agents: { get: () => AGENT } })],
    ['agent', makeServiceCtx({ agentTeams: makeTeams({ tasks: [] }).teams, agents: { get: () => undefined } })],
    ['error', makeServiceCtx({ agentTeams: throwingTeams, agents: { get: () => AGENT } })],
  ];

  for (const [expectedReason, ctx] of cases) {
    const gates = await onSwitch(createBoardState(ctx)).gates(AGENT.id);

    assert.equal(gates.status, 'unavailable', `[${expectedReason}] 门禁必须说不可用`);
    assert.equal(
      Object.hasOwn(gates, 'ledger'),
      true,
      `[${expectedReason}] 出口必须带 ledger 键 —— 少它页面就取到 undefined`,
    );
    assert.equal(typeof gates.ledger.state, 'string', `[${expectedReason}] .state 必须是字符串，不是 undefined`);
    assert.equal(gates.ledger.state, 'unavailable', `[${expectedReason}] 第四态，不许塞进 unreadable`);
    assert.equal(gates.ledger.reason, expectedReason, `[${expectedReason}] reason 与门禁出口同一个值，不另造词`);
    assert.equal(gates.ledger.readable, false);
    assert.equal(gates.ledger.meetingTasks, null, `[${expectedReason}] 没数过就是 null，不是 0`);
    assert.equal(gates.ledger.meeting, null);
    assert.deepEqual(gates.ledger.cards, []);
  }
});

test('P2-4 ⑩：`unavailable` 与 `unreadable` 成因不同，字段上必须还能分辨', async () => {
  /* unreadable：门禁是好的，拿到了任务列表，但账本块读坏了（没闭合）。 */
  const brokenTasks = [
    hostTask(`${DECL_FENCE}team-board-meeting\nmeeting: m-01\npreset: standard@1`, { id: 'B1' }),
  ];
  const unreadableGates = await onSwitch(createBoardState(makeServiceCtx({
    agentTeams: makeTeams({ tasks: brokenTasks }).teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }))).gates(AGENT.id);

  /* unavailable：门禁压根起不来，账本这件事没轮到。 */
  const unavailableGates = await onSwitch(createBoardState(makeServiceCtx({
    agents: { get: () => AGENT },
  }))).gates(AGENT.id);

  assert.equal(unreadableGates.ledger.state, 'unreadable');
  assert.equal(unavailableGates.ledger.state, 'unavailable');
  assert.notEqual(unreadableGates.ledger.state, unavailableGates.ledger.state);
  /* 两态的判别不能靠"码列表为空"这种间接信号： */
  assert.notEqual(unreadableGates.ledger.reason, unavailableGates.ledger.reason);
  /* 一个是"数到了 1 条围栏、但读不出来"，一个是"压根没数过"。0 / null / ≥1 三种值必须分开。 */
  assert.ok(unreadableGates.ledger.meetingTasks >= 1);
  assert.equal(unavailableGates.ledger.meetingTasks, null);
  assert.ok(unreadableGates.ledger.codes.length > 0, 'unreadable 必须点名拦截码');
  assert.deepEqual(unavailableGates.ledger.codes, [], 'unavailable 还没有走到"读块"那一步，不该有码');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P2-4：账本写路径
 *
 * 这组守四条硬要求，都**不是**"写进去的字节对不对"（那是 `ledger.mjs` 的往返测试）：
 *   ① 差量写：一次阶段完成 = 1 次子任务 update + 0~1 次父任务 update，绝不全量重放
 *   ② revision 冲突 → 重读 + 重算（不是拿旧 revision 硬写，也不是重试同一份计划）
 *   ③ 最终失败 → `E_LEDGER_WRITE_FAILED`，且**绝不重发这个阶段**（写次数有上界）
 *   ④ 写失败的行留在结果里，并标成败态
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 会**真的记账**的假 TeamService：`createTask` 往树上加，`updateTask` 按
 * compare-and-set 校验 `expectedRevision`（stale 就拒）。这样测试断言的就不是
 * "有没有调用"，而是"调用了几次、每次拿的是哪个 revision"。
 */
function makeWritingTeams({
  tasks = [],
  memberName = 'alice',
  failUpdates = 0,
  failCreates = 0,
  createWithoutId = false,
  membershipFails = false,
} = {}) {
  const calls = [];
  const tree = tasks.map((task) => ({ ...task }));
  let nextId = tree.length + 1;
  let updatesToFail = failUpdates;
  let createsToFail = failCreates;
  const membershipOf = (agent) => ({ root: agent, id: 'team-1', role: 'lead', name: memberName });

  const teams = {
    membership(agent) {
      calls.push(['membership', agent]);
      if (membershipFails) throw new Error('membership 读不出来');
      return membershipOf(agent);
    },
    tryMembership(agent) {
      return membershipOf(agent);
    },
    listTasks() {
      calls.push(['listTasks']);
      return tree.map((task) => ({ ...task }));
    },
    listMembers() {
      return [];
    },
    async createTask(agent, request) {
      calls.push(['createTask', request]);
      if (createsToFail > 0) {
        createsToFail -= 1;
        throw new Error('宿主拒绝建任务');
      }
      if (createWithoutId) return { subject: request.subject };
      const view = {
        id: `NEW${nextId}`,
        revision: 1,
        subject: request.subject,
        description: request.description,
        status: 'pending',
        blockedBy: Array.isArray(request.blockedBy) ? [...request.blockedBy] : [],
        writeScopes: Array.isArray(request.writeScopes) ? [...request.writeScopes] : [],
        ready: true,
        writeScopeWarnings: [],
      };
      nextId += 1;
      tree.push(view);
      return { ...view };
    },
    async updateTask(agent, request) {
      calls.push(['updateTask', request]);
      if (updatesToFail > 0) {
        updatesToFail -= 1;
        throw new Error('revision 冲突');
      }
      const found = tree.find((task) => task.id === request.taskId);
      if (found === undefined) throw new Error('任务不在了');
      if (found.revision !== request.expectedRevision) throw new Error('revision 冲突');
      if (typeof request.description === 'string') found.description = request.description;
      found.revision += 1;
      return { ...found };
    },
  };

  return { teams, calls, tree };
}

/** 一份最小的目标账本：一个阶段，`running`。 */
function meetingLedger(stageStatus = 'running', parentStatus = 'running') {
  return {
    id: 'm-01',
    preset: 'standard@1',
    status: parentStatus,
    stages: [{ stageId: 'challenge', attempt: 1, status: stageStatus, produced: [] }],
  };
}

test('P2-4 ⑪：从零写一场会 —— 建父任务 + 建阶段任务，阶段用 blockedBy 串成链', async () => {
  const page = makeWritingTeams();
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  const result = await state.writeMeetingLedger(AGENT.id, meetingLedger());

  assert.equal(result.ok, true);
  assert.equal(result.attempted, true);
  assert.equal(result.attempts, 1);
  assert.equal(page.tree.length, 2, '父任务 1 个 + 阶段任务 1 个');

  const creates = result.rows.filter((row) => row.action === 'create');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].role, 'parent');
  assert.equal(creates[1].role, 'stage');
  assert.equal(creates[1].stageId, 'challenge');

  /* 两个块都必须是账本围栏，且**都不带 writeScopes** ——
   * 会议任务给了写域会触发 `E_DECLARATION_MISSING`，每天报一条假警告。 */
  for (const task of page.tree) {
    assert.ok(task.description.includes('team-board-meeting'), 'description 里必须有账本围栏');
    assert.deepEqual(task.writeScopes, [], '会议任务不许带写域');
  }
});

test('P2-4 ⑫：差量写 —— 只改了阶段状态，就只许写那一条子任务', async () => {
  const page = makeWritingTeams();
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  await state.writeMeetingLedger(AGENT.id, meetingLedger());
  assert.equal(page.calls.filter(([method]) => method === 'createTask').length, 2, '先建父任务 + 阶段任务');

  /* 只动阶段：父任务的 status 没变 → 父块渲染结果与原文逐字相同 → 不该被写。 */
  const before = page.calls.length;
  const second = await state.writeMeetingLedger(AGENT.id, meetingLedger('done', 'running'));
  const secondRound = page.calls.slice(before);

  assert.equal(second.ok, true);
  assert.equal(second.attempted, true);
  assert.equal(
    secondRound.filter(([method]) => method === 'createTask').length,
    0,
    '第二次不许再建任务 —— 全量重放每轮都会建一份新的，看板上会翻倍',
  );
  const updates = secondRound.filter(([method]) => method === 'updateTask');
  assert.equal(updates.length, 1, '一次阶段完成 = 1 次子任务 update + 0~1 次父任务 update');
  assert.equal(updates[0][1].taskId, page.tree[1].id);
  assert.equal(updates[0][1].action, 'edit', '改 description 必须走 action: edit');
  assert.equal(typeof updates[0][1].expectedRevision, 'number', 'compare-and-set 必须带 expectedRevision');
});

test('P2-4 ⑬：revision 冲突 → 重读 + 重算，第二次成功', async () => {
  const page = makeWritingTeams({ failUpdates: 1 });
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  /* 先建树（不带阶段状态变化），再改阶段状态触发一条 update，而那条 update 第一次会被拒。 */
  await state.writeMeetingLedger(AGENT.id, meetingLedger('running', 'running'));
  const before = page.calls.length;
  const result = await state.writeMeetingLedger(AGENT.id, meetingLedger('done', 'running'));
  const round = page.calls.slice(before);

  assert.equal(result.ok, true, '冲突一次之后必须能写成功');
  assert.equal(result.attempts, 2, '首写 + 一次重读重算');
  assert.equal(round.filter(([method]) => method === 'updateTask').length, 2, '两次 update：先被拒，重算后再写');

  const failed = result.rows.filter((row) => row.status === 'failed');
  const ok = result.rows.filter((row) => row.status === 'ok' && row.action === 'update');
  assert.equal(failed.length, 1);
  assert.equal(ok.length, 1);
  assert.equal(failed[0].superseded, true, '重试成功之后，前一条失败行必须被标成"已被覆盖"，不被读成仍在失败');
  assert.deepEqual(result.codes, [], '最终成功就不该带拦截码');
});

test('P2-4 ⑭：冲突两次 → E_LEDGER_WRITE_FAILED，且写次数有上界（绝不重发阶段）', async () => {
  const page = makeWritingTeams({ failUpdates: 99 });
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  await state.writeMeetingLedger(AGENT.id, meetingLedger('running', 'running'));
  const before = page.calls.length;
  const result = await state.writeMeetingLedger(AGENT.id, meetingLedger('done', 'running'));
  const round = page.calls.slice(before);

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2, '重试次数必须有上界');
  assert.equal(
    round.filter(([method]) => method === 'updateTask').length,
    2,
    '两次就是上限 —— 再多就是"拿写失败当重发阶段"，那会让同一阶段跑两遍',
  );
  assert.equal(
    round.filter(([method]) => method === 'createTask').length,
    0,
    '失败路径上更不许建任务：那会凭空造出第二份卡',
  );
  assert.ok(result.codes.includes('E_LEDGER_WRITE_FAILED'), '最终失败必须点这条码');

  /* 写失败的行必须留在结果里，并且是失败态 —— 过滤掉就等于"一屏什么都没发生"。 */
  const failed = result.rows.filter((row) => row.status === 'failed' && row.superseded !== true);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].action, 'update');
  assert.equal(failed[0].code, 'E_LEDGER_WRITE_FAILED');
  assert.equal(typeof failed[0].message, 'string');
});

test('P2-4 ⑮：幂等 —— 目标状态已经达到时不写一次，也不产生 revision bump', async () => {
  const page = makeWritingTeams();
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  await state.writeMeetingLedger(AGENT.id, meetingLedger());
  const revisionsAfterFirst = page.tree.map((task) => task.revision);
  const before = page.calls.length;

  const again = await state.writeMeetingLedger(AGENT.id, meetingLedger());
  const round = page.calls.slice(before);

  assert.equal(again.ok, true);
  assert.equal(again.attempted, false, '没有差量 → 一次都不写');
  assert.equal(again.reason, 'no-change');
  assert.equal(
    round.some(([method]) => method === 'createTask' || method === 'updateTask'),
    false,
    '重复提交不许产生第二次写',
  );
  assert.deepEqual(page.tree.map((task) => task.revision), revisionsAfterFirst, 'revision 一条都不许涨');
});

test('P2-4 ⑯：算不出差量 → 一次都不许写（attempted:false）', async () => {
  const page = makeWritingTeams({
    tasks: [
      hostTask(meetingBlock(['meeting: m-01', 'preset: standard@1', 'status: running']), { id: 'P1' }),
      hostTask(meetingBlock(['meeting: m-01', 'preset: standard@1', 'status: running']), { id: 'P2' }),
    ],
  });
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  const result = await state.writeMeetingLedger(AGENT.id, meetingLedger());

  assert.equal(result.ok, false);
  assert.equal(result.attempted, false, '算不出差量时一次都不许写 —— 猜个目标状态写下去更坏');
  assert.equal(result.reason, 'plan');
  assert.equal(
    page.calls.some(([method]) => method === 'createTask' || method === 'updateTask'),
    false,
    '有两个会议头时不许动手，只许报出来',
  );
  assert.ok(result.codes.includes('E_LEDGER_PARTIAL'), '带上真正的成因码');
});

test('P2-4 ⑰：宿主建任务不返回 id → 这一条算失败，不许当成成功', async () => {
  const page = makeWritingTeams({ createWithoutId: true });
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  const result = await state.writeMeetingLedger(AGENT.id, meetingLedger());

  assert.equal(result.ok, false);
  assert.ok(result.codes.includes('E_LEDGER_WRITE_FAILED'));
  const failed = result.rows.filter((row) => row.status === 'failed');
  assert.ok(failed.length >= 1);
  assert.equal(failed[0].taskId, null, '没有 id 就必须如实记成 null，不许编一个');
  assert.match(failed[0].message, /id/, '文案要点明是"没拿到 id"');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P2-8：换档记录必须留住「谁换的」
 *
 * `upgrades[].by` 此前**零生产者**：账本能编码 `| by=`、往返也有测试，但没人喂。
 * 这组钉三件事：①身份只从宿主取、且真的落了盘（往返读回）；②拿不到身份不许编占位名；
 * ③换档失败时一次都不写。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 一场已经跑起来的会：`lite@1` 的父块 + 一个已完成阶段。 */
function seededMeetingTasks() {  return [
    hostTask(meetingBlock(['meeting: m-01', 'preset: lite@1', 'status: running']), { id: 'MP' }),
    hostTask(meetingBlock(['meeting: m-01', 'stage: challenge', 'attempt: 1', 'status: done']), { id: 'MS' }),
  ];
}

test('P2-8 ⑱：换档记下「谁换的」—— by 来自宿主身份，且只写父任务', async () => {
  /* 先用写路径把树建出来，**再**换档。理由：手写种子块不是规范形状
   * （少了 `produced:` 这一行之类），第一次写会顺手把它规范化一次 ——
   * 那一次 update 是"排版归正"，不是换档的功劳，混进来会让这条断言失去意义。 */
  const page = makeWritingTeams({ memberName: 'alice' });
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  await state.writeMeetingLedger(AGENT.id, {
    id: 'm-01',
    preset: 'lite@1',
    status: 'running',
    stages: [{ stageId: 'challenge', attempt: 1, status: 'done', produced: [] }],
  });
  const parentTaskId = page.tree[0].id;
  page.calls.length = 0; // 建树那一段不算，只看换档这一段的写

  const result = await state.upgradeMeeting(AGENT.id, {
    toQualified: 'standard@1',
    reason: '阶段不够，多跑几个',
    at: '2026-11-22T00:00:00Z',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.notes, [], '身份拿得到 → 不该有"没记下是谁"的说明');
  assert.equal(result.identity.status, 'ok');
  assert.equal(result.identity.name, 'alice');

  /* 往返：只断言"调用过 updateTask"证明不了这一格真的落了盘。 */
  const readBack = ledgerFromTasks(page.tree);
  assert.equal(readBack.ledger !== null, true, '写完之后账本必须仍可读');
  const entry = readBack.ledger.upgrades[0];
  assert.equal(entry.from, 'lite@1');
  assert.equal(entry.to, 'standard@1');
  assert.equal(entry.by, 'alice', 'by 必须来自 membership().name');
  assert.equal(entry.reason, '阶段不够，多跑几个');
  assert.equal(entry.at, '2026-11-22T00:00:00Z');

  /* 换档只改父块的 `upgrades` 一行，阶段子任务一个字都不该动。 */
  const updates = page.calls.filter(([method]) => method === 'updateTask');
  assert.equal(updates.length, 1, '只该写父任务一条');
  assert.equal(updates[0][1].taskId, parentTaskId);
});

test('P2-8 ⑲：拿不到身份 → 不编占位名，by 缺席，并在 notes 里如实说', async () => {
  const page = makeWritingTeams({ tasks: seededMeetingTasks(), membershipFails: true });
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  const result = await state.upgradeMeeting(AGENT.id, { toQualified: 'standard@1', reason: 'r' });

  assert.equal(
    result.ok,
    true,
    '记不下是谁 ≠ 不许换档 —— 挡在这里会把"少一格"升级成"功能没了"，那更坏',
  );
  assert.equal(result.identity.status, 'unavailable');
  assert.equal(result.identity.reason, 'membership');
  assert.equal(result.notes.length, 1, '必须如实出声一次');
  assert.match(result.notes[0], /没记下是谁/);

  const entry = ledgerFromTasks(page.tree).ledger.upgrades[0];
  assert.equal(
    Object.hasOwn(entry, 'by'),
    false,
    '不编占位名 → 这个键必须**缺席**（不是 undefined、不是空串）',
  );
  for (const placeholder of ['unknown', 'system', 'n/a', 'undefined', 'null', '']) {
    assert.notEqual(entry.by, placeholder, `不许拿「${placeholder}」凑数：编出来的 by 与真的在页面上长得一模一样`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry, '过一趟 JSON 必须一模一样');
});

test('P2-8 ⑳：升档目标不是 id@version → 拒绝，且一次都不写', async () => {
  const page = makeWritingTeams({ tasks: seededMeetingTasks() });
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  const result = await state.upgradeMeeting(AGENT.id, { toQualified: 'standard', reason: 'r' });

  assert.equal(result.ok, false);
  /* 方向判据现在在 `applyUpgrade` **内部**（P2-11）：非法目标连 parsePresetId 都过不了，
   * 于是 `direction` 是 'unknown'、成因码是 `E_PRESET_NOT_FOUND`。host 只翻译，不判。 */
  assert.equal(result.reason, 'upgrade');
  assert.equal(result.direction, 'unknown');
  assert.equal(result.written, null, '没升成就不该有写结果');
  assert.ok(
    (Array.isArray(result.errors) ? result.errors : []).some((error) => error.code === 'E_PRESET_NOT_FOUND'),
    '必须带上真正的成因码',
  );
  assert.equal(
    page.calls.some(([method]) => method === 'updateTask' || method === 'createTask'),
    false,
    '目标不合法时一次都不许写',
  );
});

test('P2-8 ㉑：阶段链 —— 补建后一个阶段时，blockedBy 必须指向已存在的那个阶段任务', async () => {
  /* 这条压的是「阶段 → 任务 id」那张表的**树侧路径**：第一个阶段这轮不建（它已经在树上），
   * 所以 `blockedByStages: ['challenge']` 必须靠 `stageTaskIds(tasks)` 翻成真 id。
   * 那张表以前是我在 host 里按 `fields` 是 `Map` 这个内部表示自己取的，现在换成
   * `ledger.mjs` 导出的契约函数 —— 这条测试是那次替换的钉子：
   * 换坏了它就会红（`blockedBy` 变成 [] 或阶段名，两种都不对）。 */
  const page = makeWritingTeams();
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  await state.writeMeetingLedger(AGENT.id, {
    id: 'm-01',
    preset: 'standard@1',
    status: 'running',
    stages: [{ stageId: 'challenge', attempt: 1, status: 'done', produced: [] }],
  });
  const challengeTaskId = page.tree[1].id;
  page.calls.length = 0;

  const result = await state.writeMeetingLedger(AGENT.id, {
    id: 'm-01',
    preset: 'standard@1',
    status: 'running',
    stages: [
      { stageId: 'challenge', attempt: 1, status: 'done', produced: [] },
      { stageId: 'confirm', attempt: 1, status: 'running', produced: [] },
    ],
  });

  assert.equal(result.ok, true);
  const creates = page.calls.filter(([method]) => method === 'createTask');
  assert.equal(creates.length, 1, '只该补建第二个阶段，已存在的不许再建一份');
  assert.equal(creates[0][1].subject.includes('confirm'), true);
  assert.deepEqual(
    creates[0][1].blockedBy,
    [challengeTaskId],
    'blockedBy 必须是真的任务 id —— 不是阶段名，也不是空数组（空数组等于把链丢了）',
  );
});

test('P2-9 ㉒：降档必须失败并说明为什么 —— 只许向上是用户定的原则', async () => {
  /* 先在 `standard@1` 上把会建起来，再试着降到 `lite@1`。
   * 判据在 `preset.mjs` 的 `judgeShift`（`rank` 比较），host 不另写一份。 */
  const page = makeWritingTeams();
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  await state.writeMeetingLedger(AGENT.id, {
    id: 'm-01',
    preset: 'standard@1',
    status: 'running',
    stages: [{ stageId: 'challenge', attempt: 1, status: 'done', produced: [] }],
  });
  page.calls.length = 0;

  const result = await state.upgradeMeeting(AGENT.id, { toQualified: 'lite@1', reason: '想少跑几步' });

  assert.equal(result.ok, false, '降档不许成功');
  assert.equal(result.reason, 'upgrade', 'host 只把 applyUpgrade 的失败翻译成一个 reason');
  assert.equal(result.direction, 'down', '必须明确说这是降档，不是"目标有问题"');
  assert.ok(
    (Array.isArray(result.errors) ? result.errors : []).some((error) => error.code === 'E_PRESET_DOWNGRADE'),
    '成因码必须来自 preset.mjs —— 判据不在 host 里重写',
  );
  assert.equal(result.written, null);
  assert.equal(
    page.calls.some(([method]) => method === 'updateTask' || method === 'createTask'),
    false,
    '降档请求一个字节都不许写进账本',
  );

  /* 账本上的档位必须还是原样 —— 一次失败的降档不许留下任何痕迹。 */
  const still = ledgerFromTasks(page.tree);
  assert.equal(still.ledger.preset, 'standard@1');
  assert.deepEqual(still.ledger.upgrades ?? [], [], '没换成就别记一条换档历史');
});

test('P2-9 ㉓：换到同一档是空操作，不许写一条"从 X 升到 X"的假历史', async () => {
  const page = makeWritingTeams();
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));

  await state.writeMeetingLedger(AGENT.id, {
    id: 'm-01',
    preset: 'standard@1',
    status: 'running',
    stages: [{ stageId: 'challenge', attempt: 1, status: 'done', produced: [] }],
  });
  page.calls.length = 0;

  const result = await state.upgradeMeeting(AGENT.id, { toQualified: 'standard@1', reason: '再升一次' });

  assert.equal(result.ok, false, '同档也不许写 —— 一次 X → X 是假历史');
  assert.equal(result.reason, 'upgrade');
  assert.equal(result.upgradedReason, 'same-tier', '同档是"没有可做的事"，不是"这条记录有问题"');
  assert.equal(result.direction, 'same');
  assert.equal(result.written, null);
  assert.equal(
    page.calls.some(([method]) => method === 'updateTask' || method === 'createTask'),
    false,
    '同档不许写',
  );
  assert.deepEqual(ledgerFromTasks(page.tree).ledger.upgrades ?? [], [], '历史里不该多一条 X → X');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P2-9：提交阶段结果的入口
 *
 * 在它之前 `writeMeetingLedger` 只有测试在调 —— 账本写路径的反证只证明了
 * "它能写对"，没证明"它会被用"。**测试绿不等于功能可用。**
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 只建一个会议头（没有任何阶段任务），用来验"提交时才建那一张卡"。 */
async function seedParentOnly(state) {
  await state.writeMeetingLedger(AGENT.id, {
    id: 'm-01',
    preset: 'standard@1',
    status: 'running',
    stages: [],
  });
}

test('P2-9 ㉔：提交阶段结果 —— 建出该阶段任务，且账本读得回来', async () => {
  const page = makeWritingTeams();
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));
  await seedParentOnly(state);
  page.calls.length = 0;

  const result = await state.submitStage(AGENT.id, {
    stageId: 'challenge',
    attempt: 1,
    status: 'done',
    produced: ['questions'],
    at: '2026-11-22T01:00:00Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.identity.status, 'ok');

  const creates = page.calls.filter(([method]) => method === 'createTask');
  assert.equal(creates.length, 1, '这一阶段还没有任务 → 建一个');

  const back = ledgerFromTasks(page.tree).ledger;
  assert.equal(back !== null, true);
  const stage = back.stages.find((item) => item.stageId === 'challenge');
  assert.equal(stage !== undefined, true, '提交之后账本里必须有这个阶段');
  assert.equal(stage.attempt, 1);
  assert.equal(stage.status, 'done');
  assert.deepEqual(stage.produced, ['questions']);
  assert.equal(stage.at, '2026-11-22T01:00:00Z', 'at 原样存，不解析');
});

test('P2-9 ㉕：同一 (阶段, 轮次) 重复提交是 no-op —— 一个字节都不许写', async () => {
  const page = makeWritingTeams();
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));
  await seedParentOnly(state);

  const first = await state.submitStage(AGENT.id, {
    stageId: 'challenge', attempt: 1, status: 'done', produced: ['questions'],
  });
  assert.equal(first.duplicate, false);
  const revisionsAfterFirst = page.tree.map((task) => task.revision);
  page.calls.length = 0;

  const again = await state.submitStage(AGENT.id, {
    stageId: 'challenge', attempt: 1, status: 'done', produced: ['questions'],
  });

  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true, '重复提交必须被认出来');
  assert.equal(again.written, null, '重复提交不产生写结果');
  assert.equal(
    page.calls.some(([method]) => method === 'createTask' || method === 'updateTask'),
    false,
    '重复提交不许写第二次 —— 这就是幂等的全部机制',
  );
  assert.deepEqual(page.tree.map((task) => task.revision), revisionsAfterFirst, 'revision 一条都不许涨');
});

test('P2-9 ㉖：拿不到身份 → 提交如实失败，不记一笔署不了名的账', async () => {
  const page = makeWritingTeams({ membershipFails: true });
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));
  await seedParentOnly(state);
  page.calls.length = 0;

  const result = await state.submitStage(AGENT.id, {
    stageId: 'challenge', attempt: 1, status: 'done',
  });

  assert.equal(result.ok, false, '署不了名的提交不许被当成正常提交');
  assert.equal(result.reason, 'identity');
  assert.equal(result.identity.status, 'unavailable', '如实给出身份的读取状态');
  assert.equal(result.written, null);
  assert.match(result.message, /身份/, '必须说清失败原因，不能只给一个 false');
  assert.equal(
    page.calls.some(([method]) => method === 'createTask' || method === 'updateTask'),
    false,
    '身份拿不到时一个字节都不许写',
  );
});

test('P2-9 ㉗：卡片判据来自 artifact.mjs —— 两条主张必须被判为不合格，判不了就直说', async () => {
  const page = makeWritingTeams();
  const state = createBoardState(makeServiceCtx({
    agentTeams: page.teams,
    agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
  }));
  await seedParentOnly(state);

  /* 判据**不在 host 里写**：这是 `artifact.mjs` 的 `E_CLAIM_MULTIPLE`，
   * 一张卡说两件事等于没人能逐条反驳它。 */
  const twoClaims = await state.submitStage(AGENT.id, {
    stageId: 'challenge',
    attempt: 1,
    status: 'done',
    card: {
      id: 'c1',
      stage: 'challenge',
      role: 'critic',
      claim: ['需求要先问清', '顺便把设计也定了'],
      basis: ['file:plugin/src/board.mjs'],
      risks: [],
      needsHuman: [],
    },
  });

  assert.equal(twoClaims.card.status, 'failed', '两条主张的卡必须判为不合格');
  assert.ok(
    twoClaims.card.errors.some((error) => error.code === 'E_CLAIM_MULTIPLE'),
    '成因码必须来自 artifact.mjs，证明判据没在 host 里重写',
  );

  /* 判不了的情形：这个阶段不在该档位里。**不许报绿** —— 判不了就是判不了。 */
  const unknownStage = await state.submitStage(AGENT.id, {
    stageId: 'nope',
    attempt: 1,
    status: 'done',
    card: { id: 'c2', stage: 'nope', role: 'x', claim: '一句话', basis: ['file:a'], risks: [], needsHuman: [] },
  });
  assert.equal(unknownStage.card.status, 'cannot-judge');
  assert.match(unknownStage.card.cannotJudge, /判不了/);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P3-2：连杆（`deliver` 的真实实现 + `team_meeting_start`）
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 真预设：`lite@1`（4 阶段、2 个盲阶段、`minCount.killScenarios: 2`）。 */
const LITE_PRESET = JSON.parse(readFileSync(new URL('../presets/lite@1.json', import.meta.url), 'utf8'));

/** `resolveAgent` 要的那张表：只认得本会话，别人的一律取不到。 */
const agentLookup = { get: (id) => (id === AGENT.id ? AGENT : undefined) };

/** 每个阶段一张**合格**的卡。少给一个必产字段就能造出"判不了"。 */
function goodMeetingArtifact(stageId) {
  const stage = LITE_PRESET.stages.find((item) => item.id === stageId);
  const base = {
    id: `card-${stageId}`,
    stage: stageId,
    role: stage === undefined ? 'unknown' : stage.role,
    claim: `${stageId} 的结论：先做最小的一步`,
    basis: [{ kind: 'file', ref: 'plugin/src/board.mjs' }],
    risks: [],
    needsHuman: [],
    conflictsWith: [],
  };
  switch (stageId) {
    case 'challenge': return { ...base, questions: ['这个需求真的必要吗', '不做会怎样'] };
    case 'confirm': return { ...base, requirements: ['只做 A 和 B'], answered: ['Q1→A1'] };
    case 'design': return { ...base, decisions: ['用现成的 lerp'], killScenarios: ['如果树是空的', '如果值为 NaN'] };
    case 'verify': return { ...base, verdict: 'pass', findings: ['没有发现阻断'] };
    default: return base;
  }
}

/** 假代理容器：按 `startActivation` / `sendMessage` 铺位收消息，按阶段回产物。 */function makeFakeSubagents(artifactFor) {
  const calls = [];
  let childSeq = 0;
  let lastName = null;

  const stageOf = (text) => {
    const matched = typeof text === 'string' ? text.match(/阶段 ([a-z]+)（角色/) : null;
    return matched === null ? null : matched[1];
  };

  return {
    calls,
    /* 真契约：`list(): string[]` 是"该用哪个 provider"的唯一来源。缺了它，
     * 冷启动在**调用宿主之前**就如实失败（`no-provider`）—— 这条曾经在真宿主里
     * 表现为 `no subagent provider registered for "undefined"`。 */
    list() {
      return ['spawn'];
    },
    async startActivation(spec) {
      /* 真契约要求 provider / label / signal / delivery 齐备，正文在
       * `request.prompt: ContentBlock[]`——**没有 `request.task` 这个字段**
       * （上一版读的就是它，于是这个假对象一直在替我们圆一个不存在的契约）。 */
      if (typeof spec.provider !== 'string' || spec.provider === '') {
        throw new Error(`no subagent provider registered for "${String(spec.provider)}"`);
      }
      if (spec.delivery !== 'parent' && spec.delivery !== 'caller') throw new Error('delivery 必填');
      if (!Array.isArray(spec.request?.prompt)) throw new Error('request.prompt 必须是 ContentBlock[]');
      const text = String(spec.request.prompt[0]?.text ?? '');
      lastName = stageOf(text);
      /* 把 id **记进 calls** 再返回：只当返回值给出的话，断言那一侧读不到证据，
       * 于是"账本里的 id = 投递那一刻宿主真给出的 id"这条**永远无法被证明**。
       * 顺带把两条路的记录形状对齐（`sendMessage` 用 `targetId`，这里用 `childId`）。 */
      childSeq += 1;
      const childId = `child-${childSeq}`;
      calls.push({ via: 'startActivation', stage: lastName, text, childId });
      return { childId };
    },
    async sendMessage(_sender, targetId, content) {
      lastName = stageOf(content);
      calls.push({ via: 'sendMessage', stage: lastName, text: String(content ?? ''), targetId });
      return { messageId: `msg-${calls.length}` };
    },
    readArtifact(childId) {
      calls.push({ via: 'readArtifact', stage: lastName, text: '', targetId: childId });
      return artifactFor(lastName);
    },
  };
}

test('P3-2 ㉙：通过挂载点真跑一场 `lite@1` —— 四个阶段全 done，账本读得回，produced 对得上 mustProduce', async () => {
  const page = makeWritingTeams();
  const subagents = makeFakeSubagents((stageId) => goodMeetingArtifact(stageId));
  const kv = makeKv({ enabled: true });
  const host = makePageHost({ kv, teams: page.teams, subagents, agents: agentLookup });
  apply(host.ctx, {});
  await flush();

  const start = host.registrations.find((item) => item.definition.name === 'team_meeting_start');
  assert.ok(start !== undefined, 'team_meeting_start 必须注册');

  const value = await start.definition.execute(
    { preset: 'lite@1', question: '这套流水线现在能不能真的跑起来' },
    { agent: AGENT },
  );

  assert.equal(value.ok, true, value.report);
  assert.equal(value.status, 'done');
  assert.equal(value.stop, 'done');
  assert.equal(value.stageCount, 4, '四个阶段都写进了账本');

  /* 投递顺序 = 预设顺序；每个阶段的文本里都必须带着会议的问题（否则那个入参是死的）。
     只数**投递**那两次调用：`readArtifact` 也带 stage，但它是回收不是投递。 */
  const delivered = subagents.calls.filter((call) => call.via !== 'readArtifact');
  assert.deepEqual(
    delivered.map((call) => call.stage),
    ['challenge', 'confirm', 'design', 'verify'],
  );
  assert.equal(
    delivered.every((call) => call.text.includes('这套流水线现在能不能真的跑起来')),
    true,
    '会议的问题必须进到每一条投递消息里',
  );

  /* 账本读回：四行 done，produced 与预设的 mustProduce 对得上。 */
  const readBack = ledgerFromTasks(page.tree);
  assert.equal(readBack.ledger !== null, true, '跑完之后账本必须仍可读');
  const rows = readBack.ledger.stages;
  assert.deepEqual(rows.map((row) => row.stageId), ['challenge', 'confirm', 'design', 'verify']);
  assert.equal(rows.every((row) => row.status === 'done'), true);
  const musts = LITE_PRESET.stages.map((stage) => stage.mustProduce);
  assert.deepEqual(rows.map((row) => row.produced), musts, 'produced 必须就是这一阶段的必产字段');
  assert.equal(readBack.ledger.status, 'done');
});

test('P3-2 ㉚：某个阶段产物不合判据 → 停在那一阶段，账本里它不是 done，报的是 E_ARTIFACT_*', async () => {
  const page = makeWritingTeams();
  const subagents = makeFakeSubagents((stageId) => {
    const artifact = goodMeetingArtifact(stageId);
    if (stageId === 'confirm') delete artifact.answered;
    return artifact;
  });
  const host = makePageHost({ kv: makeKv({ enabled: true }), teams: page.teams, subagents, agents: agentLookup });
  apply(host.ctx, {});
  await flush();

  const start = host.registrations.find((item) => item.definition.name === 'team_meeting_start');
  const value = await start.definition.execute({ preset: 'lite@1' }, { agent: AGENT });

  assert.equal(value.ok, false);
  assert.equal(value.stop, 'artifact', '判不了就停在原地，绝不"自动降低要求"');
  assert.match(value.report, /E_ARTIFACT_/i, '必须报的是 E_ARTIFACT_* 的码，不许自己编文案');

  const rows = ledgerFromTasks(page.tree).ledger.stages.map((row) => [row.stageId, row.status]);
  assert.deepEqual(rows, [['challenge', 'done']], 'confirm 不许被记成 done');
  assert.equal(value.stageCount, 1);
});

test('P3-2 ㉛：盲阶段的投递文本里不含被 withheld 的产物 —— `deliver` 一个字都不许加', async () => {
  const page = makeWritingTeams();
  const subagents = makeFakeSubagents((stageId) => goodMeetingArtifact(stageId));
  const host = makePageHost({ kv: makeKv({ enabled: true }), teams: page.teams, subagents, agents: agentLookup });
  apply(host.ctx, {});
  await flush();

  const start = host.registrations.find((item) => item.definition.name === 'team_meeting_start');
  await start.definition.execute({ preset: 'lite@1' }, { agent: AGENT });

  const verify = subagents.calls.find((call) => call.stage === 'verify');
  assert.ok(verify !== undefined, 'verify 阶段必须真被投出去');
  /* `lite@1` 的 verify 是盲阶段、且 `withheld: ['design.reasoning']`。 */
  assert.equal(verify.text.includes('reasoning'), false, '被 withheld 的产物 id 不许出现在投递文本里');
  assert.equal(verify.text.includes('的 claim：'), false, '盲阶段不许看到上一阶段的 claim');
  /* 反向自检：被藏起来的东西**本来**在驱动器组好的消息之外 —— 证明这条断言不是空转。 */
  const design = subagents.calls.find((call) => call.stage === 'design');
  assert.equal(design.text.includes('的 claim：'), true, '非盲阶段必须看得到 claim（否则上面那条无意义）');
});

test('P3-2 ㉜：主开关关着 → `team_meeting_start` 的 when 为 false，绕过 when 直接调也被拒（它会建任务、派活、写账本）', async () => {
  const page = makeWritingTeams();
  const offHost = makePageHost({ kv: makeKv(), teams: page.teams, subagents: makeFakeSubagents(() => null), agents: agentLookup });
  apply(offHost.ctx, {});
  await flush();

  /* 开关的语义是"模型看不见"，**不是**"不注册"：`register` 照常发生，`when` 每次调用才判。
   * 所以这里断言的是**可见性**，别把它写成"注册表里没有"。 */
  const offStart = offHost.registrations.find((item) => item.definition.name === 'team_meeting_start');
  assert.ok(offStart !== undefined, '注册照常 —— when 才是那道门');
  assert.equal(offStart.options.when({ agent: AGENT }), false, '开关关着 → 真成员也看不见这个工具');
  /* 第二道门：即便有人拿着**关着开关那台**的定义直接调，也必须被拒，且不许建任何任务。 */
  page.calls.length = 0;
  await assert.rejects(() => offStart.definition.execute({ preset: 'lite@1' }, { agent: AGENT }));
  assert.equal(
    page.calls.some(([method]) => method === 'createTask' || method === 'updateTask'),
    false,
    '被拒时一个字节都不许写',
  );
});

test('P2-9 ㉘：两个动作工具都注册了，缺身份抛错，开关关着时 execute 被拒（第二道门）', async () => {
  const kv = makeKv({ enabled: true });
  const page = makeWritingTeams();
  const host = makePageHost({ kv, teams: page.teams });
  apply(host.ctx, {});
  await flush();

  const submit = host.registrations.find((item) => item.definition.name === 'team_meeting_submit');
  const upgrade = host.registrations.find((item) => item.definition.name === 'team_meeting_upgrade');
  assert.ok(submit !== undefined, 'team_meeting_submit 必须注册');
  assert.ok(upgrade !== undefined, 'team_meeting_upgrade 必须注册');

  /* 缺调用方 Agent：不许拿别人的身份凑，直接抛。 */
  await assert.rejects(() => submit.definition.execute({ stageId: 'challenge', attempt: 1, status: 'done' }, {}));

  /* 开关关着：`when` 只是让模型看不见，绕过 `when` 直接调必须被拒。 */
  const offHost = makePageHost({ kv: makeKv(), teams: page.teams });
  apply(offHost.ctx, {});
  await flush();
  const offSubmit = offHost.registrations.find((item) => item.definition.name === 'team_meeting_submit');
  const offUpgrade = offHost.registrations.find((item) => item.definition.name === 'team_meeting_upgrade');
  await assert.rejects(() => offSubmit.definition.execute({ stageId: 'challenge', attempt: 1, status: 'done' }, { agent: AGENT }));
  await assert.rejects(() => offUpgrade.definition.execute({ toQualified: 'standard@1' }, { agent: AGENT }));
});

test('P3-5 R-4. 跑一场会后 `agent` 真的写回阶段块，且 `agentRoster` 读得回来（下一次的"谁存在"就靠它）', async () => {
  const page = makeWritingTeams();
  const subagents = makeFakeSubagents((stageId) => goodMeetingArtifact(stageId));
  const host = makePageHost({ kv: makeKv({ enabled: true }), teams: page.teams, subagents, agents: agentLookup });
  apply(host.ctx, {});
  await flush();

  const start = host.registrations.find((item) => item.definition.name === 'team_meeting_start');
  const value = await start.definition.execute({ preset: 'lite@1', question: '接线检查' }, { agent: AGENT });
  assert.equal(value.ok, true, value.report);

  /* 名册：每个阶段都该有一条，agentId 必须非空、且与投递时的 child id 对得上。 */
  const roster = agentRoster(page.tree);
  /* ⚠️ 这条现在**红着**，而且红在 `src/ledger.mjs`，不是我这一层：
   * `ledgerWritePlan` 拼阶段块时没有把 `record.agent` 传进 `renderStageBlock`
   * （渲染函数支持这个键，接线漏了），于是 `agent:` 永远不落盘、
   * `agentRoster` 永远读到空名册 —— 第 2/3 件要的"下次从 roster 读回来"
   * 在真机上是**空转**的。已如实上报，等 owner 修 plan 的接线。 */
  assert.equal(roster.entries.length, 4, `四个阶段都该进名册，实际 ${JSON.stringify(roster.entries)}（ledgerWritePlan 未接线 record.agent）`);
  assert.equal(roster.entries.every((entry) => typeof entry.agentId === 'string' && entry.agentId !== ''), true);
  assert.equal(roster.issues.length, 0, `不该有读不出来的块：${JSON.stringify(roster.issues)}`);

  const byStage = new Map(roster.entries.map((entry) => [entry.stageId, entry.agentId]));
  assert.deepEqual([...byStage.keys()].sort(), ['challenge', 'confirm', 'design', 'verify']);
  /* 每阶段的 agentId 必须是投递那一刻宿主真给出的那个，不是编的。
   *
   * **两条投递路径都要收**：`startActivation` 的证据在 `childId`，`sendMessage` 的在
   * `targetId`。只收前者的话，一场会里只要出现过一次复用（`reuse`/`queue`），
   * 那条路的 id 就从来没被这条断言验过 —— 那正是本项目"看起来验了、实际少一半"的形状。
   * `readArtifact` 是**回收**不是投递，必须排除，否则它会把"读过谁"混进"投给谁"。 */
  const deliveredIds = subagents.calls
    .filter((call) => call.via !== 'readArtifact')
    .map((call) => (call.via === 'startActivation' ? call.childId : call.targetId));
  assert.equal(deliveredIds.length, 4, `四个阶段各投递一次，实际 ${JSON.stringify(deliveredIds)}`);
  assert.equal(
    deliveredIds.every((id) => typeof id === 'string' && id !== ''),
    true,
    `投递那一刻必须真拿到 id（拿不到就该如实失败，不许留空）：${JSON.stringify(deliveredIds)}`,
  );
  assert.equal(
    [...byStage.values()].every((id) => deliveredIds.includes(id)),
    true,
    `账本里的 agent 必须是投递时拿到的 id（账本 ${JSON.stringify([...byStage.values()])} vs 投递 ${JSON.stringify(deliveredIds)}）`,
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P3-7：给 ledger 的四态装断点护栏
 *
 * 三件事，缺一不可：
 *   ① 形态：每个态都必须有 `readable` 且是**布尔**（不是 undefined、不是 'true'）；
 *   ② 态覆盖：四个态都必须**被产出过**（一个永远不被生产的态，它的渲染分支就是装饰）；
 *   ③ 枚举 + 带理由豁免：产出点只有这些，新增即红、删除也即红。
 *
 * ## 为什么不用"总数 > 0"防空转
 * 侦察版扫描器报过 3 处而实际 5 处 —— 它漏了 `payload.ledger = …` 那两处
 * （局部变量 `payload` 本身就是 gates payload），**却照样通过了 `>= 1`**。
 * `> 0` 防得住"一个都没扫到"，防不住"扫到一半"。所以这里用**与清单逐条相等**来兜。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 会议账本的**全部**产出点。每一条都必须能说出"右侧为什么是构造点"。 */
const LEDGER_SITES = Object.freeze([
  { sig: 'ledger=ledgerUnavailable(agentTeams)', why: 'gates() 的第一条 unavailable 出口：没有 Agent Teams 就构造一个 unavailable 槽，不是手写对象。' },
  { sig: 'ledger=ledgerUnavailable(agent)', why: 'gates() 的第二条 unavailable 出口（缺调用方 Agent）：同样走构造点。' },
  { sig: 'ledger=ledgerUnavailable(error)', why: 'gates() 第三条 unavailable 出口（外层 catch）：异常路径也必须产出一个合法槽，不许漏成 undefined。' },
  {
    sig: 'payload.ledger=ledgerPayload',
    why: '正常路径：`ledgerPayload(tasks)` 从任务树投影出会议账本（四态里的 none/ok/unreadable 都出自这里）。'
      + 'P3-12 的 `attachStagePlan(...)` 在**同一个槽上就地**多挂一个 `stagePlan` 字段，'
      + '不产生第二个产出点 —— 所以这里仍然只有一个构造点，右侧也仍然认得出来。',
  },
  { sig: 'payload.ledger=ledgerSlot', why: '异常兜底：ledgerPayload 自己抛了就构造一个 unreadable 槽 —— 兜底也不许手写对象。' },
]);

/**
 * 同名异义、必须豁免的产出点。
 *
 * **P3-9 之后这里是空的。** 原来有一条：`snapshot()` 里的顶层 `ledger: await readLedger()`
 * 是插件的**角色台账**（落 storage），与会议账本同名，套不上"会议账本构造点"这条判据。
 * 顶层那块已改名为 `roleLedger`，重名消失 —— 于是**豁免不再需要**。
 *
 * 这张表现在恒为空，而它仍然有用：将来若再出现"必须开例外"的产出点，必须在这里
 * 留下一条带非空 `why` 的记录，并且下面那条"豁免条数 == 0"会立刻红。
 * **豁免即债**：这张表非空就说明有一笔债务还没还。
 */
const LEDGER_EXEMPTIONS = Object.freeze([]);

/**
 * 扫描 `host/index.js`：找出所有给 `ledger` 赋值/产出 的地方。
 *
 * 三条实现要求都来自踩过的坑：
 *   - **跳过注释行**：`collectSrcImports` 曾因为不剥注释，把一行 JSDoc 当成真依赖抓走；
 *   - **不误抓 `===`**：`projected.ledger === null` 是**读**不是赋值；
 *   - **不管行号**：用「接收者 + 构造点 + 字面量入参」当签名，行号一变动不该红。
 */
function scanLedgerSites(source) {
  const ASSIGN = /(?<![\w.])((?:(?:payload|gates|value|result)\s*\.\s*)?)ledger\s*(?::(?!=)|=(?![=>]))\s*(.*)$/;
  const sites = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    /* 注释行整行跳过：块注释正文（`* …`）与行注释。 */
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

    const matched = raw.match(ASSIGN);
    if (matched === null) continue;

    const lhs = `${String(matched[1] ?? '').replace(/\s+/g, '')}ledger`;
    const rhs = String(matched[2] ?? '').trim();

    const ctorMatch = rhs.match(/^(ledgerSlot|ledgerUnavailable|ledgerPayload)\s*\(/);
    if (ctorMatch !== null) {
      const argMatch = rhs.match(/\(\s*'([^']*)'\s*\)/);
      const arg = argMatch === null ? '' : `(${argMatch[1]})`;
      sites.push({ line: index + 1, lhs, rhs, sig: `${lhs}=${ctorMatch[1]}${arg}`, kind: 'ctor' });
      continue;
    }
    if (/^await\s+readLedger\s*\(/.test(rhs)) {
      sites.push({ line: index + 1, lhs, rhs, sig: `${lhs}=readLedger()`, kind: 'read-ledger' });
      continue;
    }
    sites.push({ line: index + 1, lhs, rhs, sig: `${lhs}=<literal>`, kind: 'literal' });
  }
  return sites;
}

test('P3-7 ①形态：四个态的 ledger 都必须带 `readable`，且是**布尔**', async () => {
  const block = (lines) => ['```team-board-meeting', ...lines, '```'].join('\n');
  const task = (desc, id) => ({ id, revision: 1, subject: `T${id}`, description: desc, status: 'pending' });

  const slots = [];
  /* none / ok / unreadable：都出自 `ledgerPayload`。 */
  slots.push({ label: 'none', value: ledgerPayload([]) });
  slots.push({
    label: 'ok',
    value: ledgerPayload([
      task(block(['meeting: m-01', 'preset: lite@1', 'status: running']), 'P'),
      task(block(['meeting: m-01', 'stage: challenge', 'attempt: 1', 'status: done']), 'S'),
    ]),
  });
  slots.push({ label: 'unreadable', value: ledgerPayload([task('```team-board-meeting\nmeeting: m-01\n', 'X')]) });

  /* unavailable：只能从 gates() 的出口拿（没有 Agent Teams 时的第一条出口）。 */
  const bornWithoutTeams = onSwitch(createBoardState(makeServiceCtx({})));
  const snapshot = await bornWithoutTeams.snapshot({ sessionId: AGENT.id });
  slots.push({ label: 'unavailable', value: snapshot.gates.ledger });

  assert.equal(slots.length, 4, '四个态各一个样本');

  for (const slot of slots) {
    assert.equal(
      Object.hasOwn(slot.value, 'readable'),
      true,
      `${slot.label} 态缺少 readable —— 页面读不到这个键就拿不到布尔，只能自己猜`,
    );
    assert.equal(typeof slot.value.readable, 'boolean', `${slot.label} 态的 readable 必须是布尔，收到 ${typeof slot.value.readable}`);
  }

  /* ② 态覆盖：四个态都必须**真的被产出过** —— 一个不被生产的态，它的渲染分支就是装饰。 */
  const produced = new Set(slots.map((slot) => slot.value.state));
  assert.deepEqual(
    [...produced].sort(),
    ['none', 'ok', 'unavailable', 'unreadable'],
    `四个态必须都被产出过，实际只见到 ${JSON.stringify([...produced])}`,
  );
});

test('P3-7 ③枚举：ledger 的产出点与清单**逐条相等**（新增即红、删除也即红），豁免恰好一条', () => {
  const source = readFileSync(new URL('../host/index.js', import.meta.url), 'utf8');
  const sites = scanLedgerSites(source);

  const exemptSigs = new Set(LEDGER_EXEMPTIONS.map((item) => item.sig));
  const actual = sites.filter((site) => !exemptSigs.has(site.sig));
  const actualExempt = sites.filter((site) => exemptSigs.has(site.sig));

  const declared = LEDGER_SITES.map((item) => item.sig).sort();
  const found = actual.map((site) => site.sig).sort();

  /* 防空转 + 防漏扫：**逐条相等**，不是 `> 0`。
   * 少一处（删了出口 / 扫到一半）与多一处（新增出口）都必须红。 */
  assert.deepEqual(found, declared, `产出点与清单不相等。实际：${JSON.stringify(found)}；清单：${JSON.stringify(declared)}（扫描共 ${sites.length} 处）`);

  /* 右侧是**手写对象字面量**的条数必须为 0 —— 那正是"绕开构造点"的形状。 */
  const literals = sites.filter((site) => site.kind === 'literal');
  assert.equal(
    literals.length,
    0,
    `有 ${literals.length} 处 ledger 是手写对象字面量（应为 0）：${JSON.stringify(literals.map((s) => `:${s.line} ${s.rhs}`))}`,
  );

  /* 豁免必须为 0：P3-9 消掉重名之后，这条清单**一条都不该剩**。
   * 若它非空，说明有人又给某个产出点开了例外 —— 那要么是重名回来了，
   * 要么是有人把手写对象字面量塞进豁免里混过去。 */
  assert.equal(actualExempt.length, 0, `豁免条数必须是 0，实际 ${actualExempt.length}：${JSON.stringify(actualExempt.map((s) => s.sig))}`);

  /* 每一条都带非空 `why`：只填位置等于没写理由。 */
  for (const item of [...LEDGER_SITES, ...LEDGER_EXEMPTIONS]) {
    assert.equal(typeof item.why === 'string' && item.why.trim() !== '', true, `清单项 ${item.sig} 缺少非空 why`);
  }

  /* P3-9 的独立钉子：源码里**不许**再出现 `payload.ledger = …`（会议账本在 gates 下）时
   * 与顶层同名的那种写法。顶层已经叫 `roleLedger`，所以这里连"顶层还有一个 ledger 键"
   * 这件事都不该出现 —— 扫描器会把任何 `ledger: await readLedger()` 记成
   * `ledger=readLedger()`，那正是被消掉的那条。 */
  assert.equal(
    sites.some((site) => site.sig === 'ledger=readLedger()'),
    false,
    '顶层不许再出现 `ledger: await readLedger()` —— 它已改名为 roleLedger',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P3-14：开关必须管住"读取" —— 关掉 = 完全不参与
 *
 * 这一组**不写"不许读"**，只数调用次数。理由：`"不许读"` 是一句意图，
 * 而 `=== 0` 是一个可以被证伪的事实。短路点要是放在 `listTasks` 之后，
 * 功能表现上"什么都没变"，只有计数能抓住它。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('P3-14 D-1. 关掉之后一次宿主读取都不发生：四个被 spy 的调用恰好 0 次', async () => {
  const teams = makeTeams({ tasks: [hostTask(MEETING_PARENT, { id: 'MP' })], memberName: 'alice' });
  /* 存储里显式写 {enabled:false}：不是"没表态"，是"用户明确关掉了"。 */
  const kv = makeKv({ enabled: false });
  const state = createBoardState(makeServiceCtx({
    storage: kv.storage,
    agentTeams: teams.teams,
    agents: { get: () => AGENT },
  }));

  /* 先把 `hydrate()` 那一次读掉，再开始计数。
   *
   * 这一格是 P3-14 里**唯一允许的读取**：`hydrate` 读的是 `state` 表里的
   * `enabled` 记录本身 —— 开关自己的状态，不是派生数据。不禁用它，开关才打得开；
   * 禁用它，开关会把自己锁死在"关"上，而外面永远看不到原因。
   * 所以这里显式地把它先跑掉，让下面的计数只覆盖"派生数据的读取"。 */
  await state.hydrate();
  assert.equal(state.getState().enabled, false, '前提：存储里写的是关');
  const ledgerLoadsBefore = kv.counts.loadAll;

  const payload = await state.snapshot({ sessionId: AGENT.id });

  /* ① 计数：这才是这一条的牙。 */
  const counts = {
    listTasks: teams.calls.filter((c) => c[0] === 'listTasks').length,
    listMembers: teams.calls.filter((c) => c[0] === 'listMembers').length,
    membership: teams.calls.filter((c) => c[0] === 'membership').length,
    readLedger: kv.counts.loadAll - ledgerLoadsBefore,
  };
  assert.deepEqual(
    counts,
    { listTasks: 0, listMembers: 0, membership: 0, readLedger: 0 },
    '关掉 = 不读。任何一项不是 0，就说明短路点落在了读取之后 —— 那种情况功能上看不出问题',
  );

  /* ② 第五态：`disabled`，不许复用 `unavailable`（"你关了" ≠ "它坏了"）。 */
  assert.equal(payload.gates.status, 'disabled');
  assert.equal(payload.gates.reason, 'userDisabled');

  /* ③ 派生块**缺席**。用 `hasOwn` 而不是 `=== undefined`：
   * 后者会被"显式赋 undefined"满足，那这条断言就没有牙了。 */
  assert.equal(Object.hasOwn(payload, 'dataSource'), false, '关掉时不许带 dataSource');
  assert.equal(Object.hasOwn(payload, 'roleLedger'), false, '关掉时不许带角色台账');
  for (const key of ['blockers', 'warnings', 'shadow', 'ledger']) {
    assert.equal(
      Object.hasOwn(payload.gates, key),
      false,
      `关掉时 gates.${key} 必须缺席 —— 空数组会被读成"核过了，一条都没有"`,
    );
  }

  /* ④ 开关自己那格还在：否则页面连"你关了"都显示不出来。 */
  assert.equal(payload.enabled, false);
});

test('settingsOnly reads enabled without probing team, roster, gates or role ledger while enabled', async () => {
  const kv = makeKv({ enabled: true }); const probes = [];
  const state = createBoardState({ get(key) { probes.push(key); if (key === 'storage') return kv.storage; throw new Error(`unexpected ${key}`); } });
  await state.hydrate(); const loads = kv.counts.loadAll; const before = probes.length;
  assert.deepEqual(await state.snapshot({ sessionId: AGENT.id, settingsOnly: true }), { enabled: true });
  assert.deepEqual(probes.slice(before), []); assert.equal(kv.counts.loadAll, loads, 'settings read must not load role ledger');
  await state.setEnabled(false); const afterToggle = kv.counts.loadAll;
  assert.deepEqual(await state.snapshot({ settingsOnly: true }), { enabled: false });
  assert.equal(kv.counts.loadAll, afterToggle);
});

test('settingsOnly state route keeps enable toggles light and leaves default snapshots intact', async () => {
  const kv = makeKv({ enabled: true }); const teams = makeTeams({ tasks: [] }); const connection = makeConnection();
  const state = createBoardState(makeServiceCtx({storage:kv.storage, agentTeams:teams.teams, agents:{get:()=>AGENT}}));
  registerStateRoute(makeServiceCtx({connection}), state); const route = connection.routes[0];
  const send = async (body) => (await (await route.fetch({json:async()=>body})).json()).value;
  assert.deepEqual(await send({settingsOnly:true,sessionId:AGENT.id}), {enabled:true});
  assert.equal(teams.calls.length, 0);
  assert.deepEqual(await send({settingsOnly:true,enabled:false}), {enabled:false});
  assert.deepEqual(await send({settingsOnly:true,enabled:true}), {enabled:true});
  assert.equal(teams.calls.length, 0);
  const full = await send({sessionId:AGENT.id}); assert.ok(full.gates); assert.ok(full.roleLedger); assert.ok(full.dataSource);
  assert.ok(teams.calls.length > 0);
});

test('P3-14 D-2. 打开之后同一份宿主**确实会读** —— 否则上面那条会被"什么都不产出"满足', async () => {
  /* 反向自检。没有这一条，D-1 的全部断言都会被一个"永远早退"的实现满足，
   * 而那种实现等于插件死了。 */
  const teams = makeTeams({ tasks: [hostTask(MEETING_PARENT, { id: 'MP' })], memberName: 'alice' });
  const kv = makeKv({ enabled: true });
  const state = createBoardState(makeServiceCtx({
    storage: kv.storage,
    agentTeams: teams.teams,
    agents: { get: () => AGENT },
  }));

  const payload = await state.snapshot({ sessionId: AGENT.id });

  assert.equal(teams.calls.filter((c) => c[0] === 'listTasks').length > 0, true, '开着就该真的读');
  assert.equal(kv.counts.loadAll > 0, true, '开着就该真的读角色台账');
  assert.equal(payload.gates.status, 'ok');
  assert.equal(Object.hasOwn(payload, 'dataSource'), true, '开着时 dataSource 必须在');
  assert.equal(Object.hasOwn(payload, 'roleLedger'), true, '开着时角色台账必须在');
});

test('P3-14 D-3. `getState()` 关掉时也不探宿主（`dataSourceOf` 里就是 `ctx.get`）', () => {
  /* 这一处最容易被放过：它长得像"控制面"，其实是两次 `ctx.get`。 */
  const probes = [];
  const state = createBoardState({
    get(key) {
      probes.push(key);
      return undefined;
    },
  });

  const before = probes.length;
  const value = state.getState();
  assert.deepEqual(value, { enabled: false }, '关掉时只报 enabled');
  assert.equal(probes.length - before, 0, `关掉时 getState() 不许探宿主，实际探了 ${probes.length - before} 次`);
  assert.equal(Object.hasOwn(value, 'dataSource'), false, '不许带 dataSource');
});

test('P3-14 D-4. 三个入口**各自**短路：直接调它们（绕过 snapshot 的早退）也必须一次不读', async () => {
  /* 为什么必须单独测这三处：
   * `snapshot()` 的早退会把正常路径全挡住，于是 `gates()` / `roster()` / `readLedger()`
   * 里那三处短路**永远走不到** —— 删掉它们一条测试都不会红。那样它们就不是防护，
   * 只是三段看起来像防护的注释。
   *
   * 真实场景是存在的：任何一条新路由、任何一次直接调用都会绕开 snapshot。
   * "关掉不读"不能靠调用方的自觉。 */
  const teams = makeTeams({ tasks: [hostTask(MEETING_PARENT, { id: 'MP' })], memberName: 'alice' });
  const kv = makeKv({ enabled: false });
  const state = createBoardState(makeServiceCtx({
    storage: kv.storage,
    agentTeams: teams.teams,
    agents: { get: () => AGENT },
  }));

  /* `gates()` 直接调 */
  const gateValue = await state.gates(AGENT.id);
  assert.equal(gateValue.status, 'disabled', 'gates() 关掉时给 disabled');
  assert.equal(
    teams.calls.filter((call) => call[0] === 'listTasks').length,
    0,
    'gates() 关掉时一次 listTasks 都不许发生',
  );
  assert.equal(Object.hasOwn(gateValue, 'ledger'), false, '关掉时会议账本**缺席**，不是 unavailable');

  /* `roster()` 直接调 */
  const rosterValue = await state.roster(AGENT.id);
  assert.equal(rosterValue.status, 'disabled', 'roster() 关掉时给 disabled');

  /* `readLedger()` 直接调 */
  const before = kv.counts.loadAll;
  const ledgerValue = await state.readLedger();
  assert.equal(ledgerValue.status, 'disabled', 'readLedger() 关掉时给 disabled');
  assert.equal(kv.counts.loadAll - before, 0, 'readLedger() 关掉时一次存储读取都不许发生');
  assert.deepEqual(ledgerValue.roles, []);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P3-12：页面要能看出"还差几关"（`gates.ledger.stagePlan`）
 *
 * 缺口：`ledgerFromTasks` 的 `stages` 只含**已写进块**的阶段，所以页面看得出
 * "已经到哪"、看不出"还差几关"。这个字段的来源只能是**预设**，不许从
 * "已写入 + 猜"推 —— 猜出来的剩余在预设升版时会错得很自然。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 造一份会议任务树：父块 + 若干阶段回执（用真预设 `lite@1` 的阶段名）。 */
function meetingTreeWith(stageIds) {
  const block = (lines) => ['```team-board-meeting', ...lines, '```'].join('\n');
  const tasks = [
    hostTask(block(['meeting: m-p12', 'preset: lite@1', 'status: running']), { id: 'P12' }),
  ];
  stageIds.forEach((stageId, index) => {
    tasks.push(hostTask(
      block([`meeting: m-p12`, `stage: ${stageId}`, `attempt: 1`, `status: done`]),
      { id: `S12${index}` },
    ));
  });
  return tasks;
}

function pageGatesFor(tasks) {
  const teams = makeTeams({ tasks, memberName: 'alice' });
  return onSwitch(createBoardState(makeServiceCtx({
    agentTeams: teams.teams,
    agents: { get: () => AGENT },
  }))).gates(AGENT.id);
}

test('P3-12 ①. ok + 预设可读 + 阶段都在预设内 → 出现 stagePlan，数字与阶段名正确', async () => {
  const gates = await pageGatesFor(meetingTreeWith(['challenge', 'confirm']));

  assert.equal(gates.status, 'ok');
  assert.equal(Object.hasOwn(gates.ledger, 'stagePlan'), true, 'ok 态必须带 stagePlan');

  const plan = gates.ledger.stagePlan;
  /* 数字必须与预设一致（lite@1 是 4 个阶段：challenge / confirm / design / verify）。 */
  assert.equal(plan.preset, 'lite@1');
  assert.equal(plan.total, 4, '总数来自预设，不是"已写入的条数"');
  assert.equal(plan.done, 2, '已完成 2 个');
  assert.deepEqual(plan.remaining, ['design', 'verify'], '还差的那两个必须来自预设顺序');
  assert.deepEqual(plan.stages, ['challenge', 'confirm', 'design', 'verify']);
});

test('P3-12 ②. 预设读不出来 → stagePlan **缺席**（不是 0/0）', async () => {
  /* 用一个预设文件里不存在的档位名：`loadPreset` 会失败，于是不该有进度。 */
  const block = (lines) => ['```team-board-meeting', ...lines, '```'].join('\n');
  const tasks = [
    hostTask(block(['meeting: m-p12b', 'preset: nosuch@9', 'status: running']), { id: 'P12B' }),
    hostTask(block(['meeting: m-p12b', 'stage: challenge', 'attempt: 1', 'status: done']), { id: 'S12B' }),
  ];
  const gates = await pageGatesFor(tasks);

  assert.equal(gates.ledger.state, 'ok', '账本本身仍然读得出来');
  assert.equal(
    Object.hasOwn(gates.ledger, 'stagePlan'),
    false,
    '预设读不出来 ⇒ 字段**缺席**。显示 0/0 会把"没数过"说成"数过、是空的"',
  );
});

test('P3-12 ③. 账本里有预设外的阶段（升版错位）→ stagePlan 缺席，不许硬算剩余', async () => {
  /* `lite@1` 里没有 `redteam`（那是 standard@1 的阶段）。硬算 `preset - done` 会得出
   * "还差 design、verify" 这种看着合理、实际错位的答案。 */
  const gates = await pageGatesFor(meetingTreeWith(['challenge', 'redteam']));

  assert.equal(gates.ledger.state, 'ok');
  assert.equal(
    Object.hasOwn(gates.ledger, 'stagePlan'),
    false,
    '账本与预设不一致时不许给进度 —— 那是"看着合理、实际错位"的典型',
  );
  /* ⚠️ 实测结论（写给下一个人）：`E_LEDGER_STRAY_STAGE` 目前**不在**页面路径的 `codes` 里。
   * 它在 `meeting.mjs` 的 `meetingState` 里发，而页面走的是 `ledgerFromTasks` ——
   * 两函数各算各的，所以这条码到不了 `gates.ledger.codes`。
   * 我没有为了这条测试去把它补进 codes：那等于给页面新增一条码，属于另一个任务；
   * 也没有另写一份"账本有没有杂阶段"的判断（任务里明确禁止造第二份）。
   * 这里只断言**本条要求的行为**：不一致时不给进度。 */
  assert.equal(
    gates.ledger.codes.includes('E_LEDGER_STRAY_STAGE'),
    false,
    '现状：这条码到不了页面路径（如需可见，另开任务从 meetingState 透传，别在这里造第二份判断）',
  );
});

test('P3-12 ④. 另外三态（none/unreadable/unavailable）各自都不出现 stagePlan', async () => {
  /* none：一条围栏都没有。 */
  const noneSlot = ledgerPayload([]);
  assert.equal(noneSlot.state, 'none');

  /* unreadable：围栏没闭合。 */
  const unreadableSlot = ledgerPayload([hostTask('```team-board-meeting\nmeeting: m-01\n', { id: 'X' })]);
  assert.equal(unreadableSlot.state, 'unreadable');

  /* 三态的槽里都不该有 stagePlan（它是 `ok` 专属的补字段）。 */
  for (const slot of [noneSlot, unreadableSlot]) {
    assert.equal(Object.hasOwn(slot, 'stagePlan'), false, `${slot.state} 态不该有 stagePlan`);
  }

  /* unavailable：没有 Agent Teams。 */
  const born = onSwitch(createBoardState(makeServiceCtx({})));
  const unavailableGates = await born.gates(AGENT.id);
  assert.equal(unavailableGates.status, 'unavailable');
  assert.equal(
    Object.hasOwn(unavailableGates.ledger, 'stagePlan'),
    false,
    'unavailable 态不该有 stagePlan（它连阶段表都没有）',
  );
});
