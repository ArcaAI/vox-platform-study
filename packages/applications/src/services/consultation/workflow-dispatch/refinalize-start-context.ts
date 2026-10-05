import { ContextItemRepository, ContextItemType, DnaWritingStyleReportRepository } from '@arcaai/domains';
import type { ConfigResolver } from '../../config-resolver';
import type { SecretsService } from '../../baseServices/_meta/secrets';
import { validateRedactionRuleSet } from '../../dna-writing-style/redaction-rules';
import { contextItemDecryptor } from '../context/client-clinical-context';

/**
 * What a note-generation START carries besides the plan, rebuilt from the consultation row — the
 * same two reads `ConsultationEventHandler` makes for the first note, so a re-finalised note is
 * redacted and contextualised exactly like the first one.
 */

/**
 * The doctor's DNA redaction rules for a harness-doc start: the tenant gate (an active
 * `agent.dna_redaction` node) AND the doctor's opt-in, then the latest report's decrypted rules.
 * FAIL-SAFE: any gate/lookup/decrypt/validation failure — or an unwired dependency — yields `[]`,
 * which makes the workflow's `apply_redaction` a no-op; a start is never blocked by it.
 */
export async function resolveHarnessRedactionRules(
  deps: {
    configResolver?: Pick<ConfigResolver, 'resolveEffectiveDnaRedactionEnabled'>;
    dnaReportRepository?: DnaWritingStyleReportRepository;
    secretsService?: SecretsService;
  },
  consultation: { tenantId: string; departmentId?: string | null; doctorId?: string | null },
): Promise<Record<string, unknown>[]> {
  if (!deps.configResolver || !deps.dnaReportRepository || !deps.secretsService) return [];
  try {
    const doctorId = consultation.doctorId ?? null;
    const { effective } = await deps.configResolver.resolveEffectiveDnaRedactionEnabled({
      tenantId: consultation.tenantId,
      departmentId: consultation.departmentId ?? null,
      doctorId,
    });
    if (!effective || !doctorId) return [];
    const report = await deps.dnaReportRepository.findLatestForDoctor(doctorId);
    if (!report) return [];
    const { redactionRules } = await deps.dnaReportRepository.decryptFieldsFromEntity(report, deps.secretsService);
    if (!redactionRules) return [];
    return validateRedactionRuleSet(redactionRules).rules as unknown as Record<string, unknown>[];
  } catch {
    // swallow-ok: fail-safe by design (see above); nothing of the report is logged.
    return [];
  }
}

/**
 * The client's authored context as the `{ [kindKey]: payload }` envelope the governing trigger
 * validates — newest STRUCTURED item per `kindKey`, decrypted. Best-effort: an unreadable item is
 * skipped, and nothing readable means `null` (the run starts without a payload).
 */
export async function rebuildAuthoredContext(
  contextItemRepository: ContextItemRepository,
  secretsService: SecretsService | undefined,
  consultationId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const items = await contextItemRepository.findByType(consultationId, ContextItemType.STRUCTURED);
    const newest = new Map<string, (typeof items)[number]>();
    for (const item of items) {
      if (!item.kindKey) continue;
      const current = newest.get(item.kindKey);
      if (!current || new Date(item.createdAt ?? 0).getTime() >= new Date(current.createdAt ?? 0).getTime()) newest.set(item.kindKey, item);
    }
    if (newest.size === 0) return null;
    const decrypt = contextItemDecryptor(contextItemRepository, secretsService as never);
    const authored: Record<string, unknown> = {};
    for (const [kindKey, item] of newest) {
      try {
        const raw = await decrypt(item);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) authored[kindKey] = parsed;
      } catch {
        // swallow-ok: an unreadable or non-JSON kind is simply not carried (nothing of it is logged).
      }
    }
    return Object.keys(authored).length > 0 ? authored : null;
  } catch {
    // swallow-ok: the run starts without the authored context, as an open without it would.
    return null;
  }
}
