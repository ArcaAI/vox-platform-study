import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ScrubBarContainer, ScrubBarTrack, ScrubBarProgress, ScrubBarThumb, ScrubBarTimeLabel } from '../../elevenlabs/scrub-bar';

function ScrubBarDemo({ duration = 180, initialValue = 45 }: { duration?: number; initialValue?: number }) {
  const [value, setValue] = useState(initialValue);
  return (
    <ScrubBarContainer duration={duration} value={value} onScrub={setValue} className="w-full">
      <ScrubBarTimeLabel time={value} className="mr-2 text-xs" />
      <ScrubBarTrack>
        <ScrubBarProgress />
        <ScrubBarThumb />
      </ScrubBarTrack>
      <ScrubBarTimeLabel time={duration} className="ml-2 text-xs" />
    </ScrubBarContainer>
  );
}

const meta: Meta<typeof ScrubBarContainer> = {
  title: 'ElevenLabs/ScrubBar',
  component: ScrubBarContainer,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof ScrubBarContainer>;

export const Default: Story = {
  render: () => (
    <div className="w-[400px]">
      <ScrubBarDemo />
    </div>
  ),
};

export const AtStart: Story = {
  render: () => (
    <div className="w-[400px]">
      <ScrubBarDemo initialValue={0} />
    </div>
  ),
};

export const AtEnd: Story = {
  render: () => (
    <div className="w-[400px]">
      <ScrubBarDemo initialValue={180} />
    </div>
  ),
};

export const ShortDuration: Story = {
  render: () => (
    <div className="w-[400px]">
      <ScrubBarDemo duration={30} initialValue={15} />
    </div>
  ),
};

export const LongDuration: Story = {
  render: () => (
    <div className="w-[400px]">
      <ScrubBarDemo duration={3600} initialValue={1200} />
    </div>
  ),
};

export const TrackOnly: Story = {
  render: () => {
    const [value, setValue] = useState(60);
    return (
      <div className="w-[400px]">
        <ScrubBarContainer duration={180} value={value} onScrub={setValue}>
          <ScrubBarTrack>
            <ScrubBarProgress />
          </ScrubBarTrack>
        </ScrubBarContainer>
      </div>
    );
  },
};
