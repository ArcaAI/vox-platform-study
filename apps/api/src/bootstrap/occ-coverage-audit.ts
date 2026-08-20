import type { INestApplicationContext } from '@nestjs/common';
import { Logger, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';

import { REQUIRES_IF_MATCH_KEY } from '../decorators/requiresIfMatch.decorator';
import { NO_OPTIMISTIC_CONCURRENCY_KEY } from '../decorators/noOptimisticConcurrency.decorator';
import { extractExpectedVersion } from '../decorators/expectedVersion.decorator';

/**
 * Boot-time OPTIMISTIC-CONCURRENCY COVERAGE audit (REST review finding H-1).
 *
 * ## Why this one warns instead of refusing to boot
 *
 * Every other audit in this directory fails closed, because every other audit
 * pins an invariant the codebase ALREADY satisfies — a violation is new drift.
 * This one is different: it publishes an inventory we have **not yet
 * migrated**. OCC is currently applied per-ROUTE rather than per-RESOURCE, so
 * of the PATCH/PUT surface only a minority carries `@RequiresIfMatch()`, and
 * eight aggregates are internally MIXED (the same row is CAS-protected on one
 * route and clobberable on another). Closing that gap is BREAKING — every
 * client call without `If-Match` becomes a 428, so the admin console,
 * `@arcaai/vox` and `@arcaai/vox-node` need a coordinated release. That is an
 * owner-sequenced migration, not a boot-time assertion.
 *
 * Throwing here would therefore do the one thing an audit must never do: make
 * the gateway unstartable for a condition the operator cannot fix. So this
 * function logs a sorted, actionable WARN report and returns. It becomes a
 * fail-closed audit on the day the inventory reaches zero — at which point the
 * only correct escape hatch is `@NoOptimisticConcurrency('<reason>')`.
 *
 * ## Detection rule (stated explicitly, as the finding requires)
 *
 * A route is reported when ALL of the following hold:
 *
 *   1. Its HTTP verb is PATCH or PUT. (POST creates and DELETE removals are out
 *      of scope for the finding; a conditional DELETE is a separate question.)
 *   2. It carries neither `@RequiresIfMatch()` nor
 *      `@NoOptimisticConcurrency()` — both read via
 *      `Reflector.getAllAndOverride([methodRef, ControllerClass])`, so
 *      class-level declarations are visible (Nest does not copy class metadata
 *      onto route handlers), and it is not in `SANCTIONED_EXCEPTIONS` below.
 *   3. The route's RESOURCE is version-bearing, evidenced by at least one of:
 *
 *      - **E1 — the response DTO declares a `version` property.** Candidate
 *        response classes are read from the handler's (then the controller's)
 *        `swagger/apiResponse` 2xx `type` and from `swagger/apiExtraModels`
 *        (which is what `@ApiEndpoint({ returnedModel })` emits). A class
 *        counts when `swagger/apiModelPropertiesArray` — the array
 *        `@ApiProperty()` maintains on the prototype — contains `:version`
 *        anywhere on its prototype chain. This is deliberately the SAME
 *        condition that makes `ETagInterceptor` fire: a numeric top-level
 *        `version` in the body. Those are exactly the resources whose GET
 *        hands a client an `ETag` and therefore advertises a conditional-write
 *        contract.
 *      - **E2 — the handler takes an `@ExpectedVersion()` parameter.**
 *        Detected by identity: the custom route-arg factory recorded in
 *        `__routeArguments__` is compared with `extractExpectedVersion` itself,
 *        so no name matching is involved. Such a route already speaks OCC; it
 *        just never makes the precondition mandatory.
 *
 * ## False positives / false negatives — the limits of the above
 *
 * This rule reads DECLARATIONS, not the database. It cannot know whether a
 * Prisma model has `_version`; it knows what the HTTP surface says about it.
 * Consequences, stated rather than hidden:
 *
 *   - **False negative (under-reporting, the dominant error mode).** A route
 *     whose response DTO omits `version`, or which returns `void` / a plain
 *     ack, is invisible here even when the underlying row is version-bearing.
 *     Sub-resource writes that return the child rather than the versioned
 *     parent are the systematic case. The published inventory
 *     (`docs/implementation/TASK-776-API-Contract-Test-Suite/occ-coverage-inventory.md`)
 *     is the human-reviewed superset and is authoritative where the two differ.
 *   - **False negative.** A response DTO that carries `version` through
 *     inheritance from a base class NOT decorated with `@ApiProperty()` (plain
 *     `declare version: number`) is missed — the swagger array is the only
 *     runtime-visible property list.
 *   - **False positive.** A route that returns a versioned resource but does
 *     not itself mutate it (an action endpoint echoing state back) is reported
 *     even though it has nothing to CAS on. E2 also flags a route whose
 *     `@ExpectedVersion()` is an intentional create-or-update precondition —
 *     which is precisely what `@NoOptimisticConcurrency()` exists to record.
 *
 * An inventory that overstates is worse than one that admits its limits: the
 * rule is intentionally biased toward under-reporting, and every reported
 * route names the evidence that reported it so a reviewer can dismiss it in
 * one read.
 */
const AUDIT_LOGGER_CONTEXT = 'OccCoverageAudit';

/**
 * Legacy holding pen for deliberate exceptions that predated
 * `@NoOptimisticConcurrency()`.
 *
 * **It is empty, and it must stay empty.** Both original entries
 * (`SettingsRegistryWriteController.putSetting`,
 * `TenantFrontendConfigAdminController.upsert`) now carry an in-place
 * `@NoOptimisticConcurrency('<reason>')` on the controller, which is the only
 * sanctioned way to record an exception: the reason lives next to the route it
 * excuses instead of in a table a reader of the controller never opens.
 *
 * The lookup is retained (rather than deleted outright) purely so the audit's
 * `sanctioned` accounting has one code path whether an exception is declared
 * or inherited; adding a key here instead of decorating the controller is a
 * regression, not a shortcut.
 *
 * Keyed `ControllerClass.handlerName`.
 */
export const SANCTIONED_EXCEPTIONS: ReadonlyMap<string, string> = new Map<string, string>();

export interface OccCoverageFinding {
  readonly controller: string;
  readonly handler: string;
  readonly httpMethod: string;
  readonly path: string;
  /** Which detection signals fired — `responseDtoVersion` (E1), `expectedVersionParam` (E2). */
  readonly evidence: readonly string[];
}

export interface OccCoverageReport {
  readonly findings: readonly OccCoverageFinding[];
  /** PATCH/PUT routes that DO carry `@RequiresIfMatch()`. */
  readonly protectedCount: number;
  /** PATCH/PUT routes total. */
  readonly totalMutatingRoutes: number;
  /** Routes excused by `@NoOptimisticConcurrency()` or `SANCTIONED_EXCEPTIONS`. */
  readonly sanctioned: readonly string[];
  /** Routes carrying BOTH `@RequiresIfMatch()` and `@NoOptimisticConcurrency()` — a contradiction. */
  readonly contradictions: readonly string[];
}

/**
 * Walks every registered controller and reports version-bearing PATCH/PUT
 * routes that do not require `If-Match`.
 *
 * WARN-ONLY by contract: this function never throws and never refuses boot.
 * It returns the report so tests (and future tooling) can assert on it.
 */
export function auditOptimisticConcurrencyCoverage(
  app: INestApplicationContext,
  logger: Pick<Logger, 'warn' | 'log'> = new Logger(AUDIT_LOGGER_CONTEXT),
): OccCoverageReport {
  const modulesContainer = app.get(ModulesContainer);
  const reflector = app.get(Reflector);
  const metadataScanner = new MetadataScanner();

  const findings: OccCoverageFinding[] = [];
  const sanctioned: string[] = [];
  const contradictions: string[] = [];
  let protectedCount = 0;
  let totalMutatingRoutes = 0;

  for (const moduleRef of modulesContainer.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const ControllerClass = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!ControllerClass || !instance) continue;

      const proto = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!proto) continue;

      const controllerPath = readPath(ControllerClass);

      for (const methodName of metadataScanner.getAllMethodNames(proto)) {
        const methodRef = proto[methodName];
        if (typeof methodRef !== 'function') continue;

        const httpMethodCode = Reflect.getMetadata(METHOD_METADATA, methodRef) as number | undefined;
        if (httpMethodCode !== RequestMethod.PATCH && httpMethodCode !== RequestMethod.PUT) continue;

        totalMutatingRoutes += 1;

        const key = `${ControllerClass.name}.${methodName}`;
        const httpMethod = httpMethodCode === RequestMethod.PATCH ? 'PATCH' : 'PUT';
        const fullPath = joinPath(controllerPath, readPath(methodRef as object));

        const requiresIfMatch = reflector.getAllAndOverride<boolean>(REQUIRES_IF_MATCH_KEY, [methodRef, ControllerClass]) === true;
        const declaredReason = reflector.getAllAndOverride<string>(NO_OPTIMISTIC_CONCURRENCY_KEY, [methodRef, ControllerClass]);
        const staticReason = SANCTIONED_EXCEPTIONS.get(key);
        const reason = declaredReason ?? staticReason;

        if (requiresIfMatch) {
          protectedCount += 1;
          if (declaredReason !== undefined) {
            contradictions.push(
              `${httpMethod} ${fullPath} (${key}) carries BOTH @RequiresIfMatch() and @NoOptimisticConcurrency('${declaredReason}').`,
            );
          }
          continue;
        }

        if (reason !== undefined) {
          sanctioned.push(`${httpMethod} ${fullPath} (${key}) — ${reason}`);
          continue;
        }

        const evidence: string[] = [];
        if (responseDtoDeclaresVersion(methodRef, ControllerClass)) evidence.push('responseDtoVersion');
        if (declaresExpectedVersionParam(ControllerClass, methodName)) evidence.push('expectedVersionParam');
        if (evidence.length === 0) continue;

        findings.push({ controller: ControllerClass.name, handler: methodName, httpMethod, path: fullPath, evidence });
      }
    }
  }

  findings.sort((a, b) => a.path.localeCompare(b.path) || a.httpMethod.localeCompare(b.httpMethod) || a.controller.localeCompare(b.controller));
  sanctioned.sort();
  contradictions.sort();

  emit({ findings, protectedCount, totalMutatingRoutes, sanctioned, contradictions }, logger);

  return { findings, protectedCount, totalMutatingRoutes, sanctioned, contradictions };
}

