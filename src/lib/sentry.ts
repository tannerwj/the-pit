import * as Sentry from "@sentry/cloudflare";

/**
 * Report a caught cron failure to both the logs and Sentry. The scheduled()
 * catch blocks would otherwise swallow the error — Sentry only sees what
 * bubbles up unhandled, so every caught cron failure goes through here.
 */
export function reportCronError(cron: string, e: unknown): void {
  const msg = (e as Error)?.message ?? String(e);
  console.error(`scheduled ${cron} failed:`, msg);
  Sentry.captureException(e, { tags: { cron } });
}
