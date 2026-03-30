import type { Meta, StoryObj } from '@storybook/react-vite';
import { IconSearch, IconMail } from '@tabler/icons-react';

import { Input } from '../../shadcn/input';
import { Label } from '../../shadcn/label';
import { Button } from '../../shadcn/button';

const meta = {
  title: 'Components/Input',
  component: Input,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    type: {
      control: 'select',
      options: ['text', 'email', 'password', 'number', 'search', 'tel', 'url'],
      description: 'The type of input',
    },
    placeholder: {
      control: 'text',
      description: 'Placeholder text',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the input is disabled',
    },
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default input
export const Default: Story = {
  args: {
    placeholder: 'Enter text...',
  },
};

// With label
export const WithLabel: Story = {
  render: () => (
    <div className="grid w-full max-w-sm items-center gap-1.5">
      <Label htmlFor="email">Email</Label>
      <Input type="email" id="email" placeholder="Email" />
    </div>
  ),
};

// Input types
export const Types: Story = {
  render: () => (
    <div className="flex flex-col gap-4 w-[300px]">
      <div className="grid gap-1.5">
        <Label htmlFor="text">Text</Label>
        <Input type="text" id="text" placeholder="Enter text" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input type="email" id="email" placeholder="email@example.com" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input type="password" id="password" placeholder="Enter password" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="number">Number</Label>
        <Input type="number" id="number" placeholder="0" />
      </div>
    </div>
  ),
};

// Disabled state
export const Disabled: Story = {
  args: {
    placeholder: 'Disabled input',
    disabled: true,
  },
};

// With icon (using wrapper)
export const WithIcon: Story = {
  render: () => (
    <div className="flex flex-col gap-4 w-[300px]">
      <div className="relative">
        <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search..." className="pl-9" />
      </div>
      <div className="relative">
        <IconMail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="email" placeholder="Email" className="pl-9" />
      </div>
    </div>
  ),
};

// With button
export const WithButton: Story = {
  render: () => (
    <div className="flex w-full max-w-sm items-center space-x-2">
      <Input type="email" placeholder="Email" />
      <Button type="submit">Subscribe</Button>
    </div>
  ),
};

// File input
export const File: Story = {
  render: () => (
    <div className="grid w-full max-w-sm items-center gap-1.5">
      <Label htmlFor="picture">Picture</Label>
      <Input id="picture" type="file" />
    </div>
  ),
};

// Invalid state
export const Invalid: Story = {
  render: () => (
    <div className="grid w-full max-w-sm items-center gap-1.5">
      <Label htmlFor="email-invalid">Email</Label>
      <Input type="email" id="email-invalid" placeholder="Email" aria-invalid="true" defaultValue="invalid-email" />
      <p className="text-sm text-destructive">Please enter a valid email address.</p>
    </div>
  ),
};
