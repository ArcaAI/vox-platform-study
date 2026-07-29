/**
 * @arcaai/stt - MessageHandler Tests
 *
 * Comprehensive tests for the WebSocket message handler.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageHandler, type MessageHandlerCallbacks } from '../websocket/MessageHandler.js';
import type { WSInboundMessage } from '../types/index.js';

describe('MessageHandler', () => {
  let handler: MessageHandler;
  let callbacks: Required<MessageHandlerCallbacks>;

  beforeEach(() => {
    handler = new MessageHandler();

    // Create mock callbacks
    callbacks = {
      onConnected: vi.fn(),
      onTranscription: vi.fn(),
      onKeepAlive: vi.fn(),
      onStopped: vi.fn(),
      onError: vi.fn(),
    };

    handler.setCallbacks(callbacks);
  });

  describe('setCallbacks', () => {
    it('should set callback handlers', () => {
      const newHandler = new MessageHandler();
      const onTranscription = vi.fn();

      newHandler.setCallbacks({ onTranscription });

      // Trigger a transcription message
      const message: WSInboundMessage = {
        type: 'transcription',
        text: 'test',
        is_final: true,
        speaker_id: 'speaker1',
        session_id: 'session1',
        language: 'en',
      };

      newHandler.handleMessage(message);

      expect(onTranscription).toHaveBeenCalled();
    });

    it('should merge callbacks without overwriting existing ones', () => {
      const onConnected = vi.fn();
      const onError = vi.fn();

      handler.setCallbacks({ onConnected });
      handler.setCallbacks({ onError });

      // Both callbacks should work
      const connectedMessage: WSInboundMessage = {
        type: 'connected',
        session_id: 'session1',
        audio_config: {},
        timestamp: new Date().toISOString(),
      };

      const errorMessage: WSInboundMessage = {
        type: 'error',
        message: 'test error',
        session_id: 'session1',
      };

      handler.handleMessage(connectedMessage);
      handler.handleMessage(errorMessage);

      expect(onConnected).toHaveBeenCalled();
      expect(onError).toHaveBeenCalled();
    });
  });

  describe('handleMessage - connected', () => {
    it('should call onConnected with session ID and audio config', () => {
      const message: WSInboundMessage = {
        type: 'connected',
        session_id: 'session-123',
        audio_config: { sample_rate: 16000, channels: 1 },
        timestamp: '2024-01-01T00:00:00Z',
      };

      handler.handleMessage(message);

      expect(callbacks.onConnected).toHaveBeenCalledWith('session-123', {
        sample_rate: 16000,
        channels: 1,
      });
      expect(callbacks.onConnected).toHaveBeenCalledTimes(1);
    });

    it('should handle empty audio config', () => {
      const message: WSInboundMessage = {
        type: 'connected',
        session_id: 'session-456',
        audio_config: {},
        timestamp: '2024-01-01T00:00:00Z',
      };

      handler.handleMessage(message);

      expect(callbacks.onConnected).toHaveBeenCalledWith('session-456', {});
    });
  });

  describe('handleMessage - transcription', () => {
    it('should call onTranscription with properly formatted result', () => {
      const message: WSInboundMessage = {
        type: 'transcription',
        text: 'Hello, world!',
        is_final: true,
        speaker_id: 'speaker-1',
        session_id: 'session-123',
        language: 'en-US',
      };

      handler.handleMessage(message);

      expect(callbacks.onTranscription).toHaveBeenCalledWith({
        text: 'Hello, world!',
        isFinal: true,
        language: 'en-US',
        speakerId: 'speaker-1',
      });
    });

    it('should handle partial transcription', () => {
      const message: WSInboundMessage = {
        type: 'transcription',
        text: 'Hello, wor',
        is_final: false,
        speaker_id: 'speaker-2',
        session_id: 'session-123',
        language: 'en',
      };

      handler.handleMessage(message);

      expect(callbacks.onTranscription).toHaveBeenCalledWith({
        text: 'Hello, wor',
        isFinal: false,
        language: 'en',
        speakerId: 'speaker-2',
      });
    });

    it('should handle empty text transcription', () => {
      const message: WSInboundMessage = {
        type: 'transcription',
        text: '',
        is_final: true,
        speaker_id: '',
        session_id: 'session-123',
        language: 'en',
      };

      handler.handleMessage(message);

      expect(callbacks.onTranscription).toHaveBeenCalledWith({
        text: '',
        isFinal: true,
        language: 'en',
        speakerId: '',
      });
    });
  });

  describe('handleMessage - keepalive', () => {
    it('should call onKeepAlive for keepalive message', () => {
      const message: WSInboundMessage = {
        type: 'keepalive',
        session_id: 'session-123',
        timestamp: '2024-01-01T00:00:00Z',
      };

      handler.handleMessage(message);

      expect(callbacks.onKeepAlive).toHaveBeenCalledTimes(1);
    });

    it('should call onKeepAlive for pong message', () => {
      const message: WSInboundMessage = {
        type: 'pong',
        session_id: 'session-123',
        timestamp: '2024-01-01T00:00:00Z',
      };

      handler.handleMessage(message);

      expect(callbacks.onKeepAlive).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleMessage - stopped', () => {
    it('should call onStopped when session is stopped', () => {
      const message: WSInboundMessage = {
        type: 'stopped',
        session_id: 'session-123',
        timestamp: '2024-01-01T00:00:00Z',
      };

      handler.handleMessage(message);

      expect(callbacks.onStopped).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleMessage - error', () => {
    it('should call onError with error message', () => {
      const message: WSInboundMessage = {
        type: 'error',
        message: 'Connection timeout',
        session_id: 'session-123',
      };

      handler.handleMessage(message);

      expect(callbacks.onError).toHaveBeenCalledWith('Connection timeout');
      expect(callbacks.onError).toHaveBeenCalledTimes(1);
    });

    it('should handle empty error message', () => {
      const message: WSInboundMessage = {
        type: 'error',
        message: '',
        session_id: 'session-123',
      };

      handler.handleMessage(message);

      expect(callbacks.onError).toHaveBeenCalledWith('');
    });
  });

  describe('handleMessage - unknown type', () => {
    it('should ignore unknown message types', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // @ts-expect-error - Testing unknown message type
      const message: WSInboundMessage = {
        type: 'unknown_type',
        data: 'test',
      };

      handler.handleMessage(message);

      expect(consoleSpy).toHaveBeenCalledWith('Unknown STT WebSocket message type:', 'unknown_type');
      expect(callbacks.onConnected).not.toHaveBeenCalled();
      expect(callbacks.onTranscription).not.toHaveBeenCalled();
      expect(callbacks.onKeepAlive).not.toHaveBeenCalled();
      expect(callbacks.onStopped).not.toHaveBeenCalled();
      expect(callbacks.onError).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('parseMessage', () => {
    it('should parse valid JSON message', () => {
      const jsonString = JSON.stringify({
        type: 'transcription',
        text: 'Hello',
        is_final: true,
        speaker_id: 'speaker1',
        session_id: 'session1',
        language: 'en',
      });

      const result = handler.parseMessage(jsonString);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('transcription');
      expect((result as Extract<WSInboundMessage, { type: 'transcription' }>).text).toBe('Hello');
    });

    it('should return null for invalid JSON', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = handler.parseMessage('invalid json {');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should return null for empty string', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = handler.parseMessage('');

      expect(result).toBeNull();

      consoleSpy.mockRestore();
    });

    it('should handle complex nested structures', () => {
      const message = {
        type: 'connected',
        session_id: 'session-123',
        audio_config: {
          sample_rate: 16000,
          channels: 1,
          format: 'pcm',
          nested: { deep: { value: true } },
        },
        timestamp: '2024-01-01T00:00:00Z',
      };

      const result = handler.parseMessage(JSON.stringify(message));

      expect(result).not.toBeNull();
      expect((result as Extract<WSInboundMessage, { type: 'connected' }>).audio_config).toEqual(message.audio_config);
    });
  });

  describe('handleRawMessage', () => {
    it('should parse and handle valid message', () => {
      const jsonString = JSON.stringify({
        type: 'transcription',
        text: 'Test transcription',
        is_final: true,
        speaker_id: 'speaker1',
        session_id: 'session1',
        language: 'en',
      });

      handler.handleRawMessage(jsonString);

      expect(callbacks.onTranscription).toHaveBeenCalledWith({
        text: 'Test transcription',
        isFinal: true,
        language: 'en',
        speakerId: 'speaker1',
      });
    });

    it('should not call any callback for invalid JSON', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      handler.handleRawMessage('not valid json');

      expect(callbacks.onConnected).not.toHaveBeenCalled();
      expect(callbacks.onTranscription).not.toHaveBeenCalled();
      expect(callbacks.onKeepAlive).not.toHaveBeenCalled();
      expect(callbacks.onStopped).not.toHaveBeenCalled();
      expect(callbacks.onError).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should handle multiple raw messages', () => {
      const messages = [
        { type: 'connected', session_id: 's1', audio_config: {}, timestamp: '2024-01-01T00:00:00Z' },
        { type: 'transcription', text: 'Hello', is_final: false, speaker_id: 'sp1', session_id: 's1', language: 'en' },
        { type: 'transcription', text: 'Hello world', is_final: true, speaker_id: 'sp1', session_id: 's1', language: 'en' },
        { type: 'keepalive', session_id: 's1', timestamp: '2024-01-01T00:00:01Z' },
      ];

      for (const msg of messages) {
        handler.handleRawMessage(JSON.stringify(msg));
      }

      expect(callbacks.onConnected).toHaveBeenCalledTimes(1);
      expect(callbacks.onTranscription).toHaveBeenCalledTimes(2);
      expect(callbacks.onKeepAlive).toHaveBeenCalledTimes(1);
    });
  });

  describe('callback absence handling', () => {
    it('should not throw when callbacks are not set', () => {
      const emptyHandler = new MessageHandler();

      const messages: WSInboundMessage[] = [
        { type: 'connected', session_id: 's1', audio_config: {}, timestamp: '2024-01-01T00:00:00Z' },
        { type: 'transcription', text: 'Test', is_final: true, speaker_id: 'sp1', session_id: 's1', language: 'en' },
        { type: 'keepalive', session_id: 's1', timestamp: '2024-01-01T00:00:00Z' },
        { type: 'stopped', session_id: 's1', timestamp: '2024-01-01T00:00:00Z' },
        { type: 'error', message: 'Error', session_id: 's1' },
      ];

      // Should not throw
      for (const msg of messages) {
        expect(() => emptyHandler.handleMessage(msg)).not.toThrow();
      }
    });
  });
});
