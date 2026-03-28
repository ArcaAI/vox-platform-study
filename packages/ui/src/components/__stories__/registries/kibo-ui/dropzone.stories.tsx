import type { Meta, StoryObj } from '@storybook/react-vite';

import { Dropzone, DropzoneContent, DropzoneEmptyState } from '../../../registries/kibo-ui/dropzone';

const meta = {
  title: 'Registries/KiboUI/Dropzone',
  component: Dropzone,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Dropzone>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Dropzone className="w-96">
      <DropzoneContent />
      <DropzoneEmptyState />
    </Dropzone>
  ),
};
