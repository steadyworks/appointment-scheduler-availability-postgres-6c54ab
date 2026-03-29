import { test, expect, Page } from '@playwright/test'

const APP_URL = 'http://localhost:3000'

// ─── helpers ────────────────────────────────────────────────────────────────

async function goToProvider(page: Page) {
  await page.getByTestId('nav-provider').click()
  await expect(page.getByTestId('provider-view')).toBeVisible()
  await page.waitForLoadState('networkidle')
}

async function goToClient(page: Page) {
  await page.getByTestId('nav-client').click()
  await expect(page.getByTestId('client-view')).toBeVisible()
  await page.waitForLoadState('networkidle')
}

async function registerProvider(page: Page, name: string, service: string): Promise<string> {
  const providerIds = page.locator('[data-testid^="provider-id-"]')
  const countBefore = await providerIds.count()
  await page.getByTestId('provider-name-input').fill(name)
  await page.getByTestId('provider-service-input').fill(service)
  await page.getByTestId('register-provider-btn').click()
  await expect(providerIds).toHaveCount(countBefore + 1, { timeout: 10000 })
  const testId = await providerIds.last().getAttribute('data-testid')
  return testId!.replace('provider-id-', '')
}

async function configureProvider(page: Page, id: string, duration: string, buffer: string) {
  await page.getByTestId(`duration-select-${id}`).selectOption(duration)
  await page.getByTestId(`buffer-select-${id}`).selectOption(buffer)
}

async function enableDay(page: Page, id: string, day: string) {
  await page.getByTestId(`day-toggle-${id}-${day}`).click()
  // Wait for the first time block controls to appear
  await expect(page.getByTestId(`time-block-start-${id}-${day}-0`)).toBeVisible()
}

async function setTimeBlock(
  page: Page, id: string, day: string, index: number, start: string, end: string,
) {
  await page.getByTestId(`time-block-start-${id}-${day}-${index}`).selectOption(start)
  await page.getByTestId(`time-block-end-${id}-${day}-${index}`).selectOption(end)
}

async function saveAvailability(page: Page, id: string) {
  await page.getByTestId(`save-availability-${id}`).click()
  await page.waitForLoadState('networkidle')
}

/** Register a provider with a single Monday availability block and save. */
async function setupMondayProvider(
  page: Page,
  name: string, service: string,
  duration: string, buffer: string,
  start: string, end: string,
): Promise<string> {
  await goToProvider(page)
  const id = await registerProvider(page, name, service)
  await configureProvider(page, id, duration, buffer)
  await enableDay(page, id, 'monday')
  await setTimeBlock(page, id, 'monday', 0, start, end)
  await saveAvailability(page, id)
  return id
}

async function bookSlot(page: Page, day: string, time: string, clientName: string) {
  await page.getByTestId(`slot-${day}-${time}`).click()
  await page.getByTestId('client-name-input').fill(clientName)
  await page.getByTestId('confirm-booking-btn').click()
  await page.waitForLoadState('networkidle')
}

// ─── setup ──────────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL)
  await page.getByTestId('delete-all-btn').click()
  await page.waitForLoadState('networkidle')
})

// ─── TC-01 ──────────────────────────────────────────────────────────────────

test('TC-01: correct slot count with zero buffer', async ({ page }) => {
  const id = await setupMondayProvider(
    page, 'Dr. Smith', 'General Checkup', '30', '0', '09:00', '12:00',
  )
  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()

  // Exactly 6 Monday slot buttons
  await expect(page.locator('[data-testid^="slot-monday-"]')).toHaveCount(6)
  await expect(page.getByTestId('slot-monday-0900')).toBeVisible()
  await expect(page.getByTestId('slot-monday-0930')).toBeVisible()
  await expect(page.getByTestId('slot-monday-1000')).toBeVisible()
  await expect(page.getByTestId('slot-monday-1030')).toBeVisible()
  await expect(page.getByTestId('slot-monday-1100')).toBeVisible()
  await expect(page.getByTestId('slot-monday-1130')).toBeVisible()
})

// ─── TC-02 ──────────────────────────────────────────────────────────────────

