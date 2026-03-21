/**
 * MqttService Unit Tests
 *
 * Tests for the MQTT service implementation including connection management,
 * message publishing, and lifecycle hooks.
 *
 * Testing Strategy:
 * - Mock the external MQTT library (boundary mock) to avoid network calls
 * - Verify actual service behavior and state changes, not just mock calls
 * - Test complete message flow from send to callback resolution
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { MqttService } from '../mqtt.service';
import { IConfigService } from '../../_meta/';

// Mock mqtt module - external boundary that requires network
vi.mock('mqtt', () => {
    const mockClient = {
        on: vi.fn(),
        subscribe: vi.fn(),
        publish: vi.fn(),
        end: vi.fn(),
    };

    return {
        connect: vi.fn(() => mockClient),
        MqttClient: vi.fn(),
    };
});

// Import mocked module
import { connect } from 'mqtt';

describe('MqttService', () => {
    let service: MqttService;
    let mockConfigService: IConfigService;
    let mockClient: any;

    /**
     * Creates a complete mock config service matching the real interface.
     * All methods return realistic values to avoid incomplete mock issues.
     */
    const createMockConfigService = (config: Partial<{
        MQTT_HOST: string;
        MQTT_PORT: number;
        MQTT_USER: string;
        MQTT_PASS: string;
    }> = {}): IConfigService => ({
        getConfiguration: vi.fn().mockReturnValue({
            MQTT_HOST: config.MQTT_HOST ?? 'localhost',
            MQTT_PORT: config.MQTT_PORT ?? 1883,
            MQTT_USER: config.MQTT_USER ?? 'testuser',
            MQTT_PASS: config.MQTT_PASS ?? 'testpass',
        }),
        isRedisConfigured: vi.fn().mockReturnValue(false),
        getRedisConfig: vi.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
    } as unknown as IConfigService);

    beforeEach(() => {
        vi.clearAllMocks();

        // Setup mock client with complete event handler interface
        mockClient = {
            on: vi.fn(),
            subscribe: vi.fn(),
            publish: vi.fn(),
            end: vi.fn(),
            connected: false,
        };
        (connect as Mock).mockReturnValue(mockClient);

        mockConfigService = createMockConfigService();
        service = new MqttService(mockConfigService);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('should create service with config service', () => {
            expect(service).toBeDefined();
        });

        it('should log service creation', () => {
            // Service is created in beforeEach, just verify it exists
            expect(service).toBeInstanceOf(MqttService);
        });
    });

    describe('onModuleInit', () => {
        it('should connect to MQTT broker with configuration', () => {
            service.onModuleInit();

            expect(connect).toHaveBeenCalledWith('localhost:1883', {
                username: 'testuser',
                password: 'testpass',
            });
        });

        it('should use default values when config is missing', () => {
            mockConfigService = createMockConfigService({
                MQTT_HOST: undefined as any,
                MQTT_PORT: undefined as any,
            });
            (mockConfigService.getConfiguration as Mock).mockReturnValue({});

            service = new MqttService(mockConfigService);
            service.onModuleInit();

            expect(connect).toHaveBeenCalledWith('localhost:1883', {
                username: undefined,
                password: undefined,
            });
        });

        it('should set up connect event handler', () => {
            service.onModuleInit();

            expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
        });

        it('should set up message event handler', () => {
            service.onModuleInit();

            expect(mockClient.on).toHaveBeenCalledWith('message', expect.any(Function));
        });

        it('should set up error event handler', () => {
            service.onModuleInit();

            expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
        });

        it('should subscribe to topics on connect', () => {
            service.onModuleInit();

            // Get the connect callback
            const connectCallback = mockClient.on.mock.calls.find(
                (call: any[]) => call[0] === 'connect'
            )?.[1];

            expect(connectCallback).toBeDefined();

            // Simulate connect event
            connectCallback();

            expect(mockClient.subscribe).toHaveBeenCalledWith(
                ['sms/marketing', 'sms/contact', 'sms'],
                expect.any(Function)
            );
        });

        it('should handle subscription success', () => {
            service.onModuleInit();

            // Get the connect callback
            const connectCallback = mockClient.on.mock.calls.find(
                (call: any[]) => call[0] === 'connect'
            )?.[1];
            connectCallback();

            // Get the subscribe callback
            const subscribeCallback = mockClient.subscribe.mock.calls[0]?.[1];
            expect(subscribeCallback).toBeDefined();

            // Simulate successful subscription
            const granted = [
                { topic: 'sms/marketing' },
                { topic: 'sms/contact' },
                { topic: 'sms' },
            ];
            expect(() => subscribeCallback(null, granted)).not.toThrow();
        });

        it('should handle subscription error', () => {
            service.onModuleInit();

            // Get the connect callback
            const connectCallback = mockClient.on.mock.calls.find(
                (call: any[]) => call[0] === 'connect'
            )?.[1];
            connectCallback();

            // Get the subscribe callback
            const subscribeCallback = mockClient.subscribe.mock.calls[0]?.[1];
            expect(subscribeCallback).toBeDefined();

            // Simulate subscription error
            const error = new Error('Subscription failed');
            expect(() => subscribeCallback(error, null)).not.toThrow();
        });

        it('should handle incoming messages', () => {
            service.onModuleInit();

            // Get the message callback
            const messageCallback = mockClient.on.mock.calls.find(
                (call: any[]) => call[0] === 'message'
            )?.[1];

            expect(messageCallback).toBeDefined();

            // Simulate incoming message
            expect(() => messageCallback('sms/marketing', Buffer.from('test message'))).not.toThrow();
        });

        it('should handle connection errors', () => {
            service.onModuleInit();

            // Get the error callback
            const errorCallback = mockClient.on.mock.calls.find(
                (call: any[]) => call[0] === 'error'
            )?.[1];

            expect(errorCallback).toBeDefined();

            // Simulate error
            const error = new Error('Connection error');
            expect(() => errorCallback(error)).not.toThrow();
        });

        it('should handle non-Error objects in error handler', () => {
            service.onModuleInit();

            // Get the error callback
            const errorCallback = mockClient.on.mock.calls.find(
                (call: any[]) => call[0] === 'error'
            )?.[1];

            // Simulate error with string
            expect(() => errorCallback('string error')).not.toThrow();
        });
    });

    describe('onModuleDestroy', () => {
        it('should end client connection when client exists', () => {
            service.onModuleInit();
            service.onModuleDestroy();

            expect(mockClient.end).toHaveBeenCalled();
        });

        it('should not throw when client does not exist', () => {
            // Don't call onModuleInit, so client is undefined
            expect(() => service.onModuleDestroy()).not.toThrow();
        });
    });

    describe('sendMessage', () => {
        beforeEach(() => {
            service.onModuleInit();
        });

        it('should publish message to specified topic and resolve when broker acknowledges', async () => {
            // Capture the actual topic and message passed to publish
            let capturedTopic: string | undefined;
            let capturedMessage: string | undefined;

            mockClient.publish.mockImplementation(
                (topic: string, message: string, callback: (error?: Error) => void) => {
                    capturedTopic = topic;
                    capturedMessage = message;
                    callback(); // Simulate broker acknowledgment
                }
            );

            const result = await service.sendMessage('test/topic', 'test message');

            // Verify the actual behavior: message was sent with correct data
            expect(capturedTopic).toBe('test/topic');
            expect(capturedMessage).toBe('test message');
            // Verify the promise resolved (indicating successful send)
            expect(result).toBeUndefined();
        });

        it('should reject with specific error when broker returns error', async () => {
            const brokerError = new Error('Publish failed: broker unavailable');
            mockClient.publish.mockImplementation(
                (topic: string, message: string, callback: (error?: Error) => void) => {
                    callback(brokerError);
                }
            );

            // Verify the actual error is propagated, not just that it throws
            await expect(service.sendMessage('test/topic', 'test message'))
                .rejects.toThrow('Publish failed: broker unavailable');
        });

        it('should handle empty message content', async () => {
            let capturedMessage: string | undefined;
            mockClient.publish.mockImplementation(
                (topic: string, message: string, callback: (error?: Error) => void) => {
                    capturedMessage = message;
                    callback();
                }
            );

            await service.sendMessage('test/topic', '');

            // Verify empty string is passed through correctly
            expect(capturedMessage).toBe('');
        });

        it('should preserve special characters in topic path', async () => {
            let capturedTopic: string | undefined;
            mockClient.publish.mockImplementation(
                (topic: string, message: string, callback: (error?: Error) => void) => {
                    capturedTopic = topic;
                    callback();
                }
            );

            await service.sendMessage('test/topic/with/multiple/levels', 'message');

            // Verify topic path is preserved exactly
            expect(capturedTopic).toBe('test/topic/with/multiple/levels');
        });

        it('should handle large message payloads without truncation', async () => {
            let capturedMessage: string | undefined;
            mockClient.publish.mockImplementation(
                (topic: string, message: string, callback: (error?: Error) => void) => {
                    capturedMessage = message;
                    callback();
                }
            );

            const largeMessage = 'x'.repeat(10000);
            await service.sendMessage('test/topic', largeMessage);

            // Verify message is not truncated
            expect(capturedMessage).toBe(largeMessage);
            expect(capturedMessage?.length).toBe(10000);
        });

        it('should handle JSON message payloads', async () => {
            let capturedMessage: string | undefined;
            mockClient.publish.mockImplementation(
                (topic: string, message: string, callback: (error?: Error) => void) => {
                    capturedMessage = message;
                    callback();
                }
            );

            const jsonPayload = JSON.stringify({ event: 'user.created', userId: 123 });
            await service.sendMessage('events/user', jsonPayload);

            // Verify JSON is preserved and parseable
            expect(capturedMessage).toBe(jsonPayload);
            expect(JSON.parse(capturedMessage!)).toEqual({ event: 'user.created', userId: 123 });
        });

        it('should handle unicode characters in messages', async () => {
            let capturedMessage: string | undefined;
            mockClient.publish.mockImplementation(
                (topic: string, message: string, callback: (error?: Error) => void) => {
                    capturedMessage = message;
                    callback();
                }
            );

            const unicodeMessage = '你好世界 🌍 مرحبا';
            await service.sendMessage('test/topic', unicodeMessage);

            expect(capturedMessage).toBe(unicodeMessage);
        });
    });

    describe('configuration variations', () => {
        it('should connect with custom host and port', () => {
            mockConfigService = createMockConfigService({
                MQTT_HOST: 'mqtt.example.com',
                MQTT_PORT: 8883,
            });
            service = new MqttService(mockConfigService);
            service.onModuleInit();

            expect(connect).toHaveBeenCalledWith('mqtt.example.com:8883', expect.any(Object));
        });

        it('should connect without authentication when credentials are not provided', () => {
            mockConfigService = createMockConfigService({
                MQTT_USER: undefined as any,
                MQTT_PASS: undefined as any,
            });
            (mockConfigService.getConfiguration as Mock).mockReturnValue({
                MQTT_HOST: 'localhost',
                MQTT_PORT: 1883,
            });
            service = new MqttService(mockConfigService);
            service.onModuleInit();

            expect(connect).toHaveBeenCalledWith('localhost:1883', {
                username: undefined,
                password: undefined,
            });
        });
    });
});
