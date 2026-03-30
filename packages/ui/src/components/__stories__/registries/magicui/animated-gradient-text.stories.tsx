import type { Meta, StoryObj } from '@storybook/react-vite';

import { AnimatedGradientText } from '../../../registries/magicui/animated-gradient-text';

const meta = {
  title: 'Registries/MagicUI/AnimatedGradientText',
  component: AnimatedGradientText,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof AnimatedGradientText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Animated Gradient Text',
  },
};
