import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { DocumentSectionEntity, DocumentSectionRepository, ResourceType, SysEventType } from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { DocumentSectionStore, type SectionWriteRefusal } from '../live-documentation/realtime/section-store';
import { IDocumentSectionService } from './IDocumentSectionService';
import { DocumentSectionDtoMapper } from './document-section.dto.mapper';
import { DocumentSectionResponse, UpdateDocumentSectionRequest } from './dto';

/**
 * The REST half of the `DocumentSection` state machine — the clinician writer.
 *
 * ## Why this exists
 *
 * gave sections per-section OCC and a four-state machine, and wired the
 * MACHINE writer (`LiveDocumentationService.publishSectionPatches` ->
 * `DocumentSectionStore.applyFlushPatch`). The CLINICIAN writer was left to
 * " or the console lane" ( follow-up 3), never picked
 * it up, and declined it explicitly ("no section-level mutation
 * endpoint exists yet"). So `applyClinicianEdit` had test call sites and nothing
 * else, and a clinician could not persist an edit at all.
 *
 * This service is that missing caller. It adds NO new write path into
 * `DocumentSection`: it delegates to the same store, whose refusals it translates
 * into the HTTP semantics each one actually means.
 *
 * ## The four outcomes, and why each is the status it is
 *
 * | Store result | HTTP | Reason |
 * |---|---|---|
 * | section absent | **404** | Also the cross-tenant answer — `findSection` filters by `tenantId`, so a foreign section is indistinguishable from a missing one. 404-over-403, deliberately |
 * | `locked` | **409** | The endpoint finalized this encounter ( locks EVERY document). The request is well-formed and the precondition is fresh; the RESOURCE is in a state that refuses writes. That is a conflict, not a failed precondition — a client that retries with a newer `If-Match` still fails, so 412 would send it into a retry loop it can never leave |
 * | `occ-conflict` | **412** | The section moved under the client. Re-read and re-apply |
 * | `unavailable` | **503** | Persistence is down. The store never pretends a write happened |
 *
 * ## The compare-and-set is the CLIENT's, not ours
 *
 * `applyClinicianEdit` used to compare-and-set against the version it had just
 * read itself — sound for an in-process writer, but a check that cannot fail. An
 * HTTP client holds an `If-Match` from an EARLIER read and must lose to any flush
 * that landed in between, so the client's version is threaded through as the CAS
 * operand (`SectionWriteInput.expectedVersion`). Without that, the `If-Match` on
 * this route would be decorative.
 *
 * ## PHI
 *
 * Section content is Vault-Transit ciphertext with no plaintext column. Reads
 * decrypt on the fly; the edit path already holds the plaintext it was handed and
 * echoes that rather than decrypting its own write. Content is never logged, and
 * never appears in a sys-event payload.
 */
@Injectable()
export class DocumentSectionService extends BaseService implements IDocumentSectionService {
  private readonly logger = new Logger(DocumentSectionService.name);
  private store?: DocumentSectionStore;

