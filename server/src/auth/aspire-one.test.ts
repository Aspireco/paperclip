import { describe, expect, it } from "vitest";
import { ASPIRE_ONE_ACCOUNT_OPTIONS, ASPIRE_ONE_PROVIDER_ID, aspireOneConfig, aspireOnePlugin } from "./aspire-one.js";

const ENV = {
  PAPERCLIP_OIDC_ISSUER: "https://auth.example.test/application/o/paperclip",
  PAPERCLIP_OIDC_CLIENT_ID: "paperclip",
  PAPERCLIP_OIDC_CLIENT_SECRET: "test-only",
};

describe("Aspire One sign-in", () => {
  it("is off unless issuer, client id and secret are all set, over https", () => {
    expect(aspireOneConfig({})).toBeNull();
    expect(aspireOneConfig({ ...ENV, PAPERCLIP_OIDC_CLIENT_SECRET: "" })).toBeNull();
    expect(aspireOneConfig({ ...ENV, PAPERCLIP_OIDC_ISSUER: "http://auth.example.test/" })).toBeNull();
    expect(aspireOneConfig(ENV)).toEqual({
      issuer: "https://auth.example.test/application/o/paperclip/",
      clientId: "paperclip",
      clientSecret: "test-only",
      redirectUri: "https://agents.aspireco.ca/api/auth/callback/aspire-one",
    });
    expect(aspireOneConfig({ ...ENV, PAPERCLIP_OIDC_REDIRECT_URI: "http://x.test/cb" })).toBeNull();
  });

  it("never signs anyone up and never links by email", () => {
    expect(ASPIRE_ONE_ACCOUNT_OPTIONS.accountLinking.disableImplicitLinking).toBe(true);
    expect(ASPIRE_ONE_ACCOUNT_OPTIONS.accountLinking.trustedProviders).toEqual([]);
    const plugin = aspireOnePlugin(aspireOneConfig(ENV)!) as unknown as { id: string; options?: { config?: Array<Record<string, unknown>> } };
    expect(plugin.id).toBe("generic-oauth");
    const provider = plugin.options?.config?.[0];
    expect(provider?.providerId).toBe(ASPIRE_ONE_PROVIDER_ID);
    expect(provider?.disableSignUp).toBe(true);
    expect(provider?.disableImplicitSignUp).toBe(true);
    expect(provider?.requireIdTokenVerification).toBe(true);
    expect(provider?.pkce).toBe(true);
    expect(provider?.redirectURI).toBe("https://agents.aspireco.ca/api/auth/callback/aspire-one");
    expect(provider?.discoveryUrl).toBe("https://auth.example.test/application/o/paperclip/.well-known/openid-configuration");
  });
});
