import { startSchema, statusSchema, controlSchema, readSchema, reviseSchema, envelopeSchema, object } from '../../src/review/schemas.mjs';
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const descriptions = {
  review_start: '启动评审或开发并立即返回 runId。后台形成决定；develop 继续实施、机器检查、独立验证和返工。用 review_status 查看进度。',
  review_status: '读取评审运行的当前步骤、待处理事项和可继续动作。',
  review_control: '暂停、继续、重试或取消评审运行。pause 在阶段完成后暂停，stop 立即停止当前执行。',
  review_read: '按 section 读取意见、决定、实施要求、检查或报告；diagnostics 查看当前项目坏运行记录的读取错误。列表返回 nextCursor；artifact 的 id 是结果引用。',
  review_revise: '记录新需求和原因。按 impact 清单重做受影响任务与检查，复用其余结果；省略 impact 时全量重新评审。',
};
export function registerReviewTools(ctx, resolveService, visible) {
  const disposers = [];
  const define = (name, parameters, execute) => {
    const definition = { name, description: descriptions[name], parameters, output, execute: async (args, exec) => {
      if (!exec.agent) throw new Error(`${name} requires a live Agent`);
      if (!visible(exec.agent)) throw new Error('Review tools are disabled for this session');
      const service = await resolveService(exec.agent, args.runId, { readOnly: name === 'review_status' || name === 'review_read' });
      return execute(service, args, exec);
    } };
    disposers.push(ctx.tools.register(definition, { when: ({ agent }) => visible(agent) }));
  };
  define('review_start', startSchema, (service, args, exec) => service.start(args, { sessionId: exec.agent.id }));
  define('review_status', statusSchema, async (service, args, exec) => { await assertOwner(service, args.runId, exec.agent); return service.status(args.runId); });
  define('review_control', controlSchema, async (service, args, exec) => { await assertOwner(service, args.runId, exec.agent); return service.control(args.runId, args.action, args); });
  define('review_read', readSchema, async (service, args, exec) => { if (args.section !== 'diagnostics') await assertOwner(service, args.runId, exec.agent); return service.inspect(args.runId, args.section, args.cursor, args.id, exec.signal); });
  define('review_revise', reviseSchema, async (service, args, exec) => { await assertOwner(service, args.runId, exec.agent); return service.revise(args.runId, args); });
  return () => {
    const failures = [];
    for (const dispose of disposers.slice().reverse()) { try { dispose(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Review tool cleanup failed');
  };
}
export async function assertOwner(service, runId, agent) {
  const run = await service.required(runId);
  if (run.rootSessionId !== agent.id) throw new Error('This review run belongs to another root session');
}
export function submitDefinition(service, runId, executionId, childId) {
  return { name: 'review_submit', description: '保存当前阶段的完整结构化结果。返回当前或旧版本归档状态。', parameters: object({ result: envelopeSchema }), output,
    async execute(args, exec) {
      if (exec.agent?.id !== childId || args.result.executionId !== executionId) throw new Error('Stage result identity does not match this execution');
      return service.submit(runId, args.result, { sessionId: childId, kind: 'stage-tool' });
    },
  };
}
export const reviewToolDescriptions = descriptions;
