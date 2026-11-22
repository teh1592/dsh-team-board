import { z } from 'zod';
export const sessionIndexDefinition = {
  key: 'local-review-projects', stateVersion: 1,
  stateSchema: z.record(z.string(), z.string()),
  init: () => ({}),
  apply(state, event) {
    let values = [];
    if (event.type === 'tool/result' || event.type === 'user/message') {
      const message = event.type === 'tool/result' ? event.data.message : event.data;
      values = (message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text);
    } else if (event.type === 'command/done') {
      values = [event.data.text ?? ''];
    }
    for (const text of values) {
      let value;
      try { value = JSON.parse(text); } catch { continue; }
      if (typeof value?.runId === 'string' && typeof value?.projectRoot === 'string' && state[value.runId] !== value.projectRoot) return { ...state, [value.runId]: value.projectRoot };
    }
    return state;
  },
};
