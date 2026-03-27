import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram, register } from 'prom-client';

@Injectable()
export class JobMetricsService implements OnModuleInit {
  private readonly logger = new Logger(JobMetricsService.name);

  jobProcessingTotal!: Counter<string>;
  jobProcessingDuration!: Histogram<string>;
  jobWaitingDuration!: Histogram<string>;
  jobErrorsTotal!: Counter<string>;
  jobActiveCount!: Gauge<string>;
  jobSmrCallDuration!: Histogram<string>;

  onModuleInit(): void {
    this.jobProcessingTotal = new Counter({
      name: 'hope_job_processing_total',
      help: 'Total jobs processed',
      labelNames: ['queue', 'status', 'processor'],
      registers: [register],
    });

    this.jobProcessingDuration = new Histogram({
      name: 'hope_job_processing_duration_seconds',
      help: 'Job processing duration in seconds',
      labelNames: ['queue', 'processor'],
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
      registers: [register],
    });

    this.jobWaitingDuration = new Histogram({
      name: 'hope_job_waiting_duration_seconds',
      help: 'Time from enqueue to processing start',
      labelNames: ['queue'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [register],
    });

    this.jobErrorsTotal = new Counter({
      name: 'hope_job_errors_total',
      help: 'Job processing errors',
      labelNames: ['queue', 'processor', 'error_type'],
      registers: [register],
    });

    this.jobActiveCount = new Gauge({
      name: 'hope_job_active_count',
      help: 'Currently active jobs',
      labelNames: ['queue'],
      registers: [register],
    });

    this.jobSmrCallDuration = new Histogram({
      name: 'hope_job_smr_call_duration_seconds',
      help: 'Duration of SMR HTTP calls within jobs',
      labelNames: ['queue', 'provider'],
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
      registers: [register],
    });

    this.logger.log({ message: 'Job metrics initialized' });
  }

  recordJobStart(queue: string): () => number {
    this.jobActiveCount.labels(queue).inc();
    const startTime = process.hrtime.bigint();
    return () => {
      const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
      this.jobActiveCount.labels(queue).dec();
      return duration;
    };
  }

  recordJobComplete(queue: string, processor: string, durationSeconds: number): void {
    this.jobProcessingTotal.labels(queue, 'completed', processor).inc();
    this.jobProcessingDuration.labels(queue, processor).observe(durationSeconds);
  }

  recordJobFailed(queue: string, processor: string, errorType: string): void {
    this.jobProcessingTotal.labels(queue, 'failed', processor).inc();
    this.jobErrorsTotal.labels(queue, processor, errorType).inc();
  }

  recordWaitingDuration(queue: string, waitSeconds: number): void {
    this.jobWaitingDuration.labels(queue).observe(waitSeconds);
  }

  recordSmrCallDuration(queue: string, provider: string, durationSeconds: number): void {
    this.jobSmrCallDuration.labels(queue, provider).observe(durationSeconds);
  }
}
