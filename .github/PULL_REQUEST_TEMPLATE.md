## Summary

<!-- What does this change, and why? A sentence or two is often enough. -->

Closes #<!-- issue number, if any -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Federation protocol change (`server/src/lib/federation`, `server/src/modules/federation`, `/federation/v1/*`)
- [ ] Breaking change (existing data, API shape, or migration requires manual steps)
- [ ] Refactor / cleanup, no behavior change
- [ ] Docs only

## Testing

<!-- CI will run lint, typecheck+build, unit tests, and (on server changes)
integration tests against a real database - see .github/workflows/ci.yml.
This section is about what you verified beyond what CI already covers. -->

- [ ] Added or updated tests for this change (`server/src/**/*.test.ts`,
      `server/test/integration/*.test.ts`, or `client/src/**/*.test.ts`)
- [ ] `npm run test --workspace server` and `npm run test --workspace client` pass locally
- [ ] `npm run test:integration --workspace server` passes locally (if this touches server/API code)
- [ ] Verified manually in the browser (`scripts/start.ps1`) - describe what you clicked through below
- [ ] If this touches federation: verified against the two-server demo (`scripts/start-federation-demo.ps1`)

<!-- What did you actually do to check this works? E.g. "registered two
users, sent a friend request, accepted it, confirmed both friends lists
updated live." Screenshots/GIFs are welcome for UI changes. -->

## Checklist

- [ ] Updated `README.md` if this changes setup steps, adds/removes a known limitation, or changes documented behavior
- [ ] No secrets, real credentials, or `.env`-style files committed
- [ ] If this adds a Prisma schema change: migration is committed under `server/prisma/migrations/`
