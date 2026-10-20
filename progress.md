Original prompt: Implement the extensible shared room/reconnect runtime and migrate Texas Hold'em to dedicated Redis, secure reconnect, multi-connection presence and continue/auto-action behavior.

## 2026-08-10

- Completed the `@ykelit/games-room-runtime` 1.1.1 cutover using `room:v1:texas-poker:` and the shared six-character room, nickname uniqueness, revision, replay and expiry behavior.
- Replaced localStorage/session/resume-token and signed websocket join flows with the 30-day `__Host-texas-poker_guest` HttpOnly Secure SameSite=Lax cookie. The browser stores only the most recent room code.
- Implemented the common HTTP endpoints and `room.attach`, `command`, `command.result`, `state.snapshot`, `presence.changed` and `room.expired` Socket.IO protocol with exact Origin validation.
- All player and server timer actions use the same requestId idempotency and Redis CAS revision path. Deals are deterministic from the accepted request ID, so retries cannot reshuffle.
- Texas Hold'em continues while players are missing, auto checks/folds at the persisted action deadline, and marks disconnected ready players sit-out after two missed hands. Multiple tabs share one seat and only the final disconnect changes presence.
- Added runtime timer restoration: attaching after a full server restart restores the same room/private hand and rebuilds the remaining action timer from Redis.
- Viewer snapshots expose only the viewer's hole cards; opponents expose only card counts. Deck order and random seed are never sent.
- Removed the old process-memory RoomService, plaintext resume-token cache, websocket token signer and their HTTP/Socket routes.
- Removed SQL and all archive writes; active rooms, chat and hand state are intentionally ephemeral Redis state for this personal-use deployment.

Verification:

- 34 unit/component/adapter tests pass across shared, engine, server and web packages; production builds pass for all four packages.
- Real Redis HTTP/Socket smoke passed create/join, secure cookie flags, two private views, chat, multi-tab final-disconnect presence and automatic check/fold.
- Full server restart restored room `JPXW2L`, the same two private cards and the persisted timer; the timer advanced revision after restart.
- The required web-game Playwright client produced `/tmp/texas-poker-game-test/shot-0.png` and a lobby `render_game_to_text` snapshot with no console-error file; visual inspection passed.
- Redis-backed restart recovery, Compose rendering and `git diff --check` pass.
- Runtime 1.1.1 integrity is pinned to `sha512-iCt9bX...EHSg==`; all 34 tests and production builds pass after the patch upgrade.

## 2026-10-12 桌游开发团队规范

- 接入共享 [Agents Team](/Users/yangke/.codex/skills/boardgame-dev-team/SKILL.md)，提供六个角色提示词、任务/交接模板、文件归属、接口协调和验收流程。
- 项目 `AGENTS.md` 记录团队入口、当前模块路径和实际验证入口；保留游戏现有规则与实现。
- 本次文档验证：共享团队及各项目 agent guide 的本地链接、引用目录和 package scripts 已核对通过；`git diff --check` 通过。
- 未运行游戏代码测试，本次没有代码、依赖或部署配置变更。下一次功能任务由负责人按共享模板确定目标、分工和验收条件。

### 开发顺序与分阶段验收更新

- 开发顺序调整为：确定规则 → 后端逻辑及必要 API 测试、至少两个独立非实现者 agents 验收 → 页面及多轮视觉/交互测试 → 新增断线重连等附加功能；前阶段通过后才能进入后阶段。
- 新增共享 [验收规范](/Users/yangke/.codex/skills/boardgame-dev-team/references/validation.md)，覆盖电脑/手机、横竖屏、小窗、动态尺寸变化，以及环境×状态×动作记录；页面至少开发者首轮和独立 QA 第二轮，缺陷修复后相关组合回归。
- 同步团队角色提示词、阶段任务模板和项目 `AGENTS.md`；基础身份、权限、信息隔离和共享 runtime 已有契约保留在核心后端阶段。
- 本次验证：两名独立 agents 分别复查后端与页面流程文档并通过；文档本地链接、引用的 package scripts、空白格式及六仓库 `git diff --check` 通过。未运行游戏 API、联机或页面测试，此记录不代表游戏阶段已通过。

### 独立桌游团队技能与规则 agent 玩家验收

