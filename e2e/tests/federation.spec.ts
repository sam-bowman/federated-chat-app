import { expect, test } from "@playwright/test";
import {
  befriend,
  closeAll,
  createCommunity,
  domainOf,
  joinCommunity,
  messageAction,
  messageWith,
  openCommunity,
  openDm,
  send,
  signUp,
  uniqueName,
} from "../support/app";

// Two real servers (alice.test and bob.test), each with its own database, talking over the signed federation protocol.

test("friends on different servers message each other, edit and delete, across the two servers", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await befriend(alice, bella);
    await openDm(alice, bella);
    await openDm(bella, alice);

    await send(alice.page, "Message Bella", "hello across the wire");
    await expect(messageWith(bella.page, "hello across the wire")).toHaveCount(1);

    await send(bella.page, "Message Alice", "and hello back");
    await expect(messageWith(alice.page, "and hello back")).toHaveCount(1);

    await messageAction(alice.page, "hello across the wire", "Edit message");
    await alice.page.locator(".message-body form input").fill("hello, edited");
    await alice.page.getByRole("button", { name: "Save" }).click();
    await expect(messageWith(bella.page, "hello, edited")).toContainText("(edited)");

    await messageAction(bella.page, "and hello back", "Delete message");
    await expect(alice.page.getByText("message deleted")).toBeVisible();

    // The other server saved it (it is not just a live echo): both still show the same after a reload.
    await bella.page.reload();
    await alice.page.reload();
    await expect(messageWith(bella.page, "hello, edited")).toHaveCount(1);
    await expect(messageWith(alice.page, "hello, edited")).toHaveCount(1);
    await expect(messageWith(alice.page, "and hello back")).toHaveCount(0);
  } finally {
    await closeAll([alice, bella]);
  }
});

// Two bugs only live testing had found: a relay that left out the acting member's own server (so it never kept their own
// message), and a send through the home server whose WebSocket echo drew the message twice.
test("a member from another server talks in a community: one copy each, kept on both servers", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const guest = await signUp(browser, "b", "bram");
  try {
    const name = uniqueName("club");
    const id = await createCommunity(owner.page, name);
    await joinCommunity(guest.page, name, `${id}:${domainOf("a")}`);
    await expect(guest.page.getByPlaceholder("Message #general")).toBeVisible();

    await send(guest.page, "Message #general", "from the other server");
    await expect(messageWith(owner.page, "from the other server")).toHaveCount(1);
    await expect(messageWith(guest.page, "from the other server")).toHaveCount(1);

    await send(owner.page, "Message #general", "from the home server");
    await expect(messageWith(guest.page, "from the home server")).toHaveCount(1);

    // The echo of the member's own message can arrive a moment after it is shown; it must not draw it again.
    await guest.page.waitForTimeout(1000);
    await expect(messageWith(guest.page, "from the other server")).toHaveCount(1);
    await expect(messageWith(guest.page, "from the home server")).toHaveCount(1);

    // Saved, not just shown: a reload fetches it again, from each person's own server.
    await guest.page.reload();
    await openCommunity(guest.page, name);
    await expect(messageWith(guest.page, "from the other server")).toHaveCount(1);
    await expect(messageWith(guest.page, "from the home server")).toHaveCount(1);
    await owner.page.reload();
    await expect(messageWith(owner.page, "from the other server")).toHaveCount(1);
  } finally {
    await closeAll([owner, guest]);
  }
});

// The echo of a proxied send (the home server relaying it back) and the reply to the send itself race each other, and either
// can win. Left to chance the second order almost never happens, so this holds the reply back until the echo has been shown.
test("a member from another server whose message's echo arrives before the reply sees it once", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const guest = await signUp(browser, "b", "bram");
  try {
    const name = uniqueName("club");
    const id = await createCommunity(owner.page, name);
    await joinCommunity(guest.page, name, `${id}:${domainOf("a")}`);
    await expect(guest.page.getByPlaceholder("Message #general")).toBeVisible();

    let releaseReply: () => void = () => {};
    const replyHeld = new Promise<void>((resolve) => (releaseReply = resolve));
    await guest.page.route("**/api/v1/channels/*/messages", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const response = await route.fetch();
      await replyHeld;
      await route.fulfill({ response });
    });

    await send(guest.page, "Message #general", "echo first");
    await expect(messageWith(guest.page, "echo first")).toHaveCount(1); // drawn from the echo, the reply is still held
    releaseReply();
    await guest.page.waitForTimeout(1000);
    await expect(messageWith(guest.page, "echo first")).toHaveCount(1);
  } finally {
    await closeAll([owner, guest]);
  }
});
