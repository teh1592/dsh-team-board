/**
 * contract.mjs 的验收测试
 * 运行：<node> --test plugin/test/contract.test.mjs
 *
 * 约定：每个错误码至少一个正例（能触发）与一个反例（不该触发），
 * 用例名里必须出现该错误码字符串，便于评审核对。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  KINDS,
  QUALITY_KINDS,
  normalizeIdentity,
  PATH_ILLEGAL_REASONS,
  CONTRACT_FIELDS,
  DECLARATION_REPORT_FIELDS,
  describePathIllegal,
  validatePlan,
  normalizePath,
  classifyPath,
  contractOf,
  contractAmbiguity,
  parseDeclaration,
  toEntryList,
  toEntryListStrict,
} from '../src/contract.mjs';

/* ----------------------------- 测试辅助 ----------------------------- */

const codesOf = (result) => result.errors.map((error) => error.code);
const hasCode = (result, code) => codesOf(result).includes(code);
const countCode = (result, code) => codesOf(result).filter((c) => c === code).length;

/** 一条"各项齐备"的基准任务；用 overrides 打坏某一维来测单条规则。 */
function task(overrides = {}) {
  return {
    id: 'T1',
    subject: '实现 contract 模块',
    kind: 'implementation',
    objective: '交付纯函数任务单校验模块',
    acceptance: ['`validatePlan` 一次返回全部错误 [AC1]'],
    verify: ['node --test --test-name-pattern=AC1 plugin/test/contract.test.mjs'],
    inScope: ['plugin/src/contract.mjs'],
    outOfScope: ['plugin/test/'],
    reviewedTaskId: undefined,
    assignee: 'impl-contract',
    ...overrides,
  };
}

/** 一份完全合法的任务单（3 个任务，规模够、有 review），应当 ok:true。 */
function validPlan() {
  return [
    task({ id: 'T1', inScope: ['plugin/src/contract.mjs'], outOfScope: ['plugin/test/'] }),
    task({
      id: 'T2',
      subject: '实现 config 模块',
      inScope: ['plugin/src/config.mjs'],
      outOfScope: ['plugin/src/contract.mjs'],
    }),
    task({
      id: 'T3',
      kind: 'review',
      subject: '交叉评审 contract',
      objective: '确保 T1 实现符合接口契约',
      reviewedTaskId: 'T1',
      inScope: ['plugin/src/contract.mjs'],
      outOfScope: ['plugin/src/config.mjs'],
    }),
  ];
}

/* =================================================================== */

describe('acceptance 1：一次返回全部错误', () => {
  it('validatePlan 不在第一条错误处短路，单任务多错误全部返回', () => {
    const broken = task({
      id: 'DUP',
      objective: '', // E_OBJECTIVE_REQUIRED
      acceptance: ['质量要过关', '文档要写清楚'], // 两条都无法映射 → E_ACCEPTANCE_UNVERIFIABLE ×2
      verify: ['npm run lint'],
      inScope: ['plugin/src/'], // 与 outOfScope 同路径 → E_SCOPE_CONFLICT
      outOfScope: ['plugin/src/', '/etc/passwd'], // 前者同路径（冲突）；后者 E_PATH_UNSAFE
    });
    const plan = [
      broken,
      task({ id: 'DUP', kind: 'feature' }), // 重复 id → E_ID_INVALID；非法 kind → E_KIND_INVALID
    ];

    const result = validatePlan(plan);

    assert.equal(result.ok, false);
    assert.equal(typeof result.ok, 'boolean');
    assert.ok(Array.isArray(result.errors));

    // 每个错误项形状：{code, taskId?, message}
    for (const error of result.errors) {
      assert.equal(typeof error.code, 'string');
      assert.ok(error.code.length > 0);
      assert.equal(typeof error.message, 'string');
      assert.ok(error.message.length > 0);
      if ('taskId' in error) assert.equal(typeof error.taskId, 'string');
    }

    // 至少 7 类错误同时出现，说明遍历没有中途退出
    const distinct = new Set(codesOf(result));
    for (const code of [
      'E_OBJECTIVE_REQUIRED',
      'E_ACCEPTANCE_UNVERIFIABLE',
      'E_SCOPE_CONFLICT',
      'E_PATH_UNSAFE',
      'E_ID_INVALID',
      'E_KIND_INVALID',
      'E_TEAM_NOT_JUSTIFIED',
    ]) {
      assert.ok(distinct.has(code), `期望同时报出 ${code}，实际只有 ${[...distinct].join(',')}`);
    }
    assert.ok(distinct.size >= 7);

    // 两条 acceptance 各自报一次，而不是只报第一条
    assert.equal(countCode(result, 'E_ACCEPTANCE_UNVERIFIABLE'), 2);
    // 跨任务规则（小团队）也一并报出，说明任务级遍历之后还有全局检查
    assert.equal(result.errors.length, 8);
  });

  it('validatePlan 合法任务单返回 {ok:true, errors:[]}', () => {
    assert.deepEqual(validatePlan(validPlan()), { ok: true, errors: [] });
  });

  it('validatePlan 错误项带 taskId 以便定位任务', () => {
    const result = validatePlan([task({ id: 'T1', kind: 'implementation', objective: '' })]);
    const error = result.errors.find((item) => item.code === 'E_OBJECTIVE_REQUIRED');
    assert.ok(error);
    assert.equal(error.taskId, 'T1');
  });
});

/* =================================================================== */

describe('acceptance 2：10 个错误码，各有正例与反例', () => {
  describe('E_ID_INVALID', () => {
    it('E_ID_INVALID 正例：id 缺失', () => {
      const result = validatePlan([task({ id: undefined })]);
      assert.ok(hasCode(result, 'E_ID_INVALID'));
    });

    it('E_ID_INVALID 正例：id 为非字符串', () => {
      const result = validatePlan([task({ id: 42 })]);
      assert.ok(hasCode(result, 'E_ID_INVALID'));
    });

    it('E_ID_INVALID 正例：id 为空串', () => {
      const result = validatePlan([task({ id: '   ' })]);
      assert.ok(hasCode(result, 'E_ID_INVALID'));
    });

    it('E_ID_INVALID 正例：id 重复（含与 existingTasks 冲突）', () => {
      const plan = [task({ id: 'T1' }), task({ id: 'T1', subject: '重复任务' })];
      assert.ok(hasCode(validatePlan(plan), 'E_ID_INVALID'));

      const withExisting = validatePlan([task({ id: 'E1' })], {
        existingTasks: [{ id: 'E1', kind: 'implementation' }],
      });
      assert.ok(hasCode(withExisting, 'E_ID_INVALID'));
    });

    it('E_ID_INVALID 反例：id 唯一且为字符串不报', () => {
      assert.ok(!hasCode(validatePlan(validPlan()), 'E_ID_INVALID'));
    });
  });

  describe('E_KIND_INVALID', () => {
    it('E_KIND_INVALID 正例：kind 不在枚举内', () => {
      assert.ok(hasCode(validatePlan([task({ kind: 'feature' })]), 'E_KIND_INVALID'));
    });

    it('E_KIND_INVALID 正例：kind 缺失 / 非字符串', () => {
      assert.ok(hasCode(validatePlan([task({ kind: undefined })]), 'E_KIND_INVALID'));
      assert.ok(hasCode(validatePlan([task({ kind: 7 })]), 'E_KIND_INVALID'));
    });

    it('E_KIND_INVALID 反例：KINDS 里每个值都不报', () => {
      for (const kind of KINDS) {
        const result = validatePlan([task({ kind, reviewedTaskId: 'T1' })]);
        assert.ok(!hasCode(result, 'E_KIND_INVALID'), `kind=${kind} 不该报 E_KIND_INVALID`);
      }
      /* task-21（开会与方案流程）：新增第四种 kind `proposal`（产出一份方案，可以只写文档）。
       * 这条断言是"KINDS 的确切内容"，每次改 KINDS 都必须显式改这里 —— 那是故意的。 */
      assert.deepEqual([...KINDS], ['implementation', 'review', 'work', 'proposal']);
    });
  });

  describe('E_OBJECTIVE_REQUIRED', () => {
    it('E_OBJECTIVE_REQUIRED 正例：质量 kind 缺 objective', () => {
      assert.ok(hasCode(validatePlan([task({ objective: undefined })]), 'E_OBJECTIVE_REQUIRED'));
      assert.ok(hasCode(validatePlan([task({ objective: '   ' })]), 'E_OBJECTIVE_REQUIRED'));
      assert.ok(
        hasCode(
          validatePlan([task({ kind: 'review', reviewedTaskId: 'T1', objective: '' })]),
          'E_OBJECTIVE_REQUIRED',
        ),
      );
    });

    it('E_OBJECTIVE_REQUIRED 反例：work 不要求 objective，implementation 有 objective 时也不报', () => {
      assert.ok(!hasCode(validatePlan([task({ kind: 'work', objective: undefined })]), 'E_OBJECTIVE_REQUIRED'));
      assert.ok(!hasCode(validatePlan(validPlan()), 'E_OBJECTIVE_REQUIRED'));
    });
  });

  describe('E_ACCEPTANCE_REQUIRED', () => {
    it('E_ACCEPTANCE_REQUIRED 正例：质量 kind 缺 acceptance', () => {
      assert.ok(hasCode(validatePlan([task({ acceptance: [] })]), 'E_ACCEPTANCE_REQUIRED'));
      assert.ok(hasCode(validatePlan([task({ acceptance: undefined })]), 'E_ACCEPTANCE_REQUIRED'));
    });

    it('E_ACCEPTANCE_REQUIRED 反例：work 不要求 acceptance，有 acceptance 时也不报', () => {
      assert.ok(!hasCode(validatePlan([task({ kind: 'work', acceptance: [] })]), 'E_ACCEPTANCE_REQUIRED'));
      assert.ok(!hasCode(validatePlan(validPlan()), 'E_ACCEPTANCE_REQUIRED'));
    });
  });

  describe('E_ACCEPTANCE_UNVERIFIABLE', () => {
    it('E_ACCEPTANCE_UNVERIFIABLE 正例：acceptance 无任何 verify 映射', () => {
      const result = validatePlan([task({ acceptance: ['文档要写清楚'], verify: ['npm run lint'] })]);
      assert.ok(hasCode(result, 'E_ACCEPTANCE_UNVERIFIABLE'));
    });

    it('E_ACCEPTANCE_UNVERIFIABLE 正例：标签写了但 verify 没有同标签', () => {
      const result = validatePlan([
        task({ acceptance: ['接口契约要冻结 [AC7]'], verify: ['npm run lint'] }),
      ]);
      assert.ok(hasCode(result, 'E_ACCEPTANCE_UNVERIFIABLE'));
    });

    it('E_ACCEPTANCE_UNVERIFIABLE 反例：显式 [ACn] 标签命中即算已覆盖', () => {
      const tagged = task({
        acceptance: ['路径规范化必须安全 [AC1]'],
        verify: ['node --test --test-name-pattern=AC1 plugin/test/contract.test.mjs'],
      });
      assert.ok(!hasCode(validatePlan([tagged]), 'E_ACCEPTANCE_UNVERIFIABLE'));
    });

    it('E_ACCEPTANCE_UNVERIFIABLE 反例：逐字包含 verify 项原文即算已覆盖', () => {
      const byContainment = task({
        acceptance: ['登录后跳转到首页：playwright test login.spec.ts'],
        verify: ['playwright test login.spec.ts'],
      });
      assert.ok(!hasCode(validatePlan([byContainment]), 'E_ACCEPTANCE_UNVERIFIABLE'));
    });
  });

  describe('E_SCOPE_VERIFY_REQUIRED', () => {
    it('E_SCOPE_VERIFY_REQUIRED 正例：implementation 缺 inScope 或 verify', () => {
      assert.ok(hasCode(validatePlan([task({ inScope: [] })]), 'E_SCOPE_VERIFY_REQUIRED'));
      assert.ok(hasCode(validatePlan([task({ verify: [] })]), 'E_SCOPE_VERIFY_REQUIRED'));
    });

    it('E_SCOPE_VERIFY_REQUIRED 反例：work 没有 inScope/verify 也不报，implementation 齐备也不报', () => {
      const work = validatePlan([task({ kind: 'work', inScope: [], verify: [] })]);
      assert.ok(!hasCode(work, 'E_SCOPE_VERIFY_REQUIRED'));
      assert.ok(!hasCode(validatePlan(validPlan()), 'E_SCOPE_VERIFY_REQUIRED'));
    });
  });

  describe('E_REVIEWED_TARGET_REQUIRED', () => {
    it('E_REVIEWED_TARGET_REQUIRED 正例：review 缺 reviewedTaskId', () => {
      const result = validatePlan([task({ kind: 'review', reviewedTaskId: undefined })]);
      assert.ok(hasCode(result, 'E_REVIEWED_TARGET_REQUIRED'));
    });

    it('E_REVIEWED_TARGET_REQUIRED 正例：reviewedTaskId 指向不存在的任务', () => {
      const result = validatePlan([task({ kind: 'review', reviewedTaskId: 'GHOST' })]);
      assert.ok(hasCode(result, 'E_REVIEWED_TARGET_REQUIRED'));
    });

    it('E_REVIEWED_TARGET_REQUIRED 反例：目标存在（本单内或 existingTasks 内）不报', () => {
      const plan = [task({ id: 'T1' }), task({ id: 'R1', kind: 'review', reviewedTaskId: 'T1' })];
      assert.ok(!hasCode(validatePlan(plan), 'E_REVIEWED_TARGET_REQUIRED'));

      const withExisting = validatePlan(
        [task({ id: 'R2', kind: 'review', reviewedTaskId: 'E1' })],
        { existingTasks: [{ id: 'E1', kind: 'implementation' }] },
      );
      assert.ok(!hasCode(withExisting, 'E_REVIEWED_TARGET_REQUIRED'));
    });
  });

  describe('E_PATH_UNSAFE', () => {
    const unsafePaths = [
      '/etc/passwd',
      '../escape.ts',
      '~/secrets',
      'a/../../b',
      '..\\windows\\system32\\config',
      'C:\\Users\\x',
      '',
      null,
      42,
    ];

    it('E_PATH_UNSAFE 正例：绝对路径 / .. / ~ / 反斜杠逃逸 / 非字符串逐条报出', () => {
      const result = validatePlan([task({ inScope: unsafePaths })]);
      assert.equal(countCode(result, 'E_PATH_UNSAFE'), unsafePaths.length);
      assert.ok(hasCode(result, 'E_PATH_UNSAFE'));
    });

    it('E_PATH_UNSAFE 正例：outOfScope 里同样校验', () => {
      const result = validatePlan([task({ outOfScope: ['../leak/'] })]);
      assert.ok(hasCode(result, 'E_PATH_UNSAFE'));
    });

    it('E_PATH_UNSAFE 反例：合法相对路径（含 Windows 反斜杠写法）不报', () => {
      const ok = task({
        inScope: ['plugin/src/contract.mjs', 'plugin\\src\\contract.mjs', ' plugin/test/ '],
        outOfScope: ['plugin/test/'],
      });
      assert.ok(!hasCode(validatePlan([ok]), 'E_PATH_UNSAFE'));
    });
  });

  describe('E_SCOPE_CONFLICT', () => {
    it('E_SCOPE_CONFLICT 正例：同路径 / inScope 是死声明（落在 outOfScope 目录里）', () => {
      const files = task({
        inScope: ['plugin/src/contract.mjs'],
        outOfScope: ['plugin/src/contract.mjs'],
      });
      assert.ok(hasCode(validatePlan([files]), 'E_SCOPE_CONFLICT'));

      const nestedDir = task({ inScope: ['plugin/src/auth/'], outOfScope: ['plugin/src/'] });
      assert.ok(hasCode(validatePlan([nestedDir]), 'E_SCOPE_CONFLICT'));
    });

    it('E_SCOPE_CONFLICT 反例：不相交（含 src/auth/ 与 src/authz.ts 的前缀边界）不报', () => {
      const disjoint = task({ inScope: ['plugin/src/contract.mjs'], outOfScope: ['plugin/test/'] });
      assert.ok(!hasCode(validatePlan([disjoint]), 'E_SCOPE_CONFLICT'));

      const boundary = task({ inScope: ['plugin/src/auth/'], outOfScope: ['plugin/src/authz.ts'] });
      assert.ok(!hasCode(validatePlan([boundary]), 'E_SCOPE_CONFLICT'));
    });

    it('E_SCOPE_CONFLICT 反例：outOfScope 在 inScope 目录里是「挖洞」，不是冲突（回归 bug 修复）', () => {
      // 旧实现在这里误报冲突：a.isDir && b.path.startsWith(a.path + '/')。
      // 但 classifyPath 的运行时语义是 outOfScope 优先 → 挖洞本来就被支持，校验期不该禁止。
      const holeDir = task({ inScope: ['plugin/src/'], outOfScope: ['plugin/src/legacy/'] });
      assert.ok(!hasCode(validatePlan([holeDir]), 'E_SCOPE_CONFLICT'));

      const holeFile = task({ inScope: ['plugin/src/'], outOfScope: ['plugin/src/contract.mjs'] });
      assert.ok(!hasCode(validatePlan([holeFile]), 'E_SCOPE_CONFLICT'));
    });
  });

  describe('E_TEAM_NOT_JUSTIFIED', () => {
    it('E_TEAM_NOT_JUSTIFIED 正例：任务 ≤2、文件 ≤2、没有 review', () => {
      const plan = [
        task({ id: 'T1', inScope: ['plugin/src/a.mjs'], outOfScope: ['plugin/test/'] }),
        task({ id: 'T2', inScope: ['plugin/src/b.mjs'], outOfScope: ['plugin/test/'] }),
      ];
      assert.ok(hasCode(validatePlan(plan), 'E_TEAM_NOT_JUSTIFIED'));
    });

    it('E_TEAM_NOT_JUSTIFIED 反例：任务 >2 / 文件 >2 / 有 review / 空单 都不报', () => {
      assert.ok(!hasCode(validatePlan(validPlan()), 'E_TEAM_NOT_JUSTIFIED'));

      const moreFiles = [
        task({ id: 'T1', inScope: ['plugin/src/a.mjs', 'plugin/src/b.mjs'], outOfScope: [] }),
        task({ id: 'T2', inScope: ['plugin/src/c.mjs'], outOfScope: [] }),
      ];
      assert.ok(!hasCode(validatePlan(moreFiles), 'E_TEAM_NOT_JUSTIFIED'));

      const withReview = [
        task({ id: 'T1', inScope: ['plugin/src/a.mjs'], outOfScope: [] }),
        task({
          id: 'R1',
          kind: 'review',
          reviewedTaskId: 'T1',
          inScope: ['plugin/src/a.mjs'],
          outOfScope: [],
        }),
      ];
      assert.ok(!hasCode(validatePlan(withReview), 'E_TEAM_NOT_JUSTIFIED'));

      assert.ok(!hasCode(validatePlan([]), 'E_TEAM_NOT_JUSTIFIED'));
    });
  });
});

/* =================================================================== */

describe('acceptance 3：normalizePath', () => {
  it('normalizePath 输出工作区相对 POSIX 路径', () => {
    assert.equal(normalizePath('plugin/src/contract.mjs'), 'plugin/src/contract.mjs');
    assert.equal(normalizePath('plugin\\src\\contract.mjs'), 'plugin/src/contract.mjs');
    assert.equal(normalizePath('./plugin/src/contract.mjs'), 'plugin/src/contract.mjs');
    assert.equal(normalizePath('plugin//src///contract.mjs'), 'plugin/src/contract.mjs');
    assert.equal(normalizePath('plugin/src/auth/'), 'plugin/src/auth');
    assert.equal(normalizePath('  plugin/test/a.test.mjs  '), 'plugin/test/a.test.mjs');
  });

  it('normalizePath 对绝对路径 / .. 段 / ~ 开头 / 空串返回 null', () => {
    const illegal = [
      '',
      '   ',
      '/etc/passwd',
      '\\etc\\passwd',
      'C:\\Windows\\System32',
      'C:x',
      '\\\\server\\share',
      '..',
      '../x',
      'a/../b',
      '..\\..\\x',
      '~/secrets',
      '~user/secrets',
      '.',
      './',
      42,
      null,
      undefined,
      {},
    ];
    for (const value of illegal) {
      assert.equal(normalizePath(value), null, `期望 ${JSON.stringify(value)} → null`);
    }
  });
});

