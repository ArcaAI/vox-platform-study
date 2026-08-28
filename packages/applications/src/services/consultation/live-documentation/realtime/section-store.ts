/**
 * TASK-811 (OD-7) — per-section writes, with the state machine and the OCC that
 * make them safe while a clinician is editing.
 *
 * ## The rule this file enforces
 *
 * **A CONFIRMED section is never overwritten by a flush.** That sentence is why
 * `DocumentSection` is a table and not JSON on one blob: with a single
 * `_version`, every flush contends with every clinician edit, and two
 * concurrently generating documents contend with each other. Here, each section
 * carries its own `_version`, so a flush writing `assessment` and a clinician
 * editing `plan` never meet.
 *
 * ## What a losing writer does
 *
 * It LOSES. `updateWithVersion` compare-and-sets; on drift the repository throws
 * `OptimisticConcurrencyException` and this store reports `conflict` — it does not
 * re-read and retry. A flush that reloaded and rewrote would defeat the very
 * check it just lost, which is the classic way an OCC guard becomes decorative.
 * The clinician's write stands; the next flush sees the CONFIRMED state and
 * behaves accordingly.
 */
import { Logger } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  DocumentSectionFactory,
  DocumentSectionState,
  type DocumentSectionEntity,
  type DocumentSectionRepository,
  type JsonValue,
} from '@arcaai/domains';
import type { SectionAnnotationDto, SectionPatchDto, SectionProvenanceDto } from './dto/section-patch.dto';

/** Minimal structural view of the PHI encryptor — mirrors `SecretsServiceLike`. */
export interface SectionSecretsLike {
  encrypt(plaintext: Buffer, keyName?: string): Promise<string>;
  decrypt(ciphertext: string, keyName?: string): Promise<Buffer>;
  getPhiTransitKeyName?(): string | undefined;
}

/**
 * A deletion reason. §2d: "a later flush removing content must point at a
 * transcript contradiction, otherwise the patch is refused."
 *
 * A model silently emptying a section it filled two turns ago is
 * indistinguishable, to a reader, from the clinician never having said it. So a
 * shrink to empty must NAME what in the transcript contradicts it.
 */
export interface TranscriptContradiction {
  readonly transcriptSegmentId?: string;
  readonly reason: string;
}

export interface SectionWriteInput {
  readonly consultationId: string;
  readonly tenantId: string;
  readonly documentKey: string;
  readonly sectionKey: string;
  readonly title: string;
  readonly idx: number;
  readonly content: string;
  readonly annotations?: SectionAnnotationDto[];
  readonly provenance?: SectionProvenanceDto[];
  readonly documentTemplateVersionId?: string | null;
  /** The flush generation that produced this content — the staleness token. */
  readonly generation: number;
  /** Required when the write EMPTIES a section that had content. */
  readonly contradiction?: TranscriptContradiction | null;
  readonly userId?: string | null;
}

export type SectionWriteRefusal =
  | 'locked'
  | 'confirmed-no-overwrite'
  | 'deletion-without-contradiction'
  | 'stale-generation'
  | 'occ-conflict'
  | 'unavailable';

export type SectionWriteResult =
  | { readonly applied: true; readonly patch: SectionPatchDto; readonly section: DocumentSectionEntity }
  | { readonly applied: false; readonly reason: SectionWriteRefusal };

const STATE_WIRE: Readonly<Record<DocumentSectionState, SectionPatchDto['state']>> = Object.freeze({
  [DocumentSectionState.EMPTY]: 'empty',
  [DocumentSectionState.PROVISIONAL]: 'provisional',
  [DocumentSectionState.CONFIRMED]: 'confirmed',
  [DocumentSectionState.LOCKED]: 'locked',
});

function sectionAddress(input: Pick<SectionWriteInput, 'consultationId' | 'documentKey' | 'sectionKey'>): string {
  return `${input.consultationId}::${input.documentKey}::${input.sectionKey}`;
}

/**
 * Owns per-section persistence for the realtime lane.
 *
 * The repository and the encryptor are OPTIONAL, exactly as they are on
 * `LiveDocumentationService`: unit fixtures and non-DI construction paths must
 * still build, and a live feed that cannot persist must still publish (the
 * clinician sees the note either way). An absent repository refuses with
 * `unavailable` rather than pretending the write happened.
 */
