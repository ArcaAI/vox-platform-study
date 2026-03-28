import type { Meta, StoryObj } from '@storybook/react-vite';
import { CancelSubscriptionDialog } from '@/components/registries/billingsdk';
import { plans } from '@/lib/billingsdk-config';

const meta = {
  title: 'Registries/BillingSDK/CancelSubscriptionDialog',
  component: CancelSubscriptionDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof CancelSubscriptionDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    title: 'Cancel',
    description: 'Are you sure?',
    plan: plans[1],
    onCancel: () => {},
    onKeepSubscription: () => {},
  },
};
