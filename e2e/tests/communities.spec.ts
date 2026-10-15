import { expect, test } from "@playwright/test";
import { closeAll, createCommunity, joinCommunity, messageWith, send, signUp, uniqueName } from "../support/app";

test("a community's members talk in its channel, and someone who joins sees what was said before", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const guest = await signUp(browser, "a", "gus");
  try {
    const name = uniqueName("club");
    const id = await createCommunity(owner.page, name);
    await send(owner.page, "Message #general", "welcome to the club");
    await expect(messageWith(owner.page, "welcome to the club")).toHaveCount(1);

    await joinCommunity(guest.page, name, id);
    await expect(guest.page.getByPlaceholder("Message #general")).toBeVisible();
    await expect(messageWith(guest.page, "welcome to the club")).toHaveCount(1);

    await send(guest.page, "Message #general", "glad to be here");
    await expect(messageWith(owner.page, "glad to be here")).toHaveCount(1);
  } finally {
    await closeAll([owner, guest]);
  }
});
