import type { Meta, StoryObj } from '@storybook/react-vite';

import { LoginForm } from '../../../registries/blocks/login-form';

const meta = {
  title: 'Registries/Blocks/LoginForm',
  component: LoginForm,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof LoginForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

export const WithCustomClass: Story = {
  args: {
    className: 'w-[400px]',
  },
};
