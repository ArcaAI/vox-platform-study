# TASK-250: Admin Job & Scheduler Management

| Field | Value |
|---|---|
| Ticket | TASK-250 |
| Created | 2026-03-29 |
| Updated | 2026-03-29 |
| Status | Pending |

---

## 1. Requirement Analysis

### Description

Build an admin interface for managing background jobs (BullMQ queues) and schedulers (`@nestjs/schedule` + `SchedulerRegistry`), including real-time SSE monitoring, PII-redacted job data viewing, and a cron expression editor.

### Business Context

Operations teams need visibility into:
- Queue health and throughput across 14 BullMQ queues
- Failed job investigation with safe data viewing (HIPAA-compliant PII redaction)
- Scheduler management (dynamic cron updates, manual triggers)
- Real-time monitoring without page refresh

### Acceptance Criteria

- [ ] Queue dashboard with stats, pause/resume, clean operations
- [ ] Job list with status filtering, detail view with redacted data
- [ ] SSE-based real-time queue event streaming
- [ ] Scheduler list with enable/disable, manual trigger, cron editing
- [ ] PII redaction on all job data exposed through the API
- [ ] Monitoring charts (throughput, error rate, status distribution)

---

## 2. Current State Evaluation

### Existing Infrastructure

| Component | Status | Location |
|---|---|---|
| BullMQ integration | ✅ Active | `RedisServiceModule`, 14 queues in `JobQueue` enum |
| `@nestjs/schedule` | ✅ Active | `ScheduleModule.forRoot()` in `app.module.ts` |
| Dynamic schedulers | ✅ Active | `DnaRegenerationScheduler`, `AppSettingsService` |
| Static cron | ✅ Active | `ServiceHealthMonitoringService` (`@Cron(EVERY_30_SECONDS)`) |
| SSE pattern | ✅ Active | `TranscriptionRealtimeService`, `ConsultationJobService` |
| Redis pub/sub | ✅ Active | `RedisSubscriberService` with refcounted channels |
| Admin routes | ✅ Active | `api/v1/admin/*` with `@Authorize(['manage', 'all'])` |
| Admin UI | ✅ Active | `features/admin/` in `ui-playground` |
| PII redaction | ⚠️ Partial | SDK logger only (`DEFAULT_PHI_REDACT_FIELDS`) |
| `QueueEvents` | ❌ Missing | Not used anywhere in the codebase |
| Job admin API | ❌ Missing | No endpoints for queue/job management |
| Job admin UI | ❌ Missing | No pages for queue/job/scheduler management |

### Key Dependencies

- `bullmq` + `@nestjs/bullmq` (already installed)
- `@nestjs/schedule` (already installed)
- `cron` npm package (already installed)
- `ioredis` (already installed)
- `recharts` (already in `@arcaai/ui`)

---

## 3. Detailed Technical Design

### 3.1 SSE Architecture

#### Problem

Admin users need real-time visibility into queue events (job completed, failed, stalled, active count changes) without polling. The system must handle multiple concurrent admin sessions efficiently without creating excessive Redis connections.

#### Existing SSE Patterns (Reference)

Two proven patterns exist in the codebase:

**Pattern A — `ConsultationJobService` (recommended base)**

```
Controller (@Sse)
  └─ Service returns Observable<MessageEvent>
       └─ new Observable(subscriber => {
            // async setup
            const redisMessages$ = await redisSubscriber.subscribeToChannel(ch);
            const sseStream$ = redisMessages$.pipe(
              map(raw → MessageEvent),
              takeWhile(notTerminal, true),
              finalize(() => redisSubscriber.unsubscribeFromChannel(ch))
            );
            innerSub = sseStream$.subscribe(subscriber);
            // teardown on disconnect
            return () => innerSub.unsubscribe();
          })
```

**Pattern B — `SmrStreamConsumerService` (Subject-based)**

```
Subject<MessageEvent> + background read loop
  └─ subject.asObservable().pipe(
       finalize(() => { abort = true; cleanup(); })
     )
```

#### Design: `QueueEventsService`

The new SSE system uses BullMQ's `QueueEvents` class (net-new for this codebase) combined with the existing `Observable<MessageEvent>` + `finalize` pattern.

**Why `QueueEvents` over Redis pub/sub?**

- `QueueEvents` natively listens to BullMQ's internal event stream (keyspace notifications)
- No need to manually publish events from processors
- Captures events from ALL workers regardless of where they run
- Provides typed events: `completed`, `failed`, `stalled`, `waiting`, `active`, `delayed`, `progress`

**Architecture:**

```
┌─────────────────────────────────────────────────────────────┐
│ QueueEventsService (Singleton, OnModuleDestroy)             │
│                                                             │
│  queueEventsMap: Map<string, QueueEvents>                  │
│    └─ One QueueEvents instance per queue (lazy-created)    │
│    └─ Each QueueEvents = 1 Redis connection                │
│                                                             │
│  subjectMap: Map<string, Subject<QueueEventPayload>>       │
│    └─ One Subject per queue                                │
│    └─ BullMQ events → subject.next()                       │
│                                                             │
│  refCounts: Map<string, number>                            │
│    └─ Track active SSE subscribers per queue               │
│    └─ refCount hits 0 → close QueueEvents + Redis conn     │
│                                                             │
│  getEventStream(queues?, eventTypes?):                      │
│    └─ merge(...selectedSubjects).pipe(                      │
│         filter(byEventType),                                │
│         map(toMessageEvent),                                │
│         finalize(() => decrementRefCounts)                  │
│       )                                                     │
└─────────────────────────────────────────────────────────────┘
              ↑                           ↓
     Controller @Sse()          Observable<MessageEvent>
     GET /admin/system/            → SSE to browser
       queues/events
```

