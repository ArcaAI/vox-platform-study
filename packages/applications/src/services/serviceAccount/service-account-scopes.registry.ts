/**
 * The `svc:*` scope namespace —.
 *
 * ─── Why this is a SEPARATE registry ────────────────────────────────────────
 *
 * The owner ruling ("we cannot mix the `/admin/*` and `/internal/*`
 * routes as they were designed for different purposes") means the machine
 * identity for administration must be a THIRD credential class sharing NO
 * mechanism with tenant API keys. Scope vocabulary is a mechanism. Adding
 * `svc:*` rows to `API_KEY_SCOPE_REGISTRY` would put both classes in one space,
 * where `ApiKeyService.hasScope`'s prefix/wildcard matching and
 * `assertScopeCeiling`'s expansion would apply to both — and a tenant admin
 * minting a key carrying `svc:*` would be exactly the escalation this class
 * exists to prevent. The two registries are asserted DISJOINT in both directions
 * by `__tests__/service-account-scopes.registry.test.ts`.
 *
 * ─── Why the vocabulary is DERIVED, not hand-written ────────────────────────
 *
 * puts the 56 `admin:*` scopes in reserve: they still name exactly one
 * admin controller area each, they are just no longer reachable by an API key.
 * Re-typing them here would guarantee drift and would make boot-audit
 * assertion D ("every `svc:*` scope maps to a live admin area, and every admin
 * area is covered by exactly one `svc:*` scope") an aspiration rather than a
 * fact. Instead every `admin:<area>` scope is RENAMESPACED to `svc:admin:<area>`
 * at module load, carrying its `implies` verbatim. Adding an admin controller
 * area therefore extends both surfaces in one edit, and D holds by construction.
 *
 * The Option 2 "Fit" row sanctions exactly this ("reuses the `admin:*`
 * scope vocabulary puts in reserve (renamespaced `svc:admin:*` or
 * mapped 1:1)").
 *
 * ─── /: further derived families ─────────────────────────
 *
 * The registry now holds five families, all renamespaced from
 * `API_KEY_SCOPE_REGISTRY` and none hand-written:
 *
 * `svc:admin:<area>` — every concrete `admin:*` scope (above)
 *   `svc:<feature>` — the standalone STT + summarization scopes
 * ({@link STANDALONE_FEATURE_SCOPE_SOURCES})
 *   `svc:<area>` — admin-plane areas whose gating scope PREDATES the
 * `admin:<area>` convention ( decision O-1,
 *                         {@link ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES})
 *   `svc:agent:*` / `svc:workflow:*` — the agent + workflow composition plane
 *                         (TASK-930, {@link AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES})
 *   `svc:consultation:*` / `svc:tenant:context-schema:read` / `svc:workflows:execute`
 *                       — the realtime CONSULTATION plane
 *                         (TASK-933, {@link CONSULTATION_REALTIME_SCOPE_SOURCES})
 *
 * They are kept as separate families rather than one blanket derivation of the
 * whole API-key registry because the `svc:admin:*` WILDCARD must keep meaning
 * exactly "scopes spelled `svc:admin:`": widening it to every business scope by
 * accident is the kind of silent grant this class exists to prevent, and the
 * seeded ArcaAI account holds admin scopes explicitly for the same reason.
 * Each family therefore declares its own closed source list, and boot-audit
 * assertion D reconciles the registry against ALL OF THEM — a `svc:` scope
 * belonging to none of them fails the boot rather than existing quietly.
 */
import { API_KEY_SCOPE_REGISTRY, type ImpliedPermission, type ScopeDefinition } from '../apiKey/apikey-scopes.registry';

/** Every service-account scope starts with this. Nothing else may. */
export const SVC_SCOPE_PREFIX = 'svc:';

/**
 * `admin:department:manage` → `svc:admin:department:manage`;
 * `stt:stream:write` → `svc:stt:stream:write`. Pure renamespacing — it is the
 * ONE place a `svc:` string is constructed, so the two families below cannot
 * drift in how they are spelled.
 */
