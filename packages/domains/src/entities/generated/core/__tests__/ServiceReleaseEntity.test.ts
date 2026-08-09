/**
 * ServiceReleaseEntity + ServiceReleaseFactory unit tests (TASK-648).
 */
import { describe, it, expect } from 'vitest';
import { ServiceReleaseFactory } from '../../../../factories/generated/core/ServiceReleaseFactory';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const baseProps = {
  tenantId: SYSTEM_TENANT_ID,
  serviceName: 'smr',
  releaseVersion: '2.1.0',
  gitBranch: 'dev-2.1',
  gitCommitSha: '0ab258f9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6',
  buildAt: new Date('2026-08-09T11:22:33.000Z'),
};

describe('ServiceReleaseFactory', () => {
  it('generates a UUIDv7 id and applies defaults', () => {
    const release = ServiceReleaseFactory.CreateServiceRelease(baseProps);
    // UUIDv7 — version nibble is 7.
    expect(release.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(release.releaseTag).toBeNull();
    expect(release.imageRepository).toBeNull();
    expect(release.imageDigest).toBeNull();
    expect(release.changelog).toBeNull();
    expect(release.firstSeenAt).toBeInstanceOf(Date);
    expect(release.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('carries the untagged pre-release-shaped version string as-is', () => {
    const release = ServiceReleaseFactory.CreateServiceRelease({
      ...baseProps,
      releaseVersion: '0.0.0-dev-2-1.0ab258f9',
    });
    expect(release.releaseVersion).toBe('0.0.0-dev-2-1.0ab258f9');
    expect(release.releaseTag).toBeNull();
  });

  it('carries a tagged release', () => {
    const release = ServiceReleaseFactory.CreateServiceRelease({
      ...baseProps,
      releaseTag: 'SMR-2.1.0',
    });
    expect(release.releaseTag).toBe('SMR-2.1.0');
  });
});

describe('ServiceReleaseEntity.validate', () => {
  it('passes for a well-formed release', () => {
    const release = ServiceReleaseFactory.CreateServiceRelease(baseProps);
    expect(() => release.validate()).not.toThrow();
  });

  it('rejects a missing tenantId (BaseTenantEntity backstop)', () => {
    const release = ServiceReleaseFactory.CreateServiceRelease({ ...baseProps, tenantId: '' });
    expect(() => release.validate()).toThrow(/tenant/i);
  });

  it('rejects a missing serviceName', () => {
    const release = ServiceReleaseFactory.CreateServiceRelease({ ...baseProps, serviceName: '' });
    expect(() => release.validate()).toThrow(/service name/i);
  });

  it('rejects a missing releaseVersion', () => {
    const release = ServiceReleaseFactory.CreateServiceRelease({ ...baseProps, releaseVersion: '' });
    expect(() => release.validate()).toThrow(/release version/i);
  });

  it('rejects a missing gitCommitSha', () => {
    const release = ServiceReleaseFactory.CreateServiceRelease({ ...baseProps, gitCommitSha: '' });
    expect(() => release.validate()).toThrow(/commit sha/i);
  });

  it('change tracking routes through setProperty', () => {
    const release = ServiceReleaseFactory.CreateServiceRelease(baseProps);
    release.imageDigest = 'sha256:abc123';
    expect(release.hasChanges).toBe(true);
    expect(release.changes).toMatchObject({ imageDigest: 'sha256:abc123' });
  });
});