- 团队迁出共享运行时，统一使用 [$boardgame-dev-team](/Users/yangke/.codex/skills/boardgame-dev-team/SKILL.md)，适用于未来新项目和已有桌游；技术栈及运行时约束由本项目保留。
- 规则 agent 必须实际检索论坛注意事项、核对来源与版次并转成规则/API/玩家案例；后续由原规则角色在真实页面操作完整对局和适用边界案例。
- 保留两个独立非实现者 agents 的逻辑验收和页面多轮全面覆盖；规则玩家实操可并入第二轮，但不能被截图或 API 报告替代。
- 本次验证：安装后的技能格式/元数据、24 个技能与项目文档、44 个本地链接、六仓库 `git diff --check` 通过；独立审查修正了旧项目 revision 约束，新桌游空项目起步演练保留规则调查、阶段顺序和实际执行证据。未运行具体游戏、论坛调查或页面验收，不改变已有游戏阶段通过状态。

## 2026-10-14 退出与重连阶段2局部修复

- 保留既有文档改动。App.tsx先注册永久connect handler再连接；首次ACK断线和随后每次重连均能重新attach；退出HTTP失败保留牌桌、socket、房间码并显示错误，成功才清理。移除提前seat.leave；HTTPleave成功后广播剩余成员，服务端既有hook负责非活动座位清理。活动check/fold、结算、身份与私有手牌契约不变。
- 最终产品diff含App.tsx/App.lobby.test.tsx/apps/server/src/app.ts，SHA256 c007072dfba73eb57ed2fdcad59e88b1360665bbb9391d1a978a36e86858f0ee。独立审查/root/audit_three和/root/audit_extra在此基线通过；初审发现首次ACK窗口/退出缺广播均已修并重审。
- 当前shell缺corepack；pnpm默认自动依赖检查尝试安装失败后，使用 `pnpm --config.verify-deps-before-run=false --config.manage-package-manager-versions=false -r test`，37项通过；同参数 `-r build`，全部4包构建及Web tsc通过。新增3个有意义的组件案例；无依赖/锁文件改动，临时.pnpm-store已清理，diff-check通过。
- 真实本机两独立Chromium会话最终基线回归：重连attach+snapshot、刷新同房同座、503错误保留房间/连接/座位、重试真正退出activeRoom null、另玩家立即看到清座并成为房主、退出后刷新不回房；pageerror0。独立真实API广播也通过。
- 证据/private/tmp/texas-room-fix-20261014/及/private/tmp/poker-review-b-20261014/；所有测试进程、浏览器和专用Redis已清理。导航跨仓记录docs/boardgames-stage2-poker-20261014.md。未部署/推送；完整对局、活动永久退出、超时/多标签/设备矩阵未验收，跨仓阶段2其余游戏仍待修复。

## 2026-10-15 阶段3永久退出后端（第十八批review）

- 保留阶段2原改动。真实本机1.1.1三Cookie、7接受命令开局，当前行动者leave204后成员已删、actingSeat保留；原deadline+600ms仍preflop且revision不增，双SIO left0。原timer用已删除participant发命令FORBIDDEN，仅warn导致停牌。
- 后端最小修复固定原deadline，到期从engine当前座确定check/fold，以剩余合法member为server-owned timer issuer，仍经会员/nonce/CAS；提前/错/无效deadline拒绝，偶发早触发重排，FORBIDDEN/STALE100ms重排。非活动才清非member席，先保留all-in下注参与引擎完整结算/lastResult；普通断线member不清。旧onExpired兼容钩子足够，未升级runtime1.1.1或锁/vendored资产。
- HTTPleave显式Origin按原多来源配置验证，无Origin HTTP保留；SIO原严格Origin不变。广播先清已退所有socket绑定/订阅并left，再presence/私有快照。新产品diff app.ts/shared-runtime.ts SHA256e688ae04c20157a21b16d6fa0920c3a8e1380ae7c910385b262e50a1c63fe857；原UI/App.lobby.test diff1f4377bbb335a1f7682e2c8012903503f9f859039a1168cf8ed9cb280387ba73未动。
- corepack现可用；corepack pnpm --config.verify-deps-before-run=false --config.manage-package-manager-versions=false -r test全部40项通过（新增3有意义测试：提前/错误截止+到期/重放清席、普通断线保席、all-in贡献2000自然结算），同参数-r build四包通过。根无typecheck脚本，没有声称运行独立typecheck。初次新增测试误写不存在lastResult.totalPot，改按实际lastResult.pots求和；失败源码/日志保留。
- root最终真实HTTP/SIO/Redis 5组23命令、余员8动作完成本手showdown/离开保留lastResult、候场转主清席、Origin拒绝及双连接撤销通过。初次1cd冻结仅缺时钟提早重排一行，最终e688已完整重跑。两名独立最终复核中；不是页面或整体阶段3完成。
- 自有应用63113/63279/63942和无卷Redis32789已清理。旧showdown房间status仍playing、不接受新访客join的契约保留，后续手牌只复核原剩余成员；0member并不立即abandoned，按原activeEmptyTTL延迟删除。页面尚未监听room.expired（另一标签仍旧表），下一批必须补left/过期、确认/失败有界与旧响应保护，再两轮页面；本中间状态不能部署。原规则角色/真机完整矩阵未验。证据导航docs/evidence/boardgames-poker-exit-api-20261015/。

