import { assertOwner } from './tools.mjs';
import { validate, startSchema, reviseSchema, readSchema, controlSchema, object } from '../../src/review/schemas.mjs';
const str = { type: 'string', minLength: 1 }; const cursor = { type: 'integer', minimum: 0 }; const preset = { type: 'string', enum: ['quick@2', 'standard@2'] }; const mode = { type: 'string', enum: ['review', 'develop'] };
const requestSchemas = {
  start: startSchema, read: readSchema, revise: reviseSchema,
  list: object({ cursor }, []), history: object({ historyId: str, cursor }, []), status: object({ runId: str }),
  import: object({ requestId: str, historyId: str, requirement: str, preset, mode }, ['requestId', 'historyId']),
  decide: object({ runId: str, operationId: str, expectedRevision: cursor, questionId: str, optionId: str }, ['runId', 'operationId', 'questionId', 'optionId']),
};
export function registerReviewCommand(commands, resolveService, { readHistory, listRuns, checkCaller } = { readHistory: undefined, listRuns: undefined, checkCaller: undefined }) {
  const structured = async (request, invocation) => {
    const allowed = ['action', 'runId', 'requestId', 'operationId', 'expectedRevision', 'requirement', 'reason', 'preset', 'mode', 'materials', 'checks', 'impact', 'section', 'cursor', 'id', 'questionId', 'optionId', 'historyId'];
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => !allowed.includes(key))) throw new Error('Invalid structured review request');
    const { action, ...args } = request;
    if (['pause', 'resume', 'stop', 'cancel', 'retry'].includes(action)) validate(controlSchema, request);
    else { if (!requestSchemas[action]) throw new Error('Unknown review action'); validate(requestSchemas[action], args); }
    const readOnly = ['list', 'status', 'read', 'history'].includes(action);
    if (action === 'history') {
      if (!readHistory) throw new Error('History reader is unavailable');
      return readHistory(invocation.agent, args.historyId, args.cursor);
    }
    if (action === 'list' && listRuns) return listRuns(invocation.agent, args.cursor);
    const service = await resolveService(invocation.agent, args.runId, { readOnly });
    if (action === 'list') return service.listRuns(invocation.agent.id, args.cursor);
    if (action === 'start') { validate(startSchema, args); return service.start(args, { sessionId: invocation.agent.id }); }
    if (action === 'import') {
      if (!readHistory || !args.requestId || !args.historyId) throw new Error('Import requires historyId and requestId');
      const history = await readHistory(invocation.agent, args.historyId);
      const item = history.items[0];
      return service.importHistory({ requestId: args.requestId, requirement: args.requirement, preset: args.preset, mode: args.mode }, item, { kind: 'user', sessionId: invocation.agent.id });
    }
    if (!args.runId) throw new Error('Specify runId');
    await assertOwner(service, args.runId, invocation.agent);
    if (action === 'status') return service.status(args.runId);
    if (action === 'read') { validate(readSchema, args); return service.inspect(args.runId, args.section, args.cursor, args.id, invocation.signal); }
    if (action === 'revise') { validate(reviseSchema, args); return service.revise(args.runId, args); }
    if (action === 'decide') return service.decide(args.runId, args.questionId, args.optionId, { kind: 'user', sessionId: invocation.agent.id }, args.operationId, args.expectedRevision);
    if (['pause', 'resume', 'stop', 'cancel', 'retry'].includes(action)) { const params = { ...args, action }; validate(controlSchema, params); return service.control(args.runId, action, args); }
    throw new Error('Unknown review action');
  };
  return commands.register({ name: 'review', description: '启动、读取和控制评审或开发，处理用户选择及导入历史。', input: { hint: 'start <需求> | status/read <runId> | decide <runId> <questionId> <optionId> | request <JSON> | pause/resume/stop/cancel/retry <runId>' },
    async handler(invocation) {
      try {
        if (invocation.signal?.aborted) throw new Error('Review command aborted');
        checkCaller?.(invocation.agent);
        const raw = invocation.rawInput.trim();
        if (raw.startsWith('request ')) return { kind: 'success', text: JSON.stringify(await structured(JSON.parse(raw.slice(8)), invocation)) };
        const [action, runId, first, second] = raw.split(/\s+/);
        const service = await resolveService(invocation.agent, action === 'start' ? undefined : runId, { readOnly: ['status', 'read'].includes(action) });
        let result;
        if (action === 'start') result = await service.start({ requestId: invocation.commandId, requirement: raw.slice(6), mode: 'review' }, { sessionId: invocation.agent.id });
        else {
          if (!runId) throw new Error('Specify runId');
          if (!(action === 'read' && first === 'diagnostics')) await assertOwner(service, runId, invocation.agent);
          if (action === 'status') result = await service.status(runId);
          else if (action === 'probe') result = await service.probe(runId);
          else if (action === 'read') result = await service.inspect(runId, first ?? 'report', 0, undefined, invocation.signal);
          else if (action === 'decide') result = await service.decide(runId, first, second, { kind: 'user', sessionId: invocation.agent.id }, invocation.commandId);
          else if (['pause', 'resume', 'stop', 'cancel', 'retry'].includes(action)) result = await service.control(runId, action, { operationId: invocation.commandId });
          else throw new Error('Unknown review action');
        }
        return { kind: 'success', text: typeof result.content === 'string' ? result.content : JSON.stringify(result, null, 2) };
      } catch (error) { return { kind: 'error', text: `${error.code ?? 'REVIEW_ERROR'}: ${error.message ?? error}` }; }
    },
  });
}
