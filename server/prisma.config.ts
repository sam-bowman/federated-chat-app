import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7 reads the database URL for `prisma migrate` from here, not from the schema, and no longer loads a `.env` itself: `dotenv/config`
// does (`DOTENV_CONFIG_PATH` picks another file, as the federation demo's two servers need). `prisma generate` does not connect, so a URL that
// is not set yet (an image build) is not an error here; `migrate` says so itself when it needs one.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