test('TC-02: booking removes slot and appears in provider dashboard', async ({ page }) => {
  const id = await setupMondayProvider(
    page, 'Provider A', 'Service', '30', '0', '09:00', '12:00',
  )
  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()
  await bookSlot(page, 'monday', '0900', 'Alice')

  // Slot is gone from client view
  await expect(page.getByTestId('slot-monday-0900')).not.toBeVisible()

  // Booking appears in provider dashboard
  await goToProvider(page)
  const bookings = page.locator('[data-testid^="booking-item-"]')
  await expect(bookings).toHaveCount(1)
  await expect(bookings.first()).toContainText('Alice')
  await expect(bookings.first()).toContainText('9:00')
})

// ─── TC-03 ──────────────────────────────────────────────────────────────────

test('TC-03: cancelling a booking restores the slot', async ({ page }) => {
  const id = await setupMondayProvider(
    page, 'Cancel Provider', 'Service', '30', '0', '09:00', '12:00',
  )
  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()
  await bookSlot(page, 'monday', '0900', 'Bob')

  // Cancel from provider dashboard
  await goToProvider(page)
  await page.locator('[data-testid^="cancel-booking-"]').first().click()
  await page.waitForLoadState('networkidle')

  // Slot reappears in client view
  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()
  await expect(page.getByTestId('slot-monday-0900')).toBeVisible()
})

// ─── TC-04 ──────────────────────────────────────────────────────────────────
//
// Slots are generated by chaining: next_start = prev_start + duration + buffer.
// With 30-min duration + 15-min buffer the initial Monday slots in 09:00–11:00
// are: 09:00 → 09:45 → 10:30.  After booking 09:00, the slot at 09:30 (which
// was never generated) is absent and 09:45 is the next available slot.

test('TC-04: buffer time shifts the next available slot', async ({ page }) => {
  const id = await setupMondayProvider(
    page, 'Buffer Provider', 'Service', '30', '15', '09:00', '11:00',
  )
  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()
  await bookSlot(page, 'monday', '0900', 'Carol')

  await expect(page.getByTestId('slot-monday-0930')).not.toBeVisible()
  await expect(page.getByTestId('slot-monday-0945')).toBeVisible()
})

// ─── TC-05 ──────────────────────────────────────────────────────────────────
//
// Window 09:00–10:30 with 30-min duration + 15-min buffer yields two slots:
// 09:00 and 09:45.  After booking both, the buffer after 09:45 reaches 10:30
// (the window end), leaving no further slots.
// Note: instructions require 30-min-increment selectors, so 10:30 is used
// as the closest valid end time that produces the same test behaviour.

test('TC-05: buffer time can exhaust all remaining availability', async ({ page }) => {
  const id = await setupMondayProvider(
    page, 'Exhaust Provider', 'Service', '30', '15', '09:00', '10:30',
  )
  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()
  await bookSlot(page, 'monday', '0900', 'Dan')
  await bookSlot(page, 'monday', '0945', 'Eve')

  // No Monday slots remain
  await expect(page.locator('[data-testid^="slot-monday-"]')).toHaveCount(0)
})

// ─── TC-06 ──────────────────────────────────────────────────────────────────

test('TC-06: availability gaps produce no slots in the gap', async ({ page }) => {
  await goToProvider(page)
  const id = await registerProvider(page, 'Gap Provider', 'Service')
  await configureProvider(page, id, '30', '0')
  await enableDay(page, id, 'monday')
  await setTimeBlock(page, id, 'monday', 0, '09:00', '12:00')

  // Add a second time block
  await page.getByTestId(`add-time-block-${id}-monday`).click()
  await expect(page.getByTestId(`time-block-start-${id}-monday-1`)).toBeVisible()
  await setTimeBlock(page, id, 'monday', 1, '14:00', '17:00')
  await saveAvailability(page, id)

  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()

  // 12 total Monday slots (6 morning + 6 afternoon)
  await expect(page.locator('[data-testid^="slot-monday-"]')).toHaveCount(12)

  // Morning block present
  await expect(page.getByTestId('slot-monday-0900')).toBeVisible()
  await expect(page.getByTestId('slot-monday-1130')).toBeVisible()

  // Afternoon block present
  await expect(page.getByTestId('slot-monday-1400')).toBeVisible()
  await expect(page.getByTestId('slot-monday-1630')).toBeVisible()

  // Gap slots absent
  await expect(page.getByTestId('slot-monday-1200')).not.toBeVisible()
  await expect(page.getByTestId('slot-monday-1230')).not.toBeVisible()
  await expect(page.getByTestId('slot-monday-1300')).not.toBeVisible()
  await expect(page.getByTestId('slot-monday-1330')).not.toBeVisible()
})

