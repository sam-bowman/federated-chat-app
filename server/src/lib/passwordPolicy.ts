import { z } from "zod";

// Length and character-class checks are separate zod checks (not one
// combined refine) specifically so a too-short password reports as a
// length problem, not a confusing "missing a symbol" message that would
// also technically be true - zod collects every failing check for a
// field, and the client (friendlyError() in AuthPage.tsx) just shows the
// first one, which is whichever is defined first below.
export const passwordSchema = z
  .string()
  .min(8, "password must be at least 8 characters")
  .max(256)
  .refine(
    (password) => /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password) && /[^a-zA-Z0-9]/.test(password),
    "password must include an uppercase letter, a lowercase letter, a number, and a symbol"
  );
