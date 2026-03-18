import type { Meta, StoryObj } from '@storybook/react-vite'
import { IconInfoCircle, IconAlertTriangle } from '@tabler/icons-react'

import { Alert, AlertTitle, AlertDescription } from '../../shadcn/alert'

const meta = {
  title: 'Components/Alert',
  component: Alert,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'destructive'],
      description: 'The visual style of the alert',
    },
  },
} satisfies Meta<typeof Alert>

export default meta
type Story = StoryObj<typeof meta>

// Default alert
export const Default: Story = {
  render: () => (
    <Alert className="w-112.5">
      <AlertTitle>Heads up!</AlertTitle>
      <AlertDescription>
        You can add components to your app using the CLI.
      </AlertDescription>
    </Alert>
  ),
}

// Destructive variant
export const Destructive: Story = {
  render: () => (
    <Alert variant="destructive" className="w-112.5">
      <AlertTitle>Error</AlertTitle>
      <AlertDescription>
        Your session has expired. Please log in again.
      </AlertDescription>
    </Alert>
  ),
}

// All variants side by side
export const Variants: Story = {
  render: () => (
    <div className="flex w-112.5 flex-col gap-4">
      <Alert>
        <AlertTitle>Default</AlertTitle>
        <AlertDescription>
          This is the default alert variant.
        </AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertTitle>Destructive</AlertTitle>
        <AlertDescription>
          This is the destructive alert variant.
        </AlertDescription>
      </Alert>
    </div>
  ),
}

// Alerts with icons
export const WithIcon: Story = {
  render: () => (
    <div className="flex w-112.5 flex-col gap-4">
      <Alert>
        <IconInfoCircle />
        <AlertTitle>Information</AlertTitle>
        <AlertDescription>
          This alert includes an informational icon for additional context.
        </AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <IconAlertTriangle />
        <AlertTitle>Warning</AlertTitle>
        <AlertDescription>
          Something went wrong. Please check your input and try again.
        </AlertDescription>
      </Alert>
    </div>
  ),
}
