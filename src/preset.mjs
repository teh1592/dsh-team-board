/**
 * preset.mjs — 预设的校验、加载、版本比对、升档补账。
 *
 * **纯函数，零 IO。** 这一层不读文件：注册表（`index.json` 的内容）与预设本体
 * 都由调用方作为参数传进来。理由与 `src/*.mjs` 里其他模块一致 ——
 * 1100 条测试能在 3.4 秒内跑完，靠的就是这一层从不碰磁盘。
 * 真正读文件的是 `host/meeting.js`，它只做搬运。
 *
 * ## 这一层要守的四条硬规矩（都来自方案 v1.0）
 *
 * 1. **绝不回退默认档。** 声明了 `standard@1` 而它加载不到 → `E_PRESET_NOT_FOUND`，
 *    不许悄悄按 `lite@1` 跑完。把读失败渲染成默认，等于拿沉默冒充结论 ——
 *    这是本项目从第一天起的红线。
 * 2. **只升不许降。** 降档意味着"已经怀疑过的部分不怀疑了"，而那些怀疑的结论
 *    还在账本里；账本会与档位对不上，且没人知道该信哪个。换挡权在人手上，且只能往上。
 * 3. **版本钉死在 id 里。** 契约存 `standard@1` 而不是 `standard`。
 *    预设会改；改了之后旧任务按新定义判会静默漂移。
 * 4. **升档要补账。** 新档位多出来的必产字段必须有出处，否则账本会显示成
 *    "按 standard 跑完了"，而实际只跑了 lite 的部分（`E_PRESET_BACKFILL_MISSING`）。
 *
 * ## 判不了什么（写清楚，不装作能判）
 *
 * - 判不了"这个档位适合这个活"。预设只证明"按这张图走过"，不证明"这张图是对的"。
 *   一个改文案的小活走 standard@1 走七步，门禁全绿，但那是浪费 —— 这条没有门禁。
 * - 判不了"`rank` 排得对不对"。`rank` 是人给的序（hotfix 1 / lite 2 / standard 3 /
 *   full 4），它决定"什么算升档"，但系统无法判断这个序是否合理。
 * - 判不了"升档是否真有必要"。`E_UPGRADE_NO_REASON` 只判有没有写理由，不判理由对不对。
 */

import { KINDS } from './contract.mjs';
import { isMeetingCode } from './codes.mjs';
import { DELIVERY_BLOCKER_CODES, DELIVERY_WARNING_CODES } from './delivery.mjs';

/**
 * 一条预设阶段可以引用的门禁全集 = **会议码表 ∪ 基线码表**。
 *
 * 为什么是并集而不是只用会议码表：方案的七阶段表格本来就把两族混用 ——
 * `challenge`/`redteam` 用的是新码（`E_NO_CHALLENGE` / `E_NO_KILL_SCENARIO`），
 * `build`/`verify` 用的是基线早就有的码（`E_MEETING_MISSING` /
 * `E_NO_PASSING_REVIEW`）。这不是笔误，是对的：
 * 那两个阶段的判定逻辑本来就在 `delivery.mjs` 里，没必要为了"统一"再抄一份码。
 *
 * 所以判据是「这个码在任何一张已登记的码表里查得到」。查不到的才是问题 ——
 * 那才是页面上会显示成"未知门禁"的那种。
 */
const BASELINE_CODES = new Set([...DELIVERY_BLOCKER_CODES, ...DELIVERY_WARNING_CODES]);

/**
 * 某个码能不能被预设引用。
 * @param {unknown} code
 * @returns {boolean}
 */
function isKnownGateCode(code) {
  return isMeetingCode(code) || (typeof code === 'string' && BASELINE_CODES.has(code));
}

/** 预设 id 的形状：小写字母开头，只含小写/数字/连字符。 */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 全限定名（id@version）。契约里存的就是这个。 */
const QUALIFIED_PATTERN = /^([a-z][a-z0-9-]*)@([1-9][0-9]*)$/;

