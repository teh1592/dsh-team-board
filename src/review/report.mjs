import { currentDecisions, currentTasks } from './checks.mjs';
const reuseText = (entry, run) => entry.reusedForRevision === run.requirementRevision ? `（复用自需求版本 ${entry.requirementRevision}）` : '';
const statusText = { queued: '排队', running: '进行中', waiting_user: '等待用户选择', paused: '已暂停', completed: '已完成', cancelled: '已取消', error: '执行出错' };
export function runSummary(run) {
  /** @type {Array<any>} */
  const nextActions = [{ tool: 'review_read', arguments: { runId: run.runId, section: 'report' } }];
  if (['paused', 'error'].includes(run.status)) nextActions.push({ tool: 'review_control', arguments: { runId: run.runId, action: 'retry', operationId: `${run.runId}-retry-${run.revision}`, expectedRevision: run.revision } });
  if (run.status === 'running') nextActions.push({ tool: 'review_control', arguments: { runId: run.runId, action: 'pause', operationId: `${run.runId}-pause-${run.revision}`, expectedRevision: run.revision } });
  if (run.status === 'waiting_user') for (const question of run.questions.filter((q) => q.status === 'open')) nextActions.push({ command: `/review decide ${run.runId} ${question.id} ${question.options[0]?.id ?? '<optionId>'}`, options: question.options });
  return { runId: run.runId, projectRoot: run.projectRoot, revision: run.revision, status: run.status, phase: run.phase, summary: run.summary ?? `${statusText[run.status]}：${run.phase}`, pending: run.questions.filter((q) => q.status === 'open'), nextActions };
}
export function renderReport(run) {
  const lines = [`# 评审报告 ${run.runId}`, '', `状态：${statusText[run.status]}。方式：${run.mode}。Preset：${run.preset}。需求版本：${run.requirementRevision}，决定版本：${run.decisionRevision}。`, '', '## 需求', '', run.requirement, '', '## 结论', '', run.summary ?? '正在收集意见。', '', '## 独立意见', ''];
  const reviews = run.executions.filter((e) => e.stageId === 'review' && e.applicability === 'current');
  if (reviews.length) lines.push(`有效独立意见：${reviews.filter((e) => e.workStatus === 'completed').length}/${reviews.length}。失败或中断的执行按下方记录处理。`, '');
  for (const execution of reviews) {
    lines.push(`### ${execution.role} · ${execution.executionId}`, '', `工作：${execution.workStatus}。评审：${execution.reviewDecision ?? '未知'}。会话：${execution.childSessionId ?? '未接受'}。${reuseText(execution, run)}`,  '', execution.result?.summary ?? execution.diagnostic ?? '等待结果。', '');
    if (execution.result?.risks?.length) lines.push('风险：', '', ...execution.result.risks.map((risk) => `- ${risk}`), '');
    if (execution.result?.tests?.length) lines.push('检查场景：', '', ...execution.result.tests.map((check) => `- ${check}`), '');
  }
  lines.push('## 意见与决定', '');
  const decisions = currentDecisions(run);
  const currentFindings = run.findings.filter((f) => f.applicability !== 'stale' && run.executions.some((e) => e.executionId === f.sourceExecutionId && e.applicability === 'current'));
  for (const finding of currentFindings) {
    lines.push(`- ${finding.id} [${finding.severity}/${finding.status}]：${finding.description}。依据：${finding.basis}。来源：${finding.sourceExecutionId}。`);
    for (const decision of decisions.filter((d) => d.findingIds.includes(finding.id))) lines.push(`  - ${decision.id}：${decision.choice}。${decision.reason}${reuseText(decision, run)}。执行身份：${decision.owner}。检查：${decision.checks.join('；') || '见用户选择'}。`);
  }
  for (const decision of decisions.filter((d) => !d.findingIds.length)) lines.push(`- ${decision.id}：${decision.choice}。${decision.reason}${reuseText(decision, run)}。`);
  lines.push('', '## 后续实施要求', '');
  for (const task of currentTasks(run)) lines.push(`- ${task.id}：${task.objective}${reuseText(task, run)}。决定：${task.decisionIds.join(', ')}。写入范围：${task.writeScopes.join(', ') || '实施前确定'}。`, ...task.acceptance.map((criterion) => `  - 检查条件：${criterion}`));
  lines.push('', '## 用户事项', '');
  for (const question of run.questions) lines.push(`- ${question.id}：${question.question} [${question.status}]`, ...question.options.map((option) => `  - ${option.id}：${option.label}。${option.description}`), ...(question.answer ? [`  - 用户选择：${question.answer}`] : []));
  lines.push('', '## 实现与验证', '');
  for (const execution of run.executions.filter((entry) => ['build', 'verify'].includes(entry.stageId))) lines.push(`- ${execution.stageId} ${execution.executionId} [${execution.workStatus}/${execution.applicability}]：${execution.result?.summary ?? execution.diagnostic ?? ''}。代码摘要：${execution.codeFingerprint ?? '见文件记录'}。`);
  if (run.workspace) lines.push(...(run.workspace.changes ?? []).map((change) => `- ${change.kind} ${change.path}`));
  if (run.rework) lines.push(`返工：${run.rework.count}/${run.rework.max}。当前问题：${run.rework.findingIds.join(', ') || '无'}。`);
  for (const finding of run.findings.filter((entry) => ['machine', 'verification'].includes(entry.origin))) lines.push(`- ${finding.id} [${finding.status}/${finding.applicability}]：${finding.description}。依据：${finding.basis}。`);
  lines.push('', '## 技术检查', '');
  for (const check of run.checkResults) lines.push(`- ${check.checkId} [${check.outcome}/${check.applicability}]：${check.summary ?? ''}。退出码：${check.exitCode ?? '未知'}。日志：${check.logRef ?? '见运行记录'}。`);
  lines.push('', '## 材料与运行记录', '', ...run.materials.map((material) => `- ${material.name}：${material.source ?? '启动时提供正文'}。`), ...run.artifacts.map((artifact) => `- ${artifact.executionId} [${artifact.applicability}]：${artifact.resultRef}`), '', `运行状态：.review/runs/${run.runId}/run.json`, '');
  return lines.join('\n');
}