describe('acceptance 4：classifyPath', () => {
  it('classifyPath：outOfScope 优先于 inScope', () => {
    assert.equal(classifyPath('src/a.ts', ['src/'], ['src/a.ts']), 'out_of_scope');
    assert.equal(classifyPath('src/auth/a.ts', ['src/auth/'], ['src/auth/']), 'out_of_scope');
    assert.equal(classifyPath('src/auth/a.ts', ['src/'], ['src/auth/']), 'out_of_scope');
  });

  it('classifyPath：目录模式是前缀匹配，且不越界到同前缀兄弟', () => {
    assert.equal(classifyPath('src/auth/a.ts', ['src/auth/'], []), 'in_scope');
    assert.equal(classifyPath('src/auth/deep/x.ts', ['src/auth/'], []), 'in_scope');
    assert.equal(classifyPath('src/auth', ['src/auth/'], []), 'in_scope');
    assert.equal(classifyPath('src/authz.ts', ['src/auth/'], []), 'undeclared');
  });

  it('classifyPath：精确模式只匹配该文件', () => {
    assert.equal(classifyPath('src/a.ts', ['src/a.ts'], []), 'in_scope');
    assert.equal(classifyPath('src/a.tsx', ['src/a.ts'], []), 'undeclared');
    assert.equal(classifyPath('src/a.ts/b.ts', ['src/a.ts'], []), 'undeclared');
  });

  it('classifyPath：未声明返回 undeclared（含非法路径与空声明）', () => {
    assert.equal(classifyPath('docs/x.md', ['src/'], ['gen/']), 'undeclared');
    assert.equal(classifyPath('/etc/passwd', ['src/'], []), 'undeclared');
    assert.equal(classifyPath('src/a.ts', undefined, undefined), 'undeclared');
    assert.equal(classifyPath('src/a.ts', [], []), 'undeclared');
  });

  it('classifyPath：Windows 反斜杠写法同样可判定', () => {
    assert.equal(classifyPath('src\\auth\\a.ts', ['src/auth/'], []), 'in_scope');
    assert.equal(classifyPath('src\\auth\\a.ts', [], ['src/auth/']), 'out_of_scope');
  });
});

/* =================================================================== */
/* 新增：F1 / F2 / F3 修复的回归与新增口径                              */
/* =================================================================== */

/** 新写法（契约写在 task.contract 下）的任务；与顶部 task() 平行。 */
function contractTask(contract = {}, overrides = {}) {
  return { id: 'C1', kind: 'implementation', contract, ...overrides };
}

/** 一份"契约写在 contract 下"的合法任务单（3 个任务、含 review，规模足够）。 */
function contractPlan() {
  return [
    contractTask(
      {
        objective: '交付纯函数任务单校验模块',
        acceptance: ['npm test 通过'],
        verify: ['npm test'],
        inScope: ['src/'],
        outOfScope: ['docs/'],
      },
      { id: 'C1' },
    ),
    contractTask({ inScope: ['src/b.mjs'] }, { id: 'C2', kind: 'work' }),
    contractTask(
      {
        objective: '确保 C1 符合接口契约',
        acceptance: ['评审结论已签署 [AC1]'],
        verify: ['node --test --test-name-pattern=AC1 plugin/test/review.test.mjs'],
        reviewedTaskId: 'C1',
        inScope: ['src/'],
        outOfScope: ['docs/'],
      },
      { id: 'C3', kind: 'review' },
    ),
  ];
}

describe('F1 contractOf：契约唯一取值入口', () => {
  it('contractOf 对非对象输入返回空对象且永不抛错', () => {
    for (const value of [null, undefined, [], 0, 42, 'T1', true, false, () => {}]) {
      const got = contractOf(value);
      assert.deepEqual(got, {}, `contractOf(${String(value)}) 必须是 {}`);
      assert.notEqual(got, null);
      assert.notEqual(got, undefined);
    }
  });

  it('contractOf 优先返回 task.contract 本身，且不与顶层字段合并', () => {
    const contract = { inScope: ['c/'] };
    const planTask = { id: 'T', kind: 'implementation', objective: '顶层残留', inScope: ['top/'], contract };

    const got = contractOf(planTask);
    assert.equal(got, contract, '必须返回 task.contract 本身（同一引用），而不是副本或合并结果');
    assert.deepEqual(got.inScope, ['c/']);
    assert.ok(!('objective' in got), '顶层 objective 不得被合并进契约：否则双份声明会漂移');
    assert.ok(!('inScope' in got) || got.inScope[0] !== 'top/', '顶层 inScope 不得覆盖 contract');
  });

  it('contractOf 在没有普通 contract 对象时回退到 task 本身（兼容旧顶层写法）', () => {
    const legacy = { id: 'T', inScope: ['top/'], acceptance: ['a'] };
    assert.equal(contractOf(legacy), legacy);

    // contract 存在但不是普通对象 → 仍回退到 task
    for (const bad of [null, [], 'x', 42, true]) {
      const planTask = { id: 'T', inScope: ['top/'], contract: bad };
      assert.equal(contractOf(planTask), planTask, `contract=${JSON.stringify(bad)} 应回退到 task 本身`);
    }
  });
});

describe('F1 contract 写法：契约写在 task.contract 下被完整校验', () => {
  it('contract 写法齐备时 ok:true', () => {
    assert.deepEqual(validatePlan(contractPlan()), { ok: true, errors: [] });
  });

  it('contract 写法缺 objective / acceptance / verify / inScope 时逐个报错', () => {
    const result = validatePlan([
      contractTask({ inScope: ['src/'], verify: ['npm test'] }, { id: 'C1' }),
      contractTask({}, { id: 'C2', kind: 'work' }),
      contractTask({}, { id: 'C3', kind: 'work' }),
    ]);
    assert.ok(hasCode(result, 'E_OBJECTIVE_REQUIRED'));
    assert.ok(hasCode(result, 'E_ACCEPTANCE_REQUIRED'));

    const onlyVerify = validatePlan([
      contractTask({ objective: 'o', acceptance: ['npm test 通过'], inScope: ['src/'] }, { id: 'C1' }),
      contractTask({}, { id: 'C2', kind: 'work' }),
      contractTask({}, { id: 'C3', kind: 'work' }),
    ]);
    assert.ok(hasCode(onlyVerify, 'E_SCOPE_VERIFY_REQUIRED'), 'contract 缺 verify 必须报 E_SCOPE_VERIFY_REQUIRED');
  });

  it('contract.inScope / contract.outOfScope 里的危险路径照样报 E_PATH_UNSAFE', () => {
    const result = validatePlan([
      contractTask(
        {
          objective: 'o',
          acceptance: ['npm test 通过'],
          verify: ['npm test'],
          inScope: ['../etc', 'src/'],
          outOfScope: ['/abs'],
        },
        { id: 'C1' },
      ),
      contractTask({}, { id: 'C2', kind: 'work' }),
      contractTask({}, { id: 'C3', kind: 'work' }),
    ]);
    assert.equal(countCode(result, 'E_PATH_UNSAFE'), 2);
  });

  it('contract 里 E_SCOPE_CONFLICT：死声明报错，挖洞放行', () => {
    const withScopes = (inScope, outOfScope) => validatePlan([
      contractTask(
        { objective: 'o', acceptance: ['npm test 通过'], verify: ['npm test'], inScope, outOfScope },
        { id: 'C1' },
      ),
      contractTask({}, { id: 'C2', kind: 'work' }),
      contractTask({}, { id: 'C3', kind: 'work' }),
    ]);

    // 死声明：inScope 整个落在 outOfScope 目录里
    assert.ok(hasCode(withScopes(['src/legacy/'], ['src/']), 'E_SCOPE_CONFLICT'));
    // 挖洞：outOfScope 是 inScope 下的子目录 → 合法
    assert.ok(!hasCode(withScopes(['src/'], ['src/legacy/']), 'E_SCOPE_CONFLICT'));
  });

  it('contract.reviewedTaskId 缺失 / 幽灵 / 存在三种情形', () => {
    const base = (reviewedTaskId) => [
      contractTask(
        {
          objective: 'o',
          acceptance: ['评审结论已签署 [AC1]'],
          verify: ['node --test --test-name-pattern=AC1 x.mjs'],
          ...(reviewedTaskId === undefined ? {} : { reviewedTaskId }),
          inScope: ['src/'],
          outOfScope: ['docs/'],
        },
        { id: 'R1', kind: 'review' },
      ),
      contractTask({ inScope: ['src/b.mjs'] }, { id: 'C2', kind: 'work' }),
      contractTask({ inScope: ['src/c.mjs'] }, { id: 'C3', kind: 'work' }),
    ];
    assert.ok(hasCode(validatePlan(base(undefined)), 'E_REVIEWED_TARGET_REQUIRED'));
    assert.ok(hasCode(validatePlan(base('GHOST')), 'E_REVIEWED_TARGET_REQUIRED'));
    assert.ok(!hasCode(validatePlan(base('C2')), 'E_REVIEWED_TARGET_REQUIRED'), '指向本单存在的任务不应报错');
  });

  it('contract 为 {} 时视为未声明，回退顶层写法（顶层字段必须可见，L-5 修复）', () => {
    // 第三轮 C2：旧实现把 contract:{} 当成"已声明空契约"，于是顶层 objective/acceptance/inScope
    // 全部不可见，报 E_OBJECTIVE_REQUIRED / E_ACCEPTANCE_REQUIRED / E_SCOPE_VERIFY_REQUIRED，
    // 而字段其实就写在三行之上 —— 诊断方向完全错。现在 {} 是零信息 = 未声明。
    const result = validatePlan([
      {
        id: 'C1',
        kind: 'implementation',
        // 旧的顶层写法与 contract:{} 同时存在
        objective: '顶层 objective',
        acceptance: ['npm test 通过'],
        verify: ['npm test'],
        inScope: ['src/'],
        outOfScope: ['docs/'],
        contract: {},
      },
      contractTask({}, { id: 'C2', kind: 'work' }),
      contractTask({}, { id: 'C3', kind: 'work' }),
    ]);
    assert.deepEqual(codesOf(result), [], `回退顶层后应当全绿，实际 ${JSON.stringify(codesOf(result))}`);
    assert.equal(contractOf({ id: 'x', contract: {}, inScope: ['src/'] }).inScope[0], 'src/', 'contractOf 必须回退到 task 本身');
  });
});

describe('F2 acceptance→verify 收紧：通用词元不得互认', () => {
  it('F2 正例：acceptance=["验证通过"] + verify=["随便验证一下"] → E_ACCEPTANCE_UNVERIFIABLE', () => {
    const result = validatePlan([
      task({ acceptance: ['验证通过'], verify: ['随便验证一下'] }),
      task({ id: 'T2', kind: 'work', objective: undefined, acceptance: undefined }),
      task({ id: 'T3', kind: 'work', objective: undefined, acceptance: undefined }),
    ]);
    assert.ok(hasCode(result, 'E_ACCEPTANCE_UNVERIFIABLE'), `实际错误码 ${JSON.stringify(codesOf(result))}`);
    assert.equal(countCode(result, 'E_ACCEPTANCE_UNVERIFIABLE'), 1);
  });

  it('F2 口径变更（第三轮 C1）：acceptance=["node --test 全绿"] + verify=["node --test plugin/test"] → 报错', () => {
    // 原断言（第二轮）：靠共享词元 node/test 判为已覆盖，不报错。
    // 现断言：词元通道整体删除，acceptance 未逐字包含 verify 原文 → 必须报。
    // 理由：acceptance 里出现命令名就能"蒙过去"正是 L-8 指出的漏洞面；改为显式声明后，
    //       想让它过只需写成「node --test 全绿：node --test plugin/test」或两边都标 [AC1]。
    const result = validatePlan([
      task({ acceptance: ['node --test 全绿'], verify: ['node --test plugin/test'] }),
      task({ id: 'T2', kind: 'work', objective: undefined, acceptance: undefined }),
      task({ id: 'T3', kind: 'work', objective: undefined, acceptance: undefined }),
    ]);
    assert.deepEqual(codesOf(result), ['E_ACCEPTANCE_UNVERIFIABLE'], `实际错误码 ${JSON.stringify(codesOf(result))}`);
  });

  it('F2：单个中文 2-gram 交集不足以判覆盖（「检查通过」vs「随便检查一下」）', () => {
    const result = validatePlan([
      task({ acceptance: ['检查通过'], verify: ['随便检查一下'] }),
      task({ id: 'T2', kind: 'work', objective: undefined, acceptance: undefined }),
      task({ id: 'T3', kind: 'work', objective: undefined, acceptance: undefined }),
    ]);
    assert.ok(hasCode(result, 'E_ACCEPTANCE_UNVERIFIABLE'));
  });

  it('F2：[ACn] 标签通道保持原样，单个标签命中即通过（不受权重门槛限制）', () => {
    const result = validatePlan([
      task({ acceptance: ['登录成功 [AC1]'], verify: ['node --test --test-name-pattern=AC1 x.mjs'] }),
      task({ id: 'T2', kind: 'work', objective: undefined, acceptance: undefined }),
      task({ id: 'T3', kind: 'work', objective: undefined, acceptance: undefined }),
    ]);
    assert.deepEqual(codesOf(result), []);
  });

  it('F2 口径变更（第三轮 C1）：长标识符共享不再算覆盖', () => {
    // 原断言（第二轮）：`normalizePath` 是 ≥8 字符的长标识符，单个命中计权重 2 → 判为已覆盖。
    // 现断言：词元权重设施整体删除，"提到同一个函数名"不再是映射证据 → 必须报。
    const result = validatePlan([
      task({
        acceptance: ['`normalizePath` 拒绝绝对路径'],
        verify: ['node --test --test-name-pattern=normalizePath plugin/test/contract.test.mjs'],
      }),
      task({ id: 'T2', kind: 'work', objective: undefined, acceptance: undefined }),
      task({ id: 'T3', kind: 'work', objective: undefined, acceptance: undefined }),
    ]);
    assert.deepEqual(codesOf(result), ['E_ACCEPTANCE_UNVERIFIABLE'], `实际错误码 ${JSON.stringify(codesOf(result))}`);
  });
});

describe('F3 三类危险路径稳定产生 E_PATH_UNSAFE（不被降级成别的码）', () => {
  const cases = [
    ['相对穿越 ../../etc/passwd', '../../etc/passwd'],
    ['绝对路径 /abs', '/abs'],
    ['家目录 ~/x', '~/x'],
  ];

  for (const [label, unsafe] of cases) {
    it(`F3：${label} → 恰好一条 E_PATH_UNSAFE`, () => {
      const result = validatePlan([task({ inScope: [unsafe] })]);
      // 单任务必然带 E_TEAM_NOT_JUSTIFIED（规模检查），其余错误码必须只有 E_PATH_UNSAFE
      const others = codesOf(result).filter((code) => code !== 'E_TEAM_NOT_JUSTIFIED');
      assert.deepEqual(others, ['E_PATH_UNSAFE'], `${label} 实际 ${JSON.stringify(codesOf(result))}`);
      assert.equal(normalizePath(unsafe), null, `${label} 的 normalizePath 必须是 null`);
    });
  }

  it('F3：三类危险路径写在 contract.inScope 里同样报 E_PATH_UNSAFE', () => {
    for (const [, unsafe] of cases) {
      const result = validatePlan([
        contractTask(
          { objective: 'o', acceptance: ['npm test 通过'], verify: ['npm test'], inScope: ['src/', unsafe] },
          { id: 'C1' },
        ),
        contractTask({}, { id: 'C2', kind: 'work' }),
        contractTask({}, { id: 'C3', kind: 'work' }),
      ]);
      assert.ok(hasCode(result, 'E_PATH_UNSAFE'), `${unsafe} 在 contract.inScope 里必须报 E_PATH_UNSAFE`);
    }
  });
});

describe('toEntryList：跨模块锁定的声明解析入口', () => {
  it('单字符串 "src/" 必须产出一条目录条目，不能当空数组', () => {
    const entries = toEntryList('src/');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { path: 'src', isDir: true, raw: 'src/', key: 'src/' });
    assert.equal(entries[0].key, 'src/', '去重键就是带结尾斜杠的 "src/"');
  });

  it('数组：按声明顺序、按 key 去重，文件与同名目录是两条', () => {
    const entries = toEntryList(['src/', 'src/', 'src', 'plugin/src/a.mjs', 'plugin/src/a.mjs']);
    assert.deepEqual(entries.map((entry) => entry.key), ['src/', 'src', 'plugin/src/a.mjs']);
    assert.equal(entries[1].isDir, false);
  });

  it('已解析条目 { path, isDir } 也被接受', () => {
    const entries = toEntryList([{ path: 'src/a.mjs' }, { path: 'src/', isDir: true }, { path: 'src/b.mjs', isDir: false }]);
    assert.deepEqual(entries.map((entry) => entry.key), ['src/a.mjs', 'src/', 'src/b.mjs']);
    assert.equal(entries[1].isDir, true);
  });

  it('raw 永远是可直接传给 classifyPath 的模式字符串（对象条目也不是 [object Object]）', () => {
    const entries = toEntryList([{ path: 'src/', isDir: true }, { path: 'src/a.mjs' }, 'plugin/src/']);
    assert.deepEqual(entries.map((entry) => entry.raw), ['src/', 'src/a.mjs', 'plugin/src/']);
    for (const entry of entries) {
      assert.equal(typeof entry.raw, 'string');
      assert.equal(normalizePath(entry.raw), entry.path, 'raw 经 normalizePath 后必须等于 path');
    }
    assert.equal(classifyPath('src/x.ts', [entries[0].raw], []), 'in_scope', 'raw 必须保留目录语义');
  });

  it('非法 / 空 / 非字符串条目被跳过，且永不抛错', () => {
    for (const value of [undefined, null, 42, '', '   ', [], ['/abs', '../x', '~/y', null, 42, {}]]) {
      const entries = toEntryList(value);
      assert.ok(Array.isArray(entries), `toEntryList(${JSON.stringify(value)}) 必须返回数组`);
      assert.deepEqual(entries, [], `toEntryList(${JSON.stringify(value)}) 应跳过全部非法条目`);
    }
  });

  it('新导出面存在：contractOf / toEntryList 为函数，旧四件套不变', () => {
    assert.equal(typeof contractOf, 'function');
    assert.equal(typeof toEntryList, 'function');
    /* task-21：KINDS 多了 `proposal`。 */
    assert.deepEqual([...KINDS], ['implementation', 'review', 'work', 'proposal']);
    assert.equal(typeof validatePlan, 'function');
    assert.equal(typeof normalizePath, 'function');
    assert.equal(typeof classifyPath, 'function');
  });
});

