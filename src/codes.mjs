/**
 * codes.mjs — 会议流水线错误码的**唯一真相**。
 *
 * 这个文件是纯数据：没有 IO、没有 Date.now()、没有宿主 API。
 * 它存在的唯一理由是杀掉本项目反复发作的一种病：**同一个码名字在四处各写一份，
 * 漂移时没有任何东西报警**。此前 `gates.code.*` 曾在三处并存
 * （`locale/zh.json` / `locale/en.json` / `client.js` 内联表），
 * 靠 `client.test.mjs` 的三条断言勉强钉住；而新增一个门禁时漏抄一处，
 * 页面上就会出现"未知门禁"——一个没有文案的阻断码，等于一句让人无从下手的话。
 *
 * 这里改成**生成**：`locale/*.json` 与 `client.js` 里的对应段落由
 * `tools/gen-meeting-codes.mjs` 从本文件生成，`codes.test.mjs` 会重新生成一遍
 * 并与磁盘逐字比对 —— 手改那三处任何一处都会红。
 *
 * ## 与 §7 的两处账目出入（不掩盖，记账）
 *
 * 方案 `会议流水线-方案-v1.0-定稿.md` §7 写的是「新增 23 个」，实际有两条对不上：
 *
 *   1. §7 的 23 个里含 `E_QUESTIONS_UNANSWERED`，而它**早就在 `delivery.mjs` 里存在**。
 *      所以真正的"新增"是 22 个，不是 23。
 *   2. §2 的七阶段表格用了 `E_NO_CHALLENGE` 与 `E_NO_SIGNOFF`，但 §7 **从未定义**这两个。
 *      表格里另外五个（`E_MEETING_MISSING` / `E_NO_PASSING_REVIEW` /
 *      `E_PROPOSAL_UNREVIEWED` / `E_QUESTIONS_UNANSWERED` / `E_SELF_REVIEW`）都在基线里。
 *
 * 补定义的理由（一条规则，两处都适用）：
 *   **数量门槛单独出码，存在性归 `E_ARTIFACT_MISSING`。**
 *   `challenge` 要求"至少提出 1 个问题"、`redteam` 要求"至少 3 条失败情形" ——
 *   这是"够不够数"，不是"有没有这个字段"，`E_ARTIFACT_MISSING` 判不了。
 *   所以 `E_NO_KILL_SCENARIO` 必须独立存在，同理 `E_NO_CHALLENGE` 也得有。
 *   `signoff` 要求"明确给出要/不要"，缺了就是缺件 —— 但它缺的是**结论**而非字段，
 *   给 `E_ARTIFACT_MISSING` 会让人去找"哪个字段没填"，所以单独出码。
 *
 * 于是账目是：`MEETING_CODES` 共 **34** 条，其中 **33 条新增**（§7 的 22 条新码 + 补定义的 2 条
 * + 账本机制的 2 条 + 冒名清理的 7 条，见下），外加 1 条复用自基线的 `E_QUESTIONS_UNANSWERED`。
 * 批分布：批 1 = 11、批 2 = 12、批 3 = 11。
 *
 * ## 27 → 34（P2-6）：把"冒名"清出去的代价是新码，不是改判据
 *
 * 审计发现同一个码名在承载两种意思（见 `test/gates-batch3.test.mjs` 的登记表）。
 * **一码两义比死码更坏**：死码不发声、不误导；一码两义会对着 A 条件弹出一句讲 B 条件的
 * 文案，诊断指错地方。改判据修不了这件事 —— 只有拆成两条码才行。
 * 于是这一轮七条新码：
 *
 *   | 新码 | 批 | 它接手的那件事 | 原来挂在谁名下 |
 *   |---|---|---|---|
 *   | `E_PRESET_EMPTY_IMPLEMENTED` | 1 | 零阶段却称 `implemented:true` | `E_PRESET_NOT_IMPLEMENTED` |
 *   | `E_PRESET_NO_BLIND_STAGE` | 2 | 一个盲阶段都没有（设计缺陷，真阻断） | `E_PRESET_NOT_IMPLEMENTED` |
 *   | `E_MEETING_ABANDONED` | 2 | 账本已放弃，不再推进 | `E_MEETING_INTERRUPTED` |
 *   | `E_LEDGER_DROPPED` | 3 | 会议块里有不认识的键（值不落地） | 原先只是 `ledger.mjs` 里的一个本地常量 |
 *   | `E_LEDGER_STRAY_STAGE` | 3 | 账本阶段不在当前预设图里 | `E_ARTIFACT_PARTIAL` |
 *   | `E_RESUME_LIVENESS_UNKNOWN` | 3 | 存活判不出来，发「继续」是因为判不出 | `E_MEETING_INTERRUPTED` |
 *   | `E_AGENT_OVERRIDE_NO_REASON` | 3 | 领导覆盖复用模式没写理由 | `E_UPGRADE_NO_REASON`（升档专用的码） |
 *
 * 两条被腾空的码各自回到它真正的意思：`E_ARTIFACT_PARTIAL` 只讲"卡片部分字段缺失"
 * （见下方"它为什么没有发射点"），`E_PRESET_NOT_IMPLEMENTED` 只讲"这个档位
 * `implemented:false`、跑不到底"（只有 `loadPreset` 那一处会发）。
 * 还有一条 `E_MEETING_INTERRUPTED` 被腾空之后**没有任何发射点了** —— 见下方说明，
 * 它是**登记在案的沉默**，不是待办。
 *
 * ## `E_ARTIFACT_PARTIAL` 为什么没有发射点（记账，不是遗忘）
 *
 * 它的判据是"卡片部分字段缺失，但够往下走"。仓库里**没有"部分"的定义**：
 * 预设的阶段只声明 `mustProduce`（必产），没有"可选字段"这个概念；
 * `judgeArtifact` 也只判"这一阶段要求产出的字段"。缺了必产字段走
 * `E_ARTIFACT_MISSING`，齐了就什么都不缺 —— 中间那一档不存在。
 * 要接上它，必须先有数据：要么预设 schema 增加"可选/允许缺"的声明，
 * 要么明确"部分"指的是"缺了 `FIELD_RULES` 认识、但本阶段没要求的字段"
 * （后者与"只判本阶段要求产出的字段"这条既有设计冲突，需要人裁）。
 * **不许为了让通道有东西而现编一个"部分"。**
 *
 * ## 25 → 27（P2-2a）：账本存进任务树之后多出来的两条
 *
 * 方案 §7 是在"会议账本存在插件自己的存储里"这个前提下写的，因此没有这两条。
 * 把账本改成"存在任务树的 `description` 里"之后，多出一个**必须单独说**的失败方向：
 * 写进去了一半。它既不是"缺件"（批 1 的 `E_ARTIFACT_MISSING` 判的是产物没交），
 * 也不是"读不出来"（`E_LEDGER_UNREADABLE` 判的是整份账本拿不到），
 * 而是"拿得到、但只拿得到一部分" —— 判据不同，文案就得不同，否则读的人
 * 会把"账本半截"按"读不出来"那条去处理，而两条的处置方式恰恰一样（先修或交人），
 * 但**成因**完全不同：一条是存储坏了，一条是写入只成功了一半。
 * 两条都按指派归批 2。
 *
 * ## 每条码都必须写 `cannotJudge`
 *
 * 这是本项目从第一天起的红线：一个门禁如果不说清它判不了什么，
 * 读的人就会把它当成"全判了"。`codes.test.mjs` 会检查这个字段非空且不是敷衍话。
 */