## 2026-10-15 第十八批收尾：退出后端局部done

- 最终backend app.ts/shared-runtime.ts diff e688ae04c20157a21b16d6fa0920c3a8e1380ae7c910385b262e50a1c63fe857。同hash双独立未实现者/root/audit_three与/root/audit_extra正式通过；40tests/四包build、root5组23命令/余员自然8动作完整手牌通过。未运行不存在的root typecheck，未改配置故未另跑Compose。
- A完整主/重启/竞争三驱动最终均0；实际自然fold/check手、三人all-in3000结算清席、剩余两原成员下一手、同Cookie双连接撤销、新旧房隔离、已退actor进程重启恢复原deadline/原私牌后自动fold通过，40tests独立另跑通过。30原始成功条目含重复投影/nonce断言，不是30种独立场景。
- B最终有效11组：主4组40ok退出0，补轮前4组已过/49ok含后续setup后误期待0成员abandoned退出1，纠正边界3组20ok退出0。自然12动作完整四街/3000守恒、未来3街ghost auto-check，100/200/300/400起始stack明确CAS夹具但all-in/4边池总1000自然API结算，FORBIDDEN/STALE时序注入后重排通过。109ok含replay/失败前setup不是109测试。原showdown仍playing新访客join400、0成员playing保原2hTTL已实测并保留。
- 负责人误写totalPot、A join码/lastAction字段/等待预算/旧SIO revision、B字段误期望/旧hash拦停/0member误状态均保留失败源码/stdout/JSON，未按错误预期改产品。TTL仅回溯emptySince后真实sweep，非墙钟2h；时序注入非自然所有调度或实际系统回拨。
- root32789/A32790/B32791专用无卷Redis及所有自有应用已清理，未访问生产、未推送/发布/部署。导航docs/boardgames-stage3-poker-exit-api-20261015.md与docs/evidence/boardgames-poker-exit-api-20261015/保存原件/冻结patch/逐文件hash。
- 下一批必须先页面：原App未监听room.expired，另一标签仍旧牌桌；加reason:left/过期处理与room/连接世代隔离、退出确认说明仍按原时限check/fold且all-in继续本手结算、同步pending/有界HTTP与丢响应认证确认、旧restore/ACK/HTTP不能回旧房或清新房，再独立双审和两轮页面。当前中间状态不可部署。阶段4新增手动重连、原规则角色论坛玩家/真机/8款矩阵仍未过，不能把本后端done标为扑克或跨仓阶段3完成。

## 2026-10-15 第十九批：退出页面局部done

- 保留后端e688/runtime1.1.1/锁文件。App当前socket+roomId+epoch与attachAttempt守卫阻旧snapshot/ACK/restore/HTTP；entry同步lock阻重复入口，退出同步lock/fieldset禁用/8秒POST与确认GET，失败保留并可重试。left/真实expiry清页面/存储/聊天，活动手牌确认本手继续、不能原座返回、原时限check/fold与all-in继续结算。
- 真实发现并修三项：b7 offline twin错过left后留旧表（attach失败有界认证确认无房/新active）；893 Cookie失效POST401后匿名active null假成功（保留HTTP status，401禁止匿名确认）；b6手机CSS隐藏整个status-bar（原display:flex保留，手机纵排换行）。错误和pending可见可滚动，未引入依赖/资产/新手动重连。
- 最终UI三文件diff a7a36206976cbf63b07b152a110b63b88fae7e91fe291010472ec57563b55fb9；后端仍e688ae04c20157a21b16d6fa0920c3a8e1380ae7c910385b262e50a1c63fe857。corepack pnpm --config.verify-deps-before-run=false --config.manage-package-manager-versions=false -r test全部42项通过；同参数-r build四包通过，Web含tsc，没有独立root typecheck脚本。无配置变更未另跑Compose。维护apps/web/exit-ui-smoke.mjs语法/diff-check通过。
- root最终a7真实12组、16视口、三真人12动作自然完整四街showdown、same-Cookie twin/失败/刷新/结算保留及余员下一手通过，pageerror0；另320宽真clearCookies401原member仍在/页面保留/提示可见通过；既有web-game客户端0并看图。不是物理手机。
- 同a7双独立局部接受：A核对App/api与b6逐字同，仅3行CSS变；b6五驱动40条含4zero-pageerror/42tests0，a7手机320/390专项23条含1zero-pageerror、tmpbuild/client0，不称a7五逻辑驱动全重跑。B a7主20组0：自然12动作完整手牌、四街实际退出保原5s timer与余员结算、自然all-in6000、401/no确认GET、9尺寸/动态鼠标键盘及模拟tap；补前6项有效后最后expiry驱动TDZ退出1，单拆expiry真实广播补验0，不称整条补轮成功。
- 原b7/893/b6缺陷失败与源/截图/stdout全保留；A超长昵称/B旧revision准备/网络帧注入/TDZ纯驱动错误明确，不据错误预期改产品。JSON不存Cookie/token或私牌原帧，截图只含该玩家实际可见；原过期形状注入/Redis显式删除不冒称墙钟TTL。导航docs/boardgames-stage3-poker-exit-ui-20261015.md及对应docs/evidence保存原件/patch/hash。
- root两轮14518/14519/32793、A两轮54405/32792及62856/32795已清理；B专用Redis32794/所有应用也已清，17端口无监听；cleanup-tool-output.json为保存的工具返回对象，verdict.md与evidence-hashes.json归档。仅本地开发，无推送/发布/部署。原showdown playing拒新访客join和0member原2hTTL保留；下一手指原剩余成员。
- 德扑阶段3局部退出done，跨仓阶段3仍active；下一批瞎掰王活动退出终态/API先双独立再页面。阶段4手动重连、原规则角色论坛/玩家与真机/8款完整断网超时矩阵未完成，自动任务继续。


