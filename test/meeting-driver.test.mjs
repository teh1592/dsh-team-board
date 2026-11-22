/**
 * `meeting-driver.test.mjs` — 驱动器的六条要求（P3-1）。
 *
 * 这里**不用假宿主**：驱动器把全部外部能力都做成了注入，所以一个 `deliver` +
 * 一个 `writeLedger` 就是一场会需要的全部"世界"。这也顺带证明了驱动器确实
 * 没有偷偷去摸 `ctx` / `teams` / `fs` / 时钟。
 *
 * 用 `lite@1` 真预设（4 阶段、2 个盲阶段、`minCount.killScenarios: 2`）跑 ——
 * 它是**真档**，不是"简化版空壳"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { driveMeeting, composeDelivery, createSubagentDeliver, candidateFromRoster } from '../host/meeting.js';
import { nextStage } from '../src/meeting.mjs';
import { pickDelivery } from '../src/adapter.mjs';

const LITE = JSON.parse(readFileSync(new URL('../presets/lite@1.json', import.meta.url), 'utf8'));

/** 一场刚开的会（与 `writeMeetingLedger` 建出来的形状一致）。 */
function freshMeeting(over = {}) {
  return {
    id: 'm-driver-1',
    preset: 'lite@1',
    status: 'running',
    stages: [],
    upgrades: [],
    ...over,
  };
}

/** 每个阶段一张**合格**的卡（必产字段齐全、`killScenarios` 有 2 条）。 */
function goodArtifact(stage) {
  const base = {
    id: `card-${stage.id}`,
    stage: stage.id,
    role: stage.role,
    claim: `${stage.id} 的结论：先做最小的一步`,
    basis: [{ kind: 'file', ref: 'plugin/src/board.mjs' }],
    risks: [],
    needsHuman: [],
    conflictsWith: [],
  };
  switch (stage.id) {
    case 'challenge':
      return { ...base, questions: ['这个需求真的必要吗', '不做会怎样'] };
    case 'confirm':
      return { ...base, requirements: ['只做 A 和 B'], answered: ['Q1→A1'] };
    case 'design':
      return { ...base, decisions: ['用现成的 lerp'], killScenarios: ['如果树是空的', '如果值为 NaN'] };
    case 'verify':
      return { ...base, verdict: 'pass', findings: ['没有发现阻断'] };
    default:
      return base;
  }
}

/** 假的世界：按阶段给卡，并把每次写账本记下来。 */
function makeWorld(over = {}) {
  const deliveries = [];
  const writes = [];
  const continues = [];
  let ledger = freshMeeting();

  const world = {
    deliveries,
    writes,
    continues,
    get ledger() {
      return ledger;
    },
    deliver: async ({ stage, attempt, message, mode, agentId }) => {
      deliveries.push({ stageId: stage.id, attempt, message, mode, agentId });
      if (typeof over.deliver === 'function') return over.deliver({ stage, attempt });
      return { artifact: goodArtifact(stage), lastToolCall: 1_000 };
    },
    writeLedger: async (meeting) => {
      writes.push(meeting);
      if (typeof over.writeLedger === 'function') {
        const forced = over.writeLedger({ meeting, writes });
        if (forced !== undefined) return forced;
      }
      ledger = meeting;
      return { ok: true, rows: [{ status: 'ok' }], codes: [] };
    },
    now: () => 1_000,
    ...over.deps,
  };
  return world;
}

