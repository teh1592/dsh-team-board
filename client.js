/**
 * @local/team-board —— 浏览器半边（第 9 轮 W8，第 13 轮重做呈现层）
 *
 * 挂点是 `conversation.view`（会话头部那排标签：对话 / 轨迹 / 上下文 / 编队），
 * 不是右侧栏 —— 用户要的是"和 Context 同一层级、点一下就切过去"的独立页面。
 * `order: 40` 排在 dsh-context 的「上下文」(20) 与「编队」(30) 之后。
 *
 * 这个页面只放本插件独有的东西（页面上**不出现任何 token 数字或上下文占比**：
 * 那是 dsh-context 的地盘）。
 *
 * ## 第 13 轮：为什么整块重做，以及重做的原则
 *
 * 用户的判词是「这个台账做的很丑很丑」，而且这是**设计错误，不是实现质量**：
 * 上一版把四种**不同种类的问题**装进了同一个模子（四条等宽通栏卡片），于是
 * 每一块既不够重也不够轻；其中「任务板」更是把 `renderBoard()` 那个**给模型看的
 * 定宽文本**直接塞进 `<pre>` —— 一个渲染器服务两个需求相反的读者，页面必然像终端。
 *
 * 现在的原则（抄的是 dsh-context 的**手法**，不是它的像素）：
 *   ① **形状由读者要问的问题决定**，不由"别人家仪表盘长什么样"决定：
 *        判决（二值+理由）→ banner，占满宽度、置顶、最大
 *        根因（多对多）    → 关系图 + 按码聚合的明细
 *        排名（实体互比）  → 右侧栏，五个数字各自成格、等宽、可纵向对齐
 *        元信息（来源/开关）→ 压进顶栏，最小
 *   ② **颜色只编码"严重度"一个含义**，四档语义色 + 灰阶，全部走主题 token。
 *      dsh-context 还给每个"家族"一个金色角配色；我们**不搬** —— 颜色一旦同时
 *      表示两件事，两个含义一起废。
 *   ③ **等宽只给数字、门禁码、任务 id**；正文一律正常字重。
 *   ④ **空态与不可用态必须长得不一样**，而且要落在**结构**上而不是文案上：
 *      判不了时一个数字都不出现（连 0 也不出现），因为"阻断 0"是一个测量结果，
 *      读不出来的时候我们没有资格给测量结果。
 *   ⑤ **不许静默丢**：不落在任何任务上的根因、被截断的任务条数、读取失败的条目，
 *      全部要留可见痕迹。
 *
 * ## 数据边界（必须记住，否则会写出骗人的界面）
 *
 * 宿主 payload（`host/index.js` 的 `snapshot()`）只有：
 *   `enabled`、`dataSource{kind,status,total,running,reason}`、
 *   `roleLedger{status,roles[]}`（**插件自己的**角色台账，落 storage）；
 *   `gates{status,ok,blockers,warnings,auditWired,phaseKnown,board,tasks?,decisions?}`；
 *   `gates.ledger` —— **会议账本**，四态 `none | ok | unreadable | unavailable`，
 *                     形状以宿主 `ledgerSlot()` 为准（四态字段完全一致，含 `readable`）；
 *   `gates.shadow` —— 门禁覆盖，三个分母 `judgedTasks` / `withInput` / `meetingTasks`；
 *   `tasks[].declarationWarnings` —— D-14 声明警告，**挂在每条任务上**（非空才带），
 *                     不是顶层 `gates.declarationWarnings`。
 *
 * **`payload.roleLedger` 与 `gates.ledger` 是两个东西**（P3-9 之前前者就叫 `ledger`，
 * 与后者同名、只差一层路径 —— 页面作者极易拿错，而拿错不会报错，只会把"这场会开到哪了"
 * 显示成"角色台账读不出来"）。现在两侧不同名，且形状也不同：前者 `{status,roles[]}`，
 * 后者带四态 `state`。
 *
 * **别把 `roleLedger` 读成"开关状态"**：开关在 `payload.enabled` 上。这个名字选的是
 * `roleLedger` 而不是 `stateLedger`，正是因为它是**每角色一行统计**。
 *
 * 两个硬事实：
 *   - **`gates.board` 是给模型的定宽文本，页面绝不解析它**（见 `boardRows` 上面的
 *     长注释：`board.mjs` 的 subject 可以被构造成一条合法假任务行，解析 = 重开注入洞）。
 *   - **blockers 不带 `taskId`**（`delivery.mjs:764` 的 `add()` 只 push `{code,message}`），
 *     只有 warnings 带。所以关系图的左列（阻断）今天大多没有右端点，图会在
 *     `hasGeometry === false` 时**整块不出现**，而不是画一列没线的节点充数。
 *     真要让这张图对阻断生效，需要宿主在 `add()` 里多带一个 `taskId` —— 不在本文件写域。
 *
 * 数据来自宿主路由 `POST /api/team-board/state`（`@Remote` 对纯 JS 第三方插件不可用，
 * remotes 装配在构建期固定 —— 走 dsh-context 的同一骨架）。
 *
 * 纯函数挂在模块导出的 `pure` 上，供 `test/client.test.mjs` 直接单测；它们不碰 DOM、
 * 不读 slot、不测量容器 —— 布局全部是索引算术，所以**可以被断言**。
 */

