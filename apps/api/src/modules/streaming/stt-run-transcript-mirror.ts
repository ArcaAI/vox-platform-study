import { readGoverningEngineMarker } from '@arcaai/applications';
import type { RunAppendInput } from '@arcaai/async-contract';
import { ConsultationRepository, TranscriptionJobRepository, TranscriptionJobType, WorkflowRunRepository } from '@arcaai/domains';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { RunEventStreamHub } from '../workflows/run-event-stream-hub';

/** How long one session's run resolution is reused before it is asked again (a run can start mid-session). */
const RESOLUTION_REFRESH_MS = 5_000;
/** Sessions tracked per process; the oldest is forgotten past this (a forgotten one simply re-resolves). */
const MAX_TRACKED_SESSIONS = 1_024;

/** The slice of an STT result frame this mirror reads. */
export interface SttResultFrame {
  type: string;
  isFinal?: boolean;
  text?: unknown;
  utteranceIndex?: unknown;
  stableChars?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  speakerLabel?: unknown;
  speakerId?: unknown;
  language?: unknown;
  resultType?: unknown;
  [key: string]: unknown;
}

interface TrackedSession {
  resolvedAt: number;
  runIds: Promise<string[]> | null;
  /** Appends of this session, chained so they reach the sequencer in arrival order. */
  chain: Promise<void>;
}

/**
 * `SttRunTranscriptMirror` — TASK-1036 (lane B6b, §10.3): the gateway STT bridge's half of the run
 * event stream.
 *
 * When a streaming STT session is bound to a consultation that is the subject of a RUNNING workflow
 * run — a sandbox run recording from the console Test tab (`WorkflowRun.isSandbox`, its
 * `_metadata.consultationId` naming the sandbox consultation), or the consultation's governed run
 * (the `governingEngine` marker) — every transcript the bridge relays is appended to that run as
 * `transcript.partial` / `transcript.final` through the ONE sequencer (`RunEventStreamHub.append`,
 * protocol-v2.md §6.1). They are admin-audience events and carry NO `nodeId`: the consultation
 * session is their source, not a graph node (§4).
 *
 * Resolution (session → transcription job → consultation → running runs) is cached per session for
 * {@link RESOLUTION_REFRESH_MS}, so the per-transcript cost on the relay path is a map lookup. Every
 * query names the session's tenant explicitly (the socket runs outside a request's CLS tenant).
 * Best-effort end to end, like every other producer of the mirror: a failed lookup or append is
 * logged at debug and swallowed — it never touches the transcript the clinician sees.
 */
@Injectable()
export class SttRunTranscriptMirror {
  private readonly logger = new Logger(SttRunTranscriptMirror.name);
  private readonly sessions = new Map<string, TrackedSession>();

  constructor(
    @Optional() private readonly hub?: RunEventStreamHub,
    @Optional() private readonly jobs?: TranscriptionJobRepository,
    @Optional() private readonly consultations?: ConsultationRepository,
    @Optional() private readonly runs?: WorkflowRunRepository,
  ) {}

