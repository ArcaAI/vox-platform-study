/** TASK-1034 — where a DNA memory sample came from (mirrors the `DnaSampleSource` enum). */
export const DNA_SAMPLE_SOURCES = ['EDIT', 'SIGNOFF', 'INGEST'] as const;
export type DnaSampleSourceName = (typeof DNA_SAMPLE_SOURCES)[number];