/**
 * 批次 → 一句话。
 *
 * 批次不是分类学，是**上线节奏**：每批在自己的 migration 验收通过后
 * 自动从 `shadow` 翻 `enforce`，到期不达标整批回滚删码、不延期
 * （见方案 §7「翻档」）。
 */
export const MEETING_CODE_BATCHES = Object.freeze({
  1: '缺件与畸形',
  2: '冲突、换挡、盲、复用、账本',
  3: '出声但不拦',
});

/** 严重度白名单。`warning` 不拦交付，`blocker` 拦。 */
export const MEETING_CODE_SEVERITIES = Object.freeze(['blocker', 'warning']);

/**
 * 冻结一条码。
 *
 * 用函数而不是直接字面量，是为了让"每个字段都必须给"这件事在**运行时**也成立：
 * 漏一个字段就抛，而不是留一个 `undefined` 悄悄流到页面上显示成空白。
 *
 * @param {object} spec
 * @returns {Readonly<object>}
 */
function defineCode(spec) {
  const required = ['code', 'severity', 'batch', 'zh', 'en', 'cannotJudge'];
  for (const field of required) {
    const value = spec?.[field];
    if (field === 'batch') {
      if (![1, 2, 3].includes(value)) {
        throw new TypeError(`码 ${spec?.code} 的 batch 必须是 1/2/3，收到 ${String(value)}`);
      }
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`码 ${spec?.code} 缺少必填字段 ${field}`);
    }
  }
  if (!MEETING_CODE_SEVERITIES.includes(spec.severity)) {
    throw new TypeError(`码 ${spec.code} 的 severity 必须是 ${MEETING_CODE_SEVERITIES.join('/')}，收到 ${spec.severity}`);
  }
  return Object.freeze({
    code: spec.code,
    severity: spec.severity,
    batch: spec.batch,
    zh: spec.zh,
    en: spec.en,
    cannotJudge: spec.cannotJudge,
  });
}

