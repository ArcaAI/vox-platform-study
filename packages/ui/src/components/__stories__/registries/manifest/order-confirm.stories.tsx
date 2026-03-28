import type { Meta, StoryObj } from '@storybook/react-vite';

import { OrderConfirm } from '../../../registries/manifest/order-confirm';

const meta = {
  title: 'Registries/Manifest/OrderConfirm',
  component: OrderConfirm,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof OrderConfirm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <OrderConfirm />,
};
