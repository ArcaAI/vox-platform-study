/**
 * @arcaai/vox - SimpleCrossTabSync Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SimpleCrossTabSync, createCrossTabSync } from '../SimpleCrossTabSync';
import type { ContextItem } from '../../types';

// Mock BroadcastChannel
class MockBroadcastChannel {
    static instances: MockBroadcastChannel[] = [];
    name: string;
    onmessage: ((event: MessageEvent) => void) | null = null;
    closed = false;

    constructor(name: string) {
        this.name = name;
        MockBroadcastChannel.instances.push(this);
    }

    postMessage(data: unknown) {
        if (this.closed) return;

        // Broadcast to all other instances with the same name
        MockBroadcastChannel.instances
            .filter(instance => instance.name === this.name && instance !== this && !instance.closed)
            .forEach(instance => {
                if (instance.onmessage) {
                    instance.onmessage(new MessageEvent('message', { data }));
                }
            });
    }

    close() {
        this.closed = true;
        const index = MockBroadcastChannel.instances.indexOf(this);
        if (index > -1) {
            MockBroadcastChannel.instances.splice(index, 1);
        }
    }

    static clearInstances() {
        MockBroadcastChannel.instances = [];
    }
}

// Set up global mock
const originalBroadcastChannel = globalThis.BroadcastChannel;

describe('SimpleCrossTabSync', () => {
    beforeEach(() => {
        MockBroadcastChannel.clearInstances();
        (globalThis as unknown as { BroadcastChannel: typeof MockBroadcastChannel }).BroadcastChannel = MockBroadcastChannel;
    });

    afterEach(() => {
        (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel = originalBroadcastChannel;
    });

    describe('constructor', () => {
        it('should create instance with consultation key', () => {
            const sync = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            });

            expect(sync.getConsultationKey()).toBe('patient-123_doctor-456_2026-01-29');
            expect(sync.isAvailable()).toBe(true);

            sync.close();
        });

        it('should generate unique tab ID', () => {
            const sync1 = new SimpleCrossTabSync({
                patientId: 'p1',
                doctorId: 'd1',
                appointmentDate: '2026-01-29',
            });
            const sync2 = new SimpleCrossTabSync({
                patientId: 'p1',
                doctorId: 'd1',
                appointmentDate: '2026-01-29',
            });

            expect(sync1.getTabId()).not.toBe(sync2.getTabId());

            sync1.close();
            sync2.close();
        });
    });

    describe('createCrossTabSync', () => {
        it('should be a factory function that creates SimpleCrossTabSync', () => {
            const sync = createCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            });

            expect(sync).toBeInstanceOf(SimpleCrossTabSync);
            expect(sync.isAvailable()).toBe(true);

            sync.close();
        });
    });

    describe('context broadcasting', () => {
        it('should broadcast context to other tabs with same consultation', () => {
            const config = {
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            };

            const sync1 = new SimpleCrossTabSync(config);
            const sync2 = new SimpleCrossTabSync(config);

            const receivedContext: ContextItem[] = [];
            sync2.onContextAdded((context) => {
                receivedContext.push(context);
            });

            const testContext: ContextItem = {
                id: 'ctx-1',
                consultationId: 'consultation-1',
                type: 'CASE_NOTE',
                content: 'Test note',
                source: 'USER',
                isSummary: false,
                isTranscription: false,
                isAiGenerated: false,
                createdAt: '2026-01-29T10:00:00Z',
                updatedAt: '2026-01-29T10:00:00Z',
            };

            sync1.broadcastContext(testContext);

            expect(receivedContext).toHaveLength(1);
            expect(receivedContext[0]).toEqual(testContext);

            sync1.close();
            sync2.close();
        });

        it('should NOT broadcast to tabs with different consultation', () => {
            const sync1 = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            });
            const sync2 = new SimpleCrossTabSync({
                patientId: 'patient-different',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            });

            const receivedContext: ContextItem[] = [];
            sync2.onContextAdded((context) => {
                receivedContext.push(context);
            });

            const testContext: ContextItem = {
                id: 'ctx-1',
                consultationId: 'consultation-1',
                type: 'CASE_NOTE',
                content: 'Test note',
                source: 'USER',
                isSummary: false,
                isTranscription: false,
                isAiGenerated: false,
                createdAt: '2026-01-29T10:00:00Z',
                updatedAt: '2026-01-29T10:00:00Z',
            };

            sync1.broadcastContext(testContext);

            expect(receivedContext).toHaveLength(0);

            sync1.close();
            sync2.close();
        });

        it('should NOT receive own messages', () => {
            const config = {
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            };

            const sync = new SimpleCrossTabSync(config);

            const receivedContext: ContextItem[] = [];
            sync.onContextAdded((context) => {
                receivedContext.push(context);
            });

            const testContext: ContextItem = {
                id: 'ctx-1',
                consultationId: 'consultation-1',
                type: 'CASE_NOTE',
                content: 'Test note',
                source: 'USER',
                isSummary: false,
                isTranscription: false,
                isAiGenerated: false,
                createdAt: '2026-01-29T10:00:00Z',
                updatedAt: '2026-01-29T10:00:00Z',
            };

            sync.broadcastContext(testContext);

            // Should not receive own message
            expect(receivedContext).toHaveLength(0);

            sync.close();
        });
    });

    describe('context updates', () => {
        it('should broadcast and receive context updates', () => {
            const config = {
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            };

            const sync1 = new SimpleCrossTabSync(config);
            const sync2 = new SimpleCrossTabSync(config);

            const receivedUpdates: ContextItem[] = [];
            sync2.onContextUpdated((context) => {
                receivedUpdates.push(context);
            });

            const updatedContext: ContextItem = {
                id: 'ctx-1',
                consultationId: 'consultation-1',
                type: 'CASE_NOTE',
                content: 'Updated note content',
                source: 'USER',
                isSummary: false,
                isTranscription: false,
                isAiGenerated: false,
                createdAt: '2026-01-29T10:00:00Z',
                updatedAt: '2026-01-29T10:05:00Z',
            };

            sync1.broadcastContextUpdate(updatedContext);

            expect(receivedUpdates).toHaveLength(1);
            expect(receivedUpdates[0].content).toBe('Updated note content');

            sync1.close();
            sync2.close();
        });
    });

    describe('listener management', () => {
        it('should support multiple listeners', () => {
            const config = {
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            };

            const sync1 = new SimpleCrossTabSync(config);
            const sync2 = new SimpleCrossTabSync(config);

            const received1: ContextItem[] = [];
            const received2: ContextItem[] = [];

            sync2.onContextAdded((context) => received1.push(context));
            sync2.onContextAdded((context) => received2.push(context));

            const testContext: ContextItem = {
                id: 'ctx-1',
                consultationId: 'consultation-1',
                type: 'CASE_NOTE',
                content: 'Test note',
                source: 'USER',
                isSummary: false,
                isTranscription: false,
                isAiGenerated: false,
                createdAt: '2026-01-29T10:00:00Z',
                updatedAt: '2026-01-29T10:00:00Z',
            };

            sync1.broadcastContext(testContext);

            expect(received1).toHaveLength(1);
            expect(received2).toHaveLength(1);

            sync1.close();
            sync2.close();
        });

        it('should support unsubscribing', () => {
            const config = {
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            };

            const sync1 = new SimpleCrossTabSync(config);
            const sync2 = new SimpleCrossTabSync(config);

            const received: ContextItem[] = [];
            const unsubscribe = sync2.onContextAdded((context) => received.push(context));

            const testContext: ContextItem = {
                id: 'ctx-1',
                consultationId: 'consultation-1',
                type: 'CASE_NOTE',
                content: 'Test note',
                source: 'USER',
                isSummary: false,
                isTranscription: false,
                isAiGenerated: false,
                createdAt: '2026-01-29T10:00:00Z',
                updatedAt: '2026-01-29T10:00:00Z',
            };

            sync1.broadcastContext(testContext);
            expect(received).toHaveLength(1);

            // Unsubscribe
            unsubscribe();

            sync1.broadcastContext(testContext);
            // Should still be 1 because we unsubscribed
            expect(received).toHaveLength(1);

            sync1.close();
            sync2.close();
        });
    });

    describe('close', () => {
        it('should clean up on close', () => {
            const sync = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            });

            expect(sync.isAvailable()).toBe(true);

            sync.close();

            // After close, broadcasting should not throw but do nothing
            const testContext: ContextItem = {
                id: 'ctx-1',
                consultationId: 'consultation-1',
                type: 'CASE_NOTE',
                content: 'Test note',
                source: 'USER',
                isSummary: false,
                isTranscription: false,
                isAiGenerated: false,
                createdAt: '2026-01-29T10:00:00Z',
                updatedAt: '2026-01-29T10:00:00Z',
            };

            expect(() => sync.broadcastContext(testContext)).not.toThrow();
        });
    });

    describe('when BroadcastChannel is not available', () => {
        it('should handle gracefully', () => {
            // Remove BroadcastChannel
            delete (globalThis as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;

            const sync = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            });

            expect(sync.isAvailable()).toBe(false);

            // Should not throw
            expect(() => sync.broadcastContext({} as ContextItem)).not.toThrow();

            sync.close();
        });
    });

    // =========================================================================
    // REFACTOR-10: Message shape validation
    // =========================================================================

    describe('REFACTOR-10: message validation', () => {
        function sendRawMessage(sync: SimpleCrossTabSync, data: unknown) {
            const channel = (sync as any).channel;
            if (channel?.onmessage) {
                channel.onmessage(new MessageEvent('message', { data }));
            }
        }

        it('should ignore messages with missing type field', () => {
            const sync = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            });

            const listener = vi.fn();
            sync.onContextAdded(listener);

            sendRawMessage(sync, { tabId: 'other-tab', data: 'bad', timestamp: Date.now() });

            expect(listener).not.toHaveBeenCalled();
            sync.close();
        });

        it('should ignore messages with non-string type field', () => {
            const sync = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            });

            const listener = vi.fn();
            sync.onContextAdded(listener);

            sendRawMessage(sync, { type: 42, tabId: 'other-tab', data: 'bad', timestamp: Date.now() });

            expect(listener).not.toHaveBeenCalled();
            sync.close();
        });

        it('should ignore messages that are not objects', () => {
            const sync = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
            });

            const listener = vi.fn();
            sync.onContextAdded(listener);

            sendRawMessage(sync, 'just a string');
            sendRawMessage(sync, null);
            sendRawMessage(sync, 42);

            expect(listener).not.toHaveBeenCalled();
            sync.close();
        });
    });

    // =========================================================================
    // SEC-05: Session secret validation
    // =========================================================================

    describe('SEC-05: session secret validation', () => {
        function sendRawMsg(sync: SimpleCrossTabSync, data: unknown) {
            const channel = (sync as any).channel;
            if (channel?.onmessage) {
                channel.onmessage(new MessageEvent('message', { data }));
            }
        }

        it('should reject messages with missing sessionSecret', () => {
            const sync = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
                sessionSecret: 'my-secret',
            });

            const listener = vi.fn();
            sync.onContextAdded(listener);

            sendRawMsg(sync, {
                type: 'context_added',
                tabId: 'other-tab',
                data: { id: 'ctx-1' },
                timestamp: Date.now(),
            });

            expect(listener).not.toHaveBeenCalled();
            sync.close();
        });

        it('should reject messages with wrong sessionSecret', () => {
            const sync = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
                sessionSecret: 'my-secret',
            });

            const listener = vi.fn();
            sync.onContextAdded(listener);

            sendRawMsg(sync, {
                type: 'context_added',
                tabId: 'other-tab',
                data: { id: 'ctx-1' },
                timestamp: Date.now(),
                sessionSecret: 'wrong-secret',
            });

            expect(listener).not.toHaveBeenCalled();
            sync.close();
        });

        it('should accept messages with correct sessionSecret', () => {
            const sync = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
                sessionSecret: 'my-secret',
            });

            const listener = vi.fn();
            sync.onContextAdded(listener);

            sendRawMsg(sync, {
                type: 'context_added',
                tabId: 'other-tab',
                data: { id: 'ctx-1' },
                timestamp: Date.now(),
                sessionSecret: 'my-secret',
            });

            expect(listener).toHaveBeenCalledWith({ id: 'ctx-1' });
            sync.close();
        });

        it('should include sessionSecret in broadcast messages', () => {
            const sync1 = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
                sessionSecret: 'shared-secret',
            });

            const sync2 = new SimpleCrossTabSync({
                patientId: 'patient-123',
                doctorId: 'doctor-456',
                appointmentDate: '2026-01-29',
                sessionSecret: 'shared-secret',
            });

            const listener = vi.fn();
            sync2.onContextAdded(listener);

            sync1.broadcastContext({ id: 'ctx-1' } as ContextItem);

            expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: 'ctx-1' }));

            sync1.close();
            sync2.close();
        });
    });
});
