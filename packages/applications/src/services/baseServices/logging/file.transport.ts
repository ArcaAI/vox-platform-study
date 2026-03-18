import * as path from 'path';
import * as fs from 'fs';

export interface FileTransportOptions {
    logDir: string;
    maxFileSize: string;
    maxFiles: number;
    datePattern: string;
    separateErrorFile: boolean;
}

/**
 * @deprecated Use FileTransport from ./transports/file.transport.ts instead
 * This class is kept for backward compatibility
 */
export class FileTransportManager {
    private logDir: string;
    private maxFileSize: string;
    private maxFiles: number;
    private datePattern: string;
    private separateErrorFile: boolean;

    constructor(options: FileTransportOptions) {
        this.logDir = options.logDir;
        this.maxFileSize = options.maxFileSize;
        this.maxFiles = options.maxFiles;
        this.datePattern = options.datePattern;
        this.separateErrorFile = options.separateErrorFile;

        this.ensureLogDirectory();
    }

    private ensureLogDirectory(): void {
        try {
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }
        } catch (error) {
            // Re-throw with context - caller should handle this
            throw new Error(`Failed to create log directory ${this.logDir}: ${(error as Error).message}`);
        }
    }

    getLogDirectory(): string {
        return this.logDir;
    }

    getCombinedLogPath(): string {
        return path.join(this.logDir, 'combined.log');
    }

    getErrorLogPath(): string {
        return path.join(this.logDir, 'error.log');
    }

    shouldSeparateErrors(): boolean {
        return this.separateErrorFile;
    }

    getMaxFileSize(): string {
        return this.maxFileSize;
    }

    getMaxFiles(): number {
        return this.maxFiles;
    }

    getDatePattern(): string {
        return this.datePattern;
    }

    // Clean up old log files beyond the retention limit
    cleanupOldLogs(): void {
        try {
            this.cleanupOldFiles('combined.log');
            if (this.separateErrorFile) {
                this.cleanupOldFiles('error.log');
            }
        } catch {
            // Silent failure - cleanup is non-critical
        }
    }

    private cleanupOldFiles(baseFileName: string): void {
        try {
            const baseName = path.parse(baseFileName).name;
            const ext = path.parse(baseFileName).ext || '.log';

            const files = fs.readdirSync(this.logDir)
                .filter(file => file.startsWith(baseName) && file.endsWith(ext))
                .map(file => ({
                    name: file,
                    path: path.join(this.logDir, file),
                    stat: fs.statSync(path.join(this.logDir, file))
                }))
                .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

            // Remove old files beyond maxFiles limit
            if (files.length > this.maxFiles) {
                const filesToDelete = files.slice(this.maxFiles);
                filesToDelete.forEach(file => {
                    try {
                        fs.unlinkSync(file.path);
                    } catch {
                        // Silent failure - individual file deletion is non-critical
                    }
                });
            }
        } catch {
            // Silent failure - cleanup is non-critical
        }
    }
}
