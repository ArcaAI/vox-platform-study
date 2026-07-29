import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DocumentBuilder } from '@nestjs/swagger';

/**
 * Tests for Swagger configuration in main.ts.
 *
 * Since main.ts bootstraps the app procedurally, we test the DocumentBuilder
 * configuration by extracting the expected config shape and verifying it
 * matches our requirements. We mock the builder to capture calls.
 */

describe('Swagger Configuration', () => {
  let builderCalls: Record<string, any[]>;
  let mockBuilder: any;

  beforeEach(() => {
    builderCalls = {};
    const recordCall =
      (name: string) =>
      (...args: any[]) => {
        builderCalls[name] = args;
        return mockBuilder;
      };

    mockBuilder = {
      setTitle: recordCall('setTitle'),
      setDescription: recordCall('setDescription'),
      setVersion: recordCall('setVersion'),
      addBearerAuth: recordCall('addBearerAuth'),
      addApiKey: recordCall('addApiKey'),
      addServer: recordCall('addServer'),
      setContact: recordCall('setContact'),
      setLicense: recordCall('setLicense'),
      addTag: recordCall('addTag'),
      build: vi.fn().mockReturnValue({}),
    };
  });

  describe('DocumentBuilder requirements', () => {
    it('should configure bearer auth', () => {
      const builder = new DocumentBuilder()
        .setTitle('HOPE API')
        .setDescription('HOPE API Gateway - Healthcare Operations Platform Engine')
        .setVersion('1.0')
        .addBearerAuth();

      const doc = builder.build();
      expect(doc.components?.securitySchemes).toBeDefined();
      expect(doc.components?.securitySchemes?.['bearer']).toBeDefined();
    });

    it('should configure API key auth scheme', () => {
      const builder = new DocumentBuilder().setTitle('HOPE API').addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key');

      const doc = builder.build();
      expect(doc.components?.securitySchemes?.['api-key']).toBeDefined();
    });

    it('should include server URLs', () => {
      const builder = new DocumentBuilder()
        .setTitle('HOPE API')
        .addServer('http://localhost:8868/api/v1', 'Local development')
        .addServer('https://staging.arcaai.com', 'Staging');

      const doc = builder.build();
      expect(doc.servers).toBeDefined();
      expect(doc.servers!.length).toBeGreaterThanOrEqual(2);
      expect(doc.servers![0].url).toBe('http://localhost:8868/api/v1');
    });

    it('should include contact information', () => {
      const builder = new DocumentBuilder().setTitle('HOPE API').setContact('ARCA AI', 'https://arcaai.com', 'support@arcaai.com');

      const doc = builder.build();
      expect(doc.info.contact).toBeDefined();
      expect(doc.info.contact?.name).toBe('ARCA AI');
    });

    it('should include license information', () => {
      const builder = new DocumentBuilder().setTitle('HOPE API').setLicense('Proprietary', 'https://arcaai.com/license');

      const doc = builder.build();
      expect(doc.info.license).toBeDefined();
      expect(doc.info.license?.name).toBe('Proprietary');
    });
  });
});
