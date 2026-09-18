import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface CookieRecord {
  name: string;
  value: string;
  [key: string]: unknown;
}
type CookieJar = Map<string, CookieRecord>;

/**
 * `cookies()` is REQUEST-scoped in Next (AsyncLocalStorage), and that is
 * load-bearing here: a single shared jar would make every simulated request
 * the same browser, which is exactly the distinction the cross-operator case
 * below has to draw. Each simulated request therefore runs inside its own jar.
 */
const { scope } = vi.hoisted(() => ({
  scope: { requests: null, fallback: new Map() } as {
    requests: AsyncLocalStorage<CookieJar> | null;
    fallback: CookieJar;
  },
}));

vi.mock('next/headers', () => ({
  cookies: async () => {
    const store = scope.requests?.getStore() ?? scope.fallback;
    return {
      get: (name: string) => store.get(name),
      set: (name: string, value: string, options?: Record<string, unknown>) => {
        store.set(name, { name, value, ...(options ?? {}) });
      },
      delete: (name: string) => {
        store.delete(name);
      },
      has: (name: string) => store.has(name),
    };
  },
}));

import { refreshSession } from '../refresh';
import { SESSION_COOKIE_NAME, sealSession, unsealSession, type SessionPayload } from '../session';

const requests = new AsyncLocalStorage<CookieJar>();
scope.requests = requests;

const API = 'http://gateway.test:8868';
const REFRESH_URL = `${API}/api/v1/auth/refresh`;

/**
 * Every test gets its own token pair: a settled rotation stays answerable for
 * a grace window (see `ROTATION_MEMO_MS`), and that memo is module state, so
 * reusing one refresh token across tests would let one test answer the next.
 */
function sessionFor(id: string): SessionPayload {
  return {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    user: { id: `user-${id}`, username: id, email: `${id}@example.com`, roles: ['SUPER_ADMIN'] },
  };
}

/** Runs `work` as one HTTP request: its own cookie jar, returned for assertions. */
async function withRequest<T>(cookie: string, work: () => Promise<T>): Promise<{ result: T; jar: CookieJar }> {
  const jar: CookieJar = new Map([[SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: cookie }]]);
  const result = await requests.run(jar, work);
  return { result, jar };
}

interface RecordedCall {
  url: string;
  body: string | null;
}

