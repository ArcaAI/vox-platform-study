import type { ExtendedCorePrismaClient, CorePrismaClient } from '@arcaai/database';
// eslint-disable-next-line no-restricted-imports -- this is the legitimate base-client owner; consumers should default to .client (extended).
import { getExtendedPrismaClient, getPlatformAdminPrismaClient_Unscoped } from '@arcaai/database';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

/**
 * DI token for the optional
 * Vault-backed PrismaClient factory.
 *
 * When this token is bound (in `apps/api/app.module.ts` under the
 * `PG_DYNAMIC_CREDS=true && SECRETS_PROVIDER=vault` toggle), the
 * CoreDatabaseService delegates Prisma construction + disconnect to the
 * factory, bypassing the env-driven singletons in `@arcaai/database`.
 *
 * The factory is expressed as a function — not a class instance —
 * because:
 *   1. It keeps `packages/domains` free of any `packages/applications`
 *      import (no SecretsService leakage into the domain layer).
 *   2. The factory is allowed to perform async I/O (Vault round-trip)
 *      during NestJS `onModuleInit`, which is the natural integration
 *      point.
 *   3. The disconnect callback lets the wrapper class (VaultPrismaClient
 *      in `@arcaai/database`) own its own teardown semantics — the
 *      domain layer simply asks it to clean up at module destroy.
 */
export const VAULT_PRISMA_FACTORY = Symbol.for('CoreDatabaseService.VaultPrismaFactory');

/**
 * Shape returned by the Vault prisma factory.
 *
 *   client          base Prisma client (used by .baseClient getter).
 *   extendedClient  same client with soft-delete extension applied.
 *   disconnect      drains the Vault-backed pool; called once on
 *                   onModuleDestroy. The factory owns this lifecycle
 *                   because the underlying VaultPrismaClient may
 *                   batch its disconnect with a grace period.
 */
export interface VaultPrismaFactoryResult {
  client: CorePrismaClient;
  extendedClient: ExtendedCorePrismaClient;
  disconnect: () => Promise<void>;
}

export type VaultPrismaFactory = () => Promise<VaultPrismaFactoryResult>;

/**
 * Core Database Service
 *
 * Prisma 7 Implementation:
 * - Uses the shared Prisma client from @arcaai/database package by
 *   default (env-mode operation).
 * - When the optional `VAULT_PRISMA_FACTORY` token is wired, defers
 *   to that factory in `onModuleInit` to obtain a Vault-backed
 *   PrismaClient with short-lived dynamic PostgreSQL credentials.
 * - Soft-delete filtering is handled by the database package's
 *   extended client (or by the factory in Vault mode).
 * - Implements NestJS lifecycle hooks for connection management.
 *
 * Note: Soft-delete filtering is centralised in @arcaai/database/client.ts
 * to avoid code duplication. The extended client automatically filters out
 * DELETED records from findMany, findFirst, count, aggregate, and groupBy
 * operations.
 */
