import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { IStorageAccessKeyService } from '../IStorageAccessKeyService';
import { StorageAccessKeyServiceModule } from '../storage-access-key.service.module';

describe('StorageAccessKeyServiceModule (F-4b)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: any[] = Reflect.getMetadata('providers', StorageAccessKeyServiceModule) ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exports: any[] = Reflect.getMetadata('exports', StorageAccessKeyServiceModule) ?? [];

  it('registers the service exactly once via the interface token (no duplicate provider)', () => {
    // F-4b: the module previously listed BOTH `{ provide: IStorageAccessKeyService,
    // useClass: StorageAccessKeyService }` AND the bare `StorageAccessKeyService`,
    // instantiating the service twice. After dedup there is exactly one provider
    // entry, keyed by the interface token.
    expect(providers).toHaveLength(1);
    expect(providers[0]?.provide).toBe(IStorageAccessKeyService);
    expect('useClass' in providers[0]).toBe(true);
  });

  it('exports only the interface token (not the bare class)', () => {
    expect(exports).toHaveLength(1);
    expect(exports[0]).toBe(IStorageAccessKeyService);
  });
});
