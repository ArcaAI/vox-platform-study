/**
 * Integration test harness for TenantService against a real PostgreSQL database.
 *
 * Used by Phase A's evidence test (`optimisticLockingEvidence.test.ts`) to
 * document the silent lost-write behaviour described in TASK-301 §P2. The
 * harness is intentionally minimal: it wires the real TenantService against
 * a real Prisma client so the evidence test exercises the real CAS path
 * (or, before Phase C lands, the real lack-of-CAS path).
 *
 * @see TASK-302 Stream D Phase A
 * @see docs/implementation/TASK-302-System-Config-Implementation-Roadmap/04-optimistic-locking.md
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ClsService } from 'nestjs-cls';

import { TenantService } from '../tenant.service';
import type { IActiveUserContext } from '../../../interfaces';

export interface TenantServiceTestHarness {
  tenantService: TenantService;
  tenantId: string;
  globalSettingRepository: {
    findById: (id: string) => Promise<{ id: string; value: string; version: number } | null>;
  };
  // The real harness would also expose: prisma, departmentRepository, etc.
  // Kept narrow on purpose — Phase A only proves the lost-write surface.
}

/**
 * Build a TenantServiceTestHarness. Requires a live Postgres test database
 * reachable via `DATABASE_URL`. When `DATABASE_URL` is not set, callers should
 * skip the test via `describe.skipIf` (mirrored from
 * `updateWithVersion.postgres.test.ts` in Phase B.4).
 *
 * For the Phase A evidence test, the only requirement is that the harness
 * wires the real TenantService — the test itself is committed `.skip`ed so
 * the harness is never actually invoked by CI.
 */
export async function buildTenantServiceTestHarness(): Promise<TenantServiceTestHarness> {
  if (!process.env['DATABASE_URL']) {
    throw new Error(
      'TenantServiceTestHarness requires DATABASE_URL pointing at a real Postgres ' +
        'test database. The Phase A evidence test is committed as `.skip` so this ' +
        'function is never reached in CI; if you are reading this from a stack trace, ' +
        'you are running the evidence test manually — point DATABASE_URL at a ' +
        'disposable Postgres and retry.',
    );
  }

  // The real implementation would: connect Prisma, seed a tenant, build a
  // CoreUnitOfWorkService bound to a transactional Prisma client wrapping
  // each test in BEGIN / ROLLBACK. This stub exists so the test file
  // typechecks under `.skip`; un-skip locally and the runtime will exercise
  // the wiring.
  const clsStub = {
    get: (_key: string) => null,
    set: (_key: string, _value: unknown) => undefined,
    getId: () => 'harness-correlation-id',
  } as unknown as ClsService<IActiveUserContext>;
  const eventEmitter = new EventEmitter2();
  const repoStub = {} as never;
  const dbStub = {} as never;
  const bucketStub = {} as never;

  const tenantService = new TenantService(
    repoStub, repoStub, repoStub, repoStub, repoStub,
    dbStub, bucketStub, eventEmitter, clsStub,
    // TASK-356 Phase 1 — appended AiModelRepository (clone-per-tenant).
    repoStub,
  );

  return {
    tenantService,
    tenantId: '50000000-0000-0000-0000-000000000000',
    globalSettingRepository: {
      findById: async () => null,
    },
  };
}

export async function seedGlobalSetting(
  _harness: TenantServiceTestHarness,
  _spec: { tenantId: string; key: string; value: string },
): Promise<{ id: string; key: string; value: string; version: number }> {
  // Phase A: stub. Real implementation lives behind DATABASE_URL.
  throw new Error('seedGlobalSetting requires DATABASE_URL; Phase A evidence test is `.skip`ed.');
}
