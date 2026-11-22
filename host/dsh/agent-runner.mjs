import { randomUUID } from 'node:crypto';
import { outputSchema, protocolError, validateEnvelope } from '../../src/review/schemas.mjs';

export function decodeAgentResult(result) {
  if (result.structured !== undefined) return validateEnvelope(result.structured);
  const text = (result.output ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return validateEnvelope(JSON.parse(fenced ? fenced[1] : text));
}
export class DshAgentRunner {
  constructor(subagents, agents, sessionQuery, managedSessions = new Map()) {
    this.subagents = subagents; this.agents = agents; this.sessionQuery = sessionQuery; this.managedSessions = managedSessions;
  }
  chooseProvider(name) {
    const names = name ? [name] : this.subagents.list();
    const candidates = names.map((key) => this.subagents.getProvider(key)).filter((provider) => provider && provider.inheritsParentContext === false);
    const provider = candidates.find((entry) => typeof entry.prepareContinuable === 'function') ?? candidates[0];
    if (!provider) throw protocolError('FRESH_PROVIDER_UNAVAILABLE', 'No registered provider supplies a fresh context');
    return provider;
  }
  async start(spec) {
    const parent = this.agents.get(spec.rootSessionId);
    if (!parent) throw protocolError('ROOT_OFFLINE', spec.rootSessionId);
    const provider = this.chooseProvider(spec.provider);
    const request = { parent, cwd: spec.projectRoot, prompt: [{ type: 'text', text: spec.prompt }] };
    if (provider.capabilities.outputSchema) request.outputSchema = outputSchema(spec.stageId);
    if (provider.capabilities.agentOptions && spec.agentOptions) request.agentOptions = spec.agentOptions;
    if (provider.capabilities.agentPreset && spec.agentPreset) request.agentPreset = spec.agentPreset;
    const childId = typeof provider.prepareContinuable === 'function' ? randomUUID() : undefined;
    if (childId) this.managedSessions.set(childId, spec);
    let activation;
    try {
      activation = await this.subagents.startActivation({ provider: provider.name, label: `review:${spec.runId}:${spec.executionId}`, ...(childId ? { childId } : {}), request, signal: spec.signal, delivery: 'caller' });
      this.managedSessions.set(activation.childId, spec);
    } catch (error) { if (childId) this.managedSessions.delete(childId); throw error; }
    let disposed;
    const cancel = () => disposed ??= activation.dispose().finally(() => this.managedSessions.delete(activation.childId));
    const result = activation.result.then((raw) => {
      if (raw.stopReason !== 'completed') return { raw };
      try { return { raw, envelope: decodeAgentResult(raw) }; }
      catch (error) { return { raw, parseError: String(error.message ?? error) }; }
    });
    result.catch(() => {});
    // The caller awaits result and invokes cancel in finally, including success.
    return { childId: activation.childId, messageId: activation.messageId, provider: provider.name, result, cancel };
  }
  async sendMessage(rootSessionId, childId, text, signal) {
    const parent = this.agents.get(rootSessionId);
    if (!parent) throw protocolError('ROOT_OFFLINE', rootSessionId);
    return this.subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal });
  }
  async recover(run, execution) {
    if (!this.sessionQuery) return { kind: 'interrupted', diagnostic: 'Session query service is unavailable' };
    let childId = execution.childSessionId;
    if (!childId) {
      const children = await this.subagents.listChildren(run.rootSessionId);
      childId = children.find((child) => child.label === `review:${run.runId}:${execution.executionId}`)?.id;
    }
    if (!childId) return { kind: 'interrupted', diagnostic: 'Accepted child identity was not located' };
    const observation = await this.sessionQuery.observeSession(childId, { projectionMode: 'none' });
    try {
      for (const event of [...observation.events].reverse()) {
        let envelope;
        if (event.type === 'tool/call' && ['review_submit', 'structured_output'].includes(event.data.name)) {
          try { const args = JSON.parse(event.data.arguments); envelope = event.data.name === 'review_submit' ? args.result : args; } catch { continue; }
          // A tool call alone is not accepted output. It needs its successful result pair.
          if (!observation.events.some((other) => other.type === 'tool/result' && other.data.message?.toolCallId === event.data.callId && !other.data.message?.isError)) continue;
        } else if (event.type === 'assistant/message' && !event.data.interrupted) {
          try { envelope = decodeAgentResult({ output: event.data.message.content }); } catch { continue; }
        } else continue;
        try {
          validateEnvelope(envelope);
          if (envelope.executionId === execution.executionId && envelope.requirementRevision === execution.requirementRevision && envelope.decisionRevision === execution.decisionRevision && envelope.inputFingerprint === execution.inputFingerprint) return { kind: 'result', envelope, childId };
        } catch { /* Other messages in this session may contain unrelated JSON. */ }
      }
      return { kind: 'interrupted', childId, diagnostic: 'No matching committed output; stop the old execution before retry' };
    } finally { observation[Symbol.dispose](); }
  }
  async readUsage(execution, signal) {
    if (!this.sessionQuery || !execution.childSessionId) return null;
    const observation = await this.sessionQuery.observeSession(execution.childSessionId, { projectionMode: 'none', ...(signal ? { signal } : {}) });
    try {
      const messages = observation.events.filter((event) => event.type === 'assistant/message');
      const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
      if (!messages.length || messages.some((event) => !event.data.usage || !['inputTokens', 'outputTokens'].every((field) => Number.isSafeInteger(event.data.usage[field]) && event.data.usage[field] >= 0))) return null;
      const tokens = Object.fromEntries(fields.map((field) => [field, messages.every((event) => Number.isSafeInteger(event.data.usage[field]) && event.data.usage[field] >= 0) ? messages.reduce((sum, event) => sum + event.data.usage[field], 0) : null]));
      return { tokens, source: { sessionId: execution.childSessionId, eventType: 'assistant/message', eventSeqs: messages.map((event) => event.seq), fields: 'data.usage', observedAt: new Date().toISOString() } };
    } finally { observation[Symbol.dispose](); }
  }
  async stopRecovered(run, execution) {
    let childId = execution.childSessionId;
    if (!childId) childId = (await this.subagents.listChildren(run.rootSessionId)).find((child) => child.label === `review:${run.runId}:${execution.executionId}`)?.id;
    if (!childId) return;
    const parent = this.agents.get(run.rootSessionId);
    if (!parent) throw protocolError('ROOT_OFFLINE', run.rootSessionId);
    await this.subagents.drainChildren(parent, [childId]);
  }
}
