import type { Meta, StoryObj } from '@storybook/react-vite';
import { InvoiceHistory } from '@/components/registries/billingsdk';

const meta = {
  title: 'Registries/BillingSDK/InvoiceHistory',
  component: InvoiceHistory,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof InvoiceHistory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    invoices: [
      {
        id: '1',
        date: '2024-01-15',
        amount: '$20.00',
        status: 'paid',
        description: 'Pro Plan',
      },
    ],
  },
};
