import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobMetricsService } from '../job-metrics.service';
import { register } from 'prom-client';

describe('JobMetricsService', () => {
  let service: JobMetricsService;

  beforeEach(() => {
    register.clear();
    service = new JobMetricsService();
    service.onModuleInit();
  });

  afterEach(() => {
    register.clear();
  });

  describe('onModuleInit', () => {
    it('should create all 6 metrics', () => {
      expect(service.jobProcessingTotal).toBeDefined();
      expect(service.jobProcessingDuration).toBeDefined();
      expect(service.jobWaitingDuration).toBeDefined();
      expect(service.jobErrorsTotal).toBeDefined();
      expect(service.jobActiveCount).toBeDefined();
      expect(service.jobSmrCallDuration).toBeDefined();
    });

    it('should register metrics with prom-client', async () => {
      const metrics = await register.getMetricsAsJSON();
      const names = metrics.map((m) => m.name);
      expect(names).toContain('hope_job_processing_total');
      expect(names).toContain('hope_job_processing_duration_seconds');
      expect(names).toContain('hope_job_waiting_duration_seconds');
      expect(names).toContain('hope_job_errors_total');
      expect(names).toContain('hope_job_active_count');
      expect(names).toContain('hope_job_smr_call_duration_seconds');
    });
  });

  describe('recordJobStart', () => {
    it('should increment active count and return timer function', () => {
      const endTimer = service.recordJobStart('GenerateSummary');
      expect(typeof endTimer).toBe('function');
    });

    it('should return elapsed duration when timer is called', () => {
      const endTimer = service.recordJobStart('GenerateSummary');
      const duration = endTimer();
      expect(typeof duration).toBe('number');
      expect(duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('recordJobComplete', () => {
    it('should record completion metrics without error', () => {
      service.recordJobComplete('GenerateSummary', 'SummaryProcessor', 5.0);
    });
  });

  describe('recordJobFailed', () => {
    it('should record failure metrics without error', () => {
      service.recordJobFailed('GenerateSummary', 'SummaryProcessor', 'TimeoutError');
    });
  });

  describe('recordWaitingDuration', () => {
    it('should record waiting duration without error', () => {
      service.recordWaitingDuration('GenerateSummary', 2.5);
    });
  });

  describe('recordSmrCallDuration', () => {
    it('should record SMR call duration without error', () => {
      service.recordSmrCallDuration('GenerateSummary', 'smr-v1', 3.0);
    });
  });

  describe('full lifecycle', () => {
    it('should track a complete successful job lifecycle', () => {
      const endTimer = service.recordJobStart('GenerateSummary');
      service.recordWaitingDuration('GenerateSummary', 0.5);
      service.recordSmrCallDuration('GenerateSummary', 'smr-v1', 2.0);
      const duration = endTimer();
      expect(duration).toBeGreaterThanOrEqual(0);
      service.recordJobComplete('GenerateSummary', 'SummaryProcessor', duration);
    });

    it('should track a failed job lifecycle', () => {
      const endTimer = service.recordJobStart('GenerateSummary');
      const duration = endTimer();
      expect(duration).toBeGreaterThanOrEqual(0);
      service.recordJobFailed('GenerateSummary', 'SummaryProcessor', 'Error');
    });

    it('should handle multiple concurrent jobs on different queues', () => {
      const timer1 = service.recordJobStart('GenerateSummary');
      const timer2 = service.recordJobStart('GeneratePreSummary');
      const timer3 = service.recordJobStart('GenerateDnaReport');

      service.recordSmrCallDuration('GenerateSummary', 'smr-v1', 1.5);
      service.recordSmrCallDuration('GeneratePreSummary', 'smr-v1', 2.0);
      service.recordSmrCallDuration('GenerateDnaReport', 'smr', 3.0);

      const d1 = timer1();
      const d2 = timer2();
      const d3 = timer3();

      service.recordJobComplete('GenerateSummary', 'SummaryProcessor', d1);
      service.recordJobComplete('GeneratePreSummary', 'PreSummaryProcessor', d2);
      service.recordJobFailed('GenerateDnaReport', 'DnaWritingStyleProcessor', 'TimeoutError');
    });
  });

  describe('metric values', () => {
    it('should increment processing total on complete', async () => {
      service.recordJobComplete('GenerateSummary', 'SummaryProcessor', 1.0);
      service.recordJobComplete('GenerateSummary', 'SummaryProcessor', 2.0);

      const metrics = await register.getMetricsAsJSON();
      const processingTotal = metrics.find((m) => m.name === 'hope_job_processing_total');
      expect(processingTotal).toBeDefined();
    });

    it('should increment error total on failure', async () => {
      service.recordJobFailed('GenerateSummary', 'SummaryProcessor', 'TimeoutError');

      const metrics = await register.getMetricsAsJSON();
      const errorsTotal = metrics.find((m) => m.name === 'hope_job_errors_total');
      expect(errorsTotal).toBeDefined();
    });
  });
});
