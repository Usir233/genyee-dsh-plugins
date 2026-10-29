# @genyee/dsh-keyhub

Genyee 密钥中心：一个 DSH 插件，分管理员和员工两种模式。管理员的 DSH 保管公司 DeepSeek 账号下各部门的 API Key，在内网转发员工的模型请求，并按员工强制写入 DeepSeek 的 `metadata.user_id`、执行金额额度。员工只持有管理员发放的接入码，拿不到真实 Key。设计依据见仓库根目录的 [GENYEE_KEYHUB_DIRECTION.md](../../GENYEE_KEYHUB_DIRECTION.md)。

## 界面

- **管理页面**（只在管理员的 DSH 中出现）：左侧栏“Genyee 密钥中心”。六个标签：
  - **部门**：新增、停用部门，设置部门 Key。
  - **员工**：新增、停用、调整部门、限制可用模型和并发、重置接入码。接入码只显示一次。
  - **额度**：部门和员工两级额度，以及临时追加。
  - **价格**：按模型维护价格，可删除。
  - **用量**：按日期查看部门和员工的金额与 token，导出 CSV。
  - **服务状态**：转发地址、证书指纹、账号余额。
- **员工设置**（每个安装了本插件的 DSH 都有）：设置 → Genyee 密钥中心。在这里粘贴接入码，查看连接状态、可用模型和剩余额度。

管理页面和员工设置通过 DSH 的 `/api/genyee-keyhub/admin` 与 `/api/genyee-keyhub/employee` 两个接口工作。DSH 只允许本机用户本人（owner）访问这两个接口；员工能访问的只有转发服务。

## 转发时做什么

每个发往 `/anthropic/v1/messages` 的请求，管理端依次：

1. **校验授权码**：用请求头 `x-api-key` 中的授权码查账本。授权码未知、员工停用或部门停用时拒绝，请求不发往 DeepSeek。
2. **检查限制**，任一项不满足即拒绝：
   - 模型在员工的可用列表内；
   - 该模型已设置价格；
   - 员工同时进行的请求数未超上限；
   - 员工额度和部门额度都有余额。“已用”包括进行中的请求按 `max_tokens` 预留的金额，多个并发请求不能一起冲破额度。
3. **改写请求体**：把 `metadata.user_id` 设为该员工的 `userId`，覆盖员工端传来的值；删除所有 `dsh_` 开头的 DSH 扩展字段，包括插件清单 `dsh_plugin_packages` 和会话日志 `dsh_session_log`。
4. **改写请求头**：把 `x-api-key` 换成该员工所属部门的 Key，删除 `x-deepseek-harness-user-id`（设备匿名 ID）。
5. **流式转发**：原样转发响应，包括 DeepSeek 排队时的 `: keep-alive` 注释。没有数据时最多等待 600 秒。
6. **记账**：从响应中读取用量，按请求完成时的价格折算金额，记入账本。如果员工在 DeepSeek 返回最终用量前断开，已生成的输出按每 4 字节 1 个 token 估算计费，并在用量记录中标为“估算”。

**拒绝时员工看到什么**：拒绝原因以 HTTP 400 `invalid_request_error` 返回，`error.code` 是机器可读的原因（如 `keyhub_quota_exhausted`、`keyhub_model_not_allowed`、`keyhub_unauthorized`）。DSH 会把 401、402、403 换成自己的通用提示（如“API 密钥无效”），而 400 会原样显示管理端写的中文原因。并发超限是唯一的例外，返回 429，DSH 会自动重试。

**变更生效时间**：账本变化（包括命令行工具在 DSH 运行期间的写入）约 1 秒内生效。员工被停用、重置授权码或调整部门时，进行中的请求立即中断。

**Files API**：DSH 上传图片时使用 `/anthropic/v1/files`。管理端记录每个文件的上传者：列表只返回本人的文件，读取或删除他人的文件返回 404。上传同样受额度限制，没有声明长度的上传也按累计字节执行大小上限。

## 安装

两种模式安装同一个包。组合包默认是员工模式，并把默认模型切换到 `genyee-keyhub` 路由。桌面端可以在“插件 → 添加插件”中填入 `.tgz` 的绝对路径，也可以用命令行：

```sh
dsh plugin --profile <profile> add ./genyee-dsh-keyhub-<version>.tgz
```

### 管理员

1. **生成证书**：生成转发服务的证书，证书里写入管理员电脑的内网 IP。插件安装后自带命令 `genyee-keyhub-admin`；下文的 `T` 代表 `node <profile 目录>/node_modules/@genyee/dsh-keyhub/lib/tools/admin-tools.js`。

   ```sh
   T make-cert --ip 10.0.0.8 --out ~/.genyee-keyhub
   ```

