/**
 * TASK-951 R2 (clarified 2026-09-11) — the metadata timeline, exhaustively.
 *
 * The owner's ask is one sentence: *"the ALaaS can send 1 or 2 or more than 2 mic ids when
 * recordings […] hope platform must return exactly the metadata contains mic ids time-synced
 * with the generated transcript."* Everything hard about honouring it is arithmetic on spans,
 * and it all lives in this pure module — no Nest, no Redis, no clock — which is why the awkward
 * cases can be pinned here rather than discovered on a live consultation.
 *
 * The cases that actually bite, in order of how likely they are to be got wrong:
 *
 *  1. A mid-utterance change must produce TWO spans on that utterance. Getting this wrong
 *     (stamping the current value on the whole segment) looks correct in every test where the
 *     metadata happens not to change, which is most of them.
 *  2. Clipping must be to the SEGMENT's window, not the span's. A consumer reads `from`/`to`
 *     against `startTime`/`endTime` and must never be handed a bound outside them.
 *  3. Coalescing. A broker re-stating its mic set every few seconds over a lossy link is normal
 *     and must cost nothing — no span growth, and (via the same-array signal) no Redis write.
 *  4. Two declarations before any audio. Both land at offset 0; the second must REPLACE, not
 *     open a zero-length span that no segment can ever overlap.
 *  5. A still-open span covers any window that reaches into it, even when the caller's own
 *     audio counter momentarily lags the ASR's — otherwise a segment with obvious metadata
 *     comes back with none.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_STREAM_METADATA_BYTES,
  clipSpansToWindow,
  isMetadataObject,
  metadataByteLength,
  parseMetadataMarks,
  setMetadataAt,
  type MetadataSpan,
  metadataInForce,
} from '../stream-metadata-timeline';

const ONE = { micIds: ['mic-1'] };
const TWO = { micIds: ['mic-1', 'mic-2'] };
const THREE = { micIds: ['mic-1', 'mic-2', 'mic-3'] };

/** Build a timeline by replaying declarations, the way the gateway does. */
const timeline = (...marks: Array<[number, Record<string, unknown>]>): MetadataSpan[] =>
  marks.reduce<MetadataSpan[]>((spans, [at, value]) => setMetadataAt(spans, at, value), []);

describe('TASK-951 — setMetadataAt', () => {
  it('opens the first span at the offset it was declared', () => {
    expect(setMetadataAt([], 12, ONE)).toEqual([{ from: 12, to: null, value: ONE }]);
  });

  it('closes the open span and opens a new one at the change', () => {
    expect(timeline([0, ONE], [13.4, TWO])).toEqual([
      { from: 0, to: 13.4, value: ONE },
      { from: 13.4, to: null, value: TWO },
    ]);
  });

  it('COALESCES a repeat of the value already in force, and says so by identity', () => {
    // A broker re-stating its mic set must not grow the list — and the gateway reads the
    // returned identity as "nothing changed" to skip the Redis write, so `toBe` is the
    // assertion that matters, not `toEqual`.
    const spans = timeline([0, ONE]);
    const again = setMetadataAt(spans, 9, ONE);

    expect(again).toBe(spans);
    expect(again).toHaveLength(1);
  });

  it('coalesces regardless of KEY ORDER — the same fact, built differently', () => {
    // `{a,b}` and `{b,a}` describe the same set of live microphones. Comparing raw
    // `JSON.stringify` would open a span between them for no reason.
    const spans = timeline([0, { micIds: ['mic-1'], room: 'A' }]);

    expect(setMetadataAt(spans, 5, { room: 'A', micIds: ['mic-1'] })).toBe(spans);
  });

  it('does NOT coalesce a changed array order — that is a different declaration', () => {
    // Arrays are ordered data, not sets: the client chose that order and HOPE echoes verbatim.
    const spans = timeline([0, TWO]);

    expect(setMetadataAt(spans, 5, { micIds: ['mic-2', 'mic-1'] })).not.toBe(spans);
  });

  it('REPLACES rather than opening a zero-length span when two marks land at the same offset', () => {
    // The ordinary case for a broker that configures before it streams: both declarations
    // happen before the first audio frame, so both are at 0.0. Reporting the first would be
    // reporting a value that was never in force over any audio.
    expect(timeline([0, ONE], [0, TWO])).toEqual([{ from: 0, to: null, value: TWO }]);
  });

  it('never rewinds: a stale offset clamps to the open span rather than inverting it', () => {
    // Only reachable through a rebuilt timeline whose persisted `audioSec` lagged. A span with
    // `to < from` would be silently dropped by every clip, taking the label with it.
    expect(timeline([0, ONE], [10, TWO], [4, THREE])).toEqual([
      { from: 0, to: 10, value: ONE },
      { from: 10, to: null, value: THREE },
    ]);
  });

  it('treats a negative or non-finite offset as 0 rather than propagating it', () => {
    expect(setMetadataAt([], Number.NaN, ONE)).toEqual([{ from: 0, to: null, value: ONE }]);
    expect(setMetadataAt([], -3, ONE)).toEqual([{ from: 0, to: null, value: ONE }]);
  });

  it('does not mutate the array it was handed', () => {
    const spans = timeline([0, ONE]);
    const before = JSON.stringify(spans);

    setMetadataAt(spans, 5, TWO);

    expect(JSON.stringify(spans)).toBe(before);
  });
});

