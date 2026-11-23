import { createReviewRequestGate, decodeReviewResponse } from '../src/review/view-model.mjs';

/** In-page state only. Write identities belong to the operation, never to a visible tab. */
/** @param {{transport?: typeof fetch, makeId?: () => string}} options */
export function createBoardRequestState({ transport = fetch, makeId = () => globalThis.crypto.randomUUID() } = {}) {
  const gates = new Map(); const drafts = new Map(); const intents = new Map();
  let sessionId = ''; let enabled = false; let lifetime = 0;
  const gate = (name) => { if (!gates.has(name)) gates.set(name, createReviewRequestGate()); return gates.get(name); };
  const cancel = () => { for (const value of gates.values()) value.cancel(); };
  const scopeKey = (scope) => `${sessionId}\u0000${scope}`;
  const post = async (path, body, signal) => {
    const response = await transport(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    const envelope = await response.json();
    if (path.endsWith('/review')) {
      try { return { value: decodeReviewResponse(envelope), commandId: envelope.value?.commandId ?? null }; }
      catch (error) { error.confirmed = [400, 401, 403, 409].includes(response.status) && envelope?.ok === false || /(?:INVALID_|REVISION_CONFLICT|USER_CHOICE_REQUIRED|RUN_TERMINAL|QUESTION_NOT_FOUND|OPTION_NOT_FOUND|REQUEST_CONFLICT|OPERATION_CONFLICT)/.test(error.message); throw error; }
    }
    if (envelope?.ok !== true) throw new Error(envelope?.error?.message ?? `Request failed (${response.status})`);
    return { value: envelope.value, commandId: null };
  };
  return {
    session(next) { if (next !== sessionId) { cancel(); sessionId = next; enabled = false; lifetime++; } },
    enabled() { return enabled; },
    disable() { enabled = false; lifetime++; cancel(); },
    cancel(name) { if (name) gate(name).cancel(); else cancel(); },
    draft(scope, defaults = {}) { const key = scopeKey(scope); if (!drafts.has(key)) drafts.set(key, { ...defaults }); return drafts.get(key); },
    updateDraft(scope, patch) { const key = scopeKey(scope); drafts.set(key, { ...this.draft(scope), ...patch }); return drafts.get(key); },
    async state(next) {
      if (next === false) this.disable();
      const ownedSession = sessionId; const current = gate('state'); const token = current.begin(`${sessionId}:state`);
      let result;
      try { result = await post('/api/team-board/state', { sessionId, settingsOnly: true, ...(typeof next === 'boolean' ? { enabled: next } : {}) }, token.controller.signal); }
      catch (error) { if (!current.accepts(token) || ownedSession !== sessionId) return null; throw error; }
      if (!current.accepts(token) || ownedSession !== sessionId) return null;
      enabled = result.value.enabled === true;
      if (!enabled) for (const [name, value] of gates) if (name !== 'state') value.cancel();
      return result.value;
    },
    async read(name, identity, request) {
      if (!enabled) return null;
      const current = gate(name); const token = current.begin(`${sessionId}:${identity}`);
      try {
        const result = await post('/api/team-board/review', { sessionId, request }, token.controller.signal);
        return current.accepts(token) && enabled ? result.value : null;
      } catch (error) { if (!current.accepts(token) || !enabled) return null; throw error; }
    },
    /** A failure with unknown outcome retains the exact payload and CAS revision for retry. */
    async write(scope, request, revision) {
      if (!enabled) throw new Error('Team Board is disabled');
      const key = scopeKey(scope); const fingerprint = JSON.stringify(request); let intent = intents.get(key);
      if (intent?.busy) return { pending: true };
      if (intent && intent.fingerprint !== fingerprint) throw new Error('Unconfirmed operation: retry it before changing this request');
      if (!intent) {
        intent = { fingerprint, busy: false, payload: { ...request, ...(['start', 'import'].includes(request.action) ? { requestId: makeId() } : { operationId: makeId(), expectedRevision: revision }) } };
        intents.set(key, intent);
      }
      intent.busy = true; const ownedSession = sessionId; const ownedLifetime = lifetime;
      try {
        // No read gate here: changing a tab cannot abandon an accepted write or leave its lock held.
        const result = await post('/api/team-board/review', { sessionId: ownedSession, request: intent.payload });
        if (intents.get(key) === intent) intents.delete(key);
        return { ...result, sessionId: ownedSession, scope, visible: ownedSession === sessionId && ownedLifetime === lifetime && enabled };
      } catch (error) {
        // A revision conflict confirms no write occurred; input stays in the scoped draft.
        if (error.confirmed && intents.get(key) === intent) intents.delete(key);
        throw error;
      } finally { intent.busy = false; }
    },
    pending(scope) { return intents.get(scopeKey(scope))?.payload ?? null; },
    /** Team decisions retain their own service semantics and user-only route. */
    async decide(body) {
      if (!enabled) throw new Error('Team Board is disabled');
      const owner = sessionId; const generation = lifetime;
      const result = await post('/api/team-board/decide', { sessionId: owner, ...body });
      return { value: result.value, visible: owner === sessionId && generation === lifetime && enabled, sessionId: owner };
    },
  };
}

/** Run the page's bounded asynchronous read continuation in order. */
export async function continueBoardReads(isCurrent, steps) {
  for (const step of steps) {
    if (!isCurrent()) return false;
    if (await step() === false) return false;
  }
  return isCurrent();
}

/** Reference history keeps the originating page/cursor intact, including long text chunks. */
export function createReferenceStack() {
  const stack = [];
  return { open(ref) { stack.push({ ...ref, cursor: ref.cursor ?? 0 }); return this.current(); }, current() { return stack.at(-1) ?? null; }, page(cursor) { if (stack.length) stack[stack.length - 1] = { ...stack.at(-1), cursor }; return this.current(); }, back() { stack.pop(); return this.current(); }, clear() { stack.length = 0; }, depth() { return stack.length; } };
}
