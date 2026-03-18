import type { Meta, StoryObj } from '@storybook/react-vite'

import { QRCode } from '../../../registries/kibo-ui/qr-code'

const meta = {
  title: 'Registries/KiboUI/QRCode',
  component: QRCode,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof QRCode>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    data: 'https://example.com',
    className: 'w-48 h-48',
  },
}
