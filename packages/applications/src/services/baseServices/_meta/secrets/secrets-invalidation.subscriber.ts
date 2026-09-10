// TASK-944 lane C — the production subscriber for `arca:secrets:invalidate`.
//
// ## Why this file had to be written at all
//
// `SecretsService.attachRedisSubscriber` has existed, with four unit tests, since the
// channel was introduced. It had **no production caller** anywhere in the tree — only
// its own tests and one stub in `apps/api/tests/helpers`. Measured on `hope-v2-dev`,
// `PUBSUB NUMSUB arca:secrets:invalidate` reported 0 subscribers, so every rotation
// converged on the TTL re-warm alone while `docs/operations/vault/README.md` told
// operators the channel was the mechanism and the TTL merely the backstop.
//
// The publishers were all real: `SettingsRegistryWriteService`, `vault-rotation-worker`
// and `apps/api`'s scheduled-rotation processor all publish here. Only the listening
// end was missing.
//
// ## Why it consumes `RedisSubscriberService` and not a raw ioredis client
//
// Redis forbids other commands on a connection in SUBSCRIBE mode, so the platform
// already owns exactly one place that holds such a connection and multiplexes channels
// over it. `AppSettingsModule` wires its own `app-settings:invalidate` listener the same
// way; using the same service means secrets do not open a second subscriber connection
// per process for one channel.
//
// ## Failure posture: fail OPEN, loudly
//
// Every path here degrades to "no fast invalidation" rather than blocking boot: no
// subscriber wired, Redis unreachable, the stream erroring later. The TTL re-warm still
// converges the cache — that is the property that makes fail-open correct rather than
// negligent, and it is the same posture `AppSettingsService` takes on its own channel.
// What is NOT acceptable is failing open SILENTLY, which is how this went unnoticed, so
// each degraded path names itself in the log.

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { RedisSubscriberService } from '../../../stt/realtime/redisSubscriber.service';
import { SecretsService } from './SecretsService';

@Injectable()
export class SecretsInvalidationSubscriber implements OnModuleInit {
  private readonly logger = new Logger(SecretsInvalidationSubscriber.name);

  // Tokens are declared EXPLICITLY rather than inferred from the parameter types.
  // This package's vitest config sets `emitDecoratorMetadata: false` (see
  // `vitest.config.ts` — Oxc/legacy-decorator interop), so `design:paramtypes` is
  // empty under test and implicit type-based injection silently yields `undefined`
  // for every parameter. An `@Optional()` dependency resolved to `undefined` is
  // exactly the failure mode this whole provider exists to end, so it must not be
  // reachable through a build-tool difference.
  constructor(
    @Inject(SecretsService) private readonly secretsService: SecretsService,
    // Optional so a module graph without Redis (unit fixtures, the provider-type-only
    // secrets tests) still boots; absent ⇒ TTL-only convergence, stated in the log.
    @Optional() @Inject(RedisSubscriberService) private readonly redisSubscriberService?: RedisSubscriberService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.redisSubscriberService) {
      this.logger.warn({
        message: 'Redis subscriber not available — secret rotations converge on the TTL re-warm only',
        channel: SecretsService.INVALIDATION_CHANNEL,
      });
      return;
    }

    try {
      const messages$ = await this.redisSubscriberService.subscribeToChannel(SecretsService.INVALIDATION_CHANNEL);
      messages$.subscribe({
        next: (raw: string) => this.secretsService.handleInvalidationMessage(raw),
        error: (error: unknown) => {
          this.logger.warn({
            message: 'Secret invalidation subscription errored — falling back to TTL-only convergence',
            channel: SecretsService.INVALIDATION_CHANNEL,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
      this.logger.log({ message: 'Subscribed to secret invalidation channel', channel: SecretsService.INVALIDATION_CHANNEL });
    } catch (error) {
      this.logger.warn({
        message: 'Failed to subscribe to the secret invalidation channel — falling back to TTL-only convergence',
        channel: SecretsService.INVALIDATION_CHANNEL,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
