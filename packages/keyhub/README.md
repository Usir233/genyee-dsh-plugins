# @genyee/dsh-keyhub

Genyee 密钥中心：一个 DSH 插件，分管理员和员工两种模式。管理员的 DSH 保管公司 DeepSeek 账号下各部门的 API Key，在内网转发员工的模型请求，并按员工强制写入 DeepSeek 的 `metadata.user_id`。员工只持有管理员发放的接入码，拿不到真实 Key。设计依据见仓库根目录的 [GENYEE_KEYHUB_DIRECTION.md](../../GENYEE_KEYHUB_DIRECTION.md)。

当前进度：M1（转发闭环）。员工表用 YAML 文件维护；额度、价格表和管理界面属于 M2，尚未实现。

## 转发时做什么

每个发往 `/anthropic/v1/messages` 的请求，管理端依次：

1. 用请求头 `x-api-key` 中的授权码查员工表；未知、员工停用或部门停用时返回 401，请求不发往 DeepSeek。
2. 把请求体的 `metadata.user_id` 设为该员工的 `userId`，覆盖员工端传来的值；删除所有 `dsh_` 开头的 DSH 扩展字段（包括插件清单 `dsh_plugin_packages` 和会话日志 `dsh_session_log`）。
3. 把 `x-api-key` 换成该员工所属部门的 Key，删除 `x-deepseek-harness-user-id`（设备匿名 ID）。
4. 流式原样转发响应，包括 DeepSeek 排队时的 `: keep-alive` 注释；无数据等待上限默认 600 秒。
5. 从响应中读取用量，每个请求向用量日志追加一行 JSON。

员工文件变化后约 1 秒内生效；被停用员工进行中的请求会立即中断。

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

2. 写员工表 `~/.genyee-keyhub/directory.yml`：

   ```yaml
   departments:
     - { id: rd, name: 研发部, keyRef: GENYEE_DEEPSEEK_KEY_RD }
   employees: []
   ```

   `keyRef` 是凭据引用名；对应的 DeepSeek Key 存在管理员 DSH 的凭据库中（或管理员启动 DSH 的环境变量中），员工表本身不含 Key。部门或员工可加 `enabled: false` 停用。

3. 在管理员 profile 的 `cordis.patch.yml` 中把插件行改为管理员模式：

   ```yaml
   - id: genyee-keyhub
     config:
       role: admin
       listenHost: 10.0.0.8
       listenPort: 8443
       tlsCertFile: /home/admin/.genyee-keyhub/relay.crt
       tlsKeyFile: /home/admin/.genyee-keyhub/relay.key
       directoryFile: /home/admin/.genyee-keyhub/directory.yml
       usageLogFile: /home/admin/.genyee-keyhub/usage.jsonl
   ```

   `listenHost` 必须是本机某个网卡的具体 IP，不接受 `0.0.0.0`。不配置证书时必须显式写 `insecureHttp: true`，此时授权码在内网明文传输。

4. 为每名员工生成员工表条目和接入码：

   ```sh
   node node_modules/@genyee/dsh-keyhub/lib/tools/admin-tools.js issue \
     --relay https://10.0.0.8:8443 --cert ~/.genyee-keyhub/relay.crt --name 张三 --department rd
   ```

   把输出的条目加入 `employees`，把接入码交给员工。接入码只显示一次；员工表只保存授权码的 SHA-256。

### 员工

把管理员给的接入码存为凭据 `GENYEE_KEYHUB_ACCESS_CODE`（或同名环境变量）。员工端在本机 `127.0.0.1` 上开一个随机端口，DSH 的模型请求经它转发给管理端；连接管理端时核对接入码中的证书指纹，不符即拒绝，不发送授权码。

## 配置

| 字段 | 模式 | 默认值 | 含义 |
|---|---|---|---|
| `role` | 两者 | 必填 | `admin` 或 `employee` |
| `listenHost` | admin | 必填 | 监听的具体 IP |
| `listenPort` | admin | `8443` | 监听端口 |
| `tlsCertFile` / `tlsKeyFile` | admin | — | PEM 证书和私钥 |
| `insecureHttp` | admin | `false` | 不用证书、明文 HTTP |
| `directoryFile` | admin | 必填 | 员工表 YAML |
| `usageLogFile` | admin | 必填 | 用量日志（JSON Lines） |
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
- 管理员自己使用 DSH 时还没有走本机转发（方向文档 D9）。
