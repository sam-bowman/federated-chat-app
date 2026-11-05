import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redactUrl.js";

describe("redactSecrets", () => {
  const secret = `mcw_${"a".repeat(43)}`;

  it("replaces the secret of a webhook's address and keeps the rest", () => {
    expect(redactSecrets(`/api/v1/webhooks/01HZ/${secret}`)).toBe("/api/v1/webhooks/01HZ/[secret]");
    expect(redactSecrets(`/api/v1/webhooks/01HZ/${secret}?wait=1`)).toBe("/api/v1/webhooks/01HZ/[secret]?wait=1");
  });

  it("replaces whatever sits in the secret's place, valid or not", () => {
    expect(redactSecrets("/api/v1/webhooks/01HZ/not-a-secret")).toBe("/api/v1/webhooks/01HZ/[secret]");
  });

  it("leaves every other address alone", () => {
    for (const url of ["/api/v1/communities/1/webhooks", "/api/v1/communities/1/webhooks/2/url", "/api/v1/webhooks", "/api/v1/webhooks/01HZ", "/federation/v1/x", `/other/api/v1/webhooks/1/${secret}`]) {
      expect(redactSecrets(url)).toBe(url);
    }
  });
});