describe('TASK-951 — clipSpansToWindow', () => {
  it('reports ONE span when the metadata did not change during the segment', () => {
    const spans = timeline([0, ONE]);

    expect(clipSpansToWindow(spans, 12, 15.1, 20)).toEqual([{ from: 12, to: 15.1, value: ONE }]);
  });

  it('reports TWO spans when the client changed metadata MID-UTTERANCE', () => {
    // The case the whole ticket exists for: a second microphone opens while someone is still
    // speaking. The segment is reported as what it was, not stamped with whichever value
    // happened to be current when decoding finished.
    const spans = timeline([0, ONE], [13.4, TWO]);

    expect(clipSpansToWindow(spans, 12, 15.1, 20)).toEqual([
      { from: 12, to: 13.4, value: ONE },
      { from: 13.4, to: 15.1, value: TWO },
    ]);
  });

  it('clips BOTH ends to the segment, never to the span', () => {
    // A consumer reads these against `startTime`/`endTime`; a bound outside the window would
    // make it place audio the segment does not contain.
    const spans = timeline([0, ONE], [5, TWO], [9, THREE]);

    expect(clipSpansToWindow(spans, 6, 8, 30)).toEqual([{ from: 6, to: 8, value: TWO }]);
  });

  it('reports three spans when the client changed twice inside one segment', () => {
    const spans = timeline([0, ONE], [4, TWO], [7, THREE]);

    expect(clipSpansToWindow(spans, 2, 9, 30)).toEqual([
      { from: 2, to: 4, value: ONE },
      { from: 4, to: 7, value: TWO },
      { from: 7, to: 9, value: THREE },
    ]);
  });

  it('gives a window that predates the first mark no coverage for that stretch', () => {
    // Audio flowed before the client said anything. Nothing WAS in force then, and inventing a
    // value for it would be worse than the gap.
    const spans = timeline([2, ONE]);

    expect(clipSpansToWindow(spans, 0.5, 3, 10)).toEqual([{ from: 2, to: 3, value: ONE }]);
  });

  it('returns [] for a window entirely before the first mark', () => {
    expect(clipSpansToWindow(timeline([5, ONE]), 1, 4, 10)).toEqual([]);
  });

  it('returns [] for an empty timeline — the gateway reads that as "omit the field"', () => {
    expect(clipSpansToWindow([], 0, 10, 10)).toEqual([]);
  });

  it('drops a closed span that ends exactly where the window begins', () => {
    // Half-open `[from, to)`: a span ending at 5 covered no audio in `[5, 8]`.
    const spans = timeline([0, ONE], [5, TWO]);

    expect(clipSpansToWindow(spans, 5, 8, 10)).toEqual([{ from: 5, to: 8, value: TWO }]);
  });

  it('covers the whole window from a STILL-OPEN span even when the audio counter lags', () => {
    // `openEnd` is the gateway's byte counter; the ASR's sample counter can be momentarily
    // ahead of it while buffered audio is decoded. Clipping the open span to `openEnd` would
    // end it short of the segment it describes — or drop it and hand back `[]` for a segment
    // that plainly had metadata.
    const spans = timeline([0, ONE]);

    expect(clipSpansToWindow(spans, 10, 14, 11)).toEqual([{ from: 10, to: 14, value: ONE }]);
  });

  it('reports what was in force at an instant for a zero-width window', () => {
    // A partial can be emitted with `startTime === endTime`. Dropping every span there would
    // make partials unlabelled while finals were labelled — the same audio, two answers.
    const spans = timeline([0, ONE]);

    expect(clipSpansToWindow(spans, 7, 7, 10)).toEqual([{ from: 7, to: 7, value: ONE }]);
  });

  it('returns [] rather than throwing for an inverted window', () => {
    expect(clipSpansToWindow(timeline([0, ONE]), 9, 3, 10)).toEqual([]);
  });

  it('echoes the value object VERBATIM — same reference, never a copy or a re-key', () => {
    const value = { micIds: ['mic-1'], vendorPayload: { nested: { deep: true } } };
    const spans = timeline([0, value]);

    expect(clipSpansToWindow(spans, 1, 2, 5)[0]!.value).toBe(value);
  });
});

