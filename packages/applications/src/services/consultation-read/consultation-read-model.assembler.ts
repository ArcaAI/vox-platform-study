import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ContextItemRepository,
  ContextItemType,
  DepartmentRepository,
  DnaWritingStyleReportRepository,
  MediaRepository,
  TranscriptSegmentRepository,
} from '@arcaai/domains';
import type { ConsultationEntity, ContextItemEntity } from '@arcaai/domains';
import { isSttAggregateTranscript } from '../../common/transcript-provenance';
import { SecretsService } from '../baseServices/_meta/secrets';
import { ConfigResolver } from '../config-resolver';
import {
  CLIENT_INVESTIGATIONS_KIND_KEY,
  CLIENT_PREVIOUS_CASE_NOTES_KIND_KEY,
  CLIENT_VITALS_KIND_KEY,
  clientClinicalContextReaderFor,
  contextItemDecryptor,
  type ClientInvestigationsPayload,
  type ClientVitalsPayload,
  type ContextItemDecrypt,
} from '../consultation/context/client-clinical-context';
import { readSpokenLanguageMode } from '../consultation/consultation/summary-language';
import { resolveVisitTypeKey } from '../consultation/consultation/open-markers';
import { selectAuthoritativeNoteText } from '../consultation/harness/prior-visit-summary';
import { resolvePlatformOutputLanguage } from '../consultation/summary/platform-output-language';
import { DEFAULT_VISIT_TYPE_SERVICE } from '../consultation/visit-type/visit-type.service';
import { renderDnaRedactionRulesText } from '../dna-writing-style/redaction-rules-text';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';

/**
 * TASK-1036 §9.3 (OD-34) — assembles the `consultation.*` READ MODEL (`CONSULTATION_READ_SCHEMA_V1`)
 * of one consultation, ONE top-level section at a time: the caller names the roots its declared
 * paths need and nothing else is read or decrypted.
 *
 * Sources (all existing, none duplicated):
 *  - `visitType` — `resolveVisitTypeKey` (the recorded marker, else the parent link);
 *  - `language` — `readSpokenLanguageMode` (the SPOKEN language); `outputLanguage` — the tenant's
 *    `consultation.summary.outputLanguage` (`resolvePlatformOutputLanguage`);
 *  - `patient` — the v2 data model holds NO demographics (`patientId` is an external reference);
 *    only what the client recorded under `metadata.patient` is surfaced, otherwise `null`s;
 *  - `clinician.dna` — the doctor's latest DNA report, gated by the doctor's own opt-out (the
 *    workflow declaring the read IS the tenant's opt-in);
 *  - `transcript` — the STT aggregate transcript(s) with their persisted segments (text sliced by
 *    the stored offsets); `items` / `vitals` / `testResults` / `previousVisits` — the context items
 *    and the client's validated clinical kinds; `notes` — the pre-summary and the authoritative note.
 *
 * Never throws for a missing optional source: an absent value is `null` (or `[]` for a list). A
 * repository FAILURE propagates — the read is refused rather than answered with a silently
 * incomplete snapshot the run would then record as the truth.
 */
@Injectable()
export class ConsultationReadModelAssembler {
  private readonly logger = new Logger(ConsultationReadModelAssembler.name);

  constructor(
    private readonly contextItemRepository: ContextItemRepository,
    @Optional() @Inject(DepartmentRepository) private readonly departmentRepository?: DepartmentRepository,
    @Optional() @Inject(MediaRepository) private readonly mediaRepository?: MediaRepository,
    @Optional() @Inject(TranscriptSegmentRepository) private readonly transcriptSegmentRepository?: TranscriptSegmentRepository,
    @Optional() @Inject(DnaWritingStyleReportRepository) private readonly dnaReportRepository?: DnaWritingStyleReportRepository,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
    @Optional() private readonly effectiveSettings?: EffectiveSettingsService,
  ) {}

