import type { Meta, StoryObj } from '@storybook/react-vite';

import { Waveform } from '../../elevenlabs/waveform';

const generateSampleData = (length: number, seed = 42): number[] => {
  const data: number[] = [];
  let value = 0.5;
  for (let i = 0; i < length; i++) {
    value += Math.sin(i * 0.1 + seed) * 0.3 + Math.cos(i * 0.05) * 0.2;
    data.push(Math.max(0.05, Math.min(1, Math.abs(Math.sin(value)))));
  }
  return data;
};

const meta: Meta<typeof Waveform> = {
  title: 'ElevenLabs/Waveform',
  component: Waveform,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    barWidth: {
      control: { type: 'number', min: 1, max: 20, step: 1 },
      description: 'Width of each bar',
    },
    barGap: {
      control: { type: 'number', min: 0, max: 10, step: 1 },
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
      control: { type: 'number', min: 32, max: 256, step: 8 },
      description: 'Height of the waveform',
    },
  },
};

export default meta;
type Story = StoryObj<typeof Waveform>;

export const Default: Story = {
  render: () => (
    <div className="w-[400px]">
      <Waveform data={generateSampleData(200)} />
    </div>
  ),
};

export const ThinBars: Story = {
  render: () => (
    <div className="w-[400px]">
      <Waveform data={generateSampleData(200)} barWidth={2} barGap={1} />
    </div>
  ),
};

export const ThickBars: Story = {
  render: () => (
    <div className="w-[400px]">
      <Waveform data={generateSampleData(200)} barWidth={8} barGap={3} />
    </div>
  ),
};

export const NoFadeEdges: Story = {
  render: () => (
    <div className="w-[400px]">
      <Waveform data={generateSampleData(200)} fadeEdges={false} />
    </div>
  ),
};

export const SmallHeight: Story = {
  render: () => (
    <div className="w-[400px]">
      <Waveform data={generateSampleData(200)} height={48} />
    </div>
  ),
};

export const LargeHeight: Story = {
  render: () => (
    <div className="w-[400px]">
      <Waveform data={generateSampleData(200)} height={200} />
    </div>
  ),
};

export const EmptyData: Story = {
  render: () => (
    <div className="w-[400px]">
      <Waveform data={[]} />
    </div>
  ),
};

export const FewDataPoints: Story = {
  render: () => (
    <div className="w-[400px]">
      <Waveform data={[0.2, 0.5, 0.8, 1.0, 0.7, 0.3, 0.1]} />
    </div>
  ),
};
