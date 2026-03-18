Original prompt: 我需要开发一个联机版的德州扑克

- 2026-03-18: 初始化项目为空目录，已确定实现为 pnpm monorepo，包含 web、server、shared 和 poker-engine。
- 2026-03-18: 已完成共享类型、牌局引擎、Fastify + Socket.IO 服务端、React 前端牌桌和基础测试。
- 2026-03-18: 服务端当前默认以内存运行时为主，Prisma/Redis 已补 schema 与适配层，数据库环境可后续直接接入。
- TODO: 增加真实浏览器端到端脚本，覆盖 2-3 个浏览器上下文一起对局。
- TODO: 为 Docker 镜像补 Prisma migrate/generate 的正式启动脚本。
- TODO: 若要上公网，继续补鉴权加固、观战和更细的运营指标。
