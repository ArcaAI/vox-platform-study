import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { DnaStyleSelector, type DnaStyleOption } from '../../custom/dna-style-selector';

const styles: DnaStyleOption[] = [
  {
    id: 'concise',
    name: 'Concise Clinical',
    preview: 'Short, direct sentences. Bullet-pointed findings. Minimal hedging language.',
  },
  {
    id: 'narrative',
    name: 'Narrative Medical',
    preview: 'Flowing prose connecting observations to conclusions. Contextual background included.',
  },
  {
    id: 'structured',
    name: 'Structured Report',
    preview: 'Section-based format with headers. Standardized terminology. Quantitative emphasis.',
  },
];

const meta = {
  title: 'Custom/DnaStyleSelector',
  component: DnaStyleSelector,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    isLoading: {
      control: 'boolean',
      description: 'Whether styles are loading',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[400px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DnaStyleSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    styles,
    onChange: (id) => console.log('Selected:', id),
  },
};

export const WithSelection: Story = {
  args: {
    styles,
    selectedStyleId: 'narrative',
    onChange: (id) => console.log('Selected:', id),
  },
};

export const Loading: Story = {
  args: {
    styles: [],
    isLoading: true,
    onChange: () => {},
  },
};

export const Empty: Story = {
  args: {
    styles: [],
    onChange: () => {},
    onGenerate: () => console.log('Generate clicked'),
  },
};

export const EmptyWithoutGenerate: Story = {
  args: {
    styles: [],
    onChange: () => {},
  },
};

export const SingleStyle: Story = {
  args: {
    styles: [styles[0]],
    selectedStyleId: 'concise',
    onChange: (id) => console.log('Selected:', id),
  },
};

function InteractiveDemo() {
  const [selected, setSelected] = useState<string | undefined>();

  return <DnaStyleSelector styles={styles} selectedStyleId={selected} onChange={setSelected} onGenerate={() => console.log('Generate DNA style')} />;
}

export const Interactive: Story = {
  args: {} as any,
  render: () => <InteractiveDemo />,
};
