import { test, expect } from '@playwright/experimental-ct-react'
import { RadioGroup, RadioGroupItem } from '../../shadcn/radio-group'
import { BasicRadioGroup } from '../fixtures/shadcn/radio-group-fixtures'

test.describe('RadioGroup', () => {
  test.describe('rendering', () => {
    test('renders all radio items', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const radios = page.getByRole('radio')
      await expect(radios).toHaveCount(3)
    })

    test('RadioGroup has data-slot attribute', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const group = page.locator('[data-slot="radio-group"]')
      await expect(group).toBeVisible()
      await expect(group).toHaveAttribute('data-slot', 'radio-group')
    })

    test('RadioGroupItem has data-slot attribute', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const items = page.locator('[data-slot="radio-group-item"]')
      await expect(items).toHaveCount(3)
      await expect(items.first()).toHaveAttribute(
        'data-slot',
        'radio-group-item'
      )
    })

    test('renders labels for each item', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      await expect(page.getByText('Option 1')).toBeVisible()
      await expect(page.getByText('Option 2')).toBeVisible()
      await expect(page.getByText('Option 3')).toBeVisible()
    })
  })

  test.describe('selection', () => {
    test('default value is selected', async ({ mount, page }) => {
      await mount(<BasicRadioGroup defaultValue="option1" />)
      const firstRadio = page.getByRole('radio', { name: 'Option 1' })
      await expect(firstRadio).toBeChecked()
    })

    test('other items are not selected by default', async ({ mount, page }) => {
      await mount(<BasicRadioGroup defaultValue="option1" />)
      const secondRadio = page.getByRole('radio', { name: 'Option 2' })
      const thirdRadio = page.getByRole('radio', { name: 'Option 3' })
      await expect(secondRadio).not.toBeChecked()
      await expect(thirdRadio).not.toBeChecked()
    })

    test('clicking another item selects it', async ({ mount, page }) => {
      await mount(<BasicRadioGroup defaultValue="option1" />)
      const secondRadio = page.getByRole('radio', { name: 'Option 2' })
      await secondRadio.click()
      await expect(secondRadio).toBeChecked()

      const firstRadio = page.getByRole('radio', { name: 'Option 1' })
      await expect(firstRadio).not.toBeChecked()
    })

    test('only one item can be selected at a time', async ({ mount, page }) => {
      await mount(<BasicRadioGroup defaultValue="option1" />)
      const thirdRadio = page.getByRole('radio', { name: 'Option 3' })
      await thirdRadio.click()

      const checkedRadios = page.getByRole('radio', { checked: true })
      await expect(checkedRadios).toHaveCount(1)
      await expect(thirdRadio).toBeChecked()
    })
  })

  test.describe('keyboard', () => {
    test('tab moves focus to the selected radio item', async ({ mount, page }) => {
      await mount(<BasicRadioGroup defaultValue="option1" />)
      await page.keyboard.press('Tab')
      const firstRadio = page.getByRole('radio', { name: 'Option 1' })
      await expect(firstRadio).toBeFocused()
    })

    test('selected item is focusable', async ({ mount, page }) => {
      await mount(<BasicRadioGroup defaultValue="option2" />)
      const secondRadio = page.getByRole('radio', { name: 'Option 2' })
      await secondRadio.focus()
      await expect(secondRadio).toBeFocused()
    })
  })

  test.describe('disabled', () => {
    test('entire group can be disabled', async ({ mount, page }) => {
      await mount(<BasicRadioGroup disabled />)
      const radios = page.getByRole('radio')
      const count = await radios.count()
      for (let i = 0; i < count; i++) {
        await expect(radios.nth(i)).toBeDisabled()
      }
    })

    test('disabled items cannot be selected by click', async ({ mount, page }) => {
      await mount(<BasicRadioGroup disabled defaultValue="option1" />)
      const secondRadio = page.getByRole('radio', { name: 'Option 2' })
      await secondRadio.click({ force: true })
      await expect(secondRadio).not.toBeChecked()
    })

    test('disabled items have reduced opacity', async ({ mount, page }) => {
      await mount(<BasicRadioGroup disabled />)
      const items = page.locator('[data-slot="radio-group-item"]')
      await expect(items.first()).toHaveClass(/disabled:opacity-50/)
    })
  })

  test.describe('styling', () => {
    test('RadioGroup has grid layout', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const group = page.locator('[data-slot="radio-group"]')
      await expect(group).toHaveClass(/grid/)
    })

    test('RadioGroup has gap-3 spacing', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const group = page.locator('[data-slot="radio-group"]')
      await expect(group).toHaveClass(/gap-3/)
    })

    test('RadioGroupItem has rounded-full', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const item = page.locator('[data-slot="radio-group-item"]').first()
      await expect(item).toHaveClass(/rounded-full/)
    })

    test('RadioGroupItem has border', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const item = page.locator('[data-slot="radio-group-item"]').first()
      await expect(item).toHaveClass(/border/)
    })

    test('RadioGroupItem has aspect-square', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const item = page.locator('[data-slot="radio-group-item"]').first()
      await expect(item).toHaveClass(/aspect-square/)
    })

    test('RadioGroupItem has size-4', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const item = page.locator('[data-slot="radio-group-item"]').first()
      await expect(item).toHaveClass(/size-4/)
    })
  })

  test.describe('accessibility', () => {
    test('has radiogroup role', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const group = page.getByRole('radiogroup')
      await expect(group).toBeVisible()
    })

    test('items have radio role', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const radios = page.getByRole('radio')
      await expect(radios).toHaveCount(3)
    })

    test('selected item has aria-checked=true', async ({ mount, page }) => {
      await mount(<BasicRadioGroup defaultValue="option1" />)
      const firstRadio = page.getByRole('radio', { name: 'Option 1' })
      await expect(firstRadio).toHaveAttribute('data-state', 'checked')
    })

    test('unselected items have aria-checked=false', async ({ mount, page }) => {
      await mount(<BasicRadioGroup defaultValue="option1" />)
      const secondRadio = page.getByRole('radio', { name: 'Option 2' })
      await expect(secondRadio).toHaveAttribute('data-state', 'unchecked')
    })

    test('items are labeled by associated labels', async ({ mount, page }) => {
      await mount(<BasicRadioGroup />)
      const firstRadio = page.getByRole('radio', { name: 'Option 1' })
      await expect(firstRadio).toHaveAccessibleName('Option 1')
    })

    test('disabled state is communicated to assistive technologies', async ({
      mount,
      page,
    }) => {
      await mount(<BasicRadioGroup disabled />)
      const firstRadio = page.getByRole('radio', { name: 'Option 1' })
      await expect(firstRadio).toBeDisabled()
    })
  })

  test.describe('custom className', () => {
    test('RadioGroup accepts custom className', async ({ mount, page }) => {
      await mount(
        <RadioGroup className="custom-group">
          <RadioGroupItem value="a" />
        </RadioGroup>
      )
      const group = page.locator('[data-slot="radio-group"]')
      await expect(group).toHaveClass(/custom-group/)
    })

    test('RadioGroupItem accepts custom className', async ({ mount, page }) => {
      await mount(
        <RadioGroup>
          <RadioGroupItem value="a" className="custom-item" />
        </RadioGroup>
      )
      const item = page.locator('[data-slot="radio-group-item"]')
      await expect(item).toHaveClass(/custom-item/)
    })

    test('custom className merges with default classes', async ({
      mount,
      page,
    }) => {
      await mount(
        <RadioGroup className="custom-group">
          <RadioGroupItem value="a" />
        </RadioGroup>
      )
      const group = page.locator('[data-slot="radio-group"]')
      await expect(group).toHaveClass(/grid/)
      await expect(group).toHaveClass(/custom-group/)
    })
  })
})
