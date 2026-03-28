import type { Meta, StoryObj } from '@storybook/react-vite';

import { ConfettiButton } from '../../../registries/magicui/confetti';

const meta = {
  title: 'Registries/MagicUI/ConfettiButton',
  component: ConfettiButton,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ConfettiButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Click Me',
  },
};
