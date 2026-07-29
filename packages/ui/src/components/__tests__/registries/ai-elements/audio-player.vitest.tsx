import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AudioPlayer, AudioPlayerControlBar, AudioPlayerPlayButton } from '../../../registries/ai-elements/audio-player';

describe('AudioPlayer', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <AudioPlayer>
        <AudioPlayerControlBar>
          <AudioPlayerPlayButton />
        </AudioPlayerControlBar>
      </AudioPlayer>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
