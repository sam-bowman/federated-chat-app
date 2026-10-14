// Injected by Vite (`define` in vite.config.ts) from client/package.json, which
// release-please bumps. Not defined under Vitest, which doesn't use that config.
declare const __APP_VERSION__: string | undefined;

export const clientVersion: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
