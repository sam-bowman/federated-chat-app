import { z } from "zod";

// What a person wants to hear and see when a message arrives, for everything and for one community, channel or conversation.
// Nothing here reads the config or the database, so it can be unit tested on its own.

export const TARGET_TYPES = ["GLOBAL", "COMMUNITY", "CHANNEL", "CONVERSATION"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

/** More than anyone needs; it only stops one account from filling the table. */
export const MAX_SETTINGS_PER_USER = 1000;

// A protocolId, which is what the API names communities, channels and conversations by. Not checked against what the person can
// see: it is their own preference, and one for something that no longer exists is only a row that never matches.
const TARGET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One change to one place. `sound` and `notify` are separate. `true` and `false` are a choice made HERE; `null` takes the choice
 * away (use the next level up); leaving one out leaves it as it was.
 */
export const settingChangeSchema = z
  .object({
    type: z.enum(TARGET_TYPES),
    id: z.string().regex(TARGET_ID).optional(),
    sound: z.boolean().nullable().optional(),
    notify: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((v) => (v.type === "GLOBAL" ? v.id === undefined : v.id !== undefined), {
    message: "a community, channel or conversation needs its id, and the global setting has none",
  })
  .refine((v) => v.sound !== undefined || v.notify !== undefined, { message: "nothing to change" });

export type SettingChange = z.infer<typeof settingChangeSchema>;

export interface SerializedSetting {
  type: TargetType;
  /** null for the global setting. */
  id: string | null;
  sound: boolean | null;
  notify: boolean | null;
}

export function serializeSetting(row: { targetType: TargetType; targetId: string; sound: boolean | null; notify: boolean | null }): SerializedSetting {
  return { type: row.targetType, id: row.targetType === "GLOBAL" ? null : row.targetId, sound: row.sound, notify: row.notify };
}

/** What a change leaves in place: the choices it names replace the old ones, the rest stay. Both null means nothing is stored. */
export function applyChange(
  existing: { sound: boolean | null; notify: boolean | null } | null,
  change: Pick<SettingChange, "sound" | "notify">
): { sound: boolean | null; notify: boolean | null; empty: boolean } {
  const sound = change.sound === undefined ? (existing?.sound ?? null) : change.sound;
  const notify = change.notify === undefined ? (existing?.notify ?? null) : change.notify;
  return { sound, notify, empty: sound === null && notify === null };
}
