import { test, expect } from '@playwright/experimental-ct-react'
import {
  MasterDetailLayout,
  MasterDetailComposed,
  MasterDetailRoot,
  MasterDetailColumn,
  MasterDetailColumnHeader,
  MasterDetailColumnTitle,
  MasterDetailColumnDescription,
  MasterDetailItem,
  MasterDetailSkeleton,
  MasterDetailEmpty,
  type MasterDetailColumnDefinition,
  type MasterDetailColumnState,
} from '../../shadcn/master-detail-layout'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FruitItem {
  id: string
  name: string
}

const fruits: FruitItem[] = [
  { id: 'apple', name: 'Apple' },
  { id: 'banana', name: 'Banana' },
  { id: 'cherry', name: 'Cherry' },
]

const fruitColumn: MasterDetailColumnDefinition<FruitItem> = {
  id: 'fruits',
  title: 'Fruits',
  description: '3 total',
  skeletonCount: 3,
  emptyTitle: 'No fruits',
  emptyDescription: 'No fruits found.',
  renderItem: (item) => <span>{item.name}</span>,
  keyExtractor: (item) => item.id,
}

// ---------------------------------------------------------------------------
// Sub-component tests
// ---------------------------------------------------------------------------

test.describe('MasterDetailRoot', () => {
  test('renders with data-slot attribute', async ({ mount }) => {
    const c = await mount(<MasterDetailRoot>content</MasterDetailRoot>)
    await expect(c).toHaveAttribute('data-slot', 'master-detail')
  })

  test('applies custom className', async ({ mount }) => {
    const c = await mount(
      <MasterDetailRoot className="custom-root">content</MasterDetailRoot>
    )
    await expect(c).toHaveClass(/custom-root/)
  })

  test('has grid and border styling', async ({ mount }) => {
    const c = await mount(<MasterDetailRoot>content</MasterDetailRoot>)
    await expect(c).toHaveClass(/grid/)
    await expect(c).toHaveClass(/rounded-lg/)
    await expect(c).toHaveClass(/border/)
  })
})

test.describe('MasterDetailColumn', () => {
  test('renders with data-slot attribute', async ({ mount }) => {
    const c = await mount(
      <MasterDetailColumn>column</MasterDetailColumn>
    )
    await expect(c).toHaveAttribute('data-slot', 'master-detail-column')
  })

  test('has border-r when not last', async ({ mount }) => {
    const c = await mount(
      <MasterDetailColumn isLast={false}>column</MasterDetailColumn>
    )
    await expect(c).toHaveClass(/border-r/)
  })

  test('no border-r when last', async ({ mount }) => {
    const c = await mount(
      <MasterDetailColumn isLast>column</MasterDetailColumn>
    )
    await expect(c).not.toHaveClass(/border-r/)
  })
})

test.describe('MasterDetailColumnHeader', () => {
  test('renders with data-slot and border-b', async ({ mount }) => {
    const c = await mount(
      <MasterDetailColumnHeader>header</MasterDetailColumnHeader>
    )
    await expect(c).toHaveAttribute(
      'data-slot',
      'master-detail-column-header'
    )
    await expect(c).toHaveClass(/border-b/)
  })
})

test.describe('MasterDetailColumnTitle', () => {
  test('renders with data-slot and font-semibold', async ({ mount }) => {
    const c = await mount(
      <MasterDetailColumnTitle>Title</MasterDetailColumnTitle>
    )
    await expect(c).toHaveAttribute(
      'data-slot',
      'master-detail-column-title'
    )
    await expect(c).toHaveClass(/font-semibold/)
    await expect(c).toHaveText('Title')
  })
})

test.describe('MasterDetailColumnDescription', () => {
  test('renders with data-slot and muted styling', async ({ mount }) => {
    const c = await mount(
      <MasterDetailColumnDescription>desc</MasterDetailColumnDescription>
    )
    await expect(c).toHaveAttribute(
      'data-slot',
      'master-detail-column-description'
    )
    await expect(c).toHaveClass(/text-muted-foreground/)
  })
})

test.describe('MasterDetailItem', () => {
  test('renders with button semantics and data-slot', async ({ mount }) => {
    const c = await mount(
      <MasterDetailItem>item</MasterDetailItem>
    )
    await expect(c).toHaveAttribute('data-slot', 'master-detail-item')
    await expect(c).toHaveAttribute('role', 'button')
    await expect(c).toHaveAttribute('tabindex', '0')
  })

  test('applies selected styling via data-selected', async ({ mount }) => {
    const c = await mount(
      <MasterDetailItem isSelected>item</MasterDetailItem>
    )
    await expect(c).toHaveAttribute('data-selected', 'true')
    await expect(c).toHaveClass(/bg-accent/)
    await expect(c).toHaveClass(/border-l-primary/)
  })

  test('no data-selected when not selected', async ({ mount }) => {
    const c = await mount(
      <MasterDetailItem isSelected={false}>item</MasterDetailItem>
    )
    await expect(c).not.toHaveAttribute('data-selected')
  })

  test('triggers onClick with keyboard Enter/Space', async ({ mount, page }) => {
    let count = 0
    await mount(
      <MasterDetailItem onClick={() => { count += 1 }}>
        item
      </MasterDetailItem>
    )

    const item = page.locator('[data-slot="master-detail-item"]')
    await item.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')

    expect(count).toBe(2)
  })
})

