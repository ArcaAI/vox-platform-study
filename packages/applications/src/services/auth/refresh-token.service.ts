import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';

/**
 * RefreshTokenService (TASK-307 W1.1 — audit 04 §C-1 / C-12 / D-10)
 *
 * Closes the BLOCKER refresh-token forgery finding from the API-gateway
 * audit. The legacy `refresh_<userId>_<ts>_<random>` format was forgeable
 * because the random component was never persisted server-side — the
 * `userId` between the underscores was the only thing the refresh
 * handler trusted.
 *
 * This service replaces that pattern with the RFC 6749 §10.4
 * "refresh-token rotation" pattern used by Auth0 / Okta:
 *
 *   - `issue(...)`    — generate an opaque base64url token, hash it with
 *                       SHA-256, and persist the hash in Redis with
 *                       `{userId, tenantId, jti, family, expiresAt}`.
 *   - `consume(...)`  — single-use: look up the hash, delete the active
 *                       row, write a "consumed" marker, return the
 *                       recorded session attributes.
 *   - `revokeFamily(.)`— delete every member of a refresh-token family
 *                        (used on logout AND on reuse-detection).
 *
 * Family semantics: every login creates a new family id; every refresh
 * threads the same family id through. If a previously-consumed token is
 * ever presented again, the consumed-marker → family revocation kicks in
 * and ALL outstanding tokens in that family are revoked. This is the
 * defence against attackers who exfiltrated a refresh token before the
 * legitimate user rotated it.
 *
 * Wire-format (Redis keys, all TTL-bounded):
 *   refresh-token:<sha256(token)>              → JSON record
 *   refresh-token-family:<family>:<sha256>     → "1" (membership marker)
 *   refresh-token-consumed:<sha256>            → "<family>"
 *
 * TTL is configurable via `REFRESH_TOKEN_TTL_SECONDS` env var; default
 * 7 days (`604800`) per the user-locked decision in
 * `docs/implementation/TASK-307-API-Gateway-Hardening/README.md` §1.5.
 */

export const REFRESH_TOKEN_KEY_PREFIX = 'refresh-token:';
export const REFRESH_TOKEN_FAMILY_KEY_PREFIX = 'refresh-token-family:';
export const REFRESH_TOKEN_CONSUMED_KEY_PREFIX = 'refresh-token-consumed:';

const REFRESH_TOKEN_RAW_BYTES = 48;
const REFRESH_FAMILY_RAW_BYTES = 16;
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MIN_TTL_SECONDS = 1;

export interface IssuedRefreshToken {
    rawToken: string;
    family: string;
    expiresAt: number;
}

export interface ConsumedRefreshToken {
    userId: string;
    tenantId: string;
    jti: string;
    family: string;
}

export interface IssueRefreshTokenInput {
    userId: string;
    tenantId: string;
    jti: string;
    /** Optional — supply to continue an existing family (rotation). */
    family?: string;
}

export interface IRefreshTokenService {
    issue(input: IssueRefreshTokenInput): Promise<IssuedRefreshToken>;
    consume(rawToken: string): Promise<ConsumedRefreshToken>;
    revokeFamily(family: string): Promise<void>;
}

export const IRefreshTokenService = Symbol('IRefreshTokenService');

interface PersistedRecord {
    userId: string;
    tenantId: string;
    jti: string;
    family: string;
    expiresAt: number;
}

@Injectable()
export class RefreshTokenService implements IRefreshTokenService {
    private readonly logger = new Logger(RefreshTokenService.name);
    private readonly ttlSeconds: number;

    constructor(@Inject(IRedisCacheService) private readonly cache: IRedisCacheService) {
        // eslint-disable-next-line turbo/no-undeclared-env-vars
        const rawTtl = process.env.REFRESH_TOKEN_TTL_SECONDS;
        const parsed = rawTtl ? Number(rawTtl) : NaN;
        this.ttlSeconds = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TTL_SECONDS;
    }

    async issue(input: IssueRefreshTokenInput): Promise<IssuedRefreshToken> {
        const rawToken = crypto.randomBytes(REFRESH_TOKEN_RAW_BYTES).toString('base64url');
        const family = input.family ?? crypto.randomBytes(REFRESH_FAMILY_RAW_BYTES).toString('hex');
        const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
        const hash = this.hash(rawToken);

        const record: PersistedRecord = {
            userId: input.userId,
            tenantId: input.tenantId ?? '',
            jti: input.jti,
            family,
            expiresAt,
        };

        await this.cache.setex(this.key(hash), this.ttlSeconds, JSON.stringify(record));
        await this.cache.setex(this.familyMemberKey(family, hash), this.ttlSeconds, '1');

        return { rawToken, family, expiresAt };
    }

    async consume(rawToken: string): Promise<ConsumedRefreshToken> {
        if (!rawToken) {
            throw new UnauthorizedException('Invalid refresh token');
        }

        const hash = this.hash(rawToken);
        const raw = await this.cache.get(this.key(hash));

        if (raw === null) {
            // Either the token is unknown/expired, OR it was consumed earlier
            // and we are now seeing a reuse attempt. The consumed-marker tells
            // them apart and pins the family we need to revoke.
            const reusedFamily = await this.cache.get(this.consumedKey(hash));
            if (reusedFamily) {
                this.logger.warn({
                    message: 'Refresh token reuse detected — revoking entire family (RFC 6749 §10.4)',
                    family: reusedFamily,
                });
                await this.revokeFamily(reusedFamily);
            }
            throw new UnauthorizedException('Invalid refresh token');
        }

        let record: PersistedRecord;
        try {
            record = JSON.parse(raw) as PersistedRecord;
        } catch {
            throw new UnauthorizedException('Invalid refresh token');
        }

        // Atomically (best-effort) flip from "active" → "consumed": drop the
        // active row + the family-member marker, then write a consumed marker
        // bounded by the remaining TTL so a future reuse can be detected.
        await this.cache.del(this.key(hash));
        await this.cache.del(this.familyMemberKey(record.family, hash));
        const remainingTtl = Math.max(MIN_TTL_SECONDS, record.expiresAt - Math.floor(Date.now() / 1000));
        await this.cache.setex(this.consumedKey(hash), remainingTtl, record.family);

        return {
            userId: record.userId,
            tenantId: record.tenantId,
            jti: record.jti,
            family: record.family,
        };
    }

    async revokeFamily(family: string): Promise<void> {
        if (!family) return;

        const memberPrefix = `${REFRESH_TOKEN_FAMILY_KEY_PREFIX}${family}:`;
        const memberKeys = await this.cache.keys(`${memberPrefix}*`);
        if (memberKeys.length === 0) return;

        const tokenKeys: string[] = [];
        for (const memberKey of memberKeys) {
            const hash = memberKey.substring(memberPrefix.length);
            tokenKeys.push(this.key(hash));
        }
        await this.cache.delMany([...memberKeys, ...tokenKeys]);
    }

    private hash(rawToken: string): string {
        return crypto.createHash('sha256').update(rawToken).digest('hex');
    }

    private key(hash: string): string {
        return `${REFRESH_TOKEN_KEY_PREFIX}${hash}`;
    }

    private familyMemberKey(family: string, hash: string): string {
        return `${REFRESH_TOKEN_FAMILY_KEY_PREFIX}${family}:${hash}`;
    }

    private consumedKey(hash: string): string {
        return `${REFRESH_TOKEN_CONSUMED_KEY_PREFIX}${hash}`;
    }
}
