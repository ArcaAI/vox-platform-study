/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * TASK-811 (OD-7) — one section of one clinical document being generated for a
 * consultation. `(consultationId, documentKey, sectionKey)` is its identity.
 *
 * INTENTIONAL posture (mirrors TranscriptSegment, differs from the standard
 * clinical models):
 *   - NO soft-delete: listed in MODELS_WITHOUT_SOFT_DELETE, no `resourceStatus`
 *     column, so `softDelete()`/`restore()` throw for this repository. Sections
 *     live and die with their consultation's document; emptying one is a
 *     CONTENT update under the state machine, never a row delete.
 *   - PHI-CARRYING, unlike TranscriptSegment: a section's prose is generated and
 *     exists nowhere else, so it is stored here as Vault-Transit ciphertext
 *     following the `ContextItem.encryptedContent` pattern. `content` is the
 *     TRANSIENT plaintext (no column) that `encryptContentIntoEntity` reads.
 *
 * `_version` is the per-SECTION optimistic-concurrency token — the whole reason
 * this is a table rather than JSON on a single blob. "A CONFIRMED section is
 * never overwritten by a flush" is only enforceable when each section carries
 * its own version, so a flush and a clinician edit contend per section instead
 * of every writer contending with every other.
 */
export interface IDocumentSectionEntity extends IBaseTenantEntity {
  consultationId: string;
  /** The tenant's `DocumentTemplate.slug` — WHICH document this section belongs to. */
  documentKey: string;
  /** The compiled template's section key — WHICH section within that document. */
  sectionKey: string;
  title: string;
  /** 0-based render ordinal within the document. */
  idx: number;
  state: Enums.DocumentSectionState;
  /** Monotonic per-section revision, advanced by every accepted write. */
  revision: number;
  /** TRANSIENT plaintext (no column) — encrypted into `encryptedContent` before persistence. */
  content?: string | null;
  encryptedContent?: Buffer | null;
  contentKeyVersion?: number | null;
  /** Section-LOCAL annotation spans (entities / groundedness / flagged spans). */
  annotations?: JsonValue | null;
  /** Provenance anchors back to the transcript segments this section was derived from. */
  provenance?: JsonValue | null;
  documentTemplateVersionId?: string | null;
  confirmedAt?: Date | null;
  confirmedBy?: string | null;
  lockedAt?: Date | null;
  Consultation?: Entities.ConsultationEntity | null;
}

export class DocumentSectionEntity extends BaseTenantEntity {
  private _consultationId: IDocumentSectionEntity['consultationId'];
  private _documentKey: IDocumentSectionEntity['documentKey'];
  private _sectionKey: IDocumentSectionEntity['sectionKey'];
  private _title: IDocumentSectionEntity['title'];
  private _idx: IDocumentSectionEntity['idx'];
  private _state: IDocumentSectionEntity['state'];
  private _revision: IDocumentSectionEntity['revision'];
  private _content?: IDocumentSectionEntity['content'];
  private _encryptedContent?: IDocumentSectionEntity['encryptedContent'];
  private _contentKeyVersion?: IDocumentSectionEntity['contentKeyVersion'];
  private _annotations?: IDocumentSectionEntity['annotations'];
  private _provenance?: IDocumentSectionEntity['provenance'];
  private _documentTemplateVersionId?: IDocumentSectionEntity['documentTemplateVersionId'];
  private _confirmedAt?: IDocumentSectionEntity['confirmedAt'];
  private _confirmedBy?: IDocumentSectionEntity['confirmedBy'];
  private _lockedAt?: IDocumentSectionEntity['lockedAt'];
  private _Consultation?: IDocumentSectionEntity['Consultation'];

  constructor(init: IDocumentSectionEntity) {
    super(init);
    this._consultationId = init.consultationId;
    this._documentKey = init.documentKey;
    this._sectionKey = init.sectionKey;
    this._title = init.title;
    this._idx = init.idx;
    this._state = init.state;
    this._revision = init.revision;
    this._content = init.content;
    this._encryptedContent = init.encryptedContent;
    this._contentKeyVersion = init.contentKeyVersion;
    this._annotations = init.annotations;
    this._provenance = init.provenance;
    this._documentTemplateVersionId = init.documentTemplateVersionId;
    this._confirmedAt = init.confirmedAt;
    this._confirmedBy = init.confirmedBy;
    this._lockedAt = init.lockedAt;
    this._Consultation = init.Consultation;
  }

  get consultationId(): IDocumentSectionEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IDocumentSectionEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get documentKey(): IDocumentSectionEntity['documentKey'] {
    return this._documentKey;
  }

  set documentKey(value: IDocumentSectionEntity['documentKey']) {
    this.setProperty('documentKey', value);
  }

  get sectionKey(): IDocumentSectionEntity['sectionKey'] {
    return this._sectionKey;
  }

  set sectionKey(value: IDocumentSectionEntity['sectionKey']) {
    this.setProperty('sectionKey', value);
  }

  get title(): IDocumentSectionEntity['title'] {
    return this._title;
  }

  set title(value: IDocumentSectionEntity['title']) {
    this.setProperty('title', value);
  }

  get idx(): IDocumentSectionEntity['idx'] {
    return this._idx;
  }

  set idx(value: IDocumentSectionEntity['idx']) {
    this.setProperty('idx', value);
  }

  get state(): IDocumentSectionEntity['state'] {
    return this._state;
  }

  set state(value: IDocumentSectionEntity['state']) {
    this.setProperty('state', value);
  }

  get revision(): IDocumentSectionEntity['revision'] {
    return this._revision;
  }