// ─── TC-07 ──────────────────────────────────────────────────────────────────

test('TC-07: multiple providers show independent availability', async ({ page }) => {
  await goToProvider(page)

  const idX = await registerProvider(page, 'Provider X', 'Service X')
  await configureProvider(page, idX, '30', '0')
  await enableDay(page, idX, 'monday')
  await setTimeBlock(page, idX, 'monday', 0, '09:00', '10:00')
  await saveAvailability(page, idX)

  const idY = await registerProvider(page, 'Provider Y', 'Service Y')
  await configureProvider(page, idY, '60', '0')
  await enableDay(page, idY, 'monday')
  await setTimeBlock(page, idY, 'monday', 0, '13:00', '15:00')
  await saveAvailability(page, idY)

  // Provider X: exactly 2 Monday slots
  await goToClient(page)
  await page.getByTestId(`provider-card-${idX}`).click()
  await expect(page.locator('[data-testid^="slot-monday-"]')).toHaveCount(2)
  await expect(page.getByTestId('slot-monday-0900')).toBeVisible()
  await expect(page.getByTestId('slot-monday-0930')).toBeVisible()

  // Provider Y: exactly 2 Monday slots
  await goToClient(page)
  await page.getByTestId(`provider-card-${idY}`).click()
  await expect(page.locator('[data-testid^="slot-monday-"]')).toHaveCount(2)
  await expect(page.getByTestId('slot-monday-1300')).toBeVisible()
  await expect(page.getByTestId('slot-monday-1400')).toBeVisible()
})

// ─── TC-08 ──────────────────────────────────────────────────────────────────

test('TC-08: state persists across page reload', async ({ page }) => {
  const id = await setupMondayProvider(
    page, 'Provider Persist', 'Service', '30', '0', '09:00', '11:00',
  )
  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()
  await bookSlot(page, 'monday', '0900', 'Frank')
  await bookSlot(page, 'monday', '0930', 'Grace')

  // Full page reload
  await page.reload()
  await page.waitForLoadState('networkidle')

  // Booked slots are still absent; later slots still present
  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()
  await expect(page.getByTestId('slot-monday-0900')).not.toBeVisible()
  await expect(page.getByTestId('slot-monday-0930')).not.toBeVisible()
  await expect(page.getByTestId('slot-monday-1000')).toBeVisible()
  await expect(page.getByTestId('slot-monday-1030')).toBeVisible()

  // Bookings still in provider dashboard
  await goToProvider(page)
  const bookings = page.locator('[data-testid^="booking-item-"]')
  await expect(bookings).toHaveCount(2)
  const texts = await bookings.allTextContents()
  expect(texts.some(t => t.includes('Frank'))).toBe(true)
  expect(texts.some(t => t.includes('Grace'))).toBe(true)
})

// ─── TC-09 ──────────────────────────────────────────────────────────────────

test('TC-09: concurrent booking conflict — only one succeeds', async ({ page, browser }) => {
  // Window contains exactly one slot (09:00–09:30)
  const id = await setupMondayProvider(
    page, 'Race Provider', 'Service', '30', '0', '09:00', '09:30',
  )

  const ctx1 = await browser.newContext()
  const ctx2 = await browser.newContext()
  const page1 = await ctx1.newPage()
  const page2 = await ctx2.newPage()

  try {
    // Both contexts navigate to the slot and fill the booking form
    await Promise.all([
      (async () => {
        await page1.goto(APP_URL)
        await goToClient(page1)
        await page1.getByTestId(`provider-card-${id}`).click()
        await page1.getByTestId('slot-monday-0900').click()
        await page1.getByTestId('client-name-input').fill('H1')
      })(),
      (async () => {
        await page2.goto(APP_URL)
        await goToClient(page2)
        await page2.getByTestId(`provider-card-${id}`).click()
        await page2.getByTestId('slot-monday-0900').click()
        await page2.getByTestId('client-name-input').fill('H2')
      })(),
    ])

    // Submit both simultaneously
    await Promise.all([
      page1.getByTestId('confirm-booking-btn').click(),
      page2.getByTestId('confirm-booking-btn').click(),
    ])

    // Wait for both to settle
    await Promise.all([
      page1.waitForLoadState('networkidle'),
      page2.waitForLoadState('networkidle'),
    ])

    // Provider dashboard must show exactly one booking
    // Force ProviderDashboard remount so it fetches fresh booking data
    await goToClient(page)
    await goToProvider(page)
    await expect(page.locator('[data-testid^="booking-item-"]')).toHaveCount(1, { timeout: 10000 })
  } finally {
    await ctx1.close()
    await ctx2.close()
  }
})

