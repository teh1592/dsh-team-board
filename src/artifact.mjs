/**
 * artifact.mjs — 方案卡、冲突、收敛规则。
 *
 * **纯函数，零 IO。** 它判三件事：
 *   1. 一张卡是不是**一张卡**（`claim` 唯一、必产字段齐、数量门槛够、枚举值合法）
 *   2. 两张卡之间有没有**冲突**
 *   3. 一条冲突该按哪条规则裁（R1–R4），以及这个裁法**成立不成立**
 *
 * ## 为什么"一张卡只有一个 claim"值得一条门禁
 *
 * 因为整条流水线的可辩论性建立在它上面：一张卡说一件事，读的人才可能逐条反驳；
 * 一张卡说五件事，反驳其中一件就等于反驳整张卡 —— 于是没人反驳。
 * 这不是洁癖，是"能不能吵得动"的前提。
 *
 * ## 四条收敛规则（方案 §6）
 *
 * | 规则 | 触发 | 动作 |
 * |---|---|---|
 * | `R1-evidence-wins` | 一方有 `basis[].kind='verify'` 且有可复核 ref | 有证据的赢 |
 * | `R2-intersection` | 偏好冲突 | 取交集，分歧降级为"可选"，**必记 `dropped[]`** |
 * | `R3-scope-take-smaller` | 范围冲突 | 取小（保守），**必记 `dropped[]`** |
 * | `R4-escalate` | 三条都不适用 | `needsHuman: true` |
 *
 * 四条硬规矩（方案 §6 原话，逐条对应下面的实现）：
 *   1. 写不出 `rule` 的局面一律 `needsHuman`
 *   2. `resolution` 必须同时有 `rule` / `decided` / `reason`，缺一 → `E_CONFLICT_UNRULED`
 *   3. `R2`/`R3` 必须记 `dropped[]`，否则 `E_CONFLICT_UNRULED`
 *   4. `R2` 交集为空时**保留 `rule=R2` 且 `decided=[]`**，
 *      出 `E_CONFLICT_UNRULED` + `needsHuman`，**不改写成 R4**
 *
 * 第 4 条特别值得说：把空交集"顺手"判成 R4 看起来很合理，
 * 但它抹掉了一个事实 —— 我们确实试过 R2、它给出了空集。
 * 改写成 R4 之后，账本上只剩下"升级给人"，看不出"这条规则在这里失效了"。
 *
 * ## 已知失效场景（方案 §6 自己记的账，不掩盖）
 *
 * C2 那次真实冲突里 **R3 给出了错答案**（取小 = 只做一个真档 = 重现"等于没得切换"）。
 * 所以 R2/R3 的裁定要记 `conservative` 累计数，连续 ≥2 次时页面标红。
 * 本模块提供 `conservativeStreak` 的计算，不判断"该不该标红"。
 *
 * ## 判不了什么（写清楚，不装作能判）
 *
 * - 判不了"这条 claim 对不对"。本模块只判**形状**：是不是一条、字段齐不齐、
 *   数量够不够、枚举值在不在允许集合里。内容只能人读。
 * - 判不了"两条 claim 是不是真的互相矛盾"。`detectConflicts` 只按调用方给的
 *   `conflictsWith` 指针与同一字段的不同取值来配对 —— 它**不读语义**。
 *   所以"两条卡其实矛盾但没标"这种情况抓不到。
 * - 判不了"R2 取的交集是不是真的正确"。R2 的 `decided` 由**人/上层**给出，
 *   本模块只检查"交集为空时不许假装有结论"。
 */

import { KINDS } from './contract.mjs';

/** `basis` 里允许的证据类别（方案 §6）。 */
export const BASIS_KINDS = Object.freeze(['verify', 'file', 'test', 'assert']);

/** 冲突类别（方案 §6）。 */
export const CONFLICT_KINDS = Object.freeze(['contradiction', 'gap', 'risk']);

/** 收敛规则名（方案 §6）。 */
export const RESOLUTION_RULES = Object.freeze([
  'R1-evidence-wins',
  'R2-intersection',
  'R3-scope-take-smaller',
  'R4-escalate',
]);

