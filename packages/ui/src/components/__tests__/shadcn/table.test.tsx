import { test, expect } from '@playwright/experimental-ct-react';
import { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption } from '../../shadcn/table';

test.describe('Table', () => {
  test.describe('rendering', () => {
    test('renders full table structure', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Alice</TableCell>
              <TableCell>alice@example.com</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      await expect(page.locator('[data-slot="table-container"]')).toBeVisible();
      await expect(page.locator('[data-slot="table"]')).toBeVisible();
      await expect(page.locator('[data-slot="table-header"]')).toBeVisible();
      await expect(page.locator('[data-slot="table-body"]')).toBeVisible();
      await expect(page.locator('[data-slot="table-row"]').first()).toBeVisible();
      await expect(page.locator('[data-slot="table-head"]').first()).toBeVisible();
      await expect(page.locator('[data-slot="table-cell"]').first()).toBeVisible();
    });

    test('all data-slot attributes are present', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableCaption>A list of users</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Alice</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Total: 1</TableCell>
            </TableRow>
          </TableFooter>
        </Table>,
      );

      await expect(page.locator('[data-slot="table-container"]')).toHaveCount(1);
      await expect(page.locator('[data-slot="table"]')).toHaveCount(1);
      await expect(page.locator('[data-slot="table-header"]')).toHaveCount(1);
      await expect(page.locator('[data-slot="table-body"]')).toHaveCount(1);
      await expect(page.locator('[data-slot="table-footer"]')).toHaveCount(1);
      await expect(page.locator('[data-slot="table-caption"]')).toHaveCount(1);
      await expect(page.locator('[data-slot="table-row"]')).toHaveCount(3);
      await expect(page.locator('[data-slot="table-head"]')).toHaveCount(1);
      await expect(page.locator('[data-slot="table-cell"]')).toHaveCount(2);
    });
  });

  test.describe('structure', () => {
    test('table element is inside container div', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const container = page.locator('[data-slot="table-container"]');
      const table = container.locator('table');
      await expect(table).toHaveAttribute('data-slot', 'table');
    });

    test('thead contains tr > th', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Header</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const thead = page.locator('thead');
      const th = thead.locator('tr > th');
      await expect(th).toHaveText('Header');
    });

    test('tbody contains tr > td', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Cell value</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const tbody = page.locator('tbody');
      const td = tbody.locator('tr > td');
      await expect(td).toHaveText('Cell value');
    });

    test('tfoot contains tr > td', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Footer value</TableCell>
            </TableRow>
          </TableFooter>
        </Table>,
      );

      const tfoot = page.locator('tfoot');
      const td = tfoot.locator('tr > td');
      await expect(td).toHaveText('Footer value');
    });

    test('caption is a caption element', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableCaption>Caption text</TableCaption>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const caption = page.locator('caption');
      await expect(caption).toHaveText('Caption text');
    });
  });

  test.describe('styling', () => {
    test('Table has w-full caption-bottom text-sm', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const table = page.locator('[data-slot="table"]');
      await expect(table).toHaveClass(/w-full/);
      await expect(table).toHaveClass(/caption-bottom/);
      await expect(table).toHaveClass(/text-sm/);
    });

    test('container has overflow-x-auto', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const container = page.locator('[data-slot="table-container"]');
      await expect(container).toHaveClass(/overflow-x-auto/);
    });

    test('TableRow has border-b and transition-colors', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const row = page.locator('[data-slot="table-row"]');
      await expect(row).toHaveClass(/border-b/);
      await expect(row).toHaveClass(/transition-colors/);
    });

    test('TableHead has font-medium and text-left', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Header</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const th = page.locator('[data-slot="table-head"]');
      await expect(th).toHaveClass(/font-medium/);
      await expect(th).toHaveClass(/text-left/);
    });

    test('TableCaption has text-muted-foreground and text-sm', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableCaption>Caption</TableCaption>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const caption = page.locator('[data-slot="table-caption"]');
      await expect(caption).toHaveClass(/text-muted-foreground/);
      await expect(caption).toHaveClass(/text-sm/);
    });

    test('TableFooter has bg-muted/50 border-t font-medium', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Footer</TableCell>
            </TableRow>
          </TableFooter>
        </Table>,
      );

      const footer = page.locator('[data-slot="table-footer"]');
      await expect(footer).toHaveClass(/border-t/);
      await expect(footer).toHaveClass(/font-medium/);
    });
  });

  test.describe('composition', () => {
    test('renders full table with header, body, footer, and caption', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableCaption>Monthly expenses</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Rent</TableCell>
              <TableCell>$1,200</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Food</TableCell>
              <TableCell>$400</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Total</TableCell>
              <TableCell>$1,600</TableCell>
            </TableRow>
          </TableFooter>
        </Table>,
      );

      await expect(page.locator('[data-slot="table-caption"]')).toHaveText('Monthly expenses');
      await expect(page.locator('[data-slot="table-head"]')).toHaveCount(2);
      await expect(page.locator('[data-slot="table-body"] tr')).toHaveCount(2);
      await expect(page.locator('[data-slot="table-footer"] td')).toHaveCount(2);
    });

    test('renders multiple rows with correct content', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Row 1</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Row 2</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Row 3</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const cells = page.locator('[data-slot="table-cell"]');
      await expect(cells).toHaveCount(3);
      await expect(cells.nth(0)).toHaveText('Row 1');
      await expect(cells.nth(1)).toHaveText('Row 2');
      await expect(cells.nth(2)).toHaveText('Row 3');
    });
  });

  test.describe('accessibility', () => {
    test('table element has implicit table role', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      await expect(page.getByRole('table')).toBeVisible();
    });

    test('th elements have implicit columnheader role', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Alice</TableCell>
              <TableCell>alice@example.com</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const columnHeaders = page.getByRole('columnheader');
      await expect(columnHeaders).toHaveCount(2);
      await expect(columnHeaders.nth(0)).toHaveText('Name');
      await expect(columnHeaders.nth(1)).toHaveText('Email');
    });

    test('tr elements have implicit row role', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      await expect(page.getByRole('row')).toBeVisible();
    });

    test('td elements have implicit cell role', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Data</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      await expect(page.getByRole('cell')).toHaveText('Data');
    });

    test('thead has implicit rowgroup role', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Header</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const rowgroups = page.getByRole('rowgroup');
      await expect(rowgroups).toHaveCount(2);
    });
  });

  test.describe('custom className', () => {
    test('Table accepts custom className', async ({ mount, page }) => {
      await mount(
        <Table className="custom-table">
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const table = page.locator('[data-slot="table"]');
      await expect(table).toHaveClass(/custom-table/);
    });

    test('TableHeader accepts custom className', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableHeader className="custom-header">
            <TableRow>
              <TableHead>Header</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const header = page.locator('[data-slot="table-header"]');
      await expect(header).toHaveClass(/custom-header/);
    });

    test('TableBody accepts custom className', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody className="custom-body">
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const body = page.locator('[data-slot="table-body"]');
      await expect(body).toHaveClass(/custom-body/);
    });

    test('TableFooter accepts custom className', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter className="custom-footer">
            <TableRow>
              <TableCell>Footer</TableCell>
            </TableRow>
          </TableFooter>
        </Table>,
      );

      const footer = page.locator('[data-slot="table-footer"]');
      await expect(footer).toHaveClass(/custom-footer/);
    });

    test('TableRow accepts custom className', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow className="custom-row">
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const row = page.locator('[data-slot="table-row"]');
      await expect(row).toHaveClass(/custom-row/);
    });

    test('TableHead accepts custom className', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="custom-head">Header</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const head = page.locator('[data-slot="table-head"]');
      await expect(head).toHaveClass(/custom-head/);
    });

    test('TableCell accepts custom className', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell className="custom-cell">Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const cell = page.locator('[data-slot="table-cell"]');
      await expect(cell).toHaveClass(/custom-cell/);
    });

    test('TableCaption accepts custom className', async ({ mount, page }) => {
      await mount(
        <Table>
          <TableCaption className="custom-caption">Caption</TableCaption>
          <TableBody>
            <TableRow>
              <TableCell>Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      );

      const caption = page.locator('[data-slot="table-caption"]');
      await expect(caption).toHaveClass(/custom-caption/);
    });
  });
});