  async assemble(consultation: ConsultationEntity, tenantId: string, roots: ReadonlySet<string>): Promise<Record<string, unknown>> {
    const decrypt = contextItemDecryptor(this.contextItemRepository, this.secretsService);
    const model: Record<string, unknown> = {};
    const want = (root: string): boolean => roots.has(root);

    if (want('id')) model.id = consultation.id;
    if (want('visitType'))
      model.visitType = resolveVisitTypeKey(DEFAULT_VISIT_TYPE_SERVICE, tenantId, consultation.metadata, consultation.parentConsultationId);
    if (want('language')) model.language = readSpokenLanguageMode(consultation);
    if (want('outputLanguage')) {
      const language = await resolvePlatformOutputLanguage(this.effectiveSettings, tenantId, this.logger);
      model.outputLanguage = { code: language.tag, name: language.name };
    }
    if (want('department')) model.department = await this.department(consultation);
    if (want('patient')) model.patient = patientOf(consultation.metadata);
    if (want('clinician')) model.clinician = { dna: await this.dna(consultation) };
    if (want('transcript')) model.transcript = await this.transcript(consultation, tenantId, decrypt);
    if (want('items')) model.items = await this.items(consultation, decrypt);
    if (want('notes')) model.notes = await this.notes(consultation, decrypt);
    if (want('vitals')) model.vitals = await this.vitals(consultation);
    if (want('testResults')) model.testResults = await this.testResults(consultation, decrypt);
    if (want('previousVisits')) model.previousVisits = await this.previousVisits(consultation);
    return model;
  }

  private async department(consultation: ConsultationEntity): Promise<{ id: string; code: string | null; name: string | null } | null> {
    if (!consultation.departmentId || !this.departmentRepository) return null;
    const department = await this.departmentRepository.findByIdOrNull(consultation.departmentId);
    return department ? { id: department.id, code: department.code ?? null, name: department.name ?? null } : null;
  }

  private async dna(consultation: ConsultationEntity): Promise<{ style: string | null; rules: string | null }> {
    const none = { style: null, rules: null };
    if (!consultation.doctorId || !this.dnaReportRepository || !this.secretsService) return none;
    // The workflow declaring the read is the tenant's opt-in; the doctor's own opt-out still wins.
    const preference = this.configResolver ? await this.configResolver.resolveDoctorDnaPreference(consultation.doctorId) : null;
    if (preference?.enabled === false) return none;
    const report = await this.dnaReportRepository.findLatestForDoctor(consultation.doctorId);
    if (!report) return none;
    const { styleText, redactionRules } = await this.dnaReportRepository.decryptFieldsFromEntity(report, this.secretsService);
    const rules = renderDnaRedactionRulesText(redactionRules);
    return { style: styleText?.trim() || null, rules: rules || null };
  }

  private async transcript(
    consultation: ConsultationEntity,
    tenantId: string,
    decrypt: ContextItemDecrypt,
  ): Promise<{ text: string | null; segments: Array<{ text: string; speaker: string | null; start: number | null; end: number | null }> }> {
    const aggregates = (await this.contextItemRepository.findTranscripts(consultation.id)).filter((item) => isSttAggregateTranscript(item));
    const texts: string[] = [];
    const segments: Array<{ text: string; speaker: string | null; start: number | null; end: number | null }> = [];
    for (const aggregate of aggregates) {
      const text = (await decrypt(aggregate)) ?? '';
      if (text.trim()) texts.push(text);
      if (!this.transcriptSegmentRepository) continue;
      for (const segment of await this.transcriptSegmentRepository.findByContextItem(tenantId, aggregate.id)) {
        const start = typeof segment.charStart === 'number' ? segment.charStart : null;
        const end = typeof segment.charEnd === 'number' ? segment.charEnd : null;
        segments.push({
          text: start !== null && end !== null ? text.slice(start, end) : '',
          speaker: segment.speaker ?? null,
          start: typeof segment.t0Ms === 'number' ? segment.t0Ms / 1000 : null,
          end: typeof segment.t1Ms === 'number' ? segment.t1Ms / 1000 : null,
        });
      }
    }
    return { text: texts.length > 0 ? texts.join('\n\n') : null, segments };
  }

