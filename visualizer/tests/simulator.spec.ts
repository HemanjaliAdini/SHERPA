import { type APIRequestContext, expect, test } from '@playwright/test'

// Live end-to-end test, no mocks: needs TuringDB on :6666 and `scripts/simulate.py <graph>` running on
// that graph (run.sh starts both). Graph from SIM_GRAPH, default evac6.
const GRAPH = process.env.SIM_GRAPH ?? 'evac6'
// Headless rendering of the 3D map with no GPU is slow, so UI updates get generous waits
const UI_WAIT = { timeout: 15_000 }

async function scalar(request: APIRequestContext, query: string): Promise<unknown> {
  const res = await request.post(`http://localhost:6666/query?graph=${GRAPH}`, { data: query })
  return (await res.json()).data[0]?.[0]?.[0]
}

const hhmm = (iso: unknown) => {
  const d = new Date(String(iso))
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
}

test('the medic triages the batch, the system dispatches on play, and the scenario runs', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  await page.goto(`/?graph=${GRAPH}`)
  const clock = page.locator('aside .font-mono').first()
  const missions = () => scalar(request, 'MATCH (m:Mission) RETURN count(m)')
  // The 2D map: headless Chrome draws the 3D view in software, too slowly for a 1 s tick
  await page.getByRole('button', { name: '2D', exact: true }).click()

  // Start from the seed
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByText('Resetting...')).toHaveCount(0, UI_WAIT)
  await expect(page.getByText('5 to triage')).toBeVisible(UI_WAIT)

  // Each card shows the MIST report and the triage buttons; the manual planner is hidden
  await expect(page.getByText('I: Catastrophic bleed, left thigh')).toBeVisible()
  await expect(page.getByRole('button', { name: 'DEAD', exact: true })).toHaveCount(5)
  await expect(page.getByRole('button', { name: 'Plan pickup' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Manual', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Plan pickup' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Auto', exact: true }).click()

  // Triage the whole batch while paused: no mission yet (untriaged cards stay at the top)
  for (let left = 5; left > 0; left--) {
    await page.getByRole('button', { name: 'T1', exact: true }).first().click()
    if (left > 1) await expect(page.getByText(`${left - 1} to triage`)).toBeVisible(UI_WAIT)
  }
  await expect(page.getByText(/to triage/)).toHaveCount(0, UI_WAIT)
  expect(await missions()).toBe(0)

  // Play: the system dispatches, the clock runs and follows Clock.now, the map moves
  const startClock = await clock.textContent()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(missions, { timeout: 5_000 }).toBeGreaterThan(0)
  await expect(clock).not.toHaveText(startClock ?? '', { timeout: 5_000 })
  // The screen polls once a second while the clock ticks once a second: it may lag a tick or two
  const minutes = (hhmmz: string | null) => {
    const [h, m] = (hhmmz ?? '').replace('Z', '').split(':').map(Number)
    return h * 60 + m
  }
  const lag =
    minutes(hhmm(await scalar(request, 'MATCH (k:Clock) RETURN k.now'))) -
    minutes(await clock.textContent())
  expect(lag).toBeGreaterThanOrEqual(0)
  expect(lag).toBeLessThanOrEqual(2)
  const map = page.locator('div.relative.h-full.flex-1').first()
  const before = await map.screenshot()
  await page.waitForTimeout(3_000)
  expect((await map.screenshot()).equals(before)).toBe(false)

  // Pause stops the clock
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.waitForTimeout(1_500)
  const paused = await clock.textContent()
  await page.waitForTimeout(2_000)
  await expect(clock).toHaveText(paused ?? '')

  // Reset brings the batch back
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByText('Resetting...')).toHaveCount(0, UI_WAIT)
  await expect(page.getByText('5 to triage')).toBeVisible(UI_WAIT)
  expect(await missions()).toBe(0)
})
