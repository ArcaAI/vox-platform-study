import type { Meta, StoryObj } from '@storybook/react-vite';

import { BlurFade } from '../../../registries/magicui/blur-fade';

const meta = {
  title: 'Registries/MagicUI/BlurFade',
  component: BlurFade,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof BlurFade>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: <p className="text-lg">This text fades in with a blur effect when it becomes visible.</p>,
  },
};
