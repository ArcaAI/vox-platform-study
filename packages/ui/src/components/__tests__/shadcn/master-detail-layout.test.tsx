import { test, expect } from '@playwright/experimental-ct-react';
import {
  MasterDetailRoot,
  MasterDetailColumn,
  MasterDetailColumnHeader,
  MasterDetailColumnTitle,
  MasterDetailColumnDescription,
  MasterDetailItem,
  MasterDetailSkeleton,
  MasterDetailEmpty,
} from '../../shadcn/master-detail-layout';
import {
  ComposedFruitMasterDetail,
  EmptyFruitMasterDetail,
  FruitMasterDetail,
  InteractiveFruitMasterDetail,
  LoadingFruitMasterDetail,
  TwoColumnFruitMasterDetail,
} from '../fixtures/shadcn/master-detail-layout-fixtures';

// Column definitions carry `renderItem`/`keyExtractor` render props. Playwright
// CT proxies function props as async RPC to Node, so such a callback returns a
// Promise in the browser and React throws on it — taking the whole mount down.
// Every `MasterDetailLayout`/`MasterDetailComposed` case therefore lives in the
// browser-bundled fixture module and is driven by serializable props only.

// ---------------------------------------------------------------------------
// Sub-component tests
// ---------------------------------------------------------------------------

test.describe('MasterDetailRoot', () => {
  test('renders with data-slot attribute', async ({ mount }) => {
    const c = await mount(<MasterDetailRoot>content</MasterDetailRoot>);
    await expect(c).toHaveAttribute('data-slot', 'master-detail');
  });

  test('applies custom className', async ({ mount }) => {
    const c = await mount(<MasterDetailRoot className="custom-root">content</MasterDetailRoot>);
    await expect(c).toHaveClass(/custom-root/);
  });

  test('has grid and border styling', async ({ mount }) => {
    const c = await mount(<MasterDetailRoot>content</MasterDetailRoot>);
    await expect(c).toHaveClass(/grid/);
    await expect(c).toHaveClass(/rounded-surface/);
    await expect(c).toHaveClass(/border/);
  });
});

test.describe('MasterDetailColumn', () => {
  test('renders with data-slot attribute', async ({ mount }) => {
    const c = await mount(<MasterDetailColumn>column</MasterDetailColumn>);
    await expect(c).toHaveAttribute('data-slot', 'master-detail-column');
  });

  test('has border-r when not last', async ({ mount }) => {
    const c = await mount(<MasterDetailColumn isLast={false}>column</MasterDetailColumn>);
    await expect(c).toHaveClass(/border-r/);
  });

  test('no border-r when last', async ({ mount }) => {
    const c = await mount(<MasterDetailColumn isLast>column</MasterDetailColumn>);
    await expect(c).not.toHaveClass(/border-r/);
  });
});

test.describe('MasterDetailColumnHeader', () => {
  test('renders with data-slot and border-b', async ({ mount }) => {
    const c = await mount(<MasterDetailColumnHeader>header</MasterDetailColumnHeader>);
    await expect(c).toHaveAttribute('data-slot', 'master-detail-column-header');
    await expect(c).toHaveClass(/border-b/);
  });
});

test.describe('MasterDetailColumnTitle', () => {
  test('renders with data-slot and font-medium', async ({ mount }) => {
    const c = await mount(<MasterDetailColumnTitle>Title</MasterDetailColumnTitle>);
    await expect(c).toHaveAttribute('data-slot', 'master-detail-column-title');
    await expect(c).toHaveClass(/font-medium/);
    await expect(c).toHaveText('Title');
  });
});

test.describe('MasterDetailColumnDescription', () => {
  test('renders with data-slot and muted styling', async ({ mount }) => {
    const c = await mount(<MasterDetailColumnDescription>desc</MasterDetailColumnDescription>);
    await expect(c).toHaveAttribute('data-slot', 'master-detail-column-description');
    await expect(c).toHaveClass(/text-muted-foreground/);
  });
});

test.describe('MasterDetailItem', () => {
  test('renders with button semantics and data-slot', async ({ mount }) => {
    const c = await mount(<MasterDetailItem>item</MasterDetailItem>);
    await expect(c).toHaveAttribute('data-slot', 'master-detail-item');
    await expect(c).toHaveAttribute('role', 'button');
    await expect(c).toHaveAttribute('tabindex', '0');
  });

  test('applies selected styling via data-selected', async ({ mount }) => {
    const c = await mount(<MasterDetailItem isSelected>item</MasterDetailItem>);
    await expect(c).toHaveAttribute('data-selected', 'true');
    await expect(c).toHaveClass(/bg-accent/);
    await expect(c).toHaveClass(/border-l-primary/);
  });

  test('no data-selected when not selected', async ({ mount }) => {
    const c = await mount(<MasterDetailItem isSelected={false}>item</MasterDetailItem>);
    await expect(c).not.toHaveAttribute('data-selected');
  });

  test('triggers onClick with keyboard Enter/Space', async ({ mount, page }) => {
    let count = 0;
    await mount(
      <MasterDetailItem
        onClick={() => {
          count += 1;
        }}
      >
        item
      </MasterDetailItem>,
    );

    const item = page.locator('[data-slot="master-detail-item"]');
    await item.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');

    expect(count).toBe(2);
  });
});

