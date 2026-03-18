import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { log, createLogger, LogLevel, Logger } from "..";

describe("@arcaai/logger", () => {
    describe("legacy log function", () => {
        it("should be callable without throwing", () => {
            // log function should not throw
            expect(() => log("hello")).not.toThrow();
        });
    });

    describe("logger class", () => {
        it("creates a custom logger with console transport", () => {
            const logger = createLogger({ service: 'test-service' });
            expect(logger).toBeInstanceOf(Logger);
            // Should not throw when logging
            expect(() => logger.info("test message")).not.toThrow();
        });

        it("logs at different levels without throwing", () => {
            const logger = createLogger({ level: LogLevel.DEBUG });

            expect(() => logger.error("error message")).not.toThrow();
            expect(() => logger.warn("warning message")).not.toThrow();
            expect(() => logger.info("info message")).not.toThrow();
            expect(() => logger.debug("debug message")).not.toThrow();
            expect(() => logger.verbose("verbose message")).not.toThrow();
        });

        it("accepts metadata", () => {
            const logger = createLogger();
            const meta = { userId: '123', action: 'login' };

            expect(() => logger.info("user action", meta)).not.toThrow();
        });

        it("creates logger with S3 config options", () => {
            // Test that S3 config can be passed without error
            const s3Config = {
                enabled: true,
                bucket: 'test-bucket',
                accessKeyId: 'test-key',
                secretAccessKey: 'test-secret',
                region: 'us-east-1'
            };

            const logger = createLogger({
                service: 's3-test',
                transports: {
                    console: true,
                    s3: s3Config
                }
            });

            expect(logger).toBeInstanceOf(Logger);
            expect(() => logger.info("test with s3 config")).not.toThrow();
        });

        it("creates logger with MinIO config options", () => {
            const minioConfig = {
                enabled: true,
                bucket: 'minio-bucket',
                endpoint: 'http://minio:9000',
                forcePathStyle: true,
                accessKeyId: 'minio-key',
                secretAccessKey: 'minio-secret'
            };

            const logger = createLogger({
                transports: {
                    console: true,
                    s3: minioConfig
                }
            });

            expect(logger).toBeInstanceOf(Logger);
            expect(() => logger.info("test with minio config")).not.toThrow();
        });

        it("creates logger without console transport", () => {
            const logger = createLogger({
                transports: {
                    console: false
                }
            });

            expect(logger).toBeInstanceOf(Logger);
        });

        it("supports log method with level parameter", () => {
            const logger = createLogger();
            expect(() => logger.log(LogLevel.INFO, "test log method")).not.toThrow();
        });
    });
});