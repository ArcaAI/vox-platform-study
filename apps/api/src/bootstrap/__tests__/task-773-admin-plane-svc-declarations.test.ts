/**
 * TASK-773 — the admin-plane sweep, checked against the REAL controller classes.
 *
 * `service-account-surface-audit.test.ts` proves boot audit H is correct, using
 * synthetic controllers. This file proves the SWEEP is correct, using the
 * shipped ones: it imports every class named by the evidence fixture and reads
 * the `svc:*` declaration back off its Nest metadata.
 *
 * Metadata, not source text, deliberately. A grep for the decorator literal
 * would match a comment, a string in an unrelated array, or a commented-out
 * line; `Reflect.getMetadata` sees exactly what `UnifiedAuthGuard` sees at
 * request time.
 *
 * Boot audit H is the authority here and runs at startup. This test exists so
 * the same property fails in CI — before a deploy — rather than at boot, and so
 * a controller that loses its decorator in a future refactor is caught by the
 * suite that already runs on every merge request.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVICE_ACCOUNT_REQUIRED_SCOPES, toServiceAccountScope } from '@arcaai/applications';
import { TASK_773_ADMIN_SCOPE_MAP } from './fixtures/task-773-admin-scope-map';

/** Repo root, from `apps/api/src/bootstrap/__tests__/`. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

async function loadController(file: string, controllerClass: string): Promise<new (...args: never[]) => unknown> {
  const moduleUrl = pathToFileURL(resolve(REPO_ROOT, file)).href;
  const loaded = (await import(/* @vite-ignore */ moduleUrl)) as Record<string, unknown>;
  const ControllerClass = loaded[controllerClass];
  if (typeof ControllerClass !== 'function') {
    throw new Error(`${file} does not export a class named ${controllerClass}`);
  }
  return ControllerClass as new (...args: never[]) => unknown;
}

describe('TASK-773: every swept admin controller declares its svc:admin:* twin', () => {
  it('the fixture is non-empty (a silently emptied fixture would make every assertion below vacuous)', () => {
    expect(TASK_773_ADMIN_SCOPE_MAP.length).toBeGreaterThan(0);
  });

  it.each(TASK_773_ADMIN_SCOPE_MAP.map((row) => [row.controllerClass, row.file, row.adminScope] as const))(
    '%s declares the twin of %s',
    async (controllerClass, file, adminScope) => {
      const ControllerClass = await loadController(file, controllerClass);
      const declared = Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, ControllerClass) as unknown;

      expect(declared, `${controllerClass} declares no @RequiredSvcScopes — service accounts cannot reach it`).toBeDefined();
      expect(declared).toEqual([toServiceAccountScope(adminScope)]);
    },
  );
});