/**
 * 字段级门禁：这几个字段的语义是方案点名的，写在这里而不是散在调用方。
 *
 * 每个条目说明"这个字段到什么程度才算够"。门槛的**数值**不在这里 ——
 * 数值来自预设的 `minCount`（`redteam` ≥3、`lite` 的 `design` ≥2）。
 * 把数值写在这里就意味着"加一档要改代码"，而方案第一条原则是"加一档 = 加一个文件"。
 */
const FIELD_RULES = Object.freeze({
  /** 反方问题：至少 1 条，空了就是"这个会没开"。 */
  questions: Object.freeze({ minDefault: 1, gate: 'E_NO_CHALLENGE' }),
  /** 失败情形：门槛来自预设 `minCount`。 */
  killScenarios: Object.freeze({ minDefault: 1, gate: 'E_NO_KILL_SCENARIO' }),
  /** 签收结论：必须是明确的要 / 不要，不许多值。 */
  decision: Object.freeze({ gate: 'E_NO_SIGNOFF', allowed: Object.freeze(['accept', 'reject']) }),
});

/**
 * 一条诊断。形状与其它模块一致。
 * @param {string} code
 * @param {string} message
 * @param {string} [field]
 * @returns {{code: string, message: string, field?: string}}
 */
function diag(code, message, field) {
  return field === undefined ? { code, message } : { code, message, field };
}

/**
 * 取一个值"像不像一个列表"。
 *
 * 方案里这些字段都是列表，但真实输入里会出现单值、null、字符串。
 * 这里**不做宽容解释**（不把单值包成一条）—— 那是渲染层的事。
 * 数据层只回答"它是不是数组"，不是就是缺。
 *
 * @param {unknown} value
 * @returns {unknown[]|null}
 */
function listOf(value) {
  return Array.isArray(value) ? value : null;
}

/**
 * 规范化一张卡。
 *
 * 输出**永远是同一个形状**（每个字段都在），因为下游要按字段名取值 ——
 * 缺键会让 `card.risks.length` 抛错，而"抛错"与"没有风险"长得不一样，
 * 但代码里一句 `?? []` 就把它们抹平了。抹平之后，"没交"就变成了"交了个空的"。
 *
 * 所以这里区分两件事：
 *   - `card.<field>` 恒为数组（下游好取值）
 *   - `missing[]` 记录**哪些字段根本没交**（这才是"没交"的真相）
 *
 * @param {unknown} raw
 * @returns {{ok: boolean, card: object, missing: string[], errors: Array<object>}}
 */