export class DocumentSectionStore {
  private readonly logger = new Logger(DocumentSectionStore.name);
  /**
   * Highest flush generation already applied per section address.
   *
   * The DB `_version` protects against a LOST UPDATE; this protects against an
   * OUT-OF-ORDER one. They are different failures: a late generation-3 response
   * landing after generation 4 has already written would pass the version check
   * (it re-read nothing) while still replacing fresher content with older content.
   */
  private readonly lastGeneration = new Map<string, number>();

  constructor(
    private readonly repository?: DocumentSectionRepository,
    private readonly secrets?: SectionSecretsLike,
  ) {}

  /** Drop a finished session's staleness bookkeeping. */
  forget(consultationId: string): void {
    for (const key of this.lastGeneration.keys()) {
      if (key.startsWith(`${consultationId}::`)) this.lastGeneration.delete(key);
    }
  }

  /**
   * Apply a MACHINE (flush-produced) write.
   *
   * Refuses, in this order: a superseded generation, a LOCKED section, a
   * CONFIRMED section (a flush may not overwrite a clinician), and a deletion
   * with no transcript contradiction to point at.
   */
  async applyFlushPatch(input: SectionWriteInput): Promise<SectionWriteResult> {
    if (!this.repository) return { applied: false, reason: 'unavailable' };

    const address = sectionAddress(input);
    const seen = this.lastGeneration.get(address);
    if (seen !== undefined && input.generation < seen) {
      return { applied: false, reason: 'stale-generation' };
    }

    let section: DocumentSectionEntity | null;
    try {
      section = await this.repository.findSection(input.tenantId, input.consultationId, input.documentKey, input.sectionKey);
    } catch (error) {
      this.logger.warn({ message: 'Section read failed', consultationId: input.consultationId, error: this.reason(error) });
      return { applied: false, reason: 'unavailable' };
    }

    if (section && !section.isWritable()) return { applied: false, reason: 'locked' };
    if (section && !section.machineMayOverwrite()) return { applied: false, reason: 'confirmed-no-overwrite' };

    // A deletion must name what contradicts the removed content. Note the guard is
    // on the TRANSITION (had content -> has none), not on emptiness itself: a
    // section that has always been EMPTY is a normal state and needs no reason.
    const hadContent = Boolean(section && section.revision > 0 && (section.content ?? '').trim().length > 0);
    if (hadContent && input.content.trim().length === 0 && !input.contradiction) {
      return { applied: false, reason: 'deletion-without-contradiction' };
    }

    try {
      if (!section) {
        const created = DocumentSectionFactory.CreateDocumentSection({
          tenantId: input.tenantId,
          consultationId: input.consultationId,
          documentKey: input.documentKey,
          sectionKey: input.sectionKey,
          title: input.title,
          idx: input.idx,
          documentTemplateVersionId: input.documentTemplateVersionId ?? null,
          createdBy: input.userId ?? null,
        });
        created.applyMachineContent(input.content, this.asJson(input.annotations) ?? null, this.asJson(input.provenance) ?? null);
        this.stampContradiction(created, input.contradiction);
        await this.encrypt(created);
        await this.repository.create(created);
        this.lastGeneration.set(address, input.generation);
        return { applied: true, patch: this.toPatch(created, input.consultationId), section: created };
      }

      const expectedVersion = section.version;
      section.title = input.title;
      section.idx = input.idx;
      if (input.documentTemplateVersionId !== undefined) section.documentTemplateVersionId = input.documentTemplateVersionId;
      section.applyMachineContent(input.content, this.asJson(input.annotations) ?? null, this.asJson(input.provenance) ?? null);
      this.stampContradiction(section, input.contradiction);
      await this.encrypt(section);
      await this.repository.updateWithVersion(section.id, section, expectedVersion);
      this.lastGeneration.set(address, input.generation);
      return { applied: true, patch: this.toPatch(section, input.consultationId), section };
    } catch (error) {
      if (error instanceof OptimisticConcurrencyException) {
        // The clinician (or a sibling document's writer) got there first. The flush
        // LOSES — it does not re-read and rewrite, which would defeat the check.
        this.logger.log({
          message: 'Section write lost the compare-and-set — a concurrent edit won',
          consultationId: input.consultationId,
          documentKey: input.documentKey,
          sectionKey: input.sectionKey,
        });
        return { applied: false, reason: 'occ-conflict' };
      }
      this.logger.warn({ message: 'Section write failed', consultationId: input.consultationId, error: this.reason(error) });
      return { applied: false, reason: 'unavailable' };
    }
  }

