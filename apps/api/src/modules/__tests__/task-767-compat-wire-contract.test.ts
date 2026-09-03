/**
 * the v1-compat surfaces are frozen WIRE contracts, not frozen ACCESS.
 *
 * The requirement is that a service account can drive standalone speech-to-text
 * and summarization "via SDK compat and API compat". The obvious objection is
 * that those surfaces are frozen and therefore untouchable. That reading
 * conflates two different things:
 *
 *   WIRE contract — path, HTTP verb, accepted request fields, response shape.
 *                    A v1 client sends bytes; those bytes must keep working.
 * THIS is what is frozen (scope fence).
 *   ACCESS posture — which credential classes may present themselves.
 *                    Expressed entirely in guard metadata (`@RequiredScopes`,
 *                    `@RequiredSvcScopes`, `@ForbidApiKey`), which the caller
 *                    cannot observe except as 401/403 on a request it was
 *                    never entitled to make.
 *
 * already moved the access posture of these very controllers — it
 * added `@RequiredScopes` where there had been none — without anyone treating
 * that as a wire change, and `task-562-text-compat.spec.ts` still passes on the
 * original v1 bodies. Adding `@RequiredSvcScopes` is the same kind of edit for
 * the third credential class.
 *
 * This suite is the proof rather than the assertion. It reads the wire contract
 * off Nest's own route table and off `class-validator`'s metadata storage —
 * which is exactly what the global `ValidationPipe`
 * (`transform + whitelist + forbidNonWhitelisted`) consults to decide which
 * fields a request may carry — and pins it verbatim. A source-level grep would
 * pass on a route declared through a helper and fail on a comment; metadata
 * cannot lie.
 */
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { getMetadataStorage } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { SERVICE_ACCOUNT_REQUIRED_SCOPES, API_KEY_REQUIRED_SCOPES } from '@arcaai/applications';

import { SttCompatController } from '../stt-compat/stt-compat.controller';
import { StartSessionRequest } from '../stt-compat/dto/start-session.request';
import { SwitchSessionRequest } from '../stt-compat/dto/switch-session.request';
import { StopSessionRequest } from '../stt-compat/dto/stop-session.request';
import { TextCompatController } from '../text-compat/text-compat.controller';
import { PreSummaryRequest } from '../text-compat/dto/pre-summary.request';
import { SyncSummaryRequest } from '../text-compat/dto/sync-summary.request';

/** Every routed handler on a controller prototype, as Nest sees it. */
function routeTable(ControllerClass: new (...args: never[]) => unknown): Array<{ handler: string; path: string; verb: string }> {
  const proto = ControllerClass.prototype as object;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .flatMap((name) => {
      const handler = (proto as Record<string, unknown>)[name];
      if (typeof handler !== 'function') return [];
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) return [];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      return [{ handler: name, path, verb: RequestMethod[method ?? RequestMethod.GET] as string }];
    })
    .sort((a, b) => a.handler.localeCompare(b.handler));
}

/**
 * The property names the global `ValidationPipe` will accept on a DTO.
 *
 * `forbidNonWhitelisted` rejects anything outside this set with a 400, so it IS
 * the accepted-field half of the wire contract. Read from the same metadata
 * storage the pipe reads.
 */
function acceptedFields(Dto: new () => object): string[] {
  return [
    ...new Set(
      getMetadataStorage()
        .getTargetValidationMetadatas(Dto, '', false, false)
        .map((m) => m.propertyName),
    ),
  ].sort();
}

// ---------------------------------------------------------------------------
// STT compat — `POST /api/stt/*` (prefix-excluded in main.ts)
// ---------------------------------------------------------------------------

