import { test, expect } from '@playwright/experimental-ct-react'
import { ServiceStatusBar, type ServiceHealth } from '../../custom/service-status-bar'

const healthyServices: ServiceHealth[] = [
  { name: 'API Gateway', status: 'healthy', latency: 42 },
  { name: 'STT Service', status: 'healthy', latency: 128 },
]

const mixedServices: ServiceHealth[] = [
  { name: 'API Gateway', status: 'healthy', latency: 42 },
  { name: 'STT Service', status: 'degraded', latency: 850 },
  { name: 'NLP Service', status: 'down' },
  { name: 'New Service', status: 'unknown' },
]

test.describe('ServiceStatusBar', () => {
  test.describe('rendering', () => {
    test('renders all services', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={healthyServices} />
      )
      await expect(component).toHaveAttribute('data-slot', 'service-status-bar')
      await expect(component.getByText('API Gateway')).toBeVisible()
      await expect(component.getByText('STT Service')).toBeVisible()
    })

    test('shows latency when provided', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={healthyServices} />
      )
      await expect(component.getByText('42ms')).toBeVisible()
      await expect(component.getByText('128ms')).toBeVisible()
    })

    test('shows session and job counts', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={healthyServices} activeSessions={5} processingJobs={2} />
      )
      await expect(component.getByText('5 active sessions')).toBeVisible()
      await expect(component.getByText('2 processing')).toBeVisible()
    })

    test('uses singular for 1 session', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={healthyServices} activeSessions={1} />
      )
      await expect(component.getByText('1 active session')).toBeVisible()
    })
  })

  test.describe('status variants', () => {
    test('shows Operational for healthy services', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={[{ name: 'API', status: 'healthy' }]} />
      )
      await expect(component.getByText('Operational')).toBeVisible()
    })

    test('shows Degraded for degraded services', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={[{ name: 'API', status: 'degraded' }]} />
      )
      await expect(component.getByText('Degraded')).toBeVisible()
    })

    test('shows Offline for down services', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={[{ name: 'API', status: 'down' }]} />
      )
      await expect(component.getByText('Offline')).toBeVisible()
    })

    test('shows Unknown for unknown status', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={[{ name: 'API', status: 'unknown' }]} />
      )
      await expect(component.getByText('Unknown')).toBeVisible()
    })

    test('renders mixed statuses correctly', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={mixedServices} />
      )
      await expect(component.getByText('Operational')).toBeVisible()
      await expect(component.getByText('Degraded')).toBeVisible()
      await expect(component.getByText('Offline')).toBeVisible()
      await expect(component.getByText('Unknown')).toBeVisible()
    })
  })

  test.describe('loading state', () => {
    test('shows loading indicator', async ({ mount }) => {
      const component = await mount(<ServiceStatusBar isLoading />)
      await expect(component.getByText('Checking services…')).toBeVisible()
      await expect(component.locator('.animate-spin')).toBeVisible()
    })

    test('does not show services when loading', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={healthyServices} isLoading />
      )
      await expect(component.getByText('API Gateway')).toHaveCount(0)
    })
  })

  test.describe('empty state', () => {
    test('shows empty message when no services', async ({ mount }) => {
      const component = await mount(<ServiceStatusBar services={[]} />)
      await expect(component.getByText('No service data available')).toBeVisible()
    })

    test('shows empty message when services is undefined', async ({ mount }) => {
      const component = await mount(<ServiceStatusBar />)
      await expect(component.getByText('No service data available')).toBeVisible()
    })
  })

  test.describe('refresh button', () => {
    test('shows refresh button when onRefresh is provided', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={healthyServices} onRefresh={() => {}} />
      )
      await expect(component.getByLabel('Refresh service status')).toBeVisible()
    })

    test('hides refresh button when onRefresh is not provided', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={healthyServices} />
      )
      await expect(component.getByLabel('Refresh service status')).toHaveCount(0)
    })

    test('refresh button is clickable', async ({ mount }) => {
      let refreshed = false
      const component = await mount(
        <ServiceStatusBar
          services={healthyServices}
          onRefresh={() => { refreshed = true }}
        />
      )
      await component.getByLabel('Refresh service status').click()
      expect(refreshed).toBe(true)
    })
  })

  test.describe('accessibility', () => {
    test('refresh button has aria-label', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={healthyServices} onRefresh={() => {}} />
      )
      await expect(component.getByLabel('Refresh service status')).toBeVisible()
    })

    test('status indicators have aria-hidden', async ({ mount }) => {
      const component = await mount(
        <ServiceStatusBar services={healthyServices} />
      )
      const indicators = component.locator('[aria-hidden="true"]')
      expect(await indicators.count()).toBeGreaterThan(0)
    })
  })
})
