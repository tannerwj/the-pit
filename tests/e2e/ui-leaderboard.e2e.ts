import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { SEASON_1_ID } from "./support/prod.js";

// Read-only: leaderboard page structure — headers, Alpha Score explainer,
// empty state, season switcher. Pins Season 1 (settled, immutable) so the
// structural assertions hold whether or not a season is currently live.
test(
  "leaderboard: columns, empty state and season switcher",
  { requires: ["browser"], tags: ["ui"] },
  async ({ app, screen, browser }) => {
    await app.open(`/leaderboard?season=${SEASON_1_ID}`);
    await expect(browser).toHaveTitle(/Leaderboard/);
    await expect(
      screen.getByRole("heading", { level: 1, name: "Leaderboard", exact: true }),
    ).toBeVisible();

    // Exact column order from the server-rendered table.
    const headers = [
      "#",
      "Agent",
      "Alpha",
      "Return",
      "Sharpe",
      "Max DD",
      "Win rate",
      "Trades",
      "Equity",
      "Trend",
    ];
    for (const h of headers) {
      await expect(
        screen.getByRole("columnheader", { name: h, exact: true }).first(),
      ).toBeVisible();
    }

    // Alpha Score explainer note under the table.
    await expect(browser.locator("body")).toContainText("Alpha Score v1: 0–100, risk-adjusted");

    // Season switcher lists Season 1 as settled; settled badge (not live).
    const switcher = browser.locator("#seasonSel");
    await expect(switcher).toBeVisible();
    await expect(switcher).toContainText("Season 1 (settled)");
    await expect(browser.locator(".badge-dim").first()).toContainText("SETTLED");

    // Empty-state row (no entries in Season 1).
    await expect(browser.locator("body")).toContainText("No entries yet.");
  },
);

test(
  "leaderboard: unknown season shows not-found",
  { requires: ["browser"], tags: ["ui"] },
  async ({ app, screen, browser }) => {
    await app.open("/leaderboard?season=00000000-0000-0000-0000-000000000000");
    await expect(browser).toHaveTitle(/Not found/);
    await expect(
      screen.getByRole("heading", { level: 1, name: "Season not found", exact: true }),
    ).toBeVisible();
  },
);

test(
  "leaderboard: bare page renders a valid state",
  { requires: ["browser"], tags: ["ui"] },
  async ({ app, screen, browser }) => {
    // Without ?season= the page follows the live season if there is one,
    // otherwise it shows the intermission note — either is a valid render.
    await app.open("/leaderboard");
    await expect(
      screen.getByRole("heading", { level: 1, name: "Leaderboard", exact: true }),
    ).toBeVisible();
    const bodyText = (await browser.locator("body").textContent()) ?? "";
    expect(bodyText).toMatch(/No seasons yet\.|No entries yet\.|data-season=/);
  },
);
