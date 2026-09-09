# DarkPaper2022 fork

维护仓库：https://github.com/DarkPaper2022/harness-remote
上游：https://github.com/giuliastro/harness-remote

本 fork 在上游基础上维护以下改动：

- 项目标题旁提供“＋ 新建会话”，固定该机器和项目，复用原生创建流程；机器离线时禁止创建且不会误选其他项目。

- 外部 Codex 会话的模型、命令和操作列表查询不再调用 session/load，避免手机查看活动会话时触发 active writer 错误。历史仍读取原生日志，主动接续仍需取得原生写锁。
- 服务专用 Codex 包装器沿用 API key、禁止自动弹出 OAuth 浏览器，并使用主机 Codex CLI。

`origin` 指向本 fork，`upstream` 指向原仓库。`darkpaper` 是本 fork 的默认维护分支，`main` 保留上游版本。维护分支初始基线为 `78b0e1394883b0197b27354bddf003cf3f8deaf6`，不自动升级运行中的服务。日常开发推送 origin/darkpaper；同步前保持工作区干净，然后：

```sh
git fetch upstream
git merge upstream/main
node --test bridge/test/server.test.js bridge/test/codex-session-history.test.js
git push origin darkpaper
```

同步时重点核对外部会话只读元数据标记、适配器 NO_BROWSER/CODEX_PATH 行为及固定版本兼容性。不要用强制推送覆盖已发布改动。本机部署配置与运维文档仅保存在本地，不进入 Git；运行中服务的重启应另行执行。

项目快捷创建的浏览器验收：在 web 中安装与上游 CI 相同的 Playwright 测试工具后，运行 `node scripts/project-session-create-smoke.mjs`。可通过 CHROMIUM_EXECUTABLE 指定已有 Chromium。脚本使用模拟机器，覆盖手机/桌面视口、项目预选、错误重试和离线保护；不会访问真实会话。
