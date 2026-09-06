/**
 * structural reachability of `CASL_ENFORCED_PAIRS`.
 *
 * listed three `ApiKey` pairs as ENFORCED. e2e then proved
 * none of them could ever produce the 403 the list describes: the declaring
 * route's `@ResolveSubjectInstance` resolver loads its row through
 * `IApiKeyService.fetchById`, which asserts access and throws 404 for a
 * non-owned key — so on exactly the request the pair exists to deny, the
 * resolver THREW, `runCaslInstanceChecks` swallowed it on its fail-open path,
 * and no denial was ever produced. `casl_enforce_denial_total` could not move.
 *
 * The security cost of that was nil (404 hides existence, which is stronger
 * than 403). The OBSERVABILITY cost was the real defect: a counter that reads
 * zero because it cannot fire is indistinguishable from one that reads zero
 * because nothing diverged, and R1's "shadow → measure → enforce" rollout is
 * supposed to read that counter to decide.
 *
 * This module makes that failure mode mechanical rather than a review
 * argument. `assertCaslEnforcePairReachability` is a PURE function over a
 * route table so it can be unit-tested on synthetic routes (the shipped list
 * is empty, so the boot audit that calls it passes vacuously — its behaviour
 * has to be pinned somewhere that is not vacuous). `apps/api` builds the route
 * table from the live Nest container and calls it at boot.
 *
 * ### What "reachable" means here
 *
 * A pair is reachable when at least ONE route can actually hand the guard an
 * instance for a row the caller does NOT own — because that is the only
 * request an enforced pair exists to deny. Whether a given resolver does that
 * cannot be decided statically (it depends on which accessor it calls), so it
 * is DECLARED: `@ResolveSubjectInstance(fn, { enforceGrade: true })` is the
 * route author attesting that `fn` does not delegate to an access-asserting
 * accessor. A resolver that fails open on the deny case is, by definition, not
 * enforce-grade — and declaring it as such is the one thing this audit cannot
 * catch. Everything else is checked.
 *
 * ### And what it refuses outright
 *
 * An OR-mode (`@CanAny`) route may not declare an enforced pair AT ALL — not
 * even alongside a reachable one. `UnifiedAuthGuard` applies enforced denials
 * after the type-only verdict, so on an OR route a denial from alternative A
 * would override an allow earned by alternative B and silently turn the
 * route's declared OR into an AND. The guard refuses to enforce in OR mode as
 * well (defense in depth); this makes the combination unshippable.
 */

/** What a route declares, as far as enforce-reachability is concerned. */
export interface EnforceRouteDescriptor {
  /** Human-readable route identity, used verbatim in the failure message. */
  id: string;
  /** The `(action, subject)` permissions the route requires. */
  permissions: ReadonlyArray<{ action: string; subject: string }>;
  /** `AND` (default) or `OR` (`@CanAny` / `@AuthorizeAny`). */
  mode: 'AND' | 'OR';
  /** The route's `@ResolveSubjectInstance` declaration, if it has one. */
  resolver?: {
    /** The subject this resolver resolves an instance FOR, when declared. */
    subject?: string;
    /** Attests the resolver returns an instance for rows the caller does not own. */
    enforceGrade: boolean;
  };
}

const describePair = (pair: string): { action: string; subject: string } => {
  const [action, ...rest] = pair.split(':');
  return { action, subject: rest.join(':') };
};

/**
 * Throws when any pair in `enforcedPairs` is structurally unable to produce
 * the denial it claims, or is declared on a route where enforcing it would
 * change that route's declared permission semantics.
 */
export function assertCaslEnforcePairReachability(enforcedPairs: ReadonlySet<string>, routes: ReadonlyArray<EnforceRouteDescriptor>): void {
  const problems: string[] = [];

  for (const pair of enforcedPairs) {
    const { action, subject } = describePair(pair);
    const declaring = routes.filter((route) => route.permissions.some((p) => p.action === action && p.subject === subject));

    if (declaring.length === 0) {
      problems.push(
        `${pair}: no route declares this permission, so the enforce path can never run. ` +
          `Remove it from CASL_ENFORCED_PAIRS, or add the route that needs it.`,
      );
      continue;
    }

    // R4 — OR mode is refused outright, even if another route makes the pair
    // reachable. An enforced denial applied after an OR-mode allow silently
    // rewrites the route's semantics.
    const orRoutes = declaring.filter((route) => route.mode === 'OR');
    if (orRoutes.length > 0) {
      problems.push(
        `${pair}: declared on ${orRoutes.length} route(s) in OR mode (${orRoutes.map((r) => r.id).join(', ')}). ` +
          `An enforced denial on one alternative would override an allow earned by another, turning the route's ` +
          `declared OR into an AND. Split the route, or do not enforce this pair.`,
      );
    }

    const reachable = declaring.some(
      (route) =>
        route.mode === 'AND' &&
        route.resolver !== undefined &&
        route.resolver.enforceGrade &&
        (route.resolver.subject === undefined || route.resolver.subject === subject),
    );

    if (!reachable) {
      problems.push(
        `${pair}: none of the ${declaring.length} declaring route(s) can hand the guard an instance for a row the ` +
          `caller does not own — no enforce-grade @ResolveSubjectInstance resolver for this subject ` +
          `(${declaring.map((r) => `${r.id}${describeResolver(r)}`).join('; ')}). ` +
          `The pair would be listed as enforced while casl_enforce_denial_total could never increment (F-1). ` +
          `Either give the route a resolver declared { subject: '${subject}', enforceGrade: true } that loads the row ` +
          `WITHOUT an ownership assertion, or remove the pair.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`refused to start — ${problems.length} unreachable CASL enforce pair(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

const describeResolver = (route: EnforceRouteDescriptor): string => {
  if (!route.resolver) return ' [no resolver]';
  const subject = route.resolver.subject ? `subject=${route.resolver.subject}` : 'subject=<undeclared>';
  return ` [${subject}, enforceGrade=${route.resolver.enforceGrade}, mode=${route.mode}]`;
};
