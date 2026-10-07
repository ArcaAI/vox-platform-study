/**
 * TASK-1050 W2b — what the TEXT proxy relays about a guardrail outcome, and the one validator every
 * relayed notice passes.
 *
 * TEXT speaks snake_case on its own wire (`guardrail_notices`, `guardrail_evaluation_ids`, an SSE
 * `StreamChunk` envelope); the gateway answers the frozen camelCase contract (`@arcaai/types`
 * `GuardrailResponseAdditions`, `GuardrailBlockedProblem` members at the top level of the error body,
 * a `guardrail.notice` SSE event whose data IS the notice) — the shape both SDKs read.
 *
 * A notice is PHI-free BY CONSTRUCTION (check ids, categories, a fixed `messageKey` and EXACTLY its fixed
 * `defaultMessage`), which is the only reason it may cross a boundary the upstream `detail` may not. The
 * gateway does not take that on trust: every notice is checked against the frozen run-protocol schema
 * (`runEventProblems` on a synthetic `guardrail.notice` event — the same validator the run stream uses)
 * and DROPPED when it fails, so a producer bug can never put free text in front of a clinician.
 *
 * Every `x-hope-*` header is internal (`@arcaai/types` `HOPE_INTERNAL_HEADER_PREFIX`; TEXT forwards
 * them to guardrail, and `X-Hope-Guardrail-Override` re-runs a block as warn). The proxy builds its
 * upstream headers itself and never copies a caller's; {@link withoutHopeInternalHeaders} is the
 * defence-in-depth pass applied before the gateway adds its OWN correlation.
 */
import { runEventProblems } from '@arcaai/async-contract';
import type { Readable } from 'node:stream';

/** `@arcaai/types` `GUARDRAIL_BLOCKED_PROBLEM_TYPE`. */
export const GUARDRAIL_BLOCKED_PROBLEM_TYPE = 'urn:hope:problem:guardrail-blocked';
/** TEXT's 503 for a cloud call whose PII spans could not be computed — a resumable privacy hold. */
export const EGRESS_REDACTION_UNAVAILABLE = 'EGRESS_REDACTION_UNAVAILABLE';
/** `@arcaai/types` `HOPE_INTERNAL_HEADER_PREFIX`. */
const HOPE_INTERNAL_HEADER_PREFIX = 'x-hope-';
/** `@arcaai/types` `GUARDRAIL_CORRELATION_HEADERS`, the fields this proxy can know. */
export const GUARDRAIL_CONSULTATION_HEADER = 'X-Hope-Consultation-Id';

