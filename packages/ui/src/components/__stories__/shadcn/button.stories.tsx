import type { Meta, StoryObj } from '@storybook/react-vite'
import { IconMail, IconLoader2, IconChevronRight } from '@tabler/icons-react'

import { Button } from '../../shadcn/button'

const meta = {
  title: 'Components/Button',
  component: Button,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'],
      description: 'The visual style of the button',
    },
    size: {
      control: 'select',
      options: ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'],
      description: 'The size of the button',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the button is disabled',
    },
    asChild: {
      control: 'boolean',
      description: 'Render as child element (for composition)',
    },
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

// Default button
export const Default: Story = {
  args: {
    children: 'Button',
  },
}

// All variants
export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Button variant="default">Default</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
}

// All sizes
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Button size="xs">Extra Small</Button>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
    </div>
  ),
}

// With icons
export const WithIcon: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Button>
        <IconMail />
        Login with Email
      </Button>
      <Button variant="outline">
        <IconMail />
        Login with Email
      </Button>
      <Button variant="secondary">
        Continue
        <IconChevronRight />
      </Button>
    </div>
  ),
}

// Icon buttons
export const IconButtons: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Button size="icon-xs" variant="ghost">
        <IconMail />
      </Button>
      <Button size="icon-sm" variant="ghost">
        <IconMail />
      </Button>
      <Button size="icon" variant="outline">
        <IconMail />
      </Button>
      <Button size="icon-lg" variant="outline">
        <IconMail />
      </Button>
    </div>
  ),
}

// Loading state
export const Loading: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Button disabled>
        <IconLoader2 className="animate-spin" />
        Please wait
      </Button>
      <Button variant="outline" disabled>
        <IconLoader2 className="animate-spin" />
        Loading...
      </Button>
    </div>
  ),
}

// Disabled state
export const Disabled: Story = {
  args: {
    children: 'Disabled',
    disabled: true,
  },
}

// As child (link)
export const AsChild: Story = {
  render: () => (
    <Button asChild>
      <a href="https://example.com">Link Button</a>
    </Button>
  ),
}
