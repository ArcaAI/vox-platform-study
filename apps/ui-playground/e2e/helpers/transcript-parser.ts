/**
 * Ground-truth transcript parser.
 *
 * Parses .txt files with optional timestamps and speaker labels.
 * The parser is configurable via feature flags derived from pipeline config.
 *
 * Supported line formats (all valid):
 *   [00:00:00 - 00:00:05] Speaker1: Hello world.
 *   [00:00:00 - 00:00:05] Hello world.
 *   Speaker1: Hello world.
 *   Hello world.
 */

export interface ExpectedSegment {
  text: string;
  startTime?: number; // seconds, only if timestamps enabled
  endTime?: number; // seconds, only if timestamps enabled
  speaker?: string; // only if diarization enabled
}

export interface ParseFlags {
  expectTimestamps: boolean;
  expectSpeakers: boolean;
}

/**
 * Parse a timestamp string "HH:MM:SS" into seconds.
 */
function parseTimestamp(ts: string): number {
  const parts = ts.split(':');
  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  return Number(parts[0]) ?? 0;
}

// Regex: optional [HH:MM:SS(.ms) - HH:MM:SS(.ms)], optional speaker label, then text
const LINE_REGEX = /^(?:\[(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s*-\s*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*)?(?:([a-zA-Z0-9_]+):\s*)?(.+)$/;

/**
 * Parse a ground-truth transcript file content into ExpectedSegment[].
 *
 * @param content - Raw file content of the .txt transcript
 * @param flags - Feature flags determining what to parse
 */
export function parseGroundTruth(content: string, flags: ParseFlags): ExpectedSegment[] {
  const lines = content.split('\n');
  const segments: ExpectedSegment[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    const match = line.match(LINE_REGEX);
    if (!match) continue;

    const [, startTs, endTs, speaker, text] = match;
    if (!text?.trim()) continue;

    const segment: ExpectedSegment = {
      text: text.trim(),
    };

    if (flags.expectTimestamps && startTs && endTs) {
      segment.startTime = parseTimestamp(startTs);
      segment.endTime = parseTimestamp(endTs);
    }

    if (flags.expectSpeakers && speaker) {
      segment.speaker = speaker;
    }

    segments.push(segment);
  }

  return segments;
}

/**
 * Concatenate all segment texts into a single reference string.
 */
export function concatenateSegmentTexts(segments: ExpectedSegment[]): string {
  return segments.map((s) => s.text).join(' ');
}

/**
 * Extract unique speaker labels from segments.
 */
export function getUniqueSpeakers(segments: ExpectedSegment[]): string[] {
  const speakers = new Set<string>();
  for (const seg of segments) {
    if (seg.speaker) speakers.add(seg.speaker);
  }
  return [...speakers];
}
