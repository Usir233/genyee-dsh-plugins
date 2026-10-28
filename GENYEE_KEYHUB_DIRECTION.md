# Genyee 密钥中心（`@genyee/dsh-keyhub`）方向文档

> 状态：方向已定，进入 M0 技术验证。
> 基线：上游 `@deepseek-ai/dsh-root` `0.2.2-alpha.2`。
> 关系：本文取代 `Usir233/DSH-GENYEE` 仓库中的 DSH_ENTERPRISE_PLAN.md 的第 5 节（模式 A/B 选型）和第 6 节中与密钥、网关相关的工作流；该文档其余部分作为背景材料保留。

---

## 1. 一句话方向

做**一个** DSH 插件 `@genyee/dsh-keyhub`，装在公司每个人的 DSH 里，分**管理员模式**和**员工模式**：管理员的 DSH 保管公司唯一的 DeepSeek 官方 API Key，并在内网转发员工的模型请求；转发时换上真实 Key、强制写入该员工的 `user_id`，使用 DeepSeek 官方的 `user_id` 隔离能力。**不修改上游 DSH 代码，不部署第三方网关。**

## 2. 已确定的决策

| 编号 | 决策 | 理由 | 放弃的方案 |
|---|---|---|---|
| D1 | 模型只用 DeepSeek 官方 API，走上游原生 `llm-deepseek` 适配器（Anthropic Messages 协议，`https://api.deepseek.com/anthropic`） | 保留系统提示词增量更新、中途工具增删不破 KV Cache、思考签名回放；与 `user_id` 隔离配套 | 多厂商；经 `llm-pi-ai` 走 OpenAI 兼容协议 |
| D2 | 只写插件，不改上游代码，不 fork 桌面端 | 跟进上游零合并成本 | 桌面薄壳 fork、上游锁定层 PR（原 L3/L4，见 §9） |
| D3 | 一个插件包，`role: admin \| employee` 两种模式 | 你的要求；两端共享协议定义，版本天然一致 | 管理端、员工端拆成两个包 |
| D4 | 真实 Key 只存在管理员机器；员工只持有可吊销的**授权码** | Key 进入员工进程就能被同一系统用户取出（调试自身进程、抓包），与是否有 DSH 管理员权限无关 | 原模式 A：Key 下发到员工内存 |
| D5 | `user_id` 由管理端按授权码**强制覆盖**写入，忽略客户端传来的值 | 客户端写的 `user_id` 可伪造：员工能冒用同事身份，内容安全违规会记到别人头上，单人并发上限也会被绕开 | 员工端经 `deepseekLlmApiExtensions` 注入 |
| D6 | 转发服务运行在**管理员的 DSH 进程内**；管理员 DSH 必须常开，否则员工无法使用 | 你已接受该代价；不需要另外部署服务 | 独立服务器上的网关 |
| D7 | 转发服务由插件自己用 `node:http` / `node:https` 监听，不依赖 `dsh-host-webserver` | 已核实 `dsh-host-webserver` 只组合在 `web-app` 组合包里；桌面端经 `file://` + IPC 加载界面，没有 HTTP 服务器 | 原模式 B 写的"复用宿主 `ctx.webserver`" |
| D8 | 员工端注册**自己的** DeepSeek 路由 `genyee-keyhub`，复用上游公开导出的 `registerDeepSeekProvider`；不修改官方路由 `llm-deepseek-api-key` 的配置 | 员工端只需一个插件即可工作；模型选择器里显示为独立的"Genyee"路由 | 改写官方路由的 `baseURL` 和 `apiKeyEnv` |
| D9 | 管理员自己使用 DSH 时，也走本机转发（回环地址），身份为自动创建的"管理员"员工条目 | 管理员的请求同样带 `user_id`、计入用量，两种模式行为对称 | 管理员直接用官方路由 |
| D10 | 管理端转发时删除 `dsh_plugin_packages` 请求体字段和 `x-deepseek-harness-user-id` 请求头 | 已核实：上游会向 DeepSeek 请求附带启用的插件包清单和设备匿名 ID；企业场景不需要外发 | 原样透传 |
| D11 | 以 `.tgz` 包分发，用 `dsh plugin --profile <name> add ./genyee-dsh-keyhub-<version>.tgz` 安装；`package.json` 声明精确的 `engines.dsh` 范围 | 客户内网不一定能访问 npm；`engines.dsh` 不兼容时启动器跳过该组合包，不会带病运行 | 公共 npm 发布 |

## 3. 威胁模型

**信任根**：管理员机器及其系统账号。管理员机器失陷等于 Key 泄露，不在本插件防护范围内。

