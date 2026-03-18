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
docker compose up -d
```

Compose 会启动：

- PostgreSQL
- Redis
- 实时服务端
- Web 客户端

默认会直接拉取 GitHub Actions 构建好的镜像：

- `ghcr.io/ykelit/texas-poker-server:latest`
- `ghcr.io/ykelit/texas-poker-web:latest`

如果你想切换到别的 tag 或别的仓库，可以在启动前覆盖：

```bash
export TEXAS_POKER_SERVER_IMAGE=ghcr.io/ykelit/texas-poker-server:main
export TEXAS_POKER_WEB_IMAGE=ghcr.io/ykelit/texas-poker-web:main
docker compose up -d
```

服务端容器会在启动时自动执行 `prisma db push --skip-generate`，因此首次连到一块全新的 PostgreSQL 卷时也会自动建表。

前端容器里的 `VITE_SERVER_ORIGIN` 只用于 Vite 代理 `/api` 和 `/healthz`；浏览器侧 websocket 默认会连到“当前页面所在主机”的 `3001` 端口。如果你的部署把实时服务暴露在别的公网地址，可以额外设置：

```bash
export VITE_SOCKET_ORIGIN=https://poker.example.com
docker compose up -d
```

### PostgreSQL 和 Redis 是做什么的

- `PostgreSQL`：持久化游客会话、房间元数据、聊天记录和手牌历史。没有它时，服务重启后这些数据不会保留。
- `Redis`：保存在线房间运行态、公开快照、重连 token、座位锁这类实时短期状态，也为后续多实例扩展预留空间。

如果你只想跑一个最轻量的本地试玩环境，当前服务端其实也能退回到内存模式；但在正式部署或需要断线恢复、历史留存时，建议保留这两个服务。

## 调试钩子

前端在开发环境会暴露：

- `window.render_game_to_text()`
- `window.__POKER_DEBUG__.advance(ms)`

这两个接口可用于自动化回归和 Playwright 驱动测试。