## 2026-10-16 阶段4手动恢复局部done

- 保留全部已有改动。房间断线提供重新连接，首页提供恢复房间；复用安全Cookie active-room核对，再替换Socket并attach，权威snapshot前游戏/聊天命令禁用，不创建新会员或重放旧命令。冷恢复失败明确可重试。玩法/后端/依赖不变。
- QA1初审发现GET pending旧socket自动恢复能重新开放操作，旧d5候选撤回；最终先清socketRef并disconnect，延迟GET注入旧snapshot回归通过。App+组件test diff SHA cf23c13274cb15a83c63166b795c58e6611598ecb6b403097b2f2b5cf91567dd；smoke SHA 14f8463bf8fe6a04a3a1046f862ba65f911b81920284bb671c6bfd0a6ec97dd0。
- corepack pnpm --config.verify-deps-before-run=false --config.manage-package-manager-versions=false -r test 44通过，-r build四包通过（含Web tsc）。没有独立root typecheck，无配置变更未另验Compose。diff-check/驱动语法通过。
- root和两名独立未实现者/root/regicide_manual_reconnect_qa1、qa2同最终hash各5组真实双浏览器PASS/pageerror0，QA另各25 web tests通过。实际坐席开局、断线Enter不发命令、同房/会员/座/私牌恢复且无重放、刷新、冷503恢复无房；各看1440/375/568截图，恢复按钮≥44px且无横向溢出。现有web-game客户端0并看图，仅首页观察。
- 三次初始smoke驱动失败JSON保留：拦截WebSocket需显式关闭，fieldset.isDisabled需原生disabled属性；不据此改产品。截图整页前滚动按钮，不能证明初始折叠高度或所有牌桌布局；模拟视口/网络非实体手机。共享同隔离服务但各独立Cookie/房间，复用同driver不称独立设计全面矩阵。
- 证据 /Users/yangke/.codex/worktrees/f121/navigation/docs/evidence/poker-stage4-manual-reconnect-20261016/validation.md。自有API14521/Vite14520/无卷Redis32796与浏览器已清理；仅本地，无推送/合并/发布/部署。阶段4本项done，跨仓下一款瞎掰王；阶段5完整多标签/自然全手/各状态恢复/超时/原规则角色/真机未完成，原check/fold时限继续。

## 2026-10-19 Stage 5 natural reconnect + settlement refresh (local subitem)

