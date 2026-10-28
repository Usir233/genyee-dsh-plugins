# 桌面端验证清单（Windows / macOS）

本清单用于在真实的 DSH 桌面端上完成方向文档 §6 中云端环境做不了的验证：V1、V3、V6、V9、V10，以及停用后中断的行为。需要两台在同一内网的电脑：一台做**管理员**，一台做**员工**。两台都可以是 Windows 或 macOS。

每一步后面的 **【记录】** 是需要你发回给我的内容。遇到任何一步和描述不一致，停下来，把截图和报错原文发给我即可。

## 准备

| 项目 | 管理员电脑 | 员工电脑 |
|---|---|---|
| DSH 桌面端 | `0.2.2-alpha.2` | `0.2.2-alpha.2` |
| 插件包 | `genyee-dsh-keyhub-0.1.0.tgz` | 同左 |
| Node.js 24 以上 | 需要（运行管理工具；管理界面完成后不再需要） | 不需要 |
| DeepSeek Key | 一个测试用 Key，账户里留少量余额 | 不需要 |

下文路径中，`<DSH>` 表示 DSH 的数据目录：macOS 为 `~/.dsh`，Windows 为 `%USERPROFILE%\.dsh`（例如 `C:\Users\张三\.dsh`）。YAML 文件里的 Windows 路径请用正斜杠，例如 `C:/Users/张三/keyhub/relay.crt`。

## 一、管理员电脑

**1. 安装插件（V6）**

打开 DSH →左侧**插件** → **添加插件**，输入 `.tgz` 文件的绝对路径（例如 `C:/Users/admin/Downloads/genyee-dsh-keyhub-0.1.0.tgz`），点击**安装**。

【记录】是否安装成功；插件列表里是否出现 `@genyee/dsh-keyhub`。

**2. 查本机内网 IP**

- Windows：命令提示符执行 `ipconfig`，看"IPv4 地址"。
- macOS：终端执行 `ipconfig getifaddr en0`（有线网络可能是 `en1`）。

下文用 `10.0.0.8` 代指这个 IP，请替换成实际值。

**3. 生成证书**

新建一个文件夹（例如 `C:/Users/admin/keyhub` 或 `~/keyhub`），在终端执行（`T` 代表 `node <DSH>/profiles/desktop/node_modules/@genyee/dsh-keyhub/lib/tools/admin-tools.js`）：

```sh
T make-cert --ip 10.0.0.8 --out ~/keyhub
```

【记录】输出的 `fingerprint` 一行。

**4. 保存 DeepSeek Key**

用文本编辑器打开 `<DSH>/.credentials.yaml`（没有就新建），在 `refs` 下加一行：

```yaml
version: 1
refs:
  GENYEE_DEEPSEEK_KEY_RD: sk-你的测试Key
```

如果文件里已经有 `version` 和 `refs`，只加 `GENYEE_DEEPSEEK_KEY_RD` 这一行。

**5. 建账本**

```sh
T department --db ~/keyhub/ledger.db --id rd --name 研发部 --key-ref GENYEE_DEEPSEEK_KEY_RD
T price --db ~/keyhub/ledger.db --model deepseek-flash --hit 0.2 --miss 2 --output 3
T price --db ~/keyhub/ledger.db --model deepseek-v4-pro --hit 1 --miss 4 --output 16
T employee-add --db ~/keyhub/ledger.db --name 管理员 --department rd --relay https://10.0.0.8:8443 --cert ~/keyhub/relay.crt
T employee-add --db ~/keyhub/ledger.db --name 测试员工 --department rd --relay https://10.0.0.8:8443 --cert ~/keyhub/relay.crt
```

价格只是测试用的示例值，正式使用前按 DeepSeek 官网价格修改。两个 `employee-add` 各输出一个以 `gkh1.` 开头的接入码，分别保存好。

**6. 打开管理员模式**

打开 `<DSH>/profiles/desktop/cordis.patch.yml`，在文件末尾追加（路径换成实际值；如果文件内容只有 `[]`，先删掉 `[]`）：

