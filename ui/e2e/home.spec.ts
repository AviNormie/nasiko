// The scoped home at `/` (plans/feat-agent-centric.md PR2a, PR2b): scope switch, the totals strip and the agent rows (a
// table on desktop, two-line rows on a phone), Fleet's owner groups, axe, and no sideways page scroll at either width.
import { expect, test } from '@playwright/test'
import { expectAccessible } from './axe'

for (const width of [1440, 375])
  test(`home: Yours and Fleet at ${width} px${width < 640 ? ' @phone' : ''}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/?scope=yours&mock=onboarding-done')
    const phone = width < 640
    const rows = phone
      ? page.getByRole('region', { name: 'Agents and harnesses' })
      : page.getByRole('table', { name: 'Agents and harnesses' })
    await expect(rows).toBeVisible()
    if (phone) await expect(page.getByTestId('home-phone-row').first()).toBeVisible()
    else await expect(rows.getByRole('columnheader', { name: /Budget use/ })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Totals' })).toBeVisible()
    await page.getByRole('radio', { name: 'Fleet' }).click()
    await expect(page).toHaveURL(/scope=fleet/)
    await expect(rows).toBeVisible()
    // Fleet groups by owner: the viewer's own group comes first.
    if (!phone) await expect(rows.getByRole('button', { name: /^You/ })).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await expectAccessible(page)
  })