2. **新增管理员插件行**：在管理员 profile 的 `cordis.patch.yml` 末尾新增一行管理员模式的插件行。组合包自带的员工行保持不变，管理员自己用 DSH 时也走本机转发，用量记在管理员自己的员工条目下。

   ```yaml
   - insert:
       - id: genyee-keyhub-admin
         name: '@genyee/dsh-keyhub'
         config:
           role: admin
           listenHost: 10.0.0.8
           listenPort: 8443
           tlsCertFile: /home/admin/.genyee-keyhub/relay.crt
           tlsKeyFile: /home/admin/.genyee-keyhub/relay.key
           ledgerFile: /home/admin/.genyee-keyhub/ledger.db
   ```

   - `listenHost` 必须是本机某个网卡的具体 IP，不接受 `0.0.0.0`、`::` 等通配写法。IP 变了时插件会拒绝启动并提示。
   - 不配置证书时必须显式写 `insecureHttp: true`，此时授权码在内网明文传输。

3. **在管理页面完成配置**：重启 DSH 后打开左侧栏“Genyee 密钥中心”，按以下顺序操作：
   1. 部门 → 新增部门 → 设置 Key；
   2. 价格 → 按 DeepSeek 官网价格填写；
   3. 员工 → 新增员工（也给管理员自己建一条），把只显示一次的接入码交给员工；
   4. 额度 → 按需设置。

   管理员自己的接入码在“设置 → Genyee 密钥中心”中粘贴。

部门 Key 存在管理员 DSH 的凭据库中（文件 `<DSH 数据目录>/.credentials.yaml`），账本只保存凭据引用名（如 `GENYEE_DEEPSEEK_KEY_RD`）和授权码的 SHA-256。

### 命令行工具

管理页面的所有操作也可以用命令行完成，DSH 运行期间写入同样约 1 秒内生效。周期和日期按管理端记录在账本中的时区计算。

```sh
T department --db DB --id rd --name 研发部 --key-ref GENYEE_DEEPSEEK_KEY_RD
T price --db DB --model deepseek-flash --hit 0.2 --miss 2 --output 3
T employee-add --db DB --name 张三 --department rd --relay https://10.0.0.8:8443 --cert ~/.genyee-keyhub/relay.crt
T quota --db DB --department rd --amount 5000 --period month
T top-up --db DB --employee emp_xxx --amount 50 --note 项目加急
T employee --db DB --user emp_xxx --models deepseek-flash --max-concurrency 4
T employee --db DB --user emp_xxx --disable
T employee --db DB --user emp_xxx --reset-token --relay https://10.0.0.8:8443 --cert ~/.genyee-keyhub/relay.crt
T report --db DB
T export --db DB --from 2026-10-01 --to 2026-11-01 --out usage.csv
```

额度规则：

- **周期**：`day`、`week`（周一起）、`month`、`year` 或 `total`（不重置）。
- **追加**：只在当前周期有效；`total` 的追加永久有效。
- **修改额度**：只改金额时保留本周期已用和追加；改周期从修改时刻重新计算。
- **价格**：价格表里没有的模型会被拒绝；改价只影响之后完成的请求。

### 员工

在 DSH 的“设置 → Genyee 密钥中心”中粘贴管理员给的接入码并保存，然后在模型选择器中选择 Genyee 路由。设置页会显示是否已连接、可用模型和剩余额度。

接入码保存在 DSH 凭据库中，引用名为 `GENYEE_KEYHUB_ACCESS_CODE`。headless 等没有凭据库的 profile 也可以用同名环境变量。

员工端在本机 `127.0.0.1` 上开一个端口（本机中转），DSH 的模型请求经它转发给管理端：

- **字段删除**：转发前删除请求体中所有 `dsh_` 开头的 DSH 扩展字段，以及设备匿名 ID 请求头。会话日志和插件清单不会离开员工电脑。
- **证书核对**：连接管理端时核对接入码中的证书指纹，不符即拒绝，不发送授权码。
- **端口与密钥固定**：端口由 DSH 数据目录推导，固定在 40000–49999 之间，被占用时改用随机端口；DSH 访问中转所用的密钥由接入码推导。因此重启后 DSH 的图片上传缓存仍然有效，更换接入码后缓存重新开始。

## 会话日志和插件清单上传

DSH 默认会在发往 DeepSeek 官方接口的请求中附带会话日志（`dsh_session_log`）和已启用插件清单（`dsh_plugin_packages`）。本插件**不改变**这两项设置，只保证 Genyee 路由上它们不会离开员工电脑（本机中转删除；管理端也会再删一次）。走员工自己 Key 的官方路由时，按 DSH 自身的开关处理：

