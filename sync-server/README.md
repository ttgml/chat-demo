# chat-demo 同步服务

为 [chat-demo](../README.md) 提供多设备会话同步的独立服务。**自部署与托管运行的是同一份代码、同一个镜像**，区别只在配置：

| | 自部署 | 托管 |
|---|---|---|
| 部署方式 | `docker compose up` 或单二进制 | 同一镜像 + 反向代理 / HTTPS |
| 数据库 | 本机 Postgres | 托管 Postgres |
| 前端配置 | 填自己的服务地址 | 填托管服务地址 |
| 注册开放 | 由部署者控制（见下文） | 可限流并配额 |

## 设计要点

- **无损原生格式**：会话以客户端 IndexedDB 中的 `Session` JSON 存入 `payload JSONB`，服务端**不解析、不改写**内部字段，所有字段与值完整保留。现有的 ZIP 导入导出是给其他 app 兼容用的有损归档，本服务不使用、也不影响它。
  > 注意 `jsonb` 会**重排对象键的顺序**（例如 `{nested, keepMe}` 取回后变成 `{keepMe, nested}`），因此字节级并非逐字相同，语义上无损。前端按字段名读取，不受影响；但如果将来要用 `JSON.stringify` 结果做哈希或比较，需要先规范化键顺序。
- **增量游标**：每个用户一个单调递增的 `rev`。任何会话写入、删除（墓碑）、附件上传都会 `+1`。客户端用 `since` 增量拉取。
- **实时通知**：`GET /api/watch` 是 WebSocket 端点，写事务提交后按账号广播 `{type:"changed",rev}`。客户端收到后仍走原有增量拉取，通知丢失或重复都不影响一致性；定时轮询始终保留作兜底。
- **乐观锁**：上传会话须带 `baseRev`（客户端上次看到的服务端版本），不一致返回 `409`，由客户端决定用哪一版。避免多设备静默互相覆盖。
- **墓碑删除**：删除会话写 `deleted = true` 并保留记录，保证其他设备能收到删除事件。默认拒绝任何 `PUT` 覆盖墓碑，避免离线设备的旧编辑把已删会话"复活"；只有客户端显式带 `revive: true` 且 `baseRev` 匹配时才允许恢复（用于重新导入备份）。
- **附件解耦**：附件按客户端 `file.id` 独立存储，服务端不做引用计数 GC，避免设备 A 删会话时误删设备 B 仍引用的图片。
- **按用户隔离**：所有 SQL 都带 token 解析出的 `user_id`，从不信任客户端传入的用户标识。

## 快速开始

```sh
cp .env.example .env
# 至少修改 SYNC_ALLOWED_ORIGINS 为你的前端地址
docker compose up -d --build   # 源码更新后必须带 --build，否则会复用旧镜像
curl http://localhost:8080/healthz   # -> ok
# 确认实时推送端点已包含在镜像里：400 为正常，404 说明跑的是旧镜像
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/watch
```

> 常见坑：`docker compose up -d` 只按现有镜像创建容器，**不会重新编译**。
> 更新代码（例如加入 WebSocket 支持）后若漏掉 `--build`，REST 同步仍正常，
> 但 `/api/watch` 返回 404，前端会一直连不上实时推送。

或直接跑二进制（需已有 Postgres）：

```sh
SYNC_DATABASE_URL='postgres://user:pass@localhost:5432/chatsync?sslmode=disable' \
SYNC_ALLOWED_ORIGINS='http://localhost:8090' \
go run .
```

表结构在启动时自动创建（`CREATE TABLE IF NOT EXISTS`），无需手动迁移工具。

### 与前端本地联调

```sh
# 终端 1：同步服务 + Postgres
cd sync-server && cp .env.example .env && docker compose up -d --build

# 终端 2：前端开发服务器（http://localhost:8090）
cd .. && pnpm dev
```

在设置 → 云同步里填 `http://localhost:8080`、用户名、密码，点「注册」即可开启。
`.env` 里的 `SYNC_ALLOWED_ORIGINS` 必须包含前端来源（默认已含 `http://localhost:8090`），
否则浏览器预检会被拦。HTTP 仅用于本机联调，公网部署务必上 HTTPS。