describe('B7 修复：E_SCOPE_CONFLICT 判据是「inScope 是死声明」，不是「有交集」', () => {
  /** 在同一份 plan 里放 ≥3 个任务，避开 E_TEAM_NOT_JUSTIFIED 噪声。 */
  function planWith(inScope, outOfScope) {
    return [
      task({ id: 'T1', inScope, outOfScope }),
      task({ id: 'T2', kind: 'work', objective: undefined, acceptance: undefined, inScope: ['docs/a.md'], outOfScope: [] }),
      task({ id: 'T3', kind: 'work', objective: undefined, acceptance: undefined, inScope: ['docs/b.md'], outOfScope: [] }),
    ];
  }
  const conflicts = (inScope, outOfScope) => hasCode(validatePlan(planWith(inScope, outOfScope)), 'E_SCOPE_CONFLICT');

  it('1) inScope=[src/] + outOfScope=[src/legacy/] → 通过（挖目录）', () => {
    assert.equal(conflicts(['src/'], ['src/legacy/']), false);
  });

  it('2) inScope=[src/] + outOfScope=[src/legacy/x.ts] → 通过（挖单文件）', () => {
    assert.equal(conflicts(['src/'], ['src/legacy/x.ts']), false);
  });

  it('3) inScope=[src/] + outOfScope=[src/] → E_SCOPE_CONFLICT（全同）', () => {
    assert.equal(conflicts(['src/'], ['src/']), true);
  });

  it('4) inScope=[src/legacy/] + outOfScope=[src/] → E_SCOPE_CONFLICT（inScope 是死声明）', () => {
    assert.equal(conflicts(['src/legacy/'], ['src/']), true);
  });

  it('5) inScope=[src/legacy/x.ts] + outOfScope=[src/] → E_SCOPE_CONFLICT（文件落在被排除目录里）', () => {
    assert.equal(conflicts(['src/legacy/x.ts'], ['src/']), true);
  });

  it('6) inScope=[src/] + outOfScope=[docs/] → 通过（不相交）', () => {
    assert.equal(conflicts(['src/'], ['docs/']), false);
  });

  it('7) 一致性：validatePlan 的冲突判定必须与 classifyPath 的运行期语义自洽', () => {
    const combos = [
      { inScope: ['src/'], outOfScope: ['src/legacy/'], expectConflict: false, probe: 'src/legacy/x.ts', expectVerdict: 'out_of_scope' },
      { inScope: ['src/'], outOfScope: ['src/legacy/x.ts'], expectConflict: false, probe: 'src/legacy/x.ts', expectVerdict: 'out_of_scope' },
      { inScope: ['src/'], outOfScope: ['src/'], expectConflict: true, probe: 'src/legacy/x.ts', expectVerdict: 'out_of_scope' },
      { inScope: ['src/legacy/'], outOfScope: ['src/'], expectConflict: true, probe: 'src/legacy/x.ts', expectVerdict: 'out_of_scope' },
      { inScope: ['src/legacy/x.ts'], outOfScope: ['src/'], expectConflict: true, probe: 'src/legacy/x.ts', expectVerdict: 'out_of_scope' },
      { inScope: ['src/'], outOfScope: ['docs/'], expectConflict: false, probe: 'src/legacy/x.ts', expectVerdict: 'in_scope' },
    ];

    for (const combo of combos) {
      const label = `inScope=${JSON.stringify(combo.inScope)} outOfScope=${JSON.stringify(combo.outOfScope)}`;
      const conflict = conflicts(combo.inScope, combo.outOfScope);
      const verdict = classifyPath(combo.probe, combo.inScope, combo.outOfScope);

      assert.equal(conflict, combo.expectConflict, `${label} 的 E_SCOPE_CONFLICT 判定不符：${label}`);
      assert.equal(verdict, combo.expectVerdict, `${label} 的 classifyPath 判定不符`);

      // 核心不变量：校验期说「冲突」的组合，运行期绝不能还能把路径认成 in_scope。
      if (conflict) {
        assert.notEqual(verdict, 'in_scope', `${label}: validatePlan 判冲突，classifyPath 却返回 in_scope —— 两个函数又各说各话了`);
      }
      // 反向：校验期放行的「挖洞」必须真的生效（否则 outOfScope 字段等于废掉）。
      if (!conflict && combo.expectVerdict === 'out_of_scope') {
        assert.equal(verdict, 'out_of_scope', `${label}: 校验期放行的挖洞在运行期必须生效`);
      }
    }
  });
});

/* =================================================================== */

describe('接口契约', () => {
  it('导出面符合契约：KINDS / validatePlan / normalizePath / classifyPath', () => {
    /* task-21：KINDS 四大类（implementation / review / work / proposal）。 */
    assert.deepEqual([...KINDS], ['implementation', 'review', 'work', 'proposal']);
    assert.equal(typeof validatePlan, 'function');
    assert.equal(typeof normalizePath, 'function');
    assert.equal(typeof classifyPath, 'function');
    assert.equal(validatePlan.length, 1); // (tasks, ctx = {}) → 必需参数只有一个
  });

  it('ctx 缺省 / 为 undefined 时不炸', () => {
    assert.deepEqual(validatePlan(validPlan(), undefined), { ok: true, errors: [] });
    assert.deepEqual(validatePlan(validPlan(), {}), { ok: true, errors: [] });
  });

  it('tasks 不是数组时失败但不抛异常', () => {
    const result = validatePlan(null);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });
});

/* =================================================================== */
/* 第三轮评审：C1–C4                                                    */
/* =================================================================== */

/**
 * 只在 M1 上做 acceptance↔verify 映射实验的三任务单：
 * M2 / M3 是 work（不设门禁），因此错误码只会来自 M1 的映射判定，断言可以精确到数组。
 */
function mappingPlan(acceptance, verify, overrides = {}) {
  const filler = (id, inScope) => task({
    id,
    kind: 'work',
    objective: undefined,
    acceptance: undefined,
    verify: undefined,
    inScope: [inScope],
    outOfScope: [],
  });
  return [
    task({ id: 'M1', acceptance, verify, ...overrides }),
    filler('M2', 'docs/a.md'),
    filler('M3', 'docs/b.md'),
  ];
}

const mappingCodes = (acceptance, verify, overrides) => codesOf(validatePlan(mappingPlan(acceptance, verify, overrides)));

/* ------------------------------------------------------------------- */

describe('C1 显式映射契约：[ACn] 标签 / 逐字包含，其余一律 E_ACCEPTANCE_UNVERIFIABLE', () => {
  it('C1 误判修复①（推荐写法 [ACn]）：登录成功 [AC1] + curl /login 返回 200 [AC1] → 通过', () => {
    assert.deepEqual(mappingCodes(['登录成功 [AC1]'], ['curl /login 返回 200 [AC1]']), []);
  });

  it('C1 误判修复②（推荐写法 逐字包含）：登录后跳转到首页：playwright test login.spec.ts → 通过', () => {
    assert.deepEqual(
      mappingCodes(['登录后跳转到首页：playwright test login.spec.ts'], ['playwright test login.spec.ts']),
      [],
    );
  });

  it('C1 原样输入（无标签且无逐字包含）→ 拒，且 message 两条修法都写清楚', () => {
    for (const [acceptance, verify] of [
      ['登录成功', 'curl /login 返回 200'],
      ['登录后跳转到首页', 'playwright test login.spec.ts'],
    ]) {
      const result = validatePlan(mappingPlan([acceptance], [verify]));
      assert.deepEqual(codesOf(result), ['E_ACCEPTANCE_UNVERIFIABLE'], `「${acceptance}」应为未声明映射：${JSON.stringify(codesOf(result))}`);
      const message = result.errors[0].message;
      assert.match(message, /\[AC1\]/, '必须教 [ACn] 写法');
      assert.match(message, /逐字/, '必须教逐字包含写法');
      assert.match(message, /验收项/, '必须点名哪条验收项');
    }
  });

  it('C1 [ACn] 标签通道与文案语言无关：中文验收 + 英文命令也能过', () => {
    assert.deepEqual(mappingCodes(['用户能看到仪表盘 [AC2]'], ['node --test dashboard.test.mjs [AC2]']), []);
  });

  it('C1 标签通道只认数字：[AC1] 不能靠 [AC2] 蒙过去；[ACx] 根本不是标签', () => {
    assert.deepEqual(
      mappingCodes(['登录成功 [AC1]'], ['node --test --test-name-pattern=AC2 x.mjs']),
      ['E_ACCEPTANCE_UNVERIFIABLE'],
    );
    assert.deepEqual(mappingCodes(['登录成功 [ACx]'], ['x.mjs [ACx]']), ['E_ACCEPTANCE_UNVERIFIABLE']);
  });

  it('C1 标签不能从单词里抠出来：MAC1 / TAC2 不算标签', () => {
    // 否则"验收里恰好出现 ac+数字"（MAC1、TAC2、HACK2…）又会变成一条猜的路。
    assert.deepEqual(mappingCodes(['安装 MAC1 证书'], ['./mac1.sh']), ['E_ACCEPTANCE_UNVERIFIABLE']);
    assert.deepEqual(mappingCodes(['TAC2 已处理'], ['node x.mjs TAC2']), ['E_ACCEPTANCE_UNVERIFIABLE']);
    // 真标签不受影响；且逐字包含通道照常工作
    assert.deepEqual(mappingCodes(['安装 MAC1 证书 [AC1]'], ['./mac1.sh [AC1]']), []);
    assert.deepEqual(mappingCodes(['安装 MAC1 证书：./mac1.sh'], ['./mac1.sh']), []);
  });

  it('C1 逐字包含的大小写 / 连续空白 / 尾部标点变体 → 通过', () => {
    const cases = [
      ['执行 Playwright Test login.spec.ts 全部通过。', 'playwright   test  login.spec.ts'],
      ['  跑 curl /login 返回 200  ', '  CURL /LOGIN 返回 200.  '],
    ];
    for (const [acceptance, verify] of cases) {
      assert.deepEqual(mappingCodes([acceptance], [verify]), [], `「${acceptance}」应命中「${verify}」`);
    }
  });

  it('C1 逐字包含必须是完整包含：acceptance 写 curl /login、verify 写 curl /login 返回 200 → 拒', () => {
    assert.deepEqual(mappingCodes(['curl /login'], ['curl /login 返回 200']), ['E_ACCEPTANCE_UNVERIFIABLE']);
  });

  it('C1 只提命令名不算映射：acceptance 写「按 npm run lint 通过」而 verify 更长 → 拒', () => {
    assert.deepEqual(
      mappingCodes(['按 npm run lint 通过'], ['npm run lint -- --max-warnings 0']),
      ['E_ACCEPTANCE_UNVERIFIABLE'],
    );
  });

  it('C1 多个 verify 项时任一命中即可（不含蒙对：另一项不影响判定）', () => {
    assert.deepEqual(
      mappingCodes(['登录成功 [AC2]'], ['curl /login 返回 200', 'playwright test login.spec.ts [AC2]']),
      [],
    );
  });

  it('C1 判定是确定性的：同一条 acceptance 只认逐字包含它的那条 verify', () => {
    const hit = mappingCodes(['冒烟：curl /login 返回 200'], ['curl /login 返回 200', 'npm run lint']);
    assert.deepEqual(hit, []);
    const miss = mappingCodes(['冒烟：curl /login 返回 201'], ['curl /login 返回 200', 'npm run lint']);
    assert.deepEqual(miss, ['E_ACCEPTANCE_UNVERIFIABLE']);
  });
});

/* ------------------------------------------------------------------- */

describe('C2 contractOf 语义修订（{} = 未声明）与 E_CONTRACT_AMBIGUOUS', () => {
  /** 不设门禁的填充任务，用来把任务数顶过 E_TEAM_NOT_JUSTIFIED 的阈值。 */
  const workTask = (id) => task({
    id,
    kind: 'work',
    objective: undefined,
    acceptance: undefined,
    verify: undefined,
    inScope: [`docs/${id}.md`],
    outOfScope: [],
  });

  it('C2 决策表：只有"非空普通对象"的 contract 才算已声明，其余一律回退 task 本身', () => {
    const declared = { inScope: ['c/'] };
    const withContract = { id: 'T', inScope: ['top/'], contract: declared };
    assert.equal(contractOf(withContract), declared, '非空普通对象 → 返回它（同一引用，不合并）');

    // 未声明形态：缺失 / {} / null / [] / 非对象
    for (const bad of [undefined, null, {}, [], 'x', 42, true]) {
      const planTask = { id: 'T', inScope: ['top/'], ...(bad === undefined ? {} : { contract: bad }) };
      assert.equal(
        contractOf(planTask),
        planTask,
        `contract=${JSON.stringify(bad)} 必须视为未声明并回退 task 本身`,
      );
    }

    // 非任务对象 → {}
    for (const value of [null, undefined, [], 0, 42, 'T1', true, () => {}]) {
      assert.deepEqual(contractOf(value), {}, `contractOf(${String(value)}) 必须是 {}`);
    }
  });

  it('C2 contract:{} + 顶层齐备 → 回退顶层后全绿（不再谎报字段缺失）', () => {
    const planTask = {
      id: 'A1',
      kind: 'implementation',
      objective: 'o',
      acceptance: ['npm test 通过'],
      verify: ['npm test'],
      inScope: ['src/'],
      outOfScope: [],
      contract: {},
    };
    assert.deepEqual(codesOf(validatePlan([planTask, workTask('A2'), workTask('A3')])), []);
    assert.deepEqual(contractAmbiguity(planTask), [], '未声明不算歧义');
  });

  it('C2 contract 与顶层同值 → 不是歧义（contractAmbiguity 返回 []，不报 E_CONTRACT_AMBIGUOUS）', () => {
    const shared = { objective: 'o', acceptance: ['npm test 通过'], verify: ['npm test'], inScope: ['src/'], outOfScope: [] };
    const planTask = { id: 'A1', kind: 'implementation', ...shared, contract: { ...shared } };
    assert.deepEqual(contractAmbiguity(planTask), []);
    assert.ok(!hasCode(validatePlan([planTask, workTask('A2'), workTask('A3')]), 'E_CONTRACT_AMBIGUOUS'));
  });

  it('C2 contract 与顶层异值 → E_CONTRACT_AMBIGUOUS，点名字段，并且只用 contract 那份', () => {
    const planTask = {
      id: 'A1',
      kind: 'implementation',
      // 顶层是另一份声明（异值），必须被点出来
      objective: '顶层 objective',
      acceptance: ['顶层验收'],
      verify: ['顶层命令'],
      contract: {
        objective: '顶层 objective', // 与顶层同值 → 不该被点名
        acceptance: ['npm test 通过'],
        verify: ['npm test'],
        inScope: ['src/'],
        outOfScope: [],
      },
    };

    assert.deepEqual(contractAmbiguity(planTask), ['acceptance', 'verify'], '排序去重后的字段名');

    const result = validatePlan([planTask, workTask('A2'), workTask('A3')]);
    const error = result.errors.find((item) => item.code === 'E_CONTRACT_AMBIGUOUS');
    assert.ok(error, `实际错误码 ${JSON.stringify(codesOf(result))}`);
    assert.equal(error.taskId, 'A1');
    assert.match(error.message, /acceptance/);
    assert.match(error.message, /verify/);
    assert.match(error.message, /只保留 contract/);
    assert.ok(!/objective/.test(error.message), '同值字段不该被点名');
    // 取值只用 contract：contract 里的 acceptance/verify 合法 → 不再报映射错误
    assert.ok(!hasCode(result, 'E_ACCEPTANCE_UNVERIFIABLE'));
    assert.ok(!hasCode(result, 'E_SCOPE_VERIFY_REQUIRED'));
    assert.equal(countCode(result, 'E_CONTRACT_AMBIGUOUS'), 1, '同一任务只报一次');
  });

  it('C2 歧义只看契约字段：id / kind / subject 两处不同不算歧义', () => {
    const planTask = { id: 'A1', kind: 'implementation', subject: '顶层标题', contract: { subject: '契约标题' } };
    assert.deepEqual(contractAmbiguity(planTask), []);
    // 同名契约字段才算
    assert.deepEqual(contractAmbiguity({ id: 'A', inScope: ['a/'], contract: { inScope: ['b/'] } }), ['inScope']);
  });

  it('C2 contractAmbiguity 永不抛错（怪形态 + 循环引用 + 深结构）', () => {
    for (const value of [null, undefined, 42, 'x', [], {}, { contract: null }, { contract: {} }, { contract: 'x' }]) {
      assert.deepEqual(contractAmbiguity(value), []);
    }

    const loop = ['a'];
    loop.push(loop);
    const cyclic = { id: 'T', acceptance: ['a'], contract: { acceptance: loop } };
    assert.doesNotThrow(() => contractAmbiguity(cyclic));
    assert.deepEqual(contractAmbiguity(cyclic), ['acceptance']);

    // 嵌套深结构只需要"不相同"这个结论，不需要正确序列化
    const deep = (n) => (n === 0 ? 'leaf' : { next: deep(n - 1) });
    assert.deepEqual(contractAmbiguity({ id: 'T', acceptance: deep(3), contract: { acceptance: deep(4) } }), ['acceptance']);
  });
});

/* ------------------------------------------------------------------- */

describe('C3 E_TEAM_NOT_JUSTIFIED 的路径计数：src/ 与 src 是两条声明', () => {
  /** 单任务单（任务数 = 1），让 E_TEAM_NOT_JUSTIFIED 只看路径计数这一维。 */
  const teamCodes = (inScope) => codesOf(validatePlan([task({ id: 'S1', inScope, outOfScope: [] })]));
  const teamReported = (inScope) => teamCodes(inScope).includes('E_TEAM_NOT_JUSTIFIED');

  it('C3 src/ 与 src 算两条不同声明：4 条声明 → 不报（旧实现按 path 计数只有 2 条，会误报）', () => {
    const inScope = ['src/', 'src', 'docs/', 'docs'];
    assert.equal(new Set(toEntryList(inScope).map((entry) => entry.path)).size, 2, '前提：去尾斜杠后只有 2 个 path');
    assert.equal(toEntryList(inScope).length, 4, '前提：实际是 4 条声明');
    assert.equal(teamReported(inScope), false, `实际 ${JSON.stringify(teamCodes(inScope))}`);
  });

  it('C3 三条声明（src/、src、src/a.mjs）→ 不报（旧实现算 2 条，会误报）', () => {
    assert.equal(teamReported(['src/', 'src', 'src/a.mjs']), false);
  });

  it('C3 计数不到 3 条时仍然报：src/ + src 只有 2 条（没有借新口径放松尺度）', () => {
    assert.equal(teamReported(['src/', 'src']), true);
    assert.equal(teamReported(['src/']), true);
  });

  it('C3 去重仍按声明去重：重复写 src/ 两次只算 1 条', () => {
    assert.equal(teamReported(['src/', 'src/', 'src/', 'src/a.mjs']), true);
  });

  it('C3 目录与目录内的文件是两条：src/ + src/a.mjs → 2 条仍报', () => {
    assert.equal(teamReported(['src/', 'src/a.mjs']), true);
  });
});

/* ------------------------------------------------------------------- */

