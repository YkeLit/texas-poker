# 联机德州扑克 MVP

一个基于 `pnpm` monorepo 的好友房德州扑克原型，包含：

- `apps/web`: React + Vite 牌桌客户端，支持桌面和移动端布局。
- `apps/server`: Fastify + Socket.IO 实时服务端，服务端权威发牌和结算。
- `packages/shared`: 共享协议、Zod schema 和公共类型。
- `packages/poker-engine`: 纯 TypeScript 德州状态机与牌型比较引擎。

## 功能范围

- 游客昵称登录
- 创建好友房并通过房号加入
- 2-9 人牌桌
- 标准无限注德州规则
- 服务端发牌、下注校验、边池、摊牌和结算
- 聊天、快捷表情、断线重连、自动超时 `check/fold`
- 房主创建第一手，后续手牌自动开局

## 本地开发

```bash
COREPACK_HOME=/tmp/corepack corepack pnpm install
COREPACK_HOME=/tmp/corepack corepack pnpm --filter @texas-poker/server dev
COREPACK_HOME=/tmp/corepack corepack pnpm --filter @texas-poker/web dev
```

服务端默认运行在 `http://127.0.0.1:3001`，前端默认运行在 `http://127.0.0.1:5173`。

## 测试与构建

```bash
COREPACK_HOME=/tmp/corepack corepack pnpm test
COREPACK_HOME=/tmp/corepack corepack pnpm build
```

## Docker Compose

```bash
docker compose up --build
```

Compose 会启动：

- PostgreSQL
- Redis
- 实时服务端
- Web 客户端

## 调试钩子

前端在开发环境会暴露：

- `window.render_game_to_text()`
- `window.__POKER_DEBUG__.advance(ms)`

这两个接口可用于自动化回归和 Playwright 驱动测试。
