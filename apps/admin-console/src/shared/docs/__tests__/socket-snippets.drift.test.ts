/**
 * TASK-975 lane B's T8, landed under TASK-983 lane G (R9 gap 3) — the socket-lane snippets the
 * Integration panel's socket views render must name methods, events and options that EXIST on the
 * real SDKs. Mirrors `sdk-snippets.drift.test.ts`'s approach: check the SNIPPET TEXT against the
 * actual exported prototypes, rather than trusting each snippet was hand-verified once and never
 * touched again.
 *
 * This file caught a real drift on arrival, fixed in `socket-snippets.ts` itself (not just pinned
 * here): `sttRealtimeVoxNodeSnippet` called `socket.send(pcm16LeMonoChunk)`. `RealtimeSttSocket`
 * has no `send` method — sending one PCM16 frame is `sendPcm16(frame)`. `send` exists only on the
 * underlying `SocketLike` (the raw WebSocket the class wraps), which a consumer of the SDK never
 * touches directly. `sdk-screen.tsx`'s own hand-written example already used `sendPcm16` — this
 * file is what keeps the two from disagreeing again.
 *
 * Event names (`'transcript' | 'status' | 'error' | 'resumed' | 'close'`) and the `transport`
 * option on `streamRun` / `runAndStream` / `useWorkflowRun` are TYPES, not runtime values —
 * `RealtimeSttSocket.on` accepts any string at runtime, so a renamed event cannot be caught by
 * calling the method. Those are pinned as compile-time assignments below instead:
 * `pnpm --filter @arcaai/admin-console typecheck` goes red the moment either union drops a member
 * this file names — the `it` blocks below check today's SNIPPET TEXT against that pinned list.
 */
import { describe, expect, it } from 'vitest';
import { HopeClient, RealtimeSttSocket, SttResource, WorkflowsResource } from '@arcaai/vox-node';
import type { RealtimeSttEventName, StreamRunOptions } from '@arcaai/vox-node';
import { AgenticProvider as _AgenticProviderCore, useWorkflowRun } from '@arcaai/vox/core';
import type { UseWorkflowRunOptions } from '@arcaai/vox/core';
import { AgenticProvider as _AgenticProviderRoot, useArcaAudio } from '@arcaai/vox';
import {
  sttBrowserCaptureSnippet,
  sttRealtimeVoxNodeSnippet,
  workflowSocketCurlSnippet,
  workflowSocketVoxNodeSnippet,
  workflowSocketVoxSnippet,
} from '../socket-snippets';

/** Method names a resource/class actually carries, constructor excluded. */
function methodsOf(target: abstract new (...args: never[]) => object): Set<string> {
  return new Set(Object.getOwnPropertyNames(target.prototype).filter((name) => name !== 'constructor'));
}

/**
 * Every `hope.<resource>.<path…>(` call a snippet makes, as its dotted path after `hope.`.
 * Deliberately greedy about depth, exactly like `sdk-snippets.drift.test.ts`: a call that reaches
 * through a sub-resource that does not exist must be CAPTURED so it can fail, not skipped.
 */
