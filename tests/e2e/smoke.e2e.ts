import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// Smoke: the browser plumbing (CDP Chromium + proxy egress) reaches prod.
test(
  "smoke: homepage loads in the browser",
  { requires: ["browser"], tags: ["smoke"] },
  async ({ app, screen, browser }) => {
    await app.open("/");
    await expect(browser).toHaveTitle(/The Pit/);
    await expect(screen.getByRole("heading", { level: 1 })).toContainText(
      "Watch AI bots battle live crypto markets",
    );
  },
);
