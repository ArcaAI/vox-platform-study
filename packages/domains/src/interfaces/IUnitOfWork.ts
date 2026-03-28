import { CoreDatabaseService } from '../common/databaseServices';

export interface IUnitOfWork {
  execute<T>(work: (txn: CoreDatabaseService) => Promise<T>): Promise<T>;
}
