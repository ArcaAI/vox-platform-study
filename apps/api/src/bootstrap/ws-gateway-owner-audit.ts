/**
 * Boot-time audit (gate G4): every WebSocket gateway registered in
 * the gateway process is TRIAGED for owner binding.
 *
 * ─── What this pins, and what it deliberately does NOT ─────────────────────
 *
 * It pins a DECLARATION: a class carrying `@WebSocketGateway()` metadata must
 * appear in `WS_OWNER_BOUND_GATEWAYS` with a classification and the path of the
 * spec that proves it. It CANNOT pin the behaviour. "Performs an owner check"
 * is a property of what the code does at runtime, and no amount of metadata
 * reflection can establish it — an audit that claimed otherwise would be a gate
 * that looks stronger than it is, which is worse than none. The behaviour is
 * proved by the named `regressionSpec`s; `ws-gateway-owner-audit.test.ts`
 * asserts each of those files actually exists, so the registry cannot decay
 * into a citation of deleted tests.
 *
 * The name says `owner-binding` rather than `owner-check` for that reason.
 *
 * ─── Why a NEW audit and not a clause in an existing one ───────────────────
 *
 * This is the structural fact that makes G4 necessary at all: a
 * `@WebSocketGateway()` class is registered in a module's `providers` array,
 * not `controllers`. Every other audit in this directory walks
 * `moduleRef.controllers` — so all of them have always been completely blind to
 * all three gateways. Nothing today would notice if the owner branch in
 * `stt-ws.gateway.ts` were deleted; that is the gap this closes, and it is why
 * the walk below reads `moduleRef.providers`.
 *
 * ─── Why boot failure and not a warning ────────────────────────────────────
 *
 * The failure mode is a gateway that ships with nobody having asked the
 * question. A warning in a boot log is read once, by the person who already
 * knew. Failing the boot means a new WS surface cannot merge until an author
 * has picked one of the three classifications below and named the test that
 * backs it — which is the entire product of this gate.
 *
 * ─── Why not lint ──────────────────────────────────────────────────────────
 *
 * "Checks the owner" has no reliable syntactic signature: it is a comparison
 * between a live session field and a consumed ticket, spelled differently in
 * every gateway. A lint rule matching that shape would be a regex pretending to
 * be an invariant. Registration, by contrast, is a fact about the resolved
 * module graph, which is precisely what a boot audit reads.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { GATEWAY_METADATA } from '@nestjs/websockets/constants';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';

/**
 * How a gateway answers "may THIS caller drive THIS stream?".
 *
 * - `enforced` — the gateway owns a server-side session that outlives a single
 *   socket, so a second principal presenting a valid ticket for the same
 *   session id is a TAKEOVER. Requires an explicit owner comparison.
 * - `no-owned-session` — there is no server-side resource to take over. The
 *   single-use ticket, minted for one session id and burned on use, IS the
 *   whole authorisation. Adding an "owner check" here would be checking a
 *   field that does not exist.
 * - `compat-exempt` — a frozen legacy surface, deliberately out of scope
 *   (conformance review A3). Not a pass mark: an exemption that has to be
 *   spelled out in a registry is an exemption someone can find.
 */
export type WsOwnerBinding = 'enforced' | 'no-owned-session' | 'compat-exempt';

export interface WsGatewayOwnerRecord {
  readonly ownerCheck: WsOwnerBinding;
  /** Repo-relative path of the spec that proves the classification. */
  readonly regressionSpec: string;
  /** Why this classification, in one paragraph, for the next reader. */
  readonly note: string;
}

/**
 * The closed allow-list of triaged gateways — the same posture as
 * `RECOGNISED_SERVICE_TOKEN_GUARD_NAMES` (`api-key-scope-audit.ts`): a name
 * that is not here fails the boot, so a new WS surface cannot ship
 * un-triaged.
 */
export const WS_OWNER_BOUND_GATEWAYS: Readonly<Record<string, WsGatewayOwnerRecord>> = {
  SttWsGateway: {
    ownerCheck: 'enforced',
    regressionSpec: 'apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts',
    note:
      'Owns a server-side STT session that survives a socket drop for the grace window, so "same tenant, different ' +
      'user" is a real hijack and not a theoretical one.  (commit e3f3713fb) added the owner invariant at two ' +
      'independent points: the handshake compares the ticket principal against the stored binding, and `rebindSession` ' +
      'compares again against the LIVE session object — the line that used to read `session.userId = stored.userId` ' +
      'and silently performed the transplant. Both are pinned by the "session OWNER enforced at the WS handshake" ' +
      'describe block in the named spec.',
  },
  TtsWsGateway: {
    ownerCheck: 'no-owned-session',
    regressionSpec: 'apps/api/src/modules/speech/__tests__/tts-ws.gateway.origin.test.ts',
    note:
      'There is no server-side session resource to own: the gateway opens a bridge per socket and the single-use ' +
      '`tts_session:<sessionId>` ticket (minted bound to the active tenant of the caller by POST /auth/stream-ticket, and ' +
      'burned on consumption) is the whole authorisation.  added the fail-closed CSWSH origin gate that runs ' +
      'BEFORE the ticket is parsed, so a hostile origin never burns a ticket. Classified deliberately rather than ' +
      'left `pending`: the review was written before  landed, when this gateway had no origin check at all.',
  },
  SttCompatGateway: {
    ownerCheck: 'compat-exempt',
    regressionSpec: 'apps/api/tests/e2e/stt-compat-switch-cross-tenant.spec.ts',
    note:
      'The frozen legacy `/stt` surface (conformance review A3). It authenticates each socket with a raw API key ' +
      'rather than a stream ticket and binds sessions per tenant, so it has no principal to own a session with. ' +
      'Exempt because the surface is closed to new work, NOT because the question was answered — if it ever reopens, ' +
      'this entry is what makes that visible.',
  },
};

export function auditWebSocketGatewayOwnerBinding(app: INestApplicationContext): void {
  const modulesContainer = app.get(ModulesContainer);

  const offenders: string[] = [];
  const seen = new Set<string>();

  for (const moduleRef of modulesContainer.values()) {
    // `.providers`, NOT `.controllers` — see the docstring. Nest registers a
    // `@WebSocketGateway()` class as an ordinary provider.
    for (const wrapper of moduleRef.providers.values()) {
      const ProviderClass = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
      if (typeof ProviderClass !== 'function') continue;

      if (Reflect.getMetadata(GATEWAY_METADATA, ProviderClass) !== true) continue;

      const name = ProviderClass.name;
      if (seen.has(name)) continue;
      seen.add(name);

      if (!Object.prototype.hasOwnProperty.call(WS_OWNER_BOUND_GATEWAYS, name)) {
        offenders.push(
          `${name} carries @WebSocketGateway() metadata but is not classified in WS_OWNER_BOUND_GATEWAYS ` +
            `(bootstrap/ws-gateway-owner-audit.ts). Every WS surface must declare how it answers "may THIS caller drive ` +
            `THIS stream?": 'enforced' when it owns a server-side session a second principal could take over, ` +
            `'no-owned-session' when the single-use ticket is the whole authorisation and there is no session to adopt, ` +
            `or 'compat-exempt' for a frozen legacy surface. Add the entry with the spec that proves it — the registry ` +
            `pins the DECLARATION, the named spec pins the BEHAVIOUR.`,
        );
      }
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map((o) => `  - ${o}`).join('\n');
    throw new Error(`refused to start — ${offenders.length} WebSocket gateway(s) are not triaged for owner binding:\n${list}`);
  }
}