const MAX_EVALUATION_IDS = 256;
const MAX_ID_LENGTH = 128;
/** An error body read off a streamed response: TEXT's are small JSON objects. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ERROR_BODY_READ_TIMEOUT_MS = 2_000;
/** Beyond this without a frame boundary the SSE relay degrades to a byte pipe (never grows unbounded). */
const MAX_SSE_CARRY_CHARS = 1024 * 1024;

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` is a valid `GuardrailNotice` v1 (schema + the fixed-label rules). */
export function isRelayableGuardrailNotice(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const ts = typeof value.occurredAt === 'string' ? value.occurredAt : new Date().toISOString();
  return runEventProblems({ seq: 1, runId: 'gateway-relay', type: 'guardrail.notice', ts, data: value }, { plane: 'public' }).length === 0;
}

export function relayableGuardrailNotices(value: unknown): Json[] {
  return Array.isArray(value) ? (value.filter(isRelayableGuardrailNotice) as Json[]) : [];
}

export function relayableEvaluationIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH).slice(0, MAX_EVALUATION_IDS);
}

/**
 * A TEXT JSON body (200) with the guardrail lists in the gateway's camelCase. Only a body that carries
 * either list is touched, so an older TEXT's body passes through unchanged.
 */
export function withCamelGuardrailAdditions<T>(body: T): T {
  if (!isPlainObject(body)) return body;
  if (!('guardrail_notices' in body) && !('guardrail_evaluation_ids' in body) && !('guardrail_notice' in body)) return body;
  const out: Json = { ...body };
  if ('guardrail_notices' in body) out.guardrailNotices = relayableGuardrailNotices(body.guardrail_notices);
  if ('guardrail_evaluation_ids' in body) out.guardrailEvaluationIds = relayableEvaluationIds(body.guardrail_evaluation_ids);
  if ('guardrail_notice' in body && isRelayableGuardrailNotice(body.guardrail_notice)) out.guardrailNotice = body.guardrail_notice;
  delete out.guardrail_notices;
  delete out.guardrail_evaluation_ids;
  delete out.guardrail_notice;
  return out as T;
}

/**
 * The members of a TEXT 422 block / 503 redaction body that may cross the gateway, beside its own fixed
 * phrase and code: the problem `type`, a validated `guardrailNotice`, the evaluation ids, and (503) the
 * processing reason and `retryable`. Never `detail`, `title` or anything else upstream wrote.
 */
export function guardrailErrorExtensions(errorCode: string | undefined, payload: unknown): Json {
  if (!isPlainObject(payload)) return {};
  const out: Json = {};
  if (payload.type === GUARDRAIL_BLOCKED_PROBLEM_TYPE) out.type = GUARDRAIL_BLOCKED_PROBLEM_TYPE;
  if (isRelayableGuardrailNotice(payload.guardrailNotice)) out.guardrailNotice = payload.guardrailNotice;
  if ('guardrailEvaluationIds' in payload) out.guardrailEvaluationIds = relayableEvaluationIds(payload.guardrailEvaluationIds);
  if (errorCode === EGRESS_REDACTION_UNAVAILABLE) {
    // A distinct, RETRYABLE code: the consultation's processing reason, a resumable hold — never a lost run.
    out.processingReason = EGRESS_REDACTION_UNAVAILABLE;
    out.retryable = true;
  }
  return out;
}

/** `headers` without any `x-hope-*` entry (case-insensitive). */
export function withoutHopeInternalHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (!name.toLowerCase().startsWith(HOPE_INTERNAL_HEADER_PREFIX)) out[name] = value;
  return out;
}

function isReadable(value: unknown): value is Readable {
  return typeof value === 'object' && value !== null && typeof (value as Readable).on === 'function' && typeof (value as Readable).read === 'function';
}

/**
 * A STREAMING request's error arrives with `response.data` as a stream (axios `responseType: 'stream'`),
 * so its `error_code` and guardrail members were invisible and the client got the generic fallback.
 * Read it (bounded in size and time) and parse it in place; anything unreadable stays as it was.
 */
export async function materializeStreamedErrorBody(err: unknown): Promise<void> {
  const response = (err as { response?: { data?: unknown } } | null)?.response;
  if (!response || !isReadable(response.data)) return;
  const stream = response.data;
  const text = await new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => finish(null), ERROR_BODY_READ_TIMEOUT_MS);
    timer.unref?.();
    let done = false;
    function finish(value: string | null): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    }
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_ERROR_BODY_BYTES) {
        stream.destroy?.();
        finish(null);
        return;
      }
      chunks.push(buffer);
    });
    stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => finish(null));
  });
  if (text === null) return;
  try {
    response.data = JSON.parse(text);
  } catch {
    // swallow-ok: a non-JSON error body keeps the generic, redacted mapping it always had.
  }
}

/**
 * The SSE relay for `text-generations/tasks/:id/stream`. Frames are re-cut at their boundaries; a frame
 * that does not mention `guardrail` is forwarded BYTE FOR BYTE (separator included). A
 * `guardrail.notice` frame is re-emitted with the validated NOTICE as its data (or dropped when invalid);
 * a `done` / `error` frame gets the camelCase lists inside its `data`. `push` returns what may be written
 * now; `end` flushes the remainder.
 */
export class GuardrailSseRelay {
  private tail = '';
  private passthrough = false;

  push(chunk: Buffer | string): string {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (this.passthrough) return text;
    this.tail += text;
    let out = '';
    for (;;) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(this.tail);
      if (!match) break;
      const end = match.index + match[0].length;
      out += this.rewrite(this.tail.slice(0, match.index), this.tail.slice(0, end));
      this.tail = this.tail.slice(end);
    }
    if (this.tail.length > MAX_SSE_CARRY_CHARS) {
      // A frame this large is malformed, not pending: degrade to the byte pipe this relay used to be.
      this.passthrough = true;
      out += this.tail;
      this.tail = '';
    }
    return out;
  }

  end(): string {
    const rest = this.tail;
    this.tail = '';
    return rest.length > 0 ? this.rewrite(rest, rest) : '';
  }

  private rewrite(frame: string, original: string): string {
    if (!frame.includes('guardrail')) return original;
    const lines = frame.split(/\r\n|\n|\r/);
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const dataLines = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
    if (dataLines.length === 0) return original;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      return original;
    }
    const others = lines.filter((line) => line.length > 0 && !line.startsWith('data:'));
    if (event === 'guardrail.notice') {
      const notice = isPlainObject(payload) && isPlainObject(payload.data) && payload.type === 'guardrail.notice' ? payload.data : payload;
      if (!isRelayableGuardrailNotice(notice)) return '';
      return `${[...others, `data: ${JSON.stringify(notice)}`].join('\n')}\n\n`;
    }
    if (isPlainObject(payload) && isPlainObject(payload.data)) {
      const rewritten = { ...payload, data: withCamelGuardrailAdditions(payload.data) };
      return `${[...others, `data: ${JSON.stringify(rewritten)}`].join('\n')}\n\n`;
    }
    return original;
  }
}