describe('TASK-951 — metadataByteLength', () => {
  it('measures BYTES, not characters, so a non-ASCII label is charged honestly', () => {
    // A character count would admit an object several times the intended Redis and wire cost.
    expect(metadataByteLength({ room: 'Consultório' })).toBeGreaterThan(JSON.stringify({ room: 'Consultório' }).length);
  });

  it('measures JSON form, so the client is not charged for its own framing whitespace', () => {
    expect(metadataByteLength({ a: 1 })).toBe('{"a":1}'.length);
  });

  it('puts a realistic multi-mic declaration far under the bound', () => {
    expect(metadataByteLength({ micIds: ['mic-1', 'mic-2', 'mic-3'], speakerLabels: { 'mic-1': 'Clinician' } })).toBeLessThan(
      MAX_STREAM_METADATA_BYTES,
    );
  });
});

describe('TASK-951 — isMetadataObject', () => {
  it('accepts a plain object and rejects everything else a JSON frame could carry', () => {
    expect(isMetadataObject({ micIds: [] })).toBe(true);
    expect(isMetadataObject([])).toBe(false);
    expect(isMetadataObject(null)).toBe(false);
    expect(isMetadataObject('mic-1')).toBe(false);
    expect(isMetadataObject(7)).toBe(false);
    expect(isMetadataObject(undefined)).toBe(false);
  });
});