| 员工可能的行为 | 结果 |
|---|---|
| 改 `~/.dsh/cordis.patch.yml` 禁用或篡改插件 | 只是自己用不了公司模型；拿不到 Key |
| 从自己进程内存或网络抓包中取出授权码 | 授权码本来就是他自己的；离开内网无法使用；管理员可随时吊销 |
| 把授权码拷到另一台内网机器上用 | 可用，但用量仍记在他名下。v1 在用量记录里保存来源 IP；绑定 IP 留到后续版本 |
| 在请求里伪造别人的 `user_id` | 无效：管理端强制覆盖（D5） |
| 自己填一个私人 DeepSeek Key 走官方路由 | 不受管控，也不消耗公司额度；属于公司制度问题，不是本插件的范围 |
| 被停用后继续使用 | 下一次请求即被管理端拒绝；进行中的流式请求立即中断 |

**结论**：所有强制性控制（谁能用、用谁的 Key、`user_id` 是什么、用量记录）都在管理端执行。员工端代码只负责体验，不承担安全职责。因此 v1 **不需要**上游的管理员锁定配置层。

## 4. 架构

```
员工 A 的 DSH（员工模式）──┐
员工 B 的 DSH（员工模式）──┼── 内网 HTTPS ──▶ 管理员的 DSH（管理员模式）── HTTPS ──▶ api.deepseek.com/anthropic
管理员自己的会话（回环）───┘                  · 校验授权码
                                              · 换 x-api-key 为真实 Key
                                              · 强制写 metadata.user_id
                                              · 删除 dsh_plugin_packages、x-deepseek-harness-user-id
                                              · 流式原样转发、记录用量
```

## 5. 插件设计

### 5.1 包与配置

- 包名：`@genyee/dsh-keyhub`，函数插件（具名导出 `name` / `inject` / `Config` / `apply`，无默认导出）。
- `peerDependencies`：`@deepseek-ai/cordis`；依赖上游公开包 `@deepseek-ai/dsh-llm-deepseek`、`@deepseek-ai/dsh-credentials` 等，版本与 `engines.dsh` 对齐。
- 配置字段（`role` 无默认值，缺失或非法即加载失败）：

| 字段 | 模式 | 含义 |
|---|---|---|
| `role` | 两者 | `admin` 或 `employee` |
| `listen.host` / `listen.port` | admin | 监听地址；只接受具体 IP，拒绝 `0.0.0.0` 一类通配地址（与上游 webserver 规则一致） |
| `tls.cert` / `tls.key` | admin | 证书和私钥路径；未配置时必须显式设置 `insecureHttp: true`，并在启动时告警 |
| `apiKeyRef` | admin | 公司真实 Key 的凭据引用名，例如 `GENYEE_DEEPSEEK_API_KEY`，存于管理员本机凭据库，配置文件不含密钥 |
| `upstreamBaseURL` | admin | 默认 `https://api.deepseek.com/anthropic` |
| `upstreamReadTimeoutMs` | admin | 不小于 `600000`，覆盖 DeepSeek 排队时长达 10 分钟的 `: keep-alive` |
| `adminURL` | employee | 管理端地址，例如 `https://10.0.0.8:8443` |
| `tokenRef` | employee | 授权码的凭据引用名，例如 `GENYEE_KEYHUB_TOKEN` |

### 5.2 员工模式

1. 用 `registerDeepSeekProvider(ctx, 'genyee-keyhub', …)` 注册路由：`baseURL` = `adminURL` + `/anthropic`，`resolveAuth` 返回 `{ 'x-api-key': <授权码> }`，授权码每次请求经 `ctx.credentials.resolve(tokenRef)` 读取。
2. 模型目录使用上游内置 DeepSeek 目录（已核实：`baseURL` 不是官方源时，上游不跟随 `/models` 在线列表）。
3. 首次使用：在插件设置页填写管理端地址和授权码，授权码经 `ctx.credentials.set` 写入员工本机凭据库。
4. 管理端返回"授权码已停用"时，给出明确提示："授权已被管理员停用，请联系管理员"。

### 5.3 管理员模式

**转发服务**，路由：

| 路由 | 处理 |
|---|---|
| `POST /anthropic/v1/messages` | 主路径：校验 → 改写 → 流式转发 → 记录用量 |
| `/anthropic/v1/files*` | Files API 透传：校验、换 Key；记录 `file_id` 的上传者 |
| `GET /keyhub/v1/status` | 员工端检查连通性和授权状态 |

主路径的处理步骤：

1. 从 `x-api-key` 取授权码，计算 SHA-256 后查员工表；查不到或已停用，返回 401 和机器可读的错误码。
2. 解析 JSON 请求体：设置 `metadata.user_id` 为该员工的 `user_id`（覆盖已有值），删除 `dsh_plugin_packages`。
3. 请求头：`x-api-key` 换成真实 Key，删除 `x-deepseek-harness-user-id`，原样保留 `anthropic-version` 和 `anthropic-beta`。
4. 流式转发：响应体逐块直通，不缓冲，原样保留 SSE 注释行；员工端断开时中止上游请求；员工被停用时中断该员工进行中的流。
5. 旁路解析 SSE 中的 `message_start` / `message_delta` 用量字段，按员工记录输入、输出、缓存命中 token 和来源 IP。

