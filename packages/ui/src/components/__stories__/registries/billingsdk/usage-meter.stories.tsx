import type { Meta, StoryObj } from '@storybook/react-vite';
import { UsageMeter } from '@/components/registries/billingsdk';

const meta = {
  title: 'Registries/BillingSDK/UsageMeter',
  component: UsageMeter,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UsageMeter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    usage: [
      { name: 'API Calls', usage: 750, limit: 1000 },
      { name: 'Storage', usage: 3, limit: 10 },
    ],
  },
};
