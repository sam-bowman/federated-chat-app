import { expect, test } from "@playwright/test";
import { chooseWhoCanJoin, closeAll, createCommunity, domainOf, signUp, uniqueName } from "../support/app";
import type { Person } from "../support/app";

// The directory (#109 phase 5), through the real pages and two real servers: alice.test publishes one, bob.test does not.

const browse = (person: Person) => person.page.getByRole("link", { name: "Browse communities" }).click();

/** Looks for one person by their (unique) username: the directory is shared by every test that runs at once. */
async function searchPeople(person: Person, username: string) {
  await person.page.getByLabel("Search people").fill(username);
  await person.page.getByRole("button", { name: "Search", exact: true }).click();
}

async function browseServer(person: Person, domain: string) {
  await person.page.getByLabel("Server to browse").fill(domain);
  await person.page.getByRole("button", { name: "Browse", exact: true }).click();
}

/** Lists the person in their server's directory of people, from Settings -> Privacy. */
async function listMe(person: Person) {
  await person.page.getByRole("button", { name: "Settings" }).click();
  const box = person.page.getByRole("checkbox", { name: "List me in this server's directory of people" });
  const saved = person.page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/api/v1/users/me") && r.ok());
  // This box follows what the server says, so it does not change until the save is done: click, wait for it, then look.
  await box.click();
  await saved;
  await expect(box).toBeChecked();
}

test("a public community is listed for its own server's people, who can join it from there", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const local = await signUp(browser, "a", "lena");
  try {
    const name = uniqueName("club");
    await createCommunity(owner.page, name);
    await local.page.reload();
    await browse(local);
    await expect(local.page.getByText(name)).toHaveCount(0); // not public yet

    await chooseWhoCanJoin(owner, /^Public: listed in the directory/);
    await local.page.reload();
    await browse(local);
    await expect(local.page.getByText(name)).toBeVisible();

    await local.page.getByRole("button", { name: `Join ${name}` }).click();
    await expect(local.page).toHaveURL(/\/communities\//);
    await expect(local.page.getByPlaceholder("Message #general")).toBeVisible();
  } finally {
    await closeAll([owner, local]);
  }
});

test("someone on another server browses a server's directory through their own, and joins from it", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const far = await signUp(browser, "b", "bram");
  try {
    const name = uniqueName("club");
    await createCommunity(owner.page, name);
    await chooseWhoCanJoin(owner, /^Public: listed in the directory/);

    await browse(far);
    await browseServer(far, domainOf("a"));
    await expect(far.page.getByText(name)).toBeVisible();
    await far.page.getByRole("button", { name: `Join ${name}` }).click();

    await expect(far.page).toHaveURL(/\/communities\//);
    await expect(far.page.getByPlaceholder("Message #general")).toBeVisible();
  } finally {
    await closeAll([owner, far]);
  }
});

test("a community that is not public is not listed, even for people who could join it", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const far = await signUp(browser, "b", "bram");
  try {
    const name = uniqueName("club");
    await createCommunity(owner.page, name); // anyone with the code can join, but it is not listed

    await browse(far);
    await browseServer(far, domainOf("a"));

    await expect(far.page.getByText(name)).toHaveCount(0);
  } finally {
    await closeAll([owner, far]);
  }
});

test("a server that publishes no directory says so, and is not mistaken for one that is down", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  try {
    await browse(alice);
    await browseServer(alice, domainOf("b"));

    await expect(alice.page.getByText(`${domainOf("b")} doesn't publish a directory.`)).toBeVisible();
  } finally {
    await closeAll([alice]);
  }
});

test("people who chose to be listed can be found in the directory and added, from another server too", async ({ browser }) => {
  const listed = await signUp(browser, "a", "lena");
  const quiet = await signUp(browser, "a", "quentin");
  const far = await signUp(browser, "b", "bram");
  try {
    await listMe(listed);

    await browse(far);
    await browseServer(far, domainOf("a"));
    await far.page.getByRole("tab", { name: "People" }).click();

    await searchPeople(far, listed.username);
    await expect(far.page.getByText(listed.identity)).toBeVisible();
    await searchPeople(far, quiet.username);
    await expect(far.page.getByText(`No one on ${domainOf("a")} has chosen to be listed yet.`).or(far.page.getByText(/Nothing matches/))).toBeVisible();
    await expect(far.page.getByText(quiet.identity)).toHaveCount(0); // never chose to be listed
    await searchPeople(far, listed.username);
    await far.page.getByRole("button", { name: `Add ${listed.displayName} as a friend` }).click();
    await expect(far.page.getByText("Friend request sent.")).toBeVisible();
  } finally {
    await closeAll([listed, quiet, far]);
  }
});

test("someone who hides from other servers is not listed, whatever they chose", async ({ browser }) => {
  const person = await signUp(browser, "a", "hidy");
  const far = await signUp(browser, "b", "bram");
  try {
    await listMe(person);
    const hide = person.page.getByRole("checkbox", { name: "Let people on other servers find me" });
    await hide.click();
    await expect(hide).not.toBeChecked();

    await browse(far);
    await browseServer(far, domainOf("a"));
    await far.page.getByRole("tab", { name: "People" }).click();
    await searchPeople(far, person.username);

    await expect(far.page.getByText(/Nothing matches/)).toBeVisible();
    await expect(far.page.getByText(person.identity)).toHaveCount(0);
  } finally {
    await closeAll([person, far]);
  }
});
