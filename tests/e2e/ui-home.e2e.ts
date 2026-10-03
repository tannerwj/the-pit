import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Read-only: home page structure — hero, live season banner, markets table,
// top bots, nav, footer. Live prices tick client-side, so assertions stick to
// structure and labels, not values.
test(
  'home: hero, markets table and season banner render',
  { requires: ['browser'], tags: ['ui'] },
  async ({ app, screen, browser }) => {
    await app.open('/');
    await expect(browser).toHaveTitle(/The Pit/);

    // Hero
    await expect(
      screen.getByRole('heading', { level: 1 }),
    ).toContainText('Watch AI bots battle live crypto markets');

    // Season banner: Season 1 is live.
    const banner = browser.locator('#seasonBanner');
    await expect(banner).toContainText('Season 1');
    await expect(banner).toContainText('trading window ends in');

    // Live markets table headers.
    const markets = screen.getByRole('heading', { name: 'Live markets' });
    await expect(markets).toBeVisible();
    for (const h of ['Pair', 'Last price', '24h Change', '24h High', '24h Low', 'Bots']) {
      await expect(screen.getByRole('columnheader', { name: h }).first()).toBeVisible();
    }
    // All 5 pairs link to their trade views; price cells are present
    // (BTC is the hero pair: #rowPrice; the rest use #mp-{PAIR}-USD).
    const tradeLinks = screen.getByRole('link', { name: 'Trade view →' });
    for (let i = 0; i < 5; i++) {
      await expect(tradeLinks.nth(i)).toBeVisible();
    }
    await expect(browser.locator('#rowPrice')).toBeVisible();
    for (const pair of ['ETH', 'SOL', 'XRP', 'DOGE']) {
      await expect(browser.locator(`#mp-${pair}-USD`)).toBeVisible();
    }

    // Top bots section + path cards.
    await expect(screen.getByRole('heading', { name: /Top bots/ })).toBeVisible();
    for (const label of ['View leaderboard', 'Open the simulator', 'Agent quickstart']) {
      await expect(
        browser.locator(`a.pathcard:has-text("${label}")`),
      ).toBeVisible();
    }

    // Top nav.
    for (const name of ['Markets', 'Leaderboard', 'Leagues', 'Simulate', 'For agents']) {
      await expect(browser.locator('.topnav').getByRole('link', { name })).toBeVisible();
    }
  },
);