describe('C4 toEntryListStrict：非法条目不再静默消失', () => {
  const illegalCases = [
    ['../etc/passwd', 'traversal'],
    ['a/../b', 'traversal'],
    ['/abs', 'absolute'],
    ['C:\\Windows\\System32', 'absolute'],
    ['//server/share', 'absolute'],
    ['~/x', 'home'],
    ['src/a\u0000.ts', 'control-char'],
    ['src/%2e%2e/etc', 'encoded-traversal'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['.', 'empty'],
    [42, 'not-string'],
    [null, 'not-string'],
    ['src/a.ts:stream', 'colon'],
  ];

  it('C4 七类非法输入各带一条原因（另加 colon），且 entries 为空', () => {
    const seenReasons = new Set();
    for (const [raw, reason] of illegalCases) {
      const { entries, illegal } = toEntryListStrict([raw]);
      assert.deepEqual(entries, [], `${JSON.stringify(raw)} 不该产出条目`);
      assert.equal(illegal.length, 1, `${JSON.stringify(raw)} 必须报一条非法`);
      assert.equal(illegal[0].reason, reason, `${JSON.stringify(raw)} 原因应为 ${reason}`);
      assert.equal(illegal[0].raw, raw, '非法条目要带回原始值');
      seenReasons.add(illegal[0].reason);
    }
    for (const reason of ['traversal', 'absolute', 'home', 'control-char', 'encoded-traversal', 'empty', 'not-string']) {
      assert.ok(seenReasons.has(reason), `必须覆盖 ${reason}`);
    }
  });

  it('C4 合法条目零丢失：entries 与 toEntryList 完全同形（含已解析对象条目与反斜杠写法）', () => {
    const value = [
      'src/',
      'src',
      'src/a.mjs',
      { path: 'docs/', isDir: true },
      { path: 'docs/b.md', raw: 'docs/b.md' },
      'plugin\\src\\x.mjs',
    ];
    const strict = toEntryListStrict(value);
    assert.deepEqual(strict.illegal, []);
    assert.deepEqual(strict.entries, toEntryList(value));
    assert.equal(strict.entries.length, 6);
    assert.deepEqual(strict.entries.map((entry) => entry.key), ['src/', 'src', 'src/a.mjs', 'docs/', 'docs/b.md', 'plugin/src/x.mjs']);
  });

  it('C4 评审的原始样例：1 条合法留下，6 条非法全部可见', () => {
    const raw = ['src/', '../etc/passwd', '/abs', '~/x', '', 42, null];
    const { entries, illegal } = toEntryListStrict(raw);
    assert.equal(entries.length, 1, '旧行为：这里静默返回 1 条、丢 6 条且不给任何信号');
    assert.equal(illegal.length, 6);
    assert.deepEqual(illegal.map((item) => item.reason), [
      'traversal', 'absolute', 'home', 'empty', 'not-string', 'not-string',
    ]);
    // toEntryList 的返回形状与行为不变（三个模块都在用）
    assert.deepEqual(toEntryList(raw).map((entry) => entry.key), ['src/']);
  });

  it('C4 永不抛错：整值缺席 / 整值空串 = 没声明（不报非法），单字符串照常', () => {
    assert.deepEqual(toEntryListStrict('src/').entries.map((entry) => entry.key), ['src/']);
    // 字段根本没写 → 未声明（与 toEntryList(undefined) → [] 同口径），不能变成"声明非法"
    assert.deepEqual(toEntryListStrict(undefined), { entries: [], illegal: [] });
    assert.deepEqual(toEntryListStrict(null), { entries: [], illegal: [] });
    assert.deepEqual(toEntryListStrict(''), { entries: [], illegal: [] });
    assert.deepEqual(toEntryListStrict('   '), { entries: [], illegal: [] });
    assert.deepEqual(toEntryListStrict([]), { entries: [], illegal: [] });
    // 但数组里出现 undefined / null / 空串就是被丢弃的条目，必须报
    assert.deepEqual(toEntryListStrict([undefined]).illegal, [{ raw: undefined, reason: 'not-string' }]);
    assert.deepEqual(toEntryListStrict([null]).illegal, [{ raw: null, reason: 'not-string' }]);
    assert.deepEqual(toEntryListStrict(['']).illegal, [{ raw: '', reason: 'empty' }]);
  });

  it('C4 validatePlan 的 E_PATH_UNSAFE 带上 reason，指出该往哪修', () => {
    const result = validatePlan([task({ inScope: ['../etc/passwd', '/abs'], outOfScope: [] })]);
    const messages = result.errors.filter((error) => error.code === 'E_PATH_UNSAFE').map((error) => error.message);
    assert.equal(messages.length, 2, `实际 ${JSON.stringify(codesOf(result))}`);
    assert.match(messages[0], /原因：traversal/);
    assert.match(messages[1], /原因：absolute/);
    assert.match(messages[0], /inScope\[0\]/);
  });

  it('C4 非法声明不再退化成 undeclared：校验期就指认"声明本身非法"', () => {
    assert.equal(classifyPath('etc/passwd', ['../etc/passwd'], []), 'undeclared', '运行期该路径确实 undeclared');
    const result = validatePlan([task({ inScope: ['../etc/passwd'], outOfScope: [] })]);
    assert.ok(hasCode(result, 'E_PATH_UNSAFE'), '校验期必须明确指出声明本身非法，而不是留给运行期报越界');
  });

  it('C4 已解析对象条目在校验期同样合法（与 toEntryList 口径一致）', () => {
    const result = validatePlan([task({ inScope: [{ path: 'src/', isDir: true }], outOfScope: [] })]);
    assert.ok(!hasCode(result, 'E_PATH_UNSAFE'), `对象条目应按 toEntryList 口径解析：${JSON.stringify(codesOf(result))}`);
  });
});

/* =================================================================== */
/* 第 4 轮 W1：跨模块口径收口                                           */
/* =================================================================== */

/** 源码文本（闭合性测试用：枚举与实现必须彼此对应，不能只靠夹具偶然对上）。 */
const CONTRACT_SOURCE = readFileSync(new URL('../src/contract.mjs', import.meta.url), 'utf8');

describe('W1-1 PATH_ILLEGAL_REASONS + describePathIllegal（冻结导出）', () => {
  it('W1-1 枚举内容与顺序冻结：8 个原因，顺序即诊断拒绝的优先级', () => {
    assert.deepEqual([...PATH_ILLEGAL_REASONS], [
      'not-string',
      'empty',
      'home',
      'control-char',
      'encoded-traversal',
      'absolute',
      'traversal',
      'colon',
    ]);
    assert.ok(Object.isFrozen(PATH_ILLEGAL_REASONS), '枚举必须冻结：delivery 按它映射文案，不能被谁 push 一个新值');
    assert.throws(() => { PATH_ILLEGAL_REASONS.push('whatever'); }, TypeError);
    assert.throws(() => { PATH_ILLEGAL_REASONS[0] = 'changed'; }, TypeError);
    assert.equal(PATH_ILLEGAL_REASONS.length, 8);
  });

  it('W1-1 describePathIllegal 对每个 reason 都有人话输出，互不相同，且不回显枚举 token', () => {
    const texts = new Set();
    for (const reason of PATH_ILLEGAL_REASONS) {
      const text = describePathIllegal(reason);
      assert.equal(typeof text, 'string');
      assert.ok(text.length >= 6, `${reason} 的人话太短：${text}`);
      assert.notEqual(text, reason, `${reason} 不得把枚举 token 原样返回`);
      // 关键：不能走到兜底分支——枚举项漏登记人话时，兜底串里也有中文，只查中文会放过
      assert.ok(!/未知的非法原因/.test(text), `${reason} 没有登记人话，走的是兜底分支：${text}`);
      assert.match(text, /[\u4e00-\u9fff]/, `${reason} 的输出必须是中文人话：${text}`);
      assert.ok(!/undefined|\[object Object\]/.test(text), `${reason} 的输出出现了裸值：${text}`);
      texts.add(text);
    }
    assert.equal(texts.size, PATH_ILLEGAL_REASONS.length, '每个 reason 的人话必须互不相同（否则等于没解释）');
  });

  it('W1-1 describePathIllegal 永不抛错：未知 reason / 怪类型 / 对象形态', () => {
    for (const value of [undefined, null, 42, '', 'unknown-token', {}, [], true]) {
      const text = describePathIllegal(value);
      assert.equal(typeof text, 'string');
      assert.match(text, /未知的非法原因/);
      assert.ok(!/undefined|\[object Object\]/.test(text), `兜底文本必须干净：${text}`);
    }
    assert.match(describePathIllegal('unknown-token'), /"unknown-token"/, '未知 token 要原样带出来，便于排查');
    assert.match(describePathIllegal(undefined), /未提供/);
    // 容错：调用方直接把 illegal[0]（{raw, reason}）丢进来也能拿到人话
    assert.equal(describePathIllegal({ reason: 'colon', raw: 'a.ts:stream' }), describePathIllegal('colon'));
    assert.match(describePathIllegal({ raw: 'x' }), /未知的非法原因/);
  });

  it('W1-1 枚举与实现闭合（源码级）：没有枚举外的 reason，也没有死枚举项', () => {
    const literals = [...CONTRACT_SOURCE.matchAll(/reason: '([a-z-]+)'/g)].map((match) => match[1]);
    assert.ok(literals.length >= PATH_ILLEGAL_REASONS.length, `源码里应能扫到 reason 字面量，实际 ${literals.length}`);
    const produced = new Set(literals);
    for (const token of produced) {
      assert.ok(
        PATH_ILLEGAL_REASONS.includes(token),
        `源码产出了枚举外的 reason "${token}"：必须同步 PATH_ILLEGAL_REASONS`,
      );
    }
    for (const reason of PATH_ILLEGAL_REASONS) {
      assert.ok(produced.has(reason), `枚举项 "${reason}" 在实现里无处产出（死项）`);
    }
    assert.equal(produced.size, PATH_ILLEGAL_REASONS.length, '枚举与实现必须一一对应');
  });

  it('W1-1 枚举与实现闭合（运行期）：八类非法输入各产出一个枚举内的 reason', () => {
    const fixtures = [
      [42, 'not-string'],
      ['', 'empty'],
      ['~/x', 'home'],
      ['src/a\u0000.ts', 'control-char'],
      ['src/%2e%2e/x', 'encoded-traversal'],
      ['/abs', 'absolute'],
      ['../etc/passwd', 'traversal'],
      ['src/a.ts:stream', 'colon'],
    ];
    const seen = new Set();
    for (const [raw, expected] of fixtures) {
      const { entries, illegal } = toEntryListStrict([raw]);
      assert.deepEqual(entries, []);
      assert.equal(illegal.length, 1, `${JSON.stringify(raw)} 必须报一条非法`);
      assert.equal(illegal[0].reason, expected);
      assert.ok(
        PATH_ILLEGAL_REASONS.includes(illegal[0].reason),
        `运行期产出了枚举外的 reason "${illegal[0].reason}"`,
      );
      seen.add(illegal[0].reason);
    }
    assert.equal(seen.size, PATH_ILLEGAL_REASONS.length, '八类夹具必须覆盖全部枚举项');
  });

  it('W1-1 delivery 的接入方式可用：token → 人话，且 E_PATH_UNSAFE 里给的是 token', () => {
    const result = validatePlan([task({ inScope: ['../etc/passwd'], outOfScope: [] })]);
    const error = result.errors.find((item) => item.code === 'E_PATH_UNSAFE');
    assert.match(error.message, /原因：traversal/, 'message 里必须是枚举 token（机读）');

    // 推荐拼装：toEntryListStrict 拿 token，describePathIllegal 出人话
    const { illegal } = toEntryListStrict(['../etc/passwd']);
    const human = describePathIllegal(illegal[0].reason);
    assert.match(human, /穿越/, 'traversal 的人话必须说清是穿越');
    assert.ok(!human.includes('traversal'), '人话里不该再出现枚举 token');
  });
});

describe('W1-2 CONTRACT_FIELDS 冻结导出（E_CONTRACT_AMBIGUOUS 的唯一覆盖面）', () => {
  it('W1-2 内容与顺序冻结：10 个契约字段，运行时不可改', () => {
    /* task-21（开会与方案流程）：新增 `openQuestions` / `answered` —— 6 → 8。
     *
     * **这条断言红过，而且红得对。** 它的作用就是"往契约里加字段必须是有意识的行为"：
     * 我第一步把 `proposal` 加进 KINDS 时它当场报错，逼我把"这算不算契约条款"想清楚。
     * 结论：算。它们和 `changed` 不同 —— `changed` 是**干完之后**的报告（不进 contract），
     * 这两条是**动手之前**立的条款（提案承诺要问这些，决议承诺回答这些）。
     *
     * task-22（用户原话「嗯，开会是必须的。」）：再新增 `proposalId` / `skipMeeting` —— 8 → 10。
     * 这一次它同样逼我想清楚了同一件事，结论也一样：算，而且是**动手之前**的条款。
     *    - `proposalId` 是这条任务在开工前指认"我的方案来自哪次商量"（指针，不是报告）；
     *    - `skipMeeting` 是**先斩后奏的反面**：要说跳过，理由必须在动手前就写在契约里。
     * 两条都不进 `DECLARATION_REPORT_FIELDS`（那里是 changed/notes 这类干完才知道的账）。
     *
     * 顺序有意义（歧义检测按这个顺序遍历），所以这里锁的是**逐字顺序**，不是集合。 */
    assert.deepEqual([...CONTRACT_FIELDS], [
      'acceptance',
      'verify',
      'inScope',
      'outOfScope',
      'reviewedTaskId',
      'objective',
      'openQuestions',
      'answered',
      'proposalId',
      'skipMeeting',
    ]);
    assert.ok(Object.isFrozen(CONTRACT_FIELDS), '必须冻结：否则歧义覆盖面会被运行时改动');
    assert.throws(() => { CONTRACT_FIELDS.push('newField'); }, TypeError);
    assert.throws(() => { CONTRACT_FIELDS[0] = 'changed'; }, TypeError);
  });

  it('W1-2 清单即真相：每个登记字段两处异值都被点名，同值不点名', () => {
    for (const field of CONTRACT_FIELDS) {
      const ambiguous = { id: 'T', kind: 'implementation', [field]: 'top-level', contract: { [field]: 'contract-level' } };
      assert.deepEqual(contractAmbiguity(ambiguous), [field], `字段 ${field} 异值必须被点名`);

      const same = { id: 'T', kind: 'implementation', [field]: 'same', contract: { [field]: 'same' } };
      assert.deepEqual(contractAmbiguity(same), [], `字段 ${field} 同值不该点名`);
    }
  });

  it('W1-2 非契约字段两处不同不点名（id / kind / subject / assignee / status / attempt）', () => {
    const taskLevel = { id: 'top', kind: 'review', subject: 'top', assignee: 'top', status: 'top', attempt: 2 };
    const contract = { id: 'c', kind: 'work', subject: 'c', assignee: 'c', status: 'c', attempt: 1 };
    assert.deepEqual(contractAmbiguity({ ...taskLevel, contract }), []);
  });

  it('W1-2 防静默漏检：validatePlan 读的每个 contract.X 都登记在 CONTRACT_FIELDS 里', () => {
    // 负向断言 (?!) 排除文件名：注释里的 `./contract.mjs` 不是成员访问，
    // 否则 mjs 会被当成一个契约字段（第 7 轮踩过：加一行 doc 注释就把这条测试打红）。
    const read = new Set([...CONTRACT_SOURCE.matchAll(/contract\.(?!m?js\b|test\b)([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
    /* task-21 改动了这里的第一条断言。
     *
     * 原来写的是 `read.size >= CONTRACT_FIELDS.length`，它隐含一个假设：
     * **每个契约字段都在本文件里被读**。加进 `openQuestions` / `answered` 之后那个假设失效了 ——
     * 这两个字段是给 `delivery.mjs` 读的（提案要问什么、决议答了什么，都是交付层的判据），
     * 本文件不该为了喂饱一条覆盖率断言而去读它们。硬凑一个读取点才是真的错。
     *
     * 所以这里保留"扫描必须真的扫到东西"（防这条测试退化成空转），
     * 而**真正的守门员是下面的逐字段包含检查**：读到任何没登记的字段就红。
     * 那个方向才是防"静默漏检"的方向，与字段总数无关。 */
    assert.ok(read.size > 0, '扫描必须真的扫到至少一个 contract.X 读取，否则这条测试是空转的');
    for (const field of read) {
      assert.ok(
        CONTRACT_FIELDS.includes(field),
        `validatePlan 读了契约字段 "${field}"，但 CONTRACT_FIELDS 没登记：该字段两处异值会被静默漏检`,
      );
    }
  });
});

describe('W1-3 colon 保留：不谎报成 traversal / absolute', () => {
  it('W1-3 NTFS 数据流写法归 colon，且在冻结枚举内有人话', () => {
    for (const raw of ['src/a.ts:stream', 'docs/x.txt:hidden', 'plugin/src/a:b']) {
      const { entries, illegal } = toEntryListStrict([raw]);
      assert.deepEqual(entries, []);
      assert.equal(illegal[0].reason, 'colon', `${raw} 应归 colon`);
      assert.ok(PATH_ILLEGAL_REASONS.includes('colon'));
      assert.notEqual(illegal[0].reason, 'traversal', '不能为省事谎报成穿越');
      assert.notEqual(illegal[0].reason, 'absolute', '不能为省事谎报成绝对路径');
    }
    assert.match(describePathIllegal('colon'), /冒号/);
    assert.match(describePathIllegal('colon'), /NTFS/);
  });

  it('W1-3 盘符写法仍归 absolute（colon 不能把盘符抢走，判定顺序不能乱）', () => {
    // `C:x` / `C:/x` 先命中 WINDOWS_DRIVE → absolute；只有段内冒号才落到 colon。
    for (const raw of ['C:x', 'C:/x', 'a:b/c.txt']) {
      const { illegal } = toEntryListStrict([raw]);
      assert.equal(illegal[0].reason, 'absolute', `${raw} 应归 absolute`);
    }
  });
});

describe('W1-追加：toEntryListStrict 必须区分"未声明"与"脏输入"', () => {
  it('W1-追加 整值缺席 = 没有声明：6 组都返回空 entries 且空 illegal', () => {
    // 语义分工：整值没写 → 未声明（上游该报 E_SCOPE_UNDECLARED / 缺声明），
    // 不能在这里变成"写了一个非法路径"（那会让上游报 E_PATH_UNSAFE，指错修法）。
    const cases = [
      ['undefined', () => toEntryListStrict(undefined)],
      ['null', () => toEntryListStrict(null)],
      ["''", () => toEntryListStrict('')],
      ["'   '", () => toEntryListStrict('   ')],
      ['[]', () => toEntryListStrict([])],
      ['不传参', () => toEntryListStrict()],
    ];
    for (const [label, run] of cases) {
      assert.deepEqual(run(), { entries: [], illegal: [] }, `整值 ${label} 必须视为未声明`);
    }
  });

  it('W1-追加 数组内的脏元素 = 真的写了脏东西：4 组各一条 illegal', () => {
    const cases = [
      [[undefined], 'not-string'],
      [[null], 'not-string'],
      [[''], 'empty'],
      [[42], 'not-string'],
    ];
    for (const [value, reason] of cases) {
      const { entries, illegal } = toEntryListStrict(value);
      assert.deepEqual(entries, []);
      assert.equal(illegal.length, 1, `${JSON.stringify(value)} 必须报一条非法`);
      assert.equal(illegal[0].reason, reason);
      assert.equal(illegal[0].raw, value[0], '必须带回原始脏值');
      assert.ok(PATH_ILLEGAL_REASONS.includes(reason), `${reason} 必须在冻结枚举内`);
    }
  });

  it('W1-追加 混在合法条目里的脏元素不会吞掉合法条目', () => {
    const { entries, illegal } = toEntryListStrict(['src/', undefined, 'src/a.mjs', null]);
    assert.deepEqual(entries.map((entry) => entry.key), ['src/', 'src/a.mjs']);
    assert.deepEqual(illegal.map((item) => item.reason), ['not-string', 'not-string']);
  });

  it('W1-追加 两个结论在 validatePlan 上可观测：整值缺席不报 E_PATH_UNSAFE，脏元素才报', () => {
    const absent = validatePlan([task({ id: 'P1', inScope: undefined, outOfScope: undefined })]);
    assert.ok(!hasCode(absent, 'E_PATH_UNSAFE'), `整值缺席不该报 E_PATH_UNSAFE：${JSON.stringify(codesOf(absent))}`);

    const dirty = validatePlan([task({ id: 'P2', inScope: ['src/', undefined], outOfScope: [] })]);
    assert.equal(countCode(dirty, 'E_PATH_UNSAFE'), 1, `数组内脏元素必须报：${JSON.stringify(codesOf(dirty))}`);
  });
});

/* =================================================================== */
/* 第 5 轮 W1：D-5 收紧逐字包含通道 / D-6 多验收共享标签（有意合法）      */
/* =================================================================== */

/**
 * 只要该验收被判"不可验证"就算命中。
 * 用 countCode 而不是整数组断言：verify 为空时还会另报 E_SCOPE_VERIFY_REQUIRED，
 * 判定表只关心映射这一维。
 */
const mappingRejected = (acceptance, verify) =>
  countCode(validatePlan(mappingPlan(acceptance, verify)), 'E_ACCEPTANCE_UNVERIFIABLE') > 0;

describe('W1-A D-5：逐字包含通道要求 verify 项「像一条命令」', () => {
  it('W1-A 1) verify=["a"] + acceptance=["abc"] → 拒（否则一个字符就能"证明"任何包含它的验收）', () => {
    assert.deepEqual(mappingCodes(['abc'], ['a']), ['E_ACCEPTANCE_UNVERIFIABLE']);
  });

  it('W1-A 2) verify=["测试"] + acceptance=["测试通过"] → 拒（两个中文字也是长度不足 + 无命令特征）', () => {
    assert.deepEqual(mappingCodes(['测试通过'], ['测试']), ['E_ACCEPTANCE_UNVERIFIABLE']);
  });

  it('W1-A 3) verify=["npm"] + acceptance=["npm 装完了"] → 拒（裸词，无命令特征字符）', () => {
    assert.deepEqual(mappingCodes(['npm 装完了'], ['npm']), ['E_ACCEPTANCE_UNVERIFIABLE']);
  });

  it('W1-A 4) verify=["npm test"] + acceptance=["npm test 全绿"] → 通过（有空白）', () => {
    assert.deepEqual(mappingCodes(['npm test 全绿'], ['npm test']), []);
  });

  it('W1-A 5) verify=["a.sh"] + acceptance=["跑 a.sh"] → 通过（有 .）', () => {
    assert.deepEqual(mappingCodes(['跑 a.sh'], ['a.sh']), []);
  });

  it('W1-A 6) verify=["./run"] + acceptance=["./run 成功"] → 通过（有 / 与 .）', () => {
    assert.deepEqual(mappingCodes(['./run 成功'], ['./run']), []);
  });

  it('W1-A 7) verify=["node --test x.mjs"] + acceptance=["node --test x.mjs 通过"] → 通过（空白与 --）', () => {
    assert.deepEqual(mappingCodes(['node --test x.mjs 通过'], ['node --test x.mjs']), []);
  });

  it('W1-A 8) 拒绝文案：verify 全部偏弱时点出"不像命令"、点名该 verify 项、并教 [ACn] 写法', () => {
    const result = validatePlan(mappingPlan(['abc'], ['a']));
    const error = result.errors.find((item) => item.code === 'E_ACCEPTANCE_UNVERIFIABLE');
    assert.ok(error, `实际 ${JSON.stringify(codesOf(result))}`);
    assert.match(error.message, /\[AC/, '必须教 [ACn] 写法');
    assert.match(error.message, /不像命令/, '必须指出问题出在 verify 侧');
    assert.match(error.message, /「a」/, '必须点名那条 verify 项');
    assert.match(error.message, /make/, '必须说明 make 这类单词命令也会被拒');
  });

  it('W1-A 8b) 混合场景不许冤枉合法 verify 项：verify=["npm test","a"] → 通用文案', () => {
    const result = validatePlan(mappingPlan(['完全无关的验收'], ['npm test', 'a']));
    const error = result.errors.find((item) => item.code === 'E_ACCEPTANCE_UNVERIFIABLE');
    assert.ok(error);
    assert.match(error.message, /修法二选一/, '组里存在合法 verify 项时给通用修法');
    assert.ok(!/不像命令/.test(error.message), '不能把"不像命令"扣到整组 verify 头上');
  });

  it('W1-A 判定表（数据驱动）：把长度 / 命令特征 / 空白 / 空串的边界一次锁死', () => {
    const table = [
      ['a', 'abc', false, '长度不足（1），且无命令特征'],
      ['ab', 'abc', false, '长度不足（2），且无命令特征（双重不合格）'],
      // 下面两行专门区分"长度门槛 ≥3"与"≥2"。注意不能用 'a.'：尾部 . 会被归一化的
      // "去尾部标点"剥掉变成 'a'，那样测的就不是长度门槛了（变异测试抓过这个坑）。
      ['/a', '跑 /a 完成', false, '长度 2：即使含命令特征字符（/）也必须拒（长度门槛 ≥3）'],
      ['a.', '跑 a. 完成', false, '尾部标点会被归一化剥掉 → 剩 a，双重不合格'],
      ['a.b', '跑 a.b', true, '长度恰好 3 且含 .'],
      ['测试', '测试通过', false, '长度不足且无命令特征'],
      ['npm', 'npm 装完了', false, '裸词'],
      ['npm test', 'npm test 全绿', true, '有空白'],
      ['./run', './run 成功', true, '有 / 与 .'],
      ['make', 'make 装好了', false, '单词命令被有意拒（请写 make test 或改用 [ACn]）'],
      ['make test', 'make test 通过', true, '单字命令 + 参数即可'],
      ['   ', '任意验收', false, '纯空白 verify 不算命令'],
      ['', '任意验收', false, '空字符串 verify 不算命令'],
    ];
    for (const [verify, acceptance, shouldPass, note] of table) {
      assert.equal(
        !mappingRejected([acceptance], [verify]),
        shouldPass,
        `verify=${JSON.stringify(verify)} / acceptance=${JSON.stringify(acceptance)} 应为${shouldPass ? '通过' : '拒'}（${note}）`,
      );
    }
  });

  it('W1-A 边界）标签通道不受 D-5 约束：显式声明不需要"像命令"', () => {
    // D-5 只约束"靠子串猜"的那条通道；[ACn] 是作者显式写下的身份。
    assert.deepEqual(mappingCodes(['某验收 [AC1]'], ['测试 [AC1]']), []);
    assert.deepEqual(mappingCodes(['某验收 [AC7]'], ['a [AC7]']), []);
    // 关键判别用例：verify 项去掉标签后完全不合格（无空白/无命令特征），
    // 但只要标签对上就必须通过 —— 否则等于把 D-5 偷偷绑到标签通道上。
    assert.deepEqual(mappingCodes(['某验收 [AC1]'], ['a[AC1]']), []);
  });
});

describe('W1-B D-6：多验收共享一个 [ACn] 标签是合法行为（不要顺手收紧）', () => {
  it('W1-B 1) 3 条验收同标 [AC1] + verify 只有 1 条带 [AC1] → 通过', () => {
    const codes = mappingCodes(
      ['登录成功 [AC1]', '登出成功 [AC1]', '会话不泄漏 [AC1]'],
      ['npm test [AC1]'],
    );
    assert.deepEqual(codes, [], `一条命令证明多条验收是正当的：${JSON.stringify(codes)}`);
  });

  it('W1-B 2) 同上但那条 verify 不带标签 → 拒（要求"至少一个 verify 项带该标签"，不是任意）', () => {
    const result = validatePlan(mappingPlan(
      ['登录成功 [AC1]', '登出成功 [AC1]', '会话不泄漏 [AC1]'],
      ['npm test'],
    ));
    assert.equal(countCode(result, 'E_ACCEPTANCE_UNVERIFIABLE'), 3, `三条都必须报：${JSON.stringify(codesOf(result))}`);
  });

  it('W1-B 3) 共享标签不等于"有标签就过"：标签必须是同一个数字（[AC1] 不能靠 [AC2]）', () => {
    const result = validatePlan(mappingPlan(
      ['登录成功 [AC1]', '登出成功 [AC1]'],
      ['npm test [AC2]'],
    ));
    assert.equal(countCode(result, 'E_ACCEPTANCE_UNVERIFIABLE'), 2, 'D-6 放开的是"共享"，不是"标签随便对"');
  });
});

/* =================================================================== */
/* 第 7 轮 W1-A（A-3）：源码闭合测试必须覆盖全部兄弟模块                  */
/* =================================================================== */

/**
 * `plugin/src/` 下的全部 ESM 源文件（不只 contract.mjs）。
 *
 * **第 7 轮的根因就在这行**：上一版只有
 *   `const CONTRACT_SOURCE = readFileSync(new URL('../src/contract.mjs', import.meta.url), 'utf8')`
 * ——一个硬编码的单文件，没有 `readdirSync`，所以"源码闭合"只在 contract.mjs 内部成立，
 * 兄弟模块（gates.mjs / delivery.mjs）的副本对它**完全不可见**。
 */
const SRC_DIR = new URL('../src/', import.meta.url);
const SRC_FILES = readdirSync(SRC_DIR).filter((name) => name.endsWith('.mjs')).sort();
const SRC_SOURCES = new Map(SRC_FILES.map((name) => [name, readFileSync(new URL(name, SRC_DIR), 'utf8')]));

/**
 * 在源码文本里找出「给 `identifier` 赋值 / 声明」的行 —— 也就是一份**定义副本**。
 *
 * 判据是行首锚定的声明或赋值语句，因此：
 *   - `const X = [...]` / `Object.freeze([...])` / `new Set([...])` / 裸赋值 / `function X` → 命中
 *   - `import { X } from './contract.mjs'` → 不命中（没有赋值，这是迁移后的正确形态）
 *   - `if (X.includes(kind))` / `X.has(...)` → 不命中（成员访问不是定义）
 *   - 注释里提到它 → 不命中（行首是 `*` 或 `//`）
 *   - 默认参数 `function f(k = X)` → 不命中（`=` 在名字左边）
 * @param {string} source
 * @param {string} identifier
 * @returns {Array<{line: number, text: string}>}
 */
function findDefinitionsOf(source, identifier) {
  const name = String(identifier).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declarationRe = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:const|let|var|function)\\s+${name}\\b`);
  const assignRe = new RegExp(`^\\s*${name}\\s*=(?!=)`);
  const hits = [];
  String(source ?? '').split(/\r?\n/).forEach((line, index) => {
    if (declarationRe.test(line) || assignRe.test(line)) hits.push({ line: index + 1, text: line.trim() });
  });
  return hits;
}

/** 兼容旧调用点的薄包装（QUALITY_KINDS 的副本检测）。 */
function findQualityKindsDefinitions(source) {
  return findDefinitionsOf(source, 'QUALITY_KINDS');
}

/* ------------------------------------------------------------------------- */
/* 发布闭合：`files` 白名单必须覆盖每个被 import 的 src 模块                      */
/* ------------------------------------------------------------------------- */

/**
 * 这一组守的是一条**只在打包之后才炸**的缺陷：
 *
 * `plugin/package.json` 的 `files` 是 npm 打包白名单，而 `host/index.js` 用相对路径
 * `import ... from '../src/xxx.mjs'` 引兄弟模块。**白名单漏一个，本地跑测试全绿、
 * 发出去装不上** —— 因为漏掉的那个文件根本没进 tarball。
 *
 * 第 17 轮实测就漏了 `src/contract.mjs`：`host/index.js:47`
 * `import { parseDeclaration, normalizeIdentity } from '../src/contract.mjs'`，
 * 而 `files` 只有 board / adapter / roles / delivery 四个。
 * 这类缺陷的可怕之处是**测试完全看不见它**——所有测试都在源码树上跑，
 * 只有 `npm pack` 之后的产物才缺文件。所以这条断言去读 `package.json` 本身。
 */
const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * 从源码里抽出所有 `from '../src/<name>.mjs'` / `from './<name>.mjs'` 的模块名。
 * 只认相对路径里的 `src/`（或与 src 同级的 `./`），第三方包不参与。
 */
function collectSrcImports(source) {
  /* 先抹掉注释行，再匹配 —— 这个洞已经真的漏过一次：
   * `host/index.js` 里有一行 JSDoc 说明写着
   * `import { E_LEDGER_PARTIAL } from '../src/codes.mjs'`（讲"为什么不能按码名 import"），
   * 正则把它当成真依赖抓走，于是这份"期望清单"多了一个并不存在的依赖，
   * 而真有 import 的 `meeting.mjs` 反而漏了。**一份把注释算成依赖的清单，不是依赖清单。**
   *
   * 判据只认行首：`//`、JSDoc 的 `*` 与 `/*`。够用且不会误伤 —— 依赖声明永远在行首，
   * 没有人把 import 写在行尾注释里。 */
  const stripped = String(source ?? '')
    .split('\n')
    .filter((line) => {
      const head = line.trim();
      if (head === '') return false;
      if (head.startsWith('//')) return false;
      if (head.startsWith('*')) return false;
      if (head.startsWith('/*')) return false;
      return true;
    })
    .join('\n');

  const names = new Set();
  for (const match of stripped.matchAll(/from\s+'((?:\.\.\/src|\.\/src)\/([A-Za-z0-9_.-]+\.mjs))'/g)) {
    names.add(match[2]);
  }
  return [...names].sort();
}

/** `files` 里覆盖到某个 `src/xxx.mjs` 吗（支持字面路径与目录通配两种写法）。 */
function filesCovers(files, relativePath) {
  return files.some((entry) => {
    if (entry === relativePath) return true;
    // 目录通配：`src/*.mjs` / `src/**` / `src/`
    if (!entry.includes('*')) return false;
    const prefix = entry.slice(0, entry.indexOf('*'));
    return relativePath.startsWith(prefix);
  });
}

describe('发布闭合：package.json 的 files 必须包含每个被 import 的 src 模块', () => {
  it('P-1) `host/index.js` 里 from \'../src/*.mjs\' 的每个 import 都在 files 里', () => {
    const hostSource = readFileSync(new URL('../host/index.js', import.meta.url), 'utf8');
    const imports = collectSrcImports(hostSource);

    // 防这条测试自己空转：一个都没扫到 = 正则坏了，不是"没有问题"。
    assert.ok(imports.length > 0, `没从 host/index.js 扫到任何 src import，正则坏了（实际 ${imports.length} 个）`);
    assert.deepEqual(
      imports,
      [
        'adapter.mjs', 'artifact.mjs', 'board.mjs', 'contract.mjs', 'delivery.mjs',
        /* P3-2：`preset.mjs` **回来了** —— 起一场会必须先 `loadPreset` 校验档位
         * （拦下"登记了但没实现"的档，且绝不许回退默认档）。清单本身仍然被完整钉住：
         * 少一个、多一个都要在这里复核一次。 */
        'gates.mjs', 'ledger.mjs', 'meeting.mjs', 'preset.mjs', 'roles.mjs',
      ],
      `host/index.js 的 src 依赖清单变了，请复核（实际：${imports.join(', ')}）`,
    );

    const missing = imports
      .map((name) => `src/${name}`)
      .filter((relativePath) => !filesCovers(PACKAGE_JSON.files, relativePath));
    assert.deepEqual(
      missing,
      [],
      `package.json 的 files 漏了这些被 import 的模块：${missing.join(', ')}`
        + ' —— 本地测试全绿，但发出去的 tarball 里没有它们，装上就报模块找不到',
    );
  });

  it('P-4) 传递闭包：被 import 的模块自己再 import 的模块，也必须都在 files 里', () => {
    /*
     * P-1 只看 host/index.js 那一层，于是漏掉了整整一类：
     * `ledger.mjs` 进了 files、但它 `import` 的 `preset.mjs` 与 `resume.mjs` 没进 ——
     * 本地全绿，发出去的 tarball 里 ledger.mjs 一 require 就炸。**依赖是树，不是一层。**
     *
     * 判据：从 `host/` 下**每一个** `.js` 出发，沿 src 内部的相对 import（`./x.mjs`）
     * 求传递闭包，闭包里每个模块都必须被 files 覆盖。第三方包不在本测试范围内
     * （由依赖声明管）。
     *
     * **根为什么不止 `host/index.js`**（装前体检实测）：`host/meeting.js` 是独立入口，
     * 它 `import` 了 `src/agentpool.mjs`，而那个模块**只被它 import** —— 于是
     * 从 `host/index.js` 出发的闭包永远不含它，`files` 漏了它、1470 条测试全绿。
     * 这与 P-6 当初要兜的洞是同一个：**遍历的根只有一个，别的入口就在视野外。**
     * 所以这里按**目录**取根，不按某个文件名取 —— 往 `host/` 加新入口时不需要回来改测试。
     *
     * 只查 `.mjs` 代码。数据文件（如 `presets/*.json`）不是 import 出来的，
     * 本测试抓不到 —— 那一类由 `preset.mjs` 自己的加载测试兜底。
     */
    const hostDir = new URL('../host/', import.meta.url);
    const hostEntries = readdirSync(hostDir).filter((name) => name.endsWith('.js'));
    assert.ok(hostEntries.length > 0, 'host/ 下没扫到任何入口文件，扫描器坏了');

    const seed = [
      ...new Set(
        hostEntries.flatMap((name) =>
          collectSrcImports(readFileSync(new URL(name, hostDir), 'utf8')),
        ),
      ),
    ];
    assert.ok(seed.length > 0, `没从 host/ 下任何入口扫到 src import（入口 ${hostEntries.join(', ')}），扫描器坏了`);

    /** @type {Set<string>} */
    const closure = new Set();
    const queue = [...seed];
    while (queue.length > 0) {
      const name = queue.shift();
      if (closure.has(name)) continue;
      closure.add(name);
      const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/from\s+'\.\/([A-Za-z0-9_.-]+\.mjs)'/g)) {
        if (!closure.has(match[1])) queue.push(match[1]);
      }
    }

    // 防空转：闭包必须比 seed 大，否则说明"下一层"根本没扫到。
    assert.ok(
      closure.size > seed.length,
      `传递闭包只有 ${closure.size} 个模块（seed ${seed.length} 个），下一层没扫到`,
    );

    const missing = [...closure]
      .sort()
      .map((name) => `src/${name}`)
      .filter((relativePath) => !filesCovers(PACKAGE_JSON.files, relativePath));

    assert.deepEqual(
      missing,
      [],
      `传递闭包里这些模块没进 files：${missing.join(', ')}`
        + ' —— 本地测试全绿，但发出去的 tarball 里它们不在，装上就在 require 那一行炸',
    );
  });

  it('P-6) `host/` 下的每个 .js 都必须在 files 里（P-1/P-4 只看 src 闭包，看不见同级文件）', () => {
    /* 这个洞真的漏过：新建 `host/meeting.js`（驱动器）之后，`files` 只有 `host/index.js` ——
     * 发出去的包里没有驱动器，本地全绿。而 P-1 与 P-4 **抓不到它**：两者都从
     * `host/index.js` 出发、只沿 `src/` 的相对 import 走，同级 host 文件不在它们的视野里。
     *
     * 判据：`host/` 下每个 `.js` 都是生产代码（这个目录里没有测试、没有示例），
     * 所以必须逐条被 `files` 覆盖。这条按**目录**兜，不按某个文件名兜 ——
     * 下一个人往 host/ 加文件时不需要记得回来改测试。 */
    const hostDir = new URL('../host/', import.meta.url);
    const names = readdirSync(hostDir).filter((name) => name.endsWith('.js'));

    assert.ok(names.length > 0, `host/ 下没扫到任何 .js，扫描器坏了`);

    const missing = names
      .map((name) => `host/${name}`)
      .filter((relativePath) => !filesCovers(PACKAGE_JSON.files, relativePath));

    assert.deepEqual(
      missing,
      [],
      `host/ 下这些文件没进 files：${missing.join(', ')} —— 本地测试全绿，发出去的包里没有它们`,
    );
  });

  it('P-5) 反例自检：注释里的 import 不算依赖', () => {
    /* 这个洞真的漏过一次：`host/index.js` 里有一行 JSDoc 写着
     *   import { E_LEDGER_PARTIAL } from '../src/codes.mjs'
     * （讲的正是"为什么不能按码名 import"），旧版扫描器把它当成真依赖抓走 ——
     * 于是那份期望清单里多了一个并不存在的依赖，而真有 import 的 `meeting.mjs` 反而漏了。
     * 一份把注释算成依赖的清单，不是依赖清单。 */
    const source = [
      "import { a } from '../src/real-one.mjs';",
      '/*',
      " * 说明：不要写 import { x } from '../src/from-block-comment.mjs';",
      ' */',
      "  // import { y } from '../src/from-line-comment.mjs';",
      "import { z } from 'some-package';",
    ].join('\n');

    assert.deepEqual(
      collectSrcImports(source),
      ['real-one.mjs'],
      '注释里的 import 与第三方包都不许被算成 src 依赖',
    );
  });

  it('P-2) 反例自检：files 去掉一个模块时，P-1 的判据必须真的会报它', () => {
    /* 没有这条，P-1 可能因为 `filesCovers` 写成了"永远 true"而空转。 */
    const broken = PACKAGE_JSON.files.filter((entry) => entry !== 'src/contract.mjs');
    assert.equal(filesCovers(broken, 'src/contract.mjs'), false, 'filesCovers 必须能判出"漏了"');
    assert.equal(filesCovers(PACKAGE_JSON.files, 'src/contract.mjs'), true, 'filesCovers 必须能判出"有"');

    /* 通配写法的判据也要验一次（`src/*.mjs` 应当覆盖 src 下任意 .mjs）。 */
    assert.equal(filesCovers(['src/*.mjs'], 'src/contract.mjs'), true, '目录通配必须被认作覆盖');
  });

  it('P-3) `gates.mjs` 的 import 与 files 必须**成对**（接线了就得能打包出去）', () => {
    /* 这条原来守的是「不要好心加错东西」：gates.mjs 当时只有测试在用，
     * 生产路径没 import 它，所以它**不该**出现在 files 里 —— 白名单里躺一个
     * 没人用的模块，会让下一个读 package.json 的人以为它已经在生产跑了。
     *
     * 第 15 轮（P0）前提变了：`host/index.js` 现在 import 它（两态 shadow 接线，
     * 见那里 import 上方那段注释）。于是这条守门员**改成守另一件事**：
     * 事实与声明必须成对 ——
     *   import 了却没有 files 条目 → 本地全绿、发出去装不上（P-1 已经会抓）
     *   有 files 条目却没人 import → 又是一条"看着像在用"的假声明
     * 方向相反的同一个错误，所以还是同一条测试守，只是现在两向都判。
     *
     * **没有删掉它，也没有把它改成永远通过**：一条守门员在前提变化时被删掉，
     * 就等于"这件事从此没人管"，而它管的恰恰是"说的和做的要一致"。 */
    const productionSources = ['../host/index.js', '../client.js'];
    const importers = [];
    for (const relative of productionSources) {
      let source;
      try {
        source = readFileSync(new URL(relative, import.meta.url), 'utf8');
      } catch {
        continue; // 文件不存在就跳过（不把"没这个文件"变成红）
      }
      if (collectSrcImports(source).includes('gates.mjs')) importers.push(relative);
    }

    const declared = filesCovers(PACKAGE_JSON.files, 'src/gates.mjs');

    /* 现状固定在"有 import、也有 files 条目"这一态。两侧都写死，
     * 是为了让任何一侧单独漂移都被点名 —— 只判一侧的话，另一侧可以悄悄变。 */
    assert.deepEqual(
      importers,
      ['../host/index.js'],
      `目前应当**只有** host/index.js 在 shadow 接线里 import gates.mjs，实际：${importers.join(', ') || '（无）'}`,
    );
    assert.equal(
      declared,
      true,
      'host/index.js 已经 import 了 gates.mjs，package.json 的 files 必须同步包含 src/gates.mjs',
    );
  });
});

/* ------------------------------------------------------------------------- */
/* kind 名单闭合：任何源文件里的 kind 字面量副本 → 红                            */
/* ------------------------------------------------------------------------- */

/**
 * 这一组补的是 `QUALITY_KINDS` 那套检测器的**覆盖面**。
 *
 * 那个检测器只盯 `QUALITY_KINDS` 一个标识符，于是 `delivery.mjs:229` 的
 * `const KNOWN_KINDS = new Set(['implementation','review','work'])` 从它眼皮底下溜了
 * 一整轮 —— 而 `contract.mjs` 的 `KINDS` 早就是四个（task-21 加了 `proposal`）。
 *
 * 后果不是崩溃，是**静默少判**：`kind: proposal` 的任务被 `E_INPUT_INVALID` 拒掉，
 * 一份提案永远无法交付，而 `grep KNOWN_KINDS plugin/test/` 零匹配（没有任何测试覆盖）。
 *
 * 所以这里**不再盯变量名，盯内容**：任何一行只要同时出现 ≥2 个 kind 名称的字符串字面量，
 * 那就是一份 kind 名单副本 —— 不管你把它叫 KNOWN_KINDS、WHITELIST 还是别的什么。
 * 换名字是免费的，抄内容是那件会漂移的事。
 */
const KIND_NAMES = ['implementation', 'review', 'work', 'proposal'];

/** 除 contract.mjs 以外的全部生产源码（src/*.mjs + host + client）。 */
const PRODUCTION_SOURCES = new Map(SRC_SOURCES);
for (const relative of ['../host/index.js', '../client.js']) {
  try {
    PRODUCTION_SOURCES.set(
      relative.replace('../', ''),
      readFileSync(new URL(relative, import.meta.url), 'utf8'),
    );
  } catch {
    /* 文件不存在就跳过（不把"没这个文件"变成红）。 */
  }
}

/**
 * 找出「同一行里写了 ≥2 个 kind 名称字符串字面量」的行 —— 即一份 kind 名单副本。
 *
 * 判据只看**字符串字面量**（`'implementation'` 这样带引号），因此：
 *   - `KINDS.includes(task.kind)` → 不命中（没有字面量）
 *   - `kind === 'work'` → 不命中（只有 1 个字面量；单点判断不是一份名单）
 *   - `new Set(['implementation','review','work'])` → 命中（3 个）
 *   - 注释 / 文档行 → 跳过（行首是 `*` 或 `//`）
 * @param {Map<string, string>} sources
 * @returns {string[]}
 */
function collectKindListCopies(sources) {
  const offenders = [];
  for (const [name, source] of sources) {
    if (name === 'contract.mjs') continue; // 唯一真相源
    if (name.endsWith('.test.mjs')) continue; // 测试里写清单是正常的（它就是在断言清单）
    String(source)
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (/^\s*(?:\*|\/\/)/.test(line)) return;
        const hits = KIND_NAMES.filter((kind) => new RegExp(`['"\`]${kind}['"\`]`).test(line));
        if (hits.length >= 2) offenders.push(`${name}:${index + 1} → ${line.trim()}`);
      });
  }
  return offenders;
}

describe('kind 名单闭合：任何源文件里出现 kind 名称的**字面量副本** → 红', () => {
  it('K-1) 生产源码里不存在 kind 名单副本（`delivery.mjs` 的 `KNOWN_KINDS` 就是这么溜掉的）', () => {
    const offenders = collectKindListCopies(PRODUCTION_SOURCES);
    assert.deepEqual(
      offenders,
      [],
      '这些地方各自抄了一份 kind 名单：往 contract.mjs 的 KINDS 加一个 kind 时它们不会跟上，'
        + '而漏掉的那一处会静默少判（不是报错）。改成从 contract.mjs 的 KINDS 派生：\n'
        + offenders.join('\n'),
    );
  });

  it('K-2) 反例自检：检测器对"字面量副本"必须真的命中，对"派生写法"必须放过', () => {
    /* 没有这一对，K-1 可能因为检测器永远返回 [] 而空转。 */
    const literalCopy = "const KNOWN_KINDS = new Set(['implementation', 'review', 'work']);";
    const found = collectKindListCopies(new Map([['fake.mjs', literalCopy]]));
    assert.equal(found.length, 1, `检测器必须认得字面量副本，实际命中 ${found.length} 条`);

    /* 派生写法必须放过 —— 否则这条检测会逼着大家不敢用 KINDS。 */
    const derived = new Map([
      ['fake.mjs', "import { KINDS } from './contract.mjs';\nif (!KINDS.includes(task.kind)) {\n  return KINDS.join(' / ');\n}"],
    ]);
    assert.deepEqual(collectKindListCopies(derived), [], '派生写法不许被误判成副本');

    /* 单点判断（只有一个字面量）也要放过：`kind === 'work'` 不是一份名单。 */
    assert.deepEqual(
      collectKindListCopies(new Map([['fake.mjs', "if (kind === 'work') return;"]])),
      [],
      '单个 kind 的判断不是名单副本',
    );

    /* 注释里的清单不算（文档里举例子是正常的）。 */
    assert.deepEqual(
      collectKindListCopies(new Map([['fake.mjs', " * 例如 ['implementation', 'review', 'work']"]])),
      [],
      '注释行不许被当成副本',
    );
  });

  it('K-3) `delivery.mjs` 的 kind 白名单确实来自 contract.mjs，且报错消息不再硬编码名单', () => {
    const deliverySource = SRC_SOURCES.get('delivery.mjs') ?? '';
    assert.ok(deliverySource.length > 0, '读不到 delivery.mjs 源码，这条等于没做');

    /* 旧标识符必须彻底消失（连"定义个 Set 再从 KINDS 填充"都算留了口子）。 */
    assert.deepEqual(
      findDefinitionsOf(deliverySource, 'KNOWN_KINDS'),
      [],
      '`KNOWN_KINDS` 这个副本必须删掉，改成直接用 contract.mjs 的 KINDS',
    );

    /* 必须真的从 contract.mjs 取，并在装载期校验（与 QUALITY_KINDS 同一治法）。 */
    assert.match(deliverySource, /const\s*\{\s*KINDS\s*\}\s*=\s*contractModule/, '必须从 contractModule 解构 KINDS');
    assert.match(deliverySource, /Object\.isFrozen\(KINDS\)/, '装载期必须校验 KINDS 已冻结（宁可装不上也不带病跑）');

    /* 报错消息里那份**第三份**硬编码名单也必须消失，改成从 KINDS 拼。
     * 否则 KINDS 加了 kind 之后，这条错误会对着一个合法 kind 说"不在白名单"——报错本身撒谎。
     *
     * 只查**代码行**：注释里逐字引用旧字符串是正常的（那是在解释改了什么），
     * 把它也算违规会逼人不敢写注释。我第一版就漏了这个，被自己的注释打红。 */
    const deliveryCodeLines = deliverySource
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:\*|\/\/)/.test(line))
      .join('\n');
    assert.equal(
      deliveryCodeLines.includes('（implementation / review / work）'),
      false,
      '错误消息不许再硬编码 kind 名单（那是第三份副本），要从 KINDS 拼',
    );
    assert.match(deliverySource, /KINDS\.join\(' \/ '\)/, '错误消息必须从 KINDS 拼出白名单');
  });
});

