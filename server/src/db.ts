import { config } from "./config.js";
import { createPrismaClient } from "./lib/prismaClient.js";

export const prisma = createPrismaClient(config.databaseUrl);
