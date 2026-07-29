import { test, expect } from '@playwright/experimental-ct-react';
import { AspectRatio } from '../../shadcn/aspect-ratio';

test.describe('AspectRatio', () => {
  test.describe('rendering', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={16 / 9}>
          <div>Content</div>
        </AspectRatio>,
      );
      const root = component.locator('[data-slot="aspect-ratio"]');
      await expect(root).toHaveAttribute('data-slot', 'aspect-ratio');
    });

    test('renders children', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={16 / 9}>
          <div data-testid="child">Child content</div>
        </AspectRatio>,
      );
      const child = component.locator('[data-testid="child"]');
      await expect(child).toBeVisible();
      await expect(child).toHaveText('Child content');
    });

    test('renders with image child', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={16 / 9}>
          <img
            src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"
            alt="test"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AspectRatio>,
      );
      const img = component.locator('img');
      await expect(img).toBeVisible();
      await expect(img).toHaveAttribute('alt', 'test');
    });

    test('renders with multiple children', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={4 / 3}>
          <div data-testid="first">First</div>
          <div data-testid="second">Second</div>
        </AspectRatio>,
      );
      await expect(component.locator('[data-testid="first"]')).toBeVisible();
      await expect(component.locator('[data-testid="second"]')).toBeVisible();
    });
  });

  test.describe('ratio', () => {
    test('applies style for 16:9 ratio', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={16 / 9}>
          <div>Content</div>
        </AspectRatio>,
      );
      const style = await component.getAttribute('style');
      expect(style).toBeTruthy();
    });

    test('applies style for 1:1 ratio', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={1}>
          <div>Square</div>
        </AspectRatio>,
      );
      const style = await component.getAttribute('style');
      expect(style).toBeTruthy();
    });

    test('applies style for 4:3 ratio', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={4 / 3}>
          <div>Content</div>
        </AspectRatio>,
      );
      const style = await component.getAttribute('style');
      expect(style).toBeTruthy();
    });

    test('sets padding-bottom for aspect ratio', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={16 / 9}>
          <div>Content</div>
        </AspectRatio>,
      );
      const style = await component.getAttribute('style');
      expect(style).toContain('padding-bottom');
    });

    test('has position relative for containing children', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={16 / 9}>
          <div>Content</div>
        </AspectRatio>,
      );
      const style = await component.getAttribute('style');
      expect(style).toContain('position');
    });
  });

  test.describe('custom props', () => {
    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={16 / 9} className="custom-ratio">
          <div>Content</div>
        </AspectRatio>,
      );
      const root = component.locator('[data-slot="aspect-ratio"]');
      await expect(root).toHaveClass(/custom-ratio/);
    });

    test('passes through data attributes', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={16 / 9} data-testid="aspect-wrapper">
          <div>Content</div>
        </AspectRatio>,
      );
      const root = component.locator('[data-slot="aspect-ratio"]');
      await expect(root).toHaveAttribute('data-testid', 'aspect-wrapper');
    });

    test('passes through id attribute', async ({ mount }) => {
      const component = await mount(
        <AspectRatio ratio={16 / 9} id="my-aspect-ratio">
          <div>Content</div>
        </AspectRatio>,
      );
      const root = component.locator('[data-slot="aspect-ratio"]');
      await expect(root).toHaveAttribute('id', 'my-aspect-ratio');
    });
  });

  test.describe('composition', () => {
    test('works as image container', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '400px' }}>
          <AspectRatio ratio={16 / 9}>
            <img
              src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"
              alt="landscape"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />
          </AspectRatio>
        </div>,
      );
      const aspectRatio = component.locator('[data-slot="aspect-ratio"]');
      await expect(aspectRatio).toBeVisible();
    });

    test('works as video container placeholder', async ({ mount }) => {
      const component = await mount(
        <div style={{ width: '640px' }}>
          <AspectRatio ratio={16 / 9}>
            <div
              data-testid="video-placeholder"
              style={{
                width: '100%',
                height: '100%',
                background: '#000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              Video Player
            </div>
          </AspectRatio>
        </div>,
      );
      const placeholder = component.locator('[data-testid="video-placeholder"]');
      await expect(placeholder).toBeVisible();
      await expect(placeholder).toHaveText('Video Player');
    });
  });
});