- Preserved all pre-existing dirty work. Product baseline: HEAD `da483606cec70de0d90075716f0eeb3554cc614c`; `apps/web/src/App.tsx` SHA256 `49e193642f72802875503e1d91b135e2e2d09c85483f3d86f2cae6ba762aa973`; `apps/server/src/shared-runtime.ts` SHA256 `480f8f1d503f1574aa1af4ff7cb4a69e144b611161d2f7d7088e06e4aedeaa89`. No product files changed in this subitem.
- Local browser driver `natural-reconnect.mjs` SHA256 `f155c8d8b1740b45466f68e090e99b93516c35b28bfd224102922ec9593ceb05`; `node --check` and `git diff --check` passed. Root and independent QA1 each ran this exact driver against loopback API/Vite + isolated Redis and each produced 7/7 PASS: four independently cookied browser players, natural current actor disconnections at preflop/flop/turn/river, auto reconnect+reattach with the same identity/seat/hand/snapshot/deadline and zero gameplay command replay, natural showdown and same-cookie refresh with a new route/attach/snapshot plus visible result UI, and 320px no-horizontal-overflow resize. Root report and artifacts: `/Users/yangke/.codex/worktrees/f121/navigation/docs/evidence/texas-stage5-natural-reconnect-20261019/root/final/validation.md`; QA1: `/Users/yangke/.codex/worktrees/f121/navigation/docs/evidence/texas-stage5-natural-reconnect-20261019/qa1/strict-refresh-2/validation.md`.
- A reviewer found the earlier refresh predicate could accept a pre-reload in-memory snapshot; that run and screenshot remain preserved under `root/ack-parser/`. The predicate was corrected to require post-reload route/attach/snapshot increments and visible table/result. QA1 also found a seat-control setup race on the intermediate driver; `f155c8d8` waits for enabled room controls, and the final root/QA1 runs both passed. These were test-harness corrections, not product changes.
- The original rules researcher is still conducting TP-R1..R10 player operation on a separate local room; its full report is pending. Local offline simulation and emulated viewports are not physical-device or external-network checks. Multi-tab, natural deadline expiry, multiple hands/tournament, two complete device rounds, rules-player completion, and the rest of the cross-game Stage 5 matrix remain pending; this does not complete Stage 5. No production/real-player environment was used.

## 2026-10-19 Stage 5 原规则玩家实操（局部续验）

- 延续原规则角色，在同一冻结产品基线 HEAD `da483606cec70de0d90075716f0eeb3554cc614c`、App SHA256 `49e193642f72802875503e1d91b135e2e2d09c85483f3d86f2cae6ba762aa973`、shared-runtime SHA256 `480f8f1d503f1574aa1af4ff7cb4a69e144b611161d2f7d7088e06e4aedeaa89`、driver `f155c8d8...` 上实际操作本机浏览器页面。没有改产品/driver，也未停止或清理他人启动的服务/Redis。
- 两名独立本地玩家会话在真实 UI 入座、准备并自然完成第三手：P2 call、P1 check；flop/turn/river 两人按轮次逐街 check；页面到达 showdown，结果与筹码更新一致。TP-R1 此双人完整手牌 UI 子项通过。此前一手有自动超时动作，不计入 R1。
- 结算后通过同 Cookie 同一 Edge profile 重开页面并明确执行 reload；页面恢复原测试房的同一座位/房主、摊牌结果与筹码。Chrome 独立玩家会话重开本地页面也恢复原座位及相同结果。仅证明已结算态刷新恢复，TP-R5 的活动手短断仍未测。
- 另开第四手观察行动截止：P2 面对无需追加、可check局面在线等待约22秒后页面由preflop推进到flop，显示新的行动倒计时；之后再次控件调用时发生 stale element，页面已推进到turn。此为在线idle自动check的部分证据，不是离线TP-R6通过；没有足够先决状态证明TP-R7。没有自然触发全下旁池/公共牌平手/第10人。
- TP-R1已自然完整双人UI手牌通过；TP-R2仅验证call与无人下注check；TP-R5仅结算态刷新恢复；TP-R6仅在线idle计时部分；TP-R3/R4/R7/R8/R10未覆盖；TP-R9仅页面树私牌可见性观察，未审API/Socket传输。逐案例实际记录见导航报告：[rules-player/validation.md](/Users/yangke/.codex/worktrees/f121/navigation/docs/evidence/texas-stage5-natural-reconnect-20261019/rules-player/validation.md)。
- Edge标签 console error/warn 采集为空；没有单独pageerror事件。未落盘截图：实操页面含私牌/摊牌牌值，当前工具未提供安全遮挡并保存本地截图的路径；不保存含牌值、昵称、房号或Cookie的图像。一次Safari测试会话显示`SESSION_EXPIRED`并排除；一次stale DOM action保留为未定位观察。Mac锁屏曾短暂阻止原生按键操作，之后CUA浏览器扩展仍可继续；不需要用户解锁，不把锁屏当最终阻塞。
- 环境：`lsof`只读见本机3010/3011监听进程；shell直连3011失败，但CUA浏览器成功打开同一loopback页面。Docker socket只读查询返回permission denied；未因此提升权限，也未操作容器/Redis。测试房和页面状态保留待负责人继续复用；未清理共享资源。完整规则案例、活动手短断/期限、私牌传输检查、截图及其余Stage5设备/矩阵仍未完成，阶段5 active。

