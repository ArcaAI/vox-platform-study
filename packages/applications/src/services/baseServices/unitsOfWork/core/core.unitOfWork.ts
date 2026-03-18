import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { CorePrisma, CoreDatabaseService } from '@arcaai/domains';

// Type for database context - either extended client or transaction client
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseContext = any;

@Injectable()
export class CoreUnitOfWorkService {
    private readonly TRANSACTION_CLIENT_KEY = 'coreTransactionClient';
    private transactionClient: CorePrisma.TransactionClient | null = null;

    constructor(
        @Inject('CORE_DATABASE_SERVICE')
        private readonly databaseService: CoreDatabaseService,
        private readonly cls: ClsService
    ) {}

    async startTransaction(): Promise<void> {
        // Use the base client for transactions
        this.transactionClient = await this.databaseService.baseClient.$transaction(
            async (tx) => tx
        );
        this.cls.set(this.TRANSACTION_CLIENT_KEY, this.transactionClient);
    }

    /**
     * Get the database client for repository operations
     * Returns either the transaction client (if in transaction) or the extended Prisma client
     */
    getDatabaseService(): DatabaseContext {
        const txClient = this.cls.get(this.TRANSACTION_CLIENT_KEY);
        if (txClient) {
            return txClient;
        }
        // Return the extended client which has model accessors
        return this.databaseService.client;
    }

    endTransaction(): void {
        this.transactionClient = null;
        this.cls.set(this.TRANSACTION_CLIENT_KEY, null);
    }
}
