/**
 * per-provider REQUIRED FIELDS.
 *
 * The defect: `extraJson` was shape-checked but nothing said which fields a
 * given provider actually NEEDS, so an Azure connection could be saved with no
 * deployment name and would fail at request time — in a worker, hours later,
 * with a vendor error — instead of at save time, in the console, naming the
 * field the operator forgot.
 *
 * These tests pin the two halves that matter: a provider that needs a field is
 * REFUSED without it and the message NAMES it, and a self-hosted engine that
 * legitimately has no key still SAVES. "Required fields" must never collapse
 * into "every provider needs a key".
 */
import { describe, expect, it } from 'vitest';
import { PROVIDER_REQUIREMENTS, requirementsFor, validateProviderRequirements } from '../provider-requirements';

/** A row that satisfies nothing — each test adds only what it is testing. */
const bare = {
  enabled: true,
  baseUrl: null,
  region: null,
  apiVersion: null,
  deploymentName: null,
  hasApiKey: false,
  extraJson: null,
};

describe('provider requirements — the declared sets', () => {
  it('declares a requirement for every provider the owner table names', () => {
    for (const key of [
      'llm:lm-studio',
      'llm:ollama',
      'llm:llama-cpp',
      'llm:azure',
      'llm:bedrock',
      'model-registry:huggingface',
      'model-registry:s3',
    ]) {
      expect(PROVIDER_REQUIREMENTS[key], `${key} has no declared requirement`).toBeDefined();
    }
  });

  it('every declaration carries a rationale — a requirement nobody can explain is a requirement nobody can remove', () => {
    for (const [key, requirement] of Object.entries(PROVIDER_REQUIREMENTS)) {
      expect(requirement.why.length, `${key} declares no rationale`).toBeGreaterThan(20);
    }
  });

  it('an undeclared (service, provider) requires nothing — the default is permissive, not a guess', () => {
    expect(requirementsFor('llm', 'some-future-engine')).toBeUndefined();
    expect(validateProviderRequirements('llm', 'some-future-engine', bare)).toEqual([]);
  });
});

describe('self-hosted engines — URL required, key NOT', () => {
  it.each(['lm-studio', 'ollama'])('%s saves keyless when the server URL is present', (provider) => {
    expect(validateProviderRequirements('llm', provider, { ...bare, baseUrl: 'http://localhost:1234/v1' })).toEqual([]);
  });

  it.each(['lm-studio', 'ollama'])('%s is refused without a server URL, naming baseUrl', (provider) => {
    const errors = validateProviderRequirements('llm', provider, bare);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('baseUrl');
  });

  it('never demands an apiKey from a self-hosted engine', () => {
    for (const provider of ['lm-studio', 'ollama', 'llama-cpp']) {
      expect(PROVIDER_REQUIREMENTS[`llm:${provider}`]?.columns).not.toContain('apiKey');
    }
  });

  it('a blank string is not a value — whitespace does not satisfy a required column', () => {
    const errors = validateProviderRequirements('llm', 'ollama', { ...bare, baseUrl: '   ' });
    expect(errors[0]).toContain('baseUrl');
  });
});

