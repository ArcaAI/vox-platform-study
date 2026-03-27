import type { Meta, StoryObj } from '@storybook/react-vite';

import { ItemCarousel } from '../../../registries/tool-ui/item-carousel';

const meta = {
  title: 'Registries/ToolUI/ItemCarousel',
  component: ItemCarousel,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ItemCarousel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    id: '1',
    items: [
      { id: '1', name: 'Item 1', subtitle: 'First item' },
      { id: '2', name: 'Item 2', subtitle: 'Second item' },
    ],
  },
};
