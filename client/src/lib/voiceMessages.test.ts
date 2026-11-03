import { describe, expect, it } from "vitest";
import livekitSource from "../../../node_modules/livekit-client/dist/livekit-client.esm.mjs?raw";
import { connectFailureMessage } from "./voiceMessages";

const BLOCKED = /audio couldn't get through/;
const UNREACHABLE = "Couldn't connect to the voice server. Try again.";

describe("connectFailureMessage (#245)", () => {
  it("says the audio is blocked when the server answered but no audio path came up", () => {
    // The three ways the voice library gives up on the audio connection (see the next test: these are its own words).
    expect(connectFailureMessage(new Error("could not establish pc connection"))).toMatch(BLOCKED);
    expect(connectFailureMessage(new Error("could not establish PC connection, ICE failed"))).toMatch(BLOCKED);
    expect(connectFailureMessage(new Error("could not establish publisher connection, state: failed"))).toMatch(BLOCKED);
  });

  it("keeps 'try again' for a server that could not be reached at all", () => {
    expect(connectFailureMessage(new Error("could not establish signal connection"))).toBe(UNREACHABLE);
    expect(connectFailureMessage(new Error("websocket closed"))).toBe(UNREACHABLE);
    expect(connectFailureMessage("not an error")).toBe(UNREACHABLE);
    expect(connectFailureMessage(undefined)).toBe(UNREACHABLE);
  });

  it("matches the words the installed voice library really uses", () => {
    // If an upgrade rewords these, the message above would quietly go back to 'try again' for a blocked network.
    expect(livekitSource).toContain("could not establish pc connection");
    expect(livekitSource).toContain("could not establish signal connection");
  });
});
