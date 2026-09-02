/** `DownloadStatusBadge`: one distinct label per `AiModelDownloadStatus` — never color alone. */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiModelDownloadStatus } from '../../api/types';
import { DownloadStatusBadge } from '../download-status-badge';

afterEach(() => cleanup());

const CASES: [AiModelDownloadStatus, string][] = [
  ['NOT_DOWNLOADED', 'Not downloaded'],
  ['DOWNLOADING', 'Downloading'],
  ['DOWNLOADED', 'Downloaded'],
  ['DOWNLOAD_FAILED', 'Download failed'],
];

describe('DownloadStatusBadge', () => {
  it.each(CASES)('renders the label for %s', (status, label) => {
    render(<DownloadStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeDefined();
  });
});