test.describe('MasterDetailSkeleton', () => {
  test('renders correct number of skeletons', async ({ mount }) => {
    const c = await mount(<MasterDetailSkeleton count={5} />);
    await expect(c).toHaveAttribute('data-slot', 'master-detail-skeleton');
    const skeletons = c.locator('[data-slot="skeleton"]');
    await expect(skeletons).toHaveCount(5);
  });

  test('defaults to 3 skeletons', async ({ mount }) => {
    const c = await mount(<MasterDetailSkeleton />);
    const skeletons = c.locator('[data-slot="skeleton"]');
    await expect(skeletons).toHaveCount(3);
  });

  test('applies custom height class', async ({ mount }) => {
    const c = await mount(<MasterDetailSkeleton count={1} height="h-20" />);
    const skeleton = c.locator('[data-slot="skeleton"]').first();
    await expect(skeleton).toHaveClass(/h-20/);
  });
});

test.describe('MasterDetailEmpty', () => {
  test('renders title and description', async ({ mount }) => {
    const c = await mount(<MasterDetailEmpty title="No items" description="Nothing to show." />);
    await expect(c.locator('[data-slot="empty-title"]')).toHaveText('No items');
    await expect(c.locator('[data-slot="empty-description"]')).toHaveText('Nothing to show.');
  });

  test('renders icon when provided', async ({ mount }) => {
    const c = await mount(<MasterDetailEmpty icon={<svg data-testid="test-icon" />} title="Empty" />);
    await expect(c.locator('[data-testid="test-icon"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// MasterDetailLayout (composed) tests
// ---------------------------------------------------------------------------

test.describe('MasterDetailLayout', () => {
  test('renders correct number of columns', async ({ mount, page }) => {
    await mount(<TwoColumnFruitMasterDetail />);

    const cols = page.locator('[data-slot="master-detail-column"]');
    await expect(cols).toHaveCount(2);
  });

  test('renders items in list column', async ({ mount, page }) => {
    await mount(<FruitMasterDetail />);

    const items = page.locator('[data-slot="master-detail-item"]');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText('Apple');
  });

  test('shows skeletons when loading', async ({ mount, page }) => {
    await mount(<LoadingFruitMasterDetail skeletonCount={4} />);

    const skeletons = page.locator('[data-slot="skeleton"]');
    await expect(skeletons).toHaveCount(4);
  });

  test('shows empty state when no data and not loading', async ({ mount, page }) => {
    await mount(<EmptyFruitMasterDetail />);

    await expect(page.locator('[data-slot="empty-title"]')).toHaveText('No fruits');
  });

  test('shows disabled empty state when enabled=false', async ({ mount, page }) => {
    await mount(<EmptyFruitMasterDetail emptyTitle="No selection" emptyDescription="Select an item first." enabled={false} />);

    await expect(page.locator('[data-slot="empty-title"]')).toHaveText('No selection');
  });

  test('marks selected item with data-selected', async ({ mount, page }) => {
    await mount(<FruitMasterDetail selectedId="banana" />);

    const selected = page.locator('[data-slot="master-detail-item"][data-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toContainText('Banana');
  });

  test('calls onSelect when item is clicked', async ({ mount, page }) => {
    await mount(<InteractiveFruitMasterDetail />);

    await page.locator('[data-testid="fruits-item-cherry"]').click();
    await expect(page.locator('[data-testid="selected-fruit"]')).toHaveText('cherry');
  });

  test('renders column headers with title and description', async ({ mount, page }) => {
    await mount(<FruitMasterDetail />);

    await expect(page.locator('[data-slot="master-detail-column-title"]')).toHaveText('Fruits');
    await expect(page.locator('[data-slot="master-detail-column-description"]')).toHaveText('3 total');
  });
});

// ---------------------------------------------------------------------------
// MasterDetailComposed (with detail column) tests
// ---------------------------------------------------------------------------

test.describe('MasterDetailComposed', () => {
  test('renders list columns + detail column', async ({ mount, page }) => {
    await mount(<ComposedFruitMasterDetail selectedId="apple" hasSelection detailDescription="Fruit detail" />);

    const cols = page.locator('[data-slot="master-detail-column"]');
    await expect(cols).toHaveCount(2);
    await expect(page.locator('[data-testid="detail-content"]')).toHaveText('Apple detail');
  });

  test('shows empty state in detail when no selection', async ({ mount, page }) => {
    await mount(<ComposedFruitMasterDetail detailEmptyTitle="Nothing selected" detailEmptyDescription="Pick a fruit." />);

    await expect(page.locator('[data-slot="empty-title"]').last()).toHaveText('Nothing selected');
  });

  test('last column has no border-r', async ({ mount, page }) => {
    await mount(<ComposedFruitMasterDetail />);

    const cols = page.locator('[data-slot="master-detail-column"]');
    const lastCol = cols.last();
    await expect(lastCol).not.toHaveClass(/border-r/);
  });
});
