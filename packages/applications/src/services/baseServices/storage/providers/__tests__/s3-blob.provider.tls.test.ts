/**
 * S3BlobProvider — TLS certificate-verification relaxation.
 *
 * Owner ruling (2026-08-30): there is no private CA. MinIO keeps HTTPS on
 * :9000 and authenticates with a service account (access key + secret); the
 * platform therefore has to be able to SKIP certificate verification. This
 * file pins that the escape hatch exists, is opt-in per construction, and is
 * off unless asked for — the env-tier default lives in
 * `minioCertCheckFromEnv`, not here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageProvider } from '@arcaai/types';

// Captured constructor config of the most recently built S3Client.
let capturedConfig: Record<string, unknown> | undefined;

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    constructor(config: Record<string, unknown>) {
      capturedConfig = config;
    }
    send = vi.fn();
  }
  return {
    S3Client: MockS3Client,
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    DeleteObjectCommand: vi.fn(),
    ListObjectsV2Command: vi.fn(),
    CreateBucketCommand: vi.fn(),
    DeleteBucketCommand: vi.fn(),
    HeadBucketCommand: vi.fn(),
    ListBucketsCommand: vi.fn(),
    PutBucketLifecycleConfigurationCommand: vi.fn(),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}));

// The real handler keeps its config private, so mock it and assert on the
// agent it was HANDED — that is the contract this file pins.
vi.mock('@smithy/node-http-handler', () => {
  class MockNodeHttpHandler {
    constructor(public readonly options: { httpsAgent?: { options?: Record<string, unknown> } }) {}
  }
  return { NodeHttpHandler: MockNodeHttpHandler };
});

import { S3BlobProvider } from '../s3-blob.provider';

function build(overrides: Record<string, unknown> = {}): S3BlobProvider {
  return new S3BlobProvider({
    endpoint: 'https://minio.internal:9000',
    region: 'us-east-1',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
    forcePathStyle: true,
    provider: StorageProvider.MINIO,
    ...overrides,
  });
}

/** The `https.Agent` the request handler was built with, if any. */
function agentOf(config: Record<string, unknown> | undefined): { options?: Record<string, unknown> } | undefined {
  const handler = config?.requestHandler as { options?: { httpsAgent?: { options?: Record<string, unknown> } } } | undefined;
  return handler?.options?.httpsAgent;
}

describe('S3BlobProvider TLS verification', () => {
  beforeEach(() => {
    capturedConfig = undefined;
  });

  it('installs no custom request handler when certCheck is not specified', () => {
    build();
    expect(capturedConfig?.requestHandler).toBeUndefined();
  });

  it('installs no custom request handler when certCheck is true', () => {
    build({ certCheck: true });
    expect(capturedConfig?.requestHandler).toBeUndefined();
  });

  it('installs an https agent with rejectUnauthorized:false when certCheck is false', () => {
    build({ certCheck: false });
    expect(capturedConfig?.requestHandler).toBeDefined();
    expect(agentOf(capturedConfig)?.options?.rejectUnauthorized).toBe(false);
  });
});
