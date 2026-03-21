/**
 * Environment utility functions for the logging service
 */

export function getEnvString(key: string, defaultValue?: string): string | undefined {
    const value = process.env[key];
    return value !== undefined ? value : defaultValue;
}

export function getEnvBoolean(key: string, defaultValue: boolean = false): boolean {
    const value = process.env[key];
    if (value === undefined) return defaultValue;

    return value.toLowerCase() === 'true' || value === '1';
}

export function getEnvNumber(key: string, defaultValue?: number): number | undefined {
    const value = process.env[key];
    if (value === undefined) return defaultValue;

    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
}

export function isDevelopment(): boolean {
    return process.env.NODE_ENV === 'development';
}

export function isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
}