验证两台设备：用两个不同的浏览器用户配置（或无痕窗口）打开同一前端地址，
用同一账号登录，在其中一个新建对话，另一个会立即收到 WebSocket 通知并自动拉取；
若长连接被代理拦掉，则退回切回前台 / 60 秒定时同步。

实时推送连不上时按顺序排查（设置 → 云同步会显示当前状态）：

1. `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/watch`：
   `400` 表示端点存在（不带 Upgrade 头属正常），`404` 表示跑的是旧镜像，重新执行 `docker compose up -d --build`。
2. `SYNC_ALLOWED_ORIGINS` 要与浏览器地址栏的 origin **完全一致**；`http://localhost:8090` 与 `http://127.0.0.1:8090` 是两个不同来源，不匹配时握手返回 `403`。
3. 浏览器控制台看 WebSocket 握手状态码；公网部署还要确认反向代理放行 Upgrade，并把该路径读超时设到 70 秒以上。

## 配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SYNC_DATABASE_URL` | 必填 | Postgres 连接串 |
| `SYNC_ADDR` | `:8080` | 监听地址 |
| `SYNC_ALLOWED_ORIGINS` | 空（禁跨域） | 允许的前端来源，逗号分隔 |
| `SYNC_REQUIRE_HTTPS` | `false` | 附加 HSTS 头 |
| `SYNC_TOKEN_TTL` | `720h` | 登录 token 有效期 |
| `SYNC_MAX_SESSION_BYTES` | `8388608` | 单个会话 JSON 上限 |
| `SYNC_MAX_FILE_BYTES` | `33554432` | 单个附件上限 |
| `SYNC_LOGIN_LIMIT` | `10` | 每 IP 窗口内登录尝试次数 |
| `SYNC_LOGIN_WINDOW` | `15m` | 限流窗口 |

## API

除注册、登录和 `/healthz` 外，所有接口都需要 `Authorization: Bearer <token>`；
`/api/watch` 是唯一例外（浏览器 WebSocket 无法设置该头，改用首帧认证，见下文）。
用户名 3-32 位字母/数字/`_ . -`，密码 8-72 字节（bcrypt 上限）；密码用 bcrypt 加盐哈希存储。

