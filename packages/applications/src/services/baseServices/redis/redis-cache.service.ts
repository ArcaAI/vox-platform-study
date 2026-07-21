import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { IConfigService } from '../_meta/config';

/**
 * Interface for Redis cache operations
 */
export interface IRedisCacheService {
  /**
   * Get a value from cache
   * @param key - Cache key
   * @returns Cached value or null if not found
   */
  get(key: string): Promise<string | null>;

  /**
   * Set a value in cache with optional TTL
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttlSeconds - Time to live in seconds (optional)
   */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  /**
   * Set a value in cache with TTL (setex)
   * @param key - Cache key
   * @param ttlSeconds - Time to live in seconds
   * @param value - Value to cache
   */
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;

  /**
   * Delete a key from cache
   * @param key - Cache key
   */
  del(key: string): Promise<void>;

  /**
   * Delete multiple keys from cache
   * @param keys - Array of cache keys
   */
  delMany(keys: string[]): Promise<void>;

  /**
   * Find keys matching a pattern.
   *
   * IMPORTANT: backed by Redis `KEYS`, which is O(N) and BLOCKS the
   * server thread for the entire keyspace scan. Suitable for admin /
   * dev tooling, NOT for production request paths. For hot paths use
   * {@link scan} instead.
   *
   * @param pattern - Key pattern (supports * wildcard)
   * @returns Array of matching keys
   */
  keys(pattern: string): Promise<string[]>;

  /**
   * Iteratively scan keys matching a pattern using non-blocking SCAN.
   *
   * Unlike {@link keys}, this does NOT block the Redis server: it walks
   * the keyspace in `count`-sized chunks via the cursor protocol (returns
   * once cursor wraps back to `0`). Drop-in shape-compatible replacement
   * for hot-path uses of `keys()`.
   *
   * @param pattern - Key pattern (supports * wildcard)
   * @param options - `count` is a Redis hint for the per-iteration batch
   *                  size (default `200`). The server may return more or
   *                  fewer items per round-trip; the total walks the
   *                  whole keyspace regardless.
   * @returns Array of matching keys
   */
  scan(pattern: string, options?: { count?: number }): Promise<string[]>;

  /**
   * Check if a key exists
   * @param key - Cache key
   * @returns true if key exists
   */
  exists(key: string): Promise<boolean>;

  /**
   * Publish a message to a channel
   * @param channel - Channel name
   * @param message - Message to publish
   */
  publish(channel: string, message: string): Promise<void>;

  /**
   * Push a value to the head of a Redis list (LPUSH)
   * @param key - List key
   * @param value - Value to push
   * @returns Number of elements in the list after push, or 0 if not connected
   */
  lpush(key: string, value: string): Promise<number>;

  /**
   * Push a value to the tail of a Redis list (RPUSH)
   * @param key - List key
   * @param value - Value to push
   * @returns Number of elements in the list after push, or 0 if not connected
   */
  rpush(key: string, value: string): Promise<number>;

  /**
   * Set a field in a Redis hash (HSET)
   * @param key - Hash key
   * @param field - Field name within the hash
   * @param value - Value to set
   */
  hset(key: string, field: string, value: string): Promise<void>;

  /**
   * Add a member to a Redis set (SADD). Idempotent — re-adding an existing
   * member is a no-op.
   * @param key - Set key
   * @param member - Member to add
   * @returns Number of members added (0 if already present or not connected)
   */
  sadd(key: string, member: string): Promise<number>;

  /**
   * Remove a member from a Redis set (SREM).
   * @param key - Set key
   * @param member - Member to remove
   * @returns Number of members removed (0 if absent or not connected)
   */
  srem(key: string, member: string): Promise<number>;

  /**
   * Read all members of a Redis set (SMEMBERS).
   * @param key - Set key
   * @returns Array of members (empty if missing or not connected)
   */
  smembers(key: string): Promise<string[]>;