  set revision(value: IDocumentSectionEntity['revision']) {
    this.setProperty('revision', value);
  }

  /**
   * Generated section prose. `@Secret()` marks it for redaction in logs /
   * `toObject()` telemetry — the same treatment `ContextItem.content` gets.
   * TRANSIENT: there is no plaintext column; the persisted form is
   * `encryptedContent`.
   */
  @Secret()
  get content(): IDocumentSectionEntity['content'] {
    return this._content;
  }

  set content(value: IDocumentSectionEntity['content']) {
    this.setProperty('content', value);
  }

  /** Vault-Transit (`hope-phi`) ciphertext of `content`. */
  @Secret()
  get encryptedContent(): IDocumentSectionEntity['encryptedContent'] {
    return this._encryptedContent;
  }

  set encryptedContent(value: IDocumentSectionEntity['encryptedContent']) {
    this.setProperty('encryptedContent', value);
  }

  get contentKeyVersion(): IDocumentSectionEntity['contentKeyVersion'] {
    return this._contentKeyVersion;
  }

  set contentKeyVersion(value: IDocumentSectionEntity['contentKeyVersion']) {
    this.setProperty('contentKeyVersion', value);
  }

  get annotations(): IDocumentSectionEntity['annotations'] {
    return this._annotations;
  }

  set annotations(value: IDocumentSectionEntity['annotations']) {
    this.setProperty('annotations', value);
  }

  get provenance(): IDocumentSectionEntity['provenance'] {
    return this._provenance;
  }

  set provenance(value: IDocumentSectionEntity['provenance']) {
    this.setProperty('provenance', value);
  }

  get documentTemplateVersionId(): IDocumentSectionEntity['documentTemplateVersionId'] {
    return this._documentTemplateVersionId;
  }

  set documentTemplateVersionId(value: IDocumentSectionEntity['documentTemplateVersionId']) {
    this.setProperty('documentTemplateVersionId', value);
  }

  get confirmedAt(): IDocumentSectionEntity['confirmedAt'] {
    return this._confirmedAt;
  }

  set confirmedAt(value: IDocumentSectionEntity['confirmedAt']) {
    this.setProperty('confirmedAt', value);
  }

  get confirmedBy(): IDocumentSectionEntity['confirmedBy'] {
    return this._confirmedBy;
  }

  set confirmedBy(value: IDocumentSectionEntity['confirmedBy']) {
    this.setProperty('confirmedBy', value);
  }

  get lockedAt(): IDocumentSectionEntity['lockedAt'] {
    return this._lockedAt;
  }

  set lockedAt(value: IDocumentSectionEntity['lockedAt']) {
    this.setProperty('lockedAt', value);
  }

  get Consultation(): IDocumentSectionEntity['Consultation'] {
    return this._Consultation;
  }

  set Consultation(value: IDocumentSectionEntity['Consultation']) {
    this.setProperty('Consultation', value);
  }

  // ---------------------------------------------------------------------------
  // The section state machine (§2d)
  // ---------------------------------------------------------------------------

  /**
   * A flush may replace this section's content outright.
   *
   * TRUE only for EMPTY and PROVISIONAL. A CONFIRMED section has been touched by
   * a clinician, so a flush may APPEND to it but must never overwrite it; a
   * LOCKED section rejects every write.
   */
  public machineMayOverwrite(): boolean {
    return this._state === Enums.DocumentSectionState.EMPTY || this._state === Enums.DocumentSectionState.PROVISIONAL;
  }

  /** No writer of any kind may touch a LOCKED section. */
  public isWritable(): boolean {
    return this._state !== Enums.DocumentSectionState.LOCKED;
  }

  /** Machine write: content produced by a flush. Advances the revision. */
  public applyMachineContent(content: string, annotations?: JsonValue | null, provenance?: JsonValue | null): void {
    this.content = content;
    if (annotations !== undefined) this.annotations = annotations;
    if (provenance !== undefined) this.provenance = provenance;
    this.revision = this._revision + 1;
    // A machine write never demotes a CONFIRMED section back to PROVISIONAL —
    // the clinician's touch is the higher authority and survives the append.
    if (this._state === Enums.DocumentSectionState.EMPTY) {
      this.state = Enums.DocumentSectionState.PROVISIONAL;
    }
  }

  /** Clinician write: the PROVISIONAL/EMPTY -> CONFIRMED transition. */
  public applyClinicianContent(content: string, userId?: string | null, at?: Date): void {
    this.content = content;
    this.revision = this._revision + 1;
    this.state = Enums.DocumentSectionState.CONFIRMED;
    this.confirmedAt = at ?? new Date();
    this.confirmedBy = userId ?? null;
  }

  /** Endpoint finalization. Terminal: nothing may write afterwards. */
  public lock(at?: Date): void {
    this.state = Enums.DocumentSectionState.LOCKED;
    this.lockedAt = at ?? new Date();
  }

  public override validate(): void {
    super.validate();
    if (!this._consultationId || this._consultationId.trim().length === 0) {
      throw new BusinessException('DocumentSection consultationId is required.');
    }
    if (!this._documentKey || this._documentKey.trim().length === 0) {
      throw new BusinessException('DocumentSection documentKey is required.');
    }
    if (!this._sectionKey || this._sectionKey.trim().length === 0) {
      throw new BusinessException('DocumentSection sectionKey is required.');
    }
    if (this._idx === undefined || this._idx === null || this._idx < 0) {
      throw new BusinessException('DocumentSection idx must be a non-negative integer.');
    }
    if (this._revision === undefined || this._revision === null || this._revision < 0) {
      throw new BusinessException('DocumentSection revision must be a non-negative integer.');
    }
  }
}
