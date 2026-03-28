import type { Meta, StoryObj } from '@storybook/react-vite';

import { ServiceStatusBar, type ServiceHealth } from '../../custom/service-status-bar';

const allHealthy: ServiceHealth[] = [
  { name: 'API Gateway', status: 'healthy', latency: 42 },
  { name: 'STT Service', status: 'healthy', latency: 128 },
  { name: 'TTS Service', status: 'healthy', latency: 95 },
  { name: 'NLP Service', status: 'healthy', latency: 67 },
];

const mixed: ServiceHealth[] = [
  { name: 'API Gateway', status: 'healthy', latency: 42 },
  { name: 'STT Service', status: 'degraded', latency: 850 },
  { name: 'TTS Service', status: 'healthy', latency: 95 },
  { name: 'NLP Service', status: 'down' },
];

const allDown: ServiceHealth[] = [
  { name: 'API Gateway', status: 'down' },
  { name: 'STT Service', status: 'down' },
  { name: 'TTS Service', status: 'down' },
  { name: 'NLP Service', status: 'down' },
];

const meta = {
  title: 'Custom/ServiceStatusBar',
  component: ServiceStatusBar,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    activeSessions: {
      control: { type: 'number', min: 0, max: 100 },
      description: 'Number of active sessions',
    },
    processingJobs: {
      control: { type: 'number', min: 0, max: 100 },
      description: 'Number of processing jobs',
    },
    isLoading: {
      control: 'boolean',
      description: 'Whether service data is loading',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[520px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ServiceStatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllHealthy: Story = {
  args: {
    services: allHealthy,
    activeSessions: 12,
    processingJobs: 3,
    onRefresh: () => console.log('Refresh'),
  },
};

export const MixedStatus: Story = {
  args: {
    services: mixed,
    activeSessions: 5,
    processingJobs: 1,
    onRefresh: () => console.log('Refresh'),
  },
};

export const AllDown: Story = {
  args: {
    services: allDown,
    activeSessions: 0,
    processingJobs: 0,
    onRefresh: () => console.log('Refresh'),
  },
};

export const Loading: Story = {
  args: {
    isLoading: true,
  },
};

export const NoServices: Story = {
  args: {
    services: [],
  },
};

export const WithUnknown: Story = {
  args: {
    services: [
      { name: 'API Gateway', status: 'healthy', latency: 42 },
      { name: 'New Service', status: 'unknown' },
    ],
    activeSessions: 1,
    processingJobs: 0,
  },
};

export const WithoutRefresh: Story = {
  args: {
    services: allHealthy,
    activeSessions: 8,
    processingJobs: 2,
  },
};