function hopeCalledPaths(snippet: string): string[] {
  return [...snippet.matchAll(/\bhope\.((?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g)].map((match) => match[1]);
}

/** Every `socket.<method>(` call a snippet makes against the `RealtimeSttSocket` it built. */
function socketCalledMethods(snippet: string): string[] {
  return [...snippet.matchAll(/\bsocket\.([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
}

const RESOURCE_METHODS: Record<string, Set<string>> = {
  stt: methodsOf(SttResource),
  workflows: methodsOf(WorkflowsResource),
};

const SOCKET_METHODS = methodsOf(RealtimeSttSocket);

/**
 * Compile-time pin: assignable to `RealtimeSttEventName` only while every member below is a real
 * event key on `RealtimeSttSocketEvents`. Enforced by `pnpm --filter @arcaai/admin-console
 * typecheck`, not by the `it` blocks below — `.on()` performs no runtime validation of its event
 * name argument, so a renamed union member would otherwise pass every test in this file silently.
 */
const KNOWN_STT_EVENT_NAMES: readonly RealtimeSttEventName[] = ['transcript', 'status', 'error', 'resumed', 'gap', 'close'];

/** Same reasoning as {@link KNOWN_STT_EVENT_NAMES}: `transport` is a plain string field. */
const _workflowStreamRunTransportOption: StreamRunOptions = { transport: 'socket' };
const _useWorkflowRunTransportOption: UseWorkflowRunOptions = { transport: 'socket' };
void _workflowStreamRunTransportOption;
void _useWorkflowRunTransportOption;
// Both hooks/classes are imported above ONLY to prove the import path resolves and the export
// name exists — using an aliased binding keeps the linter from flagging them as unused.
void _AgenticProviderCore;
void _AgenticProviderRoot;

const VOX_NODE_SNIPPETS = [
  { name: 'workflow socket (vox-node)', code: workflowSocketVoxNodeSnippet('discharge-summary') },
  { name: 'STT socket (vox-node)', code: sttRealtimeVoxNodeSnippet('asr') },
] as const;

describe('vox-node socket snippets name methods that exist', () => {
  it.each(VOX_NODE_SNIPPETS)('$name', ({ code }) => {
    const paths = hopeCalledPaths(code);
    expect(paths.length).toBeGreaterThan(0);

    for (const path of paths) {
      const [resource, ...rest] = path.split('.');
      const methods = RESOURCE_METHODS[resource];
      expect(methods, `hope.${resource} is not a known resource namespace`).toBeDefined();
      // A snippet must call a method DIRECTLY on the resource. Anything deeper is a sub-resource
      // that has to be proven to exist.
      expect(rest, `hope.${path}() reaches through a sub-resource that does not exist`).toHaveLength(1);
      expect(methods).toContain(rest[0]);
    }
  });

  it.each(VOX_NODE_SNIPPETS)('$name constructs a usable client with a baseUrl', ({ code }) => {
    expect(code).toMatch(/new HopeClient\(/);
    const construction = code.slice(code.indexOf('new HopeClient('));
    expect(construction).toMatch(/baseUrl:/);
  });

  it('HopeClient refuses construction without a baseUrl (the reason every snippet passes one)', () => {
    expect(() => new HopeClient({ apiKey: 'k' } as unknown as ConstructorParameters<typeof HopeClient>[0])).toThrow(/baseUrl/);
  });
});

describe('the STT socket snippet calls only methods RealtimeSttSocket actually has', () => {
  it('every socket.<method>( call resolves on the real class', () => {
    const code = sttRealtimeVoxNodeSnippet('asr');
    const methods = socketCalledMethods(code);
    expect(methods.length).toBeGreaterThan(0);

    for (const method of methods) {
      expect(SOCKET_METHODS, `RealtimeSttSocket has no method \`${method}\` — this snippet is a dead end`).toContain(method);
    }
  });

  it('sends audio with sendPcm16, never the raw-socket-only send()', () => {
    const code = sttRealtimeVoxNodeSnippet('asr');
    const methods = socketCalledMethods(code);

    expect(methods).toContain('sendPcm16');
    expect(methods).not.toContain('send');
    // `send` is real, but only on the underlying `SocketLike` — never on `RealtimeSttSocket`
    // itself, so it must never appear in `SOCKET_METHODS` either.
    expect(SOCKET_METHODS).not.toContain('send');
  });

  /**
   * TASK-991 wave 2 — `finalize()` resolves only on the terminal status frame
   * (`realtime-stt-socket.ts:339`), so an UN-awaited call loses the tail final; it does not send
   * `{type:'close'}` either, and the gateway clears the sessionId binding at finalize
   * (`stt-ws.gateway.ts:1857`), which is why a `closeStreamSession()` afterwards answers 404. The
   * snippet used to print exactly that sequence. This pins the SDK's own documented one.
   */
  it('tears the session down the way the SDK documents: await finalize, close, await waitForClosed', () => {
    const code = sttRealtimeVoxNodeSnippet('asr');
    expect(code).toMatch(/await socket\.finalize\(\)/);
    expect(code).toMatch(/socket\.close\(\)/);
    expect(code).toMatch(/await socket\.waitForClosed\(\)/);
    // An un-awaited finalize is the defect; it must never come back.
    expect(code).not.toMatch(/^\s*socket\.finalize\(\)/m);
    // closeStreamSession is a real method, but not on this path.
    expect(code).not.toMatch(/hope\.stt\.closeStreamSession\(/);
  });

  it('subscribes to `gap` — a hole the Manual lane calls text that is gone for good', () => {
    expect(sttRealtimeVoxNodeSnippet('asr')).toMatch(/socket\.on\('gap'/);
  });

  it('every socket.on(...) event name is one this file has pinned against the real event union', () => {
    const code = sttRealtimeVoxNodeSnippet('asr');
    const events = [...code.matchAll(/socket\.on\('([a-z]+)'/g)].map((match) => match[1]);
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      expect(KNOWN_STT_EVENT_NAMES, `'${event}' is not in KNOWN_STT_EVENT_NAMES — update the pin (and check it still typechecks)`).toContain(
        event,
      );
    }
  });
});

describe('the browser socket snippets import real hooks from the paths they claim', () => {
  it('workflowSocketVoxSnippet imports useWorkflowRun from @arcaai/vox/core and passes the real transport option', () => {
    expect(typeof useWorkflowRun).toBe('function');
    const code = workflowSocketVoxSnippet('discharge-summary');
    expect(code).toMatch(/import\s*\{\s*AgenticProvider,\s*useWorkflowRun\s*\}\s*from\s*'@arcaai\/vox\/core'/);
    expect(code).toMatch(/useWorkflowRun\(\{\s*transport:\s*'socket'\s*\}\)/);
  });

  it('sttBrowserCaptureSnippet imports useArcaAudio from @arcaai/vox', () => {
    expect(typeof useArcaAudio).toBe('function');
    const code = sttBrowserCaptureSnippet('asr');
    expect(code).toMatch(/import\s*\{\s*AgenticProvider,\s*useArcaAudio\s*\}\s*from\s*'@arcaai\/vox'/);
    // Capture, not invocation — agentSlug is the only selector this snippet may pass.
    expect(code).toMatch(/audio\.start\(\{\s*agentSlug:/);
  });
});

describe('the websocat fallback mints the ticket before opening the url it returns', () => {
  it('workflowSocketCurlSnippet mints the run-scoped ticket, then opens the returned url', () => {
    const code = workflowSocketCurlSnippet('discharge-summary');
    expect(code).toMatch(/runs\/\$RUN_ID\/stream-ticket/);
    expect(code).toMatch(/websocat/);
    // curl cannot speak WebSocket — this snippet must never claim it can.
    expect(code).not.toMatch(/curl[^\n]*ws(?:s)?:\/\//);
  });

  /**
   * TASK-991 wave 2 — `issueRunStreamTicket` answers a RELATIVE url that already carries the
   * ticket (`workflows.controller.ts:398-399`), and `workflow-ws.gateway.ts:82-88` reads `ticket`
   * straight off the query string. The snippet used to append a second `?ticket=` to a url with
   * no scheme or host, which is two ways of failing the handshake at once.
   */
  it('resolves the relative url against the origin and does NOT re-append the ticket', () => {
    const code = workflowSocketCurlSnippet('discharge-summary');
    expect(code).not.toMatch(/websocat[^\n]*\?ticket=/);
    expect(code).toMatch(/jq -r \.url/);
    // The url is relative, so the snippet has to supply a ws(s) origin of its own.
    expect(code).toMatch(/websocat "\$WS_ORIGIN\$URL"/);
  });
});
