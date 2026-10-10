/**
 * TASK-1059 C-0 / C-1 / OD-5 / OD-9 — the runtime medical judge over CONTEXT, before it is combined
 * with the prompt (`IContextMedicalJudgeService`, the frozen contract beside this file).
 *
 * One call to guardrail `POST /api/medical/validate` with `scope: "context"` and one `trust: "data"`
 * region per uncached item (`key` = the item id). Guardrail packs small regions into shared windows
 * and answers `region_verdicts[{ key, is_medical, context_type, confidence }]`, one per region.
 *
 * Verdict cache (Redis): `ctxjudge:{tenantId}:{policyVersion}:{sha256(text)}`, 24 h. The policy
 * version is the one guardrail reports on the response `stats` (`policy_version` / `policyVersion`)
 * when it does; until it does, {@link CONTEXT_JUDGE_DEFAULT_POLICY_VERSION}. The last version a
 * tenant's judge answered under is remembered so the next lookup reads the same generation.
 *
 * Fail-CLOSED: a transport error, a non-2xx, a timeout, a missing `region_verdicts`, a region with
 * no verdict or a non-boolean `is_medical` is a {@link ContextJudgeUnavailableError} — never "in
 * scope". Nothing from a failed call is cached.
 *
 * OD-9: an off-scope item is EXCLUDED; with a `consultationId`, ONE inbound `guardrail.warning`
 * notice per consultation request names the excluded item ids (never their text). The notice is
 * best-effort: a failed write is logged and never fails the generation.
 */
import { createHash } from 'node:crypto';
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GuardrailNoticeRepository, generateId } from '@arcaai/domains';
import type { GuardrailNotice } from '@arcaai/types';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES, GUARDRAIL_NOTICE_SCHEMA_VERSION } from '@arcaai/types';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common';
import { REQUEST_ID_HEADER } from '../../common/internal-service-headers';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { SecretsService } from '../baseServices/_meta/secrets/SecretsService';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';
import { guardrailNoticeRow } from '../guardrail-notice/guardrail-hold.service';
import {
  ContextJudgeUnavailableError,
  type ContextJudgeItem,
  type ContextJudgeRequest,
  type ContextJudgeResult,
  type ContextJudgeVerdict,
  type IContextMedicalJudgeService,
} from './IContextMedicalJudgeService';

/** 24 h — a verdict is a pure function of (tenant policy, text); the TTL only bounds the cache. */
export const CONTEXT_JUDGE_CACHE_TTL_SECONDS = 86_400;
/**
 * The cache generation used until guardrail reports a policy version on `stats`. Bumping this
 * constant voids every cached context verdict.
 */
export const CONTEXT_JUDGE_DEFAULT_POLICY_VERSION = 'v1';
export const CONTEXT_JUDGE_CACHE_PREFIX = 'ctxjudge:';

/**
 * The gateway now makes the medical call text used to make (OD-10), so it waits as long as text
 * did: `text.externalGuardrail.timeoutS`, which nests above guardrail's own judge timeout plus its
 * admission wait. The fallback is that descriptor's default.
 */
const TIMEOUT_SETTING_KEY = 'text.externalGuardrail.timeoutS';
const DEFAULT_TIMEOUT_SECONDS = 120;

interface CachedVerdict {
  inScope: boolean;
  contextType: string;
  confidence: number;
}

