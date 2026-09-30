/** TASK-1023 — the two new lifecycle statuses and the CANCELLED download status carry icon + label + a Retry hint. */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MODEL_LIFECYCLE_STATUSES } from '../../api/types';
import type { AiModelDownloadStatus } from '../../api/types';
import { DownloadStatusBadge } from '../download-status-badge';
import { LIFECYCLE_META, LifecycleBadge } from '../lifecycle-badge';

afterEach(() => cleanup());

describe('TASK-1023 lifecycle statuses', () => {
  it('mirrors UNREGISTER_FAILED and DOWNLOAD_CANCELLED', () => {
    expect(MODEL_LIFECYCLE_STATUSES).toContain('UNREGISTER_FAILED');
    expect(MODEL_LIFECYCLE_STATUSES).toContain('DOWNLOAD_CANCELLED');
  });

  it('renders "Unregister failed" as destructive with a Retry hint', () => {
    render(<LifecycleBadge status="UNREGISTER_FAILED" />);
    expect(screen.getByText('Unregister failed')).toBeDefined();
    expect(LIFECYCLE_META.UNREGISTER_FAILED.role).toBe('destructive');
    expect(LIFECYCLE_META.UNREGISTER_FAILED.hint).toMatch(/retry/i);
  });

  it('renders "Download cancelled" as a non-destructive state with a Retry hint', () => {
    render(<LifecycleBadge status="DOWNLOAD_CANCELLED" />);
    expect(screen.getByText('Download cancelled')).toBeDefined();
    expect(LIFECYCLE_META.DOWNLOAD_CANCELLED.role).not.toBe('destructive');
    expect(LIFECYCLE_META.DOWNLOAD_CANCELLED.hint).toMatch(/retry/i);
  });

  it('labels the CANCELLED download status', () => {
    render(<DownloadStatusBadge status={'CANCELLED' satisfies AiModelDownloadStatus} />);
    expect(screen.getByText('Cancelled')).toBeDefined();
  });
});