/**
 * 会议流水线用到的 25 条码 —— 其中 **24 条是新增**，1 条（`E_QUESTIONS_UNANSWERED`）
 * 复用自基线的 `delivery.mjs`。
 *
 * 为什么复用那条也要收进这张表：它是七阶段里 `confirm` 的门禁，属于这条流水线的
 * 判定面。表里不收它，`codes.test.mjs` 的"码表 ⊇ 实际发射集合"就漏一个，
 * 而漏的那一个恰好是最常触发的（问题没答复）。
 *
 * 排序：先按 batch，再按 code 字典序。**顺序由测试钉住** ——
 * 这样生成的文案文件是稳定的，`git diff` 只会在真加了码时才动。
 */
export const MEETING_CODES = Object.freeze([
  /* ═══════════════════ 批 1（11 个 blocker）：缺件与畸形 ═══════════════════ */
  defineCode({
    code: 'E_ARTIFACT_MALFORMED',
    severity: 'blocker',
    batch: 1,
    zh: '这一阶段的卡畸形，两次修复后仍解析不出来——缺字段、类型不对、或不是约定的形状。按 submit_artifact 的参数说明重交一张；不要靠"我觉得它大概是这个意思"往下走。',
    en: 'The card for this stage is malformed and still unparseable after two repair attempts — missing fields, wrong types, or not the agreed shape. Resubmit one card following submit_artifact; do not proceed on a guess about what it probably meant.',
    cannotJudge: '判不了"能解析但语义错"——例如字段齐全、claim 却指向了错误的东西。',
  }),
  defineCode({
    code: 'E_ARTIFACT_MISSING',
    severity: 'blocker',
    batch: 1,
    zh: '这一阶段已标记完成，但必产字段没有交——阶段没产物就等于没开过这个会，后面所有阶段都建在空气上。',
    en: 'This stage is marked complete but its required fields were not submitted — a stage with no artifact means the meeting never really happened, and every later stage is built on air.',
    cannotJudge: '判不了"字段在、内容却是废话"——内容质量只能由人读。',
  }),
  defineCode({
    code: 'E_CLAIM_MULTIPLE',
    severity: 'blocker',
    batch: 1,
    zh: '一张卡给了不止一个主张。卡的意义就是"这一阶段只说一件事"——多于一个，读的人就没法判断你到底在要什么，也没法逐条吵。拆成两张卡。',
    en: 'One card carries more than one claim. A card exists so that a stage says exactly one thing — with more than one, the reader cannot tell what is being asked for, and nothing can be argued point by point. Split it.',
    cannotJudge: '判不了"一条 claim 里塞了两件事"——那要靠人读句子。',
  }),
  defineCode({
    code: 'E_LEDGER_UNREADABLE',
    severity: 'blocker',
    batch: 1,
    zh: '会议账本读不出来，无法判断跑到哪了。**绝不许从第一阶段重来**——那会把已经做完的活全部作废，而且没有任何痕迹说明作废过。先修账本，或交人。',
    en: 'The meeting ledger cannot be read, so the current position is unknown. Never restart from stage one — that voids work already done and leaves no trace that it was voided. Repair the ledger, or hand it to a human.',
    cannotJudge: '判不了"账本是空的还是坏的"——两者在这里都表现为读不出来。',
  }),
  defineCode({
    code: 'E_NO_CHALLENGE',
    severity: 'blocker',
    batch: 1,
    zh: '反方一个问题都没提。开会的第一阶段就是"先砍需求"——一个零问题的反方等于没开这个会。至少写出一个具体问题（不是"需求可以更清晰"这种）。',
    en: 'The challenger raised no questions at all. The first stage exists to cut requirements down — a challenger with zero questions means the meeting did not happen. Write at least one concrete question (not "the requirements could be clearer").',
    cannotJudge: '判不了"提出的问题是不是真问题"——只判数量到了没有。',
  }),
  defineCode({
    code: 'E_NO_KILL_SCENARIO',
    severity: 'blocker',
    batch: 1,
    zh: '红队没有列出足够的具体失败情形。要求的是"这个东西怎么坏"的具体剧本，不是"可能有风险"。数量门槛单独出码，因为凑数在这条上最容易发生——写 3 条软的在门禁上和写 3 条硬的一模一样。',
    en: 'The red team did not list enough concrete failure scenarios. What is required is specific "how this breaks" scripts, not "there may be risks". The count threshold has its own code because padding is easiest exactly here — three soft entries pass this gate identically to three hard ones.',
    cannotJudge: '判不了"列出的这 3 条是不是真的好 3 条"——只数条数，不评质量。',
  }),
  defineCode({
    code: 'E_NO_SIGNOFF',
    severity: 'blocker',
    batch: 1,
    zh: '签收阶段没有给出明确结论（要 / 不要）。「验过没问题」和「我决定收下」是两件事——验是 qa 做的，签是客户做的，混在一起就是自审的变种。',
    en: 'The signoff stage gave no explicit decision (accept / reject). "It passed verification" and "I decide to accept it" are two different acts — verification belongs to QA, acceptance belongs to the client; merging them is a variant of self-review.',
    cannotJudge: '判不了"这个结论是不是客户本人给的"——身份归属由 agent 层判。',
  }),
  defineCode({
    code: 'E_PRESET_EMPTY_IMPLEMENTED',
    severity: 'blocker',
    batch: 1,
    zh: '预设声称已实现，却一个阶段都没有。零阶段的档位跑起来会立刻"完成"——那不是实现，是空壳：它会一路绿着通过，而什么都没做。要么把 implemented 改成 false 承认还没做完，要么把阶段补齐。',
    en: 'The preset claims to be implemented but has no stages at all. A zero-stage tier finishes the moment it starts — that is not an implementation, it is a shell that passes everything while doing nothing. Either set implemented to false to admit it is unfinished, or fill in the stages.',
    cannotJudge: '判不了"这些阶段是被人有意留空还是忘了写"——只判"声称已实现"与"阶段数为零"同时成立这个矛盾。',
  }),
  defineCode({
    code: 'E_PRESET_NOT_FOUND',
    severity: 'blocker',
    batch: 1,
    zh: '声明了预设，但加载不到。**绝不回退默认档**——回退等于让一份写了 `standard@1` 的会议在没人发现的情况下按 `lite@1` 跑完，而账本上还写着 standard。',
    en: 'A preset was declared but cannot be loaded. Never fall back to the default tier — falling back would let a meeting that says standard@1 quietly run as lite@1 while the ledger still says standard.',
    cannotJudge: '判不了"这个 presetId 是不是用户想要的"——只知道它不在能加载到的集合里。',
  }),
  defineCode({
    code: 'E_PRESET_STAGE_SKIPPED',
    severity: 'blocker',
    batch: 1,
    zh: '这个预设的必过阶段没有对应任务。必过就是必过——缺了它，后面阶段的结论就没有前提出处。',
    en: 'A mandatory stage of this preset has no corresponding task. Mandatory means mandatory — without it, the conclusions of later stages have no antecedent.',
    cannotJudge: '判不了"跳过是因为不需要，还是因为忘了"——它是必过阶段，两种原因都一样不能跳。',
  }),
  defineCode({
    code: 'E_QUESTIONS_UNANSWERED',
    severity: 'blocker',
    batch: 1,
    zh: '提案里声明要向人确认的问题，没有逐条得到答复——逐条写上"问题 → 答复"，或把问不出来的那条删掉（想过没问题就写空列表）',
    en: 'Questions the proposal promised to confirm with a human were not answered one by one — write "<question> → <answer>" for each, or drop the question (declare an empty list if there is nothing to ask).',
    cannotJudge: '判不了"答复是不是本人真说的"——只判有没有一条条对上。',
  }),

  /* ═══════════════════ 批 2（12 个 blocker）：冲突、换挡、盲、复用、账本 ═══════════════════ */
  defineCode({
    code: 'E_AGENT_SHARED_ACROSS_MEETINGS',
    severity: 'blocker',
    batch: 2,
    zh: '同一个 agent 要去另一场会做同一个角色，但**隔离无从验证**：这一阶段没有声明任何要扣住的产物（`withheld` 为空），所以没法证明它没看过那一场会的结论。跨会议复用的前提是"隔离成立"，不是"声明了 fork"——`fork` 是继承上下文，正好相反，它会把 A 的结论带进 B。要么让该阶段声明它要扣住的产物，要么换一个没进过那场会的人。',
    en: 'The same agent is being sent to another meeting for the same role, but isolation cannot be verified: this stage declares no artifacts to withhold, so there is no way to show it has not seen that meeting\'s conclusions. Cross-meeting reuse requires isolation to hold — not a "fork" declaration. A fork inherits context, which is the opposite: it carries one meeting\'s conclusions into the other. Either have the stage declare what it withholds, or use someone who was never in that meeting.',
    cannotJudge: '判不了"跨会议泄漏到底影响了哪一条结论"——只知道隔离无从验证。',
  }),
  defineCode({
    code: 'E_BLIND_AGENT_REUSED',
    severity: 'blocker',
    batch: 2,
    zh: '这个盲阶段复用的 agent 见过本该扣住的产物（`seenIds` 与 `withheldIds` 有交集）。盲审的价值全在"它没看过"，看过之后再复用等于把盲审变成复述。换一个 fresh agent。',
    en: 'The agent reused for this blind stage has already seen artifacts that were supposed to be withheld (seenIds intersects withheldIds). The entire value of a blind review is that it has not seen them; reusing it turns blind review into restatement. Use a fresh agent.',
    cannotJudge: '判不了"复用的 agent 是不是真的忘了"——只判它见过什么。',
  }),
  defineCode({
    code: 'E_BLIND_LEAK',
    severity: 'blocker',
    batch: 2,
    zh: '盲阶段的输入里出现了本该扣住的产物——这是泄漏本身，不是复用的副作用。',
    en: 'Artifacts that were supposed to be withheld appear in a blind stage’s input — this is the leak itself, not a side effect of reuse.',
    cannotJudge: '判不了"它已经看过并记住了"——泄漏一旦发生无法回滚，只能作废这一阶段。',
  }),
  defineCode({
    code: 'E_CONFLICT_UNRESOLVED',
    severity: 'blocker',
    batch: 2,
    zh: '有冲突但没有任何裁定。冲突不藏是这个流水线存在的理由之一——把它挂着往下走，等于让 build 阶段自己猜用哪一条。',
    en: 'A conflict exists with no ruling at all. Not hiding conflicts is one of the reasons this pipeline exists — leaving it open means the build stage silently guesses which side to follow.',
    cannotJudge: '判不了"这条冲突重不重要"——重要与否不由系统裁。',
  }),
  defineCode({
    code: 'E_CONFLICT_UNRULED',
    severity: 'blocker',
    batch: 2,
    zh: '冲突的裁定不成立：`rule` / `decided` / `reason` 缺一，或用了 R2/R3 却没记 `dropped[]`（被删掉的那方原文）。没有 `dropped[]` 的"取交集"和"取小"是没法复核的——谁被牺牲了，账上没有。',
    en: 'The ruling does not hold: one of rule / decided / reason is missing, or R2/R3 was used without dropped[] (the losing text). An "intersection" or "take the smaller" with no dropped[] cannot be reviewed — the ledger does not say who was sacrificed.',
    cannotJudge: '判不了"写了 reason 但 reason 是编的"——理由的真假只有人能判。',
  }),
  defineCode({
    code: 'E_LEDGER_PARTIAL',
    severity: 'blocker',
    batch: 2,
    zh: '账本只写进去了一半：父任务的会议头块在、某个阶段的子块不在；或者子块在、父块不见了。这和"这个阶段还没开始"是两件不同的事——**读不出来不等于没跑过**。先修账本，或交人。绝不许把缺的那一段当成没发生过、从第一阶段重跑：那会把已经做完的活全部作废，而且不留任何痕迹说明作废过。',
    en: 'Only half of the ledger got written: the parent task carries the meeting header block while a stage child block is absent, or the child block is there while the parent block is gone. That is a different thing from "this stage has not started" — an unreadable stage is not a stage that never ran. Repair the ledger, or hand it to a human. Never treat the missing piece as work that never happened and rerun from stage one: that voids work already done and leaves no trace that it was voided.',
    cannotJudge: '判不了"缺的那一半是从没写进去，还是写进去又被改掉"——两种在这里都表现为读不出来。',
  }),
  defineCode({
    code: 'E_LEDGER_WRITE_FAILED',
    severity: 'blocker',
    batch: 2,
    zh: '往任务树里写账本失败了——建子任务没成功，或更新被拒、超时。**账本没记上不等于阶段没跑**：这个阶段可能已经真的跑完了，产物在会话里，只是没落到板上。所以这里绝不许重发这个阶段，重发会让同一阶段执行两次，而账本只会记下第二次。先修好写路径（看 revision 是不是被别人推进了、宿主还连得上吗），再把这次的结果补记上去。',
    en: 'Writing the ledger into the task tree failed — creating the child task did not go through, or the update was rejected or timed out. A ledger that never got the write does not mean the stage never ran: this stage may well have finished, with its artifact sitting in the session and only the board missing it. So this must never resend the stage — resending executes one stage twice while the ledger records only the second run. Fix the write path first (check whether the revision was advanced by someone else, and whether the host is still reachable), then record this result.',
    cannotJudge: '判不了"写失败的这一笔到底跑完了没有"——只说明没记上，不推断执行结果。',
  }),
  defineCode({
    code: 'E_MEETING_ABANDONED',
    severity: 'blocker',
    batch: 2,
    zh: '这场会议已被放弃（abandoned），不会再推进任何阶段。要接着做请开一场新的会，并把这场会的产物作为输入带过去——那样至少账本上说得清哪一场做了什么，而不是让一场被放弃的会悄悄接着往下跑。',
    en: 'This meeting has been abandoned and will not advance any further stage. To carry on, open a new meeting and bring this one’s artifacts in as input — at least then the ledger can say which meeting did what, instead of an abandoned meeting quietly running on.',
    cannotJudge: '判不了"放弃得对不对"——只判这个账本现在处在不再推进的状态。',
  }),
  defineCode({
    code: 'E_PRESET_BACKFILL_MISSING',
    severity: 'blocker',
    batch: 2,
    zh: '升档之后，旧档位产出的阶段产物没有补齐新档位要求的字段。升档不是改个名字——新档位多出来的阶段/字段必须有出处，否则账本会显示成"按 standard 跑完了"，而实际只跑了 lite 的部分。',
    en: 'After an upgrade, artifacts produced under the old tier are missing fields the new tier requires. Upgrading is not a rename — the stages and fields the new tier adds must have a source, otherwise the ledger reads "ran as standard" when only part of lite actually ran.',
    cannotJudge: '判不了"补上的字段是补写的还是本来就有"——只看形状齐不齐。',
  }),
  defineCode({
    code: 'E_PRESET_DOWNGRADE',
    severity: 'blocker',
    batch: 2,
    zh: '试图降档。这条流水线只许升不许降：降档意味着"已经怀疑过的部分不怀疑了"，而那些怀疑的结论还在账本里——账本会与档位对不上，且没人知道该信哪个。换挡权在人手上，且只能往上。',
    en: 'An attempt to downgrade. This pipeline only moves up, never down: downgrading means "the parts already doubted no longer need doubting", while the conclusions of that doubting remain in the ledger — ledger and tier disagree and nobody knows which to trust. Gear-shifting belongs to the human, and only upward.',
    cannotJudge: '判不了"降档是不是用户明确要求的"——即使明确要求了，这一层也拦。',
  }),
  defineCode({
    code: 'E_PRESET_NO_BLIND_STAGE',
    severity: 'blocker',
    batch: 2,
    zh: '这份预设一个盲阶段都没有。没有盲阶段就没有独立复核——被审的人看得见审的人先前写下的推理，那这条流水线只是把一个人的想法拆成七段说出来。加一个 blind 阶段（并且它看不见被审对象的推理），或换一份有盲阶段的档位。',
    en: 'This preset has no blind stage at all. Without one there is no independent review — the reviewer can see the reasoning the reviewed just wrote, so the pipeline only splits one person’s thinking into seven segments. Add a blind stage (one that cannot see the reviewed side’s reasoning), or use a tier that has one.',
    cannotJudge: '判不了"这个盲阶段够不够硬"——只判有没有至少一个。',
  }),
  defineCode({
    code: 'E_RESUME_EXHAUSTED',
    severity: 'blocker',
    batch: 2,
    zh: '同一阶段已连续 3 次发「继续」仍无产物，止损——交人。继续发第 4 次大概率只是让一个坏掉的 agent 多跑一轮。',
    en: 'Three consecutive "continue" messages on the same stage produced no artifact. Stop here and hand it to a human — a fourth is probably just giving a broken agent one more round.',
    cannotJudge: '判不了"是 agent 坏了还是这件事本身做不出来"——两种都要交人，所以不细分。',
  }),

  defineCode({
    code: 'E_UPGRADE_SAME_TIER',
    severity: 'blocker',
    batch: 2,
    zh: '要换去的档位就是当前档位——这不是升档，是空操作。**一次都不写**：在 append-only 的历史里留下一条"X → X"，回头看会以为这里真的换过档。要么把目标改成更高的档位，要么这件事本来就不需要动。',
    en: 'The tier you asked to shift to is the tier this meeting is already on — that is a no-op, not an upgrade. Nothing is written: an "X → X" line in an append-only history makes a later reader think a shift actually happened here. Either name a higher tier, or accept that nothing needs to change.',
    cannotJudge: '判不了"你是想换档但写错了档位，还是只是想确认当前档位"——两种在这里都表现为"目标等于当前"，所以只拒、不猜意图。',
  }),

  /* ═══════════════════ 批 3（11 个 warning）：出声但不拦 ═══════════════════ */
  defineCode({
    code: 'E_AGENT_OVERRIDE_NO_REASON',
    severity: 'warning',
    batch: 3,
    zh: '领导把复用模式改了，但没有写理由。覆盖本身允许，可账本上会变成"不知道为什么换了人"——而换人恰好是事后最需要解释得清的一件事。补一句为什么换，或把这次覆盖撤回改成默认模式。',
    en: 'A leader changed the reuse mode but gave no reason. Overriding is allowed, yet the ledger will read "someone was swapped for unknown reasons" — and a swap is exactly the thing that most needs to be explainable afterwards. Say why the swap happened, or withdraw the override and go back to the default mode.',
    cannotJudge: '判不了"这个换人的理由对不对"——只判有没有写理由。',
  }),
  defineCode({
    code: 'E_ARTIFACT_PARTIAL',
    severity: 'warning',
    batch: 3,
    zh: '卡片部分字段缺失，但够往下走。缺的那部分会在后面某个阶段变成"当初没说清楚"——先记着。',
    en: 'Some card fields are missing but there is enough to continue. What is missing will surface later as "that was never specified" — noted.',
    cannotJudge: '判不了"缺的那部分是不是关键"——关键与否由后面阶段暴露。',
  }),
  defineCode({
    code: 'E_LEDGER_DROPPED',
    severity: 'warning',
    batch: 3,
    zh: '会议块里出现了这个块不认识的键，它的值没有落地——只留了这一条声音。所以那一行写了等于没写，而写的人以为它生效了。照着 `team-board-meeting` 认的键重写这一行，或把它挪到真正负责那个字段的块里去。',
    en: 'The meeting block contained a key this block does not recognise, so its value was not persisted — only this note remains. The line was written as if it took effect, and it did not. Rewrite it using the keys `team-board-meeting` accepts, or move it into the block that actually owns that field.',
    cannotJudge: '判不了"这个键是拼错了，还是写了本块不负责的字段"——两种在这里都表现为"不认识"。',
  }),
  defineCode({
    code: 'E_LEDGER_STRAY_STAGE',
    severity: 'warning',
    batch: 3,
    zh: '账本里有这个阶段，但它不在当前预设的阶段图里——多半是升档/降档留下的历史记录。保留它、如实列出来，但不让它参与"跑到哪了"的计算：否则一次换档就会把当前该跑哪个阶段算错。',
    en: 'The ledger holds this stage, but it is not in the current preset’s stage graph — most likely a leftover from an upgrade or a downgrade. Keep it and list it plainly, but do not let it into the "where are we now" calculation: otherwise one tier change shifts which stage should run next.',
    cannotJudge: '判不了"这条历史该不该清掉"——只判它不在当前阶段的图里这件事。',
  }),
  defineCode({
    code: 'E_MEETING_INTERRUPTED',
    severity: 'warning',
    batch: 3,
    zh: '这个会议被中断过——有阶段没跑完就换了轮次。这里只留痕、不拦。要注意的是它留下的是一个空洞：中断那次输入了什么、输出了什么，账本上都缺一段，回头读会觉得那一轮本来就没有内容。',
    en: 'This meeting was interrupted — a stage ended unfinished and the round moved on. This is recorded, not blocked. What it leaves is a hole: the inputs and outputs of that round are simply missing, so a later reader will conclude the round had no content at all.',
    cannotJudge: '判不了"中断期间有没有人动过产物"——只记录中断发生过。',
  }),
  defineCode({
    code: 'E_PRESET_NOT_IMPLEMENTED',
    severity: 'warning',
    batch: 3,
    zh: '这个档位存在、数据也合法，但它还没有实现（注册表里 implemented 是 false）——现在跑它跑不到底。加载本身是成功的，所以这条只出声、不拦；但别把"加载成功"当成"能用"。',
    en: 'This tier exists and its data is valid, but it is not implemented yet (the registry entry has implemented: false) — running it now cannot reach the end. Loading itself succeeds, so this note only speaks and does not block; just do not read "it loaded" as "it works".',
    cannotJudge: '判不了"这个档位该不该被做出来"——只说明它现在跑不到底。',
  }),
  defineCode({
    code: 'E_PRESET_UPGRADED',
    severity: 'warning',
    batch: 3,
    zh: '本会议发生过升档。留痕用——升档本身是允许的，但"升过档"这件事必须留在账本上，否则回头看会以为一路都是高档位。',
    en: 'This meeting was upgraded at some point. This is a record, not a defect — upgrading is allowed, but the fact of it must stay in the ledger or a later reader will assume the higher tier applied throughout.',
    cannotJudge: '判不了"升档是否必要"——那是人事后的判断。',
  }),
  defineCode({
    code: 'E_RESUME_LIVENESS_UNKNOWN',
    severity: 'warning',
    batch: 3,
    zh: '存活判定是 unknown：既不能说它还在动，也不能说它已经停了。这时发「继续」是安全的（幂等，若它真在跑，这一条不会产生第二个产物），但请记住这一条是"因为判不出来才发的"，不是"确认它卡住了"。',
    en: 'The liveness check came back unknown: it is neither clearly running nor clearly stopped. Sending "continue" is safe here (it is idempotent; if the agent really is running, this message produces no second artifact), but remember that this one was sent because it could not be judged, not because it was confirmed stuck.',
    cannotJudge: '判不了"它到底在跑还是已经停了"——这一条只记录"判不出来"这个事实。',
  }),
  defineCode({
    code: 'E_RESUME_NO_TARGET',
    severity: 'warning',
    batch: 3,
    zh: '收到「继续」，但当前没有未完成的会议。空态显式说出来——不然发的人会以为消息丢了，然后重发好几次。',
    en: 'A "continue" arrived but no meeting is unfinished. Say the empty state plainly — otherwise the sender assumes the message was lost and sends it several more times.',
    cannotJudge: '判不了"用户是不是其实想开一个新会议"——只回答"现在没得继续"。',
  }),
  defineCode({
    code: 'E_SUGGEST_UPGRADE',
    severity: 'warning',
    batch: 3,
    zh: '有信号建议升档（例如冲突数、返工次数、被判"判不了"的次数超阈值）。只是建议。',
    en: 'Signals suggest upgrading (for example conflict count, rework count, or "cannot judge" count over threshold). A suggestion only.',
    cannotJudge: '判不了"升了会更好"——升档的代价（阶段更多、更慢）不由这条码衡量。',
  }),
  defineCode({
    code: 'E_UPGRADE_NO_REASON',
    severity: 'warning',
    batch: 3,
    zh: '升档时没写理由。升档本身允许，但没有理由的升档在账本上等于"不知道为什么多跑了三个阶段"。',
    en: 'An upgrade carried no stated reason. Upgrading is allowed, but an upgrade with no reason reads in the ledger as "three extra stages ran for unknown reasons".',
    cannotJudge: '判不了"理由写得对不对"——只判有没有写。',
  }),
]);

