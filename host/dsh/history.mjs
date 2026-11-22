import { fingerprint } from '../../src/review/state.mjs';
export function createHistoryReader(teams) {
  return async (agent, id, cursor = 0) => {
    if (!teams) return { items: [], total: null, nextCursor: null, status: 'unknown', reason: 'agentTeams unavailable' };
    const legacyModule = '../../src/ledger.mjs';
    const { ledgerFromTasks, parseMeetingBlock } = await import(legacyModule);
    const tasks = teams.listTasks(agent);
    const meetingIdOf = (block) => { const value = block?.fields.get('meeting')?.inline; return typeof value === 'string' && value.trim() ? value.trim() : null; };
    const parsedTasks = new Map(tasks.map((task) => [task.id, parseMeetingBlock(task.description)]));
    const taskMeetings = new Map(tasks.map((task) => {
      const parsed = parsedTasks.get(task.id);
      return [task.id, parsed.errors.length ? [] : [...new Set([parsed.header, ...parsed.stages].map(meetingIdOf).filter(Boolean))]];
    }));
    const meetings = new Map(); const fullLedger = ledgerFromTasks(tasks).ledger;
    if (fullLedger) meetings.set(fullLedger.id, fullLedger);
    for (const meetingId of new Set([...taskMeetings.values()].flat())) {
      if (meetings.has(meetingId)) continue;
      const ledger = ledgerFromTasks(tasks.filter((task) => taskMeetings.get(task.id).includes(meetingId))).ledger;
      if (ledger) meetings.set(meetingId, ledger);
    }
    const selected = id ? tasks.filter((task) => task.id === id) : tasks;
    if (id && !selected.length) throw Object.assign(new Error('Historical task was not found'), { code: 'HISTORY_NOT_FOUND' });
    const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    const items = selected.slice(offset, offset + 20).map((task) => {
      const ids = taskMeetings.get(task.id); const meetingId = ids.length === 1 ? ids[0] : null;
      const meeting = meetings.get(meetingId);
      const source = { sessionId: agent.id, taskId: task.id, taskRevision: task.revision, meetingId, preset: meeting?.preset ?? null, kind: 'team-task' };
      const content = JSON.stringify({ subject: task.subject, description: task.description, status: task.status, writeScopes: task.writeScopes }, null, 2);
      return { id: task.id, title: task.subject.slice(0, 1200), status: 'imported', sourceStatus: task.status, source, content: id ? content : content.slice(0, 16000), truncated: !id && content.length > 16000, digest: fingerprint({ source, content }), evidence: 'unknown', readOnly: true };
    });
    return { items, total: selected.length, nextCursor: offset + 20 < selected.length ? offset + 20 : null, status: 'ok' };
  };
}
