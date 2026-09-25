/**
 * TASK-1006 (following TASK-865, "the browser never runs a model") — the R4
 * removal of every client-side inference path and pre-agent selector from
 * @arcaai/vox. This pins the absence in one place so a future change cannot
 * silently reintroduce any of it. Behavioral coverage for what replaced each
 * surface lives in the rewritten test files named in the comments below;
 * this file is existence-only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(__dirname, '..', '..');

describe('deleted hooks (TASK-1006)', () => {
  it.each(['usePipelines.ts', 'useArcaPipelines.ts', 'useSttProviderToggle.ts', 'useLocalVoiceEmbedding.ts', 'useGatedClientStages.ts'])(
    'src/hooks/%s no longer exists',
    (file) => {
      expect(existsSync(join(PACKAGE_ROOT, 'src', 'hooks', file))).toBe(false);
    },
  );

  it('none of the deleted hooks are exported from the core.ts barrel', async () => {
    const core = await import('../core.js');
    for (const name of ['usePipelines', 'useArcaPipelines', 'useSttProviderToggle', 'useLocalVoiceEmbedding', 'useGatedClientStages']) {
      expect(core).not.toHaveProperty(name);
    }
  });
});

describe('deleted core modules (TASK-1006)', () => {
  it.each(['LocalVoiceEmbedder.ts', 'clientInferenceGate.ts', 'PipelineRegistry.ts', 'ProcessedAudioTap.ts'])(
    'src/core/%s no longer exists',
    (file) => {
      expect(existsSync(join(PACKAGE_ROOT, 'src', 'core', file))).toBe(false);
    },
  );

  it('src/utils/voiceEmbedding.ts no longer exists', () => {
    expect(existsSync(join(PACKAGE_ROOT, 'src', 'utils', 'voiceEmbedding.ts'))).toBe(false);
  });
});

describe('the ./plugins/med-ner entry point is gone (TASK-1006)', () => {
  it('package.json#exports has no ./plugins/med-ner entry', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
      typesVersions?: { '*'?: Record<string, unknown> };
    };
    expect(Object.keys(pkg.exports)).not.toContain('./plugins/med-ner');
    expect(Object.keys(pkg.typesVersions?.['*'] ?? {})).not.toContain('plugins/med-ner');
  });

  it('src/plugins-med-ner.ts no longer exists', () => {
    expect(existsSync(join(PACKAGE_ROOT, 'src', 'plugins-med-ner.ts'))).toBe(false);
  });

  it('tsup.config.ts declares no plugins-med-ner build entry', () => {
    const config = readFileSync(join(PACKAGE_ROOT, 'tsup.config.ts'), 'utf8');
    expect(config).not.toMatch(/['"]plugins-med-ner['"]/);
  });
});

describe('./plugins no longer re-exports the gated client-AI hooks (TASK-1006)', () => {
  it('useVAD / useSTT / useNoiseFilter / useMedNER / useSttProviderToggle / createProcessedAudioTap are absent', async () => {
    const plugins = await import('../plugins.js');
    for (const name of ['useVAD', 'useSTT', 'useNoiseFilter', 'useMedNER', 'useSttProviderToggle', 'createProcessedAudioTap']) {
      expect(plugins).not.toHaveProperty(name);
    }
  });
});

describe('the three retired client-AI packages are gone (TASK-1006)', () => {
  it('package.json lists no dependency on @arcaai/vad / @arcaai/noise-filter / @arcaai/med-ner', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.devDependencies,
    };
    for (const name of ['@arcaai/vad', '@arcaai/noise-filter', '@arcaai/med-ner']) {
      expect(Object.keys(allDeps)).not.toContain(name);
    }
  });

  it('the package directories no longer exist in the monorepo', () => {
    const monorepoPackages = resolve(PACKAGE_ROOT, '..');
    for (const dir of ['vad', 'noise-filter', 'med-ner']) {
      expect(existsSync(join(monorepoPackages, dir, 'package.json'))).toBe(false);
    }
  });
});

describe('pipeline selection is agentSlug-only — pipelineId removed from every REQUEST-side type (TASK-1006)', () => {
  it('CreateStreamingSessionRequest carries no pipelineId field', async () => {
    // Type-level pin: this file would fail to compile (not just fail at
    // runtime) if `pipelineId` were reintroduced as a valid property, since
    // TS would then allow assigning it below without error — so the
    // meaningful assertion is the successful compile plus this explicit
    // runtime check that the key is genuinely absent from a real object.
    const { StreamingSessionManager } = await import('../core/StreamingSessionManager.js');
    expect(StreamingSessionManager).toBeDefined();
    const req: import('../types/stt').CreateStreamingSessionRequest = { agentSlug: 'clinic-asr' };
    expect('pipelineId' in req).toBe(false);
  });

  it('BatchTranscriptionOptions and FileTranscribeOptions carry no pipelineId field', async () => {
    // Same pin, for the batch/file-upload selectors: uploading a file was the
    // last ASR request-side surface still accepting the deprecated
    // `pipelineId` (BatchTranscriptionQueue refused to upload at all without
    // one). `enqueue`/`uploadAndTranscribe` now accept only `agentSlug`, or
    // neither — the gateway resolves the tenant assignment cascade.
    const { BatchTranscriptionQueue } = await import('../core/BatchTranscriptionQueue.js');
    const { FileTranscriptionService } = await import('../core/FileTranscriptionService.js');
    expect(BatchTranscriptionQueue).toBeDefined();
    expect(FileTranscriptionService).toBeDefined();
    const batchOptions: import('../core/BatchTranscriptionQueue').BatchTranscriptionOptions = { agentSlug: 'clinic-asr' };
    const fileOptions: import('../core/FileTranscriptionService').FileTranscribeOptions = { agentSlug: 'clinic-asr' };
    expect('pipelineId' in batchOptions).toBe(false);
    expect('pipelineId' in fileOptions).toBe(false);
  });
});

describe('dead pipeline-local-processing types removed from types/config.ts (TASK-1006)', () => {
  // These were TYPE-only exports (`export interface`/`export type`), which
  // erase at build time and never appear as a runtime property of the
  // imported module either way — so the meaningful check reads the source
  // text directly, the same pattern `compat-removed.task1004.test.ts` uses
  // for its tsup.config.ts assertion.
  it('none of the dead ProcessingConfig-family symbols remain in types/config.ts or its barrel', () => {
    const configSrc = readFileSync(join(PACKAGE_ROOT, 'src', 'types', 'config.ts'), 'utf8');
    const indexSrc = readFileSync(join(PACKAGE_ROOT, 'src', 'types', 'index.ts'), 'utf8');
    for (const name of [
      'ProcessingConfig',
      'TranscriptionProcessingConfig',
      'KnowledgeProcessingConfig',
      'DEFAULT_PROCESSING_CONFIG',
      'ProcessingLocation',
    ]) {
      expect(configSrc).not.toMatch(new RegExp(`\\b${name}\\b`));
      expect(indexSrc).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
