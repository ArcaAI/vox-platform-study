/**
 * the gateway reads the platform storage endpoint from TWO seeded rows
 * (`TenantStorageConfig` SYSTEM row and the `S3_ENDPOINT` GlobalSetting) and they must
 * agree with the environment the seed ran in. In-cluster the setting was a hardcoded
 * `http://localhost:<port>`, so `S3Service` dialled nothing and every governed
 * consultation fell back to the default loop with an empty error.
 */
import { describe, expect, it } from 'vitest';

import { platformStorageEndpoint } from '../05c-platform-storage-config';
import { DEFAULT_STT_SETTINGS } from '../06-stt';

describe('platformStorageEndpoint', () => {
  it('falls back to the local-dev MinIO when nothing is declared', () => {
    expect(platformStorageEndpoint({})).toBe('http://localhost:9000');
    expect(platformStorageEndpoint({ MINIO_ENDPOINT: '   ' })).toBe('http://localhost:9000');
  });

  it('derives scheme + host from MINIO_ENDPOINT and MINIO_USE_SSL (the in-cluster shape)', () => {
    expect(platformStorageEndpoint({ MINIO_ENDPOINT: 'hope-minio:9000', MINIO_USE_SSL: 'true' })).toBe('https://hope-minio:9000');
    expect(platformStorageEndpoint({ MINIO_ENDPOINT: 'hope-minio:9000', MINIO_USE_SSL: 'false' })).toBe('http://hope-minio:9000');
    expect(platformStorageEndpoint({ MINIO_ENDPOINT: 'hope-minio:9000' })).toBe('http://hope-minio:9000');
  });

  it('keeps an explicit scheme', () => {
    expect(platformStorageEndpoint({ MINIO_ENDPOINT: 'https://minio.example:443', MINIO_USE_SSL: 'false' })).toBe('https://minio.example:443');
  });

  it('seeds the S3_ENDPOINT GlobalSetting from the same derivation, never a localhost literal', () => {
    const row = DEFAULT_STT_SETTINGS.find((s) => s.key === 'S3_ENDPOINT');
    expect(row).toBeDefined();
    expect(row!.value).toBe(platformStorageEndpoint());
  });
});
