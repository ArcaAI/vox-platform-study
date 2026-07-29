import { test, expect } from '@playwright/experimental-ct-react';
import { ShimmeringText } from '../../elevenlabs/shimmering-text';

test.describe('ShimmeringText', () => {
  test.describe('rendering', () => {
    test('renders text content', async ({ mount }) => {
      const component = await mount(<ShimmeringText text="Hello World" />);
      await expect(component).toBeVisible();
      await expect(component).toHaveText('Hello World');
    });

    test('renders as span element', async ({ mount }) => {
      const component = await mount(<ShimmeringText text="Test" />);
      const tagName = await component.evaluate((el) => el.tagName.toLowerCase());
      expect(tagName).toBe('span');
    });

    test('applies custom className', async ({ mount }) => {
      const component = await mount(<ShimmeringText text="Test" className="custom-shimmer" />);
      await expect(component).toHaveClass(/custom-shimmer/);
    });
  });

  test.describe('styling', () => {
    test('has inline-block display', async ({ mount }) => {
      const component = await mount(<ShimmeringText text="Test" />);
      await expect(component).toHaveClass(/inline-block/);
    });

    test('has text-transparent for gradient clipping', async ({ mount }) => {
      const component = await mount(<ShimmeringText text="Test" />);
      await expect(component).toHaveClass(/text-transparent/);
    });

    test('has bg-clip-text class', async ({ mount }) => {
      const component = await mount(<ShimmeringText text="Test" />);
      await expect(component).toHaveClass(/bg-clip-text/);
    });
  });

  test.describe('props', () => {
    test('applies custom spread via CSS variable', async ({ mount }) => {
      const component = await mount(<ShimmeringText text="Test" spread={4} />);
      await expect(component).toBeVisible();
    });

    test('applies custom color via CSS variable', async ({ mount }) => {
      const component = await mount(<ShimmeringText text="Test" color="#ff0000" />);
      await expect(component).toBeVisible();
    });

    test('applies shimmer color via CSS variable', async ({ mount }) => {
      const component = await mount(<ShimmeringText text="Test" shimmerColor="#00ff00" />);
      await expect(component).toBeVisible();
    });

    test('renders short text', async ({ mount }) => {
      const shortComponent = await mount(<ShimmeringText text="Hi" />);
      await expect(shortComponent).toBeAttached();
      await expect(shortComponent).toContainText('Hi');
    });

    test('renders long text', async ({ mount }) => {
      const longComponent = await mount(<ShimmeringText text="This is a very long text that should still render correctly" />);
      await expect(longComponent).toHaveText('This is a very long text that should still render correctly');
    });
  });
});