function emit(report: OccCoverageReport, logger: Pick<Logger, 'warn' | 'log'>): void {
  const { findings, protectedCount, totalMutatingRoutes, sanctioned, contradictions } = report;

  logger.log(
    `OCC coverage: ${protectedCount}/${totalMutatingRoutes} PATCH/PUT routes require If-Match; ` +
      `${sanctioned.length} sanctioned exception(s); ${findings.length} version-bearing route(s) unprotected.`,
  );

  for (const contradiction of contradictions) {
    logger.warn(`OCC contradiction — ${contradiction}`);
  }

  if (findings.length === 0) return;

  const byController = new Map<string, OccCoverageFinding[]>();
  for (const finding of findings) {
    const bucket = byController.get(finding.controller);
    if (bucket) bucket.push(finding);
    else byController.set(finding.controller, [finding]);
  }

  const lines: string[] = [];
  for (const controller of [...byController.keys()].sort()) {
    lines.push(`  ${controller}`);
    for (const f of byController.get(controller) ?? []) {
      lines.push(`    - ${f.httpMethod} ${f.path} (${f.handler}) [${f.evidence.join(',')}]`);
    }
  }

  logger.warn(
    `REST review H-1 — OCC is applied per-ROUTE, not per-RESOURCE. ${findings.length} version-bearing PATCH/PUT route(s) ` +
      `lack @RequiresIfMatch(), so a client that read an ETag can still blind-overwrite the row:\n${lines.join('\n')}\n` +
      `  Evidence keys: responseDtoVersion = the response DTO declares a version property (ETagInterceptor fires); ` +
      `expectedVersionParam = the handler already takes @ExpectedVersion() but never makes it mandatory.\n` +
      `  Adding the decorator is BREAKING (missing header ⇒ 428). Inventory and phased migration: ` +
      `docs/implementation/TASK-776-API-Contract-Test-Suite/occ-coverage-inventory.md. ` +
      `Deliberate exceptions declare @NoOptimisticConcurrency('<reason>').`,
  );
}