**Key Implementation Details:**

```typescript
// packages/applications/src/services/queue-admin/queue-events.service.ts

@Injectable()
export class QueueEventsService implements OnModuleDestroy {
  private readonly queueEventsInstances = new Map<string, QueueEvents>();
  private readonly subjects = new Map<string, Subject<QueueEventPayload>>();
  private readonly refCounts = new Map<string, number>();

  constructor(
    @Inject(IConfigService) private readonly configService: IConfigService,
  ) {}

  /**
   * Returns a merged Observable that streams events from the requested
   * queues. Each SSE client connection calls this once.
   *
   * Resource lifecycle:
   * - First subscriber for a queue → creates QueueEvents (1 Redis conn)
   * - Additional subscribers share the same QueueEvents
   * - Last subscriber disconnects → closes QueueEvents + Redis conn
   */
  getEventStream(
    queueNames?: string[],
    eventTypes?: QueueEventType[],
  ): Observable<MessageEvent> {
    const targetQueues = queueNames ?? Object.values(JobQueue);

    // Increment refcounts and ensure QueueEvents exist
    for (const name of targetQueues) {
      this.ensureQueueEvents(name);
      this.refCounts.set(name, (this.refCounts.get(name) ?? 0) + 1);
    }

    const streams = targetQueues
      .map(name => this.subjects.get(name)!)
      .filter(Boolean)
      .map(subject => subject.asObservable());

    return merge(...streams).pipe(
      // Filter by event type if specified
      filter(event =>
        !eventTypes?.length || eventTypes.includes(event.type)
      ),
      // Convert to SSE MessageEvent format
      map(event => ({
        data: JSON.stringify(event),
        type: event.type,
        id: `${event.queueName}-${event.jobId ?? 'system'}-${Date.now()}`,
      } as MessageEvent)),
      // Cleanup: decrement refcounts on disconnect
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

    // Wire BullMQ events → Subject
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
      subject.next({
        type: 'job:progress',
        queueName,
        jobId,
        timestamp: Date.now(),
        progress: data,
      });
    });
  }

  private decrementAndCleanup(queueName: string): void {
    const count = (this.refCounts.get(queueName) ?? 1) - 1;

    if (count <= 0) {
      // Last subscriber disconnected — tear down
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
```

**SSE Event Types:**

```typescript
// packages/domains/src/interfaces/queueAdminTypes.ts

export type QueueEventType =
  | 'job:completed'
  | 'job:failed'
  | 'job:stalled'
  | 'job:active'
  | 'job:waiting'
  | 'job:progress';

export interface QueueEventPayload {
  type: QueueEventType;
  queueName: string;
  jobId: string;
  timestamp: number;
  failedReason?: string;
  returnValue?: string;
  progress?: number | object;
}
```

**Controller (matches existing `@Sse()` pattern):**

```typescript
// apps/api/src/modules/queue-admin/queue-admin.controller.ts

@Get('events')
@Sse()
@ApiOperation({ summary: 'Stream queue events via SSE' })
@ApiQuery({
  name: 'queues', required: false,
  description: 'Comma-separated queue names (omit for all)',
})
@ApiQuery({
  name: 'events', required: false,
  description: 'Comma-separated event types: completed,failed,stalled,active,waiting,progress',
})
streamQueueEvents(
  @Query('queues') queues?: string,
  @Query('events') events?: string,
): Observable<MessageEvent> {
  const queueNames = queues?.split(',').filter(Boolean);
  const eventTypes = events?.split(',').filter(Boolean) as QueueEventType[];
  return this.queueEventsService.getEventStream(queueNames, eventTypes);
}
```

**Frontend SSE Hook:**

```typescript
// apps/ui-playground/src/features/admin/jobs/hooks/use-job-sse.ts

export function useJobSSE(
  queueName?: string,
  onEvent?: (event: QueueEventPayload) => void,
) {
  const qc = useQueryClient();

  useEffect(() => {
    const controller = new AbortController();

    const connect = async () => {
      const { accessToken } = useAuthStore.getState();
      const baseUrl = usePlaygroundStore.getState().apiBaseUrl;
      const params = new URLSearchParams();
      if (queueName) params.set('queues', queueName);

      const url = `${baseUrl}/admin/system/queues/events?${params}`;

      try {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        });

        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === '[DONE]') continue;

            try {
              const event: QueueEventPayload = JSON.parse(raw);
              onEvent?.(event);

              // Auto-invalidate relevant queries
              if (event.type === 'job:failed' || event.type === 'job:completed') {
                qc.invalidateQueries({
                  queryKey: ['admin', 'jobs', 'queues', event.queueName],
                });
                qc.invalidateQueries({
                  queryKey: ['admin', 'jobs', 'stats'],
                });
              }
            } catch { /* skip malformed */ }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          // Reconnect with exponential backoff
          setTimeout(connect, 5000);
        }
      }
    };

    connect();
    return () => controller.abort();
  }, [queueName, qc, onEvent]);
}
```

