/**
 * The guardrail opt-out is RETIRED (owner decision OD-1, 2026-10-02): platform guardrail screens
 * every LLM call, request and response, with no tenant / agent / workflow / node switch.
 *
 * Stored agent and workflow JSONB written before the retirement may still carry the field, so for
 * one release the contract ACCEPTS and STRIPS it rather than refusing a row the tenant cannot
 * repair without first opening it. These tests pin both halves: the vocabulary no longer offers
 * the field, and a stored value never becomes a 400 or an opt-out.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { AGENT_PARAMETER_SCHEMAS } from '../agent-schemas';
import type { WorkflowGraph } from '../graph-model';
import * as contract from '../index';
import { NODE_CONFIG_SCHEMAS } from '../node-config-schemas';
import { publishFindings, type PublishContext } from '../publish-findings';
import {
  stripRetiredAgentGuardrailOptOut,
  stripRetiredGraphGuardrailOptOuts,
  stripRetiredNodeGuardrailOptOut,
} from '../retired-guardrail-optout';

const ctx = (): PublishContext => ({ schemaValueProblems: jsonSchemaValueProblems, templateReferenceSeverity: 'WARNING' });

function graphWithStoredOptOuts(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 't1', type: 'core.trigger', config: { kinds: ['api'], guardrail: { enabled: false } }, position: { x: 0, y: 0 } },
      { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 's' }, guardrail: { enabled: false } }, position: { x: 1, y: 0 } },
    ],
    edges: [],
  } as unknown as WorkflowGraph;
}

describe('the vocabulary no longer offers a guardrail opt-out', () => {
  it('core.trigger and core.agent declare no `guardrail` property', () => {
    for (const type of ['core.trigger', 'core.agent']) {
      const properties = (NODE_CONFIG_SCHEMAS[type] as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(properties), type).not.toContain('guardrail');
    }
  });

  it('agent `parameters.guards` declares no `enabled` switch', () => {
    const parameters = AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION as { properties: Record<string, { properties?: Record<string, unknown> }> };
    expect(Object.keys(parameters.properties.guards?.properties ?? {})).not.toContain('enabled');
  });

  it('the precedence function is gone from the public surface', () => {
    expect((contract as Record<string, unknown>).resolveGuardrailDecision).toBeUndefined();
    expect((contract as Record<string, unknown>).guardrailOptOutOf).toBeUndefined();
  });
});

describe('a stored opt-out is accepted and stripped, never a 400 and never honoured', () => {
  it('strips `guardrail` off a node config and keeps everything else', () => {
    expect(stripRetiredNodeGuardrailOptOut({ agentRef: { slug: 's' }, guardrail: { enabled: false } })).toEqual({ agentRef: { slug: 's' } });
  });

  it('returns the SAME object when there is nothing to strip (idempotent, allocation-free)', () => {
    const config = { agentRef: { slug: 's' } };
    expect(stripRetiredNodeGuardrailOptOut(config)).toBe(config);
    expect(stripRetiredNodeGuardrailOptOut(null)).toBeNull();
  });

  it('strips every node of a graph and reports whether it changed anything', () => {
    const { graph, changed } = stripRetiredGraphGuardrailOptOuts(graphWithStoredOptOuts());
    expect(changed).toBe(true);
    for (const node of graph.nodes) expect(Object.keys(node.config ?? {})).not.toContain('guardrail');
    const again = stripRetiredGraphGuardrailOptOuts(graph);
    expect(again.changed).toBe(false);
    expect(again.graph).toBe(graph);
  });

  it('strips `guards.enabled` off agent parameters, dropping an emptied `guards` block', () => {
    expect(stripRetiredAgentGuardrailOptOut({ guards: { enabled: false }, memory: 'none' })).toEqual({ memory: 'none' });
    expect(stripRetiredAgentGuardrailOptOut({ guards: { enabled: true, input: ['pii'] } })).toEqual({ guards: { input: ['pii'] } });
    const clean = { guards: { input: ['pii'] } };
    expect(stripRetiredAgentGuardrailOptOut(clean)).toBe(clean);
  });

  it('publish neither refuses a stored opt-out on schema grounds nor records it as an opt-out', () => {
    const findings = publishFindings(graphWithStoredOptOuts(), ctx());
    const codes = findings.map((finding) => finding.code);
    expect(codes).not.toContain('GUARDRAIL_OPTED_OUT');
    expect(findings.filter((finding) => finding.code === 'NODE_CONFIG_SCHEMA' && /guardrail/.test(finding.message))).toEqual([]);
  });

  it('a stored `guards.enabled` passes the agent parameters schema once stripped', () => {
    const parameters = stripRetiredAgentGuardrailOptOut({ guards: { enabled: false } });
    expect(jsonSchemaValueProblems(AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION, parameters, 'parameters')).toEqual([]);
  });
});