@Injectable()
export class CoreDatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoreDatabaseService.name);
  private prisma!: CorePrismaClient;
  private extendedPrisma!: ExtendedCorePrismaClient;
  private vaultDisconnect: (() => Promise<void>) | null = null;
  private readonly useVault: boolean;
  // Memoizes the (possibly async, Vault-backed) client
  // resolution so it runs exactly once whether invoked by the async DI
  // provider (core.database.module.ts) or the NestJS onModuleInit hook.
  private _initPromise: Promise<void> | null = null;

  constructor(
    @Optional()
    @Inject(VAULT_PRISMA_FACTORY)
    private readonly vaultFactory?: VaultPrismaFactory,
  ) {
    this.useVault = typeof vaultFactory === 'function';
    if (!this.useVault) {
      // Env-mode: eagerly resolve the shared singletons so synchronous
      // getters (`.client`, `.baseClient`) are usable before
      // `onModuleInit` runs (existing behavior the test suite relies on).
      this.prisma = getPlatformAdminPrismaClient_Unscoped();
      this.extendedPrisma = getExtendedPrismaClient();
    }
    this.logger.log(`${CoreDatabaseService.name} has been created! (mode=${this.useVault ? 'vault' : 'env'})`);
  }

  /**
   * Get the extended Prisma Client instance
   * Use this for all database operations to ensure soft-delete filtering
   *
   * Soft-delete filtering is automatically applied to:
   * - findMany: Excludes DELETED records
   * - findFirst: Excludes DELETED records
   * - count: Excludes DELETED records
   * - aggregate: Excludes DELETED records
   * - groupBy: Excludes DELETED records
   *
   * Note: findUnique does NOT filter soft-deleted records due to Prisma limitations.
   * Use findFirst with the unique fields if you need soft-delete filtering.
   */
  get client(): ExtendedCorePrismaClient {
    return this.extendedPrisma;
  }

  /**
   * Get the base Prisma Client instance (without extensions).
   *
   * ⚠️ This client BYPASSES both the soft-delete and
   * the tenant-scope `$extends`. Prefer `.client` for routine queries.
   * Use `baseClient` only for legitimate platform-admin paths:
   *   - Querying or restoring soft-deleted records
   *   - Performing hard deletes
   *   - Cross-tenant maintenance tooling
   *
   * Consumers reaching for `baseClient` should leave a JSDoc note that
   * justifies why tenant-scope is being bypassed; reviewers should
   * scrutinise every new call site for B.4-class violations.
   */
  get baseClient(): CorePrismaClient {
    return this.prisma;
  }

  /**
   * Execute raw SQL query (unsafe - use with caution)
   * @deprecated Prefer queryRaw for parameterized queries
   */
  async query(query: string) {
    return await this.prisma.$queryRawUnsafe(query);
  }

  /**
   * Execute parameterized raw SQL query (safer)
   */
  async queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    return await this.prisma.$queryRaw<T>(query, ...values);
  }

  async onModuleInit() {
    await this.ensureInitialized();
  }

  /**
   * Resolve the active Prisma client exactly once (memoized).
   *
   * In Vault mode the client is produced by an async factory
   * (a Vault round-trip), so it is NOT available at construction time the
   * way the env-mode singletons are. The async DI provider in
   * core.database.module.ts awaits this BEFORE the service is injected
   * anywhere, restoring the env-mode invariant that `client`/`baseClient`
   * are usable by the time any consumer (repositories, AppSettingsService,
   * …) touches the database — including from their own constructors and
   * onModuleInit hooks. NestJS also invokes onModuleInit on the instance;
   * the memoization makes that second call a no-op.
   */
  ensureInitialized(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = this.initialize();
    }
    return this._initPromise;
  }

  private async initialize(): Promise<void> {
    if (this.useVault && this.vaultFactory) {
      try {
        const result = await this.vaultFactory();
        this.prisma = result.client;
        this.extendedPrisma = result.extendedClient;
        this.vaultDisconnect = result.disconnect;
        this.logger.log('Core Service has been initialized via Vault factory! Core database connected!');
      } catch (error) {
        this.logger.error('Error initialising Vault-backed Prisma client', error);
        throw error;
      }
      return;
    }
    try {
      await this.prisma.$connect();
      this.logger.log('Core Service has been initialized! Core database connected!');
    } catch (error) {
      this.logger.error('Error connecting to Core database', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    if (this.useVault && this.vaultDisconnect) {
      // The Vault factory owns its own disconnect cadence (grace
      // period, lease revoke, pool drain) — delegate fully.
      await this.vaultDisconnect();
      this.logger.warn('Core database disconnected via Vault factory! Core Service has been destroyed!');
      return;
    }
    await this.prisma.$disconnect();
    this.logger.warn('Core database disconnected! Core Service has been destroyed!');
  }
}