/**
 * 一条诊断。
 *
 * 形状刻意与 `delivery.mjs` 的 blocker 一致（`code` + `message` + 可选 `stageId`），
 * 这样宿主那一层可以用同一套渲染，不必为预设再造一种错误形状。
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
 * 把 `standard@1` 拆成 `{id:'standard', version:1}`。
 *
 * 只接受全限定名。**传裸 `standard` 一律返回 null** —— 这是有意的：
 * 允许裸 id 就等于允许"用最新版"，而预设一旦改过，旧任务就会按新定义被判，
 * 且没有任何痕迹说明它原本是按哪一版跑的。
 *
 * @param {unknown} qualified
 * @returns {{id: string, version: number}|null} 形态不对 → null（不抛）
 */
export function parsePresetId(qualified) {
  if (typeof qualified !== 'string') return null;
  const match = QUALIFIED_PATTERN.exec(qualified);
  if (match === null) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { id: match[1], version };
}

/**
 * 拼回全限定名。
 * @param {string} id
 * @param {number} version
 * @returns {string}
 */
export function qualifyPreset(id, version) {
  return `${id}@${version}`;
}

/**
 * 校验一份预设本体。
 *
 * 返回**全部**问题，不做 early return —— 一次给人看完，而不是让他改一处跑一次。
 * 这与 `evaluateCompletion` 的口径一致。
 *
 * @param {unknown} preset
 * @returns {{ok: boolean, errors: Array<object>, warnings: Array<object>}}
 */
