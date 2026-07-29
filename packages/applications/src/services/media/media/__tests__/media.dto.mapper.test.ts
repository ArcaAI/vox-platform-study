/**
 * MediaDtoMapper Unit Tests
 *
 * Tests for the MediaDtoMapper that transforms media entities to response DTOs.
 *
 * Testing Strategy:
 * - Use complete mock entities matching real entity structure
 * - Test all field mappings including timestamps
 * - Test edge cases and boundary conditions
 * - Verify mapper handles various file types correctly
 */

import { describe, it, expect } from 'vitest';
import { MediaDtoMapper } from '../media.dto.mapper';
import { FetchResponse } from '../../../../common';

/**
 * Helper to create mock media entity with complete structure.
 * Uses default values that can be overridden for specific test cases.
 * Note: Uses 'in' operator to properly handle null values as explicit overrides.
 */
const createMockMediaEntity = (
  overrides: Partial<{
    id: string;
    tenantId: string;
    name: string;
    uri: string;
    extension: string;
    mimeType: string;
    size: number;
    hash: string;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }> = {},
) => ({
  id: 'id' in overrides ? overrides.id : 'media-id-1',
  tenantId: 'tenantId' in overrides ? overrides.tenantId : 'tenant-1',
  name: 'name' in overrides ? overrides.name : 'test-file.pdf',
  uri: 'uri' in overrides ? overrides.uri : '/uploads/test-file.pdf',
  extension: 'extension' in overrides ? overrides.extension : 'pdf',
  mimeType: 'mimeType' in overrides ? overrides.mimeType : 'application/pdf',
  size: 'size' in overrides ? overrides.size : 1024,
  hash: 'hash' in overrides ? overrides.hash : 'abc123hash',
  createdBy: 'createdBy' in overrides ? overrides.createdBy : 'creator-123',
  createdAt: 'createdAt' in overrides ? overrides.createdAt : new Date('2026-01-29T10:00:00Z'),
  updatedAt: 'updatedAt' in overrides ? overrides.updatedAt : new Date('2026-01-29T10:30:00Z'),
  deletedAt: 'deletedAt' in overrides ? overrides.deletedAt : null,
});

