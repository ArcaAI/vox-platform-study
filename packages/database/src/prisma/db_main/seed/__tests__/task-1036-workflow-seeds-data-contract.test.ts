/**
 * TASK-1036 (lane B6b) — the seeded workflow blobs are what a REAL publish stamps today.
 *
 * Since wave B a publish compiles with the data contract on (`workflows.emitDataContract`), with
 * the referenced agents' task + output schema (`agents`), and with W3's pins applied: every
 * `core.agent` node carries `agentRef.versionNumber` (the seeded agent version) and
 * `policyBindings.promptTemplateRefs` names the prompt each pinned agent version runs. The regen
 * script used to compile without any of that, so a seeded workflow was a pre-contract artifact the
 * interpreter could only run on the legacy path.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { WORKFLOW_LIBRARY_TARGETS } from '../28-workflow-library';
import { WORKFLOW_LIBRARY_GENERATED } from '../28-workflow-library.generated';
import { ARCAAI_WORKFLOW_TARGETS } from '../29-arcaai-agents-and-workflows';
import { ARCAAI_GENERATED } from '../29-arcaai-agents-and-workflows.generated';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGEN_SRC = path.resolve(HERE, '../../../../../scripts/regen-workflow-seeds.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { engineOutputFor }: any = await import(/* @vite-ignore */ REGEN_SRC);
const CONTRACT_DIST = path.resolve(HERE, '../../../../../../workflow-contract/dist/index.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const contract: any = await import(/* @vite-ignore */ CONTRACT_DIST);
const checksum: string = contract.registryChecksum();

type CompiledNode = { nodeId: string; type: string; config: Record<string, unknown>; bindings?: Record<string, unknown> };
const nodesOf = (compiled: Record<string, unknown>): CompiledNode[] =>
  (compiled.stages as Array<{ nodes: CompiledNode[] }>).flatMap((stage) => stage.nodes);

const TARGETS = [...WORKFLOW_LIBRARY_TARGETS, ...ARCAAI_WORKFLOW_TARGETS];

describe('regen compiles every seeded workflow as a real publish does', () => {
  it.each(TARGETS.map((target) => [target.key, target] as const))('%s — data contract, agent pins, prompt pins', (_key, target) => {
    const output = engineOutputFor(target, checksum);
    expect(output.problems).toEqual([]);
    const compiled = output.compiledConfig;

    // The data contract: frozen settings, and node bindings.
    expect(compiled.settings).toBeDefined();
    expect(nodesOf(compiled).some((node) => node.bindings !== undefined)).toBe(true);

    // W3: every agent node is pinned to the seeded agent version.
    const agentNodes = nodesOf(compiled).filter((node) => node.type === 'core.agent');
    expect(agentNodes.length).toBeGreaterThan(0);
    for (const node of agentNodes) expect((node.config.agentRef as { versionNumber?: unknown }).versionNumber).toBe(1);

    // W3: the prompt each pinned TEXT agent runs is named, at a concrete version.
    const promptRefs = (compiled.policyBindings as { promptTemplateRefs: Array<{ nodeId: string; templateId: string; versionNumber: number }> })
      .promptTemplateRefs;
    expect(promptRefs.length).toBeGreaterThan(0);
    for (const ref of promptRefs) expect(Number.isInteger(ref.versionNumber) && ref.versionNumber >= 1).toBe(true);

    // The authored graph is never rewritten — only the compiled artifact carries the pins.
    for (const node of target.graph.nodes.filter((n: { type: string }) => n.type === 'core.agent')) {
      expect((node.config.agentRef as { versionNumber?: unknown }).versionNumber).toBeUndefined();
    }
  });

  it('the committed blobs ARE that output (regenerated, never hand-patched)', () => {
    for (const target of WORKFLOW_LIBRARY_TARGETS) {
      expect(WORKFLOW_LIBRARY_GENERATED[target.key]?.compiledConfig).toEqual(engineOutputFor(target, checksum).compiledConfig);
    }
    for (const target of ARCAAI_WORKFLOW_TARGETS) {
      expect(ARCAAI_GENERATED[target.key]?.compiledConfig).toEqual(engineOutputFor(target, checksum).compiledConfig);
    }
  });
});
