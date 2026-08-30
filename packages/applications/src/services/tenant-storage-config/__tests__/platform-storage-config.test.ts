/**
 * Platform-default storage tier — pure resolution tests.
 *
 * The cascade this file owns is the LAST two steps of the runtime order
 * `bucket row → tenant default row → SYSTEM default row → env`:
 * the SYSTEM-tenant `TenantStorageConfig` row, then the bootstrap env
 * fallback (AppSettings `S3_*`, then raw `MINIO_*`).
 */

import { describe, expect, it } from 'vitest';
import { StorageProviderType, StorageTopologyType, TenantStorageConfigFactory } from '@arcaai/domains';

import {
  PLATFORM_STORAGE_CREDENTIALS_REF,
  minioCertCheckFromEnv,
  minioEndpointFromEnv,
  normalizeStorageProvider,
  resolvePlatformStorageConfig,
} from '../platform-storage-config';

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

function systemRow(overrides: Record<string, unknown> = {}) {
  return TenantStorageConfigFactory.CreateConfig({
    tenantId: SYSTEM_TENANT,
    bucketId: null,
    provider: StorageProviderType.MINIO,
    topology: StorageTopologyType.SHARED,
    endpoint: 'http://minio.internal:9000',
    region: 'eu-west-1',
    forcePathStyle: true,
    credentialsRef: PLATFORM_STORAGE_CREDENTIALS_REF,
    ...overrides,
  });
}

describe('normalizeStorageProvider', () => {
  it.each([
    ['minio', StorageProviderType.MINIO],
    ['  MinIO ', StorageProviderType.MINIO],
    ['aws_s3', StorageProviderType.AWS_S3],
    ['azure_blob', StorageProviderType.AZURE_BLOB],
  ])('normalizes %s', (raw, expected) => {
    expect(normalizeStorageProvider(raw)).toBe(expected);
  });

  it('returns null for unknown values so the caller can log + default', () => {
    expect(normalizeStorageProvider('gcs')).toBeNull();
    expect(normalizeStorageProvider(undefined)).toBeNull();
  });
});

describe('minioEndpointFromEnv', () => {
  it('builds an http URL from host:port when TLS is off', () => {
    expect(minioEndpointFromEnv({ MINIO_ENDPOINT: 'localhost:9000', MINIO_USE_SSL: 'false' })).toBe('http://localhost:9000');
  });

  it('builds an https URL when MINIO_USE_SSL is true', () => {
    expect(minioEndpointFromEnv({ MINIO_ENDPOINT: 'minio.example.com:9000', MINIO_USE_SSL: 'true' })).toBe('https://minio.example.com:9000');
  });

  it('passes an already-qualified URL through untouched', () => {
    expect(minioEndpointFromEnv({ MINIO_ENDPOINT: 'https://minio.example.com' })).toBe('https://minio.example.com');
  });

  it('returns null when MINIO_ENDPOINT is absent', () => {
    expect(minioEndpointFromEnv({})).toBeNull();
  });
});

describe('minioCertCheckFromEnv', () => {
  // The DEFAULT is the deployed posture, not the safe one: MinIO serves HTTPS
  // on :9000 with a certificate no CA in this platform can validate (owner
  // ruling 2026-08-30 — there is no private CA; MinIO auth is a service
  // account). Defaulting to "verify" would make every object-store call fail
  // closed on day one, so absence means OFF and an operator opts back IN.
  it('defaults to false (certificate verification OFF) when MINIO_CERT_CHECK is unset', () => {
    expect(minioCertCheckFromEnv({})).toBe(false);
  });

  it('is true only for an explicit true value', () => {
    expect(minioCertCheckFromEnv({ MINIO_CERT_CHECK: 'true' })).toBe(true);
    expect(minioCertCheckFromEnv({ MINIO_CERT_CHECK: '  TRUE  ' })).toBe(true);
  });

  it.each(['false', 'FALSE', '', '  ', '1', 'yes'])('treats %o as verification OFF', (raw) => {
    expect(minioCertCheckFromEnv({ MINIO_CERT_CHECK: raw })).toBe(false);
  });
});