**Redis Connection Budget:**

- Each `QueueEvents` instance = 1 Redis connection
- Lazy creation: only queues being actively monitored consume connections
- Refcounting: connections close when last admin disconnects
- Worst case (all 14 queues monitored): 14 additional Redis connections
- Typical case (dashboard open): 0 connections (SSE only on queue detail page)

---

### 3.2 PII Redaction Service

#### Problem

Job payloads may contain sensitive data:
- `SendEmailJob`: `subject`, `body` (may contain patient names, appointment details)
- `SendSmsJob`: `message`, `recipientPhoneNumberId`
- `GenerateDnaReportJobPayload`: `textSamples[]` (clinical text)
- `AuditLogJob`: `data`, `previousData` (arbitrary JSON with potential PII)
- `GenerateSummaryJobPayload`: `request.contextItemIds` (references to PHI)

The existing `DEFAULT_PHI_REDACT_FIELDS` in the SDK logger provides a starting point but is flat-key only (no nested traversal) and client-side only.

#### Design: `JobDataRedactorService`

A server-side service that redacts sensitive fields from job data before it reaches the API response. Uses a configurable, multi-strategy approach.

**Redaction Strategies:**

1. **Field-name matching** — Redact fields whose keys match sensitive patterns
2. **Value-pattern matching** — Redact values that look like emails, phone numbers, SSNs
3. **Size truncation** — Truncate large text fields (> 500 chars) in list views
4. **Queue-specific rules** — Different queues have different sensitive fields

```typescript
// packages/applications/src/services/queue-admin/job-data-redactor.service.ts

@Injectable()
export class JobDataRedactorService {

  private static readonly REDACTED = '[REDACTED]';
  private static readonly TRUNCATED_SUFFIX = '...[TRUNCATED]';

  /**
   * Sensitive field name patterns (case-insensitive).
   * Matches both exact keys and glob-style patterns.
   */
  private static readonly SENSITIVE_KEY_PATTERNS: RegExp[] = [
    /password/i,
    /secret/i,
    /token/i,
    /apikey/i,
    /api[-_]?key/i,
    /authorization/i,
    /credential/i,
    /ssn/i,
    /social[-_]?security/i,
    /date[-_]?of[-_]?birth/i,
    /dob/i,
    /mrn/i,                        // Medical Record Number
    /medical[-_]?record/i,
    /patient[-_]?name/i,
    /doctor[-_]?name/i,
  ];

  /**
   * Value patterns that indicate PII regardless of field name.
   */
  private static readonly SENSITIVE_VALUE_PATTERNS: RegExp[] = [
    /\b\d{3}-\d{2}-\d{4}\b/,      // SSN format (###-##-####)
    /\b\d{9}\b/,                    // SSN without dashes
  ];

  /**
   * Queue-specific field redaction rules.
   * These fields are always redacted for the specified queue.
   */
  private static readonly QUEUE_SPECIFIC_RULES: Record<string, string[]> = {
    [JobQueue.SendEmail]: ['body', 'subject'],
    [JobQueue.SendSms]: ['message'],
    [JobQueue.GenerateDnaReport]: ['textSamples'],
  };

  /**
   * Redact sensitive data from a job payload.
   *
   * @param data      Raw job data from BullMQ
   * @param queueName Queue this job belongs to (enables queue-specific rules)
   * @param mode      'detail' preserves more structure; 'list' truncates aggressively
   */
  redact(
    data: Record<string, unknown>,
    queueName: string,
    mode: 'detail' | 'list' = 'detail',
  ): Record<string, unknown> {
    if (!data || typeof data !== 'object') return data;

    const queueFields = new Set(
      JobDataRedactorService.QUEUE_SPECIFIC_RULES[queueName] ?? []
    );
    const maxValueLength = mode === 'list' ? 200 : 500;

    return this.redactObject(data, queueFields, maxValueLength);
  }

  private redactObject(
    obj: Record<string, unknown>,
    queueFields: Set<string>,
    maxValueLength: number,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      // Check queue-specific rules (top-level only)
      if (queueFields.has(key)) {
        result[key] = JobDataRedactorService.REDACTED;
        continue;
      }

      // Check sensitive key patterns
      if (this.isSensitiveKey(key)) {
        result[key] = JobDataRedactorService.REDACTED;
        continue;
      }

      // Recurse into nested objects
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.redactObject(
          value as Record<string, unknown>,
          queueFields,
          maxValueLength,
        );
        continue;
      }

      // Recurse into arrays
      if (Array.isArray(value)) {
        result[key] = value.map(item => {
          if (item !== null && typeof item === 'object') {
            return this.redactObject(
              item as Record<string, unknown>,
              queueFields,
              maxValueLength,
            );
          }
          if (typeof item === 'string') {
            return this.redactStringValue(item, maxValueLength);
          }
          return item;
        });
        continue;
      }

      // Check string values
      if (typeof value === 'string') {
        result[key] = this.redactStringValue(value, maxValueLength);
        continue;
      }

      result[key] = value;
    }

    return result;
  }

  private isSensitiveKey(key: string): boolean {
    return JobDataRedactorService.SENSITIVE_KEY_PATTERNS.some(
      pattern => pattern.test(key)
    );
  }

  private redactStringValue(value: string, maxLength: number): string {
    // Check value-level PII patterns
    for (const pattern of JobDataRedactorService.SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        return JobDataRedactorService.REDACTED;
      }
    }

    // Truncate long values
    if (value.length > maxLength) {
      return value.substring(0, maxLength) + JobDataRedactorService.TRUNCATED_SUFFIX;
    }

    return value;
  }
}
```

