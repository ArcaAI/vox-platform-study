/**
 * The `svc:*` scope namespace — TASK-762.
 *
 * ─── Why this is a SEPARATE registry ────────────────────────────────────────
 *
 * The TASK-708 §6 owner ruling ("we cannot mix the `/admin/*` and `/internal/*`
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
 * TASK-757 puts the 56 `admin:*` scopes in reserve: they still name exactly one
 * admin controller area each, they are just no longer reachable by an API key.
 * Re-typing them here would guarantee drift and would make §5.7 boot-audit
 * assertion D ("every `svc:*` scope maps to a live admin area, and every admin
 * area is covered by exactly one `svc:*` scope") an aspiration rather than a
 * fact. Instead every `admin:<area>` scope is RENAMESPACED to `svc:admin:<area>`
 * at module load, carrying its `implies` verbatim. Adding an admin controller
 * area therefore extends both surfaces in one edit, and D holds by construction.
 *
 * The ticket §3 Option 2 "Fit" row sanctions exactly this ("reuses the `admin:*`
 * scope vocabulary TASK-757 puts in reserve (renamespaced `svc:admin:*` or
 * mapped 1:1)").
 *
 * ─── TASK-767: a SECOND derived family, on the business plane ───────────────
 *
 * The registry now holds two families, both renamespaced from
 * `API_KEY_SCOPE_REGISTRY` and neither hand-written:
 *
 *   `svc:admin:<area>`  — every concrete `admin:*` scope (TASK-762, above)
 *   `svc:<feature>`     — the standalone STT + summarization scopes
 *                         (TASK-767, {@link STANDALONE_FEATURE_SCOPE_SOURCES})
 *
 * They are kept as separate families rather than one blanket derivation of the
 * whole API-key registry because the `svc:admin:*` WILDCARD must keep meaning
 * exactly "the administration plane": widening it to every business scope by
 * accident is the kind of silent grant this class exists to prevent, and the
 * seeded ArcaAI account holds admin scopes explicitly for the same reason.
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
 * TASK-767 — the STANDALONE-FEATURE scopes, the SECOND `svc:` family.
 *
 * ─── Why a second family at all ─────────────────────────────────────────────
 *
 * TASK-762 built this registry as a pure renamespacing of `admin:*`, because a
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
 * The trap TASK-766 §"Coordination note for TASK-767" names is the reason this
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
 *   `stt:transcription:write`   → `audio/transcription-jobs`   (native STT)
 *   `stt:stream:write`          → `api/stt`                    (compat STT)
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

  // TASK-767 — the standalone-feature family, derived from the SAME API-key
  // definition the human-credential path uses on the same route, so the scope
  // and its abilities can never disagree. A source name that stops existing in
  // `API_KEY_SCOPE_REGISTRY` is a module-load crash, not a silently missing
  // registry row that `hasServiceAccountScope` would then accept as a bare
  // string while CASL refused it.
  for (const source of STANDALONE_FEATURE_SCOPE_SOURCES) {
    const def = API_KEY_SCOPE_REGISTRY[source];
    if (!def) {
      throw new Error(
        `TASK-767: STANDALONE_FEATURE_SCOPE_SOURCES names '${source}', which is not in API_KEY_SCOPE_REGISTRY. ` +
          `The svc: standalone family is DERIVED from the API-key scope that gates the same route; it cannot be invented here.`,
      );
    }
    registry[toServiceAccountScope(source)] = {
      description: `${def.description} (machine identity)`,
      category: 'ServiceAccount',
      implies: def.implies,
    };
  }

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
