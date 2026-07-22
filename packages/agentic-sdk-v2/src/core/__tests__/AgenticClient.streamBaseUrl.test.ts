/**
 * AgenticClient.getStreamBaseUrl (TASK-543)
 *
 * SSE opens against the gateway directly when a `wsUrl` gateway base is set
 * (BFF-split deployment), else against the REST base — never proxying a
 * long-lived stream through a REST BFF.
 */

import { describe, it, expect } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { createMockLogger } from '../../__tests__/setup';

const logger = createMockLogger();

describe('AgenticClient.getStreamBaseUrl', () => {
    it('returns the REST base unchanged when no gateway wsUrl is configured', () => {
        const client = new AgenticClient({ baseUrl: 'https://gw.example.com/api/v1' }, logger);
        expect(client.getStreamBaseUrl()).toBe('https://gw.example.com/api/v1');
    });

    it('opens streams against the gateway (http origin + /api/v1) in a BFF-split deployment', () => {
        const client = new AgenticClient({ baseUrl: 'https://app.example.com/api/hope', wsUrl: 'https://gw.example.com' }, logger);
        expect(client.getStreamBaseUrl()).toBe('https://gw.example.com/api/v1');
        // REST + ticket mint still go through the BFF base.
        expect(client.getBaseUrl()).toBe('https://app.example.com/api/hope');
    });

    it('normalizes a ws:// gateway base to http:// and strips a trailing slash', () => {
        const client = new AgenticClient({ baseUrl: 'https://app.example.com/api/hope', wsUrl: 'wss://gw.example.com/' }, logger);
        expect(client.getStreamBaseUrl()).toBe('https://gw.example.com/api/v1');
    });
});
