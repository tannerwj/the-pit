// Shared helpers for prod read-only API tests.
export const PROD_URL = process.env.E2E_PROD_URL ?? "https://the-pit.twj.workers.dev";
export const SEASON_1_ID = "f3a84681-cf69-4483-aa5c-f35970065c69";
export const PAIRS = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD"];

export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, PROD_URL), init);
}

export async function errCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}
