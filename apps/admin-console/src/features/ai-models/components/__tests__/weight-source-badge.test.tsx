/**
 * `weightSourceMode` + `WeightSourceBadge`: which of mount / S3 URI / hub id /
 * none a model's `sourceUri`/`localPath` currently resolve to. `localPath` has
 * the HIGHEST precedence in every service resolver, so it must win the chip
 * even when a (now-superseded) `sourceUri` is still set.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WeightSourceBadge, weightSourceMode } from '../weight-source-badge';

afterEach(() => cleanup());

describe('weightSourceMode', () => {
  it('is "mount" whenever localPath is set, regardless of sourceUri', () => {
    expect(weightSourceMode({ localPath: '/mnt/models-bucket/whisper/v1/', sourceUri: 's3://hope-models/whisper/v1/' })).toBe('mount');
    expect(weightSourceMode({ localPath: '/mnt/models-bucket/whisper/v1/', sourceUri: '' })).toBe('mount');
  });

  it('is "s3-uri" for an s3:// sourceUri with no localPath', () => {
    expect(weightSourceMode({ localPath: null, sourceUri: 's3://hope-models/whisper/v1/' })).toBe('s3-uri');
    expect(weightSourceMode({ localPath: '', sourceUri: 'S3://hope-models/whisper/v1/' })).toBe('s3-uri');
  });

  it('is "hub-id" for any other non-empty sourceUri', () => {
    expect(weightSourceMode({ localPath: null, sourceUri: 'openai/whisper-large-v4' })).toBe('hub-id');
  });

  it('is "none" when neither field is set', () => {
    expect(weightSourceMode({ localPath: null, sourceUri: '' })).toBe('none');
    expect(weightSourceMode({ localPath: '   ', sourceUri: '   ' })).toBe('none');
  });
});

describe('WeightSourceBadge', () => {
  it('renders a distinct label per mode — never color alone', () => {
    const { rerender } = render(<WeightSourceBadge model={{ localPath: '/mnt/x', sourceUri: '' }} />);
    expect(screen.getByText('Mounted')).toBeDefined();

    rerender(<WeightSourceBadge model={{ localPath: null, sourceUri: 's3://hope-models/x/v/' }} />);
    expect(screen.getByText('S3 URI')).toBeDefined();

    rerender(<WeightSourceBadge model={{ localPath: null, sourceUri: 'openai/whisper-large-v4' }} />);
    expect(screen.getByText('Hub ID')).toBeDefined();

    rerender(<WeightSourceBadge model={{ localPath: null, sourceUri: '' }} />);
    expect(screen.getByText('No source')).toBeDefined();
  });
});
