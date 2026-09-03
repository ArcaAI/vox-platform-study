/**
 * boot-time reachability audit for `CASL_ENFORCED_PAIRS`.
 *
 * listed three `ApiKey` pairs as ENFORCED; proved none of
 * them could ever fire, because the declaring route's subject-instance
 * resolver loads its row through a 404-throwing accessor and therefore fails
 * open on exactly the request the pair exists to deny. Nothing in the tree
 * compared the enforce list against the routes, so a pair could be listed —
 * and its Prometheus counter read a reassuring, structurally impossible zero —
 * indefinitely.
 *
 * This audit closes that. It walks the live controller table, builds the
 * descriptor set `assertCaslEnforcePairReachability` consumes, and refuses to
 * start the gateway when a listed pair cannot fire, or is declared on an
 * OR-mode route where enforcing it would rewrite the route's own semantics.
 *
 * Reads metadata through the app's own `Reflector` with
 * `getAllAndOverride([methodRef, ControllerClass])`, so it sees exactly what
 * `UnifiedAuthGuard` sees at request time — class-level decorators included,
 * which Nest does NOT copy onto route handlers.
 *
 * With the enforce list currently EMPTY this passes vacuously. That is the
 * correct state (see `policy.engine.ts`), and it is why the audit's own
 * behaviour is pinned on synthetic routes in
 * `__tests__/casl-enforce-reachability-audit.test.ts` rather than on the real
 * app alone.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import {
  CASL_ENFORCED_PAIRS,
  PERMISSION_MODE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  SUBJECT_INSTANCE_RESOLVER_KEY,
  assertCaslEnforcePairReachability,
  type EnforceRouteDescriptor,
} from '@arcaai/applications';

type RequiredPermissionLike = { action: string; subject: string };

export function collectEnforceRouteDescriptors(app: INestApplicationContext): EnforceRouteDescriptor[] {
  const modulesContainer = app.get(ModulesContainer);
  const reflector = app.get(Reflector);
  const metadataScanner = new MetadataScanner();

  const descriptors: EnforceRouteDescriptor[] = [];

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
        if (Reflect.getMetadata(METHOD_METADATA, methodRef) === undefined) continue;

        const required = reflector.getAllAndOverride<RequiredPermissionLike[] | undefined>(REQUIRED_PERMISSIONS_KEY, [methodRef, ControllerClass]);
        if (!Array.isArray(required) || required.length === 0) continue;

        const mode = reflector.getAllAndOverride<'AND' | 'OR' | undefined>(PERMISSION_MODE_KEY, [methodRef, ControllerClass]) === 'OR' ? 'OR' : 'AND';

        // The metadata is a descriptor since; a bare function is the
        // earlier shape and is, by definition, not enforce-grade — it
        // carries no attestation at all. That is precisely the F-1 shape.
        const declared = reflector.getAllAndOverride<unknown>(SUBJECT_INSTANCE_RESOLVER_KEY, [methodRef, ControllerClass]);
        const resolver = readResolver(declared);

        descriptors.push({
          id: `${joinPath(controllerPath, readPath(methodRef))} (${ControllerClass.name}.${methodName})`,
          permissions: required.map((p) => ({ action: p.action, subject: p.subject })),
          mode,
          ...(resolver ? { resolver } : {}),
        });
      }
    }
  }

  return descriptors;
}

export function auditCaslEnforcePairReachability(app: INestApplicationContext, enforcedPairs: ReadonlySet<string> = CASL_ENFORCED_PAIRS): void {
  assertCaslEnforcePairReachability(enforcedPairs, collectEnforceRouteDescriptors(app));
}

function readResolver(declared: unknown): EnforceRouteDescriptor['resolver'] | undefined {
  if (typeof declared === 'function') return { subject: undefined, enforceGrade: false };
  if (declared && typeof declared === 'object' && 'resolver' in declared) {
    const d = declared as { subject?: string; enforceGrade?: boolean };
    return { subject: d.subject, enforceGrade: d.enforceGrade === true };
  }
  return undefined;
}

function readPath(target: unknown): string {
  const raw = Reflect.getMetadata(PATH_METADATA, target as object);
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
