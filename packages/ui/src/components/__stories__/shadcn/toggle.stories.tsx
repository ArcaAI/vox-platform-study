import type { Meta, StoryObj } from '@storybook/react-vite';
import { IconBold, IconItalic, IconUnderline } from '@tabler/icons-react';

import { Toggle } from '../../shadcn/toggle';

const meta = {
  title: 'Components/Toggle',
  component: Toggle,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'outline'],
    },
    size: {
      control: 'select',
      options: ['default', 'sm', 'lg'],
    },
  },
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Toggle aria-label="Toggle bold">
      <IconBold className="size-4" />
    </Toggle>
  ),
};

export const Variants: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Toggle variant="default" aria-label="Toggle bold">
        <IconBold className="size-4" />
      </Toggle>
      <Toggle variant="outline" aria-label="Toggle italic">
        <IconItalic className="size-4" />
      </Toggle>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Toggle size="sm" aria-label="Toggle small">
        <IconBold className="size-3.5" />
      </Toggle>
      <Toggle size="default" aria-label="Toggle default">
        <IconBold className="size-4" />
      </Toggle>
      <Toggle size="lg" aria-label="Toggle large">
        <IconBold className="size-5" />
      </Toggle>
    </div>
  ),
};

export const WithText: Story = {
  render: () => (
    <Toggle aria-label="Toggle italic">
      <IconItalic className="size-4" />
      Italic
    </Toggle>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Toggle aria-label="Toggle underline" disabled>
      <IconUnderline className="size-4" />
    </Toggle>
  ),
};
