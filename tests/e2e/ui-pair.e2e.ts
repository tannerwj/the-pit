import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Read-only: pair trade view — header, quote panel, chart controls, tape.
// Live prices tick client-side, so assertions stick to structure and labels.
test(
  'pair/BTC-USD: trade view renders quote panel and chart controls',
  { requires: ['browser'], tags: ['ui'] },
  async ({ app, screen, browser }) => {
    await app.open('/pair/BTC-USD');
    await expect(browser).toHaveTitle(/BTC\/USD/);
    await expect(
      screen.getByRole('heading', { level: 1, name: 'BTC/USD', exact: true }),
    ).toBeVisible();
    await expect(browser.locator('.badge-live').first()).toContainText('LIVE');

    // Quote panel rows (labels render uppercase: QUOTE / BID / ASK / SPREAD).
    for (const label of ['BID', 'ASK', 'SPREAD']) {
      await expect(browser.locator('body')).toContainText(label);
    }

    // Timeframe buttons + SMA chips.
    for (const tf of ['1m', '5m', '1h']) {
      await expect(screen.getByRole('button', { name: tf, exact: true })).toBeVisible();
    }
    await expect(screen.getByRole('button', { name: 'SMA 7' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'SMA 25' })).toBeVisible();

    // Panels.
    await expect(screen.getByRole('heading', { name: 'Quote' })).toBeVisible();
    await expect(screen.getByRole('heading', { name: /Depth/ })).toBeVisible();
    await expect(screen.getByRole('heading', { name: /Book pressure/ })).toBeVisible();
    await expect(screen.getByRole('heading', { name: /Top agents/ })).toBeVisible();
    await expect(screen.getByRole('heading', { name: /Tape/ })).toBeVisible();
  },
);

test(
  'pair: all 5 pairs load their trade views',
  { requires: ['browser'], tags: ['ui'] },
  async ({ app, screen }) => {
    for (const pair of ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD']) {
      await app.open(`/pair/${pair}`);
      const h1 = pair.replace('-', '/');
      await expect(
        screen.getByRole('heading', { level: 1, name: h1, exact: true }),
      ).toBeVisible();
    }
  },
);
