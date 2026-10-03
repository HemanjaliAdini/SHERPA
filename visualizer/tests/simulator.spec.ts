import { type APIRequestContext, expect, test } from '@playwright/test'

// Live end-to-end test, no mocks: needs TuringDB on :6666 and `scripts/simulate.py <graph>` running on
// that graph (run.sh starts both). Graph from SIM_GRAPH, default evac.
const GRAPH = process.env.SIM_GRAPH ?? 'evac'
// The C2 screen run.sh serves (port 8080 is TuringDB's own UI when run.sh starts it)
const C2_URL = process.env.C2_URL ?? 'http://localhost:5180'
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
  await page.goto(`${C2_URL}/?graph=${GRAPH}`)
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

  // Selecting one casualty starts only its linked communication.
  const radio = page.getByRole('region', { name: 'CAS-1 Radio', exact: true })
  await expect(radio).toHaveCount(0)
  await expect(page.getByLabel('Simulated radio communication', { exact: true })).toHaveCount(0)
  await page.getByTitle('Show on map', { exact: true }).filter({ hasText: 'CAS-1' }).click()
  await expect(radio.getByRole('article', { name: /Radio message from MED-CAS-/ }).first()).toBeVisible({ timeout: 20000 })
  await expect(radio.getByText(/Triage pending/).first()).toBeVisible()
  await expect(page.getByText('Radio traffic', { exact: true })).toHaveCount(0)
  const savedCount = await radio.locator('article').count()
  await radio.getByRole('button', { name: 'Collapse CAS-1 radio', exact: true }).click()
  await expect(radio.locator('article')).toHaveCount(0)
  await radio.getByRole('button', { name: 'Expand CAS-1 radio', exact: true }).click()
  await expect(radio.locator('article')).toHaveCount(savedCount)

  await page.getByTitle('Show on map', { exact: true }).filter({ hasText: 'CAS-1' }).click()
  await expect(radio.getByRole('article', { name: 'Radio message from CAS-1', exact: true })).toBeVisible({ timeout: 10000 })

  // Triage the whole batch while paused: no mission yet (untriaged cards stay at the top)
  for (let left = 5; left > 0; left--) {
    await page.getByRole('button', { name: 'T1', exact: true }).first().click()
    if (left === 5) await expect(radio.getByText(/CAS-1, T1.*Priority first.*Request evacuation/)).toBeVisible({ timeout: 10000 })
    if (left > 1) await expect(page.getByText(`${left - 1} to triage`)).toBeVisible(UI_WAIT)
  }
  await expect(page.getByText(/to triage/)).toHaveCount(0, UI_WAIT)
  expect(await missions()).toBe(0)
  const historyCount = await radio.locator('article').count()
  await page.getByTitle('Show on map', { exact: true }).filter({ hasText: 'CAS-2' }).click()
  await expect(page.getByRole('region', { name: 'CAS-2 Radio', exact: true })).toBeVisible()
  await expect(radio).toHaveCount(0)
  await page.getByTitle('Show on map', { exact: true }).filter({ hasText: 'CAS-1' }).click()
  await expect(radio.locator('article')).toHaveCount(historyCount)
  await expect(radio.locator('time').first()).toContainText('Z')


  // Play: the system dispatches, the clock runs and follows Clock.now, the map moves
  const startClock = await clock.textContent()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(missions, { timeout: 5_000 }).toBeGreaterThan(0)
  await expect(radio.getByRole('article', { name: 'Radio message from CMD-1', exact: true }).filter({ hasText: 'collect CAS-1' })).toBeVisible({ timeout: 5000 })
  await expect(radio.getByText(/collect CAS-1/).first()).toBeVisible()
  await expect(radio.getByText(/^Assigned: /)).toBeVisible({ timeout: 5000 })
  const assignedVehicle = await scalar(request, "MATCH (m:Mission)-[:PICKS_UP]->(c:Casualty {id: 'CAS-1'}) MATCH (m)-[:USES]->(v:Vehicle) RETURN v.id")
  await expect(radio.getByRole('article', { name: `Radio message from ${assignedVehicle}`, exact: true }).first()).toBeVisible({ timeout: 5000 })

  await expect(radio.getByText(/CAS-[2-5]/)).toHaveCount(0)
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
  // Selecting a casualty zooms away from distant vehicles: verify actual mission progress instead of pixels.
  const progress = () => scalar(request, 'MATCH (m:Mission) RETURN sum(m.progress_m)')
  const before = Number(await progress())
  await expect.poll(async () => Number(await progress()), { timeout: 5000 }).toBeGreaterThan(before)

  // Pause stops the clock
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.waitForTimeout(1_500)
  const paused = await clock.textContent()
  await page.waitForTimeout(2_000)
  await expect(clock).toHaveText(paused ?? '')

  await page.screenshot({ path: 'test-results/casualty-radio-2d.png' })
  await page.getByRole('button', { name: '3D', exact: true }).click()
  await expect(radio).toBeVisible(UI_WAIT)
  await page.screenshot({ path: 'test-results/casualty-radio-3d.png' })

  // Reset brings the batch back
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByText('Resetting...')).toHaveCount(0, UI_WAIT)
  await expect(page.getByText('5 to triage')).toBeVisible(UI_WAIT)
  expect(await missions()).toBe(0)
  await radio.getByRole('button', { name: 'Close casualty radio', exact: true }).click()
  await expect(radio).toHaveCount(0)
})