export function toServiceAccountScope(apiKeyScope: string): string {
  return `${SVC_SCOPE_PREFIX}${apiKeyScope}`;
}

/**
 * the STANDALONE-FEATURE scopes, the SECOND `svc:` family.
 *
 * ─── Why a second family at all ─────────────────────────────────────────────
 *
 * built this registry as a pure renamespacing of `admin:*`, because a
 * machine identity was only ever meant to reach the ADMINISTRATION plane. The
 * owner requirement of 2026-08-18 is different in kind: *"end-user can use
 * service-account/api-key for standalone features: speech-to-text,
 * summarization, via SDK compat and API compat"*. Those are BUSINESS-plane
 * capabilities (`audio/transcription-jobs`, `api/stt`, `text-generations`,
 * `api/smr/api/v1`), and no amount of `admin:*` derivation produces a scope
 * that names them — so a machine identity could reach NOTHING there
 * (`enforceServiceAccountScopes` denies every route that declares no `svc:*`
 * scope, and no route declared one).
 *
 * ─── Why it is DERIVED too, and from the API-key scope ──────────────────────
 *
 * The trap names is the reason this
 * is a list of SOURCE scope names rather than hand-written definitions:
 * `hasServiceAccountScope` is pure string matching, so an unregistered `svc:`
 * string still SATISFIES the guard, while `serviceAccountPolicyRules` silently
 * SKIPS it — the credential passes the scope gate and is then refused by CASL,
 * which is the worst possible failure to debug. Deriving each entry from the
 * API-key scope that already gates the same route makes BOTH halves — registry
 * membership and the ability mapping — land in one edit, by construction, with
 * the identical `implies` the human-credential path uses. Boot audit D
 * additionally refuses to start if any registry scope resolves to zero
 * abilities.
 *
 * ─── Why exactly these three ────────────────────────────────────────────────
 *
 * They are the scopes the four standalone surfaces ALREADY declare for API
 * keys, so the machine class reaches exactly the same routes as the human-
 * delegated class and not one more:
 *
 *   `stt:transcription:write` → `audio/transcription-jobs` (native STT)
 *   `stt:stream:write` → `api/stt` (compat STT)
 *   `consultation:report:write` → `text-generations` (native summarization)
 *                                 AND `api/smr/api/v1` (compat summarization)
 *
 * `ai:inference:write` (`safety-checks`, `text-analyses`) and `tts:speech:write`
 * (`speech`) are deliberately ABSENT: they are different standalone features
 * (guardrail moderation, medical NLP, speech synthesis) that the requirement
 * does not name, and deny-by-default means silence is a refusal, not an
 * oversight. Adding one is a single line here plus a decorator — see the ticket.
 */
export const STANDALONE_FEATURE_SCOPE_SOURCES = ['stt:transcription:write', 'stt:stream:write', 'consultation:report:write'] as const;

/** The renamespaced form of {@link STANDALONE_FEATURE_SCOPE_SOURCES}. */
export const STANDALONE_FEATURE_SVC_SCOPES: readonly string[] = STANDALONE_FEATURE_SCOPE_SOURCES.map(toServiceAccountScope);

