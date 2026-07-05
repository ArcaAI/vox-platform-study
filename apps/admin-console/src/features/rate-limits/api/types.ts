export type RateLimitTier = 'default' | 'strict' | 'heavy' | 'relaxed';

/** Where an effective value came from (DB override vs code vs default). */
export type RateLimitSource = 'db' | 'code' | 'default';

/** GET /admin/rate-limit (RateLimitPolicyResponse). */
export interface RateLimitPolicy {
    enabled: boolean;
    enabledSource: 'db' | 'default';
    tiers: RateLimitTierPolicy[];
    routes: RateLimitRoutePolicy[];
}

export interface RateLimitTierPolicy {
    tier: RateLimitTier;
    limit: number;
    ttl: number;
    limitSource: RateLimitSource;
    ttlSource: RateLimitSource;
}

export interface RateLimitRoutePolicy {
    routeId: string;
    controller: string;
    handler?: string;
    description: string;
    tier: string;
    limit: number;
    ttl: number;
    enabled: boolean;
    limitSource: string;
    ttlSource: string;
}

export interface SetTierOverrideRequest {
    limit?: number;
    ttl?: number;
}

export interface SetRouteOverrideRequest {
    limit?: number;
    ttl?: number;
    enabled?: boolean;
}