/**
 * 在一批源码里找出「contract.mjs 之外还定义了 `QUALITY_KINDS`」的副本。
 *
 * C-1（第 12 轮）：这个函数存在的理由是**旧断言结构上不可能变红**。
 * 旧版有两个问题，正好互相遮盖：
 *   1. `KNOWN_DUPLICATE_OWNERS = ['delivery.mjs', 'gates.mjs']` 白名单**恰好豁免了
 *      `delivery.mjs` 与 `gates.mjs`** —— 也就是当时唯一两个真带副本的文件。
 *      于是"除 contract.mjs 外不得有副本"这条断言，对着**全部违规者**逐个 continue 掉了，
 *      永远看到 offenders=[]，永远不会红。
 *   2. 配套那条"债务清单自洽"断言写的是 `hits.length <= 1`，即"清单里的人可以永久保留 1 份"。
 *      两条合起来，等于把"三份副本"这个事实写成了期望值 —— 给 bug 盖章。
 * 现在白名单整条删掉（不是清空：留一个空数组只会让"再加名字"变得毫无摩擦），
 * 任何文件、任何写法出现第二份定义都会在这里被点名。
 * @param {Map<string, string>} sources 文件名 -> 源码
 * @returns {string[]} `文件:行 → 源码行` 形式的违规列表（空数组 = 只有一份）
 */