/**
 * (owner decision **O-1**, 2026-08-19) — the ADMIN-PLANE
 * PRE-CONVENTION scopes, the THIRD `svc:` family.
 *
 * ─── The finding this exists for ────────────────────────────────────────────
 *
 * enumerated CONTROLLERS rather than scopes for the first time
 * and found three admin-plane controllers with nothing for the `svc:admin:*`
 * derivation to consume. `WebhookController` is one of them: it sits at
 * `admin/webhooks` but is gated by `@RequiredScopes('webhook:event:write')` —
 * a scope minted before the `admin:<area>` naming convention existed.
 * reserved the three `webhook:` strings *precisely because* their only consumer
 * is that admin controller, so the area is administration by every test except
 * the spelling of its scope. O-1 opens it to the machine class; the other two
 * (`MonitoringController`, `AdminHealthServicesController`) are closed with
 * `@ForbidServiceAccount()` and appear nowhere in this file.
 *
 * ─── Why a THIRD family and not one more line in the second ─────────────────
 *
 * Adding `webhook:event:write` to {@link STANDALONE_FEATURE_SCOPE_SOURCES}
 * would have been one line, and it would have been the wrong line: that
 * constant means "standalone BUSINESS-plane features an end user drives through
 * the SDK/compat surfaces (STT, summarization)", and `admin/webhooks` is
 * neither standalone nor business-plane. A constant whose name no longer
 * describes its contents is exactly how the next reader mis-derives the next
 * scope — and the boot audit would then be reconciling against a lie. The
 * header's own reasoning applies unchanged: families are kept apart so that
 * membership stays a justified decision per scope rather than a side effect of
 * where a string was convenient to type.
 *
 * ─── The deliberate consequence ─────────────────────────────────────────────
 *
 * `svc:admin:*` does NOT reach `svc:webhook:event:write` — the wildcard expands
 * over the `svc:admin:` PREFIX, not over "the admin plane". So this area is
 * granted explicitly or not at all, which is the same non-widening posture the
 * standalone family has and the same reason the seeded ArcaAI account
 * (`seed/94-service-account.ts`) enumerates its `svc:admin:<area>` scopes
 * instead of holding a wildcard. Widening the wildcard to cover it would be a
 * new owner decision, not a refactor.
 *
 * ─── Why DERIVED, like the other two ────────────────────────────────────────
 *
 * Same trap: `hasServiceAccountScope` is pure string matching, so a
 * hand-written `svc:` entry with no `implies` passes the scope guard and is
 * then refused by CASL. Deriving from the API-key scope that already gates the
 * SAME route lands both halves in one edit, with the identical ability
 * (`manage:Webhook`) the human-credential path uses.
 *
 * `webhook:event:read` is deliberately ABSENT: `WebhookController` is gated as
 * a whole by the write scope, so a read-only twin would grant nothing extra and
 * deny-by-default means silence is a refusal, not an oversight.
 */
export const ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES = ['webhook:event:read', 'webhook:event:write'] as const;

/** The renamespaced form of {@link ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES}. */
export const ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES: readonly string[] = ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES.map(toServiceAccountScope);

/**
 * TASK-930 §3 — the FOURTH `svc:` family: the agent + workflow BUSINESS plane.
 *
 * ─── The gap this closes ────────────────────────────────────────────────────
 *
 * A service account could reach every admin area and three standalone features, but NOT the two
 * planes a machine identity most obviously exists to drive: invoking a published agent
 * (`/agents/**`) and running a published workflow (`/workflows/**`). `AgentController`'s own
 * docblock said so out loud — "service accounts are deliberately not admitted (`svcScopes: []`)"
 * — which made an integration reach for a tenant API key bound to a human, or for nothing at all.
 *
 * ─── Why a FOURTH family rather than five more lines in the second ──────────
 *
 * The same reason `ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES` exists.
 * {@link STANDALONE_FEATURE_SCOPE_SOURCES} means "standalone BUSINESS-plane features an end user
 * drives through the SDK/compat surfaces (STT, summarization)". Agents and workflows are neither
 * standalone nor compat: they are the platform's own composition plane, published content a
 * tenant authors and a machine then calls. A constant whose name no longer describes its
 * contents is exactly how the NEXT scope gets mis-derived, and the boot audit would then be
 * reconciling against a lie.
 *
 * ─── What is deliberately ABSENT ────────────────────────────────────────────
 *
 * Nothing beyond the five above. This family is the UNBOUND plane only.
 *
 * SUPERSEDED (owner decision, 2026-09-09 — TASK-933): this docblock used to record the
 * CONSULTATION-BOUND plane (`workflows:` plural — `POST /consultations/:id/workflows/...`) as
 * deliberately closed to machines, on the reasoning that it writes real `ContextItem` rows
 * against a patient's consultation. The owner has since ruled that the platform service account
 * must hold *every* permission `@arcaai/vox-node` needs to drive a realtime consultation, and
 * that plane is one of them. It is therefore OPEN — but it is opened in
 * {@link CONSULTATION_REALTIME_SCOPE_SOURCES}, the fifth family, and NOT here: the clinical
 * consultation plane is a different justification from the unbound composition plane, and
 * merging the two would make the next reader inherit a grant nobody decided. The refusal that
 * used to live in this paragraph is now a decision recorded in the family that carries it.
 *
 * `svc:admin:*` does NOT reach these — the wildcard expands over the `svc:admin:` PREFIX — so
 * the family is granted explicitly or not at all, exactly like the other two source families.
 */