export function normalizeArtifact(raw) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      card: {
        id: '', stage: '', role: '', claim: '', basis: [], risks: [],
        needsHuman: [], conflictsWith: [], dropped: [],
      },
      missing: [],
      errors: [diag('E_ARTIFACT_MALFORMED', `方案卡必须是一个对象，收到 ${Array.isArray(raw) ? 'array' : typeof raw}`)],
    };
  }

  const id = typeof raw.id === 'string' ? raw.id : '';
  if (id === '') errors.push(diag('E_ARTIFACT_MALFORMED', '方案卡缺少 id —— 没有 id 就无法被引用、被审、被收敛'));

  /* `claim` 允许三种写法：
   *   字符串 → 一条
   *   单元素数组 → 一条
   *   多元素数组 → **多于一条**（要让 E_CLAIM_MULTIPLE 报出来）
   * 所以这里保留原始条数，不在规范化阶段就压成一条 —— 压了就再也看不见"它给了两条"。 */
  const claimList = listOf(raw.claim);
  const claims = claimList !== null
    ? claimList.filter((item) => typeof item === 'string' && item.trim() !== '')
    : (typeof raw.claim === 'string' && raw.claim.trim() !== '' ? [raw.claim] : []);

  const basisRaw = listOf(raw.basis) ?? [];
  const basis = [];
  for (const item of basisRaw) {
    if (item === null || typeof item !== 'object') {
      errors.push(diag('E_ARTIFACT_MALFORMED', `卡 ${id} 的 basis 里有非对象项`));
      continue;
    }
    const kind = typeof item.kind === 'string' ? item.kind : '';
    const ref = typeof item.ref === 'string' ? item.ref : '';
    if (!BASIS_KINDS.includes(kind)) {
      errors.push(diag(
        'E_ARTIFACT_MALFORMED',
        `卡 ${id} 的 basis 里 kind 是 ${JSON.stringify(item.kind)}，必须是 ${BASIS_KINDS.join(' / ')} 之一`,
      ));
      continue;
    }
    if (ref === '') {
      errors.push(diag('E_ARTIFACT_MALFORMED', `卡 ${id} 的 basis 里有一条 kind=${kind} 但 ref 是空的 —— 没有 ref 的依据无法复核`));
      continue;
    }
    basis.push({ kind, ref });
  }

  const missing = [];
  const takeList = (name) => {
    const value = listOf(raw[name]);
    if (value === null) {
      if (raw[name] !== undefined) {
        errors.push(diag('E_ARTIFACT_MALFORMED', `卡 ${id} 的 ${name} 不是数组`));
      }
      missing.push(name);
      return [];
    }
    return value.filter((item) => typeof item === 'string' && item.trim() !== '');
  };

  const risks = takeList('risks');
  const needsHuman = takeList('needsHuman');
  const conflictsWith = takeList('conflictsWith');
  const dropped = takeList('dropped');

  const card = {
    id,
    stage: typeof raw.stage === 'string' ? raw.stage : '',
    role: typeof raw.role === 'string' ? raw.role : '',
    claim: claims.length > 0 ? claims[0] : '',
    /* 原始条数单独留一份：`E_CLAIM_MULTIPLE` 与"下游只读一条"两件事都要成立，
     * 而只留 `claim` 一个字段就装不下这两件事。 */
    claimCount: claims.length,
    claims: claims.slice(),
    basis,
    risks,
    needsHuman,
    conflictsWith,
    dropped,
  };

  /* 把**其余字段原样带过去**（`questions` / `killScenarios` / `decisions` /
   * `requirements` / `answered` / `verdict` / `findings` / `decision` / `changed` …）。
   *
   * 第一版漏了这一步，后果很直接：这些字段压根没进 card，于是
   * `judgeArtifact` 里 `card[field]` 恒为 undefined —— **每一张卡都判"缺字段"**，
   * 而且 `killScenarios: ['x','y','z']` 交齐 3 条也照报"数量不够"。
   * 一个把所有正确输入都判成错的判据，比没有判据更坏。
   *
   * 不写白名单是为了"加一档 = 加一个文件"：新阶段可能要求新字段，
   * 而 `artifact.mjs` 不该每加一个字段就改一次。
   *
   * 安全：只取**自有可枚举**键，并跳过三个原型相关的危险键 ——
   * 卡片的来源是模型输出，`__proto__` 这类键必须挡在门外。 */
  const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
  for (const key of Object.keys(raw)) {
    if (DANGEROUS.has(key)) continue;
    if (Object.hasOwn(card, key)) continue; // 上面已规范化的那几个不覆盖
    card[key] = raw[key];
  }

  return { ok: errors.length === 0, card, missing, errors };
}

/**
 * 判一张卡够不够这一阶段用。
 *
 * 三类判据，顺序固定：
 *   ① `claim` 唯一（`E_CLAIM_MULTIPLE`）
 *   ② 必产字段在场（`E_ARTIFACT_MISSING`）
 *   ③ 字段级门槛与枚举（`E_NO_CHALLENGE` / `E_NO_KILL_SCENARIO` / `E_NO_SIGNOFF`）
 *
 * "一次报全部"是本项目的硬要求，任何一类失败都不 early return。
 *
 * @param {object} input { stage, raw, card }
 *   `card` 可省（省了就现规范化一遍）；给了就用给的（避免重复规范化）。
 *   **但"给了就用给的"曾经是个坑，见下面那段注释** —— 现在判据不认槽位、只认形态。
 * @returns {{ok: boolean, card: object, errors: Array<object>, warnings: Array<object>,
 *            cannotJudge: string}}
 */
