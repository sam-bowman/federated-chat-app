import { expect, test } from "@playwright/test";
import { befriend, closeAll, messageWith, openDm, send, signUp, goToFriends } from "../support/app";
import type { Person } from "../support/app";

// Who can find a person (#109 phase 3), through the real Settings page and two real servers.

async function setFindable(person: Person, findable: boolean) {
  await person.page.getByRole("button", { name: "Settings" }).click();
  const box = person.page.getByRole("checkbox", { name: "Let people on other servers find me" });
  await expect(box).toBeVisible();
  if ((await box.isChecked()) !== findable) await box.click();
  await expect(box).toBeChecked({ checked: findable });
  // The server has it before anyone relies on it: reload and look again.
  await person.page.reload();
  await expect(person.page.getByRole("checkbox", { name: "Let people on other servers find me" })).toBeChecked({ checked: findable });
}

async function sendRequest(from: Person, to: string) {
  await goToFriends(from.page);
  await from.page.getByRole("combobox").fill(to);
  await from.page.getByRole("button", { name: "Send request" }).click();
}

test("a person who hides cannot be found from another server, and can be again once they stop hiding", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await setFindable(bella, false);

    await sendRequest(alice, bella.identity);
    await expect(alice.page.getByText("No one with that name was found.")).toBeVisible();

    await setFindable(bella, true);
    await sendRequest(alice, bella.identity);
    await expect(alice.page.getByText(/Friend request sent to/)).toBeVisible();
  } finally {
    await closeAll([alice, bella]);
  }
});

test("hiding does not cut off friends: what they have together carries on", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await befriend(alice, bella);
    await openDm(alice, bella);
    await openDm(bella, alice);

    await setFindable(bella, false);
    await openDm(bella, alice);

    await send(alice.page, "Message Bella", "still there?");
    await expect(messageWith(bella.page, "still there?")).toHaveCount(1);
    await send(bella.page, "Message Alice", "yes, just hidden");
    await expect(messageWith(alice.page, "yes, just hidden")).toHaveCount(1);
  } finally {
    await closeAll([alice, bella]);
  }
});

test("someone on the same server can still find a person who hides", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const ben = await signUp(browser, "a", "ben");
  try {
    await setFindable(ben, false);

    await sendRequest(alice, ben.username);

    await expect(alice.page.getByText(/Friend request sent to/)).toBeVisible();
  } finally {
    await closeAll([alice, ben]);
  }
});

test("a person who hides can still reach out themselves, and the other person can then answer", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await setFindable(bella, false);

    await sendRequest(bella, alice.identity);
    await expect(bella.page.getByText(/Friend request sent to/)).toBeVisible();

    // A request in flight is something alice's server and bella's already share, so alice can still look her up and answer.
    await goToFriends(alice.page);
    await alice.page.getByRole("tab", { name: /Incoming/ }).click();
    await expect(alice.page.getByText(bella.identity)).toBeVisible();
    await alice.page.getByRole("button", { name: "Accept" }).click();
    await alice.page.getByRole("tab", { name: /^Friends/ }).click();
    await expect(alice.page.getByText(bella.identity)).toBeVisible();
  } finally {
    await closeAll([alice, bella]);
  }
});
