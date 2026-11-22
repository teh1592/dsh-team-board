import { createHash } from 'node:crypto';
export class DshNotifier {
  constructor(agents) { this.agents = agents; }
  async enqueue(rootSessionId, notification) {
    const agent = this.agents.get(rootSessionId);
    if (!agent) return undefined;
    const messageId = `review-notice-${createHash('sha256').update(notification.notificationId).digest('hex').slice(0, 24)}`;
    // Deterministic identity also covers a crash after inbox acceptance but before run.json publication.
    if (agent.session.snapshotEvents().some((event) => event.type === 'agent/inbox/spliced' && (event.data.inserted ?? event.data.messages ?? []).some((message) => message.id === messageId) || event.type === 'user/message' && event.data.id === messageId)) return messageId;
    const summary = { ...notification.summary, nextActions: [{ tool: 'review_status', arguments: { runId: notification.summary.runId } }, { tool: 'review_read', arguments: { runId: notification.summary.runId, section: 'report' } }] };
    agent.followup({ id: messageId, role: 'user', content: [{ type: 'text', text: `评审运行更新 ${notification.notificationId}\n${JSON.stringify(summary)}\n使用 review_read 读取完整决定、风险与实施检查条件。` }], source: { kind: 'review-plugin' } });
    return messageId;
  }
}
