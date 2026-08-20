import { SetMetadata } from '@nestjs/common';

/**
 * Reflector key for the `@NoOptimisticConcurrency()` route-level marker.
 */
export const NO_OPTIMISTIC_CONCURRENCY_KEY = 'noOptimisticConcurrency';

/**
 * Declares that a mutating route DELIBERATELY does not require the RFC 7232
 * `If-Match` precondition, and records WHY.
 *
 * This is the counterpart of `@RequiresIfMatch()` for the routes where the
 * absence of a precondition is a decision rather than an oversight. It is
 * metadata-only and changes NO runtime behaviour: its sole consumer is the
 * warn-only boot audit `auditOptimisticConcurrencyCoverage`
 * (`src/bootstrap/occ-coverage-audit.ts`), which drops annotated routes from
 * its report.
 *
 * The reason string is mandatory and is echoed by the audit, so an exception
 * can never become an anonymous silence.
 *
 * The canonical sanctioned shape today is the **create-or-update config
 * write**: the route takes `@ExpectedVersion()` but not `@RequiresIfMatch()`,
 * because a FIRST write has no row, therefore no ETag, therefore nothing for
 * the client to echo — `@RequiresIfMatch()` would 428 forever. The service
 * applies the precondition only when a row exists, so first writes succeed and
 * later ones still cannot blind-overwrite. Both current instances are named in
 * `SANCTIONED_EXCEPTIONS` in the audit.
 *
 * ## Usage
 *
 *     @Put('registry/:key')
 *     @NoOptimisticConcurrency('create-or-update: a first write has no row to precondition on')
 *     async putSetting(...) { ... }
 *
 * ## Rules
 *  - The reason must describe the MECHANISM, not restate the absence
 *    ("no If-Match here" is not a reason).
 *  - Never combine with `@RequiresIfMatch()` — the audit reports that pair as
 *    a contradiction.
 *  - It is not a way to silence a route that simply has not been migrated yet;
 *    those belong in the inventory
 *    (`docs/implementation/TASK-776-API-Contract-Test-Suite/occ-coverage-inventory.md`).
 *
 * @see apps/api/src/bootstrap/occ-coverage-audit.ts
 * @see apps/api/src/decorators/requiresIfMatch.decorator.ts
 */
export const NoOptimisticConcurrency = (reason: string): MethodDecorator => SetMetadata(NO_OPTIMISTIC_CONCURRENCY_KEY, reason);
