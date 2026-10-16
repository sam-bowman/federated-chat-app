import { expect, test } from "@playwright/test";
import { befriend, closeAll, createCommunity, domainOf, goToFriends, joinCommunity, messageWith, openDm, send, signUp, uniqueName } from "../support/app";
import type { Person } from "../support/app";

// Who may start something with a person (#109 phase 3b), through the real Settings page and two real servers.

async function chooseWhoCanContact(person: Person, choice: RegExp) {
  await person.page.getByRole("button", { name: "Settings" }).click();
  // The choice shows at once, before it is saved, so wait for the save itself: a reload straight away would cancel it.
  const saved = person.page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/api/v1/users/me") && r.ok());
  await person.page.getByRole("radio", { name: choice }).check();
  await saved;
  // The server has it before anyone relies on it: reload and look again.
  await person.page.reload();
  await expect(person.page.getByRole("radio", { name: choice })).toBeChecked();
}

async function sendRequest(from: Person, to: string) {
  await goToFriends(from.page);
  await from.page.getByRole("combobox").fill(to);
  await from.page.getByRole("button", { name: "Send request" }).click();
}

test("someone who only accepts people on their own server refuses a friend request from another, and accepts it again when they change their mind", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await chooseWhoCanContact(bella, /^People on this server/);

    await sendRequest(alice, bella.identity);
    await expect(alice.page.getByText("This person isn't accepting friend requests from you.")).toBeVisible();

    await chooseWhoCanContact(bella, /^Anyone/);
    await sendRequest(alice, bella.identity);
    await expect(alice.page.getByText(/Friend request sent to/)).toBeVisible();
  } finally {
    await closeAll([alice, bella]);
  }
});

test("someone on the same server is still let in by 'people on this server'", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const ben = await signUp(browser, "a", "ben");
  try {
    await chooseWhoCanContact(ben, /^People on this server/);

    await sendRequest(alice, ben.username);

    await expect(alice.page.getByText(/Friend request sent to/)).toBeVisible();
  } finally {
    await closeAll([alice, ben]);
  }
});

test("'people I share a community with' lets in someone from another server once they share one", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await chooseWhoCanContact(bella, /^People I share a community with/);
    const name = uniqueName("club");
    const id = await createCommunity(alice.page, name);

    await sendRequest(alice, bella.identity);
    await expect(alice.page.getByText("This person isn't accepting friend requests from you.")).toBeVisible();

    await joinCommunity(bella.page, name, `${id}:${domainOf("a")}`);

    // Alice's own server asks bella's, which now sees them in a community together.
    await sendRequest(alice, bella.identity);
    await expect(alice.page.getByText(/Friend request sent to/)).toBeVisible();
  } finally {
    await closeAll([alice, bella]);
  }
});

test("a friend can still start a conversation whatever was chosen, and what already exists carries on", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await befriend(alice, bella);
    await openDm(alice, bella);
    await openDm(bella, alice);

    await chooseWhoCanContact(bella, /^People on this server/);
    await openDm(bella, alice);

    await send(alice.page, "Message Bella", "still allowed");
    await expect(messageWith(bella.page, "still allowed")).toHaveCount(1);
  } finally {
    await closeAll([alice, bella]);
  }
});
