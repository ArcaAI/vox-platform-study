import { Inject, Injectable, MessageEvent, OnModuleDestroy } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import { Observable, merge, Subject } from 'rxjs';
import { filter, map, finalize } from 'rxjs/operators';
import { JobQueue, type QueueEventPayload, type QueueEventType } from '@arcaai/domains';
import { IConfigService } from '../baseServices/_meta/config/IConfigService';

@Injectable()
export class QueueEventsService implements OnModuleDestroy {
  private readonly queueEventsInstances = new Map<string, QueueEvents>();
  private readonly subjects = new Map<string, Subject<QueueEventPayload>>();
  private readonly refCounts = new Map<string, number>();

  constructor(
    @Inject(IConfigService) private readonly configService: IConfigService,
  ) {}

  getEventStream(
    queueNames?: string[],
    eventTypes?: QueueEventType[],
  ): Observable<MessageEvent> {
    const targetQueues = queueNames ?? Object.values(JobQueue);

    for (const name of targetQueues) {
      this.ensureQueueEvents(name);
      this.refCounts.set(name, (this.refCounts.get(name) ?? 0) + 1);
    }

    const streams = targetQueues
      .map((name) => this.subjects.get(name)!)
      .filter(Boolean)
      .map((subject) => subject.asObservable());

    return merge(...streams).pipe(
      filter(
        (event) =>
          !eventTypes?.length || eventTypes.includes(event.type),
      ),
      map(
        (event) =>
          ({
            data: JSON.stringify(event),
            type: event.type,
            id: `${event.queueName}-${event.jobId ?? 'system'}-${Date.now()}`,
          }) as MessageEvent,
      ),
      finalize(() => {
        for (const name of targetQueues) {
          this.decrementAndCleanup(name);
        }
      }),
    );
  }

  private ensureQueueEvents(queueName: string): void {
    if (this.queueEventsInstances.has(queueName)) return;

    const redisConfig = this.configService.getRedisConfig();
    const queueEvents = new QueueEvents(queueName, {
      connection: {
        host: redisConfig.host,
        port: redisConfig.port,
        password: redisConfig.password,
        maxRetriesPerRequest: null,
      },
    });

    const subject = new Subject<QueueEventPayload>();
    this.subjects.set(queueName, subject);
    this.queueEventsInstances.set(queueName, queueEvents);

    queueEvents.on('completed', ({ jobId, returnvalue }) => {
      subject.next({
        type: 'job:completed',
        queueName,
        jobId,
        timestamp: Date.now(),
        returnValue: returnvalue,
      });
    });

    queueEvents.on('failed', ({ jobId, failedReason }) => {
      subject.next({
        type: 'job:failed',
        queueName,
        jobId,
        timestamp: Date.now(),
        failedReason,
      });
    });

    queueEvents.on('stalled', ({ jobId }) => {
      subject.next({
        type: 'job:stalled',
        queueName,
        jobId,
        timestamp: Date.now(),
      });
    });

    queueEvents.on('active', ({ jobId }) => {
      subject.next({
        type: 'job:active',
        queueName,
        jobId,
        timestamp: Date.now(),
      });
    });

    queueEvents.on('waiting', ({ jobId }) => {
      subject.next({
        type: 'job:waiting',
        queueName,
        jobId,
        timestamp: Date.now(),
      });
    });

    queueEvents.on('progress', ({ jobId, data }) => {
      let progress: number | object;
      if (typeof data === 'number') progress = data;
      else if (typeof data === 'object' && data !== null) progress = data;
      else progress = typeof data === 'string' ? parseFloat(data) || 0 : 0;

      subject.next({
        type: 'job:progress',
        queueName,
        jobId,
        timestamp: Date.now(),
        progress,
      });
    });
  }

  private decrementAndCleanup(queueName: string): void {
    const count = (this.refCounts.get(queueName) ?? 1) - 1;

    if (count <= 0) {
      this.refCounts.delete(queueName);
      this.subjects.get(queueName)?.complete();
      this.subjects.delete(queueName);
      this.queueEventsInstances.get(queueName)?.close();
      this.queueEventsInstances.delete(queueName);
    } else {
      this.refCounts.set(queueName, count);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const subject of this.subjects.values()) {
      subject.complete();
    }
    for (const qe of this.queueEventsInstances.values()) {
      await qe.close();
    }
    this.subjects.clear();
    this.queueEventsInstances.clear();
    this.refCounts.clear();
  }
}
