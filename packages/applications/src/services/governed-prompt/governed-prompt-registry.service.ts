/**
 * TASK-1047 FC-3 — the governed-prompt registry.
 *
 * Authoring time (PromptTemplate approve, agent publish, promote-to-system, the boot backfill):
 * every static prompt piece is screened ONCE by guardrail — prompt safety, jailbreak/injection, PII —
 * and its verdict recorded against `sha256(text)` under guardrail's policy version. Call time: a
 * system message is governed iff every piece digest is PASS under the CURRENT policy version.
 *
 * Fail-closed throughout (OD-4): a guardrail that cannot answer, a check that could not run, or an
 * unknown policy version yields `PROMPT_SCREENING_UNAVAILABLE` and registers nothing, so a piece is
 * never governed without a verdict. No text is stored or logged — digests, codes and check names.
 */
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  GovernedPromptPieceKind,
  GovernedPromptPieceRepository,
  GovernedPromptSourceType,
  GovernedPromptVerdict,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import type { JsonValue } from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { pieceDigest, piecesFromResolvedPrompt, templateBodyPieces } from './governed-pieces';
import { GuardrailPromptScreenClient, PromptScreeningUnavailableError, type PromptScreenOutcome } from './guardrail-prompt-screen.client';
import type {
  GovernedPieceFinding,
  GovernedPieceInput,
  GovernedPromptSourceKind,
  GovernedScreeningResult,
  IGovernedPromptRegistry,
} from './IGovernedPromptRegistry';

/** FC-3 — how long the guardrail policy version is trusted before it is re-read. */
const POLICY_VERSION_TTL_MS = 60_000;
/** An unknown policy version is re-asked sooner, so a guardrail that comes back is noticed. */
const POLICY_VERSION_NEGATIVE_TTL_MS = 5_000;
/** FC-3 — the call-time verdict cache: `(tenant, digest, policyVersion)`, TTL 300 s. */
const VERDICT_TTL_MS = 300_000;
const VERDICT_CACHE_MAX = 10_000;
/** Region keys are a digest prefix: unique per distinct text in practice, and never text. */
const REGION_KEY_CHARS = 16;
/** The boot backfill's bounded concurrency (sources in flight at once). */
const BACKFILL_CONCURRENCY = 2;
/** Backfill retry backoff (code defaults; `governedPrompt.backfillRetry{Min,Max}Ms` override them). */
const DEFAULT_BACKFILL_RETRY_MIN_MS = 30_000;
const DEFAULT_BACKFILL_RETRY_MAX_MS = 900_000;
/** The check guardrail names an injection/jailbreak verdict by (`INBOUND_TASKS`). */
const INJECTION_CHECK = 'jailbreak_detection';

type FindingCode = GovernedPieceFinding['code'];

/** One code a screen produced for a piece, with the guardrail checks behind it (names only). */
interface PieceCode {
  readonly code: FindingCode;
  readonly checks: readonly string[];
}

interface DistinctPiece {
  readonly piece: GovernedPieceInput;
  readonly digest: string;
  readonly regionKey: string;
}

export interface GovernedBackfillFailure {
  readonly sourceType: GovernedPromptSourceKind;
  readonly sourceId: string | null;
  readonly tenantId: string;
  readonly codes: readonly FindingCode[];
}

export interface GovernedBackfillSummary {
  readonly policyVersion: string | null;
  readonly skipped?: 'policy_version_unknown';
  readonly sources: number;
  readonly alreadyGoverned: number;
  readonly screened: number;
  readonly passed: number;
  readonly failed: number;
  readonly unavailable: number;
  readonly failures: readonly GovernedBackfillFailure[];
}

/** A small insertion-ordered LRU with a per-entry TTL (no dependency for ~30 lines). */
class TtlLru<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}

function toPieceKind(kind: GovernedPieceInput['kind']): GovernedPromptPieceKind {
  return GovernedPromptPieceKind[kind];
}

function toSourceType(sourceType: GovernedPromptSourceKind): GovernedPromptSourceType {
  return GovernedPromptSourceType[sourceType];
}

