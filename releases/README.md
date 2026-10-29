# 插件安装包

每个版本的 `.tgz` 可直接在 DSH 的**插件 → 添加插件**中填入本地绝对路径安装，或执行 `dsh plugin --profile <profile> add <路径>`。安装时需要能访问 npm 源，用于下载插件的少量依赖。

| 包 | 版本 | 文件 | SHA-256 | 适用 DSH | 说明 |
|---|---|---|---|---|---|
| `@genyee/dsh-keyhub` | 0.2.1 | [genyee-dsh-keyhub-0.2.1.tgz](keyhub/genyee-dsh-keyhub-0.2.1.tgz) | `e52f366fcb7f6a00e4fc9300fce60fc92a4d0952c4a8cd7df54bf20df2d87960` | `>=0.2.1-rc.1 <0.3.0` | 不再全局关闭会话日志和插件清单上传，Genyee 路由上由员工本机中转删除；本机中转端口和密钥固定，图片上传缓存跨重启有效；支持 DSH 0.2.1-rc.1 起的 0.2.x（0.2.1-rc.1～rc.5、0.2.2-alpha.2 均已跑 headless 端到端测试，0.2.1-rc.2 另经 Web 实测） |
| `@genyee/dsh-keyhub` | 0.2.0 | [genyee-dsh-keyhub-0.2.0.tgz](keyhub/genyee-dsh-keyhub-0.2.0.tgz) | `47cea6d821727c973342ec650b574161f9f136c8b6b00cf5cc524be1f43fd4d2` | `0.2.2-alpha.2` | 管理页面与员工设置；额度预留、断开计费估算、Files 归属、账号余额、用量导出；拒绝原因原样显示给员工；经真实 DeepSeek API、本机两个 DSH Web 实例和源码运行的桌面端验证；两台电脑之间的网络与防火墙待实测 |
| `@genyee/dsh-keyhub` | 0.1.0 | [genyee-dsh-keyhub-0.1.0.tgz](keyhub/genyee-dsh-keyhub-0.1.0.tgz) | `1238fa8002e04232db815941a5b6ea8c652b9423e051b17d273b95c80dc01c19` | `0.2.2-alpha.2` | 转发、两级金额额度、价格、模型与并发限制；命令行管理工具；尚无管理界面；未经真实 DeepSeek API 和桌面端验证 |