describe('MediaDtoMapper', () => {
  describe('ToResponse', () => {
    it('should map basic media entity to response', () => {
      const entity = createMockMediaEntity();

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.id).toBe('media-id-1');
      expect(result.name).toBe('test-file.pdf');
      expect(result.uri).toBe('/uploads/test-file.pdf');
      expect(result.extension).toBe('pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.size).toBe(1024);
      expect(result.hash).toBe('abc123hash');
    });

    it('should map name correctly', () => {
      const entity = createMockMediaEntity({ name: 'document.docx' });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.name).toBe('document.docx');
    });

    it('should map uri correctly', () => {
      const entity = createMockMediaEntity({
        uri: '/storage/files/2026/01/document.pdf',
      });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.uri).toBe('/storage/files/2026/01/document.pdf');
    });

    it('should map extension correctly', () => {
      const extensions = ['pdf', 'jpg', 'png', 'mp4', 'docx', 'xlsx'];

      extensions.forEach((extension) => {
        const entity = createMockMediaEntity({ extension });
        const result = MediaDtoMapper.ToResponse(entity as any);
        expect(result.extension).toBe(extension);
      });
    });

    it('should map mimeType correctly', () => {
      const mimeTypes = [
        'application/pdf',
        'image/jpeg',
        'image/png',
        'video/mp4',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ];

      mimeTypes.forEach((mimeType) => {
        const entity = createMockMediaEntity({ mimeType });
        const result = MediaDtoMapper.ToResponse(entity as any);
        expect(result.mimeType).toBe(mimeType);
      });
    });

    it('should map size correctly', () => {
      const sizes = [0, 1024, 1048576, 10485760, 104857600];

      sizes.forEach((size) => {
        const entity = createMockMediaEntity({ size });
        const result = MediaDtoMapper.ToResponse(entity as any);
        expect(result.size).toBe(size);
      });
    });

    it('should map hash correctly', () => {
      const entity = createMockMediaEntity({
        hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.hash).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('should handle entity with all fields populated', () => {
      const entity = createMockMediaEntity({
        id: 'media-123',
        name: 'report.pdf',
        uri: '/uploads/reports/report.pdf',
        extension: 'pdf',
        mimeType: 'application/pdf',
        size: 5242880,
        hash: 'md5:d41d8cd98f00b204e9800998ecf8427e',
      });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.id).toBe('media-123');
      expect(result.name).toBe('report.pdf');
      expect(result.uri).toBe('/uploads/reports/report.pdf');
      expect(result.extension).toBe('pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.size).toBe(5242880);
      expect(result.hash).toBe('md5:d41d8cd98f00b204e9800998ecf8427e');
    });
  });

  describe('ToPaginatedResponse', () => {
    it('should map paginated media files correctly', () => {
      const entities = [
        createMockMediaEntity({ id: 'media-1', name: 'file1.pdf' }),
        createMockMediaEntity({ id: 'media-2', name: 'file2.jpg' }),
        createMockMediaEntity({ id: 'media-3', name: 'file3.mp4' }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 3,
        limit: 10,
        page: 1,
      });

      const result = MediaDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(3);
      expect(result.count).toBe(3);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
      expect(result.data[0].id).toBe('media-1');
      expect(result.data[1].id).toBe('media-2');
      expect(result.data[2].id).toBe('media-3');
    });

    it('should handle empty data array', () => {
      const fetchResponse = new FetchResponse({
        data: [] as any[],
        count: 0,
        limit: 10,
        page: 1,
      });

      const result = MediaDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
    });

    it('should preserve pagination metadata', () => {
      const entities = [createMockMediaEntity({ id: 'media-1' })];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 100,
        limit: 25,
        page: 4,
      });

      const result = MediaDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.count).toBe(100);
      expect(result.limit).toBe(25);
      expect(result.page).toBe(4);
    });

    it('should map each entity in the data array', () => {
      const entities = [
        createMockMediaEntity({
          id: 'media-1',
          extension: 'pdf',
          mimeType: 'application/pdf',
        }),
        createMockMediaEntity({
          id: 'media-2',
          extension: 'jpg',
          mimeType: 'image/jpeg',
        }),
        createMockMediaEntity({
          id: 'media-3',
          extension: 'mp4',
          mimeType: 'video/mp4',
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 3,
        limit: 10,
        page: 1,
      });

      const result = MediaDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data[0].extension).toBe('pdf');
      expect(result.data[0].mimeType).toBe('application/pdf');
      expect(result.data[1].extension).toBe('jpg');
      expect(result.data[1].mimeType).toBe('image/jpeg');
      expect(result.data[2].extension).toBe('mp4');
      expect(result.data[2].mimeType).toBe('video/mp4');
    });

    it('should handle large page numbers', () => {
      const entities = [createMockMediaEntity({ id: 'media-1' })];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 1000,
        limit: 10,
        page: 100,
      });

      const result = MediaDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.page).toBe(100);
      expect(result.count).toBe(1000);
    });

    it('should handle different file sizes in paginated results', () => {
      const entities = [
        createMockMediaEntity({ id: 'media-1', size: 1024 }),
        createMockMediaEntity({ id: 'media-2', size: 1048576 }),
        createMockMediaEntity({ id: 'media-3', size: 10485760 }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 3,
        limit: 10,
        page: 1,
      });

      const result = MediaDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data[0].size).toBe(1024);
      expect(result.data[1].size).toBe(1048576);
      expect(result.data[2].size).toBe(10485760);
    });
  });

  describe('ToResponse - timestamp handling', () => {
    it('should map createdAt correctly', () => {
      const createdAt = new Date('2026-01-15T08:30:00Z');
      const entity = createMockMediaEntity({ createdAt });

      const result = MediaDtoMapper.ToResponse(entity as any);

      // Result may be Date or string depending on mapper implementation
      expect(new Date(result.createdAt).toISOString()).toBe(createdAt.toISOString());
    });

    it('should map updatedAt correctly', () => {
      const updatedAt = new Date('2026-01-20T14:45:00Z');
      const entity = createMockMediaEntity({ updatedAt });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(new Date(result.updatedAt).toISOString()).toBe(updatedAt.toISOString());
    });

    it('should handle different timezone dates', () => {
      const utcDate = new Date('2026-06-15T12:00:00Z');
      const entity = createMockMediaEntity({
        createdAt: utcDate,
        updatedAt: utcDate,
      });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(new Date(result.createdAt).toISOString()).toBe('2026-06-15T12:00:00.000Z');
    });
  });

  describe('ToResponse - edge cases', () => {
    it('should handle zero-byte file size', () => {
      const entity = createMockMediaEntity({ size: 0 });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.size).toBe(0);
    });

    it('should handle very large file size', () => {
      const largeSize = 10 * 1024 * 1024 * 1024; // 10GB
      const entity = createMockMediaEntity({ size: largeSize });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.size).toBe(largeSize);
    });

    it('should handle null createdBy', () => {
      const entity = createMockMediaEntity({ createdBy: null });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.createdBy).toBeNull();
    });

    it('should handle createdBy with value', () => {
      const entity = createMockMediaEntity({ createdBy: 'system-user-123' });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.createdBy).toBe('system-user-123');
    });

    it('should handle file names with special characters', () => {
      const entity = createMockMediaEntity({
        name: 'file (1) [copy] - final.pdf',
      });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.name).toBe('file (1) [copy] - final.pdf');
    });

    it('should handle unicode file names', () => {
      const entity = createMockMediaEntity({
        name: '文档_2026.pdf',
      });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.name).toBe('文档_2026.pdf');
    });

    it('should handle URI with query parameters', () => {
      const entity = createMockMediaEntity({
        uri: '/uploads/file.pdf?token=abc123&expires=2026-12-31',
      });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.uri).toBe('/uploads/file.pdf?token=abc123&expires=2026-12-31');
    });

    it('should handle full URL as URI', () => {
      const entity = createMockMediaEntity({
        uri: 'https://storage.example.com/bucket/files/document.pdf',
      });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.uri).toBe('https://storage.example.com/bucket/files/document.pdf');
    });

    it('should handle UUID format IDs', () => {
      const entity = createMockMediaEntity({
        id: '01912345-6789-7abc-def0-123456789abc',
      });

      const result = MediaDtoMapper.ToResponse(entity as any);

      expect(result.id).toBe('01912345-6789-7abc-def0-123456789abc');
    });

    it('should handle various hash formats', () => {
      const hashFormats = [
        'abc123',
        'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'md5:d41d8cd98f00b204e9800998ecf8427e',
        'sha1:da39a3ee5e6b4b0d3255bfef95601890afd80709',
      ];

      hashFormats.forEach((hash) => {
        const entity = createMockMediaEntity({ hash });
        const result = MediaDtoMapper.ToResponse(entity as any);
        expect(result.hash).toBe(hash);
      });
    });
  });

  describe('ToPaginatedResponse - edge cases', () => {
    it('should handle single item in data array', () => {
      const entities = [createMockMediaEntity({ id: 'single-media' })];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 1,
        limit: 10,
        page: 1,
      });

      const result = MediaDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('single-media');
    });

    it('should handle mixed file types in paginated results', () => {
      const entities = [
        createMockMediaEntity({
          id: 'media-1',
          extension: 'pdf',
          mimeType: 'application/pdf',
          size: 1024,
        }),
        createMockMediaEntity({
          id: 'media-2',
          extension: 'jpg',
          mimeType: 'image/jpeg',
          size: 2048,
        }),
        createMockMediaEntity({
          id: 'media-3',
          extension: 'mp4',
          mimeType: 'video/mp4',
          size: 10485760,
        }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 3,
        limit: 10,
        page: 1,
      });

      const result = MediaDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data[0].extension).toBe('pdf');
      expect(result.data[0].mimeType).toBe('application/pdf');
      expect(result.data[1].extension).toBe('jpg');
      expect(result.data[1].mimeType).toBe('image/jpeg');
      expect(result.data[2].extension).toBe('mp4');
      expect(result.data[2].mimeType).toBe('video/mp4');
    });

    it('should preserve order of entities in paginated response', () => {
      const entities = [
        createMockMediaEntity({ id: 'first' }),
        createMockMediaEntity({ id: 'second' }),
        createMockMediaEntity({ id: 'third' }),
        createMockMediaEntity({ id: 'fourth' }),
        createMockMediaEntity({ id: 'fifth' }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 5,
        limit: 10,
        page: 1,
      });

      const result = MediaDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data.map((d) => d.id)).toEqual(['first', 'second', 'third', 'fourth', 'fifth']);
    });

    it('should handle mixed file names in paginated results', () => {
      const entities = [
        createMockMediaEntity({ id: 'media-1', name: 'file-a.pdf' }),
        createMockMediaEntity({ id: 'media-2', name: 'file-b.jpg' }),
        createMockMediaEntity({ id: 'media-3', name: 'file-c.mp4' }),
      ];

      const fetchResponse = new FetchResponse({
        data: entities as any[],
        count: 3,
        limit: 10,
        page: 1,
      });

      const result = MediaDtoMapper.ToPaginatedResponse(fetchResponse);

      expect(result.data[0].name).toBe('file-a.pdf');
      expect(result.data[1].name).toBe('file-b.jpg');
      expect(result.data[2].name).toBe('file-c.mp4');
    });
  });
});