function collectQualityKindsCopies(sources) {
  const offenders = [];
  for (const [name, source] of sources) {
    if (name === 'contract.mjs') continue; // 唯一真相源
    for (const hit of findQualityKindsDefinitions(source)) {
      offenders.push(`${name}:${hit.line} → ${hit.text}`);
    }
  }
  return offenders;
}

describe('W1-A A-3：QUALITY_KINDS 不得有副本（跨模块闭合）', () => {
  it('W1-A A-3 扫描范围：plugin/src 下全部 .mjs 都被读入（不再只扫 contract.mjs）', () => {
    for (const required of ['contract.mjs', 'gates.mjs', 'delivery.mjs', 'adapter.mjs']) {
      assert.ok(SRC_FILES.includes(required), `扫描范围必须包含 ${required}，实际 ${JSON.stringify(SRC_FILES)}`);
    }
    assert.equal(SRC_SOURCES.size, SRC_FILES.length);
    for (const [name, source] of SRC_SOURCES) {
      assert.ok(source.length > 0, `${name} 读出来是空的，扫描等于没做`);
    }
  });

  it('W1-A A-3 contract.mjs 之外的任何源文件都不得定义 QUALITY_KINDS（无白名单）', () => {
    const offenders = collectQualityKindsCopies(SRC_SOURCES);
    assert.deepEqual(
      offenders,
      [],
      'QUALITY_KINDS 是跨模块口径，只允许 contract.mjs 定义一次；'
        + '新增副本会让"以后加一个 kind 必漏一处"重现（漏掉的那处就是 fail-open）。'
        + `请改为从 contract.mjs 读取同一个绑定（解构或 import，不要重新赋值）：\n${offenders.join('\n')}`,
    );
  });

  it('W1-A A-3 检测器对**真实文件**有牙：往 gates.mjs / delivery.mjs 源码里塞回一份副本必须被点名', () => {
    // 这条替代了旧的"债务清单自洽"断言。旧断言遍历白名单、断言 `hits.length <= 1`，
    // 白名单一清空就退化成"循环体一次都不执行"的恒真断言——换了个理由继续恒真。
    // 新断言用**仓库里真实的那两份源码**做注入：把字面量副本塞回去 → 必须被点名。
    // 这是 C-1 的常驻自证（对应的手工变异见回报：改坏 → 变红 → 改回）。
    const copyLines = [
      "const QUALITY_KINDS = Object.freeze(['implementation', 'review']);", // 旧 gates.mjs:68
      "const QUALITY_KINDS = new Set(['implementation', 'review']);", // 旧 delivery.mjs:195
    ];
    for (const fileName of ['gates.mjs', 'delivery.mjs']) {
      const original = SRC_SOURCES.get(fileName);
      assert.equal(typeof original, 'string', `${fileName} 必须在扫描范围里`);
      for (const copyLine of copyLines) {
        // 模拟"迁移漏了一处"：真实源码 + 一行副本
        const injected = new Map(SRC_SOURCES);
        injected.set(fileName, `${original}\n${copyLine}\n`);
        const offenders = collectQualityKindsCopies(injected);
        assert.ok(
          offenders.some((line) => line.startsWith(`${fileName}:`)),
          `${fileName} 塞回副本后必须被点名，实际：${JSON.stringify(offenders)}`,
        );
      }
    }
    // 反向：真实现状必须是零违规（否则上一条会以"反正有违规"的方式恒真通过）
    assert.deepEqual(collectQualityKindsCopies(SRC_SOURCES), []);
  });

  it('W1-A A-3 检测器自证：三种字面量写法都认，import / 成员访问 / 注释都不算', () => {
    const positives = [
      "const QUALITY_KINDS = ['implementation', 'review'];",
      "const QUALITY_KINDS = Object.freeze(['implementation', 'review']);",
      "const QUALITY_KINDS = new Set(['implementation', 'review']);",
      'export const QUALITY_KINDS = Object.freeze([]);',
      "QUALITY_KINDS = ['implementation'];",
      "  const QUALITY_KINDS = ['a'];",
    ];
    for (const line of positives) {
      assert.equal(findQualityKindsDefinitions(`x\n${line}\ny`).length, 1, `应识别为定义副本：${line}`);
    }

    const negatives = [
      "import { QUALITY_KINDS } from './contract.mjs';",
      "import { QUALITY_KINDS as QK } from './contract.mjs';",
      'const isQuality = QUALITY_KINDS.includes(kind);',
      'if (!QUALITY_KINDS.has(task.kind)) continue;',
      '// const QUALITY_KINDS = [...];',
      ' * 与 contract.mjs 的 `QUALITY_KINDS` 同集合',
      'const QUALITY_KINDS_LIKE = [...];',
      'function f(kinds = QUALITY_KINDS) {}',
    ];
    for (const line of negatives) {
      assert.deepEqual(findQualityKindsDefinitions(line), [], `不该识别为定义副本：${line}`);
    }
  });

  it('W1-A A-3 QUALITY_KINDS 已冻结导出，且与 KINDS 自洽', () => {
    assert.deepEqual([...QUALITY_KINDS], ['implementation', 'review']);
    assert.ok(Object.isFrozen(QUALITY_KINDS), '必须冻结：兄弟模块要 import 同一份，不能被谁 push');
    assert.throws(() => { QUALITY_KINDS.push('work'); }, TypeError);
    for (const kind of QUALITY_KINDS) {
      assert.ok(KINDS.includes(kind), `QUALITY_KINDS 里的 ${kind} 必须是合法 kind`);
    }
    /* task-21（开会与方案流程）：`proposal` 进入 KINDS，但**故意不进 QUALITY_KINDS**。
     *
     * 原来这条断言写的是「work 是**唯一**不需要质量门禁的 kind」—— 那句话在只有三个 kind 时
     * 成立，现在是 `['work', 'proposal']` 两个，所以补集要跟着改。
     *
     * 为什么 proposal 不该进 QUALITY_KINDS（这是有意识的决定，不是漏了）：
     * `QUALITY_KINDS` 的语义是"必须提供 acceptance 回执 + verify 命令，且逐条对账"。
     * 而**一份方案的"验收"不是这个形状** —— 方案的判据是"有没有被独立评审读过"
     * （`E_PROPOSAL_UNREVIEWED`）和"待确认项有没有被逐条答复"（`E_QUESTIONS_UNANSWERED`），
     * 那是 delivery 层单独定的两条判据，不是 acceptance 回执。
     * 若把 proposal 塞进来，它会被要求交一份它根本产不出的回执，等于逼人伪造。 */
    assert.deepEqual(
      KINDS.filter((kind) => !QUALITY_KINDS.includes(kind)),
      ['work', 'proposal'],
      'work 与 proposal 不需要质量门禁（proposal 的判据由 delivery 层单独定，不是 acceptance 回执）',
    );
  });
});

/* =================================================================== */
/* 第 7 轮 W1-A2（SD-2）：normalizeIdentity —— 身份规范化                */
/* =================================================================== */

