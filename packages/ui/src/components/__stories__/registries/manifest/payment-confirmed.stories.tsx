import type { Meta, StoryObj } from '@storybook/react-vite';

import { PaymentConfirmed } from '../../../registries/manifest/payment-confirmed';

const meta = {
  title: 'Registries/Manifest/PaymentConfirmed',
  component: PaymentConfirmed,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PaymentConfirmed>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <PaymentConfirmed />,
};

export const Compressed: Story = {
  render: () => <PaymentConfirmed appearance={{ variant: 'compressed' }} />,
};
