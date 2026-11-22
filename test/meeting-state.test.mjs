/**
 * meeting-state.test.mjs — `src/meeting.mjs`（会议状态机）的测试。
 *
 * **注意文件名**：`meeting.test.mjs` 是 baseline 里已有的、
 * 钉「开会是必须的」（`E_MEETING_MISSING` / `proposalId`）那组门禁的专用文件，
 * 与本模块无关。两个都叫 meeting 是历史遗留，所以这里用 `meeting-state`。
 * （改这个文件名时我一度覆盖了原文件 —— 已从 git 恢复，14 条测试完好。）
 *
 * 这一层守的是方案里四条被明确拍过的规矩，外加一批"读不出来时不许假装"的边界：
 *   ① 不猜测、不重来（`E_LEDGER_UNREADABLE`，绝不从第一阶段重跑）
 *   ② 幂等（`(meetingId, stageId, attempt)` 三元组）
 *   ③ 必过阶段不可跳（`E_PRESET_STAGE_SKIPPED`）
 *   ④ 轮次必须显式（迟到回执 `E_STALE_ATTEMPT`，已完成阶段不许有新轮次）
 *
 * ④ 那两条不是洁癖：账本是这场会唯一的真相源，
 * 一次迟到回执覆盖了新记录，就是"账本开始撒谎"的起点。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MEETING_STATUSES,
  STAGE_STATUSES,
  RUNNABLE_STATUSES,
  idempotencyKey,
  parseIdempotencyKey,
  stageAttempt,
  nextAttempt,
  readLedger,
  meetingState,
  nextStage,
  recordSubmission,
  canUpgrade,
  applyUpgrade,
  isKnownStageKind,
  isKnownStageGate,
} from '../src/meeting.mjs';
import { qualifyPreset } from '../src/preset.mjs';
import { decideAgent } from '../src/agentpool.mjs';

const REGISTRY = JSON.parse(readFileSync(new URL('../presets/index.json', import.meta.url), 'utf8'));
const STANDARD = JSON.parse(readFileSync(new URL('../presets/standard@1.json', import.meta.url), 'utf8'));
const LITE = JSON.parse(readFileSync(new URL('../presets/lite@1.json', import.meta.url), 'utf8'));

/** 升档的统一入口（P2-11）：`applyUpgrade` 现在**自己判方向**，所以 registry 是必填的。
 *
 * 用真注册表（上面那条 `readFileSync`）而不是手写一份 rank 表 —— 手写的那份会和
 * `presets/index.json` 漂移，而"漂移的判据"正是这一轮要消灭的东西。 */
const upgrade = (input) => applyUpgrade({ registry: REGISTRY, ...input });

/** 一场刚开的会。 */
function freshMeeting(over = {}) {
  return {
    id: 'meeting-1',
    preset: 'standard@1',
    status: 'running',
    stages: [],
    ...over,
  };
}

