/** What a verified attachment hands its kind's processor. Object location and ids only — no file name. */
export interface AttachmentProcessInput {
  consultationId: string;
  attachmentId: string;
  mediaId: string;
  bucket: string;
  key: string;
  /** Normalised declared MIME type (already sniffed against the bytes). */
  mime: string;
  /** The consultation's doctor: the clinical owner of anything the attachment produces. */
  doctorId?: string | null;
  /** The whole body, when the service already holds it (case notes). */
  body?: Buffer;
  /** The encounter the attachment belongs to; stamped on the item it produces. */
  encounterSeq?: number | null;
}

export interface AttachmentProcessOutcome {
  /** `true` when the result arrives later (the row stays PROCESSING). */
  pending: boolean;
  contextItemId: string | null;
  transcriptionJobId?: string;
}

/** The slice of `ContextItemRepository` the encounter stamp needs. */
export interface ContextItemEncounterWriter {
  findByIdOrNull(id: string): Promise<{ encounterSeq?: number | null } | null>;
  update(id: string, entity: never): Promise<unknown>;
}

/**
 * Put the item on its encounter. `addContext` takes no encounter, and the fact ledger selects an
 * encounter's attachment inputs by the item's `encounterSeq` column, so the stamp is written right
 * after the item exists (a tracked single-column update).
 */
export async function stampEncounterSeq(
  items: ContextItemEncounterWriter,
  contextItemId: string,
  encounterSeq: number | null | undefined,
): Promise<void> {
  if (typeof encounterSeq !== 'number') return;
  const item = await items.findByIdOrNull(contextItemId);
  if (!item || item.encounterSeq === encounterSeq) return;
  item.encounterSeq = encounterSeq;
  await items.update(contextItemId, item as never);
}
