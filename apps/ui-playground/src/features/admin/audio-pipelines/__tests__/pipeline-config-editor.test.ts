/**
 * PipelineConfigEditor — per-pipeline dual_capture authoring (TASK-333 T5)
 *
 * Verifies the YAML <-> PipelineConfig round-trip for the dual-capture toggles:
 *   - preprocessing.dual_capture.{enabled, capture_raw}
 *   - postprocessing.dual_capture.{enabled, capture_processed}
 *
 * Tests the pure parse/serialize helpers (no render needed).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';

import { DEFAULT_CONFIG, configToYaml, tryParseYaml } from '../pipeline-config-editor';

const minimalYaml = ['version: "1.1"', 'models:', '  asr: openai/whisper-large-v3-turbo', ''].join('\n');

describe('PipelineConfigEditor dual_capture (TASK-333 T5)', () => {
  it('exposes disabled dual_capture toggles on DEFAULT_CONFIG', () => {
    expect(DEFAULT_CONFIG.preprocessing.dual_capture).toEqual({ enabled: false, capture_raw: false });
    expect(DEFAULT_CONFIG.postprocessing.dual_capture).toEqual({ enabled: false, capture_processed: false });
  });

  it('defaults dual_capture to disabled when the YAML omits it', () => {
    const config = tryParseYaml(minimalYaml);
    expect(config).not.toBeNull();
    expect(config!.preprocessing.dual_capture).toEqual({ enabled: false, capture_raw: false });
    expect(config!.postprocessing.dual_capture).toEqual({ enabled: false, capture_processed: false });
  });

  it('parses preprocessing.capture_raw and postprocessing.capture_processed from YAML', () => {
    const yaml = [
      'version: "1.1"',
      'models:',
      '  asr: openai/whisper-large-v3-turbo',
      'preprocessing:',
      '  dual_capture:',
      '    enabled: true',
      '    capture_raw: true',
      'postprocessing:',
      '  dual_capture:',
      '    enabled: true',
      '    capture_processed: true',
      '',
    ].join('\n');

    const config = tryParseYaml(yaml);
    expect(config).not.toBeNull();
    expect(config!.preprocessing.dual_capture).toEqual({ enabled: true, capture_raw: true });
    expect(config!.postprocessing.dual_capture).toEqual({ enabled: true, capture_processed: true });
  });

  it('round-trips dual_capture through serialize -> parse', () => {
    const config = tryParseYaml(
      [
        'version: "1.1"',
        'models:',
        '  asr: openai/whisper-large-v3-turbo',
        'preprocessing:',
        '  dual_capture: { enabled: true, capture_raw: true }',
        'postprocessing:',
        '  dual_capture: { enabled: true, capture_processed: true }',
        '',
      ].join('\n'),
    );
    expect(config).not.toBeNull();

    const yaml = configToYaml(config!);
    expect(yaml).toContain('dual_capture');

    const reparsed = tryParseYaml(yaml);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.preprocessing.dual_capture.enabled).toBe(true);
    expect(reparsed!.preprocessing.dual_capture.capture_raw).toBe(true);
    expect(reparsed!.postprocessing.dual_capture.enabled).toBe(true);
    expect(reparsed!.postprocessing.dual_capture.capture_processed).toBe(true);
  });
});
