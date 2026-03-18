import { test, expect } from '@playwright/experimental-ct-react'
import {
  LocalToggle,
  RemoteToggle,
  ToggleWithContent,
  InteractiveToggle,
} from '../fixtures/custom/workflow-toggle-fixtures'

test.describe('WorkflowToggle', () => {
  test.describe('rendering', () => {
    test('renders both options', async ({ mount }) => {
      const component = await mount(<LocalToggle />)
      await expect(component.getByText('Local Processing')).toBeVisible()
      await expect(component.getByText('Remote Processing')).toBeVisible()
    })

    test('shows descriptions for each option', async ({ mount }) => {
      const component = await mount(<LocalToggle />)
      await expect(
        component.getByText('Client-side AI models for on-device data processing')
      ).toBeVisible()
      await expect(
        component.getByText('Server-side pipeline managed by tenant administrator')
      ).toBeVisible()
    })

    test('highlights local when mode is local', async ({ mount }) => {
      const component = await mount(<LocalToggle />)
      const localOption = component.locator('[role="radio"][aria-checked="true"]')
      await expect(localOption).toContainText('Local Processing')
    })

    test('highlights remote when mode is remote', async ({ mount }) => {
      const component = await mount(<RemoteToggle />)
      const remoteOption = component.locator('[role="radio"][aria-checked="true"]')
      await expect(remoteOption).toContainText('Remote Processing')
    })
  })

  test.describe('radio group semantics', () => {
    test('has radiogroup role', async ({ mount }) => {
      const component = await mount(<LocalToggle />)
      await expect(component).toHaveAttribute('role', 'radiogroup')
    })

    test('has radiogroup label', async ({ mount }) => {
      const component = await mount(<LocalToggle />)
      await expect(component).toHaveAttribute('role', 'radiogroup')
      await expect(component).toHaveAttribute('aria-label', 'Workflow mode')
    })

    test('options have radio role', async ({ mount }) => {
      const component = await mount(<LocalToggle />)
      const radios = component.getByRole('radio')
      await expect(radios).toHaveCount(2)
    })

    test('selected option has aria-checked true', async ({ mount }) => {
      const component = await mount(<LocalToggle />)
      const localRadio = component.getByRole('radio').filter({ hasText: 'Local Processing' })
      await expect(localRadio).toHaveAttribute('aria-checked', 'true')
    })

    test('unselected option has aria-checked false', async ({ mount }) => {
      const component = await mount(<LocalToggle />)
      const remoteRadio = component.getByRole('radio').filter({ hasText: 'Remote Processing' })
      await expect(remoteRadio).toHaveAttribute('aria-checked', 'false')
    })
  })

  test.describe('conditional content', () => {
    test('shows local content when local is selected', async ({ mount }) => {
      const component = await mount(<ToggleWithContent />)
      await expect(component.locator('[data-testid="local-content"]')).toBeVisible()
      await expect(component.locator('[data-testid="remote-content"]')).toHaveCount(0)
    })

    test('shows remote content when remote is selected', async ({ mount }) => {
      const component = await mount(<InteractiveToggle />)
      await component.getByText('Remote Processing').click()
      await expect(component.locator('[data-testid="remote-content"]')).toBeVisible()
      await expect(component.locator('[data-testid="local-content"]')).toHaveCount(0)
    })
  })

  test.describe('interactions', () => {
    test('clicking remote switches mode', async ({ mount }) => {
      const component = await mount(<InteractiveToggle />)
      await expect(component.locator('[data-testid="current-mode"]')).toHaveText('local')

      await component.getByText('Remote Processing').click()
      await expect(component.locator('[data-testid="current-mode"]')).toHaveText('remote')
    })

    test('clicking local switches back', async ({ mount }) => {
      const component = await mount(<InteractiveToggle />)
      await component.getByText('Remote Processing').click()
      await expect(component.locator('[data-testid="current-mode"]')).toHaveText('remote')

      await component.getByText('Local Processing').click()
      await expect(component.locator('[data-testid="current-mode"]')).toHaveText('local')
    })
  })

  test.describe('visual indicators', () => {
    test('selected option shows filled radio dot', async ({ mount }) => {
      const component = await mount(<LocalToggle />)
      const selectedOption = component.locator('[role="radio"][aria-checked="true"]')
      const dot = selectedOption.locator('.bg-primary').last()
      await expect(dot).toBeVisible()
    })

    test('unselected option does not show filled radio dot', async ({ mount }) => {
      const component = await mount(<LocalToggle />)
      const unselectedOption = component.locator('[role="radio"][aria-checked="false"]')
      const dots = unselectedOption.locator('.size-2.rounded-full.bg-primary')
      await expect(dots).toHaveCount(0)
    })
  })

  test.describe('accessibility', () => {
    test('options are keyboard focusable', async ({ mount }) => {
      const component = await mount(<InteractiveToggle />)
      const remoteOption = component.getByRole('radio').filter({ hasText: 'Remote Processing' })
      await remoteOption.focus()
      await expect(remoteOption).toBeFocused()
    })

    test('options are keyboard activatable', async ({ mount }) => {
      const component = await mount(<InteractiveToggle />)
      const remoteOption = component.getByRole('radio').filter({ hasText: 'Remote Processing' })
      await remoteOption.focus()
      await remoteOption.press('Enter')
      await expect(component.locator('[data-testid="current-mode"]')).toHaveText('remote')
    })
  })
})
