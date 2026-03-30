import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  AudioPlayer,
  AudioPlayerControlBar,
  AudioPlayerDurationDisplay,
  AudioPlayerElement,
  AudioPlayerMuteButton,
  AudioPlayerPlayButton,
  AudioPlayerSeekBackwardButton,
  AudioPlayerSeekForwardButton,
  AudioPlayerTimeDisplay,
  AudioPlayerTimeRange,
  AudioPlayerVolumeRange,
} from '../../../registries/ai-elements/audio-player';

const meta = {
  title: 'Registries/AiElements/AudioPlayer',
  component: AudioPlayer,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof AudioPlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <AudioPlayer className="w-[400px]">
      <AudioPlayerElement src="https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3" />
      <AudioPlayerControlBar>
        <AudioPlayerSeekBackwardButton />
        <AudioPlayerPlayButton />
        <AudioPlayerSeekForwardButton />
        <AudioPlayerTimeDisplay />
        <AudioPlayerTimeRange />
        <AudioPlayerDurationDisplay />
        <AudioPlayerMuteButton />
        <AudioPlayerVolumeRange />
      </AudioPlayerControlBar>
    </AudioPlayer>
  ),
};
