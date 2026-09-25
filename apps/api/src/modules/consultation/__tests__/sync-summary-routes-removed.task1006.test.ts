import { describe, it, expect } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConsultationController } from '../consultation.controller';

/**
 * TASK-1006 (owner decision OD-2) — the SYNCHRONOUS summary plane is removed, not shimmed:
 * `POST consultations/:id/summary` and `POST consultations/:id/summary/pre-summary` generated a
 * note by calling TEXT directly, bypassing the tenant's agents and workflows. A note is produced
 * by the async/workflow plane only, so both paths answer 404 now.
 *
 * Read off the controller's route metadata (what Nest mounts), not its source text, so a re-add
 * under any method name — or through `@ApiEndpoint` or a bare `@Post` — fails this suite.
 */

interface DeclaredRoute {
  handler: string;
  method: RequestMethod;
  path: string;
}

function declaredRoutes(): DeclaredRoute[] {
  const proto = ConsultationController.prototype as unknown as Record<string, unknown>;
  const routes: DeclaredRoute[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const handler = proto[name];
    if (typeof handler !== 'function') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof path !== 'string' || typeof method !== 'number') continue;
    routes.push({ handler: name, method: method as RequestMethod, path });
  }
  return routes;
}

function isDeclared(method: RequestMethod, path: string): boolean {
  return declaredRoutes().some((route) => route.method === method && route.path === path);
}

describe('synchronous summary plane removed (TASK-1006 OD-2)', () => {
  it('reads real route metadata off the controller (guards against a vacuous pass)', () => {
    expect(declaredRoutes().length).toBeGreaterThan(20);
  });

  it.each([':id/summary', ':id/summary/pre-summary'])('declares no POST %s', (path) => {
    const offenders = declaredRoutes().filter((route) => route.method === RequestMethod.POST && route.path === path);
    expect(offenders.map((route) => route.handler)).toEqual([]);
  });

  it('keeps the async/workflow siblings and the note read/write routes', () => {
    expect(isDeclared(RequestMethod.POST, ':id/summary/async')).toBe(true);
    expect(isDeclared(RequestMethod.POST, ':id/summary/pre-summary/async')).toBe(true);
    expect(isDeclared(RequestMethod.GET, ':id/summary')).toBe(true);
    expect(isDeclared(RequestMethod.GET, ':id/summary/latest')).toBe(true);
    expect(isDeclared(RequestMethod.GET, ':id/summary/pre-summary/latest')).toBe(true);
    expect(isDeclared(RequestMethod.PATCH, ':id/summary/:summaryId')).toBe(true);
    expect(isDeclared(RequestMethod.POST, ':id/summary/:contextItemId/approve')).toBe(true);
  });

  it('no longer carries the generateSummary / generatePreSummary handlers', () => {
    const proto = ConsultationController.prototype as unknown as Record<string, unknown>;
    expect(proto.generateSummary).toBeUndefined();
    expect(proto.generatePreSummary).toBeUndefined();
  });
});
