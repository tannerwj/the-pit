import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { SEASON_1_ID } from "./support/prod.js";

// Read-only: mobile layout — the dark exchange UI must stay usable at a
// phone viewport (no horizontal overflow of the core chrome).
test(
  "mobile: home page renders cleanly at 390px",
  { requires: ["browser"], tags: ["ui", "mobile"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open("/");
    await expect(browser).toHaveTitle(/The Pit/);
    await expect(screen.getByRole("heading", { level: 1 })).toContainText(
      "Watch AI bots battle live crypto markets",
    );

    // Top nav brand + key links still present.
    await expect(browser.locator(".topnav").getByRole("link", { name: "THE PIT" })).toBeVisible();
    await expect(
      browser.locator(".topnav").getByRole("link", { name: "Leaderboard" }),
    ).toBeVisible();

    // Markets table fits: no horizontal scroll on the body.
    const scrollW = await browser.evaluate(() => document.documentElement.scrollWidth);
    const clientW = await browser.evaluate(() => document.documentElement.clientWidth);
    expect(scrollW).toBeLessThanOrEqual(clientW + 1);
  },
);

test(
  "mobile: leaderboard table is reachable at 390px",
  { requires: ["browser"], tags: ["ui", "mobile"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 });
    // Pin Season 1 (settled, immutable) so the table renders regardless of
    // whether a season is currently live.
    await app.open(`/leaderboard?season=${SEASON_1_ID}`);
    await expect(
      screen.getByRole("heading", { level: 1, name: "Leaderboard", exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("columnheader", { name: "Alpha", exact: true }).first(),
    ).toBeVisible();
    // Table fits the phone viewport: no horizontal page scroll.
    const scrollW = await browser.evaluate(() => document.documentElement.scrollWidth);
    const clientW = await browser.evaluate(() => document.documentElement.clientWidth);
    expect(scrollW).toBeLessThanOrEqual(clientW + 1);
  },
);