// ─── TC-10 ──────────────────────────────────────────────────────────────────

test('TC-10: waitlist hold on cancellation — confirmed within time limit', async ({ page, browser }) => {
  test.setTimeout(90_000)

  // One-slot window
  const id = await setupMondayProvider(
    page, 'Hold Provider', 'Service', '30', '0', '09:00', '09:30',
  )

  // Context A (main page): book Ivan at 09:00
  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()
  await bookSlot(page, 'monday', '0900', 'Ivan')

  const ctxB = await browser.newContext()
  const ctxC = await browser.newContext()
  const pageB = await ctxB.newPage()
  const pageC = await ctxC.newPage()

  try {
    // Context B: join the waitlist as Judy
    await pageB.goto(APP_URL)
    await goToClient(pageB)
    await pageB.getByTestId(`provider-card-${id}`).click()
    await pageB.getByTestId('join-waitlist-monday').click()
    await pageB.getByTestId('waitlist-name-input').fill('Judy')
    await pageB.getByTestId('join-waitlist-confirm-btn').click()
    await pageB.waitForLoadState('networkidle')

    // Context A: cancel Ivan's booking
    await goToProvider(page)
    await page.locator('[data-testid^="cancel-booking-"]').first().click()
    await page.waitForLoadState('networkidle')

    // Context B: reservation hold should appear
    await expect(pageB.getByTestId('hold-timer')).toBeVisible({ timeout: 15_000 })
    await expect(pageB.getByTestId('confirm-hold-btn')).toBeVisible()

    // Timer is counting down from ≤60 and >0
    const timerText = await pageB.getByTestId('hold-timer').textContent()
    const secs = parseInt(timerText!, 10)
    expect(secs).toBeGreaterThan(0)
    expect(secs).toBeLessThanOrEqual(60)

    // During the hold the slot must not be visible to any other client
    await pageC.goto(APP_URL)
    await goToClient(pageC)
    await pageC.getByTestId(`provider-card-${id}`).click()
    await expect(pageC.getByTestId('slot-monday-0900')).not.toBeVisible()

    // Context B: confirm the hold
    await pageB.getByTestId('confirm-hold-btn').click()
    await pageB.waitForLoadState('networkidle')

    // Hold UI disappears
    await expect(pageB.getByTestId('hold-timer')).not.toBeVisible()
    await expect(pageB.getByTestId('confirm-hold-btn')).not.toBeVisible()

    // Provider dashboard shows Judy's booking
    await goToProvider(page)
    const bookings = page.locator('[data-testid^="booking-item-"]')
    await expect(bookings).toHaveCount(1)
    await expect(bookings.first()).toContainText('Judy')
  } finally {
    await ctxB.close()
    await ctxC.close()
  }
})

// ─── TC-11 ──────────────────────────────────────────────────────────────────