export function judgeArtifact(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const stage = source.stage !== null && typeof source.stage === 'object' ? source.stage : null;
  const stageId = typeof stage?.id === 'string' ? stage.id : '';

  /* 入参有两个槽（`raw` / `card`），但只有前者会被规范化 —— 这是个会被踩的坑：
   * 把**原始卡**放进 `card` 槽，`claimCount` 就永远是 undefined，
   * 而下面第 ① 关拿 `claimCount` 判"有没有 claim"，于是**每一张卡都被判缺 claim**，
   * 假红满屏、而且看起来像是"所有阶段都没交对东西"。
   *
   * 这个坑已经发生过一次接近事故：host 首次接线判卡时差点就这么写，是作者自己想起
   * `judgeBatch` 里用的是 `raw` 才没踩下去。而**驱动器的作者下一步就要走这条路** ——
   * 让每个人各自躲一次，不如把坑填了。
   *
   * 判据从"看是哪个槽"改成"看形态"：`claimCount` 不是非负安全整数的一律按原始卡处理。
   * `claimCount` 是 `normalizeArtifact` 专属产物（规范化过的卡一定有），所以这个标记可靠；
   * 而规范化是幂等的，已经规范过的卡再走一遍结果不变，不会误伤。
   *
   * 顺带修掉一个崩溃：旧写法下 `card: null` 会走到 `card.claimCount` 直接抛 TypeError，
   * 而不是老实报"这张卡畸形"。
   */
  const looksNormalized = Number.isSafeInteger(source.card?.claimCount) && source.card.claimCount >= 0;
  const rawInput = source.card === undefined
    ? source.raw
    : (looksNormalized ? undefined : source.card);
  const normalized = rawInput === undefined ? null : normalizeArtifact(rawInput);
  const card = normalized === null ? source.card : normalized.card;
  const errors = normalized === null ? [] : normalized.errors.slice();
  const warnings = [];

  if (stage === null) {
    errors.push(diag('E_ARTIFACT_MALFORMED', '判卡时没有当前阶段 —— 不知道这一阶段要什么。'));
    return { ok: false, card, errors, warnings, cannotJudge: '判不了这张卡够不够 —— 连是哪一阶段都不知道。' };
  }

  /* ① claim 唯一。 */
  if (!Number.isSafeInteger(card.claimCount) || card.claimCount === 0) {
    errors.push(diag(
      'E_ARTIFACT_MISSING',
      `阶段 ${stageId} 的卡没有 claim —— 一张说不出主张的卡等于什么都没说，后面没人能反驳它。`,
    ));
  } else if (card.claimCount > 1) {
    errors.push(diag(
      'E_CLAIM_MULTIPLE',
      `阶段 ${stageId} 的卡给了 ${card.claimCount} 个主张：${card.claims.map((c) => `「${c}」`).join('、')}。`
        + '卡的意义就是"这一阶段只说一件事"——多于一个，读的人没法判断你到底在要什么，'
        + '也没法逐条吵（反驳其中一件就等于反驳整张卡）。拆成两张卡。',
    ));
  }

  /* ② 必产字段在场。
   * 注意判据是"字段有没有交"，不是"值是不是空"—— `risks: []` 是合法的
   * "我想过风险，没有"，而 `risks` 缺键是"没想过"。两者不可混。 */
  const mustProduce = Array.isArray(stage.mustProduce) ? stage.mustProduce.filter((f) => typeof f === 'string') : [];
  const missingFields = [];
  for (const field of mustProduce) {
    const value = card[field];
    /* `claim` 已单独判过，不重复报。 */
    if (field === 'claim') continue;
    if (value === undefined || (Array.isArray(value) && value.length === 0 && card.claimCount === 0)) {
      missingFields.push(field);
      continue;
    }
    /* 空数组是否算缺，取决于这个字段有没有数量门槛：
     *   - 有门槛（killScenarios ≥3）→ 交给 ③ 报"数量不够"，这里不重复
     *   - 没门槛（requirements / decisions）→ 空数组就是缺 */
    if (Array.isArray(value) && value.length === 0 && FIELD_RULES[field] === undefined) {
      missingFields.push(field);
    }
  }
  if (missingFields.length > 0) {
    errors.push(diag(
      'E_ARTIFACT_MISSING',
      `阶段 ${stageId} 已标记完成，但必产字段没有交：${missingFields.join('、')}。`
        + '阶段没产物就等于没开过这个会，后面所有阶段都建在空气上。'
        + '（"没交"与"交了个空列表"是两件事：后者表示想过并确认是空的。）',
    ));
  }

  /* ③ 字段级门槛与枚举。 */
  const minCount = stage.minCount !== null && typeof stage.minCount === 'object' && !Array.isArray(stage.minCount)
    ? stage.minCount
    : {};
  for (const [field, rule] of Object.entries(FIELD_RULES)) {
    /* 只判这一阶段真的要求产出的字段 —— 不要求产出的字段设了门槛也不会被检查。 */
    if (!mustProduce.includes(field)) continue;

    if (rule.allowed !== undefined) {
      const value = card[field];
      if (typeof value !== 'string' || !rule.allowed.includes(value)) {
        errors.push(diag(
          rule.gate,
          `阶段 ${stageId} 的 ${field} 是 ${JSON.stringify(value)}，必须是明确结论之一：`
            + `${rule.allowed.join(' / ')}。「验过没问题」和「我决定收下」是两件事，`
            + '验是 qa 做的，签是客户做的。',
          field,
        ));
      }
      continue;
    }

    const list = listOf(card[field]) ?? [];
    const required = Number.isSafeInteger(minCount[field]) && minCount[field] >= 1
      ? minCount[field]
      : rule.minDefault;
    if (list.length < required) {
      errors.push(diag(
        rule.gate,
        `阶段 ${stageId} 的 ${field} 只有 ${list.length} 条，要求至少 ${required} 条。`
          + (field === 'killScenarios'
            ? '数量门槛单独出码，因为凑数在这条上最容易发生——写 3 条软的在门禁上和写 3 条硬的一模一样。'
            : ''),
        field,
      ));
    }
  }

  return {
    ok: errors.length === 0,
    card,
    errors,
    warnings,
    cannotJudge: '判不了这张卡的内容对不对 —— 本模块只判形状（是不是一条主张、字段齐不齐、'
      + '数量够不够、枚举值合不合法）。一条形状完美但主张是错的卡，在这里全绿。',
  };
}