describe('W1-A2 normalizeIdentity：身份规范形（trim + 内部空白折叠，保留大小写）', () => {
  it('W1-A2 表行 1-2）原样与两端空白', () => {
    assert.equal(normalizeIdentity('a'), 'a');
    assert.equal(normalizeIdentity(' a '), 'a');
    assert.equal(normalizeIdentity('  a'), 'a');
    assert.equal(normalizeIdentity('a  '), 'a');
    assert.equal(normalizeIdentity('\ta\t'), 'a');
  });

  it('W1-A2 表行 3）内部连续空白折叠成单个半角空格', () => {
    assert.equal(normalizeIdentity('a  b'), 'a b');
    assert.equal(normalizeIdentity('a     b'), 'a b');
    assert.equal(normalizeIdentity('a \t \n b'), 'a b');
    assert.equal(normalizeIdentity('a b'), 'a b', '已经规范的输入必须幂等');
  });

  it('W1-A2 表行 4）制表 / 换行 / 全角空格同属空白', () => {
    assert.equal(normalizeIdentity('a\tb'), 'a b');
    assert.equal(normalizeIdentity('a\nb'), 'a b');
    assert.equal(normalizeIdentity('a\r\nb'), 'a b');
    assert.equal(normalizeIdentity('a\u3000b'), 'a b', '全角空格 U+3000');
    // 裁决表没写、但实现覆盖到的边界：不换行空格也属空白（\s 的一部分），一并钉住
    assert.equal(normalizeIdentity('a\u00a0b'), 'a b', '不换行空格 U+00A0');
    assert.equal(normalizeIdentity('\u3000'), '', '全角空格单独成串 → 空规范形');
  });

  it('W1-A2 表行 5）不折叠大小写（宿主 id 大小写敏感）', () => {
    assert.equal(normalizeIdentity('A'), 'A');
    assert.equal(normalizeIdentity('Alice'), 'Alice');
    assert.notEqual(normalizeIdentity('Alice'), normalizeIdentity('alice'), 'Alice / alice 必须是两个人');
    assert.notEqual(normalizeIdentity('IMPL-A'), normalizeIdentity('impl-a'), 'J-1：大小写不许宽容');
  });

  it('W1-A2 表行 6）空串 / 纯空白 → 空规范形（= 没有归属）', () => {
    assert.equal(normalizeIdentity(''), '');
    assert.equal(normalizeIdentity('   '), '');
    assert.equal(normalizeIdentity('\t\n '), '');
  });

  it('W1-A2 表行 7）非字符串一律空串且永不抛错', () => {
    for (const value of [null, undefined, 42, 0, NaN, true, false, {}, [], Symbol('s'), () => {}, 10n]) {
      assert.doesNotThrow(() => normalizeIdentity(value));
      assert.equal(normalizeIdentity(value), '', `${String(value)} 必须规范化成空串`);
    }
  });

  it('W1-A2 表行 8）控制符不清除：ANSI 原样保留（方向 fail-closed）', () => {
    assert.equal(normalizeIdentity('a\u001b[31mb'), 'a\u001b[31mb');
    assert.equal(normalizeIdentity('a\u0000b'), 'a\u0000b', 'NUL 不在这里处理');
    // 保留控制符的后果：带 ANSI 的名字不会等于干净名字 —— 方向安全（宁可判成两个人）
    assert.notEqual(normalizeIdentity('a\u001b[31mb'), normalizeIdentity('ab'));
  });

  it('W1-A2 边界）身份规范化不是显示消毒：@ / 全角冒号 / ! 一律不降级', () => {
    // 显示消毒在 board.mjs 的 clean() 里（@→＠、：→：、!→！），两者必须能分别演进。
    // 这里若也降级，等于把显示规则搬回身份层 —— 这轮修完下轮再犯。
    assert.equal(normalizeIdentity('a@b'), 'a@b', 'clean 会给出 a＠b，这里必须不降级');
    assert.equal(normalizeIdentity('a：b'), 'a：b');
    assert.equal(normalizeIdentity('a!b'), 'a!b');
    assert.notEqual(normalizeIdentity('a@b'), 'a＠b');
    // 三条合起来钉住：本函数与 clean 是**两个**函数，不能互相替换
    assert.equal(normalizeIdentity('a\u001b[31mb'), 'a\u001b[31mb', 'clean 会清 ANSI，这里不清');
  });

  it('W1-A2 幂等性：规范化两次与一次结果相同（跨模块反复规范化不会漂移）', () => {
    for (const value of ['a  b', ' A ', 'a\tb', 'a\u3000b', 'a@b', '', '   ', 'a\u001b[31mb']) {
      const once = normalizeIdentity(value);
      assert.equal(normalizeIdentity(once), once, `normalizeIdentity 必须幂等：${JSON.stringify(value)}`);
    }
  });

  it('W1-A2 闭合扫描：normalizeIdentity 只允许在 contract.mjs 有一份实现', () => {
    // 身份规则两套实现就是 SD-2 的病根（board 的 clean + delivery 的 assigneeOf）。
    // 这里不留任何"已知债务"名单：第三份副本必须在出现的当轮就红。
    const offenders = [];
    for (const [name, source] of SRC_SOURCES) {
      if (name === 'contract.mjs') continue;
      for (const hit of findDefinitionsOf(source, 'normalizeIdentity')) {
        offenders.push(`${name}:${hit.line} → ${hit.text}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'normalizeIdentity 是跨模块唯一实现，兄弟模块必须 import，不许抄第二份：\n' + offenders.join('\n'),
    );
    // 反向自证：扫描器确实认得它的定义处（否则上一条就是空转）
    const own = findDefinitionsOf(SRC_SOURCES.get('contract.mjs') ?? '', 'normalizeIdentity');
    assert.equal(own.length, 1, `contract.mjs 里应当恰好有 1 处 normalizeIdentity 定义，实际 ${own.length}`);
  });
});

/* =================================================================== */
/* D-14：parseDeclaration —— 解析 description 里的 team-board 声明块      */
/* =================================================================== */

/**
 * 声明块里的围栏符号。
 *
 * 写成常量而不是直接内联三个反引号，只有一个理由：测试正文里到处是模板字符串，
 * 内联反引号会让字符串本身变成"谁来改这里谁先踩一次语法错"。语义没有区别。
 */
const FENCE = '```';

/** 拼一个完整的 `team-board` 块（块内每行原样给出，不加缩进）。 */
function declarationBlock(...lines) {
  return [FENCE + 'team-board', ...lines, FENCE].join('\n');
}

const warningCodes = (result) => result.warnings.map((warning) => warning.code);

describe('D-14 parseDeclaration：description 里的 team-board 声明块', () => {
  it('D-14 1) 正常块：kind + 六个契约字段全部落地，warnings 为空', () => {
    const result = parseDeclaration(declarationBlock(
      'kind: implementation',
      'objective: 让 /api/team-board/state 在 storage 不可用时如实返回 unavailable',
      'acceptance:',
      "  - storage.open 失败时 ledger.status === 'unavailable'",
      '  - 不许返回 roles: []',
      'verify:',
      '  - node --test plugin/test/host.test.mjs',
      'inScope:',
      '  - plugin/host/index.js',
      'outOfScope:',
      '  - plugin/client.js',
      'reviewedTaskId: T7',
    ));

    assert.equal(result.kind, 'implementation');
    assert.deepEqual(result.contract, {
      objective: '让 /api/team-board/state 在 storage 不可用时如实返回 unavailable',
      acceptance: ["storage.open 失败时 ledger.status === 'unavailable'", '不许返回 roles: []'],
      verify: ['node --test plugin/test/host.test.mjs'],
      inScope: ['plugin/host/index.js'],
      outOfScope: ['plugin/client.js'],
      reviewedTaskId: 'T7',
    });
    assert.deepEqual(result.warnings, []);
  });

  it('D-14 2) 只认第一个块：第二个块的 kind 不许覆盖第一个', () => {
    const text = [
      declarationBlock('kind: implementation', 'acceptance:', '  - 第一条'),
      '',
      declarationBlock('kind: review', 'acceptance:', '  - 第二条'),
    ].join('\n');

    const result = parseDeclaration(text);
    assert.equal(result.kind, 'implementation', '只认第一个块：第二个块的 kind 是被整块忽略的');
  });

  it('D-14 3) 第二个块整块忽略：它的键不许污染第一个块的契约（逐字段比对，不看单个 kind）', () => {
    // 这条是 D-14 里最容易写成空断言的地方：只断言 result.kind === 'implementation' 的话，
    // 一个"把两个块的内容合并起来"的实现照样是绿的（合并也不改 kind，只会多出几个键）。
    // 所以这里直接对整个 contract 做 deepEqual —— 多一个键就红。
    const text = [
      declarationBlock('kind: implementation'),
      '',
      declarationBlock(
        'kind: review',
        'acceptance:',
        '  - 第二个块的验收项',
        'outOfScope:',
        '  - plugin/client.js',
        'objective: 第二个块的目标',
      ),
    ].join('\n');

    const result = parseDeclaration(text);
    assert.equal(result.kind, 'implementation');
    assert.deepEqual(result.contract, {}, '第一个块只有 kind，契约必须是空的：第二个块一个键都不许漏进来');
    for (const leaked of ['acceptance', 'outOfScope', 'objective']) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(result.contract, leaked),
        `第二个块的 ${leaked} 漏进了第一个块`,
      );
    }
  });

  it('D-14 4) 第一个块未闭合 → E_DECLARATION_UNPARSEABLE，且后面那个正常块不许当成第一个', () => {
    // 现场：第一个块忘了写结尾反引号，紧接着又写了一个完整的块。
    // 危险写法是"用第二个块的闭合行给第一个块收尾"——那样第一个块的 kind 会配上第二个块的
    // 验收项，两条断言各自看着都对，实际是一份不存在的声明。
    const text = [
      FENCE + 'team-board',
      'kind: work',
      '',
      '这里忘了写结尾的反引号',
      '',
      declarationBlock('kind: review', 'acceptance:', '  - 第二个块的验收项'),
    ].join('\n');

    const result = parseDeclaration(text);
    assert.deepEqual(warningCodes(result), ['E_DECLARATION_UNPARSEABLE']);
    assert.match(result.warnings[0].message, /没有闭合/, '文案必须说清是"没有闭合"，不然人不知道去补哪儿');
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'kind'), '未闭合块里的 kind 不许生效');
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'contract'), '未闭合时不返回 contract（与"没有块"同形）');
    // 第二个块也不许被当成第一个：它的 kind / acceptance 一个都不许出现
    assert.ok(!JSON.stringify(result).includes('review'), '第二个块的 kind 不许出现在结果里');
    assert.ok(!JSON.stringify(result).includes('第二个块的验收项'), '第二个块的验收项不许出现在结果里');
  });

  it('D-14 5) 未知键 Kind: → E_DECLARATION_UNKNOWN_KEY，但同块的其它键照常解析', () => {
    // 这条守的是"一个错键不许把整份声明带走"：`Kind:` 如果把整块判死，就等于拼写错误
    // 静默丢掉了所有契约，比报错危险得多。
    const result = parseDeclaration(declarationBlock(
      'Kind: implementation',
      'acceptance:',
      '  - 这条必须还在',
      'verify:',
      '  - node --test x',
    ));

    assert.deepEqual(warningCodes(result), ['E_DECLARATION_UNKNOWN_KEY']);
    assert.match(result.warnings[0].message, /Kind/, '警告里必须点名那个不认识的键，否则人找不到自己打错了哪儿');
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'kind'), '大小写错的键不算 kind');
    assert.deepEqual(result.contract, {
      acceptance: ['这条必须还在'],
      verify: ['node --test x'],
    });
  });

  it('D-14 6) kind 取值拼错 → 原样保留，不在解析层改写或丢弃（交给 gates 报）', () => {
    const result = parseDeclaration(declarationBlock(
      'kind: implementaton',
      'acceptance:',
      '  - a',
    ));

    assert.equal(result.kind, 'implementaton', '解析层不许把不认识的 kind 改写成 ? 或 undefined');
    assert.deepEqual(result.warnings, [], '取值不认识不是解析层的错，不在这里发警告');
    assert.ok(!QUALITY_KINDS.includes(result.kind), '自检：这个取值确实不在 QUALITY_KINDS 里');
  });

  it('D-14 7) 空块：块存在但没有任何键 → contract 为空对象（不是"没有块"）', () => {
    const result = parseDeclaration(declarationBlock());
    assert.deepEqual(result.contract, {});
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'kind'));
    assert.deepEqual(result.warnings, []);
  });

  it('D-14 8) 完全没有块 → { warnings: [] }，且没有 contract 键（调用方据此发 E_DECLARATION_MISSING）', () => {
    for (const text of ['', '   ', '只有一段普通描述，没有任何围栏块', '```js\nconsole.log(1)\n```']) {
      const result = parseDeclaration(text);
      assert.deepEqual(result, { warnings: [] }, `没有声明块时必须是 {warnings: []}：${JSON.stringify(text)}`);
      assert.ok(
        !Object.prototype.hasOwnProperty.call(result, 'contract'),
        '没有块时不许造一个 contract: {}：调用方要能区分"空块"与"没有块"',
      );
    }
  });

  it('D-14 9) CRLF 换行：与 LF 版结果逐字段相同', () => {
    // 一个诚实的自我提醒（这条差点写成空转）：单看标量值，`'implementation\r'.trim()` 本来
    // 就会把 \r 去掉，所以"值对不对"对 CRLF 毫无检测力。真正会被 \r 打死的是**围栏行**——
    // 结束行是 "```\r" 时若不做 trim，就根本认不出闭合，整份声明会变成 unparseable。
    // 因此这里断言的是**整个结果对象相等**，而不是某个取值。
    const lines = [
      'kind: implementation',
      'acceptance:',
      '  - 第一条',
      '  - 第二条',
      'verify:',
      '  - node --test x',
    ];
    const lf = parseDeclaration(declarationBlock(...lines));
    const crlf = parseDeclaration([FENCE + 'team-board', ...lines, FENCE].join('\r\n') + '\r\n');

    assert.deepEqual(crlf, lf, 'CRLF 版必须与 LF 版逐字段相同（含围栏识别）');
    assert.equal(crlf.kind, 'implementation');
    assert.deepEqual(crlf.contract.acceptance, ['第一条', '第二条'], '列表项里不许残留 \\r');
    assert.deepEqual(crlf.warnings, []);
  });

  it('D-14 10) 块在正文中间：前后的散文都不影响解析', () => {
    const text = [
      '先说结论：这个任务要做三件事，下面那段是声明。',
      '',
      declarationBlock('kind: work'),
      '',
      '后面还有一段补充说明，顺便提一下 kind: review 这种行不算声明。',
    ].join('\n');

    const result = parseDeclaration(text);
    assert.equal(result.kind, 'work', '只认围栏块；正文里裸写 kind: xxx 不是声明');
    assert.deepEqual(result.contract, {});
    assert.deepEqual(result.warnings, []);
  });

  it('D-14 11) 块前后都有正文，且正文里的同名文字不影响"只认第一个块"', () => {
    const text = [
      FENCE + 'team-board',
      'kind: implementation',
      FENCE,
      '',
      '下面是上一个版本留下的旧声明，已作废：',
      '',
      FENCE + 'team-board',
      'kind: review',
      FENCE,
      '（以上作废）',
    ].join('\n');

    const result = parseDeclaration(text);
    assert.equal(result.kind, 'implementation');
    assert.deepEqual(result.warnings, []);
  });

  it('D-14 12) 列表项多条：逐行收集到同一个数组里（保留原文与顺序）', () => {
    const result = parseDeclaration(declarationBlock(
      'kind: implementation',
      'acceptance:',
      '  - storage.open 失败时 ledger.status === \'unavailable\'',
      '  - 控制台必须打印 `degraded`',
      '  -   - 第三个（多余缩进也不影响）',
      'verify:',
      '  - node --test plugin/test/host.test.mjs',
      '  - node --test plugin/test/client.test.mjs',
    ));

    assert.deepEqual(result.contract.acceptance, [
      "storage.open 失败时 ledger.status === 'unavailable'",
      '控制台必须打印 `degraded`',
      '- 第三个（多余缩进也不影响）',
    ]);
    assert.deepEqual(result.contract.verify, [
      'node --test plugin/test/host.test.mjs',
      'node --test plugin/test/client.test.mjs',
    ], '一个列表结束于下一个键，不许把 verify 的条目追加进 acceptance');
  });

  it('D-14 13) 重复键：第一个生效（标量与列表都一样，后来者不许覆盖）', () => {
    const scalar = parseDeclaration(declarationBlock('kind: work', 'kind: review'));
    assert.equal(scalar.kind, 'work', '重复的 kind 取第一个：与"只认第一个块"同一取向');

    const list = parseDeclaration(declarationBlock(
      'acceptance:',
      '  - 先写的',
      'acceptance:',
      '  - 后写的',
    ));
    assert.deepEqual(list.contract.acceptance, ['先写的'], '重复的列表键取第一个，后一个整段丢弃');
  });

  it('D-14 14) 键名冒号前带空格（kind : work）仍认作 kind', () => {
    // 裁决里点名了 `kind :` 这种写法。若解析层把键原样比对，它会变成"不认识的键"，
    // 于是一条声明被警告掉——而作者其实写对了，只是多敲了个空格。
    const result = parseDeclaration(declarationBlock('kind : work', 'objective : 目标'));
    assert.equal(result.kind, 'work');
    assert.equal(result.contract.objective, '目标');
    assert.deepEqual(result.warnings, []);
  });

  it('D-14 15) 孤儿列表项（前面没有任何键）被丢弃，不污染任何字段，也不让整块作废', () => {
    const result = parseDeclaration(declarationBlock(
      '  - 孤儿条目',
      'kind: work',
      'acceptance:',
      '  - 正常的',
    ));

    assert.equal(result.kind, 'work');
    assert.deepEqual(result.contract, { acceptance: ['正常的'] });
    assert.deepEqual(result.warnings, []);
  });

  it('D-14 16) 标量不剥引号、不做 YAML 转义（引号原样留在值里）', () => {
    const result = parseDeclaration(declarationBlock('objective: "带引号的目标"', 'acceptance: a\\nb'));
    assert.equal(result.contract.objective, '"带引号的目标"', '解析层不做引号解析；剥引号会让值悄悄变样');
    assert.equal(result.contract.acceptance, 'a\\nb', '反斜杠转义不解释');
  });

  it('D-14 17) 永不抛错：怪值 / NUL / 孤立代理项 / 超长描述一律不抛，怪值走 E_DECLARATION_UNPARSEABLE', () => {
    // 这一条是"永不抛错"的唯一硬证据：`String(Object.create(null))` 会抛 TypeError
    // （Cannot convert object to primitive value），实现里那个 catch 就是为它存在的。
    // 删掉 catch，这一行立刻把 TypeError 抛给调用方。
    const hostile = Object.create(null);
    assert.doesNotThrow(() => parseDeclaration(hostile), '入参把 toString 都没有时也不许抛');
    const unreadable = parseDeclaration(hostile);
    assert.deepEqual(warningCodes(unreadable), ['E_DECLARATION_UNPARSEABLE']);
    assert.ok(!Object.prototype.hasOwnProperty.call(unreadable, 'kind'));
    assert.ok(!Object.prototype.hasOwnProperty.call(unreadable, 'contract'));

    // 其余怪值：不抛即可，且不产生假的声明
    const weird = [
      null,
      undefined,
      42,
      NaN,
      true,
      Symbol('s'),
      () => {},
      [],
      {},
      { toString: () => 'not a declaration' },
    ];
    for (const value of weird) {
      assert.doesNotThrow(() => parseDeclaration(value), `入参 ${String(value)} 不该让解析器抛错`);
      const result = parseDeclaration(value);
      assert.ok(!Object.prototype.hasOwnProperty.call(result, 'kind'), `入参 ${String(value)} 不该解出 kind`);
      assert.ok(Array.isArray(result.warnings), 'warnings 永远是数组');
    }
    assert.deepEqual(parseDeclaration(null), { warnings: [] }, 'null 描述 = 没有块，不是畸形');
    assert.deepEqual(parseDeclaration(undefined), { warnings: [] }, 'undefined 描述 = 没有块，不是畸形');

    // 二进制怪字符：NUL 与孤立代理项都不许让解析器抛，取值原样保留（消毒是下游 classifyPath 的活）
    assert.doesNotThrow(() => parseDeclaration(declarationBlock('kind: work\u0000')));
    assert.equal(parseDeclaration(declarationBlock('kind: work\u0000')).kind, 'work\u0000');
    assert.doesNotThrow(() => parseDeclaration(declarationBlock('kind: work\uD800')));
    assert.doesNotThrow(() => parseDeclaration(declarationBlock('kind: \u001b[31mred\u001b[0m')));

    // 超长描述：2000 行正文 + 一个块，必须照样能读出来（不许因为量大就退化成"读不懂"）
    const longText = [...Array(2000).fill('填充正文，保持行数'), declarationBlock('kind: work')].join('\n');
    assert.equal(parseDeclaration(longText).kind, 'work');
  });

  it('D-14 18) 解析层不发 E_DECLARATION_MISSING（那是调用方的事），且 warning 码只有两个', () => {
    // 白名单式断言：任何畸形输入下，warning 码只能来自这两枚。多一枚就红，
    // 免得以后有人图省事把 E_DECLARATION_MISSING 塞进解析层（那会让"读文档的任务"也被警告）。
    const allowed = new Set(['E_DECLARATION_UNKNOWN_KEY', 'E_DECLARATION_UNPARSEABLE']);
    const inputs = [
      '',
      '没有块',
      declarationBlock(),
      declarationBlock('Kind: work'),
      declarationBlock('kind: work', 'kind: review'),
      declarationBlock('kind: work', '不认识键: 1', '又一个错键: 2'),
      FENCE + 'team-board\nkind: work',
      declarationBlock('kind: work\u0000'),
      '```js\n```',
    ];
    const seen = new Set();
    for (const text of inputs) {
      const codes = warningCodes(parseDeclaration(text));
      for (const code of codes) seen.add(code);
      assert.ok(
        !codes.includes('E_DECLARATION_MISSING'),
        `解析层不许发 E_DECLARATION_MISSING（调用方才知道 writeScopes 是不是空）：${JSON.stringify(text)}`,
      );
      for (const code of codes) {
        assert.ok(allowed.has(code), `解析层出现了白名单外的 warning 码 ${code}`);
      }
    }
    // 反向自证：这两枚码确实都被真的触发过，否则上面那条白名单是空转
    assert.deepEqual([...seen].sort(), ['E_DECLARATION_UNKNOWN_KEY', 'E_DECLARATION_UNPARSEABLE']);
  });

  it('D-14 19) 键集由 CONTRACT_FIELDS 派生：六个契约字段全部能认，且没有一条未知键警告', () => {
    const lines = ['kind: review'];
    for (const field of CONTRACT_FIELDS) lines.push(`${field}:`, `  - ${field}-1`, `  - ${field}-2`);

    const result = parseDeclaration(declarationBlock(...lines));
    assert.deepEqual(result.warnings, [], '契约字段一个都不许被当成"不认识的键"');
    assert.equal(result.kind, 'review');
    assert.deepEqual(
      Object.keys(result.contract).sort(),
      [...CONTRACT_FIELDS].sort(),
      'CONTRACT_FIELDS 的每一项都必须落地——以后往表里加字段，这条会自动跟着要求',
    );
    for (const field of CONTRACT_FIELDS) {
      assert.deepEqual(result.contract[field], [`${field}-1`, `${field}-2`]);
    }
  });

  it('D-14 20) 键集必须是派生而不是字面量副本（源码闭合，含反例自检）', () => {
    // 本项目反复栽的坑：给同一份清单抄第二份字面量，漂移时没人报警。
    // 声明块的键集若写成 ['kind','acceptance',...] 字面量，以后 CONTRACT_FIELDS 加字段，
    // 新字段就会在每次声明里被当成错键警告掉——而且是静默的、越用越错的那种。
    const source = SRC_SOURCES.get('contract.mjs') ?? '';
    assert.ok(source.length > 0, '读不到 contract.mjs 源码，这条等于没做');

    const definitions = findDefinitionsOf(source, 'DECLARATION_KEYS');
    assert.equal(definitions.length, 1, `contract.mjs 里应当恰好有 1 处 DECLARATION_KEYS 定义，实际 ${definitions.length}`);
    assert.match(
      definitions[0].text,
      /\.\.\.CONTRACT_FIELDS/,
      `声明块的键集必须从 CONTRACT_FIELDS 展开派生，实际这行是：${definitions[0].text}`,
    );

    // 反例自检：把定义换成字面量副本时，上面那条 match 必须失败（否则它就是空转的）
    const literalCopy = "const DECLARATION_KEYS = Object.freeze(['kind', 'acceptance']);";
    assert.doesNotMatch(literalCopy, /\.\.\.CONTRACT_FIELDS/, '反例自检：字面量副本不该满足派生断言');
    assert.equal(findDefinitionsOf(literalCopy, 'DECLARATION_KEYS').length, 1, '反例自检：扫描器确实认得这种写法');
  });
});

