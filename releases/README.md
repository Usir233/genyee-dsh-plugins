# 插件安装包

每个版本的 `.tgz` 可直接在 DSH 的**插件 → 添加插件**中填入本地绝对路径安装，或执行 `dsh plugin --profile <profile> add <路径>`。安装时需要能访问 npm 源，用于下载插件的少量依赖。

| 包 | 版本 | 文件 | SHA-256 | 适用 DSH | 说明 |
|---|---|---|---|---|---|
| `@genyee/dsh-keyhub` | 0.1.0 | [genyee-dsh-keyhub-0.1.0.tgz](keyhub/genyee-dsh-keyhub-0.1.0.tgz) | `1238fa8002e04232db815941a5b6ea8c652b9423e051b17d273b95c80dc01c19` | `0.2.2-alpha.2` | 转发、两级金额额度、价格、模型与并发限制；命令行管理工具；尚无管理界面；未经真实 DeepSeek API 和桌面端验证 |
