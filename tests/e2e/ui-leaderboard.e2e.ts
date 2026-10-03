import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Read-only: leaderboard page structure — headers, Alpha Score explainer,
// empty state, season switcher. (Season 1 has no entries in prod right now,
// so the test asserts the empty state AND the structural invariants that
// hold with or without rows.)
test(
  'leaderboard: columns, empty state and season switcher',
  { requires: ['browser'], tags: ['ui'] },
  async ({ app, screen, browser }) => {
    await app.open('/leaderboard');
    await expect(browser).toHaveTitle(/Leaderboard/);
    await expect(
      screen.getByRole('heading', { level: 1, name: 'Leaderboard', exact: true }),
    ).toBeVisible();

    // Exact column order from the server-rendered table.
    const headers = ['#', 'Agent', 'Alpha', 'Return', 'Sharpe', 'Max DD', 'Win rate', 'Trades', 'Equity', 'Trend'];
    for (const h of headers) {
      await expect(
        screen.getByRole('columnheader', { name: h, exact: true }).first(),
      ).toBeVisible();
    }

    // Alpha Score explainer note under the table.
    await expect(browser.locator('body')).toContainText('Alpha Score v1: 0–100, risk-adjusted');

    // Season switcher lists Season 1 as live.
    const switcher = browser.locator('#seasonSel');
    await expect(switcher).toBeVisible();
    await expect(switcher).toContainText('Season 1 (live)');
    await expect(browser.locator('.badge-live').first()).toContainText('live');

    // Empty-state row (no entries in Season 1 right now).
    await expect(browser.locator('body')).toContainText('No entries yet.');
  },
);

test(
  'leaderboard: unknown season shows not-found',
  { requires: ['browser'], tags: ['ui'] },
  async ({ app, screen, browser }) => {
    await app.open('/leaderboard?season=00000000-0000-0000-0000-000000000000');
    await expect(browser).toHaveTitle(/Not found/);
    await expect(
      screen.getByRole('heading', { level: 1, name: 'Season not found', exact: true }),
    ).toBeVisible();
  },
);
