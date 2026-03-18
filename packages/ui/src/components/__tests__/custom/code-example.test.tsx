import { test, expect } from '@playwright/experimental-ct-react'
import {
  CollapsedCodeExample,
  ExpandedCodeExample,
  PythonCodeExample,
} from '../fixtures/custom/code-example-fixtures'

test.describe('CodeExample', () => {
  test.describe('rendering', () => {
    test('renders collapsed by default', async ({ mount }) => {
      const component = await mount(<CollapsedCodeExample />)
      await expect(component.getByText('Show Example Code')).toBeVisible()
      await expect(component.locator('pre')).toHaveCount(0)
    })

    test('renders expanded when defaultOpen is true', async ({ mount }) => {
      const component = await mount(<ExpandedCodeExample />)
      await expect(component.getByText('Hide Example Code')).toBeVisible()
      await expect(component.locator('pre')).toBeVisible()
    })
  })

  test.describe('toggle behavior', () => {
    test('expands when trigger is clicked', async ({ mount }) => {
      const component = await mount(<CollapsedCodeExample />)
      await component.getByText('Show Example Code').click()
      await expect(component.locator('pre')).toBeVisible()
      await expect(component.getByText('Hide Example Code')).toBeVisible()
    })

    test('collapses when trigger is clicked again', async ({ mount }) => {
      const component = await mount(<ExpandedCodeExample />)
      await component.getByText('Hide Example Code').click()
      await expect(component.locator('pre')).toHaveCount(0)
      await expect(component.getByText('Show Example Code')).toBeVisible()
    })
  })

  test.describe('code display', () => {
    test('displays code content', async ({ mount }) => {
      const component = await mount(<ExpandedCodeExample />)
      await expect(component.locator('code')).toContainText('Hello, world!')
    })

    test('shows title', async ({ mount }) => {
      const component = await mount(<ExpandedCodeExample />)
      await expect(component.getByText('Sample Code')).toBeVisible()
    })

    test('shows language badge', async ({ mount }) => {
      const component = await mount(<ExpandedCodeExample />)
      await expect(component.getByText('typescript')).toBeVisible()
    })

    test('sets data-language attribute on code element', async ({ mount }) => {
      const component = await mount(<ExpandedCodeExample />)
      await expect(component.locator('code')).toHaveAttribute('data-language', 'typescript')
    })

    test('renders python language correctly', async ({ mount }) => {
      const component = await mount(<PythonCodeExample />)
      await component.locator('pre').waitFor({ state: 'visible', timeout: 5000 })
      await expect(component.getByText('python', { exact: true })).toBeVisible()
      await expect(component.locator('code')).toHaveAttribute('data-language', 'python')
    })
  })

  test.describe('copy button', () => {
    test('shows copy button when expanded', async ({ mount }) => {
      const component = await mount(<ExpandedCodeExample />)
      await expect(component.getByLabel('Copy code')).toBeVisible()
    })

    test('copy button is not visible when collapsed', async ({ mount }) => {
      const component = await mount(<CollapsedCodeExample />)
      await expect(component.getByLabel('Copy code')).toHaveCount(0)
    })
  })

  test.describe('accessibility', () => {
    test('trigger button is keyboard accessible', async ({ mount }) => {
      const component = await mount(<CollapsedCodeExample />)
      const trigger = component.getByRole('button', { name: /Show Example Code/ })
      await trigger.focus()
      await expect(trigger).toBeFocused()
      await trigger.press('Enter')
      await expect(component.locator('pre')).toBeVisible()
    })

    test('copy button has aria-label', async ({ mount }) => {
      const component = await mount(<ExpandedCodeExample />)
      await expect(component.getByLabel('Copy code')).toBeVisible()
    })

    test('code is in a pre element for screen readers', async ({ mount }) => {
      const component = await mount(<ExpandedCodeExample />)
      const pre = component.locator('pre')
      await expect(pre).toBeVisible()
      const tagName = await pre.evaluate((el) => el.tagName.toLowerCase())
      expect(tagName).toBe('pre')
    })
  })
})