| 上传项 | 开关 | 生效 |
|---|---|---|
| 会话日志 | DSH 设置 → 通用设置 → “在使用官方模型 API 时上传 Session Log” | 立即 |
| 插件清单 | profile 的 `cordis.patch.yml` 中加入下面的行 | 重启 DSH 后 |

公司要在所有员工电脑上统一关闭两项上传时，把下面两行加入员工 profile 的 `cordis.patch.yml`：

```yaml
- id: plugin-package-inventory-deepseek
  disabled: true

- id: session-log-deepseek
  config:
    enabled: false
```

## 配置

| 字段 | 模式 | 默认值 | 含义 |
|---|---|---|---|
| `role` | 两者 | 必填 | `admin` 或 `employee` |
| `listenHost` | admin | 必填 | 监听的具体 IP |
| `listenPort` | admin | `8443` | 监听端口 |
| `tlsCertFile` / `tlsKeyFile` | admin | — | PEM 证书和私钥 |
| `insecureHttp` | admin | `false` | 不用证书、明文 HTTP |
| `ledgerFile` | admin | 必填 | SQLite 账本，不存在时自动创建 |
| `timeZone` | admin | `Asia/Shanghai` | 额度周期使用的日历；启动时写入账本，命令行工具和管理页面都按它计算 |
| `defaultMaxConcurrency` | admin | `8` | 员工未单独设置时的并发上限 |
| `upstreamBaseURL` | admin | `https://api.deepseek.com/anthropic` | DeepSeek Anthropic 接口 |
| `upstreamReadTimeoutMs` | admin | `600000`（最小值） | 上游无数据等待上限 |
| `maxRequestBytes` | admin | 64 MiB | 请求体上限 |
| `balanceURL` | admin | `https://api.deepseek.com/user/balance` | 账号余额接口 |
| `balancePollMinutes` | admin | `10` | 余额查询间隔，`0` 关闭；失败时 1 分钟后重试 |
| `lowBalanceYuan` | admin | `50` | 余额低于此值（元）时在服务状态页和日志中提醒 |
| `accessCodeRef` | employee | `GENYEE_KEYHUB_ACCESS_CODE` | 存放接入码的凭据名 |
| `relayReadTimeoutMs` | employee | `660000` | 等待管理端数据的上限，应大于管理端的 `upstreamReadTimeoutMs` |
| `localProxyPort` | employee | `0` | 本机中转端口；`0` 表示由 DSH 数据目录推导出 40000–49999 中的固定端口 |
| `maxRequestBytes` | employee | 64 MiB | 本机中转读取单个模型请求的上限 |

## DSH 版本兼容

`engines.dsh` 为 `>=0.2.1-rc.1 <0.3.0`：0.2.1 的各个 rc、0.2.2 的 alpha 以及之后的 0.2.x 都会加载本插件。DSH 判断时包含预发布版本。

`pnpm test:compat` 列出 npm 上该范围内已发布的每个 `@deepseek-ai/dsh` 版本，逐个安装后跑一次 headless 端到端测试；DSH 发布新的 0.2.x 版本后运行它确认兼容。DSH 0.3 起需要重新适配，并在验证后放宽 `engines.dsh`。

## 测试

```sh
pnpm test         # 单元、转发、账本与管理接口测试，使用本地模拟的 DeepSeek
pnpm test:e2e     # 构建后用 npm 上的 dsh CLI 加载本插件，跑一次 headless 任务（TLS + 指纹核对）
pnpm test:real    # 用真实 DeepSeek API 测试转发（需要 DEEPSEEK_API_KEY 或仓库根目录 .env；会产生少量费用）
pnpm test:compat  # 对 engines.dsh 范围内每个已发布的 DSH 版本跑一次 headless 端到端测试
```

`pnpm build` 同时构建服务端（`lib/`）和浏览器端（`lib/client.js`，由 `scripts/build-client.mjs` 生成 DSH 客户端模块格式）。

## 已知限制

- 管理员的 DSH 必须开着，员工才能使用；管理端关闭时员工看到“无法连接管理端”。
- 同一版本号的 `.tgz` 重新安装时，pnpm 会沿用已安装的内容；替换为同版本的新构建前先 `dsh plugin --profile <profile> remove @genyee/dsh-keyhub`。
- 本机中转推导出的端口被其他程序占用时改用随机端口，那次运行中上传的图片在下次启动后会重新上传一次。
- 断开连接时的输出估算按实测的中文约 4.8 字节/token 取 4 字节/token，略高于实际。
- DSH 在额度用尽（402）等情况下会在界面上替换掉服务端的提示文字，本插件因此用 400 返回拒绝原因（见“转发时做什么”）。
