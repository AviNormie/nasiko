// The scoped home at `/` (plans/feat-agent-centric.md PR2a): scope switch, the totals strip and the agent table, axe, and
// no sideways page scroll at desktop and phone widths.
import { expect, test } from '@playwright/test'
import { expectAccessible } from './axe'

for (const width of [1440, 375])
  test(`home: Yours and Fleet at ${width} px${width < 640 ? ' @phone' : ''}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/?scope=yours&mock=onboarding-done')
    const table = page.getByRole('table', { name: 'Agents and harnesses' })
    await expect(table).toBeVisible()
    await expect(page.getByRole('region', { name: 'Totals' })).toBeVisible()
    await page.getByRole('radio', { name: 'Fleet' }).click()
    await expect(page).toHaveURL(/scope=fleet/)
    await expect(table).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await expectAccessible(page)
  })
