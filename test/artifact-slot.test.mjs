/**
 * `judgeArtifact` 的两个入参槽：`raw` 与 `card`。
 *
 * 这里钉的是一条曾经会被踩到的坑：旧写法下只有 `raw` 槽会被规范化，
 * 把**原始卡**放进 `card` 槽，`claimCount` 就永远是 undefined，
 * 而第 ① 关拿 `claimCount` 判"有没有 claim" —— 于是每一张卡都被判缺 claim，
 * 假红满屏，而且看起来像是"所有阶段都没交对东西"。
 *
 * 现在判据不认槽位、只认形态。这一组就是那句话的执行版本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { judgeArtifact, normalizeArtifact } from '../src/artifact.mjs';

const STANDARD = JSON.parse(readFileSync(new URL('../presets/standard@1.json', import.meta.url), 'utf8'));

function stageOf(id) {
  const stage = (Array.isArray(STANDARD.stages) ? STANDARD.stages : []).find((s) => s && s.id === id);
  assert.ok(stage !== undefined, `预设里没有阶段 ${id}`);
  return stage;
}

/** 一张合法的 challenge 卡（一个主张 + 至少一个问题）。 */
const GOOD_RAW = Object.freeze({
  id: 'c1',
  claim: ['把右栏置顶'],
  questions: ['右栏置顶后，窄屏怎么办'],
});

test('K-1. 同一张原始卡，放进 `raw` 槽与放进 `card` 槽，判据结果必须完全一致', () => {
  const stage = stageOf('challenge');

  const viaRaw = judgeArtifact({ stage, raw: { ...GOOD_RAW } });
  const viaCardSlot = judgeArtifact({ stage, card: { ...GOOD_RAW } });

  assert.deepEqual(
    viaCardSlot,
    viaRaw,
    '槽位只是入口，判据不许因为"卡从哪个门进来"而变脸',
  );
  assert.equal(viaRaw.ok, true, '这张卡是合格的 —— 如果这里红了，说明夹具先坏了');
});

test('K-2. 已规范化的卡放进 `card` 槽，仍然照用（不被二次规范化搞坏）', () => {
  const stage = stageOf('challenge');
  const normalized = normalizeArtifact({ ...GOOD_RAW });
  assert.equal(normalized.errors.length, 0);

  const result = judgeArtifact({ stage, card: normalized.card });
  assert.equal(result.ok, true);
  assert.equal(result.card.claimCount, 1, '规范化产物照用，claimCount 不许被抹掉');
});

test('K-3. 一张真的缺 claim 的卡，两个槽都必须判它缺 —— 修槽位不等于放宽判据', () => {
  const stage = stageOf('challenge');
  const badRaw = { id: 'c2', questions: ['q'] };

  const viaRaw = judgeArtifact({ stage, raw: { ...badRaw } });
  const viaCardSlot = judgeArtifact({ stage, card: { ...badRaw } });

  for (const [label, result] of [['raw 槽', viaRaw], ['card 槽', viaCardSlot]]) {
    assert.equal(result.ok, false, `${label}：缺 claim 必须被拒`);
    assert.ok(
      result.errors.some((error) => error.code === 'E_ARTIFACT_MISSING'),
      `${label}：要报 E_ARTIFACT_MISSING`,
    );
  }
});

test('K-4. `card: null` 不许抛错 —— 老实报"这张卡畸形"，而不是 ReferenceError', () => {
  const stage = stageOf('challenge');

  /* 旧写法在这里会走到 `card.claimCount` 直接抛 TypeError：
   * 一个"判卡"函数因为入参是 null 而抛错，调用方只能看到异常，看不到"卡畸形"。 */
  const result = judgeArtifact({ stage, card: null });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0, '必须有错可说，不许静默通过');
  assert.ok(
    result.errors.some((error) => error.code === 'E_ARTIFACT_MALFORMED'),
    '要报畸形，不是别的',
  );
});

test('K-5. 两个槽都给时，`card` 优先（调用方明确给了规范化产物，就别再规范化一遍）', () => {
  const stage = stageOf('challenge');
  const normalized = normalizeArtifact({ ...GOOD_RAW });

  /* `raw` 故意给一张不合格的卡：如果实现挑了 `raw`，结论会变成不合格。 */
  const result = judgeArtifact({
    stage,
    raw: { id: 'x', questions: ['q'] },
    card: normalized.card,
  });

  assert.equal(result.ok, true, '`card` 存在且已规范化时应当用 `card`');
});