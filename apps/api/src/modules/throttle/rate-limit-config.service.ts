import { Injectable } from '@nestjs/common';

export interface ThrottlerConfig {
    name: string;
    ttl: number;
    limit: number;
}

@Injectable()
export class RateLimitConfigService {
    isEnabled(): boolean {
        return process.env.RATE_LIMIT_ENABLED !== 'false';
    }

    getThrottlers(): ThrottlerConfig[] {
        const defaultLimit = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10);
        const defaultWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

        return [
            { name: 'default', ttl: defaultWindowMs, limit: defaultLimit },
            { name: 'strict', ttl: 60000, limit: 10 },
            { name: 'heavy', ttl: 60000, limit: 20 },
            { name: 'relaxed', ttl: 60000, limit: 300 },
        ];
    }

    getThrottlerModuleConfig(): ThrottlerConfig[] {
        return this.getThrottlers();
    }
}
