/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TASK-958 — the repository lookups the connection service gained, expressed in
 * terms of the one every fixture in this folder already stubs.
 *
 * These suites predate multiplicity, so each holds AT MOST ONE row per
 * (tenant, service, provider). Since TASK-958 that is precisely the DEFAULT
 * connection, and a default's slug IS its provider id — so the by-slug, the
 * by-default and the group lookups all answer from the same stub, and the
 * assertions those suites make on `findByTenantServiceProvider` keep counting
 * the same calls.
 *
 * A fixture that wants to exercise SIBLINGS must stub the lookups itself (see
 * `ai-provider-connection.multiplicity.task958.test.ts`, which backs them with a
 * real array); this helper exists so the pre-958 suites keep testing what they
 * were written to test rather than being rewritten around a shape they do not
 * use.
 */
export function withTask958Lookups<T extends Record<string, any>>(repo: T): T {
  const r = repo as Record<string, any>;
  const byDefault = r.findByTenantServiceProvider;

  r.findByTenantServiceSlug ??= byDefault;
  r.findDefaultByTenantServiceProvider ??= byDefault;
  r.findAllByTenantServiceProvider ??= async (...args: any[]) => {
    const row = await byDefault?.(...args);
    return row ? [row] : [];
  };
  r.findDeletedByTenantServiceSlug ??= r.findDeletedByTenantServiceProvider ?? (async () => null);
  // Read by `countTenantConnections` (the create-time quota precheck) for every
  // service, and by the whole-service cascade shape.
  r.findByTenantIdAndService ??= async () => [];

  return repo;
}
