# Genyee 密钥中心使用说明

`@genyee/dsh-keyhub` 是一个 DeepSeek Harness（DSH）插件，让公司在不把 DeepSeek Key 发给员工的前提下统一提供模型。管理员的 DSH 保管各部门的 Key，并在内网转发员工的请求：员工的每个请求都带上自己的 `user_id`，按金额额度计费，管理员随时可以停用。

本文面向管理员和员工。实现细节见 [packages/keyhub/README.md](packages/keyhub/README.md)，设计依据见 [GENYEE_KEYHUB_DIRECTION.md](GENYEE_KEYHUB_DIRECTION.md)。

## 目录

- [工作方式](#工作方式)
- [准备](#准备)
- [管理员：首次配置](#管理员首次配置)
- [员工：开始使用](#员工开始使用)
- [日常管理](#日常管理)
- [常见提示与处理](#常见提示与处理)
- [DSH 版本与隐私设置](#dsh-版本与隐私设置)
- [升级、备份与迁移](#升级备份与迁移)
- [命令行工具](#命令行工具)
- [开发者](#开发者)

## 工作方式

```
员工的 DSH ──(内网 HTTPS，校验证书指纹)──▶ 管理员的 DSH ──▶ api.deepseek.com
  只持有接入码                              保管部门 Key、校验额度、记账
```

- 管理员和员工安装**同一个插件包**；管理员多加一行配置即进入管理员模式。
- 员工只拿到**接入码**（`gkh1.` 开头），其中包含管理端地址、证书指纹和授权码。接入码可以随时停用或重置，不能用来直接调用 DeepSeek。
- 管理员的 DSH 必须开着，员工才能使用。

## 准备

| 项目 | 管理员电脑 | 员工电脑 |
|---|---|---|
| DSH 桌面端 | 0.2.x，从 `0.2.1-rc.1` 起 | 同左 |
| 插件包 | `releases/keyhub/genyee-dsh-keyhub-0.2.1.tgz` | 同左 |
| Node.js 24 以上 | 需要（生成证书时用一次） | 不需要 |
| DeepSeek Key | 公司账号下每个部门一个 | 不需要 |
| 网络 | 一个固定的内网 IP，员工能访问它的 8443 端口 | 能访问管理员电脑 |

下文用 `<DSH>` 表示 DSH 数据目录：macOS 为 `~/.dsh`，Windows 为 `%USERPROFILE%\.dsh`。桌面端的插件配置在 `<DSH>/profiles/desktop/` 下。

## 管理员：首次配置

### 1. 安装插件

打开 DSH → 左侧**插件** → **添加插件**，填入 `.tgz` 文件的绝对路径，点击**安装**，然后点击**立即启用**。

### 2. 生成证书

查出本机内网 IP：Windows 执行 `ipconfig`，macOS 执行 `ipconfig getifaddr en0`。下文用 `10.0.0.8` 代替，请换成实际值。

```sh
node <DSH>/profiles/desktop/node_modules/@genyee/dsh-keyhub/lib/tools/admin-tools.js make-cert --ip 10.0.0.8 --out ~/keyhub
```

命令会生成 `relay.crt` 和 `relay.key`。证书只写入这个 IP，IP 变了需要重新生成证书，并给员工重新发放接入码。

### 3. 打开管理员模式

在 `<DSH>/profiles/desktop/cordis.patch.yml` 末尾追加下面的内容，路径换成实际值。如果文件里只有 `[]`，先删掉它。Windows 路径用正斜杠，例如 `C:/Users/admin/keyhub/relay.crt`。

```yaml
- insert:
    - id: genyee-keyhub-admin
      name: '@genyee/dsh-keyhub'
      config:
        role: admin
        listenHost: 10.0.0.8
        listenPort: 8443
        tlsCertFile: /Users/admin/keyhub/relay.crt
        tlsKeyFile: /Users/admin/keyhub/relay.key
        ledgerFile: /Users/admin/keyhub/ledger.db
```

完全退出并重新打开 DSH。如果系统询问是否允许接受网络连接，选择**允许**（Windows 至少勾选“专用网络”）。左侧栏出现 **Genyee 密钥中心** 即表示成功。

### 4. 在管理页面完成配置

打开左侧栏 **Genyee 密钥中心**，按顺序操作：

1. **部门**：新增部门（例如 ID `rd`、名称“研发部”）。点**设置 Key**，粘贴该部门的 DeepSeek Key，状态变为“已配置”。
2. **价格**：按 DeepSeek 官网价格，为每个要开放的模型填写三项价格：输入缓存命中、输入缓存未命中、输出，单位为元/百万 token。**没有价格的模型员工无法使用。**
3. **员工**：新增员工，弹出的接入码**只显示这一次**，复制后安全地交给员工。管理员也要给自己建一条员工记录。
4. **额度**（可选）：为部门或员工设置每日、每周、每月、每年或总额度。
5. **服务状态**：点**查询余额**，确认能查到公司账号余额。

最后在 **设置 → Genyee 密钥中心** 中粘贴管理员自己的接入码，管理员就可以和员工一样对话了，用量记在自己名下。

## 员工：开始使用

1. 按管理员第 1 步安装插件。
2. 打开 **设置 → Genyee 密钥中心**，粘贴管理员给的接入码，点**保存接入码**。
3. 状态显示 **已连接管理端**，并列出姓名、部门、可用模型和剩余额度。
4. 新建对话，在模型选择器中选择 **Genyee** 下的模型即可使用。

更换电脑或接入码被重置时，重复第 2 步。

## 日常管理

所有操作都在管理页面完成，约 1 秒内生效。

| 要做的事 | 位置 | 说明 |
|---|---|---|
| 停用员工 | 员工 → 停用 | 下一个请求即被拒绝，正在输出的回复立即中断 |
| 员工丢失或泄露接入码 | 员工 → 重置接入码 | 旧码立即失效，新码只显示一次 |
| 调整部门、可用模型、并发上限 | 员工 → 编辑 | 员工换部门后，已用金额留在原部门 |
| 设置额度 | 额度 → 设置额度 | 只改金额不影响本周期已用；改周期则从现在重新计算 |
| 临时追加额度 | 额度 → 追加额度 | 只在当前周期有效；“总额度”的追加永久有效 |
| 停用整个部门 | 部门 → 停用 | 该部门所有员工立即不可用 |
| 更换部门 Key | 部门 → 设置 Key | 新请求立即使用新 Key |
| 修改价格 | 价格 → 编辑 | 只影响之后完成的请求，已有记录不变 |
| 下架模型 | 价格 → 删除 | 没有价格的模型会被拒绝 |
| 查看和导出用量 | 用量 | 按日期查看部门和员工的金额与 token；导出 CSV 可直接用 Excel 打开 |
| 账号余额 | 服务状态 | 每 10 分钟自动查询；低于 ¥50 时提示，可在配置中调整 |

关于计费：

- 金额按管理员填写的价格折算，与 DeepSeek 账单可能有小差异，请每月与官方账单核对总数。
- 员工中途停止生成时，已输出的部分按估算计费，用量记录中标为“估算”。
- 不同员工之间不共享 DeepSeek 的上下文缓存；同一员工的多轮对话正常命中缓存。

## 常见提示与处理

员工界面看到的提示：

| 提示 | 原因 | 处理 |
|---|---|---|
| 尚未填写 Genyee 接入码 | 没有保存接入码 | 在设置中粘贴接入码 |
| 授权码无效或已被管理员停用 | 员工或部门被停用，或接入码已被重置 | 联系管理员 |
| 你的本月额度已用完（已用 ¥…，额度 ¥…） | 员工或部门额度用完 | 管理员追加或调整额度 |
| 你没有使用模型 … 的权限 | 该模型不在员工的可用列表中 | 换模型，或请管理员开放 |
| 管理员尚未设置模型 … 的价格 | 价格表里没有该模型 | 管理员在“价格”中补充 |
| 管理端尚未配置部门“…”的 DeepSeek Key | 部门没有 Key | 管理员在“部门”中设置 Key |
| 无法连接管理端 …；请确认管理员的 DSH 已打开 | 管理员电脑关机、DSH 未打开、IP 变化或被防火墙拦截 | 确认管理员 DSH 已打开；IP 变化时管理员需重新生成证书和接入码 |
| 管理端的证书与接入码不符 | 管理端更换了证书，或连接到了冒充的地址 | 向管理员索取新的接入码 |
| 你同时进行的请求已达上限 | 并发超过限制 | 稍等，DSH 会自动重试 |

管理员启动时的问题：

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件报错 `listenHost … is not an address of this machine` | 本机 IP 变了 | 修改 `listenHost`，重新生成证书和接入码 |
| 插件报错 `set tlsCertFile and tlsKeyFile` | 缺少证书配置 | 检查第 3 步的路径 |
| 服务状态显示“没有已配置 Key 的启用部门” | 没有启用的部门设置了 Key，或 DSH 刚启动 | 设置部门 Key；刚启动时 1 分钟内会自动重试 |
| 员工电脑连不上 | 防火墙拦截 8443 端口 | 在系统防火墙中允许 DSH 接受连接 |

## DSH 版本与隐私设置

**DSH 版本**：插件支持 DSH `0.2.1-rc.1` 起的所有 0.2.x 版本（包括正式版、rc 和 alpha）。DSH 在 0.2.x 内升级时不用更换插件。DSH 升到 0.3 后，需要等插件发布新版本才能继续使用 Genyee 路由；此时插件会被 DSH 跳过，员工看不到 Genyee 模型。

**会话日志和插件清单**：DSH 默认会随发往 DeepSeek 官方接口的请求上传会话日志和已启用插件清单。走 Genyee 路由时，这两项在员工电脑上就被删除，不会经过管理员电脑，也不会到达 DeepSeek。员工用自己的 Key 走官方路由时，按 DSH 自己的开关处理：

- 会话日志：设置 → 通用设置 → “在使用官方模型 API 时上传 Session Log”，立即生效。
- 插件清单：没有界面开关，需要在 `cordis.patch.yml` 中关闭，重启后生效。

公司要统一关闭这两项上传，在每台员工电脑的 `<DSH>/profiles/desktop/cordis.patch.yml` 末尾加入：

```yaml
- id: plugin-package-inventory-deepseek
  disabled: true

- id: session-log-deepseek
  config:
    enabled: false
```

## 升级、备份与迁移

**升级插件**：在插件页卸载旧版本后安装新版本的 `.tgz`，例如从 0.2.0 升到 0.2.1。同一版本号的包重新安装不会替换文件，必须先卸载。账本会自动升级格式；降级到旧版本的插件不能读取新格式的账本。

**备份**：定期备份以下三类文件。

- `ledgerFile` 指向的 `ledger.db`（部门、员工、额度、价格、用量）
- `<DSH>/.credentials.yaml`（部门 Key；请妥善保管）
- `relay.crt` 和 `relay.key`

**迁移到新电脑**：把这三类文件拷到新电脑，按“管理员：首次配置”第 1、3 步安装和配置，并把 `listenHost` 改成新电脑的 IP。如果 IP 变了，需要重新生成证书并给所有员工重置接入码。

## 命令行工具

管理页面的操作也可以用命令行完成，例如批量处理。DSH 运行期间写入同样约 1 秒内生效。下文 `T` 代表 `node <DSH>/profiles/desktop/node_modules/@genyee/dsh-keyhub/lib/tools/admin-tools.js`，`DB` 代表账本路径。

```sh
T department --db DB --id rd --name 研发部 --key-ref GENYEE_DEEPSEEK_KEY_RD
T price --db DB --model deepseek-flash --hit 0.2 --miss 2 --output 3
T employee-add --db DB --name 张三 --department rd --relay https://10.0.0.8:8443 --cert ~/keyhub/relay.crt
T quota --db DB --employee emp_xxx --amount 200 --period month
T top-up --db DB --employee emp_xxx --amount 50 --note 项目加急
T employee --db DB --user emp_xxx --disable
T employee --db DB --user emp_xxx --reset-token --relay https://10.0.0.8:8443 --cert ~/keyhub/relay.crt
T report --db DB
T export --db DB --from 2026-10-01 --to 2026-11-01 --out usage.csv
```

所有配置项见 [packages/keyhub/README.md 的“配置”一节](packages/keyhub/README.md#配置)。

## 开发者

```sh
pnpm install
cd packages/keyhub
pnpm run build        # 构建服务端和浏览器端，输出到 lib/
pnpm test             # 单元、转发、账本和管理接口测试（模拟 DeepSeek）
pnpm run test:e2e     # 用 npm 上的 dsh CLI 加载插件，跑一次 headless 任务
pnpm run test:real    # 用真实 DeepSeek API 测试，需要 DEEPSEEK_API_KEY 或仓库根目录的 .env，会产生少量费用
pnpm run test:compat  # 对支持范围内每个已发布的 DSH 版本跑一次 headless 端到端测试
pnpm pack --pack-destination ../../releases/keyhub   # 生成安装包
```

在两台电脑之间验证的步骤见 [docs/desktop-verification.md](docs/desktop-verification.md)。
