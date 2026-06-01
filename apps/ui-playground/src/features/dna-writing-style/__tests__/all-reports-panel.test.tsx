import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AllReportsPanel } from '../components/all-reports-panel'
import type { DnaReport, DnaStyleVersion } from '../api/dna-writing-styles'

const MOCK_REPORTS: DnaReport[] = [
  {
    id: 'report-1',
    doctorId: 'doctor-aaa',
    reportData: { tone: 'Professional', vocabulary: 'Technical', formality: 'Formal' },
    styleText: 'Concise clinical documentation style.',
    isLatest: true,
    currentVersionNumber: 3,
    resourceStatus: 'ENABLED',
    createdAt: '2025-12-01T10:00:00Z',
    updatedAt: '2025-12-15T14:00:00Z',
  },
  {
    id: 'report-2',
    doctorId: 'doctor-bbb',
    reportData: { tone: 'Empathetic', vocabulary: 'Simple' },
    styleText: 'Patient-friendly narrative style.',
    isLatest: true,
    currentVersionNumber: 1,
    resourceStatus: 'ENABLED',
    createdAt: '2025-11-20T09:00:00Z',
    updatedAt: '2025-11-20T09:00:00Z',
  },
]

const MOCK_VERSIONS: DnaStyleVersion[] = [
  {
    id: 'ver-3',
    dnaReportId: 'report-1',
    versionNumber: 3,
    reportData: { tone: 'Professional', vocabulary: 'Technical', formality: 'Formal' },
    styleText: 'Concise clinical documentation style.',
    changeReason: 'Refined tone after review',
    changedBy: 'admin-user',
    createdAt: '2025-12-15T14:00:00Z',
  },
  {
    id: 'ver-2',
    dnaReportId: 'report-1',
    versionNumber: 2,
    reportData: { tone: 'Professional', vocabulary: 'Moderate' },
    styleText: 'Clinical documentation style.',
    changeReason: 'Updated vocabulary level',
    changedBy: 'admin-user',
    createdAt: '2025-12-10T10:00:00Z',
  },
  {
    id: 'ver-1',
    dnaReportId: 'report-1',
    versionNumber: 1,
    reportData: { tone: 'Neutral' },
    styleText: 'Initial generated style.',
    changeReason: null,
    changedBy: null,
    createdAt: '2025-12-01T10:00:00Z',
  },
]

vi.mock('@arcaai/ui/badge', () => ({
  Badge: ({ children, ...props }: any) => <span data-testid="badge" {...props}>{children}</span>,
}))
vi.mock('@arcaai/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}))
vi.mock('@arcaai/ui/skeleton', () => ({
  Skeleton: (props: any) => <div data-testid="skeleton" {...props} />,
}))
vi.mock('@arcaai/ui/separator', () => ({
  Separator: (props: any) => <hr {...props} />,
}))
vi.mock('@arcaai/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, size, ...props }: any) => (
    <button type="button" data-testid="switch" {...props} />
  ),
}))

// The ui-playground vitest config stubs every @arcaai/ui/* import, so the
// MultiColumnLayout primitive must be mocked here. This lightweight mock
// drives the same callbacks/render-props the real component exposes and emits
// the data-testids these tests assert on (`<id>-column`, `report-item-*`,
// `version-item-*`, `detail-column`).
vi.mock('@arcaai/ui/multi-column-layout', () => {
  const renderColumn = (col: any, state: any, itemTestIdPrefix: string) => {
    let body: any
    if (state.isLoading) {
      body = Array.from({ length: col.skeletonCount ?? 3 }).map((_, i) => <div key={`sk-${i}`} data-testid="skeleton" />)
    } else if (state.enabled === false || (state.data?.length ?? 0) === 0) {
      body = (
        <div>
          <p>{col.emptyTitle}</p>
          <p>{col.emptyDescription}</p>
        </div>
      )
    } else {
      body = state.data.map((item: any) => {
        const key = col.keyExtractor(item)
        return (
          <div
            key={key}
            data-testid={`${itemTestIdPrefix}-${key}`}
            className={state.selectedId === key ? 'bg-accent' : ''}
            onClick={() => state.onSelect?.(key)}
          >
            {col.renderItem(item)}
          </div>
        )
      })
    }
    return (
      <div data-testid={`${col.id}-column`}>{body}</div>
    )
  }

  return {
    MultiColumnLayout: ({ columns, columnStates, detailColumn, detailState }: any) => (
      <div data-testid="multi-column-layout">
        {renderColumn(columns[0], columnStates[0], 'report-item')}
        {renderColumn(columns[1], columnStates[1], 'version-item')}
        <div data-testid="detail-column">
          {detailState?.hasSelection ? (
            detailState.content
          ) : (
            <div>
              <p>{detailColumn?.emptyTitle}</p>
              <p>{detailColumn?.emptyDescription}</p>
            </div>
          )}
        </div>
      </div>
    ),
  }
})

