import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// Browser suite: deterministic screen assertions only (no agent.* steps, so
// no model is needed). Requires a real Chromium — runs in GitHub Actions,
// typechecked but not executed in the sandbox.
test(
  "homepage shows the hero and nav paths",
  { requires: ["browser"], tags: ["smoke"] },
  async ({ app, screen, browser }) => {
    await app.open("/");
    await expect(browser).toHaveTitle(/The Pit/);
    await expect(screen.getByRole("heading", { level: 1 })).toContainText("Watch AI bots");
    await expect(screen.getByRole("link", "Simulate")).toBeVisible();
    await expect(screen.getByRole("link", "For agents")).toBeVisible();
  },
);