/**
 * 按调用方给的指针配对冲突。
 *
 * **不读语义**：只认 `conflictsWith` 里写的 id，以及"同一阶段同一字段被不同阶段
 * 给出不同值"这一种可机械判定的形状。所以"两条卡其实矛盾但没标"抓不到 ——
 * 这条局限写在模块头部的"判不了什么"里。
 *
 * @param {object} input { cards }
 * @returns {{conflicts: Array<object>, errors: Array<object>}}
 */
export function detectConflicts(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const cards = Array.isArray(source.cards) ? source.cards.filter((c) => c !== null && typeof c === 'object') : [];
  const byId = new Map(cards.filter((c) => typeof c.id === 'string' && c.id !== '').map((c) => [c.id, c]));
  const errors = [];
  const conflicts = [];
  const seenPairs = new Set();

  const pairKey = (a, b) => [a, b].sort().join('\u0000');

  for (const card of cards) {
    const targets = Array.isArray(card.conflictsWith) ? card.conflictsWith : [];
    for (const targetId of targets) {
      if (typeof targetId !== 'string' || targetId === '') continue;
      if (targetId === card.id) {
        errors.push(diag(
          'E_CONFLICT_UNRESOLVED',
          `卡 ${card.id} 把**自己**列进了 conflictsWith —— 自己与自己的冲突没有裁定对象。`,
        ));
        continue;
      }
      const other = byId.get(targetId);
      if (other === undefined) {
        errors.push(diag(
          'E_ARTIFACT_MALFORMED',
          `卡 ${card.id} 指的冲突对象 ${targetId} 不存在 —— 指错了 id 与没指一样，`
            + '但它更容易被误读成"这两条已经对上了"。',
        ));
        continue;
      }
      const key = pairKey(card.id, targetId);
      if (seenPairs.has(key)) continue; // 双向都写了只算一条
      seenPairs.add(key);

      conflicts.push({
        id: `conflict:${card.id}:${targetId}`,
        between: [card.id, targetId],
        kind: guessConflictKind(card, other),
        claimA: { cardId: card.id, claim: card.claim },
        claimB: { cardId: other.id, claim: other.claim },
        resolution: undefined,
        needsHuman: false,
      });
    }
  }

  return { conflicts, errors };
}

