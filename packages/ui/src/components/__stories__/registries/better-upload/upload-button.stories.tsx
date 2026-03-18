import type { Meta, StoryObj } from '@storybook/react-vite'
import { UploadButton } from '../../../registries/better-upload'
import type { UploadHookControl } from '@better-upload/client'

function createMockControl(
  overrides: Partial<UploadHookControl<false>> = {},
): UploadHookControl<false> {
  return {
    upload: () => {},
    isPending: false,
    progress: undefined,
    isSuccess: false,
    isError: false,
    ...overrides,
  } as unknown as UploadHookControl<false>
}

function UploadButtonIdle() {
  return <UploadButton control={createMockControl()} />
}

function UploadButtonLoading() {
  return <UploadButton control={createMockControl({ isPending: true })} />
}

const meta = {
  title: 'Registries/BetterUpload/UploadButton',
  component: UploadButtonIdle,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UploadButtonIdle>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Loading: Story = {
  render: () => <UploadButtonLoading />,
}