## 2026-10-19 Stage 5 多标签与最后连接期限自动行动（局部通过）

- 产品基线仍为 HEAD `da483606cec70de0d90075716f0eeb3554cc614c`，`App.tsx` 与 `shared-runtime.ts` 分别保持 SHA256 `49e193642f72802875503e1d91b135e2e2d09c85483f3d86f2cae6ba762aa973`、`480f8f1d503f1574aa1af4ff7cb4a69e144b611161d2f7d7088e06e4aedeaa89`；未修改产品文件。新增/修正本地 Stage 5 Playwright driver `apps/web/multitab-timeout-smoke.mjs`，最终 SHA256 `53f44e362a6232e0ce114d2f5a70de7f8b99951eb116c77bb89336ff5320261d`。
- 本地 loopback API/Vite/隔离 Redis 下两个独立 Cookie 玩家真实 UI 开局；房主同 Cookie 第二标签恢复同一参与者/座位、关闭单标签仍在线；最后行动者标签关闭后仍保座，原deadline自然触发无人代操作的弃牌并进入showdown，由另一名赢得结果；同Cookie重开恢复原房/身份/座位，无重复命令发送。最终5/5通过、pageErrors空，语法与diff-check通过，完整原始结果和driver见导航 [本批记录](/Users/yangke/.codex/worktrees/f121/navigation/docs/evidence/texas-stage5-multitab-timeout-20261019/validation.md)。此前同产品哈希的44 tests、四包build及web TypeScript检查通过。
- 初次浏览器驱动在前三项通过后因期待结算后仍有瞬时`lastAction`而误报失败；真实快照已处于showdown且pageErrors空。检查引擎契约后将断言改为自然deadline后对手赢得showdown，再同基线整轮通过；属测试器断言修正，不作为产品失败。测试输出不记录私牌/Cookie/昵称/房间码。
- 仅单房、模拟Chromium与本地进程；非实体设备/公网断网/完整保座TTL/独立QA第二轮/多手牌/规则角色全集。API/Vite发送Ctrl-C，专用无卷Redis已停止并确认容器及14730/14731端口释放，未触碰14631既有无关进程；Stage 5仍active。未发布或部署。

## 2026-10-20 Stage 5 old-room/new-room active-pointer browser subitem

- Frozen Texas HEAD `da483606cec70de0d90075716f0eeb3554cc614c`; App, server route, shared adapter, and web API hashes unchanged. A navigation-only Playwright driver SHA `9c120dfd0360258c3dccac71b435d09aa0c881c1d072726a17bd91905b339f7d` ran against loopback API/Vite plus a unique no-volume tmpfs Redis bound only to 127.0.0.1.
- Root local browser run passed 6/6: same-cookie second tab restored one seat; old active-room response was held until A was left and B created, then UI followed B; old A HTTP leave returned expected 403; direct same-cookie/origin socket attach to A was rejected; active B remained and both tabs refreshed outside after leaving B. 22 API responses contained only the expected stale-leave 403 and 200/201/204 otherwise; pageErrors empty. Sanitized result and report: `/Users/yangke/.codex/worktrees/f121/navigation/docs/evidence/texas-stage5-old-active-20261019/root/results-final.json` and `root/validation.md`.
- Early driver failures were stale UI state/room-scoped participant-ID and secure-cookie lookup assumptions; retained as diagnostic attempts, corrected harness only, no Texas source changes. Script `node --check` and diff-check pass. Local services and only this test's Redis stopped; selected ports released, previously running containers untouched.
- Independent non-implementer QA1 is pending on the same frozen product and driver hashes. This is a desktop Chromium/local service subitem; no complete device/tournament/TTL/physical-device claim, and Stage 5 remains active.

## 2026-10-20 Stage 5 old-room/new-room independent QA

- QA1 independently replayed the exact frozen product and navigation-only driver hashes; all 6/6 assertions passed, natural driver exit code 0, 22 API responses (only the stale A leave was the expected 403), and `pageErrors=[]`. It covered same-cookie two-tab single-seat restore, delayed A active-room response after leaving A/creating B, stale A HTTP leave, rejected stale A socket attach, and both tabs remaining outside after leaving B and refreshing. QA report and sanitized results: `/Users/yangke/.codex/worktrees/f121/navigation/docs/evidence/texas-stage5-old-active-20261019/qa1/validation.md` and `results-redacted.json`.
- QA-owned API/Vite/Redis were stopped and its three ports released. No product/driver changes. This closes only the Texas active-room pointer subitem; full Stage 5 and physical device coverage remain open.

