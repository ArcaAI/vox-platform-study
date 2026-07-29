import { test, expect } from '@playwright/experimental-ct-react';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from '../../shadcn/pagination';

test.describe('Pagination', () => {
  test.describe('Pagination (root)', () => {
    test('renders as nav element', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="#">1</PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      await expect(component).toBeVisible();
      const tagName = await component.evaluate((el) => el.tagName.toLowerCase());
      expect(tagName).toBe('nav');
    });

    test('has navigation role', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent />
        </Pagination>,
      );
      await expect(component).toHaveRole('navigation');
    });

    test('has aria-label "pagination"', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent />
        </Pagination>,
      );
      await expect(component).toHaveAttribute('aria-label', 'pagination');
    });

    test('has data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent />
        </Pagination>,
      );
      await expect(component).toHaveAttribute('data-slot', 'pagination');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Pagination className="custom-pagination">
          <PaginationContent />
        </Pagination>,
      );
      await expect(component).toHaveClass(/custom-pagination/);
    });

    test('has centered flex layout', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent />
        </Pagination>,
      );
      await expect(component).toHaveClass(/flex/);
      await expect(component).toHaveClass(/justify-center/);
    });
  });

  test.describe('PaginationContent', () => {
    test('renders as ul element', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="#">1</PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const ul = component.locator('[data-slot="pagination-content"]');
      await expect(ul).toBeVisible();
      const tagName = await ul.evaluate((el) => el.tagName.toLowerCase());
      expect(tagName).toBe('ul');
    });

    test('has data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent />
        </Pagination>,
      );
      const content = component.locator('[data-slot="pagination-content"]');
      await expect(content).toHaveAttribute('data-slot', 'pagination-content');
    });

    test('has flex row layout with gap', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent />
        </Pagination>,
      );
      const content = component.locator('[data-slot="pagination-content"]');
      await expect(content).toHaveClass(/flex/);
      await expect(content).toHaveClass(/flex-row/);
      await expect(content).toHaveClass(/items-center/);
    });
  });

  test.describe('PaginationItem', () => {
    test('renders as li element', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="#">1</PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const item = component.locator('[data-slot="pagination-item"]');
      await expect(item).toBeVisible();
      const tagName = await item.evaluate((el) => el.tagName.toLowerCase());
      expect(tagName).toBe('li');
    });
  });

  test.describe('PaginationLink', () => {
    test('renders as anchor element', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="#">1</PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const link = component.locator('[data-slot="pagination-link"]');
      await expect(link).toBeVisible();
      const tagName = await link.evaluate((el) => el.tagName.toLowerCase());
      expect(tagName).toBe('a');
    });

    test('has data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="#">1</PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const link = component.locator('[data-slot="pagination-link"]');
      await expect(link).toHaveAttribute('data-slot', 'pagination-link');
    });

    test('renders inactive link by default', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="#">1</PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const link = component.locator('[data-slot="pagination-link"]');
      await expect(link).not.toHaveAttribute('aria-current');
    });

    test('renders active link with aria-current="page"', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="#" isActive>
                1
              </PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const link = component.locator('[data-slot="pagination-link"]');
      await expect(link).toHaveAttribute('aria-current', 'page');
      await expect(link).toHaveAttribute('data-active', 'true');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="#" className="custom-link">
                1
              </PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const link = component.locator('[data-slot="pagination-link"]');
      await expect(link).toHaveClass(/custom-link/);
    });
  });

  test.describe('PaginationPrevious', () => {
    test('renders with "Go to previous page" aria-label', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const prev = component.locator('[aria-label="Go to previous page"]');
      await expect(prev).toBeVisible();
    });

    test('contains "Previous" text', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const prev = component.locator('[aria-label="Go to previous page"]');
      await expect(prev).toContainText('Previous');
    });
  });

  test.describe('PaginationNext', () => {
    test('renders with "Go to next page" aria-label', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationNext href="#" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const next = component.locator('[aria-label="Go to next page"]');
      await expect(next).toBeVisible();
    });

    test('contains "Next" text', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationNext href="#" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const next = component.locator('[aria-label="Go to next page"]');
      await expect(next).toContainText('Next');
    });
  });

  test.describe('PaginationEllipsis', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const ellipsis = component.locator('[data-slot="pagination-ellipsis"]');
      await expect(ellipsis).toBeVisible();
    });

    test('is hidden from screen readers with aria-hidden', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const ellipsis = component.locator('[data-slot="pagination-ellipsis"]');
      await expect(ellipsis).toHaveAttribute('aria-hidden', 'true');
    });

    test('has sr-only "More pages" text', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );
      const srOnly = component.locator('.sr-only');
      await expect(srOnly).toHaveText('More pages');
    });
  });

  test.describe('full composition', () => {
    test('renders a complete pagination', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#" />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#">1</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" isActive>
                2
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#">3</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
            <PaginationItem>
              <PaginationNext href="#" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );

      const links = component.locator('[data-slot="pagination-link"]');
      await expect(links).toHaveCount(5);

      const activeLink = component.locator('[aria-current="page"]');
      await expect(activeLink).toHaveCount(1);
      await expect(activeLink).toHaveText('2');
    });

    test('multiple page links are independently clickable', async ({ mount }) => {
      const component = await mount(
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="#page1">1</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#page2">2</PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>,
      );

      const firstLink = component.locator('[data-slot="pagination-link"]').first();
      await expect(firstLink).toHaveAttribute('href', '#page1');

      const secondLink = component.locator('[data-slot="pagination-link"]').last();
      await expect(secondLink).toHaveAttribute('href', '#page2');
    });
  });
});
