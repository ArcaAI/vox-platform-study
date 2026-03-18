import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  MediaPlayer,
  MediaPlayerVideo,
  MediaPlayerControls,
  MediaPlayerPlay,
  MediaPlayerSeek,
  MediaPlayerVolume,
  MediaPlayerTime,
} from '../../../registries/diceui/media-player'

const meta = {
  title: 'Registries/DiceUI/MediaPlayer',
  component: MediaPlayer,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof MediaPlayer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <MediaPlayer className="w-80">
      <MediaPlayerVideo src="" />
      <MediaPlayerControls>
        <MediaPlayerPlay />
        <MediaPlayerSeek />
        <MediaPlayerVolume />
        <MediaPlayerTime />
      </MediaPlayerControls>
    </MediaPlayer>
  ),
}