### 认证

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/register` | `{username, password}` | `201 {token}`；重名 `409` |
| POST | `/api/login` | `{username, password}` | `200 {token}`；凭据错误统一 `401` |
| POST | `/api/logout` | — | `{ok: true}`，撤销当前 token |

登录失败不区分"用户不存在"与"密码错误"，避免账号枚举。

### 同步

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | `{rev, sessions}` 当前全局游标 + 云端未删除的会话数（设置页概览用；`sessions` 为新增字段，旧客户端忽略） |
| GET | `/api/changes?since=<rev>&limit=<n>` | 增量变更列表 |
| GET | `/api/session/{id}` | 单个会话完整原生 JSON |
| PUT | `/api/session/{id}` | 上传/更新会话；`revive: true` 且 `baseRev` 匹配时可覆盖墓碑 |
| DELETE | `/api/session/{id}?baseRev=<rev>` | 删除会话（写墓碑） |
| PUT | `/api/file/{id}` | 上传附件原件（二进制，Content-Type 即 MIME） |
| GET | `/api/file/{id}` | 下载附件原件 |
| GET | `/api/watch` | WebSocket 变更通知（首帧携带 token 认证，见下文） |

**`GET /api/changes` 响应**

```json
{
  "rev": 42,
  "nextSince": 25,
  "sessions": [
    { "id": "s1", "rev": 23, "updatedAt": 1730000000000, "deleted": false },
    { "id": "s2", "rev": 25, "updatedAt": 0, "deleted": true }
  ],
  "files": [{ "id": "f1", "rev": 24, "mimeType": "image/png" }],
  "hasMore": true
}
```

> **重要**：分页时下一次请求必须用 `nextSince`（本页最大 rev），**不要用 `rev`**（全局最大版本号）。
> 服务端把会话与附件的变更统一按 `rev` 排序后分页，两类分别分页会让中间变更被跳过。
> 循环拉取直到 `hasMore: false`，然后把 `rev` 记为本地已同步游标。

**`PUT /api/session/{id}` 请求**

```json
{
  "baseRev": 23,
  "updatedAt": 1730000000000,
  "session": { "id": "s1", "title": "...", "messages": ["..."], "..." : "..." },
  "revive": false
}
```

`session` 是前端 `Session` 对象的原始 JSON，服务端只校验它是合法 JSON。
`revive` 可选，默认 `false`；仅当客户端已知该 id 是墓碑、且确实要恢复时才置 `true`。
成功返回 `{rev: 26}`；`baseRev` 与服务端不符，或服务端是墓碑但未带 `revive` 时返回：

```json
{ "error": "conflict", "message": "...", "serverRev": 25, "deleted": false }
```

`deleted` 告知客户端服务端当前是否是墓碑，`serverRev` 是可用来重试的当前版本。
`revive` 不能绕过乐观锁：`baseRev` 不匹配仍然返回 `409`。

错误码统一为 `{error, message}`：`400` 参数非法、`401` 未登录、`404` 不存在、
`409` 冲突、`413` 超限、`429` 登录限流。

### 实时通知（WebSocket）

`GET /api/watch` 让同一账号的其它设备立刻知道「有变更」。服务端只推版本号，不推会话内容，
客户端收到后仍走 `GET /api/changes` 增量拉取，因此通知丢失、乱序或重复都不会破坏数据；
前端另保留 60 秒定时同步作为兜底，旧版服务端或代理未放行 Upgrade 时自动降级。

浏览器 WebSocket API 不能设置 `Authorization` 头，把 token 放进 URL 又会留在代理日志里，
因此采用**首帧认证**：连接建立后客户端立即发送（5 秒内，否则断开）：

```json
{ "type": "auth", "token": "<登录 token>" }
```

校验通过后服务端回复 `{"type":"ready","rev":42}`（`rev` 是当前游标，客户端据此补拉一次），
随后在任意会话写入、删除、附件上传的事务提交后广播 `{"type":"changed","rev":43}`。

| 方向 | 消息 | 说明 |
|---|---|---|
| 服务端 → 客户端 | `{"type":"ping"}` | 每 25 秒一次，客户端需回 `{"type":"pong"}` |
| 服务端 → 客户端 | `{"type":"auth_required"}` | token 无效或过期，随后关闭连接 |
| 服务端 → 客户端 | `{"type":"error"}` | 服务端临时故障，客户端稍后重连，不清除登录态 |

70 秒未收到任何客户端消息即判定连接死亡；连接最长存活 30 分钟，到期断开让客户端重新认证。
广播严格按 token 解析出的 `user_id` 隔离；退出登录只断开该 token 建立的连接，不影响其它设备。
`Origin` 校验沿用 `SYNC_ALLOWED_ORIGINS`（同源、`file://` 产生的 `null` 与非浏览器客户端放行），
因为 WebSocket 没有 CORS 预检，必须在握手阶段自行拒绝未知来源。

## 前端接入（已实现）

前端代码在 `src/services/sync/`，设置弹窗新增「云同步」分区。落地时的几个关键约定：

