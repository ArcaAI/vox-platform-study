/**
 *  — per-section writes, with the state machine and the OCC that
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
 * A deletion reason.: "a later flush removing content must point at a
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

/**
 * How a flush means its `content`.
 *
 * TASK-939 — `replace` is the original behaviour and still the only way a section's existing text
 * can change. `append` means "`content` is the NEW PART, add it": the prior body is carried
 * forward byte-for-byte, which is what makes it legitimate on a CONFIRMED section (an append
 * cannot destroy what the clinician wrote) and what makes a turn's cost proportional to what was
 * actually said rather than to the whole note.
 *
 * Default is `replace`, so every pre-existing caller keeps its semantics unchanged.
 */
export type SectionWriteMode = 'replace' | 'append';

export interface SectionWriteInput {
  readonly consultationId: string;
  readonly tenantId: string;
  readonly documentKey: string;
  readonly sectionKey: string;
  readonly title: string;
  readonly idx: number;
  /** The whole new body when `mode` is `replace`; the NEW PART ONLY when `mode` is `append`. */
  readonly content: string;
  /** @see SectionWriteMode — absent ⇒ `replace`. */
  readonly mode?: SectionWriteMode;
  readonly annotations?: SectionAnnotationDto[];
  readonly provenance?: SectionProvenanceDto[];
  readonly documentTemplateVersionId?: string | null;
  /** The flush generation that produced this content — the staleness token. */
  readonly generation: number;
  /** Required when the write EMPTIES a section that had content. */
  readonly contradiction?: TranscriptContradiction | null;
  readonly userId?: string | null;
  /**
   * The `_version` the CALLER read, when the caller has one — the compare-and-set
   * operand for `applyClinicianEdit`.
   *
   * Without it the edit path re-reads the row and compare-and-sets against the
   * version it JUST read, which is a read-modify-write, not a precondition: the
   * check can only ever pass. That is sound for an in-process writer with no
   * opinion about what it is replacing, and wrong for an HTTP client holding an
   * `If-Match` from an earlier read — such a client must LOSE to a flush that
   * landed in between, and with a self-read operand it would silently win.
   *
   * Absent ⇒ the previous read-modify-write behaviour, unchanged. Only
   * `applyClinicianEdit` consults it; a flush's staleness token is `generation`.
   */
  readonly expectedVersion?: number;
}

export type SectionWriteRefusal =
  | 'locked'
  | 'confirmed-no-overwrite'
  | 'deletion-without-contradiction'
  /** TASK-939 — an `append` whose new part was empty. Not a failure; there was simply nothing to add. */
  | 'nothing-to-append'
  | 'stale-generation'
  | 'occ-conflict'
  | 'unavailable';

