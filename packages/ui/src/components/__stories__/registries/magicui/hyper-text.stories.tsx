import type { Meta, StoryObj } from '@storybook/react-vite';

import { HyperText } from '../../../registries/magicui/hyper-text';

const meta = {
  title: 'Registries/MagicUI/HyperText',
  component: HyperText,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof HyperText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Hyper Text',
  },
};