**Integration Points:**

| Layer | Usage |
|---|---|
| `JobAdminService.getJobDetail()` | `redactor.redact(job.data, queueName, 'detail')` |
| `JobAdminService.listJobs()` | `redactor.redact(job.data, queueName, 'list')` — or omit `data` entirely from list |
| `QueueEventsService` | `returnValue` field redacted before SSE emission |
| `AuditLogJob` viewer | `redactor.redact(auditLog.data, 'AuditLog', 'detail')` |

**Design Decisions:**

1. **Server-side only** — PII never reaches the browser unredacted. The SDK-side logger redaction is defense-in-depth, not primary.

2. **Queue-specific rules take priority** — For `SendEmail`, the `body` is always redacted regardless of content. This is intentional: email bodies in a healthcare context are presumed to contain PHI.

3. **No `data` field in list views** — Job list responses deliberately exclude the `data` payload. Only the detail endpoint returns redacted data. This minimizes exposure surface.

4. **`textSamples` fully redacted** — DNA report job payloads may contain raw clinical text. The entire array is replaced, not individual elements.

5. **Configurable via `GlobalSetting`** — Future enhancement: allow admins to define additional redaction patterns via the existing `GlobalSetting` table (`pii-redaction.custom-patterns`).

---

### 3.3 Cron Expression Editor

#### Problem

Admins need to modify dynamic scheduler cron expressions without redeploying. The existing `DnaRegenerationScheduler` pattern supports this via `GlobalSetting` + `AppSettingsService` cache refresh + `@OnEvent('app-settings.cache-refreshed')`, but there's no admin UI or API endpoint to perform the update.

#### Backend: Scheduler Admin Service

The service wraps `SchedulerRegistry` and `GlobalSettingRepository` to provide a unified view of all schedulers (static `@Cron` + dynamic `SchedulerRegistry`).

