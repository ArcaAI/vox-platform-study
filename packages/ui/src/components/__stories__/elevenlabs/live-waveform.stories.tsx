import type { Meta, StoryObj } from '@storybook/react-vite';

import { LiveWaveform } from '../../elevenlabs/live-waveform';

const meta: Meta<typeof LiveWaveform> = {
  title: 'ElevenLabs/LiveWaveform',
  component: LiveWaveform,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    active: {
      control: 'boolean',
      description: 'Whether the waveform is actively recording',
    },
    processing: {
      control: 'boolean',
      description: 'Whether the waveform is in processing state',
    },
    barWidth: {
      control: { type: 'number', min: 1, max: 10, step: 1 },
      description: 'Width of each bar',
    },
    barGap: {
      control: { type: 'number', min: 0, max: 5, step: 1 },
      description: 'Gap between bars',
    },
    barRadius: {
      control: { type: 'number', min: 0, max: 10, step: 0.5 },
      description: 'Border radius of bars',
    },
    fadeEdges: {
      control: 'boolean',
      description: 'Whether to fade edges',
    },
    height: {
      control: { type: 'number', min: 16, max: 128, step: 8 },
      description: 'Height of the waveform',
    },
    mode: {
      control: 'select',
      options: ['scrolling', 'static'],
      description: 'Display mode',
    },
    sensitivity: {
      control: { type: 'number', min: 0.1, max: 5, step: 0.1 },
      description: 'Microphone sensitivity',
    },
  },
};

export default meta;
type Story = StoryObj<typeof LiveWaveform>;

export const Idle: Story = {
  render: () => (
    <div className="w-[400px]">
      <LiveWaveform height={64} />
    </div>
  ),
};

export const Processing: Story = {
  render: () => (
    <div className="w-[400px]">
      <LiveWaveform processing height={64} />
    </div>
  ),
};

export const StaticMode: Story = {
  render: () => (
    <div className="w-[400px]">
      <LiveWaveform processing height={64} mode="static" />
    </div>
  ),
};

export const ScrollingMode: Story = {
  render: () => (
    <div className="w-[400px]">
      <LiveWaveform processing height={64} mode="scrolling" />
    </div>
  ),
};

export const ThinBars: Story = {
  render: () => (
    <div className="w-[400px]">
      <LiveWaveform processing height={64} barWidth={2} barGap={1} />
    </div>
  ),
};

export const ThickBars: Story = {
  render: () => (
    <div className="w-[400px]">
      <LiveWaveform processing height={64} barWidth={6} barGap={2} />
    </div>
  ),
};

export const NoFadeEdges: Story = {
  render: () => (
    <div className="w-[400px]">
      <LiveWaveform processing height={64} fadeEdges={false} />
    </div>
  ),
};

export const SmallHeight: Story = {
  render: () => (
    <div className="w-[400px]">
      <LiveWaveform processing height={24} barWidth={2} barGap={1} />
    </div>
  ),
};

export const LargeHeight: Story = {
  render: () => (
    <div className="w-[400px]">
      <LiveWaveform processing height={128} />
    </div>
  ),
};

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="w-[400px]">
        <p className="mb-1 text-sm font-medium">Idle</p>
        <LiveWaveform height={48} />
      </div>
      <div className="w-[400px]">
        <p className="mb-1 text-sm font-medium">Processing</p>
        <LiveWaveform processing height={48} />
      </div>
    </div>
  ),
};
