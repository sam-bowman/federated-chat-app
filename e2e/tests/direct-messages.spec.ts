import { expect, test } from "@playwright/test";
import { befriend, closeAll, messageAction, messageWith, openDm, send, signUp } from "../support/app";

test("two people on one server become friends, then send, edit and delete messages live", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const ben = await signUp(browser, "a", "ben");
  try {
    await befriend(alice, ben);
    await openDm(alice, ben);
    await openDm(ben, alice);

    // Arrives on the other side without anyone reloading: that is the WebSocket path.
    await send(alice.page, "Message Ben", "hello ben");
    await expect(messageWith(ben.page, "hello ben")).toHaveCount(1);
    await expect(messageWith(alice.page, "hello ben")).toHaveCount(1);

    await send(ben.page, "Message Alice", "hello alice");
    await expect(messageWith(alice.page, "hello alice")).toHaveCount(1);

    // Edit: the new text replaces the old on both sides and is marked as edited.
    await messageAction(alice.page, "hello ben", "Edit message");
    await alice.page.locator(".message-body form input").fill("hello again ben");
    await alice.page.getByRole("button", { name: "Save" }).click();
    await expect(messageWith(ben.page, "hello again ben")).toContainText("(edited)");
    await expect(messageWith(ben.page, "hello ben")).toHaveCount(0);

    // Delete: the other side is told, and the text is gone.
    await messageAction(alice.page, "hello again ben", "Delete message");
    await expect(ben.page.getByText("message deleted")).toBeVisible();
    await expect(messageWith(ben.page, "hello again ben")).toHaveCount(0);

    // What is left is still there after a reload (it was saved, not just shown).
    await ben.page.reload();
    await expect(messageWith(ben.page, "hello alice")).toHaveCount(1);
  } finally {
    await closeAll([alice, ben]);
  }
});

test("a friend request can be declined, and the person who sent it is not made a friend", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const ben = await signUp(browser, "a", "ben");
  try {
    await alice.page.getByRole("link", { name: /Friends & DMs/ }).click();
    await alice.page.getByRole("combobox").fill(ben.username);
    await alice.page.getByRole("button", { name: "Send request" }).click();
    await expect(alice.page.getByText(/Friend request sent to/)).toBeVisible();

    await ben.page.getByRole("link", { name: /Friends & DMs/ }).click();
    await ben.page.getByRole("tab", { name: /Incoming/ }).click();
    await ben.page.getByRole("button", { name: "Decline" }).click();
    await expect(ben.page.getByRole("tab", { name: "Incoming (0)" })).toBeVisible();

    await alice.page.reload();
    await expect(alice.page.getByRole("tab", { name: "Friends (0)" })).toBeVisible();
    await expect(alice.page.getByRole("tab", { name: "Outgoing (0)" })).toBeVisible();
  } finally {
    await closeAll([alice, ben]);
  }
});