  constructor(
    private readonly documentSectionRepository: DocumentSectionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Vault-Transit PHI encryptor. Optional + @Inject so direct-construction
    // tests still build; ABSENT ⇒ the store skips encryption exactly as it does
    // on the flush path, and reads surface no content rather than plaintext.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    // `ResourceType.Consultation`, not a DocumentSection member — there is none,
    // and `finalizeDocuments` (the LOCK half of this same state
    // machine) already reports section transitions against the parent
    // consultation. Adding a `DocumentSection` enum member would need matching
    // `ALTER TYPE` migrations in `audit.prisma` and the domain enum; the parent
    // resource is the honest audit subject anyway, since a section has no
    // independent lifecycle.
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  /** Per-section store, built on first use — mirrors `LiveDocumentationService.sections()`. */
  private sections(): DocumentSectionStore {
    this.store ??= new DocumentSectionStore(this.documentSectionRepository, this.secretsService);
    return this.store;
  }

  async listSections(consultationId: string, documentKey: string): Promise<DocumentSectionResponse[]> {
    return this.toResponses(await this.documentSectionRepository.findByDocument(this.tenantId, consultationId, documentKey));
  }

  /**
   * Every section of EVERY document of the consultation — the DISCOVERY read.
   *
   * `listSections` above requires the caller to already know a `documentKey`, and
   * nothing else in the API surface can enumerate them. A client that reloads
   * mid-encounter therefore had no way to ask what documents this consultation
   * has: the durable view existed but was unreachable until a `section.patch`
   * happened to name a key, which is exactly the window the SSE lane does not
   * cover (it only emits while a flush is running). This read closes that:
   * one request, no discover-then-fetch waterfall, and the same
   * `DocumentSectionResponse` items `listSections` returns.
   *
   * Order is `(documentKey, idx)` — alphabetical by document, render order within
   * it. Deliberately NOT "the order a stream happened to mention them in": a cold
   * read has no stream to inherit an order from, and a deterministic one is what
   * makes two clients hydrating the same encounter render it the same way.
   */
  async listAllSections(consultationId: string): Promise<DocumentSectionResponse[]> {
    return this.toResponses(await this.documentSectionRepository.findByConsultation(this.tenantId, consultationId));
  }

  /** Decrypt-and-map a read result. Shared by both list reads, which differ only in their query. */
  private toResponses(sections: DocumentSectionEntity[]): Promise<DocumentSectionResponse[]> {
    return Promise.all(sections.map(async (section) => DocumentSectionDtoMapper.toResponse(section, await this.plaintext(section))));
  }

  async getSection(consultationId: string, documentKey: string, sectionKey: string): Promise<DocumentSectionResponse> {
    const section = await this.requireSection(consultationId, documentKey, sectionKey);
    return DocumentSectionDtoMapper.toResponse(section, await this.plaintext(section));
  }

  /**
   * Persist a clinician's edit — the `PROVISIONAL`/`EMPTY` -> `CONFIRMED` transition.
   *
   * A section that does not exist is a 404 and is never created here, unlike
   * `applyClinicianEdit`'s own create-on-miss branch. That branch is right for the
   * flush lane, which legitimately materializes a section the template declares;
   * it is wrong for an OCC-gated route, where a client cannot possess an `If-Match`
   * for a row that has never existed, and where a mistyped `sectionKey` would
   * otherwise silently create a section belonging to no template.
   */
  async updateSectionContent(
    consultationId: string,
    documentKey: string,
    sectionKey: string,
    request: UpdateDocumentSectionRequest,
  ): Promise<DocumentSectionResponse> {
    const expectedVersion = request.expectedVersion;
    if (expectedVersion === undefined) {
      // Unreachable through the gateway (`@RequiresIfMatch()` returns 428 first);
      // defense in depth for any other caller of this service.
      throw new ArgumentInvalidException('An expected version is required to edit a document section.');
    }

    const tenantId = this.tenantId;
    const section = await this.requireSection(consultationId, documentKey, sectionKey);

    // Checked BEFORE the compare-and-set so a finalized encounter answers 409
    // rather than 412: the client's precondition may be perfectly fresh, and
    // telling it to re-read and retry would be a lie — no version of a LOCKED
    // section is writable.
    if (!section.isWritable()) {
      throw new ConflictException(`Section ${sectionKey} of document ${documentKey} is locked and can no longer be edited.`);
    }

    // A fast, accurate 412: the store swallows the OCC exception into a refusal
    // reason, so raising it here is what carries `currentVersion` into the error
    // body the SDK conflict handler and the UI conflict modal read.
    if (section.version !== expectedVersion) {
      throw new OptimisticConcurrencyException('DocumentSection', section.id, { expectedVersion, currentVersion: section.version });
    }

    const result = await this.sections().applyClinicianEdit({
      consultationId,
      tenantId,
      documentKey,
      sectionKey,
      title: section.title,
      idx: section.idx,
      content: request.content,
      documentTemplateVersionId: section.documentTemplateVersionId,
      // The clinician lane has no flush generation. `generation` orders MACHINE
      // writes against each other and is only read by `applyFlushPatch`.
      generation: 0,
      expectedVersion,
      userId: this.requestUserId ?? null,
    });

    if (result.applied !== true) {
      throw this.refusalToHttp(result.reason, section, expectedVersion);
    }

    // Re-read rather than trusting the in-memory entity: `applyClinicianEdit`
    // discards what `updateWithVersion` returns, so the object it hands back still
    // carries the PRE-write `_version` and `updatedAt` (both database-owned). A
    // client that echoed that stale version as its next `If-Match` would 412 on
    // its own successful edit.
    const persisted = await this.requireSection(consultationId, documentKey, sectionKey);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: consultationId,
      resourceType: ResourceType.Consultation,
      // Identity and state transition only — never the section body.
      data: {
        sectionEdit: {
          documentKey,
          sectionKey,
          revision: persisted.revision,
          previousVersion: expectedVersion,
          newVersion: persisted.version,
        },
      },
    });