window.__ModuleLoader__.load({
  id: '@local/team-board',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    /* REVIEW_CLIENT_BEGIN */
    const reviewClient = (() => {
const LIMIT = 100;
const text = (value, max = 1200) => typeof value === 'string' ? value.slice(0, max) : 'unknown';
function reviewViewModel(run, section = 'run', page = {}) {
  if (!run || typeof run !== 'object') return { state: 'empty', rows: [], nextCursor: null };
  const list = Array.isArray(page.items) ? page.items : [];
  const rows = list.slice(0, LIMIT).map((item) => ({ id: text(item.id ?? item.executionId ?? item.checkId, 180), title: text(item.objective ?? item.description ?? item.summary ?? item.role ?? item.id ?? item.checkId, 1200), status: text(item.workStatus ?? item.status ?? item.outcome ?? item.choice, 80), applicability: text(item.applicability ?? (item.imported ? 'imported' : undefined), 40), detail: JSON.stringify(item, null, 2).slice(0, 18000), logRef: typeof item.logRef === 'string' ? item.logRef : null, resultRef: typeof item.resultRef === 'string' ? item.resultRef : null }));
  return { state: 'ready', runId: text(run.runId, 180), revision: Number.isSafeInteger(run.revision) ? run.revision : null, requirementRevision: Number.isSafeInteger(run.requirementRevision) ? run.requirementRevision : null, status: text(run.status, 80), phase: text(run.phase, 80), mode: text(run.mode, 40), preset: text(run.preset, 80), summary: text(run.summary, 1600), diagnostic: typeof run.diagnostic === 'string' ? run.diagnostic.slice(0, 2000) : null, requirement: text(run.requirement, 60000), provenance: run.provenance ?? null, pending: Array.isArray(run.pending) ? run.pending.slice(0, 30) : [], section, rows, content: typeof page.content === 'string' ? page.content : null, nextCursor: Number.isSafeInteger(page.nextCursor) ? page.nextCursor : null, total: Number.isSafeInteger(page.total) ? page.total : null, truncated: list.length > LIMIT || page.truncated === true, usage: run.usage ?? null };
}
function createReviewRequestGate() {
  let generation = 0; let current;
  return { begin(key) { current?.controller.abort(); const token = { key, generation: ++generation, controller: new AbortController() }; current = token; return token; }, accepts(token) { return current === token && !token.controller.signal.aborted; }, cancel() { current?.controller.abort(); current = undefined; generation++; } };
}
function decodeReviewResponse(envelope) {
  if (!envelope?.ok) throw new Error(envelope?.error?.message ?? 'Review request failed');
  const execution = envelope.value;
  if (execution?.result?.kind !== 'success') throw new Error(execution?.result?.text ?? 'Review command did not succeed');
  try { return JSON.parse(execution.result.text); } catch { throw new Error('Review command returned invalid JSON'); }
}

const reviewMessages = {
  zh: {
    'review.title': '评审与开发运行', 'review.start': '启动', 'review.requirement': '需求正文', 'review.refresh': '刷新', 'review.empty': '当前会话还没有运行', 'review.loading': '读取运行中…', 'review.error': '操作失败', 'review.mode.review': '只评审', 'review.mode.develop': '实施与验证', 'review.history': '历史任务（只读）', 'review.import': '导入为新运行', 'review.imported': '导入来源', 'review.unknown': '未知', 'review.report': '报告', 'review.logs': '日志', 'review.more': '继续读取', 'review.revise': '修订需求', 'review.reason': '修订原因', 'review.impact': '影响清单 JSON（留空则完整重做）', 'review.submitRevision': '保存修订', 'review.section.run': '运行详情', 'review.section.executions': '角色执行', 'review.section.findings': '意见与问题', 'review.section.decisions': '决定', 'review.section.tasks': '实施任务', 'review.section.checkSpecs': '检查定义', 'review.section.checkResults': '检查结果', 'review.section.report': '报告', 'review.section.history': '操作记录', 'review.section.usage': '运行统计', 'review.pause': '边界暂停', 'review.stop': '立即停止', 'review.resume': '继续', 'review.retry': '重试', 'review.cancel': '取消', 'review.pending': '需要你的选择', 'review.choose': '确认选择', 'review.details': '详细记录', 'review.openLog': '读取日志', 'review.openResult': '读取结果', 'review.noSession': '请打开一个根会话', 'review.readOnly': '历史记录不会自动继续。导入会创建新的运行并保留来源。', 'review.run': '运行', 'review.phase': '阶段', 'review.revision': '需求版本', 'review.storageRevision': '记录版本', 'review.busy': '操作进行中', 'review.lastCommand': '上次命令', 'review.back': '返回分区', 'review.new': '新需求', 'review.previous': '上一页', 'review.partial': '当前显示一页，长内容请继续读取',
  },
  en: {
    'review.title': 'Review and development runs', 'review.start': 'Start', 'review.requirement': 'Requirement', 'review.refresh': 'Refresh', 'review.empty': 'No runs in this session', 'review.loading': 'Loading runs…', 'review.error': 'Operation failed', 'review.mode.review': 'Review only', 'review.mode.develop': 'Implement and verify', 'review.history': 'Historical tasks (read only)', 'review.import': 'Import as a new run', 'review.imported': 'Imported source', 'review.unknown': 'Unknown', 'review.report': 'Report', 'review.logs': 'Logs', 'review.more': 'Load more', 'review.revise': 'Revise requirement', 'review.reason': 'Reason for revision', 'review.impact': 'Impact JSON (empty runs a full review)', 'review.submitRevision': 'Save revision', 'review.section.run': 'Run details', 'review.section.executions': 'Role executions', 'review.section.findings': 'Findings', 'review.section.decisions': 'Decisions', 'review.section.tasks': 'Implementation tasks', 'review.section.checkSpecs': 'Check definitions', 'review.section.checkResults': 'Check results', 'review.section.report': 'Report', 'review.section.history': 'Operation history', 'review.section.usage': 'Run statistics', 'review.pause': 'Pause at boundary', 'review.stop': 'Stop now', 'review.resume': 'Resume', 'review.retry': 'Retry', 'review.cancel': 'Cancel', 'review.pending': 'Your choice is needed', 'review.choose': 'Confirm choice', 'review.details': 'Full record', 'review.openLog': 'Read log', 'review.openResult': 'Read result', 'review.noSession': 'Open a root session', 'review.readOnly': 'History does not resume automatically. Import creates a new run with its source retained.', 'review.run': 'Run', 'review.phase': 'Stage', 'review.revision': 'Requirement version', 'review.storageRevision': 'Record revision', 'review.busy': 'Operation in progress', 'review.lastCommand': 'Last command', 'review.back': 'Back to section', 'review.new': 'New requirement', 'review.previous': 'Previous page', 'review.partial': 'Showing one page; continue to read long content',
  },
};
function createReviewPanel(React, h) {
  const style = `.tb-review{margin:16px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:13px/1.55 inherit}.tb-review h2{font-size:16px;margin:0 0 12px}.tb-review h3{font-size:14px;margin:12px 0 8px}.tb-review-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}.tb-review label{display:grid;gap:5px;flex:1;min-width:160px}.tb-review textarea,.tb-review input,.tb-review select{font:inherit;box-sizing:border-box;max-width:100%;padding:7px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}.tb-review textarea{width:100%;min-height:90px;resize:vertical}.tb-review button{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);border-radius:7px;padding:5px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.tb-review button:disabled{opacity:.5;cursor:default}.tb-review button:focus-visible,.tb-review textarea:focus-visible,.tb-review input:focus-visible,.tb-review select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.tb-review [role=alert]{padding:9px;border-left:3px solid var(--dsw-alias-state-error-primary);white-space:pre-wrap}.tb-review pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow:auto;background:var(--dsw-alias-bg-layer-2);padding:10px;border-radius:6px;font-size:12px}.tb-review-item{padding:10px 0;border-top:1px solid var(--dsw-alias-border-l2)}.tb-review-small{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.tb-review-tabs button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary)}.tb-review summary{cursor:pointer}.tb-review-list{max-height:220px;overflow:auto}`;
  const id = () => globalThis.crypto?.randomUUID?.() ?? `review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sections = ['run', 'executions', 'findings', 'decisions', 'tasks', 'checkSpecs', 'checkResults', 'report', 'history', 'usage'];
  function ReviewPanel({ sessionId, t }) {
    const [runs, setRuns] = React.useState({ items: [], nextCursor: null });
    const [runId, setRunId] = React.useState(''); const [section, setSection] = React.useState('run');
    const [run, setRun] = React.useState(null); const [page, setPage] = React.useState({});
    const [error, setError] = React.useState(null); const [busy, setBusy] = React.useState(false); const [loading, setLoading] = React.useState(false);
    const [requirement, setRequirement] = React.useState(''); const [mode, setMode] = React.useState('review'); const [preset, setPreset] = React.useState('standard@2');
    const [reason, setReason] = React.useState(''); const [impact, setImpact] = React.useState(''); const [revisionDraft, setRevisionDraft] = React.useState('');
    const [history, setHistory] = React.useState(null); const [artifact, setArtifact] = React.useState(null); const [lastCommand, setLastCommand] = React.useState(null);
    const gates = React.useRef(null); if (!gates.current) gates.current = { list: createReviewRequestGate(), detail: createReviewRequestGate(), mutation: createReviewRequestGate(), history: createReviewRequestGate() };
    const context = React.useRef({ sessionId, runId, section }); context.current = { sessionId, runId, section };
    const mutation = React.useRef(null); const locked = React.useRef(false); const startKey = React.useRef(id());
    const query = React.useCallback(async (request, token) => {
      const response = await fetch('/api/team-board/review', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, request }), signal: token.controller.signal });
      const envelope = await response.json(); return { value: decodeReviewResponse(envelope), commandId: envelope.value?.commandId ?? null };
    }, [sessionId]);
    const listRuns = React.useCallback(async (cursor = 0) => {
      const token = gates.current.list.begin(`${sessionId}:list`);
      try { const { value } = await query({ action: 'list', cursor }, token); if (gates.current.list.accepts(token)) setRuns({ ...value, cursor }); }
      catch (problem) { if (gates.current.list.accepts(token)) setError(problem.message); }
    }, [query, sessionId]);
    const load = React.useCallback(async (cursor = 0, logRef = null) => {
      if (!runId) return; setError(null); const token = gates.current.detail.begin(`${sessionId}:${runId}:${section}:${logRef ?? ''}`); setLoading(true);
      try {
        const [summary, detail] = await Promise.all([query({ action: 'read', runId, section: 'run' }, token), query({ action: 'read', runId, section: logRef ? 'artifact' : section, cursor, ...(logRef ? { id: logRef } : {}) }, token)]);
        if (gates.current.detail.accepts(token)) { setRun(summary.value); setPage({ ...detail.value, cursor }); setArtifact(logRef); }
      } catch (problem) { if (gates.current.detail.accepts(token)) setError(problem.message); }
      finally { if (gates.current.detail.accepts(token)) setLoading(false); }
    }, [query, runId, section, sessionId]);
    React.useEffect(() => {
      setRunId(''); setRun(null); setPage({}); setRuns({ items: [], nextCursor: null }); setHistory(null); setError(null); mutation.current = null; locked.current = false; setBusy(false); startKey.current = id(); if (sessionId) listRuns();
      return () => { for (const gate of Object.values(gates.current)) gate.cancel(); };
    }, [sessionId, listRuns]);
    React.useEffect(() => { setPage({}); setRun(null); setArtifact(null); setError(null); setLoading(false); if (runId) load(); return () => gates.current.detail.cancel(); }, [load, runId, section]);
    const operate = async (request) => {
      if (locked.current) return; locked.current = true; setBusy(true); setError(null);
      const owner = { ...context.current }; const fingerprint = JSON.stringify(request);
      if (!mutation.current || mutation.current.fingerprint !== fingerprint) mutation.current = { fingerprint, payload: { ...request, ...(['start', 'import'].includes(request.action) ? {} : { operationId: id(), expectedRevision: run?.revision }) } };
      const token = gates.current.mutation.begin(`${owner.sessionId}:${owner.runId}:${owner.section}`);
      try {
        const payload = mutation.current.payload;
        const { value, commandId } = await query(payload, token);
        if (gates.current.mutation.accepts(token) && context.current.sessionId === owner.sessionId && context.current.runId === owner.runId && context.current.section === owner.section) {
          setLastCommand(commandId); mutation.current = null;
          if (value.runId) { if (value.runId !== runId) { setRunId(value.runId); setSection('run'); } else await load(); }
          if (request.action === 'start') startKey.current = id();
          await listRuns();
        }
      } catch (problem) {
        if (gates.current.mutation.accepts(token) && context.current.sessionId === owner.sessionId && context.current.runId === owner.runId && context.current.section === owner.section) { if (problem.message.includes('REVISION_CONFLICT')) { mutation.current = null; await load(); } setError(problem.message); }
      } finally { if (gates.current.mutation.accepts(token)) { locked.current = false; setBusy(false); } }
    };
    const loadHistory = async (cursor = 0) => {
      const token = gates.current.history.begin(`${sessionId}:history`);
      try { const { value } = await query({ action: 'history', cursor }, token); if (gates.current.history.accepts(token)) setHistory({ ...value, cursor }); }
      catch (problem) { if (gates.current.history.accepts(token)) setError(problem.message); }
    };
    const vm = reviewViewModel(run, section, page);
    const button = (label, fn, disabled = false, extra = {}) => h('button', { type: 'button', onClick: fn, disabled: busy || disabled, ...extra }, label);
    const viewRows = vm.rows ?? [];
    return h('section', { className: 'tb-review', 'aria-busy': busy || loading }, h('style', null, style),
      h('div', { className: 'tb-review-row' }, h('h2', null, t('review.title')), button(t('review.refresh'), () => { listRuns(); if (runId) load(); }), busy ? h('span', { role: 'status' }, t('review.busy')) : null),
      !sessionId ? h('p', null, t('review.noSession')) : null,
      error ? h('div', { role: 'alert' }, `${t('review.error')}: ${error}`) : null,
      h('details', null, h('summary', null, t('review.new')),
        h('label', null, t('review.requirement'), h('textarea', { value: requirement, onChange: (event) => { setRequirement(event.target.value); startKey.current = id(); } })),
        h('div', { className: 'tb-review-row' }, h('select', { 'aria-label': t('review.run'), value: mode, onChange: (event) => { setMode(event.target.value); startKey.current = id(); } }, ['review', 'develop'].map((key) => h('option', { value: key, key }, t(`review.mode.${key}`)))),
          h('select', { 'aria-label': 'Preset', value: preset, onChange: (event) => { setPreset(event.target.value); startKey.current = id(); } }, ['quick@2', 'standard@2'].map((key) => h('option', { value: key, key }, key))),
          button(t('review.start'), () => operate({ action: 'start', requestId: startKey.current, requirement, mode, preset }), !sessionId || !requirement.trim()))),
      h('div', { className: 'tb-review-list' }, runs.items.length ? runs.items.map((item) => button(`${item.runId} · ${item.status} · ${item.phase}`, () => { setRunId(item.runId); setSection('run'); setRevisionDraft(''); }, false, { key: item.runId, 'aria-pressed': item.runId === runId })) : h('p', null, t('review.empty'))),
      (runs.errors ?? []).map((entry, index) => h('div', { role: 'alert', key: index }, `${entry.projectRoot}: ${entry.message}`)),
      runs.cursor > 0 ? button(t('review.previous'), () => listRuns(Math.max(0, runs.cursor - 20))) : null,
      runs.nextCursor !== null ? button(t('review.more'), () => listRuns(runs.nextCursor)) : null,
      loading ? h('p', { role: 'status' }, t('review.loading')) : null,
      vm.state === 'ready' ? h('div', null,
        h('div', { className: 'tb-review-small' }, `${vm.runId} · ${vm.mode} · ${vm.preset} · ${t('review.phase')}: ${vm.phase} · ${t('review.revision')}: ${vm.requirementRevision ?? t('review.unknown')} · ${t('review.storageRevision')}: ${vm.revision ?? t('review.unknown')}`),
        h('p', null, vm.summary), vm.diagnostic ? h('pre', null, vm.diagnostic) : null,
        vm.provenance ? h('details', null, h('summary', null, t('review.imported')), h('pre', null, JSON.stringify(vm.provenance, null, 2))) : null,
        h('div', { className: 'tb-review-row' }, ['pause', 'stop', 'resume', 'retry', 'cancel'].map((action) => button(t(`review.${action}`), () => operate({ action, runId }), ['completed', 'cancelled'].includes(vm.status), { key: action }))),
        (vm.pending ?? []).filter((question) => question.status === 'open').map((question) => h('div', { className: 'tb-review-item', key: question.id }, h('strong', null, t('review.pending')), h('p', null, question.question), question.options.map((option) => button(`${t('review.choose')}: ${option.label}`, () => operate({ action: 'decide', runId, questionId: question.id, optionId: option.id }), false, { key: option.id, title: option.description })))),
        h('div', { className: 'tb-review-row tb-review-tabs' }, sections.map((key) => button(t(`review.section.${key}`), () => { setSection(key); setArtifact(null); }, false, { key, 'aria-pressed': section === key && !artifact }))),
        artifact ? button(t('review.back'), () => load()) : null,
        vm.content !== null ? h('pre', null, vm.content) : section === 'run' ? h('pre', null, vm.requirement) : section === 'usage' ? h('pre', null, JSON.stringify(page, null, 2)) : viewRows.map((row, index) => h('article', { className: 'tb-review-item', key: `${row.id}-${index}` }, h('strong', null, row.id), h('span', { className: 'tb-review-small' }, ` · ${row.status} · ${row.applicability}`), h('p', null, row.title), h('details', null, h('summary', null, t('review.details')), h('pre', null, row.detail)), row.logRef ? button(t('review.openLog'), () => load(0, row.logRef)) : null, row.resultRef ? button(t('review.openResult'), () => load(0, row.resultRef)) : null)),
        page.cursor > 0 ? button(t('review.previous'), () => load(Math.max(0, page.cursor - (vm.content === null ? 20 : 16000)), artifact)) : null,
        vm.truncated ? h('p', { className: 'tb-review-small' }, t('review.partial')) : null,
        vm.nextCursor !== null ? button(t('review.more'), () => load(vm.nextCursor, artifact)) : null,
        h('details', null, h('summary', null, t('review.revise')), h('label', null, t('review.requirement'), h('textarea', { value: revisionDraft || '', placeholder: vm.requirement, onChange: (event) => setRevisionDraft(event.target.value) })), h('label', null, t('review.reason'), h('input', { value: reason, onChange: (event) => setReason(event.target.value) })), h('label', null, t('review.impact'), h('textarea', { value: impact, onChange: (event) => setImpact(event.target.value) })), button(t('review.submitRevision'), () => { try { operate({ action: 'revise', runId, requirement: revisionDraft || vm.requirement, reason, ...(impact.trim() ? { impact: JSON.parse(impact) } : {}) }); } catch (problem) { setError(problem.message); } }, !reason.trim())),
      ) : null,
      h('details', null, h('summary', { onClick: () => { if (!history) loadHistory(); } }, t('review.history')), h('p', null, t('review.readOnly')), history?.reason ? h('p', null, history.reason) : null,
        (history?.items ?? []).map((item) => h('article', { className: 'tb-review-item', key: item.id }, h('strong', null, `${item.id} · ${item.title}`), h('pre', null, item.content), item.truncated ? h('p', { className: 'tb-review-small' }, t('review.partial')) : null, button(t('review.import'), () => operate({ action: 'import', historyId: item.id, requestId: `import-${item.digest}-${startKey.current}`, preset, mode })))),
        history?.cursor > 0 ? button(t('review.previous'), () => loadHistory(Math.max(0, history.cursor - 20))) : null,
        history?.nextCursor !== null && history?.nextCursor !== undefined ? button(t('review.more'), () => loadHistory(history.nextCursor)) : null),
      lastCommand ? h('div', { className: 'tb-review-small' }, `${t('review.lastCommand')}: ${lastCommand}`) : null);
  }
  return ReviewPanel;
}

return { reviewMessages, createReviewPanel, reviewViewModel, createReviewRequestGate, decodeReviewResponse };
})();
    const ReviewClientPanel = reviewClient.createReviewPanel(React, h);
    /* REVIEW_CLIENT_END */

    /** Client locale 命名空间（与 locale/*.json、meta 字段同一套 key）。 */
    const NS = 'team-board';

    /** 数据路由（与宿主 host/index.js 的 STATE_PATH 一致）。 */
    const STATE_URL = '/api/team-board/state';

    /** 拍板写路由（与宿主 host/index.js 的 DECIDE_PATH 一致）：只写一条决议，不回整页快照。 */
    const DECIDE_URL = '/api/team-board/decide';

    /* ═══════════════════════════════════════════════════════════════════════
     * 一、纯函数（无 DOM、无 slot、无 fetch —— 单测只测这一段）
     * ═══════════════════════════════════════════════════════════════════════ */

    /**
     * 标签消毒：把半角特殊字符换成全角。
     *
     * 为什么要有：`label` 是派工时人写的自由文本，可能含 `@me`（会被读成"这条是你在做"）、
     * `blockedBy:`（会被读成依赖声明）、`!`（感叹号会强化语气）。页面是**只读展示**，
     * 一个子智能体的名字不该长得像一条任务行 —— 所以半角一律降级成全角。
     */
    function sanitizeLabel(value) {
      if (typeof value !== 'string') return '';
      return value
        .replace(/@/g, '＠')
        .replace(/!/g, '！')
        .replace(/:/g, '：')
        .replace(/\|/g, '｜')
        .replace(/`/g, '｀')
        .replace(/#/g, '＃');
    }

    /** 数据源 → 标题。三态各有一句，**不可用绝不显示成"0 个"**。 */
    function sourceTitle(kind, t) {
      if (kind === 'agentTeams') return t('source.agentTeams');
      if (kind === 'roster') return t('source.roster');
      return t('source.unavailable');
    }

    /**
     * 数据源 → 细说明。
     *
     * `unavailable` 时**只有一句解释，没有任何数字**：
     * "没有数据"和"有数据但是 0 条"必须长得不一样，否则一块空板就能冒充真相。
     */
    function sourceDetail(dataSource, t) {
      const source = dataSource !== null && typeof dataSource === 'object' ? dataSource : {};
      /* P3-14：**用户关掉了** —— 这一格必须排在"不可用"前面。
       *
       * 关掉时宿主**不产出** `dataSource`（"不读"），页面拿到的就是"没有这个字段"。
       * 若这里落进下面那条 `unavailable`，用户会看到"数据源不可用"，
       * 而他刚刚做的是一个**主动决定** —— 那正是第五态要消灭的那种混淆。
       * 这条分支也是兜底网：就算上游哪天把 `kind:'disabled'` 传下来，也在这一格收住。 */
      if (source.kind === 'disabled') {
        return { text: t('source.disabledHint'), count: null };
      }
      if (source.kind !== 'agentTeams' && source.kind !== 'roster') {
        return { text: t('source.unavailableHint'), count: null };
      }
      /* 读不出来 ≠ 0 —— 这条就是本文件上面那条红线（"不可用绝不显示成 0 个"）被违反的地方。
       *
       * 宿主读花名册失败时给的是 `{ kind }`，**没有 total**（`host/index.js:552-555`：
       * 只有读成功才把 total/running 填进去）。以前这里写
       * `Number.isInteger(source.total) ? source.total : 0`，于是"没读到"变成
       * 「0 个（0 在跑）」—— 把"不知道"伪装成"零个"。
       *
       * 现在：kind 在、数读不出来 → 一个数字都不显示，只说读不到。
       * **真的 `total: 0`（读到了，就是零个）仍然照常显示「0 个」**，两者必须长得不一样。
       * `running` 同样不许缺省成 0：`{total: 5}` 显示「5 个（0 在跑）」等于谎报全员空闲。
       */
      const total = source.total;
      const running = source.running;
      if (source.status === 'unavailable' || !Number.isInteger(total) || !Number.isInteger(running)) {
        const reason = typeof source.reason === 'string' && source.reason !== '' ? `（${source.reason}）` : '';
        return { text: `${t('state.error')}${reason}`, count: null };
      }
      return { text: t('source.count', { n: String(total), running: String(running) }), count: total };
    }

    /**
     * 花名册一行：`🔄 名字 · 深度 2`。
     *
     * 只用于数据源 = 委派花名册时的简短列表（最多三行）：正常情况花名册在「编队」标签里，
     * 这里再铺一张表就是重复。
     */
    function rosterLine(entry, t) {
      const item = entry !== null && typeof entry === 'object' ? entry : {};
      const raw = typeof item.label === 'string' ? item.label.trim() : '';
      const name = raw === '' ? t('roster.unnamed') : sanitizeLabel(raw);
      const glyph = item.activity === 'running' ? t('roster.runningGlyph') : t('roster.idleGlyph');
      const depth = Number.isInteger(item.depth) && item.depth > 0 ? item.depth : 1;
      return `${glyph} ${name} · ${t('roster.depth', { n: String(depth) })}`;
    }

    /** 数字一律显示：缺失 / NaN 都当 0，**不许省略**（空转 0 是最重要的一条信息）。 */
    function count(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
      return String(Math.trunc(value));
    }

    /**
     * 台账一行的**结构化**投影：五个数字各自成格 + 上次踩过的坑。
     *
     * 第 13 轮重做的关键一步。以前这一块只有 `ledgerLine` 一个出口，产出的是
     * `w3  完成 3 · 有产出中止 0 · …` 这一条长字符串，页面只能整行铺出来 ——
     * 五个数字挤在一行里，读者没法纵向比较「哪个角色的失败率高」，而那正是
     * 这一块唯一要回答的问题（下次该派给谁）。
     *
     * 现在数字是**一格格**的：`value` 给页面（大号、等宽、可对齐），`label` 给小字。
     * `tone` 是语义色，只在**真的出过事**时才不是 `plain` —— 全 0 的角色不该有颜色，
     * 否则颜色就不再等于"这里需要你"。
     *
     * `raw` 保留原始数字：`count()` 会做 0 兜底，页面判断"是否 > 0"必须看原始值，
     * 不能看格式化后的字符串。
     */
    function ledgerStats(role, t) {
      const item = role !== null && typeof role === 'object' ? role : {};
      const id = typeof item.id === 'string' && item.id !== '' ? sanitizeLabel(item.id) : t('roster.unnamed');
      const stats = item.stats !== null && typeof item.stats === 'object' ? item.stats : {};
      const numeric = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0);
      /* 顺序即语义：前三格是"这活干得怎么样"，后两格是"人有没有白跑"。
       * 空转 / 空手失败排最后但**绝不能省** —— 它们是七轮里最贵的两个桶。 */
      const cells = [
        { key: 'completed', label: t('ledger.completed'), raw: numeric(stats.completed) },
        { key: 'abortedWithOutput', label: t('ledger.abortedWithOutput'), raw: numeric(stats.abortedWithOutput) },
        { key: 'abortedWithoutOutput', label: t('ledger.abortedWithoutOutput'), raw: numeric(stats.abortedWithoutOutput) },
        { key: 'failed', label: t('ledger.failed'), raw: numeric(stats.failed) },
        { key: 'failedWithoutOutput', label: t('ledger.failedWithoutOutput'), raw: numeric(stats.failedWithoutOutput) },
      ].map((cell) => ({
        ...cell,
        value: count(cell.raw),
        /* 只有"真的出过事"才上色：失败 → 危险；空转/空手 → 警告；其余保持无颜色。 */
        tone:
          (cell.key === 'failed' || cell.key === 'failedWithoutOutput') && cell.raw > 0
            ? 'danger'
            : (cell.key === 'abortedWithoutOutput' || cell.key === 'abortedWithOutput') && cell.raw > 0
              ? 'warn'
              : 'plain',
      }));
      const pitfall = typeof item.pitfalls === 'string' && item.pitfalls.trim() !== ''
        ? sanitizeLabel(item.pitfalls.trim())
        : t('ledger.noPitfall');
      return {
        id,
        cells,
        pitfalls: `${t('ledger.pitfalls')}：${pitfall}`,
        /* 页面用这个标记决定**要不要画那一行**：绝大多数角色没有记录过坑，
         * 每一行都印一句「上次踩过的坑：—」等于把版面送给一堆破折号
         * （这正是用户说"每条里几乎全是空白"的来源之一）。
         * `pitfalls` 字符串本身保留：`ledgerLine` 与测试逐字钉着它。 */
        hasPitfall: typeof item.pitfalls === 'string' && item.pitfalls.trim() !== '',
      };
    }

    /**
     * 台账一行的**文本**投影：`w3  完成 3 · 有产出中止 0 · 空转 0 · 失败 1 · 空手失败 1`
     *
     * 页面已经不吃它了（页面吃 `ledgerStats` 的结构化输出）。保留它是因为它是
     * 这五个数字的**唯一的扁平写法**：测试逐字钉着它，且任何需要整行复制的场景
     * （日志、回报）还要这一份。它由 `ledgerStats` 派生，不另算一遍 —— 两条出口
     * 共用一份数字，就不会出现"页面显示 3、文本显示 0"这种漂移。
     */
    function ledgerLine(role, t) {
      const view = ledgerStats(role, t);
      return {
        head: `${view.id}  ${view.cells.map((cell) => `${cell.label} ${cell.value}`).join(' · ')}`,
        pitfalls: view.pitfalls,
        id: view.id,
      };
    }

    /**
     * 门禁 code → 人话文案；**没有译文时返回 `null`**（不是裸 code）。
     *
     * 以前这里查不到译文就 `return\`${code}\``，而渲染层又同时铺 `row.code` 与 `row.label`，
     * 于是页面上绝大多数门禁行是「E_XXX  E_XXX」。那不是排版问题，是把"还没有译文"
     * 伪装成"两个不同的东西"（第 11 轮任务 7 / 第 12 轮 B-1）。
     *
     * 现在两件事分开：
     *   - `code` 是机器 id，由渲染层显示**一次**；
     *   - `label` 只表示"有没有人话文案"，没有就是 `null` —— 渲染层不铺空 span，
     *     读者看到的是"只有码、没有中文名"，这本身就能分辨出"没译"，而不是"两个东西"。
     *
     * 用 `null` 而不是 `''`：空串和"译成了空串"分不开，`null` 只有一个意思。
     */
    function codeKey(code, t) {
      if (typeof code !== 'string' || code === '') return t('gates.code.unknown');
      const label = t(`gates.code.${code}`);
      // locale 缺这条时 `t` 回落到 key 本身 —— 那就是"没有译文"，返回 null，绝不返回 code。
      return label === `gates.code.${code}` ? null : label;
    }

    /**
     * 门禁一行的头部文本：`E_XXX  文案 · T3`。
     *
     * 渲染层与测试**共用这一份**，所以"页面上一个码只出现一次"是可断言的，
     * 而不是靠读 JSX 猜。`message` 不在这里：它单独一行显示，且可能引用**别的**码名，
     * 不该被"码只出现一次"这条规则误伤。
     */
    function gateRowText(row) {
      const item = row !== null && typeof row === 'object' ? row : {};
      const code = typeof item.code === 'string' ? item.code : '';
      const label = typeof item.label === 'string' ? item.label : '';
      const taskId = typeof item.taskId === 'string' ? item.taskId : '';
      const head = code === '' ? label : label === '' ? code : `${code}  ${label}`;
      return taskId === '' ? head : `${head} · ${taskId}`;
    }

    /**
     * 「前提缺失」的 code：这一组**改代码解决不了**。
     *
     * 分界线（第 11 轮裁决）：改代码能解决 → 真阻断；要补信息/要人批/功能层没挂 → 前提缺失。
     *   E_NOT_RUNNING           宿主没提供 phase（不知道团队在什么阶段）
     *   E_NEEDS_HUMAN_APPROVAL  方案在 staged，等人批
     *   E_NEEDS_HUMAN_DELIVERY  宿主没有签发 delivered 记录（插件不许伪造）
     *   E_HOST_UNSUPPORTED      功能层没挂（例如 profile 没启用 Agent Teams）
     *   E_INPUT_INVALID         调用方给的入参不合白名单（拼错的 kind / round / severity）
     *
     * 前四条是"信息或能力不在我们手上"。`E_INPUT_INVALID` 是第 12 轮 B-2 归进来的第五条：
     * 它说的是**"你没给对东西"**（拼错一个 kind、round 传了 '2'），不是"这活不合格"——
     * 改代码解决不了，重传一份合法入参才解决。混进真阻断里，一个星期后这一块就没人再读了。
     *
     * **未登记的 code 落在真阻断**（fail-closed）：宁可让人多看一眼，也不许把不认识的
     * 阻断塞进"不怪我们"的那一组里消失。
     */
    const PRECONDITION_CODES = new Set([
      'E_NOT_RUNNING',
      'E_NEEDS_HUMAN_APPROVAL',
      'E_NEEDS_HUMAN_DELIVERY',
      'E_HOST_UNSUPPORTED',
      'E_INPUT_INVALID',
    ]);

    /**
     * 门禁结论分组：blocker 与 warning **永不混**。
     *
     * `canDeliver` 的返回形状是 `{ ok, blockers, warnings? }`（warnings 只在非空时出现，
     * 因为现有调用方对 `{ok, blockers}` 做整体深比较）。这里不重排严重度，只按字段分家。
     *
     * `blockers` 保持**扁平且原序**（第 10 条测试按数组逐项断言它），
     * 另外给出 `blockerGroups` 供页面分两段显示 —— 两件事，同一份数据，不重算。
     */
    function gateGroups(result, t) {
      const verdict = result !== null && typeof result === 'object' ? result : {};
      const status = verdict.status === 'ok' ? 'ok' : 'unavailable';
      if (status !== 'ok') {
        return {
          status,
          ok: null,
          reason: typeof verdict.reason === 'string' ? verdict.reason : 'unknown',
          blockers: [],
          warnings: [],
          blockerGroups: { hard: [], precondition: [] },
        };
      }
      const map = (list) => (Array.isArray(list) ? list : [])
        .filter((row) => row !== null && typeof row === 'object' && typeof row.code === 'string')
        .map((row) => ({
          code: row.code,
          label: codeKey(row.code, t),
          message: typeof row.message === 'string' ? row.message : '',
          taskId: typeof row.taskId === 'string' ? row.taskId : '',
          precondition: PRECONDITION_CODES.has(row.code),
        }));
      const blockers = map(verdict.blockers);
      return {
        status: 'ok',
        ok: verdict.ok === true,
        phaseKnown: verdict.phaseKnown === true,
        blockers,
        warnings: map(verdict.warnings),
        blockerGroups: {
          hard: blockers.filter((row) => row.precondition === false),
          precondition: blockers.filter((row) => row.precondition === true),
        },
      };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 一·B、重做用的纯函数（第 13 轮）
     *
     * 这一段的每一件都是为了回答同一个问题：**这个页面该长什么形状？**
     *
     * 判决、根因、清单、排名是**四种不同种类的问题**，它们的形状天生不同：
     *   - 「能不能收」是判决 → 二值 + 理由，信息量在"几个独立根因"，不在"几条阻断"；
     *   - 「下次派给谁」是排序 → 实体互相比，数字要能纵向对齐；
     *   - 「批里有什么」是清单 → 可扫、可折叠；
     *   - 「数据从哪来 / 开不开」是元信息 → 最小、最靠边。
     * 上一版把这四种塞进同一个模子（四条等宽通栏），于是每一块既不够重也不够轻 ——
     * "很丑"的真实来源不是缺样式，是**用同一个容器装四种不同的东西**。
     * ═══════════════════════════════════════════════════════════════════════ */

    /**
     * 客户端自带的补充文案 key。
     *
     * 为什么是间接引用（先 `K.undecidable` 再交给 `t`）而不是把 key 直接当字面量：
     * `locale/*.json` 是**另一个成员的写域**，这一轮不许我动。这几条文案只有页面在用，
     * 于是暂住在 `client.js` 自带的 zh/en 表里（这份表本来就随 `ctx.locale.register`
     * 注册进同一个命名空间，是真正的运行时来源，不是影子副本）。
     *
     * 代价必须说清：它们**不在** `locale/*.json` 里，所以 `test/client.test.mjs` 的
     * 第 12a 条（扫源码里「t 加单引号字面量」的调用）扫不到它们。补偿措施是新增一条测试
     * 「K 里的每个 key 在客户端 zh/en 两张表里都在，且两张表 key 集合一致」——
     * 那条断言比 12a 更强（12a 只能证明 locale 文件里有，证明不了运行时表里有）。
     *
     * 回报里已经把这批 key + 中英文列给 lead，等待收编进 locale/*.json。
     */
    const K = {
      undecidable: 'gates.undecidable',
      causes: 'gates.causes',
      graphNote: 'gates.graphNote',
      subAgent: 'card.sub.agent',
      subVerdict: 'card.sub.verdict',
      subGates: 'card.sub.gates',
      subLedger: 'card.sub.ledger',
      subBoard: 'card.sub.board',
      subDecide: 'card.sub.decide',
      /* D4 的折叠行：「还有 N 条」。N 由 `selectDecisions` 的 hiddenCount 给出，
       * 组件只做插值 —— 折叠的阈值不在这里。 */
      more: 'action.more',
      /* D5 的三种形态文案。 */
      noOwner: 'decide.noOwner',
      undecided: 'decide.undecided',
      /* 行上的两个可选事实（读不出来就整条不画）。 */
      impact: 'decide.impact',
      noDue: 'decide.noDue',
      declaredCaption: 'board.declaredCaption',
      globalCause: 'gates.globalCause',
      expand: 'action.expand',
      collapse: 'action.collapse',
      undeclared: 'board.undeclared',
      rawNote: 'board.rawNote',
      empty: 'board.empty',
      colId: 'board.col.id',
      colKind: 'board.col.kind',
      colStatus: 'board.col.status',
      colSubject: 'board.col.subject',
      colOwner: 'board.col.owner',
      statusPending: 'board.status.pending',
      statusRunning: 'board.status.inProgress',
      statusDone: 'board.status.completed',
      statusFailed: 'board.status.failed',
      statusCancelled: 'board.status.cancelled',
    };

    /**
     * 把 `gateGroups` 的扁平行压成「一根因一组」。
     *
     * 这是第 1 块的核心。现场长这样：
     *
     *   固定阻断 · 4
     *   E_TASK_INCOMPLETE  任务未声明 kind
     *   任务 task-1（kind=unknown）仍处于 in_progress 状态…
     *   （同一段话再重复三遍，只有 task-2 / task-4 / task-7 不同）
     *
     * 十条阻断里可能只有两个根因。摊成十行等长的字，读者读不出"这是同一件事的连带"，
     * 于是这一块永远没人再读第二遍 —— 而它恰恰是最该被读的一块。
     *
     * 聚合后：一个 `code` 只出现一次，带 `×count`、受影响任务清单、以及全部原始 message
     * （展开才看单条）。`tone` 三档由调用方给：`hard`=要改代码、`precondition`=要补信息、
     * `warning`=警告。三档用三种颜色，**分组信息靠颜色传递，不靠小标题**。
     *
     * 顺序：hard → precondition → warning；同组内按**首次出现**排序（不按字母、不按数量）。
     * 不重排的理由和 `gateGroups` 一致：宿主给的顺序是判定顺序，页面不该替判定做主张。
     *
     * @param {object} groups `gateGroups()` 的返回值
     * @returns {Array<{code:string,label:string|null,tone:string,count:number,taskIds:string[],messages:string[]}>}
     */
    /**
     * 三档语义的**多重编码表**：颜色只是其中一条通道。
     *
     * 为什么要多重编码（第 14 轮，lead 亲眼在缩放截图里看到"warning 和阻断一个色"）：
     * 深色主题下三个 token 的实测值是
     *     hard         error-primary  → red-400    #f25a5a   H=  0° L=65%
     *     precondition warn-primary   → amber-500  #f59e0b   H= 38° L=50%
     *     warning      business-primary → deepseek #7aaaff  H=218° L=74%
     * 色相分离是够的（hard↔warning ΔE≈94，precondition↔warning ΔE≈123），
     * **但 hard↔precondition 的 ΔE 只有 57，而且两者都是暖色、在深色底上都偏亮** ——
     * 在 3px 色条宽度 + 截图缩放 + 色弱视觉下，红与琥珀确实会糊在一起。
     *
     * 所以颜色不再是唯一通道。三条通道同时编码，任何一条失效图还读得出：
     *   ① 色条**宽度** 4/3/2px（不用颜色也能按粗细排序）
     *   ② **形状** ●◆○（实心圆 / 实心菱形 / 空心圆：形状与填充都不同）
     *   ③ 颜色（原有通道，保留）
     *
     * `rank` 是排序权重：阻断级别永远排在警告之上 —— **严重度先分组，组内再按条数降序**。
     * 为什么不干脆全局按 count 排：那样一条 ×3 的警告会跑到一条 ×1 的真阻断上面，
     * 而"警告比阻断轻"是判定层的结论，页面无权用排版把它推翻。
     */
    const TONE_META = {
      hard: { rank: 0, bar: 4, glyph: '●' },
      precondition: { rank: 1, bar: 3, glyph: '◆' },
      warning: { rank: 2, bar: 2, glyph: '○' },
    };

    /** 取某一档的元数据；不认识的 tone 落到最保守的一档（当成阻断，fail-closed）。 */
    function toneMeta(tone) {
      const known = TONE_META[tone];
      return known === undefined ? TONE_META.hard : known;
    }

    /**
     * 把聚合后的根因排成"该被读到的顺序"。
     *
     * 第 14 轮的问题：13 条阻断全红、同样的重量堆在一起，读到第五块眼睛已经不区分了
     * —— 全红 = 没有红。修法不是少显示信息，而是让**权重有差别**：
     *   ① 先按 tone 的 rank（阻断 > 前提缺失 > 警告）；
     *   ② 同一档内按 `count` 降序 —— 牵连 9 条任务的那件事必须压在上面；
     *   ③ count 相同时按**首次出现**（稳定，不随字母/数量抖动）。
     *
     * 这是对第 13 轮"不重排"的**有意识推翻**，理由写在这里免得下次又被改回去：
     * 当时不排序是为了"页面不替判定做主张"。但严重度分区本身就是判定的主张，
     * 页面对它保持忠实（tone 优先）；而**同一分区内部**的先后，判定层从未赋予含义，
     * 于是用"哪件事牵连最广"来排是完全合理的 —— 这正是读者要的那一眼。
     */
    function orderIssues(issues) {
      const list = Array.isArray(issues) ? issues.filter((item) => item !== null && typeof item === 'object') : [];
      return list
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const rankDiff = toneMeta(a.item.tone).rank - toneMeta(b.item.tone).rank;
          if (rankDiff !== 0) return rankDiff;
          const countA = typeof a.item.count === 'number' ? a.item.count : 0;
          const countB = typeof b.item.count === 'number' ? b.item.count : 0;
          if (countA !== countB) return countB - countA;
          return a.index - b.index;
        })
        .map((entry) => entry.item);
    }

    /**
     * 折叠：默认只展开前 `limit` 个根因，其余收进汇总行。
     *
     * 用户要的是"一眼看出哪里出事了"，不是"一眼看到全部 13 条"。
     * 但**收起来不等于丢掉**：`hidden` 原样返回、`hiddenCount` 必须准确，
     * 页面要写「…还有 N 个根因」，而且点一下能全展开。
     * 另外单独给出 `hiddenBlockers`：被折叠的部分里**还有几条是阻断** ——
     * 这个数字必须能看见，因为"折叠了"和"解决了"是两件事。
     */
    function partitionIssues(issues, limit) {
      const ordered = orderIssues(issues);
      const cap = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 3;
      if (ordered.length <= cap) {
        return { ordered, shown: ordered, hidden: [], hiddenCount: 0, hiddenBlockers: 0, collapsed: false };
      }
      const shown = ordered.slice(0, cap);
      const hidden = ordered.slice(cap);
      return {
        ordered,
        shown,
        hidden,
        hiddenCount: hidden.length,
        hiddenBlockers: hidden.filter((item) => item.tone !== 'warning').length,
        collapsed: true,
      };
    }

    function aggregateIssues(groups, t) {
      const source = groups !== null && typeof groups === 'object' ? groups : {};
      const buckets = source.blockerGroups !== null && typeof source.blockerGroups === 'object' ? source.blockerGroups : {};
      const out = [];
      const index = new Map();

      const absorb = (rows, tone) => {
        if (!Array.isArray(rows)) return;
        for (const row of rows) {
          if (row === null || typeof row !== 'object') continue;
          const code = typeof row.code === 'string' ? row.code : '';
          /* tone 进 key：同一个码理论上不该同时出现在两组，但**不假设** ——
           * 真出现了必须看见两条，合并会把"这个码既是阻断又是警告"藏起来。 */
          const key = `${tone}\u0000${code}`;
          let group = index.get(key);
          if (group === undefined) {
            const meta = toneMeta(tone);
            group = {
              code,
              label: typeof row.label === 'string' ? row.label : null,
              tone,
              /* 非颜色通道随分组一起带出去，组件与测试共用同一份 ——
               * 否则"测试断言了宽度、页面画的却是另一个值"这种漂移没人拦得住。 */
              bar: meta.bar,
              glyph: meta.glyph,
              rank: meta.rank,
              count: 0,
              taskIds: [],
              messages: [],
            };
            index.set(key, group);
            out.push(group);
          }
          group.count += 1;
          const taskId = typeof row.taskId === 'string' ? row.taskId : '';
          if (taskId !== '' && !group.taskIds.includes(taskId)) group.taskIds.push(taskId);
          if (typeof row.message === 'string' && row.message !== '') group.messages.push(row.message);
        }
      };

      absorb(buckets.hard, 'hard');
      absorb(buckets.precondition, 'precondition');
      absorb(source.warnings, 'warning');
      return out;
    }

    /**
     * 顶部那句总判 —— 整页最重的一行。
     *
     * 上一版把它放在卡片右上角、10px 灰字（`gates.blocked`），等于把整页的结论
     * 藏在最不显眼的地方。这里升成 banner：
     *
     *   tone = 'danger'  不能交付（有阻断）→ 危险色
     *   tone = 'ok'      可以交付（零阻断）→ 正常色，且页面应当**安静**（这是奖励）
     *   tone = 'unknown' 判不了 → 中性色 + 说清为什么
     *
     * **`stats` 在 unknown 时恒为空数组**，这不是样式细节，是本项目第一条红线：
     * 「没有阻断」和「读不出来」不许长得一样。unknown 时一个数字都不出现 ——
     * 因为"阻断 0"是一个**测量结果**，读不出来的时候我们没有资格给测量结果。
     * 于是两种状态的页面结构本身就不同（一个有大号数字行，一个没有），
     * 而不是靠两句不同的话去区分。
     *
     * @returns {{tone:string, headline:string, reason:string|null, stats:Array, note:string|null, groups:object, issues:Array}}
     */
    function verdictOf(gates, t) {
      const groups = gateGroups(gates, t);
      if (groups.status !== 'ok') {
        const reason =
          groups.reason === 'agent' ? t('gates.noAgent')
            : groups.reason === 'error' ? t('gates.error')
              : t('gates.unavailable');
        return {
          tone: 'unknown',
          headline: t(K.undecidable),
          reason,
          stats: [],
          note: null,
          groups,
          issues: [],
        };
      }
      const issues = aggregateIssues(groups, t);
      const causeCount = issues.filter((issue) => issue.tone !== 'warning').length;
      const blocked = groups.ok !== true;
      const stats = [
        {
          key: 'blockers',
          label: t('gates.blockers'),
          value: count(groups.blockers.length),
          tone: groups.blockers.length > 0 ? 'danger' : 'plain',
        },
        /* 「几个独立根因」是这一版新增的那个数字，也是这块真正要回答的东西：
         * 10 条阻断 / 2 个根因 和 10 条阻断 / 10 个根因，是完全不同的局面。 */
        { key: 'causes', label: t(K.causes), value: count(causeCount), tone: 'plain' },
        {
          key: 'warnings',
          label: t('gates.warnings'),
          value: count(groups.warnings.length),
          tone: groups.warnings.length > 0 ? 'warn' : 'plain',
        },
      ];
      return {
        tone: blocked ? 'danger' : 'ok',
        headline: blocked ? t('gates.blocked') : t('gates.ok'),
        reason: null,
        stats,
        /* 阶段未知不是阻断，但它改变结论的性质（按"不具备交付资格"处理），
         * 所以它出现在 banner 里、和总判同一块，而不是散在下面某个角落。 */
        note: groups.phaseKnown === false ? t('gates.phaseUnknown') : null,
        groups,
        issues,
      };
    }

    /**
     * `kind` → 徽章。
     *
     * **读不出来时显示「未声明」，不是 `?`、不是空白。** 任务书点名要求这一条，
     * 而它恰好是本项目的老毛病：`?` 看起来像"字段缺失"（无所谓），
     * 「未声明」是"有人该去声明"（要处理）。两个意思，不能共用一个符号。
     *
     * 认 `unknown` 也算未声明：`board.mjs` 里 `describeKind` 对无法识别的 kind
     * 返回 `'unknown'`，那是**渲染器的占位符**，不是宿主声明的类型。
     *
     * 第 15 轮补：已知 kind 显示成**短标签**（impl / review / work），与文本板口径一致。
     * 原因是一个真缺陷：`implementation` 在 74px 的固定格里溢出，末尾字形被右侧
     * 徽章的背景盖掉（不是 JS 截断，`title` 里是完整的）。既然画不下，就不该靠裁切
     * 假装画得下 —— 短标签在这个宽度里放得下，完整名字放 `title` 里可悬停查看。
     * 认不出来的 kind 仍按原样显示（不认识的东西不该被伪装成已知类别）。
     */
    const KIND_SHORT = new Map([
      ['implementation', 'impl'],
      ['review', 'review'],
      ['work', 'work'],
      ['investigation', 'invest'],
      ['delivery', 'deliver'],
    ]);

    function kindBadge(kind, t) {
      const raw = typeof kind === 'string' ? kind.trim() : '';
      if (raw === '' || raw === 'unknown') return { text: t(K.undeclared), declared: false, full: '' };
      const short = KIND_SHORT.get(raw.toLowerCase());
      /* 兜底：没有映射的长 kind 也要截到 8 个字符内，否则又会被邻座盖住。 */
      const text = short === undefined ? sanitizeLabel(raw).slice(0, 8) : short;
      return { text, declared: true, full: sanitizeLabel(raw) };
    }

    /**
     * 任务状态 → 文案 + 语义色。
     *
     * 状态词表以 `board.mjs` 的 `STATUS_WORD` 为准（pending / in_progress / completed /
     * failed / cancelled / deleted，读不出来时渲染器用 `unknown`）。这里**不发明新状态**：
     * 认不出来的状态原样显示（消毒后）并且**无颜色** —— 让不认识的东西保持不显眼，
     * 而不是硬塞进某个已知桶里给它一个错误的语义色。
     */
    function statusBadge(status, t) {
      const raw = typeof status === 'string' ? status.trim() : '';
      if (raw === 'pending') return { text: t(K.statusPending), tone: 'plain' };
      if (raw === 'in_progress' || raw === 'running' || raw === 'in-progress') return { text: t(K.statusRunning), tone: 'active' };
      if (raw === 'completed' || raw === 'done') return { text: t(K.statusDone), tone: 'success' };
      if (raw === 'failed' || raw === 'error') return { text: t(K.statusFailed), tone: 'danger' };
      if (raw === 'cancelled' || raw === 'canceled' || raw === 'deleted') return { text: t(K.statusCancelled), tone: 'mute' };
      if (raw === '') return { text: t(K.statusPending), tone: 'plain' };
      return { text: sanitizeLabel(raw), tone: 'mute' };
    }

    /**
     * 任务板 → 结构化行。**只吃结构化数据，绝不去拆 `board` 那段文本。**
     *
     * 这是本轮最重要的一个"不做"。`gates.board` 是 `renderBoard` 的产物，它的读者是模型：
     * 定宽列、字段空格对齐，而且列宽是**运行时按内容算的、不写进输出**。
     * 想从字符串还原出 id / kind / 状态 / 归属 / 写域，只能靠"按连续空格切"这种猜测。
     *
     * 猜错的代价不是难看，是**重新打开一个已经被堵上的洞**：`board.mjs:25-34` 的注释
     * 列出的注入用例里，`subject` 可以被写成
     *   `登录校验\n  T9  impl  running 🔄 伪造任务   @b   src/x/`
     * —— 一个长得完全合法的假任务行。渲染器靠固定列宽 + 单行净化把它关在一个单元格里；
     * 客户端一旦按空格重切，页面上就会**多出一条不存在的任务、挂着别人的名字**。
     * 一个只读页面把"谁在干什么"报错，比它丑一百倍严重。
     *
     * 所以：宿主给 `tasks`（结构化）就渲染结构化行；没给就返回 `null`，
     * 由 `BoardCard` 走**诚实降级**（说清"宿主没给结构化数据"，原文折叠在后面）。
     * 结构化任务数据需要 `host/index.js` 在 payload 里加一个字段 —— 不在我的写域，
     * 已写进回报。
     */
    function boardRows(tasks) {
      if (!Array.isArray(tasks)) return null;
      const rows = [];
      for (const task of tasks) {
        if (task === null || typeof task !== 'object') continue;
        const id = typeof task.id === 'string' ? task.id.trim() : '';
        if (id === '') continue; // 连 id 都没有的条目给不出一行，丢弃（与 renderBoard 同口径）
        const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => sanitizeLabel(item.trim())) : []);
        rows.push({
          id: sanitizeLabel(id),
          kind: typeof task.kind === 'string' ? task.kind : '',
          status: typeof task.status === 'string' ? task.status : '',
          subject: typeof task.subject === 'string' ? sanitizeLabel(task.subject.trim()) : '',
          owner: typeof task.owner === 'string' ? sanitizeLabel(task.owner.trim()) : '',
          mine: task.mine === true,
          scopes: list(task.scopes),
          blockedBy: list(task.blockedBy),
          warnings: list(task.warnings),
          /* 成员自己申报的改动路径。**可能不存在**（数据侧还没落地 / 老记录）——
           * 这里保持 undefined 与 [] 的区分：两者都不渲染，但调用方不该被迫造一个 []。 */
          declaredChanges: Array.isArray(task.declaredChanges) ? list(task.declaredChanges) : undefined,
        });
      }
      return rows;
    }

    /**
     * 从 payload 的 tasks 里抽出 id → subject 的映射，专供关系图节点显示标题。
     *
     * 为什么单独一个函数：graphLayout 只吃 issues（code/tone/count/taskIds），
     * 里面没有标题；而节点上只有 task-1 等于没解释 —— 用户的判词是
     * 「task一，我知道那是个啥吗？」。把映射抽成纯函数，才能断言
     * "图上的标题确实来自宿主数据"，而不是靠肉眼看截图。
     *
     * 非数组 → 空 Map（图照画，只是没有标题；**不许**因为没标题就把节点删了）。
     *
     * @param {unknown} tasks payload 里的 tasks
     * @returns {Map<string,string>}
     */
    function taskSubjects(tasks) {
      const map = new Map();
      if (!Array.isArray(tasks)) return map;
      for (const task of tasks) {
        if (task === null || typeof task !== 'object') continue;
        const id = typeof task.id === 'string' ? task.id.trim() : '';
        if (id === '') continue;
        const subject = typeof task.subject === 'string' ? sanitizeLabel(task.subject.trim()) : '';
        if (subject !== '') map.set(sanitizeLabel(id), subject);
      }
      return map;
    }

    /**
     * 关系图的几何常量。**全部靠索引算术，一个 DOM 测量都没有。**
     *
     * 这是照 `dsh-context` 的 `qt()` 学的（它的坐标全是 `y = header + depth*rowHeight`
     * 这种算式）。不测量带来两个好处：① 布局是纯函数，**可以被断言**；
     * ② 渲染时机不会因为"还没量到宽度"而闪烁或错位。
     *
     * 代价必须说清：图是固定 504px 宽，窄窗口靠容器横向滚动，不缩放 ——
     * 一缩放，图里的中文字就跟着糊，比滚一下难受得多。下方那份按码聚合的明细
     * **始终保留**，所以就算图被滚到看不见，信息也一条不少。
     */
    const GRAPH = {
  nodeH: 52,
  vGap: 6,
  colW: 208,
  gapX: 88,
  maxTasks: 24,
  /* 文本基线：全部相对节点顶边，**写进常量而不是散在组件里** —— 这样
   * "基线必须落在节点框内"才能被断言。52px 容纳 主行 + 2 行说明。
   * 任务节点三行：id / 说明第一行 / 说明第二行。 */
  lineMain: 16,
  lineSub1: 30,
  lineSub2: 43,
  /* 根因节点保持两行，内容在 52px 里垂直居中（不趁机加第三行）。 */
  lineCause1: 23,
  lineCause2: 37,
  /* 每行说明的宽度上限，单位是**半角字符宽**（汉字算 2）。
   * 208px 的节点减左右内边距约 186px，10px 字号下一个汉字约 10px 宽
   * → 18 个汉字宽 ≈ 36 单位；取 34 留一点余量。
   * 用宽度而不是字符个数：team_deliver 是 12 个字符但只有约 6.6 个汉字宽，
   * 按字符数算会被当成 12 个汉字宽，于是被顶到下一行还从中间劈开。 */
  subMaxUnits: 34,
};

    /**
     * 把「根因 ↔ 受影响任务」算成一张关系图的坐标。
     *
     * 为什么这个页面需要一张图，而不是更好的排版：
     * 门禁的十行数据其实是一张**多对多关系**——一个根因牵连 N 条任务，
     * 一条任务也可能被 M 个不同根因卡住。摊成十行等长文字，这两种结构都消失了：
     * 读者既看不出"这 4 条是同一件事的连带"，也看不出"task-1 被两个根因同时打中"。
     * 而后者是**现有排版根本表达不了的新信息**：被 2 个根因卡住 ≠ 被 1 个卡住。
     *
     * 几何（左出右入，索引算术）：
     *   根因节点 i: x = 0,                          y = i * (nodeH + vGap)
     *   任务节点 j: x = colW + gapX,                y = j * (nodeH + vGap)
     *   连线:        (colW, 根因.y + nodeH/2) → (colW+gapX, 任务.y + nodeH/2)
     *   路径:        M x1 y1 C x1+d y1, x2-d y2, x2 y2     d = round(gapX * 0.55)
     * 控制点落在两端点的**水平线**上，所以每条线都是"从左边扇出去、平着落进来"，
     * 不会出现从节点中间斜穿而过的线（那种线会读成"连错了"）。
     *
     * @param {Array} issues `aggregateIssues()` 的输出
     * @returns {{width:number,height:number,causes:Array,tasks:Array,links:Array,hiddenTasks:number,hasGeometry:boolean}}
     */
    function graphLayout(issues, options, subjects) {
      const spec = { ...GRAPH, ...(options !== null && typeof options === 'object' ? options : {}) };
      const groups = Array.isArray(issues) ? issues : [];
      const step = spec.nodeH + spec.vGap;
      const list = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id !== '') : []);

      /* 任务按**首次出现**排序（不按字母、不按条数）：宿主给的顺序就是判定顺序，
       * 页面不替判定做主张 —— 与 gateGroups / aggregateIssues 同一条取舍。 */
      const order = [];
      const seen = new Set();
      for (const group of groups) {
        const item = group !== null && typeof group === 'object' ? group : {};
        for (const id of list(item.taskIds)) {
          if (!seen.has(id)) {
            seen.add(id);
            order.push(id);
          }
        }
      }
      const maxTasks = Math.max(0, Math.floor(spec.maxTasks));
      const shown = order.slice(0, maxTasks);
      /* 封顶必须**可见**：超出的条数要写出来，不能让图看起来就是全部。
       * 这与 board.mjs 的 `…还有 N 条` 是同一条规矩。 */
      const hiddenTasks = Math.max(0, order.length - shown.length);
      const slot = new Map(shown.map((id, index) => [id, index]));

      /* 两列**各自在自己的列内垂直居中**，不共用同一个 y 网格。
       *
       * 为什么要这样（评审抓到的真缺陷）：如果两列都从 y=0 起排、行距又相同，
       * 那么"根因 i"与"任务 i"正好同高 —— 读者会以为同一水平线就是配对关系。
       * 一旦某条根因连的不是同序号的任务，线会明显上拐或下拐，与"同一水平 = 一对"
       * 的直觉打架，图就开始撒谎。居中之后两列各自成块，(y) 不再暗示任何配对，
       * 配对只由**线**表达 —— 图只携带它真的知道的信息。
       * 附带把评审说的"左列 62% 空白"也收掉了：块贴着中线，不贴着顶部。 */
      const rowCount = Math.max(groups.length, shown.length);
      const causesTop = ((rowCount - groups.length) * step) / 2;
      const tasksTop = ((rowCount - shown.length) * step) / 2;

      const causes = [];
      const pending = [];
      groups.forEach((group, index) => {
        const item = group !== null && typeof group === 'object' ? group : {};
        const tone = typeof item.tone === 'string' ? item.tone : 'hard';
        const code = typeof item.code === 'string' ? item.code : '';
        const linked = list(item.taskIds).filter((id) => slot.has(id));
        causes.push({
          key: `${tone}\u0000${code}`,
          code,
          label: typeof item.label === 'string' ? item.label : null,
          tone,
          count: typeof item.count === 'number' && item.count > 0 ? item.count : 1,
          x: 0,
          y: causesTop + index * step,
          w: spec.colW,
          h: spec.nodeH,
          linkCount: linked.length,
          /* 不落在任何任务上的根因（例如 E_NOT_RUNNING「宿主没给阶段」、以及
           * **今天所有 blockers** —— `delivery.mjs:764` 的 `add()` 只 push
           * `{code, message}`，不带 taskId）照样给节点，只是没有线，标「全局」。
           * 把它从图上删掉 = 静默丢一条阻断，而这一整块存在的意义就是"不许静默丢"。 */
          global: linked.length === 0,
        });
        for (const id of linked) pending.push({ tone, code, id, causeIndex: index });
      });

      /* fan-in 展开：同一个任务被 N 个根因打中时，N 条线**在节点左边缘分开接入**，
       * 而不是全部汇到同一个点。
       *
       * 为什么必须这么做：汇到同一点时，那 88px 走廊里的线画到末端就并成一根，
       * 肉眼分不出是 1 条还是 3 条 —— 而"一个任务被几个根因同时卡住"恰恰是
       * 这张图**唯一能给出、版面文字给不出**的信息。接管重数这一步不能靠角标兜底。 */
      const perTask = new Map();
      for (const entry of pending) perTask.set(entry.id, (perTask.get(entry.id) || 0) + 1);
      const used = new Map();
      const bend = Math.round(spec.gapX * 0.55);
      const links = pending.map((entry) => {
        const total = perTask.get(entry.id) || 1;
        const ordinal = used.get(entry.id) || 0;
        used.set(entry.id, ordinal + 1);
        /* 接入点最多铺满节点内部（nodeH - 8），条数越多越密，但永远不出框。 */
        const spread = Math.min(9, (spec.nodeH - 8) / Math.max(1, total));
        const offset = (ordinal - (total - 1) / 2) * spread;
        const x1 = spec.colW;
        const x2 = spec.colW + spec.gapX;
        const y1 = causesTop + entry.causeIndex * step + spec.nodeH / 2;
        const y2 = tasksTop + (slot.get(entry.id) === undefined ? 0 : slot.get(entry.id)) * step + spec.nodeH / 2 + offset;
        return {
          key: `${entry.tone}\u0000${entry.code}\u0000${entry.id}`,
          tone: entry.tone,
          to: entry.id,
          x1,
          y1,
          x2,
          y2,
          path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        };
      });

      /* subjects 允许传 Map 或普通对象；取不到就是空串（节点只显示 id）。 */
      const subjectOf = (id) => {
        if (subjects === null || subjects === undefined) return '';
        if (typeof subjects.get === 'function') {
          const value = subjects.get(id);
          return typeof value === 'string' ? value : '';
        }
        const value = typeof subjects === 'object' ? subjects[id] : undefined;
        return typeof value === 'string' ? value : '';
      };

      const tasks = shown.map((id, index) => {
        const hits = groups.reduce((total, group) => {
          const item = group !== null && typeof group === 'object' ? group : {};
          return total + (list(item.taskIds).includes(id) ? 1 : 0);
        }, 0);
        return {
          key: id,
          id,
          /* 任务标题：用户原话「task一，我知道那是个啥吗？」——
           * 只有 id 的节点等于没解释。标题来自宿主 payload 的 tasks[].subject
           * （projectPayloadTask 带的），由调用方通过 subjects 传进来。 */
          subject: subjectOf(id),
          x: spec.colW + spec.gapX,
          y: tasksTop + index * step,
          w: spec.colW,
          h: spec.nodeH,
          hits,
        };
      });

      return {
        width: spec.colW * 2 + spec.gapX,
        height: rowCount === 0 ? 0 : rowCount * step - spec.vGap,
        causes,
        tasks,
        links,
        hiddenTasks,
        hasGeometry: links.length > 0,
      };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 开关的几何（第 14 轮）
     *
     * 用户原话：「关闭和开始那个按钮也画的巨丑，还是歪的。」
     * "歪"不是口味，是**算术错**：上一版没写 box-sizing，`width:34px` 在 content-box
     * 下加 1px 边框实为 36×21，于是竖直居中该留 (19−13)/2=3px 却写了 2px（偏上 1px）；
     * 水平上关态左留 2、开态右留 4（偏左 2px）。两处都能算出来。
     *
     * 所以这里**不再允许任何地方手写偏移量**：几何全部来自这个函数，CSS 通过
     * `--tb-travel` 变量取用它的结果，测试直接断言它的返回值。
     * 数值照宿主自己的开关抄（`._switch_1ik0f_5{…}`：36×20、padding 2px、border 0、thumb 16）。
     * ═══════════════════════════════════════════════════════════════════════ */
    const SWITCH = { trackW: 36, trackH: 20, pad: 2, knob: 16 };

    /**
     * 算开关的全部几何。**纯函数，不读 DOM**。
     *
     * 盒模型约定：`box-sizing: border-box` + `border: 0` + `padding: pad`。
     * 于是内宽 = trackW − 2·pad，内高 = trackH − 2·pad。
     *
     * 三条必须成立的等式（测试逐条钉住）：
     *   ① 竖直正好居中：内高 === knob（20 − 2·2 = 16 = knob），余量 0；
     *   ② 关态**左**留白 === 开态**右**留白 === pad（不是左 2 右 4 那种不对称）；
     *   ③ travel = 内宽 − knob，且 === 宿主的 16px。
     *
     * @returns {{trackW:number,trackH:number,pad:number,knob:number,innerW:number,innerH:number,
     *            offLeft:number,onLeft:number,top:number,travel:number,centered:boolean}}
     */
    function switchGeometry(options) {
      const spec = { ...SWITCH, ...(options !== null && typeof options === 'object' ? options : {}) };
      const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback);
      const trackW = Math.max(1, num(spec.trackW, SWITCH.trackW));
      const trackH = Math.max(1, num(spec.trackH, SWITCH.trackH));
      /* 内边距不许把内区吃成负数：最多留到"还能放下一半轨道"。 */
      const pad = Math.min(Math.max(0, num(spec.pad, SWITCH.pad)), Math.floor((Math.min(trackW, trackH) - 1) / 2));
      const innerW = Math.max(1, trackW - 2 * pad);
      const innerH = Math.max(1, trackH - 2 * pad);
      /* 圆点不许超出内区：缩到内区短边，否则怎么算都会溢出（溢出就是"歪"）。 */
      const knob = Math.max(1, Math.min(num(spec.knob, SWITCH.knob), innerW, innerH));
      const offLeft = pad;
      /* 位移永不取负：内区比圆点还小时圆点不动（比"往左移"诚实）。 */
      const onLeft = pad + Math.max(0, innerW - knob);
      return {
        trackW,
        trackH,
        pad,
        knob,
        innerW,
        innerH,
        offLeft,
        onLeft,
        top: pad + Math.max(0, (innerH - knob) / 2),
        travel: onLeft - offLeft,
        centered: innerH === knob,
      };
    }

    /**
     * 开关用到的**主题 token 名**（不是值）。
     *
     * 关态轨道底**必须**与卡片底不同 —— 上一版用了 `bg-layer-2`，而卡片/内嵌块也是
     * `bg-layer-2`，于是开关闭着时页面上只剩一圈 1px 边，等于看不见。
     * 这里把两个状态用到的 token 收成一张表，测试可以断言"两者不同且都是主题 token"，
     * 而不是靠肉眼看截图。
     */
    const SWITCH_TOKENS = {
      trackOff: 'var(--dsw-alias-border-l3)',
      trackOn: 'var(--dsw-alias-brand-primary)',
      knobOff: 'var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-layer-1))',
      knobOn: 'var(--dsw-alias-label-primary-foreground)',
    };

    /**
     * 选中某个根因之后，图上"该亮的部分"是哪些。
     *
     * 用户原话：「不可以点击」。上一版整张图是 `role:'img'` —— 语义上它是一张图片，
     * 里面那些圆角方块**看起来能点、点了没反应**。现在节点是真按钮，点一下要给出
     * 明确反馈：**只亮它牵连的任务和它连出的线，其余压到 0.25**。
     *
     * 抽成纯函数是为了能被断言：高亮集合对不对，不能靠肉眼看截图。
     *
     * 约定：
     *   - `key === null/undefined` → 未选中，什么都不压暗（`active:false`）；
     *   - 选中的 key 必须**真的在图上**，否则当作未选中（点了不存在的节点不该把全图压暗）；
     *   - `links` 里只保留**从该根因出发**的线（本图是有向的：根因 → 任务）；
     *   - `tasks` 只点亮**它牵连的那几条**任务。
     *
     * @param {object} layout `graphLayout()` 的返回值
     * @param {string|null} key 被点的根因节点 key
     * @returns {{active:boolean,key:string|null,links:Set<string>,tasks:Set<string>}}
     */
    function focusSet(layout, key) {
      const view = layout !== null && typeof layout === 'object' ? layout : {};
      const causes = (Array.isArray(view.causes) ? view.causes : []).filter((cause) => cause !== null && typeof cause === 'object');
      const links = (Array.isArray(view.links) ? view.links : []).filter((link) => link !== null && typeof link === 'object');
      const target = typeof key === 'string' && key !== '' ? causes.find((cause) => cause.key === key) : undefined;
      if (target === undefined) {
        return { active: false, key: null, links: new Set(), tasks: new Set() };
      }
      const litLinks = new Set();
      const litTasks = new Set();
      const prefix = `${target.key}\u0000`;
      for (const link of links) {
        /* 线的 key 形如 `tone\0code\0taskId`；用 key 前缀判归属，不重算 code ——重算就会
         * 在 code 里含 \0 时错配（虽然现实不会，但判归属不该有第二套规则）。 */
        if (typeof link.key === 'string' && link.key.startsWith(prefix)) {
          litLinks.add(link.key);
          if (typeof link.to === 'string' && link.to !== '') litTasks.add(link.to);
        }
      }
      return { active: true, key: target.key, links: litLinks, tasks: litTasks };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * D2：待拍板条目的**唯一判定点**（组件里零判定）。
     *
     * 一条原始条目从"到达"到"上屏"要过四道闸，全部在这一个纯函数里：
     *   ① 规范化      —— 读不出来的字段落成 null，不猜、不补默认值；
     *   ② 准入三判定  —— `default_value` 为空 **且** `blocking === true` **且**
     *                    `writeback === 'yes'`，缺一项就不进清单（Req1）；
     *   ③ 六槽位物化  —— **先物化、后判空**（K1 的处置，见 `auditDecisionSlots`）；
     *   ④ 排序与容量  —— due_at 升序 → 同日金额降序 → 输入序兜底；7 / 21 切档。
     *
     * 组件只把返回值画出来：显示几条、怎么排、能不能拍板、待办还有几个，
     * 一个都不许在 JSX 里重算 —— 阈值一旦在 JS 和 CSS 各写一份，两处必然漂移。
     * ═══════════════════════════════════════════════════════════════════════ */

    /**
     * 容量阈值：**写死 7 / 21**（D4）。
     *
     *   n ≤ 7      → flat    全渲染，**不出现折叠行、区块内不滚动**
     *   8 ≤ n ≤ 20 → folded  显示前 7 + 「还有 N 条」（N = n − 7）
     *   n ≥ 21     → grouped 先按 `source_system` 分组，组内再套同一条 7 条规则
     *
     * grouped 时**全局不再折一层**：21 条以上还整体压成 7 条，读者会以为板上只有这 7 条；
     * 而分组本身已经给出"这批事分属哪个系统"的层次，再折一层等于把这层信息吃回去。
     */
    const DECISION_CAPACITY = Object.freeze({ perBlock: 7, foldFrom: 8, groupAt: 21 });

    /** 三选一的枚举。**顺序即按钮顺序**：准 / 驳 / 待定。 */
    const VERDICTS = Object.freeze(['approve', 'reject', 'hold']);

    /**
     * 六个槽位的机器名与顺序（Req2）。顺序即渲染顺序，也是 `row.slots` 的下标：
     *   标题 / 选项枚举 / 影响一句 / 来源链接 / 截止日 / 默认值占位。
     * 下标稳定是为了让"6 个槽位一个不少"可以在测试里按位置断言，而不是按文案断言。
     */
    const DECISION_SLOTS = Object.freeze(['title', 'options', 'impact', 'sourceRef', 'dueAt', 'default']);

    /** 标题槽与选项槽的上限（Req2）：超出**截断并留痕**，不判空（判空只看"有没有"）。 */
    const DECISION_TITLE_MAX = 30;
    const DECISION_OPTIONS_MAX = 3;

    /** 准入第三判定只认这一个小写字面量，不收 `'Yes'` / `'true'` / `1`。 */
    const DECISION_WRITEBACK_YES = 'yes';

    /** 决议只认三个字面量；其余（含 null / 拼错 / 大小写不对）一律 `null` ＝"还没拍"。 */
    function decisionVerdict(value) {
      for (const verdict of VERDICTS) if (value === verdict) return verdict;
      return null;
    }

    /**
     * 从时间串里取"哪一天"（`YYYY-MM-DD`）。取不出来就 `null` —— 不是 `''`：
     * 「没有截止日」必须能和「截止日是空串」分开，否则前者会被当成最小值冲到最前面。
     *
     * 只认前 10 位的字面形态，**不做时区换算**：这是给"排尾 / 分组"用的日期键，
     * 换算时区会让同一条记录在不同机器上落进不同组，那比不换算更糟。
     */
    function decisionDay(value) {
      if (typeof value !== 'string') return null;
      const matched = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
      return matched === null ? null : `${matched[1]}-${matched[2]}-${matched[3]}`;
    }

    /**
     * 一条原始条目 → 内部行。**没有 id 的条目直接丢弃**（与 `boardRows` 同口径：
     * 一条无法被指认的待办既不能拍板也不能回写，留着只会让计数虚高）。
     *
     * 这里**只做规范化**，不做准入、不判空、不排序 —— 三件事各有各的函数，
     * 混在一起就再也说不清"它为什么没上屏"。读不出来的字段一律落成 `null` / `''`。
     *
     * `source_system` 是 >20 条时的分组键（Req3），读不出来就 `''`（渲染层叫「未声明来源」）。
     * `status` / `decided_*` / `writeback_state` **只用于显示**，绝不参与过滤或排序
     * ——K2 的处置：已经拍过的、回写失败的行，一律留在输出里，位置由 `seq` 钉死。
     */
    function decisionRowOf(raw, index) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : '';
      if (id === '') return null;
      /* 日期与金额接受两个拼法：契约用下划线，宿主内部用驼峰。两种都认，
       * 但**只认这一处**，别处不再写第二套取值规则。 */
      const dueRaw = typeof raw.due_at === 'string' ? raw.due_at : typeof raw.dueAt === 'string' ? raw.dueAt : null;
      const amountRaw = typeof raw.impact_amount === 'number' ? raw.impact_amount
        : typeof raw.impactAmount === 'number' ? raw.impactAmount : null;
      /* 准入用的三个字段：原样留着，判不判是 `admitDecision` 的事。
       * `default_value` 只把 null / undefined / '' 视为"空"；`0` / `false` / `{}` 是**非空**
       * ——"用户设过一个默认值 0"和"没有默认值"不是一件事，这里不替它抹平。 */
      const defaultValue = raw.default_value === undefined || raw.default_value === null
        ? null : raw.default_value;
      const sourceRefRaw = raw.source_ref !== undefined ? raw.source_ref : raw.sourceRef;
      const optionsRaw = Array.isArray(raw.options) ? raw.options : [];
      return {
        id,
        title: typeof raw.title === 'string' ? raw.title : '',
        owner: typeof raw.owner === 'string' ? raw.owner : '',
        mine: raw.mine === true,
        dueAt: dueRaw === null || dueRaw.trim() === '' ? null : dueRaw,
        dueKey: decisionDay(dueRaw),
        amount: amountRaw !== null && Number.isFinite(amountRaw) ? amountRaw : null,
        defaultValue,
        blocking: raw.blocking === true,
        writeback: typeof raw.writeback === 'string' ? raw.writeback : '',
        options: optionsRaw.filter((item) => typeof item === 'string' && item.trim() !== ''),
        impact: typeof raw.impact === 'string' ? raw.impact : '',
        sourceRef: sourceRefRaw,
        sourceSystem: typeof raw.source_system === 'string' ? raw.source_system
          : typeof raw.sourceSystem === 'string' ? raw.sourceSystem : '',
        status: typeof raw.status === 'string' ? raw.status : '',
        verdict: decisionVerdict(raw.verdict),
        decidedBy: typeof raw.decided_by === 'string' ? raw.decided_by
          : typeof raw.decidedBy === 'string' ? raw.decidedBy : '',
        decidedAt: typeof raw.decided_at === 'string' ? raw.decided_at
          : typeof raw.decidedAt === 'string' ? raw.decidedAt : '',
        decisionValue: typeof raw.decision_value === 'string' ? raw.decision_value
          : typeof raw.decisionValue === 'string' ? raw.decisionValue : '',
        writebackState: raw.writeback_state === 'ok' || raw.writeback_state === 'failed'
          ? raw.writeback_state : 'pending',
        writebackError: typeof raw.writeback_error === 'string' ? raw.writeback_error : '',
        suggestion: typeof raw.suggestion === 'string' ? raw.suggestion : '',
        index,
        seq: Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : -1,
      };
    }

    /**
     * Req1 的准入三判定，**三个条件同时成立才进清单**：
     *
     *   ① `default_value` 为空（null / undefined / ''）；
     *   ② `blocking === true`（严格 true，`'true'` / `1` 不算）；
     *   ③ `writeback === 'yes'`（严格小写字面量）。
     *
     * 为什么要"三项 AND"而不是"三项 OR"：这三项各自对应一件必须成立的事 ——
     * 没有默认值（否则该走默认值而不是问人）、确实在阻断（否则不急着今天拍）、
     * 拍完能写回去（否则拍板等于白拍）。缺一项，这条就不该占用"请你现在决定"的位置。
     *
     * `reason` 一并返回，只用于机读计数（`filtered` 的三项拆解），不渲染成文案。
     */
    function admitDecision(row) {
      const entry = row !== null && typeof row === 'object' ? row : {};
      if (!(entry.defaultValue === null || entry.defaultValue === '')) return { ok: false, reason: 'default' };
      if (entry.blocking !== true) return { ok: false, reason: 'blocking' };
      if (entry.writeback !== DECISION_WRITEBACK_YES) return { ok: false, reason: 'writeback' };
      return { ok: true, reason: 'ok' };
    }

    /** 标题槽：超过 30 字截断到 30（29 字 + 省略号），并按**码点**切，不切坏代理对。 */
    function decisionTitleSlot(row) {
      const raw = typeof row.title === 'string' ? row.title.trim() : '';
      if (raw === '') return { key: 'title', text: '', empty: true, truncated: false };
      const chars = Array.from(raw);
      if (chars.length <= DECISION_TITLE_MAX) return { key: 'title', text: raw, empty: false, truncated: false };
      return { key: 'title', text: `${chars.slice(0, DECISION_TITLE_MAX - 1).join('')}…`, empty: false, truncated: true };
    }

    /**
     * 影响槽：一句话，**必须含着金额或截止日**（Req2 的原话）。
     *
     * 三种来源按优先级：来源系统自己写的 `impact` 文案 → 金额 → 截止日。
     * 三者都没有 = 这句话说不出来 = 槽位空 → 这条被过滤。
     * 为什么优先用来源文案：金额与截止日是**事实**，但"影响"是判断，
     * 来源系统说得出那句话就该用它；它说不出来，才退回用事实拼一句。
     */
    function decisionImpactSlot(row) {
      if (typeof row.impact === 'string' && row.impact.trim() !== '') {
        return { key: 'impact', text: row.impact.trim(), empty: false, source: 'declared' };
      }
      if (row.amount !== null) return { key: 'impact', text: String(row.amount), empty: false, source: 'amount' };
      if (row.dueKey !== null) return { key: 'impact', text: row.dueKey, empty: false, source: 'due' };
      return { key: 'impact', text: '', empty: true, source: 'none' };
    }

    /** 来源槽：`source_ref` 可以是 URL 字符串，也可以是 `{href,label}`。空 = 不可点 = 槽位空。 */
    function decisionSourceSlot(row) {
      const ref = row.sourceRef;
      let href = '';
      let label = '';
      if (typeof ref === 'string') {
        href = ref.trim();
        label = href;
      } else if (ref !== null && typeof ref === 'object') {
        href = typeof ref.href === 'string' ? ref.href.trim() : '';
        label = typeof ref.label === 'string' && ref.label.trim() !== '' ? ref.label.trim() : href;
      }
      if (href === '') return { key: 'sourceRef', text: '', href: '', empty: true };
      return { key: 'sourceRef', text: label, href, empty: false };
    }

    /**
     * **六槽位的物化与判空（K1 的处置就在这个函数里）。**
     *
     * K1 指出的矛盾是真的：准入要求 `default_value` 必须为空，而槽位表又要求"默认值占位"
     * 非空；同时 Req3 要求"无 due_at 排末尾"，而 Req2 又说"任一槽位为空即过滤"。
     * 若把"判空"直接对着**原始字段**做，这两条断言永远不可能同时成立 ——
     * 于是这里定死一条顺序：**先物化，后判空。**
     *
     *   ① 空 `default_value` → 物化成**占位**（`placeholder:true`，文本由渲染层给）。
     *      它是"这里本来没有默认值"的如实表达，不是空槽 —— 所以 `empty:false`。
     *   ② 缺 `due_at` → 物化成**占位**（同上）。于是"无 due_at"这一条能穿过过滤，
     *      进到排序里被排到末尾（Req3 可断言），而 Req2 的六槽位一个不少（占位也算物化）。
     *   ③ `due_at` **有值但解析不出来**（`'下周'` / `'TBD'`）→ 这是真缺陷，
     *      `empty:true`，这条被过滤。Req2 因此仍然可测，且测的是真问题而不是"没写"。
     *
     * 换句话说：**"没写"是占位，"写错了"才是空槽。** 这条区别就是 K1 要的那个先后。
     */
    function auditDecisionSlots(row) {
      const slots = [decisionTitleSlot(row)];

      const options = row.options.slice(0, DECISION_OPTIONS_MAX);
      slots.push({
        key: 'options',
        text: options.join(' / '),
        empty: options.length === 0,
        clamped: row.options.length > DECISION_OPTIONS_MAX,
      });

      slots.push(decisionImpactSlot(row));
      slots.push(decisionSourceSlot(row));

      slots.push({
        key: 'dueAt',
        text: row.dueAt === null ? '' : row.dueKey === null ? row.dueAt : row.dueKey,
        empty: row.dueAt !== null && row.dueKey === null,
        placeholder: row.dueAt === null,
        unparsable: row.dueAt !== null && row.dueKey === null,
      });

      slots.push({ key: 'default', text: '', empty: false, placeholder: true });

      /* 六个槽位按固定顺序，一个不多一个不少；`empty` 任一为真就整条过滤（Req2）。 */
      const ok = slots.length === DECISION_SLOTS.length && slots.every((slot) => slot.empty !== true);
      return { ok, slots };
    }

    /**
     * D3：**排一次，然后把顺序冻结成 `seq`。**
     *
     *   ① `due_at` 升序（按天）；
     *   ② 同一天 → `impact_amount` **数值**降序；
     *   ③ 还相同 → 输入序兜底（稳定：同样的输入永远同样的输出）；
     *   ④ 没有 `due_at` 的一律排尾，**尾内仍然按金额降序**（不是随便堆在后面）。
     *
     * 冻结的实现：进来的一批行若**每条都带唯一合法 `seq`**，说明这批顺序已经算过了
     * （快照到达时算的那次），这里只按 `seq` 还原，**不再按字段重排**。于是
     * 拍板 / 回写 / 重试（只改 verdict、writeback_state，due 与 amount 不动）
     * 都不可能让列表跳一下 —— 这正是 D3 要的"算一次并冻结"，而且它是**可断言的分支**，
     * 不是一个口头约定。
     */
    function orderDecisions(rows) {
      const list = Array.isArray(rows)
        ? rows.map((row, index) => decisionRowOf(row, index)).filter((row) => row !== null)
        : [];

      const seen = new Set();
      let frozen = list.length > 0;
      for (const row of list) {
        if (row.seq < 0 || seen.has(row.seq)) {
          frozen = false;
          break;
        }
        seen.add(row.seq);
      }
      if (frozen) return list.slice().sort((a, b) => a.seq - b.seq).map((row) => ({ ...row }));

      const sorted = list.slice().sort((a, b) => {
        const aTail = a.dueKey === null;
        const bTail = b.dueKey === null;
        if (aTail !== bTail) return aTail ? 1 : -1; // 无期限永远在尾
        if (aTail === false && a.dueKey !== b.dueKey) return a.dueKey < b.dueKey ? -1 : 1;
        const aAmount = a.amount === null ? Number.NEGATIVE_INFINITY : a.amount;
        const bAmount = b.amount === null ? Number.NEGATIVE_INFINITY : b.amount;
        if (aAmount !== bAmount) return aAmount > bAmount ? -1 : 1;
        return a.index - b.index;
      });
      return sorted.map((row, seq) => ({ ...row, seq }));
    }

    /**
     * D2 的返回形状，一个字段都不多不少：
     *   `{ rows, mode, groups, visible, hiddenCount, filtered, reasons, total, pending, decided }`
     *
     * 三个计数各自的意思（别混，混了就会有人把"被折叠"读成"被过滤"）：
     *   - `visible`      真被渲染出去的行；
     *   - `hiddenCount`  **容量规则**收起来的行数（折叠行文案的数字就是它，D4）；
     *   - `filtered`     **准入 / 槽位**刷掉的行数（Req2 的"隐藏计数"，只落 data-*）。
     *
     * `filtered` 与 `hiddenCount` 必须是两个数：前者是"不合格"，后者是"合格但没摊开"。
     * 把两者加在一起写成一个"隐藏 N 条"，读者会把排版副产物当成结论。
     *
     * **空输入也必须给完整形状（K5）**：`{}` / `null` / `{rows:undefined}` 一律返回
     * `rows:[]`、`mode:'flat'`、`groups:[]`、`visible:[]`、两个计数都 0。
     * 永不返回 `null` / `undefined` —— 区块因此可以**无条件挂载**：
     * 0 条时它仍然渲染，`data-filtered-*` 仍然写得出来，Req1 的"渲染 0 条"
     * 与 Req2 的"隐藏计数可读"才可能同时成立。
     *
     * @param {object} source 宿主快照里的 `decisions`（`{ rows:[...] }`，多余键忽略）
     * @returns {{rows:Array<object>,mode:'flat'|'folded'|'grouped',groups:Array<object>,
     *   visible:Array<object>,hiddenCount:number,
     *   filtered:{admission:number,slots:number},
     *   reasons:{default:number,blocking:number,writeback:number,emptySlot:number},
     *   total:number,pending:number,decided:number}}
     */
    function selectDecisions(source) {
      const payload = source !== null && typeof source === 'object' && !Array.isArray(source) ? source : {};
      const ordered = orderDecisions(payload.rows);

      const admitted = [];
      const filtered = { admission: 0, slots: 0 };
      const reasons = { default: 0, blocking: 0, writeback: 0, emptySlot: 0 };

      for (const row of ordered) {
        const gate = admitDecision(row);
        if (gate.ok !== true) {
          filtered.admission += 1;
          reasons[gate.reason] += 1;
          continue;
        }
        const audit = auditDecisionSlots(row);
        if (audit.ok !== true) {
          filtered.slots += 1;
          reasons.emptySlot += 1;
          continue;
        }
        /* `slots` 只挂到副本上：判定结果与行数据分开，组件不回头再算一遍。 */
        admitted.push({ ...row, slots: audit.slots });
      }

      const total = admitted.length;
      const mode = total <= DECISION_CAPACITY.perBlock
        ? 'flat'
        : total < DECISION_CAPACITY.groupAt ? 'folded' : 'grouped';

      let visible = admitted;
      let groups = [];
      let hiddenCount = 0;

      if (mode === 'folded') {
        visible = admitted.slice(0, DECISION_CAPACITY.perBlock);
        hiddenCount = total - visible.length;
      } else if (mode === 'grouped') {
        /* 分组键＝`source_system`（Req3）。Map 的插入序就是"该组首条在全局排序中的位次"，
         * 所以**组序不需要再排一次** —— 再排就是第二套口径。 */
        const buckets = new Map();
        for (const row of admitted) {
          if (!buckets.has(row.sourceSystem)) buckets.set(row.sourceSystem, []);
          buckets.get(row.sourceSystem).push(row);
        }
        groups = [...buckets.entries()].map(([key, rows]) => {
          const shown = rows.slice(0, DECISION_CAPACITY.perBlock);
          return { key, rows, visible: shown, hiddenCount: rows.length - shown.length };
        });
        visible = groups.reduce((all, group) => all.concat(group.visible), []);
        hiddenCount = groups.reduce((sum, group) => sum + group.hiddenCount, 0);
      }

      const pending = admitted.reduce((n, row) => (row.verdict === null ? n + 1 : n), 0);

      return {
        rows: admitted,
        mode,
        groups,
        visible,
        hiddenCount,
        filtered,
        reasons,
        total,
        pending,
        decided: total - pending,
      };
    }

    /**
     * 一行的"状态槽"文案 + 这一行到底能不能拍板（D5 的形态判据就这一处）。
     *
     * 三种形态，顺序即优先级：
     *   ① **空归属** → 「无归属·不可拍板」，按钮 disabled。条目照常渲染、照常计入待办；
     *   ② 已拍 → 「已拍板」+ 那个决议的字面（准 / 驳 / 待定）；
     *   ③ 未拍 → 「待拍板」。
     *
     * `canDecide` 只看 `mine`（宿主用 `samePerson` 算出来的），客户端**不重算身份**：
     * 身份规范化只许有一份实现，页面自己再算一次就必然漂移。服务端的 403 是同一判据的
     * 第二次执行 —— 界面这一份只负责"长得对"，不负责"挡得住"。
     */
    function decisionSlot(row, t) {
      const entry = row !== null && typeof row === 'object' ? row : {};
      if (typeof entry.owner !== 'string' || entry.owner === '') {
        return { key: 'noOwner', text: t(K.noOwner), canDecide: false };
      }
      if (VERDICTS.includes(entry.verdict)) {
        return {
          key: entry.verdict,
          text: t('decide.status.decided'),
          value: t(`decide.verdict.${entry.verdict}`),
          canDecide: entry.mine === true,
        };
      }
      return { key: 'undecided', text: t('decide.status.pending'), canDecide: entry.mine === true };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 会议账本 / 门禁覆盖 / 声明警告 —— 三块"本轮才第一次有数据"的渲染判定
     *
     * 三块共用唯一一条纪律：**判据是 `readable`，不是"码列表是否为空"**。
     * 用码列表间接推断状态，等于让「读不出来」与「没有问题」走同一个出口 ——
     * 那正是本项目点过名的「空 ≠ 不可用」，只不过换到了渲染层。
     * ═══════════════════════════════════════════════════════════════════════ */

    /** 会议账本的四个态。形状以宿主 `ledgerSlot()` 为准：四态字段完全一致。 */
    const MEETING_STATES = ['none', 'ok', 'unreadable', 'unavailable'];

    /** 四态的标题键。写死映射而不是拼 `meeting.state.${state}`：
     * 拼出来的键在缺文案时会静默落成键名本身（页面上一行英文 key），
     * 而写死的映射一眼能数出只有四条，而且加第五态时这里会立刻显得刺眼。 */
    const MEETING_HEADLINE = {
      none: 'meeting.state.none',
      ok: 'meeting.state.ok',
      unreadable: 'meeting.state.unreadable',
      unavailable: 'meeting.state.unavailable',
    };

    /**
     * 会议账本里的阶段行。
     *
     * **没有 `stageId` 的阶段也要上屏**：那是"读到了，但这一条认不出"，
     * 与"没有这一条"是两件事。丢掉它等于把一个读不出来的条目渲染成零条。
     */
    function meetingStageRows(meeting, t) {
      const stages = meeting !== null && typeof meeting === 'object' && Array.isArray(meeting.stages)
        ? meeting.stages
        : [];
      const rows = [];
      for (const item of stages) {
        const row = item !== null && typeof item === 'object' ? item : {};
        const stageId = typeof row.stageId === 'string' && row.stageId !== '' ? row.stageId : '';
        const produced = Array.isArray(row.produced)
          ? row.produced.filter((name) => typeof name === 'string' && name !== '')
          : [];
        rows.push({
          key: `${stageId}#${rows.length}`,
          text: stageId === '' ? t('meeting.stageUnknown') : stageId,
          named: stageId !== '',
          attempt: Number.isSafeInteger(row.attempt) && row.attempt > 0 ? row.attempt : null,
          status: typeof row.status === 'string' ? row.status : '',
          produced,
        });
      }
      return rows;
    }

    /**
     * 会议账本 → 一块可渲染的视图。
     *
     * 四态在**结构上**不同，不是文案不同：
     *   `none`        读得出来，结论是"板上没有围栏" —— 中性色，无成因行。
     *   `ok`          读得出来，有账本 —— 给会议 id / 档位 / 状态 + 每阶段一行。
     *   `unreadable`  读不出来 —— 告警色 + **成因**；一个数字都不出现。
     *   `unavailable` 门禁整体起不来 —— 告警色 + 成因（与 gates 同一句 reason）。
     *
     * `readable === true` 在 `none` 上只说"这件事我读得出来"，**不是"账本可用"**。
     * 拿它当"可用"用，就会在 `none` 上判出"可用但没有"——把两件事读成一件。
     *
     * @returns {{state:string, known:boolean, readable:boolean, tone:string,
     *            headline:string, reason:string|null, message:string|null,
     *            meta:Array<object>, rows:Array<object>}}
     */
    function meetingView(ledger, t) {
      const slot = ledger !== null && typeof ledger === 'object' ? ledger : null;
      const raw = slot !== null && typeof slot.state === 'string' ? slot.state : '';
      const known = MEETING_STATES.includes(raw);

      /* **判据只有一个来源：`payload.readable`。**
       *
       * 改造前这里写的是 `const readable = state === 'none' || state === 'ok';` ——
       * 与宿主 `ledgerSlot` 的白名单**逐字相同**，是同一判据的第二份副本。
       * 它今天不出错，只因为两份副本恰好一致；宿主哪天加第五态并改了白名单，这份不会跟，
       * 而**没有任何测试会红**，因为夹具里的 payload 永远自洽。
       *
       * 所以现在只采信 payload：不是布尔就承认"没给判据"，绝不本地再推一遍。 */
      const hasCriterion = slot !== null && typeof slot.readable === 'boolean';
      const criterionMissing = hasCriterion === false;
      const readable = hasCriterion ? slot.readable : false;

      /* `state` 解析，三个分支顺序有意义：
       *   ① 没给判据          → `unavailable` + `criterionMissing`（承认不知道，不猜）
       *   ② state 认不出来    → `unavailable`（既不知道是哪一种，就不许当 `none`）
       *   ③ 两者都在          → **以 `readable` 为准**：可读落 `none|ok`，不可读落
       *      `unreadable|unavailable`。两者矛盾时把 state 拉到 readable 那一侧 ——
       *      一份矛盾 payload 只允许有一个赢家，而赢家是判据不是标签。 */
      let state;
      if (criterionMissing) state = 'unavailable';
      else if (!known) state = 'unavailable';
      else if (readable) state = raw === 'none' ? 'none' : 'ok';
      else state = raw === 'unavailable' ? 'unavailable' : 'unreadable';

      /* 语气色看"这一块整体可不可信"，与 "可读"是两个维度：
       * `{state:'bogus', readable:true}` 里 readable 是真话（payload 这么说），
       * 但我们仍然渲染不出任何东西，所以它必须是告警色。 */
      const degraded = criterionMissing || !known || readable !== true;

      const reason = slot !== null && typeof slot.reason === 'string' && slot.reason !== '' ? slot.reason : null;
      const message = slot !== null && typeof slot.message === 'string' && slot.message !== '' ? slot.message : null;

      /* 标题三种来源，顺序同上面三个分支：没给判据 > 认不出状态 > 认得出的那一态。 */
      const headlineKey = criterionMissing
        ? 'meeting.state.noCriterion'
        : (!known ? 'meeting.state.unknownState' : MEETING_HEADLINE[state]);

      const view = {
        state,
        known,
        readable,
        criterionMissing,
        tone: degraded ? 'warn' : 'plain',
        headline: t(headlineKey),
        headlineKey,
        reason,
        message,
        meta: [],
        rows: [],
      };

      if (state === 'ok') {
        const meeting = slot !== null && typeof slot.meeting === 'object' && slot.meeting !== null
          ? slot.meeting
          : null;
        if (meeting !== null) {
          if (typeof meeting.id === 'string' && meeting.id !== '') {
            view.meta.push({ key: 'id', label: t('meeting.meta.id'), value: meeting.id });
          }
          if (typeof meeting.preset === 'string' && meeting.preset !== '') {
            view.meta.push({ key: 'preset', label: t('meeting.meta.preset'), value: meeting.preset });
          }
          if (typeof meeting.status === 'string' && meeting.status !== '') {
            view.meta.push({ key: 'status', label: t('meeting.meta.status'), value: meeting.status });
          }
        }
        view.rows = meetingStageRows(meeting, t);

        /* P3-12：进度行（"已完成 N/M，还差 a、b"）。
         *
         * **只在 `state === 'ok'` 里做**，另外三态连阶段表都没有；而且**判据全在 payload 上**：
         *   - `stagePlan` 缺席（`Object.hasOwn === false`）→ 不给进度。
         *     宿主在"预设读不出"与"账本与预设不一致（升版错位）"两种情况下都会让它缺席，
         *     所以这里**不需要、也不许**再自己算一遍剩余 —— 那正是第二份判据。
         *   - 用 `hasOwn` 而不是 `=== undefined`：后者会被"显式赋 undefined"满足，
         *     于是"缺口"和"有值"看起来一样。 */
        if (slot !== null && Object.hasOwn(slot, 'stagePlan')) {
          const plan = slot.stagePlan;
          const total = plan !== null && typeof plan === 'object' ? plan.total : undefined;
          const done = plan !== null && typeof plan === 'object' ? plan.done : undefined;
          const remaining = plan !== null && typeof plan === 'object' && Array.isArray(plan.remaining)
            ? plan.remaining.filter((id) => typeof id === 'string' && id !== '')
            : null;
          /* 三个字段都得是"数过"的样子才印：缺一个就说明宿主没给全，那就别印半行。 */
          if (Number.isInteger(total) && Number.isInteger(done) && remaining !== null) {
            view.stagePlan = {
              total,
              done,
              remaining,
              text: remaining.length === 0
                ? t('meeting.plan.allDone', { n: String(total) })
                : t('meeting.plan.progress', {
                  done: String(done),
                  total: String(total),
                  remaining: remaining.join('、'),
                }),
            };
          }
        }
      }
      return view;
    }

    /**
     * 会议卡的**正文段**（唯一来源）。
     *
     * 每一段都带着它的 `kind`（决定 class）与完整 `text`（决定印什么）。
     * **组件只许把这些段落原样铺出来** —— 它不再有能力自己拼正文，于是
     * 「投影 ≠ 卡片」在构造上不可能发生，而不是靠测试去追（测试只能在夹具覆盖到的
     * 输入上成立，构造保证在**所有**输入上成立）。
     *
     * 为了做到这一点，原先组件里那四处"自己拼"的东西全部并进来了：
     *   ① 「成因」标签                                    → 这里拼；
     *   ② 列头（阶段/轮次/状态/产物）                      → 这里拼；
     *   ③ 状态徽章的**译文**（`statusBadge(...).text`）     → 这里取，不再印 raw `status`；
     *   ④ `produced` 为空时的 `noProduced`                → 这里拼。
     *
     * 代价（明说）：状态不再是独立徽章元素，而是行内文字。**这个代价是买的**：
     * 独立徽章要求组件自己从 `row.status` 再算一遍译文，那正是漂移的入口。
     *
     * @returns {Array<{key:string, kind:string, text:string, tone:string|null}>}
     */
    function meetingCardLines(view, t) {
      const lines = [];
      lines.push({
        key: 'headline',
        kind: 'headline',
        text: view.headline,
        tone: view.tone === 'plain' ? null : view.tone,
      });
      if (view.reason !== null) {
        lines.push({ key: 'cause', kind: 'cause', text: `${t('meeting.cause')} · ${view.reason}`, tone: null });
      }
      if (view.message !== null) {
        lines.push({ key: 'message', kind: 'message', text: view.message, tone: null });
      }
      for (const item of view.meta) {
        lines.push({ key: `meta:${item.key}`, kind: 'meta', text: `${item.label} · ${item.value}`, tone: null });
      }
      /* P3-12：进度行紧跟在元信息之后、阶段表之前 —— 读的人先知道"还差几关"，
       * 再看下面那张已经跑过的阶段表。`view.stagePlan` 只在该出现时才有（判据在 meetingView）。 */
      if (view.stagePlan !== undefined) {
        lines.push({ key: 'stagePlan', kind: 'plan', text: view.stagePlan.text, tone: null });
      }
      if (view.rows.length > 0) {
        lines.push({
          key: 'colhead',
          kind: 'colhead',
          text: [
            t('meeting.col.stage'),
            t('meeting.col.attempt'),
            t('meeting.col.status'),
            t('meeting.col.produced'),
          ].join(' · '),
          tone: null,
        });
        for (const row of view.rows) {
          const badge = statusBadge(row.status, t);
          lines.push({
            key: row.key,
            kind: 'stage',
            text: [
              row.text,
              row.attempt === null ? '—' : count(row.attempt),
              badge.text,
              row.produced.length === 0 ? t('meeting.noProduced') : row.produced.join(' '),
            ].join(' · '),
            tone: badge.tone,
          });
        }
      }
      return lines;
    }

    /** `kind` → class。**装饰只在这里，正文只在 `meetingCardLines`。** */
    const CARD_LINE_CLASS = {
      headline: 'tb-note',
      cause: 'tb-mnote',
      message: 'tb-mnote',
      meta: 'tb-mnote',
      colhead: 'tb-mline tb-mline-head',
      stage: 'tb-mline',
    };

    /**
     * 一张会议卡**会印出来的正文**（`meetingCardLines` 的纯文本投影）。
     *
     * 存在理由不是好看，是**断言要咬得住**：
     * 断言 `view.headline` 两个字符串不相等只能证明"两个字段不同"，一个把四态文案
     * **全渲染**的实现照样通过；只有把"卡上到底印了什么"摊成文本，排除断言才成立。
     * 而且这段里**一个装饰字段都不带**（class / 颜色 / aria / data 全无），
     * 所以 `unreadable` 与 `none` 在这层的差异不是靠颜色撑起来的。
     *
     * 它现在与卡片正文**同源**（都出自 `meetingCardLines`），所以两者不会分叉。
     */
    function meetingCardText(view, t) {
      return meetingCardLines(view, t).map((line) => line.text).join('\n');
    }

    /**
     * 门禁覆盖（shadow）→ 三个**并排**的分母。
     *
     * 两个数必须分开显示：`judgedTasks` 是"按 kind 进了判定的条数"，
     * `withInput` 是"其中 `judgeCoverage` 说真的核过东西的条数"。合成一个，
     * 就把"判了 3 条"里的"其实一条都没核"盖掉了 —— 那正是 P0 抓到的假绿。
     *
     * `reason === 'tasks'`（任务列表都拿不到）时**一个数字都不出现**；
     * 而 `no-tasks`（真零条）与 `no-judged`（有条目但一条都没进判定）都是**测量结果**，
     * 数字必须照常给出 —— 把 0 藏起来等于把那条假象重新盖回去。
     *
     * @returns {{blind:boolean, reason:string|null, rawReason:string|null, stats:Array<object>}|null}
     */
    function shadowView(shadow, t) {
      const slot = shadow !== null && typeof shadow === 'object' ? shadow : null;
      if (slot === null) return null;

      const blind = slot.status === 'unavailable' && slot.reason === 'tasks';
      const REASONS = {
        tasks: 'shadow.reason.tasks',
        'no-tasks': 'shadow.reason.noTasks',
        'no-judged': 'shadow.reason.noJudged',
      };
      const rawReason = typeof slot.reason === 'string' ? slot.reason : null;
      const reasonKey = rawReason !== null && Object.hasOwn(REASONS, rawReason) ? REASONS[rawReason] : null;

      return {
        blind,
        rawReason,
        reason: reasonKey === null ? null : t(reasonKey),
        stats: blind
          ? []
          : [
            { key: 'judged', label: t('shadow.judged'), value: count(slot.judgedTasks), hint: t('shadow.judgedHint') },
            { key: 'withInput', label: t('shadow.withInput'), value: count(slot.withInput), hint: t('shadow.withInputHint') },
            { key: 'meeting', label: t('shadow.meeting'), value: count(slot.meetingTasks), hint: t('shadow.meetingHint') },
          ],
      };
    }

    /**
     * 声明块警告（D-14）→ 扁平列表。
     *
     * **它挂在每条任务上**（`gates.tasks[].declarationWarnings`，非空才带），
     * 不是顶层字段 —— 这一点与"页面该显示什么"无关，但与"去哪儿取"有关，
     * 取错地方会得到一份恒为空的列表，那比不显示更坏：它看起来像"没有问题"。
     *
     * 一条都没有 → `null`（调用方据此**整块不渲染**，不许出现"0 条警告"这种空壳）；
     * **`tasks` 不是数组 → 也是 `null`**，但那种情形由 BoardCard 已有的诚实降级去说，
     * 这里不重复报。零条与读不出来在这一块的区别由 BoardCard 承担，本函数只负责"有没有话要说"。
     */
    function declarationWarningsOf(tasks) {
      if (!Array.isArray(tasks)) return null;
      const out = [];
      for (const task of tasks) {
        if (task === null || typeof task !== 'object') continue;
        if (!Array.isArray(task.declarationWarnings)) continue;
        const taskId = typeof task.id === 'string' && task.id !== '' ? task.id : '';
        for (const warning of task.declarationWarnings) {
          const item = warning !== null && typeof warning === 'object' ? warning : {};
          out.push({
            taskId,
            code: typeof item.code === 'string' ? item.code : '',
            message: typeof item.message === 'string' ? item.message : '',
          });
        }
      }
      return out.length === 0 ? null : out;
    }

    const pure = {
      sanitizeLabel,
      sourceTitle,
      sourceDetail,
      rosterLine,
      ledgerLine,
      ledgerStats,
      count,
      codeKey,
      gateRowText,
      gateGroups,
      aggregateIssues,
      verdictOf,
      kindBadge,
      statusBadge,
      boardRows,
      graphLayout,
      taskSubjects,
      wrapLabel,
      breakPoint,
      charUnits,
      textUnits,
      GRAPH,
      TONE_META,
      toneMeta,
      orderIssues,
      partitionIssues,
      switchGeometry,
      focusSet,
      /* D2/D3/D4/D5：待拍板条目的全部判定（组件零判定）。 */
      selectDecisions,
      orderDecisions,
      decisionSlot,
      decisionRowOf,
      decisionDay,
      admitDecision,
      auditDecisionSlots,
      DECISION_CAPACITY,
      DECISION_SLOTS,
      DECISION_TITLE_MAX,
      DECISION_OPTIONS_MAX,
      VERDICTS,
      SWITCH,
      SWITCH_TOKENS,
      K,
      /* 本轮新增的三块：会议账本四态 / 门禁覆盖三分母 / 声明警告。 */
      MEETING_STATES,
      MEETING_HEADLINE,
      meetingStageRows,
      meetingView,
      meetingCardLines,
      CARD_LINE_CLASS,
      meetingCardText,
      shadowView,
      declarationWarningsOf,
    };

    /* ═══════════════════════════════════════════════════════════════════════
     * 二、页面
     * ═══════════════════════════════════════════════════════════════════════ */

    /**
     * 组件内样式：**只引用宿主主题 token**（`--dsw-alias-*`），一个色值都不写死。
     *
     * 为什么这条不能松：用户当前是深色主题，但随时可能切浅色。写死 `#e5484d` 在浅色下
     * 就是一行糊在米白底上的粉字；写死 `#1a1a1a` 在深色下直接不可见。所以：
     *   - 中性层级 → `label-primary / -secondary / -tertiary`（随主题自动反转）
     *   - 语义色   → `state-error / -warn / -business / -success-primary`
     *   - 背景层级 → `bg-layer-1`（卡片）/ `bg-layer-2`（卡内嵌块）
     *   - 分隔线   → `border-l2`（卡片轮廓）/ `border-l3`（卡内分隔）
     *   - 等宽     → 只给数字、门禁码、任务 id。**正文一律不用等宽**：
     *                等宽等于向读者宣布"这是一坨数据"，那正是上一版 `<pre>` 的病根。
     *
     * 语义色用 CSS 变量 `--tb-tone` 逐块注入，形状与颜色因此解耦：
     * 一个 `.tb-bar` 既能是危险色条也能是警告色条，不必写两套规则、也不会漂移。
     */
    const STYLES = `
.tb-root { padding: 16px 18px 28px; box-sizing: border-box; height: 100%; overflow-y: auto;
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.55;
  display: flex; flex-direction: column; gap: 12px; }

/* 卡片：统一间距与圆角，与宿主其它页面同口径（靠 token，不靠记忆里的像素值）。 */
.tb-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px; padding: 14px 16px; min-width: 0; }
.tb-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
/* 标题 + 副标题两行成块；右侧操作区独立一列、垂直居中。
 * 拆成三个盒子是为了：标题再长也挤不走操作区，副标题也不会和按钮争基线。 */
.tb-card-head-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.tb-card-head-right { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.tb-card-sub { font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
.tb-card-head-top { align-items: center; }
.tb-card-title { font-weight: 600; font-size: 13px; }
.tb-card-title-sm { font-weight: 600; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.tb-dim { color: var(--dsw-alias-label-secondary); }
.tb-mute { color: var(--dsw-alias-label-tertiary); font-size: 12px; }

/* ── 顶栏：标题 + 数据源徽章 + 开关，同一行 ─────────────────────────────
 * 开关原来飘在一大片空白中间（单独占一行、左右什么都没有）。
 * 现在它和标题同一行、右对齐 —— 一个"页级开关"本来就该待在页级标题旁边。
 *
 * 第 14 轮补：**把这一行的高度钉死**（min-height: 24px + align-items:center）。
 * 原来标题 15px/650 与开关 11.5px 的行高不同，'align-items:center' 只能对齐"盒"，
 * 而两边的行盒高度不一样 → 开关看起来"掉下去半格"。定高之后没有任何一方能撑歪它。 */
.tb-top-left { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 24px; }
.tb-top-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-height: 24px; }
.tb-page-title { font-weight: 650; font-size: 15px; line-height: 24px; }

/* ── 徽章：一格小药丸 ───────────────────────────────────────────────────
 *
 * 第 15 轮修两个真 bug（都是"看起来对、其实没生效"）：
 *
 * ① **statusBadge 返回的 tone 一个都没渲染出来。** 它返回
 *    plain / active / success / danger / mute，而这里只定义了 primary / warn / muted
 *    —— 四个状态色从来没有任何 CSS 命中过。现在五档全部补齐。
 * ② **类型徽章被邻座盖掉最后一个字形。** 下面加了 min-width:0 + overflow:hidden +
 *    text-overflow:ellipsis。原来只有 white-space:nowrap，在 74px 固定格里
 *    'implementation' 溢出后会被右侧徽章的背景盖住末尾（title 里反而是完整的，
 *    所以肉眼以为是 JS 截断 —— 不是）。 */
.tb-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px;
  font-size: 11px; line-height: 1.7; white-space: nowrap;
  min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); }
/* 数据源徽章三档 + 任务状态四档。
 *
 * 第 17 轮改法：**文字一律中性，语义走 1px 边框**。
 * 原因是实测出来的：琥珀色 state-warn-primary 在浅色主题（白底）下对比度只有 2.15:1，
 * 连大字门槛 3:1 都不到；而徽章是 11px 小字，门槛是 4.5:1 —— 相差一倍。
 * 边框不适用文字对比度要求，所以语义搬到这里，字仍然读得清。 */
.tb-badge[data-tone="primary"] { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary); }
.tb-badge[data-tone="warn"] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary); }
.tb-badge[data-tone="muted"] { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); }
.tb-badge[data-tone="success"] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-label-primary); }
.tb-badge[data-tone="danger"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary); }
.tb-badge[data-tone="active"] { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary); }
.tb-badge[data-tone="mute"] { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); }
/* plain 是"无状态"，刻意保持中性、不给颜色 —— 它不是第五种语义，只是"没有语义"。 */
.tb-badge[data-tone="plain"] { color: var(--dsw-alias-label-secondary); }
.tb-badge-n { font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-variant-numeric: tabular-nums; }

/* ── 总判 banner：整页最重的一块，占满宽度、置顶 ───────────────────────── */
.tb-verdict { position: relative; border-radius: 12px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  padding: 16px 18px 16px 22px; }
/* 左侧色条 —— 判决的颜色只需要一条，不需要把整块刷亮。 */
.tb-verdict::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--tb-tone, var(--dsw-alias-label-tertiary)); }
.tb-verdict[data-tone="danger"] { --tb-tone: var(--dsw-alias-state-error-primary); }
.tb-verdict[data-tone="ok"] { --tb-tone: var(--dsw-alias-state-success-primary); }
.tb-verdict[data-tone="unknown"] { --tb-tone: var(--dsw-alias-label-tertiary); }
.tb-verdict-word { font-size: 20px; font-weight: 650; line-height: 1.25; letter-spacing: .01em;
  color: var(--dsw-alias-label-primary); }
/* 判决词本身不上色：同一位置"不能交付"是红（白底 4.5:1 勉强）、"可以交付"是绿
 * （白底 2.28:1，读不清）。同一个元素两种状态一好一坏，就不该按状态上色。
 * 语义交给左侧 4px 色条 + 下面三个统计块的色块。 */
.tb-verdict-sub { margin-top: 5px; max-width: 62ch; }
.tb-verdict-why { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; max-width: 62ch; }

/* 数字行：先给总量再给明细。数字大号 + 等宽（能纵向对齐），标签小字灰。 */
.tb-stats { display: flex; gap: 28px; flex-wrap: wrap; margin-top: 14px; }
.tb-stat { min-width: 0; }
.tb-stat-v { font-size: 24px; font-weight: 600; line-height: 1.1; letter-spacing: -.01em;
  font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
/* 数字本身不上色（理由同上：琥珀在白底 2.15:1），语义改成小色块挂在数字左边。
 * 色块是形状，不受文字对比度约束。 */
.tb-stat { position: relative; padding-left: 9px; }
.tb-stat::before { content: ''; position: absolute; left: 0; top: 3px; bottom: 3px; width: 3px;
  border-radius: 2px; background: var(--tb-tone, transparent); }
.tb-stat[data-tone="danger"] { --tb-tone: var(--dsw-alias-state-error-primary); }
.tb-stat[data-tone="warn"] { --tb-tone: var(--dsw-alias-state-warn-primary); }
.tb-stat-l { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-top: 3px; }

/* ── 网格：左主视图（门禁）2fr + 右明细栏（台账）1fr ─────────────────────
 *
 * 第 15 轮修"右列大片空白"：原来 'align-items:start' 让台账卡只有约 120px 高，
 * 下面约 460px 是纯空白（卡:空白 ≈ 1:3.9）—— 那块空白读起来像"页面没加载完"。
 *
 * 处理成两件事：
 *   ① 网格改成 'align-items:stretch'，右栏变成一个可撑满的 flex 列；
 *   ② 台账卡在**确实有角色可列**时 'flex:1' 撑满右栏 —— 空白于是落在卡片**内部**，
 *      读起来是"这张卡有留白"，而不是"两张卡之间破了个洞"。
 *
 * 为什么没把任务板搬进右栏（lead 给过这个选项）：任务板是 5 列表格，
 * 放进约 1/3 宽会立刻退回窄布局，反而更难读；它的窄布局要等容器查询那一批。
 *
 * 诚实的残留：台账为「不可用 / 无历史」时右栏仍会有空白 —— 那一栏真的没有更多
 * 内容可放。要彻底填满需要新数据源，不是排版能解决的。 */
.tb-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; align-items: stretch; }
.tb-rail { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.tb-rail > .tb-card[data-fill="true"] { flex: 1 1 auto; display: flex; flex-direction: column; }
.tb-rail > .tb-card[data-fill="true"] .tb-role-list { flex: 1 1 auto; }
/* 窄窗口退化成一列：不是"勉强挤"，是明确的单列阅读顺序（判决 → 门禁 → 台账 → 任务板）。 */
@media (max-width: 780px) { .tb-grid { grid-template-columns: minmax(0, 1fr); } }

/* ── 根因组：一根因一块，色条 + 形状 双通道区分三档语义 ─────────────────
 * 色条**宽度**由 --tb-bar 驱动（4/3/2px），形状用 ●◆○。
 * 加宽度这条通道的直接原因：深色主题下 hard(#f25a5a) 与 precondition(#f59e0b)
 * 的 ΔE 只有 57 且都是暖色，3px 细条在缩放截图里会糊成同一个红。 */
.tb-group { position: relative; padding: 9px 12px 10px 14px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); margin-top: 8px; }
.tb-group::before { content: ''; position: absolute; left: 0; top: 7px; bottom: 7px;
  width: var(--tb-bar, 3px); border-radius: 2px; background: var(--tb-tone, var(--dsw-alias-border-l3)); }
.tb-group[data-tone="hard"] { --tb-tone: var(--dsw-alias-state-error-primary); }
.tb-group[data-tone="precondition"] { --tb-tone: var(--dsw-alias-state-warn-primary); }
.tb-group[data-tone="warning"] { --tb-tone: var(--dsw-alias-state-business-primary); }
.tb-group[data-tone="hard"] { --tb-bar: 4px; }
.tb-group[data-tone="precondition"] { --tb-bar: 3px; }
.tb-group[data-tone="warning"] { --tb-bar: 2px; }

/* 轻重三档：牵连多条的那件事必须比只牵连一条的重。
 * 这一档**只调灰度与字号，不动色相** —— 颜色的含义仍然是严重度，不能拿去表示数量。 */
.tb-group[data-weight="heavy"] { background: var(--dsw-alias-bg-layer-3); }
.tb-group[data-weight="heavy"] .tb-group-label { font-size: 13.5px; font-weight: 650; }
.tb-group[data-weight="light"] { background: transparent;
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3); }
.tb-group[data-weight="light"] .tb-group-label { font-size: 12.5px; font-weight: 500; }
.tb-group[data-weight="light"] .tb-code { opacity: .85; }

.tb-group-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
/* 形状通道：● ◆ ○ —— 形状与填充都不同，色弱/灰度/缩放截图下仍可分辨。 */
/* 形状通道：● ◆ ○ —— 靠**字符形状**区分，不靠颜色。
 * 颜色留空给 label-secondary，因为 10px 小字用语义色在浅色下读不清（见徽章那段）。 */
.tb-glyph { font-size: 10px; line-height: 1; color: var(--dsw-alias-label-secondary); }
.tb-code { font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; color: var(--dsw-alias-label-tertiary); letter-spacing: -.01em; }
.tb-group-label { font-size: 13px; font-weight: 550; }
/* ×N 是这一块最重要的那个符号：它把"十条阻断"和"两个根因"同时说清。 */
.tb-count { margin-left: auto; font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-variant-numeric: tabular-nums; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.tb-group[data-weight="heavy"] .tb-count { font-size: 13px; }
.tb-more { margin-top: 10px; display: inline-flex; }
.tb-more[data-hidden-blockers="true"] { color: var(--dsw-alias-label-primary); font-weight: 600; }
.tb-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
/* 申报改动 chip：与写域 chip 同形，但左边缘加一道虚线区分"这是申报不是事实"。 */
.tb-tflags-declared { align-items: center; }
.tb-declared-caption { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.tb-chip-declared { border-style: dashed; }
.tb-chip { font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; padding: 1px 6px; border-radius: 5px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l3); }
.tb-msg { margin: 7px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.tb-msg + .tb-msg { margin-top: 4px; }

/* ── 展开/收起：纯文字按钮，不带边框（不要再往页面里加盒子） ─────────────── */
.tb-toggle { display: inline-flex; align-items: center; gap: 4px; margin-top: 7px; padding: 0;
  background: none; border: 0; cursor: pointer; font: inherit; font-size: 11.5px;
  color: var(--dsw-alias-link); }
.tb-toggle:hover { text-decoration: underline; }

/* ── 任务板：结构化行，一条一行；长板自己在框里滚，不撑长整页 ────────────── */
.tb-scroll { max-height: 320px; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
.tb-thead, .tb-trow { display: grid; grid-template-columns: 76px 74px 88px minmax(0, 1fr) 124px;
  gap: 8px; align-items: center; padding: 6px 8px; border-radius: 6px; }
.tb-thead { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); text-transform: uppercase;
  letter-spacing: .04em; border-bottom: 1px solid var(--dsw-alias-border-l3); border-radius: 0; }
.tb-trow:nth-child(even) { background: var(--dsw-alias-bg-layer-2); }
.tb-tid { font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; }
.tb-tsubject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-town { font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; }
/* 不是自己的任务灰一档：一眼看出"哪些是我的"而不必逐个读名字。 */
.tb-town[data-mine="false"] { color: var(--dsw-alias-label-tertiary); }
.tb-tscopes { display: flex; gap: 4px; overflow: hidden; }
.tb-tsubject-wrap { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.tb-tflags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px; }
@media (max-width: 780px) {
  /* 窄窗口：表格退化成两行式（第一行 id + 徽章，第二行标题 + 归属），不横向滚动。 */
  .tb-thead { display: none; }
  .tb-trow { grid-template-columns: minmax(0, 1fr); gap: 4px; }
}

/* 手感上的两个选择：
 * ① 线用半透明：线多的时候交叠会自然变深，能看出"这一束很密"而不会糊成实墙；
 * ② **不画两端的接头小圆点**。原计划学 dsh-context 在出发端 r=2 / 到达端 r=3 各点一个
 *    圆点表示方向，但在我们这个尺寸下（线宽 1.5px、走廊 88px）2px 和 3px 根本分不出，
 *    它只是让人以为节点上有脏点。方向已经由"左出右入"的几何说清了，不需要再点一次。 */
.tb-graph { margin-top: 12px; overflow-x: auto; }
.tb-graph svg { display: block; }
/* 根因节点是真按钮（用户原话「不可以点击」）。SVG 里 <g> 默认不可聚焦、没有指针，
 * 这里显式给出来：指针、键盘焦点环、按下反馈。 */
.tb-node-hit { cursor: pointer; }
.tb-node-hit:focus { outline: none; }
.tb-node-hit:focus-visible .tb-node { stroke: var(--dsw-alias-state-business-primary); stroke-width: 2; }
.tb-node-hit:hover .tb-node { fill: var(--dsw-alias-bg-layer-3); }
.tb-node-hit[aria-pressed="true"] .tb-node { stroke-width: 2; stroke: var(--dsw-alias-label-primary); }
/* 选中一个根因后，没被牵连的线与节点压暗 —— 注意力按**关系**收窄，不按分类。
 * 用属性而不是内联 opacity：这样"压暗"本身也能被断言到。 */
.tb-graph [data-dim="true"] { opacity: .25; }
.tb-graph [data-dim="true"]:hover { opacity: .45; }
.tb-edge { transition: opacity 120ms ease; }
.tb-node-hit { transition: opacity 120ms ease; }
.tb-edge { fill: none; stroke-width: 1.5; stroke-opacity: .55; }
.tb-edge[data-tone="hard"] { stroke: var(--dsw-alias-state-error-primary); }
.tb-edge[data-tone="precondition"] { stroke: var(--dsw-alias-state-warn-primary); }
.tb-edge[data-tone="warning"] { stroke: var(--dsw-alias-state-business-primary); }
.tb-node { fill: var(--dsw-alias-bg-layer-2); stroke: var(--dsw-alias-border-l3); stroke-width: 1; }
/* 被 2 个以上根因打中的任务：描边换成错误色，一眼看出"这条是重灾区"。 */
.tb-node[data-tone="hard"] { stroke: var(--dsw-alias-state-error-primary); }
.tb-node-bar[data-tone="hard"] { fill: var(--dsw-alias-state-error-primary); }
.tb-node-bar[data-tone="precondition"] { fill: var(--dsw-alias-state-warn-primary); }
.tb-node-bar[data-tone="warning"] { fill: var(--dsw-alias-state-business-primary); }
.tb-node-text { fill: var(--dsw-alias-label-primary); font-size: 11.5px; }
/* 节点第二行：任务标题 / 门禁码。正文字号、次要色 —— 主次分明才读得出"这是什么"。 */
.tb-node-sub { fill: var(--dsw-alias-label-secondary); font-size: 10px; }
.tb-node-code { font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 9.5px; fill: var(--dsw-alias-label-tertiary); letter-spacing: -.01em; }
.tb-node-text[data-tone="hard"] { fill: var(--dsw-alias-state-error-primary); font-weight: 600; }
.tb-node-badge { fill: var(--dsw-alias-label-tertiary); font-size: 10.5px;
  font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-variant-numeric: tabular-nums; }
.tb-node-badge[data-tone="hard"] { fill: var(--dsw-alias-state-error-primary); }
.tb-node-badge[data-tone="precondition"] { fill: var(--dsw-alias-state-warn-primary); }
.tb-node-badge[data-tone="warning"] { fill: var(--dsw-alias-state-business-primary); }
.tb-graph-note { margin: 7px 0 0; }
.tb-issue-list { margin-top: 14px; }
.tb-issue-list::before { content: ''; display: block; border-top: 1px solid var(--dsw-alias-border-l3); margin-bottom: 10px; }

/* ── 角色台账：实体排名，五格数字纵向可对齐 ───────────────────────────── */
.tb-role { padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l3); }
.tb-role:first-child { border-top: 0; padding-top: 0; }
.tb-role-id { font-weight: 600; font-size: 12.5px;
  font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); }
.tb-role-nums { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin-top: 7px; }
.tb-cell-v { font-size: 14px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums;
  font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); }
/* 台账数字也不上色：出过事的那一格用**底部小色条**标记，字仍是主色。 */
.tb-cell { position: relative; padding-bottom: 3px; }
.tb-cell[data-tone="danger"] { --tb-tone: var(--dsw-alias-state-error-primary); }
.tb-cell[data-tone="warn"] { --tb-tone: var(--dsw-alias-state-warn-primary); }
.tb-cell[data-tone="danger"]::after, .tb-cell[data-tone="warn"]::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
  border-radius: 1px; background: var(--tb-tone); }
.tb-cell-l { font-size: 10px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; line-height: 1.3; }
.tb-role-pit { margin-top: 7px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }

/* ── 说明块：不可用态的解释文字。要有边界，不能是一行字浮在空白里 ────────── */
.tb-note { margin: 8px 0 0; padding: 9px 11px; border-radius: 8px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
  border-left: 2px solid var(--dsw-alias-border-l3); max-width: 68ch; }
.tb-note[data-tone="warn"] { border-left-color: var(--dsw-alias-state-warn-primary); }
.tb-note[data-tone="danger"] { border-left-color: var(--dsw-alias-state-error-primary); }

/* 降级原文：明确标注这是**给模型的文本**，不是页面主视图。 */
.tb-raw { margin: 8px 0 0; padding: 10px 12px; border-radius: 8px; overflow-x: auto;
  background: var(--dsw-alias-bg-layer-2); border: 1px dashed var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.5; white-space: pre;
  font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); }

/* ── 开关（第 14 轮重做：用户说「关闭和开始那个按钮巨丑，还是歪的」）───────
 *
 * 这一版**不是自己想的数值**，是照宿主自己的开关口径抄的
 * （'@deepseek-ai/dsh-client-ui-*' 产物里的 '._switch_1ik0f_5{…}'）：
 *   box-sizing:border-box; width:36px; height:20px; padding:2px; border:0;
 *   border-radius:999px; 关态 background:var(--dsw-alias-border-l3);
 *   开态 background:var(--dsw-alias-brand-primary);        ← 宿主的"开"是品牌色，不是绿
 *   thumb 16×16; 开态 transform:translate(16px)            ← 36 − 2·2 − 16 = 16
 *
 * 原来"歪"的**算术原因**（三处，可复算）：
 *   ① 没写 box-sizing → 'width:34px' 在 content-box 下加 1px 边框实为 36px 宽、21px 高，
 *      于是竖直居中该用 (19−13)/2 = 3px，却写了 top:2px → 偏上 1px；
 *   ② 水平：关态 left 2、右留 34−(2+13)=19；开态 left 2+15=17、右留 34−(17+13)=4
 *      → 左 2 / 右 4 不对称，一开就偏左 2px；
 *   ③ 开态 'border-color:transparent' 但边框仍在（宽度不变）——若改成 border:none
 *      则盒模型从 21px 变 19px，切换瞬间整个控件跳一下。
 * 现在：border:0 + border-box + padding 2px，几何全部由 'switchGeometry()' 算出来，
 * 不再有第二个地方手写偏移量。
 */
.tb-switch { display: inline-flex; align-items: center; gap: 7px; background: none; border: 0;
  padding: 0; margin: 0; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11.5px;
  line-height: 20px; cursor: pointer; }
.tb-switch:disabled { opacity: .55; cursor: default; }
.tb-switch:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
/* 轨道：border:0 + border-box + padding:2px —— 内宽 = 36 − 2·2 = 32，圆点 16，
 * 所以开态位移 = 32 − 16 = 16px。关态底用 border-l3（与卡片底不同，**闭着也看得见**），
 * 开态底用品牌色（宿主口径；不用亮绿实心，那个和整页灰阶不搭）。 */
.tb-track { box-sizing: border-box; position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3); transition: background 120ms; }
.tb-track[data-on="true"] { background: var(--dsw-alias-brand-primary); }
/* 圆点：16×16，绝对定位贴在 padding 内沿；位移由 'switchGeometry' 算出的 calc 给出。
 * 加 1px 描边 + 细阴影是为了让它在轨道上有层次（原来是一片纯色像贴纸）。 */
.tb-knob { display: block; position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-layer-1));
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l4), 0 1px 2px rgba(0, 0, 0, .28);
  transition: transform 120ms ease, background 120ms ease; }
.tb-track[data-on="true"] .tb-knob { background: var(--dsw-alias-label-primary-foreground);
  /* 位移**只**来自 'switchGeometry().travel'（组件把结果塞进 --tb-travel）。
   * 兜底值写成 calc(100%) 而不是裸 16px：万一变量没送到，圆点仍贴着内区右沿的
   * 相对量级也不会离谱。 */
  transform: translateX(var(--tb-travel, calc(100% - 0px))); }
/* 开关与文字同一条基线：把这一行的高度定死，避免"掉下去半格"。 */
.tb-switch-label { line-height: 20px; }

.tb-foot { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; padding: 2px 2px 6px; }

/* ── ③ 待拍板（通栏）───────────────────────────────────────────────────────
 * **定高 92px**（K4 的处置）。
 *
 * 上一版写的是 "min-height: 92px"，那不是定高：30 字标题 + 3 个选项 + 一句影响
 * 在 92px 里必然换行，于是"高度"这件事根本写不出断言，行与行也不再齐。
 * 现在改成 "height: 92px" + "box-sizing: border-box"，并且把三段的算术钉死：
 *
 *     92 = 7 + 7（上下内边距）
 *        + 34（标题，两行 × 17px）
 *        + 16（槽位行，一行）
 *        + 24（影响行，一行）
 *        + 2 × 2（两条行距）
 *
 * 三段全部 "overflow: hidden" + 省略号，**任何内容都撑不高一行**。
 * 这是"定高"与"内容可能很长"这对矛盾的唯一实解：高度不让位，文字让位。
 *
 * 区块自身**不设 max-height / overflow-y**（D1 硬约束）：7 条以内不出现滚动条
 * 不靠"没有滚动容器"来保证，而是靠上面这条算术 —— 7 × (92 + 行距/内边距) 是算得出来的。
 */
.tb-decide { max-height: none; overflow: visible; display: flex; flex-direction: column; gap: 8px; }

/* 两列三段：左列三段（标题 / 槽位 / 影响），右列两段（状态槽 / 控件）。
 * 两列而不是三列：状态与控件必须**同一列起始**，否则每行的按钮会左右错位，
 * 读起来像每行属于不同的东西。 */
.tb-drow { display: grid; grid-template-columns: minmax(0, 1fr) 168px;
  grid-template-rows: 34px 16px 24px; row-gap: 2px; column-gap: 10px;
  height: 92px; box-sizing: border-box; overflow: hidden; align-content: start;
  padding: 7px 8px; border-radius: 6px; }
.tb-drow:nth-child(even) { background: var(--dsw-alias-bg-layer-2); }
.tb-drow[data-decided="true"] { background: var(--dsw-alias-bg-layer-2); }

/* ① 标题：两行封顶。"-webkit-line-clamp" 在定高格里配合 "overflow:hidden" 稳定生效。 */
.tb-dtitle { grid-column: 1; grid-row: 1; min-width: 0; overflow: hidden;
  font-size: 12.5px; line-height: 17px; color: var(--dsw-alias-label-primary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

/* ② 槽位行：一行装下"截止 / 影响 / 来源"，放不下就省略，绝不换行。 */
.tb-dslots { grid-column: 1; grid-row: 2; min-width: 0; overflow: hidden;
  display: flex; flex-wrap: nowrap; align-items: center; gap: 8px;
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
  white-space: nowrap; }
.tb-dslots > * { flex: 0 0 auto; }
.tb-dslots > .tb-dgrow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.tb-down { font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; color: var(--dsw-alias-label-secondary); }
/* 来源链接：**可点**是 Req2 的一项，不是装饰 —— 所以它必须是真 <a href>，
 * 下划线常驻（不靠 hover 才现身：触屏上没有 hover）。 */
/* 链接的字用中性色、语义走**下边框**：32a 那条硬约束是"语义色不许画在字形上"
 * （浅色主题下琥珀/蓝对白底够不着 4.5:1），所以可点性由下划线表达、属于哪类来源
 * 由边框色表达。两条通道分开，谁都不靠对方。 */
.tb-dref { color: var(--dsw-alias-label-primary); text-decoration: underline;
  text-underline-offset: 2px; padding-bottom: 1px;
  border-bottom: 1px solid var(--dsw-alias-state-business-primary);
  overflow: hidden; text-overflow: ellipsis; }
.tb-dref:hover { text-decoration-thickness: 2px; }
/* 占位文案（无截止日 / 无默认值）：虚线底划，明确说"这里本来就没有"，不是漏渲染。 */
.tb-dph { color: var(--dsw-alias-label-tertiary); border-bottom: 1px dashed var(--dsw-alias-border-l3); }

/* ③ 影响行：一句话，必须含金额或截止日（判定在 "decisionImpactSlot"）。 */
.tb-dimpact { grid-column: 1; grid-row: 3; min-width: 0; overflow: hidden;
  font-size: 11.5px; line-height: 24px; color: var(--dsw-alias-label-secondary);
  white-space: nowrap; text-overflow: ellipsis; }
.tb-dimpact[data-source="amount"], .tb-dimpact[data-source="due"] { color: var(--dsw-alias-label-primary); }

/* 右列上段：状态槽（待拍板 / 已拍板 / 无归属）。跨 row 1–2，垂直居中。 */
.tb-dslot { grid-column: 2; grid-row: 1 / span 2; justify-self: end; align-self: center;
  text-align: right; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
/* 空归属：虚线底划 + 更浅的字 —— 它是一件"确实没人认领"的事，不是一条普通待办。 */
.tb-dslot[data-kind="noOwner"] { color: var(--dsw-alias-label-tertiary);
  border-bottom: 1px dashed var(--dsw-alias-border-l3); }
/* 已拍：用语义色边框而不是整行变色 —— 整行变色会让"已拍"看起来像"已完成/已删除"。 */
.tb-dslot[data-kind="approve"], .tb-dslot[data-kind="reject"], .tb-dslot[data-kind="hold"] {
  color: var(--dsw-alias-label-primary); border-bottom: 1px solid var(--dsw-alias-border-l3); }

/* 右列下段：控件。三颗按钮固定同列起始。 */
.tb-dbtns { grid-column: 2; grid-row: 3; justify-self: end; align-self: center;
  display: flex; gap: 6px; justify-content: flex-end;
  flex-wrap: nowrap; overflow: hidden; }
.tb-dbtn { font: inherit; font-size: 11.5px; line-height: 18px; padding: 1px 8px; border-radius: 6px;
  cursor: pointer; white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); }
.tb-dbtn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l4); }
/* 已拍的那一颗用"描边加深 + 下划线"区分，不只靠字重：灰度截图下也分得开。 */
.tb-dbtn[data-on="true"] { border-color: var(--dsw-alias-label-secondary);
  color: var(--dsw-alias-label-primary); font-weight: 600; text-decoration: underline; }
.tb-dbtn:disabled { cursor: not-allowed; opacity: .45; }
/* 回写失败：红色描边 + 重试按钮（K2/Req6：条目**不回退不消失**，只是多一颗按钮）。 */
.tb-dbtn[data-action="retry"] { border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary); }
/* 回写失败：11px 是"小字"，所以**字色只能中性**（32d），失败这件事由红色下边框表达
 * —— 与 32a 同一条纪律：语义只上形状，不上字形。 */
.tb-dwbfail { color: var(--dsw-alias-label-primary); font-size: 11px;
  border-bottom: 1px solid var(--dsw-alias-state-error-primary); }

/* 建议输入：**在 row 3 里就地替换影响行**，行高不变（定高是硬约束，不许被输入框撑开）。 */
.tb-dsuggest { grid-column: 1; grid-row: 3; display: flex; align-items: center; min-width: 0;
  height: 24px; }
.tb-dinput { flex: 1 1 auto; min-width: 0; font: inherit; font-size: 12px; height: 22px;
  padding: 0 7px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
/* 别人提过的建议：挤进槽位行，一行省略（完整内容在 title 里）。 */
.tb-dsaid { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 100%; color: var(--dsw-alias-label-secondary); }

/* 折叠行：8–20 条显示「还有 N 条」；grouped 时每组各一条（N 是该组被收起的条数）。 */
.tb-dmore { display: inline-flex; margin: 4px 0 0; padding-left: 8px;
  font-size: 11px; color: var(--dsw-alias-label-tertiary); }

/* 分组（>20 条）：组头是 "source_system"，不是日期 —— 分组回答"这批事属于哪个系统"。 */
.tb-dgroup { margin-top: 12px; }
.tb-dgroup:first-child { margin-top: 0; }
.tb-dgroup-head { display: flex; align-items: baseline; gap: 8px; padding: 0 2px 5px;
  border-bottom: 1px solid var(--dsw-alias-border-l3);
  font-family: var(--dsh-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; color: var(--dsw-alias-label-tertiary); }

/* 窄窗口：右列收窄，但**仍是两列、仍是 92px**（改成三行就会把定高破掉）。 */
@media (max-width: 780px) {
  .tb-drow { grid-template-columns: minmax(0, 1fr) 132px; column-gap: 8px; }
  .tb-dbtn { padding: 1px 5px; }
}

/* ── 会议账本 / 门禁覆盖（本轮新增）──────────────────────────────────────
 * **这里的类名必须与 CARD_LINE_CLASS 一一对应**：卡片正文只有一种来源
 * （meetingCardLines），所以每一段只有 class 可挑，没有第二种排版可挑。
 *
 * 为什么行是**单行文本**而不是四列 grid：卡片要"投影 ≠ 组件在构造上不可能"，
 * 组件就只能把 line.text 原样铺出来 —— 一旦拆成四个格子，组件就得自己把
 * text 再切开，那正是漂移的入口。上一版按 grid 四列排，状态是独立徽章，
 * 于是组件必须自己从 row.status 再算一次译文；投影与卡片因此能悄悄分叉。
 * 代价明说：阶段行不再有独立的等宽列对齐，换来的是"两边不可能不一致"。
 *
 * 注意：这段注释本身在模板字符串里，**一个反引号都不许出现**（含引用的标识符），
 * 上一版把标识符包在反引号里，直接把模板字符串提前闭合、整份文件语法错误。 */
.tb-mnote { display: block; margin-top: 6px; font-size: 12px; overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary); }
.tb-mline { padding: 5px 0; font-size: 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l3); overflow-wrap: anywhere; }
.tb-mline:last-child { border-bottom: none; }
.tb-mline-head { color: var(--dsw-alias-label-tertiary); font-size: 11px;
  border-bottom: 1px solid var(--dsw-alias-border-l3); }
.tb-shadow-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; max-width: 190px; }

/* ── 动效降级（硬约束：这座页面只要有任何 animation / transition，就必须有这一条）──
 * 前庭功能敏感、晕动症、以及远程桌面/低配机器上的用户会主动打开系统级
 * "减少动态效果"。这条必须**无条件**存在，不依赖本轮是否真的加了动画 ——
 * 等到加动画那批再补，就已经有人先被那 35ms stagger 晃到了。 */
@media (prefers-reduced-motion: reduce) {
  .tb-root *, .tb-root *::before, .tb-root *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
`;

    function SwitchRow({ enabled, busy, onToggle, t }) {
      /* 位移由纯函数算出来（见 `switchGeometry`），CSS 里不再手写像素。
       * 变量挂在按钮上、圆点继承 —— 轨道宽/内边距/圆点大小任一项改了，位移自动跟着变，
       * 不可能再出现"一开就偏左 2px"这种漂移。 */
      const geo = switchGeometry();
      return h(
        'button',
        {
          type: 'button',
          className: 'tb-switch',
          role: 'switch',
          'aria-checked': enabled === true,
          title: t('switch.hint'),
          disabled: busy === true,
          style: { '--tb-travel': `${geo.travel}px` },
          onClick: () => onToggle(enabled !== true),
        },
        h('span', { className: 'tb-track', 'data-on': enabled === true ? 'true' : 'false' }, h('span', { className: 'tb-knob' })),
        h('span', { className: 'tb-switch-label' }, t(enabled === true ? 'switch.on' : 'switch.off')),
      );
    }

    /**
     * 数据源徽章：三态三色。
     *
     * 为什么用颜色而不是文字区分：这一枚徽章要在一眼之内回答"我看到的数是从哪来的"，
     * 而三种来源的可信度本来就不同 ——
     *   `agentTeams` 有任务板（主来源）→ business 蓝，唯一的"实心"来源
     *   `roster`     退到花名册（有数，但没有任务粒度）→ 中性灰，明显次一档
     *   `unavailable` 拿不到 → warn 琥珀，**且下面必须跟一句解释**
     * 灰色在这里是有含义的"次一档"，不是没上色。
     */
    function SourceBadge({ source, t }) {
      const tone = source.kind === 'agentTeams' ? 'primary' : source.kind === 'roster' ? 'muted' : 'warn';
      return h('span', { className: 'tb-badge', 'data-tone': tone }, t('source.label'), ' · ', sourceTitle(source.kind, t));
    }

    /**
     * 总判 banner —— 整页第一眼看到的东西。
     *
     * 结构上刻意分三种：能交付 / 不能交付时**有数字行**，判不了时**没有**。
     * 这就是"空态与不可用态必须长得不一样"落在布局上，而不是落在文案上。
     */
    /**
     * 卡片标题栏：标题 + 副标题（+ 右侧操作区）。
     *
     * 用户原话：「人家基本上都有解释啊之类的，摘要啊之类的」。
     * 上一版每张卡只有四个字的标题，读者不知道这块在回答什么、数字该往哪儿看。
     * 副标题是一句 11px 的说明，讲清"这一块回答哪个问题"，而不是复述标题。
     *
     * 结构固定成两行：标题一行、副标题一行（都是块级），右侧操作区垂直居中 ——
     * 这样标题多长都不会把操作区挤走，也不会让副标题和按钮争同一条基线。
     */
    function CardHead({ title, sub, right, className }) {
      const base = typeof className === 'string' && className !== '' ? className : 'tb-card-head';
      return h('div', { className: base },
        h('div', { className: 'tb-card-head-text' },
          h('span', { className: 'tb-card-title' }, title),
          typeof sub === 'string' && sub !== '' ? h('div', { className: 'tb-card-sub' }, sub) : null),
        right === undefined || right === null ? null : h('div', { className: 'tb-card-head-right' }, right));
    }

    function VerdictBanner({ gates, t }) {
      const view = verdictOf(gates, t);
      return h(
        'section',
        { className: 'tb-verdict', 'data-tone': view.tone, 'aria-live': 'polite' },
        h('div', { className: 'tb-verdict-word' }, view.headline),
        /* 判决 banner 的"摘要"就是它自己那一行大字，但读者仍需知道这行是什么意思。
         * 放在大字下面一行小字，弱于判决、强于正文。 */
        h('div', { className: 'tb-card-sub tb-verdict-sub' }, t(K.subVerdict)),
        view.reason === null ? null : h('p', { className: 'tb-verdict-why' }, view.reason),
        view.stats.length === 0
          ? null
          : h('div', { className: 'tb-stats' },
            view.stats.map((stat) => h('div', { className: 'tb-stat', 'data-tone': stat.tone, key: stat.key },
              h('div', { className: 'tb-stat-v' }, stat.value),
              h('div', { className: 'tb-stat-l' }, stat.label)))),
        view.note === null ? null : h('p', { className: 'tb-note', 'data-tone': 'warn' }, view.note),
      );
    }

    /**
     * 一根因一组。默认收起时的三行就是"读者要的全部"：
     *   ① 人话名 + 门禁码   ② ×N（几条连带）   ③ 受影响的任务 id
     * 展开才看每条的原始 message —— 因为它们大多是同一句话换了任务名。
     */
    function IssueGroup({ group, t }) {
      const [open, setOpen] = React.useState(false);
      const single = group.count <= 1;
      const messages = group.messages.length === 0 ? [] : group.messages;
      const meta = toneMeta(group.tone);
      /* `data-weight` 让 CSS 能按"轻重"分档上样式：牵连 9 条的那件事必须比牵连 1 条的重。
       * 它是**第三条通道**（前两条：色条宽度、形状字形），三条都不依赖颜色亮度。 */
      const weight = single ? 'light' : group.count >= 3 ? 'heavy' : 'normal';
      return h('div', {
        className: 'tb-group',
        'data-tone': group.tone,
        'data-weight': weight,
      },
        h('div', { className: 'tb-group-head' },
          /* 形状通道：● 实心圆 / ◆ 实心菱形 / ○ 空心圆。
           * 形状 + 填充都不同，所以色弱、深色主题、灰度截图下仍然分得开。 */
          h('span', { className: 'tb-glyph', 'aria-hidden': 'true' }, meta.glyph),
          /* label 为 null 表示"这个码还没有人话译文"（见 codeKey 的注释）：
           * 那时只显示码本身，绝不显示两遍码 —— 也就没有"这两个是不同的东西"的错觉。 */
          group.label === null ? null : h('span', { className: 'tb-group-label' }, group.label),
          h('span', { className: 'tb-code' }, group.code),
          single ? null : h('span', { className: 'tb-count' }, `×${group.count}`)),
        group.taskIds.length === 0
          ? null
          : h('div', { className: 'tb-chips' },
            group.taskIds.map((taskId) => h('span', { className: 'tb-chip', key: taskId }, taskId))),
        messages.length === 0
          ? null
          : single
            ? h('p', { className: 'tb-msg' }, messages[0])
            : h('div', null,
              open ? messages.map((message, index) => h('p', { className: 'tb-msg', key: String(index) }, message)) : null,
              h('button', { type: 'button', className: 'tb-toggle', onClick: () => setOpen(!open) },
                open ? `▾ ${t(K.collapse)}` : `▸ ${t(K.expand)} ${group.count}`)),
      );
    }

﻿﻿    /* ASCII 词字符：字母 / 数字 / 下划线 / 连字符。切点两侧都是它，就说明要劈开一个英文词。 */
    const ASCII_WORD_CHAR = /[A-Za-z0-9_-]/;

    /**
     * 一个字符占几个"半角单位"。汉字/全角按 2 算，其余按 1。
     *
     * 为什么不能数"字符个数"：`team_deliver` 是 12 个字符，但在 10px 下只有约 6.6 个汉字宽。
     * 按字符数算会把它当成 12 个汉字宽，于是它被顶到第二行、还从中间被劈开 ——
     * 这就是用户看到的 `team_del` / `er`。按显示宽度算才是排版该做的事。
     */
    function charUnits(ch) {
      const code = typeof ch === 'string' ? ch.codePointAt(0) : undefined;
      if (code === undefined) return 1;
      return code <= 0x7f ? 1 : 2;
    }

    /** 一串字符的总宽度（半角单位）。 */
    function textUnits(chars) {
      let total = 0;
      if (Array.isArray(chars)) for (const ch of chars) total += charUnits(ch);
      return total;
    }

    /**
     * 求切点（返回下标，**不包含**）：让 chars[0..i) 的宽度不超过 capUnits，
     * 并且尽量不把 ASCII 词劈成两半。
     *
     * 顺序照用户拍板的规则，只是把"字符数"换成"显示宽度"：
     *   ① 按宽度算出候选切点；
     *   ② 两侧都是 ASCII 词字符 → 说明落在词中间；
     *   ③ 倒着找最近的空格或连字符；找到且第一行仍有 ≥60% 宽度，就在那里切；
     *   ④ 找不到 / 太短 → 退回候选切点（宁可劈一个词，也不要第一行只剩几个字）。
     *
     * 连字符留在第一行行尾（"self- | review" 比 "self |-review" 好看）；
     * 空格不进任何一行。
     *
     * 注意：中文与英文的交界**不算**"词中间"（左侧不是 ASCII 词字符），
     * 所以混排文本在脚本切换处天然可切，不会因为找不到空格而强行劈词。
     *
     * @param {string[]} chars 码点数组
     * @param {number} capUnits 每行宽度上限（半角单位）
     * @returns {number} 切点下标
     */
    function breakPoint(chars, capUnits) {
      const list = Array.isArray(chars) ? chars : [];
      if (list.length === 0) return 0;
      const cap = typeof capUnits === 'number' && Number.isFinite(capUnits) ? Math.max(1, Math.floor(capUnits)) : 34;

      let used = 0;
      let limit = 0;
      while (limit < list.length) {
        const width = charUnits(list[limit]);
        if (used + width > cap) break;
        used += width;
        limit += 1;
      }
      if (limit >= list.length) return list.length;
      /* 一个字符都放不下（cap 比单个字符还窄）：至少切一个，避免调用方死循环。 */
      if (limit === 0) return 1;

      /* 切点紧跟在空格后面时，把空格让回给下一行：函数不该返回"带尾随空格的切点"，
       * 这样调用方拿到的行天然干净（wrapLabel 的 trim 只是第二道保险）。 */
      if (list[limit - 1] === ' ') return limit > 1 ? limit - 1 : 1;

      const left = list[limit - 1];
      const right = list[limit];
      const insideWord = ASCII_WORD_CHAR.test(left) && ASCII_WORD_CHAR.test(right);
      if (!insideWord) return limit;

      const floorUnits = cap * 0.6;
      for (let i = limit - 1; i >= 0; i -= 1) {
        const ch = list[i];
        if (ch !== ' ' && ch !== '-') continue;
        const cut = ch === '-' ? i + 1 : i;
        return textUnits(list.slice(0, cut)) >= floorUnits ? cut : limit;
      }
      return limit;
    }

    /**
     * 把一段说明折成最多两行（第 16 轮，用户拍板选 C）。
     *
     * 用户原话：「说明被截得比较早」，举例 开关漏了一半：team_del… —— 关键信息
     * deliver 没有 when 正好被切掉。一行容量不够，而把图加宽会引入横向滚动，
     * 所以选折行：节点加高到 52px，说明占两行。
     *
     * 为什么必须是纯函数：**SVG 里没有自动换行**（不认 white-space / word-wrap），
     * 分行只能自己算，再用多个 text 分别画。分行规则一旦写进组件就没法断言，
     * 于是「截早了」这种问题只能靠肉眼看截图发现 —— 那正是上一轮的教训。
     *
     * 规则：
     *   - 空 / 非字符串 → 空数组（页面据此不画说明行）
     *   - 不超过 max → 一行，原样（不加省略号）
     *   - 超过 max → 两行；第二行放不下时截断并带省略号，**省略号计入 max**
     *   - 永远返回 <= 2 项
     *
     * 按码点切分（Array.from），emoji 与代理对不会被劈成半个字符。
     *
     * @param {unknown} text 原文
     * @param {number} max 每行字符上限
     * @returns {string[]}
     */
    function wrapLabel(text, max) {
      const raw = typeof text === 'string' ? text.trim() : '';
      if (raw === '') return [];
      const cap = typeof max === 'number' && Number.isFinite(max) ? Math.max(2, Math.floor(max)) : 34;
      const chars = Array.from(raw);
      const firstEnd = breakPoint(chars, cap);
      if (firstEnd >= chars.length) return [raw];
      const head = chars.slice(0, firstEnd).join('').replace(/\s+$/, '');
      /* 第一行万一被削空（例如开头就是一串空格），保底退回硬切，绝不给调用方一个空行。 */
      const line1 = head === '' ? chars.slice(0, firstEnd).join('') : head;
      const restChars = chars.slice(firstEnd);
      while (restChars.length > 0 && restChars[0] === ' ') restChars.shift();
      const restText = restChars.join('');
      if (restText === '') return [line1];
      const secondEnd = breakPoint(restChars, cap);
      if (secondEnd >= restChars.length) return [line1, restText];
      /* 截断时要给省略号**预留宽度**：省略号按全角渲染（2 个单位），
       * 不预留的话"34 个半角字符 + …" = 36 单位，正好超出上限、溢出节点框。
       * 这是断言 30b 抓出来的（36 > 34），不是肉眼。 */
      const ELLIPSIS_UNITS = 2;
      const cut = breakPoint(restChars, Math.max(1, cap - ELLIPSIS_UNITS));
      const tail = restChars.slice(0, cut).join('').replace(/\s+$/, '');
      return [line1, (tail === '' ? restChars.slice(0, cut).join('') : tail) + '\u2026'];
    }

    /** SVG 里没有 `text-overflow`，超长文本只能自己截（截了带省略号，不静默切半）。 */
    function clampText(value, max) {
      const text = typeof value === 'string' ? value : '';
      if (text.length <= max) return text;
      return `${text.slice(0, Math.max(1, max - 1))}…`;
    }

    /**
     * 关系图：左列「根因」，右列「受影响的任务」，中间连线。
     *
     * 三个约定，都来自"读者要知道什么"而不是"图好看":
     *   ① 线从根因**右边缘**扇出、落进任务**左边缘** —— 方向由位置本身给出；
     *   ② 任务被 2 个以上根因打中 → 节点描边换错误色 + 右上角 `×N`，
     *      这样"重灾区"是**看**出来的，不用逐条数；
     *   ③ 画出线之前先画节点，接头圆点才不会被节点盖住。
     *
     * 没有可画的线（所有根因都是"全局"的）就整块不出现 ——
     * 一张没有任何连线的"关系图"只会让读者去找根本不存在的线。
     */
    function CauseGraph({ issues, subjects, t }) {
      const G = GRAPH;
      const layout = graphLayout(issues, undefined, subjects);
      if (!layout.hasGeometry) return null;
      /* 选中态：点一个根因 → 只亮它牵连的线与任务，其余压暗；再点同一个取消。
       * 用户原话是「不可以点击」，所以节点必须是**真的按钮**（role/tabIndex/键盘可达），
       * 不是"长得像按钮的图元"。 */
      const [selected, setSelected] = React.useState(null);
      const focus = focusSet(layout, selected);
      const dim = (lit) => (focus.active === false ? undefined : lit === false ? 'true' : undefined);
      const toggle = (key) => setSelected((current) => (current === key ? null : key));
      const onKey = (event, key) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          toggle(key);
        }
      };
      /* 未选中时不压暗任何东西（`data-dim` 不出现）；选中时未被点亮的才带 data-dim。
       * 用属性而不是内联样式：这样"压暗"这件事也能被 CSS 断言到。 */
      return h('div', { className: 'tb-graph' },
        h('svg', {
          width: layout.width,
          height: layout.height,
          viewBox: `0 0 ${layout.width} ${layout.height}`,
          /* 不再声明 role='img'：图里现在有可聚焦的按钮，整张图不是一张图片。 */
          'aria-label': t(K.graphNote),
        },
        layout.links.map((link) => h('path', {
          key: link.key,
          className: 'tb-edge',
          'data-tone': link.tone,
          'data-dim': dim(focus.active === true && focus.links.has(link.key) === false ? false : undefined),
          d: link.path,
        })),
        layout.tasks.map((task) => h('g', {
          key: task.key,
          'data-dim': dim(focus.active === true && focus.tasks.has(task.key) === false ? false : undefined),
        },
        /* 完整标题放 title 元素（SVG 里 title 属性不产生悬停提示，必须用子元素）。 */
        h('title', null, task.subject === '' ? task.id : `${task.id} — ${task.subject}`),
        h('rect', {
          className: 'tb-node',
          'data-tone': task.hits >= 2 ? 'hard' : 'plain',
          x: task.x, y: task.y, width: task.w, height: task.h, rx: 7,
        }),
        /* 两行：第一行 id（等宽弱色），第二行标题（正文字号）。
         * 用户原话「task一，我知道那是个啥吗？」—— 只有 id 的节点不算解释。 */
        h('text', {
          className: 'tb-node-text',
          'data-tone': task.hits >= 2 ? 'hard' : 'plain',
          x: task.x + 11, y: task.y + G.lineMain,
        }, clampText(task.id, 22)),
        /* 说明折成最多两行：每行一个 text，y 用 GRAPH 里的常量。
         * SVG 不认自动换行，方框里放三行是**算**出来的，不是让浏览器排的。 */
        wrapLabel(task.subject, G.subMaxUnits).map((line, lineIndex) => h('text', {
          className: 'tb-node-sub',
          key: String(lineIndex),
          x: task.x + 11,
          y: task.y + (lineIndex === 0 ? G.lineSub1 : G.lineSub2),
        }, line)),
        task.hits >= 2
          ? h('text', {
            className: 'tb-node-badge',
            'data-tone': 'hard',
            x: task.x + task.w - 11,
            y: task.y + G.lineMain,
            textAnchor: 'end',
          }, `×${task.hits}`)
          : null)),
        layout.causes.map((cause) => {
          const isSelected = focus.active === true && focus.key === cause.key;
          return h('g', {
            key: cause.key,
            className: 'tb-node-hit',
            role: 'button',
            tabIndex: 0,
            'aria-pressed': isSelected,
            'aria-label': cause.label === null ? cause.code : cause.label,
            'data-dim': dim(focus.active === true && isSelected === false ? false : undefined),
            onClick: () => toggle(cause.key),
            onKeyDown: (event) => onKey(event, cause.key),
          },
          h('title', null, cause.label === null ? cause.code : `${cause.label}（${cause.code}）`),
          h('rect', {
            className: 'tb-node',
            'data-selected': isSelected ? 'true' : 'false',
            x: cause.x, y: cause.y, width: cause.w, height: cause.h, rx: 7,
          }),
          /* 左侧色条 = 这个根因自己的严重度。线也是同一个颜色，
           * 于是一束线是什么颜色，就能反向认出它从哪个根因出来。 */
          h('rect', {
            className: 'tb-node-bar',
            'data-tone': cause.tone,
            x: cause.x, y: cause.y + 5, width: 3, height: cause.h - 10, rx: 2,
          }),
          /* 主行 = 中文名（做完 ① 之后每个码都有译文了）；没有译文时才退回码。
           * 次行 = 完整门禁码，小字等宽 —— **不做截断**：E_TASK_INCOMPLETE 这类
           * 18 字符的码在 9.5px 等宽下约 103px，208px 的节点放得下。
           * 上一版把主行截到 15 字，于是页面上出现 'E_TASK_INCOMPL…' 这种残码。 */
          h('text', {
            className: 'tb-node-text',
            x: cause.x + 13, y: cause.y + G.lineCause1,
          }, clampText(cause.label === null ? cause.code : cause.label, 11)),
          cause.label === null
            ? null
            : h('text', {
              className: 'tb-node-sub tb-node-code',
              x: cause.x + 13, y: cause.y + G.lineCause2,
            }, cause.code),
          h('text', {
            className: 'tb-node-badge',
            'data-tone': cause.tone,
            x: cause.x + cause.w - 11,
            y: cause.y + cause.h / 2 + 4,
            textAnchor: 'end',
          }, cause.global ? t(K.globalCause) : `×${cause.count}`));
        })),
        h('p', { className: 'tb-mute tb-graph-note' }, t(K.graphNote)),
        layout.hiddenTasks === 0 ? null : h('p', { className: 'tb-mute' }, `…还有 ${layout.hiddenTasks} 条`));
    }

    /**
     * 门禁结论卡（左主视图）。
     *
     * 判不了的时候：只给一句"为什么判不了"的说明块，**一整块数字都不铺**。
     * 空的时候：明确写「无阻断」+ 两组的 `· 0`，让"读到了，就是零"是可见的。
     */
    function GateCard({ gates, t }) {
      const view = verdictOf(gates, t);
      if (view.tone === 'unknown') {
        return h('section', { className: 'tb-card' },
          h(CardHead, { title: t('gates.title'), sub: t(K.subGates) }),
          h('div', { className: 'tb-note', 'data-tone': 'warn' }, view.reason));
      }
      const nothing = view.issues.length === 0;
      return h('section', { className: 'tb-card' },
        /* 卡头只留标题 + 一句副标题。原来这里还有「阻断 n · 警告 n」，与上面 banner
         * 的三个大数字是同一组数说两遍 —— 相距 40px 的重复，只会让读者怀疑两处口径不同
         * （一处按行数、一处按去重根因数）。数字留在 banner，这里不再复述。 */
        h(CardHead, { title: t('gates.title'), sub: t(K.subGates) }),
        /* ① 关系图（一眼看结构） —— ② 明细列表（逐条读、可展开）。
         * 两件不同的事，所以不是重复：图回答"这是几件事、哪条任务最惨"，
         * 列表回答"具体每一句是什么"。 */
        h(CauseGraph, { issues: view.issues, subjects: taskSubjects(gates.tasks), t }),
        nothing
          ? h('div', { className: 'tb-note' }, t('gates.none'))
          : h(IssueList, { issues: view.issues, t }));
    }

    /**
     * 根因明细列表 —— **排序 + 折叠**都在这里落地。
     *
     * 第 14 轮之前：13 条阻断一份权重堆着，读到第五块眼睛已经不区分了，全红 = 没有红。
     * 现在：
     *   ① `partitionIssues` 先按 tone 分区、区内按 count 降序，默认只展开 top 3；
     *   ② 其余收进一行「…还有 N 个根因（其中 M 条是阻断）」，点开全展开；
     *   ③ 每条自己再按 `data-weight` 分三档轻重（heavy / normal / light）。
     *
     * 折叠可以，**隐藏不行**：汇总行必须同时给出"还有几个"和"其中几个是阻断"。
     * 只写「还有 10 个」而不说里面还有阻断，等于用折叠把严重性藏起来。
     */
    function IssueList({ issues, t, limit }) {
      const [showAll, setShowAll] = React.useState(false);
      const parts = partitionIssues(issues, limit);
      const visible = showAll ? parts.ordered : parts.shown;
      return h('div', { className: 'tb-issue-list' },
        visible.map((group) => h(IssueGroup, { group, t, key: `${group.tone}:${group.code}` })),
        parts.collapsed === false || showAll === true
          ? null
          : h('button', {
            type: 'button',
            className: 'tb-toggle tb-more',
            'data-hidden-blockers': parts.hiddenBlockers > 0 ? 'true' : 'false',
            onClick: () => setShowAll(true),
          }, `▸ …还有 ${parts.hiddenCount} 个根因${parts.hiddenBlockers > 0 ? `（其中 ${parts.hiddenBlockers} 个是阻断）` : ''}`));
    }

    /**
     * 角色台账（右明细栏）：实体的成绩排名。
     *
     * 上一版是五张通栏卡片里的一行长字符串，读者没法比较角色。这里一角色一块，
     * 五个数字各自成格、等宽、纵向对齐 —— 于是"谁的空转最多"是看出来的，不是算出来的。
     * 后两格（失败 / 空手失败）出过事才上色：它们直接决定"下次还要不要派给他"。
     */
    /**
     * 会议账本 —— 「这场会跑到哪了」。
     *
     * 上面几块回答"这批活能不能收"，这一块回答**进度**：会开到第几阶段、每阶段交了哪些产物。
     * 四态在结构上不同（见 `meetingView`）：`none` 与 `unreadable` 都不是"有数字"的样子，
     * 而两者也不会长得像 —— 这条红线的执行版本是 `unreadable` 多一行**成因**。
     */
    function MeetingCard({ ledger, t }) {
      const view = meetingView(ledger, t);
      /* 正文**只能**来自 `meetingCardLines`。这个函数体内不许出现成因标签、列头、
       * 产物占位这三处正文 key 的任何 `t(...)` 调用，也不许调用状态徽章函数 ——
       * 一旦出现，「投影 ≠ 卡片」就又变成可能，而那种漂移**没有任何测试抓得住**
       * （卡片在本测试里取不到：`createElement` 返回 null）。
       * `37d` 用源码扫描钉住这一条；注意本注释**刻意不写出那几个字面量**，
       * 否则扫描会把自己的注释当成犯规。
       *
       * 卡头的 title/sub 除外：它们是**卡头**而不是正文，投影不负责。 */
      const lines = meetingCardLines(view, t);
      return h('section', { className: 'tb-card', 'data-meeting': view.state },
        h(CardHead, { title: t('meeting.title'), sub: t('meeting.sub') }),
        lines.map((line) => {
          const extra = line.tone === null ? {} : { 'data-tone': line.tone };
          return h('div', { className: CARD_LINE_CLASS[line.kind], key: line.key, ...extra }, line.text);
        }));
    }

    /**
     * 门禁覆盖（shadow）—— **三个分母并排**，外加声明块警告。
     *
     * 两个分母合成一个，就把"判了 3 条"里"其实一条都没核"盖掉 —— 那正是 P0 抓到的假绿。
     * `blind`（任务列表都拿不到）时一个数字都不出现；`no-tasks` / `no-judged` 是测量结果，照给。
     *
     * 声明警告一条都没有时**整块不渲染**（不许出现"0 条警告"的空壳）。
     */
    function ShadowCard({ shadow, tasks, t }) {
      const view = shadowView(shadow, t);
      const warnings = declarationWarningsOf(tasks);
      if (view === null && warnings === null) return null;

      return h('section', { className: 'tb-card' },
        h(CardHead, { title: t('shadow.title'), sub: t('shadow.sub') }),
        view === null
          ? null
          : (view.blind
            ? h('div', { className: 'tb-note', 'data-tone': 'warn' }, view.reason === null ? t('shadow.reason.tasks') : view.reason)
            : h('div', null,
              h('div', { className: 'tb-stats' }, view.stats.map((stat) => h('div', { className: 'tb-stat', key: stat.key },
                h('div', { className: 'tb-stat-v' }, stat.value),
                h('div', { className: 'tb-stat-l' }, stat.label),
                h('div', { className: 'tb-shadow-hint' }, stat.hint)))),
              /* `no-judged` / `no-tasks` 的成因照给数字，但必须有一句说明
               * "这些 0 是测量结果，不是没读"。 */
              view.reason === null ? null : h('div', { className: 'tb-note' }, view.reason))),
        warnings === null
          ? null
          : h('div', { className: 'tb-group' },
            h('div', { className: 'tb-group-head' },
              h('span', { className: 'tb-group-label' }, t('declaration.title')),
              h('span', { className: 'tb-count' }, count(warnings.length))),
            warnings.map((item, index) => h('div', { className: 'tb-mnote', key: `${item.taskId}:${item.code}:${index}` },
              item.taskId === '' ? null : h('code', { className: 'tb-code' }, item.taskId),
              item.code === '' ? null : h('code', { className: 'tb-code' }, item.code),
              h('span', { className: 'tb-msg' }, item.message)))));
    }

    function LedgerCard({ ledger, t }) {
      const value = ledger !== null && typeof ledger === 'object' ? ledger : { status: 'unavailable', roles: [] };
      const statusText =
        value.status === 'ok' ? t('ledger.status.ok')
          : value.status === 'empty' ? t('ledger.status.empty')
            : t('ledger.status.unavailable');

      let body;
      if (value.status === 'unavailable') {
        /* 这句解释已经被用户确认为"写对了"，保留原样：
         * "存储读不出来，所以这一块给不出任何结论（不是「没有历史」）"。
         * 它放在有边界的说明块里，不再是一行字浮在一整片空白中间。 */
        body = h('div', { className: 'tb-note', 'data-tone': 'warn' }, t('ledger.unavailable'));
      } else if (value.status !== 'ok' || !Array.isArray(value.roles) || value.roles.length === 0) {
        body = h('div', { className: 'tb-note' }, t('ledger.empty'));
      } else {
        const list = value.roles.map((role) => {
          const row = ledgerStats(role, t);
          return h('div', { className: 'tb-role', key: row.id },
            h('div', { className: 'tb-role-id' }, row.id),
            h('div', { className: 'tb-role-nums' },
              row.cells.map((cell) => h('div', { className: 'tb-cell', 'data-tone': cell.tone, key: cell.key },
                h('div', { className: 'tb-cell-v' }, cell.value),
                h('div', { className: 'tb-cell-l' }, cell.label)))),
            /* 没有记录过坑就**不画这一行** —— 不印一堆「—」占版面。 */
            row.hasPitfall ? h('div', { className: 'tb-role-pit' }, row.pitfalls) : null);
        });
        body = h('div', { className: 'tb-role-list' }, list);
      }

      const hasRoles = value.status === 'ok' && Array.isArray(value.roles) && value.roles.length > 0;
      return h('section', { className: 'tb-card', 'data-fill': hasRoles ? 'true' : 'false' },
        h(CardHead, {
          title: t('ledger.title'),
          sub: t(K.subLedger),
          right: h('span', { className: 'tb-mute' }, statusText),
        }),
        body);
    }

