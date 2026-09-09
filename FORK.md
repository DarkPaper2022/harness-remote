# DarkPaper2022 fork

维护仓库：https://github.com/DarkPaper2022/harness-remote
上游：https://github.com/giuliastro/harness-remote

本 fork 在上游基础上维护以下改动：

- 项目标题旁提供“＋ 新建会话”，固定该机器和项目，复用原生创建流程；机器离线时禁止创建且不会误选其他项目。
- Codex 会话标题栏提供“释放会话”：空闲时确认释放并返回列表，随后可在 PC 执行 `codex resume <session-id>`。历史记录保留；再次在手机打开会话会尝试重新取得写权。运行或发送中的会话需先停止并等待结束。

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

释放会话通过已认证的 `POST /v1/agents/codex/session/:id/release` 实现，目前支持 Linux/macOS 服务端。Codex CLI 0.153.4 的 `thread/unsubscribe` 会延迟约 30 分钟卸载，因此 daemon 为每个打开的 Codex 会话维护独立适配器进程组，释放时等待该组退出；其他会话继续运行。相应代价是每个打开的会话有独立进程开销，闲置后可主动释放。Windows 保留原适配器模式，释放接口明确返回不支持。模型目录查询继续使用独立的技术会话。

相关回归测试在 `bridge/test/session-acp-client.test.js`、`bridge/test/acp-process-group.test.js`、`bridge/test/acp-session-claim.test.js` 和 HTTP daemon 测试中。浏览器验收在 web 目录运行 `node scripts/session-release-smoke.mjs`。进程组测试只操作自身创建的进程；真实 Codex 验收应使用专用测试会话，验证第二客户端在释放前冲突、释放后立即恢复。