1. 设置里填服务地址 + 用户名密码，登录/注册后只持久化 token 与地址，密码不落盘。
2. **启动时**：`GET /api/changes` 用 `nextSince` 分页拉全量变更 → 逐个 `GET /api/session/{id}` → 在单个 IndexedDB 事务中增量 upsert 并应用墓碑。**没有复用 `replaceHistory()`**（它是全量清空重写，会抹掉本地未同步数据），而是新增 `db.applyRemoteChanges()` + `store.applyRemoteSummaries()`。
3. **同步元数据独立库**（`chat-demo-sync`），不动主库的 `DB_VERSION`：存 `lastSyncedRev`、每会话 `baseRev`、待上传队列、已上传附件 rev。
4. **本地变更后**：`store.ts` 在落盘成功后发出变更通知；流式生成中的中间态不上传，回复 settle 后的那次落盘才排队。先上传会话引用的附件原件，再上传会话。
5. **全局游标只由 pull 阶段按页推进**，push 成功只更新单会话 `baseRev`。若 push 后把游标跳到上传返回的 rev，会漏掉这期间另一台设备上传的较小 rev 变更。
6. **冲突 `409` / 拉取覆盖**：按会话内容时间（`updatedAt` 与最后一条消息时间的较大者）比较，谁更新用谁。本地更新则以 `serverRev` 为 `baseRev` 重新上传；服务端更新或时间相同则采用服务端版本并 toast 提示。服务端是墓碑时默认沿用删除；但导入备份属于显式全量替换，会带 `revive: true` 覆盖墓碑恢复会话，避免"删除全部 → 重新导入"后两端一起清零。
7. 同步失败不阻塞聊天：本地照常写 IndexedDB，变更排队 + 指数退避重试；401 自动清除登录态并要求重新登录。
8. 已登录后锁定服务器地址与用户名；更换账号请先退出登录（本地会话保留），重新登录后清空同步进度重新对账。
9. **实时通知**：`watch.ts` 连接 `/api/watch`，收到 `ready` / `changed` 后 200ms 合并触发一次完整同步；断线按指数退避重连，切回前台立即重试，`auth_required` 时清除登录态。60 秒定时同步始终保留兜底，连接状态显示在设置页。

## 测试

```sh
go test ./...                              # 单元测试（集成测试自动跳过）
docker compose up -d db                    # 起一个测试用 Postgres
SYNC_TEST_DATABASE_URL='postgres://chatsync:chatsync@localhost:5432/chatsync?sslmode=disable' \
  go test -count=1 -v ./...                # 含集成测试
```

集成测试用随机用户名后缀隔离数据，**不会清空数据库**，可以安全地对已在使用中的库运行。
覆盖：注册登录、用户隔离、会话无损往返、乐观锁冲突、删除墓碑、墓碑复活（`revive` 与 `baseRev` 组合）、附件往返、分页游标不丢数据、未授权访问，以及实时通知的账号隔离、Origin 校验、无效 token 与登出断连。

## 安全与运维注意事项

- **自部署走 HTTP 时，用户名密码和聊天记录是明文传输的**。局域网内也有风险，公网部署务必在前面挂 HTTPS 反代并设置 `SYNC_REQUIRE_HTTPS=true`。
- `SYNC_ALLOWED_ORIGINS` 必须精确列出前端来源。跨域带凭证不允许通配 `*`，配置错误会直接导致浏览器预检失败；WebSocket 握手也按同一份白名单校验 `Origin`。
- 反向代理必须放行 WebSocket Upgrade（`Connection: Upgrade` / `Upgrade: websocket`），并把该路径的读超时设到 70 秒以上；否则前端会自动退回定时同步。
- `/api/watch` 受进程内连接总数上限（2048，含未认证连接）保护；公网部署仍建议在网关层按 IP 限制并发长连接。
- 登录限流目前是**进程内**计数；多实例托管时需要在网关层再做一层全局限流。
- 当前版本**没有注册开关、配额、审计日志和附件 GC**。托管给不特定用户前，建议补上注册开关（环境变量控制）、单用户容量上限、以及墓碑/附件的定期清理策略。
- 附件以 `BYTEA` 存在 Postgres 中，量大时数据库会膨胀。数据量增长后可迁到对象存储，接口保持不变。
- 数据库里是聊天明文。托管方需要明确的隐私说明、备份加密和保留期限。

## 已知边界

- 实时通知的订阅表是**进程内**的：多实例部署时，某台实例上的写入只会通知连到同一实例的客户端，连到其它实例的客户端要等切回前台或下一轮 60 秒轮询。彻底解决需要 Postgres `LISTEN/NOTIFY` 或消息总线；数据一致性不受影响。
- 冲突粒度是**会话级**，同一会话两端同时编辑会互相覆盖；消息级合并留待后续版本。
- 附件上传目前按 `file.id` 幂等覆盖，无版本校验；配合会话里记录的 `baseRev` 使用。
- 墓碑不会自动清理，长期运行后首次 `since=0` 的全量同步会变慢，需要清理策略。
