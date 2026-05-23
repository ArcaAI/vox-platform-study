/**
 * AudioPipelineController — route metadata tests
 *
 * Covers TASK-263 / W0-9: the validate route must be `validate` (not the
 * legacy `validate-yaml`) so that `PIPELINE_ENDPOINTS.VALIDATE` in the SDK
 * (`/admin/audio/pipelines/validate`) resolves on the backend.
 *
 * We assert the runtime decorator metadata installed by `@Post(...)` on the
 * `validateYaml` handler rather than the source string, so the test fails
 * if a future refactor changes the route in either direction.
 */
import { describe, it, expect } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AudioPipelineController } from '../audio-pipeline.controller';

describe('AudioPipelineController route metadata (TASK-263 W0-9)', () => {
  it('class-level @Controller path stays admin/audio/pipelines', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelineController);
    expect(path).toBe('admin/audio/pipelines');
  });

  it('validateYaml handler is bound to HTTP path "validate"', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelineController.prototype.validateYaml);
    expect(path).toBe('validate');
  });

  it('validateYaml handler is bound to HTTP POST', () => {
    const method = Reflect.getMetadata(METHOD_METADATA, AudioPipelineController.prototype.validateYaml);
    expect(method).toBe(RequestMethod.POST);
  });

  it('validateYaml handler must NOT be bound to the legacy "validate-yaml" path', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelineController.prototype.validateYaml);
    expect(path).not.toBe('validate-yaml');
  });
});