@Injectable()
export class GovernedPromptRegistryService extends BaseService implements IGovernedPromptRegistry, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GovernedPromptRegistryService.name);
  private readonly verdicts = new TtlLru<boolean>(VERDICT_CACHE_MAX, VERDICT_TTL_MS);
  /** Guardrail resolves its policy version PER TENANT (L5), so the cache is keyed by tenant. */
  private readonly policyVersions = new Map<string, { value: string | null; expiresAt: number }>();
  private readonly policyVersionInFlight = new Map<string, Promise<string | null>>();
  /** `${policyVersion}|${digest}` of platform pieces already handled in this process. */
  private readonly platformHandled = new Set<string>();
  private readonly background = new Set<Promise<unknown>>();
  /** Backfill retry state: one pass at a time, one pending timer, backoff attempt counter. */
  private passInFlight: Promise<void> | null = null;
  private fullPassPending = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private destroyed = false;
  /** The last SYSTEM policy version actually read (a failed read never overwrites it). */
  private lastSystemPolicyVersion: string | null = null;

  constructor(
    private readonly repository: GovernedPromptPieceRepository,
    private readonly screenClient: GuardrailPromptScreenClient,
    protected override readonly eventEmitter: EventEmitter2,
    @Inject(ClsService) protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: IAppSettingsService,
  ) {
    super(eventEmitter, clsService, ResourceType.GovernedPromptPiece);
  }

  // ============================================================
  // Authoring time
  // ============================================================

  async screenAndRegister(tenantId: string, pieces: readonly GovernedPieceInput[]): Promise<GovernedScreeningResult> {
    return this.screenAs(tenantId, tenantId, pieces);
  }

  /**
   * Screen under `screenTenantId`'s guardrail configuration and policy version, and record the
   * verdicts as owned by `ownerTenantId`. The two differ only for platform pieces: owned by SYSTEM,
   * screened under the request tenant's version (a tenant that overrides a guardrail selection has
   * its own version, and a SYSTEM row under THAT version is what its calls look up).
   */
  private async screenAs(screenTenantId: string, ownerTenantId: string, pieces: readonly GovernedPieceInput[]): Promise<GovernedScreeningResult> {
    const tenantId = ownerTenantId;
    const digests = pieces.map((piece) => pieceDigest(piece.text));
    if (pieces.length === 0) return { passed: true, policyVersion: await this.currentPolicyVersion(screenTenantId), digests: [], findings: [] };

    const distinct = this.distinct(pieces);
    const policyVersion = await this.currentPolicyVersion(screenTenantId);
    if (policyVersion === null) {
      return { passed: false, policyVersion, digests, findings: distinct.map((one) => this.unavailable(one, 'guardrail policy version unknown')) };
    }

    const known = new Set(
      (
        await this.repository.findPassing(
          tenantId,
          distinct.map((one) => one.digest),
          policyVersion,
        )
      ).map((row) => row.digest),
    );
    const toScreen = distinct.filter((one) => !known.has(one.digest));
    if (toScreen.length === 0) return { passed: true, policyVersion, digests, findings: [] };

    let perPiece: Map<string, PieceCode[] | 'unavailable'>;
    try {
      perPiece = await this.screen(screenTenantId, toScreen);
    } catch (error) {
      if (!(error instanceof PromptScreeningUnavailableError)) throw error;
      return { passed: false, policyVersion, digests, findings: toScreen.map((one) => this.unavailable(one, 'guardrail screening unavailable')) };
    }

    const findings: GovernedPieceFinding[] = [];
    for (const one of toScreen) {
      const verdict = perPiece.get(one.digest) ?? [];
      if (verdict === 'unavailable') {
        findings.push(this.unavailable(one, 'a guardrail check could not run'));
        continue;
      }
      const pieceFindings = verdict.map((entry) => this.finding(one, entry));
      findings.push(...pieceFindings);
      await this.register(tenantId, one, policyVersion, pieceFindings);
    }
    return { passed: findings.length === 0, policyVersion, digests, findings };
  }

  async registerPlatformPieces(pieces: readonly GovernedPieceInput[], tenantId: string = SYSTEM_TENANT_ID): Promise<void> {
    // swallow-ok: an unknown policy version means "cannot register yet"; the composer's call takes the full-screening path.
    const policyVersion = await this.currentPolicyVersion(tenantId).catch(() => null);
    if (policyVersion === null || pieces.length === 0) return;
    const fresh = this.distinct(pieces).filter((one) => !this.platformHandled.has(`${policyVersion}|${one.digest}`));
    if (fresh.length === 0) return;
    for (const one of fresh) this.platformHandled.add(`${policyVersion}|${one.digest}`);
    this.track(
      this.screenAs(
        tenantId,
        SYSTEM_TENANT_ID,
        fresh.map((one) => one.piece),
      )
        .then((result) => {
          // Unavailable ⇒ forget, so a later compose retries; a real verdict (PASS or FAIL) stays handled.
          for (const finding of result.findings) {
            if (finding.code === 'PROMPT_SCREENING_UNAVAILABLE') this.platformHandled.delete(`${policyVersion}|${finding.digest}`);
          }
          if (!result.passed) {
            this.logger.warn({
              message: 'governed-prompt.platform.refused',
              findings: result.findings.map(({ code, pieceKey, digest }) => ({ code, pieceKey, digest })),
            });
          }
        })
        .catch((error: unknown) => {
          for (const one of fresh) this.platformHandled.delete(`${policyVersion}|${one.digest}`);
          this.logger.warn({ message: 'governed-prompt.platform.failed', error: error instanceof Error ? error.name : 'unknown' });
        }),
    );
  }

  // ============================================================
  // Call time
  // ============================================================

  async areGoverned(tenantId: string, digests: readonly string[]): Promise<boolean> {
    const unique = [...new Set(digests)];
    if (unique.length === 0) return false;
    const policyVersion = await this.currentPolicyVersion(tenantId);
    if (policyVersion === null) return false;

    const misses: string[] = [];
    for (const digest of unique) {
      const cached = this.verdicts.get(this.verdictKey(tenantId, digest, policyVersion));
      if (cached === false) return false;
      if (cached === undefined) misses.push(digest);
    }
    if (misses.length === 0) return true;

    const passing = new Set((await this.repository.findPassing(tenantId, misses, policyVersion)).map((row) => row.digest));
    for (const digest of misses) this.verdicts.set(this.verdictKey(tenantId, digest, policyVersion), passing.has(digest));
    return misses.every((digest) => passing.has(digest));
  }

  async currentPolicyVersion(tenantId: string = SYSTEM_TENANT_ID): Promise<string | null> {
    const cached = this.policyVersions.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    let inFlight = this.policyVersionInFlight.get(tenantId);
    if (!inFlight) {
      inFlight = this.screenClient
        .fetchPolicyVersion(tenantId)
        // swallow-ok: an unknown policy version IS the fail-closed answer (nothing is governed while it is null).
        .catch(() => null)
        .then((value) => {
          this.noteSystemPolicyVersion(tenantId, value);
          this.policyVersions.set(tenantId, {
            value,
            expiresAt: Date.now() + (value === null ? POLICY_VERSION_NEGATIVE_TTL_MS : POLICY_VERSION_TTL_MS),
          });
          return value;
        })
        .finally(() => {
          this.policyVersionInFlight.delete(tenantId);
        });
      this.policyVersionInFlight.set(tenantId, inFlight);
    }
    return inFlight;
  }

  // ============================================================
  // Boot backfill (§5.5)
  // ============================================================

  /** Never blocks boot: the backfill runs in the background and logs its outcome. */
  onApplicationBootstrap(): void {
    this.startPass();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.clearRetryTimer();
  }

  /**
   * Single-flight backfill pass. `only` restricts it to those sources (a retry of the UNAVAILABLE
   * ones); no `only` is a full pass, and a full request that arrives mid-pass is queued behind it.
   */
  private startPass(only?: ReadonlySet<string>): void {
    if (this.destroyed) return;
    if (this.passInFlight) {
      if (!only) this.fullPassPending = true;
      return;
    }
    if (!only) this.retryAttempt = 0;
    this.clearRetryTimer();
    const pass = this.clsService
      .run(() => this.runBackfill(only))
      .then((summary) => this.scheduleRetryIfNeeded(summary))
      .catch((error: unknown) => {
        this.logger.warn({ message: 'governed-prompt.backfill.failed', error: error instanceof Error ? error.message : 'unknown' });
      })
      .finally(() => {
        this.passInFlight = null;
        if (this.fullPassPending) {
          this.fullPassPending = false;
          this.startPass();
        }
      });
    this.passInFlight = pass;
    this.track(pass);
  }

  /** UNAVAILABLE sources (never FAIL — a FAIL is a real verdict) are retried with bounded backoff. */
  private scheduleRetryIfNeeded(summary: GovernedBackfillSummary): void {
    if (this.destroyed) return;
    const unavailable = summary.failures.filter((failure) => failure.codes.every((code) => code === 'PROMPT_SCREENING_UNAVAILABLE'));
    // A skipped pass (policy version unknown) retries everything; otherwise only the unavailable ones.
    const only = summary.skipped
      ? undefined
      : new Set(unavailable.map((failure) => this.sourceKey(failure.tenantId, failure.sourceType, failure.sourceId)));
    if (!summary.skipped && unavailable.length === 0) {
      this.retryAttempt = 0;
      return;
    }
    const min = this.settingMs('governedPrompt.backfillRetryMinMs', DEFAULT_BACKFILL_RETRY_MIN_MS);
    const max = Math.max(min, this.settingMs('governedPrompt.backfillRetryMaxMs', DEFAULT_BACKFILL_RETRY_MAX_MS));
    const delayMs = Math.min(max, min * 2 ** this.retryAttempt);
    this.retryAttempt += 1;
    this.logger.log({ message: 'governed-prompt.backfill.retry_scheduled', unavailable: unavailable.length, delayMs });
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startPass(only);
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private settingMs(key: string, fallback: number): number {
    const value = this.appSettings?.getValueWithDefault<number>(key, fallback) ?? fallback;
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  /** A changed SYSTEM policy version invalidates every verdict, so it kicks a (single-flight) full pass. */
  private noteSystemPolicyVersion(tenantId: string, value: string | null): void {
    if (tenantId !== SYSTEM_TENANT_ID || value === null) return;
    const previous = this.lastSystemPolicyVersion;
    this.lastSystemPolicyVersion = value;
    if (previous !== null && previous !== value) this.startPass();
  }

  private sourceKey(tenantId: string, sourceType: string, sourceId: string | null): string {
    return `${tenantId}|${sourceType}|${sourceId ?? ''}`;
  }

  /**
   * Screen every PUBLISHED agent and every APPROVED prompt version whose pieces are not all PASS
   * under its tenant's current policy version (SYSTEM's version is the availability probe). Bounded concurrency; failures are LISTED for the owner and
   * nothing is unpublished — until a source is screened, its calls take the full-screening path.
   */
  async runBackfill(only?: ReadonlySet<string>): Promise<GovernedBackfillSummary> {
    const policyVersion = await this.currentPolicyVersion();
    const empty = { sources: 0, alreadyGoverned: 0, screened: 0, passed: 0, failed: 0, unavailable: 0, failures: [] };
    if (policyVersion === null) {
      this.logger.warn({ message: 'governed-prompt.backfill.skipped', reason: 'policy_version_unknown' });
      return { policyVersion, skipped: 'policy_version_unknown', ...empty };
    }

    const [agents, versions] = await Promise.all([this.repository.findPublishedAgentSources(), this.repository.findApprovedVersionSources()]);
    const sources: Array<{ tenantId: string; sourceType: GovernedPromptSourceKind; sourceId: string; pieces: GovernedPieceInput[] }> = [
      ...agents.map((agent) => ({
        tenantId: agent.tenantId,
        sourceType: 'AGENT' as const,
        sourceId: agent.id,
        pieces: piecesFromResolvedPrompt((agent.compiledConfig as { resolvedPrompt?: unknown } | null)?.resolvedPrompt, {
          sourceType: 'AGENT',
          sourceId: agent.id,
        }),
      })),
      ...versions.map((version) => ({
        tenantId: version.tenantId,
        sourceType: 'PROMPT_VERSION' as const,
        sourceId: version.promptTemplateId,
        pieces: version.content ? templateBodyPieces(version.content, version.promptTemplateId) : [],
      })),
    ].filter((source) => source.pieces.length > 0 && (!only || only.has(this.sourceKey(source.tenantId, source.sourceType, source.sourceId))));

    const counts = { alreadyGoverned: 0, screened: 0, passed: 0, failed: 0, unavailable: 0 };
    const failures: GovernedBackfillFailure[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < sources.length) {
        const source = sources[next++]!;
        const digests = source.pieces.map((piece) => pieceDigest(piece.text));
        // Each source is checked against ITS tenant's policy version (guardrail resolves it per tenant).
        const sourceVersion = await this.currentPolicyVersion(source.tenantId);
        const passing = new Set(
          sourceVersion === null ? [] : (await this.repository.findPassing(source.tenantId, digests, sourceVersion)).map((row) => row.digest),
        );
        if (digests.every((digest) => passing.has(digest))) {
          counts.alreadyGoverned += 1;
          continue;
        }
        counts.screened += 1;
        const result = await this.screenAndRegister(source.tenantId, source.pieces);
        if (result.passed) {
          counts.passed += 1;
          continue;
        }
        const codes = [...new Set(result.findings.map((finding) => finding.code))];
        if (codes.every((code) => code === 'PROMPT_SCREENING_UNAVAILABLE')) counts.unavailable += 1;
        else counts.failed += 1;
        failures.push({ sourceType: source.sourceType, sourceId: source.sourceId, tenantId: source.tenantId, codes });
      }
    };
    await Promise.all(Array.from({ length: Math.min(BACKFILL_CONCURRENCY, sources.length) }, () => worker()));

    const summary: GovernedBackfillSummary = { policyVersion, sources: sources.length, ...counts, failures };
    if (failures.length > 0) this.logger.warn({ message: 'governed-prompt.backfill.failures', policyVersion, failures });
    this.logger.log({ message: 'governed-prompt.backfill.completed', policyVersion, sources: sources.length, ...counts });
    return summary;
  }

  /** Test seam: wait for every background screen this instance started. */
  async drainBackground(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  // ============================================================
  // Internals
  // ============================================================

  private track(work: Promise<unknown>): void {
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  private distinct(pieces: readonly GovernedPieceInput[]): DistinctPiece[] {
    const byDigest = new Map<string, DistinctPiece>();
    for (const piece of pieces) {
      const digest = pieceDigest(piece.text);
      if (!byDigest.has(digest)) byDigest.set(digest, { piece, digest, regionKey: digest.slice(0, REGION_KEY_CHARS) });
    }
    return [...byDigest.values()];
  }

  /**
   * One screen over every piece as a region. A block is a verdict about the REQUEST, so when more
   * than one piece was screened each piece is re-screened alone to attribute it; if no piece blocks
   * alone, the block is attributed to all of them (fail closed). PII is attributed by region.
   */
  private async screen(tenantId: string, pieces: readonly DistinctPiece[]): Promise<Map<string, PieceCode[] | 'unavailable'>> {
    const outcome = await this.screenClient.screenRegions(
      tenantId,
      pieces.map((one) => ({ key: one.regionKey, text: one.piece.text })),
    );
    const result = new Map<string, PieceCode[] | 'unavailable'>();
    if (outcome.undetermined) {
      for (const one of pieces) result.set(one.digest, 'unavailable');
      return result;
    }
    if (outcome.decision === 'allow' || pieces.length === 1) {
      for (const one of pieces) result.set(one.digest, this.codesFor(outcome, one.regionKey));
      return result;
    }

    let anyBlockedAlone = false;
    for (const one of pieces) {
      const alone = await this.screenClient.screenRegions(tenantId, [{ key: one.regionKey, text: one.piece.text }]);
      if (alone.undetermined) {
        result.set(one.digest, 'unavailable');
        continue;
      }
      if (alone.decision === 'block') anyBlockedAlone = true;
      result.set(one.digest, this.codesFor(alone, one.regionKey));
    }
    if (!anyBlockedAlone) {
      for (const one of pieces) {
        const codes = result.get(one.digest);
        if (codes === 'unavailable') continue;
        const seen = new Set((codes ?? []).map((entry) => entry.code));
        result.set(one.digest, [...(codes ?? []), ...this.codesFor(outcome, one.regionKey).filter((entry) => !seen.has(entry.code))]);
      }
    }
    return result;
  }

  /** The codes one outcome assigns to one region: injection, other unsafe checks, PII. */
  private codesFor(outcome: PromptScreenOutcome, regionKey: string): PieceCode[] {
    const codes: PieceCode[] = [];
    if (outcome.decision === 'block') {
      if (outcome.reasons.includes(INJECTION_CHECK)) codes.push({ code: 'PROMPT_SCREENING_INJECTION', checks: [INJECTION_CHECK] });
      const unsafe = outcome.reasons.filter((reason) => reason !== INJECTION_CHECK);
      // A block that names no check is still a block — reported as unsafe, never dropped.
      if (unsafe.length > 0 || outcome.reasons.length === 0) codes.push({ code: 'PROMPT_SCREENING_UNSAFE', checks: unsafe });
    }
    if (outcome.piiRegions.has(regionKey)) codes.push({ code: 'PROMPT_CONTAINS_PII', checks: [] });
    return codes;
  }

  private finding(one: DistinctPiece, entry: PieceCode): GovernedPieceFinding {
    const reason =
      entry.code === 'PROMPT_CONTAINS_PII'
        ? 'personal data detected in the prompt text'
        : entry.code === 'PROMPT_SCREENING_INJECTION'
          ? `injection/jailbreak detected (${INJECTION_CHECK})`
          : `unsafe content detected (${entry.checks.join(', ') || 'blocked'})`;
    return { code: entry.code, pieceKind: one.piece.kind, pieceKey: one.piece.sourceKey, digest: one.digest, reason };
  }

  private unavailable(one: DistinctPiece, reason: string): GovernedPieceFinding {
    return { code: 'PROMPT_SCREENING_UNAVAILABLE', pieceKind: one.piece.kind, pieceKey: one.piece.sourceKey, digest: one.digest, reason };
  }

  private async register(tenantId: string, one: DistinctPiece, policyVersion: string, findings: readonly GovernedPieceFinding[]): Promise<void> {
    const verdict = findings.length === 0 ? GovernedPromptVerdict.PASS : GovernedPromptVerdict.FAIL;
    const saved = await this.repository.upsertVerdict({
      tenantId,
      digest: one.digest,
      policyVersion,
      kind: toPieceKind(one.piece.kind),
      sourceType: toSourceType(one.piece.sourceType),
      sourceId: one.piece.sourceId,
      sourceKey: one.piece.sourceKey,
      verdict,
      findings: findings.length === 0 ? null : (findings.map(({ code, reason }) => ({ code, reason })) as unknown as JsonValue),
      textChars: one.piece.text.length,
      screenedAt: new Date(),
      actorId: this.requestUserId ?? null,
    });
    this.verdicts.set(this.verdictKey(tenantId, one.digest, policyVersion), verdict === GovernedPromptVerdict.PASS);
    this.broadcastSysEvent((saved.version ?? 1) > 1 ? SysEventType.ResourceUpdated : SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: {
        action: 'screen',
        ownerTenantId: tenantId,
        digest: one.digest,
        policyVersion,
        verdict,
        kind: one.piece.kind,
        sourceType: one.piece.sourceType,
        sourceId: one.piece.sourceId,
        codes: findings.map((finding) => finding.code),
      },
    });
  }

  private verdictKey(tenantId: string, digest: string, policyVersion: string): string {
    return `${tenantId}|${policyVersion}|${digest}`;
  }
}