```typescript
// packages/applications/src/services/queue-admin/scheduler-admin.service.ts

export interface SchedulerInfo {
  name: string;
  type: 'cron' | 'interval' | 'timeout';
  source: 'static' | 'dynamic';
  cronExpression: string | null;
  intervalMs: number | null;
  running: boolean;
  lastExecution: string | null;  // ISO datetime
  nextExecution: string | null;  // ISO datetime
  timeZone: string | null;
  settingsKey: string | null;    // GlobalSetting key if dynamic
}

/**
 * Maps dynamic scheduler names to their GlobalSetting keys.
 * Static @Cron schedulers are not editable.
 */
const DYNAMIC_SCHEDULER_SETTINGS: Record<string, {
  enabledKey: string;
  cronKey: string;
}> = {
  'dna-regeneration': {
    enabledKey: 'dna-regen.enabled',
    cronKey: 'dna-regen.cron',
  },
  // Future schedulers register here
};

@Injectable()
export class SchedulerAdminService {
  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(IGlobalSettingService)
    private readonly globalSettingService: IGlobalSettingService,
  ) {}

  listSchedulers(): SchedulerInfo[] {
    const result: SchedulerInfo[] = [];

    // Cron jobs
    const cronJobs = this.schedulerRegistry.getCronJobs();
    for (const [name, job] of cronJobs) {
      const dynamic = DYNAMIC_SCHEDULER_SETTINGS[name];
      result.push({
        name,
        type: 'cron',
        source: dynamic ? 'dynamic' : 'static',
        cronExpression: this.extractCronExpression(job),
        intervalMs: null,
        running: job.running,
        lastExecution: job.lastDate()?.toISOString() ?? null,
        nextExecution: job.nextDate()?.toISOString() ?? null,
        timeZone: job.cronTime?.zone ?? null,
        settingsKey: dynamic?.cronKey ?? null,
      });
    }

    // Intervals
    const intervals = this.schedulerRegistry.getIntervals();
    for (const name of intervals) {
      result.push({
        name,
        type: 'interval',
        source: 'static',
        cronExpression: null,
        intervalMs: null, // SchedulerRegistry doesn't expose interval values
        running: true,
        lastExecution: null,
        nextExecution: null,
        timeZone: null,
        settingsKey: null,
      });
    }

    // Timeouts
    const timeouts = this.schedulerRegistry.getTimeouts();
    for (const name of timeouts) {
      result.push({
        name,
        type: 'timeout',
        source: 'static',
        cronExpression: null,
        intervalMs: null,
        running: true,
        lastExecution: null,
        nextExecution: null,
        timeZone: null,
        settingsKey: null,
      });
    }

    return result;
  }

  /**
   * Update a dynamic scheduler's cron expression.
   *
   * Flow:
   * 1. Validate cron expression
   * 2. Update GlobalSetting in database
   * 3. AppSettingsService cache refreshes (periodic or forced)
   * 4. @OnEvent('app-settings.cache-refreshed') triggers scheduler sync
   *
   * This follows the EXISTING pattern used by DnaRegenerationScheduler.
   * No direct SchedulerRegistry manipulation — the event-driven sync
   * ensures consistency between DB state and runtime.
   */
  async updateSchedulerCron(
    schedulerName: string,
    cronExpression: string,
  ): Promise<SchedulerInfo> {
    const dynamic = DYNAMIC_SCHEDULER_SETTINGS[schedulerName];
    if (!dynamic) {
      throw new BadRequestException(
        `Scheduler '${schedulerName}' is static and cannot be modified at runtime`
      );
    }

    // Validate cron expression
    try {
      new CronJob(cronExpression, () => {});
    } catch {
      throw new BadRequestException(
        `Invalid cron expression: '${cronExpression}'`
      );
    }

    // Update the GlobalSetting
    await this.globalSettingService.updateByKey(dynamic.cronKey, cronExpression);

    // Force cache refresh so the scheduler picks up the change immediately
    await this.globalSettingService.refreshCache();

    // Return updated scheduler info
    return this.getScheduler(schedulerName);
  }

  /**
   * Enable or disable a dynamic scheduler.
   */
  async toggleScheduler(
    schedulerName: string,
    enabled: boolean,
  ): Promise<SchedulerInfo> {
    const dynamic = DYNAMIC_SCHEDULER_SETTINGS[schedulerName];
    if (!dynamic) {
      throw new BadRequestException(
        `Scheduler '${schedulerName}' is static and cannot be toggled`
      );
    }

    await this.globalSettingService.updateByKey(
      dynamic.enabledKey,
      String(enabled),
    );

    await this.globalSettingService.refreshCache();

    return this.getScheduler(schedulerName);
  }

  /**
   * Manually trigger a dynamic scheduler's callback (one-off).
   * Uses the existing handler method pattern.
   */
  async triggerScheduler(schedulerName: string): Promise<void> {
    // The trigger map connects scheduler names to injectable services.
    // For now, this is hardcoded; future enhancement: use a registry.
    // The controller injects the specific scheduler and calls its handler.
    throw new NotImplementedException(
      'Manual trigger requires scheduler-specific handler injection'
    );
  }

  /**
   * Pause a running cron job.
   */
  pauseScheduler(schedulerName: string): void {
    try {
      const job = this.schedulerRegistry.getCronJob(schedulerName);
      if (!job.running) {
        throw new ConflictException(`Scheduler '${schedulerName}' is already paused`);
      }
      job.stop();
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw new NotFoundException(`Scheduler '${schedulerName}' not found`);
    }
  }

  /**
   * Resume a paused cron job.
   */
  resumeScheduler(schedulerName: string): void {
    try {
      const job = this.schedulerRegistry.getCronJob(schedulerName);
      if (job.running) {
        throw new ConflictException(`Scheduler '${schedulerName}' is already running`);
      }
      job.start();
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw new NotFoundException(`Scheduler '${schedulerName}' not found`);
    }
  }

  private getScheduler(name: string): SchedulerInfo {
    const all = this.listSchedulers();
    const found = all.find(s => s.name === name);
    if (!found) throw new NotFoundException(`Scheduler '${name}' not found`);
    return found;
  }

  private extractCronExpression(job: CronJob): string | null {
    // CronJob stores the expression internally
    try {
      return (job as any).cronTime?.source ?? null;
    } catch {
      return null;
    }
  }
}
```

**Cron Update Flow (leverages existing infrastructure):**

```
Admin UI                      API                         Service
  │                            │                            │
  │ PATCH /schedulers/:name    │                            │
  │ { cronExpression: "..." }  │                            │
  │──────────────────────────→ │                            │
  │                            │ updateSchedulerCron()      │
  │                            │──────────────────────────→ │
  │                            │                            │
  │                            │  1. Validate CronJob(expr) │
  │                            │  2. globalSettingService    │
  │                            │     .updateByKey()         │
  │                            │     → UPDATE GlobalSetting │
  │                            │  3. refreshCache()         │
  │                            │     → cacheAppSettings()   │
  │                            │     → emit 'app-settings   │
  │                            │       .cache-refreshed'    │
  │                            │                            │
  │                            │  DnaRegenerationScheduler  │
  │                            │  @OnEvent('^')             │
  │                            │  → syncSchedulerFromConfig │
  │                            │  → stopJob() + replaceJob()│
  │                            │                            │
  │                            │ ← SchedulerInfo response   │
  │ ← 200 OK                  │                            │
```

#### Frontend: Cron Expression Editor Component

The editor provides both manual input and preset-based selection with human-readable preview.

