import { reviewViewModel, createReviewRequestGate, decodeReviewResponse } from '../src/review/view-model.mjs';
export const reviewMessages = {
  zh: {
    'review.title': '评审与开发运行', 'review.start': '启动', 'review.requirement': '需求正文', 'review.refresh': '刷新', 'review.empty': '当前会话还没有运行', 'review.loading': '读取运行中…', 'review.error': '操作失败', 'review.mode.review': '只评审', 'review.mode.develop': '实施与验证', 'review.history': '历史任务（只读）', 'review.import': '导入为新运行', 'review.imported': '导入来源', 'review.unknown': '未知', 'review.report': '报告', 'review.logs': '日志', 'review.more': '继续读取', 'review.revise': '修订需求', 'review.reason': '修订原因', 'review.impact': '影响清单 JSON（留空则完整重做）', 'review.submitRevision': '保存修订', 'review.section.run': '运行详情', 'review.section.executions': '角色执行', 'review.section.findings': '意见与问题', 'review.section.decisions': '决定', 'review.section.tasks': '实施任务', 'review.section.checkSpecs': '检查定义', 'review.section.checkResults': '检查结果', 'review.section.report': '报告', 'review.section.history': '操作记录', 'review.section.usage': '运行统计', 'review.pause': '边界暂停', 'review.stop': '立即停止', 'review.resume': '继续', 'review.retry': '重试', 'review.cancel': '取消', 'review.pending': '需要你的选择', 'review.choose': '确认选择', 'review.details': '详细记录', 'review.openLog': '读取日志', 'review.openResult': '读取结果', 'review.noSession': '请打开一个根会话', 'review.readOnly': '历史记录不会自动继续。导入会创建新的运行并保留来源。', 'review.run': '运行', 'review.phase': '阶段', 'review.revision': '需求版本', 'review.storageRevision': '记录版本', 'review.busy': '操作进行中', 'review.lastCommand': '上次命令', 'review.back': '返回分区', 'review.new': '新需求', 'review.previous': '上一页', 'review.partial': '当前显示一页，长内容请继续读取',
  },
  en: {
    'review.title': 'Review and development runs', 'review.start': 'Start', 'review.requirement': 'Requirement', 'review.refresh': 'Refresh', 'review.empty': 'No runs in this session', 'review.loading': 'Loading runs…', 'review.error': 'Operation failed', 'review.mode.review': 'Review only', 'review.mode.develop': 'Implement and verify', 'review.history': 'Historical tasks (read only)', 'review.import': 'Import as a new run', 'review.imported': 'Imported source', 'review.unknown': 'Unknown', 'review.report': 'Report', 'review.logs': 'Logs', 'review.more': 'Load more', 'review.revise': 'Revise requirement', 'review.reason': 'Reason for revision', 'review.impact': 'Impact JSON (empty runs a full review)', 'review.submitRevision': 'Save revision', 'review.section.run': 'Run details', 'review.section.executions': 'Role executions', 'review.section.findings': 'Findings', 'review.section.decisions': 'Decisions', 'review.section.tasks': 'Implementation tasks', 'review.section.checkSpecs': 'Check definitions', 'review.section.checkResults': 'Check results', 'review.section.report': 'Report', 'review.section.history': 'Operation history', 'review.section.usage': 'Run statistics', 'review.pause': 'Pause at boundary', 'review.stop': 'Stop now', 'review.resume': 'Resume', 'review.retry': 'Retry', 'review.cancel': 'Cancel', 'review.pending': 'Your choice is needed', 'review.choose': 'Confirm choice', 'review.details': 'Full record', 'review.openLog': 'Read log', 'review.openResult': 'Read result', 'review.noSession': 'Open a root session', 'review.readOnly': 'History does not resume automatically. Import creates a new run with its source retained.', 'review.run': 'Run', 'review.phase': 'Stage', 'review.revision': 'Requirement version', 'review.storageRevision': 'Record revision', 'review.busy': 'Operation in progress', 'review.lastCommand': 'Last command', 'review.back': 'Back to section', 'review.new': 'New requirement', 'review.previous': 'Previous page', 'review.partial': 'Showing one page; continue to read long content',
  },
};
export function createReviewPanel(React, h) {
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
