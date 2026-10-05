import { Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { TranscriptionJobRepository, TranscriptionJobType } from '@arcaai/domains';
import { IRedisCacheService } from '../baseServices/redis';
import { WORKFLOW_RUNS_DEFAULTS, WORKFLOW_RUNS_LIVE_AUDIO_MAX_SECONDS_KEY } from '../settings-registry/descriptors/workflow-runs.descriptors';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { isLiveStreamJob, liveAudioMaxSecondsOf, readBoundRun } from './run-audio-binding.service';

/**
 * TASK-1042 (C5) — what the harness reads of a run's bound live STT session:
 * `GET /api/v1/internal/stt/sessions/:sessionId/transcript?runId=`.
 *
 * ## Where the finals come from
 *
 * `stt:result:<sessionId>` — the Redis stream `apps/stt` `ResultPublisher` writes (approximate
 * `MAXLEN` per `XADD`, `EXPIRE` after close). It is read with ONE `EVAL` that takes `XINFO STREAM`
 * and `XRANGE - +` atomically, so the trim check and the entries describe the same instant. Never
 * a consumer group: the WS bridge owns the group, and a second reader in it would steal frames.
 *
 * The frame fields are the ones `StreamingAudioBridgeService.projectAndEmitResult` already parses
 * (`SegmentResult.to_redis_dict`, snake_case strings): `type` (`segment` — or absent on an old
 * worker — / `gloss` / `punctuated` / `status` / `error`), `text`, `is_final` (`'1'`),
 * `utterance_index`, `start_time`, `end_time`, `speaker_id`, `language`; a `status` frame carries
 * `status` (`closed` / `cancelled` end the session). A final is a `segment` frame with
 * `is_final = '1'` and non-blank text. A later final, or a `punctuated` republish, for the SAME
 * `utterance_index` replaces the earlier text in place. `gloss` (an English translation) is not
 * the transcript and is skipped.
 *
 * ## The four states
 *
 * - `truncated` — the retained stream no longer starts at the first final. Detected EXACTLY, not by
 *   guessing from `utterance_index` (an utterance that decodes to no text publishes nothing, so the
 *   first retained final can legitimately be index 1): Redis 7+ `XINFO STREAM` reports
 *   `entries-added`, every entry ever appended; only `MAXLEN` trims this stream (nothing `XDEL`s
 *   it), so `entries-added > length` means the head was dropped. A server too old to report it is
 *   treated as truncated (fail closed). An ABSENT stream after the session ended (the post-close
 *   `EXPIRE`) is also truncated, unless the job row measured an empty transcript
 *   (`resultCharCount === 0`).
 * - `ended` — the job row is no longer live, or the stream carries the terminal `closed` /
 *   `cancelled` status (the row is updated at teardown and may lag it).
 * - `timeout` — still live, and bound (`boundRun.boundAt`) longer than
 *   `workflowRuns.liveAudioMaxSeconds` ago.
 * - `live` — otherwise. An absent stream while live is simply "no speech yet".
 *
 * A Redis outage is a 503 (the harness retries the poll), never an empty transcript.
 */

export type RunAudioTranscriptState = 'live' | 'ended' | 'truncated' | 'timeout';

export interface RunAudioFinal {
  text: string;
  utteranceIndex?: number;
  start?: number;
  end?: number;
  speaker: string | null;
  language: string | null;
}

export interface RunAudioTranscript {
  state: RunAudioTranscriptState;
  language: string | null;
  /** The finals' text joined with single spaces. */
  transcript: string;
  finals: RunAudioFinal[];
}

export interface ReadRunAudioTranscriptInput {
  tenantId: string;
  sttSessionId: string;
  runId: string;
}

/** `{ exists, length, entriesAdded, entries }` in one atomic read. */
export const RESULT_STREAM_SNAPSHOT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {0, 0, 0, {}} end
local info = redis.call('XINFO', 'STREAM', KEYS[1])
local length, added = 0, -1
for i = 1, #info, 2 do
  if info[i] == 'length' then length = info[i + 1] end
  if info[i] == 'entries-added' then added = info[i + 1] end
end
return {1, length, added, redis.call('XRANGE', KEYS[1], '-', '+')}
`;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['closed', 'cancelled']);

interface StreamJobLike {
  tenantId?: string;
  status?: unknown;
  completedAt?: Date | null;
  resultCharCount?: number | null;
  metaData?: Record<string, unknown> | null;
}

interface StreamSnapshot {
  exists: boolean;
  length: number;
  entriesAdded: number;
  entries: Array<Record<string, string>>;
}

function toText(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(toText(value));
  return Number.isFinite(n) ? n : 0;
}

/** Parse the EVAL reply; `null` when it is not the script's shape (e.g. Redis unavailable). */
function parseSnapshot(reply: unknown): StreamSnapshot | null {
  if (!Array.isArray(reply) || reply.length < 4 || !Array.isArray(reply[3])) return null;
  const entries: Array<Record<string, string>> = [];
  for (const entry of reply[3] as unknown[]) {
    const fields = Array.isArray(entry) && Array.isArray(entry[1]) ? (entry[1] as unknown[]) : [];
    const frame: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) frame[toText(fields[i])] = toText(fields[i + 1]);
    entries.push(frame);
  }
  return { exists: toNumber(reply[0]) === 1, length: toNumber(reply[1]), entriesAdded: toNumber(reply[2]), entries };
}

function nonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function nonNegative(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The finals of a stream snapshot, in order, plus whether it carried the terminal status. Pure. */
export function liveTranscriptFinalsOf(entries: ReadonlyArray<Record<string, string>>): { finals: RunAudioFinal[]; terminal: boolean } {
  const finals: RunAudioFinal[] = [];
  const byIndex = new Map<number, RunAudioFinal>();
  let terminal = false;
  for (const frame of entries) {
    const type = frame.type || 'segment';
    if (type === 'status') {
      if (TERMINAL_STATUSES.has(frame.status)) terminal = true;
      continue;
    }
    const text = (frame.text ?? '').trim();
    const utteranceIndex = nonNegativeInt(frame.utterance_index);
    if (type === 'punctuated') {
      const prior = utteranceIndex === undefined ? undefined : byIndex.get(utteranceIndex);
      if (prior && text.length > 0) prior.text = text;
      continue;
    }
    if (type !== 'segment' || frame.is_final !== '1' || text.length === 0) continue;
    const start = nonNegative(frame.start_time);
    const end = nonNegative(frame.end_time);
    const next: RunAudioFinal = {
      text,
      ...(utteranceIndex === undefined ? {} : { utteranceIndex }),
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      speaker: frame.speaker_id || null,
      language: frame.language || null,
    };
    const prior = utteranceIndex === undefined ? undefined : byIndex.get(utteranceIndex);
    if (prior) {
      Object.assign(prior, next);
      if (next.utteranceIndex === undefined) delete prior.utteranceIndex;
      continue;
    }
    finals.push(next);
    if (utteranceIndex !== undefined) byIndex.set(utteranceIndex, next);
  }
  return { finals, terminal };
}

@Injectable()
export class RunAudioTranscriptService {
  constructor(
    @Optional() private readonly jobs?: TranscriptionJobRepository,
    @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
    @Optional() private readonly tenantSettings?: TenantSettingsService,
  ) {}

  async read(input: ReadRunAudioTranscriptInput): Promise<RunAudioTranscript> {
    if (!this.jobs) throw new ServiceUnavailableException('The STT session store is not configured.');
    const [job] = (await this.jobs.findAll({
      filters: { tenantId: input.tenantId, streamSessionId: input.sttSessionId, jobType: TranscriptionJobType.STREAMING },
    } as never)) as unknown as StreamJobLike[];
    const bound = job && job.tenantId === input.tenantId ? readBoundRun(job.metaData) : null;
    if (!job || !bound || bound.runId !== input.runId) {
      throw new NotFoundException(`STT session '${input.sttSessionId}' is not bound to run '${input.runId}'.`);
    }

    const snapshot = parseSnapshot(await this.redis?.eval(RESULT_STREAM_SNAPSHOT_SCRIPT, 1, `stt:result:${input.sttSessionId}`));
    if (!snapshot) throw new ServiceUnavailableException('The live transcript cannot be read right now; retry.');

    const { finals, terminal } = liveTranscriptFinalsOf(snapshot.entries);
    const ended = terminal || !isLiveStreamJob(job);
    const trimmed = snapshot.exists && (snapshot.entriesAdded < 0 || snapshot.entriesAdded > snapshot.length);
    const expired = !snapshot.exists && ended && job.resultCharCount !== 0;

    let state: RunAudioTranscriptState;
    if (trimmed || expired) state = 'truncated';
    else if (ended) state = 'ended';
    else if (this.boundTooLong(input.tenantId, bound.boundAt)) state = 'timeout';
    else state = 'live';

    const language = [...finals].reverse().find((final) => final.language !== null)?.language ?? null;
    return { state, language, transcript: finals.map((final) => final.text).join(' '), finals };
  }

  private boundTooLong(tenantId: string, boundAt: string | null): boolean {
    const since = boundAt ? Date.parse(boundAt) : Number.NaN;
    if (!Number.isFinite(since)) return false;
    let maxSeconds: number = WORKFLOW_RUNS_DEFAULTS.liveAudioMaxSeconds;
    try {
      maxSeconds = liveAudioMaxSecondsOf(this.tenantSettings?.resolve<number>(WORKFLOW_RUNS_LIVE_AUDIO_MAX_SECONDS_KEY, tenantId).value);
    } catch {
      // fail open to the default
    }
    return Date.now() - since > maxSeconds * 1000;
  }
}
