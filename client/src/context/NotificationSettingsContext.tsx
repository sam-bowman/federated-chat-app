import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import * as api from "../api";
import type { NotificationSetting, NotificationTargetType } from "../api";
import { emptyPrefs, indexPrefs, withChange, withSetting, type PrefsIndex } from "../lib/notificationPrefs";
import { useWs } from "./WsContext";

export interface NotificationChange {
  type: NotificationTargetType;
  id?: string;
  sound?: boolean | null;
  notify?: boolean | null;
}

interface Value {
  prefs: PrefsIndex;
  /** False until the person's choices have arrived (until then everything is on, the default). */
  loaded: boolean;
  /** Changes one place's choices at once, on screen and on the server (put back if the server refuses). */
  update: (change: NotificationChange) => Promise<void>;
}

const NotificationSettingsContext = createContext<Value | null>(null);

/**
 * What the person has chosen to hear and see when a message arrives (kept on the server, so it follows them to every device).
 * Another device's change arrives over the websocket and is taken as it is made.
 */
export function NotificationSettingsProvider({ children }: { children: ReactNode }) {
  const { subscribe } = useWs();
  const [prefs, setPrefs] = useState<PrefsIndex>(emptyPrefs);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      setPrefs(indexPrefs(await api.getNotificationSettings()));
      setLoaded(true);
    } catch {
      // Keep what we have: the defaults (everything on) are a safe thing to run with.
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () =>
      subscribe("notification-settings:updated", (payload: { setting?: NotificationSetting }) => {
        if (payload?.setting) setPrefs((current) => withSetting(current, payload.setting!));
        else void reload();
      }),
    [subscribe, reload]
  );

  const update = useCallback(
    async (change: NotificationChange) => {
      setPrefs((current) => withChange(current, change));
      try {
        const { setting } = await api.setNotificationSetting(change);
        setPrefs((current) => withSetting(current, setting));
      } catch {
        await reload();
      }
    },
    [reload]
  );

  const value = useMemo(() => ({ prefs, loaded, update }), [prefs, loaded, update]);
  return <NotificationSettingsContext.Provider value={value}>{children}</NotificationSettingsContext.Provider>;
}

const NOTHING: Value = { prefs: emptyPrefs(), loaded: false, update: async () => {} };

/** Without a provider (a page rendered on its own, in a test) everything is on and nothing can be changed, as for UserLink. */
export function useNotificationSettings(): Value {
  return useContext(NotificationSettingsContext) ?? NOTHING;
}