/** guardrail `notice_id_for`: a UUID-formatted id derived from `sha256(tenantId|dedupeKey)` (RFC 9562 v8). */
function noticeIdFor(tenantId: string, dedupeKey: string): string {
  const bytes = createHash('sha256').update(`${tenantId}|${dedupeKey}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

@Injectable()
export class ContextMedicalJudgeService implements IContextMedicalJudgeService {
  private readonly logger = new Logger(ContextMedicalJudgeService.name);
  private readonly guardrailUrl: string;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: Pick<IAppSettingsService, 'getValueWithDefault'>,
    // Unwired ⇒ every item is judged on every call (still correct, only dearer).
    @Optional() @Inject(IRedisCacheService) private readonly cache?: Pick<IRedisCacheService, 'get' | 'setex'>,
    // Unwired ⇒ excluded items are still excluded; no notice row is written.
    @Optional() @Inject(GuardrailNoticeRepository) private readonly notices?: Pick<GuardrailNoticeRepository, 'upsertByDedupeKey'>,
  ) {
    // Bootstrap TRANSPORT address (rule 00): the only sanctioned env default.
    this.guardrailUrl = configService.get<string>('GUARDRAIL_URL') ?? 'http://localhost:8863';
  }

  async judge(request: ContextJudgeRequest): Promise<ContextJudgeResult> {
    const { tenantId, items } = request;
    if (items.length === 0) return { verdicts: [], inScopeIds: [], excludedIds: [], refused: false };

    const digests = items.map((entry) => sha256(entry.text));
    let policyVersion = (await this.cacheRead(this.policyPointerKey(tenantId))) ?? CONTEXT_JUDGE_DEFAULT_POLICY_VERSION;
    const known = new Map<string, CachedVerdict>();
    for (const digest of new Set(digests)) {
      const raw = await this.cacheRead(this.verdictKey(tenantId, policyVersion, digest));
      const verdict = raw ? parseCached(raw) : null;
      if (verdict) known.set(digest, verdict);
    }

    // One region per uncached DIGEST: a text repeated under two ids is judged once.
    const pending = new Map<string, ContextJudgeItem>();
    items.forEach((entry, index) => {
      const digest = digests[index]!;
      if (!known.has(digest) && !pending.has(digest)) pending.set(digest, entry);
    });
    const fresh = new Set<string>();
    if (pending.size > 0) {
      const answered = await this.callJudge(tenantId, [...pending.values()], request.requestId);
      if (answered.policyVersion && answered.policyVersion !== policyVersion) {
        policyVersion = answered.policyVersion;
        await this.cacheWrite(this.policyPointerKey(tenantId), policyVersion);
      }
      for (const [digest, entry] of pending) {
        const verdict = answered.verdicts.get(entry.id)!;
        known.set(digest, verdict);
        fresh.add(digest);
        await this.cacheWrite(this.verdictKey(tenantId, policyVersion, digest), JSON.stringify(verdict));
      }
    }

    const verdicts: ContextJudgeVerdict[] = items.map((entry, index) => {
      const digest = digests[index]!;
      const verdict = known.get(digest)!;
      return { id: entry.id, digest, inScope: verdict.inScope, contextType: verdict.contextType, confidence: verdict.confidence, cached: !fresh.has(digest) };
    });
    const inScopeIds = verdicts.filter((verdict) => verdict.inScope).map((verdict) => verdict.id);
    const excludedIds = verdicts.filter((verdict) => !verdict.inScope).map((verdict) => verdict.id);
    if (excludedIds.length > 0) {
      // Kinds and counts only — never text (PHI).
      const kinds: Record<string, number> = {};
      for (const entry of items) if (excludedIds.includes(entry.id)) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
      this.logger.log({ message: 'context-judge.excluded', tenantId, consultationId: request.consultationId, excluded: kinds, inScope: inScopeIds.length });
      if (request.consultationId) await this.raiseExclusionNotice(tenantId, request.consultationId, excludedIds, policyVersion, request.requestId);
    }
    return { verdicts, inScopeIds, excludedIds, refused: inScopeIds.length === 0 };
  }

  private async callJudge(
    tenantId: string,
    items: readonly ContextJudgeItem[],
    requestId: string | undefined,
  ): Promise<{ verdicts: Map<string, CachedVerdict>; policyVersion: string | null }> {
    const timeoutSeconds = this.appSettings?.getValueWithDefault<number>(TIMEOUT_SETTING_KEY, DEFAULT_TIMEOUT_SECONDS) ?? DEFAULT_TIMEOUT_SECONDS;
    let body: Record<string, unknown> | undefined;
    try {
      const response = await this.httpService.axiosRef.post(
        `${this.guardrailUrl}/api/medical/validate`,
        {
          text: '',
          scope: 'context',
          regions: items.map((entry) => ({ key: entry.id, text: entry.text, trust: 'data' })),
          ...(requestId ? { request_id: requestId } : {}),
        },
        {
          timeout: timeoutSeconds * 1000,
          headers: internalServiceHeaders({
            serviceToken: await resolveInternalAccessToken(this.secretsService, 'GUARDRAIL_SERVICE_TOKEN'),
            tenantId,
            tenantlessReason: TENANTLESS.CONTROL_PLANE,
            ...(requestId ? { extra: { [REQUEST_ID_HEADER]: requestId } } : {}),
          }),
        },
      );
      body = response.data as Record<string, unknown> | undefined;
    } catch (error) {
      // PHI-safe: the error TYPE and status, never the judged text.
      const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
      this.logger.warn({ message: 'context-judge.unavailable', tenantId, status: typeof status === 'number' ? status : undefined, error: error instanceof Error ? error.name : 'unknown' });
      throw new ContextJudgeUnavailableError('context medical judge unavailable', { cause: error });
    }
    const raw = body?.region_verdicts;
    if (!Array.isArray(raw)) throw new ContextJudgeUnavailableError('context medical judge answered without region verdicts');
    const verdicts = new Map<string, CachedVerdict>();
    for (const entry of raw) {
      const { key, is_medical: isMedical, context_type: contextType, confidence } = (entry ?? {}) as Record<string, unknown>;
      if (typeof key !== 'string' || typeof isMedical !== 'boolean') continue;
      verdicts.set(key, {
        inScope: isMedical,
        contextType: typeof contextType === 'string' ? contextType : 'unknown',
        confidence: typeof confidence === 'number' ? confidence : 0,
      });
    }
    const missing = items.filter((entry) => !verdicts.has(entry.id)).length;
    if (missing > 0) {
      this.logger.warn({ message: 'context-judge.undetermined', tenantId, missing, sent: items.length });
      throw new ContextJudgeUnavailableError('context medical judge left a region undetermined');
    }
    const stats = body?.stats as Record<string, unknown> | null | undefined;
    const reported = stats?.policy_version ?? stats?.policyVersion;
    return { verdicts, policyVersion: typeof reported === 'string' && reported.trim() ? reported : null };
  }

  private async raiseExclusionNotice(tenantId: string, consultationId: string, excludedIds: string[], policyVersion: string, requestId: string | undefined): Promise<void> {
    if (!this.notices) return;
    // ONE notice per consultation REQUEST: the dedupe key (and so the id) is the request.
    const noticeId = noticeIdFor(tenantId, `context_scope|${consultationId}|${requestId ?? generateId()}`);
    const notice: GuardrailNotice = {
      schemaVersion: GUARDRAIL_NOTICE_SCHEMA_VERSION,
      noticeId,
      type: 'guardrail.warning',
      direction: 'inbound',
      action: 'warn',
      checks: [{ checkId: 'medical_validation', category: 'not_medical', severity: 'low' }],
      consultationId,
      itemIds: [...excludedIds],
      messageKey: 'guardrail.warning.generic',
      defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
      requiresAcknowledgement: true,
      resumable: false,
      policyVersion,
      occurredAt: new Date().toISOString(),
    };
    try {
      await this.notices.upsertByDedupeKey(guardrailNoticeRow(tenantId, notice));
    } catch (error) {
      this.logger.warn({ message: 'context-judge.notice.failed', tenantId, consultationId, error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  private policyPointerKey(tenantId: string): string {
    return `${CONTEXT_JUDGE_CACHE_PREFIX}${tenantId}:policy`;
  }

  private verdictKey(tenantId: string, policyVersion: string, digest: string): string {
    return `${CONTEXT_JUDGE_CACHE_PREFIX}${tenantId}:${policyVersion}:${digest}`;
  }

  /** A cache outage is a miss, never a failure: the item is judged instead. */
  private async cacheRead(key: string): Promise<string | null> {
    if (!this.cache) return null;
    try {
      return await this.cache.get(key);
    } catch {
      return null;
    }
  }

  private async cacheWrite(key: string, value: string): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.setex(key, CONTEXT_JUDGE_CACHE_TTL_SECONDS, value);
    } catch (error) {
      this.logger.warn({ message: 'context-judge.cache.write_failed', error: error instanceof Error ? error.name : 'unknown' });
    }
  }
}

function parseCached(raw: string): CachedVerdict | null {
  try {
    const value = JSON.parse(raw) as Partial<CachedVerdict>;
    if (typeof value.inScope !== 'boolean') return null;
    return { inScope: value.inScope, contextType: String(value.contextType ?? 'unknown'), confidence: Number(value.confidence ?? 0) };
  } catch {
    return null;
  }
}