export type SectionWriteResult =
  | { readonly applied: true; readonly patch: SectionPatchDto; readonly section: DocumentSectionEntity }
  | {
      readonly applied: false;
      readonly reason: SectionWriteRefusal;
      /**
       * TASK-939 R10 — the section's AUTHORITATIVE body, when the refusal was
       * `confirmed-no-overwrite`.
       *
       * The row was already read to reach that verdict, so returning it costs nothing and closes a
       * real defect: the flush's own `lastPayload` is what the NEXT turn's prompt is built from, and
       * it carried the MACHINE's version of a section the clinician had since rewritten. The model
       * was therefore shown its own superseded text and kept re-proposing over the clinician's
       * edit — the DB row was protected while the conversation with the model was not.
       */
      readonly current?: string;
    };

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

  /**
   * TASK-939 R9 — read one document's PERSISTED sections back, in the template's authored order.
   *
   * A `LiveSession` is an in-process object: `stop()` deletes it, a lost owner lock tears it down,
   * and a pod restart or an ownership handoff starts a new one with `lastPayload` undefined. The
   * next flush then saw an EMPTY prior note and `buildTextUserPrompt` switched to its first-turn
   * instruction — so a second recording segment, or a reconnect after a restart, silently RESTARTED
   * the note instead of continuing it. Nothing in the service read the persisted note back:
   * `findLiveSnapshotRow` deliberately touches only `_metadata`.
   *
   * The `DocumentSection` rows are the right source rather than the durable blob, because they are
   * what the turn contract folds onto AND they carry the clinician's confirmed text.
   *
   * `null` means "nothing to resume" — no repository, no rows, or a read that failed. Never throws:
   * this sits on the live flush path and a failed resume must degrade to today's behaviour (a fresh
   * note) rather than failing the flush.
   */
  async readDocument(
    tenantId: string,
    consultationId: string,
    documentKey: string,
    order: readonly { readonly key: string; readonly title: string }[],
  ): Promise<{ title: string; content: string }[] | null> {
    if (!this.repository) return null;
    try {
      const rows = await this.repository.findByDocument(tenantId, consultationId, documentKey);
      if (rows.length === 0) return null;

      const byKey = new Map(rows.map((row) => [row.sectionKey, row]));
      const sections: { title: string; content: string }[] = [];
      for (const entry of order) {
        const row = byKey.get(entry.key);
        // `content` has no column — `encryptedContent` is the only persisted form — so a row read
        // back out of the database carries no body until it is decrypted.
        const content = row ? ((await this.decrypt(row)) ?? row.content ?? '') : '';
        sections.push({ title: row?.title ?? entry.title, content });
      }
      return sections;
    } catch (error) {
      this.logger.warn({ message: 'Section resume read failed', consultationId, error: this.reason(error) });
      return null;
    }
  }

  /** Decrypt a row's body when an encryptor is wired; plaintext fixtures pass through. */
  private async decrypt(section: DocumentSectionEntity): Promise<string | null> {
    if (!this.repository || !this.secrets) return null;
    return this.repository.decryptContentFromEntity(section, this.secrets);
  }

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
   *
   * TASK-939 — the last two apply to a `replace` ONLY. An `append` (`mode: 'append'`, where
   * `content` is the new part rather than the whole body) is refused only by LOCKED and by having
   * nothing to add, because it cannot destroy prior text: that is the distinction this class has
   * documented since it was written ("a flush may APPEND to it but must never overwrite it") and
   * did not have.
   */
  async applyFlushPatch(input: SectionWriteInput): Promise<SectionWriteResult> {
    if (!this.repository) return { applied: false, reason: 'unavailable' };

    const appending = input.mode === 'append';
    // Checked BEFORE the row read: an append with nothing in it needs no I/O to answer, and
    // answering it early keeps the generation watermark from advancing on a turn that wrote
    // nothing — a later real append for the same generation must not then look stale.
    if (appending && input.content.trim().length === 0) {
      return { applied: false, reason: 'nothing-to-append' };
    }

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
    // REPLACE only. An append leaves the clinician's text in place, so there is nothing here for
    // this guard to protect — see the method doc.
    if (!appending && section && !section.machineMayOverwrite()) {
      return { applied: false, reason: 'confirmed-no-overwrite', current: section.content ?? '' };
    }

    // A deletion must name what contradicts the removed content. Note the guard is
    // on the TRANSITION (had content -> has none), not on emptiness itself: a
    // section that has always been EMPTY is a normal state and needs no reason.
    //
    // Also REPLACE only: an append can never empty a section, and an append with nothing in it
    // was already answered as `nothing-to-append` above — which is a turn with nothing to say,
    // not a removal, and so needs no justification.
    const hadContent = Boolean(section && section.revision > 0 && (section.content ?? '').trim().length > 0);
    if (!appending && hadContent && input.content.trim().length === 0 && !input.contradiction) {
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
        if (appending) created.appendMachineContent(input.content, this.asJson(input.annotations) ?? null, this.asJson(input.provenance) ?? null);
        else created.applyMachineContent(input.content, this.asJson(input.annotations) ?? null, this.asJson(input.provenance) ?? null);
        this.stampContradiction(created, input.contradiction);
        await this.encrypt(created);
        await this.repository.create(created);
        this.lastGeneration.set(address, input.generation);
        return { applied: true, patch: this.toPatch(created, input.consultationId, appending ? input.content.trim() : undefined), section: created };
      }

      const expectedVersion = section.version;
      section.title = input.title;
      section.idx = input.idx;
      if (input.documentTemplateVersionId !== undefined) section.documentTemplateVersionId = input.documentTemplateVersionId;
      if (appending) section.appendMachineContent(input.content, this.asJson(input.annotations) ?? null, this.asJson(input.provenance) ?? null);
      else section.applyMachineContent(input.content, this.asJson(input.annotations) ?? null, this.asJson(input.provenance) ?? null);
      this.stampContradiction(section, input.contradiction);
      await this.encrypt(section);
      await this.repository.updateWithVersion(section.id, section, expectedVersion);
      this.lastGeneration.set(address, input.generation);
      return { applied: true, patch: this.toPatch(section, input.consultationId, appending ? input.content.trim() : undefined), section };
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

      // The CALLER's operand when it has one (an HTTP `If-Match`), else the row
      // we just read. See `SectionWriteInput.expectedVersion`: a self-read operand
      // is a check that cannot fail, which is precisely what a client editing from
      // a stale render must not get.
      const expectedVersion = input.expectedVersion ?? section.version;
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

  /**
   * The `section.patch` event for one section — the SSE wire shape.
   *
   * `appended` (TASK-939) is present only on an append and carries just the new part. `content`
   * stays the WHOLE body on every patch, so a consumer that knows nothing about appends — the
   * published `@arcaai/vox-node` `onSectionPatch`, the browser SDK, the console's revision-gated
   * fold — behaves exactly as before. A renderer that wants to mark what just arrived now can.
   */
  toPatch(section: DocumentSectionEntity, consultationId: string, appended?: string): SectionPatchDto {
    return {
      ...(appended ? { appended } : {}),
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
    section.metaData = {
      ...((section.metaData as Record<string, unknown> | null) ?? {}),
      lastDeletion: { ...contradiction, at: new Date().toISOString() },
    };
  }

  /**
   * The DTO arrays are structurally JSON already; this is the single, named
   * place the cast happens rather than sprinkling `as never` at each call site.
   */
  private asJson(value: SectionAnnotationDto[] | SectionProvenanceDto[] | undefined): JsonValue | undefined {
    return value === undefined ? undefined : (value as unknown as JsonValue);
  }

  /**
   * Encrypt the transient plaintext into `encryptedContent` before persistence.
   *
   * THIS MUST NOT CATCH. `content` has no column: `encryptedContent`
   * is the only persisted form of the body, while `revision`, `state`,
   * `confirmedAt`/`confirmedBy` and `_version` are real columns that both
   * `applyMachineContent` and `applyClinicianContent` have ALREADY moved by the
   * time we get here. So swallowing a failure does not "lose the encryption" —
   * it commits the state transition and the bumped revision on top of the
   * PREVIOUS ciphertext (or, on the create branch, a permanently NULL body) and
   * answers the clinician 200. The write must be abandoned instead.
   *
   * Both callers' catch blocks turn the throw into `unavailable`, which is a 503
   * on the clinician route and publishes no `section.patch` on the flush lane.
   * Secrets are `failMode: closed` (`09-infrastructure-devops.md` §Configuration
   * Tiers); this is that policy applied to the one field it protects.
   *
   * An ABSENT encryptor is still not a failure — unit fixtures and dev paths run
   * without Vault, and there is nothing to encrypt or lose there.
   */
  private async encrypt(section: DocumentSectionEntity): Promise<void> {
    if (!this.repository || !this.secrets) return;
    await this.repository.encryptContentIntoEntity(section, this.secrets);
  }

  private reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
