import type { Meta, StoryObj } from '@storybook/react-vite';

import { Terminal } from '../../../registries/ai-elements/terminal';

const meta = {
  title: 'Registries/AiElements/Terminal',
  component: Terminal,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Terminal>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleOutput = `$ npm install
added 1024 packages in 12s

$ npm run build
> @arcaai/ui@1.0.0 build
> tsc && vite build

vite v6.0.0 building for production...
✓ 142 modules transformed.
dist/index.js   45.2 kB │ gzip: 14.1 kB
✓ built in 2.34s`;

export const Default: Story = {
  args: {
    output: sampleOutput,
    className: 'w-[500px]',
  },
};

export const Streaming: Story = {
  args: {
    output: '$ running tests...\nTest suite: 42 passed, 0 failed',
    isStreaming: true,
    className: 'w-[500px]',
  },
};

export const WithClear: Story = {
  args: {
    output: sampleOutput,
    onClear: () => console.log('Clear terminal'),
    className: 'w-[500px]',
  },
};