/** 把"世界"摊成驱动器的依赖。缺的项是 `undefined`，驱动器会自己判断要不要用。 */
function depsOf(world) {
  return {
    preset: LITE,
    deliver: world.deliver,
    writeLedger: world.writeLedger,
    now: world.now,
    sendContinue: world.sendContinue,
    continuesFor: world.continuesFor,
    chooseAgent: world.chooseAgent,
    candidate: { id: 'agent-1' },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. 真跑一场 lite@1
 * ═══════════════════════════════════════════════════════════════════════════ */

test('D-1. `lite@1` 四个阶段真的跑完：顺序一致、账本读得回、收尾是 done', async () => {
  const world = makeWorld();
  const result = await driveMeeting(
    depsOf(world),
    { meeting: freshMeeting(), meetingId: 'm-driver-1' },
  );

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.status, 'done');
  assert.equal(result.stop, 'done');

  /* 投递顺序 = 预设顺序（不是插入顺序、不是字母序）。 */
  assert.deepEqual(
    world.deliveries.map((item) => item.stageId),
    ['challenge', 'confirm', 'design', 'verify'],
  );
  /* 4 个阶段各写一次 + 收尾写一次。 */
  assert.equal(world.writes.length, 5, `写账本次数应为 5，实际 ${world.writes.length}`);

  /* 账本上每个阶段都是 done，且 attempt 都是 1。 */
  assert.deepEqual(
    result.meeting.stages.map((row) => [row.stageId, row.status, row.attempt]),
    [
      ['challenge', 'done', 1],
      ['confirm', 'done', 1],
      ['design', 'done', 1],
      ['verify', 'done', 1],
    ],
  );
  assert.equal(result.meeting.status, 'done');
  /* 每一阶段都真的判过卡（不是"跳过了就记 done"）。 */
  assert.equal(result.trace.every((item) => item.judged.ok === true), true);

  /* 「待你拍板清单」：没有人报冲突 → 空表，而不是编一条出来。 */
  assert.deepEqual(result.pending, []);
});

test('D-2. 两个盲阶段都拿到了 `blind` 的投递文案，非盲阶段拿到了上一阶段的 claim', async () => {
  const world = makeWorld();
  await driveMeeting(
    depsOf(world),
    { meeting: freshMeeting(), meetingId: 'm-driver-1' },
  );

  const byStage = new Map(world.deliveries.map((item) => [item.stageId, item.message]));
  /* challenge 是第一个阶段、又是盲阶段：既没有历史，也不该出现任何 claim。 */
  assert.match(byStage.get('challenge'), /盲阶段/);
  assert.doesNotMatch(byStage.get('challenge'), /claim/);
  /* verify 也是盲阶段：strip 掉 claim，但产物名要留下来。 */
  assert.match(byStage.get('verify'), /盲阶段/);
  assert.doesNotMatch(byStage.get('verify'), /的 claim：/);
  assert.match(byStage.get('verify'), /已有的产物/);
  /* design 不是盲阶段：上一阶段的 claim 必须在。 */
  assert.match(byStage.get('design'), /的 claim：/);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. 盲阶段不许复用（判据在 agentpool，驱动器在信任边界上再核一次）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('D-3. 盲阶段拿到 `reuse` → 停，并报 E_BLIND_AGENT_REUSED（不许"看不见作者的推理"变成空话）', async () => {
  const world = makeWorld({
    deps: {
      chooseAgent: () => ({ ok: true, mode: 'reuse', agentId: 'agent-1', errors: [], warnings: [] }),
    },
  });
  const result = await driveMeeting(
    depsOf(world),
    { meeting: freshMeeting(), meetingId: 'm-driver-1' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.stop, 'blind-reuse');
  assert.equal(result.status, 'blocked');
  assert.equal(
    result.errors.some((error) => error.code === 'E_BLIND_AGENT_REUSED'),
    true,
    '必须用注册过的码，不许自己编文案',
  );
  /* 一个阶段都没投递、一次都没写 —— 拒绝要发生在最外层。 */
  assert.equal(world.deliveries.length, 0);
  assert.equal(world.writes.length, 0);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. 判不了不放行
 * ═══════════════════════════════════════════════════════════════════════════ */

test('D-4. 卡缺必须字段 → 停在该阶段，账本里它不是 done，且**绝不降低要求**', async () => {
  const world = makeWorld({
    deliver: ({ stage }) => {
      const artifact = goodArtifact(stage);
      if (stage.id === 'confirm') {
        /* 少了 `answered` —— 交上来的东西不完整。 */
        delete artifact.answered;
      }
      return { artifact, lastToolCall: 1_000 };
    },
  });
  const result = await driveMeeting(
    depsOf(world),
    { meeting: freshMeeting(), meetingId: 'm-driver-1' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.stop, 'artifact');
  assert.equal(result.errors.some((error) => error.code === 'E_ARTIFACT_MISSING'), true);

  /* 停在 confirm：challenge 已经记上了，confirm 没有。 */
  const rows = result.meeting.stages.map((row) => [row.stageId, row.status]);
  assert.deepEqual(rows, [['challenge', 'done']]);
  assert.equal(result.meeting.status, 'running', '没收尾就还是 running，不许被写成 done');

  /* 只写了一次（challenge），confirm 一个字节都没写。 */
  assert.equal(world.writes.length, 1);
  assert.equal(world.deliveries.map((item) => item.stageId).join(','), 'challenge,confirm');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. 写失败不重发
 * ═══════════════════════════════════════════════════════════════════════════ */

test('D-5. 写账本失败 → 停，且该阶段只被投递一次（绝不重发）', async () => {
  let deliverCount = 0;
  const world = makeWorld({
    deliver: ({ stage }) => {
      deliverCount += 1;
      return { artifact: goodArtifact(stage), lastToolCall: 1_000 };
    },
    writeLedger: () => ({ ok: false, rows: [{ status: 'failed' }], codes: ['E_LEDGER_WRITE_FAILED'] }),
  });
  const result = await driveMeeting(
    depsOf(world),
    { meeting: freshMeeting(), meetingId: 'm-driver-1' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.stop, 'write');
  assert.equal(
    result.errors.some((error) => error.code === 'E_LEDGER_WRITE_FAILED'),
    true,
    '写失败必须如实带出成因码',
  );
  assert.equal(deliverCount, 1, '写失败之后**绝不重发这个阶段** —— 重发会让同一阶段执行两次');
  assert.equal(world.writes.length, 1, '只尝试写了一次');
});

/** 已经跑完一个阶段的会（`at` 是很久以前）。存活判定要靠账本上的产物时间，
 * 所以"死了"这件事必须先有一份**有时间戳**的历史才判得出来。 */
const SEED_AT = '2026-11-22T00:00:00Z';
function seededMeeting() {
  return freshMeeting({
    stages: [{ stageId: 'challenge', attempt: 1, status: 'done', produced: ['questions'], at: SEED_AT }],
  });
}

test('D-6. 回执判 dead → 发「继续」；同一 attempt 已发 3 次 → E_RESUME_EXHAUSTED 交人，不再投递', async () => {
  const world = makeWorld({
    /* `lastToolCall` 极早 + 账本上的产物是两小时前 → 沉默远超 deadMs。 */
    deliver: ({ stage }) => ({ artifact: goodArtifact(stage), lastToolCall: 0 }),
    deps: {
      now: () => Date.parse('2026-11-22T02:00:00Z'),
      sendContinue: async (input) => { world.continues.push(input); },
      continuesFor: () => 3, // 已经发满 3 次
    },
  });
  const result = await driveMeeting(depsOf(world), { meeting: seededMeeting(), meetingId: 'm-driver-1' });

  assert.equal(result.ok, false);
  assert.equal(result.stop, 'exhausted');
  assert.equal(result.errors.some((error) => error.code === 'E_RESUME_EXHAUSTED'), true);
  assert.equal(result.trace[0].liveness, 'dead', '第一轮就该判成 dead');
  assert.equal(world.deliveries.length, 1, '交人之后一次都不许再投递');
  assert.equal(world.writes.length, 0, '一个阶段都没完成，账本不许写');
  assert.equal(world.continues.length, 0, '已经发满 3 次，不许再发第 4 次');
});

test('D-7. 回执判 dead 但还没发满 → 真发一条「继续」，且**不记账、不推进**', async () => {
  const world = makeWorld({
    deliver: ({ stage }) => {
      /* 发过「继续」之前，回执是死的；发过之后，它接着干了。 */
      if (world.continues.length === 0) return { artifact: null, lastToolCall: 0 };
      return { artifact: goodArtifact(stage), lastToolCall: 0 };
    },
    deps: {
      now: () => (
        world.continues.length === 0
          ? Date.parse('2026-11-22T02:00:00Z')
          : Date.parse(SEED_AT) + 1000
      ),
      sendContinue: async (input) => { world.continues.push(input); },
      continuesFor: () => world.continues.length,
    },
  });
  const result = await driveMeeting(depsOf(world), { meeting: seededMeeting(), meetingId: 'm-driver-1' });

  assert.equal(world.continues.length, 1, 'dead 时必须真的发一条「继续」');
  assert.match(world.continues[0].message, /现在要交/);
  assert.equal(result.stop, 'done', '活过来之后必须能把这场会跑完');
  const first = result.trace[0];
  assert.equal(first.liveness, 'dead');
  assert.equal(first.recorded, null, 'dead 的那一轮不许记账');
  assert.equal(first.attempt, 1, '同一 attempt 不许被推进');
  assert.equal(result.meeting.stages.find((row) => row.stageId === 'confirm').attempt, 1);
});


test('D-8. 跑完整场会也不许换档：preset 原样、upgrades 零增长（动手的只有人）', async () => {
  const world = makeWorld();
  const result = await driveMeeting(
    depsOf(world),
    { meeting: freshMeeting(), meetingId: 'm-driver-1' },
  );

  assert.equal(result.meeting.preset, 'lite@1', '档位是人的决定，机器不许自己动');
  assert.deepEqual(result.meeting.upgrades ?? [], [], '机器不许写换档历史');
  /* 驱动器**没有**换档入口 —— 有的话就是"机器能按换档杆"。 */
  const source = readFileSync(new URL('../host/meeting.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /applyUpgrade\s*\(/, '驱动层不许调 applyUpgrade：换档走 state.upgradeMeeting');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 附带：组消息的两根轴是正交的
 * ═══════════════════════════════════════════════════════════════════════════ */

test('D-9. 组消息：`blind`（剥推理）与 `withheld`（藏点名产物）是两根轴，不许合并', () => {
  const history = [{ stageId: 'design', claim: '我选了 lerp', produced: ['decisions', 'killScenarios'] }];

  /* 轴一：盲 → 剥推理，但**产物名留着**。盲不等于什么都没有。 */
  const blindStage = { id: 'verify', role: 'qa', blind: true, withheld: [], mustProduce: ['verdict'] };
  const blindText = composeDelivery({ stage: blindStage, history });
  assert.doesNotMatch(blindText, /我选了 lerp/, '盲阶段必须剥掉作者的推理');
  assert.match(blindText, /decisions/, '产物名要留着 —— 盲不等于什么都没有');

  /* 轴二：非盲 + `withheld` → claim 照给，但被点名的那一项要藏。
   * 一个非盲阶段照样可以藏某一项；两根轴互不覆盖。 */
  const openStage = { id: 'verify', role: 'qa', blind: false, withheld: ['design.killScenarios'], mustProduce: ['verdict'] };
  const openText = composeDelivery({ stage: openStage, history });
  assert.match(openText, /我选了 lerp/, '非盲阶段必须看得到上一阶段的 claim');
  assert.doesNotMatch(openText, /killScenarios/, 'withheld 与 blind 无关，非盲也照藏');
  assert.match(openText, /decisions/, '没被点名的产物不许连带藏掉');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 附带：`nextStage` 是唯一顺序来源（驱动器不许自己排阶段）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('D-10. 驱动器没有自己的阶段顺序：投递顺序必须等于 `nextStage` 一步步给出的顺序', async () => {
  const world = makeWorld();
  const result = await driveMeeting(
    depsOf(world),
    { meeting: freshMeeting(), meetingId: 'm-driver-1' },
  );

  /* 用同一份预设、同一套账本，独立地走一遍 `nextStage`。 */
  const expected = [];
  let meeting = freshMeeting();
  for (let index = 0; index < 8; index += 1) {
    const next = nextStage({ meeting, preset: LITE });
    if (next.done === true) break;
    expected.push(next.stage.id);
    meeting = { ...meeting, stages: [...meeting.stages, { stageId: next.stage.id, attempt: 1, status: 'done', produced: [] }] };
  }

  assert.deepEqual(world.deliveries.map((item) => item.stageId), expected);
  assert.equal(result.ok, true);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P3-2：真实投递 `createSubagentDeliver`
 *
 * 这一层是纯注入的，所以档位、加料、重试三件事都能**直接**钉死 ——
 * 通过工具跑只能覆盖 startActivation 那一条路，另外两档必须在这一层验。
 * ═══════════════════════════════════════════════════════════════════════════ */

function makeHost({ children = undefined, artifactCalls = [] } = {}) {
  const sent = [];
  const activated = [];
  const reads = [];
  const api = {
    sent,
    activated,
    reads,
    /* 契约：`list(): string[]` 列出注册过的 provider。真宿主靠它回答"该用谁"，
     * 所以假对象必须也有 —— 没有它，驱动器就选不出 provider。 */
    list() {
      return ['spawn'];
    },
    /* **按真契约逐字校验**。上一版这个假对象什么都收，于是 1489 条全绿、
     * 真宿主一按就 `no subagent provider registered for "undefined"` 然后崩。
     * 现在缺哪个字段就在这里抛，测试才会红在它该红的地方。 */
    async startActivation(spec) {
      if (typeof spec.provider !== 'string' || spec.provider === '') {
        throw new Error(`no subagent provider registered for "${String(spec.provider)}"`);
      }
      if (typeof spec.label !== 'string' || spec.label === '') throw new Error('label 必填');
      if (spec.signal === undefined || typeof spec.signal.aborted !== 'boolean') {
        throw new Error('signal 必须是 AbortSignal');
      }
      if (spec.delivery !== 'parent' && spec.delivery !== 'caller') throw new Error('delivery 必填');
      if (!Array.isArray(spec.request?.prompt)) throw new Error('request.prompt 必须是 ContentBlock[]');
      activated.push(spec);
      return {
        childId: 'child-new',
        messageId: 'msg-1',
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {},
      };
    },
    async sendMessage(_sender, targetId, content) {
      sent.push({ targetId, content });
      return { messageId: 'msg-1' };
    },
    readArtifact(childId) {
      reads.push(childId);
      artifactCalls.push(childId);
      return { id: 'card-x', stage: 'verify', role: 'qa', claim: '一句话', basis: [{ kind: 'file', ref: 'a' }], risks: [], needsHuman: [], verdict: 'pass', findings: ['ok'] };
    },
  };
  if (children !== undefined) {
    /* 契约要的是**字符串** session id。传对象，真宿主报
     * `session "[object Object]" not found` 并 fatal —— 这里必须一样凶。 */
    api.listChildren = async (parentSessionId) => {
      /* 契约要的是**字符串** session id，且它是 **async** —— 真宿主会 reject。
       * 上一版这个假对象是**同步**的，于是"同步 try/catch 抓不住 Promise"那个
       * 会杀死宿主进程的 bug 类别，在测试里物理上不可能显形。 */
      if (typeof parentSessionId !== 'string') {
        throw new Error(`session "${JSON.stringify(parentSessionId)}" not found`);
      }
      return children;
    };
  }
  return api;
}

test('P3-2 L-1. 三档都由 `pickDelivery` 决定：不存在 → startActivation，空闲 → queue，在跑 → steer', async () => {
  const parent = { id: 'parent-1' };
  const message = '阶段 verify（角色 qa）\n必产字段：verdict';

  /* 档位与 `pickDelivery` 的结论必须逐条对齐 —— 这是"不许新造分档"的钉子。 */
  const notExist = makeHost({ children: [] });
  const a = await createSubagentDeliver({ subagents: notExist, parent })({ stage: { id: 'verify' }, attempt: 1, message, mode: 'fresh', agentId: 'child-1' });
  assert.equal(a.tier, pickDelivery({ exists: false, idle: undefined }));
  assert.equal(a.tier, 'startActivation');
  assert.equal(notExist.sent.length, 0, '这一档不许走 sendMessage');

  const idleHost = makeHost({ children: [{ id: 'child-1', idle: true }] });
  const b = await createSubagentDeliver({ subagents: idleHost, parent })({ stage: { id: 'verify' }, attempt: 1, message, mode: 'reuse', agentId: 'child-1' });
  assert.equal(b.tier, pickDelivery({ exists: true, idle: true }));
  assert.equal(b.tier, 'queue');

  const busyHost = makeHost({ children: [{ id: 'child-1', idle: false }] });
  const c = await createSubagentDeliver({ subagents: busyHost, parent })({ stage: { id: 'verify' }, attempt: 1, message, mode: 'reuse', agentId: 'child-1' });
  assert.equal(c.tier, pickDelivery({ exists: true, idle: false }));
  assert.equal(c.tier, 'steer');
});

test('P3-2 L-2. 投递文本必须**逐字**等于驱动器给的那条 —— `deliver` 一个字都不许加', async () => {
  const parent = { id: 'parent-1' };
  const message = '阶段 verify（角色 qa）\n必产字段：verdict\n已有的产物（阶段 design）：decisions';

  const idleHost = makeHost({ children: [{ id: 'child-1', idle: true }] });
  await createSubagentDeliver({ subagents: idleHost, parent })({ stage: { id: 'verify' }, attempt: 1, message, mode: 'reuse', agentId: 'child-1' });
  assert.equal(idleHost.sent[0].content, message, 'sendMessage 收到的那条必须逐字相同');

  const newHost = makeHost({ children: [] });
  await createSubagentDeliver({ subagents: newHost, parent })({ stage: { id: 'verify' }, attempt: 1, message, mode: 'fresh', agentId: 'child-1' });
  assert.equal(newHost.activated[0].request.prompt[0].text, message, 'startActivation 收到的那条也必须逐字相同（正文在 request.prompt，不是 request.task —— 契约里没有 task 这个字段）');
});

test('P3-2 L-3. 拿不到产物只说一次"没拿到"，**不在这里重试**（上限归 resume.mjs）', async () => {
  const parent = { id: 'parent-1' };
  const reads = [];
  const subagents = {
    /* 真契约里 `list()` 是"该用哪个 provider"的唯一来源；缺了它，冷启动这一步
     * 会在调用宿主之前就如实失败（`no-provider`），产物那条路径根本走不到。 */
    list() { return ['spawn']; },
    async startActivation() { return { childId: 'child-1' }; },
    readArtifact(childId) { reads.push(childId); return null; },
  };

  const result = await createSubagentDeliver({ subagents, parent })({
    stage: { id: 'verify' }, attempt: 1, message: '阶段 verify（角色 qa）', mode: 'fresh', agentId: null,
  });

  assert.equal(result.artifact, null, '拿不到就如实说没拿到');
  assert.equal(reads.length, 1, '**只读一次**：重试是 resume 的事，不是 deliver 的事');
});

test('P3-2 L-4. 宿主目录**拒绝**不许冒泡成未处理拒绝（那会杀掉宿主进程），退回"状态未知"', async () => {
  const parent = { id: 'parent-1' };
  const subagents = {
    list() {
      return ['spawn'];
    },
    /* 真宿主就是这样：`listChildren` 是 async，读不出来时**reject**（SessionQueryError）。
     * 同步 `try/catch` 接不住它 —— 那个拒绝会变成 unhandledRejection，
     * 而 Node 默认 `--unhandled-rejections=throw` 直接把进程干掉。
     * 真机事故原文：`dsh: fatal load failure: SessionQueryError: …` + `host exited with 1`。 */
    listChildren(parentSessionId) {
      if (typeof parentSessionId !== 'string') {
        throw new Error(`session "${JSON.stringify(parentSessionId)}" not found`);
      }
      return Promise.reject(new Error('SessionQueryError: session not found'));
    },
    async sendMessage() {
      return { messageId: 'msg-x' };
    },
  };

  let unhandled = null;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  process.on('unhandledRejection', onUnhandled);
  let result;
  try {
    result = await createSubagentDeliver({ subagents, parent })({
      stage: { id: 'verify' },
      attempt: 1,
      message: '阶段 verify（角色 qa）',
      mode: 'reuse',
      agentId: 'child-1',
    });
    /* 给微任务/事件环一点时间，让任何漏网的拒绝有机会冒出来。 */
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.equal(unhandled, null, '拒绝必须被调用方接住 —— 未处理拒绝会把宿主进程打成 exit 1');
  /* 目录读不出来 = **状态未知**，不是"不存在"。档位由 `pickDelivery` 按 unknown 落，不在这里猜。 */
  assert.equal(result.tier, pickDelivery({ exists: true, idle: undefined }), '目录不可读 → 状态未知');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P3-5：`attempt` / `role` 接线 —— 判据在 `agentpool`，接线在这里
 *
 * `task-13` 给 `defaultAgentMode` 加了 `attempt` 与 `candidate.role` 两个入参。
 * 不传的后果很具体：`attempt` 缺省 1 ⇒ `fork` **永不**触发；`candidate.role`
 * 缺省空 ⇒ `reuse` **永不**触发。所以这一组不许只断言"传进去了"，
 * 必须断言"在该触发的地方真触发了"，而且要看得出**凭哪条规则**。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('P3-5 W-1. 真驱动一场 `lite@1`：返工到第 2 轮时 `fork` 真触发（rule=rework-fork）', async () => {
  /* 账本里 `confirm` 是**第 1 轮、failed** —— 返工的起点。
   * 第 2 轮那个数字**不再由人手写进账本**，而是 `nextStage` 从"上一轮 failed"算出来的
   * （P3-8：原来这里塞的是 `attempt: 2`，那是夹具绕法，掩盖了"failed 之后拿不到新轮次"的真缺陷）。 */
  const seeded = freshMeeting({
    stages: [
      { stageId: 'challenge', attempt: 1, status: 'done', produced: ['questions'], at: SEED_AT },
      { stageId: 'confirm', attempt: 1, status: 'failed', produced: [], at: SEED_AT },
    ],
  });

  const world = makeWorld();
  const result = await driveMeeting(
    { ...depsOf(world), candidate: { id: 'agent-1' } },
    { meeting: seeded, meetingId: 'm-driver-1' },
  );

  const confirm = result.trace.find((step) => step.stageId === 'confirm');
  assert.ok(confirm !== undefined, 'confirm 必须被投递');
  assert.equal(confirm.attempt, 2, '第 2 轮必须原样传下去');
  assert.equal(confirm.mode, 'fork', '第 2 轮 = 返工 → 必须 fork');
  assert.equal(confirm.rule, 'rework-fork', '要看得出**凭哪条规则**，不能只看 mode 像不像');
});

test('P3-5 W-2. 真驱动一场会：跨会议同角色 + 隔离成立 → `reuse` 真触发（rule=cross-meeting-reuse）', async () => {
  /* ⚠️ 这条必须用 `standard@1`，不能用 `lite@1`：
   * `reuse` 的另一半前提是"这一阶段确实声明了要扣住的东西"（`withheldIds` 非空，
   * 「空 ≠ 可用」那条红线）。`lite@1` 的两个非盲阶段 `confirm` / `design` 的
   * `withheld` **都是空数组** —— 也就是说 `reuse` 在 `lite@1` 下**结构上无法触发**。
   * 全项目只有 `standard@1` 的 `build`（非盲 + `withheld: ['redteam.killScenarios']`）
   * 满足条件。把测试写在 lite 上，它会因为"结构上不可能"而永远红或永远假绿。 */
  const standard = JSON.parse(readFileSync(new URL('../presets/standard@1.json', import.meta.url), 'utf8'));

  /* 前四个阶段已经跑完，轮到 `build`。 */
  const seeded = freshMeeting({
    preset: 'standard@1',
    stages: [
      { stageId: 'challenge', attempt: 1, status: 'done', produced: ['questions', 'claim'], at: SEED_AT },
      { stageId: 'confirm', attempt: 1, status: 'done', produced: ['requirements', 'answered'], at: SEED_AT },
      { stageId: 'design', attempt: 1, status: 'done', produced: ['decisions', 'claim'], at: SEED_AT },
      { stageId: 'redteam', attempt: 1, status: 'done', produced: ['killScenarios'], at: SEED_AT },
    ],
  });

  /* 候选人：在**别的会议**里承担 `dev`（正是 `build` 的角色）。 */
  const candidate = { id: 'agent-dev', role: 'dev', meetings: ['m-old'] };
  const world = makeWorld({
    deliver: ({ stage }) => ({
      artifact: { id: 'card-' + stage.id, stage: stage.id, role: stage.role, claim: '一句话', basis: [{ kind: 'file', ref: 'a' }], risks: [], needsHuman: [], conflictsWith: [], changed: ['plugin/src/x.mjs'], verdict: 'pass', findings: ['无阻断'], decision: 'accept' },
      lastToolCall: 1_000,
    }),
  });

  const result = await driveMeeting(
    { ...depsOf(world), preset: standard, candidate, seenIds: [] },
    { meeting: seeded, meetingId: 'm-driver-1' },
  );

  const build = result.trace.find((step) => step.stageId === 'build');
  assert.ok(build !== undefined, 'build 必须被投递');
  assert.equal(build.mode, 'reuse', '跨会议同角色 + 隔离成立 → 应当复用');
  assert.equal(build.rule, 'cross-meeting-reuse', '要看得出**凭哪条规则**');

  /* 反向自检：同一个候选人在 `lite@1` 的 design 上必须 fresh ——
   * 因为那一阶段的 `withheld` 是空的，隔离无从验证。这条同时钉住了
   * "reuse 不是恒真"，也钉住了 lite 的那个结构事实。 */
  const liteWorld = makeWorld();
  const liteRun = await driveMeeting(
    { ...depsOf(liteWorld), candidate: { id: 'agent-arch', role: 'architect', meetings: ['m-old'] }, seenIds: [] },
    { meeting: freshMeeting(), meetingId: 'm-driver-2' },
  );
  const design = liteRun.trace.find((step) => step.stageId === 'design');
  assert.equal(design.mode, 'fresh', 'lite 的 design 没有声明要扣住的产物 → 不许声称隔离成立');
  assert.notEqual(design.rule, 'cross-meeting-reuse');
});

test('P3-5 W-3. 盲阶段即使候选人完全符合复用的条件，也必须 `fresh`（blind 排在 reuse 前面）', async () => {
  /* `verify` 是盲阶段；把候选人做成"在别的会议当过 qa"也照样不许复用。 */
  const candidate = { id: 'agent-qa', role: 'qa', meetings: ['m-old'] };
  const world = makeWorld();
  const result = await driveMeeting(
    { ...depsOf(world), candidate, seenIds: [] },
    { meeting: freshMeeting(), meetingId: 'm-driver-1' },
  );

  const verify = result.trace.find((step) => step.stageId === 'verify');
  assert.equal(verify.mode, 'fresh', '盲阶段一律 fresh —— 这是盲审的定义，不是可商量的默认值');
  assert.equal(verify.rule, 'blind-fresh');
});

test('P3-5 W-4. 候选人**没声明角色**时不许拿 `stage.role` 顶上 —— 那等于编一个"它当过"', async () => {
  /* 这是"不许编"的钉子。候选人在别的会议里待过、`withheld` 也非空（`build`），
   * 唯一缺的就是"它承担过什么角色"。这一格没有真值，就必须退回 fresh；
   * 一旦有人图省事填 `role: stage.role`，`sameRole` 会立刻变真，reuse 就凭空成立了。 */
  const standard = JSON.parse(readFileSync(new URL('../presets/standard@1.json', import.meta.url), 'utf8'));
  const seeded = freshMeeting({
    preset: 'standard@1',
    stages: [
      { stageId: 'challenge', attempt: 1, status: 'done', produced: ['questions', 'claim'], at: SEED_AT },
      { stageId: 'confirm', attempt: 1, status: 'done', produced: ['requirements', 'answered'], at: SEED_AT },
      { stageId: 'design', attempt: 1, status: 'done', produced: ['decisions', 'claim'], at: SEED_AT },
      { stageId: 'redteam', attempt: 1, status: 'done', produced: ['killScenarios'], at: SEED_AT },
    ],
  });
  /* 关键：**没有 role**，但有跨会议经历。 */
  const candidate = { id: 'agent-x', meetings: ['m-old'] };
  const world = makeWorld({
    deliver: ({ stage }) => ({
      artifact: { id: 'card-' + stage.id, stage: stage.id, role: stage.role, claim: '一句话', basis: [{ kind: 'file', ref: 'a' }], risks: [], needsHuman: [], conflictsWith: [], changed: ['a'], verdict: 'pass', findings: ['无'], decision: 'accept' },
      lastToolCall: 1_000,
    }),
  });

  const result = await driveMeeting(
    { ...depsOf(world), preset: standard, candidate, seenIds: [] },
    { meeting: seeded, meetingId: 'm-driver-1' },
  );

  const build = result.trace.find((step) => step.stageId === 'build');
  assert.ok(build !== undefined, 'build 必须被投递');
  assert.equal(build.mode, 'fresh', '它没声明过角色 → 不许声称"同角色"，因此不许复用');
  assert.notEqual(build.rule, 'cross-meeting-reuse');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P3-5 第 2/3 件：候选人从名册来、干完记回 `agent`
 *
 * 「该用谁」的三个来源必须分清：
 *   - `agentId` ← `agentRoster(tasks)`（账本里我们自己写的 `agent` 那格）
 *   - `role`    ← 预设（名册**故意不给 role**，角色只存在于预设）
 *   - 用不用它  ← `decideAgent`（本层不判）
 * ═══════════════════════════════════════════════════════════════════════════ */

test('P3-5 R-1. 名册候选：agentId 从名册来、role 从预设来，按 stageId 关联', () => {
  const standard = JSON.parse(readFileSync(new URL('../presets/standard@1.json', import.meta.url), 'utf8'));
  const entries = [
    /* 在别的会议干过 `build`（role=dev） */
    { agentId: 'agent-dev', meetingId: 'm-old', stageId: 'build', taskId: 'T9' },
    /* 在别的会议干过 `confirm`（role=client）—— 角色不对，不该进候选 */
    { agentId: 'agent-cli', meetingId: 'm-old', stageId: 'confirm', taskId: 'T8' },
    /* 本会议的记录 —— 不构成"跨会议"候选 */
    { agentId: 'agent-me', meetingId: 'm-now', stageId: 'build', taskId: 'T7' },
  ];
  const stage = standard.stages.find((item) => item.id === 'build');

  const picked = candidateFromRoster({ entries, preset: standard, meetingId: 'm-now', stage });
  assert.deepEqual(picked, { id: 'agent-dev', role: 'dev', meetings: ['m-old'] });

  /* 角色不符 / 只有本会议记录 → 没有候选（不是"随便挑一个"）。 */
  const empty = candidateFromRoster({
    entries: entries.filter((item) => item.agentId !== 'agent-dev'),
    preset: standard,
    meetingId: 'm-now',
    stage,
  });
  assert.equal(empty, null);
});

test('P3-5 R-2. 名册里查不到角色的阶段（跨档位）→ 不猜，跳过', () => {
  const lite = JSON.parse(readFileSync(new URL('../presets/lite@1.json', import.meta.url), 'utf8'));
  /* `redteam` 只在 standard@1 里存在；拿 lite 查它 → 角色未知 → 不许猜。 */
  const entries = [{ agentId: 'agent-rt', meetingId: 'm-old', stageId: 'redteam', taskId: 'T9' }];
  const picked = candidateFromRoster({
    entries,
    preset: lite,
    meetingId: 'm-now',
    stage: { id: 'redteam', role: 'critic' },
  });
  assert.equal(picked, null, '预设里没有这个阶段 → 角色无从得知 → 不进候选');
});

test('P3-5 R-3. 宿主拿不到子会话 id → 如实失败停下，**绝不编 id、也绝不退回 fresh 重跑**', async () => {
  const world = makeWorld({
    deliver: () => ({ ok: false, artifact: null, tier: 'startActivation', via: 'startActivation', reason: 'no-child-id' }),
  });
  const result = await driveMeeting(depsOf(world), { meeting: freshMeeting(), meetingId: 'm-driver-1' });

  assert.equal(result.ok, false);
  assert.equal(result.stop, 'deliver');
  assert.equal(result.errors.some((error) => error.code === 'E_RESUME_NO_TARGET'), true);
  assert.match(result.errors[0].message, /不会退回 fresh 重跑/);
  /* 只投递了一次：重跑会让同一阶段执行两次，而账本只记第二次。 */
  assert.equal(world.deliveries.length, 1);
  assert.equal(world.writes.length, 0, '投不出去就不许写账本');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P3-11：检测器接在**组装路径**上（`E_BLIND_LEAK` 的生产发射点）
 *
 * ⚠️ 这条测试放在本文件（我 `task-17` 的写域）而不是 `delivery.test.mjs`，
 * 因为接线点在 `host/meeting.js`：`composeDelivery` 与驱动器都在这里，
 * 而 `delivery.test.mjs` 只测纯函数、够不着它。改动已如实报备。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('P3-11 L-4. 组装出来的盲阶段消息若真带泄漏，驱动器**当场停下**并报 E_BLIND_LEAK', async () => {
  /* 走**真实**组装路径：一份两阶段的合成预设，第二个阶段是盲的、且 `withheld` 里
   * 放了一个消息里必然出现的串（"阶段"二字每条消息都有）。这模拟的正是
   * "组装漏了 / 扣留清单配错"那种 bug —— 不许靠给驱动器开测试专用注入口来验。 */
  const leakyPreset = {
    id: 'leakprobe',
    version: 1,
    implemented: true,
    rank: 2,
    stages: [
      { id: 'aaa', order: 1, role: 'critic', kind: 'proposal', blind: false, mustProduce: ['claim'], withheld: [], gate: 'E_NO_CHALLENGE' },
      { id: 'bbb', order: 2, role: 'qa', kind: 'review', blind: true, mustProduce: ['verdict'], withheld: ['阶段'], gate: 'E_NO_PASSING_REVIEW' },
    ],
  };

  const world = makeWorld();
  const result = await driveMeeting(
    { ...depsOf(world), preset: leakyPreset },
    { meeting: freshMeeting({ preset: 'leakprobe@1' }), meetingId: 'm-driver-1' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.stop, 'blind-leak', '第二阶段的 bbb 是盲的、且带着被扣留的串，必须当场停');
  assert.equal(result.errors.some((error) => error.code === 'E_BLIND_LEAK'), true);
  /* 第一阶段照常投出去了；泄漏的那一条**一条都不许投出去**。 */
  assert.deepEqual(world.deliveries.map((item) => item.stageId), ['aaa']);
  assert.equal(world.writes.length, 1, '只写第一阶段那一条');
});