  /**
   * Apply a CLINICIAN edit — the PROVISIONAL/EMPTY -> CONFIRMED transition.
   *
   * A clinician may edit a section a flush is mid-way through replacing; that is
   * exactly the race per-section OCC exists for. A LOCKED section still refuses.
   */
  async applyClinicianEdit(input: SectionWriteInput): Promise<SectionWriteResult> {
    if (!this.repository) return { applied: false, reason: 'unavailable' };

    let section: DocumentSectionEntity | null;
    try {
      section = await this.repository.findSection(input.tenantId, input.consultationId, input.documentKey, input.sectionKey);
    } catch (error) {
      this.logger.warn({ message: 'Section read failed', consultationId: input.consultationId, error: this.reason(error) });
      return { applied: false, reason: 'unavailable' };
    }

    try {
      if (!section) {
        const created = DocumentSectionFactory.CreateDocumentSection({
          tenantId: input.tenantId,
          consultationId: input.consultationId,
          documentKey: input.documentKey,
          sectionKey: input.sectionKey,
          title: input.title,
          idx: input.idx,
          documentTemplateVersionId: input.documentTemplateVersionId ?? null,
          createdBy: input.userId ?? null,
        });
        created.applyClinicianContent(input.content, input.userId ?? null);
        await this.encrypt(created);
        await this.repository.create(created);
        return { applied: true, patch: this.toPatch(created, input.consultationId), section: created };
      }

      if (!section.isWritable()) return { applied: false, reason: 'locked' };

      const expectedVersion = section.version;
      section.applyClinicianContent(input.content, input.userId ?? null);
      await this.encrypt(section);
      await this.repository.updateWithVersion(section.id, section, expectedVersion);
      return { applied: true, patch: this.toPatch(section, input.consultationId), section };
    } catch (error) {
      if (error instanceof OptimisticConcurrencyException) return { applied: false, reason: 'occ-conflict' };
      this.logger.warn({ message: 'Clinician section write failed', consultationId: input.consultationId, error: this.reason(error) });
      return { applied: false, reason: 'unavailable' };
    }
  }

  /** The `section.patch` event for one section — the SSE wire shape (§2b). */
  toPatch(section: DocumentSectionEntity, consultationId: string): SectionPatchDto {
    return {
      event: 'section.patch',
      consultationId,
      documentKey: section.documentKey,
      sectionKey: section.sectionKey,
      title: section.title,
      idx: section.idx,
      revision: section.revision,
      state: STATE_WIRE[section.state],
      content: section.content ?? '',
      ...(section.annotations ? { annotations: section.annotations as unknown as SectionAnnotationDto[] } : {}),
      ...(section.provenance ? { provenance: section.provenance as unknown as SectionProvenanceDto[] } : {}),
      documentTemplateVersionId: section.documentTemplateVersionId ?? null,
      updatedAt: new Date().toISOString(),
    };
  }

  private stampContradiction(section: DocumentSectionEntity, contradiction?: TranscriptContradiction | null): void {
    if (!contradiction) return;
    // Recorded on `_metadata` rather than a column: it explains ONE transition, so
    // it belongs with the row's history, not in its shape.
    section.metaData = { ...((section.metaData as Record<string, unknown> | null) ?? {}), lastDeletion: { ...contradiction, at: new Date().toISOString() } };
  }

  /**
   * The DTO arrays are structurally JSON already; this is the single, named
   * place the cast happens rather than sprinkling `as never` at each call site.
   */
  private asJson(value: SectionAnnotationDto[] | SectionProvenanceDto[] | undefined): JsonValue | undefined {
    return value === undefined ? undefined : (value as unknown as JsonValue);
  }

  private async encrypt(section: DocumentSectionEntity): Promise<void> {
    if (!this.repository || !this.secrets) return;
    try {
      await this.repository.encryptContentIntoEntity(section, this.secrets);
    } catch (error) {
      // Mirrors `encryptPhiFields`: a dev/test path with no Vault must not lose the
      // write, but a PRODUCTION encryptor failing is loud.
      this.logger.warn({ message: 'Section content encryption failed', error: this.reason(error) });
    }
  }

  private reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
