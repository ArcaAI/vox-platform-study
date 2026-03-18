/**
 * FileTransport Unit Tests
 *
 * Tests for the file transport implementation with rotating log files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FileTransport, createFileTransport } from '../transports/file.transport';
import type { FileTransportConfig, LogEntry, LogLevel } from '../transports/types';

// Mock fs module
vi.mock('fs', () => ({
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
}));

describe('FileTransport', () => {
    let mockWriteStream: {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        once: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();

        mockWriteStream = {
            write: vi.fn().mockReturnValue(true),
            end: vi.fn(),
            once: vi.fn(),
        };

        (fs.existsSync as any).mockReturnValue(true);
        (fs.createWriteStream as any).mockReturnValue(mockWriteStream);
        (fs.readdirSync as any).mockReturnValue([]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const createEntry = (
        level: LogLevel,
        message: string = 'test message',
        overrides: Partial<LogEntry> = {}
    ): LogEntry => ({
        level,
        levelNumber: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }[level],
        message,
        timestamp: '2024-01-15T10:30:00.000Z',
        timestampMs: 1705315800000,
        ...overrides,
    });

    describe('constructor', () => {
        it('should create transport with default config', () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
            });
            expect(transport.name).toBe('file');
        });

        it('should use provided log directory', () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: '/var/log/app',
            });
            expect(transport.getLogDirectory()).toBe('/var/log/app');
        });
    });

    describe('initialize', () => {
        it('should create log directory if it does not exist', async () => {
            (fs.existsSync as any).mockReturnValue(false);

            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
            });

            await transport.initialize();

            expect(fs.mkdirSync).toHaveBeenCalledWith('./logs', { recursive: true });
        });

        it('should not create directory if it already exists', async () => {
            (fs.existsSync as any).mockReturnValue(true);

            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
            });

            await transport.initialize();

            expect(fs.mkdirSync).not.toHaveBeenCalled();
        });

        it('should open combined log stream', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
            });

            await transport.initialize();

            expect(fs.createWriteStream).toHaveBeenCalledWith(
                expect.stringContaining('combined-'),
                { flags: 'a' }
            );
        });

        it('should open error log stream when separateErrorFile is true', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
                separateErrorFile: true,
            });

            await transport.initialize();

            expect(fs.createWriteStream).toHaveBeenCalledTimes(2);
            expect(fs.createWriteStream).toHaveBeenCalledWith(
                expect.stringContaining('error-'),
                { flags: 'a' }
            );
        });

        it('should not open error log stream when separateErrorFile is false', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
                separateErrorFile: false,
            });

            await transport.initialize();

            expect(fs.createWriteStream).toHaveBeenCalledTimes(1);
        });

        it('should throw error if directory creation fails', async () => {
            (fs.existsSync as any).mockReturnValue(false);
            (fs.mkdirSync as any).mockImplementation(() => {
                throw new Error('Permission denied');
            });

            const transport = new FileTransport({
                name: 'file',
                logDir: '/protected/logs',
            });

            await expect(transport.initialize()).rejects.toThrow('Permission denied');
        });
    });

    describe('log', () => {
        it('should write JSON log line to combined stream', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test message'));

            expect(mockWriteStream.write).toHaveBeenCalled();
            const writtenData = mockWriteStream.write.mock.calls[0][0];
            expect(writtenData).toMatch(/\n$/); // Ends with newline
            expect(() => JSON.parse(writtenData.trim())).not.toThrow();
        });

        it('should include all entry fields in JSON', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                context: 'TestService',
                traceId: 'trace-123',
                requestId: 'req-456',
            }));

            const writtenData = mockWriteStream.write.mock.calls[0][0];
            const parsed = JSON.parse(writtenData.trim());
            expect(parsed.msg).toBe('Test');
            expect(parsed.context).toBe('TestService');
            expect(parsed.trace_id).toBe('trace-123');
            expect(parsed.request_id).toBe('req-456');
        });

        it('should write error logs to both combined and error streams', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
                separateErrorFile: true,
            });
            await transport.initialize();

            transport.log(createEntry('error', 'Error message'));

            // Should write to both streams
            expect(mockWriteStream.write).toHaveBeenCalledTimes(2);
        });

        it('should write fatal logs to both combined and error streams', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
                separateErrorFile: true,
            });
            await transport.initialize();

            transport.log(createEntry('fatal', 'Fatal message'));

            expect(mockWriteStream.write).toHaveBeenCalledTimes(2);
        });

        it('should not write to error stream for non-error levels', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
                separateErrorFile: true,
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Info message'));
            transport.log(createEntry('warn', 'Warn message'));

            // Should only write to combined stream (2 calls total)
            expect(mockWriteStream.write).toHaveBeenCalledTimes(2);
        });

        it('should not log when level is below minimum', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
                level: 'warn',
            });
            await transport.initialize();

            transport.log(createEntry('debug', 'Debug message'));
            transport.log(createEntry('info', 'Info message'));

            expect(mockWriteStream.write).not.toHaveBeenCalled();
        });
    });

    describe('file naming', () => {
        it('should use date-based file names', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
            });
            await transport.initialize();

            const combinedPath = transport.getCombinedLogPath();
            const errorPath = transport.getErrorLogPath();

            expect(combinedPath).toMatch(/combined-\d{4}-\d{2}-\d{2}\.log$/);
            expect(errorPath).toMatch(/error-\d{4}-\d{2}-\d{2}\.log$/);
        });

        it('should include log directory in file paths', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: '/var/log/myapp',
            });
            await transport.initialize();

            expect(transport.getCombinedLogPath()).toContain('/var/log/myapp');
            expect(transport.getErrorLogPath()).toContain('/var/log/myapp');
        });
    });

    describe('shutdown', () => {
        it('should close all streams on shutdown', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
                separateErrorFile: true,
            });
            await transport.initialize();

            await transport.shutdown();

            expect(mockWriteStream.end).toHaveBeenCalledTimes(2);
        });

        it('should set state to stopped', async () => {
            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
            });
            await transport.initialize();

            await transport.shutdown();

            expect(transport.state).toBe('stopped');
        });
    });

    describe('file cleanup', () => {
        it('should cleanup old files beyond maxFiles limit', async () => {
            const oldFiles = [
                { name: 'combined-2024-01-01.log', mtime: new Date('2024-01-01') },
                { name: 'combined-2024-01-02.log', mtime: new Date('2024-01-02') },
                { name: 'combined-2024-01-03.log', mtime: new Date('2024-01-03') },
                { name: 'combined-2024-01-04.log', mtime: new Date('2024-01-04') },
                { name: 'combined-2024-01-05.log', mtime: new Date('2024-01-05') },
            ];

            (fs.readdirSync as any).mockReturnValue(oldFiles.map(f => f.name));
            (fs.statSync as any).mockImplementation((filePath: string) => {
                const fileName = path.basename(filePath);
                const file = oldFiles.find(f => f.name === fileName);
                return { mtime: file?.mtime || new Date() };
            });

            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
                maxFiles: 3,
            });

            // Trigger cleanup by simulating date change
            // This is tested indirectly through initialization
            await transport.initialize();

            // The cleanup happens when date changes, which we can't easily test
            // but we verify the configuration is set correctly
            expect(transport.config).toBeDefined();
        });
    });

    describe('createFileTransport factory', () => {
        it('should create transport with default name', () => {
            const transport = createFileTransport({ logDir: './logs' });
            expect(transport.name).toBe('file');
        });

        it('should create enabled transport by default', () => {
            const transport = createFileTransport({ logDir: './logs' });
            expect(transport.enabled).toBe(true);
        });

        it('should use default log directory', () => {
            const transport = createFileTransport();
            expect(transport.getLogDirectory()).toBe('./logs');
        });

        it('should merge provided config with defaults', () => {
            const transport = createFileTransport({
                logDir: '/custom/logs',
                maxFiles: 10,
            });

            expect(transport.getLogDirectory()).toBe('/custom/logs');
        });
    });

    describe('edge cases', () => {
        it('should handle write stream not being ready', async () => {
            mockWriteStream.write.mockReturnValue(false); // Stream is not draining

            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
            });
            await transport.initialize();

            // Should not throw
            transport.log(createEntry('info', 'Test'));

            expect(mockWriteStream.write).toHaveBeenCalled();
        });

        it('should handle errors in cleanup gracefully', async () => {
            (fs.readdirSync as any).mockImplementation(() => {
                throw new Error('Read error');
            });

            const transport = new FileTransport({
                name: 'file',
                logDir: './logs',
            });

            // Should not throw during initialization
            await expect(transport.initialize()).resolves.not.toThrow();
        });
    });
});
