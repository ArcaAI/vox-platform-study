/**
 * Seam from the feedback-mining loop to the eval-gate curation queue.
 *
 * A mined feedback exemplar is a PENDING proposal; the eval-gate programme may
 * want to be told one exists so it can queue it for SME review. A port, so the
 * miner depends on neither the eval service nor its transport, and the default
 * ({@link NoopEvalGateCurationSink}) lets a deployment with no curation
 * consumer mine exactly as before.
 *
 * The payload is ids and kinds only — the redacted text stays in the exemplar
 * row and is read by the curator through the existing curation surface.
 */
export interface FeedbackExemplarNotice {
  tenantId: string;
  consultationId: string;
  exemplarId: string;
  feedbackId: string;
  targetKind: string;
  reasonCodes: readonly string[];
}

export interface IEvalGateCurationSink {
  /** Best-effort: the miner swallows a rejection, so an implementation must not rely on being retried. */
  onFeedbackExemplar(notice: FeedbackExemplarNotice): Promise<void>;
}

export const IEvalGateCurationSink = Symbol('IEvalGateCurationSink');

export class NoopEvalGateCurationSink implements IEvalGateCurationSink {
  async onFeedbackExemplar(): Promise<void> {
    // No curation consumer wired.
  }
}