test.describe('MasterDetailSkeleton', () => {
  test('renders correct number of skeletons', async ({ mount }) => {
    const c = await mount(<MasterDetailSkeleton count={5} />)
    await expect(c).toHaveAttribute('data-slot', 'master-detail-skeleton')
    const skeletons = c.locator('[data-slot="skeleton"]')
    await expect(skeletons).toHaveCount(5)
  })

  test('defaults to 3 skeletons', async ({ mount }) => {
    const c = await mount(<MasterDetailSkeleton />)
    const skeletons = c.locator('[data-slot="skeleton"]')
    await expect(skeletons).toHaveCount(3)
  })

  test('applies custom height class', async ({ mount }) => {
    const c = await mount(<MasterDetailSkeleton count={1} height="h-20" />)
    const skeleton = c.locator('[data-slot="skeleton"]').first()
    await expect(skeleton).toHaveClass(/h-20/)
  })
})

test.describe('MasterDetailEmpty', () => {
  test('renders title and description', async ({ mount }) => {
    const c = await mount(
      <MasterDetailEmpty
        title="No items"
        description="Nothing to show."
      />
    )
    await expect(c.locator('[data-slot="empty-title"]')).toHaveText(
      'No items'
    )
    await expect(c.locator('[data-slot="empty-description"]')).toHaveText(
      'Nothing to show.'
    )
  })

  test('renders icon when provided', async ({ mount }) => {
    const c = await mount(
      <MasterDetailEmpty
        icon={<svg data-testid="test-icon" />}
        title="Empty"
      />
    )
    await expect(c.locator('[data-testid="test-icon"]')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// MasterDetailLayout (composed) tests
// ---------------------------------------------------------------------------

test.describe('MasterDetailLayout', () => {
  test('renders correct number of columns', async ({ mount, page }) => {
    const columns: MasterDetailColumnDefinition<FruitItem>[] = [
      fruitColumn,
      { ...fruitColumn, id: 'col2', title: 'Column 2' },
    ]
    const states: MasterDetailColumnState<FruitItem>[] = [
      {
        data: fruits,
        isLoading: false,
        selectedId: null,
        onSelect: () => {},
      },
      {
        data: [],
        isLoading: false,
        selectedId: null,
        onSelect: () => {},
        enabled: true,
      },
    ]

    await mount(
      <MasterDetailLayout columns={columns} states={states} />
    )

    const cols = page.locator('[data-slot="master-detail-column"]')
    await expect(cols).toHaveCount(2)
  })

  test('renders items in list column', async ({ mount, page }) => {
    const columns: MasterDetailColumnDefinition<FruitItem>[] = [fruitColumn]
    const states: MasterDetailColumnState<FruitItem>[] = [
      {
        data: fruits,
        isLoading: false,
        selectedId: null,
        onSelect: () => {},
      },
    ]

    await mount(
      <MasterDetailLayout columns={columns} states={states} />
    )

    const items = page.locator('[data-slot="master-detail-item"]')
    await expect(items).toHaveCount(3)
    await expect(items.first()).toContainText('Apple')
  })

  test('shows skeletons when loading', async ({ mount, page }) => {
    const columns: MasterDetailColumnDefinition<FruitItem>[] = [
      { ...fruitColumn, skeletonCount: 4 },
    ]
    const states: MasterDetailColumnState<FruitItem>[] = [
      {
        data: [],
        isLoading: true,
        selectedId: null,
        onSelect: () => {},
      },
    ]

    await mount(
      <MasterDetailLayout columns={columns} states={states} />
    )

    const skeletons = page.locator('[data-slot="skeleton"]')
    await expect(skeletons).toHaveCount(4)
  })

  test('shows empty state when no data and not loading', async ({
    mount,
    page,
  }) => {
    const columns: MasterDetailColumnDefinition<FruitItem>[] = [fruitColumn]
    const states: MasterDetailColumnState<FruitItem>[] = [
      {
        data: [],
        isLoading: false,
        selectedId: null,
        onSelect: () => {},
      },
    ]

    await mount(
      <MasterDetailLayout columns={columns} states={states} />
    )

    await expect(page.locator('[data-slot="empty-title"]')).toHaveText(
      'No fruits'
    )
  })

  test('shows disabled empty state when enabled=false', async ({
    mount,
    page,
  }) => {
    const columns: MasterDetailColumnDefinition<FruitItem>[] = [
      {
        ...fruitColumn,
        emptyTitle: 'No selection',
        emptyDescription: 'Select an item first.',
      },
    ]
    const states: MasterDetailColumnState<FruitItem>[] = [
      {
        data: [],
        isLoading: false,
        selectedId: null,
        onSelect: () => {},
        enabled: false,
      },
    ]

    await mount(
      <MasterDetailLayout columns={columns} states={states} />
    )

    await expect(page.locator('[data-slot="empty-title"]')).toHaveText(
      'No selection'
    )
  })

  test('marks selected item with data-selected', async ({ mount, page }) => {
    const columns: MasterDetailColumnDefinition<FruitItem>[] = [fruitColumn]
    const states: MasterDetailColumnState<FruitItem>[] = [
      {
        data: fruits,
        isLoading: false,
        selectedId: 'banana',
        onSelect: () => {},
      },
    ]

    await mount(
      <MasterDetailLayout columns={columns} states={states} />
    )

    const selected = page.locator(
      '[data-slot="master-detail-item"][data-selected="true"]'
    )
    await expect(selected).toHaveCount(1)
    await expect(selected).toContainText('Banana')
  })

  test('calls onSelect when item is clicked', async ({ mount, page }) => {
    let selectedId = ''
    const columns: MasterDetailColumnDefinition<FruitItem>[] = [fruitColumn]
    const states: MasterDetailColumnState<FruitItem>[] = [
      {
        data: fruits,
        isLoading: false,
        selectedId: null,
        onSelect: (id) => {
          selectedId = id
        },
      },
    ]

    await mount(
      <MasterDetailLayout columns={columns} states={states} />
    )

    await page.locator('[data-testid="fruits-item-cherry"]').click()
    expect(selectedId).toBe('cherry')
  })

  test('renders column headers with title and description', async ({
    mount,
    page,
  }) => {
    const columns: MasterDetailColumnDefinition<FruitItem>[] = [fruitColumn]
    const states: MasterDetailColumnState<FruitItem>[] = [
      {
        data: fruits,
        isLoading: false,
        selectedId: null,
        onSelect: () => {},
      },
    ]

    await mount(
      <MasterDetailLayout columns={columns} states={states} />
    )

    await expect(
      page.locator('[data-slot="master-detail-column-title"]')
    ).toHaveText('Fruits')
    await expect(
      page.locator('[data-slot="master-detail-column-description"]')
    ).toHaveText('3 total')
  })
})

// ---------------------------------------------------------------------------
// MasterDetailComposed (with detail column) tests
// ---------------------------------------------------------------------------

test.describe('MasterDetailComposed', () => {
  test('renders list columns + detail column', async ({ mount, page }) => {
    await mount(
      <MasterDetailComposed
        listColumns={[fruitColumn]}
        listStates={[
          {
            data: fruits,
            isLoading: false,
            selectedId: 'apple',
            onSelect: () => {},
          },
        ]}
        detailColumn={{
          id: 'detail',
          title: 'Detail',
          description: 'Fruit detail',
        }}
        detailState={{
          hasSelection: true,
          content: <div data-testid="detail-content">Apple detail</div>,
        }}
      />
    )

    const cols = page.locator('[data-slot="master-detail-column"]')
    await expect(cols).toHaveCount(2)
    await expect(
      page.locator('[data-testid="detail-content"]')
    ).toHaveText('Apple detail')
  })

  test('shows empty state in detail when no selection', async ({
    mount,
    page,
  }) => {
    await mount(
      <MasterDetailComposed
        listColumns={[fruitColumn]}
        listStates={[
          {
            data: fruits,
            isLoading: false,
            selectedId: null,
            onSelect: () => {},
          },
        ]}
        detailColumn={{
          id: 'detail',
          title: 'Detail',
          emptyTitle: 'Nothing selected',
          emptyDescription: 'Pick a fruit.',
        }}
        detailState={{
          hasSelection: false,
          content: null,
        }}
      />
    )

    await expect(page.locator('[data-slot="empty-title"]').last()).toHaveText(
      'Nothing selected'
    )
  })

  test('last column has no border-r', async ({ mount, page }) => {
    await mount(
      <MasterDetailComposed
        listColumns={[fruitColumn]}
        listStates={[
          {
            data: fruits,
            isLoading: false,
            selectedId: null,
            onSelect: () => {},
          },
        ]}
        detailColumn={{ id: 'detail', title: 'Detail' }}
        detailState={{ hasSelection: false, content: null }}
      />
    )

    const cols = page.locator('[data-slot="master-detail-column"]')
    const lastCol = cols.last()
    await expect(lastCol).not.toHaveClass(/border-r/)
  })
})