/* ------------------------------------------------------------------------- */
/* 派生视图（全部只读，不许在下游另建一份）                                      */
/* ------------------------------------------------------------------------- */

/** 所有码名字符串，按 MEETING_CODES 的顺序。 */
export const MEETING_CODE_NAMES = Object.freeze(MEETING_CODES.map((entry) => entry.code));

/** 会阻断交付的码。 */
export const MEETING_BLOCKER_CODES = Object.freeze(
  MEETING_CODES.filter((entry) => entry.severity === 'blocker').map((entry) => entry.code),
);

/** 只出声、不阻断的码。 */
export const MEETING_WARNING_CODES = Object.freeze(
  MEETING_CODES.filter((entry) => entry.severity === 'warning').map((entry) => entry.code),
);

/** 按批次分组的码名。 */
export const MEETING_CODES_BY_BATCH = Object.freeze({
  1: Object.freeze(MEETING_CODES.filter((e) => e.batch === 1).map((e) => e.code)),
  2: Object.freeze(MEETING_CODES.filter((e) => e.batch === 2).map((e) => e.code)),
  3: Object.freeze(MEETING_CODES.filter((e) => e.batch === 3).map((e) => e.code)),
});

/** code → 码定义。查不到就是 `undefined`，调用方必须自己决定"未知码"怎么展示。 */
const BY_CODE = new Map(MEETING_CODES.map((entry) => [entry.code, entry]));

/**
 * 查一条码的定义。
 * @param {unknown} code
 * @returns {Readonly<object>|undefined}
 */
export function meetingCodeOf(code) {
  if (typeof code !== 'string') return undefined;
  return BY_CODE.get(code);
}

/**
 * 这条码属不属于会议流水线。
 * @param {unknown} code
 * @returns {boolean}
 */
export function isMeetingCode(code) {
  return meetingCodeOf(code) !== undefined;
}

/**
 * 取一条码的文案。
 *
 * **查不到时返回 `undefined`，绝不返回英文或码名兜底** —— 调用方必须显式处理
 * "未知门禁"，因为把码名直接画在页面上正是"一句让人无从下手的话"。
 *
 * @param {unknown} code
 * @param {'zh'|'en'} lang
 * @returns {string|undefined}
 */
export function meetingCodeText(code, lang) {
  const entry = meetingCodeOf(code);
  if (entry === undefined) return undefined;
  return lang === 'en' ? entry.en : entry.zh;
}
