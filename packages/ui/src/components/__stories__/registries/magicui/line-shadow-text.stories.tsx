import type { Meta, StoryObj } from '@storybook/react-vite';

import { LineShadowText } from '../../../registries/magicui/line-shadow-text';

const meta = {
  title: 'Registries/MagicUI/LineShadowText',
  component: LineShadowText,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof LineShadowText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Shadow',
  },
};