describe('TASK-951 — parseMetadataMarks', () => {
  it('round-trips a real timeline through JSON', () => {
    const spans = timeline([0, ONE], [13.4, TWO]);
    const marks = { spans, audioSec: 20 };

    expect(parseMetadataMarks(JSON.parse(JSON.stringify(marks)))).toEqual(marks);
  });

  it('rebuilds the clock to at least the last recorded boundary', () => {
    // An `audioSec` that somehow lagged the spans it was written with would place the next
    // declaration before one already recorded.
    expect(parseMetadataMarks({ spans: [{ from: 0, to: 9, value: ONE }], audioSec: 2 }).audioSec).toBe(9);
  });

  it('yields an EMPTY timeline for anything unreadable, never a throw', () => {
    // The echo is an attribution aid. A corrupt marks record must cost a client its mic labels,
    // never its live transcription — the same posture the sampleRate read takes at this seam.
    for (const raw of [null, undefined, 'nope', 42, [], { spans: 'nope' }, {}]) {
      expect(parseMetadataMarks(raw)).toEqual({ spans: [], audioSec: 0 });
    }
  });

  it('truncates at the first entry that breaks monotonic order', () => {
    const parsed = parseMetadataMarks({
      spans: [
        { from: 0, to: 5, value: ONE },
        { from: 3, to: 8, value: TWO },
      ],
      audioSec: 8,
    });

    expect(parsed.spans).toEqual([{ from: 0, to: 5, value: ONE }]);
  });

  it('truncates after an open span — only the LAST span may be open', () => {
    const parsed = parseMetadataMarks({
      spans: [
        { from: 0, to: null, value: ONE },
        { from: 5, to: null, value: TWO },
      ],
      audioSec: 9,
    });

    expect(parsed.spans).toEqual([{ from: 0, to: null, value: ONE }]);
  });

  it('drops an entry whose value is not an object', () => {
    expect(parseMetadataMarks({ spans: [{ from: 0, to: null, value: 'mic-1' }], audioSec: 3 }).spans).toEqual([]);
  });

  it('feeds straight back into setMetadataAt after a rebuild', () => {
    // The whole point of persisting: a session that reconnects onto another gateway instance
    // continues ONE timeline instead of silently starting a second one at zero.
    const persisted = JSON.parse(JSON.stringify({ spans: timeline([0, ONE], [13.4, TWO]), audioSec: 20 }));
    const rebuilt = parseMetadataMarks(persisted);

    const next = setMetadataAt(rebuilt.spans, rebuilt.audioSec, THREE);

    expect(next).toEqual([
      { from: 0, to: 13.4, value: ONE },
      { from: 13.4, to: 20, value: TWO },
      { from: 20, to: null, value: THREE },
    ]);
  });
});

describe('metadataInForce — the one label a segment is reported under (the v1 `metadata.mic_id` shape)', () => {
  const MIC = (id: string) => ({ mic_id: id });

  it('is the value in force over the largest share of the segment', () => {
    expect(
      metadataInForce([
        { from: 12, to: 13.4, value: MIC('1') },
        { from: 13.4, to: 15.1, value: MIC('2') },
      ]),
    ).toEqual(MIC('2'));
    expect(
      metadataInForce([
        { from: 12, to: 14.8, value: MIC('1') },
        { from: 14.8, to: 15.1, value: MIC('2') },
      ]),
    ).toEqual(MIC('1'));
  });

  it('a tie goes to the EARLIER span — what was in force when the segment started', () => {
    expect(
      metadataInForce([
        { from: 0, to: 1, value: MIC('1') },
        { from: 1, to: 2, value: MIC('2') },
      ]),
    ).toEqual(MIC('1'));
  });

  it('a zero-width window (a partial whose bounds coincide) reports its one instantaneous span', () => {
    expect(metadataInForce([{ from: 3, to: 3, value: MIC('2') }])).toEqual(MIC('2'));
  });

  it('is undefined with no spans, so the caller omits the field', () => {
    expect(metadataInForce([])).toBeUndefined();
  });

  it("reproduces the owner's sequence: a frame that declares nothing inherits the last mic, and each segment reports the mic live over it", () => {
    // | time | mic_id sent | returned metadata.mic_id |   (one frame per second, one segment per frame)
    // |  1   |     1       |           1              |
    // |  2   |             |           1              |
    // |  3   |     2       |           2              |
    // |  4   |     1       |           1              |
    // |  5   |     2       |           2              |
    // |  6   |             |           2              |
    let spans = setMetadataAt([], 0, MIC('1'));
    spans = setMetadataAt(spans, 2, MIC('2'));
    spans = setMetadataAt(spans, 3, MIC('1'));
    spans = setMetadataAt(spans, 4, MIC('2'));
    const label = (from: number, to: number) => metadataInForce(clipSpansToWindow(spans, from, to, 6))?.mic_id;
    expect([label(0, 1), label(1, 2), label(2, 3), label(3, 4), label(4, 5), label(5, 6)]).toEqual(['1', '1', '2', '1', '2', '2']);
  });
});