  /** Mirror one relayed STT frame. Synchronous and never throws; the work is queued per session. */
  mirror(tenantId: string | null, sttSessionId: string, frame: SttResultFrame): void {
    try {
      const event = transcriptEvent(frame);
      if (event === null || !tenantId || !this.hub?.available() || !this.jobs || !this.consultations || !this.runs) return;
      const tracked = this.track(sttSessionId);
      const now = Date.now();
      if (tracked.runIds === null || now - tracked.resolvedAt >= RESOLUTION_REFRESH_MS) {
        tracked.resolvedAt = now;
        tracked.runIds = this.resolveRuns(tenantId, sttSessionId);
      }
      const runIds = tracked.runIds;
      const ts = new Date(now).toISOString();
      tracked.chain = tracked.chain.then(async () => {
        for (const runId of await runIds) {
          await this.hub?.append({ runId, ts, ...event } as RunAppendInput);
        }
      }).catch((error: unknown) => {
        this.logger.debug({ message: 'live transcript could not be mirrored to its run', sttSessionId, error: error instanceof Error ? error.message : String(error) });
      });
    } catch (error) {
      this.logger.debug({ message: 'live transcript mirror refused a frame', sttSessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Resolves once every append queued for the session so far has settled (tests, shutdown). */
  async idle(sttSessionId: string): Promise<void> {
    await this.sessions.get(sttSessionId)?.chain;
  }

  /** Drop a session's cached resolution (its socket closed). */
  forget(sttSessionId: string): void {
    this.sessions.delete(sttSessionId);
  }

  private track(sttSessionId: string): TrackedSession {
    let tracked = this.sessions.get(sttSessionId);
    if (tracked === undefined) {
      if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      tracked = { resolvedAt: 0, runIds: null, chain: Promise.resolve() };
      this.sessions.set(sttSessionId, tracked);
    }
    return tracked;
  }

  /** The RUNNING runs the session's consultation feeds: its sandbox run(s), then its governed run. */
  private async resolveRuns(tenantId: string, sttSessionId: string): Promise<string[]> {
    try {
      const [job] = (await this.jobs!.findAll({
        filters: { tenantId, streamSessionId: sttSessionId, jobType: TranscriptionJobType.STREAMING },
      } as never)) as Array<{ tenantId?: string; consultationId?: string | null }>;
      const consultationId = job && job.tenantId === tenantId ? job.consultationId : null;
      if (!consultationId) return [];
      const consultation = (await this.consultations!.findByIdOrNull(consultationId)) as { tenantId?: string; metadata?: unknown } | null;
      if (!consultation || consultation.tenantId !== tenantId) return [];

      const sandbox = (await this.runs!.findAll({
        where: { tenantId, isSandbox: true, status: 'RUNNING', metaData: { path: ['consultationId'], equals: consultationId } },
      } as never)) as Array<{ runId: string }>;
      const runIds = sandbox.map((run) => run.runId);
      const governed = readGoverningEngineMarker(consultation.metadata);
      if (governed && (governed.runStatus === undefined || governed.runStatus === 'RUNNING') && !runIds.includes(governed.workflowRunId)) {
        runIds.push(governed.workflowRunId);
      }
      return runIds;
    } catch (error) {
      this.logger.debug({ message: 'live transcript run resolution failed', sttSessionId, error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }
}

/** The protocol event for one STT frame — only the closed fields of `transcript.partial|final` — or `null`. */
function transcriptEvent(frame: SttResultFrame): Pick<RunAppendInput, 'type' | 'data'> | null {
  if (frame?.type !== 'transcript' || frame.resultType === 'gloss') return null;
  if (typeof frame.text !== 'string' || frame.text.trim().length === 0) return null;
  const text = frame.text;
  const utteranceIndex = nonNegativeInt(frame.utteranceIndex);
  if (frame.isFinal !== true) {
    const stableChars = nonNegativeInt(frame.stableChars);
    return {
      type: 'transcript.partial',
      data: { text, ...(utteranceIndex === undefined ? {} : { utteranceIndex }), ...(stableChars === undefined ? {} : { stableChars }) },
    } as Pick<RunAppendInput, 'type' | 'data'>;
  }
  const start = nonNegative(frame.startTime);
  const end = nonNegative(frame.endTime);
  const speaker = [frame.speakerLabel, frame.speakerId].find((value): value is string => typeof value === 'string' && value.length > 0);
  const language = typeof frame.language === 'string' && frame.language.length > 0 ? frame.language : undefined;
  return {
    type: 'transcript.final',
    data: {
      text,
      ...(utteranceIndex === undefined ? {} : { utteranceIndex }),
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      ...(speaker === undefined ? {} : { speaker }),
      ...(language === undefined ? {} : { language }),
    },
  } as Pick<RunAppendInput, 'type' | 'data'>;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
