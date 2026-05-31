import { describe, it, expect } from 'vitest';
import 'reflect-metadata';

import { TenantStorageConfigEntity } from '../entities/generated/core/TenantStorageConfigEntity';
import { TenantStorageConfigFactory } from '../factories/generated/core/TenantStorageConfigFactory';
import { StorageProviderType, StorageTopologyType } from '../enums';

describe('TenantStorageConfig Domain Layer', () => {
  describe('TenantStorageConfigEntity', () => {
    it('treats a null bucketId as the tenant-wide default', () => {
      const entity = new TenantStorageConfigEntity({
        id: 'cfg-1',
        tenantId: 'tenant-1',
        bucketId: null,
        provider: StorageProviderType.MINIO,
        topology: StorageTopologyType.SHARED,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(entity.isTenantDefault).toBe(true);
      expect(entity.isShared).toBe(true);
    });

    it('treats a set bucketId as a per-bucket override', () => {
      const entity = new TenantStorageConfigEntity({
        id: 'cfg-2',
        tenantId: 'tenant-1',
        bucketId: 'bucket-9',
        provider: StorageProviderType.AWS_S3,
        topology: StorageTopologyType.DEDICATED,
        credentialsRef: 'secrets/tenant-1/s3',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(entity.isTenantDefault).toBe(false);
    });

    it('requires credentialsRef when topology is DEDICATED', () => {
      const entity = new TenantStorageConfigEntity({
        id: 'cfg-3',
        tenantId: 'tenant-1',
        provider: StorageProviderType.AZURE_BLOB,
        topology: StorageTopologyType.DEDICATED,
        credentialsRef: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(() => entity.validate()).toThrow(/credentialsRef is required/);
    });

    it('does not require credentialsRef for a SHARED config', () => {
      const entity = new TenantStorageConfigEntity({
        id: 'cfg-4',
        tenantId: 'tenant-1',
        provider: StorageProviderType.MINIO,
        topology: StorageTopologyType.SHARED,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(() => entity.validate()).not.toThrow();
    });

    it('tracks field changes via setProperty', () => {
      const entity = new TenantStorageConfigEntity({
        id: 'cfg-5',
        tenantId: 'tenant-1',
        provider: StorageProviderType.MINIO,
        topology: StorageTopologyType.SHARED,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      entity.topology = StorageTopologyType.DEDICATED;
      entity.credentialsRef = 'secrets/tenant-1/azure';

      expect(entity.topology).toBe(StorageTopologyType.DEDICATED);
      expect(entity.credentialsRef).toBe('secrets/tenant-1/azure');
      expect(entity.hasChanges).toBe(true);
    });
  });

  describe('TenantStorageConfigFactory', () => {
    it('defaults topology to SHARED and bucketId to null (tenant default)', () => {
      const entity = TenantStorageConfigFactory.CreateConfig({
        tenantId: 'tenant-1',
        provider: StorageProviderType.MINIO,
      });

      expect(entity.id).toBeTruthy();
      expect(entity.tenantId).toBe('tenant-1');
      expect(entity.provider).toBe(StorageProviderType.MINIO);
      expect(entity.topology).toBe(StorageTopologyType.SHARED);
      expect(entity.isTenantDefault).toBe(true);
    });

    it('carries dedicated provider settings + credentialsRef', () => {
      const entity = TenantStorageConfigFactory.CreateConfig({
        tenantId: 'tenant-2',
        provider: StorageProviderType.AWS_S3,
        topology: StorageTopologyType.DEDICATED,
        bucketId: 'bucket-1',
        endpoint: 'https://s3.example.com',
        region: 'ap-southeast-1',
        forcePathStyle: true,
        credentialsRef: 'secrets/tenant-2/s3',
        createdBy: 'admin-1',
      });

      expect(entity.topology).toBe(StorageTopologyType.DEDICATED);
      expect(entity.bucketId).toBe('bucket-1');
      expect(entity.region).toBe('ap-southeast-1');
      expect(entity.forcePathStyle).toBe(true);
      expect(entity.credentialsRef).toBe('secrets/tenant-2/s3');
      expect(() => entity.validate()).not.toThrow();
    });
  });
});
