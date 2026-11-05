// A small bot for this chat platform (#132): answers "!ping" with "pong", "!echo <words>" with the words, and "!card <words>" with a card.
//
//   CHAT_URL=https://chat.example BOT_TOKEN=mcb_... node bot.mjs
//
// It shows the whole contract in one file: the token goes in `Authorization: Bot <token>` (never in the address), events arrive on the
// WebSocket, and it answers with the ordinary REST API. The bot only hears the communities a manager has added it to, and can only do what
// its roles there allow. See docs/bots.md.
import WebSocket from "ws";

const base = (process.env.CHAT_URL ?? "").replace(/\/+$/, "");
const token = process.env.BOT_TOKEN ?? "";
if (!base || !token) {
  console.error("Set CHAT_URL (the server's address, e.g. https://chat.example) and BOT_TOKEN (shown once when you made the bot).");
  process.exit(1);
}

const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };

async function api(path, options = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { ...options, headers });
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} answered ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const { user: me } = await api("/users/me");
console.log(`Signed in as ${me.identity} (${me.displayName})`);

async function say(channelId, content) {
  await api(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
}

// A card (an embed) is structured, not text: a title, a description, fields, a stripe colour. Add `image` or `thumbnail` (the address of a
// picture) and the server fetches it once and shows its own copy. See "Cards" in docs/bots.md.
async function card(channelId, words) {
  await api(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      embeds: [
        {
          title: words.slice(0, 150),
          description: "A card from the example bot.",
          color: "#5865f2",
          fields: [
            { name: "Sent by", value: me.displayName, inline: true },
            { name: "At", value: new Date().toISOString(), inline: true },
          ],
          footer: "examples/echo-bot",
        },
      ],
    }),
  });
}

function handle(event) {
  // A bot is not told about its own messages, so it cannot answer itself into a loop; it still ignores other bots to be safe.
  if (event.type !== "message:created" || !event.channelId) return;
  const { message } = event;
  if (message.sender.isBot || typeof message.content !== "string") return;

  if (message.content === "!ping") return say(event.channelId, "pong").catch(console.error);
  if (message.content.startsWith("!echo ")) return say(event.channelId, message.content.slice("!echo ".length)).catch(console.error);
  if (message.content.startsWith("!card ")) return card(event.channelId, message.content.slice("!card ".length)).catch(console.error);
}

function connect(attempt = 0) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws`, { headers: { Authorization: `Bot ${token}` } });
  socket.on("open", () => {
    attempt = 0;
    console.log("Connected: listening for messages.");
  });
  socket.on("message", (raw) => {
    try {
      handle(JSON.parse(raw.toString()));
    } catch (err) {
      console.error("Could not handle an event:", err);
    }
  });
  socket.on("close", (code) => {
    // 4001 means the token is not (or no longer) good: reconnecting would only be refused again.
    if (code === 4001) {
      console.error("The server refused the token (revoked, replaced, or the bot was deleted). Stopping.");
      process.exit(1);
    }
    const wait = Math.min(30_000, 1000 * 2 ** attempt);
    console.log(`Disconnected (${code}); reconnecting in ${wait / 1000}s.`);
    setTimeout(() => connect(attempt + 1), wait);
  });
  socket.on("error", (err) => console.error("Socket error:", err.message));
}

connect();
