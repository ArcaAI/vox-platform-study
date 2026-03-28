import type { Meta, StoryObj } from '@storybook/react-vite';

import { NumberTicker } from '../../../registries/magicui/number-ticker';

const meta = {
  title: 'Registries/MagicUI/NumberTicker',
  component: NumberTicker,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof NumberTicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    value: 100,
  },
};
