FROM node:23-alpine AS base
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/poker-engine/package.json ./packages/poker-engine/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @texas-poker/server prisma:generate
RUN pnpm --filter @texas-poker/server build

EXPOSE 3001
CMD ["pnpm", "--filter", "@texas-poker/server", "dev"]
