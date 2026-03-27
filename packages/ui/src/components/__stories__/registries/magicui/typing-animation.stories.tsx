import type { Meta, StoryObj } from '@storybook/react-vite';

import { TypingAnimation } from '../../../registries/magicui/typing-animation';

const meta = {
  title: 'Registries/MagicUI/TypingAnimation',
  component: TypingAnimation,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof TypingAnimation>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Typing Animation',
  },
};