  /**
   * Increment a key's integer value by 1 (INCR)
   * @param key - Cache key
   * @returns The value after increment, or 0 if not connected
   */
  incr(key: string): Promise<number>;

  /**
   * Set a timeout on a key in seconds (EXPIRE)
   * @param key - Cache key
   * @param ttlSeconds - Time to live in seconds
   * @returns true if the timeout was set, false otherwise
   */
  expire(key: string, ttlSeconds: number): Promise<boolean>;

  /**
   * Execute a Lua script atomically (Redis EVAL).
   *
   * Used by `RefreshTokenService.consume()` to
   * collapse the GET / DEL / DEL / SETEX flip into a single atomic
   * operation. Redis serialises Lua scripts so two concurrent invocations
   * race-replay each other deterministically — exactly one observes the
   * active row, the other sees the post-DEL state.
   *
   * No `script-load` / `evalsha` caching: refresh-token consumes are
   * low-frequency and the script body is small, so the extra round-trip
   * to script-load doesn't pay off relative to the simpler API.
   *
   * @param script   Lua source.
   * @param numKeys  Number of `KEYS[]` entries; remaining args populate `ARGV[]`.
   * @param args     Keys followed by argv values, in the order Redis expects.
   * @returns        Whatever the script's `return` evaluates to (string,
   *                 number, array, or null when the script returns nil /
   *                 false / when Redis is unavailable).
   */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;

  /**
   * Check if Redis is connected and available
   */
  isConnected(): boolean;
}

export const IRedisCacheService = Symbol('IRedisCacheService');

/**
 * Redis Cache Service
 *
 * Provides caching operations using Redis with automatic connection management
 * and graceful fallback when Redis is unavailable.
 *
 * @example
 * ```typescript
 * // Inject the service
 * constructor(
 *   @Inject(IRedisCacheService) private readonly cache: IRedisCacheService
 * ) {}
 *
 * // Use caching
 * const cached = await this.cache.get('my-key');
 * if (!cached) {
 *   const data = await this.fetchData();
 *   await this.cache.setex('my-key', 300, JSON.stringify(data));
 * }
 * ```
 */
