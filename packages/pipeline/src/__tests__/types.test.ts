/**
 * @arcaai/pipeline - Types Tests
 *
 * Unit tests for type definitions and constants.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  PipelineEvent,
  PipelineErrorCode,
  PipelineError,
  DEFAULT_PIPELINE_STATE,
  DEFAULT_STAGE_CONFIG,
} from '../types/index.js';

describe('Pipeline Types', () => {
  describe('DEFAULT_PIPELINE_STATE', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_PIPELINE_STATE.status).toBe('IDLE');
      expect(DEFAULT_PIPELINE_STATE.progress).toBe(0);
      expect(DEFAULT_PIPELINE_STATE.completedStages).toBe(0);
      expect(DEFAULT_PIPELINE_STATE.totalStages).toBe(0);
      expect(DEFAULT_PIPELINE_STATE.lastUpdated).toBeGreaterThan(0);
    });
  });

  describe('DEFAULT_STAGE_CONFIG', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_STAGE_CONFIG.enabled).toBe(true);
      expect(DEFAULT_STAGE_CONFIG.priority).toBe(0);
    });
  });

  describe('PipelineEvent', () => {
    it('should have all required events', () => {
      expect(PipelineEvent.Started).toBe('started');
      expect(PipelineEvent.Completed).toBe('completed');
      expect(PipelineEvent.Error).toBe('error');
      expect(PipelineEvent.Paused).toBe('paused');
      expect(PipelineEvent.Resumed).toBe('resumed');
      expect(PipelineEvent.Cancelled).toBe('cancelled');
      expect(PipelineEvent.StateChange).toBe('stateChange');
      expect(PipelineEvent.StageStarted).toBe('stageStarted');
      expect(PipelineEvent.StageCompleted).toBe('stageCompleted');
      expect(PipelineEvent.StageFailed).toBe('stageFailed');
      expect(PipelineEvent.StageSkipped).toBe('stageSkipped');
      expect(PipelineEvent.Data).toBe('data');
    });
  });

  describe('PipelineErrorCode', () => {
    it('should have all required error codes', () => {
      expect(PipelineErrorCode.STAGE_FAILED).toBe('STAGE_FAILED');
      expect(PipelineErrorCode.TIMEOUT).toBe('TIMEOUT');
      expect(PipelineErrorCode.CANCELLED).toBe('CANCELLED');
      expect(PipelineErrorCode.INVALID_INPUT).toBe('INVALID_INPUT');
      expect(PipelineErrorCode.CONFIGURATION_ERROR).toBe('CONFIGURATION_ERROR');
      expect(PipelineErrorCode.INITIALIZATION_ERROR).toBe('INITIALIZATION_ERROR');
      expect(PipelineErrorCode.NOT_INITIALIZED).toBe('NOT_INITIALIZED');
      expect(PipelineErrorCode.ALREADY_RUNNING).toBe('ALREADY_RUNNING');
    });
  });

  describe('PipelineError', () => {
    it('should create error with code and message', () => {
      const error = new PipelineError(PipelineErrorCode.STAGE_FAILED, 'Test error');

      expect(error.name).toBe('PipelineError');
      expect(error.code).toBe('STAGE_FAILED');
      expect(error.message).toBe('Test error');
      expect(error instanceof Error).toBe(true);
    });

    it('should create error with stage option', () => {
      const error = new PipelineError(PipelineErrorCode.STAGE_FAILED, 'Stage error', {
        stage: 'test-stage',
      });

      expect(error.stage).toBe('test-stage');
    });

    it('should create error with cause option', () => {
      const cause = new Error('Original error');
      const error = new PipelineError(PipelineErrorCode.STAGE_FAILED, 'Wrapper error', {
        cause,
      });

      expect(error.cause).toBe(cause);
    });

    it('should create error with all options', () => {
      const cause = new Error('Original error');
      const error = new PipelineError(PipelineErrorCode.STAGE_FAILED, 'Full error', {
        stage: 'test-stage',
        cause,
      });

      expect(error.code).toBe('STAGE_FAILED');
      expect(error.stage).toBe('test-stage');
      expect(error.cause).toBe(cause);
    });

    it('should be catchable as Error', () => {
      const error = new PipelineError(PipelineErrorCode.CANCELLED, 'Cancelled');

      expect(() => {
        throw error;
      }).toThrow('Cancelled');

      try {
        throw error;
      } catch (e) {
        expect(e instanceof Error).toBe(true);
        expect(e instanceof PipelineError).toBe(true);
      }
    });
  });
});