export function validatePreset(preset) {
  const errors = [];
  const warnings = [];

  if (preset === null || typeof preset !== 'object' || Array.isArray(preset)) {
    return {
      ok: false,
      errors: [diag('E_ARTIFACT_MALFORMED', `预设必须是一个对象，收到 ${Array.isArray(preset) ? 'array' : typeof preset}`)],
      warnings,
    };
  }

  /* ── 头部 ─────────────────────────────────────────────────────────────── */
  if (typeof preset.id !== 'string' || !ID_PATTERN.test(preset.id)) {
    errors.push(diag('E_ARTIFACT_MALFORMED', `预设 id 必须匹配 ${ID_PATTERN}，收到 ${JSON.stringify(preset.id)}`));
  }
  if (!Number.isSafeInteger(preset.version) || preset.version < 1) {
    errors.push(diag('E_ARTIFACT_MALFORMED', `预设 version 必须是正整数，收到 ${JSON.stringify(preset.version)}`));
  }
  if (typeof preset.implemented !== 'boolean') {
    errors.push(diag('E_ARTIFACT_MALFORMED', '预设必须显式声明 implemented（true/false）—— 缺了它就没法区分"还没做完"与"做完了但没阶段"'));
  }

  const stages = Array.isArray(preset.stages) ? preset.stages : null;
  if (stages === null) {
    errors.push(diag('E_ARTIFACT_MALFORMED', '预设的 stages 必须是数组'));
    return { ok: errors.length === 0, errors, warnings };
  }

  /* ── 未实现的档位：允许零阶段，但不许"零阶段却声称已实现" ──────────────── */
  if (stages.length === 0) {
    if (preset.implemented === true) {
      errors.push(diag(
        'E_PRESET_EMPTY_IMPLEMENTED',
        `预设 ${preset.id}@${preset.version} 声称已实现，却没有任何阶段 —— `
          + '一个零阶段的档位跑起来会立刻"完成"，那不是实现，是空壳。',
      ));
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  /* ── 阶段 ─────────────────────────────────────────────────────────────── */
  const seenStageIds = new Set();
  for (const [index, stage] of stages.entries()) {
    const where = `第 ${index + 1} 个阶段`;
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
      errors.push(diag('E_ARTIFACT_MALFORMED', `${where} 必须是对象`));
      continue;
    }
    const stageId = typeof stage.id === 'string' ? stage.id : '';
    if (stageId === '') {
      errors.push(diag('E_ARTIFACT_MALFORMED', `${where} 缺少 id`));
      continue;
    }
    if (!ID_PATTERN.test(stageId)) {
      errors.push(diag('E_ARTIFACT_MALFORMED', `阶段 id ${JSON.stringify(stageId)} 必须匹配 ${ID_PATTERN}`, stageId));
    }
    if (seenStageIds.has(stageId)) {
      errors.push(diag('E_ARTIFACT_MALFORMED', `阶段 id 重复：${stageId} —— 重名会让"这个阶段跑完没有"无从回答`, stageId));
    }
    seenStageIds.add(stageId);

    /* order 必须**恰好**是 1..N，不许跳号、不许重复。
     * 跳号会让"第 3 阶段"这个说法在有洞的序列里失去意义，
     * 而"阶段序列"正是整条流水线的骨架。 */
    const expectedOrder = index + 1;
    if (stage.order !== expectedOrder) {
      errors.push(diag(
        'E_ARTIFACT_MALFORMED',
        `阶段 ${stageId} 的 order 应是 ${expectedOrder}，收到 ${JSON.stringify(stage.order)} —— `
          + 'order 必须从 1 开始连续，不许跳号或重复',
        stageId,
      ));
    }

    if (typeof stage.role !== 'string' || stage.role.trim() === '') {
      errors.push(diag('E_ARTIFACT_MALFORMED', `阶段 ${stageId} 缺少 role`, stageId));
    }

    /* kind 必须来自 `contract.mjs` 的 KINDS —— 不在这里另写一份字面量。
     * 写成字面量就会多出第五份副本，而 `contract.test.mjs` 的闭合扫描专门抓这个。 */
    if (!KINDS.includes(stage.kind)) {
      errors.push(diag(
        'E_ARTIFACT_MALFORMED',
        `阶段 ${stageId} 的 kind 必须是 ${KINDS.join(' / ')} 之一，收到 ${JSON.stringify(stage.kind)}`,
        stageId,
      ));
    }

    if (typeof stage.blind !== 'boolean') {
      errors.push(diag('E_ARTIFACT_MALFORMED', `阶段 ${stageId} 必须显式声明 blind（true/false）—— 缺了它，"这一阶段是不是盲的"就只能靠猜`, stageId));
    }

    if (!Array.isArray(stage.mustProduce) || stage.mustProduce.length === 0) {
      errors.push(diag(
        'E_ARTIFACT_MISSING',
        `阶段 ${stageId} 的 mustProduce 必须是非空数组 —— 一个不要求任何产物的阶段，`
          + '它的门禁永远不可能触发，等于这个阶段不存在',
        stageId,
      ));
    } else {
      for (const field of stage.mustProduce) {
        if (typeof field !== 'string' || field.trim() === '') {
          errors.push(diag('E_ARTIFACT_MISSING', `阶段 ${stageId} 的 mustProduce 里有非字符串项：${JSON.stringify(field)}`, stageId));
        }
      }
      if (new Set(stage.mustProduce).size !== stage.mustProduce.length) {
        errors.push(diag('E_ARTIFACT_MISSING', `阶段 ${stageId} 的 mustProduce 有重复项`, stageId));
      }
    }

    /* gate 必须在**某张已登记的码表**里（会议码表 ∪ 基线码表）。
     * 查不到 = 页面上会显示成"未知门禁"。
     * 这一条把"预设声明的门禁"与"码表实际有的门禁"钉在一起 —— 两边分叉时立刻红。 */
    if (!isKnownGateCode(stage.gate)) {
      errors.push(diag(
        'E_ARTIFACT_MALFORMED',
        `阶段 ${stageId} 声明的门禁 ${JSON.stringify(stage.gate)} 不在任何已登记的码表里`
          + '（会议码表与基线码表都查不到）—— 它会在页面上显示成"未知门禁"，一句没有下一步的话',
        stageId,
      ));
    }

    /* `minCount`：数量门槛的**唯一出处**。
     *
     * 为什么门槛必须是数据而不是逻辑里的常量：`redteam` 要 ≥3 条失败情形、
     * `lite` 的 `design` 要 ≥2 条 —— 同一个字段在不同档位门槛不同。
     * 写死在 `artifact.mjs` 里就意味着"加一档要改代码"，而方案的第一条设计原则
     * 是"加一档 = 加一个文件"。
     *
     * 校验三件事：必须是对象、键必须在 mustProduce 里、值必须是正整数。
     * 第二条尤其重要：给一个不产出的字段设门槛，那个门槛永远不会被检查到 ——
     * 一个不起作用的门禁比没有门禁更坏，它让人以为有约束。 */
    if (stage.minCount !== undefined) {
      if (stage.minCount === null || typeof stage.minCount !== 'object' || Array.isArray(stage.minCount)) {
        errors.push(diag('E_ARTIFACT_MALFORMED', `阶段 ${stageId} 的 minCount 必须是对象`, stageId));
      } else {
        const produced = Array.isArray(stage.mustProduce) ? stage.mustProduce : [];
        for (const [field, value] of Object.entries(stage.minCount)) {
          if (!produced.includes(field)) {
            errors.push(diag(
              'E_ARTIFACT_MALFORMED',
              `阶段 ${stageId} 给 ${field} 设了数量门槛，但它不在 mustProduce 里 —— `
                + '这个门槛永远不会被检查到。一个不起作用的门禁比没有门禁更坏：它让人以为有约束。',
              stageId,
            ));
          }
          if (!Number.isSafeInteger(value) || value < 1) {
            errors.push(diag(
              'E_ARTIFACT_MALFORMED',
              `阶段 ${stageId} 的 minCount.${field} 必须是正整数，收到 ${JSON.stringify(value)}`,
              stageId,
            ));
          }
        }
      }
    }

    if (stage.withheld !== undefined) {
      if (!Array.isArray(stage.withheld)) {
        errors.push(diag('E_ARTIFACT_MALFORMED', `阶段 ${stageId} 的 withheld 必须是数组`, stageId));
      } else {
        for (const item of stage.withheld) {
          if (typeof item !== 'string' || item.trim() === '') {
            errors.push(diag('E_ARTIFACT_MALFORMED', `阶段 ${stageId} 的 withheld 里有非字符串项`, stageId));
          }
        }
      }
    }

    /* `blind` 与 `withheld` 是**两根正交的轴**，不要把它们混成一件事：
     *
     *   blind    —— 这一阶段的输入要不要**剥掉作者的推理过程**（只留主张 + 依据）
     *   withheld —— 这一阶段**具体看不见哪些产物**（按 artifact id / 阶段字段点名）
     *
     * 证据就在 `standard@1` 自己身上：`build` 不是盲阶段（它要完整看 design 的
     * decisions 才能动手），但它必须**看不见 redteam 的 killScenarios** ——
     * 否则做活的人会照着红队的剧本写实现。方案 §3 的信息流表把它写得很清楚。
     *
     * 所以这里**不再是 warning**。第一版我写了"非盲阶段声明 withheld 是自相矛盾"，
     * 那是把两根轴当成一根，结果对本项目最重要的那一行产生了误报 ——
     * 一条会对正确数据报警的检查，比没有检查更坏：它会教人忽略警告。
     *
     * 只保留真正矛盾的那一种：非盲阶段把**自己**的产物 withheld 掉。
     * 那意味着这一阶段既看得见一切、又看不见自己刚写下的东西。 */
    if (stage.blind === false && Array.isArray(stage.withheld)) {
      for (const item of stage.withheld) {
        if (typeof item === 'string' && item.startsWith(`${stageId}.`)) {
          errors.push(diag(
            'E_ARTIFACT_MALFORMED',
            `阶段 ${stageId} 不是盲阶段，却把**自己的**产物 ${item} 放进了 withheld —— `
              + '它既看得见一切、又看不见自己刚写下的东西，这是自相矛盾的',
            stageId,
          ));
        }
      }
    }
  }

  /* ── 档位内部一致性 ───────────────────────────────────────────────────── */
  /* 必须有至少一个盲阶段。一个全是非盲阶段的档位，"独立复核"这件事完全不存在，
   * 而这正是整条流水线存在的理由 —— 那就不是档位，是顺序对话。 */
  if (stages.length > 0 && !stages.some((stage) => stage && stage.blind === true)) {
    errors.push(diag(
      'E_PRESET_NO_BLIND_STAGE',
      `预设 ${preset.id}@${preset.version} 一个盲阶段都没有 —— 没有盲阶段就没有独立复核，`
        + '那这条流水线只是把一个人的想法拆成七段说出来',
    ));
  }

  /* 出方案的人与砍方案的人不能是同一个角色。
   * 这是 `E_SELF_REVIEW` 在**预设层面**的对应物：如果一份预设把 design 与 redteam
   * 都写成 `architect`，那么无论运行时怎么派 agent，自己砍自己都是注定的。 */
  const design = stages.find((s) => s && s.id === 'design');
  const redteam = stages.find((s) => s && s.id === 'redteam');
  if (design && redteam && typeof design.role === 'string' && design.role === redteam.role) {
    errors.push(diag(
      'E_SELF_REVIEW',
      `design 与 redteam 用了同一个角色（${design.role}）—— 自己砍自己的方案不算独立复核，`
        + '这是 E_SELF_REVIEW 在预设层面的同一种病',
    ));
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 从注册表里查一条预设条目。
 *
 * 返回 `{entry}` / `{entry: null, error}` 两种形态之一 —— **不抛**，
 * 因为"找不到"是一个正常的判定结果，不是异常。
 *
 * @param {unknown} registry `index.json` 的内容
 * @param {string} id
 * @param {number} version
 * @returns {{entry: object|null, error: object|null}}
 */
export function findEntry(registry, id, version) {
  const list = Array.isArray(registry?.presets) ? registry.presets : null;
  if (list === null) {
    return {
      entry: null,
      error: diag(
        'E_PRESET_NOT_FOUND',
        '预设注册表读不出来（没有 presets 数组）—— 这时候**无法判断**是注册表坏了还是真没这个档位。'
          + '两种都按"加载不到"处理，绝不回退默认档。',
      ),
    };
  }

  const entry = list.find((item) => item && item.id === id && item.version === version);
  if (entry === undefined) {
    const known = list
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => qualifyPreset(item.id, item.version))
      .join('、');
    return {
      entry: null,
      error: diag(
        'E_PRESET_NOT_FOUND',
        `注册表里没有 ${qualifyPreset(id, version)}。已登记的有：${known === '' ? '（一个都没有）' : known}。`
          + '**不会回退到默认档** —— 回退等于让一份写着这个档位的会议在没人发现的情况下换档跑完，'
          + '而账本上还写着原来那个。',
      ),
    };
  }
  return { entry, error: null };
}

/**
 * 加载并校验一份预设。
 *
 * @param {object} input
 *   { registry, qualified, bodies }
 *   - `registry`：`index.json` 的内容
 *   - `qualified`：`'standard@1'`（**不接受裸 id**）
 *   - `bodies`：`{ 'standard@1': <预设对象> }`，宿主读文件后的载荷
 * @returns {{ok: boolean, preset?: object, qualified?: string, implemented?: boolean,
 *            errors: Array<object>, warnings: Array<object>}}
 */
export function loadPreset(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const errors = [];
  const warnings = [];

  const parsed = parsePresetId(source.qualified);
  if (parsed === null) {
    /* 裸 id / 形态不对 —— 一律拒绝，并说清为什么不是"宽松一点就过去了"。 */
    return {
      ok: false,
      errors: [diag(
        'E_PRESET_NOT_FOUND',
        `预设标识 ${JSON.stringify(source.qualified)} 不是 id@version 形式。`
          + '必须先拆清楚：预设会改，改了之后旧任务按新定义判会静默漂移 —— '
          + '所以契约里存的是 standard@1，不是 standard。',
      )],
      warnings,
    };
  }

  const { entry, error } = findEntry(source.registry, parsed.id, parsed.version);
  if (entry === null) {
    errors.push(error);
    return { ok: false, errors, warnings };
  }

  const qualified = qualifyPreset(parsed.id, parsed.version);
  const bodies = source.bodies !== null && typeof source.bodies === 'object' ? source.bodies : {};
  const body = Object.prototype.hasOwnProperty.call(bodies, qualified) ? bodies[qualified] : undefined;

  if (body === undefined) {
    /* 注册表里有、但本体没给。**这不是"回退"的场合，而是"注册表与本体检对不上"** ——
     * 两者不一致本身就是缺陷，要说出来。 */
    errors.push(diag(
      'E_PRESET_NOT_FOUND',
      `注册表登记了 ${qualified}，但没有提供它的预设本体（bodies 里缺这个键）—— `
        + '注册表与实际文件对不上，先修数据，不要让它按默认档跑。',
    ));
    return { ok: false, errors, warnings };
  }

  const validation = validatePreset(body);
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);

  /* 注册表与本体的两处身份必须一致。不一致时**不做任何修补** ——
   * 修补会让"这份文件到底是哪一档"变成谜。 */
  if (typeof body.id === 'string' && body.id !== parsed.id) {
    errors.push(diag(
      'E_ARTIFACT_MALFORMED',
      `注册表说这是 ${parsed.id}，预设本体里写的是 ${JSON.stringify(body.id)} —— 两份数据打架，不选边`,
    ));
  }
  if (Number.isSafeInteger(body.version) && body.version !== parsed.version) {
    errors.push(diag(
      'E_ARTIFACT_MALFORMED',
      `注册表说这是第 ${parsed.version} 版，预设本体里写的是 ${JSON.stringify(body.version)} —— 两份数据打架，不选边`,
    ));
  }
  if (entry.implemented !== body.implemented) {
    errors.push(diag(
      'E_ARTIFACT_MALFORMED',
      `注册表的 implemented=${String(entry.implemented)} 与本体的 implemented=${String(body.implemented)} 不一致 —— `
        + '"这个档位能不能跑"这件事不允许有两种说法',
    ));
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  /* 未实现的档位：加载是**成功**的（它确实存在、数据也合法），
   * 但要如实告诉调用方"它跑不完"。这不是错误，是一条 warning 级事实。 */
  if (entry.implemented === false) {
    warnings.push(diag(
      'E_PRESET_NOT_IMPLEMENTED',
      `预设 ${qualified} 存在，但还没有实现 —— 这个档位目前跑不完。`,
    ));
  }

  return {
    ok: true,
    preset: body,
    qualified,
    implemented: entry.implemented === true,
    errors: [],
    warnings,
  };
}

/**
 * 比对两份预设的阶段图。
 *
 * 用于升档时的补账检查：`to` 相对 `from` 多了哪些阶段、少了哪些、哪些阶段的必产字段变了。
 *
 * @param {unknown} from 旧预设
 * @param {unknown} to 新预设
 * @returns {{addedStages: string[], removedStages: string[], addedFields: Array<{stageId: string, field: string}>, changedKinds: Array<{stageId: string, from: string, to: string}>}}
 */
export function diffStages(from, to) {
  const fromStages = Array.isArray(from?.stages) ? from.stages.filter((s) => s && typeof s.id === 'string') : [];
  const toStages = Array.isArray(to?.stages) ? to.stages.filter((s) => s && typeof s.id === 'string') : [];

  const fromById = new Map(fromStages.map((s) => [s.id, s]));
  const toById = new Map(toStages.map((s) => [s.id, s]));

  const addedStages = toStages.filter((s) => !fromById.has(s.id)).map((s) => s.id);
  const removedStages = fromStages.filter((s) => !toById.has(s.id)).map((s) => s.id);

  const addedFields = [];
  const changedKinds = [];
  for (const stage of toStages) {
    const before = fromById.get(stage.id);
    if (before === undefined) continue;

    const beforeFields = Array.isArray(before.mustProduce) ? before.mustProduce : [];
    const afterFields = Array.isArray(stage.mustProduce) ? stage.mustProduce : [];
    for (const field of afterFields) {
      if (!beforeFields.includes(field)) addedFields.push({ stageId: stage.id, field });
    }

    if (before.kind !== stage.kind) {
      changedKinds.push({ stageId: stage.id, from: before.kind, to: stage.kind });
    }
  }

  return { addedStages, removedStages, addedFields, changedKinds };
}

/**
 * 升档补账检查：新档位要求的字段，旧档位产物里有没有。
 *
 * `E_PRESET_BACKFILL_MISSING` 的判据。**只看字段在不在，不看内容对不对** ——
 * 内容只能人读。这是这条门禁能力的上限，写在这里而不是藏在实现里。
 *
 * @param {object} input
 *   { from, to, artifacts }
 *   - `artifacts`：`{ [stageId]: Set<string>|string[] }` 已产出的字段名
 * @returns {{ok: boolean, gaps: Array<{stageId: string, field: string, reason: string}>, errors: Array<object>}}
 */
export function backfillGaps(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const diff = diffStages(source.from, source.to);
  const artifacts = source.artifacts !== null && typeof source.artifacts === 'object' ? source.artifacts : {};

  /** 取某阶段已产出的字段集合（数组或 Set 都接受）。 */
  const fieldsOf = (stageId) => {
    const value = artifacts[stageId];
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value);
    return new Set();
  };

  const gaps = [];
  for (const { stageId, field } of diff.addedFields) {
    if (fieldsOf(stageId).has(field)) continue;
    gaps.push({
      stageId,
      field,
      reason: `升档后新档位要求 ${stageId} 产出 ${field}，但已有的产物里没有它`,
    });
  }

  const errors = [];
  if (gaps.length > 0) {
    errors.push(diag(
      'E_PRESET_BACKFILL_MISSING',
      `升档缺账 ${gaps.length} 处：${gaps.map((g) => `${g.stageId}.${g.field}`).join('、')}。`
        + '升档不是改个名字 —— 新档位多出来的字段必须有出处，'
        + '否则账本会显示成"按新档位跑完了"，而实际只跑了旧档位的部分。',
    ));
  }

  /* 新档位多出来的**阶段**：只有在它**真的没跑过**时才是缺口。
   *
   * 第一版这里无条件把 `addedStages` 全部报成缺口 —— 于是"升档之后补跑了
   * redteam / build / signoff"这种**正确**的局面也照样红。测试 5c 抓到的就是这个。
   * 判据必须看 artifacts：有产物就算跑过，没有才是缺口。 */
  const unrunStages = diff.addedStages.filter((stageId) => fieldsOf(stageId).size === 0);
  if (unrunStages.length > 0) {
    errors.push(diag(
      'E_PRESET_BACKFILL_MISSING',
      `升档后新档位多了这些阶段，但它们从没跑过：${unrunStages.join('、')}。`
        + '升档意味着这些阶段必须补跑，或者由人明确决定放弃它们（并写进账本）。',
    ));
  }

  return { ok: gaps.length === 0 && unrunStages.length === 0, gaps, errors };
}

/**
 * 换挡判定：从 `fromQualified` 换到 `toQualified` 算不算升档。
 *
 * **只升不降。** 降档的语义在方案 v0.2 里已经被否掉：降档意味着"已经怀疑过的部分
 * 不怀疑了"，而那些怀疑的结论还在账本里 —— 账本会与档位对不上。
 *
 * @param {object} input
 *   { registry, fromQualified, toQualified }
 * @returns {{ok: boolean, direction: 'same'|'up'|'down'|'unknown',
 *            fromRank?: number, toRank?: number, errors: Array<object>}}
 */
export function judgeShift(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const fromId = parsePresetId(source.fromQualified);
  const toId = parsePresetId(source.toQualified);
  const errors = [];

  if (fromId === null || toId === null) {
    return {
      ok: false,
      direction: 'unknown',
      errors: [diag(
        'E_PRESET_NOT_FOUND',
        `换挡的两个标识都必须是 id@version：收到 ${JSON.stringify(source.fromQualified)} → ${JSON.stringify(source.toQualified)}`,
      )],
    };
  }

  const fromFind = findEntry(source.registry, fromId.id, fromId.version);
  const toFind = findEntry(source.registry, toId.id, toId.version);
  if (fromFind.entry === null) errors.push(fromFind.error);
  if (toFind.entry === null) errors.push(toFind.error);
  if (errors.length > 0) return { ok: false, direction: 'unknown', errors };

  const fromRank = fromFind.entry.rank;
  const toRank = toFind.entry.rank;

  /* `rank` 必须是真的数字。缺了它就没法判断方向 —— 而"没法判断方向"绝不能
   * 被当成"不算降档所以放行"。 */
  if (!Number.isSafeInteger(fromRank) || !Number.isSafeInteger(toRank)) {
    return {
      ok: false,
      direction: 'unknown',
      errors: [diag(
        'E_ARTIFACT_MALFORMED',
        `档位 rank 必须是整数才能判断升/降：${source.fromQualified}=${JSON.stringify(fromRank)}、`
          + `${source.toQualified}=${JSON.stringify(toRank)}。判不出方向时不许放行。`,
      )],
    };
  }

  const same = fromRank === toRank && fromId.id === toId.id && fromId.version === toId.version;
  if (same) return { ok: true, direction: 'same', fromRank, toRank, errors: [] };

  if (toRank > fromRank) return { ok: true, direction: 'up', fromRank, toRank, errors: [] };

  /* 同档位换版本不算换挡：`standard@1` → `standard@2` 是**同一档位的新版本**。
   * 版本升级本来就该允许（预设改了必须 version+1），它不等于换挡。
   *
   * 但**往回用旧版本**要拦：`standard@2` → `standard@1` 意味着用一份更旧的图去判
   * 一份按新图跑出来的账 —— 结果与降档一样，账本会与档位对不上。
   * 第一版这里写成 `direction: ... ? 'up' : 'down'` 却统一 `ok: true`，
   * 于是"往回退版本"被放行了。测试 4c 抓到的就是这个。 */
  if (fromId.id === toId.id && toRank === fromRank) {
    if (toId.version > fromId.version) {
      return { ok: true, direction: 'up', fromRank, toRank, errors: [] };
    }
    errors.push(diag(
      'E_PRESET_DOWNGRADE',
      `从 ${source.fromQualified} 换到 ${source.toQualified} 是在**往回退版本**（同一档位，版本更旧）。`
        + '按新版本图跑出来的账，用旧版本图去判会对不上 —— 与降档是同一个后果。',
    ));
    return { ok: false, direction: 'down', fromRank, toRank, errors };
  }

  errors.push(diag(
    'E_PRESET_DOWNGRADE',
    `从 ${source.fromQualified}（rank ${fromRank}）换到 ${source.toQualified}（rank ${toRank}）是**降档**。`
      + '这条流水线只许升不许降：降档意味着"已经怀疑过的部分不怀疑了"，'
      + '而那些怀疑的结论还在账本里 —— 账本会与档位对不上，且没人知道该信哪个。'
      + '换挡权在人手上，且只能往上。',
  ));
  return { ok: false, direction: 'down', fromRank, toRank, errors };
}
