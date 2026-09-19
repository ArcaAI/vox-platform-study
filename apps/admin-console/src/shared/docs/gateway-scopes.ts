/**
 * The API-key and service-account scope EVERY documented request needs, stated once.
 *
 * ## Why a table rather than a sentence
 *
 * Every lane used to open with "an API key holding the business-plane scopes". A developer
 * cannot mint a key from that sentence, and the failure it produces does not look like a
 * documentation gap: the gateway answers
 * `403 API key does not have required scope(s): agent:invocation:write` on the ONE request in
 * the walkthrough that needed a scope the key was not minted with. Measured live on the dev
 * gateway (2026-09-17): the same key opened an STT stream session and was refused on
 * `POST agents/{slug}/invocations`.
 *
 * ## The trap this table exists to make visible
 *
 * Batch transcription crosses TWO scope families. `POST agents/{slug}/transcriptions` is on the
 * AGENT plane (`agent:invocation:write`) and answers an `sseUrl` that points at the STT job
 * plane (`stt:transcription:write`) — so a key minted for the first request cannot read the
 * progress stream the same response just handed it. A key that does the whole batch job needs
 * both, or the upload route (`audio/transcription-jobs/transcribe`), which is entirely on the
 * STT plane.
 *
 * ## Source of truth
 *
 * `apps/api/route-manifest.json` — the gateway's own authorization oracle
 * (`05-nestjs-api.md` §API Test Standard). `__tests__/gateway-scopes.test.ts` reads it and fails
 * if any row here names a route the gateway does not serve, or a scope it does not declare.
 */

export interface GatewayRouteScope {
  method: 'GET' | 'POST' | 'DELETE';
  /** Manifest spelling: the `api/v1` prefix included, `{param}` placeholders. */
  path: string;
  /** The scope an `X-API-Key` must carry. Missing it is a 403 naming this exact string. */
  apiKeyScope: string;
  /** The renamespaced scope a service-account token must carry for the same route. */
  serviceAccountScope: string;
  /** What the request is for, in the developer's words. */
  what: string;
  /**
   * What a MACHINE caller has to know beyond the scope, where the scope alone overstates the
   * route. A declared `svcScopes` entry says the gateway will let the token past the scope check;
   * it does not promise the handler can serve it. Routes that resolve an owner from the request
   * USER are the case that bites: `UnifiedAuthGuard` never writes a service account onto `user`
   * (it goes on its own `serviceAccount` CLS key, by design), so a handler reading `user` refuses
   * a token that carried the right scope.
   *
   * Absent means the route serves both machine classes with nothing extra to say.
   */
  serviceAccountNote?: string;
}

export const GATEWAY_ROUTE_SCOPES = {
  agentList: {
    method: 'GET',
    path: '/api/v1/agents',
    apiKeyScope: 'agent:definition:read',
    serviceAccountScope: 'svc:agent:definition:read',
    what: 'List the published agents this tenant can call',
  },
  agentGet: {
    method: 'GET',
    path: '/api/v1/agents/{slug}',
    apiKeyScope: 'agent:definition:read',
    serviceAccountScope: 'svc:agent:definition:read',
    what: 'Read one agent’s task and its input/output schemas',
  },
  agentInvocations: {
    method: 'POST',
    path: '/api/v1/agents/{slug}/invocations',
    apiKeyScope: 'agent:invocation:write',
    serviceAccountScope: 'svc:agent:invocation:write',
    what: 'Generate text (blocking) or stream it (?mode=stream); also the NER route',
  },
  agentSpeech: {
    method: 'POST',
    path: '/api/v1/agents/{slug}/speech',
    apiKeyScope: 'agent:invocation:write',
    serviceAccountScope: 'svc:agent:invocation:write',
    what: 'Synthesize speech — the response is audio, not JSON',
  },
  agentTranscriptions: {
    method: 'POST',
    path: '/api/v1/agents/{slug}/transcriptions',
    apiKeyScope: 'agent:invocation:write',
    serviceAccountScope: 'svc:agent:invocation:write',
    what: 'Start a batch transcription job for media that is ALREADY uploaded (`mediaId`)',
  },
  transcriptionUpload: {
    method: 'POST',
    path: '/api/v1/audio/transcription-jobs/transcribe',
    apiKeyScope: 'stt:transcription:write',
    serviceAccountScope: 'svc:stt:transcription:write',
    what: 'Upload an audio FILE (multipart) and start the batch job in one request',
    serviceAccountNote:
      'A batch job has an OWNER (the in-flight ceiling is counted per user, and the job’s later owner-scoped reads ' +
      'resolve against it). A service-account caller must therefore name that clinician in `clinicianUserId`, and may ' +
      'name any clinician of its working tenant; an API key is already bound to its human and names nobody.',
  },
  transcriptionJobGet: {
    method: 'GET',
    path: '/api/v1/audio/transcription-jobs/{id}',
    apiKeyScope: 'stt:transcription:write',
    serviceAccountScope: 'svc:stt:transcription:write',
    what: 'Read a batch job — status, and the transcript once it is COMPLETED',
  },
  transcriptionJobStream: {
    method: 'GET',
    path: '/api/v1/audio/transcription-jobs/{id}/stream',
    apiKeyScope: 'stt:transcription:write',
    serviceAccountScope: 'svc:stt:transcription:write',
    what: 'Follow a batch job’s progress over SSE',
  },
  transcriptionLimits: {
    method: 'GET',
    path: '/api/v1/audio/transcription-jobs/limits',
    apiKeyScope: 'stt:transcription:write',
    serviceAccountScope: 'svc:stt:transcription:write',
    what: 'The upload ceilings the gateway will enforce (size, duration, in-flight jobs)',
  },
  streamSessionCreate: {
    method: 'POST',
    path: '/api/v1/audio/transcription-jobs/stream/session',
    apiKeyScope: 'stt:transcription:write',
    serviceAccountScope: 'svc:stt:transcription:write',
    what: 'Open a realtime session and mint the single-use socket ticket',
  },
  streamSessionRefreshTicket: {
    method: 'POST',
    path: '/api/v1/audio/transcription-jobs/stream/session/{sessionId}/refresh-ticket',
    apiKeyScope: 'stt:transcription:write',
    serviceAccountScope: 'svc:stt:transcription:write',
    what: 'Mint a fresh ticket for a reconnect — the first one is consumed by the first open',
  },
  streamSessionClose: {
    method: 'DELETE',
    path: '/api/v1/audio/transcription-jobs/stream/session/{sessionId}',
    apiKeyScope: 'stt:transcription:write',
    serviceAccountScope: 'svc:stt:transcription:write',
    what: 'Close a realtime session',
  },
  workflowRunStart: {
    method: 'POST',
    path: '/api/v1/workflows/{slug}/runs',
    apiKeyScope: 'workflow:run:write',
    serviceAccountScope: 'svc:workflow:run:write',
    what: 'Start a workflow run',
  },
  workflowRunGet: {
    method: 'GET',
    path: '/api/v1/workflows/{slug}/runs/{runId}',
    apiKeyScope: 'workflow:run:read',
    serviceAccountScope: 'svc:workflow:run:read',
    what: 'Read a run’s status',
  },
  workflowRunStream: {
    method: 'GET',
    path: '/api/v1/workflows/{slug}/runs/{runId}/stream',
    apiKeyScope: 'workflow:run:read',
    serviceAccountScope: 'svc:workflow:run:read',
    what: 'Follow a run over resumable SSE',
  },
  workflowRunStreamTicket: {
    method: 'POST',
    path: '/api/v1/workflows/{slug}/runs/{runId}/stream-ticket',
    apiKeyScope: 'workflow:run:read',
    serviceAccountScope: 'svc:workflow:run:read',
    what: 'Mint a run-scoped, single-use ticket for a socket or an EventSource',
    serviceAccountNote:
      'JWT or API key only, whatever the manifest declares. The ticket is minted FOR a user and the handler reads one ' +
      'off the request context (`workflows.controller.ts:383-384`), so a service-account token is a 401 “User context ' +
      'not available”. Follow the run over SSE with the token’s own header instead — which is the resumable lane anyway.',
  },
} as const satisfies Record<string, GatewayRouteScope>;