  private async items(consultation: ConsultationEntity, decrypt: ContextItemDecrypt): Promise<Array<Record<string, unknown>>> {
    const rows = await this.contextItemRepository.findByConsultation(consultation.id);
    const out: Array<Record<string, unknown>> = [];
    const mediaIds = rows.filter((row) => itemKindOf(row) === 'ATTACHMENT' && row.mediaId).map((row) => row.mediaId as string);
    const media = await this.mediaById(mediaIds);
    for (const row of rows) {
      const kind = itemKindOf(row);
      if (kind === null) continue;
      const meta = asObject(row.metaData);
      const extracted = typeof meta?.extractedText === 'string' ? meta.extractedText : null;
      const text = kind === 'ATTACHMENT' ? (extracted ?? (await decrypt(row))) : await decrypt(row);
      const file = row.mediaId ? media.get(row.mediaId) : undefined;
      out.push({
        id: row.id,
        kind,
        text: text ?? null,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : null,
        ...(kind === 'ATTACHMENT'
          ? { attachment: { mediaId: row.mediaId ?? null, mime: file?.mimeType ?? null, name: file?.name ?? null, size: file?.size ?? null } }
          : {}),
      });
    }
    return out;
  }

  private async mediaById(ids: string[]): Promise<Map<string, { mimeType?: string | null; name?: string | null; size?: number | null }>> {
    const byId = new Map<string, { mimeType?: string | null; name?: string | null; size?: number | null }>();
    if (ids.length === 0 || !this.mediaRepository) return byId;
    for (const id of new Set(ids)) {
      const media = await this.mediaRepository.findByIdOrNull(id);
      if (media) byId.set(id, { mimeType: media.mimeType, name: media.name, size: media.size });
    }
    return byId;
  }

  private async notes(consultation: ConsultationEntity, decrypt: ContextItemDecrypt): Promise<{ preSummary: string | null; summary: string | null }> {
    const preSummaries = (await this.contextItemRepository.findPreSummaries(consultation.id)).filter(
      (item) => asObject(item.metaData)?.subType !== LIVE_SOAP_SNAPSHOT_SUBTYPE,
    );
    const newest = preSummaries.reduce<ContextItemEntity | null>(
      (latest, item) => (!latest || item.createdAt > latest.createdAt ? item : latest),
      null,
    );
    const preSummary = newest ? ((await decrypt(newest))?.trim() ?? null) : null;
    const summary = await selectAuthoritativeNoteText(this.contextItemRepository, consultation.id);
    return { preSummary: preSummary || null, summary: summary ?? null };
  }

  private async vitals(consultation: ConsultationEntity): Promise<Array<{ name: string; value: string; unit: string; measuredAt: string | null }>> {
    const context = await clientClinicalContextReaderFor(this.contextItemRepository, this.secretsService).read(consultation.id);
    return vitalsListOf(context.raw.vitals);
  }

  private async testResults(consultation: ConsultationEntity, decrypt: ContextItemDecrypt): Promise<Array<Record<string, unknown>>> {
    const item = await this.contextItemRepository.findLatestByKindKey(consultation.id, CLIENT_INVESTIGATIONS_KIND_KEY);
    const payload = item ? (parseJson(await decrypt(item)) as ClientInvestigationsPayload | null) : null;
    return (payload?.results ?? [])
      .filter((result) => typeof result?.name === 'string' && result.name.trim())
      .map((result) => ({
        name: result.name ?? null,
        value: result.value === undefined || result.value === null ? null : String(result.value),
        unit: result.unit ?? null,
        flag: result.flag ?? result.refRange ?? null,
        takenAt: result.collectedAt ?? null,
      }));
  }