test('TC-11: waitlist hold expiry — slot becomes publicly available', async ({ page, browser }) => {
  test.setTimeout(150_000)

  // One-slot window
  const id = await setupMondayProvider(
    page, 'Expire Provider', 'Service', '30', '0', '09:00', '09:30',
  )

  // Context A (main page): book Karl at 09:00
  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()
  await bookSlot(page, 'monday', '0900', 'Karl')

  const ctxB = await browser.newContext()
  const ctxC = await browser.newContext()
  const pageB = await ctxB.newPage()
  const pageC = await ctxC.newPage()

  try {
    // Context B: join the waitlist as Lena
    await pageB.goto(APP_URL)
    await goToClient(pageB)
    await pageB.getByTestId(`provider-card-${id}`).click()
    await pageB.getByTestId('join-waitlist-monday').click()
    await pageB.getByTestId('waitlist-name-input').fill('Lena')
    await pageB.getByTestId('join-waitlist-confirm-btn').click()
    await pageB.waitForLoadState('networkidle')

    // Context A: cancel Karl's booking
    await goToProvider(page)
    await page.locator('[data-testid^="cancel-booking-"]').first().click()
    await page.waitForLoadState('networkidle')

    // Context B: hold timer must appear
    await expect(pageB.getByTestId('hold-timer')).toBeVisible({ timeout: 15_000 })

    // Do NOT confirm — wait for the 60-second hold to expire
    // (timer becomes invisible when the hold is released)
    await expect(pageB.getByTestId('hold-timer')).not.toBeVisible({ timeout: 75_000 })

    // Context C: the slot is now generally available
    await pageC.goto(APP_URL)
    await goToClient(pageC)
    await pageC.getByTestId(`provider-card-${id}`).click()
    await expect(pageC.getByTestId('slot-monday-0900')).toBeVisible({ timeout: 10_000 })
  } finally {
    await ctxB.close()
    await ctxC.close()
  }
})

// ─── TC-12 ──────────────────────────────────────────────────────────────────
//
// With 60-min duration and 30-min buffer in a 09:00–12:00 window:
//   09:00 → ends 10:00 → buffer until 10:30 → slot 10:30
//   10:30 → ends 11:30 → buffer until 12:00 = window end → stop
// Only 2 slots: 09:00 and 10:30.

test('TC-12: 60-min appointments with 30-min buffer produce correct slot sequence', async ({ page }) => {
  const id = await setupMondayProvider(
    page, 'Long Provider', 'Service', '60', '30', '09:00', '12:00',
  )
  await goToClient(page)
  await page.getByTestId(`provider-card-${id}`).click()

  await expect(page.locator('[data-testid^="slot-monday-"]')).toHaveCount(2)
  await expect(page.getByTestId('slot-monday-0900')).toBeVisible()
  await expect(page.getByTestId('slot-monday-1030')).toBeVisible()
  await expect(page.getByTestId('slot-monday-1000')).not.toBeVisible()
  await expect(page.getByTestId('slot-monday-1100')).not.toBeVisible()
})

// ─── TC-13 ──────────────────────────────────────────────────────────────────
//
// buildDayEntries() computes booking dates via toISOString() which yields
// the UTC date.  The backend's next_5_weekdays() uses date.today() in
// server-local time.  In any timezone ahead of UTC the local date can be
// one day ahead of the UTC date, so the frontend sends the wrong
// booking_date.  The booking lands on the previous day and get_slots
// never finds it → the slot stays visible after booking.

test('TC-13: booking in a positive-offset timezone removes the slot', async ({ page, browser }) => {
  const id = await setupMondayProvider(
    page, 'TZ Provider', 'Service', '30', '0', '09:00', '12:00',
  )

  // Fix the browser clock at 15:00 UTC today.
  // In Etc/GMT-12 (UTC+12) that is 03:00 "tomorrow", so the local date
  // is one day ahead of the UTC date and toISOString() produces a date
  // that is one day behind what the user sees.
  const now = new Date()
  const fixedUtc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 15, 0, 0,
  ))

  const ctx = await browser.newContext({ timezoneId: 'Etc/GMT-12' })
  const tzPage = await ctx.newPage()
  await tzPage.clock.setFixedTime(fixedUtc)

  try {
    await tzPage.goto(APP_URL)
    await goToClient(tzPage)
    await tzPage.getByTestId(`provider-card-${id}`).click()

    // Monday slots should be visible
    await expect(tzPage.getByTestId('slot-monday-0900')).toBeVisible({ timeout: 10000 })

    // Book the 09:00 slot
    await bookSlot(tzPage, 'monday', '0900', 'TZUser')

    // The slot must disappear — with the toISOString() bug it stays visible
    await expect(tzPage.getByTestId('slot-monday-0900')).not.toBeVisible()
  } finally {
    await ctx.close()
  }
})
