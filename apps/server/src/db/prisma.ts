import type { PrismaClient } from "@prisma/client";

export async function createPrismaClient(databaseUrl?: string): Promise<PrismaClient | null> {
  if (!databaseUrl) {
    return null;
  }

  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient({
    datasourceUrl: databaseUrl,
  });
}
