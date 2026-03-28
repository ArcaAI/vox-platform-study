import type { Meta, StoryObj } from '@storybook/react-vite';
import { PricingTableOne } from '@/components/registries/billingsdk';
import { plans } from '@/lib/billingsdk-config';

const meta = {
  title: 'Registries/BillingSDK/PricingTableOne',
  component: PricingTableOne,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof PricingTableOne>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    plans,
  },
};
