# 联机德州扑克 MVP

一个基于 `pnpm` monorepo 的好友房德州扑克原型，包含：

- `apps/web`: React + Vite 牌桌客户端，支持桌面和移动端布局。
- `apps/server`: Fastify + Socket.IO 实时服务端，服务端权威发牌和结算。
- `packages/shared`: 共享协议、Zod schema 和公共类型。
- `packages/poker-engine`: 纯 TypeScript 德州状态机与牌型比较引擎。

## 功能范围

- HttpOnly Cookie 游客身份（前端不保存重连令牌）
- 创建好友房并通过房号加入
- 2-9 人牌桌
- 标准无限注德州规则
- 服务端发牌、下注校验、边池、摊牌和结算
- 聊天、快捷表情、断线重连、自动超时 `check/fold`
- 房主创建第一手，后续手牌自动开局

## 本地开发

```bash
COREPACK_HOME=/tmp/corepack corepack pnpm install
export REDIS_URL=redis://127.0.0.1:6379
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
cp .env.example .env
docker compose up -d
```

Compose 会启动：

- PostgreSQL
- 连接导航栈提供的专用 `games-room-redis`
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

在启动 compose 前，需要先提供这些必填密钥：

- `POSTGRES_PASSWORD`：PostgreSQL 密码
- `ROOM_REDIS_PASSWORD_FILE_HOST`：专用房间 Redis 密码文件

`postgres` 只保留在 compose 内部网络；活跃房间 Redis 由导航栈统一提供，服务端通过 Docker Secret 连接。

服务端容器会在启动时自动执行 `prisma db push --skip-generate`，因此首次连到一块全新的 PostgreSQL 卷时也会自动建表。

`CLIENT_ORIGIN` 支持多个来源，使用逗号分隔即可，例如：

```bash
export CLIENT_ORIGIN=http://127.0.0.1:5173,https://poker.example.com
```

前端容器里的 `VITE_SERVER_ORIGIN` 只用于 Vite 代理 `/api` 和 `/healthz`；浏览器侧 websocket 默认会连到“当前页面所在主机”的 `3001` 端口。如果你的部署把实时服务暴露在别的公网地址，可以额外设置：

```bash
export VITE_SOCKET_ORIGIN=https://poker.example.com
docker compose up -d
```

### PostgreSQL 和 Redis 是做什么的

- `PostgreSQL`：只归档房间元数据、聊天和手牌历史。旧游客/房间表保留一个发布周期，但不再写入。
- `games-room-redis`：以 `room:v1:texas-poker:` 命名空间保存游客令牌哈希、活跃房间、幂等结果、presence 和 CAS revision；Redis 不可用时服务 readiness 失败，不降级到内存。

服务端不会退回进程内存。房间与游客身份恢复必须使用专用 Redis。

## 调试钩子

前端在开发环境会暴露：

- `window.render_game_to_text()`
- `window.__POKER_DEBUG__.advance(ms)`
- `window.advanceTime(ms)`

这两个接口可用于自动化回归和 Playwright 驱动测试。