export type GatewayRouteKey = keyof typeof GATEWAY_ROUTE_SCOPES;

/**
 * The one-line "Scopes this lane needs" note that sits above a lane's FIRST request.
 *
 * Distinct scopes only, in the order the routes are named — so the batch-transcription lane
 * reads `agent:invocation:write + stt:transcription:write` and a developer sees the crossing
 * before they mint the key rather than after the 403.
 */
export function scopeNote(keys: readonly GatewayRouteKey[]): string {
  if (keys.length === 0) throw new Error('scopeNote needs at least one route: a lane with no named scope is the sentence this table replaced.');
  const scopes = [...new Set(keys.map((key) => GATEWAY_ROUTE_SCOPES[key].apiKeyScope))];
  return `Scopes this lane needs: ${scopes.join(' + ')}`;
}

/** Same, for a machine identity exchanged at `POST auth/service-token`. */
export function serviceAccountScopeNote(keys: readonly GatewayRouteKey[]): string {
  if (keys.length === 0) throw new Error('serviceAccountScopeNote needs at least one route.');
  const scopes = [...new Set(keys.map((key) => GATEWAY_ROUTE_SCOPES[key].serviceAccountScope))];
  return `Service-account scopes: ${scopes.join(' + ')}`;
}

/**
 * The caveats a machine caller needs on top of the scopes, distinct and in route order.
 *
 * Empty for a lane where the scope IS the whole answer — which is most of them, and is why this
 * returns an array rather than a sentence with "none" in it.
 */
export function serviceAccountNotes(keys: readonly GatewayRouteKey[]): readonly string[] {
  // Widened to the interface deliberately: `satisfies` keeps the literal row types, on which the
  // OPTIONAL property simply does not exist for rows that omit it, so a direct index access would
  // not compile.
  const notes = keys.map((key) => (GATEWAY_ROUTE_SCOPES[key] as GatewayRouteScope).serviceAccountNote);
  return [...new Set(notes.filter((note): note is string => Boolean(note)))];
}

/**
 * The other 4xx a correctly-scoped, correctly-credentialed request still meets.
 *
 * The budget is deployment-configured (`RateLimitConfigService` reads `RATE_LIMIT_MAX_REQUESTS` /
 * `RATE_LIMIT_WINDOW_MS`, and the dev gateway runs far below the code default), so printing a
 * number here would be a promise about somebody else's cluster. The gateway answers the real one
 * on every response.
 */
export const RATE_LIMIT_NOTE =
  'A 429 here is the rate limiter, not a quota: read the live `RateLimit-Policy` response header — `"default";q=<requests>;w=<seconds>` — ' +
  'rather than hardcoding a number, because the budget is set per deployment and per API key.';

/** Where a scoped key comes from — printed wherever a scope is named. */
export const API_KEY_MINT_NOTE =
  'A tenant admin mints one on the API keys screen (/api-keys, POST admin/api-keys) and picks the scopes there. ' +
  'A key missing one answers 403 "API key does not have required scope(s): <scope>" — the scope it names is the one to add.';
