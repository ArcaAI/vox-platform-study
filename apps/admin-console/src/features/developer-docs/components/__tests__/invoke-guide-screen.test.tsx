import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';

import { renderWithProviders } from '@/test/render';

import { InvokeGuideScreen } from '../invoke-guide-screen';

/**
 * `/developer/invoke` — "Call a published agent or workflow" (TASK-971 lane E).
 *
 * This is the page that would have caught F-A1/F-C1 before a tenant admin did:
 * the flat-vs-enveloped body distinction, the credential matrix including the
 * workflow-only CASL caveat, the async→poll→stream progression with its ~60s
 * blocking ceiling, the SSE framing, the reserved `input` keys, and the
 * Postman import walkthrough. Every fact asserted here is load-bearing — it
 * is the one thing a developer who has never seen HOPE needs to get right.
 */

afterEach(() => {
  cleanup();
});

describe('InvokeGuideScreen', () => {
  it('has one h1 naming the page', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Call a published agent or workflow' })).toBeDefined();
  });

  it('walks the numbered first-call setup, including minting a key', () => {
    renderWithProviders(<InvokeGuideScreen />);

    // "API keys" links the header action AND the closing "See also" card —
    // both point at the same place, so any one of them proves the route exists.
    const apiKeysLinks = screen.getAllByRole('link', { name: /API keys/i });
    expect(apiKeysLinks.some((link) => link.getAttribute('href') === '/api-keys')).toBe(true);
    expect(screen.getByText(/Mint an API key/i)).toBeDefined();
    expect(screen.getAllByText('api/v1').length).toBeGreaterThan(0);
    expect(screen.getByText(/sits under the/i)).toBeDefined();
  });

  it('states the flat-vs-enveloped body distinction and its consequence', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getByText(/"text"/)).toBeDefined();
    expect(screen.getByText(/"input"/)).toBeDefined();
    expect(screen.getByText(/produced a 400 on every call/i)).toBeDefined();
  });

  it('lists all three credential classes with their headers', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getByText('Authorization: Bearer <jwt>')).toBeDefined();
    expect(screen.getByText('X-API-Key: <key>')).toBeDefined();
    expect(screen.getByText('X-Service-Account-Token: <token>')).toBeDefined();
    expect(screen.getByText(/tenant binds to the credential/i)).toBeDefined();
  });

  it('states the workflow-only CASL caveat (F-C3)', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getByText('create:WorkflowRun')).toBeDefined();
    expect(screen.getByText('read:WorkflowRun')).toBeDefined();
    expect(screen.getByText(/still get a 403 starting a workflow/i)).toBeDefined();
  });

  it('lists the invocation scopes', () => {
    renderWithProviders(<InvokeGuideScreen />);

    // Several scopes are repeated deliberately — once per route they govern in
    // the "Routes at a glance" table, and again in the summary list — so any
    // number of matches greater than zero proves the fact is stated.
    for (const scope of ['agent:invocation:write', 'agent:definition:read', 'workflow:run:write', 'workflow:run:read', 'workflow:definition:read']) {
      expect(screen.getAllByText(scope).length).toBeGreaterThan(0);
    }
  });

  it('explains the async default, the blocking ceiling, and the streaming lane', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getAllByText(/202/).length).toBeGreaterThan(0);
    expect(screen.getByText('runId, status, statusUrl, streamUrl')).toBeDefined();
    expect(screen.getByText('504 at a hard ~60s ceiling')).toBeDefined();
    expect(screen.getByText(/run is still going/i)).toBeDefined();
  });

  it('names every reserved input key', () => {
    renderWithProviders(<InvokeGuideScreen />);

    for (const key of ['consultationId', 'externalPatientId', 'userId', 'jobId', 'sessionId']) {
      expect(screen.getAllByText(key).length).toBeGreaterThan(0);
    }
  });

  it('describes the SSE framing, including keepalive cadence and the snapshot frame', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getByText(':keepalive')).toBeDefined();
    expect(screen.getByText(/every 15 seconds/i)).toBeDefined();
    expect(screen.getByText(/snapshot with no/i)).toBeDefined();
    expect(screen.getByText(/stream ends on the/i)).toBeDefined();
    expect(screen.getAllByText('workflow.run.completed').length).toBeGreaterThan(0);
  });

  it('states that NER cannot stream', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getAllByText(/MODE_UNSUPPORTED/).length).toBeGreaterThan(0);
  });

  it('walks the Postman import flow and states no credential is ever embedded', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getByText(/never contains a credential/i)).toBeDefined();
    expect(screen.getByText(/run request captures its/i)).toBeDefined();
    expect(screen.getAllByText('runId').length).toBeGreaterThan(0);
  });

  // A3 — the reverse pointer: a developer reading the Postman-import walkthrough
  // must be told WHERE the collection it imports comes from, in the same
  // vocabulary the Integration tab itself uses (a Tabs "Integration" trigger,
  // not an internal "panel" name).
  it('points to the Integration tab as the source of the Postman collection (A3)', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getAllByText(/Integration tab/i).length).toBeGreaterThan(0);
  });

  // D1 — the stream ticket authenticates SSE AND WebSocket, minted by two
  // routes that take different credential classes. Documenting only the SSE
  // half was worse than omitting the WebSocket half entirely (F-3).
  it('states the stream ticket authenticates SSE and WebSocket, minted by two routes with different credentials (D1/T9)', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getAllByText(/WebSocket/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SSE/i).length).toBeGreaterThan(0);
    // Named once in the code example and once in the credentials prose — assert
    // presence, not a single element, since both are true and load-bearing.
    expect(screen.getAllByText(/auth\/stream-ticket/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/workflows\/\{slug\}\/runs\/\{runId\}\/stream-ticket/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/user JWT only/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/API key or a service account/i).length).toBeGreaterThan(0);
  });

  // D2 — a companion table for the WebSocket surfaces a developer can reach:
  // /ws/workflows and /ws/stt/stream, with their query-param handshake and
  // scope shape. The legacy compat gateway (`/stt`) is deliberately omitted
  // (OQ-2) — it is a compat surface and documenting it invites new consumers.
  it('lists /ws/workflows and /ws/stt/stream, and never the legacy /stt compat gateway (D2)', () => {
    const { container } = renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getByText('/ws/workflows')).toBeDefined();
    expect(screen.getByText('/ws/stt/stream')).toBeDefined();
    expect(screen.getAllByText(/workflow_run:/).length).toBeGreaterThan(0);
    expect(screen.getByText(/stt_session:/)).toBeDefined();

    // Strip every legitimate "/ws/stt/stream" occurrence out of the rendered
    // text; whatever is left must not still contain a bare "/stt" — proving
    // the legacy compat path was never named on its own.
    const textWithoutModernRoute = (container.textContent ?? '').replaceAll('/ws/stt/stream', '');
    expect(textWithoutModernRoute).not.toMatch(/\/stt(?![a-zA-Z-])/);
  });

  it('states the ticket is single-use and consumed on first open, so SSE is the only lane that resumes', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getAllByText(/single-use/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/only lane that resumes/i)).toBeDefined();
  });

  // TASK-983 R9 gap 1 — frame shapes were documented in no user-facing surface. Every event
  // name from both gateways must be literally present, not just described in prose.
  it('names every /ws/workflows frame event, both directions', () => {
    const { container } = renderWithProviders(<InvokeGuideScreen />);
    const text = container.textContent ?? '';

    expect(text).toMatch(/"event":"workflow\.run\.progress"/);
    expect(text).toMatch(/"event":"workflow\.run\.completed"/);
    expect(screen.getAllByText(/lastEventId/i).length).toBeGreaterThan(0);
  });

  it('names every /ws/stt/stream frame type, both directions, and the binary frame format', () => {
    const { container } = renderWithProviders(<InvokeGuideScreen />);
    const text = container.textContent ?? '';

    for (const type of ['audio', 'metadata', 'stop', 'resume', 'close']) {
      expect(text).toMatch(new RegExp(`"type":"${type}"`));
    }
    for (const type of ['ready', 'transcript', 'status', 'resumed', 'resume_failed', 'error']) {
      expect(text).toMatch(new RegExp(`"type":"${type}"`));
    }
    expect(text).toMatch(/PCM16 LE, mono frame/i);
  });

  it('gives each WebSocket surface its ticket route and credential class', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getAllByText(/API key or service account/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/minted inline, any credential class/i)).toBeDefined();
  });

  it('states resume semantics differ: STT resumes in-band, the workflow socket does not auto-reconnect', () => {
    renderWithProviders(<InvokeGuideScreen />);

    expect(screen.getByText(/Resume semantics differ per lane/i)).toBeDefined();
    expect(screen.getByText(/no automatic reconnect and no in-band resume message/i)).toBeDefined();
  });

  it('links onward to the reference, the SDKs, and API keys', () => {
    renderWithProviders(<InvokeGuideScreen />);

    // "API reference" links both the header action and the closing "See also"
    // card — both point at the reference screen.
    const referenceLinks = screen.getAllByRole('link', { name: /API reference/i });
    expect(referenceLinks.every((link) => link.getAttribute('href') === '/developer/reference')).toBe(true);
    expect(screen.getByRole('link', { name: /SDK/i }).getAttribute('href')).toBe('/developer/sdk');
    expect(screen.getByRole('link', { name: 'Developer overview' }).getAttribute('href')).toBe('/developer');
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(<InvokeGuideScreen />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
