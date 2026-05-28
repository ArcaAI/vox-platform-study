/**
 * @TenantOwnedResource decorator — unit tests (TASK-307 W3.1 / AC-7)
 *
 * Pins the Reflector metadata contract used by
 * `TenantOwnedResourceInterceptor` (W3.2). The decorator itself is a thin
 * `SetMetadata` wrapper — these tests document the key + payload shape so
 * the interceptor and the per-controller rollout commits (W3.4..W3.8) can
 * rely on the contract.
 */
import { describe, it, expect } from 'vitest';
import {
  TenantOwnedResource,
  TENANT_OWNED_RESOURCE_KEY,
  type TenantOwnedResourceOptions,
} from '../tenant-owned-resource.decorator';

describe('TASK-307 W3.1 — @TenantOwnedResource decorator', () => {
  it('exports a stable Reflector metadata key string', () => {
    expect(TENANT_OWNED_RESOURCE_KEY).toBe('tenant_owned_resource');
  });

  it('attaches the options payload to the method via Reflect metadata', () => {
    class TestController {
      @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'id' })
      getBucket(): void {
        // marker handler
      }
    }

    const meta = Reflect.getMetadata(
      TENANT_OWNED_RESOURCE_KEY,
      TestController.prototype.getBucket,
    ) as TenantOwnedResourceOptions;

    expect(meta).toEqual({ modelName: 'TenantBucket', paramName: 'id' });
  });

  it('preserves the optional `lookup` field on the metadata payload', () => {
    class StorageLike {
      @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'name', lookup: 'name' })
      getBucketByName(): void {
        // marker handler
      }
    }

    const meta = Reflect.getMetadata(
      TENANT_OWNED_RESOURCE_KEY,
      StorageLike.prototype.getBucketByName,
    ) as TenantOwnedResourceOptions;

    expect(meta).toEqual({ modelName: 'TenantBucket', paramName: 'name', lookup: 'name' });
  });

  // TASK-308 AC-1 — `scope` field carries the intra-tenant ownership opt-in.
  it('preserves the optional `scope` field on the metadata payload', () => {
    class JobLike {
      @TenantOwnedResource({ modelName: 'ConsultationJob', paramName: 'jobId', scope: 'creator' })
      cancelJob(): void {
        // marker handler
      }
    }

    const meta = Reflect.getMetadata(
      TENANT_OWNED_RESOURCE_KEY,
      JobLike.prototype.cancelJob,
    ) as TenantOwnedResourceOptions;

    expect(meta).toEqual({
      modelName: 'ConsultationJob',
      paramName: 'jobId',
      scope: 'creator',
    });
  });

  it('supports each of the four model names enumerated by AC-7', () => {
    class CoverageController {
      @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'id' })
      bucket(): void {}

      @TenantOwnedResource({ modelName: 'UserVoiceProfile', paramName: 'id' })
      voice(): void {}

      @TenantOwnedResource({ modelName: 'ConsultationJob', paramName: 'jobId' })
      consultationJob(): void {}

      @TenantOwnedResource({ modelName: 'TranscriptionJob', paramName: 'id' })
      transcriptionJob(): void {}
    }

    expect(
      Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, CoverageController.prototype.bucket),
    ).toMatchObject({ modelName: 'TenantBucket' });
    expect(
      Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, CoverageController.prototype.voice),
    ).toMatchObject({ modelName: 'UserVoiceProfile' });
    expect(
      Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, CoverageController.prototype.consultationJob),
    ).toMatchObject({ modelName: 'ConsultationJob', paramName: 'jobId' });
    expect(
      Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, CoverageController.prototype.transcriptionJob),
    ).toMatchObject({ modelName: 'TranscriptionJob' });
  });
});
