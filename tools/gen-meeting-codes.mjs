/**
 * gen-meeting-codes.mjs — 从 `src/codes.mjs` 生成文案，供三处消费。
 *
 * ## 为什么要生成
 *
 * 本项目此前栽过好几次同一个跟头：同一个码名在四处各写一份
 * （`locale/zh.json` / `locale/en.json` / `client.js` 的中文内联表 /
 * `client.js` 的英文内联表），新增一个门禁时漏抄一处，页面上就出现
 * **"未知门禁"** —— 一个没有文案的阻断码，等于一句让人无从下手的话。
 *
 * 靠人记着抄是治不住的，靠测试事后抓也只是把伤害延后。所以改成：
 * **码表是唯一真相，文案由它生成**，生成的产物不许手改。
 *
 * ## 三处消费端与各自的标记方式
 *
 * | 目标 | 标记方式 |
 * |---|---|
 * | `locale/zh.json` | **无标记**（JSON 不能写注释）。判据是"重新生成一遍，整份文件逐字比对" |
 * | `locale/en.json` | 同上 |
 * | `client.js` | 两个注释行夹住的区块（`@meeting-codes:begin` / `:end`） |
 *
 * JSON 走"整份比"这条路是安全的：生成器只增删自己负责的那批键，
 * 其余键（基线的 47 条 `gates.code.*` 以及非 `gates.` 前缀的所有文案）
 * 一律原样保留、且**顺序不动**。
 *
 * ## 哪些码归这里生成
 *
 * **只生成基线没有的码。** 判据是：该码不在 `DELIVERY_BLOCKER_CODES` /
 * `DELIVERY_WARNING_CODES` 里。
 *
 * 理由：`E_QUESTIONS_UNANSWERED` 这类"复用自基线"的码，它的文案源头是基线，
 * 由 `delivery.mjs` 那一套管。这里再生成一遍就变成"一个码两份文案" ——
 * 正是本文件要消灭的病。
 *
 * 但复用码在 `codes.mjs` 里也写了一份文本（会议侧要能独立拿文案做测试）。
 * 那份文本与 locale 的一致性**由 `codes.test.mjs` 的断言 7c 强制** ——
 * 允许重复，不许漂移。
 *
 * ## `--check`
 *
 * 不带参数：写盘。
 * 带 `--check`：只比对，不一致就打印差异并以码 1 退出。测试用这个。
 *
 * ## 本生成器**不负责**的事（别把 `--check` 当成万能体检）
 *
 * 1. **它查不出一份已从 `codes.mjs` 删掉的码留在 locale 里的孤儿键。**
 *
 *    原因：`regenerateClient` 是整段重写，能删键；`regenerateLocale` 只在"当前码表
 *    认识的键"上覆盖/插入，不认识的键一律原样保留（这是**故意的** —— 见下一条）。
 *    所以 `--check` 在一个"删了码但没清 locale"的仓库上会退出 0。
 *
 * 2. **`DELIVERY_BLOCKER_CODES` / `DELIVERY_WARNING_CODES` 不是基线的完整视图。**
 *
 *    实测：locale 里 73 个 `gates.code.*`，这两个名单只覆盖 34 个；另外 **13** 个是真在跑的
 *    基线门禁码却不在任何一张表里 ——
 *    `E_DECLARATION_MISSING` / `E_ILLEGAL_TRANSITION` / `E_FINDINGS_REQUIRED` /
 *    `E_OPEN_FINDINGS` / `E_VERIFY_FAILED_BY_RUNTIME` / `E_VERIFY_MISSING` /
 *    `E_ACCEPTANCE_MISMATCH` / `E_EVIDENCE_UNBACKED` / `E_PHANTOM_CHANGES` /
 *    `E_SCOPE_UNDECLARED` / `E_CHANGED_PATHS_REQUIRED` / `E_AUDIT_UNWIRED`，外加无码的
 *    `unknown`（"未知门禁"这个兜底标签本身）。
 *    它们由 `src/gates.mjs` / `src/contract.mjs` 等处直接产出。
 *
 *    所以**绝不许**把 `regenerateLocale` 改成"凡不在这两个名单里就删掉" —— 那会一次
 *    删掉上面 13 条活文案。第一版差点就这么写了，是先把这 13 个键数出来才拦住的。
 *
 * 3. 那么孤儿键靠什么抓？**靠测试，且报错会点名。**
 *
 *    `client.test.mjs` 的 28a / 35a 做的是 locale 与 `client.js` 内联表的**双向**键集比对，
 *    并逐值相等。删掉一个码再跑本生成器之后：client.js 少一个键、locale 还留着 →
 *    28a/35a 立刻红，`onlyJson.join(', ')` 会把那几个键名列出来，人工删掉即可。
 *    `31c` 的 73 这个数字也会红，逼人确认"确实该减少"。三处分工不同，合起来才盖住。
 *
 *    也就是说：**`--check` 管"生成器跑没跑过"，测试管"有没有死文案"。** 两件事。
 *
 * 用法：
 *   node plugin/tools/gen-meeting-codes.mjs
 *   node plugin/tools/gen-meeting-codes.mjs --check
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MEETING_CODES } from '../src/codes.mjs';
import { DELIVERY_BLOCKER_CODES, DELIVERY_WARNING_CODES } from '../src/delivery.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

/** 码名前缀。页面按 `gates.code.<CODE>` 查文案。 */
const KEY_PREFIX = 'gates.code.';

