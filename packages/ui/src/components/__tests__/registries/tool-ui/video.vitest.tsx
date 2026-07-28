import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Video } from '../../../registries/tool-ui/video';

describe('Video', () => {
  it('renders without crashing', () => {
    const { container } = render(<Video id="1" assetId="asset-1" src="https://example.com/video.mp4" />);
    expect(container.firstChild).toBeTruthy();
  });
});