/**
 * 猜冲突类别。**只按可机械判定的证据猜**，猜不出就记 `gap`。
 *
 * 为什么允许"猜"：`kind` 只影响"哪条规则适用"的建议，不影响裁定的合法性 ——
 * 裁定的合法性由 `resolution` 的字段完整性决定（见 `resolveConflict`）。
 * 所以猜错不会放过一条没裁的冲突，只会让建议的规则不同，而人还能改。
 *
 * @param {object} a
 * @param {object} b
 * @returns {'contradiction'|'gap'|'risk'}
 */
function guessConflictKind(a, b) {
  const basisA = Array.isArray(a.basis) ? a.basis : [];
  const basisB = Array.isArray(b.basis) ? b.basis : [];
  /* 一方有证据、另一方没有 → 这是证据层面的对撞。 */
  if (basisA.length !== basisB.length) return 'contradiction';
  /* 任一方把这条列进 needsHuman → 那是风险层面的事。 */
  if ((a.needsHuman ?? []).length > 0 || (b.needsHuman ?? []).length > 0) return 'risk';
  return 'gap';
}

/**
 * 有没有"可复核的 verify 证据"。
 *
 * 方案 R1 的触发条件：`basis[].kind='verify'` 且 ref 可复核。
 * "可复核"这里只判 ref 非空字符串 —— 能不能真的复核，本模块不知道。
 *
 * @param {object} card
 * @returns {boolean}
 */
export function hasVerifyEvidence(card) {
  const basis = Array.isArray(card?.basis) ? card.basis : [];
  return basis.some((item) => item !== null && typeof item === 'object'
    && item.kind === 'verify'
    && typeof item.ref === 'string' && item.ref.trim() !== '');
}

/**
 * 建议一条规则（不裁定）。
 *
 * 顺序有意：**先看证据，再看类别，最后才升级**。
 * 因为 R1 是唯一一条"能靠事实结束争论"的规则，它该先被问。
 *
 * @param {object} conflict
 * @param {object} [context] `{ fromBuildStage: boolean }`
 * @returns {{rule: string, why: string}}
 */
export function suggestRule(conflict, context) {
  const source = context !== null && typeof context === 'object' ? context : {};
  const cards = source.cardsById instanceof Map ? source.cardsById : new Map();
  const [idA, idB] = Array.isArray(conflict?.between) ? conflict.between : [];

  const cardA = cards.get(idA) ?? { basis: [] };
  const cardB = cards.get(idB) ?? { basis: [] };
  const evA = hasVerifyEvidence(cardA);
  const evB = hasVerifyEvidence(cardB);

  /* R1 只在**从 build 阶段起**可触发（方案原话：从 build 阶段起可触发）。
   * 为什么：build 之前没有任何"可复核的产物"，那时的 verify 依据只能是设想。 */
  if (source.fromBuildStage === true && (evA || evB) && evA !== evB) {
    return {
      rule: 'R1-evidence-wins',
      why: `一方有可复核的 verify 依据、另一方没有 —— 有证据的一方赢（${evA ? idA : idB}）。`,
    };
  }

  const kind = conflict?.kind;
  if (kind === 'contradiction') {
    return { rule: 'R3-scope-take-smaller', why: '两方直接矛盾且没有单方面证据 → 取小（保守）。' };
  }
  if (kind === 'gap') {
    return { rule: 'R2-intersection', why: '两边都在补不同的缺口 → 取交集，分歧降级为可选。' };
  }
  return {
    rule: 'R4-escalate',
    why: `冲突类别是 ${JSON.stringify(kind)}，三条规则都不适用 → 升级给人。`,
  };
}

/**
 * 检查一条裁定成立不成立。**这是四条硬规矩的落点。**
 *
 * @param {object} conflict
 * @returns {{ok: boolean, errors: Array<object>, needsHuman: boolean}}
 */
