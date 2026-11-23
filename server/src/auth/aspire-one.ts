import { genericOAuth } from "better-auth/plugins";

/**
 * Aspire One sign-in (Aspireco, 2026-11-23): "one login to everything" for the owner and staff.
 * Aspire One is the company's Authentik at auth.aspireco.ca, acting as an OpenID Connect provider
 * (client "paperclip", blueprint in Aspireco/business-os deploy/authentik).
 *
 * The rules, all enforced by better-auth options rather than our own code:
 *  - never a NEW account through it (disableSignUp): people join a company by invite, as before;
 *  - never matched to an existing account by email (accountLinking.disableImplicitLinking): a
 *    signed-in user connects it once from their profile (POST /api/auth/link-social), and only
 *    then can it sign them in. allowDifferentEmails is on because an Aspire One address need not
 *    be the Paperclip one, and a link is only ever made from inside a signed-in session;
 *  - the ID token is verified against the discovered keys (requireIdTokenVerification).
 * Off unless all three env values are set; the email + password sign-in is unchanged either way.
 */

export const ASPIRE_ONE_PROVIDER_ID = "aspire-one";

export interface AspireOneConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export function aspireOneConfig(env: Record<string, string | undefined> = process.env): AspireOneConfig | null {
  const issuer = env.PAPERCLIP_OIDC_ISSUER?.trim();
  const clientId = env.PAPERCLIP_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.PAPERCLIP_OIDC_CLIENT_SECRET?.trim();
  if (!issuer || !clientId || !clientSecret) return null;
  try {
    if (new URL(issuer).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { issuer: issuer.endsWith("/") ? issuer : `${issuer}/`, clientId, clientSecret };
}

export function aspireOnePlugin(config: AspireOneConfig) {
  return genericOAuth({
    config: [
      {
        providerId: ASPIRE_ONE_PROVIDER_ID,
        discoveryUrl: `${config.issuer}.well-known/openid-configuration`,
        requireIdTokenVerification: true,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        scopes: ["openid", "email", "profile"],
        pkce: true,
        disableSignUp: true,
        disableImplicitSignUp: true,
      },
    ],
  });
}

/** better-auth `account` options when Aspire One is on: explicit linking only. */
export const ASPIRE_ONE_ACCOUNT_OPTIONS = {
  accountLinking: {
    enabled: true,
    disableImplicitLinking: true,
    allowDifferentEmails: true,
    trustedProviders: [] as string[],
  },
} as const;
