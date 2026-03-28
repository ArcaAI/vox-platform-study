import type { Meta, StoryObj } from '@storybook/react-vite';
import { BillingScreen } from '@/components/registries/billingsdk';

const meta = {
  title: 'Registries/BillingSDK/BillingScreen',
  component: BillingScreen,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof BillingScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};
