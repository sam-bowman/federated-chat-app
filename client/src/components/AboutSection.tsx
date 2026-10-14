import { useEffect, useState } from "react";
import { getHomeServer } from "../api/client";
import { fetchServerInfo, type ServerInfo } from "../api/discovery";
import { clientVersion } from "../lib/version";

type State = { status: "loading" } | { status: "failed" } | { status: "ready"; info: ServerInfo };

/** Settings: which client build you are running and which release of server it is talking to. */
export default function AboutSection() {
  const origin = getHomeServer()?.origin;
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!origin) return;
    const controller = new AbortController();
    fetchServerInfo(origin, controller.signal)
      .then((info) => setState({ status: "ready", info }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "failed" });
      });
    return () => controller.abort();
  }, [origin]);

  return (
    <>
      <h3>About</h3>
      <dl className="about-list">
        <dt>Client</dt>
        <dd>{clientVersion === "dev" ? "development build" : `v${clientVersion}`}</dd>
        <dt>Home server</dt>
        <dd>
          {state.status === "loading" && "Checking…"}
          {state.status === "failed" && "Couldn't reach the server to check its version."}
          {state.status === "ready" && (
            <>
              {state.info.serverName}
              {state.info.domain && ` (${state.info.domain})`}
              <br />
              {state.info.serverVersion ? `v${state.info.serverVersion}` : "version not reported (an older server)"}
              {state.info.protocolVersion && ` · federation protocol ${state.info.protocolVersion}`}
            </>
          )}
        </dd>
      </dl>
    </>
  );
}
