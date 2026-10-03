import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// Read-only: fantasy league browser + league detail not-found state.
test(
  "leagues: browser renders with empty state",
  { requires: ["browser"], tags: ["ui"] },
  async ({ app, screen, browser }) => {
    await app.open("/leagues");
    await expect(browser).toHaveTitle(/Leagues/);
    await expect(
      screen.getByRole("heading", { level: 1, name: "Fantasy Leagues", exact: true }),
    ).toBeVisible();
    await expect(browser.locator("body")).toContainText("No public leagues yet — check back soon.");
    await expect(screen.getByRole("heading", { name: "Run your own league?" })).toBeVisible();
  },
);

test(
  "league: unknown slug shows not-found",
  { requires: ["browser"], tags: ["ui"] },
  async ({ app, screen, browser }) => {
    await app.open("/league/definitely-not-a-real-league");
    await expect(browser).toHaveTitle(/League not found/);
    await expect(
      screen.getByRole("heading", { level: 1, name: "League not found", exact: true }),
    ).toBeVisible();
    await expect(screen.getByRole("link", { name: /Browse leagues/ })).toBeVisible();
  },
);

test(
  "agents: quickstart page renders steps and code blocks",
  { requires: ["browser"], tags: ["ui"] },
  async ({ app, screen, browser }) => {
    await app.open("/agents");
    await expect(browser).toHaveTitle(/Agents/);
    await expect(screen.getByRole("heading", { level: 1, name: "Agent quickstart" })).toBeVisible();
    for (const step of [
      "Register",
      "Pick a season",
      "Enter the season",
      "Place your first trade",
    ]) {
      await expect(browser.locator("body")).toContainText(step);
    }
    await expect(browser.locator("body")).toContainText("api/v1/agents/register");
  },
);

test(
  "simulate: simulator controls render",
  { requires: ["browser"], tags: ["ui"] },
  async ({ app, screen, browser }) => {
    await app.open("/simulate");
    await expect(browser).toHaveTitle(/Simulator/);
    await expect(screen.getByRole("heading", { level: 1, name: "Simulator" })).toBeVisible();
    for (const pair of ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD"]) {
      await expect(screen.getByRole("button", { name: pair, exact: true })).toBeVisible();
    }
    await expect(browser.locator("#simCapital")).toBeVisible();
    await expect(screen.getByRole("button", { name: "+ Add trade" })).toBeVisible();
    await expect(screen.getByRole("button", { name: "Run simulation" })).toBeVisible();
  },
);
