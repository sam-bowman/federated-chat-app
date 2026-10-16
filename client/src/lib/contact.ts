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

/** Who a server's limit lets in, as the end of "This server only lets ... send you a friend request or start a conversation". */
const LIMIT_WHO: Record<ContactPolicy, string> = {
  ANYONE: "anyone",
  SHARED_COMMUNITY: "people who share a community with you",
  LOCAL_ONLY: "people on this server",
};

/** What to tell someone about their server's limit on who may contact them, or null when there is none. */
export function contactLimitNote(limit: ContactPolicy | undefined): string | null {
  if (limit === undefined || limit === "ANYONE") return null;
  return `This server only lets ${LIMIT_WHO[limit]} send friend requests or start conversations, whatever you choose here. You can narrow it further.`;
}

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