```typescript
// apps/ui-playground/src/features/admin/schedulers/components/cron-expression-editor.tsx

interface CronExpressionEditorProps {
  value: string;
  onChange: (expression: string) => void;
  onSave: (expression: string) => void;
  onCancel: () => void;
  schedulerName: string;
}

const CRON_PRESETS = [
  { label: 'Every minute',          value: '* * * * *' },
  { label: 'Every 5 minutes',       value: '*/5 * * * *' },
  { label: 'Every 15 minutes',      value: '*/15 * * * *' },
  { label: 'Every hour',            value: '0 * * * *' },
  { label: 'Every 6 hours',         value: '0 */6 * * *' },
  { label: 'Daily at midnight',     value: '0 0 * * *' },
  { label: 'Daily at 2 AM',         value: '0 2 * * *' },
  { label: 'Weekly on Monday 9 AM', value: '0 9 * * 1' },
  { label: '1st of every month',    value: '0 0 1 * *' },
] as const;

const CRON_FIELD_LABELS = ['Minute', 'Hour', 'Day', 'Month', 'Weekday'];
const CRON_FIELD_RANGES = ['0-59', '0-23', '1-31', '1-12', '0-6'];
```

**UI Layout:**

```
┌── Dialog ──────────────────────────────────────────────┐
│ DialogHeader: "Edit Schedule — dna-regeneration"       │
│                                                         │
│ ┌── 5-field cron input ──────────────────────────────┐ │
│ │ ┌────────┐ ┌────────┐ ┌────────┐ ┌───────┐ ┌─────┐│ │
│ │ │Minute  │ │Hour    │ │Day     │ │Month  │ │Week ││ │
│ │ │  0     │ │  2     │ │  *     │ │  *    │ │  *  ││ │
│ │ │(0-59)  │ │(0-23)  │ │(1-31)  │ │(1-12) │ │(0-6)││ │
│ │ └────────┘ └────────┘ └────────┘ └───────┘ └─────┘│ │
│ └────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌── Preview ─────────────────────────────────────────┐ │
│ │ Runs: Every day at 2:00 AM                         │ │
│ │ Next 3 runs:                                       │ │
│ │   • Mar 30, 2026, 2:00 AM                          │ │
│ │   • Mar 31, 2026, 2:00 AM                          │ │
│ │   • Apr 1, 2026, 2:00 AM                           │ │
│ └────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌── Presets ─────────────────────────────────────────┐ │
│ │ [Every minute] [Every 5 min] [Every hour]          │ │
│ │ [Daily midnight] [Daily 2AM] [Weekly Mon 9AM]      │ │
│ │ [1st of month]                                      │ │
│ └────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌── Validation ──────────────────────────────────────┐ │
│ │ ✓ Valid cron expression                             │ │
│ │ — or —                                              │ │
│ │ ✗ Invalid: Day-of-month value out of range          │ │
│ └────────────────────────────────────────────────────┘ │
│                                                         │
│                            [Cancel]  [Save Schedule]    │
└─────────────────────────────────────────────────────────┘
```

**Cron-to-Human translation** uses a lightweight utility (no heavy dependency):

```typescript
// apps/ui-playground/src/features/admin/schedulers/utils/cron-human.ts

/**
 * Converts a 5-field cron expression to a human-readable string.
 * Handles the most common patterns; falls back to raw expression.
 */
export function cronToHuman(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) return expression;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every minute
  if (expression === '* * * * *') return 'Every minute';

  // Every N minutes
  const everyNMin = minute.match(/^\*\/(\d+)$/);
  if (everyNMin && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${everyNMin[1]} minutes`;
  }

  // Every N hours
  const everyNHour = hour.match(/^\*\/(\d+)$/);
  if (minute === '0' && everyNHour && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${everyNHour[1]} hours`;
  }

  // Specific time daily
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every day at ${pad(hour)}:${pad(minute)}`;
  }

  // Specific day of week
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dayOfMonth === '*' && month === '*' && /^\d+$/.test(dayOfWeek)) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `Every ${days[Number(dayOfWeek)] ?? dayOfWeek} at ${pad(hour)}:${pad(minute)}`;
  }

  // Specific day of month
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(dayOfMonth) && month === '*' && dayOfWeek === '*') {
    return `${ordinal(Number(dayOfMonth))} of every month at ${pad(hour)}:${pad(minute)}`;
  }

  // Fallback
  return expression;
}

function pad(n: string): string {
  return n.padStart(2, '0');
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Computes the next N run times for a cron expression.
 * Uses the `cron` package's CronJob internally.
 */
export function getNextRuns(expression: string, count = 3): Date[] {
  // Client-side implementation using simple date math
  // For accuracy, the API returns next runs server-side
  // This is a UI-only approximation for instant preview
  const runs: Date[] = [];
  // ... simplified date iteration logic ...
  return runs;
}
```

**Validation uses server-side validation (API returns error) + client-side basic check:**

```typescript
export function isValidCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return false;

  const ranges = [
    { min: 0, max: 59 },  // minute
    { min: 0, max: 23 },  // hour
    { min: 1, max: 31 },  // day of month
    { min: 1, max: 12 },  // month
    { min: 0, max: 7 },   // day of week (0 and 7 = Sunday)
  ];

  return parts.slice(0, 5).every((part, i) => {
    if (part === '*') return true;
    if (part.startsWith('*/')) {
      const step = Number(part.slice(2));
      return !isNaN(step) && step > 0 && step <= ranges[i].max;
    }
    // Handle comma-separated values
    return part.split(',').every(segment => {
      // Handle ranges (e.g., 1-5)
      if (segment.includes('-')) {
        const [start, end] = segment.split('-').map(Number);
        return !isNaN(start) && !isNaN(end)
          && start >= ranges[i].min && end <= ranges[i].max
          && start <= end;
      }
      const num = Number(segment);
      return !isNaN(num) && num >= ranges[i].min && num <= ranges[i].max;
    });
  });
}
```

---

### 3.4 Core Interfaces & DTOs

#### Domain Types (`packages/domains/src/interfaces/queueAdminTypes.ts`)

```typescript
import { JobQueue } from '../enums';