export const AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES = [
  'agent:definition:read',
  'agent:invocation:write',
  'workflow:definition:read',
  'workflow:run:read',
  'workflow:run:write',
] as const;

/** The renamespaced form of {@link AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES}. */
export const AGENT_WORKFLOW_BUSINESS_PLANE_SVC_SCOPES: readonly string[] = AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES.map(toServiceAccountScope);

/**
 * TASK-933 §3.1 — the FIFTH `svc:` family: the REALTIME CONSULTATION plane.
 *
 * ─── The gap this closes ────────────────────────────────────────────────────
 *
 * After TASK-930 a service account could invoke a published agent and run an unbound workflow,
 * but it could not drive a CONSULTATION — the thing the platform exists to do. Every route on
 * that path (`POST consultations/open`, `GET consultations/:id`, recording start/stop, case-note
 * writes, the four live SSE planes, `summary/latest`, the async job reads, the tenant's
 * context-schema discovery bundle and the consultation-bound workflows plane) declared no
 * `svc:*` scope at all, so `enforceServiceAccountScopes` refused every one of them by default.
 * An external broker driving a live consultation therefore had to borrow a tenant API key bound
 * to a human, which is precisely the delegation the machine class exists to replace.
 *
 * The owner opened it natively on 2026-09-09: the platform service account holds *every*
 * permission `@arcaai/vox-node` needs for a realtime consultation.
 *
 * ─── Why a FIFTH family and not more lines in the fourth ────────────────────
 *
 * The same rule that produced families two, three and four.
 * {@link AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES} means "the platform's own composition
 * plane — published content a tenant authors and a machine then calls". A realtime clinical
 * consultation is not that: it opens a patient-bound clinical record, writes into it, and
 * streams PHI. It needs its own justification, and a constant whose name stops describing its
 * contents is how the NEXT scope gets mis-derived — the boot audit would then be reconciling
 * against a lie.
 *
 * ─── What is in it, and the one thing that is not ───────────────────────────
 *
 *   `consultation:session:write` — open, recording start/stop, case notes, and the four live
 *                                  SSE planes. The streams REUSE the write scope rather than
 *                                  minting a `consultation:stream:read`: that would widen the
 *                                  API-key surface too (every `svc:` scope is derived from a
 *                                  real API-key scope), and no read-only stream consumer exists.
 *   `consultation:session:read`   — `GET consultations/:id`.
 *   `consultation:report:read`    — `summary/latest`, `summary/pre-summary/latest`, and the
 *                                   async job status/stream reads.
 *   `tenant:context-schema:read`  — `GET tenants/me/context-schema`, the discovery bundle a
 *                                   client needs before it can build a valid case-note payload.
 *   `workflows:execute`           — the CONSULTATION-BOUND workflows plane, opened by the same
 *                                   owner decision (see the fourth family's superseded note).
 *
 * `consultation:report:write` is deliberately NOT here: it is already registered by
 * {@link STANDALONE_FEATURE_SCOPE_SOURCES} (native + compat summarization) and one scope belongs
 * to exactly one family. `POST auth/stream-ticket` stays closed to machines — the SSE routes
 * authenticate the `X-Service-Account-Token` header directly and the STT ticket is auto-issued
 * by session create/refresh, so there is nothing a machine needs it for.
 *
 * `svc:admin:*` does NOT reach any of these — the wildcard expands over the `svc:admin:` PREFIX
 * — so the family is granted explicitly or not at all, exactly like the three before it.
 */