**身份与授权码**：

- `user_id` 格式 `emp_<随机 16 位 base32>`，创建员工时生成，**不含姓名、工号等明文隐私**，满足官方约束（`[a-zA-Z0-9\-_]+`，最长 512）。员工姓名与 `user_id` 的对照只存在管理端。
- 授权码 `gk_<256 位随机数的 base64url>`，生成时只显示一次，管理端只存 SHA-256。
- 员工表、用量记录存于管理员本机，经上游存储设施（`ctx.storageDomain` / `storage-sqlite`）持久化。

**管理界面**（插件页面，经 `dsh.client` 客户端半侧挂载）：

- 员工列表：新增、停用、启用、重置授权码（旧码立即失效）
- 用量：按员工、按日统计 token
- 服务状态：监听地址、证书状态、上游连通性

## 6. 里程碑与验收标准

### M0 技术验证（先做，任何一项不通过都要回来改方向）

| 编号 | 验证项 | 通过标准 |
|---|---|---|
| V1 | 桌面端宿主进程内，插件能自行监听内网端口 | 另一台机器能访问 `GET /keyhub/v1/status` |
| V2 | `registerDeepSeekProvider` 可从树外包调用 | 员工端路由跑通一次带工具调用的多轮对话，`anthropic-beta` 原样到达上游 |
| V3 | DeepSeek Anthropic 端点接受 `metadata.user_id` | 同一 Key、不同 `user_id` 的并发请求互不挤占单用户并发上限（官方说明页 `api-docs.deepseek.com` 在本会话网络中无法访问，当前以 DSH_ENTERPRISE_PLAN.md §4.10 的摘录为准，必须实测） |
| V4 | 员工端信任管理端证书的方式 | 上游适配器使用全局 `fetch`，无法按请求固定证书；需确认公司内部 CA 或自签证书的信任途径（系统证书库或 `NODE_EXTRA_CA_CERTS`）在桌面端有效 |
| V5 | 树外包构建客户端半侧 | 上游的 `clientBundle` 构建预设不在已发布包里，需在我们仓库复刻；管理界面在桌面端能显示 |
| V6 | 桌面端安装 `.tgz` 插件 | 确认桌面端所用 profile 名称，`dsh plugin add` 后重启生效 |
| V7 | 上游包已在 npm 发布且版本可对齐 | `@deepseek-ai/dsh-llm-deepseek` 等依赖可按 `0.2.2-alpha.2` 安装 |

### M1 转发闭环（无界面）

- 员工表用一个本地 YAML 文件手工维护（临时手段，M2 移除）
- 验收：
  - 两名员工同时对话，DeepSeek 收到两个不同的 `user_id`
  - 员工请求体中伪造的 `metadata.user_id` 被覆盖
  - 停用员工后，下一次请求返回 401，进行中的流被中断
  - 抓包确认上游请求中没有 `dsh_plugin_packages` 和 `x-deepseek-harness-user-id`
  - 排队 5 分钟以上的请求不被转发层超时切断

### M2 管理界面与用量

- 员工增删停、重置授权码、用量统计全部在管理员 DSH 内完成
- 员工端设置页：填写管理端地址和授权码、显示连接状态

### M3 交付

- `.tgz` 包、`engines.dsh` 精确范围、安装手册（管理员、员工各一份）、版本矩阵
- 用 DSH 测试设施编写真实组合测试（通过 Loader 加载 `cordis.yml`，只模拟 DeepSeek 上游）

## 7. 仓库

- 新仓库 `genyee-dsh-plugins`：pnpm workspace，第一个包放在 `packages/keyhub/`；以后的 Genyee 插件（WeKnora 预配置、审计等）各自成包。
- 当前仓库 `DSH-GENYEE`：上游的 fork，只用于阅读源码和本地联调，不承载 Genyee 代码。

## 8. 待定事项（不阻塞 M0）

1. 每名员工的 token 月额度：放到 M2 之后，还是 v1 就要？
2. 管理员机器关机期间，是否需要一台备用管理员机器（两台管理端共享员工表）？v1 不做。
3. 授权码是否需要有效期（例如 90 天自动失效）？v1 只有手动吊销。

## 9. 明确不做

- 多厂商、本地模型路由
- 桌面端品牌 fork、更新源替换、企业 SSO 登录页（原 L3）
- 上游管理员锁定配置层 PR（原 L4）：安全控制已全部在管理端执行（§3），v1 不需要
- 员工端的工具、目录策略强制执行：客户端无法强制，留待以后需要时单独设计
