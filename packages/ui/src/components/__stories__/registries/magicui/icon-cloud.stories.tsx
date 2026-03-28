import type { Meta, StoryObj } from '@storybook/react-vite';

import { IconCloud } from '../../../registries/magicui/icon-cloud';

const meta = {
  title: 'Registries/MagicUI/IconCloud',
  component: IconCloud,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof IconCloud>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    images: ['https://via.placeholder.com/40'],
  },
};
