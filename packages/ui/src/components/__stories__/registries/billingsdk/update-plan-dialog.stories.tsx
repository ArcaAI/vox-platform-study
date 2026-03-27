import type { Meta, StoryObj } from '@storybook/react-vite';
import { UpdatePlanDialog } from '@/components/registries/billingsdk';
import { plans } from '@/lib/billingsdk-config';

const meta = {
  title: 'Registries/BillingSDK/UpdatePlanDialog',
  component: UpdatePlanDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UpdatePlanDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    currentPlan: plans[0],
    plans,
    triggerText: 'Change Plan',
    onPlanChange: () => {},
  },
};