export const CONSULTATION_REALTIME_SCOPE_SOURCES = [
  'consultation:session:write',
  'consultation:session:read',
  'consultation:report:read',
  'tenant:context-schema:read',
  'workflows:execute',
] as const;

/** The renamespaced form of {@link CONSULTATION_REALTIME_SCOPE_SOURCES}. */
export const CONSULTATION_REALTIME_SVC_SCOPES: readonly string[] = CONSULTATION_REALTIME_SCOPE_SOURCES.map(toServiceAccountScope);

/**
 * Renamespace one declared source family into the registry. Shared by both
 * source-list families so they cannot drift in how a `svc:` row is built: the
 * description, the category and — the load-bearing part — the `implies` all
 * come from the API-key definition, never from this file.
 */
function deriveFamilyInto(registry: Record<string, ScopeDefinition>, sources: readonly string[], constantName: string): void {
  for (const source of sources) {
    const def = API_KEY_SCOPE_REGISTRY[source];
    if (!def) {
      throw new Error(
        `${constantName} names '${source}', which is not in API_KEY_SCOPE_REGISTRY. ` +
          `Every svc: family is DERIVED from the API-key scope that gates the same route; it cannot be invented here.`,
      );
    }
    registry[toServiceAccountScope(source)] = {
      description: `${def.description} (machine identity)`,
      category: 'ServiceAccount',
      implies: def.implies,
    };
  }
}

