/**
 * Date and time utility functions
 */

import type { Timestamp } from '@arcaai/types';

/**
 * Input accepted by the date formatting helpers.
 *
 * `Timestamp` is an ISO 8601 string, but these helpers parse via `new Date(...)`
 * and have always accepted epoch milliseconds too. Widening only the parameters
 * keeps `Timestamp` itself strict for data models (`createdAt`, `dueDate`, ...).
 */
export type DateInput = Timestamp | number;

/**
 * Format duration in seconds to human-readable string (e.g., "1h 23m 45s")
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return '0s';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Format timestamp to locale date string
 */
export function formatDate(timestamp: DateInput, locale = 'en-US'): string {
  return new Date(timestamp).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Format timestamp to locale time string
 */
export function formatTime(timestamp: DateInput, locale = 'en-US'): string {
  return new Date(timestamp).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format timestamp to locale date and time string
 */
export function formatDateTime(timestamp: DateInput, locale = 'en-US'): string {
  return new Date(timestamp).toLocaleString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Get relative time string (e.g., "2 hours ago", "in 3 days")
 */
export function getRelativeTime(timestamp: DateInput, locale = 'en-US'): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (Math.abs(diffDay) >= 1) return rtf.format(diffDay, 'day');
  if (Math.abs(diffHour) >= 1) return rtf.format(diffHour, 'hour');
  if (Math.abs(diffMin) >= 1) return rtf.format(diffMin, 'minute');
  return rtf.format(diffSec, 'second');
}

/**
 * Check if timestamp is today
 */
export function isToday(timestamp: DateInput): boolean {
  const date = new Date(timestamp);
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

/**
 * Get ISO 8601 timestamp string
 */
export function now(): Timestamp {
  return new Date().toISOString();
}

