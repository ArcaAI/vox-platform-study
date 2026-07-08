/**
 * AiInferenceController unit tests (TASK-446). The controller maps the
 * validated camelCase DTOs to the upstream snake_case body (with defaults) and
 * proxies the client response verbatim.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiInferenceController } from '../ai-inference.controller';

function makeController() {
  const client = { analyzeGuardrail: vi.fn(), classifyTokens: vi.fn() };
  const controller = new AiInferenceController(client as never);
  return { controller, client };
}

describe('AiInferenceController', () => {
  it('maps guardrailType → guardrail_type and returns the verdict verbatim', async () => {
    const { controller, client } = makeController();
    const verdict = { safe: true, issues: [], confidence: 0.1 };
    client.analyzeGuardrail.mockResolvedValue(verdict);

    const result = await controller.analyzeGuardrail({ text: 'hello', guardrailType: 'pii_detection' });

    expect(client.analyzeGuardrail).toHaveBeenCalledWith({ text: 'hello', guardrail_type: 'pii_detection' });
    expect(result).toBe(verdict);
  });

  it('defaults guardrail_type to comprehensive when omitted', async () => {
    const { controller, client } = makeController();
    client.analyzeGuardrail.mockResolvedValue({});
    await controller.analyzeGuardrail({ text: 'hello' });
    expect(client.analyzeGuardrail).toHaveBeenCalledWith({ text: 'hello', guardrail_type: 'comprehensive' });
  });

  it('maps aggregationStrategy → aggregation_strategy (default simple) and omits language when absent', async () => {
    const { controller, client } = makeController();
    const entities = { entities: [], model_version: 'v1' };
    client.classifyTokens.mockResolvedValue(entities);

    const result = await controller.extractEntities({ text: 'aspirin 100mg' });

    expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'aspirin 100mg', aggregation_strategy: 'simple' });
    expect(result).toBe(entities);
  });

  it('forwards language and a custom aggregation strategy when supplied', async () => {
    const { controller, client } = makeController();
    client.classifyTokens.mockResolvedValue({});
    await controller.extractEntities({ text: 'x', aggregationStrategy: 'max', language: 'vi' });
    expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'x', aggregation_strategy: 'max', language: 'vi' });
  });
});
