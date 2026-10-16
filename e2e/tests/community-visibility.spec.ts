import { expect, test } from "@playwright/test";
import { chooseWhoCanJoin, closeAll, createCommunity, domainOf, joinCommunity, signUp, uniqueName } from "../support/app";
import type { Person } from "../support/app";

// Who may join a community (#109 phase 4), through the real settings dialog and two real servers.

async function tryJoin(person: Person, reference: string) {
  await person.page.getByRole("button", { name: "Create a community" }).click();
  await person.page.getByRole("tab", { name: "Join by ID" }).click();
  await person.page.getByPlaceholder(/Invite code/).fill(reference);
  await person.page.getByRole("button", { name: "Join", exact: true }).click();
}

test("a community that takes only people on its own server cannot be found from another, and can from its own", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const local = await signUp(browser, "a", "lena");
  const far = await signUp(browser, "b", "bram");
  try {
    const name = uniqueName("club");
    const id = await createCommunity(owner.page, name);
    await chooseWhoCanJoin(owner, /^Only people on this server/);

    await tryJoin(far, `${id}:${domainOf("a")}`);
    await expect(far.page.getByText("Couldn't find or join that community.")).toBeVisible();
    await far.page.keyboard.press("Escape");

    await joinCommunity(local.page, name, id);
    await expect(local.page.getByPlaceholder("Message #general")).toBeVisible();
  } finally {
    await closeAll([owner, local, far]);
  }
});

test("an invite-only community says so to someone who has only its code, and opening it again lets them in", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const guest = await signUp(browser, "a", "gus");
  try {
    const name = uniqueName("club");
    const id = await createCommunity(owner.page, name);
    await chooseWhoCanJoin(owner, /^Only people with an invite/);

    await tryJoin(guest, id);
    await expect(guest.page.getByText("This community is invite-only. Ask a member to invite you.")).toBeVisible();
    await guest.page.keyboard.press("Escape");

    await chooseWhoCanJoin(owner, /^Anyone with the community code/);
    await joinCommunity(guest.page, name, id);
    await expect(guest.page.getByPlaceholder("Message #general")).toBeVisible();
  } finally {
    await closeAll([owner, guest]);
  }
});

test("someone from another server who is already in stays in when it is switched to local-only", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const far = await signUp(browser, "b", "bram");
  try {
    const name = uniqueName("club");
    const id = await createCommunity(owner.page, name);
    await joinCommunity(far.page, name, `${id}:${domainOf("a")}`);

    await chooseWhoCanJoin(owner, /^Only people on this server/);

    await far.page.reload();
    await expect(far.page.getByRole("navigation", { name: "Communities" }).getByRole("link", { name })).toBeVisible();
  } finally {
    await closeAll([owner, far]);
  }
});
