/**
 * TenantStorageConfigEntity — `publicEndpoint` invariants (TASK-984).
 *
 * `publicEndpoint` is the origin presigned URLs are signed for. SigV4 covers
 * the path and an S3 API cannot be mounted under a sub-path, so only a bare
 * origin (`scheme://host[:port]`) can ever verify. Azure SAS URLs are already
 * public, so the field means nothing on an AZURE_BLOB row.
 */

import { describe, expect, it } from 'vitest';
import { StorageProviderType, StorageTopologyType } from '../../enums';
import { TenantStorageConfigFactory } from '../../factories/generated/core/TenantStorageConfigFactory';

function makeConfig(publicEndpoint: string | null, provider: StorageProviderType = StorageProviderType.MINIO) {
  return TenantStorageConfigFactory.CreateConfig({
    tenantId: '00000000-0000-0000-0000-000000000000',
    provider,
    topology: StorageTopologyType.SHARED,
    endpoint: 'https://hope-minio:9000',
    publicEndpoint,
  });
}

describe('TenantStorageConfigEntity.publicEndpoint', () => {
  it('is carried by the factory and readable', () => {
    expect(makeConfig('https://admin.example.com').publicEndpoint).toBe('https://admin.example.com');
    expect(makeConfig(null).publicEndpoint).toBeNull();
  });

  it.each(['https://admin.example.com', 'http://127.0.0.1:9000', 'https://files.example.com:8443'])('accepts the origin %s', (origin) => {
    expect(() => makeConfig(origin).validate()).not.toThrow();
  });

  it('accepts an unset value', () => {
    expect(() => makeConfig(null).validate()).not.toThrow();
  });

  it.each([
    ['a path', 'https://admin.example.com/s3'],
    ['a trailing slash', 'https://admin.example.com/'],
    ['a query', 'https://admin.example.com?x=1'],
    ['a fragment', 'https://admin.example.com#x'],
    ['credentials', 'https://user:pass@admin.example.com'],
    ['a non-http scheme', 'ftp://admin.example.com'],
    ['a bare host', 'admin.example.com'],
  ])('rejects %s', (_label, value) => {
    expect(() => makeConfig(value).validate()).toThrow(/publicEndpoint/);
  });

  it('rejects any value on an AZURE_BLOB row', () => {
    const config = makeConfig('https://admin.example.com', StorageProviderType.AZURE_BLOB);
    expect(() => config.validate()).toThrow(/publicEndpoint/);
  });

  it('records a change through the tracked setter', () => {
    const config = makeConfig(null);
    config.publicEndpoint = 'https://admin.example.com';
    expect(config.hasChanges).toBe(true);
    expect(config.publicEndpoint).toBe('https://admin.example.com');
  });
});
