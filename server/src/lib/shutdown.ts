export interface ShutdownStep {
  name: string;
  run(): Promise<unknown> | unknown;
}

/**
 * Runs the shutdown steps in order. A step that throws or takes longer than `stepTimeoutMs`
 * is reported and skipped, so one stuck step (a client that never answers a close frame, a
 * request that never finishes) cannot keep the rest from running or the process from exiting.
 */
export async function runShutdown(
  steps: ShutdownStep[],
  stepTimeoutMs: number,
  log: Pick<Console, "error"> = console
): Promise<void> {
  for (const step of steps) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => step.run()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${stepTimeoutMs} ms`)), stepTimeoutMs);
        }),
      ]);
    } catch (err) {
      log.error(`[shutdown] ${step.name} failed:`, err instanceof Error ? err.message : err);
    } finally {
      clearTimeout(timer);
    }
  }
}