function buildRegistry(): Record<string, ScopeDefinition> {
  const registry: Record<string, ScopeDefinition> = {};

  for (const [scope, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
    // Concrete `admin:*` scopes only. The `admin:*` WILDCARD is deliberately
    // not renamespaced one-to-one: its service-account equivalent is
    // `svc:admin:*`, declared explicitly below so its expansion semantics are
    // this module's, not the API-key module's.
    if (!scope.startsWith('admin:') || scope.endsWith(':*')) continue;
    registry[toServiceAccountScope(scope)] = {
      description: `${def.description} (machine identity)`,
      category: 'ServiceAccount',
      implies: def.implies,
    };
  }

  // The four source-list families, each derived from the SAME API-key definition
  // the human-credential path uses on the same route, so the scope and its
  // abilities can never disagree. A source name that stops existing in
  // `API_KEY_SCOPE_REGISTRY` is a module-load crash, not a silently missing
  // registry row that `hasServiceAccountScope` would then accept as a bare
  // string while CASL refused it.
  deriveFamilyInto(registry, STANDALONE_FEATURE_SCOPE_SOURCES, 'STANDALONE_FEATURE_SCOPE_SOURCES');
  deriveFamilyInto(registry, ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES, 'ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES');
  deriveFamilyInto(registry, AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES, 'AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES');
  deriveFamilyInto(registry, CONSULTATION_REALTIME_SCOPE_SOURCES, 'CONSULTATION_REALTIME_SCOPE_SOURCES');

  // Wildcards carry `[]` and are resolved by EXPANSION in
  // `resolveServiceAccountImpliedPermissions`, never by a literal of their own —
  // the same convention `API_KEY_SCOPE_REGISTRY` uses.
  registry[`${SVC_SCOPE_PREFIX}admin:*`] = {
    description: 'Full administrative access for a machine identity',
    category: 'Wildcard',
    implies: [],
  };
  registry[`${SVC_SCOPE_PREFIX}*`] = {
    description: 'Unrestricted machine-identity access (platform service accounts only)',
    category: 'Wildcard',
    implies: [],
  };

  return registry;
}

export const SERVICE_ACCOUNT_SCOPE_REGISTRY: Record<string, ScopeDefinition> = buildRegistry();

/**
 * Registry membership. Deliberately strict: an unknown `svc:` string is INVALID
 * rather than "unconstrained", so a typo can never widen a credential.
 */
export function isValidServiceAccountScope(scope: string): boolean {
  return Object.prototype.hasOwnProperty.call(SERVICE_ACCOUNT_SCOPE_REGISTRY, scope);
}

/**
 * The CASL abilities a scope implies — the privilege CEILING input, mirroring
 * `resolveImpliedPermissions` for API keys.
 *
 * Fails CLOSED on an unknown scope for the reason `ApiKeyService.
 * assertScopeCeiling` documents: resolving an unrecognised string to "no
 * requirement" would turn a typo into a ceiling bypass.
 */
export function resolveServiceAccountImpliedPermissions(scope: string): ImpliedPermission[] {
  if (!isValidServiceAccountScope(scope)) {
    throw new Error(`Unknown service-account scope: ${scope}`);
  }

  const collected: ImpliedPermission[] = [];

  if (scope.endsWith(':*')) {
    const prefix = scope.slice(0, -1); // 'svc:admin:*' -> 'svc:admin:'
    for (const [key, def] of Object.entries(SERVICE_ACCOUNT_SCOPE_REGISTRY)) {
      if (key !== scope && key.startsWith(prefix)) collected.push(...def.implies);
    }
  } else {
    collected.push(...SERVICE_ACCOUNT_SCOPE_REGISTRY[scope].implies);
  }

  const seen = new Set<string>();
  return collected.filter((permission) => {
    const key = `${permission.action}:${permission.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Does a service account's held scope set satisfy `requiredScope`?
 *
 * Mirrors `ApiKeyService.hasScope`'s exact/parent/trailing-wildcard semantics
 * with ONE deliberate difference: there is no bare `'*'` universal grant. The
 * entity refuses to persist a non-`svc:` scope, so a `'*'` can only arrive from
 * a corrupted row or a hand-written test — and honouring it would silently make
 * a machine credential unrestricted. Every match is confined to the `svc:`
 * namespace, so an `svc:*` holder can never satisfy an `admin:*` requirement
 * (which is what boot-audit assertion C pins from the other direction).
 */
export function hasServiceAccountScope(heldScopes: string[] | null | undefined, requiredScope: string): boolean {
  if (!Array.isArray(heldScopes) || heldScopes.length === 0) return false;
  if (!requiredScope.startsWith(SVC_SCOPE_PREFIX)) return false;

  return heldScopes.some((scope) => {
    if (typeof scope !== 'string' || !scope.startsWith(SVC_SCOPE_PREFIX)) return false;
    if (requiredScope === scope) return true;
    // Parent scope: `svc:admin` grants `svc:admin:anything`. The delimiter is
    // retained so `svc:admin:department` cannot match `svc:admin:departmentagent`.
    if (requiredScope.startsWith(`${scope}:`)) return true;
    if (scope.endsWith(':*') && requiredScope.startsWith(scope.slice(0, -1))) return true;
    return false;
  });
}

export function getAvailableServiceAccountScopes(): Array<{ scope: string } & ScopeDefinition> {
  return Object.entries(SERVICE_ACCOUNT_SCOPE_REGISTRY).map(([scope, def]) => ({ scope, ...def }));
}

/**
 * The CASL rules a service account's scope set grants — the input to
 * `PolicyEngine.buildAbilityFromRules`.
 *
 * The account's authority IS its scope set: there is no user, no role
 * assignment and no database read behind it. That is the point of the
 * credential class — a machine's authority must be independently grantable and
 * revocable, not inherited from whichever human happens to have issued it (the
 * API-key path's `enforceApiKeyAbilities` does the opposite, deliberately, for
 * a credential that IS a delegation of a person).
 *
 * An unknown scope is SKIPPED rather than throwing: the entity refuses to
 * persist one, so reaching here means the registry shrank under a live
 * credential — in which case narrowing the ability is the safe direction and
 * failing the request outright would take down every consumer at once.
 */
export function serviceAccountPolicyRules(scopes: string[] | null | undefined): Array<{ action: string; subject: string }> {
  if (!Array.isArray(scopes)) return [];
  const rules: Array<{ action: string; subject: string }> = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    let implied: ImpliedPermission[];
    try {
      implied = resolveServiceAccountImpliedPermissions(scope);
    } catch {
      continue;
    }
    for (const permission of implied) {
      const key = `${permission.action}:${permission.subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ action: permission.action, subject: permission.subject });
    }
  }
  return rules;
}
