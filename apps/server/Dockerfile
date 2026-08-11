FROM node:23-alpine AS base
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY pnpm-lock.yaml ./pnpm-lock.yaml
COPY apps/server/package.json ./apps/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/poker-engine/package.json ./packages/poker-engine/package.json
COPY vendor/ykelit-games-room-runtime-1.1.1.tgz ./vendor/ykelit-games-room-runtime-1.1.1.tgz
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @texas-poker/server build

EXPOSE 3001
CMD ["pnpm", "--filter", "@texas-poker/server", "start"]