```yaml
- insert:
    - id: genyee-keyhub-admin
      name: '@genyee/dsh-keyhub'
      config:
        role: admin
        listenHost: 10.0.0.8
        listenPort: 8443
        tlsCertFile: C:/Users/admin/keyhub/relay.crt
        tlsKeyFile: C:/Users/admin/keyhub/relay.key
        ledgerFile: C:/Users/admin/keyhub/ledger.db
```

再在 `<DSH>/.credentials.yaml` 的 `refs` 下加入管理员自己的接入码：

```yaml
  GENYEE_KEYHUB_ACCESS_CODE: gkh1.（第 5 步"管理员"那个接入码）
```

完全退出并重新打开 DSH。

- Windows 可能弹出防火墙提示，请选择**允许**（至少勾选"专用网络"）。
- macOS 可能询问是否允许 DSH 接受传入连接，请选择**允许**。

【记录】是否弹出防火墙提示、选择了什么。

**7. 管理员自己对话（V3、V10）**

新建对话，确认模型选择器里是 **Genyee** 路由下的 deepseek-flash（不是的话手动切换），发送"用一句话介绍你自己"。

【记录】是否正常回复；如果报错，报错原文。然后执行：

```sh
T report --db ~/keyhub/ledger.db
```

【记录】`report` 的完整输出（应能看到"管理员"本月的次数和金额）。

## 二、员工电脑

**8. 安装插件**

同第 1 步。

**9. 填写接入码**

在员工电脑的 `<DSH>/.credentials.yaml` 的 `refs` 下加入第 5 步"测试员工"的接入码：

```yaml
version: 1
refs:
  GENYEE_KEYHUB_ACCESS_CODE: gkh1.（测试员工的接入码）
```

完全退出并重新打开 DSH。

**10. 员工对话（V1）**

新建对话，发送"你好"。如果模型选择器里当前不是 **Genyee** 路由（以前选过别的模型时会这样），先切换到 Genyee 下的 deepseek-flash。

【记录】是否正常回复；模型选择器里 Genyee 路由的显示名称。能回复就说明管理员电脑的转发端口在内网可以访问（V1）。

## 三、管控行为（V9 与中断）

以下命令都在**管理员电脑**上执行，员工电脑的 DSH 保持打开。先查测试员工的 `userId`：执行 `T report --db ~/keyhub/ledger.db`，测试员工那一行中 `emp_` 开头的就是，下文写作 `emp_xxx`。

**11. 额度用完的提示**

```sh
T quota --db ~/keyhub/ledger.db --employee emp_xxx --amount 0.000001 --period month
```

员工发一条消息（第一条可能还会成功，因为额度检查看的是请求前的已用金额），再发第二条。

【记录】员工界面显示的报错原文（期望包含"本月额度已用完"）。然后恢复：

```sh
T quota --db ~/keyhub/ledger.db --employee emp_xxx --clear
```

**12. 模型限制的提示**

```sh
T employee --db ~/keyhub/ledger.db --user emp_xxx --models deepseek-v4-pro
```

员工用默认模型（deepseek-flash）发消息。

【记录】员工界面显示的报错原文（期望包含"没有使用模型 deepseek-flash 的权限"）。然后恢复：

```sh
T employee --db ~/keyhub/ledger.db --user emp_xxx --all-models
```

**13. 停用后立即中断**

员工发送"写一篇 2000 字的文章介绍长城"，在回复还在输出时，管理员执行：

```sh
T employee --db ~/keyhub/ledger.db --user emp_xxx --disable
```

【记录】员工的回复是否在约 1 秒内停止、显示了什么；再发一条消息时显示了什么（期望包含"授权码无效或已被管理员停用"）。然后恢复：

```sh
T employee --db ~/keyhub/ledger.db --user emp_xxx --enable
```

**14. 管理员关闭 DSH**

管理员退出 DSH，员工发一条消息。

【记录】员工界面显示的报错原文（期望包含"无法连接管理端"和"请确认管理员的 DSH 已打开"）。

## 四、发回给我

把每一步的【记录】按编号发给我即可，截图优先。第 7 步的 `report` 输出请贴文字。
