import { installAsyncErrorHandling } from "./asyncErrors.js";

// A module of its own so that app.ts can import it FIRST: ES module imports are
// evaluated in order, before the importing file's own statements run, so a bare
// `installAsyncErrorHandling()` call inside app.ts would come too late - the route
// modules it imports would already have registered their handlers.
installAsyncErrorHandling();