    // The plaintext we were handed, not a decrypt of our own write: one fewer
    // Vault round-trip, and it does not report an empty body on a dev/test path
    // where no encryptor is wired.
    return DocumentSectionDtoMapper.toResponse(persisted, request.content);
  }

  /**
   * Fetch one section or 404.
   *
   * `findSection` is tenant-filtered, so a section belonging to another tenant
   * returns null here and becomes the SAME 404 a genuinely missing one does —
   * the 404-over-403 posture, which is what stops the response confirming that a
   * foreign consultation's section exists.
   */
  private async requireSection(consultationId: string, documentKey: string, sectionKey: string): Promise<DocumentSectionEntity> {
    const section = await this.documentSectionRepository.findSection(this.tenantId, consultationId, documentKey, sectionKey);
    if (!section) {
      throw new NotFoundException(`Section ${sectionKey} of document ${documentKey} was not found for consultation ${consultationId}.`);
    }
    return section;
  }

  /**
   * Decrypt a persisted section body. Returns `''` — never a partial or a
   * placeholder — when there is no encryptor wired or the row has no content yet,
   * because `state` already distinguishes "nothing written" from "written and
   * unreadable" and a fabricated body would be worse than an empty one.
   */
  private async plaintext(section: DocumentSectionEntity): Promise<string> {
    if (!this.secretsService || !section.encryptedContent) return '';
    try {
      return (await this.documentSectionRepository.decryptContentFromEntity(section, this.secretsService)) ?? '';
    } catch (error) {
      // PHI-safe: the failure, never the ciphertext or any fragment of the body.
      this.logger.warn({
        message: 'Section content could not be decrypted',
        consultationId: section.consultationId,
        documentKey: section.documentKey,
        sectionKey: section.sectionKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    }
  }

  /** Translate a store refusal into the status it actually means (see the class doc). */
  private refusalToHttp(reason: SectionWriteRefusal, section: DocumentSectionEntity, expectedVersion: number): Error {
    switch (reason) {
      case 'locked':
        // Re-checked above, but the store re-reads the row: a finalize can land
        // between our read and its write.
        return new ConflictException(`Section ${section.sectionKey} of document ${section.documentKey} is locked and can no longer be edited.`);
      case 'occ-conflict':
        // Lost the race between our version check and the store's write.
        // `currentVersion` is our last known reading; the client re-reads anyway.
        return new OptimisticConcurrencyException('DocumentSection', section.id, { expectedVersion, currentVersion: section.version });
      case 'unavailable':
        return new ServiceUnavailableException('Section persistence is unavailable.');
      default:
        // `stale-generation`, `confirmed-no-overwrite` and
        // `deletion-without-contradiction` are FLUSH refusals — `applyClinicianEdit`
        // evaluates none of them, by design: a clinician outranks a generation
        // counter, outranks their own earlier confirmation, and does not owe the
        // transcript a reason for deleting their own text. Reaching this arm means
        // the store grew a refusal the clinician lane does not model.
        this.logger.error({
          message: 'Unexpected section-write refusal on the clinician lane',
          consultationId: section.consultationId,
          documentKey: section.documentKey,
          sectionKey: section.sectionKey,
          reason,
        });
        return new ServiceUnavailableException('The section edit could not be applied.');
    }
  }
}