  private async previousVisits(consultation: ConsultationEntity): Promise<Array<Record<string, unknown>>> {
    const context = await clientClinicalContextReaderFor(this.contextItemRepository, this.secretsService).read(consultation.id);
    // The client's own prior notes carry no HOPE consultation id — `null`, never invented.
    return context.raw.previousVisits.map((note) => ({
      consultationId: null,
      date: note.date ?? null,
      department: note.department ?? null,
      summary: note.text ?? null,
    }));
  }
}

const LIVE_SOAP_SNAPSHOT_SUBTYPE = 'LIVE_SOAP_SNAPSHOT';

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The read schema's `items[].kind` for one context item, or `null` when it is not an item. */
export function itemKindOf(item: Pick<ContextItemEntity, 'type' | 'kindKey' | 'metaData'>): string | null {
  if (item.type === ContextItemType.CASE_NOTE) {
    // A case note materialised from the client's `previous_case_notes` is the PRIOR_VISIT item.
    return asObject(item.metaData)?.origin === 'open.context' ? null : 'CASE_NOTE';
  }
  if (item.type === ContextItemType.ATTACHMENT) return 'ATTACHMENT';
  if (item.type === ContextItemType.STRUCTURED) {
    if (item.kindKey === CLIENT_VITALS_KIND_KEY) return 'VITALS';
    if (item.kindKey === CLIENT_INVESTIGATIONS_KIND_KEY) return 'TEST_RESULT';
    if (item.kindKey === CLIENT_PREVIOUS_CASE_NOTES_KIND_KEY) return 'PRIOR_VISIT';
  }
  return null;
}

/** `metadata.patient` as the read schema's `patient`, every absent field `null`. */
export function patientOf(metadata: unknown): { age: number | null; gender: string | null; dob: string | null } {
  const patient = asObject(asObject(metadata)?.patient);
  const age = patient?.age;
  return {
    age: typeof age === 'number' && Number.isInteger(age) && age >= 0 ? age : null,
    gender: typeof patient?.gender === 'string' && patient.gender.trim() ? patient.gender.trim() : null,
    dob: typeof patient?.dob === 'string' && patient.dob.trim() ? patient.dob.trim() : null,
  };
}

const VITAL_FIELDS: ReadonlyArray<{ key: keyof ClientVitalsPayload; name: string; unit: string }> = [
  { key: 'bloodPressure', name: 'Blood pressure', unit: 'mmHg' },
  { key: 'heartRate', name: 'Heart rate', unit: 'bpm' },
  { key: 'respiratoryRate', name: 'Respiratory rate', unit: '/min' },
  { key: 'temperature', name: 'Temperature', unit: '°C' },
  { key: 'oxygenSaturation', name: 'Oxygen saturation', unit: '%' },
  { key: 'weightKg', name: 'Weight', unit: 'kg' },
  { key: 'heightCm', name: 'Height', unit: 'cm' },
  { key: 'bmi', name: 'BMI', unit: 'kg/m²' },
  { key: 'bloodGlucose', name: 'Blood glucose', unit: 'mg/dL' },
  { key: 'painScore', name: 'Pain score', unit: '/10' },
];

/** The client's single `vitals` payload as the read schema's list of readings. */
export function vitalsListOf(
  vitals: ClientVitalsPayload | undefined,
): Array<{ name: string; value: string; unit: string; measuredAt: string | null }> {
  if (!vitals) return [];
  const measuredAt = typeof vitals.recordedAt === 'string' ? vitals.recordedAt : null;
  return VITAL_FIELDS.flatMap(({ key, name, unit }) => {
    const value = vitals[key];
    if (value === undefined || value === null || value === '') return [];
    return [{ name, value: String(value), unit, measuredAt }];
  });
}
