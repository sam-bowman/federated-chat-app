// Shared between conversations/routes.ts (local creation) and
// federation/routes.ts (the receiving handshake) so the two sides can't
// drift - a locally-created group exceeding the receiving peer's own limit
// would otherwise fail confusingly at handshake time instead of upfront.
export const MAX_GROUP_MEMBERS = 10;
