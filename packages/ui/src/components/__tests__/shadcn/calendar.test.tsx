import { test, expect } from '@playwright/experimental-ct-react'
import { Calendar } from '../../shadcn/calendar'

test.describe('Calendar', () => {
  test.describe('rendering', () => {
    test('renders with data-slot attribute', async ({ mount, page }) => {
      await mount(<Calendar />)
      const calendar = page.locator('[data-slot="calendar"]')
      await expect(calendar).toBeVisible()
    })

    test('displays current month name', async ({ mount, page }) => {
      const now = new Date()
      const monthName = now.toLocaleString('default', { month: 'long' })
      await mount(<Calendar month={now} />)
      const calendar = page.locator('[data-slot="calendar"]')
      await expect(calendar).toContainText(monthName)
    })

    test('displays year', async ({ mount, page }) => {
      const now = new Date()
      await mount(<Calendar month={now} />)
      const calendar = page.locator('[data-slot="calendar"]')
      await expect(calendar).toContainText(String(now.getFullYear()))
    })

    test('renders day-of-week headers', async ({ mount, page }) => {
      await mount(<Calendar />)
      const weekdays = page.locator('.rdp-weekday')
      await expect(weekdays.first()).toBeVisible()
    })

    test('renders day cells', async ({ mount, page }) => {
      await mount(<Calendar />)
      const days = page.locator('.rdp-day')
      const count = await days.count()
      expect(count).toBeGreaterThan(0)
    })

    test('applies custom className', async ({ mount, page }) => {
      await mount(<Calendar className="custom-calendar" />)
      const calendar = page.locator('[data-slot="calendar"]')
      await expect(calendar).toHaveClass(/custom-calendar/)
    })
  })

  test.describe('navigation', () => {
    test('renders previous month button', async ({ mount, page }) => {
      await mount(<Calendar />)
      const prevButton = page.locator('.rdp-button_previous')
      await expect(prevButton).toBeVisible()
    })

    test('renders next month button', async ({ mount, page }) => {
      await mount(<Calendar />)
      const nextButton = page.locator('.rdp-button_next')
      await expect(nextButton).toBeVisible()
    })

    test('navigates to previous month', async ({ mount, page }) => {
      const january = new Date(2025, 0, 15)
      await mount(<Calendar defaultMonth={january} />)

      const prevButton = page.locator('.rdp-button_previous')
      await prevButton.click()

      const calendar = page.locator('[data-slot="calendar"]')
      await expect(calendar).toContainText('December')
    })

    test('navigates to next month', async ({ mount, page }) => {
      const january = new Date(2025, 0, 15)
      await mount(<Calendar defaultMonth={january} />)

      const nextButton = page.locator('.rdp-button_next')
      await nextButton.click()

      const calendar = page.locator('[data-slot="calendar"]')
      await expect(calendar).toContainText('February')
    })
  })

  test.describe('day selection', () => {
    test('selects a day in single mode', async ({ mount, page }) => {
      const january = new Date(2025, 0, 15)
      await mount(<Calendar mode="single" defaultMonth={january} />)

      const dayButton = page.locator('.rdp-day').filter({ hasText: '15' }).first()
      await dayButton.click()

      const selectedButton = page.locator('[data-selected-single="true"]')
      await expect(selectedButton).toBeVisible()
    })

    test('shows today with accent styling', async ({ mount, page }) => {
      await mount(<Calendar />)
      const today = page.locator('.rdp-today')
      await expect(today).toBeVisible()
    })
  })

  test.describe('outside days', () => {
    test('shows outside days by default', async ({ mount, page }) => {
      await mount(<Calendar defaultMonth={new Date(2025, 0, 1)} />)
      const outsideDays = page.locator('.rdp-outside')
      const count = await outsideDays.count()
      expect(count).toBeGreaterThan(0)
    })

    test('hides outside days when showOutsideDays is false', async ({
      mount,
      page,
    }) => {
      await mount(<Calendar showOutsideDays={false} />)
      // react-day-picker v9 keeps outside-day cells in the DOM but applies the
      // `hidden` modifier (mapped to Tailwind `invisible`), so assert none are
      // actually visible rather than absent from the DOM.
      const visibleOutsideDays = page.locator('.rdp-outside:visible')
      await expect(visibleOutsideDays).toHaveCount(0)
    })
  })

  test.describe('accessibility', () => {
    test('navigation buttons are keyboard accessible', async ({
      mount,
      page,
    }) => {
      await mount(<Calendar />)
      const prevButton = page.locator('.rdp-button_previous')
      await prevButton.focus()
      await expect(prevButton).toBeFocused()
    })

    test('day buttons are keyboard accessible', async ({ mount, page }) => {
      await mount(<Calendar mode="single" />)
      const dayButton = page.locator('.rdp-day button').first()
      await dayButton.focus()
      await expect(dayButton).toBeFocused()
    })

    test('calendar has proper structure with table', async ({
      mount,
      page,
    }) => {
      await mount(<Calendar />)
      const table = page.locator('[data-slot="calendar"] table')
      await expect(table).toBeVisible()
    })
  })
})