export function checkResolution(conflict) {
  const errors = [];
  const resolution = conflict?.resolution;

  /* 硬规矩 1：写不出 rule 的局面一律 needsHuman。
   * 注意这不是"报错就完了" —— 它同时要求 `needsHuman: true`，
   * 因为"这条冲突没有规则可裁"这个事实必须传到页面上，而不只是变成一条阻断码。 */
  if (resolution === undefined || resolution === null) {
    return {
      ok: false,
      needsHuman: true,
      errors: [diag(
        'E_CONFLICT_UNRESOLVED',
        `冲突 ${String(conflict?.id)} 没有任何裁定，也没标 needsHuman —— `
          + '把它挂着往下走，等于让 build 阶段自己猜用哪一条。'
          + '有规则就写 rule/decided/reason，没规则就明确标 needsHuman: true。',
      )],
    };
  }
  if (resolution === null || typeof resolution !== 'object' || Array.isArray(resolution)) {
    return {
      ok: false,
      needsHuman: true,
      errors: [diag('E_CONFLICT_UNRULED', `冲突 ${String(conflict?.id)} 的 resolution 不是对象。`)],
    };
  }

  const rule = typeof resolution.rule === 'string' ? resolution.rule : '';
  /* 硬规矩 2：rule / decided / reason 缺一不可。 */
  if (!RESOLUTION_RULES.includes(rule)) {
    errors.push(diag(
      'E_CONFLICT_UNRULED',
      `冲突 ${String(conflict?.id)} 的 rule 是 ${JSON.stringify(resolution.rule)}，`
        + `必须是 ${RESOLUTION_RULES.join(' / ')} 之一。写不出规则的局面一律 needsHuman。`,
    ));
  }
  if (resolution.decided === undefined) {
    errors.push(diag(
      'E_CONFLICT_UNRULED',
      `冲突 ${String(conflict?.id)} 的裁定没有 decided —— 只说了用哪条规则、没说结论是什么，等于没裁。`,
    ));
  }
  if (typeof resolution.reason !== 'string' || resolution.reason.trim() === '') {
    errors.push(diag(
      'E_CONFLICT_UNRULED',
      `冲突 ${String(conflict?.id)} 的裁定没有 reason —— 没有理由的裁定事后无法复核。`,
    ));
  }

  /* 硬规矩 3：R2 / R3 必须记 dropped[]。
   * 没有 dropped[] 的"取交集"和"取小"是没法复核的 —— 谁被牺牲了，账上没有。 */
  if (rule === 'R2-intersection' || rule === 'R3-scope-take-smaller') {
    const dropped = listOf(resolution.dropped);
    if (dropped === null) {
      errors.push(diag(
        'E_CONFLICT_UNRULED',
        `冲突 ${String(conflict?.id)} 用了 ${rule}，但没有 dropped[] —— `
          + '没有 dropped[] 的"取交集 / 取小"没法复核：谁被牺牲了，账上没有。',
      ));
    }
  }

  /* 硬规矩 4：R2 交集为空 → 保留 rule=R2 且 decided=[]，
   * 出 E_CONFLICT_UNRULED + needsHuman，**不改写成 R4**。
   *
   * 为什么不能顺手改成 R4：改完之后账本上只剩"升级给人"，
   * 看不出"我们确实试过 R2、它给出了空集" —— 而那正是规则失效的证据。 */
  let needsHuman = conflict?.needsHuman === true || rule === 'R4-escalate';
  if (rule === 'R2-intersection') {
    const decided = listOf(resolution.decided);
    if (decided !== null && decided.length === 0) {
      errors.push(diag(
        'E_CONFLICT_UNRULED',
        `冲突 ${String(conflict?.id)} 用 R2 取交集，交集是空的 —— `
          + '两边没有任何共同点。保留 rule=R2 与 decided=[]（这是"R2 在这里失效了"的记录），'
          + '同时必须标 needsHuman: true 升级给人。**不要改写成 R4**：'
          + '改完就看不出"试过 R2、它给出了空集"。',
      ));
      needsHuman = true;
    }
  }

  return { ok: errors.length === 0, errors, needsHuman };
}

/**
 * 裁定一条冲突（把建议规则 + 给定内容装进 `resolution`，然后**只做检查**）。
 *
 * 它**不替人做决定**：`decided` 必须由调用方给。
 * 这是本模块最克制的一处 —— 一条冲突"该选哪个"不是算法能回答的。
 *
 * @param {object} input { conflict, rule, decided, reason, dropped, cardsById, fromBuildStage }
 * @returns {{ok: boolean, conflict: object, errors: Array<object>, needsHuman: boolean}}
 */
