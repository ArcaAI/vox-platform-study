/**
 * @arcaai/pipeline - E2E Tests
 *
 * End-to-end tests for sequential pipelines, parallel pipelines, and orchestrator.
 */

import { test, expect, type Page } from '@playwright/test';

test.describe('@arcaai/pipeline E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for page to be fully loaded
    await page.waitForFunction(() => window.PipelineStage !== undefined);
  });

  test.describe('Module Loading', () => {
    test('should load all pipeline exports', async ({ page }) => {
      const exports = await page.evaluate(() => ({
        hasPipelineStage: typeof window.PipelineStage === 'function',
        hasSequentialPipeline: typeof window.SequentialPipeline === 'function',
        hasParallelPipeline: typeof window.ParallelPipeline === 'function',
        hasPipelineOrchestrator: typeof window.PipelineOrchestrator === 'function',
        hasPipelineEvent: typeof window.PipelineEvent === 'object',
        hasOrchestratorEvent: typeof window.OrchestratorEvent === 'object',
        hasPipelineError: typeof window.PipelineError === 'function',
        hasPipelineErrorCode: typeof window.PipelineErrorCode === 'object',
      }));

      expect(exports.hasPipelineStage).toBe(true);
      expect(exports.hasSequentialPipeline).toBe(true);
      expect(exports.hasParallelPipeline).toBe(true);
      expect(exports.hasPipelineOrchestrator).toBe(true);
      expect(exports.hasPipelineEvent).toBe(true);
      expect(exports.hasOrchestratorEvent).toBe(true);
      expect(exports.hasPipelineError).toBe(true);
      expect(exports.hasPipelineErrorCode).toBe(true);
    });
  });

  test.describe('Sequential Pipeline', () => {
    test('should create sequential pipeline', async ({ page }) => {
      await page.click('#btn-seq-create');

      // Check state updated
      await expect(page.locator('#seq-state')).toHaveText('IDLE');

      // Check pipeline is created
      const hasSeqPipeline = await page.evaluate(() => window.seqPipeline !== null);
      expect(hasSeqPipeline).toBe(true);
    });

    test('should add stages to sequential pipeline', async ({ page }) => {
      await page.click('#btn-seq-create');
      await page.click('#btn-seq-add-stages');

      // Verify stages were added
      await expect(page.locator('#seq-stages')).toHaveText('3 stages');

      // Verify stage names in list
      await expect(page.locator('#seq-stages-list')).toContainText('add-5');
      await expect(page.locator('#seq-stages-list')).toContainText('multiply-2');
      await expect(page.locator('#seq-stages-list')).toContainText('add-10');
    });

    test('should execute sequential pipeline with correct result', async ({ page }) => {
      await page.click('#btn-seq-create');
      await page.click('#btn-seq-add-stages');

      // Set input value
      await page.fill('#seq-input', '10');

      await page.click('#btn-seq-execute');

      // Wait for completion
      await expect(page.locator('#seq-state')).toHaveText('COMPLETED', { timeout: 10000 });

      // Check result: ((10 + 5) * 2) + 10 = 40
      await expect(page.locator('#seq-result')).toContainText('Result: 40');

      // Verify result in window
      const result = await page.evaluate(() => window.seqResult);
      expect(result).toBe(40);
    });

    test('should execute with different input values', async ({ page }) => {
      await page.click('#btn-seq-create');
      await page.click('#btn-seq-add-stages');

      // Test with 0
      await page.fill('#seq-input', '0');
      await page.click('#btn-seq-execute');
      await expect(page.locator('#seq-state')).toHaveText('COMPLETED', { timeout: 10000 });
      let result = await page.evaluate(() => window.seqResult);
      expect(result).toBe(20); // ((0 + 5) * 2) + 10 = 20

      // Reset and test with negative
      await page.click('#btn-seq-reset');
      await page.fill('#seq-input', '-5');
      await page.click('#btn-seq-execute');
      await expect(page.locator('#seq-state')).toHaveText('COMPLETED', { timeout: 10000 });
      result = await page.evaluate(() => window.seqResult);
      expect(result).toBe(10); // ((-5 + 5) * 2) + 10 = 10
    });

    test('should emit stage events during execution', async ({ page }) => {
      await page.click('#btn-seq-create');
      await page.click('#btn-seq-add-stages');
      await page.fill('#seq-input', '5');
      await page.click('#btn-seq-execute');

      await expect(page.locator('#seq-state')).toHaveText('COMPLETED', { timeout: 10000 });

      // Check event log for stage events
      const eventsLog = page.locator('#events-list');
      await expect(eventsLog).toContainText("Stage 'add-5' started");
      await expect(eventsLog).toContainText("Stage 'add-5' completed");
      await expect(eventsLog).toContainText("Stage 'multiply-2' started");
      await expect(eventsLog).toContainText("Stage 'multiply-2' completed");
      await expect(eventsLog).toContainText("Stage 'add-10' started");
      await expect(eventsLog).toContainText("Stage 'add-10' completed");
    });

    test('should update progress during execution', async ({ page }) => {
      await page.click('#btn-seq-create');
      await page.click('#btn-seq-add-stages');

      // Execute and capture progress updates
      await page.click('#btn-seq-execute');

      // Should show running state at some point
      await expect(page.locator('#seq-state')).toHaveText('RUNNING');

      // Wait for completion
      await expect(page.locator('#seq-state')).toHaveText('COMPLETED', { timeout: 10000 });
      await expect(page.locator('#seq-progress')).toHaveText('100%');
    });

    test('should reset pipeline state', async ({ page }) => {
      await page.click('#btn-seq-create');
      await page.click('#btn-seq-add-stages');
      await page.click('#btn-seq-execute');
      await expect(page.locator('#seq-state')).toHaveText('COMPLETED', { timeout: 10000 });

      await page.click('#btn-seq-reset');

      await expect(page.locator('#seq-state')).toHaveText('IDLE');
      await expect(page.locator('#seq-progress')).toHaveText('0%');
      await expect(page.locator('#seq-result')).toContainText('Execute pipeline to see result');
    });

    test('should destroy pipeline', async ({ page }) => {
      await page.click('#btn-seq-create');
      await page.click('#btn-seq-destroy');

      // Check pipeline is destroyed
      const hasSeqPipeline = await page.evaluate(() => window.seqPipeline);
      expect(hasSeqPipeline).toBeNull();

      // Check buttons are reset
      await expect(page.locator('#btn-seq-create')).toBeEnabled();
      await expect(page.locator('#btn-seq-add-stages')).toBeDisabled();
    });

    test('should pause and resume pipeline', async ({ page }) => {
      await page.click('#btn-seq-create');

      // Add slow stages for pausable execution via page.evaluate and enable execute button
      await page.evaluate(() => {
        const { seqPipeline, SlowStage } = window;
        seqPipeline.addStage(new SlowStage('slow1', 500), { priority: 10 });
        seqPipeline.addStage(new SlowStage('slow2', 500), { priority: 20 });
        seqPipeline.addStage(new SlowStage('slow3', 500), { priority: 30 });
        // Enable the execute button manually since we bypassed the UI workflow
        document.getElementById('btn-seq-execute').disabled = false;
        document.getElementById('btn-seq-add-stages').disabled = true;
      });

      await page.fill('#seq-input', '5');
      await page.click('#btn-seq-execute');

      // Wait a bit then pause
      await page.waitForTimeout(200);
      await page.click('#btn-seq-pause');

      await expect(page.locator('#seq-state')).toHaveText('PAUSED');
      await expect(page.locator('#events-list')).toContainText('Paused');

      // Resume
      await page.click('#btn-seq-resume');
      await expect(page.locator('#seq-state')).toHaveText('RUNNING');
      await expect(page.locator('#events-list')).toContainText('Resumed');

      // Wait for completion
      await expect(page.locator('#seq-state')).toHaveText('COMPLETED', { timeout: 15000 });
    });

    test('should cancel running pipeline', async ({ page }) => {
      await page.click('#btn-seq-create');

      // Add slow stages and enable execute button
      await page.evaluate(() => {
        const { seqPipeline, SlowStage } = window;
        seqPipeline.addStage(new SlowStage('slow1', 500), { priority: 10 });
        seqPipeline.addStage(new SlowStage('slow2', 500), { priority: 20 });
        // Enable the execute button manually since we bypassed the UI workflow
        document.getElementById('btn-seq-execute').disabled = false;
        document.getElementById('btn-seq-add-stages').disabled = true;
      });

      await page.click('#btn-seq-execute');

      // Wait a bit then cancel
      await page.waitForTimeout(200);
      await page.click('#btn-seq-cancel');

      await expect(page.locator('#events-list')).toContainText('Cancelled');
    });
  });

  test.describe('Parallel Pipeline', () => {
    test('should create parallel pipeline', async ({ page }) => {
      await page.click('#btn-par-create');

      await expect(page.locator('#par-state')).toHaveText('IDLE');

      const hasParPipeline = await page.evaluate(() => window.parPipeline !== null);
      expect(hasParPipeline).toBe(true);
    });

    test('should add stages with different trigger modes', async ({ page }) => {
      await page.click('#btn-par-create');
      await page.click('#btn-par-add-stages');

      // Should have 4 stages
      await expect(page.locator('#par-stages-list')).toContainText('uppercase');
      await expect(page.locator('#par-stages-list')).toContainText('reverse');
      await expect(page.locator('#par-stages-list')).toContainText('length');
      await expect(page.locator('#par-stages-list')).toContainText('manual');
    });

    test('should execute parallel stages concurrently', async ({ page }) => {
      await page.click('#btn-par-create');
      await page.click('#btn-par-add-stages');
      await page.fill('#par-input', 'hello');
      await page.click('#btn-par-execute');

      await expect(page.locator('#par-state')).toHaveText('COMPLETED', { timeout: 10000 });

      // Check results - only auto stages executed
      await expect(page.locator('#par-results-count')).toHaveText('3 results');
      await expect(page.locator('#par-results')).toContainText('HELLO'); // uppercase
      await expect(page.locator('#par-results')).toContainText('olleh'); // reverse
      await expect(page.locator('#par-results')).toContainText('length: 5'); // length

      // Manual stage should not have executed
      await expect(page.locator('#par-results')).not.toContainText('[MANUAL]');
    });

    test('should trigger manual stage after execution', async ({ page }) => {
      await page.click('#btn-par-create');
      await page.click('#btn-par-add-stages');
      await page.fill('#par-input', 'test');
      await page.click('#btn-par-execute');

      await expect(page.locator('#par-state')).toHaveText('COMPLETED', { timeout: 10000 });

      // Now trigger manual stage
      await page.click('#btn-par-trigger-manual');

      // Check manual stage result
      await expect(page.locator('#par-results')).toContainText('[MANUAL] test');

      const manualResult = await page.evaluate(() => window.manualResult);
      expect(manualResult).toBe('[MANUAL] test');
    });

    test('should collect results from parallel execution', async ({ page }) => {
      await page.click('#btn-par-create');
      await page.click('#btn-par-add-stages');
      await page.fill('#par-input', 'world');
      await page.click('#btn-par-execute');

      await expect(page.locator('#par-state')).toHaveText('COMPLETED', { timeout: 10000 });

      const result = await page.evaluate(() => {
        const res = window.parResult;
        return {
          success: res.success,
          resultsCount: res.results.size,
          errorsCount: res.errors.size,
          uppercase: res.results.get('uppercase'),
          reverse: res.results.get('reverse'),
        };
      });

      expect(result.success).toBe(true);
      expect(result.resultsCount).toBe(3);
      expect(result.errorsCount).toBe(0);
      expect(result.uppercase).toBe('WORLD');
      expect(result.reverse).toBe('dlrow');
    });

    test('should reset parallel pipeline', async ({ page }) => {
      await page.click('#btn-par-create');
      await page.click('#btn-par-add-stages');
      await page.fill('#par-input', 'test');
      await page.click('#btn-par-execute');
      await expect(page.locator('#par-state')).toHaveText('COMPLETED', { timeout: 10000 });

      await page.click('#btn-par-reset');

      await expect(page.locator('#par-state')).toHaveText('IDLE');
      await expect(page.locator('#par-results-count')).toHaveText('0 results');
      await expect(page.locator('#par-results')).toContainText('Execute pipeline to see results');
    });

    test('should destroy parallel pipeline', async ({ page }) => {
      await page.click('#btn-par-create');
      await page.click('#btn-par-destroy');

      const hasParPipeline = await page.evaluate(() => window.parPipeline);
      expect(hasParPipeline).toBeNull();

      await expect(page.locator('#btn-par-create')).toBeEnabled();
      await expect(page.locator('#btn-par-add-stages')).toBeDisabled();
    });
  });

  test.describe('Pipeline Orchestrator', () => {
    test('should create orchestrator', async ({ page }) => {
      await page.click('#btn-orch-create');

      await expect(page.locator('#orch-state')).toHaveText('IDLE');

      const hasOrchestrator = await page.evaluate(() => window.orchestrator !== null);
      expect(hasOrchestrator).toBe(true);
    });

    test('should register pipelines', async ({ page }) => {
      await page.click('#btn-orch-create');
      await page.click('#btn-orch-register');

      await expect(page.locator('#orch-pipelines')).toHaveText('2 pipelines');
      await expect(page.locator('#orch-pipelines-list')).toContainText('process');
      await expect(page.locator('#orch-pipelines-list')).toContainText('finalize');
    });

    test('should connect pipelines', async ({ page }) => {
      await page.click('#btn-orch-create');
      await page.click('#btn-orch-register');
      await page.click('#btn-orch-connect');

      await expect(page.locator('#events-list')).toContainText('Connected: process → finalize');
    });

    test('should initialize orchestrator', async ({ page }) => {
      await page.click('#btn-orch-create');
      await page.click('#btn-orch-register');
      await page.click('#btn-orch-connect');
      await page.click('#btn-orch-init');

      await expect(page.locator('#orch-initialized')).toHaveText('Initialized');
      await expect(page.locator('#events-list')).toContainText('Orchestrator: Initialized');
    });

    test('should execute connected pipeline chain', async ({ page }) => {
      await page.click('#btn-orch-create');
      await page.click('#btn-orch-register');
      await page.click('#btn-orch-connect');
      await page.click('#btn-orch-init');
      await page.click('#btn-orch-execute');

      // Wait for execution
      await page.waitForTimeout(1000);

      // Check result: ((10 + 100) * 3) = 330
      await expect(page.locator('#orch-result')).toContainText('330');

      const result = await page.evaluate(() => window.orchResult);
      expect(result).toBe(330);
    });

    test('should track canClose state', async ({ page }) => {
      await page.click('#btn-orch-create');

      const canClose = await page.evaluate(() => window.orchestrator.canClose());
      expect(canClose).toBe(true);

      await expect(page.locator('#orch-can-close')).toContainText('Yes');
    });

    test('should pause and resume all pipelines', async ({ page }) => {
      await page.click('#btn-orch-create');
      await page.click('#btn-orch-register');
      await page.click('#btn-orch-connect');
      await page.click('#btn-orch-init');

      await page.click('#btn-orch-pause-all');
      await expect(page.locator('#events-list')).toContainText('Paused all pipelines');

      await page.click('#btn-orch-resume-all');
      await expect(page.locator('#events-list')).toContainText('Resumed all pipelines');
    });

    test('should cancel all pipelines', async ({ page }) => {
      await page.click('#btn-orch-create');
      await page.click('#btn-orch-register');
      await page.click('#btn-orch-connect');
      await page.click('#btn-orch-init');

      await page.click('#btn-orch-cancel-all');
      await expect(page.locator('#events-list')).toContainText('Cancelled all pipelines');
    });

    test('should destroy orchestrator', async ({ page }) => {
      await page.click('#btn-orch-create');
      await page.click('#btn-orch-register');
      await page.click('#btn-orch-destroy');

      const hasOrchestrator = await page.evaluate(() => window.orchestrator);
      expect(hasOrchestrator).toBeNull();

      await expect(page.locator('#btn-orch-create')).toBeEnabled();
      await expect(page.locator('#btn-orch-register')).toBeDisabled();
    });
  });

  test.describe('Statistics Tracking', () => {
    test('should track execution statistics', async ({ page }) => {
      await page.click('#btn-seq-create');
      await page.click('#btn-seq-add-stages');

      // Execute twice
      await page.click('#btn-seq-execute');
      await expect(page.locator('#seq-state')).toHaveText('COMPLETED', { timeout: 10000 });

      await page.click('#btn-seq-reset');
      await page.click('#btn-seq-execute');
      await expect(page.locator('#seq-state')).toHaveText('COMPLETED', { timeout: 10000 });

      // Check stats
      await expect(page.locator('#stat-executions')).toHaveText('2');
      await expect(page.locator('#stat-completed')).toHaveText('2');
    });
  });

  test.describe('Pipeline Error Handling', () => {
    test('should expose PipelineError class', async ({ page }) => {
      const hasError = await page.evaluate(() => {
        try {
          const err = new window.PipelineError(
            window.PipelineErrorCode.STAGE_FAILED,
            'Test error',
            { stage: 'test-stage' }
          );
          return {
            hasCode: err.code === 'STAGE_FAILED',
            hasMessage: err.message === 'Test error',
            hasStage: err.stage === 'test-stage',
            isError: err instanceof Error,
          };
        } catch {
          return null;
        }
      });

      expect(hasError).not.toBeNull();
      expect(hasError?.hasCode).toBe(true);
      expect(hasError?.hasMessage).toBe(true);
      expect(hasError?.hasStage).toBe(true);
      expect(hasError?.isError).toBe(true);
    });

    test('should have all error codes', async ({ page }) => {
      const codes = await page.evaluate(() => {
        const { PipelineErrorCode } = window;
        return {
          stageFailed: PipelineErrorCode.STAGE_FAILED,
          timeout: PipelineErrorCode.TIMEOUT,
          cancelled: PipelineErrorCode.CANCELLED,
          invalidInput: PipelineErrorCode.INVALID_INPUT,
          configError: PipelineErrorCode.CONFIGURATION_ERROR,
          initError: PipelineErrorCode.INITIALIZATION_ERROR,
          notInitialized: PipelineErrorCode.NOT_INITIALIZED,
          alreadyRunning: PipelineErrorCode.ALREADY_RUNNING,
        };
      });

      expect(codes.stageFailed).toBe('STAGE_FAILED');
      expect(codes.timeout).toBe('TIMEOUT');
      expect(codes.cancelled).toBe('CANCELLED');
      expect(codes.invalidInput).toBe('INVALID_INPUT');
      expect(codes.configError).toBe('CONFIGURATION_ERROR');
      expect(codes.initError).toBe('INITIALIZATION_ERROR');
      expect(codes.notInitialized).toBe('NOT_INITIALIZED');
      expect(codes.alreadyRunning).toBe('ALREADY_RUNNING');
    });
  });

  test.describe('Pipeline Events', () => {
    test('should have all pipeline events', async ({ page }) => {
      const events = await page.evaluate(() => {
        const { PipelineEvent } = window;
        return {
          started: PipelineEvent.Started,
          completed: PipelineEvent.Completed,
          error: PipelineEvent.Error,
          paused: PipelineEvent.Paused,
          resumed: PipelineEvent.Resumed,
          cancelled: PipelineEvent.Cancelled,
          stateChange: PipelineEvent.StateChange,
          stageStarted: PipelineEvent.StageStarted,
          stageCompleted: PipelineEvent.StageCompleted,
          stageFailed: PipelineEvent.StageFailed,
          stageSkipped: PipelineEvent.StageSkipped,
          data: PipelineEvent.Data,
        };
      });

      expect(events.started).toBe('started');
      expect(events.completed).toBe('completed');
      expect(events.error).toBe('error');
      expect(events.paused).toBe('paused');
      expect(events.resumed).toBe('resumed');
      expect(events.cancelled).toBe('cancelled');
      expect(events.stateChange).toBe('stateChange');
      expect(events.stageStarted).toBe('stageStarted');
      expect(events.stageCompleted).toBe('stageCompleted');
      expect(events.stageFailed).toBe('stageFailed');
      expect(events.stageSkipped).toBe('stageSkipped');
      expect(events.data).toBe('data');
    });

    test('should have all orchestrator events', async ({ page }) => {
      const events = await page.evaluate(() => {
        const { OrchestratorEvent } = window;
        return {
          registered: OrchestratorEvent.PipelineRegistered,
          unregistered: OrchestratorEvent.PipelineUnregistered,
          initialized: OrchestratorEvent.Initialized,
          stateChange: OrchestratorEvent.StateChange,
          dataFlow: OrchestratorEvent.DataFlow,
          error: OrchestratorEvent.Error,
        };
      });

      expect(events.registered).toBe('pipelineRegistered');
      expect(events.unregistered).toBe('pipelineUnregistered');
      expect(events.initialized).toBe('initialized');
      expect(events.stateChange).toBe('stateChange');
      expect(events.dataFlow).toBe('dataFlow');
      expect(events.error).toBe('error');
    });
  });

  test.describe('Cross-Browser Compatibility', () => {
    test('should work in current browser', async ({ page, browserName }) => {
      await page.click('#btn-seq-create');
      await page.click('#btn-seq-add-stages');
      await page.fill('#seq-input', '10');
      await page.click('#btn-seq-execute');

      await expect(page.locator('#seq-state')).toHaveText('COMPLETED', { timeout: 10000 });

      const result = await page.evaluate(() => window.seqResult);
      expect(result).toBe(40);

      // Log browser info
      console.log(`Test passed in ${browserName}`);
    });
  });
});
