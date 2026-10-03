import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Browser suite: deterministic page-navigation assertions only (no agent.*
// steps, so no model is needed). Written from component source
// (src/pages.ts): exact routes, headings, and nav labels. NOT executed in the
// sandbox — Chromium here cannot reach the public internet. Runs in CI
// (prod-ui target) with real Chromium.
const H1 = (name: string) => ({ name, exact: true });

test('nav: every top-level page loads with its heading', { requires: ['browser'], tags: ['ui'] }, async ({
  app,
  screen,
  browser,
}) => {
  const pages: Array<[string, string, RegExp]> = [
    ['/', 'Watch AI bots battle live crypto markets — with paper money.', /The Pit/],
    ['/leaderboard', 'Leaderboard', /Leaderboard — The Pit/],
    ['/pair/BTC-USD', 'BTC/USD', /BTC\/USD — Markets — The Pit/],
    ['/leagues', 'Fantasy Leagues', /Leagues — The Pit/],
    ['/agents', 'Agent quickstart', /Agents — The Pit/],
    ['/simulate', 'Simulator', /Simulator — The Pit/],
  ];
  for (const [path, heading, title] of pages) {
    await app.open(path);
    await expect(browser).toHaveTitle(title);
    await expect(screen.getByRole('heading', { level: 1, ...H1(heading) })).toBeVisible();
  }
});

test('nav: topnav links reach every section', { requires: ['browser'], tags: ['ui'] }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/');
  for (const label of ['Leaderboard', 'Leagues', 'Simulate', 'For agents']) {
    await expect(screen.getByRole('link', { name: label, exact: true }).first()).toBeVisible();
  }
  await screen.getByRole('link', { name: 'Leaderboard', exact: true }).first().click();
  await expect(browser).toHaveURL(/\/leaderboard/);
  await expect(screen.getByRole('heading', { level: 1, ...H1('Leaderboard') })).toBeVisible();
});

test('nav: unknown season shows the not-found page', { requires: ['browser'], tags: ['ui'] }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/leaderboard?season=no-such-season');
  await expect(browser).toHaveTitle(/Not found — The Pit/);
  await expect(
    screen.getByRole('heading', { level: 1, ...H1('Season not found') }),
  ).toBeVisible();
});

test('nav: unknown league slug shows the not-found page', { requires: ['browser'], tags: ['ui'] }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/league/no-such-league');
  await expect(browser).toHaveTitle(/League not found — The Pit/);
  await expect(
    screen.getByRole('heading', { level: 1, ...H1('League not found') }),
  ).toBeVisible();
});
