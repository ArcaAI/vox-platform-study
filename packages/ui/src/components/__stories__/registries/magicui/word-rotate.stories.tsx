import type { Meta, StoryObj } from '@storybook/react-vite';

import { WordRotate } from '../../../registries/magicui/word-rotate';

const meta = {
  title: 'Registries/MagicUI/WordRotate',
  component: WordRotate,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof WordRotate>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    words: ['Hello', 'World', 'Magic'],
  },
};
