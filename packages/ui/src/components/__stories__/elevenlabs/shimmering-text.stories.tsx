import type { Meta, StoryObj } from '@storybook/react-vite';

import { ShimmeringText } from '../../elevenlabs/shimmering-text';

const meta: Meta<typeof ShimmeringText> = {
  title: 'ElevenLabs/ShimmeringText',
  component: ShimmeringText,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    text: {
      control: 'text',
      description: 'Text to display with shimmer effect',
    },
    duration: {
      control: { type: 'number', min: 0.5, max: 10, step: 0.5 },
      description: 'Animation duration in seconds',
    },
    delay: {
      control: { type: 'number', min: 0, max: 5, step: 0.1 },
      description: 'Delay before starting animation',
    },
    repeat: {
      control: 'boolean',
      description: 'Whether to repeat the animation',
    },
    spread: {
      control: { type: 'number', min: 0.5, max: 5, step: 0.5 },
      description: 'Shimmer spread multiplier',
    },
  },
};

export default meta;
type Story = StoryObj<typeof ShimmeringText>;

export const Default: Story = {
  args: {
    text: 'Shimmering Text Effect',
  },
};

export const SlowAnimation: Story = {
  args: {
    text: 'Slow shimmer animation',
    duration: 5,
  },
};

export const FastAnimation: Story = {
  args: {
    text: 'Fast shimmer',
    duration: 0.8,
  },
};

export const NoRepeat: Story = {
  args: {
    text: 'This only shimmers once',
    repeat: false,
  },
};

export const CustomColors: Story = {
  args: {
    text: 'Custom colored shimmer',
    color: '#6366f1',
    shimmerColor: '#f59e0b',
  },
};

export const LargeText: Story = {
  render: () => (
    <div className="text-4xl font-bold">
      <ShimmeringText text="Large Heading" duration={3} />
    </div>
  ),
};

export const WideSpread: Story = {
  args: {
    text: 'Wide shimmer spread',
    spread: 4,
  },
};

export const WithDelay: Story = {
  args: {
    text: 'Delayed shimmer start',
    delay: 2,
  },
};
