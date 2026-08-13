/**
 * parseStorageUri — shared util collapsing the two
 * formerly-duplicated private copies in `context.service.ts` and
 * `smr-proxy.controller.ts` (`extractAttachmentText`). Behavior must be
 * IDENTICAL to both former call sites: parse the canonical `s3://<bucket>/<key>`
 * form written by `StorageController.uploadFile`, `null` for anything else.
 */
import { describe, it, expect } from 'vitest';
import { parseStorageUri } from '../storage-uri';

describe('parseStorageUri', () => {
  it('parses a canonical s3://<bucket>/<key> uri', () => {
    expect(parseStorageUri('s3://attachments/lab-scan.pdf')).toEqual({ bucket: 'attachments', key: 'lab-scan.pdf' });
  });

  it('treats everything after the first / as the key, including nested paths', () => {
    expect(parseStorageUri('s3://attachments/tenant-1/consult-1/raw-capture.webm')).toEqual({
      bucket: 'attachments',
      key: 'tenant-1/consult-1/raw-capture.webm',
    });
  });

  // Mirrors both former call sites: context.service.ts accepted `string | null | undefined`,
  // smr-proxy.controller.ts's copy defaulted `uri ?? ''` before matching — same net effect.
  it('returns null for null/undefined', () => {
    expect(parseStorageUri(null)).toBeNull();
    expect(parseStorageUri(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseStorageUri('')).toBeNull();
  });

  it('returns null for a non-s3 scheme (e.g. a legacy absolute URL)', () => {
    expect(parseStorageUri('https://example.com/file.pdf')).toBeNull();
  });

  it('returns null when there is no key segment after the bucket', () => {
    expect(parseStorageUri('s3://attachments')).toBeNull();
    expect(parseStorageUri('s3://attachments/')).toBeNull();
  });
});
