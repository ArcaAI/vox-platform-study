import type { Meta, StoryObj } from '@storybook/react-vite';

import { OrderSummary } from '../../../registries/tool-ui/order-summary';

const meta = {
  title: 'Registries/ToolUI/OrderSummary',
  component: OrderSummary,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof OrderSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <OrderSummary.Display
      id="1"
      items={[
        {
          id: '1',
          name: 'Widget',
          quantity: 2,
          unitPrice: 9.99,
        },
      ]}
      pricing={{
        subtotal: 19.98,
        total: 19.98,
      }}
    />
  ),
};
