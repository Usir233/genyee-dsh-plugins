# @genyee/dsh-keyhub

Genyee 密钥中心：一个 DSH 插件，分管理员和员工两种模式。管理员的 DSH 保管公司 DeepSeek 账号下各部门的 API Key，在内网转发员工的模型请求，并按员工强制写入 DeepSeek 的 `metadata.user_id`。员工只持有管理员发放的接入码，拿不到真实 Key。设计依据见仓库根目录的 [GENYEE_KEYHUB_DIRECTION.md](../../GENYEE_KEYHUB_DIRECTION.md)。

当前进度：转发、两级金额额度、价格表、模型与并发限制已实现；数据存在管理员电脑上的 SQLite 账本中，暂时用命令行工具维护。管理界面尚未实现。

## 转发时做什么

每个发往 `/anthropic/v1/messages` 的请求，管理端依次：

1. 用请求头 `x-api-key` 中的授权码查账本；未知、员工停用或部门停用时返回 401，请求不发往 DeepSeek。
2. 依次检查：模型在员工的可用列表内（403）、该模型已设置价格（400）、员工同时进行的请求数未超上限（429）、员工额度和部门额度都有余额（402）。任一项不满足即拒绝，提示文字会显示在员工的 DSH 中。
3. 把请求体的 `metadata.user_id` 设为该员工的 `userId`，覆盖员工端传来的值；删除所有 `dsh_` 开头的 DSH 扩展字段（包括插件清单 `dsh_plugin_packages` 和会话日志 `dsh_session_log`）。
4. 把 `x-api-key` 换成该员工所属部门的 Key，删除 `x-deepseek-harness-user-id`（设备匿名 ID）。
5. 流式原样转发响应，包括 DeepSeek 排队时的 `: keep-alive` 注释；无数据等待上限默认 600 秒。
6. 从响应中读取用量，按请求完成时的价格折算金额，记入账本。

账本变化（包括命令行工具在 DSH 运行期间写入）约 1 秒内生效；被停用或重置授权码的员工，进行中的请求会立即中断。

## 安装

两种模式安装同一个包。组合包默认是员工模式，并把默认模型切换到 `genyee-keyhub` 路由；同时关闭插件清单和会话日志上传。

```sh
dsh plugin --profile <profile> add ./genyee-dsh-keyhub-<version>.tgz
```

### 管理员

1. 生成转发服务的证书（证书里写入管理员电脑的内网 IP）：

   ```sh
   node node_modules/@genyee/dsh-keyhub/lib/tools/admin-tools.js make-cert --ip 10.0.0.8 --out ~/.genyee-keyhub
   ```

2. 在管理员 profile 的 `cordis.patch.yml` 末尾**新增**一行管理员模式的插件行。组合包自带的员工行保持不变，管理员自己用 DSH 时也走本机转发，用量记在管理员自己的员工条目下：

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

   `listenHost` 必须是本机某个网卡的具体 IP，不接受 `0.0.0.0`。不配置证书时必须显式写 `insecureHttp: true`，此时授权码在内网明文传输。管理员也用下文的 `employee-add` 给自己建一个员工条目，并按“员工”一节保存自己的接入码。

3. 用命令行工具维护账本（下文 `T` 代表 `node node_modules/@genyee/dsh-keyhub/lib/tools/admin-tools.js`，`DB` 代表账本路径）。金额单位为元，价格单位为元/百万 token：

   ```sh
   T department --db DB --id rd --name 研发部 --key-ref GENYEE_DEEPSEEK_KEY_RD
   T price --db DB --model deepseek-flash --hit 0.2 --miss 2 --output 3
   T employee-add --db DB --name 张三 --department rd --relay https://10.0.0.8:8443 --cert ~/.genyee-keyhub/relay.crt
   T quota --db DB --department rd --amount 5000 --period month
   T quota --db DB --employee emp_xxx --amount 200 --period week
   T top-up --db DB --employee emp_xxx --amount 50 --note 项目加急
   T employee --db DB --user emp_xxx --models deepseek-flash --max-concurrency 4
   T employee --db DB --user emp_xxx --disable
   T employee --db DB --user emp_xxx --reset-token --relay https://10.0.0.8:8443 --cert ~/.genyee-keyhub/relay.crt
   T report --db DB
   ```

   - `--key-ref` 是凭据引用名；对应的 DeepSeek Key 存在管理员 DSH 的凭据库中（或管理员启动 DSH 的环境变量中），账本本身不含 Key。
   - `employee-add` 输出员工的接入码，只显示一次；账本只保存授权码的 SHA-256。
   - 额度周期为 `day`、`week`（周一起）、`month`、`year` 或 `total`（不重置），按 `timeZone` 的日历计算；修改额度从修改时刻起计算，不追溯之前的用量。追加额度只在当前周期有效，`total` 的追加永久有效。
   - 价格表里没有的模型会被拒绝；改价只影响之后完成的请求。

### 员工

把管理员给的接入码存为凭据 `GENYEE_KEYHUB_ACCESS_CODE`：在 DSH 的凭据文件（macOS `~/.dsh/.credentials.yaml`，Windows `%USERPROFILE%\.dsh\.credentials.yaml`）的 `refs` 下加一行，保存后自动生效；也可以用同名环境变量。

```yaml
version: 1
refs:
  GENYEE_KEYHUB_ACCESS_CODE: gkh1.eyJ1Ijoi…
```

员工端在本机 `127.0.0.1` 上开一个随机端口，DSH 的模型请求经它转发给管理端；连接管理端时核对接入码中的证书指纹，不符即拒绝，不发送授权码。

## 配置

| 字段 | 模式 | 默认值 | 含义 |
|---|---|---|---|
| `role` | 两者 | 必填 | `admin` 或 `employee` |
| `listenHost` | admin | 必填 | 监听的具体 IP |
| `listenPort` | admin | `8443` | 监听端口 |
| `tlsCertFile` / `tlsKeyFile` | admin | — | PEM 证书和私钥 |
| `insecureHttp` | admin | `false` | 不用证书、明文 HTTP |
| `ledgerFile` | admin | 必填 | SQLite 账本，不存在时自动创建 |
| `timeZone` | admin | `Asia/Shanghai` | 额度周期使用的日历 |
| `defaultMaxConcurrency` | admin | `8` | 员工未单独设置时的并发上限 |
| `upstreamBaseURL` | admin | `https://api.deepseek.com/anthropic` | DeepSeek Anthropic 接口 |
| `upstreamReadTimeoutMs` | admin | `600000`（最小值） | 上游无数据等待上限 |
| `maxRequestBytes` | admin | 64 MiB | 请求体上限 |
| `accessCodeRef` | employee | `GENYEE_KEYHUB_ACCESS_CODE` | 存放接入码的凭据名 |

## 测试

```sh
pnpm test        # 单元与转发测试，使用本地模拟的 DeepSeek
pnpm test:e2e    # 构建后用 npm 上的 dsh CLI 加载本插件，跑一次 headless 任务（TLS + 指纹核对）
```

## 已知限制

- Files API 请求会转发，但尚未记录文件归属，员工理论上可以引用同事上传的文件 id。
- 管理界面尚未实现；命令行工具需要管理员电脑上装有 Node.js 24 以上版本。
