import { Router, type Request, type Response } from "express";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  directoryQueryString,
  parseDirectoryQuery,
  sanitizeCommunityPage,
  sanitizePeoplePage,
  type CommunityListing,
  type DirectoryPage,
  type PersonListing,
} from "../../lib/directory.js";
import { isDomainName, normalizeDomain } from "../../lib/federationPolicy.js";
import { FederationProxyError, proxyToHomeServer } from "../../lib/federation/proxy.js";
import { listListedPeople, listPublicCommunities } from "./service.js";

/**
 * Browsing the directory (#109, phase 5), for the signed-in person: `/directory/communities` and `/directory/people`, this
 * server's own, or another's with `?domain=`. Another server's is asked through THIS server (a signed federation call), never by
 * the person's own browser: that keeps this server's rules (private mode, allow and block lists, the checks on who may be
 * contacted) in force, and keeps the person's address from the server they are browsing. What comes back is a stranger's and goes
 * to our own people's screens, so every item is checked first (lib/directory.ts).
 */
export const directoryRouter = Router();

type Kind = "communities" | "people";

async function browse(kind: Kind, req: Request, res: Response) {
  const query = parseDirectoryQuery(req.query);
  if (!query.ok) return res.status(400).json({ error: "invalid_request" });

  const asked = req.query.domain;
  if (asked !== undefined && (typeof asked !== "string" || !isDomainName(asked))) return res.status(400).json({ error: "invalid_request" });
  const domain = typeof asked === "string" && normalizeDomain(asked) !== normalizeDomain(config.domain) ? normalizeDomain(asked) : null;

  if (domain === null) {
    if (!config.directoryEnabled) return res.status(404).json({ error: "directory_disabled" });
    const page: DirectoryPage<CommunityListing | PersonListing> =
      kind === "communities" ? await listPublicCommunities(query.q, query.cursor) : await listListedPeople(query.q, query.cursor, undefined, req.userId!);
    return res.json(page);
  }

  try {
    const raw = await proxyToHomeServer<unknown>(domain, `/directory/${kind}${directoryQueryString(query.q, query.cursor)}`, { method: "GET" });
    return res.json(kind === "communities" ? sanitizeCommunityPage(raw, domain) : sanitizePeoplePage(raw, domain));
  } catch (err) {
    // A server that does not publish one says so (404 directory_disabled); a private or unreachable one, or one we do not talk to,
    // is said as it is for everything else.
    if (err instanceof FederationProxyError) return res.status(err.status).json(err.body);
    return res.status(502).json({ error: "federation_unreachable" });
  }
}

directoryRouter.get("/communities", requireAuth, (req, res) => browse("communities", req, res));
directoryRouter.get("/people", requireAuth, (req, res) => browse("people", req, res));
