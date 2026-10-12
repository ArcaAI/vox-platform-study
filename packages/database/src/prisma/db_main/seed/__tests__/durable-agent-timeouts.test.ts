/**
 * Every seeded DURABLE `core.agent` node gets more time than one model call may take.
 *
 * The harness runs a durable `core.agent` node as one Temporal activity whose `start_to_close`
 * timeout is the node's compiled `timeoutSeconds`, and the harness LLM governor lets ONE call run
 * for `HARNESS_LLM_REQUEST_TIMEOUT_S` (300 s by default) once it holds its endpoint slot. A node
 * budget equal to that per-call bound leaves no room for the slot wait, a truncation retry or the
 * coverage repair: measured at three concurrent sessions, `n_finalize` was cancelled by Temporal at
 * exactly 300 s mid-repair and the run ended without a clinical result.
 *
 * Realtime-lane nodes are out of scope: the live executor runs them, not a harness activity.
 */
import { describe, expect, it } from 'vitest';

import { WORKFLOW_LIBRARY_GENERATED } from '../28-workflow-library.generated';
import { ARCAAI_GENERATED } from '../29-arcaai-agents-and-workflows.generated';

/** The harness governor's default per-call timeout (`apps/harness` `LlmGovernorConfig.request_timeout_s`). */
const HARNESS_LLM_REQUEST_TIMEOUT_S = 300;
/** Headroom for the endpoint slot wait and the activity's own work around the call. */
const MARGIN_S = 60;

type CompiledNode = {
  nodeId: string;
  type: string;
  timeoutSeconds: number;
  config: { execution?: { lane?: string } };
};

const durableAgents = Object.entries({ ...WORKFLOW_LIBRARY_GENERATED, ...ARCAAI_GENERATED }).flatMap(([key, blob]) =>
  ((blob.compiledConfig.stages as Array<{ nodes: CompiledNode[] }>) ?? [])
    .flatMap((stage) => stage.nodes)
    .filter((node) => node.type === 'core.agent' && node.config.execution?.lane !== 'realtime')
    .map((node) => [`${key} ${node.nodeId}`, node] as const),
);

describe('seeded durable agent nodes outlast one governed model call', () => {
  it('covers at least one durable agent per seeded library', () => {
    expect(durableAgents.length).toBeGreaterThan(0);
  });

  it.each(durableAgents)('%s', (_label, node) => {
    expect(node.timeoutSeconds).toBeGreaterThan(HARNESS_LLM_REQUEST_TIMEOUT_S + MARGIN_S);
  });
});
