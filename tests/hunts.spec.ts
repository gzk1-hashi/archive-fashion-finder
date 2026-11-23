/**
 * Hunts end to end, with two real signed-in users in separate browsers.
 *
 * The unit tests prove the rules (schemas, actions, engine) in isolation; this
 * proves them through the real stack — RecordRoom RBAC over the WebSocket,
 * routing, the actions — the way a user meets them.
 *
 * Scans are owner-billed, so no test here ever runs one: startScan is
 * answered in the browser by `page.route`, before it reaches the worker.
 */
import { test, expect, loadAllTestAccounts, type MultiplayerUser } from 'deepspace/testing'

const usableTestAccounts = loadAllTestAccounts().length
test.skip(
  usableTestAccounts < 2,
  `Needs 2 usable test accounts, found ${usableTestAccounts}. Create them with ` +
    '`npx deepspace test accounts create --email <name>@deepspace.test --name "<name>" --password-stdin`.',
)

/** Answer startScan locally so creating a hunt never spends money. */
async function stubScans(user: MultiplayerUser) {
  await user.page.route('**/api/actions/startScan', (route) =>
    route.fulfill({ json: { success: true, data: { jobId: 'test-stub' } } }),
  )
}

/** Wait until the hunts list has finished loading (no skeleton). */
async function huntsLoaded(user: MultiplayerUser) {
  await expect(user.page.getByRole('heading', { name: 'Your hunts' })).toBeVisible({ timeout: 15_000 })
  await expect(user.page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
}

test('a hunt is private to the user who created it', async ({ users }) => {
  const [a, b] = await users(2)
  const piece = `isolation check ${Date.now()}`
  await stubScans(a)

  // A creates a hunt and lands on its board.
  await a.page.goto('/hunts')
  await huntsLoaded(a)
  await a.page.getByLabel('Designer', { exact: true }).fill('Junya Watanabe')
  await a.page.getByLabel('Piece', { exact: true }).fill(piece)
  await a.page.getByRole('button', { name: /create hunt/i }).click()
  await a.page.waitForURL(/\/hunts\/[^/]+$/, { timeout: 15_000 })
  const boardPath = new URL(a.page.url()).pathname
  await expect(a.page.getByRole('heading', { name: new RegExp(piece) })).toBeVisible({ timeout: 15_000 })

  // B can't see it in their list…
  await b.page.goto('/hunts')
  await huntsLoaded(b)
  await expect(b.page.getByText(piece)).toHaveCount(0)

  // …or by pasting A's board URL. Same page as a hunt that never existed.
  await b.page.goto(boardPath)
  await expect(b.page.getByText('Hunt not found')).toBeVisible({ timeout: 15_000 })
  await expect(b.page.getByText(piece)).toHaveCount(0)

  // A cleans up through the cascading delete action.
  await a.page.getByRole('button', { name: 'Delete', exact: true }).click()
  await a.page.getByRole('button', { name: 'Delete hunt' }).click()
  await a.page.waitForURL(/\/hunts$/, { timeout: 15_000 })
  await huntsLoaded(a)
  await expect(a.page.getByText(piece)).toHaveCount(0)
})

test('the form explains bad input instead of saving it', async ({ users }) => {
  const [a] = await users(1)
  await stubScans(a)
  await a.page.goto('/hunts')
  await huntsLoaded(a)

  await a.page.getByLabel('Designer', { exact: true }).fill('Junya Watanabe')
  await a.page.getByLabel('Piece', { exact: true }).fill('jacket')
  await a.page.getByLabel('Season (optional)').fill('vintage')
  await a.page.getByLabel('Max landed price, USD (optional)').fill('12.50')
  await a.page.getByRole('button', { name: /create hunt/i }).click()

  await expect(a.page.getByText(/season code like SS02/)).toBeVisible()
  await expect(a.page.getByText(/whole dollars/i)).toBeVisible()
  await expect(a.page).toHaveURL(/\/hunts$/) // nothing was created, no navigation
})
