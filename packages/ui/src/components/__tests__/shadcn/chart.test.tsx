import { test, expect } from '@playwright/experimental-ct-react'
import { ChartContainer, type ChartConfig } from '../../shadcn/chart'

const testConfig: ChartConfig = {
  revenue: {
    label: 'Revenue',
    color: '#2563eb',
  },
  expenses: {
    label: 'Expenses',
    color: '#dc2626',
  },
}

const themedConfig: ChartConfig = {
  sales: {
    label: 'Sales',
    theme: {
      light: '#0ea5e9',
      dark: '#38bdf8',
    },
  },
}

const emptyConfig: ChartConfig = {
  data: {
    label: 'Data',
  },
}

test.describe('ChartContainer', () => {
  test.describe('rendering', () => {
    test('renders with data-slot attribute', async ({ mount, page }) => {
      await mount(
        <ChartContainer config={testConfig}>
          <div>Chart content</div>
        </ChartContainer>
      )

      const chart = page.locator('[data-slot="chart"]')
      await expect(chart).toBeVisible()
    })

    test('renders children', async ({ mount, page }) => {
      await mount(
        <ChartContainer config={testConfig}>
          <div data-testid="chart-child">Chart content</div>
        </ChartContainer>
      )

      const child = page.locator('[data-testid="chart-child"]')
      await expect(child).toBeVisible()
      await expect(child).toHaveText('Chart content')
    })

    test('applies custom className', async ({ mount, page }) => {
      await mount(
        <ChartContainer config={testConfig} className="custom-chart">
          <div>Chart content</div>
        </ChartContainer>
      )

      const chart = page.locator('[data-slot="chart"]')
      await expect(chart).toHaveClass(/custom-chart/)
    })

    test('has data-chart attribute with generated id', async ({
      mount,
      page,
    }) => {
      await mount(
        <ChartContainer config={testConfig}>
          <div>Chart content</div>
        </ChartContainer>
      )

      const chart = page.locator('[data-slot="chart"]')
      const chartId = await chart.getAttribute('data-chart')
      expect(chartId).toBeTruthy()
      expect(chartId).toContain('chart-')
    })

    test('uses custom id when provided', async ({ mount, page }) => {
      await mount(
        <ChartContainer config={testConfig} id="my-chart">
          <div>Chart content</div>
        </ChartContainer>
      )

      const chart = page.locator('[data-slot="chart"]')
      await expect(chart).toHaveAttribute('data-chart', 'chart-my-chart')
    })
  })

  test.describe('CSS variables', () => {
    test('generates CSS variables from color config', async ({
      mount,
      page,
    }) => {
      await mount(
        <ChartContainer config={testConfig} id="test-colors">
          <div>Chart content</div>
        </ChartContainer>
      )

      const style = page.locator('style')
      const styleContent = await style.textContent()
      expect(styleContent).toContain('--color-revenue')
      expect(styleContent).toContain('#2563eb')
      expect(styleContent).toContain('--color-expenses')
      expect(styleContent).toContain('#dc2626')
    })

    test('generates CSS variables from themed config', async ({
      mount,
      page,
    }) => {
      await mount(
        <ChartContainer config={themedConfig} id="test-themed">
          <div>Chart content</div>
        </ChartContainer>
      )

      const style = page.locator('style')
      const styleContent = await style.textContent()
      expect(styleContent).toContain('--color-sales')
      expect(styleContent).toContain('#0ea5e9')
    })

    test('does not render style tag when config has no colors', async ({
      mount,
      page,
    }) => {
      await mount(
        <ChartContainer config={emptyConfig}>
          <div>Chart content</div>
        </ChartContainer>
      )

      const chart = page.locator('[data-slot="chart"]')
      await expect(chart).toBeVisible()
      const styleTag = chart.locator('style')
      await expect(styleTag).toHaveCount(0)
    })
  })

  test.describe('styling', () => {
    test('has aspect-video class by default', async ({ mount, page }) => {
      await mount(
        <ChartContainer config={testConfig}>
          <div>Chart content</div>
        </ChartContainer>
      )

      const chart = page.locator('[data-slot="chart"]')
      await expect(chart).toHaveClass(/aspect-video/)
    })

    test('has flex layout', async ({ mount, page }) => {
      await mount(
        <ChartContainer config={testConfig}>
          <div>Chart content</div>
        </ChartContainer>
      )

      const chart = page.locator('[data-slot="chart"]')
      await expect(chart).toHaveClass(/flex/)
    })

    test('has justify-center alignment', async ({ mount, page }) => {
      await mount(
        <ChartContainer config={testConfig}>
          <div>Chart content</div>
        </ChartContainer>
      )

      const chart = page.locator('[data-slot="chart"]')
      await expect(chart).toHaveClass(/justify-center/)
    })
  })

  test.describe('ResponsiveContainer', () => {
    test('wraps children in recharts ResponsiveContainer', async ({
      mount,
      page,
    }) => {
      await mount(
        <ChartContainer config={testConfig}>
          <div>Chart content</div>
        </ChartContainer>
      )

      const container = page.locator('.recharts-responsive-container')
      await expect(container).toBeVisible()
    })
  })
})
