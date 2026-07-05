import { describe, expect, it } from 'vitest';
import { formatBytes, formatDateTime, formatNumber, formatRelativeTime } from '../index';

describe('formatNumber', () => {
    it('groups thousands', () => {
        expect(formatNumber(1284)).toBe('1,284');
        expect(formatNumber(0)).toBe('0');
    });

    it('renders an em-dash for nullish values', () => {
        expect(formatNumber(null)).toBe('\u2014');
        expect(formatNumber(undefined)).toBe('\u2014');
    });
});

describe('formatBytes', () => {
    it('scales binary units with one decimal above KB', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1024)).toBe('1 KB');
        expect(formatBytes(612 * 1024 ** 3)).toBe('612 GB');
        expect(formatBytes(1.5 * 1024 ** 4)).toBe('1.5 TB');
    });

    it('renders an em-dash for nullish values', () => {
        expect(formatBytes(null)).toBe('\u2014');
    });
});

describe('formatRelativeTime', () => {
    const now = new Date('2026-07-05T12:00:00Z');

    it('describes recent instants relative to now', () => {
        expect(formatRelativeTime('2026-07-05T11:59:40Z', now)).toBe('just now');
        expect(formatRelativeTime('2026-07-05T11:55:00Z', now)).toBe('5 min ago');
        expect(formatRelativeTime('2026-07-05T10:00:00Z', now)).toBe('2 h ago');
    });

    it('falls back to an absolute date beyond a week', () => {
        expect(formatRelativeTime('2026-06-01T12:00:00Z', now)).toBe(formatDateTime('2026-06-01T12:00:00Z', 'date'));
    });

    it('renders an em-dash for nullish or invalid input', () => {
        expect(formatRelativeTime(null, now)).toBe('\u2014');
        expect(formatRelativeTime('not-a-date', now)).toBe('\u2014');
    });
});

describe('formatDateTime', () => {
    it('renders an em-dash for nullish input', () => {
        expect(formatDateTime(null)).toBe('\u2014');
    });

    it('renders date-only and date-time variants', () => {
        const iso = '2026-03-02T09:30:00Z';
        expect(formatDateTime(iso, 'date')).toMatch(/2026/);
        expect(formatDateTime(iso)).toMatch(/\d{2}:\d{2}/);
    });
});