﻿    /**
     * 「申报改动」chip：成员**自己申报**改了哪些文件。
     *
     * 这里有一条红线：**自我申报不得被读成已核实**。
     * 文案必须是「申报」而不是「改了」——"改了这些文件"是在陈述事实，
     * 而我们手上只有成员的一句话；事实要靠 diff 对账（那是判定层的活）。
     * 本项目栽过的那几笔，多半就是"某人这么说"被当成了"事情是这样"。
     *
     * 三条渲染纪律：
     *   ① 前缀标记 ✎ 表明"这是申报"；
     *   ② `declaredChanges` 不存在 / 非数组 / 空数组 → **什么都不画**
     *      （画一个「无」会和"申报了零个"混起来，那又是空态与不可用的老问题）；
     *   ③ 每条 chip 的 title 也写「申报」，悬停时同样不会被读成事实。
     */
    function DeclaredChanges({ paths, t }) {
      const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.trim() !== '') : [];
      if (list.length === 0) return null;
      return h('span', { className: 'tb-tflags tb-tflags-declared' },
        h('span', { className: 'tb-declared-caption' }, `✎ ${t(K.declaredCaption)}`),
        list.map((path) => h('span', {
          className: 'tb-chip tb-chip-declared',
          key: `d:${path}`,
          title: `${t(K.declaredCaption)}：${path}`,
        }, sanitizeLabel(path.trim()))));
    }

    /** 一条结构化任务行：ID ｜ 类型徽章 ｜ 状态徽章 ｜ 标题（+警告）｜ 归属。 */
    function TaskRow({ row, t }) {
      const kind = kindBadge(row.kind, t);
      const status = statusBadge(row.status, t);
      return h('div', { className: 'tb-trow' },
        h('span', { className: 'tb-tid', title: row.id }, row.id),
        /* kind 徽章：显示短标签，完整名字放 title（悬停可看）。
         * 以前这里是完整 kind，'implementation' 在 74px 格里溢出、末字被右侧徽章盖掉。 */
        h('span', { className: 'tb-badge', 'data-tone': kind.declared ? 'muted' : 'warn', title: kind.full === '' ? kind.text : kind.full }, kind.text),
        /* 状态徽章：danger / success / active / plain / mute —— 这四档 CSS 以前**整段缺失**。 */
        h('span', { className: 'tb-badge', 'data-tone': status.tone === 'plain' ? 'plain' : status.tone, title: status.text }, status.text),
        h('span', { className: 'tb-tsubject-wrap' },
          h('span', { className: 'tb-tsubject', title: row.subject }, row.subject),
          /* 依赖 / 警告 / 写域挤在标题下面一行，而不是各占一列。
           * 理由：它们的**出现频率极不均匀** —— 大多数任务三项全空。各占一列会让
           * 90% 的行飘着三片空白；挤成标记列，则"有标记的行"本身就跳出来了。 */
          h('span', { className: 'tb-tflags' },
            row.blockedBy.map((id) => h('span', { className: 'tb-chip', key: `b:${id}` }, `⛓ ${id}`)),
            row.warnings.map((warning) => h('span', { className: 'tb-chip', key: `w:${warning}` }, `⚠ ${warning}`)),
            row.scopes.map((scope) => h('span', { className: 'tb-chip', key: `s:${scope}` }, scope)),
            h(DeclaredChanges, { paths: row.declaredChanges, t }))),
        h('span', { className: 'tb-town', 'data-mine': row.mine ? 'true' : 'false', title: row.owner },
          row.owner === '' ? '' : `@${row.owner}`));
    }

    /**
     * 任务板（整幅，可滚）。
     *
     * 两条路径，都必须是**诚实**的：
     *   ① 宿主给了结构化 `tasks` → 一条一行，可扫、可折叠、长板自己滚。
     *   ② 宿主没给 → 明说"宿主没有提供结构化任务"，把给模型的原文折叠起来放后面。
     *
     * 为什么②不做成"尽力解析原文"：见 `boardRows` 上面那段 —— 解析等于重新打开
     * `board.mjs` 特意堵上的注入洞。宁可选"这版还不够好"并如实说出来。
     *
     * 空态与不可用态在这里同样分家：`tasks: []` → 「板上没有任务」（读到了，就是零）；
     * `tasks` 不是数组 → 「没有结构化数据」（拿不到，不给任何结论）。
     */
    function BoardCard({ tasks, raw, t }) {
      const rows = boardRows(tasks);
      const [openRaw, setOpenRaw] = React.useState(false);
      const hasRaw = typeof raw === 'string' && raw.trim() !== '';

      if (rows === null) {
        if (!hasRaw) return null; // 连原文都没有 —— 这一块整个不出现，不占用页面
        return h('section', { className: 'tb-card' },
          /* 卡头**不写「不可用」**：顶栏那枚徽章说的是"数据源 = Agent Teams 任务板"，
           * 同一屏幕两种说法会当场打架。这里只陈述本卡自己的事实：
           * 宿主没有给结构化任务，所以这里只有给模型的原文。 */
          h(CardHead, { title: t('board.title'), sub: t(K.subBoard) }),
          h('div', { className: 'tb-note', 'data-tone': 'warn' }, t(K.rawNote)),
          h('button', { type: 'button', className: 'tb-toggle', onClick: () => setOpenRaw(!openRaw) },
            openRaw ? `▾ ${t(K.collapse)}` : `▸ ${t(K.expand)}`),
          openRaw ? h('pre', { className: 'tb-raw' }, raw) : null);
      }

      return h('section', { className: 'tb-card' },
        h(CardHead, {
          title: t('board.title'),
          sub: t(K.subBoard),
          right: h('span', { className: 'tb-mute' }, `${rows.length}`),
        }),
        rows.length === 0
          ? h('div', { className: 'tb-note' }, t(K.empty))
          : h('div', null,
            h('div', { className: 'tb-thead' },
              h('span', null, t(K.colId)),
              h('span', null, t(K.colKind)),
              h('span', null, t(K.colStatus)),
              h('span', null, t(K.colSubject)),
              h('span', null, t(K.colOwner))),
            h('div', { className: 'tb-scroll' }, rows.map((row) => h(TaskRow, { row, t, key: row.id })))));
    }

    /**
     * ③ 待拍板（**通栏**，D1：插在总判 banner 与 `.tb-grid` 之间，不进右栏 rail）。
     *
     * 为什么必须通栏而不是塞进右栏：rail 里那一列的语义是「明细 / 补充」（角色台账），
     * 而这一块是「还要做的事」。两栏并排、宽度一样，读者就会把待办读成明细 ——
     * 而"还有 3 件事没人拍板"和"某个角色上次踩过什么坑"根本不是同一个重量级。
     *
     * 组件里**零判定**：显示几条、怎么排、能不能拍板、待办还有几个，全部来自
     * `selectDecisions` / `decisionSlot`。组件只保留三类**交互**状态：
     * 失败提示、建议草稿、以及"本地已写成功但还没重拉快照"的覆盖值。
     *
     * 为什么本地只打补丁、不重拉快照（K2 的处置）：
     *   重拉会返回一个新数组 → `baseRows` 重算 → 顺序重排，于是"点了准，那一行
     *   往下跳了两格"。D3 要的是"算一次并冻结"，所以写成功之后**只覆盖这一行**，
     *   行的身份（id）与位次（seq）都不动；已拍板的行、回写失败的行**一律留在原位**，
     *   不删除、不隐藏、不改序 —— 判定函数本来就不按 status 过滤（见 `selectDecisions`）。
     */
    function DecideCard({ decisions, t, sessionId }) {
      const source = decisions !== null && typeof decisions === 'object' ? decisions : { status: 'unavailable', reason: 'missing' };
      const rawRows = Array.isArray(source.rows) ? source.rows : [];

      /* D3 的**冻结点**就在这一行：快照到达时排一次序并盖上 `seq`。
       * 之后拍板 / 提建议 / 失败重试只改行内容（`override`），`baseRows` 的引用不变，
       * `orderDecisions` 走"带 seq 就还原"的分支 —— 列表不会因为一次回写跳一下。 */
      const baseRows = React.useMemo(() => orderDecisions(rawRows), [rawRows]);

      const [override, setOverride] = React.useState({});
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [draftId, setDraftId] = React.useState(null);
      const [draftText, setDraftText] = React.useState('');

      const merged = baseRows.map((row) => (override[row.id] === undefined ? row : { ...row, ...override[row.id] }));
      const view = selectDecisions({ rows: merged });

      const post = React.useCallback(
        async (body) => {
          const response = await fetch(DECIDE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...(sessionId === undefined ? {} : { sessionId }), ...body }),
          });
          const envelope = await response.json();
          if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true) {
            const detail = envelope !== null && typeof envelope === 'object' && envelope.error !== undefined
              ? envelope.error.message : undefined;
            throw new Error(String(detail === undefined || detail === null ? 'unknown' : detail));
          }
          return envelope.value;
        },
        [sessionId],
      );

      /**
       * 把服务端回来的那一行折成补丁。
       *
       * **只用服务端回的字段**：`decided_by` / `decided_at` / `decision_value` 是拍板的
       * 三个证据，客户端不自己编时间戳 —— 编了就无法与台账对账。
       * 服务端没给（老版本宿主）就保留本地已知值，绝不回退成空。
       */
      const patchOf = React.useCallback((row, value, fallbackVerdict) => {
        const next = value !== null && typeof value === 'object' && value.row !== null && typeof value.row === 'object'
          ? value.row : {};
        const writebackState = next.writeback_state === 'ok' || next.writeback_state === 'failed'
          ? next.writeback_state : row.writebackState;
        return {
          verdict: typeof next.verdict === 'string' ? decisionVerdict(next.verdict) ?? fallbackVerdict : fallbackVerdict,
          status: typeof next.status === 'string' && next.status !== '' ? next.status : row.status,
          decidedBy: typeof next.decided_by === 'string' && next.decided_by !== '' ? next.decided_by : row.decidedBy,
          decidedAt: typeof next.decided_at === 'string' && next.decided_at !== '' ? next.decided_at : row.decidedAt,
          decisionValue: typeof next.decision_value === 'string' && next.decision_value !== ''
            ? next.decision_value : row.decisionValue,
          writebackState,
          writebackError: typeof next.writeback_error === 'string' ? next.writeback_error : row.writebackError,
        };
      }, []);

      const write = React.useCallback(
        (row, body, fallbackVerdict) => {
          setBusy(row.id);
          setError(null);
          post({ id: row.id, ...body }).then(
            (value) => {
              setBusy(null);
              const patch = patchOf(row, value, fallbackVerdict);
              setOverride((prev) => ({
                ...prev,
                [row.id]: { ...(prev[row.id] === undefined ? {} : prev[row.id]), ...patch },
              }));
            },
            (failure) => {
              /* 失败**不改行**：403（不是本人）、回写失败、网络断 —— 行原样留在原位，
               * 只多一句错误提示。删行或改序都会让"我点过，但它没了"变成一次事故。 */
              setBusy(null);
              setError(failure instanceof Error ? failure.message : String(failure));
            },
          );
        },
        [post, patchOf],
      );

      /**
       * 一行 = **定高 92px 的两列三段网格**（CSS 里有算术）。
       *
       * 左列：①标题 ②槽位行（截止 / 影响金额已并入影响行 / 来源 / 默认值占位 / 建议）
       *       ③影响句
       * 右列：①状态槽（待拍板 / 已拍板 / 无归属）②回写状态 ③控件
       *
       * 六个槽位一个不少，且每个槽位都带 `data-slot`：这样"6 个槽位"是可数的，
       * 而不是一句口头承诺（断言：`[data-slot]` 恰好 6 个，key 与 `DECISION_SLOTS` 一致）。
       */
      const rowNode = (row) => {
        const slot = decisionSlot(row, t);
        const emptyOwner = row.owner === '';
        const slots = Array.isArray(row.slots) ? row.slots : auditDecisionSlots(row).slots;
        const byKey = {};
        for (const item of slots) byKey[item.key] = item;

        const optionSlot = byKey.options === undefined ? { text: '', clamped: false } : byKey.options;
        const dueSlot = byKey.dueAt === undefined ? { text: '', placeholder: true } : byKey.dueAt;
        const refSlot = byKey.sourceRef === undefined ? { text: '', href: '', empty: true } : byKey.sourceRef;
        const impactSlot = byKey.impact === undefined ? { text: '', source: 'none' } : byKey.impact;

        /* D5 的形态分工：本人 = 三选项；非本人 = 单个「提建议」。
         * 空归属走"非本人"那一支，但按钮 disabled —— 条目照常在，只是没人能替它拍板。 */
        const controls = row.mine === true && !emptyOwner
          ? h('div', { className: 'tb-dbtns', 'data-slot': 'options', 'data-count': String(Array.isArray(row.options) ? row.options.length : 0), 'data-clamped': optionSlot.clamped === true ? 'true' : 'false' },
            VERDICTS.map((verdict) => h('button', {
              type: 'button',
              className: 'tb-dbtn',
              key: verdict,
              'data-verdict': verdict,
              'data-on': row.verdict === verdict ? 'true' : 'false',
              disabled: busy === row.id,
              onClick: () => write(row, { verdict }, verdict),
            }, t(`decide.verdict.${verdict}`))))
          : h('div', { className: 'tb-dbtns', 'data-slot': 'options', 'data-count': '0' }, h('button', {
            type: 'button',
            className: 'tb-dbtn',
            'data-action': 'suggest',
            disabled: emptyOwner || busy === row.id,
            onClick: () => {
              setDraftId(row.id);
              setDraftText(row.suggestion);
            },
          }, t('decide.suggest')));

        /* 回写状态（Req6：「已回写」/「回写失败」+ 重试按钮）。失败**不回退、不消失**：
         * 行还在、决议还在，只是多一颗重试按钮 —— 重试只重发回写，不改决议。 */
        const writebackNode = row.writebackState === 'ok'
          ? h('span', { className: 'tb-muted', 'data-writeback': 'ok' }, t('decide.writeback.ok'))
          : row.writebackState === 'failed'
            ? h('span', { className: 'tb-dwbfail', 'data-writeback': 'failed', title: row.writebackError }, t('decide.writeback.failed'))
            : null;
        const retryNode = row.writebackState === 'failed'
          ? h('button', {
            type: 'button',
            className: 'tb-dbtn',
            'data-action': 'retry',
            disabled: busy === row.id,
            onClick: () => write(row, { retry: true }, row.verdict),
          }, t('decide.retry'))
          : null;

        const draft = draftId === row.id && !emptyOwner
          ? h('div', { className: 'tb-dsuggest' },
            h('input', {
              className: 'tb-dinput',
              type: 'text',
              value: draftText,
              placeholder: t('decide.suggestPlaceholder'),
              onChange: (event) => setDraftText(event.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'tb-dbtn',
              'data-action': 'send-suggestion',
              disabled: busy === row.id || draftText.trim() === '',
              onClick: () => {
                const text = draftText.trim();
                write(row, { suggestion: text }, row.verdict);
                setDraftId(null);
                setDraftText('');
              },
            }, t('decide.suggestSubmit')),
            h('button', {
              type: 'button',
              className: 'tb-dbtn',
              'data-action': 'cancel-suggestion',
              onClick: () => {
                setDraftId(null);
                setDraftText('');
              },
            }, t('decide.suggestCancel')))
          : null;

        return h('div', {
          className: 'tb-drow',
          key: row.id,
          'data-decision-id': row.id,
          'data-mine': row.mine === true ? 'true' : 'false',
          'data-decided': row.verdict === null ? 'false' : 'true',
          'data-writeback': row.writebackState,
        },
        /* ① 标题槽 */
        h('div', { className: 'tb-dtitle', 'data-slot': 'title', title: row.title },
          byKey.title === undefined ? row.title : byKey.title.text),
        /* ② 槽位行：截止日 / 来源链接 / 默认值占位 / 建议（一条线，放不下就省略） */
        h('div', { className: 'tb-dslots' },
          h('span', {
            className: dueSlot.placeholder === true ? 'tb-dph' : 'tb-down',
            'data-slot': 'dueAt',
            'data-placeholder': dueSlot.placeholder === true ? 'true' : 'false',
          }, dueSlot.placeholder === true ? t(K.noDue) : dueSlot.text),
          refSlot.href === ''
            ? h('span', { className: 'tb-dph', 'data-slot': 'sourceRef', 'data-href': '' }, t('decide.noRef'))
            /* **真 <a href>**：可点是 Req2 的一项，不是装饰。 */
            : h('a', {
              className: 'tb-dref',
              'data-slot': 'sourceRef',
              'data-href': refSlot.href,
              href: refSlot.href,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, refSlot.text),
          h('span', { className: 'tb-dph tb-dgrow', 'data-slot': 'default', 'data-placeholder': 'true' },
            t('decide.noDefault')),
          row.suggestion === ''
            ? null
            : h('span', { className: 'tb-dsaid tb-dgrow', 'data-slot': 'suggestion', title: row.suggestion }, `✎ ${row.suggestion}`)),
        /* ③ 影响槽（含金额或截止日；来源文案优先，判定在 decisionImpactSlot） */
        draft === null
          ? h('div', { className: 'tb-dimpact', 'data-slot': 'impact', 'data-source': impactSlot.source }, impactSlot.text)
          : draft,
        /* 右列上段：状态槽 + 回写状态 */
        h('div', { className: 'tb-dslot', 'data-kind': slot.key },
          h('div', null, slot.text),
          slot.value === undefined ? null : h('div', { className: 'tb-mute' }, slot.value),
          writebackNode),
        retryNode === null ? controls : h('div', { className: 'tb-dbtns' }, retryNode, controls));
      };

      /* 折叠行：「还有 N 条」（D4）。N 来自 `hiddenCount`，不是另算一遍。
       * 全量口径落在 section 的 `data-hidden-capacity`；**过滤口径**落在 `data-filtered-*`
       * —— 两个数是两件事（"合格但没摊开" ≠ "不合格"），所以各写各的，绝不合并成一个。 */
      const foldNode = (count) => h('div', {
        className: 'tb-dmore',
        'data-fold': String(count),
      }, t(K.more, { n: count }));

      let body;
      if (source.status === 'unavailable') {
        body = h('div', { className: 'tb-note', 'data-tone': 'warn' }, t('decide.unavailable'));
      } else if (view.rows.length === 0) {
        /* 0 条时区块**照样挂载**（K5）：`data-filtered-*` 仍然写得出来，
         * 于是"渲染 0 条"（Req1）与"隐藏计数可读"（Req2）可以同时成立。 */
        body = h('div', { className: 'tb-note', 'data-tone': 'mute' }, t('decide.empty'));
      } else if (view.mode === 'grouped') {
        body = h('div', null, view.groups.map((group) => h('div', {
          className: 'tb-dgroup',
          key: group.key === '' ? '\u0000none' : group.key,
          'data-group': group.key,
        },
        h('div', { className: 'tb-dgroup-head' }, group.key === '' ? t('decide.group.unknown') : group.key),
        group.visible.map(rowNode),
        group.hiddenCount === 0 ? null : foldNode(group.hiddenCount))));
      } else {
        body = h('div', null,
          view.visible.map(rowNode),
          view.hiddenCount === 0 ? null : foldNode(view.hiddenCount));
      }

      /* 区块属性是**机器可读的真相**：模式、过滤计数、容量折叠计数、待办计数。
       * 一个都不写成可见文案 —— 这些数字一旦变成正文，读者就会把它当第二个结论。 */
      return h('section', {
        className: 'tb-card tb-decide',
        'data-mode': view.mode,
        'data-filtered-count': String(view.filtered.admission + view.filtered.slots),
        'data-filtered-admission': String(view.filtered.admission),
        'data-filtered-slots': String(view.filtered.slots),
        'data-hidden-capacity': String(view.hiddenCount),
        'data-total': String(view.total),
        'data-pending': String(view.pending),
        'data-decided': String(view.decided),
      },
      h(CardHead, {
        title: t('decide.title'),
        sub: t(K.subDecide),
        /* 待办计数（Req4：拍板后 -1）。它数的是"还没拍的"，不是"一共有几条"。 */
        right: h('span', { className: 'tb-mute' }, t('decide.pendingCount', { pending: view.pending, total: view.total })),
      }),
      error === null ? null : h('div', { className: 'tb-note', 'data-tone': 'warn' }, error),
      body);
    }

    function LedgerView(props) {
      const t = props.t;
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
      const [state, setState] = React.useState({ status: 'loading' });
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(
        async (next) => {
          const body = { ...(sessionId === undefined ? {} : { sessionId }), ...(next === undefined ? {} : { enabled: next }) };
          const response = await fetch(STATE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const envelope = await response.json();
          if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true) {
            const message = envelope !== null && typeof envelope === 'object' && envelope.error !== undefined ? envelope.error.message : 'unknown';
            throw new Error(String(message));
          }
          return envelope.value;
        },
        [sessionId],
      );

      React.useEffect(() => {
        let alive = true;
        load().then(
          (value) => {
            if (alive) setState({ status: 'ready', value });
          },
          (error) => {
            if (alive) setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
          },
        );
        return () => {
          alive = false;
        };
      }, [load]);

      const toggle = React.useCallback(
        (next) => {
          setBusy(true);
          load(next).then(
            (value) => {
              setBusy(false);
              setState({ status: 'ready', value });
            },
            (error) => {
              setBusy(false);
              setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
            },
          );
        },
        [load],
      );

      if (state.status === 'loading') {
        return h('div', { className: 'tb-root' }, h('style', null, STYLES),
          h('div', { className: 'tb-mute' }, t('state.loading')));
      }
      if (state.status === 'failed') {
        /* 第三态：连宿主都没应答（请求本身失败）。它和「判定不可用」不是一回事 ——
         * 那是"宿主答了，但答的是'我不知道'"。两种都不许长得像"零阻断"，
         * 所以这里直接复用 banner 的危险色条 + 原始错误文本。 */
        return h('div', { className: 'tb-root' }, h('style', null, STYLES),
          h('section', { className: 'tb-verdict', 'data-tone': 'danger' },
            h('div', { className: 'tb-verdict-word' }, t('state.error')),
            h('p', { className: 'tb-verdict-why' }, state.message)));
      }

      const value = state.value;
      /* P3-14：关掉时宿主**不产出** `dataSource`（"不读"）。这里**不许**回落成
       * `{kind:'unavailable'}` —— 那会把"你关了"显示成"它坏了"。
       *
       * 判据取自 `gates.status === 'disabled'`（那是开关的第五态，关掉时一定会带），
       * 而不是"dataSource 缺了就当成关掉"：后者会把任何一次字段缺失都解释成
       * 用户主动关闭，等于给下一个 bug 发一张免罪证。 */
      const gates = value.gates !== null && typeof value.gates === 'object' ? value.gates : {};
      const switchOff = gates.status === 'disabled';
      const source = value.dataSource !== null && typeof value.dataSource === 'object'
        ? value.dataSource
        : (switchOff ? { kind: 'disabled' } : { kind: 'unavailable' });
      const detail = sourceDetail(source, t);

      /* 阅读顺序 = 重要度顺序，窄窗口退化成一列时也照这个顺序读：
       *   ① 顶栏（标题 · 数据源 · 开关）—— 元信息，最小
       *   ② 总判 banner                —— 整页第一眼，最大
       *   ③ 待拍板（通栏）              —— 还没拍的事：这是页面上唯一"要动手"的一块
       *   ④ 门禁（按根因聚合）｜角色台账  —— 左主视图 + 右明细栏
       *   ⑤ 任务板                     —— 支撑材料，可滚可折叠
       *   ⑥ 页脚的一句"这页回答什么"    —— 最轻
       * 上一版是四张等宽通栏卡片，把"判决"和"元信息"排成了同样的重量 ——
       * 于是判决被埋、开关浮在空白里、整页读完不知道重点在哪。 */
      return h('div', { className: 'tb-root' },
        h('style', null, STYLES),

        /* ① 顶栏：标题 + 数据源徽章 + 开关，**同一行**（开关不再单独占一行飘着） */
        h('section', { className: 'tb-card' },
          h('div', { className: 'tb-card-head tb-card-head-top' },
            h('div', { className: 'tb-top-left' },
              h('div', { className: 'tb-card-head-text' },
                h('span', { className: 'tb-page-title' }, t('page.title')),
                h('div', { className: 'tb-card-sub' }, t(K.subAgent))),
              h(SourceBadge, { source, t })),
            h('div', { className: 'tb-top-right' },
              detail.count === null ? null : h('span', { className: 'tb-mute tb-badge-n' }, detail.text),
              h(SwitchRow, { enabled: value.enabled === true, busy, onToggle: toggle, t }))),
          /* 读不出来时：这一行是**解释**，且明说"不是 0 条"；读到了才给数字。 */
          detail.count === null ? h('div', { className: 'tb-note', 'data-tone': 'warn' }, detail.text) : null),

        /* ② 总判 */
        h(VerdictBanner, { gates: value.gates, t }),

        /* ③ 待拍板（**通栏**，D1：VerdictBanner 之后、.tb-grid 之前；不进右栏 rail） */
        h(DecideCard, { decisions: gates.decisions, t, sessionId }),

        /* ③b 会议账本（通栏）：整页唯一回答**进度**的一块。
         * 放在"待拍板"之后、"门禁结论"之前 —— 读者先看见"要你动手的事"，
         * 再看"这场会开到哪了"，最后才是"这批活能不能收"的细节。 */
        h(MeetingCard, { ledger: gates.ledger, t }),

        /* ④ 左：门禁结论（按根因聚合）｜ 右：角色台账（成绩排名） */
        h('div', { className: 'tb-grid' },
          h(GateCard, { gates: value.gates, t }),
          h('div', { className: 'tb-rail' },
            h(LedgerCard, { ledger: value.roleLedger, t }))),

        /* ④b 门禁覆盖（通栏）：三个分母 + 声明块警告。
         * 在任务板**之前**：先说"这一轮到底核了什么"，再给支撑材料；
         * 反过来读者会先看到一堆任务、后才知道那些任务一条都没被核。 */
        h(ShadowCard, { shadow: gates.shadow, tasks: gates.tasks, t }),

        /* ⑤ 任务板：宿主给结构化 tasks 就铺行，没给就诚实降级 + 折叠原文 */
        h(BoardCard, { tasks: gates.tasks, raw: gates.board, t }),

        h('div', { className: 'tb-foot' }, t('page.footer')));
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 三、Client 插件体
     * ═══════════════════════════════════════════════════════════════════════ */

    const zh = {
      /* 会议账本 / 门禁覆盖 / 声明警告（本轮新增）。
       * 全部是**整句**，不做插值：数字走独立的等宽格，机器令牌（reason / code / stageId）
       * 用 code 样式原样印 —— 拼句子会让两种语言的词序各自别扭，而拼错时是静默的。 */
      'meeting.title': '会议账本',
      'meeting.sub': '这场会开到了哪一阶段、每阶段交了什么',
      'meeting.state.none': '板上没有任何会议账本：这是「确实没有」，不是「读不出来」',
      'meeting.state.ok': '会议账本可读',
      'meeting.state.unreadable': '会议账本读不出来',
      'meeting.state.unavailable': '门禁整体起不来，会议账本这一块无从判断',
      'meeting.state.noCriterion': '这一块没给判据（readable 不是布尔），所以按不可用处理——不是猜，也不是「确实没有」',
      'meeting.state.unknownState': '会议账本给了一个认不出的状态值，这一块按不可用处理',
      'meeting.cause': '成因',
      'meeting.meta.id': '会议',
      'meeting.meta.preset': '档位',
      'meeting.plan.progress': '已完成 {done}/{total}，还差 {remaining}',
      'meeting.plan.allDone': '已完成 {n}/{n}，这一场走完了',
      'meeting.meta.status': '状态',
      'meeting.col.stage': '阶段',
      'meeting.col.attempt': '轮次',
      'meeting.col.status': '状态',
      'meeting.col.produced': '产物',
      'meeting.stageUnknown': '（阶段名读不出来）',
      'meeting.noProduced': '未申报产物',
      'shadow.title': '门禁覆盖',
      'shadow.sub': '这一轮到底核了多少条，以及其中多少条其实一条输入都没拿到',
      'shadow.judged': '进了判定',
      'shadow.withInput': '真拿到输入',
      'shadow.meeting': '会议任务（已排除）',
      'shadow.judgedHint': '按 kind 进了判定的任务数',
      'shadow.withInputHint': '其中真的核过东西的条数——这个数才是可信的分母',
      'shadow.meetingHint': '会议账本任务，已从上面两个分母里排除',
      'shadow.reason.tasks': '任务列表都没拿到：这一轮一个数都没有',
      'shadow.reason.noTasks': '板上一条任务都没有（读到了，就是零条）',
      'shadow.reason.noJudged': '有任务、但没有任何一条进得了判定——上面的 0 是测量结果，不是没读',
      'declaration.title': '声明块警告',
      'tab.ledger': '台账',
      'page.title': '团队台账',
      'page.footer': '上下文插件回答「还能不能继续」，这个页面回答「这批活能不能收、下次该派给谁」。',
      'state.loading': '读取中…',
      'state.error': '读不到宿主数据',
      'switch.on': '开',
      'switch.off': '关',
      'switch.hint': '关闭后 team_board 与 team_deliver 都对模型不可见（下一步生效）',
      'source.label': '数据源',
      'source.agentTeams': 'Agent Teams 任务板',
      'source.roster': '委派花名册',
      'source.unavailable': '不可用',
      'source.unavailableHint': '宿主既没有 Agent Teams 任务板，也没有可用的委派花名册 —— 这不是「0 条」，是拿不到数据。',
      'source.disabledHint': '已关闭 —— 你自己关掉了它，所以这一页不读任何东西，也不对工作下判断。',
      'source.count': '{n} 个（{running} 在跑）',
      'roster.title': '委派花名册',
      'roster.unnamed': '(未命名)',
      'roster.runningGlyph': '🔄',
      'roster.idleGlyph': '·',
      'roster.depth': '深度 {n}',
      'ledger.title': '角色台账',
      'ledger.status.ok': '有记录',
      'ledger.status.empty': '无历史',
      'ledger.status.unavailable': '不可用',
      'ledger.empty': '无历史：还没有任何角色记录，下面五个数字全是 0 —— 这是「没有历史」，不是「历史很好」。',
      'ledger.unavailable': '不可用：存储读不出来，所以这一块给不出任何结论（不是「没有历史」）。',
      'ledger.completed': '完成',
      'ledger.abortedWithOutput': '有产出中止',
      'ledger.abortedWithoutOutput': '空转',
      'ledger.failed': '失败',
      'ledger.failedWithoutOutput': '空手失败',
      'ledger.pitfalls': '上次踩过的坑',
      'ledger.noPitfall': '—',
      'gates.title': '门禁结论',
      'gates.ok': '可以宣布交付',
      'gates.blocked': '不能宣布交付',
      'gates.blockers': '阻断',
      'gates.warnings': '警告',
      'gates.none': '无',
      'gates.unavailable': '不可用：宿主没有 Agent Teams 任务板，门禁跑不了。',
      'gates.noAgent': '不可用：这个会话没有活着的 Agent，门禁跑不了。',
      'gates.error': '不可用：判定过程报错。',
      'gates.phaseUnknown': '团队阶段未知，按「不具备交付资格」处理（这是可见的，不是静默）。',
      'gates.code.E_ACCEPTANCE_MISMATCH': '验收没逐条对账：有验收项没有结果记录，或结果不是「通过」——逐条补上通过的结果',
      'gates.code.E_AUDIT_UNWIRED': "本次判定没有拿到审计输入（字节指纹与 diff 都没跑），所以\"没有越权改动\"这个结论不成立——要么补审计输入，要么把这条当\"没查\"看",
      'gates.code.E_BINDING_STALE': '评审之后产物又被动过：指纹对不上、当时没有现在有了、或者现在没了——重审一遍再交付',
      'gates.code.E_BINDING_UNVERIFIABLE': '评审记录里的产物没写指纹，证明不了审完没被改过——重审时把每个产物的 sha256 记上',
      'gates.code.E_CANCELLED_NO_REASON': '任务被取消了，却没写取消原因——补上 cancelReason，否则没人知道为什么砍掉它',
      'gates.code.E_CHANGED_PATHS_REQUIRED': '实现类任务一条改动路径都没申报——没有改动就没有可交付的东西，先确认活真的落地了',
      'gates.code.E_CONTRACT_AMBIGUOUS': '同一项契约在 task.contract 和任务顶层各写了一份、值还不一样——只留一份（contract 那份算数），两边都写门禁不替你选',
      'gates.code.E_CONTRACT_INCOMPLETE': '这活没写验收项或验证命令，补上才能验收——少写一个字段就能把门禁整段关掉，所以直接拒',
      'gates.code.E_DECLARATION_MISSING': '任务未声明 kind',
      'gates.code.E_EVIDENCE_UNBACKED': '验收项的证据不是一个成功的回执（写的是文件路径、引用了不存在的回执、或回执退出码非 0）——文件在不等于跑过，改成交一条成功的回执',
      'gates.code.E_FAILED_NO_FOLLOWUP': '有任务失败了，却没有任何后续任务接着它——失败被无声吞掉，补一个返工任务，或说明为什么不用跟',
      'gates.code.E_FINDINGS_REQUIRED': '判了「要改／打回」却一条具体问题都没写——补上问题清单，否则被审的人不知道该改什么',
      'gates.code.E_ILLEGAL_TRANSITION': '状态流转被拒：缺起止状态、转移表里没这条边，或发起人角色不对——该改的是这次流转请求，不是任务内容',
      'gates.code.E_INDEPENDENCE_UNENFORCED': '独立性未生效',
      'gates.code.E_INPUT_INVALID': '入参没通过白名单（轮次不是正整数，或裁决/严重度/任务类型/状态拼错或缺失）——重传一份合法入参才行，改代码解决不了',
      /* task-22（开会是必须的）：三条会议码。措辞纪律与其它码一致 ——
       * 说清"发生了什么 / 该怎么办"，不说"你违规了"。例外通道是允许的，
       * 所以 E_MEETING_SKIPPED 那句的重点是"留了痕"，不是"下次别这样"。 */
      'gates.code.E_MEETING_MISSING': '实现类任务没有指认方案来自哪次商量（缺 proposalId）——先写一份 kind 为 proposal 的任务把事商量清楚，再在契约里写上它的 id；确实不必商量就写 proposalId: skip 加一句理由',
      'gates.code.E_MEETING_SKIP_UNEXPLAINED': '声明了跳过开会，却没写理由——例外可以开，但必须留痕：把"为什么这件活不必先商量"写进 skipMeeting',
      'gates.code.E_MEETING_SKIPPED': '这件实现任务跳过了开会（理由已记录）——不阻断交付，但这条会留在台账上，复盘时能看出哪些活是没商量就动手的',
      'gates.code.E_NEEDS_HUMAN_APPROVAL': '团队还停在「等人工批准」阶段，不是活干不完——等人批完、转成运行中，才有资格宣布交付',
      'gates.code.E_NEEDS_HUMAN_DELIVERY': '还没有一条宿主签发的合格交付登记（缺签发方、调用号或证据指纹）——这一步要宿主侧动作，插件不许自己签',
      'gates.code.E_NOT_RUNNING': '团队已经停了，或者阶段值认不出来（只认运行中）——只有运行中的团队才能宣布交付，先把团队拉回运行中',
      'gates.code.E_NO_ASSIGNEE': '队里别的任务都有负责人，这个质量任务却没有——归属要么全填、要么全不填，给它指定负责人',
      'gates.code.E_NO_PASSING_REVIEW': '有实现任务已完成，但整队找不到一条「已完成且通过」的评审——派一个评审，并把结论写成通过',
      'gates.code.E_OPEN_FINDINGS': '结论写「通过」，却还挂着没解决的严重问题——先把这些问题关掉，或者把结论改成不通过',
      'gates.code.E_OUT_OF_SCOPE': '申报的路径不在声明的 inScope 里（或撞上了 outOfScope）——要么缩小改动，要么先改范围声明',
      'gates.code.E_PATH_UNSAFE': '出现了工作区之外的路径（绝对路径、.. 穿越、~ 开头、盘符）——改成工作区内的相对路径',
      'gates.code.E_PHANTOM_CHANGES': '申报说改了这个文件，实际 diff 里根本不存在——虚报，只报真正改过的路径',
      /* task-22：指向类三码。共同的措辞重点：**写错的、指错种类的、指到还没开完的**，
       * 与"没写"是不同的事故，但性质都是"这个指针证明不了开过会"。 */
      'gates.code.E_PROPOSAL_KIND': 'proposalId 指向的那条任务不是方案（kind 不对）——指一条实现或评审任务当方案，等于自己给自己批方案',
      'gates.code.E_PROPOSAL_NOT_READY': '指向的提案还没完成——会没开完就开工了，等方案定下来再派实现',
      'gates.code.E_PROPOSAL_UNKNOWN': 'proposalId 指向一条不存在的任务——这个指针落空了；写错的 id 与没写一样，但更容易被误读成"已经开过会"',
      'gates.code.E_PROPOSAL_UNREVIEWED': '提案已经完成，但队里没有一条评审读过它——开完会没人看纪要等于没开会，派一个评审并留下结论',
      'gates.code.E_QUESTIONS_UNANSWERED': '提案里声明要向人确认的问题，没有逐条得到答复——逐条写上"问题 → 答复"，或把问不出来的那条删掉（想过没问题就写空列表）',
      'gates.code.E_REPORTED_UNCHANGED': '任务申报改了某个文件，但工作区的变更清单里没有它——这条改动要么从来没发生，要么发生在别的地方（「改了没报」和「报了没改」是两条不同的账，不互相抵扣）',
      'gates.code.E_BASIS_FABRICATED': '任务引用的依据（来源任务 / 来源评审 / 被审任务）在任务表里查不到——这几个字段只在对得上号时起作用，对不上号时毫无声音，所以一条编造的来源和一条真实的来源在页面上长得一样。改成真实存在的任务 id，或删掉这个字段',
      'gates.code.E_ARTIFACT_UNVERIFIED': '任务申报的产物在工作区里查不到指纹——不在、或者读不出来，这两种情况在这一层分不开，所以这条不说「不存在」。先确认它该不该存在：该存在就补回工作区，不该存在就从申报里删掉（注意：这条的修法不是去补评审，文件不在，补评审也绑不上）',
      'gates.code.E_REVIEW_STAGNATION': '同一个人对同一个文件连续 3 次以上都判通过，注意力可能已经衰减——只是提醒，不卡交付；换个评审人这条就没了',
      'gates.code.E_SCOPE_UNDECLARED': '申报了改动却完全没声明范围——没有范围就没有审计依据，先写 inScope 与 outOfScope',
      'gates.code.E_SELF_REVIEW': '评审人和被审任务的负责人是同一个人，自己审自己不算独立——换一个人来审',
      'gates.code.E_STALE_ATTEMPT': '这份回执或评审属于别的轮次（或者没标轮次），证明不了是这一轮做的——重跑这一轮，交这一轮的回执',
      'gates.code.E_TASK_INCOMPLETE': '还有任务停在「待认领／已认领／进行中」，没有结论——先把这些任务做完或取消',
      'gates.code.E_UNBOUND_ARTIFACT': '这个任务申报的路径，没有一条「针对它自己」的通过评审绑过——别的任务过了不算，得单独为它评一次',
      'gates.code.E_UNREPORTED_CHANGES': '工作区里真有文件被改了，但申报清单里没有它——补上申报，或者把改动撤掉',
      'gates.code.E_VERDICT_REQUIRED': '评审没给结论，或结论是「要改／打回」——只有审过了才算完成，返工后再评一轮',
      'gates.code.E_VERIFY_FAILED_BY_RUNTIME': '有条验证命令跑出来的退出码不是 0，也就是它实际没通过——修到它真绿，或者换掉这条验证',
      'gates.code.E_VERIFY_MISSING': '契约要求的验证命令一条回执都没有——证明不了它跑过，去跑一次并交回执',
      'gates.code.E_WORK_DECLARED_CHANGES': '「只读调研」类任务却申报改了文件——这类任务本来就不该产生改动，把改动撤掉或改任务类型',
      /* @meeting-codes:begin 由 tools/gen-meeting-codes.mjs 生成，勿手改 */
        "gates.code.E_AGENT_OVERRIDE_NO_REASON": "领导把复用模式改了，但没有写理由。覆盖本身允许，可账本上会变成\"不知道为什么换了人\"——而换人恰好是事后最需要解释得清的一件事。补一句为什么换，或把这次覆盖撤回改成默认模式。",
        "gates.code.E_AGENT_SHARED_ACROSS_MEETINGS": "同一个 agent 要去另一场会做同一个角色，但**隔离无从验证**：这一阶段没有声明任何要扣住的产物（`withheld` 为空），所以没法证明它没看过那一场会的结论。跨会议复用的前提是\"隔离成立\"，不是\"声明了 fork\"——`fork` 是继承上下文，正好相反，它会把 A 的结论带进 B。要么让该阶段声明它要扣住的产物，要么换一个没进过那场会的人。",
        "gates.code.E_ARTIFACT_MALFORMED": "这一阶段的卡畸形，两次修复后仍解析不出来——缺字段、类型不对、或不是约定的形状。按 submit_artifact 的参数说明重交一张；不要靠\"我觉得它大概是这个意思\"往下走。",
        "gates.code.E_ARTIFACT_MISSING": "这一阶段已标记完成，但必产字段没有交——阶段没产物就等于没开过这个会，后面所有阶段都建在空气上。",
        "gates.code.E_ARTIFACT_PARTIAL": "卡片部分字段缺失，但够往下走。缺的那部分会在后面某个阶段变成\"当初没说清楚\"——先记着。",
        "gates.code.E_BLIND_AGENT_REUSED": "这个盲阶段复用的 agent 见过本该扣住的产物（`seenIds` 与 `withheldIds` 有交集）。盲审的价值全在\"它没看过\"，看过之后再复用等于把盲审变成复述。换一个 fresh agent。",
        "gates.code.E_BLIND_LEAK": "盲阶段的输入里出现了本该扣住的产物——这是泄漏本身，不是复用的副作用。",
        "gates.code.E_CLAIM_MULTIPLE": "一张卡给了不止一个主张。卡的意义就是\"这一阶段只说一件事\"——多于一个，读的人就没法判断你到底在要什么，也没法逐条吵。拆成两张卡。",
        "gates.code.E_CONFLICT_UNRESOLVED": "有冲突但没有任何裁定。冲突不藏是这个流水线存在的理由之一——把它挂着往下走，等于让 build 阶段自己猜用哪一条。",
        "gates.code.E_CONFLICT_UNRULED": "冲突的裁定不成立：`rule` / `decided` / `reason` 缺一，或用了 R2/R3 却没记 `dropped[]`（被删掉的那方原文）。没有 `dropped[]` 的\"取交集\"和\"取小\"是没法复核的——谁被牺牲了，账上没有。",
        "gates.code.E_LEDGER_DROPPED": "会议块里出现了这个块不认识的键，它的值没有落地——只留了这一条声音。所以那一行写了等于没写，而写的人以为它生效了。照着 `team-board-meeting` 认的键重写这一行，或把它挪到真正负责那个字段的块里去。",
        "gates.code.E_LEDGER_PARTIAL": "账本只写进去了一半：父任务的会议头块在、某个阶段的子块不在；或者子块在、父块不见了。这和\"这个阶段还没开始\"是两件不同的事——**读不出来不等于没跑过**。先修账本，或交人。绝不许把缺的那一段当成没发生过、从第一阶段重跑：那会把已经做完的活全部作废，而且不留任何痕迹说明作废过。",
        "gates.code.E_LEDGER_STRAY_STAGE": "账本里有这个阶段，但它不在当前预设的阶段图里——多半是升档/降档留下的历史记录。保留它、如实列出来，但不让它参与\"跑到哪了\"的计算：否则一次换档就会把当前该跑哪个阶段算错。",
        "gates.code.E_LEDGER_UNREADABLE": "会议账本读不出来，无法判断跑到哪了。**绝不许从第一阶段重来**——那会把已经做完的活全部作废，而且没有任何痕迹说明作废过。先修账本，或交人。",
        "gates.code.E_LEDGER_WRITE_FAILED": "往任务树里写账本失败了——建子任务没成功，或更新被拒、超时。**账本没记上不等于阶段没跑**：这个阶段可能已经真的跑完了，产物在会话里，只是没落到板上。所以这里绝不许重发这个阶段，重发会让同一阶段执行两次，而账本只会记下第二次。先修好写路径（看 revision 是不是被别人推进了、宿主还连得上吗），再把这次的结果补记上去。",
        "gates.code.E_MEETING_ABANDONED": "这场会议已被放弃（abandoned），不会再推进任何阶段。要接着做请开一场新的会，并把这场会的产物作为输入带过去——那样至少账本上说得清哪一场做了什么，而不是让一场被放弃的会悄悄接着往下跑。",
        "gates.code.E_MEETING_INTERRUPTED": "这个会议被中断过——有阶段没跑完就换了轮次。这里只留痕、不拦。要注意的是它留下的是一个空洞：中断那次输入了什么、输出了什么，账本上都缺一段，回头读会觉得那一轮本来就没有内容。",
        "gates.code.E_NO_CHALLENGE": "反方一个问题都没提。开会的第一阶段就是\"先砍需求\"——一个零问题的反方等于没开这个会。至少写出一个具体问题（不是\"需求可以更清晰\"这种）。",
        "gates.code.E_NO_KILL_SCENARIO": "红队没有列出足够的具体失败情形。要求的是\"这个东西怎么坏\"的具体剧本，不是\"可能有风险\"。数量门槛单独出码，因为凑数在这条上最容易发生——写 3 条软的在门禁上和写 3 条硬的一模一样。",
        "gates.code.E_NO_SIGNOFF": "签收阶段没有给出明确结论（要 / 不要）。「验过没问题」和「我决定收下」是两件事——验是 qa 做的，签是客户做的，混在一起就是自审的变种。",
        "gates.code.E_PRESET_BACKFILL_MISSING": "升档之后，旧档位产出的阶段产物没有补齐新档位要求的字段。升档不是改个名字——新档位多出来的阶段/字段必须有出处，否则账本会显示成\"按 standard 跑完了\"，而实际只跑了 lite 的部分。",
        "gates.code.E_PRESET_DOWNGRADE": "试图降档。这条流水线只许升不许降：降档意味着\"已经怀疑过的部分不怀疑了\"，而那些怀疑的结论还在账本里——账本会与档位对不上，且没人知道该信哪个。换挡权在人手上，且只能往上。",
        "gates.code.E_PRESET_EMPTY_IMPLEMENTED": "预设声称已实现，却一个阶段都没有。零阶段的档位跑起来会立刻\"完成\"——那不是实现，是空壳：它会一路绿着通过，而什么都没做。要么把 implemented 改成 false 承认还没做完，要么把阶段补齐。",
        "gates.code.E_PRESET_NO_BLIND_STAGE": "这份预设一个盲阶段都没有。没有盲阶段就没有独立复核——被审的人看得见审的人先前写下的推理，那这条流水线只是把一个人的想法拆成七段说出来。加一个 blind 阶段（并且它看不见被审对象的推理），或换一份有盲阶段的档位。",
        "gates.code.E_PRESET_NOT_FOUND": "声明了预设，但加载不到。**绝不回退默认档**——回退等于让一份写了 `standard@1` 的会议在没人发现的情况下按 `lite@1` 跑完，而账本上还写着 standard。",
        "gates.code.E_PRESET_NOT_IMPLEMENTED": "这个档位存在、数据也合法，但它还没有实现（注册表里 implemented 是 false）——现在跑它跑不到底。加载本身是成功的，所以这条只出声、不拦；但别把\"加载成功\"当成\"能用\"。",
        "gates.code.E_PRESET_STAGE_SKIPPED": "这个预设的必过阶段没有对应任务。必过就是必过——缺了它，后面阶段的结论就没有前提出处。",
        "gates.code.E_PRESET_UPGRADED": "本会议发生过升档。留痕用——升档本身是允许的，但\"升过档\"这件事必须留在账本上，否则回头看会以为一路都是高档位。",
        "gates.code.E_RESUME_EXHAUSTED": "同一阶段已连续 3 次发「继续」仍无产物，止损——交人。继续发第 4 次大概率只是让一个坏掉的 agent 多跑一轮。",
        "gates.code.E_RESUME_LIVENESS_UNKNOWN": "存活判定是 unknown：既不能说它还在动，也不能说它已经停了。这时发「继续」是安全的（幂等，若它真在跑，这一条不会产生第二个产物），但请记住这一条是\"因为判不出来才发的\"，不是\"确认它卡住了\"。",
        "gates.code.E_RESUME_NO_TARGET": "收到「继续」，但当前没有未完成的会议。空态显式说出来——不然发的人会以为消息丢了，然后重发好几次。",
        "gates.code.E_SUGGEST_UPGRADE": "有信号建议升档（例如冲突数、返工次数、被判\"判不了\"的次数超阈值）。只是建议。",
        "gates.code.E_UPGRADE_NO_REASON": "升档时没写理由。升档本身允许，但没有理由的升档在账本上等于\"不知道为什么多跑了三个阶段\"。",
        "gates.code.E_UPGRADE_SAME_TIER": "要换去的档位就是当前档位——这不是升档，是空操作。**一次都不写**：在 append-only 的历史里留下一条\"X → X\"，回头看会以为这里真的换过档。要么把目标改成更高的档位，要么这件事本来就不需要动。",
      /* @meeting-codes:end */
      'gates.code.unknown': '未知门禁',
      'gates.group.hard': '真阻断 · 要改代码',
      'gates.group.precondition': '前提缺失 · 要补信息',
      'gates.group.preconditionHint': '这一组改代码解决不了：宿主没提供判定所需的信息，或功能层没挂上。',
      'board.title': '任务板',
      /* ── 以下这批只有页面在用，暂住客户端表（`locale/*.json` 是另一个成员的写域）──
       * 回报里已列给 lead 等待收编。`test/client.test.mjs` 新增的第 15 条钉住
       * "K 里的每个 key 在 zh/en 两张表里都在，且两张表 key 集合一致"。 */
      'gates.undecidable': '无法判定',
      'gates.causes': '独立根因',
      'gates.graphNote': '线 = 这个根因落在哪条任务上。连进多条线的任务，是被几个根因同时卡住的。',
      'gates.globalCause': '全局',
      'card.sub.agent': '这块说清数据从哪来、模型能不能看见这两个工具',
      'card.sub.verdict': '整页最重要的一行：这批活现在能不能收',
      'card.sub.gates': '每条阻断落在哪些任务上——线多的地方就是卡住交付的根因',
      'card.sub.ledger': '谁擅长什么、上次踩过什么坑，决定下一轮该派给谁',
      'card.sub.board': '宿主任务板的结构化视图；「未声明」表示这条任务没写声明块',
      'board.declaredCaption': '申报改动',
      'action.expand': '展开',
      'action.collapse': '收起',
      'board.undeclared': '未声明',
      'board.rawNote': '宿主没有提供结构化任务数据。下面折叠的是给模型看的原文（定宽、为对齐而生），页面不解析它：按空格重切会把一个精心构造的标题解析成一条不存在的任务。',
      'board.empty': '板上没有任务（读到了，就是零条，不是读不出来）。',
      'board.col.id': 'ID',
      'board.col.kind': '类型',
      'board.col.status': '状态',
      'board.col.subject': '标题',
      'board.col.owner': '归属',
      'board.status.pending': '待办',
      'board.status.inProgress': '进行中',
      'board.status.completed': '已完成',
      'board.status.failed': '失败',
      'board.status.cancelled': '已取消',
      'decide.title': "待拍板",
      'card.sub.decide': "还没拍的事：这是页面上唯一\"要动手\"的一块",
      'action.more': "还有 {n} 条",
      'decide.empty': "没有待拍板的条目（准入三条全过、六个槽位齐备的才进这张清单）。",
      'decide.unavailable': "读不到待拍板数据（这是\"拿不到\"，不是\"没有待办\"）。",
      'decide.suggest': "提建议",
      'decide.suggestPlaceholder': "写下你的意见（不改决议）",
      'decide.suggestSubmit': "发送",
      'decide.suggestCancel': "取消",
      'decide.status.pending': "待拍板",
      'decide.status.decided': "已拍板",
      'decide.verdict.approve': "准",
      'decide.verdict.reject': "驳",
      'decide.verdict.hold': "待定",
      'decide.writeback.ok': "已回写",
      'decide.writeback.failed': "回写失败",
      'decide.retry': "重试",
      'decide.noRef': "无来源",
      'decide.noDefault': "默认值：无",
      'decide.pendingCount': "待办 {pending} / 共 {total}",
      'decide.group.unknown': "未声明来源",
      'decide.noOwner': "无归属·不可拍板",
      'decide.undecided': "待拍板",
      'decide.impact': "影响",
      'decide.noDue': "无截止日",
    };

    const en = {
      'meeting.title': 'Meeting ledger',
      'meeting.sub': 'Which stage this meeting has reached, and what each stage produced',
      'meeting.state.none': 'No meeting ledger on the board at all — that is "there really is none", not "cannot be read"',
      'meeting.state.ok': 'The meeting ledger can be read',
      'meeting.state.unreadable': 'The meeting ledger cannot be read',
      'meeting.state.unavailable': 'The gates themselves are unavailable, so the meeting ledger cannot be assessed at all',
      'meeting.state.noCriterion': 'This block supplied no criterion (readable is not a boolean), so it is treated as unavailable — that is neither a guess nor "there really is none"',
      'meeting.state.unknownState': 'The meeting ledger reported a state value this page does not recognise, so this block is treated as unavailable',
      'meeting.cause': 'cause',
      'meeting.meta.id': 'meeting',
      'meeting.meta.preset': 'preset',
      'meeting.plan.progress': '{done}/{total} done — still to go: {remaining}',
      'meeting.plan.allDone': '{n}/{n} done — this meeting ran to the end',
      'meeting.meta.status': 'status',
      'meeting.col.stage': 'stage',
      'meeting.col.attempt': 'round',
      'meeting.col.status': 'status',
      'meeting.col.produced': 'produced',
      'meeting.stageUnknown': '(stage name unreadable)',
      'meeting.noProduced': 'nothing declared',
      'shadow.title': 'Gate coverage',
      'shadow.sub': 'How many tasks this round actually checked, and how many of those had no input at all',
      'shadow.judged': 'reached a gate',
      'shadow.withInput': 'had input',
      'shadow.meeting': 'meeting tasks (excluded)',
      'shadow.judgedHint': 'tasks whose kind put them in front of the gates',
      'shadow.withInputHint': 'of those, the ones with something to check — this is the honest denominator',
      'shadow.meetingHint': 'meeting-ledger tasks, excluded from both numbers above',
      'shadow.reason.tasks': 'The task list itself could not be read, so there are no numbers for this round',
      'shadow.reason.noTasks': 'There are no tasks at all (read successfully, and there are zero)',
      'shadow.reason.noJudged': 'There are tasks, but none of them reached a gate — the zeros above are measurements, not a read failure',
      'declaration.title': 'Declaration warnings',
      'tab.ledger': 'Ledger',
      'page.title': 'Team ledger',
      'page.footer': 'The context plugin answers "can we keep going"; this page answers "can this batch be delivered, and who should get the next task".',
      'state.loading': 'Loading…',
      'state.error': 'Host data unavailable',
      'switch.on': 'On',
      'switch.off': 'Off',
      'switch.hint': 'When off, both team_board and team_deliver are hidden from the model (applies from the next step)',
      'source.label': 'Data source',
      'source.agentTeams': 'Agent Teams task board',
      'source.roster': 'Delegation roster',
      'source.unavailable': 'Unavailable',
      'source.unavailableHint': 'Neither an Agent Teams task board nor a delegation roster is available — this is "cannot read", not "zero rows".',
      'source.disabledHint': 'Switched off — you turned it off, so this page reads nothing and makes no judgement about the work.',
      'source.count': '{n} total ({running} running)',
      'roster.title': 'Delegation roster',
      'roster.unnamed': '(unnamed)',
      'roster.runningGlyph': '🔄',
      'roster.idleGlyph': '·',
      'roster.depth': 'depth {n}',
      'ledger.title': 'Role ledger',
      'ledger.status.ok': 'on record',
      'ledger.status.empty': 'no history',
      'ledger.status.unavailable': 'unavailable',
      'ledger.empty': 'No history: no role has been recorded yet, so all five numbers are 0 — that means "no history", not "a clean record".',
      'ledger.unavailable': 'Unavailable: storage could not be read, so this block reaches no conclusion (this is not "no history").',
      'ledger.completed': 'completed',
      'ledger.abortedWithOutput': 'aborted with output',
      'ledger.abortedWithoutOutput': 'aborted with nothing',
      'ledger.failed': 'failed',
      'ledger.failedWithoutOutput': 'failed with nothing',
      'ledger.pitfalls': 'Last pitfall',
      'ledger.noPitfall': '—',
      'gates.title': 'Delivery gate',
      'gates.ok': 'ready to declare delivery',
      'gates.blocked': 'cannot declare delivery',
      'gates.blockers': 'Blockers',
      'gates.warnings': 'Warnings',
      'gates.none': 'None',
      'gates.unavailable': 'Unavailable: this host has no Agent Teams task board, so the gate cannot run.',
      'gates.noAgent': 'Unavailable: this session has no live Agent, so the gate cannot run.',
      'gates.error': 'Unavailable: the check itself failed.',
      'gates.phaseUnknown': 'The team phase is unknown, so this is treated as "not eligible to deliver" (visible, not silent).',
      'gates.code.E_ACCEPTANCE_MISMATCH': 'Acceptance was not reconciled item by item: an item has no result, or its result is not a pass — record a passing result for each.',
      'gates.code.E_AUDIT_UNWIRED': "This run had no audit input (neither digests nor diff were provided), so \"no out-of-scope change\" cannot be concluded — supply audit input, or read this as \"not checked\".",
      'gates.code.E_BINDING_STALE': 'An artifact changed after it was reviewed (digest mismatch, it appeared, or it vanished) — review it again before delivering.',
      'gates.code.E_BINDING_UNVERIFIABLE': 'A review record lists artifacts with no digest, so tampering after review cannot be ruled out — record a sha256 per artifact when re-reviewing.',
      'gates.code.E_CANCELLED_NO_REASON': 'A task was cancelled with no reason recorded — add a cancelReason, or nobody can tell why it was dropped.',
      'gates.code.E_CHANGED_PATHS_REQUIRED': 'An implementation task declared no changed paths at all — with no change there is nothing to deliver; confirm the work actually landed.',
      'gates.code.E_CONTRACT_AMBIGUOUS': "The same contract field is written both in task.contract and at the task's top level, with different values — keep one (contract wins); the gate will not pick for you.",
      'gates.code.E_CONTRACT_INCOMPLETE': 'This task declares no acceptance items or no verify commands — add both before it can be accepted; omitting one field would switch the whole gate off, which is why it is refused.',
      'gates.code.E_DECLARATION_MISSING': 'Task kind not declared',
      'gates.code.E_EVIDENCE_UNBACKED': "An acceptance item's evidence is not a successful receipt (a file path, a missing receipt, or a non-zero exit) — a file existing is not proof of a run; cite a passing receipt.",
      'gates.code.E_FAILED_NO_FOLLOWUP': 'A task failed and no follow-up task continues it — the failure is swallowed silently; add a rework task, or say why none is needed.',
      'gates.code.E_FINDINGS_REQUIRED': 'A needs-revision/reject verdict came with no findings at all — list the concrete problems, or the owner cannot know what to change.',
      'gates.code.E_ILLEGAL_TRANSITION': 'Transition refused: no from/to, no such edge in the table, or the wrong actor asked for it — fix the transition request, not the task.',
      'gates.code.E_INDEPENDENCE_UNENFORCED': 'Independence not enforced',
      'gates.code.E_INPUT_INVALID': 'Input failed the allow-list (a round number that is not a positive integer, or a misspelled/missing verdict, severity, kind or status) — resend valid input; changing code cannot clear this.',
      'gates.code.E_MEETING_MISSING': 'An implementation task names no proposal it came from (no proposalId) — write a kind: proposal task first and put its id in the contract; if no discussion is needed, write proposalId: skip with a reason.',
      'gates.code.E_MEETING_SKIP_UNEXPLAINED': 'The task declares it skipped the meeting but gives no reason — an exception is allowed, but it must leave a trace: put "why this does not need discussing first" into skipMeeting.',
      'gates.code.E_MEETING_SKIPPED': 'This implementation task skipped the meeting (reason recorded) — it does not block delivery, but the ledger keeps it, so a review can see which work started without discussion.',
      'gates.code.E_NEEDS_HUMAN_APPROVAL': 'The team is still waiting for human approval — the work is not the problem; wait for the approval and a running team before declaring delivery.',
      'gates.code.E_NEEDS_HUMAN_DELIVERY': 'No valid host-issued delivery record exists (missing issuer, call id, or evidence digest) — this needs a host-side action; the plugin may not issue one.',
      'gates.code.E_NOT_RUNNING': 'The team is stopped, or its phase is unrecognizable (only running qualifies) — bring it back to running; only a running team may declare delivery.',
      'gates.code.E_NO_ASSIGNEE': 'Other tasks have owners but this quality task has none — ownership must be all-or-nothing; assign an owner.',
      'gates.code.E_NO_PASSING_REVIEW': 'An implementation task is complete, but the team has no completed review that passed — assign a review and record a pass.',
      'gates.code.E_OPEN_FINDINGS': 'The verdict says pass while serious findings are still open — close those findings first, or change the verdict to not-pass.',
      'gates.code.E_OUT_OF_SCOPE': 'A declared path is not inside the declared inScope (or hits outOfScope) — narrow the change, or amend the scope first.',
      'gates.code.E_PATH_UNSAFE': 'A path falls outside the workspace (absolute, .. traversal, ~ prefix, or a drive letter) — use a relative path inside the workspace.',
      'gates.code.E_PHANTOM_CHANGES': 'A declared change does not exist in the real diff — a phantom entry; declare only the paths you actually changed.',
      'gates.code.E_PROPOSAL_KIND': 'proposalId points at a task that is not a proposal (wrong kind) — pointing at an implementation or review task as "the plan" is approving your own plan.',
      'gates.code.E_PROPOSAL_NOT_READY': 'The proposal it points at is not completed — the meeting had not finished before work started; assign the implementation once the plan is settled.',
      'gates.code.E_PROPOSAL_UNKNOWN': 'proposalId points at a task that does not exist — a dangling pointer; a mistyped id is as good as none, yet far easier to misread as "we met".',
      'gates.code.E_PROPOSAL_UNREVIEWED': 'The proposal is completed but no review in the team has read it — minutes nobody read are the same as no meeting; assign a review and record a verdict.',
      'gates.code.E_QUESTIONS_UNANSWERED': 'Questions the proposal promised to confirm with a human were not answered one by one — write "<question> → <answer>" for each, or drop the question (declare an empty list if there is nothing to ask).',
      'gates.code.E_REPORTED_UNCHANGED': 'A task declared a changed file that is absent from the workspace diff — either that change never happened, or it happened somewhere else ("changed but not declared" and "declared but not changed" are two separate debts; neither offsets the other).',
      'gates.code.E_BASIS_FABRICATED': 'A basis this task cites (source task / source review / reviewed task) is absent from the task table — these fields only take effect when they match something and are silent otherwise, so a fabricated reference looks exactly like a real one on the page. Point it at a task id that exists, or drop the field.',
      'gates.code.E_ARTIFACT_UNVERIFIED': 'No fingerprint can be found in the workspace for a path this task declared — missing and unreadable are indistinguishable at this layer, which is why this code does not say "absent". First decide whether the file should exist: restore it, or drop it from the declaration (note: the remedy is not "add a review" — a review cannot bind a file that is not there).',
      'gates.code.E_REVIEW_STAGNATION': 'One person passed the same file three or more times running — a hint of attention fatigue, not a delivery blocker; rotate the reviewer and this clears.',
      'gates.code.E_SCOPE_UNDECLARED': 'Changes were declared with no scope at all — without scope there is nothing to audit against; write inScope and outOfScope first.',
      'gates.code.E_SELF_REVIEW': "The reviewer and the task's owner are the same person, so the review is not independent — have someone else review it.",
      'gates.code.E_STALE_ATTEMPT': 'This receipt or review belongs to another round (or names none), so it cannot vouch for this one — rerun it this round and submit the new receipt.',
      'gates.code.E_TASK_INCOMPLETE': 'Tasks are still pending / claimed / in progress with no conclusion — finish or cancel them first.',
      'gates.code.E_UNBOUND_ARTIFACT': "The paths this task declared have no passing review bound to that same task — another task's pass does not count; review this one.",
      'gates.code.E_UNREPORTED_CHANGES': 'Files really changed in the workspace but are missing from the declared list — declare them, or revert them.',
      'gates.code.E_VERDICT_REQUIRED': 'The review gave no verdict, or its verdict was needs-revision/reject — only a pass counts as done; fix the work and review again.',
      'gates.code.E_VERIFY_FAILED_BY_RUNTIME': 'A verify command exited non-zero, so it did not actually pass — fix it until it is green, or replace that command.',
      'gates.code.E_VERIFY_MISSING': 'A required verify command has no receipt at all, so it cannot be shown to have run — run it and submit the receipt.',
      'gates.code.E_WORK_DECLARED_CHANGES': 'A read-only work task declared changed files — that kind must not produce changes; revert them, or change the task kind.',
      /* @meeting-codes:begin 由 tools/gen-meeting-codes.mjs 生成，勿手改 */
        "gates.code.E_AGENT_OVERRIDE_NO_REASON": "A leader changed the reuse mode but gave no reason. Overriding is allowed, yet the ledger will read \"someone was swapped for unknown reasons\" — and a swap is exactly the thing that most needs to be explainable afterwards. Say why the swap happened, or withdraw the override and go back to the default mode.",
        "gates.code.E_AGENT_SHARED_ACROSS_MEETINGS": "The same agent is being sent to another meeting for the same role, but isolation cannot be verified: this stage declares no artifacts to withhold, so there is no way to show it has not seen that meeting's conclusions. Cross-meeting reuse requires isolation to hold — not a \"fork\" declaration. A fork inherits context, which is the opposite: it carries one meeting's conclusions into the other. Either have the stage declare what it withholds, or use someone who was never in that meeting.",
        "gates.code.E_ARTIFACT_MALFORMED": "The card for this stage is malformed and still unparseable after two repair attempts — missing fields, wrong types, or not the agreed shape. Resubmit one card following submit_artifact; do not proceed on a guess about what it probably meant.",
        "gates.code.E_ARTIFACT_MISSING": "This stage is marked complete but its required fields were not submitted — a stage with no artifact means the meeting never really happened, and every later stage is built on air.",
        "gates.code.E_ARTIFACT_PARTIAL": "Some card fields are missing but there is enough to continue. What is missing will surface later as \"that was never specified\" — noted.",
        "gates.code.E_BLIND_AGENT_REUSED": "The agent reused for this blind stage has already seen artifacts that were supposed to be withheld (seenIds intersects withheldIds). The entire value of a blind review is that it has not seen them; reusing it turns blind review into restatement. Use a fresh agent.",
        "gates.code.E_BLIND_LEAK": "Artifacts that were supposed to be withheld appear in a blind stage’s input — this is the leak itself, not a side effect of reuse.",
        "gates.code.E_CLAIM_MULTIPLE": "One card carries more than one claim. A card exists so that a stage says exactly one thing — with more than one, the reader cannot tell what is being asked for, and nothing can be argued point by point. Split it.",
        "gates.code.E_CONFLICT_UNRESOLVED": "A conflict exists with no ruling at all. Not hiding conflicts is one of the reasons this pipeline exists — leaving it open means the build stage silently guesses which side to follow.",
        "gates.code.E_CONFLICT_UNRULED": "The ruling does not hold: one of rule / decided / reason is missing, or R2/R3 was used without dropped[] (the losing text). An \"intersection\" or \"take the smaller\" with no dropped[] cannot be reviewed — the ledger does not say who was sacrificed.",
        "gates.code.E_LEDGER_DROPPED": "The meeting block contained a key this block does not recognise, so its value was not persisted — only this note remains. The line was written as if it took effect, and it did not. Rewrite it using the keys `team-board-meeting` accepts, or move it into the block that actually owns that field.",
        "gates.code.E_LEDGER_PARTIAL": "Only half of the ledger got written: the parent task carries the meeting header block while a stage child block is absent, or the child block is there while the parent block is gone. That is a different thing from \"this stage has not started\" — an unreadable stage is not a stage that never ran. Repair the ledger, or hand it to a human. Never treat the missing piece as work that never happened and rerun from stage one: that voids work already done and leaves no trace that it was voided.",
        "gates.code.E_LEDGER_STRAY_STAGE": "The ledger holds this stage, but it is not in the current preset’s stage graph — most likely a leftover from an upgrade or a downgrade. Keep it and list it plainly, but do not let it into the \"where are we now\" calculation: otherwise one tier change shifts which stage should run next.",
        "gates.code.E_LEDGER_UNREADABLE": "The meeting ledger cannot be read, so the current position is unknown. Never restart from stage one — that voids work already done and leaves no trace that it was voided. Repair the ledger, or hand it to a human.",
        "gates.code.E_LEDGER_WRITE_FAILED": "Writing the ledger into the task tree failed — creating the child task did not go through, or the update was rejected or timed out. A ledger that never got the write does not mean the stage never ran: this stage may well have finished, with its artifact sitting in the session and only the board missing it. So this must never resend the stage — resending executes one stage twice while the ledger records only the second run. Fix the write path first (check whether the revision was advanced by someone else, and whether the host is still reachable), then record this result.",
        "gates.code.E_MEETING_ABANDONED": "This meeting has been abandoned and will not advance any further stage. To carry on, open a new meeting and bring this one’s artifacts in as input — at least then the ledger can say which meeting did what, instead of an abandoned meeting quietly running on.",
        "gates.code.E_MEETING_INTERRUPTED": "This meeting was interrupted — a stage ended unfinished and the round moved on. This is recorded, not blocked. What it leaves is a hole: the inputs and outputs of that round are simply missing, so a later reader will conclude the round had no content at all.",
        "gates.code.E_NO_CHALLENGE": "The challenger raised no questions at all. The first stage exists to cut requirements down — a challenger with zero questions means the meeting did not happen. Write at least one concrete question (not \"the requirements could be clearer\").",
        "gates.code.E_NO_KILL_SCENARIO": "The red team did not list enough concrete failure scenarios. What is required is specific \"how this breaks\" scripts, not \"there may be risks\". The count threshold has its own code because padding is easiest exactly here — three soft entries pass this gate identically to three hard ones.",
        "gates.code.E_NO_SIGNOFF": "The signoff stage gave no explicit decision (accept / reject). \"It passed verification\" and \"I decide to accept it\" are two different acts — verification belongs to QA, acceptance belongs to the client; merging them is a variant of self-review.",
        "gates.code.E_PRESET_BACKFILL_MISSING": "After an upgrade, artifacts produced under the old tier are missing fields the new tier requires. Upgrading is not a rename — the stages and fields the new tier adds must have a source, otherwise the ledger reads \"ran as standard\" when only part of lite actually ran.",
        "gates.code.E_PRESET_DOWNGRADE": "An attempt to downgrade. This pipeline only moves up, never down: downgrading means \"the parts already doubted no longer need doubting\", while the conclusions of that doubting remain in the ledger — ledger and tier disagree and nobody knows which to trust. Gear-shifting belongs to the human, and only upward.",
        "gates.code.E_PRESET_EMPTY_IMPLEMENTED": "The preset claims to be implemented but has no stages at all. A zero-stage tier finishes the moment it starts — that is not an implementation, it is a shell that passes everything while doing nothing. Either set implemented to false to admit it is unfinished, or fill in the stages.",
        "gates.code.E_PRESET_NO_BLIND_STAGE": "This preset has no blind stage at all. Without one there is no independent review — the reviewer can see the reasoning the reviewed just wrote, so the pipeline only splits one person’s thinking into seven segments. Add a blind stage (one that cannot see the reviewed side’s reasoning), or use a tier that has one.",
        "gates.code.E_PRESET_NOT_FOUND": "A preset was declared but cannot be loaded. Never fall back to the default tier — falling back would let a meeting that says standard@1 quietly run as lite@1 while the ledger still says standard.",
        "gates.code.E_PRESET_NOT_IMPLEMENTED": "This tier exists and its data is valid, but it is not implemented yet (the registry entry has implemented: false) — running it now cannot reach the end. Loading itself succeeds, so this note only speaks and does not block; just do not read \"it loaded\" as \"it works\".",
        "gates.code.E_PRESET_STAGE_SKIPPED": "A mandatory stage of this preset has no corresponding task. Mandatory means mandatory — without it, the conclusions of later stages have no antecedent.",
        "gates.code.E_PRESET_UPGRADED": "This meeting was upgraded at some point. This is a record, not a defect — upgrading is allowed, but the fact of it must stay in the ledger or a later reader will assume the higher tier applied throughout.",
        "gates.code.E_RESUME_EXHAUSTED": "Three consecutive \"continue\" messages on the same stage produced no artifact. Stop here and hand it to a human — a fourth is probably just giving a broken agent one more round.",
        "gates.code.E_RESUME_LIVENESS_UNKNOWN": "The liveness check came back unknown: it is neither clearly running nor clearly stopped. Sending \"continue\" is safe here (it is idempotent; if the agent really is running, this message produces no second artifact), but remember that this one was sent because it could not be judged, not because it was confirmed stuck.",
        "gates.code.E_RESUME_NO_TARGET": "A \"continue\" arrived but no meeting is unfinished. Say the empty state plainly — otherwise the sender assumes the message was lost and sends it several more times.",
        "gates.code.E_SUGGEST_UPGRADE": "Signals suggest upgrading (for example conflict count, rework count, or \"cannot judge\" count over threshold). A suggestion only.",
        "gates.code.E_UPGRADE_NO_REASON": "An upgrade carried no stated reason. Upgrading is allowed, but an upgrade with no reason reads in the ledger as \"three extra stages ran for unknown reasons\".",
        "gates.code.E_UPGRADE_SAME_TIER": "The tier you asked to shift to is the tier this meeting is already on — that is a no-op, not an upgrade. Nothing is written: an \"X → X\" line in an append-only history makes a later reader think a shift actually happened here. Either name a higher tier, or accept that nothing needs to change.",
      /* @meeting-codes:end */
      'gates.code.unknown': 'Unknown gate',
      'gates.group.hard': 'Real blockers · code must change',
      'gates.group.precondition': 'Missing preconditions · information must be supplied',
      'gates.group.preconditionHint': 'Changing code cannot clear this group: the host is not supplying what the check needs, or the capability is not mounted.',
      'board.title': 'Task board',
      'gates.undecidable': 'Cannot decide',
      'gates.causes': 'Root causes',
      'gates.graphNote': 'A line = this root cause lands on that task. A task with several lines is blocked by several causes at once.',
      'gates.globalCause': 'global',
      'card.sub.agent': 'Where this data comes from, and whether the model can see the two tools.',
      'card.sub.verdict': 'The one line that matters: can this batch be delivered now?',
      'card.sub.gates': 'Which tasks each blocker lands on; dense lines mark the root cause holding delivery.',
      'card.sub.ledger': 'Who is good at what and what they tripped on last time — i.e. who to send next.',
      'card.sub.board': 'Structured view of the host board; "not declared" means the task has no declaration block.',
      'board.declaredCaption': 'declared changes',
      'action.expand': 'Show',
      'action.collapse': 'Hide',
      'board.undeclared': 'not declared',
      'board.rawNote': 'The host supplied no structured task data. What is folded below is the model-facing text (fixed-width, built for alignment); the page does not parse it, because re-splitting on whitespace would turn a crafted subject into a task row that does not exist.',
      'board.empty': 'No tasks on the board (this was read successfully and is genuinely zero, not unreadable).',
      'board.col.id': 'ID',
      'board.col.kind': 'Kind',
      'board.col.status': 'Status',
      'board.col.subject': 'Subject',
      'board.col.owner': 'Owner',
      'board.status.pending': 'pending',
      'board.status.inProgress': 'in progress',
      'board.status.completed': 'completed',
      'board.status.failed': 'failed',
      'board.status.cancelled': 'cancelled',
      'decide.title': "Awaiting your call",
      'card.sub.decide': "What is still open: the only block on this page that asks you to act.",
      'action.more': "{n} more",
      'decide.empty': "Nothing awaits a decision (a row gets in only by passing all three admission checks and carrying all six slots).",
      'decide.unavailable': "Decision data is unavailable — this is \"cannot read\", not \"nothing pending\".",
      'decide.suggest': "Suggest",
      'decide.suggestPlaceholder': "Your note (does not change the decision)",
      'decide.suggestSubmit': "Send",
      'decide.suggestCancel': "Cancel",
      'decide.status.pending': "Pending",
      'decide.status.decided': "Decided",
      'decide.verdict.approve': "Approve",
      'decide.verdict.reject': "Reject",
      'decide.verdict.hold': "Hold",
      'decide.writeback.ok': "Written back",
      'decide.writeback.failed': "Write-back failed",
      'decide.retry': "Retry",
      'decide.noRef': "no source",
      'decide.noDefault': "no default",
      'decide.pendingCount': "{pending} pending / {total} total",
      'decide.group.unknown': "no source system",
      'decide.noOwner': "no owner · cannot decide",
      'decide.undecided': "Pending",
      'decide.impact': "impact",
      'decide.noDue': "no deadline",
    };

    return {
      /**
       * 客户端模块的 `inject` 有两种名字，**各写各的，谁也不替谁**：
       *
       *   1. `'loader'` —— **加载器服务名**（`dsh-client-modules/lib/client.js:999`
       *      自己导出的就是 `["loader"]`）。缺了它，加载器根本不会执行本模块。
       *   2. `'locale'` / `'slots'` —— **apply 里真正用到的业务服务**
       *      （`ctx.locale`、`ctx.slots`）。服务名合法性有同族证据：
       *      `dsh-client-ui-conversation/lib/client.js:22547` 起的
       *      `["slots","sessions","fileUpload","uiSession","uiWorkspace","locale","configForms"]`、
       *      `dsh-client-ui-sidebar/lib/client.js:666`、`dsh-client-ui-layout/lib/client.js:655`、
       *      `dsh-client-locale/lib/client.js:1779` 都写着 `"slots"` 与 `"locale"`。
       *
       * 为什么必须声明业务服务：cordis 里未在 `inject` 声明的服务若尚未就绪，
       * `apply` 拿到的是未解析代理 —— `ctx.slots.inject(...)` 会挂在一次永不 settle
       * 的等待上，审计词表里那个状态正好叫 `loading`（fiber 已存在、apply 在飞）。
       * 少写一个服务名**不会报错**，只会让条目永久停在 `loading`：这就是这个 bug
       * 能活下来的唯一原因。上一版只写了 `'loader'`，等于没声明业务服务。
       */
      inject: ['loader', 'locale', 'slots'],
      pure,
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: { ...zh, ...reviewClient.reviewMessages.zh }, en: { ...en, ...reviewClient.reviewMessages.en } }), 'team-board: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'team-board',
              order: 40,
              locale: NS,
              label: () => t('tab.ledger'),
              /* 会话作用域的 list slot 会把 sessionId 交给 inject，页面据此向宿主问这个会话的队况。 */
              inject: (sessionId) => ({ sessionId }),
            },
            (props) => h(React.Fragment, null, h(ReviewClientPanel, { ...props, t, key: props.sessionId }), h(LedgerView, { ...props, t })),
          ),
        );
      },
    };
  },
});
