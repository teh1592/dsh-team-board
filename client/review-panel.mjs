import { reviewViewModel, reviewRow, reviewControls, discussionView, boardTabs } from '../src/review/view-model.mjs';
import { createBoardRequestState, createReferenceStack, continueBoardReads } from './request-state.mjs';
import { boardStyles } from './styles.mjs';
import { boardMessages } from './messages.mjs';
export const reviewMessages = boardMessages;

export function createReviewPanel(React, h) {
  const uid = () => globalThis.crypto?.randomUUID?.() ?? `board-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sessionStates = new Map();
  function RecordDetails({ value, t }) {
    const [opened, setOpened] = React.useState(false); const [cursor, setCursor] = React.useState(0);
    const content = React.useMemo(() => opened ? JSON.stringify(value, null, 2) ?? '' : '', [opened, value]);
    return h('details', { onToggle: (event) => setOpened(event.currentTarget.open) }, h('summary', null, t('boardUi.raw')),
      opened ? h('div', null, h('pre', null, content.slice(cursor, cursor + 16000)), h('div', { className: 'tb-pagination' },
        cursor ? h('button', { type: 'button', onClick: () => setCursor(Math.max(0, cursor - 16000)) }, t('boardUi.previous')) : null,
        cursor + 16000 < content.length ? h('button', { type: 'button', onClick: () => setCursor(cursor + 16000) }, t('boardUi.more')) : null)) : null);
  }
  function UnifiedBoard({ sessionId, t }) {
    const [, redraw] = React.useState(0); const bump = () => redraw((value) => value + 1);
    const requestRef = React.useRef(null); if (!requestRef.current) { if (!sessionStates.has(sessionId)) sessionStates.set(sessionId, createBoardRequestState({ makeId: uid })); requestRef.current = sessionStates.get(sessionId); }
    const requests = requestRef.current; requests.session(sessionId ?? '');
    const [state, setState] = React.useState({ status: 'loading', value: null });
    const [runs, setRuns] = React.useState({ items: [], cursor: 0, total: null, nextCursor: null });
    const [runId, setRunId] = React.useState(''); const [tab, setTab] = React.useState('overview');
    const [run, setRun] = React.useState(null); const [pages, setPages] = React.useState({});
    const [detail, setDetail] = React.useState(null); const [detailPage, setDetailPage] = React.useState(null);
    const [error, setError] = React.useState(null); const [notice, setNotice] = React.useState(null); const [busy, setBusy] = React.useState(false);
    const refs = React.useRef(null); if (!refs.current) refs.current = createReferenceStack();
    const returnFocus = React.useRef(null); const detailHeading = React.useRef(null);
    const current = React.useRef(null);
    if (!current.current || current.current.sessionId !== sessionId || current.current.runId !== runId || current.current.tab !== tab) current.current = { sessionId, runId, tab };
    const refreshGeneration = React.useRef(0);
    const scope = runId ? `run:${runId}` : 'new';
    const draft = requests.draft('new', { requirement: '', mode: 'review', preset: 'standard@2' });
    const revisionDraft = requests.draft(scope, { requirement: '', requirementEdited: false, reason: '', impact: '' });
    const update = (key, patch) => { requests.updateDraft(key, patch); bump(); };
    const tr = (key, vars) => t(`boardUi.${key}`, vars);
    const label = (value) => { const result = tr(`state.${value}`); return result === `boardUi.state.${value}` ? value : result; };
    const tone = (value) => ['error', 'failed', 'reject'].includes(value) ? 'danger' : ['waiting_user', 'paused', 'needs_revision', 'interrupted'].includes(value) ? 'warn' : ['running', 'queued', 'in_progress'].includes(value) ? 'active' : ['passed', 'accept', 'completed'].includes(value) ? 'success' : 'plain';
    const status = (value) => h('span', { className: 'tb-status', 'data-tone': tone(value) }, label(value ?? 'unknown'));
    const button = (text, fn, disabled = false, props = {}) => h('button', { type: 'button', disabled, onClick: fn, ...props }, text);
    const link = (text, ref, props = {}) => button(text, (event) => open(ref, event), false, { className: 'tb-link', ...props });
    const json = (value) => h('pre', null, JSON.stringify(value, null, 2));
    const fail = (problem) => { if (problem?.name !== 'AbortError') setError(problem.message ?? String(problem)); };
    const ownerIsCurrent = (owner) => current.current.sessionId === owner.sessionId && current.current.runId === owner.runId && requests.enabled();
    const readSection = async (section, cursor = 0, targetRun = runId) => {
      const owner = { sessionId, runId: targetRun };
      if (!ownerIsCurrent(owner)) return;
      try {
        const page = await requests.read(`section:${section}`, `${targetRun}:${section}:${cursor}`, { action: 'read', runId: targetRun, section, cursor });
        if (page && ownerIsCurrent(owner)) setPages((previous) => ({ ...previous, [section]: { ...page, cursor } }));
      } catch (problem) { if (ownerIsCurrent(owner)) { setPages((previous) => ({ ...previous, [section]: { error: problem.message, cursor } })); fail(problem); } }
    };
    const readRun = async (targetRun = runId) => {
      if (!targetRun || !ownerIsCurrent({ sessionId, runId: targetRun })) return;
      try { const value = await requests.read('summary', `${targetRun}:run`, { action: 'read', runId: targetRun, section: 'run' }); if (value && current.current.runId === targetRun) setRun(value); }
      catch (problem) { if (current.current.runId === targetRun) fail(problem); }
    };
    const listRuns = async (cursor = 0) => {
      try { const value = await requests.read('list', `list:${cursor}`, { action: 'list', cursor }); if (value) setRuns({ ...value, cursor }); }
      catch (problem) { fail(problem); }
    };
    const refreshState = async (next) => {
      const owner = current.current; const generation = ++refreshGeneration.current;
      const sameRefresh = () => current.current === owner && refreshGeneration.current === generation;
      setError(null);
      if (next === false) { requests.disable(); setState((previous) => ({ ...previous, value: { ...previous.value, enabled: false } })); }
      try {
        await continueBoardReads(sameRefresh, [async () => {
          const value = await requests.state(next); if (!value) return false;
          setState({ status: 'ready', value });
          if (!value.enabled) { if (sameRefresh()) { setRun(null); setPages({}); setDetail(null); refs.current.clear(); } return false; }
        }, () => listRuns(), () => runId ? readRun() : undefined, () => runId ? loadTab(tab) : undefined]);
      } catch (problem) { if (sameRefresh()) { requests.disable(); setState({ status: 'failed', value: null }); fail(problem); } }
    };
    React.useEffect(() => {
      if (sessionId) refreshState(); else setState({ status: 'ready', value: null });
      return () => { requests.disable(); };
    }, [sessionId]);
    const loadTab = async (selected) => {
      if (!runId || !ownerIsCurrent({ sessionId, runId }) || current.current.tab !== selected) return;
      const sections = selected === 'overview' ? ['tasks'] : selected === 'discussion' ? ['findings', 'decisions', 'executions', 'tasks'] : selected === 'tasks' ? ['tasks'] : ['checkResults', 'executions'];
      // Independent gates for the three bounded pages: one completion cannot cancel another.
      await Promise.all(sections.map((section) => readSection(section, pages[section]?.cursor ?? 0)));
    };
    React.useEffect(() => {
      setError(null); setDetail(null); setDetailPage(null); refs.current.clear(); requests.cancel('reference');
      if (runId && requests.enabled()) { readRun(); loadTab(tab); }
      return () => { requests.cancel('summary'); for (const key of ['tasks', 'findings', 'decisions', 'executions', 'checkResults']) requests.cancel(`section:${key}`); };
    }, [runId, tab, state.value?.enabled]);
    React.useEffect(() => { if (detail) detailHeading.current?.focus(); }, [detail]);
    const selectContext = (next) => { setRunId(next); setRun(null); setPages({}); setTab('overview'); setError(null); setNotice(null); };
    const queryDetail = async (ref) => {
      setDetailPage(null); if (!ref || ref.local || ['new', 'records', 'revise'].includes(ref.section)) return;
      const target = runId;
      try {
        const page = await requests.read('reference', `${target}:${ref.section}:${ref.id ?? ''}:${ref.cursor}`, { action: 'read', runId: target, section: ref.section, cursor: ref.cursor, ...(ref.id ? { id: ref.id } : {}) });
        if (page && current.current.runId === target) setDetailPage({ ...page, cursor: ref.cursor });
      } catch (problem) { fail(problem); }
    };
    const open = (ref, event) => { if (!refs.current.depth()) returnFocus.current = event?.currentTarget ?? null; const next = refs.current.open(ref); setDetail(next); setError(null); queryDetail(next); };
    const close = () => { requests.cancel('reference'); const next = refs.current.back(); setDetail(next); setError(null); if (next) queryDetail(next); else { setDetailPage(null); returnFocus.current?.focus?.(); } };
    const clearDetail = () => { refs.current.clear(); setDetail(null); setDetailPage(null); requests.cancel('reference'); returnFocus.current?.focus?.(); };
    const operate = async (intentScope, request) => {
      if (busy) return; const owner = { ...current.current }; setBusy(true); setError(null);
      try {
        const result = await requests.write(intentScope, request, run?.revision);
        if (result.pending || !result.visible) return;
        if (request.action === 'start') { clearDetail(); selectContext(result.value.runId); await listRuns(); }
        else if (ownerIsCurrent(owner)) { const readOwner = current.current; await continueBoardReads(() => current.current === readOwner && requests.enabled(), [() => readRun(), () => loadTab(readOwner.tab)]); }
        else setNotice(tr('savedElsewhere'));
      } catch (problem) { if (current.current.sessionId === owner.sessionId && requests.enabled()) { if (request.action === 'start' || ownerIsCurrent(owner)) fail(problem); else setNotice(tr('savedElsewhere')); if (problem.message.includes('REVISION_CONFLICT') && ownerIsCurrent(owner)) await readRun(); } }
      finally { if (current.current.sessionId === owner.sessionId) setBusy(false); }
    };
    const retry = (intentScope) => {
      const payload = requests.pending(intentScope); if (!payload) return;
      const { operationId, expectedRevision, requestId, ...request } = payload; operate(intentScope, request);
    };
    const retryButton = (intentScope) => requests.pending(intentScope) ? button(tr('operationRetry'), () => retry(intentScope), busy) : null;
    const pagination = (page, fn, textMode = false) => page ? h('div', { className: 'tb-pagination' },
      page.cursor > 0 ? button(tr('previous'), () => fn(Math.max(0, page.cursor - (textMode ? 16000 : 20)))) : null,
      Number.isSafeInteger(page.total) ? h('span', null, tr('range', { start: page.total ? (page.cursor ?? 0) + 1 : 0, end: (page.cursor ?? 0) + (page.items?.length ?? page.executions?.length ?? 0), total: page.total })) : page.truncated ? h('span', null, tr('partial')) : null,
      page.nextCursor !== null && page.nextCursor !== undefined ? button(tr('more'), () => fn(page.nextCursor)) : null) : null;
    const related = (row, showMissing = false) => row.refs?.length ? h('div', { className: 'tb-related' }, h('span', { className: 'tb-muted' }, tr('related')), row.refs.map((ref) => link(`${tr(ref.section)} · ${ref.id}`, ref, { key: `${ref.section}:${ref.id}` }))) : showMissing ? h('p', { className: 'tb-muted' }, tr('noRelation')) : null;
    const rowNode = (row) => h('article', { className: 'tb-item', key: row.key },
      h('div', { className: 'tb-item-head' }, link(row.title, { section: row.section, ...(row.recordId ? { id: row.recordId } : { local: row.raw }) }), status(row.reviewDecision ?? row.status)),
      row.role || row.applicability === 'stale' ? h('div', { className: 'tb-meta' }, row.role ? h('span', null, row.role) : null, row.applicability === 'stale' ? h('span', null, label('stale')) : null) : null);
    const sectionRows = (section, filter = null) => {
      const page = pages[section];
      if (!page) return h('p', { className: 'tb-muted', role: 'status' }, tr('loading'));
      if (page.error) return h('div', { className: 'tb-alert', role: 'alert' }, page.error);
      const model = reviewViewModel(run, section, page); const rows = filter ? model.rows.filter(filter) : model.rows;
      const active = rows.filter((row) => row.applicability !== 'stale'); const archived = rows.filter((row) => row.applicability === 'stale');
      return h(React.Fragment, null, active.length ? active.map(rowNode) : h('p', { className: 'tb-muted' }, tr(filter ? 'noVerifier' : 'empty')), archived.length ? h('details', { className: 'tb-section' }, h('summary', null, label('stale')), archived.map(rowNode)) : null, pagination(page, (cursor) => readSection(section, cursor)));
    };
    const runOverview = () => {
      const question = run?.pending?.find((entry) => entry.status === 'open'); const controls = reviewControls(run); const primary = controls.resume ? 'resume' : controls.retry ? 'retry' : controls.pause ? 'pause' : null;
      return h(React.Fragment, null, question ? h('section', { className: 'tb-focus' }, h('h2', null, question.question), h('div', { className: 'tb-choice' }, question.options.map((option) => button(h(React.Fragment, null, option.label, option.description ? h('small', null, option.description) : null), () => operate(scope, { action: 'decide', runId, questionId: question.id, optionId: option.id }), busy, { key: option.id }))), question.findingIds?.length ? related({ refs: question.findingIds.map((id) => ({ section: 'findings', id })) }) : null) : h('section', { className: 'tb-focus' }, h('h2', null, run?.summary ?? tr('current')), ['paused', 'error'].includes(run?.status) && run?.diagnostic ? h('p', null, run.diagnostic) : null, primary ? h('div', { className: 'tb-actions' }, button(tr(primary), () => operate(scope, { action: primary, runId }), busy, { className: 'tb-primary' })) : null),
        h('details', null, h('summary', null, tr('controls')), h('div', { className: 'tb-actions' }, Object.keys(controls).map((action) => button(tr(action), () => operate(scope, { action, runId }), busy || !controls[action], { key: action })), button(tr('revise'), (event) => open({ section: 'revise' }, event), busy))),
        h('section', { className: 'tb-section' }, h('div', { className: 'tb-section-head' }, h('h2', null, tr('tasks')), button(tr('more'), () => setTab('tasks'), false, { className: 'tb-quiet' })), sectionRows('tasks')));
    };
    const runDiscussion = () => {
      const view = discussionView(pages.findings?.items, pages.decisions?.items, pages.tasks?.items);
      const loaded = pages.findings && pages.decisions;
      return h(React.Fragment, null, !loaded ? h('p', { role: 'status' }, tr('loading')) : view.issues.length ? view.issues.map(({ finding, decisions }) => h('article', { className: 'tb-item', key: finding.key },
        h('div', { className: 'tb-item-head' }, link(finding.title, { section: 'findings', id: finding.recordId }), status(finding.status)),
        finding.raw.sourceExecutionId ? h('div', { className: 'tb-meta' }, link((pages.executions?.items ?? []).find((entry) => entry.executionId === finding.raw.sourceExecutionId)?.role ?? tr('source'), { section: finding.raw.origin === 'machine' ? 'checkResults' : 'executions', id: finding.raw.sourceExecutionId })) : null,
        decisions.map(({ decision, tasks }) => h('div', { className: 'tb-decision', key: decision.key }, h('strong', null, label(decision.status)), h('p', null, decision.title), link(tr('details'), { section: 'decisions', id: decision.recordId }),
          h('div', { className: 'tb-related' }, tasks.map((task) => link(task.title, { section: 'tasks', id: task.recordId }, { key: task.key })), decision.refs.filter((ref) => ref.section === 'tasks' && !tasks.some((task) => task.id === ref.id)).map((ref) => link(`${tr('task')} · ${ref.id}`, ref, { key: ref.id }))))),
        decisions.length ? null : related({ refs: finding.refs.filter((ref) => ref.section !== 'executions') }))) : h('p', { className: 'tb-muted' }, tr('empty')),
        pagination(pages.findings, (cursor) => readSection('findings', cursor)),
        view.otherDecisions.length ? h('section', { className: 'tb-section' }, h('div', { className: 'tb-section-head' }, h('h2', null, tr('decisions'))), view.otherDecisions.map(rowNode)) : null,
        pagination(pages.decisions, (cursor) => readSection('decisions', cursor)),
        h('details', { className: 'tb-section' }, h('summary', null, tr('executions')), sectionRows('executions')),
        h('details', { className: 'tb-section' }, h('summary', null, label('stale')), ['findings', 'decisions'].map((section) => h('div', { key: section }, (pages[section]?.items ?? []).filter((entry) => entry.applicability === 'stale').map((entry) => rowNode(reviewRow(entry, section)))))));
    };
    const runResults = () => h(React.Fragment, null,
      h('section', null, h('div', { className: 'tb-section-head' }, h('h2', null, tr('checkResults'))), sectionRows('checkResults')),
      h('section', { className: 'tb-section' }, h('div', { className: 'tb-section-head' }, h('h2', null, tr('verifier'))), sectionRows('executions', (row) => row.stageId === 'verify')),
      h('div', { className: 'tb-actions' }, link(tr('report'), { section: 'report' }), link(tr('checkSpecs'), { section: 'checkSpecs' }), link(tr('artifacts'), { section: 'executions' })));
    const form = (revising = false) => {
      const value = revising ? revisionDraft : draft; const draftScope = revising ? scope : 'new';
      return h('div', null, h('label', null, tr('requirement'), h('textarea', { value: revising && !value.requirementEdited ? (run?.requirement ?? '') : value.requirement, onChange: (event) => update(draftScope, { requirement: event.target.value, requirementEdited: true }) })),
        revising ? h(React.Fragment, null, h('label', null, tr('reason'), h('input', { value: value.reason, onChange: (event) => update(draftScope, { reason: event.target.value }) })), h('label', null, tr('impact'), h('textarea', { value: value.impact, onChange: (event) => update(draftScope, { impact: event.target.value }) }))) : h('div', { className: 'tb-form-row' }, h('label', null, tr('mode'), h('select', { value: value.mode, onChange: (event) => update('new', { mode: event.target.value }) }, ['review', 'develop'].map((key) => h('option', { key, value: key }, tr(key))))), h('label', null, tr('preset'), h('select', { value: value.preset, onChange: (event) => update('new', { preset: event.target.value }) }, ['quick@2', 'standard@2'].map((key) => h('option', { key, value: key }, key))))),
        h('div', { className: 'tb-actions' }, button(tr(revising ? 'saveRevision' : 'start'), () => { try { operate(revising ? scope : 'new', revising ? { action: 'revise', runId, requirement: value.requirementEdited ? value.requirement : run.requirement, reason: value.reason, ...(value.impact.trim() ? { impact: JSON.parse(value.impact) } : {}) } : { action: 'start', requirement: value.requirement, mode: value.mode, preset: value.preset }); } catch (problem) { fail(problem); } }, busy || (revising ? !value.reason.trim() : !value.requirement.trim()), { className: 'tb-primary' }), retryButton(revising ? scope : 'new')));
    };
    const detailRows = () => {
      if (!detailPage) return h('p', { role: 'status', className: 'tb-muted' }, tr('loading'));
      if (detailPage.content !== undefined) return h(React.Fragment, null, h('pre', null, detailPage.content), pagination(detailPage, (cursor) => { const next = refs.current.page(cursor); setDetail(next); queryDetail(next); }, true));
      if (detail.section === 'usage') return h(React.Fragment, null, json(detailPage), pagination(detailPage, (cursor) => { const next = refs.current.page(cursor); setDetail(next); queryDetail(next); }));
      const model = reviewViewModel(run, detail.section, detailPage);
      return h(React.Fragment, null, model.rows.length ? model.rows.map((row) => h('article', { className: 'tb-item', key: row.key }, h('h2', null, row.title), h('div', { className: 'tb-meta' }, status(row.status), row.reviewDecision ? status(row.reviewDecision) : null, row.applicability !== 'unknown' ? label(row.applicability) : null), row.basis ? h('p', null, row.basis) : null,
        h('dl', null, h('dt', null, tr('execution')), h('dd', null, row.raw.executionId ?? row.raw.sourceExecutionId ?? row.recordId), row.requirementRevision !== null ? h(React.Fragment, null, h('dt', null, tr('version')), h('dd', null, row.requirementRevision)) : null, row.role ? h(React.Fragment, null, h('dt', null, tr('owner')), h('dd', null, row.role)) : null),
        row.acceptance.length ? h('div', null, h('h3', null, tr('acceptance')), h('ul', null, row.acceptance.map((text, index) => h('li', { key: index }, text)))) : null,
        row.scopes.length ? h('div', null, h('h3', null, tr('scopes')), h('p', null, row.scopes.join(', '))) : null,
        related(row), h('div', { className: 'tb-actions' }, row.logRef ? link(tr('log'), { section: 'artifact', id: row.logRef }) : null, row.resultRef ? link(tr('result'), { section: 'artifact', id: row.resultRef }) : null), h(RecordDetails, { value: row.raw, t }))) : h('p', { className: 'tb-muted' }, tr('missing')), pagination(detailPage, (cursor) => { const next = refs.current.page(cursor); setDetail(next); queryDetail(next); }));
    };
    const records = () => h('div', null,
      h('div', { className: 'tb-actions' }, ['history', 'questions', 'executions', 'usage'].map((section) => link(tr(section === 'history' ? 'records' : section), { section }, { key: section }))),
      h(RecordDetails, { value: run, t }));
    const renderDetail = () => h('section', { className: 'tb-detail', onKeyDown: (event) => { if (event.key === 'Escape') close(); } },
      h('div', { className: 'tb-detail-bar' }, button(tr('back'), close, false, { className: 'tb-quiet' }), button(tr('close'), clearDetail, false, { className: 'tb-quiet' })),
      h('h2', { ref: detailHeading, tabIndex: -1 }, tr(detail.section === 'artifact' ? 'result' : detail.section)),
      detail.section === 'new' ? form() : detail.section === 'revise' ? form(true) : detail.section === 'records' ? records() : detail.local ? h('div', null, rowNode(reviewRow(detail.local, detail.section)), h(RecordDetails, { value: detail.local, t })) : detailRows());
    const title = runId ? (run?.requirement?.split('\n').find((line) => line.trim())?.slice(0, 160) ?? run?.summary ?? tr('loading')) : tr('title');
    const enabled = state.value?.enabled === true;
    return h('div', { className: 'tb-page', 'aria-busy': busy }, h('style', null, boardStyles),
      h('header', { className: 'tb-toolbar' }, h('select', { value: runId, 'aria-label': tr('context'), disabled: !enabled, onChange: (event) => selectContext(event.target.value) }, h('option', { value: '', disabled: true }, tr('selectRun')), runs.items.map((item) => h('option', { key: item.runId, value: item.runId }, item.summary || item.runId)), runId && !runs.items.some((item) => item.runId === runId) ? h('option', { value: runId }, run?.summary ?? tr('runSource')) : null),
        h('div', { className: 'tb-toolbar-actions' }, button(tr('new'), (event) => open({ section: 'new' }, event), !enabled, { className: 'tb-quiet' }), button(tr('refresh'), () => refreshState(), state.status === 'loading', { className: 'tb-quiet' }), button(enabled ? tr('enabled') : tr('disabled'), () => refreshState(!enabled), !sessionId || busy, { role: 'switch', 'aria-label': tr('enabled'), 'aria-checked': enabled, className: 'tb-quiet' }))),
      h('main', { className: 'tb-main' },
        error ? h('div', { className: 'tb-alert', role: 'alert' }, `${tr('error')}: ${error}`, retryButton(scope)) : null, notice ? h('p', { role: 'status', className: 'tb-notice' }, notice) : null,
        !sessionId ? h('p', null, tr('noSession')) : state.status === 'loading' ? h('p', { role: 'status' }, tr('loading')) : state.status === 'failed' ? button(tr('retry'), () => refreshState()) : !enabled ? h('div', { className: 'tb-off' }, h('h1', null, tr('disabled')), button(tr('enable'), () => refreshState(true), busy)) : h(React.Fragment, null,
          h('header', null, h('h1', null, title), runId ? h('div', { className: 'tb-meta' }, status(run?.status), run?.phase ? h('span', null, run.phase) : null, button(tr('records'), (event) => open({ section: 'records' }, event), false, { className: 'tb-quiet' })) : null),
          runId ? h('nav', { className: 'tb-tabs', role: 'tablist', 'aria-label': tr('context') }, boardTabs.map((key) => button(tr(key), () => { setTab(key); clearDetail(); }, false, { key, id: `tb-tab-${key}`, role: 'tab', 'aria-selected': tab === key, 'aria-controls': 'tb-panel', tabIndex: tab === key ? 0 : -1, onKeyDown: (event) => { const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (delta) { event.preventDefault(); const next = boardTabs[(boardTabs.indexOf(tab) + delta + 4) % 4]; setTab(next); event.currentTarget.parentElement?.querySelector(`#tb-tab-${next}`)?.focus(); } } }))) : null,
          detail ? renderDetail() : runId ? h('section', { role: 'tabpanel', id: 'tb-panel', 'aria-labelledby': `tb-tab-${tab}` }, !run ? h('p', { role: 'status' }, tr('loading')) : tab === 'overview' ? runOverview() : tab === 'discussion' ? runDiscussion() : tab === 'tasks' ? sectionRows('tasks') : runResults()) : h('section', { className: 'tb-focus' }, h('p', { className: 'tb-muted' }, runs.items.length ? tr('selectRun') : tr('noRuns')), h('div', { className: 'tb-actions' }, button(tr('new'), (event) => open({ section: 'new' }, event), false, { className: 'tb-primary' }))),
          runs.cursor > 0 || runs.nextCursor !== null ? pagination(runs, listRuns) : null, (runs.errors ?? []).map((entry, index) => h('p', { role: 'alert', className: 'tb-alert', key: index }, `${entry.projectRoot}: ${entry.message}`)))));
  }
  return UnifiedBoard;
}
