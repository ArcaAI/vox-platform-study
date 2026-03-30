import type { Meta, StoryObj } from '@storybook/react-vite';

import { AmountInput } from '../../../registries/manifest/amount-input';

const meta = {
  title: 'Registries/Manifest/AmountInput',
  component: AmountInput,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof AmountInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <AmountInput />,
};
