/**
 * gate G4 — every WebSocket gateway is triaged for OWNER binding.
 *
 * Read the audit's own docstring for what this can and cannot prove. In short:
 * it pins the DECLARATION (a gateway class is classified, and names the spec
 * that proves its classification), never the BEHAVIOUR. The behaviour is
 * proved by the named specs, which this file asserts actually exist — a
 * registry pointing at a deleted test would be worse than no registry.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketGateway } from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';

import { auditWebSocketGatewayOwnerBinding, WS_OWNER_BOUND_GATEWAYS } from '../ws-gateway-owner-audit';
import { SttWsGateway } from '../../modules/streaming/stt-ws.gateway';
import { TtsWsGateway } from '../../modules/speech/tts-ws.gateway';
import { SttCompatGateway } from '../../modules/stt-compat/stt-compat.gateway';

/**
 * The sibling audits' fake-app helper with ONE deliberate change: the wrapper
 * map is keyed `providers`, not `controllers`.
 *
 * That single word is the whole reason G4 needed a new audit rather than a
 * clause in an existing one. A `@WebSocketGateway()` class is registered in a
 * module's `providers` array, so every `moduleRef.controllers` sweep in
 * `apps/api/src/bootstrap/` — all seven of them — walks straight past all
 * three gateways and always has.
 */
function buildFakeApp(providers: Array<new (...args: never[]) => unknown>): Parameters<typeof auditWebSocketGatewayOwnerBinding>[0] {
  const wrappers = providers.map((ProviderClass) => ({
    metatype: ProviderClass,
    instance: Object.create(ProviderClass.prototype) as Record<string, unknown>,
  }));
  const modulesContainer = new Map([['synthetic', { providers: new Map(wrappers.map((w, i) => [i, w])) }]]);

  return {
    get: (token: unknown) => {
      if (token === ModulesContainer) return modulesContainer;
      if (token === Reflector) return new Reflector();
      throw new Error(`unexpected token: ${String(token)}`);
    },
  } as unknown as Parameters<typeof auditWebSocketGatewayOwnerBinding>[0];
}

const REPO_ROOT = resolve(__dirname, '../../../../..');

describe('WebSocket gateway owner-binding audit (G4)', () => {
  it('passes against the three REAL gateways in the tree', () => {
    const app = buildFakeApp([SttWsGateway, TtsWsGateway, SttCompatGateway]);
    expect(() => auditWebSocketGatewayOwnerBinding(app)).not.toThrow();
  });

  it('FAILS a gateway that is not in the registry — a new WS surface cannot ship un-triaged', () => {
    @WebSocketGateway({ path: '/ws/untriaged' })
    class UntriagedGateway {}

    const app = buildFakeApp([UntriagedGateway]);
    expect(() => auditWebSocketGatewayOwnerBinding(app)).toThrow(/UntriagedGateway/);
  });

  it('ignores ordinary providers — only classes carrying gateway metadata are judged', () => {
    @Injectable()
    class PlainService {}

    const app = buildFakeApp([PlainService]);
    expect(() => auditWebSocketGatewayOwnerBinding(app)).not.toThrow();
  });

  it('lists every un-triaged gateway in one error rather than failing on the first', () => {
    @WebSocketGateway({ path: '/ws/a' })
    class AlphaGateway {}
    @WebSocketGateway({ path: '/ws/b' })
    class BetaGateway {}

    const app = buildFakeApp([AlphaGateway, BetaGateway]);
    expect(() => auditWebSocketGatewayOwnerBinding(app)).toThrow(/AlphaGateway[\s\S]*BetaGateway/);
  });

  it('classifies all three real gateways and nothing else (a stale entry is drift too)', () => {
    expect(Object.keys(WS_OWNER_BOUND_GATEWAYS).sort()).toEqual(['SttCompatGateway', 'SttWsGateway', 'TtsWsGateway']);
  });

  /**
   * The classification VALUES, pinned individually — this is where the review's
   * findings are recorded in code rather than in prose that drifts.
   *
   *   - `SttWsGateway` — `enforced`: it owns a server-side session, so a
   * second user resuming it is a hijack (commit `e3f3713fb`).
   *   - `TtsWsGateway` — `no-owned-session`: there is no server-side resource
   *     to take over; the single-use `tts_session:<id>` ticket IS the whole
   * authorisation, plus the CSWSH origin gate.
   *   - `SttCompatGateway` — `compat-exempt` per review A3.
 */
  it('pins each gateway classification', () => {
    expect(WS_OWNER_BOUND_GATEWAYS.SttWsGateway.ownerCheck).toBe('enforced');
    expect(WS_OWNER_BOUND_GATEWAYS.TtsWsGateway.ownerCheck).toBe('no-owned-session');
    expect(WS_OWNER_BOUND_GATEWAYS.SttCompatGateway.ownerCheck).toBe('compat-exempt');
  });

  /**
   * A registry that names a test which does not exist is worse than no
   * registry: it reads as proof while proving nothing. The filesystem check
   * lives here rather than in the audit deliberately — a boot audit should not
   * stat files, and this is exactly the kind of fact a test is for.
   */
  it('every named regression spec exists on disk', () => {
    for (const [gatewayName, record] of Object.entries(WS_OWNER_BOUND_GATEWAYS)) {
      expect(record.regressionSpec, `${gatewayName} must name a regression spec`).toBeTruthy();
      expect(existsSync(resolve(REPO_ROOT, record.regressionSpec)), `${gatewayName}: ${record.regressionSpec} does not exist`).toBe(true);
    }
  });
});
