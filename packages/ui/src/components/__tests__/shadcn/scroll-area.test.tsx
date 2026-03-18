import { test, expect } from '@playwright/experimental-ct-react'
import { ScrollArea, ScrollBar } from '../../shadcn/scroll-area'

test.describe('ScrollArea', () => {
  test.describe('rendering', () => {
    test('renders with default props', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <p>Content</p>
        </ScrollArea>
      )
      await expect(component).toBeVisible()
    })

    test('has data-slot="scroll-area"', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <p>Content</p>
        </ScrollArea>
      )
      await expect(component).toHaveAttribute('data-slot', 'scroll-area')
    })
  })

  test.describe('children', () => {
    test('renders children content', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <p>Hello World</p>
        </ScrollArea>
      )
      await expect(component.locator('p')).toHaveText('Hello World')
    })

    test('renders multiple children', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <p>First</p>
          <p>Second</p>
          <p>Third</p>
        </ScrollArea>
      )
      const paragraphs = component.locator('p')
      await expect(paragraphs).toHaveCount(3)
    })

    test('renders complex children', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <div>
            <h2>Title</h2>
            <ul>
              <li>Item 1</li>
              <li>Item 2</li>
            </ul>
          </div>
        </ScrollArea>
      )
      await expect(component.locator('h2')).toHaveText('Title')
      await expect(component.locator('li')).toHaveCount(2)
    })
  })

  test.describe('viewport', () => {
    test('scroll-area-viewport is present', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <p>Content</p>
        </ScrollArea>
      )
      const viewport = component.locator('[data-slot="scroll-area-viewport"]')
      await expect(viewport).toBeVisible()
    })

    test('viewport has data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <p>Content</p>
        </ScrollArea>
      )
      const viewport = component.locator('[data-slot="scroll-area-viewport"]')
      await expect(viewport).toHaveAttribute(
        'data-slot',
        'scroll-area-viewport'
      )
    })

    test('viewport contains children', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <p>Inside viewport</p>
        </ScrollArea>
      )
      const viewport = component.locator('[data-slot="scroll-area-viewport"]')
      await expect(viewport.locator('p')).toHaveText('Inside viewport')
    })
  })

  test.describe('styling', () => {
    test('ScrollArea has relative class', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <p>Content</p>
        </ScrollArea>
      )
      await expect(component).toHaveClass(/relative/)
    })

    test('viewport has size-full class', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <p>Content</p>
        </ScrollArea>
      )
      const viewport = component.locator('[data-slot="scroll-area-viewport"]')
      await expect(viewport).toHaveClass(/size-full/)
    })

    test('viewport inherits border radius', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <p>Content</p>
        </ScrollArea>
      )
      const viewport = component.locator('[data-slot="scroll-area-viewport"]')
      await expect(viewport).toHaveClass(/rounded-\[inherit\]/)
    })
  })

  test.describe('custom className', () => {
    test('accepts custom className', async ({ mount }) => {
      const component = await mount(
        <ScrollArea className="custom-scroll">
          <p>Content</p>
        </ScrollArea>
      )
      await expect(component).toHaveClass(/custom-scroll/)
    })

    test('merges custom className with defaults', async ({ mount }) => {
      const component = await mount(
        <ScrollArea className="custom-scroll">
          <p>Content</p>
        </ScrollArea>
      )
      await expect(component).toHaveClass(/relative/)
      await expect(component).toHaveClass(/custom-scroll/)
    })
  })

  test.describe('composition', () => {
    test('wraps content in viewport', async ({ mount }) => {
      const component = await mount(
        <ScrollArea>
          <div data-testid="inner">Wrapped</div>
        </ScrollArea>
      )
      const viewport = component.locator('[data-slot="scroll-area-viewport"]')
      const inner = viewport.locator('[data-testid="inner"]')
      await expect(inner).toHaveText('Wrapped')
    })

  })
})
