import type { Meta, StoryObj } from '@storybook/react-vite';

import { SparklesText } from '../../../registries/magicui/sparkles-text';

const meta = {
  title: 'Registries/MagicUI/SparklesText',
  component: SparklesText,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof SparklesText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Sparkles',
  },
};