/** E1 — does any declared 2xx response model of this route carry a `version` property? */
function responseDtoDeclaresVersion(methodRef: unknown, ControllerClass: object): boolean {
  for (const candidate of responseModelCandidates(methodRef, ControllerClass)) {
    if (declaresVersionProperty(candidate)) return true;
  }
  return false;
}

function responseModelCandidates(methodRef: unknown, ControllerClass: object): object[] {
  const out: object[] = [];

  for (const target of [methodRef as object, ControllerClass]) {
    if (!target) continue;

    const responses = Reflect.getMetadata('swagger/apiResponse', target) as Record<string, { type?: unknown }> | undefined;
    if (responses) {
      for (const [status, meta] of Object.entries(responses)) {
        const code = Number.parseInt(status, 10);
        if (!Number.isInteger(code) || code < 200 || code > 299) continue;
        const type = meta?.type;
        if (typeof type === 'function') out.push(type);
      }
    }

    const extraModels = Reflect.getMetadata('swagger/apiExtraModels', target) as unknown[] | undefined;
    if (Array.isArray(extraModels)) {
      for (const model of extraModels) {
        if (typeof model === 'function') out.push(model);
      }
    }
  }

  return out;
}

/**
 * A class "declares version" when `@ApiProperty()` registered `:version` on its
 * prototype (or any ancestor prototype). `swagger/apiModelPropertiesArray` is
 * the only runtime-visible property list for a plain response DTO.
 */
function declaresVersionProperty(model: object): boolean {
  let proto: unknown = (model as { prototype?: unknown }).prototype;
  while (proto && proto !== Object.prototype) {
    const props = Reflect.getOwnMetadata?.('swagger/apiModelPropertiesArray', proto as object) as string[] | undefined;
    if (Array.isArray(props) && props.includes(':version')) return true;
    proto = Object.getPrototypeOf(proto as object);
  }
  return false;
}

/** E2 — does the handler take an `@ExpectedVersion()` parameter? Compared by factory identity. */
function declaresExpectedVersionParam(ControllerClass: object, methodName: string): boolean {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ControllerClass, methodName) as Record<string, { factory?: unknown }> | undefined;
  if (!args) return false;
  return Object.values(args).some((arg) => arg?.factory === extractExpectedVersion);
}

function readPath(target: object): string {
  const raw = Reflect.getMetadata(PATH_METADATA, target);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return '';
}

function joinPath(controllerPath: string, methodPath: string): string {
  const normalize = (segment: string): string => (segment ? (segment.startsWith('/') ? segment : `/${segment}`) : '');
  const a = normalize(controllerPath).replace(/\/+$/, '');
  const b = normalize(methodPath).replace(/\/+$/, '');
  return `${a}${b}` || '/';
}
