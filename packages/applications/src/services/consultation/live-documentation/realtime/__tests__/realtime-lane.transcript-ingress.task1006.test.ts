/**
 * TASK-1006 (A-2) — the caller-supplied transcript never reaches the LIVE lane.
 *
 * Every seeded consultation graph now carries `n_transcript` (a DURABLE `core.data` reshape of the
 * trigger's `transcript` kind) bound into `n_ner.in` beside `n_asr.transcript`. On a recorded
 * consultation the live executor owns `n_asr` / `n_ner` / the summarizers, and `buildRealtimeLane`
 * drops every binding whose producer is not a realtime node — so the lane a recording runs is the
 * lane it ran before: the ASR transcript is `n_ner`'s only input, and `n_transcript` is not in it.
 *
 * Read from the REGENERATED seed blobs by computed path, as the other seeded-lane suites do.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildRealtimeLane } from '../realtime-lane';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(HERE, '../../../../../../../database/src/prisma/db_main/seed');

/* eslint-disable @typescript-eslint/no-explicit-any */
const arcaaiSeed: any = await import(/* @vite-ignore */ `${SEED_DIR}/29-arcaai-agents-and-workflows.generated.ts`);
const librarySeed: any = await import(/* @vite-ignore */ `${SEED_DIR}/28-workflow-library.generated.ts`);

const CONSULTATION_BLOBS: Array<[string, any]> = [
  ...Object.entries(arcaaiSeed.ARCAAI_GENERATED as Record<string, any>),
  ...Object.entries(librarySeed.WORKFLOW_LIBRARY_GENERATED as Record<string, any>),
].filter(([key]) => key.endsWith('-consultation'));

describe('the live lane of every seeded consultation graph', () => {
  it('covers the eleven ArcaAI graphs and both library copies', () => {
    expect(CONSULTATION_BLOBS).toHaveLength(13);
  });

  it.each(CONSULTATION_BLOBS)('%s — NER reads only the ASR transcript; the reshape is durable', (_key, blob) => {
    // The compiled graph DOES bind both sources…
    const compiledNer = blob.compiledConfig.stages.flatMap((stage: any) => stage.nodes).find((node: any) => node.nodeId === 'n_ner');
    expect(compiledNer.inputs.map((b: any) => `${b.fromNodeId}.${b.fromPort}`).sort()).toEqual(['n_asr.transcript', 'n_transcript.text']);

    // …and the live lane keeps only the realtime one.
    const lane = buildRealtimeLane(blob.compiledConfig);
    expect(lane).not.toBeNull();
    const laneNodes = lane!.stages.flatMap((stage) => stage.nodes);
    expect(laneNodes.map((node) => node.nodeId)).not.toContain('n_transcript');
    const ner = laneNodes.find((node) => node.nodeId === 'n_ner');
    expect(ner?.inputs).toEqual([{ fromNodeId: 'n_asr', fromPort: 'transcript', toPort: 'in' }]);
  });
});
