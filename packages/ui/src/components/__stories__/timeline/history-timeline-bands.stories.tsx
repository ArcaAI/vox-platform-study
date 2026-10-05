import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { HistoryTimelineList } from '../../timeline/history-timeline-list';
import type { TimelineBandModel, TimelineItemModel } from '../../timeline/types';

const note = (id: string, title: string, timestamp: string): TimelineItemModel => ({
  id,
  title,
  timestamp,
  variant: 'markdown',
  content: { type: 'markdown', markdown: `Content of **${title}**.` },
});

const rows: Array<TimelineItemModel | TimelineBandModel> = [
  { kind: 'band', id: 'enc-1', label: 'Encounter 1 - initial visit', tone: 'section' },
  note('a', 'Pre-summary', '2026-10-01T09:00:00Z'),
  note('b', 'Case note', '2026-10-01T09:20:00Z'),
  { kind: 'band', id: 'gap-1', label: 'Gap of 3 days', tone: 'gap' },
  { kind: 'band', id: 'enc-2', label: 'Encounter 2 - follow-up', tone: 'section' },
  note('c', 'Summary', '2026-10-04T10:00:00Z'),
];

const meta = {
  title: 'Timeline/HistoryTimelineList (bands)',
  component: HistoryTimelineList,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof HistoryTimelineList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OldestFirstWithBands: Story = {
  args: { items: rows, inputOrder: 'asc', height: 420 },
};

export const SelectableWithActions: Story = {
  args: { items: rows, inputOrder: 'asc', height: 420 },
  render: (args) => {
    const [selected, setSelected] = useState<string | null>('b');
    return (
      <HistoryTimelineList
        {...args}
        selectedId={selected}
        onItemSelect={setSelected}
        actions={(m) => (
          <button type="button" className="rounded-md border px-2 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            History {String(m.title)}
          </button>
        )}
      />
    );
  },
};