@Injectable()
export class RedisCacheService implements IRedisCacheService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private redis: Redis | null = null;
  private connected = false;
  private reconnecting = false;

  constructor(@Optional() @Inject(IConfigService) private readonly configService?: IConfigService) {
    this.logger.log({
      message: 'Service created',
      service: RedisCacheService.name,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  /**
   * Connect to Redis
   */
  private async connect(): Promise<void> {
    if (!this.configService) {
      this.logger.warn({
        message: 'ConfigService not available',
        status: 'cache_disabled',
      });
      return;
    }

    if (!this.configService.isRedisConfigured()) {
      this.logger.warn({
        message: 'Redis not configured',
        status: 'cache_disabled',
      });
      return;
    }

    try {
      const config = this.configService.getRedisConfig();

      this.redis = new Redis({
        host: config.host,
        port: config.port,
        password: config.password,
        retryStrategy: (times) => {
          if (times > 3) {
            this.logger.error({
              message: 'Redis connection failed after retries',
              retries: times,
            });
            return null; // Stop retrying
          }
          return Math.min(times * 200, 2000);
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
      });

      this.redis.on('connect', () => {
        this.connected = true;
        this.reconnecting = false;
        this.logger.log({
          message: 'Connected to Redis',
          host: config.host,
          port: config.port,
        });
      });

      this.redis.on('error', (error) => {
        this.logger.error({
          message: 'Redis error',
          error: error.message,
        });
        this.connected = false;
      });

      this.redis.on('close', () => {
        this.connected = false;
        this.logger.warn({
          message: 'Redis connection closed',
        });
      });

      this.redis.on('reconnecting', () => {
        this.reconnecting = true;
        this.logger.log({
          message: 'Reconnecting to Redis',
        });
      });

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Redis connection timeout'));
        }, 5000);

        this.redis!.once('ready', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.redis!.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to connect to Redis',
        error: error instanceof Error ? error.message : String(error),
      });
      this.redis = null;
      this.connected = false;
    }
  }

  /**
   * Disconnect from Redis
   */
  private async disconnect(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.quit();
        this.logger.log({
          message: 'Disconnected from Redis',
        });
      } catch (error) {
        this.logger.error({
          message: 'Error disconnecting from Redis',
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.redis = null;
        this.connected = false;
      }
    }
  }

  /**
   * Check if Redis is connected
   */
  isConnected(): boolean {
    return this.connected && this.redis !== null;
  }

  /**
   * Get a value from cache
   */
  async get(key: string): Promise<string | null> {
    if (!this.isConnected()) {
      return null;
    }

    try {
      return await this.redis!.get(key);
    } catch (error) {
      this.logger.error({
        message: 'Failed to get key',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Set a value in cache
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.isConnected()) {
      return;
    }

    try {
      if (ttlSeconds) {
        await this.redis!.setex(key, ttlSeconds, value);
      } else {
        await this.redis!.set(key, value);
      }
    } catch (error) {
      this.logger.error({
        message: 'Failed to set key',
        key,
        ttlSeconds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Set a value with TTL
   */
  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    if (!this.isConnected()) {
      return;
    }

    try {
      await this.redis!.setex(key, ttlSeconds, value);
    } catch (error) {
      this.logger.error({
        message: 'Failed to setex key',
        key,
        ttlSeconds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Delete a key
   */
  async del(key: string): Promise<void> {
    if (!this.isConnected()) {
      return;
    }

    try {
      await this.redis!.del(key);
    } catch (error) {
      this.logger.error({
        message: 'Failed to delete key',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Delete multiple keys
   */
  async delMany(keys: string[]): Promise<void> {
    if (!this.isConnected() || keys.length === 0) {
      return;
    }

    try {
      await this.redis!.del(...keys);
    } catch (error) {
      this.logger.error({
        message: 'Failed to delete keys',
        keyCount: keys.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Find keys matching a pattern (KEYS — O(N), blocking).
   *
   * See the interface TSDoc: prefer {@link scan} for production paths.
   */
  async keys(pattern: string): Promise<string[]> {
    if (!this.isConnected()) {
      return [];
    }

    try {
      return await this.redis!.keys(pattern);
    } catch (error) {
      this.logger.error({
        message: 'Failed to find keys with pattern',
        pattern,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Iteratively scan keys matching a pattern using non-blocking SCAN.
   *
   * Walks the keyspace via the cursor protocol until cursor wraps to
   * `'0'`. Returns the union of all matched keys, de-duplicated by Redis
   * server semantics (SCAN may return the same key in multiple
   * iterations across rehashes — we accept the upstream behaviour
   * without further dedupe to keep the implementation surface tiny).
   */
  async scan(pattern: string, options?: { count?: number }): Promise<string[]> {
    if (!this.isConnected()) {
      return [];
    }

    const count = options?.count ?? 200;
    const matches: string[] = [];
    let cursor = '0';

    try {
      do {
        const [next, keys] = await this.redis!.scan(cursor, 'MATCH', pattern, 'COUNT', count);
        cursor = next;
        if (keys.length > 0) {
          matches.push(...keys);
        }
      } while (cursor !== '0');
      return matches;
    } catch (error) {
      this.logger.error({
        message: 'Failed to scan keys with pattern',
        pattern,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    if (!this.isConnected()) {
      return false;
    }

    try {
      const result = await this.redis!.exists(key);
      return result === 1;
    } catch (error) {
      this.logger.error({
        message: 'Failed to check existence of key',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Publish a message to a channel
   */
  async publish(channel: string, message: string): Promise<void> {
    if (!this.isConnected()) {
      return;
    }

    try {
      await this.redis!.publish(channel, message);
    } catch (error) {
      this.logger.error({
        message: 'Failed to publish to channel',
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Push a value to the head of a Redis list (LPUSH)
   *
   * Used for enqueueing messages into Dramatiq task queues.
   * Dramatiq workers consume from Redis lists via BRPOP.
   */
  async lpush(key: string, value: string): Promise<number> {
    if (!this.isConnected()) {
      return 0;
    }

    try {
      return await this.redis!.lpush(key, value);
    } catch (error) {
      this.logger.error({
        message: 'Failed to lpush to list',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Push a value to the tail of a Redis list (RPUSH)
   *
   * Used for Dramatiq message dispatch: the message ID is RPUSHed
   * to the queue list while the payload is stored in a hash.
   */
  async rpush(key: string, value: string): Promise<number> {
    if (!this.isConnected()) {
      return 0;
    }

    try {
      return await this.redis!.rpush(key, value);
    } catch (error) {
      this.logger.error({
        message: 'Failed to rpush to list',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Increment a key's integer value by 1 (INCR)
   *
   * Used for rate limiting counters. Returns the value after increment.
   * If the key does not exist, it is set to 0 before performing the increment.
   */
  async incr(key: string): Promise<number> {
    if (!this.isConnected()) {
      return 0;
    }

    try {
      return await this.redis!.incr(key);
    } catch (error) {
      this.logger.error({
        message: 'Failed to increment key',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Set a timeout on a key in seconds (EXPIRE)
   *
   * Used alongside INCR for sliding-window rate limiting.
   */
  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    if (!this.isConnected()) {
      return false;
    }

    try {
      const result = await this.redis!.expire(key, ttlSeconds);
      return result === 1;
    } catch (error) {
      this.logger.error({
        message: 'Failed to set expiry on key',
        key,
        ttlSeconds,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Execute a Lua script atomically against Redis.
   *
   * See interface TSDoc. Returns `null` when
   * Redis is unavailable (graceful degradation, mirroring the rest of
   * this service) — callers must treat `null` as "missing record".
   */
  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (!this.isConnected()) {
      return null;
    }

    try {
      // ioredis types the variadic eval as `(script, numKeys, ...keysAndArgs)`.
      // `as never` defeats the union-of-overloads issue without weakening
      // the public surface we expose to consumers.
      return await this.redis!.eval(script, numKeys, ...(args as never[]));
    } catch (error) {
      this.logger.error({
        message: 'Failed to eval Lua script',
        scriptPrefix: script.slice(0, 60),
        numKeys,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Set a field in a Redis hash (HSET)
   *
   * Used for Dramatiq message dispatch: the message payload is stored
   * in a hash keyed by message ID (e.g. dramatiq:stt_batch.msgs).
   */
  async hset(key: string, field: string, value: string): Promise<void> {
    if (!this.isConnected()) {
      return;
    }

    try {
      await this.redis!.hset(key, field, value);
    } catch (error) {
      this.logger.error({
        message: 'Failed to hset in hash',
        key,
        field,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Add a member to a Redis set (SADD).
   *
   * Used to track the live cross-instance set of active consultations per
   * tenant (`live-doc:active:{tenantId}`) for the admin live console.
   */
  async sadd(key: string, member: string): Promise<number> {
    if (!this.isConnected()) {
      return 0;
    }

    try {
      return await this.redis!.sadd(key, member);
    } catch (error) {
      this.logger.error({
        message: 'Failed to sadd to set',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Remove a member from a Redis set (SREM).
   */
  async srem(key: string, member: string): Promise<number> {
    if (!this.isConnected()) {
      return 0;
    }

    try {
      return await this.redis!.srem(key, member);
    } catch (error) {
      this.logger.error({
        message: 'Failed to srem from set',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Read all members of a Redis set (SMEMBERS).
   */
  async smembers(key: string): Promise<string[]> {
    if (!this.isConnected()) {
      return [];
    }

    try {
      return await this.redis!.smembers(key);
    } catch (error) {
      this.logger.error({
        message: 'Failed to read set members',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