describe('resolvePlatformStorageConfig', () => {
  it('prefers the SYSTEM-tenant row over env and reports source=system-row', () => {
    const resolved = resolvePlatformStorageConfig({
      systemRow: systemRow(),
      appSettings: { S3_ENDPOINT: 'http://appsettings:9000', S3_REGION: 'us-east-1' },
      env: { MINIO_ENDPOINT: 'localhost:9000' },
    });

    expect(resolved.source).toBe('system-row');
    expect(resolved.endpoint).toBe('http://minio.internal:9000');
    expect(resolved.region).toBe('eu-west-1');
    expect(resolved.forcePathStyle).toBe(true);
    expect(resolved.credentialsRef).toBe(PLATFORM_STORAGE_CREDENTIALS_REF);
  });

  it('carries the SYSTEM row provider/azure fields through', () => {
    const resolved = resolvePlatformStorageConfig({
      systemRow: systemRow({
        provider: StorageProviderType.AZURE_BLOB,
        accountName: 'hopeblob',
        endpointSuffix: 'core.chinacloudapi.cn',
        containerPrefix: 'hope-',
      }),
      appSettings: {},
      env: {},
    });

    expect(resolved.provider).toBe(StorageProviderType.AZURE_BLOB);
    expect(resolved.accountName).toBe('hopeblob');
    expect(resolved.endpointSuffix).toBe('core.chinacloudapi.cn');
    expect(resolved.containerPrefix).toBe('hope-');
  });

  it('falls back to AppSettings S3_* when the SYSTEM row is absent (source=app-settings)', () => {
    const resolved = resolvePlatformStorageConfig({
      systemRow: null,
      appSettings: { S3_ENDPOINT: 'http://appsettings:9000', S3_REGION: 'ap-south-1', S3_FORCE_PATH_STYLE: false },
      env: { MINIO_ENDPOINT: 'localhost:9000' },
    });

    expect(resolved.source).toBe('app-settings');
    expect(resolved.endpoint).toBe('http://appsettings:9000');
    expect(resolved.region).toBe('ap-south-1');
    expect(resolved.forcePathStyle).toBe(false);
    expect(resolved.credentialsRef).toBeNull();
  });

  it('falls back to raw MINIO_* env when neither the SYSTEM row nor AppSettings has an endpoint (source=env)', () => {
    const resolved = resolvePlatformStorageConfig({
      systemRow: null,
      appSettings: {},
      env: { MINIO_ENDPOINT: 'localhost:9000', MINIO_USE_SSL: 'false' },
    });

    expect(resolved.source).toBe('env');
    expect(resolved.endpoint).toBe('http://localhost:9000');
    expect(resolved.provider).toBe(StorageProviderType.MINIO);
    expect(resolved.region).toBe('us-east-1');
    expect(resolved.forcePathStyle).toBe(true);
  });

  it('reports source=env with an empty endpoint when nothing is configured at all', () => {
    const resolved = resolvePlatformStorageConfig({ systemRow: null, appSettings: {}, env: {} });

    expect(resolved.source).toBe('env');
    expect(resolved.endpoint).toBe('');
  });

  it('honours STORAGE_PROVIDER from AppSettings on the fallback tiers', () => {
    const resolved = resolvePlatformStorageConfig({
      systemRow: null,
      appSettings: { STORAGE_PROVIDER: 'azure_blob', AZURE_STORAGE_ACCOUNT: 'acct' },
      env: {},
    });

    expect(resolved.provider).toBe(StorageProviderType.AZURE_BLOB);
    expect(resolved.accountName).toBe('acct');
  });

  it('ignores a soft-deleted/disabled SYSTEM row is NOT its job — callers pass ENABLED rows only', () => {
    // Guard against accidental behaviour change: a row that IS passed always wins.
    const resolved = resolvePlatformStorageConfig({
      systemRow: systemRow({ endpoint: 'http://only-row:9000' }),
      appSettings: { S3_ENDPOINT: 'http://appsettings:9000' },
      env: {},
    });
    expect(resolved.endpoint).toBe('http://only-row:9000');
  });
});