## 2026-10-20 Stage5 rules-player explicit successor partial

- `/root/texas_rules_successor_2` explicitly succeeded unavailable original role; personally operated two independent local UI sessions on unchanged App/shared-runtime hashes. Natural second hand completed via manual fold while facing call10, both pages settled. First hand UI raise60 led to call50 with no check, then call/check play reached showdown, but rerender timeout prevents full per-street manual-action claim. TP-R2 raise/call/check-exclusion and natural fold-hand subitems PASS; full rules-player/Stage5 PARTIAL.
- Primary PokerStars rules opened. Three community full-page opens returned Cache miss; search excerpts are unverified leads, not completed forum research. No product/config/driver edits. Own API/Vite and isolated no-volume Redis stopped; own browser contexts exited via UI and closed. Documentation diff-check passed. Evidence: docs/evidence/texas-stage5-rules-player-successor-20261020/validation.md. No pageerror listener or screenshots; no claim of zero browser errors or device coverage.

## 2026-10-20 Stage5 disconnect-to-sit-out independent QA1

- Independent non-implementer `/root/texas_sitout_qa1` verified the exact requested product and driver SHA256 set; all matched before/after. No product or driver source was changed.
- Full `corepack pnpm --config.verify-deps-before-run=false --config.manage-package-manager-versions=false test` passed (45 tests); same-config `build` passed across four packages including web `tsc --noEmit`.
- Independent Chromium + loopback API/Vite + isolated no-volume Redis run of `docs/evidence/texas-stage5-disconnect-sitout-20261020/driver.mjs` passed 4/4 assertions: two cookie-isolated players start; last-connection loss retains ready seat; first completed hand stays within grace; second completed hand changes disconnected member to sit-out without deleting seat. `pageErrors`, `consoleErrors`, and the driver's non-WebSocket `requestFailures` are empty.
- QA evidence: `docs/evidence/texas-stage5-disconnect-sitout-20261020/qa1/validation.md`, `results.json`. All owned services/container stopped; ports 32845/14878/5174 had no listeners and the named container was absent afterward.
- This closes only the assigned local desktop browser subcase. Physical phone/external-network checks, broad state/device coverage, and the rest of Stage 5 remain pending.

## 2026-10-20 Stage5 disconnected-seat grace-hand UI (root pass; independent review pending)

- On the frozen Texas product baseline `da483606cec70de0d90075716f0eeb3554cc614c`, a local two-player browser run disconnected one ready member. The first hand settled and retained that seat; the host then could not start the next hand although the engine's existing contract keeps a disconnected ready seat eligible for two missed hands. `ActionPanel.canStartFromSnapshot` imposed an extra `presence === "connected"` requirement absent from server `canStartHand`, preventing that existing policy from running through the UI.
- Minimal fix removes only that extra presence check and adds one regression test with a disconnected ready player. Source hashes: ActionPanel `853f766c5c61fb2419202401d370437b936ee2af2ad559924cc0f2d1424af1f4`; App.test `42348340a707d4419110eb04d8996cf4462cd10f6a4ebf20aae8ef39f47b5b3f`. Server, runtime adapter, poker engine, shared contract and App hashes are recorded in `docs/evidence/texas-stage5-disconnect-sitout-20261020/root/validation.md`.
- Root real browser driver final attempt 4/4 PASS, pageErrors/consoleErrors/failed requests 0: independent Cookie players seat/ready/start; one connection drops; the host completes hand one while the seat remains ready; hand two completes and the disconnected seat becomes `sit-out`, `ready=false`, while remaining occupied. Root report/results/driver are in `docs/evidence/texas-stage5-disconnect-sitout-20261020/`. Full workspace tests 45/45 and all four package builds passed; driver syntax and diff checks passed.
- Preserved the initial missing-socket-origin harness attempt and the corrected pre-fix browser reproduction (first hand passed, next-hand UI absent); neither is counted as a product-test pass. An isolated Redis container and the API/Vite loopback services were stopped; the named container and ports are absent. Independent non-implementer QA1 and QA2 both replayed the same file/driver hashes and passed. This is an emulated desktop Chromium subitem only; Stage5 and physical-device/full rules matrix remain active.
- QA1 and QA2 each independently passed all 4 browser assertions, 45 tests, four package builds, driver syntax, and diff-check on the frozen hashes; both cleaned their owned services/Redis and released ports. Evidence: `docs/evidence/texas-stage5-disconnect-sitout-20261020/qa1/validation.md` and `qa2/validation.md`, with sanitized results in their respective run directories. The bounded product change has met the two-reviewer gate; Stage5 remains active.

