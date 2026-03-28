import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, useCallback } from 'react';

import { AsyncJobTracker, type AsyncJob } from '../../custom/async-job-tracker';

function createMockPollFn(scenario: 'success' | 'fail' | 'slow') {
  let callCount = 0;
  return async (_jobId: string): Promise<AsyncJob> => {
    callCount++;
    if (scenario === 'fail' && callCount >= 3) {
      return { jobId: _jobId, status: 'failed', error: 'Model inference timeout after 30s' };
    }
    if (scenario === 'success' && callCount >= 5) {
      return { jobId: _jobId, status: 'completed', progress: 100, result: { output: 'done' } };
    }
    const progress = Math.min(95, callCount * 20);
    return {
      jobId: _jobId,
      status: callCount === 1 ? 'pending' : 'processing',
      progress: callCount === 1 ? undefined : progress,
      estimatedMs: 10000,
    };
  };
}

const meta = {
  title: 'Custom/AsyncJobTracker',
  component: AsyncJobTracker,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    pollIntervalMs: {
      control: { type: 'number', min: 500, max: 10000, step: 500 },
      description: 'Polling interval in milliseconds',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AsyncJobTracker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  args: {
    jobId: 'job-001',
    pollFn: async (id) => ({ jobId: id, status: 'pending' }),
    pollIntervalMs: 60000,
  },
};

export const Processing: Story = {
  args: {
    jobId: 'job-002',
    pollFn: async (id) => ({
      jobId: id,
      status: 'processing',
      progress: 45,
      estimatedMs: 8000,
    }),
    pollIntervalMs: 60000,
  },
};

export const Completed: Story = {
  args: {
    jobId: 'job-003',
    pollFn: async (id) => ({
      jobId: id,
      status: 'completed',
      progress: 100,
      result: { summary: 'Analysis complete' },
    }),
    pollIntervalMs: 60000,
  },
};

export const Failed: Story = {
  args: {
    jobId: 'job-004',
    pollFn: async (id) => ({
      jobId: id,
      status: 'failed',
      error: 'Connection to inference server timed out after 30 seconds.',
    }),
    pollIntervalMs: 60000,
  },
};

export const NoJob: Story = {
  args: {
    jobId: null,
    pollFn: async (id) => ({ jobId: id, status: 'pending' }),
  },
};

function LiveDemo({ scenario }: { scenario: 'success' | 'fail' | 'slow' }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const pollFn = useCallback(createMockPollFn(scenario), [scenario, jobId]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => setJobId(`job-${Date.now()}`)}>
          Start Job
        </button>
        <button className="rounded border px-3 py-1.5 text-sm" onClick={() => setJobId(null)}>
          Reset
        </button>
      </div>
      <AsyncJobTracker
        jobId={jobId}
        pollFn={pollFn}
        pollIntervalMs={1000}
        onComplete={(r) => console.log('Complete:', r)}
        onError={(e) => console.log('Error:', e)}
      />
    </div>
  );
}

export const LiveSuccess: Story = {
  args: {} as any,
  render: () => <LiveDemo scenario="success" />,
};

export const LiveFailure: Story = {
  args: {} as any,
  render: () => <LiveDemo scenario="fail" />,
};
