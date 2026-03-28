/**
 * @arcaai/room - Debug Logger Utility
 *
 * Lightweight console-based debug logging for audio pipeline diagnostics.
 * Used by all @arcaai plugin packages when debugMode is enabled.
 */

const PREFIX = '[ARCAAI:DEBUG]';

/**
 * A single word-level timestamp entry for debug transcript output.
 */
export interface DebugTranscriptWord {
  word: string;
  confidence: number;
  start: number;
  end: number;
}

/**
 * Structured transcript entry logged when debugMode is enabled.
 * Matches the required JSON schema for debug output.
 */
export interface DebugTranscriptEntry {
  segment: number;
  speaker: string;
  start: number;
  end: number;
  duration: number;
  inference: number;
  words?: DebugTranscriptWord[];
}

/**
 * Round a number to the specified decimal places.
 */
function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Format a DebugTranscriptEntry with the required precision:
 * - times (start, end, duration): 3 decimal places
 * - inference: 4 decimal places
 * - confidence: 3 decimal places
 */
function formatTranscriptEntry(entry: DebugTranscriptEntry): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    segment: entry.segment,
    speaker: entry.speaker,
    start: round(entry.start, 3),
    end: round(entry.end, 3),
    duration: round(entry.duration, 3),
    inference: round(entry.inference, 4),
  };

  if (entry.words && entry.words.length > 0) {
    formatted.words = entry.words.map((w) => ({
      word: w.word,
      confidence: round(w.confidence, 3),
      start: round(w.start, 3),
      end: round(w.end, 3),
    }));
  }

  return formatted;
}

/**
 * Log a general debug message.
 */
export function debugLog(component: string, message: string, data?: unknown): void {
  if (data !== undefined) {
    console.log(`${PREFIX} [${component}]`, message, data);
  } else {
    console.log(`${PREFIX} [${component}]`, message);
  }
}

/**
 * Log a component's configuration as formatted JSON.
 */
export function debugLogConfig(component: string, config: Record<string, unknown>): void {
  console.log(`${PREFIX} [${component}] Configuration:\n${JSON.stringify(config, null, 2)}`);
}

/**
 * Log a structured transcript entry with required precision formatting.
 */
export function debugLogTranscript(component: string, transcript: DebugTranscriptEntry): void {
  const formatted = formatTranscriptEntry(transcript);
  console.log(`${PREFIX} [${component}] Transcript:\n${JSON.stringify(formatted, null, 2)}`);
}
