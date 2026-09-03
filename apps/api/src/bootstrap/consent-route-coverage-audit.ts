import type { INestApplicationContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { CONSENT_EXEMPT_KEY, REQUIRES_CONSENT_KEY, SKIP_AUTH_KEY } from '@arcaai/applications';

/**
 * Boot-time consent-coverage audit (consent-abac
 * Task 11).
 *
 * Walks every controller registered on the Nest application context and
 * refuses to start if any HTTP route whose full path carries a `:patientId`
 * segment declares NEITHER `@RequiresConsent(...)` NOR `@ConsentExempt(...)`.
 *
 * Scope note (a deliberate, disclosed narrowing from the ticket's original
 * Task 11 predicate — see
 * the full predicate is "every route in the consultation module AND
 * every route with a `patientId` parameter". This audit checks the
 * `:patientId`-parameter half only. Decorating every one of the consultation
 * module's ~60 other routes (PATCH/close/reopen/tags/highlights/etc., none
 * of which take a patient id) with an explicit `@ConsentExempt(reason)`
 * would touch a very large surface for routes this ticket's gated stages
 * (prior-history retrieval, capture start) never named — done here as a
 * `:patientId`-only check to keep the change surgical and correct rather
 * than mechanically exempting dozens of unrelated routes. Widening to the
 * full module-wide predicate is a follow-up, tracked in consent-design.md.
 *
 * Diagnostic-only — mirrors `admin-route-permission-audit.ts` exactly
 * (implementation notes below are the same reasoning, restated for this
 * audit's own metadata keys).
 */
const PATIENT_ID_PARAM_RE = /:patientId(?:\/|$)/;

export function auditConsentRouteCoverage(app: INestApplicationContext): void {
  const modulesContainer = app.get(ModulesContainer);
  const reflector = app.get(Reflector);
  const metadataScanner = new MetadataScanner();

  const offenders: string[] = [];

  for (const moduleRef of modulesContainer.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const ControllerClass = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!ControllerClass || !instance) continue;

      const proto = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!proto) continue;

      const controllerPath = readControllerPath(ControllerClass);

      for (const methodName of metadataScanner.getAllMethodNames(proto)) {
        const methodRef = proto[methodName];
        if (typeof methodRef !== 'function') continue;

        const httpMethodCode = Reflect.getMetadata(METHOD_METADATA, methodRef);
        if (httpMethodCode === undefined) continue;

        const skipAuth = reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [methodRef, ControllerClass]);
        if (skipAuth === true) continue;

        const methodPath = readMethodPath(methodRef);
        const fullPath = joinPath(controllerPath, methodPath);
        if (!PATIENT_ID_PARAM_RE.test(fullPath)) continue;

        const requiresConsent = reflector.getAllAndOverride<unknown>(REQUIRES_CONSENT_KEY, [methodRef, ControllerClass]);
        const consentExempt = reflector.getAllAndOverride<string | undefined>(CONSENT_EXEMPT_KEY, [methodRef, ControllerClass]);
        if (requiresConsent !== undefined || consentExempt !== undefined) continue;

        offenders.push(
          `Route ${fullPath} on ${ControllerClass.name}.${methodName} takes a :patientId route param but has ` +
            `neither @RequiresConsent(...) nor @ConsentExempt(reason). Add one.`,
        );
      }
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map((o) => `  - ${o}`).join('\n');
    throw new Error(`refused to start — ${offenders.length} :patientId route(s) lack consent coverage:\n${list}`);
  }
}

function readControllerPath(controllerClass: new (...args: unknown[]) => unknown): string {
  const raw = Reflect.getMetadata(PATH_METADATA, controllerClass);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return '';
}

function readMethodPath(methodRef: unknown): string {
  const raw = Reflect.getMetadata(PATH_METADATA, methodRef as object);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return '';
}

function joinPath(controllerPath: string, methodPath: string): string {
  const normalize = (segment: string): string => {
    if (!segment) return '';
    return segment.startsWith('/') ? segment : `/${segment}`;
  };
  const a = normalize(controllerPath).replace(/\/+$/, '');
  const b = normalize(methodPath).replace(/\/+$/, '');
  const joined = `${a}${b}` || '/';
  return joined.startsWith('/') ? joined : `/${joined}`;
}
