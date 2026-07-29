import { IRedisCacheService } from '@arcaai/applications';
import { Inject, Injectable } from '@nestjs/common';
import { STREAM_SESSION_TENANT_DEFAULT_TTL_SECONDS } from '../../common';

const LANGUAGE_KEY_PREFIX = 'stt-compat-language:';

@Injectable()
export class SttCompatSessionMetadataService {
  constructor(@Inject(IRedisCacheService) private readonly cache: IRedisCacheService) {}

  async setLanguage(sessionId: string, language?: string | null): Promise<void> {
    if (!sessionId.trim()) {
      return;
    }

    const normalized = typeof language === 'string' ? language.trim() : '';
    if (!normalized) {
      await this.cache.del(this.key(sessionId));
      return;
    }

    await this.cache.setex(this.key(sessionId), STREAM_SESSION_TENANT_DEFAULT_TTL_SECONDS, normalized);
  }

  async getLanguage(sessionId: string): Promise<string | null> {
    if (!sessionId.trim()) {
      return null;
    }

    const language = await this.cache.get(this.key(sessionId));
    return typeof language === 'string' && language.trim().length > 0 ? language.trim() : null;
  }

  async clear(sessionId: string): Promise<void> {
    if (!sessionId.trim()) {
      return;
    }

    await this.cache.del(this.key(sessionId));
  }

  private key(sessionId: string): string {
    return `${LANGUAGE_KEY_PREFIX}${sessionId}`;
  }
}
