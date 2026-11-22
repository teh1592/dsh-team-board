export const REVIEW_ROUTE = '/api/team-board/review';
export function registerReviewRoute(ctx, commands, agents) {
  const pending = new Set(); const lifetime = new AbortController();
  const mount = (owner) => {
    const connection = owner.get?.('connection') ?? owner.connection;
    if (!connection?.fetch?.register) return undefined;
    return connection.fetch.register({ path: REVIEW_ROUTE, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
      const json = (value, status = 200) => Response.json(value, { status });
      try {
        const admission = connection.admit(request);
        if ('rejection' in admission) return json({ ok: false, error: { code: 'REQUEST_DENIED', message: 'Authenticated owner request required' } }, admission.rejection);
        if (admission.peer.principal.kind !== 'owner') return json({ ok: false, error: { code: 'OWNER_REQUIRED', message: 'Owner request required' } }, 403);
        const body = await request.json();
        if (!body || typeof body !== 'object' || Object.keys(body).some((key) => !['sessionId', 'request'].includes(key)) || typeof body.sessionId !== 'string' || !body.request || typeof body.request !== 'object') return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Expected sessionId and structured request' } }, 400);
        const agent = agents.get(body.sessionId);
        if (!agent || !agents.roots().some((root) => root === agent)) return json({ ok: false, error: { code: 'LIVE_ROOT_REQUIRED', message: 'Open the exact root session to use review actions' } }, 409);
        if (request.signal.aborted || lifetime.signal.aborted) throw new Error('Review request aborted');
        const signal = AbortSignal.any([request.signal, lifetime.signal]);
        const operation = commands.execute(agent, `/review request ${JSON.stringify(body.request)}`, [], signal);
        pending.add(operation); let execution;
        try { execution = await operation; } finally { pending.delete(operation); }
        if (!execution) return json({ ok: false, error: { code: 'COMMAND_UNAVAILABLE', message: 'Review command is not registered' } }, 503);
        return json({ ok: true, value: execution });
      } catch (error) { return json({ ok: false, error: { code: error.code ?? 'REVIEW_ROUTE_ERROR', message: String(error.message ?? error) } }, 400); }
    } });
  };
  const registration = typeof ctx.inject === 'function' ? ctx.inject(['connection'], mount) : mount(ctx);
  let disposal;
  return () => disposal ??= (async () => {
    lifetime.abort(new Error('Review route unloaded'));
    const results = await Promise.allSettled([Promise.resolve().then(() => typeof registration === 'function' ? registration() : registration?.dispose()), ...[...pending].map((operation) => operation.catch((error) => { if (!lifetime.signal.aborted) throw error; }))]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Review route cleanup failed');
  })();
}