describe('SttCompatController wire contract is unchanged by ', () => {
  it('exposes exactly the three v1 routes, at the v1 paths and verbs', () => {
    expect(routeTable(SttCompatController)).toEqual([
      { handler: 'startSession', path: 'start_session', verb: 'POST' },
      { handler: 'stopSession', path: 'stop_session', verb: 'POST' },
      { handler: 'switchSession', path: 'switch', verb: 'POST' },
    ]);
  });

  it('is still mounted at the frozen `api/stt` prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SttCompatController)).toBe('api/stt');
  });

  it('accepts exactly the v1 request fields — start_session', () => {
    expect(acceptedFields(StartSessionRequest)).toEqual([
      'audioSettings',
      'language',
      'pipelineId',
      'provider',
      'session_id',
      'startOn',
    ]);
  });

  it('accepts exactly the v1 request fields — switch', () => {
    expect(acceptedFields(SwitchSessionRequest)).toEqual(['session_id', 'target']);
  });

  it('accepts exactly the v1 request fields — stop_session', () => {
    expect(acceptedFields(StopSessionRequest)).toEqual(['bit_depth', 'channels', 'sample_rate', 'session_id']);
  });
});

// ---------------------------------------------------------------------------
// Summarization compat — `POST /api/smr/api/v1/*` (prefix-excluded in main.ts)
// ---------------------------------------------------------------------------

describe('TextCompatController wire contract is unchanged by ', () => {
  it('exposes exactly the two v1 routes, at the v1 paths and verbs', () => {
    expect(routeTable(TextCompatController)).toEqual([
      { handler: 'presummary', path: 'presummary', verb: 'POST' },
      { handler: 'summarySync', path: 'summary/sync', verb: 'POST' },
    ]);
  });

  it('is still mounted at the frozen `api/smr/api/v1` prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TextCompatController)).toBe('api/smr/api/v1');
  });

  it('accepts exactly the v1 request fields — summary/sync', () => {
    expect(acceptedFields(SyncSummaryRequest)).toEqual([
      'context',
      'department',
      'doctor_id',
      'encounter_type',
      'include_pre_summary_in_context',
      'include_previous_visit_summary',
      'max_tokens',
      'session_data',
      'specialty',
      'stream',
      'system_prompt',
      'temperature',
      'translate_to_english',
      'use_enhanced_format',
      'user_prompt_template',
      'visit_type',
    ]);
  });

  it('accepts exactly the v1 request fields — presummary', () => {
    expect(acceptedFields(PreSummaryRequest)).toEqual([
      'age',
      'current_department',
      'dob',
      'doctor_id',
      'formatted_previous_visits',
      'formatted_test_results',
      'formatted_vitals',
      'gender',
      'language',
      'max_tokens',
      'stream',
      'temperature',
      'visit_type',
    ]);
  });
});

// ---------------------------------------------------------------------------
// What DID change: access posture only, and additively.
// ---------------------------------------------------------------------------

describe(' changed ACCESS, and only additively', () => {
  const svcScopes = (target: object) => Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, target) as string[] | undefined;
  const keyScopes = (target: object) => Reflect.getMetadata(API_KEY_REQUIRED_SCOPES, target) as string[] | undefined;

  it('STT compat: the pre-existing API-key scope is untouched, and a svc: sibling is added', () => {
    expect(keyScopes(SttCompatController)).toEqual(['stt:stream:write']);
    expect(svcScopes(SttCompatController)).toEqual(['svc:stt:stream:write']);
  });

  it('summarization compat: same, declared per-route exactly where the key scope is', () => {
    for (const handler of ['summarySync', 'presummary'] as const) {
      const ref = (TextCompatController.prototype as unknown as Record<string, object>)[handler]!;
      expect(keyScopes(ref), `${handler} key scope`).toEqual(['consultation:report:write']);
      expect(svcScopes(ref), `${handler} svc scope`).toEqual(['svc:consultation:report:write']);
    }
  });

  it('the two vocabularies stay disjoint — a svc: scope never appears as an API-key requirement', () => {
    for (const target of [SttCompatController, TextCompatController.prototype.summarySync, TextCompatController.prototype.presummary]) {
      for (const scope of keyScopes(target as object) ?? []) {
        expect(scope.startsWith('svc:'), `${scope} is a machine scope and must not gate an API key`).toBe(false);
      }
    }
  });
});