/** `client.js` 里生成区块的边界标记。 */
const CLIENT_BEGIN = '/* @meeting-codes:begin 由 tools/gen-meeting-codes.mjs 生成，勿手改 */';
const CLIENT_END = '/* @meeting-codes:end */';

/**
 * 基线已经拥有的码 —— 这些不该由本生成器负责。
 * @returns {Set<string>}
 */
function baselineOwnedCodes() {
  return new Set([...DELIVERY_BLOCKER_CODES, ...DELIVERY_WARNING_CODES]);
}

/**
 * 本生成器负责的码（按码名排序，保证产物稳定）。
 * @returns {Array<object>}
 */
export function generatedCodes() {
  const baseline = baselineOwnedCodes();
  return MEETING_CODES
    .filter((entry) => !baseline.has(entry.code))
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * 重新生成一份 locale 对象：删掉旧的生成键，再按顺序插回去。
 *
 * **插回的位置是"第一个生成键原来的位置"，不是文件末尾** ——
 * 这样 `git diff` 只会显示真正新增的那几行，而不是整段搬家。
 * 如果原来一个生成键都没有，就追加到末尾。
 *
 * @param {object} current 当前 locale 对象
 * @param {'zh'|'en'} lang
 * @returns {object} 新对象（不改入参）
 */
export function regenerateLocale(current, lang) {
  const codes = generatedCodes();
  const liveKeys = new Set(codes.map((entry) => KEY_PREFIX + entry.code));

  const out = {};
  let inserted = false;
  for (const [key, value] of Object.entries(current)) {
    if (liveKeys.has(key)) {
      if (!inserted) {
        for (const entry of codes) out[KEY_PREFIX + entry.code] = lang === 'en' ? entry.en : entry.zh;
        inserted = true;
      }
      continue; // 旧值丢弃，稍后统一写新的
    }
    out[key] = value;
  }
  if (!inserted) {
    for (const entry of codes) out[KEY_PREFIX + entry.code] = lang === 'en' ? entry.en : entry.zh;
  }
  return out;
}

/**
 * 重新生成 `client.js` 里那两段内联表。
 *
 * 找不到标记 → 抛。**绝不"顺手追加到文件末尾"**：那会把键塞到对象字面量外面，
 * 变成语法错误，而报错信息会指向一个跟本生成器毫无关系的位置。
 *
 * @param {string} source 当前 client.js 内容
 * @returns {string} 新内容
 */
export function regenerateClient(source) {
  const codes = generatedCodes();

  /* 两段区块：中文表在前、英文表在后。按出现顺序切成 [表1, 表2]。 */
  const beginCount = source.split(CLIENT_BEGIN).length - 1;
  const endCount = source.split(CLIENT_END).length - 1;
  if (beginCount !== 2 || endCount !== 2) {
    throw new Error(
      `client.js 里应有 2 组 @meeting-codes 标记（中文表、英文表各一组），`
        + `实际 begin=${beginCount} end=${endCount} —— 标记被删了或被复制了`,
    );
  }

  /** 按出现顺序取出两段区块的 [start, end) 区间。 */
  const regions = [];
  let cursor = 0;
  for (let i = 0; i < 2; i += 1) {
    const begin = source.indexOf(CLIENT_BEGIN, cursor);
    const end = source.indexOf(CLIENT_END, begin);
    regions.push({ begin, end });
    cursor = end;
  }

  /** 用 8 空格缩进拼接，与文件里对象字面量的既有缩进一致。 */
  const block = (lang) => codes
    .map((entry) => `        ${JSON.stringify(KEY_PREFIX + entry.code)}: ${JSON.stringify(lang === 'en' ? entry.en : entry.zh)},`)
    .join('\n');

  /* 从后往前替换：前面的下标不会因为后面的替换而失效。
   *
   * `regions[0]` 是文件里**先出现**的那段（中文表），`regions[1]` 是英文表 ——
   * 所以 langs 的顺序必须与 regions 一致。第一版这里写成了 ['en','zh']，
   * 结果中文表被填进英文文案，`client.test.mjs` 的 28a/35a 立刻抓到。
   * 那两条断言存在的理由就是这个：一个人不可能同时看住四处。 */
  let out = source;
  const langs = ['zh', 'en'];
  for (let i = regions.length - 1; i >= 0; i -= 1) {
    const { begin, end } = regions[i];
    const body = `\n${block(langs[i])}\n      `;
    out = out.slice(0, begin + CLIENT_BEGIN.length) + body + out.slice(end);
  }
  return out;
}

/** 读 JSON（保留原有格式化：2 空格缩进 + 末尾换行）。 */
function readJson(relative) {
  return JSON.parse(readFileSync(path.join(PLUGIN_ROOT, relative), 'utf8'));
}

/** 写 JSON，与仓库里既有的格式一致。 */
function writeJsonObject(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * 算出三份产物的期望内容。
 * @returns {Array<{relative: string, next: string, current: string}>}
 */
export function plan() {
  const targets = [];
  for (const lang of ['zh', 'en']) {
    const relative = `locale/${lang}.json`;
    const current = readFileSync(path.join(PLUGIN_ROOT, relative), 'utf8');
    const next = writeJsonObject(regenerateLocale(JSON.parse(current), lang));
    targets.push({ relative, current, next });
  }

  const clientRelative = 'client.js';
  const clientCurrent = readFileSync(path.join(PLUGIN_ROOT, clientRelative), 'utf8');
  targets.push({
    relative: clientRelative,
    current: clientCurrent,
    next: regenerateClient(clientCurrent),
  });

  return targets;
}

/**
 * 主流程。作为模块被 import 时不自动跑（`main` 单独导出，测试要用 `plan`）。
 *
 * @param {{check: boolean}} options
 * @returns {{ok: boolean, changed: Array<{relative: string, diffLines: number}>}}
 */
export function run({ check }) {
  const targets = plan();
  const changed = [];

  for (const { relative, current, next } of targets) {
    if (current === next) continue;
    const diffLines = countChangedLines(current, next);
    changed.push({ relative, diffLines });
    if (!check) writeFileSync(path.join(PLUGIN_ROOT, relative), next, 'utf8');
  }

  return { ok: changed.length === 0, changed };
}

/**
 * 粗算变了多少行（只用于给人看的报告，不做断言）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function countChangedLines(a, b) {
  const left = new Set(a.split('\n'));
  const right = new Set(b.split('\n'));
  let n = 0;
  for (const line of right) if (!left.has(line)) n += 1;
  for (const line of left) if (!right.has(line)) n += 1;
  return n;
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */
/* 只有被当脚本直接跑时才执行。`import.meta.url` 与 `process.argv[1]` 比对，
 * 是 ESM 里判断"入口还是被 import"的标准做法；用 `process.argv` 判据不写死路径。 */
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const check = process.argv.includes('--check');
  const { ok, changed } = run({ check });

  if (ok) {
    console.log(`会议码文案已是最新（生成 ${generatedCodes().length} 条）。`);
    process.exit(0);
  }

  if (check) {
    console.error('会议码文案与 src/codes.mjs 不一致：');
    for (const item of changed) console.error(`  ${item.relative}  (~${item.diffLines} 行)`);
    console.error('跑 `node plugin/tools/gen-meeting-codes.mjs` 重新生成，不要手改生成区块。');
    process.exit(1);
  }

  for (const item of changed) console.log(`已重写 ${item.relative}（~${item.diffLines} 行）`);
  process.exit(0);
}
