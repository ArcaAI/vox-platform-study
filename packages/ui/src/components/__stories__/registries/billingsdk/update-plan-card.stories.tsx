import type { Meta, StoryObj } from '@storybook/react-vite';
import { UpdatePlanCard } from '@/components/registries/billingsdk';
import { plans } from '@/lib/billingsdk-config';

const meta = {
  title: 'Registries/BillingSDK/UpdatePlanCard',
  component: UpdatePlanCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UpdatePlanCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    currentPlan: plans[0],
    plans,
    onPlanChange: () => {},
  },
};
