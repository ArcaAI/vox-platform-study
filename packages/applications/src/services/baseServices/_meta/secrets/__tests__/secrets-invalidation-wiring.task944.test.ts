// TASK-944 lane C — `arca:secrets:invalidate` must actually have a subscriber.
//
// ## What was measured
//
// On `hope-v2-dev`, `PUBSUB NUMSUB arca:secrets:invalidate` reported **0 subscribers**.
// The channel is documented as the fast propagation path for a rotation ("TTL is the
// backstop, not the mechanism" — `docs/operations/vault/README.md`), it is published to
// by `SettingsRegistryWriteService` / `vault-rotation-worker` / the scheduled-rotation
// processor, and `SecretsService.attachRedisSubscriber` exists to consume it.
//
// Nothing ever called it. A tree-wide search for `attachRedisSubscriber` found only its
// own definition, four unit tests, and one stub in `apps/api/tests/helpers`. So the
// documented mechanism was inert in every deployed environment and rotations converged
// only on the 150 s TTL re-warm — which is also why the JWT sign path took ~150 s to
// notice a rotation the verify path never noticed at all.
//
// ## What this test pins
//
// That the PRODUCTION module graph attaches a subscriber, not merely that the method
// exists. The previous state passed every test in the tree.

import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { RedisSubscriberService } from '../../../../stt/realtime/redisSubscriber.service';
import { SecretsModule } from '../secrets.module';
import { SecretsService } from '../SecretsService';

describe('TASK-944 — SecretsModule attaches the invalidation subscriber', () => {
  const originalEnv = process.env;
  let channelSubject: Subject<string>;
  let subscribeToChannel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...originalEnv, SECRETS_PROVIDER: 'in-memory' };
    channelSubject = new Subject<string>();
    subscribeToChannel = vi.fn().mockResolvedValue(channelSubject.asObservable() as Observable<string>);
  });

  afterEach(() => {
    process.env = originalEnv;
    channelSubject.complete();
  });

  async function bootModule() {
    return Test.createTestingModule({ imports: [SecretsModule.forRoot()] })
      .overrideProvider(RedisSubscriberService)
      .useValue({ subscribeToChannel })
      .compile();
  }

  it('subscribes to the documented channel on init', async () => {
    const moduleRef = await bootModule();
    await moduleRef.init();

    expect(subscribeToChannel).toHaveBeenCalledWith(SecretsService.INVALIDATION_CHANNEL);

    await moduleRef.close();
  });

  it('evicts ONE key on a {key} announcement', async () => {
    const moduleRef = await bootModule();
    await moduleRef.init();
    const secrets = moduleRef.get(SecretsService);
    const invalidate = vi.spyOn(secrets, 'invalidate');

    channelSubject.next(JSON.stringify({ key: 'JWT_SECRET_KEY' }));

    expect(invalidate).toHaveBeenCalledWith('JWT_SECRET_KEY');

    await moduleRef.close();
  });

  it('evicts everything on an {all:true} announcement', async () => {
    const moduleRef = await bootModule();
    await moduleRef.init();
    const secrets = moduleRef.get(SecretsService);
    const invalidateAll = vi.spyOn(secrets, 'invalidateAll');

    channelSubject.next(JSON.stringify({ all: true }));

    expect(invalidateAll).toHaveBeenCalled();

    await moduleRef.close();
  });

  it('ignores a malformed payload rather than taking the process down', async () => {
    const moduleRef = await bootModule();
    await moduleRef.init();

    expect(() => channelSubject.next('{not-json')).not.toThrow();

    await moduleRef.close();
  });
});
