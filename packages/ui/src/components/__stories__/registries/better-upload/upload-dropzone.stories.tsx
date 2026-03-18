import type { Meta, StoryObj } from '@storybook/react-vite'
import { UploadDropzone } from '../../../registries/better-upload'
import type { UploadHookControl } from '@better-upload/client'

function createMockControl(
  overrides: Partial<UploadHookControl<true>> = {},
): UploadHookControl<true> {
  return {
    upload: () => {},
    isPending: false,
    progresses: new Map(),
    isSuccess: false,
    isError: false,
    ...overrides,
  } as unknown as UploadHookControl<true>
}

function UploadDropzoneIdle() {
  return (
    <UploadDropzone
      control={createMockControl()}
      description={{
        fileTypes: 'PNG, JPG, PDF',
        maxFileSize: '10MB',
        maxFiles: 5,
      }}
    />
  )
}

function UploadDropzoneLoading() {
  return (
    <UploadDropzone
      control={createMockControl({ isPending: true })}
      description="Uploading your files..."
    />
  )
}

const meta = {
  title: 'Registries/BetterUpload/UploadDropzone',
  component: UploadDropzoneIdle,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UploadDropzoneIdle>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Loading: Story = {
  render: () => <UploadDropzoneLoading />,
}

export const CustomDescription: Story = {
  render: () => (
    <UploadDropzone
      control={createMockControl()}
      description="Drop your documents here to get started"
    />
  ),
}
