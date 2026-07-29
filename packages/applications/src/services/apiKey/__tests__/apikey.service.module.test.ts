import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { IApiKeyRateLimiter } from '../apikey-rate-limiter.service';
import { IApiKeyService } from '../IApiKeyService';
import { ApiKeyServiceModule } from '../apikey.service.module';

describe('ApiKeyServiceModule', () => {
  const providers: any[] = Reflect.getMetadata('providers', ApiKeyServiceModule) ?? [];
  const exports: any[] = Reflect.getMetadata('exports', ApiKeyServiceModule) ?? [];

  it('should register IApiKeyRateLimiter provider', () => {
    const rateLimiterProvider = providers.find((p: any) => p?.provide === IApiKeyRateLimiter);
    expect(rateLimiterProvider).toBeDefined();
  });

  it('should export IApiKeyRateLimiter', () => {
    expect(exports).toContain(IApiKeyRateLimiter);
  });

  it('should still register IApiKeyService provider', () => {
    const serviceProvider = providers.find((p: any) => p?.provide === IApiKeyService);
    expect(serviceProvider).toBeDefined();
  });

  it('should still export IApiKeyService', () => {
    expect(exports).toContain(IApiKeyService);
  });
});