describe('llama.cpp — server URL AND a model path', () => {
  const withUrl = { ...bare, baseUrl: 'http://hope-llama-cpp:8080' };

  it('is refused when the model path is missing, naming it', () => {
    const errors = validateProviderRequirements('llm', 'llama-cpp', withUrl);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('modelPath');
  });

  it('accepts an absolute filesystem path', () => {
    expect(validateProviderRequirements('llm', 'llama-cpp', { ...withUrl, extraJson: { modelPath: '/models/llama-3.gguf' } })).toEqual([]);
  });

  it('accepts a MinIO/S3 model URL', () => {
    expect(validateProviderRequirements('llm', 'llama-cpp', { ...withUrl, extraJson: { modelPath: 's3://models/llama-3.gguf' } })).toEqual([]);
  });

  it('REFUSES a relative path — the resolver has no working directory to resolve it against', () => {
    const errors = validateProviderRequirements('llm', 'llama-cpp', { ...withUrl, extraJson: { modelPath: 'models/llama-3.gguf' } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('modelPath');
  });

  it('reports BOTH misses when the URL is absent too — an operator fixes one round trip, not two', () => {
    expect(validateProviderRequirements('llm', 'llama-cpp', bare)).toHaveLength(2);
  });
});

describe('azure — endpoint, api version, deployment, key', () => {
  const complete = {
    ...bare,
    baseUrl: 'https://acme.openai.azure.com',
    apiVersion: '2024-10-21',
    deploymentName: 'gpt-4o-mini',
    hasApiKey: true,
  };

  it('accepts a complete connection', () => {
    expect(validateProviderRequirements('llm', 'azure', complete)).toEqual([]);
  });

  it('is refused without a deployment, and the message NAMES deploymentName', () => {
    const errors = validateProviderRequirements('llm', 'azure', { ...complete, deploymentName: null });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('deploymentName');
  });

  it.each(['baseUrl', 'apiVersion', 'deploymentName'] as const)('is refused without %s', (field) => {
    const errors = validateProviderRequirements('llm', 'azure', { ...complete, [field]: null });
    expect(errors[0]).toContain(field);
  });

  it('is refused without a key — azure is a vendor account, keyless is not a state it has', () => {
    const errors = validateProviderRequirements('llm', 'azure', { ...complete, hasApiKey: false });
    expect(errors[0]).toContain('apiKey');
  });
});

describe('bedrock — region and credentials', () => {
  it('accepts region + key', () => {
    expect(validateProviderRequirements('llm', 'bedrock', { ...bare, region: 'us-east-1', hasApiKey: true })).toEqual([]);
  });

  it('is refused without a region, naming it', () => {
    const errors = validateProviderRequirements('llm', 'bedrock', { ...bare, hasApiKey: true });
    expect(errors[0]).toContain('region');
  });

  it('is refused without credentials', () => {
    const errors = validateProviderRequirements('llm', 'bedrock', { ...bare, region: 'us-east-1' });
    expect(errors[0]).toContain('apiKey');
  });
});

/**
 * TASK-932 D-7/D-8 amended the two `model-registry` rows: they are the
 * PLATFORM's built-in weight-fetch plane, seeded ENABLED and blank. A blank
 * enabled row is therefore a configured state — the platform storage
 * credentials for `s3`, an anonymous pull for `huggingface` — and only a
 * PARTLY-filled row is refused.
 */
describe('model-registry — the built-in weight-fetch plane', () => {
  it('huggingface accepts a blank enabled row — that IS the anonymous built-in default', () => {
    expect(validateProviderRequirements('model-registry', 'huggingface', bare)).toEqual([]);
  });

  it('huggingface requires a model id once a token is supplied — half a configuration is neither', () => {
    const errors = validateProviderRequirements('model-registry', 'huggingface', { ...bare, hasApiKey: true });
    expect(errors.join(' ')).toContain('model');
  });

  it('huggingface accepts an explicit model id with a token — there is no discovery here', () => {
    expect(
      validateProviderRequirements('model-registry', 'huggingface', { ...bare, hasApiKey: true, extraJson: { model: 'openai/whisper-large-v3' } }),
    ).toEqual([]);
  });

  it('s3 accepts a blank enabled row — the platform storage credentials serve it', () => {
    expect(validateProviderRequirements('model-registry', 's3', bare)).toEqual([]);
  });

  it('s3 accepts the platform-storage marker without any credential material', () => {
    expect(validateProviderRequirements('model-registry', 's3', { ...bare, extraJson: { inheritsPlatformStorage: true } })).toEqual([]);
  });

  it('s3 requires an endpoint, a secret key and the access key id once ANY of them is supplied', () => {
    const errors = validateProviderRequirements('model-registry', 's3', { ...bare, baseUrl: 'minio:9000' });
    expect(errors.join(' ')).toContain('apiKey');
    expect(errors.join(' ')).toContain('accessKeyId');
  });

  it('s3 accepts a complete connection', () => {
    expect(
      validateProviderRequirements('model-registry', 's3', {
        ...bare,
        baseUrl: 'minio:9000',
        hasApiKey: true,
        extraJson: { accessKeyId: 'hope-models' },
      }),
    ).toEqual([]);
  });
});

describe('DISABLED rows are exempt — the veto must stay expressible', () => {
  it('a disabled azure row with nothing on it is accepted', () => {
    // `enabled: false` IS the tenant's veto (`CONNECTION_ENABLED_SEMANTICS`). A
    // tenant refusing Azure has no Azure endpoint, deployment or key to supply,
    // so requiring them would make the refusal unsayable. Nothing that never
    // serves a request can fail at request time.
    expect(validateProviderRequirements('llm', 'azure', { ...bare, enabled: false })).toEqual([]);
  });

  it('a disabled llama-cpp row needs no model path', () => {
    expect(validateProviderRequirements('llm', 'llama-cpp', { ...bare, enabled: false })).toEqual([]);
  });
});

describe('messages', () => {
  it('never echo the stored value — only the field name and why it is needed', () => {
    // A PARTLY-filled row (TASK-932 D-7: a blank one is the built-in default),
    // so the message under test is actually produced.
    const errors = validateProviderRequirements('model-registry', 's3', { ...bare, baseUrl: 'https://minio.internal:9000', extraJson: {} });
    expect(errors.join(' ')).not.toContain('minio');
    expect(errors.join(' ')).toContain('accessKeyId');
  });

  it('name the provider and service so a console toast is actionable on its own', () => {
    const [message] = validateProviderRequirements('llm', 'azure', bare);
    expect(message).toContain('azure');
    expect(message).toContain('llm');
  });
});
