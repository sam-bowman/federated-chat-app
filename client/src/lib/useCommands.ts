import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { CommunityCommands } from "../api";
import { useWs } from "../context/WsContext";

const NONE: CommunityCommands = { commands: [], canUse: false };

/**
 * The slash commands a person may run in a community (#132, phase 3b), asked for when the community opens and again whenever they may have changed: a bot
 * registered new ones (`commands:updated`), a bot was added or removed or a role changed (`community:updated`), or the connection came back (`ws:open`: pushed
 * events are not replayed). `enabled` is false for a community on another server, which has none here. An answer for a community that is no longer the one
 * being asked about is dropped, and nothing is offered for a community that has not answered yet.
 */
export function useCommands(communityId: string | null | undefined, enabled: boolean): CommunityCommands {
  const { subscribe } = useWs();
  // Held in a ref so a new function each render cannot make this ask again each render: it asks when the community changes, not when the page is drawn.
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  const [answer, setAnswer] = useState<{ communityId: string; value: CommunityCommands } | null>(null);
  const active = enabled && !!communityId;

  const load = useCallback(
    (isCurrent: () => boolean) => {
      if (!communityId) return;
      api
        .listCommunityCommands(communityId)
        .then((value) => {
          if (isCurrent()) setAnswer({ communityId, value });
        })
        // Not being able to ask means no commands are offered; the person can still type text.
        .catch(() => undefined);
    },
    [communityId]
  );

  useEffect(() => {
    if (!active) return;
    let current = true;
    const isCurrent = () => current;
    load(isCurrent);
    const refresh = (payload?: { communityId?: string }) => {
      if (payload?.communityId && payload.communityId !== communityId) return;
      load(isCurrent);
    };
    const on = subscribeRef.current;
    const unsubs = [on("commands:updated", () => refresh()), on("community:updated", refresh), on("ws:open", () => refresh())];
    return () => {
      current = false;
      unsubs.forEach((u) => u());
    };
  }, [active, communityId, load]);

  return active && answer && answer.communityId === communityId ? answer.value : NONE;
}