/** 按顺序把前 n 个阶段记成 done，返回新账本。 */
function withCompleted(preset, count, over = {}) {
  let meeting = freshMeeting({ preset: qualifyPreset(preset.id, preset.version), ...over });
  for (const stage of preset.stages.slice(0, count)) {
    const result = recordSubmission({ meeting, stageId: stage.id, attempt: 1, status: 'done' });
    assert.equal(result.ok, true, `夹具准备失败：${stage.id} → ${JSON.stringify(result.errors)}`);
    meeting = result.meeting;
  }
  return meeting;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. 幂等键
 * ═══════════════════════════════════════════════════════════════════════════ */

test('M1a. 幂等键用 NUL 分隔，拼接无碰撞', () => {
  const key = idempotencyKey('m1', 'design', 2);
  assert.equal(key, 'm1\u0000design\u00002');
  assert.deepEqual(parseIdempotencyKey(key), { meetingId: 'm1', stageId: 'design', attempt: 2 });

  /* 这一条是 NUL 而不是 `:` 的理由：`a:b` + `c` 与 `a` + `b:c`
   * 用 `:` 拼出来是同一个字符串。那种碰撞只会在生产里某个奇怪 id 上发生，
   * 然后极难查 —— 所以在这里就让它不可能。 */
  const left = idempotencyKey('a:b', 'c', 1);
  const right = idempotencyKey('a', 'b:c', 1);
  assert.notEqual(left, right, '含冒号的 id 不许造成键碰撞');
});

test('M1b. parseIdempotencyKey 对畸形输入返回 null，不抛', () => {
  assert.equal(parseIdempotencyKey('m1\u0000design'), null, '少一段');
  assert.equal(parseIdempotencyKey('m1\u0000design\u00000'), null, 'attempt 从 1 起');
  assert.equal(parseIdempotencyKey('m1\u0000design\u0000abc'), null);
  assert.equal(parseIdempotencyKey('\u0000design\u00001'), null, '空 meetingId');
  assert.equal(parseIdempotencyKey('m1\u0000\u00001'), null, '空 stageId');
  for (const bad of [undefined, null, 1, {}, []]) {
    assert.equal(parseIdempotencyKey(bad), null, `parseIdempotencyKey(${String(bad)})`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. 账本可读性：读不出来就是读不出来
 * ═══════════════════════════════════════════════════════════════════════════ */

test('M2a. 畸形账本一律 E_LEDGER_UNREADABLE，且 phase 不是 not-started', () => {
  const cases = [
    { label: 'null', meeting: null },
    { label: '数组', meeting: [] },
    { label: '字符串', meeting: 'x' },
    { label: '缺 id', meeting: { preset: 'standard@1', status: 'running', stages: [] } },
    { label: 'id 是空串', meeting: { id: '', preset: 'standard@1', status: 'running', stages: [] } },
    { label: 'preset 是裸 id', meeting: { id: 'm', preset: 'standard', status: 'running', stages: [] } },
    { label: 'status 拼错', meeting: { id: 'm', preset: 'standard@1', status: 'runing', stages: [] } },
    { label: 'stages 不是数组', meeting: { id: 'm', preset: 'standard@1', status: 'running', stages: {} } },
  ];

  for (const { label, meeting } of cases) {
    const state = meetingState({ meeting, preset: STANDARD });
    assert.equal(state.ok, false, `${label} 必须判失败`);
    assert.equal(state.phase, 'unreadable', `${label} 的 phase 必须是 unreadable，不许是 not-started`);
    assert.equal(state.errors[0].code, 'E_LEDGER_UNREADABLE', label);
    assert.equal(state.currentStage, null, `${label} 不许给出"当前阶段"`);
  }
});

test('M2b. 读不出来时 nextStage 必须 blocked —— 绝不返回第一阶段', () => {
  /* 这是本模块最重要的一条。返回第一阶段 = "从第一阶段重跑"，
   * 而那是看起来像在工作的最坏失败：活全作废、且账本上没有任何痕迹说作废过。 */
  const result = nextStage({ meeting: null, preset: STANDARD });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true, '必须 blocked');
  assert.equal(result.stage, undefined, '**绝不**返回第一阶段');
  assert.equal(result.done, undefined, '更不许说 done');
  assert.equal(result.errors[0].code, 'E_LEDGER_UNREADABLE');
});

test('M2c. 预设没提供 / 没有阶段时也算读不出来', () => {
  for (const preset of [undefined, null, {}, { stages: [] }]) {
    const state = meetingState({ meeting: freshMeeting(), preset });
    assert.equal(state.ok, false);
    assert.equal(state.phase, 'unreadable');
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. 阶段推进
 * ═══════════════════════════════════════════════════════════════════════════ */

test('M3a. 空账本 → 从第一个阶段开始，轮次为 1', () => {
  const result = nextStage({ meeting: freshMeeting(), preset: STANDARD });
  assert.equal(result.ok, true);
  assert.equal(result.stage.id, 'challenge', 'standard@1 的第一阶段是 challenge');
  assert.equal(result.attempt, 1, '首次是第 1 轮');
  assert.equal(result.done, undefined);
});

test('M3b. 逐阶段推进，顺序严格照预设', () => {
  const order = STANDARD.stages.map((stage) => stage.id);
  for (let i = 0; i <= order.length; i += 1) {
    const meeting = withCompleted(STANDARD, i);
    const state = meetingState({ meeting, preset: STANDARD });
    assert.equal(state.completed.length, i, `完成 ${i} 个阶段的账本，completed 应为 ${i}`);

    if (i === order.length) {
      assert.equal(state.phase, 'ready-to-close', '全完成但没标 done → ready-to-close（不是 done）');
      const next = nextStage({ meeting, preset: STANDARD });
      assert.equal(next.ok, true);
      assert.equal(next.done, true);
      continue;
    }
    assert.equal(state.phase, 'in-progress');
    assert.deepEqual(state.currentStage.id, order[i], `完成 ${i} 个之后当前阶段应是 ${order[i]}`);
    assert.deepEqual(state.pending, order.slice(i));
  }
});

test('M3c. ready-to-close 与 done 都不再给阶段', () => {
  const closed = withCompleted(STANDARD, STANDARD.stages.length);
  const readyNext = nextStage({ meeting: closed, preset: STANDARD });
  assert.equal(readyNext.done, true);
  assert.equal(readyNext.stage, undefined);

  const marked = { ...closed, status: 'done' };
  const doneNext = nextStage({ meeting: marked, preset: STANDARD });
  assert.equal(doneNext.done, true);
  assert.equal(doneNext.stage, undefined);
  assert.equal(meetingState({ meeting: marked, preset: STANDARD }).phase, 'done');
});

test('M3d. abandoned 的会议不再推进', () => {
  const meeting = withCompleted(STANDARD, 2, { status: 'abandoned' });
  const result = nextStage({ meeting, preset: STANDARD });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.errors[0].code, 'E_MEETING_ABANDONED', '放弃的会要用自己的码，不许借用"中断"那条');
  assert.equal(result.stage, undefined, '放弃的会不许给阶段');
  assert.equal(meetingState({ meeting, preset: STANDARD }).phase, 'abandoned');
});

test('M3e. 账本里有预设外的阶段 → warning 但不参与推进', () => {
  /* 升档/降档会留下历史记录。保留它们，但不许让它们影响"跑到哪了" ——
   * 否则一次换档就会把当前阶段算错。 */
  const meeting = freshMeeting({
    stages: [
      { stageId: 'challenge', attempt: 1, status: 'done', produced: [] },
      { stageId: 'frame', attempt: 1, status: 'done', produced: [] }, // 不在 standard@1 里
    ],
  });
  const state = meetingState({ meeting, preset: STANDARD });
  assert.equal(state.ok, true, '外来的阶段不该让整场会读不出来');
  assert.equal(state.currentStage.id, 'confirm');
  assert.ok(
    state.warnings.some((w) => w.message.includes('frame')),
    `必须点名那个外来阶段：${JSON.stringify(state.warnings)}`,
  );
  /* 码名也要钉住。这条 warning 以前借用的是 `E_ARTIFACT_PARTIAL`（文案讲"卡片字段半缺"），
   * 而这里判的是"阶段不在预设图里" —— 一码两义，页面会指错地方。
   * 现在它有自己的码；把码名钉在这里，防止下一次又被人随手换回去。 */
  assert.equal(
    state.warnings.find((w) => w.message.includes('frame')).code,
    'E_LEDGER_STRAY_STAGE',
    'stray 阶段必须用自己的码，不许借用"卡片部分缺失"那条',
  );
});

test('M3f. 阶段 status 拼错 → 读不出来（否则永远是幽灵未完成）', () => {
  const meeting = freshMeeting({
    stages: [{ stageId: 'challenge', attempt: 1, status: 'finished', produced: [] }],
  });
  const state = meetingState({ meeting, preset: STANDARD });
  assert.equal(state.ok, false);
  assert.equal(state.phase, 'unreadable');
  assert.match(state.errors[0].message, /永远算"没完成"/);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. 必过阶段不可跳
 * ═══════════════════════════════════════════════════════════════════════════ */

test('M4a. 声称收工但有必过阶段没完成 → E_PRESET_STAGE_SKIPPED', () => {
  const meeting = withCompleted(STANDARD, 4, { status: 'done' });
  const state = meetingState({ meeting, preset: STANDARD });
  assert.equal(state.ok, false);
  assert.equal(state.phase, 'unreadable');
  const error = state.errors.find((e) => e.code === 'E_PRESET_STAGE_SKIPPED');
  assert.notEqual(error, undefined, `必须报 E_PRESET_STAGE_SKIPPED：${JSON.stringify(state.errors)}`);
  assert.match(error.message, /build/, '必须点名缺了哪些阶段');
  assert.match(error.message, /signoff/);
});

test('M4b. 全部完成才允许收工', () => {
  const meeting = withCompleted(STANDARD, STANDARD.stages.length, { status: 'done' });
  const state = meetingState({ meeting, preset: STANDARD });
  assert.equal(state.ok, true);
  assert.equal(state.phase, 'done');
  assert.deepEqual(state.pending, []);
});

test('M4c. lite@1 只要求它自己的四个阶段', () => {
  /* 用 standard 的账本去判 lite，会多出没跑过的阶段；
   * 反过来 lite 的账本对 lite 必须自洽。这是"档位分区"的最基本表现。 */
  const liteClosed = withCompleted(LITE, LITE.stages.length, { status: 'done' });
  const state = meetingState({ meeting: liteClosed, preset: LITE });
  assert.equal(state.ok, true, `lite 只看自己的四阶段：${JSON.stringify(state.errors)}`);
  assert.equal(state.phase, 'done');
  assert.deepEqual(state.completed, ['challenge', 'confirm', 'design', 'verify']);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. 幂等与轮次
 * ═══════════════════════════════════════════════════════════════════════════ */

test('M5a. 同一 (meetingId, stageId, attempt) 重复提交 = 1 次', () => {
  const base = freshMeeting();
  const first = recordSubmission({ meeting: base, stageId: 'challenge', attempt: 1, status: 'done' });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.meeting.stages.length, 1);

  const again = recordSubmission({ meeting: first.meeting, stageId: 'challenge', attempt: 1, status: 'done' });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true, '第二次必须标 duplicate');
  assert.equal(again.meeting.stages.length, 1, '不许追加第二条');
  assert.equal(again.meeting, first.meeting, '重复提交必须原样返回同一个账本对象');
});

test('M5b. 上一轮是 failed 时允许推进轮次', () => {
  const base = freshMeeting();
  const failed = recordSubmission({ meeting: base, stageId: 'challenge', attempt: 1, status: 'failed' });
  assert.equal(failed.ok, true);
  assert.equal(stageAttempt(failed.meeting, 'challenge'), 1);

  const retry = recordSubmission({ meeting: failed.meeting, stageId: 'challenge', attempt: 2, status: 'done' });
  assert.equal(retry.ok, true, '失败之后重试必须允许');
  assert.equal(retry.duplicate, false);
  assert.equal(stageAttempt(retry.meeting, 'challenge'), 2);
  assert.equal(retry.meeting.stages.length, 1, '同一阶段只保留一条记录（最新轮次）');
});

test('M5c. 迟到回执不许覆盖新记录', () => {
  /* 账本是唯一真相源。一次迟到回执覆盖了新记录，就是"账本开始撒谎"的起点。 */
  const base = freshMeeting();
  const step1 = recordSubmission({ meeting: base, stageId: 'challenge', attempt: 1, status: 'failed' });
  const step2 = recordSubmission({ meeting: step1.meeting, stageId: 'challenge', attempt: 2, status: 'done' });

  const late = recordSubmission({ meeting: step2.meeting, stageId: 'challenge', attempt: 1, status: 'failed' });
  assert.equal(late.ok, false);
  assert.equal(late.errors[0].code, 'E_STALE_ATTEMPT');
  assert.equal(late.meeting, step2.meeting, '不改写账本');
  assert.equal(stageAttempt(late.meeting, 'challenge'), 2, '仍是第 2 轮');
});

test('M5d. 已完成的阶段不许有新轮次', () => {
  const base = freshMeeting();
  const done = recordSubmission({ meeting: base, stageId: 'challenge', attempt: 1, status: 'done' });
  const redo = recordSubmission({ meeting: done.meeting, stageId: 'challenge', attempt: 2, status: 'done' });
  assert.equal(redo.ok, false);
  assert.equal(redo.errors[0].code, 'E_STALE_ATTEMPT');
  assert.match(redo.errors[0].message, /重复执行还是账本被改过/);
});

test('M5e. 记提交时畸形入参不抛，逐项报清楚', () => {
  const base = freshMeeting();
  const noStage = recordSubmission({ meeting: base, attempt: 1, status: 'done' });
  assert.equal(noStage.ok, false);
  assert.equal(noStage.errors[0].code, 'E_ARTIFACT_MALFORMED');

  for (const attempt of [0, -1, 1.5, '1', undefined, null]) {
    const bad = recordSubmission({ meeting: base, stageId: 'challenge', attempt, status: 'done' });
    assert.equal(bad.ok, false, `attempt=${String(attempt)} 必须被拒`);
    assert.equal(bad.errors[0].code, 'E_ARTIFACT_MALFORMED');
  }

  const badStatus = recordSubmission({ meeting: base, stageId: 'challenge', attempt: 1, status: 'finished' });
  assert.equal(badStatus.ok, false);
  assert.match(badStatus.errors[0].message, /pending\/running\/done\/failed/);
});

test('M5f. recordSubmission 不改编本（纯函数）', () => {
  const base = freshMeeting();
  const snapshot = JSON.parse(JSON.stringify(base));
  recordSubmission({ meeting: base, stageId: 'challenge', attempt: 1, status: 'done' });
  assert.deepEqual(base, snapshot, '入参对象必须原样不动');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. 换档
 * ═══════════════════════════════════════════════════════════════════════════ */

test('M6a. lite → standard 方向合法，但补账不齐时不许放行', () => {
  const meeting = withCompleted(LITE, LITE.stages.length);
  const result = canUpgrade({
    meeting,
    registry: REGISTRY,
    fromPreset: LITE,
    toPreset: STANDARD,
    toQualified: 'standard@1',
    artifacts: {
      challenge: ['questions'],
      confirm: ['requirements', 'answered'],
      design: ['decisions', 'killScenarios'],
      verify: ['verdict', 'findings'],
    },
  });
  assert.equal(result.direction, 'up');
  assert.equal(result.ok, false, '缺 2 字段 + 3 个阶段没跑，不许放行');
  assert.ok(result.gaps.length > 0);
});

test('M6b. 降档：先说不许降，而不是先报一堆缺字段', () => {
  /* 顺序是有意的。降档根本不该算缺口 —— 先告诉他"不许降"，
   * 否则他会去补那些字段，补完才发现方向本身被拒。 */
  const meeting = withCompleted(STANDARD, STANDARD.stages.length);
  const result = canUpgrade({
    meeting,
    registry: REGISTRY,
    fromPreset: STANDARD,
    toPreset: LITE,
    toQualified: 'lite@1',
    artifacts: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.direction, 'down');
  assert.equal(result.errors[0].code, 'E_PRESET_DOWNGRADE');
  assert.deepEqual(result.gaps, [], '不许在方向被拒时还给补账建议');
});

test('M6c. 账本读不出来时 canUpgrade 直接失败', () => {
  const result = canUpgrade({ meeting: null, registry: REGISTRY, toQualified: 'standard@1' });
  assert.equal(result.ok, false);
  assert.equal(result.direction, 'unknown');
  assert.equal(result.errors[0].code, 'E_LEDGER_UNREADABLE');
});

test('M6d. applyUpgrade 只追加不改历史，且缺理由要出声', () => {
  const meeting = withCompleted(LITE, 2);
  const snapshot = JSON.parse(JSON.stringify(meeting));

  const noReason = upgrade({ meeting, toQualified: 'standard@1', at: '2026-11-21T00:00:00Z' });
  assert.equal(noReason.ok, true, '缺理由不阻断升档（方案把 E_UPGRADE_NO_REASON 放在批 3）');
  assert.equal(noReason.meeting.preset, 'standard@1');
  assert.equal(noReason.meeting.upgrades.length, 1);
  assert.equal(noReason.errors[0].code, 'E_UPGRADE_NO_REASON');

  const withReason = upgrade({
    meeting,
    toQualified: 'standard@1',
    reason: '做到一半发现动了架构',
    at: '2026-11-21T00:00:00Z',
  });
  assert.deepEqual(withReason.errors, [], '写了理由就不出声');
  assert.equal(withReason.meeting.upgrades[0].reason, '做到一半发现动了架构');

  assert.deepEqual(meeting, snapshot, '入参账本必须原样不动');

  /* 再升一次：历史必须是两段，不是被覆盖成一段。 */
  const twice = upgrade({
    meeting: withReason.meeting,
    toQualified: 'full@1',
    reason: '还要更严',
    at: '2026-11-21T01:00:00Z',
  });
  assert.equal(twice.meeting.upgrades.length, 2, 'upgrades 必须 append-only');
  assert.equal(twice.meeting.upgrades[0].to, 'standard@1');
  assert.equal(twice.meeting.upgrades[1].to, 'full@1');
});

test('M6e. applyUpgrade 拒绝非 id@version 的目标', () => {
  const result = upgrade({ meeting: freshMeeting(), toQualified: 'standard' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'E_PRESET_NOT_FOUND');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. 常量与工具
 * ═══════════════════════════════════════════════════════════════════════════ */

test('M7a. 状态白名单是冻结的，且 runnable 是它的子集', () => {
  assert.ok(Object.isFrozen(MEETING_STATUSES));
  assert.ok(Object.isFrozen(STAGE_STATUSES));
  assert.ok(Object.isFrozen(RUNNABLE_STATUSES));
  for (const status of RUNNABLE_STATUSES) {
    assert.ok(MEETING_STATUSES.includes(status), `${status} 必须在 MEETING_STATUSES 里`);
  }
  assert.equal(RUNNABLE_STATUSES.includes('done'), false);
  assert.equal(RUNNABLE_STATUSES.includes('abandoned'), false);
});

test('M7b. stageAttempt：没记录 = 1，有记录取记录值，畸形退回 1', () => {
  assert.equal(stageAttempt(freshMeeting(), 'challenge'), 1);
  assert.equal(stageAttempt(freshMeeting({ stages: [{ stageId: 'x', attempt: 3, status: 'done' }] }), 'x'), 3);
  assert.equal(stageAttempt(freshMeeting({ stages: [{ stageId: 'x', attempt: 0, status: 'done' }] }), 'x'), 1, '畸形退回 1');
  assert.equal(stageAttempt(null, 'x'), 1, '账本为空也不抛');
});

test('M7c. isKnownStageKind / isKnownStageGate 用共享判据，不另写字面量', () => {
  assert.equal(isKnownStageKind('proposal'), true);
  assert.equal(isKnownStageKind('implementation'), true);
  assert.equal(isKnownStageKind('review'), true);
  assert.equal(isKnownStageKind('work'), true);
  assert.equal(isKnownStageKind('frame'), false);
  assert.equal(isKnownStageKind(undefined), false);

  assert.equal(isKnownStageGate('E_NO_CHALLENGE'), true);
  assert.equal(isKnownStageGate('E_MADE_UP'), false);
  assert.equal(isKnownStageGate(undefined), false);
});

test('M7d. readLedger 只判形状，健康账本通过', () => {
  const result = readLedger(freshMeeting());
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
});

test('M7e. 七阶段全程走一遍（端到端，只用纯函数）', () => {
  /* 这条不是"再测一遍单元"，而是验证**组合**起来的行为：
   * 逐阶段推进 → 每步的当前阶段与轮次都对 → 最后 ready-to-close → 标 done → done。 */
  let meeting = freshMeeting();
  const expectedOrder = ['challenge', 'confirm', 'design', 'redteam', 'build', 'verify', 'signoff'];

  for (const [index, stageId] of expectedOrder.entries()) {
    const next = nextStage({ meeting, preset: STANDARD });
    assert.equal(next.ok, true, `第 ${index + 1} 步：${JSON.stringify(next.errors)}`);
    assert.equal(next.stage.id, stageId, `第 ${index + 1} 步应是 ${stageId}`);
    assert.equal(next.attempt, 1);

    const recorded = recordSubmission({ meeting, stageId, attempt: 1, status: 'done', produced: ['x'] });
    assert.equal(recorded.ok, true);
    meeting = recorded.meeting;
  }

  const beforeClose = nextStage({ meeting, preset: STANDARD });
  assert.equal(beforeClose.done, true, '七个阶段走完必须 done');

  const closed = { ...meeting, status: 'done' };
  assert.equal(meetingState({ meeting: closed, preset: STANDARD }).phase, 'done');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * applyUpgrade 写进 upgrades[] 的那条记录：键的**存在性**本身是有含义的
 * ═══════════════════════════════════════════════════════════════════════════ */

test('M-1. applyUpgrade 没给 at 时，记录里不许有 at 这个键', () => {
  /* 与 `recordSubmission` 同一条规矩：写成 `at: undefined` 会真的产生一个键，
   * 而 JSON 序列化会把它丢掉 —— "没记时间"在内存里与落盘后长得不一样，
   * 账本一旦过一趟 JSON 就点不相等。
   *
   * 现在这个键还要被账本渲染成 `| at=<时间>`：一个假的 `at=` 等于凭空断言
   * "时间是空的"，而真相是"调用方没给时间"。 */
  const meeting = freshMeeting({ preset: 'lite@1' });
  const result = upgrade({ meeting, toQualified: 'standard@1', reason: '多跑几个阶段' });

  assert.equal(result.ok, true);
  const entry = result.meeting.upgrades[0];

  assert.equal(entry.from, 'lite@1');
  assert.equal(entry.to, 'standard@1');
  assert.equal(entry.reason, '多跑几个阶段');
  assert.equal(
    Object.hasOwn(entry, 'at'),
    false,
    '没给 at 就不许有这个键 —— 写成 undefined 会被 JSON 丢掉，内存与落盘就不一致了',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry, '过一趟 JSON 必须一模一样');
});

test('M-2. applyUpgrade 给了 at 才挂这个键，且原样保存（这一层不解析时间）', () => {
  const meeting = freshMeeting({ preset: 'lite@1' });
  const result = upgrade({
    meeting,
    toQualified: 'standard@1',
    reason: 'r',
    at: '2026-11-22T00:10:00+08:00',
  });

  const entry = result.meeting.upgrades[0];
  assert.equal(Object.hasOwn(entry, 'at'), true);
  assert.equal(entry.at, '2026-11-22T00:10:00+08:00', '原样保存，不解析、不改格式');
});

test('M-3. applyUpgrade 的 reason 必须恒存在（缺省空串）：账本靠"空串 vs 没这个键"分辨两种沉默', () => {
  /* 这是 `meeting.mjs` 里**唯一**一处有意偏离"只给真值才挂键"的地方：
   * `reason: ''` 是"升档时没写理由"，而键压根不存在是"老账本没有这个字段"。
   * 两件事在账本层要能分开（ledger.mjs 的 20f 钉着那一侧）。 */
  const meeting = freshMeeting({ preset: 'lite@1' });
  const result = upgrade({ meeting, toQualified: 'standard@1' });

  const entry = result.meeting.upgrades[0];
  assert.equal(Object.hasOwn(entry, 'reason'), true, '没写理由也要落一个空串，不许省略这个键');
  assert.equal(entry.reason, '');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P2-8：`by`（谁按了换档杆）—— 与 `at` 完全同一条规矩
 *
 * 「换档权归人类」是本项目的核心原则，所以"这一次是谁换的"不是装饰字段，
 * 而是那条原则的记录本身。这一层只负责"给了才挂"：不编、不猜、不裁剪。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('M-4. applyUpgrade 给了 by 才挂这个键，且原样保存（这一层不改身份字符串）', () => {
  const meeting = freshMeeting({ preset: 'lite@1' });
  const result = upgrade({
    meeting,
    toQualified: 'standard@1',
    reason: 'r',
    by: 'alice',
  });

  const entry = result.meeting.upgrades[0];
  assert.equal(Object.hasOwn(entry, 'by'), true);
  assert.equal(entry.by, 'alice', '原样保存：身份来自宿主，这一层不 trim、不改格式');
});

test('M-5. applyUpgrade 没给 by 时记录里不许有 by 键', () => {
  /* 与 M-1 那条 `at` 完全同源：写成 `by: undefined` 会真的产生一个键，
   * JSON 序列化会丢掉它 —— "没记下是谁"在内存里与落盘后长得不一样。 */
  const meeting = freshMeeting({ preset: 'lite@1' });
  const result = upgrade({ meeting, toQualified: 'standard@1', reason: 'r' });

  const entry = result.meeting.upgrades[0];
  assert.equal(Object.hasOwn(entry, 'by'), false, '没给身份就不许有这个键');
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry, '过一趟 JSON 必须一模一样');
});

test('M-6. applyUpgrade 的 by 是空串时等于没给（不许落一个空的 by=）', () => {
  /* 账本把它渲染成 `| by=`。一个空的 `by=` 不是"记不下是谁"，而是"记下了一个空名字" ——
   * 两件事在页面上完全不同，所以空串必须走"不挂这个键"那条路。 */
  const meeting = freshMeeting({ preset: 'lite@1' });
  const result = upgrade({ meeting, toQualified: 'standard@1', reason: 'r', by: '' });

  const entry = result.meeting.upgrades[0];
  assert.equal(Object.hasOwn(entry, 'by'), false);
});

test('M-7. 加了 by 之后 reason 的既有口径不变：没写理由仍然落空串并出声', () => {
  /* 这条是"改一格不许动旁边那格"的钉子。`reason` 是全文件**唯一**一处有意偏离
   * "只给真值才挂键"的地方，任何加字段的改动都不许顺手把它改齐。 */
  const meeting = freshMeeting({ preset: 'lite@1' });
  const result = upgrade({ meeting, toQualified: 'standard@1', by: 'alice' });

  const entry = result.meeting.upgrades[0];
  assert.equal(Object.hasOwn(entry, 'reason'), true, '没写理由也要落空串');
  assert.equal(entry.reason, '');
  assert.ok(
    Array.isArray(result.errors) && result.errors.some((error) => error.code === 'E_UPGRADE_NO_REASON'),
    '没写理由仍然要出声（批 3 那条码）',
  );
  assert.equal(entry.by, 'alice', 'by 与 reason 是两格，不许互相影响');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * P2-11：`applyUpgrade` 自己判方向 —— 判据不许留在调用方
 *
 * 在它之前，"只许升不许降"靠 `host` 的 `upgradeMeeting` 先调判据保证。唯一的调用方
 * 是对的，但**函数本身不安全**：任何新调用方直接调它，就会把一次降档照单写进
 * append-only 的历史，而那条历史看起来完全合法。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('T-1. 降档 → ok:false 且 upgrades 零增长（不许把"不再怀疑"写进历史）', () => {
  const meeting = freshMeeting({ preset: 'standard@1' });
  const result = applyUpgrade({ meeting, registry: REGISTRY, toQualified: 'lite@1', reason: '想少跑几步' });

  assert.equal(result.ok, false);
  assert.equal(result.direction, 'down');
  assert.ok(
    result.errors.some((error) => error.code === 'E_PRESET_DOWNGRADE'),
    '错因必须来自 preset.mjs（判据只有一份）',
  );
  assert.deepEqual(result.meeting.upgrades ?? [], [], '一次降档不许留下任何记录');
  assert.equal(result.meeting.preset, 'standard@1', '档位必须原样');
  assert.deepEqual(result.warnings, [], '没升成就不许发升档留痕');
});

test('T-2. 同档 → ok:false 且零增长，并且带 E_UPGRADE_SAME_TIER（不是空 errors）', () => {
  const meeting = freshMeeting({ preset: 'standard@1' });
  const result = applyUpgrade({ meeting, registry: REGISTRY, toQualified: 'standard@1', reason: '再升一次' });

  assert.equal(result.ok, false);
  assert.equal(result.direction, 'same');
  assert.equal(result.reason, 'same-tier');
  /* 早先这里是 `errors: []`（"不是失败，是空操作"）—— 那与本项目"失败必带码"的口径冲突：
   * 一个 `ok:false` 却不在任何码列表里的状态，页面渲染不出来，读的人只能看见「失败了」。
   * 现在它有自己的码，并且**不是** `E_PRESET_DOWNGRADE` 的变体：那个说"往下走"，
   * 这个说"根本没动"，成因与处置都不同。 */
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['E_UPGRADE_SAME_TIER'],
    '同档必须有自己的一条码，不许靠"errors 为空 + direction=same"让调用方自己猜',
  );
  assert.match(result.errors[0].message, /不是升档/);
  assert.deepEqual(result.meeting.upgrades ?? [], [], '不许记一条 X → X 的假历史');
});

test('T-3. 缺 registry → ok:false（判不出方向绝不许放行）', () => {
  const meeting = freshMeeting({ preset: 'lite@1' });
  const cases = [
    { label: '不传', input: {} },
    { label: '传 null', input: { registry: null } },
  ];
  for (const item of cases) {
    const result = applyUpgrade({ meeting, toQualified: 'standard@1', ...item.input });
    assert.equal(result.ok, false, `registry ${item.label} 时必须拒绝 —— 判不出方向不是"没挡"`);
    assert.equal(result.direction, 'unknown');
    assert.equal(result.errors[0].code, 'E_PRESET_NOT_FOUND');
    assert.match(result.errors[0].message, /没.*判方向|判不了/);
    assert.deepEqual(result.meeting.upgrades ?? [], []);
  }
});

test('T-4. 注册表读不出来（没有 presets 数组）→ 同样不放行', () => {
  const meeting = freshMeeting({ preset: 'lite@1' });
  const result = applyUpgrade({ meeting, registry: { schemaVersion: 1 }, toQualified: 'standard@1' });

  assert.equal(result.ok, false, '注册表坏了与"没这个档"都必须按加载不到处理');
  assert.equal(result.direction, 'unknown');
  assert.deepEqual(result.meeting.upgrades ?? [], [], '注册表坏了也不许写');
});

test('T-5. 正常升档回归：by / at / reason 行为不变，direction 是 up', () => {
  const meeting = freshMeeting({ preset: 'lite@1' });
  const result = applyUpgrade({
    meeting,
    registry: REGISTRY,
    toQualified: 'standard@1',
    reason: '动了架构',
    at: '2026-11-22T02:00:00Z',
    by: 'alice',
  });

  assert.equal(result.ok, true);
  assert.equal(result.direction, 'up');
  const entry = result.meeting.upgrades[0];
  assert.equal(entry.from, 'lite@1');
  assert.equal(entry.to, 'standard@1');
  assert.equal(entry.reason, '动了架构');
  assert.equal(entry.at, '2026-11-22T02:00:00Z');
  assert.equal(entry.by, 'alice');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 8. `nextStage` 交出的"下一轮编号"（P3-8）
 *
 * 这一组修的是一个**真机上走不通的返工链**：
 * `nextStage` 原来把 `stageAttempt(...)`（记录里的轮次）原样交出去，
 * 于是 `failed` 的阶段下一轮拿到的还是同一个 `attempt`；
 * 而 `recordSubmission` 的幂等键是 `(meetingId, stageId, attempt)` ——
 * 同一个键 ⇒ 判 `duplicate` ⇒ **既不推进也不报错**，一直空转到守卫上限。
 *
 * 两个值必须分开，这一组就是它们的界桩：
 *   - `stageAttempt(...)`     = **当前记录是第几轮**（给读的人看）；
 *   - `nextAttempt(...)`      = **下一轮该用第几轮**（给驱动器用）。
 * 合并成一个数，就再也分不清"现在跑到第几轮"和"下一轮编号"。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('M8a. 首跑（没有记录）→ attempt 1', () => {
  const meeting = freshMeeting({ preset: 'lite@1' });
  const next = nextStage({ meeting, preset: LITE });
  assert.equal(next.ok, true);
  assert.equal(next.stage.id, 'challenge');
  assert.equal(next.attempt, 1);
});

test('M8b. 正在跑（running）→ 仍是同一个 attempt，不许当成新一轮', () => {
  /* 一次投递被计成两轮，是最隐蔽的重复执行：账本上会多出一条"第 2 轮"，
   * 而实际只投过一次。 */
  const meeting = freshMeeting({
    preset: 'lite@1',
    stages: [{ stageId: 'challenge', attempt: 1, status: 'running', produced: [] }],
  });
  assert.equal(stageAttempt(meeting, 'challenge'), 1);
  assert.equal(nextAttempt(meeting, 'challenge'), 1, 'running 不许推进轮次');

  const next = nextStage({ meeting, preset: LITE });
  assert.equal(next.attempt, 1);
});

test('M8c. failed（第 1 轮）→ 交出 2，而且这个 2 真的能被 recordSubmission 接受', () => {
  /* 光在 `nextStage` 里多一个数字不算修好 —— 那个数字必须能推动账本。
   * 所以这条要一路喂进 `recordSubmission`，断言 `duplicate === false`。 */
  const base = freshMeeting({ preset: 'lite@1' });
  const failed = recordSubmission({ meeting: base, stageId: 'challenge', attempt: 1, status: 'failed' });
  assert.equal(failed.ok, true);

  const next = nextStage({ meeting: failed.meeting, preset: LITE });
  assert.equal(next.stage.id, 'challenge', 'failed 的阶段还是当前阶段（没完成）');
  assert.equal(next.attempt, 2, 'failed 之后必须交出新轮次');

  const retry = recordSubmission({
    meeting: failed.meeting,
    stageId: next.stage.id,
    attempt: next.attempt,
    status: 'done',
  });
  assert.equal(retry.ok, true, `这个 attempt 必须能用：${JSON.stringify(retry.errors)}`);
  assert.equal(retry.duplicate, false, '不许判成重复提交 —— 那正是原来的 bug');
  assert.equal(stageAttempt(retry.meeting, 'challenge'), 2);
});

test('M8d. 连续两轮失败（1 → 2）→ 第三次交出 3', () => {
  const base = freshMeeting({ preset: 'lite@1' });
  const f1 = recordSubmission({ meeting: base, stageId: 'challenge', attempt: 1, status: 'failed' });
  const f2 = recordSubmission({ meeting: f1.meeting, stageId: 'challenge', attempt: 2, status: 'failed' });
  assert.equal(f2.ok, true, '第 2 轮失败也要能记上');

  const next = nextStage({ meeting: f2.meeting, preset: LITE });
  assert.equal(next.attempt, 3);
});

test('M8e. 两个值必须分开：failed 时「当前是第几轮」与「下一轮编号」不同一个数', () => {
  /* 这一条防的是"顺手把 meetingState.attempt 也改掉" ——
   * 那会让读的人看到"已经跑到第 2 轮"，而实际上第 2 轮还没开始。 */
  const base = freshMeeting({ preset: 'lite@1' });
  const failed = recordSubmission({ meeting: base, stageId: 'challenge', attempt: 1, status: 'failed' });

  const state = meetingState({ meeting: failed.meeting, preset: LITE });
  assert.equal(state.attempt, 1, 'meetingState 报的是"当前记录是第几轮"，不许被改成语义不同的值');
  assert.equal(nextAttempt(failed.meeting, 'challenge'), 2, '下一轮编号是另一个值');
  assert.notEqual(state.attempt, nextAttempt(failed.meeting, 'challenge'), '两个值必须可分辨');
});

test('M8f. 端到端：failed 之后的返工真的会被判成 fork（rule=rework-fork）', () => {
  /* 这一条替掉 `host.test` W-1 里"账本里预先写 attempt 2"的夹具绕法：
   * 现在 attempt 是由 `nextStage` **真算出来**的，不是人手塞进账本的。 */
  const base = freshMeeting({ preset: 'lite@1' });
  const failed = recordSubmission({ meeting: base, stageId: 'challenge', attempt: 1, status: 'failed' });
  const next = nextStage({ meeting: failed.meeting, preset: LITE });

  /* challenge 是盲阶段 —— 盲阶段一律 fresh 且不可覆盖（比 fork 更强的一条）。
   * 所以真要说"返工 → fork"，必须用非盲阶段。这里用 lite@1 的 confirm？它也是首跑。
   * 直接把 confirm 记成 failed，让 nextStage 算出它的下一轮。 */
  const toConfirm = recordSubmission({ meeting: base, stageId: 'challenge', attempt: 1, status: 'done' });
  const confirmFailed = recordSubmission({
    meeting: toConfirm.meeting,
    stageId: 'confirm',
    attempt: 1,
    status: 'failed',
  });
  const confirmNext = nextStage({ meeting: confirmFailed.meeting, preset: LITE });
  assert.equal(confirmNext.stage.id, 'confirm');
  assert.equal(confirmNext.attempt, 2);

  const decision = decideAgent({
    stage: confirmNext.stage,
    attempt: confirmNext.attempt,
    candidate: { id: 'a1', role: 'client', seenIds: [], meetings: [] },
    meetingId: base.id,
  });
  assert.equal(decision.mode, 'fork');
  assert.equal(decision.rule, 'rework-fork', '返工链真的走到了 fork 那条判据');

  /* 反面对照：同一个阶段、第 1 轮 → 不是 fork。
   * 没有这一半，"fork 触发"可能只是"所有 confirm 都 fork"。 */
  const firstRound = decideAgent({
    stage: confirmNext.stage,
    attempt: 1,
    candidate: { id: 'a1', role: 'client', seenIds: [], meetings: [] },
    meetingId: base.id,
  });
  assert.notEqual(firstRound.mode, 'fork');

  /* 盲阶段那条更强的规则不许被这次改动削弱。 */
  assert.equal(next.stage.blind, true, '前提：lite@1 的 challenge 是盲阶段');
  assert.equal(next.attempt, 2, '盲阶段的返工同样交出 +1（但模式仍是 fresh）');
});
