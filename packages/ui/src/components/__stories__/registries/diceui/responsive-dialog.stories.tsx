import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
} from '@/components/registries/diceui/responsive-dialog'

const meta = {
  title: 'Registries/DiceUI/ResponsiveDialog',
  component: ResponsiveDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ResponsiveDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <ResponsiveDialog>
      <ResponsiveDialogTrigger>Open Dialog</ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Dialog Title</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>Description</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  ),
}
