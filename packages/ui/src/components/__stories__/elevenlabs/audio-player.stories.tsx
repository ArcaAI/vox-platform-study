import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  AudioPlayerProvider,
  AudioPlayerButton,
  AudioPlayerProgress,
  AudioPlayerTime,
  AudioPlayerDuration,
  AudioPlayerSpeed,
  AudioPlayerSpeedButtonGroup,
  exampleTracks,
} from '../../elevenlabs/audio-player';

const meta: Meta<typeof AudioPlayerProvider> = {
  title: 'ElevenLabs/AudioPlayer',
  component: AudioPlayerProvider,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof AudioPlayerProvider>;

export const Default: Story = {
  render: () => (
    <AudioPlayerProvider>
      <div className="flex w-[400px] items-center gap-3">
        <AudioPlayerButton item={{ id: exampleTracks[0].id, src: exampleTracks[0].url }} variant="outline" size="icon" />
        <AudioPlayerTime />
        <AudioPlayerProgress className="flex-1" />
        <AudioPlayerDuration />
      </div>
    </AudioPlayerProvider>
  ),
};

export const WithSpeedControl: Story = {
  render: () => (
    <AudioPlayerProvider>
      <div className="flex w-[500px] items-center gap-3">
        <AudioPlayerButton item={{ id: exampleTracks[0].id, src: exampleTracks[0].url }} variant="outline" size="icon" />
        <AudioPlayerTime />
        <AudioPlayerProgress className="flex-1" />
        <AudioPlayerDuration />
        <AudioPlayerSpeed />
      </div>
    </AudioPlayerProvider>
  ),
};

export const SpeedButtonGroup: Story = {
  render: () => (
    <AudioPlayerProvider>
      <div className="flex w-[500px] flex-col gap-3">
        <div className="flex items-center gap-3">
          <AudioPlayerButton item={{ id: exampleTracks[0].id, src: exampleTracks[0].url }} variant="outline" size="icon" />
          <AudioPlayerTime />
          <AudioPlayerProgress className="flex-1" />
          <AudioPlayerDuration />
        </div>
        <AudioPlayerSpeedButtonGroup />
      </div>
    </AudioPlayerProvider>
  ),
};

export const MultipleTracksPlaylist: Story = {
  render: () => (
    <AudioPlayerProvider>
      <div className="w-[400px] space-y-2">
        {exampleTracks.slice(0, 4).map((track) => (
          <div key={track.id} className="flex items-center gap-3 rounded-lg border p-2">
            <AudioPlayerButton item={{ id: track.id, src: track.url }} variant="ghost" size="icon" />
            <span className="text-sm font-medium">{track.name}</span>
          </div>
        ))}
        <div className="flex items-center gap-3 pt-2">
          <AudioPlayerTime />
          <AudioPlayerProgress className="flex-1" />
          <AudioPlayerDuration />
        </div>
      </div>
    </AudioPlayerProvider>
  ),
};

export const MinimalPlayer: Story = {
  render: () => (
    <AudioPlayerProvider>
      <div className="flex items-center gap-2">
        <AudioPlayerButton item={{ id: exampleTracks[0].id, src: exampleTracks[0].url }} variant="ghost" size="icon" />
        <AudioPlayerProgress className="w-48" />
      </div>
    </AudioPlayerProvider>
  ),
};
