import type { Meta, StoryObj } from '@storybook/react-vite';

import { FileUpload, FileUploadDropzone } from '../../../registries/prompt-kit/file-upload';

const meta = {
  title: 'Registries/PromptKit/FileUpload',
  component: FileUpload,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof FileUpload>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <FileUpload>
      <FileUploadDropzone>
        <span className="text-sm text-muted-foreground">Drop files here or click to upload</span>
      </FileUploadDropzone>
    </FileUpload>
  ),
};
