import type { Meta, StoryObj } from '@storybook/react-vite';

import { Shimmer } from '../../../registries/ai-elements/shimmer';

const meta = {
  title: 'Registries/AiElements/Shimmer',
  component: Shimmer,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Shimmer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Thinking...',
  },
};

export const SlowDuration: Story = {
  args: {
    children: 'Processing your request...',
    duration: 4,
  },
};

export const AsHeading: Story = {
  args: {
    children: 'Loading content',
    as: 'h2',
    className: 'text-2xl font-bold',
  },
};