export function resolveConflict(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const conflict = source.conflict !== null && typeof source.conflict === 'object' ? source.conflict : {};
  const rule = typeof source.rule === 'string' && RESOLUTION_RULES.includes(source.rule)
    ? source.rule
    : suggestRule(conflict, source).rule;

  const resolution = {
    by: 'rule',
    rule,
    decided: source.decided,
    reason: typeof source.reason === 'string' ? source.reason : '',
  };
  if (Array.isArray(source.dropped)) resolution.dropped = source.dropped.slice();

  const resolved = { ...conflict, resolution, needsHuman: conflict.needsHuman === true };
  const check = checkResolution(resolved);

  return {
    ok: check.ok,
    conflict: { ...resolved, needsHuman: resolved.needsHuman || check.needsHuman },
    errors: check.errors,
    needsHuman: resolved.needsHuman || check.needsHuman,
  };
}

/**
 * 一批冲突里 `conservative`（R2/R3）的连续次数。
 *
 * 方案 §6 自己记的账：C2 那次真实冲突里 R3 给出了错答案，
 * 所以"连续 ≥2 次走保守规则"要在页面上标红。
 *
 * 本模块只算数，**不判断该不该标红** —— 阈值是展示层的事。
 *
 * @param {unknown} conflicts
 * @returns {number} 从最新一条往回数，连续 R2/R3 的条数
 */
export function conservativeStreak(conflicts) {
  const list = Array.isArray(conflicts) ? conflicts.filter((c) => c !== null && typeof c === 'object') : [];
  let streak = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const rule = typeof list[i].resolution?.rule === 'string' ? list[i].resolution.rule : '';
    if (rule === 'R2-intersection' || rule === 'R3-scope-take-smaller') streak += 1;
    else break;
  }
  return streak;
}

/**
 * 一批卡的总体判定。
 *
 * 汇总三件事：逐卡判定、冲突配对、每条冲突的裁定检查。
 * **一次报全部**，不 early return。
 *
 * @param {object} input { stages, raws, cards? }
 *   `stages`：本场会议的阶段序列（用来查每个阶段的 mustProduce / minCount）
 *   `raws`：`{ [stageId]: 原始卡 }`
 * @returns {{ok: boolean, cards: object[], conflicts: object[], errors: Array<object>,
 *            warnings: Array<object>, conservativeStreak: number, cannotJudge: string}}
 */
export function judgeBatch(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const stages = Array.isArray(source.stages) ? source.stages.filter((s) => s !== null && typeof s === 'object') : [];
  const raws = source.raws !== null && typeof source.raws === 'object' ? source.raws : {};

  const errors = [];
  const warnings = [];
  const cards = [];

  for (const stage of stages) {
    if (typeof stage.id !== 'string') continue;
    if (!KINDS.includes(stage.kind)) continue; // 未声明的阶段交给 preset 层报
    const raw = raws[stage.id];
    if (raw === undefined) {
      /* 没交卡 —— 这是"阶段完成但没产物"，由 `E_ARTIFACT_MISSING` 管。
       * 在这里报，是因为 artifact 层是唯一能看到"这一阶段该有卡却没有"的地方。 */
      errors.push(diag(
        'E_ARTIFACT_MISSING',
        `阶段 ${stage.id} 没有交任何卡，但它是必过阶段 —— 阶段没产物等于没开过这个会。`,
      ));
      continue;
    }
    const judged = judgeArtifact({ stage, raw });
    cards.push(judged.card);
    errors.push(...judged.errors);
    warnings.push(...judged.warnings);
  }

  const detected = detectConflicts({ cards });
  errors.push(...detected.errors);

  const conflicts = [];
  for (const conflict of detected.conflicts) {
    const check = checkResolution(conflict);
    errors.push(...check.errors);
    conflicts.push({ ...conflict, needsHuman: conflict.needsHuman || check.needsHuman });
  }

  return {
    ok: errors.length === 0,
    cards,
    conflicts,
    errors,
    warnings,
    conservativeStreak: conservativeStreak(conflicts),
    cannotJudge: '判不了内容对不对。本层只判形状与配对：一张形状完美但主张是错的卡在这里全绿；'
      + '两条其实矛盾但没在 conflictsWith 里互指的卡，这里也发现不了。',
  };
}