describe('AllReportsPanel', () => {
  describe('Column 1 — Reports List', () => {
    it('should render all reports in the list', () => {
      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={[]}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId={null}
          selectedVersionId={null}
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      expect(screen.getByText(/doctor-aaa/i)).toBeInTheDocument()
      expect(screen.getByText(/doctor-bbb/i)).toBeInTheDocument()
    })

    it('should show version number for each report', () => {
      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={[]}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId={null}
          selectedVersionId={null}
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      expect(screen.getByText(/v3/)).toBeInTheDocument()
      expect(screen.getByText(/v1/)).toBeInTheDocument()
    })

    it('should call onSelectReport when a report is clicked', async () => {
      const onSelectReport = vi.fn()
      const user = userEvent.setup()

      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={[]}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId={null}
          selectedVersionId={null}
          onSelectReport={onSelectReport}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      await user.click(screen.getByText(/doctor-aaa/i))
      expect(onSelectReport).toHaveBeenCalledWith('report-1')
    })

    it('should highlight the selected report', () => {
      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={[]}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId="report-1"
          selectedVersionId={null}
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      const reportItem = screen.getByTestId('report-item-report-1')
      expect(reportItem.className).toContain('bg-accent')
    })

    it('should show loading skeletons when isLoadingReports is true', () => {
      render(
        <AllReportsPanel
          reports={[]}
          versions={[]}
          isLoadingReports={true}
          isLoadingVersions={false}
          selectedReportId={null}
          selectedVersionId={null}
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      expect(screen.getAllByTestId('skeleton').length).toBeGreaterThanOrEqual(3)
    })

    it('should show empty state when no reports exist', () => {
      render(
        <AllReportsPanel
          reports={[]}
          versions={[]}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId={null}
          selectedVersionId={null}
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      expect(screen.getByText(/no reports/i)).toBeInTheDocument()
    })
  })

  describe('Column 2 — Versions List', () => {
    it('should show placeholder when no report is selected', () => {
      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={[]}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId={null}
          selectedVersionId={null}
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      const col = screen.getByTestId('versions-column')
      expect(within(col).getByText(/select a report to view its version history/i)).toBeInTheDocument()
    })

    it('should render versions when a report is selected', () => {
      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={MOCK_VERSIONS}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId="report-1"
          selectedVersionId={null}
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      const col = screen.getByTestId('versions-column')
      expect(within(col).getByText(/Refined tone after review/)).toBeInTheDocument()
      expect(screen.getByTestId('version-item-ver-3')).toBeInTheDocument()
      expect(screen.getByTestId('version-item-ver-2')).toBeInTheDocument()
    })

    it('should call onSelectVersion when a version is clicked', async () => {
      const onSelectVersion = vi.fn()
      const user = userEvent.setup()

      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={MOCK_VERSIONS}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId="report-1"
          selectedVersionId={null}
          onSelectReport={vi.fn()}
          onSelectVersion={onSelectVersion}
          doctors={[]}
        />,
      )

      await user.click(screen.getByTestId('version-item-ver-3'))
      expect(onSelectVersion).toHaveBeenCalledWith('ver-3')
    })

    it('should show loading skeletons when isLoadingVersions is true', () => {
      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={[]}
          isLoadingReports={false}
          isLoadingVersions={true}
          selectedReportId="report-1"
          selectedVersionId={null}
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      const versionsColumn = screen.getByTestId('versions-column')
      expect(within(versionsColumn).getAllByTestId('skeleton').length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('Column 3 — Version Detail', () => {
    it('should show placeholder when no version is selected', () => {
      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={MOCK_VERSIONS}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId="report-1"
          selectedVersionId={null}
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      const col = screen.getByTestId('detail-column')
      expect(within(col).getByText(/select a version to view its full details/i)).toBeInTheDocument()
    })

    it('should display version detail when a version is selected', () => {
      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={MOCK_VERSIONS}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId="report-1"
          selectedVersionId="ver-3"
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      const col = screen.getByTestId('detail-column')
      expect(within(col).getByText(/Concise clinical documentation style/)).toBeInTheDocument()
      expect(within(col).getByText(/Change Reason/i)).toBeInTheDocument()
    })

    it('should show style attributes in the detail view', () => {
      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={MOCK_VERSIONS}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId="report-1"
          selectedVersionId="ver-3"
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={[]}
        />,
      )

      const col = screen.getByTestId('detail-column')
      expect(within(col).getByText('Technical')).toBeInTheDocument()
      expect(within(col).getByText('Formal')).toBeInTheDocument()
    })
  })

  describe('Doctor name resolution', () => {
    it('should display doctor username when doctors list is provided', () => {
      const doctors = [
        { id: 'doctor-aaa', username: 'Dr. Smith', email: 'smith@test.com', roles: [], permissions: [], isServiceAccount: false },
      ]

      render(
        <AllReportsPanel
          reports={MOCK_REPORTS}
          versions={[]}
          isLoadingReports={false}
          isLoadingVersions={false}
          selectedReportId={null}
          selectedVersionId={null}
          onSelectReport={vi.fn()}
          onSelectVersion={vi.fn()}
          doctors={doctors as any}
        />,
      )

      expect(screen.getByText('Dr. Smith')).toBeInTheDocument()
    })
  })
})
