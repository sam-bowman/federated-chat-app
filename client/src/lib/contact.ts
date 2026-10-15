// Who may start something with a person (#109, phase 3): the three choices they can make, in the words the Settings page uses,
// and what someone is told when the person they tried to reach does not accept it from them. The server decides (and says
// `403 contact_not_allowed`); nothing here is a check, only wording.

export type ContactPolicy = "ANYONE" | "SHARED_COMMUNITY" | "LOCAL_ONLY";

export const CONTACT_CHOICES: { value: ContactPolicy; label: string; description: string }[] = [
  { value: "ANYONE", label: "Anyone", description: "Anyone who can find you can send you a friend request or start a conversation." },
  {
    value: "SHARED_COMMUNITY",
    label: "People I share a community with",
    description: "Nobody else can send you a friend request or start a conversation, on this server or another.",
  },
  {
    value: "LOCAL_ONLY",
    label: "People on this server",
    description: "Only people on your own server can send you a friend request or start a conversation.",
  },
];

/** Whether an API answer means the person's setting does not let the asker start this. */
export function isContactRefusal(code: string | undefined): boolean {
  return code === "contact_not_allowed";
}

/** What the person is told: deliberately the same whichever choice was made, so it does not say what the other person chose. */
export function contactRefusalMessage(what: "request" | "conversation"): string {
  return what === "request"
    ? "This person isn't accepting friend requests from you."
    : "This person isn't accepting conversations from you.";
}
