# DarkPaper2022 fork

维护仓库：https://github.com/DarkPaper2022/harness-remote
上游：https://github.com/giuliastro/harness-remote

本 fork 在上游基础上维护以下改动：

- 项目标题旁提供“＋ 新建会话”，固定该机器和项目，复用原生创建流程；机器离线时禁止创建且不会误选其他项目。
- 会话消息区提供刷新按钮，生成回复时也能手动补取最新消息；保留已加载的旧分页、草稿和阅读位置，显示刷新结果。手动请求不会被实时事件合并丢弃，应用从后台恢复时也会立即补取。刷新走已有只读消息接口，不重新 claim、replay 或发送提示词。
- Codex 会话标题栏提供“释放会话”：空闲时确认释放并返回列表，随后可在 PC 执行 `codex resume <session-id>`。历史记录保留；再次在手机打开会话会尝试重新取得写权。运行或发送中的会话需先停止并等待结束。

- 外部 Codex 会话的模型、命令和操作列表查询不再调用 session/load，避免手机查看活动会话时触发 active writer 错误。历史仍读取原生日志，主动接续仍需取得原生写锁。
- 服务专用 Codex 包装器沿用 API key、禁止自动弹出 OAuth 浏览器，并使用主机 Codex CLI。
- Android 下载构建强制使用本 fork 的固定 release keystore；私钥与口令只保存在 GitHub Actions Secrets 及本机私有备份，不进入 Git。由 `web/package.json` 推导 `versionCode`，每次 Android 发布都要递增版本。
- 项目目录与会话列表按需发现：不再依赖 `HARNESS_REMOTE_ROOT` 指向的容器目录；daemon 从各 harness 已上报会话的工作目录动态生成项目与目录边界，并默认只列出最近 7 天有活动的会话。Codex 列表直接读取本地 `state_*.sqlite` 索引，启动列会话从约 6.8s 降到约 10ms。

`origin` 指向本 fork，`upstream` 指向原仓库。`darkpaper` 是本 fork 的默认维护分支，`main` 保留上游版本。维护分支初始基线为 `78b0e1394883b0197b27354bddf003cf3f8deaf6`，不自动升级运行中的服务。日常开发推送 origin/darkpaper；同步前保持工作区干净，然后：

```sh
git fetch upstream
git merge upstream/main
node --test bridge/test/server.test.js bridge/test/codex-session-history.test.js
git push origin darkpaper
```

同步时重点核对外部会话只读元数据标记、适配器 NO_BROWSER/CODEX_PATH 行为及固定版本兼容性。不要用强制推送覆盖已发布改动。本机部署配置与运维文档仅保存在本地，不进入 Git；运行中服务的重启应另行执行。

## 项目发现、目录边界与最近会话窗口

上游要求用 `--root` 指定项目目录边界，并把配置的根目录本身当作项目。当根目录是 `~/Documents` 这类容器时，前端会按路径前缀把所有子目录折叠成同一个 “Documents” 项目，无法区分真实仓库。

本 fork 的 daemon 改为从各 harness 已上报会话的 `cwd` 学习项目根：先 `realpath`，再向上找到最近的 `.git` 目录作为仓库根，否则使用该目录本身；同时把这些目录并入 `/path`、`/file`、新建会话的目录边界。因此 `HARNESS_REMOTE_ROOT` 不再是必需的（配置后仍按上游语义作为“配置根”参与项目列表，但不要指向容器目录）。单一 harness 的 `bridge/src/cli.js` 也采用同样的学习逻辑。

会话列表默认只包含最近 7 天内有活动的会话（按 harness 时间戳；PI 适配器缺失 `updatedAt` 时用日志文件 `mtime` 回填）。可用 `--session-days <n>` 或 `HARNESS_REMOTE_SESSION_DAYS` 调整，`0` 表示全部；单次请求可用 `?days=<n>` 或 `?all=1` 覆盖，非法取值返回 400。原生列表页按 `cursor + 时间窗口` 做单飞合并并缓存约 3 秒，写操作会立即失效缓存，因此删除、改名或新建会话在下次读取时即可见。

Codex 的 `thread/list` 需要扫描约 500MB 的 `thread_history_1.sqlite`，是启动卡顿的主因。本 fork 在 `bridge/src/codex-session-history.js` 中通过受保护的动态 `import("node:sqlite")` 直接查询 `state_<n>.sqlite` 的 `threads` 表（要求 Node 22.5+），失败或遇到未知游标时自动回退到 ACP。分页游标格式为 `codex-created:<created_at_ms>:<session_id>`，以 ID 打破时间戳相同的分页边界，并兼容旧的时间戳游标。

