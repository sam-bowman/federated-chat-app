// The address a program posts an incoming webhook to ends in its secret, so it is a credential and must not be written to a log when a
// request fails (app.ts logs the request line). Kept free of config.ts imports so it can be unit-tested on its own.

const WEBHOOK_POST = /^(\/api\/v1\/webhooks\/[^/?#]*\/)[^/?#]*/;

/** The request address as it may be logged: a webhook's secret is replaced. Everything else is unchanged. */
export function redactSecrets(url: string): string {
  return url.replace(WEBHOOK_POST, "$1[secret]");
}
