import type { Meta, StoryObj } from '@storybook/react-vite';

import { IssueReportForm } from '../../../registries/manifest/issue-report-form';

const meta = {
  title: 'Registries/Manifest/IssueReportForm',
  component: IssueReportForm,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof IssueReportForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <IssueReportForm />,
};