## 2026-10-20 Stage5 responsive reconnect control (root + independent QA1 pass)

- Frozen HEAD `da483606cec70de0d90075716f0eeb3554cc614c`; App, ActionPanel, CSS, server app and shared runtime SHA-256 remained `49e19364…`, `853f766c…`, `a5c1db95…`, `88360752…`, `480f8f1d…`. No Texas source/test/config changed; pre-existing dirty files were preserved.
- A navigation-only Playwright driver `docs/evidence/texas-stage5-responsive-reconnect-20261020/driver.mjs` (SHA-256 `2508b72e232303fcfe760758146f685e9c874bfe4549a74b3dc833cd7492bcde`) passed 5/5 against local loopback API/Vite and this batch's disposable no-volume loopback Redis. It checks offline recovery visibility and command lock, touch recovery with same room/player/seat/own-hand identity and no replay, refresh recovery, cold-failure retry messaging, and ten viewport layouts (1440×900 through 320×568/568×320) with >=44×44 control and no horizontal overflow.
- Root evidence/results/viewports and ten button-only crops are in navigation `docs/evidence/texas-stage5-responsive-reconnect-20261020/root/validation.md`; page errors, unexpected console errors and unexpected request failures were empty. The initial missing-Socket-origin attempt is retained under `root/attempt-1-config/` and excluded. Driver syntax and navigation diff-check passed. Read-only cleanup checks found no named Redis container or listener on 14780/14781/32825; unrelated test containers/listeners were untouched.
- Root and independent QA1 each passed the same 5 assertions on identical source/driver hashes; QA1 report is in navigation `docs/evidence/texas-stage5-responsive-reconnect-20261020/qa1/validation.md` with the same ten viewport checks and empty error counters. Two Chromium/offline-emulation rounds are still not physical-device/network testing, and the full state/expiry matrix remains open. Stage5 stays active; no product change, push, merge or deployment.


## 2026-10-20 Stage 5 open-page offline action-deadline subcase

- Root used two independent local Chromium cookie contexts against the frozen HEAD `da483606cec70de0d90075716f0eeb3554cc614c` and unchanged Texas sources/build inputs. The action timer was set to 45s via the UI; the acting browser context went offline while its page stayed open. The observer saw disconnect before the deadline, then server settlement for the connected opponent after the deadline. The actor remained seated/disconnected; same-cookie recovery restored the original participant/seat/view without a new membership or command replay. Five assertions passed; `pageErrors=[]`.
- The final copied driver is `/Users/yangke/.codex/worktrees/f121/navigation/docs/evidence/texas-stage5-offline-deadline-20261020/root/driver.mjs`, SHA `cbf21bc38069a77317370033a3cd944ef61a15f0a8f95c506c4a9928ae6da507`; final results SHA `cb0fdeefba8de03e67451d8a652269aa323f28ecffe35917bda693bb32999857`. Root report: `/Users/yangke/.codex/worktrees/f121/navigation/docs/evidence/texas-stage5-offline-deadline-20261020/root/validation.md`. QA1 same-baseline replay is pending.
- The retained first attempt only hit a test-driver assertion expecting a settled public snapshot to preserve `lastAction`; that view clears the field. It did not establish a product failure. The corrected final driver checks observable pre-deadline disconnect, post-deadline result, still-open offline page, and no command increment. This is Chromium network emulation with local Redis, not a physical network/device check; complete Stage 5 remains active. Dedicated API/Vite/ephemeral tmpfs Redis and temporary script were removed; ports were released. No product code was edited.


## 2026-10-20 Stage5 open-page offline action-deadline subcase (root + QA1 pass)

- Frozen HEAD `da483606cec70de0d90075716f0eeb3554cc614c`, source hashes and copied driver `cbf21bc38069a77317370033a3cd944ef61a15f0a8f95c506c4a9928ae6da507` match across root and independent QA1. Each run passed 5/5: the acting browser page remained open but offline before the 45-second deadline; the connected opponent observed disconnection and the server settled after the deadline; same-cookie recovery restored the original seat without membership duplication or command replay. Both result files have SHA-256 `cb0fdeefba8de03e67451d8a652269aa323f28ecffe35917bda693bb32999857`.
- Reports: `/Users/yangke/.codex/worktrees/f121/navigation/docs/evidence/texas-stage5-offline-deadline-20261020/root/validation.md` and `.../qa1/validation.md`. This is Chromium offline emulation, not physical network/device or complete Stage5 acceptance. Stage5 remains active; no product source changed.
