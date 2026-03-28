import type { Meta, StoryObj } from '@storybook/react-vite';

import { RainbowButton } from '../../../registries/magicui/rainbow-button';

const meta = {
  title: 'Registries/MagicUI/RainbowButton',
  component: RainbowButton,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof RainbowButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Rainbow',
  },
};