function installFetchMock(handler: (call: RecordedCall) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const call: RecordedCall = { url, body: typeof init?.body === 'string' ? init.body : null };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sessionIn(jar: CookieJar): Promise<SessionPayload | null> {
  return unsealSession(jar.get(SESSION_COOKIE_NAME)?.value);
}

afterEach(() => {
  vi.unstubAllGlobals();
  scope.fallback.clear();
});

describe('refreshSession', () => {
  it('rotates once for two concurrent callers of the same session, and reseals both', async () => {
    const session = sessionFor('shared');
    const cookie = await sealSession(session);
    const calls = installFetchMock(async () => {
      await sleep(20);
      return Response.json({ token: 'access-next', refreshToken: 'refresh-next' });
    });

    const [first, second] = await Promise.all([
      withRequest(cookie, () => refreshSession(session)),
      withRequest(cookie, () => refreshSession(session)),
    ]);

    expect(calls.map((call) => call.url)).toEqual([REFRESH_URL]);
    expect(first.result?.accessToken).toBe('access-next');
    expect(second.result?.accessToken).toBe('access-next');
    // Each caller reseals in its OWN request context, so whichever response
    // the browser actually receives carries the rotated cookie. A waiter that
    // answered without a Set-Cookie would leave the browser replaying a token
    // the gateway has already consumed.
    expect(await sessionIn(first.jar)).toMatchObject({ refreshToken: 'refresh-next' });
    expect(await sessionIn(second.jar)).toMatchObject({ refreshToken: 'refresh-next' });
  });

  // D-3a, the production shape: a page load fires a dozen parallel proxied
  // calls against one expired access token. The ones that 401 AFTER the
  // rotation settled are separate requests whose cookie still holds the spent
  // token — replaying it is what the gateway reads as reuse, and it revokes
  // the entire refresh-token family.
  it('answers a caller that arrives after the rotation settled without replaying the spent token', async () => {
    const session = sessionFor('late');
    const cookie = await sealSession(session);
    const calls = installFetchMock(() => Response.json({ token: 'access-next', refreshToken: 'refresh-next' }));

    await withRequest(cookie, () => refreshSession(session));
    const late = await withRequest(cookie, () => refreshSession(session));

    expect(calls).toHaveLength(1);
    expect(late.result?.accessToken).toBe('access-next');
    expect(late.result?.refreshToken).toBe('refresh-next');
  });

  // D-3a, the same-request half: the caller's snapshot predates a rotation
  // this request has already observed.
  it('does not call the gateway when the cookie already holds a newer refresh token', async () => {
    const stale = sessionFor('stale');
    const cookie = await sealSession({ ...stale, accessToken: 'access-newer', refreshToken: 'refresh-newer' });
    const calls = installFetchMock(() => Response.json({ token: 'must-not-happen', refreshToken: 'must-not-happen' }));

    const { result } = await withRequest(cookie, () => refreshSession(stale));

    expect(calls).toHaveLength(0);
    expect(result?.accessToken).toBe('access-newer');
    expect(result?.refreshToken).toBe('refresh-newer');
  });

  // D-3b: a module-scope single-flight slot hands the second operator the
  // first operator's tokens, and the proxy then sends them on their request.
  it('never hands one operator another operator rotated tokens', async () => {
    const alice = sessionFor('alice');
    const bob = sessionFor('bob');
    const [aliceCookie, bobCookie] = await Promise.all([sealSession(alice), sealSession(bob)]);
    installFetchMock(async (call) => {
      const { refreshToken } = JSON.parse(call.body ?? '{}') as { refreshToken: string };
      await sleep(20);
      return Response.json({ token: `access-${refreshToken}`, refreshToken: `${refreshToken}-next` });
    });

    const [first, second] = await Promise.all([
      withRequest(aliceCookie, () => refreshSession(alice)),
      withRequest(bobCookie, () => refreshSession(bob)),
    ]);

    expect(first.result?.accessToken).toBe('access-refresh-alice');
    expect(first.result?.user.id).toBe('user-alice');
    expect(second.result?.accessToken).toBe('access-refresh-bob');
    expect(second.result?.user.id).toBe('user-bob');
    expect(await sessionIn(second.jar)).toMatchObject({ refreshToken: 'refresh-bob-next' });
  });

  // A memo entry freezes ONE pair, but the cookie moves on: each tab runs its
  // own unsynchronised heartbeat, so a second rotation inside the 30s window
  // is ordinary. A straggler still holding the oldest token must not be handed
  // the pair that has since been rotated away — resealing it would regress the
  // cookie to a token the gateway has already consumed, and the NEXT rotation
  // would then look like reuse and revoke the family.
  it('hands a caller two rotations behind the newest pair, not the one its own token produced', async () => {
    const first = sessionFor('lineage');
    const second: SessionPayload = { ...first, accessToken: 'access-second', refreshToken: 'refresh-second' };
    const [firstCookie, secondCookie] = await Promise.all([sealSession(first), sealSession(second)]);
    const calls = installFetchMock((call) => {
      const { refreshToken } = JSON.parse(call.body ?? '{}') as { refreshToken: string };
      return refreshToken === 'refresh-lineage'
        ? Response.json({ token: 'access-second', refreshToken: 'refresh-second' })
        : Response.json({ token: 'access-third', refreshToken: 'refresh-third' });
    });

    await withRequest(firstCookie, () => refreshSession(first));
    await withRequest(secondCookie, () => refreshSession(second));
    // Still holding the ORIGINAL token: in flight since before either rotation.
    const straggler = await withRequest(firstCookie, () => refreshSession(first));

    expect(calls).toHaveLength(2);
    expect(straggler.result?.accessToken).toBe('access-third');
    expect(straggler.result?.refreshToken).toBe('refresh-third');
    expect(await sessionIn(straggler.jar)).toMatchObject({ refreshToken: 'refresh-third' });
  });

  it('clears the cookie and returns null when the gateway rejects the rotation', async () => {
    const session = sessionFor('rejected');
    const cookie = await sealSession(session);
    installFetchMock(() => Response.json({ message: 'Invalid or expired refresh token' }, { status: 401 }));

    const { result, jar } = await withRequest(cookie, () => refreshSession(session));

    expect(result).toBeNull();
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });
});