/* =================================================================== */
/* D-14 顺手活：KINDS 冻结                                              */
/* =================================================================== */

describe('D-14 KINDS 冻结（与 QUALITY_KINDS 同待遇）', () => {
  it('D-14 K1) KINDS 已冻结：运行时不可 push，且内容不变', () => {
    /* task-21（开会与方案流程）：`proposal` 成为第四种 kind（产出一份方案，可以只写文档）。
     * 这条断言是"KINDS 的确切内容"，改 KINDS 就必须显式改这里 —— 那是故意的。 */
    assert.deepEqual([...KINDS], ['implementation', 'review', 'work', 'proposal'], '冻结不许改内容');
    assert.ok(Object.isFrozen(KINDS), 'KINDS 必须冻结：delivery.mjs 曾逐字重抄它，冻结是最便宜的一道报警');
    assert.throws(() => { KINDS.push('bugfix'); }, TypeError, '冻结后 push 必须当场抛 TypeError，而不是悄悄生效');
    assert.throws(() => { KINDS[0] = 'x'; }, TypeError);
    assert.deepEqual([...KINDS], ['implementation', 'review', 'work', 'proposal'], '被拒的写入不许留下任何痕迹');
    assert.ok(Object.isFrozen(QUALITY_KINDS), '自检：KINDS 与 QUALITY_KINDS 同一待遇');
  });
});

/* =================================================================== */
/* task-18：申报改动 `changed` —— 报告不是条款                            */
/* =================================================================== */

/**
 * 这组钉的是**一次曾经出过的判断错误**：`changed` 最初被我加进 `CONTRACT_FIELDS`，
 * 那条 `W1-2 CONTRACT_FIELDS 冻结导出` 断言当场红了。
 *
 * 它红得对。`CONTRACT_FIELDS` 是**开工前约定的条款**（门禁拿它判"够不够格验收"），
 * `changed` 是**干完之后交的报告**。混在一起的两个实际后果：
 *   ① `contractAmbiguity` 会拿它跟任务顶层比冲突 —— 一份报告不该有"歧义"这回事；
 *   ② 以后可能把"没申报改动"判成"契约不完整"，等于把交付报告混进验收标准。
 *
 * 所以 `changed` 走 `DECLARATION_REPORT_FIELDS`，落 `result.changed`，**不进 `contract`**。
 */
describe('task-18 申报改动 changed（是交付报告，不是契约条款）', () => {
  const FENCE = '```';
  const blockOf = (...lines) => [`${FENCE}team-board`, ...lines, FENCE].join('\n');

  it('18-1) `changed` 落 `result.changed`，**且 `result.contract` 里没有它**（本轮最重要）', () => {
    const parsed = parseDeclaration(blockOf(
      'kind: implementation',
      'changed:',
      '  - plugin/host/index.js',
      '  - plugin/test/host.test.mjs',
    ));

    assert.deepEqual(parsed.changed, ['plugin/host/index.js', 'plugin/test/host.test.mjs']);
    /* 这两条是本组的命门：申报一旦混进契约，下游 `contractOf` / 歧义检测 / 契约完整性
     * 就都会把它当成"开工前的约定"，于是"我自己说改了 2 个文件"变成"约定了改这 2 个文件"。 */
    assert.deepEqual(parsed.contract, {}, `contract 必须是空的，实际：${JSON.stringify(parsed.contract)}`);
    assert.equal(
      Object.hasOwn(parsed.contract, 'changed'),
      false,
      'changed 不许出现在 contract 里：报告不是条款',
    );
  });

  it('18-2) `changed` 是**认识的**键：不产生 E_DECLARATION_UNKNOWN_KEY', () => {
    const parsed = parseDeclaration(blockOf('kind: implementation', 'changed:', '  - a.js'));
    const codes = parsed.warnings.map((warning) => warning.code);
    assert.equal(
      codes.includes('E_DECLARATION_UNKNOWN_KEY'),
      false,
      `changed 已在 DECLARATION_REPORT_FIELDS 里，不该再报未知键（实际 warnings：${codes.join(',') || '无'}）`,
    );

    /* 反例自检：真拼错仍然必须报 —— 否则上面那条可以被"任何键都不报"满足。 */
    const typo = parseDeclaration(blockOf('kind: implementation', 'changes:', '  - a.js'));
    assert.ok(
      typo.warnings.map((warning) => warning.code).includes('E_DECLARATION_UNKNOWN_KEY'),
      '拼成 `changes:` 必须仍然报未知键（证明这条断言不是空转的）',
    );
    assert.equal(Object.hasOwn(typo, 'changed'), false, '拼错的键不许产出 changed');
  });

  it('18-3) 两个名单互不相交，且 CONTRACT_FIELDS 是逐字那 10 个', () => {
    /* **不改那条已存在的冻结断言（`W1-2`）**，这里补的是"两个名单不许重叠"这个新关系。
     * 重叠的后果就是 18-1 守的那件事：报告混进条款。 */
    const overlap = DECLARATION_REPORT_FIELDS.filter((key) => CONTRACT_FIELDS.includes(key));
    assert.deepEqual(overlap, [], `两个名单不许有交集，实际重叠：${overlap.join(',')}`);
    /* task-21：这里从 6 条变成 8 条（`openQuestions` / `answered` 进来了）。
     * 它们进的是**契约**而不是报告 —— 提案"开工前"就承诺要问这些，决议承诺回答这些，
     * 与 `changed`（干完之后的报告）是两件事，所以这里必须看得见它们。 */
    /* task-22：再变成 10 条（`proposalId` / `skipMeeting`）。同一条理由的第三次适用：
     * `skipMeeting` 若是报告，就等于允许"先做完再补一句我跳过了会议" ——
     * 那这条门禁的时态就错了，它要拦的恰恰是不打招呼就开工。 */
    assert.deepEqual(
      [...CONTRACT_FIELDS],
      [
        'acceptance',
        'verify',
        'inScope',
        'outOfScope',
        'reviewedTaskId',
        'objective',
        'openQuestions',
        'answered',
        'proposalId',
        'skipMeeting',
      ],
      'CONTRACT_FIELDS 必须仍是开工前那些约定（它是冻结导出，不是能随手加字段的地方）',
    );
    /* 反向自检：报告字段**不**在契约里 —— 否则上一条会被"两个名单随便怎么加都行"满足。 */
    for (const reportField of DECLARATION_REPORT_FIELDS) {
      assert.equal(CONTRACT_FIELDS.includes(reportField), false, `${reportField} 是报告，不许出现在契约名单里`);
    }
    assert.ok(Object.isFrozen(DECLARATION_REPORT_FIELDS), '新名单也要冻结：冻结是最便宜的漂移报警');
  });

  it('18-4) 「没申报」与「申报了零个」必须可分辨：无键 vs `[]`', () => {
    /* 块里**没有** `changed:` → 键不存在 = 没交报告。 */
    const absent = parseDeclaration(blockOf('kind: implementation', 'acceptance:', '  - a'));
    assert.equal(
      Object.hasOwn(absent, 'changed'),
      false,
      `没写 changed 时不许造一个空数组，实际：${JSON.stringify(absent.changed)}`,
    );

    /* 块里**写了** `changed:` 但零条目 → `[]` = 交了报告，说没改。
     * 这是本文件唯一一处有意偏离"没有值 = 没写这个键"的地方，必须钉住。 */
    const empty = parseDeclaration(blockOf('kind: implementation', 'changed:'));
    assert.equal(Object.hasOwn(empty, 'changed'), true, '写了 changed: 就必须产出这个键');
    assert.deepEqual(empty.changed, [], '申报了零个改动 → []（不是"没申报"）');
  });

  it('18-5) 畸形的 changed 输入不抛错，且不污染 inScope', () => {
    /* ① 行内写法：当成单元素列表（报告字段一律按列表收）。 */
    const inline = parseDeclaration(blockOf('kind: implementation', 'changed: a.js'));
    assert.deepEqual(inline.changed, ['a.js']);

    /* ② `changed` 与 `inScope` 同块出现：各归各的桶，不许串味。 */
    const mixed = parseDeclaration(blockOf(
      'kind: implementation',
      'inScope:',
      '  - plugin/src/',
      'changed:',
      '  - plugin/src/contract.mjs',
    ));
    assert.deepEqual(mixed.contract.inScope, ['plugin/src/'], 'inScope 只许有它自己的条目');
    assert.deepEqual(mixed.changed, ['plugin/src/contract.mjs'], 'changed 只许有它自己的条目');
    assert.equal(Object.hasOwn(mixed.contract, 'changed'), false);

    /* ③ 空条目/非字符串条目被丢掉，但**不抛**。 */
    const messy = parseDeclaration(blockOf('kind: implementation', 'changed:', '  - ', '  -  '));
    assert.deepEqual(messy.changed, [], '空条目没有信息，丢掉但不许让它变成"没申报"');

    /* ④ 重复键取第一个（与本文件"后来者不能覆盖原意"同口径）。 */
    const dup = parseDeclaration(blockOf('changed:', '  - first.js', 'changed:', '  - second.js'));
    assert.deepEqual(dup.changed, ['first.js'], '重复的 changed 取第一个');

    /* ⑤ 非文本入参一律不抛（`parseDeclaration` 的永不抛错契约）。
     * 注意消息里**不能**用 `String(value)` 插值：`String(Object.create(null))` 自己就抛
     * TypeError，那会让"断言的消息"取代"被断言的行为"失败——我第一次写就栽在这儿。 */
    const weirdInputs = [null, undefined, 0, false, [], {}, Object.create(null)];
    for (const [index, weird] of weirdInputs.entries()) {
      assert.doesNotThrow(() => parseDeclaration(weird), `第 ${index} 个怪入参不许让解析抛错`);
    }
  });

  it('18-6) `changed` 不参与契约歧义：contract 与顶层同时写也不报 E_CONTRACT_AMBIGUOUS', () => {
    /* 歧义检测的覆盖面由 `CONTRACT_FIELDS` 决定，`changed` 不在其中 —— 这是 18-3 的直接推论，
     * 但值得单独钉一条：一份**报告**有两处写法不同，不该被当成"两份契约打架"。 */
    const task = {
      contract: { changed: ['a.js'] },
      changed: ['b.js'],
    };
    assert.deepEqual(
      contractAmbiguity(task),
      [],
      `changed 不该进歧义检测，实际报出：${JSON.stringify(contractAmbiguity(task))}`,
    );

    /* 反例自检：真契约字段两处异值必须仍然报（证明上面那条不是"检测全挂了"）。 */
    assert.deepEqual(contractAmbiguity({ contract: { inScope: ['a'] }, inScope: ['b'] }), ['inScope']);
  });
});

/* =================================================================== */
/* task-21 续：`openQuestions` / `answered` 的列表形态与「空 vs 缺失」    */
/* =================================================================== */

/**
 * 这一组守的是整条开会流程的**命脉**：
 *
 *   - `openQuestions: []` = 「我想过了，**没有**需要用户拍板的问题」
 *   - 键不存在           = 「我**根本没想过**这件事」
 *
 * 两者混起来，`E_QUESTIONS_UNANSWERED` 那条判据就写不出来 —— 它分不清
 * "没问" 和 "问了、没问题"。这与本项目那条老红线同源：**读不出来 ≠ 零条**。
 *
 * 另一个必须钉住的是**形态**：这两个字段在规格里就是列表，行内写法只是"只有一条"的简写。
 * 若行内返回字符串，下游三个模块就得各写一次 `Array.isArray ? x : [x]` —— 三份副本，
 * 漂移时没人报警（这个病本项目已经栽过很多次）。
 */
describe('task-21 续：openQuestions / answered 是列表，且「空 vs 缺失」可分辨', () => {
  const FENCE2 = '```';
  const blk = (...lines) => [`${FENCE2}team-board`, ...lines, FENCE2].join('\n');
  const contractOfDeclaration = (text) => parseDeclaration(text).contract ?? {};

  it('21-1) 列表形式 → 数组（多条按顺序收集）', () => {
    const contract = contractOfDeclaration(blk(
      'kind: proposal',
      'openQuestions:',
      '  - 动效是必须的，还是"有更好、没有也能接受"？',
      '  - 卡片入场和连线流动，两个都要还是先做一个？',
    ));
    assert.deepEqual(contract.openQuestions, [
      '动效是必须的，还是"有更好、没有也能接受"？',
      '卡片入场和连线流动，两个都要还是先做一个？',
    ]);
    assert.equal(Array.isArray(contract.openQuestions), true, '必须是数组');

    /* answered 同形（决议侧） */
    const answered = contractOfDeclaration(blk(
      'kind: review',
      'answered:',
      '  - 动效是必须的 → 用户答复：必须有',
      '  - 两个都要还是先做一个 → 用户答复：先做卡片入场',
    ));
    assert.deepEqual(answered.answered, [
      '动效是必须的 → 用户答复：必须有',
      '两个都要还是先做一个 → 用户答复：先做卡片入场',
    ]);
  });

  it('21-2) 行内单条 → **单元素数组**（不是字符串）', () => {
    const contract = contractOfDeclaration(blk('kind: proposal', 'openQuestions: 要不要动效'));
    assert.equal(
      Array.isArray(contract.openQuestions),
      true,
      `行内写法也必须包成数组，实际类型：${Array.isArray(contract.openQuestions) ? 'array' : typeof contract.openQuestions}`
        + ' —— 返回字符串会让下游三个模块各写一次 Array.isArray 兜底',
    );
    assert.deepEqual(contract.openQuestions, ['要不要动效']);

    const answered = contractOfDeclaration(blk('kind: review', 'answered: 动效要 → 要'));
    assert.deepEqual(answered.answered, ['动效要 → 要'], 'answered 的行内写法同样包成数组');
  });

  it('21-3) 写了键但零条目 → **`[]` 且键存在**（"我想过了，没有问题"）', () => {
    const parsed = parseDeclaration(blk('kind: proposal', 'openQuestions:'));
    assert.equal(
      Object.hasOwn(parsed.contract, 'openQuestions'),
      true,
      '写了 openQuestions: 就必须产出这个键 —— 否则"我想过了、没有问题"永远表达不出来',
    );
    assert.deepEqual(parsed.contract.openQuestions, [], '零条目 → 空数组（不是 undefined）');

    const answered = parseDeclaration(blk('kind: review', 'answered:'));
    assert.equal(Object.hasOwn(answered.contract, 'answered'), true, 'answered 同样：写了键就必须在');
    assert.deepEqual(answered.contract.answered, []);
  });

  it('21-4) 完全没写这个键 → **键不存在**（"我根本没想过"）', () => {
    const parsed = parseDeclaration(blk('kind: proposal', 'objective: 给这件事出个方案'));
    assert.equal(
      Object.hasOwn(parsed.contract, 'openQuestions'),
      false,
      '没写 openQuestions 就不许造一个空数组 —— 那会把"没想过"伪装成"想过、没问题"',
    );
    assert.equal(Object.hasOwn(parsed.contract, 'answered'), false, 'answered 同理');

    /* 21-3 与 21-4 的**唯一**差别就是"键有没有出现"，这里把两者并排断一次，
     * 让"可分辨"这件事本身也被测到（而不是分别测两个孤立事实）。 */
    const empty = parseDeclaration(blk('kind: proposal', 'openQuestions:'));
    const absent = parseDeclaration(blk('kind: proposal'));
    assert.notDeepEqual(
      empty.contract,
      absent.contract,
      '「写了键零条目」与「完全没写」的解析结果必须可以被程序区分开',
    );
  });

  it('21-5) 两者都进 `contract`，**不进** report 桶（它们是开工前的承诺，不是交付报告）', () => {
    const parsed = parseDeclaration(blk(
      'kind: proposal',
      'openQuestions:',
      '  - 要不要动效',
      'answered:',
      '  - 要不要动效 → 要',
    ));
    assert.deepEqual(parsed.contract.openQuestions, ['要不要动效'], 'openQuestions 必须在 contract 里');
    assert.deepEqual(parsed.contract.answered, ['要不要动效 → 要'], 'answered 必须在 contract 里');
    assert.equal(Object.hasOwn(parsed, 'changed'), false, '它们不该顺手把 changed 也造出来');
  });

  it('21-6) 反例自检：`changed` 的行为不许被这次改动带歪（它仍是 report 桶）', () => {
    /* 三条并排：这个字段是**干完之后**的报告，与上面两条（开工前的条款）是两件事。
     * 若哪天有人把它们统一成一个桶，这三条会立刻红。 */
    const withItems = parseDeclaration(blk('kind: implementation', 'changed:', '  - a.js'));
    assert.deepEqual(withItems.changed, ['a.js'], 'changed 有内容 → 字符串数组');
    assert.equal(Object.hasOwn(withItems.contract, 'changed'), false, 'changed **不许**出现在 contract 里');

    const empty = parseDeclaration(blk('kind: implementation', 'changed:'));
    assert.deepEqual(empty.changed, [], 'changed 零条目 → []（"申报了没改任何东西"）');

    const absent = parseDeclaration(blk('kind: implementation'));
    assert.equal(Object.hasOwn(absent, 'changed'), false, '没写 changed → 键不存在（"没交报告"）');

    /* 同一个块里两者同时出现：各归各的桶，不许串味。 */
    const both = parseDeclaration(blk(
      'kind: implementation',
      'openQuestions:',
      '  - 要不要动效',
      'changed:',
      '  - a.js',
    ));
    assert.deepEqual(both.contract.openQuestions, ['要不要动效'], 'openQuestions 在 contract');
    assert.deepEqual(both.changed, ['a.js'], 'changed 在顶层 report 位置');
    assert.equal(Object.hasOwn(both.contract, 'changed'), false, 'changed 不许混进 contract');
  });
});
