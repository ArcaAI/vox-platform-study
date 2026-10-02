import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ConsultationRepository, ContextItemRepository, ContextItemType, UserProfileRepository } from '@arcaai/domains';
import type { KnownPhiEntry } from '@arcaai/types';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IConsultationContextSchemaService } from '../consultation-context-schema/IConsultationContextSchemaService';
import type { IConsultationContextSchemaService as IConsultationContextSchemaServicePort } from '../consultation-context-schema/IConsultationContextSchemaService';
import { contextItemDecryptor, latestContextItemOfKind } from '../consultation/context/client-clinical-context';
import { collectKnownPhi, type KnownPhiSources } from './known-phi';

/** How long one consultation's known-PHI list is reused. The live loop flushes every few seconds. */
const CACHE_TTL_MS = 60_000;
/** Upper bound on cached consultations per process. */
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  expiresAt: number;
  sources: Promise<KnownPhiSources>;
}

/**
 * Resolves `known_phi` for a consultation: the patient identifier, the clinician's name and staff
 * id, and the short string values of every context kind the governing context schema classes as
 * PHI (`kinds[].phiClass === 'PHI'`). The pure fold is {@link collectKnownPhi}; this class only
 * gathers its inputs.
 *
 * FAIL OPEN, deliberately. `known_phi` is the deterministic HALF of cloud redaction; the detector's
 * span-level pass in `apps/text` runs regardless. A read failure therefore degrades to "the
 * detector alone", is logged WITHOUT values, and never blocks generation.
 *
 * Every dependency is optional so a composition that does not wire one (and every positional test
 * fixture) keeps working; a missing source simply contributes nothing.
 */
@Injectable()
export class KnownPhiService {
  private readonly logger = new Logger(KnownPhiService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly cls: ClsService<IActiveUserContext>,
    @Optional() @Inject(ConsultationRepository) private readonly consultations?: ConsultationRepository,
    @Optional() @Inject(UserProfileRepository) private readonly userProfiles?: UserProfileRepository,
    @Optional() @Inject(ContextItemRepository) private readonly contextItems?: ContextItemRepository,
    @Optional() @Inject(IConsultationContextSchemaService) private readonly contextSchemas?: IConsultationContextSchemaServicePort,
    @Optional() @Inject(SecretsService) private readonly secrets?: SecretsService,
  ) {}

  /**
   * The known-PHI list for one consultation. `context` is the caller's own copy of the validated
   * open context (the realtime lane's `trigger.context`), merged over what was persisted at open.
   * Never throws.
   */
  async forConsultation(consultationId: string, context?: Record<string, unknown> | null): Promise<KnownPhiEntry[]> {
    const key = `${this.cls.get('tenantId') ?? 'none'}:${consultationId}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    const sources = await (cached && cached.expiresAt > now ? cached.sources : this.remember(key, now, this.load(consultationId)));
    // The caller's copy of the open context wins per kind over what was persisted at open.
    return collectKnownPhi(context ? { ...sources, context: { ...(sources.context ?? {}), ...context } } : sources);
  }

  private remember(key: string, now: number, sources: Promise<KnownPhiSources>): Promise<KnownPhiSources> {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      for (const [stale, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(stale);
      if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    }
    this.cache.set(key, { expiresAt: now + CACHE_TTL_MS, sources });
    return sources;
  }

  private async load(consultationId: string): Promise<KnownPhiSources> {
    try {
      const consultation = this.consultations ? await this.consultations.findByIdOrNull(consultationId) : null;
      if (!consultation) return {};
      const [clinician, definition, context] = await Promise.all([
        this.userProfiles ? this.userProfiles.findFirst({ where: { userId: consultation.doctorId } }).catch(() => null) : null,
        this.definitionFor(consultation.departmentId ?? null).catch(() => null),
        this.persistedContext(consultationId).catch(() => ({})),
      ]);
      return {
        definition,
        context,
        patientId: consultation.patientId,
        clinician: clinician ? { firstName: clinician.firstName, lastName: clinician.lastName, staffId: clinician.staffId } : null,
      };
    } catch (error) {
      this.logger.warn({
        message: 'Known-PHI resolution failed; cloud redaction falls back to the detector alone (fail-open)',
        consultationId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return {};
    }
  }

  private async definitionFor(departmentId: string | null): Promise<unknown> {
    if (!this.contextSchemas) return null;
    const bundle = await this.contextSchemas.getEffectiveBundle(departmentId ?? undefined);
    return bundle?.definition ?? null;
  }

  /** The latest STRUCTURED context item per kind key, decrypted and parsed. */
  private async persistedContext(consultationId: string): Promise<Record<string, unknown>> {
    if (!this.contextItems) return {};
    const items = await this.contextItems.findByConsultation(consultationId, { type: ContextItemType.STRUCTURED });
    const decrypt = contextItemDecryptor(this.contextItems, this.secrets);
    const kindKeys = [...new Set(items.map((item) => item.kindKey).filter((kindKey): kindKey is string => typeof kindKey === 'string' && kindKey.length > 0))];
    const context: Record<string, unknown> = {};
    for (const kindKey of kindKeys) {
      const item = latestContextItemOfKind(items, kindKey);
      if (!item) continue;
      try {
        const raw = await decrypt(item);
        if (raw?.trim()) context[kindKey] = JSON.parse(raw);
      } catch {
        // An unreadable body contributes nothing; the detector still runs over the prompt.
      }
    }
    return context;
  }
}
