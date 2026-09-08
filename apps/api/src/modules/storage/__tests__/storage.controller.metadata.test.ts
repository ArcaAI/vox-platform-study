/**
 * StorageController must carry `@TenantOwnedResource` with
 * `lookup: 'name'` on every handler that addresses a bucket by name.
 *
 * Before this
 * change, `getBucket`/`deleteBucket`/`updateBucket`/`listFiles`/`uploadFile`/
 * `getFileInfo`/`deleteFile` accepted any free-form S3 bucket name guarded
 * only by a path-traversal regex; a tenant-A user with `delete:Storage`
 * could enumerate and delete tenant-B buckets.
 *
 * The W3.2 interceptor + `findByName` resolver yields 404 ("Resource not
 * found") whenever the looked-up `TenantBucket.tenantId !== cls.tenantId`.
 * Handlers that do NOT accept a `:name` param (`listBuckets`,
 * `createBucket`, `checkHealth`) are not decorated.
 */
import { describe, it, expect } from 'vitest';
import { StorageController } from '../storage.controller';
import { TENANT_OWNED_RESOURCE_KEY, type TenantOwnedResourceOptions } from '../../../common/tenant-owned-resource.decorator';

describe('@TenantOwnedResource metadata on StorageController', () => {
  const meta = (m: keyof StorageController): TenantOwnedResourceOptions | undefined =>
    Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, StorageController.prototype[m] as object) as TenantOwnedResourceOptions | undefined;

  const expected = { modelName: 'TenantBucket', paramName: 'name', lookup: 'name' };

  it.each([
    ['getBucket'] as const,
    ['deleteBucket'] as const,
    ['updateBucket'] as const,
    ['uploadFile'] as const,
    ['getFileInfo'] as const,
    ['deleteFile'] as const,
  ])('handler %s is annotated with lookup=name', (handler) => {
    expect(meta(handler)).toEqual(expected);
  });

  // TASK-932 Lane T: `listFiles` additionally carries `scope: 'super-admin'`
  // so the storage browser's "All tenants" view (an unscoped platform admin)
  // can list files in any registered bucket by name — see storage.controller.ts.
  it('handler listFiles is annotated with lookup=name AND scope=super-admin', () => {
    expect(meta('listFiles')).toEqual({ ...expected, scope: 'super-admin' });
  });

  it.each([['listBuckets'] as const, ['createBucket'] as const, ['checkHealth'] as const])(
    'handler %s is NOT annotated (no :name route param)',
    (handler) => {
      expect(meta(handler)).toBeUndefined();
    },
  );
});