历史搜索会读取所有结果分页（包括过滤后的空页），与默认 7 天浏览窗口独立；没有近期会话时仍显示搜索框。机器轮询不会取消正在进行的搜索，失败时显示错误并支持重试。列表缓存以窗口长度为键并限制容量，写操作开始和完成都会失效缓存，失效前发起的读取不能回写旧结果。

iOS 发布时由 `web/package.json` 设置 IPA 内部 `CFBundleShortVersionString`，以 Actions 运行序号设置 `CFBundleVersion`，并在打包前检查两者。软件源中的版本必须与 IPA 内部版本一致。

原生会话工具栏不再继承旧 Work Thread 在 980px 以下纵向排列的规则。Harness/Model 组使用内容尺寸作为 flex 基准，允许列宽随右侧会话面板收缩，状态与刷新控件保持独立宽度；避免平板竖屏将控件宽度误当作 588px 高度。浏览器验证在 web 目录运行 `npm run test:native-session-toolbar`（需安装 Playwright，可用 `PLAYWRIGHT_MODULE` 指定模块入口，`CHROMIUM_EXECUTABLE` 指定浏览器）。脚本挂载真实会话工作区，模拟 daemon，覆盖 13 种手机、平板与桌面视口，检查工具栏高度、控件排列、边界及模型菜单。

相关回归测试在 `bridge/test/server.test.js`、`bridge/test/codex-session-history.test.js`、`bridge/test/pi-session-history.test.js`、`bridge/test/project-catalog.test.js`、`bridge/test/machine-daemon.test.js` 与 `bridge/test/config.test.js`。

项目快捷创建的浏览器验收：在 web 中安装与上游 CI 相同的 Playwright 测试工具后，运行 `node scripts/project-session-create-smoke.mjs`。可通过 CHROMIUM_EXECUTABLE 指定已有 Chromium。脚本使用模拟机器，覆盖手机/桌面视口、项目预选、错误重试和离线保护；不会访问真实会话。

释放会话通过已认证的 `POST /v1/agents/codex/session/:id/release` 实现，目前支持 Linux/macOS 服务端。Codex CLI 0.153.4 的 `thread/unsubscribe` 会延迟约 30 分钟卸载，因此 daemon 为每个打开的 Codex 会话维护独立适配器进程组，释放时等待该组退出；其他会话继续运行。相应代价是每个打开的会话有独立进程开销，闲置后可主动释放。Windows 保留原适配器模式，释放接口明确返回不支持。模型目录查询继续使用独立的技术会话。

相关回归测试在 `bridge/test/session-acp-client.test.js`、`bridge/test/acp-process-group.test.js`、`bridge/test/acp-session-claim.test.js` 和 HTTP daemon 测试中。浏览器验收在 web 目录运行 `node scripts/session-release-smoke.mjs`。进程组测试只操作自身创建的进程；真实 Codex 验收应使用专用测试会话，验证第二客户端在释放前冲突、释放后立即恢复。

Codex 最终回复展示：实时 ACP 流与原生日志均保留 `commentary` / `final_answer` 标记；最终文字不依赖可能滞后的 running 状态，也不会因后续工具事件被归入 Activity。迟到消息按创建时间插回原来的位置，避免最终回复落到下一轮用户消息之后。此修复需要客户端和后端同时更新。

原生会话的逻辑轮次在首次读取及发送落盘后绑定原生 user message ID。刷新和新增消息优先按该稳定 ID 归属回复，不再因相同提示词、延迟落盘或尾页变化重新配对最近几轮。

会话同步采用单调合并：旧日志页不能删除已显示的 message part，也不能把完整文本缩回旧前缀。Codex 回复完成后客户端继续快速对账到 `final_answer`；ACP 实时缓存会保留到延迟写入的 JSONL 出现对应内容，期间不会因 idle 切源而撤回。PC 新增的 Codex user turn 可在已打开的手机客户端中持续发现，重叠的刷新会排队执行最后一次对账。Bridge 在确认 SSE 建连前注册监听器，避免连接窗口漏掉首个事件。

iOS 客户端支持：引入 `@capacitor/ios@8.3.4` 原生工程，采用 SPM（Swift Package Manager）依赖结构，通过 `npm run cap:sync:ios` 将前端 WebUI 产物直接预封装进原生资源目录。配置 `Info.plist` 开启 ATS（允许连接自建 HTTP/HTTPS 服务）与本地局域网权限，配置高清应用图标。配套提供 `.github/workflows/ios-ipa.yml` CI 构建流，在 GitHub Actions 的 macOS 环境中通过 `xcodebuild` 自动打包未签名 IPA 产物，支持通过 TrollStore、AltStore、SideStore 或自签名工具在 iPhone/iPad 上侧载安装。
