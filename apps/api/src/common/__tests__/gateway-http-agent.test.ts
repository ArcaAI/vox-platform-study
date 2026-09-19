import { Agent, createServer, globalAgent, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpModule, HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGatewayKeepAliveAgents,
  gatewayKeepAliveAgents,
  GATEWAY_HTTP_AGENT_MAX_FREE_SOCKETS,
  GATEWAY_HTTP_AGENT_MAX_SOCKETS,
} from '../gateway-http-agent';

/**
 * TASK-993 lane C. An assertion that "the agent object has keepAlive: true"
 * proves nothing about actual behaviour — only that a flag was set. This suite
 * proves the SOCKET is actually reused: a throwaway local HTTP server counts
 * every TCP `'connection'` it accepts (Node's `net.Server` 'connection'
 * event fires once per underlying socket, before HTTP parsing, so N
 * requests replayed over ONE kept-alive socket fire it once, not N times),
 * and each case drives that server through a REAL `HttpService` built the
 * same way the four production modules build theirs — `HttpModule.register(
 * {...})` — never a mock. That is also why this file does not follow the
 * mock-everything pattern of the neighbouring controller tests: it exists to
 * verify the transport behaviour those tests deliberately stub out.
 *
 * The "no reuse" side is proved against an EXPLICIT `keepAlive: false` agent,
 * not a bare "no agent configured" module. Node's `http.globalAgent`/
 * `https.globalAgent` already default to `keepAlive: true` on the Node 19+
 * runtime this service ships on (see the doc comment in `../gateway-http-
 * agent.ts`), so a "no agent" control does NOT reproduce a non-pooling
 * baseline here — it was tried first and it measured 1 connection for 5
 * requests, same as the fix. `keepAlive: false` is the honest baseline: it
 * isolates the ONE mechanism this file turns on, independent of whatever a
 * given Node version's global agent happens to default to.
 */

const REQUEST_COUNT = 5;

interface CountingServer {
  server: Server;
  port: number;
  connectionCount: () => number;
}

async function startCountingServer(): Promise<CountingServer> {
  let connections = 0;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, port, connectionCount: () => connections };
}

/** Issues `REQUEST_COUNT` sequential GETs — the same `axiosRef.get`/`.post` shape every
 * production controller in these four modules uses — waiting for each response before
 * sending the next, so reuse (or its absence) cannot be an artifact of overlapping requests. */
async function fireSequentialRequests(httpService: HttpService, port: number): Promise<void> {
  for (let i = 0; i < REQUEST_COUNT; i += 1) {
    const response = await httpService.axiosRef.get(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
  }
}

describe('gateway-http-agent', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('reuses one TCP connection across sequential requests once the keep-alive agent is configured', async () => {
    const started = await startCountingServer();
    server = started.server;
    const agents = createGatewayKeepAliveAgents();

    const moduleRef = await Test.createTestingModule({
      imports: [HttpModule.register({ timeout: 5000, maxRedirects: 3, ...agents })],
    }).compile();

    try {
      await fireSequentialRequests(moduleRef.get(HttpService), started.port);
      // The fix: every request after the first reused the one pooled socket.
      expect(started.connectionCount()).toBe(1);
    } finally {
      agents.httpAgent.destroy();
      agents.httpsAgent.destroy();
      await moduleRef.close();
    }
  });

  it('control: opens a new TCP connection per request with keepAlive explicitly disabled', async () => {
    const started = await startCountingServer();
    server = started.server;
    // The honest "pooling off" baseline — see the file doc comment for why this
    // is `keepAlive: false` rather than a bare "no agent configured" module.
    const controlAgent = new Agent({ keepAlive: false });

    const moduleRef = await Test.createTestingModule({
      imports: [HttpModule.register({ timeout: 5000, maxRedirects: 3, httpAgent: controlAgent })],
    }).compile();

    try {
      await fireSequentialRequests(moduleRef.get(HttpService), started.port);
      // The mechanism, isolated: with keepAlive off, every request opens its own connection.
      expect(started.connectionCount()).toBe(REQUEST_COUNT);
    } finally {
      controlAgent.destroy();
      await moduleRef.close();
    }
  });

  it('createGatewayKeepAliveAgents returns an isolated pair, independent of the shared singleton', () => {
    const isolated = createGatewayKeepAliveAgents();
    try {
      expect(isolated.httpAgent).not.toBe(gatewayKeepAliveAgents.httpAgent);
      expect(isolated.httpsAgent).not.toBe(gatewayKeepAliveAgents.httpsAgent);
    } finally {
      isolated.httpAgent.destroy();
      isolated.httpsAgent.destroy();
    }
  });

  it('bounds maxSockets, unlike Node globalAgent which has none (Infinity)', () => {
    // The real gap this file closes on this Node version (see the file doc
    // comment): the global agent already pools, but with no per-host ceiling.
    expect(globalAgent.maxSockets).toBe(Infinity);
    const agents = createGatewayKeepAliveAgents();
    try {
      expect(agents.httpAgent.maxSockets).toBe(GATEWAY_HTTP_AGENT_MAX_SOCKETS);
      expect(agents.httpAgent.maxSockets).not.toBe(Infinity);
    } finally {
      agents.httpAgent.destroy();
      agents.httpsAgent.destroy();
    }
  });

  it('sizes every agent from the documented, shared constants', () => {
    const agents = createGatewayKeepAliveAgents();
    try {
      expect((agents.httpAgent as unknown as { keepAlive: boolean }).keepAlive).toBe(true);
      expect(agents.httpAgent.maxSockets).toBe(GATEWAY_HTTP_AGENT_MAX_SOCKETS);
      expect(agents.httpAgent.maxFreeSockets).toBe(GATEWAY_HTTP_AGENT_MAX_FREE_SOCKETS);
      expect((agents.httpsAgent as unknown as { keepAlive: boolean }).keepAlive).toBe(true);
      expect(agents.httpsAgent.maxSockets).toBe(GATEWAY_HTTP_AGENT_MAX_SOCKETS);
      expect(agents.httpsAgent.maxFreeSockets).toBe(GATEWAY_HTTP_AGENT_MAX_FREE_SOCKETS);
    } finally {
      agents.httpAgent.destroy();
      agents.httpsAgent.destroy();
    }
  });
});
