import { describe, expect, it, vi } from 'vitest';
import { SttCompatSessionMetadataService } from '../stt-compat-session-metadata.service';

describe('SttCompatSessionMetadataService', () => {
  it('stores normalized language and clears it', async () => {
    const cache = {
      setex: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(' en-US '),
      del: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SttCompatSessionMetadataService(cache as any);

    await service.setLanguage('session-1', ' en-US ');
    expect(cache.setex).toHaveBeenCalledWith('stt-compat-language:session-1', 86400, 'en-US');
    expect(await service.getLanguage('session-1')).toBe('en-US');

    await service.clear('session-1');
    expect(cache.del).toHaveBeenCalledWith('stt-compat-language:session-1');
  });

  it('removes stale language when start request omits it', async () => {
    const cache = {
      setex: vi.fn(),
      get: vi.fn(),
      del: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SttCompatSessionMetadataService(cache as any);

    await service.setLanguage('session-1');

    expect(cache.del).toHaveBeenCalledWith('stt-compat-language:session-1');
  });
});