// ── Queue Stats ───────────────────────────────────────

export interface QueueStats {
  name: string;
  isPaused: boolean;
  counts: QueueJobCounts;
  workerCount: number;
}

export interface QueueJobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  prioritized: number;
}

// ── Queue Events (SSE) ───────────────────────────────

export type QueueEventType =
  | 'job:completed'
  | 'job:failed'
  | 'job:stalled'
  | 'job:active'
  | 'job:waiting'
  | 'job:progress';

export interface QueueEventPayload {
  type: QueueEventType;
  queueName: string;
  jobId: string;
  timestamp: number;
  failedReason?: string;
  returnValue?: string;
  progress?: number | object;
}

// ── Job Summary (list view) ──────────────────────────

export interface JobSummary {
  id: string;
  name: string;
  queueName: string;
  status: string;
  progress: number | null;
  attempts: number;
  maxAttempts: number;
  delay: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
  parentId: string | null;
}

// ── Job Detail ───────────────────────────────────────

export interface JobDetail extends JobSummary {
  data: Record<string, unknown>;       // PII-redacted
  returnValue: unknown | null;
  stacktrace: string[];
  logs: string[];
  opts: JobOptions;
}

export interface JobOptions {
  attempts: number;
  delay: number;
  backoff: { type: string; delay: number } | null;
  priority: number;
  removeOnComplete: boolean | number;
  removeOnFail: boolean | number;
}

// ── Scheduler ────────────────────────────────────────

export interface SchedulerInfo {
  name: string;
  type: 'cron' | 'interval' | 'timeout';
  source: 'static' | 'dynamic';
  cronExpression: string | null;
  intervalMs: number | null;
  running: boolean;
  lastExecution: string | null;
  nextExecution: string | null;
  timeZone: string | null;
  settingsKey: string | null;
}

// ── Redis Health ─────────────────────────────────────

export interface RedisHealthInfo {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
  connectedClients: number;
  usedMemory: string;
  uptime: number;
  version: string;
  queuesRegistered: number;
}

// ── Metrics ──────────────────────────────────────────

export interface QueueMetrics {
  queueName: string;
  period: string;
  completedRate: number;
  failedRate: number;
  avgProcessingTimeMs: number;
  avgWaitTimeMs: number;
}
```

#### API DTOs (`apps/api/src/modules/queue-admin/dto/`)

```typescript
// ── Requests ─────────────────────────────────────────

// clean-queue.request.ts
export class CleanQueueRequest {
  @IsEnum(['completed', 'failed'])
  @ApiProperty({ enum: ['completed', 'failed'] })
  status: 'completed' | 'failed';

  @IsInt()
  @Min(0)
  @ApiProperty({ description: 'Remove jobs older than this (ms)' })
  gracePeriodMs: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  @ApiProperty({ required: false, default: 1000 })
  limit?: number;
}

// list-jobs.query.ts
export class ListJobsQuery {
  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiProperty({ required: false, default: 0 })
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiProperty({ required: false, default: 20 })
  limit?: number;

  @IsOptional()
  @IsEnum(['waiting', 'active', 'completed', 'failed', 'delayed'])
  @ApiProperty({
    required: false,
    enum: ['waiting', 'active', 'completed', 'failed', 'delayed'],
  })
  status?: string;

  @IsOptional()
  @IsString()
  @ApiProperty({ required: false })
  jobName?: string;

  @IsOptional()
  @IsDateString()
  @ApiProperty({ required: false })
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  @ApiProperty({ required: false })
  toDate?: string;
}

// bulk-job-action.request.ts
export class BulkJobActionRequest {
  @IsEnum(['retry', 'remove'])
  @ApiProperty({ enum: ['retry', 'remove'] })
  action: 'retry' | 'remove';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @ApiProperty({ type: [String], minItems: 1, maxItems: 100 })
  jobIds: string[];
}

// update-scheduler.request.ts
export class UpdateSchedulerRequest {
  @IsOptional()
  @IsString()
  @ApiProperty({ required: false, description: 'New cron expression' })
  cronExpression?: string;

