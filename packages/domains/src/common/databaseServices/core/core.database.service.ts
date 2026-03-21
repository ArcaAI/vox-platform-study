import type { ExtendedCorePrismaClient, CorePrismaClient } from '@arcaai/database';
import { getExtendedPrismaClient, getPrismaClient } from '@arcaai/database';
import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit
} from '@nestjs/common';

/**
 * Core Database Service
 *
 * Prisma 7 Implementation:
 * - Uses the shared Prisma client from @arcaai/database package
 * - Soft-delete filtering is handled by the database package's extended client
 * - Implements NestJS lifecycle hooks for connection management
 *
 * Note: Soft-delete filtering is centralized in @arcaai/database/client.ts
 * to avoid code duplication. The extended client automatically filters out
 * DELETED records from findMany, findFirst, count, aggregate, and groupBy operations.
 */
@Injectable()
export class CoreDatabaseService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(CoreDatabaseService.name);
    private prisma: CorePrismaClient;
    private extendedPrisma: ExtendedCorePrismaClient;

    constructor() {
        // Use shared Prisma client instances from @arcaai/database
        // This ensures consistent soft-delete filtering across the application
        this.prisma = getPrismaClient();
        this.extendedPrisma = getExtendedPrismaClient();
        this.logger.log(`${CoreDatabaseService.name} has been created!`);
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
     * Get the base Prisma Client instance (without extensions)
     * Use this when you need to bypass soft-delete filtering, such as:
     * - Querying deleted records for admin purposes
     * - Restoring soft-deleted records
     * - Performing hard deletes
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
        try {
            await this.prisma.$connect();
            this.logger.log('Core Service has been initialized! Core database connected!');
        } catch (error) {
            this.logger.error('Error connecting to Core database', error);
            throw error;
        }
    }

    async onModuleDestroy() {
        await this.prisma.$disconnect();
        this.logger.warn('Core database disconnected! Core Service has been destroyed!');
    }
}
