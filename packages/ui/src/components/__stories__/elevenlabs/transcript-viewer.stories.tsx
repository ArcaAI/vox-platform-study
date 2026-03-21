import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  TranscriptViewerContainer,
  TranscriptViewerWords,
  TranscriptViewerAudio,
  TranscriptViewerPlayPauseButton,
  TranscriptViewerScrubBar,
} from '../../elevenlabs/transcript-viewer'

const mockAlignment = {
  characters: ['H', 'e', 'l', 'l', 'o', ' ', 'w', 'o', 'r', 'l', 'd'],
  character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1],
  characterStartTimesSeconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  characterEndTimesSeconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1],
}

const meta: Meta<typeof TranscriptViewerContainer> = {
  title: 'ElevenLabs/TranscriptViewer',
  component: TranscriptViewerContainer,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof TranscriptViewerContainer>

export const Default: Story = {
  render: () => (
    <div className="w-[500px]">
      <TranscriptViewerContainer
        audioSrc="https://storage.googleapis.com/eleven-public-cdn/audio/ui-elevenlabs-io/00.mp3"
        audioType="audio/mpeg"
        alignment={mockAlignment}
      >
        <TranscriptViewerAudio />
        <TranscriptViewerWords />
        <div className="flex items-center gap-3 pt-4">
          <TranscriptViewerPlayPauseButton />
          <TranscriptViewerScrubBar className="flex-1" />
        </div>
      </TranscriptViewerContainer>
    </div>
  ),
}

export const WithoutTimeLabels: Story = {
  render: () => (
    <div className="w-[500px]">
      <TranscriptViewerContainer
        audioSrc="https://storage.googleapis.com/eleven-public-cdn/audio/ui-elevenlabs-io/00.mp3"
        audioType="audio/mpeg"
        alignment={mockAlignment}
      >
        <TranscriptViewerAudio />
        <TranscriptViewerWords />
        <div className="flex items-center gap-3 pt-4">
          <TranscriptViewerPlayPauseButton />
          <TranscriptViewerScrubBar showTimeLabels={false} className="flex-1" />
        </div>
      </TranscriptViewerContainer>
    </div>
  ),
}

export const PlayPauseOnly: Story = {
  render: () => (
    <div className="w-[500px]">
      <TranscriptViewerContainer
        audioSrc="https://storage.googleapis.com/eleven-public-cdn/audio/ui-elevenlabs-io/00.mp3"
        audioType="audio/mpeg"
        alignment={mockAlignment}
      >
        <TranscriptViewerAudio />
        <TranscriptViewerWords />
        <div className="pt-4">
          <TranscriptViewerPlayPauseButton />
        </div>
      </TranscriptViewerContainer>
    </div>
  ),
}

export const CustomPlayPauseButton: Story = {
  render: () => (
    <div className="w-[500px]">
      <TranscriptViewerContainer
        audioSrc="https://storage.googleapis.com/eleven-public-cdn/audio/ui-elevenlabs-io/00.mp3"
        audioType="audio/mpeg"
        alignment={mockAlignment}
      >
        <TranscriptViewerAudio />
        <TranscriptViewerWords />
        <div className="flex items-center gap-3 pt-4">
          <TranscriptViewerPlayPauseButton>
            {({ isPlaying }) => (
              <span className="text-xs">{isPlaying ? 'Pause' : 'Play'}</span>
            )}
          </TranscriptViewerPlayPauseButton>
          <TranscriptViewerScrubBar className="flex-1" />
        </div>
      </TranscriptViewerContainer>
    </div>
  ),
}
