/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/ban-ts-comment */
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

@Injectable()
export class UnitOfWorkService<T> {
  private readonly TRANSACTION_CLIENT_KEY = 'transactionClient';

  constructor(
    private readonly databaseService: T,
    private readonly cls: ClsService,
  ) {}

  /**
   * Starts a new transaction and sets the transaction context.
   */
  async startTransaction(): Promise<void> {
    // @ts-ignore
    const tx = await (this.databaseService as any).$transaction(async (txClient: any) => txClient);
    this.cls.set(`${this.TRANSACTION_CLIENT_KEY}::${(this.databaseService as any).constructor.name}`, tx);
  }

  /**
   * Gets the active database context, either transaction-aware or default.
   */
  getDatabaseService(): T {
    return this.cls.get(`${this.TRANSACTION_CLIENT_KEY}::${(this.databaseService as any).constructor.name}`) || this.databaseService;
  }

  /**
   * Ends the transaction context.
   */
  endTransaction(): void {
    this.cls.set(`${this.TRANSACTION_CLIENT_KEY}::${(this.databaseService as any).constructor.name}`, null);
  }
}