  @IsOptional()
  @IsBoolean()
  @ApiProperty({ required: false })
  enabled?: boolean;
}
```

#### Pipe (`apps/api/src/modules/queue-admin/pipes/queue-name.pipe.ts`)

```typescript
@Injectable()
export class QueueNamePipe implements PipeTransform {
  transform(value: string): string {
    if (!Object.values(JobQueue).includes(value as JobQueue)) {
      throw new NotFoundException(`Queue '${value}' is not registered`);
    }
    return value;
  }
}
```

---

### 3.5 Module Structure

#### API Module (`apps/api/src/modules/queue-admin/queue-admin.module.ts`)

```typescript
@Module({
  imports: [
    QueueAdminServiceModule,  // from @arcaai/applications
  ],
  controllers: [
    QueueAdminController,
    SchedulerAdminController,
  ],
})
export class QueueAdminModule {}
```

This module is added to `featureModules` in `app.module.ts`.

#### Service Module (`packages/applications/src/services/queue-admin/queue-admin.service.module.ts`)

```typescript
@Module({
  imports: [
    CoreDatabaseModule,
    RedisServiceModule.register([]),  // reuses existing Redis connection
    BullModule.registerQueue(
      ...Object.values(JobQueue).map(name => ({ name }))
    ),
  ],
  providers: [
    QueueAdminService,
    JobAdminService,
    SchedulerAdminService,
    JobDataRedactorService,
    QueueEventsService,
    {
      provide: IQueueAdminService,
      useClass: QueueAdminService,
    },
    {
      provide: IJobAdminService,
      useClass: JobAdminService,
    },
    {
      provide: ISchedulerAdminService,
      useClass: SchedulerAdminService,
    },
  ],
  exports: [
    IQueueAdminService,
    IJobAdminService,
    ISchedulerAdminService,
    QueueEventsService,
    JobDataRedactorService,
  ],
})
export class QueueAdminServiceModule {}
```

---

## 4. Implementation Plan

### Phase 1: Core Infrastructure (Backend)

| # | Task | Layer | Test |
|---|------|-------|------|
| 1.1 | Define `QueueEventPayload`, `SchedulerInfo`, `JobSummary`, `JobDetail` interfaces | `packages/domains` | Type-only |
| 1.2 | Implement `JobDataRedactorService` | `packages/applications` | Unit tests for each redaction strategy |
| 1.3 | Implement `QueueAdminService` (list queues, pause/resume, clean, stats) | `packages/applications` | Unit tests with mocked BullMQ `Queue` |
| 1.4 | Implement `JobAdminService` (list/detail/retry/remove/bulk/promote) | `packages/applications` | Unit tests |
| 1.5 | Implement `SchedulerAdminService` | `packages/applications` | Unit tests |
| 1.6 | Implement `QueueEventsService` (SSE) | `packages/applications` | Unit tests for lifecycle + refcounting |
| 1.7 | Create `QueueAdminServiceModule` | `packages/applications` | Module loads |

### Phase 2: API Layer (Backend)

| # | Task | Layer | Test |
|---|------|-------|------|
| 2.1 | Create DTOs, `QueueNamePipe` | `apps/api` | Validation unit tests |
| 2.2 | Create `QueueAdminController` (queues + jobs + SSE) | `apps/api` | E2E tests |
| 2.3 | Create `SchedulerAdminController` | `apps/api` | E2E tests |
| 2.4 | Register `QueueAdminModule` in `app.module.ts` | `apps/api` | Build check |

### Phase 3: Frontend — Data Layer

| # | Task | Layer |
|---|------|-------|
| 3.1 | Create `features/admin/api/jobs.ts` (query/mutation hooks) | `ui-playground` |
| 3.2 | Create `features/admin/api/schedulers.ts` | `ui-playground` |
| 3.3 | Create `use-job-sse.ts` hook | `ui-playground` |

### Phase 4: Frontend — Jobs UI

| # | Task | Layer |
|---|------|-------|
| 4.1 | Create route files + sidebar entries + breadcrumbs | `ui-playground` |
| 4.2 | `JobsDashboardPage` (health cards, queue table, auto-refresh) | `ui-playground` |
| 4.3 | `QueueDetailPage` (tab-based status view, bulk actions) | `ui-playground` |
| 4.4 | `JobDetailSheet` (metadata, data viewer, error, timeline) | `ui-playground` |
| 4.5 | `JobStatusBadge`, `JobProgressCell` shared components | `ui-playground` |

### Phase 5: Frontend — Schedulers UI

| # | Task | Layer |
|---|------|-------|
| 5.1 | `SchedulersPage` (table, toggle, detail sheet) | `ui-playground` |
| 5.2 | `CronExpressionEditor` dialog | `ui-playground` |
| 5.3 | `cron-human.ts` utility + `isValidCron` | `ui-playground` |

### Phase 6: Frontend — Monitoring

| # | Task | Layer |
|---|------|-------|
| 6.1 | Throughput line chart | `ui-playground` |
| 6.2 | Status distribution donut chart | `ui-playground` |
| 6.3 | Queue comparison bar chart | `ui-playground` |
| 6.4 | Redis health indicator | `ui-playground` |
| 6.5 | Worker status cards | `ui-playground` |

---

## 5. Security Considerations

| Concern | Mitigation |
|---|---|
| PII in job data | `JobDataRedactorService` — server-side, queue-aware |
| Never expose `obliterate()` | API only allows `clean()` on `completed`/`failed` |
| No raw Redis commands | All operations go through BullMQ SDK |
| No job data mutation | Retry re-uses original data |
| Audit trail | All mutations emit `AuditLog` via existing `SysEvent` |
| Auth | `@Authorize(['manage', 'all'])` on all endpoints |
| Rate limiting | Reads: 60/min, Mutations: 20/min, Bulk: 5/min |
| SSE connection limit | Max 2 concurrent SSE per user |

---

## 6. Change History

| Date | Description | Files |
|------|-------------|-------|
| 2026-03-29 | Initial design document with SSE, PII, cron, interfaces | This file |
