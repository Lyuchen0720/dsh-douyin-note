# 更新记录

格式化参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

每条版本在 GitHub 上都有对应的 tag（`v0.4.0`、`v0.5.0`…），
点仓库的 **Tags / Releases** 就能看到每个版本当时的代码快照。

## [0.7.0] - 2026-11-24

### 新增

- **管理员 + 逐项权限**：设置页新增「管理员」卡片，可以从聊过的人里挑，也可以粘贴 sec_uid；
  按「发图文 / 回评论 / 删作品 / 改设置·频率 / 查状态」逐项授权。
- 名单写进 `$DSH_HOME/douyin-duty/admin.json`（与「刷抖音」共用），改完即时生效，
  私信转达会在第 ② 条列出「他当前被允许做什么」；没勾的操作一律不做。
- HTTP：`GET /api/douyin-note/admins`、`POST /api/douyin-note/admins`。
- 兼容旧形状 `{ "uids": [...] }`（等于全权限），第一次保存会升级成新结构。

### 变更

- 内置的「刷抖音」副本同步到同一套权限逻辑（`wakeText` 改为 `adminInfo()` + `permsText()`）。
- selfcheck 增至 **18 项**（新增 admins 去重 / 默认权限 / 旧形状兼容）。

## [0.6.0] - 2026-11-24

### 新增

- **图文评论区自动回复**（新工具 `douyin_note_replies`）：
  - 只看本插件自己发出去的作品（`state.json` 里有 `aweme_id` 的，默认最近 7 天）。
  - 读完评论先过滤：纯表情（`[看][看][看]`）、空文本、广告词、作者自己、超过 200 字、已经回过的，全部跳过。
  - 每轮最多挑 1–2 条；同一个人只挑他最新的一条。
  - 回复文案由模型按插件自带的 `prompts/persona.md` 现场写，不是模板。
  - 读评论走签名接口（`tools/dy-signer.mjs`），失败时用无头页面 XHR 兜底；发回复走页面上下文里的
    `tools/comment-api.mjs`，拿到 `cid` 才算成功。
  - 默认关闭、默认干跑：`action:"reply"` 不带 `confirm:true` 只出候选和草稿。
  - 回过的 `cid` 记在 `state.json` 的 `replies`（最多 300 条），不会重复回。
- 设置页「抖音图文」新增「评论自动回复」卡片：开关、间隔分钟、每轮条数，以及「扫一遍评论」「干跑一轮」。
- 新接口：`POST /api/douyin-note/reply/scan`、`POST /api/douyin-note/reply/run`。
- 新模块：`lib/comments.mjs`（读评论 / 发回复 / 过滤规则 / 让模型写回复）、`lib/replyauto.mjs`（配置、去重、跑一轮）。

### 修复

- 自检里两个对时区敏感的用例（`dayKey` 用本地日期、候选排序期望值），换到 UTC 跨天的时段会误报。

## [0.5.1] - 2026-11-23

### 变更

- README 与教程的口径从「内置了，不用另装」改成**「推荐先装『刷抖音』并扫码登录，包内副本作兜底」**：
  先装上游插件时设置页完整、扫码点一下就能完成；只装本插件时副本只挂宿主半端，扫码要敲命令。
- 新增两条路的对比表（命令条数 / 扫码方式 / 设置页有无 / profile 共用 / 副本是否跳过 / 装主依赖）。
- `docs/TUTORIAL.md` 重排：1 装刷抖音并登录 → 2 装图文插件 → 3 确认登录态 → 4 干跑 → 5 真发 → 6 自动发。

## [0.5.0] - 2026-11-23

### 新增

- **把「刷抖音」（`dsh-douyin-scroll`）vendor 进包**（`vendor/dsh-douyin-scroll/`，MIT，保留上游 LICENSE 与来源说明），
  `cordis.patch.yml` 增加第二行 `douyin-scroll-embedded`，装一个包就能同时挂上发布与登录态。
  - 带守卫：本机已单独装了刷抖音（工具表里有 `douyin_status`）时自动跳过，不重复注册。
  - 随包挂载时用 `autoEnabled:false` 等配置，避免它在后台自己刷、自己发。
- `scrollStatus()` 返回值增加 `bundled` 与 `login_tool`，提示里直接给二维码登录命令。

### 说明

- 不走 `dependencies: github:...`：pnpm 会去装上游 peer 的 `@deepseek-ai/dsh-tools` 等未发布的私包，直接 404。

## [0.4.0] - 2026-11-23

第一个推上 GitHub 的版本。

### 新增

- 图文发布：`douyin_note_publish`（本地图片 1–35 张、标题、描述、话题、配乐、可见性，默认干跑）。
- 定时自己发：`douyin_note_auto`（按小时/每天上限，模型按人设写稿 → 渲染 1080×1440 文字卡 → 随机配乐 → 发布）。
- 状态查询：`douyin_note_status`。
- 设置页「抖音图文」（`client.js`，`settings.section`）。
- **前置依赖门**：没检测到「刷抖音」的家目录 / 浏览器 profile 时，发布前直接报 `stage:"dependency"`，不起浏览器。
- 仓库化：图标、三张截图、`screenshots.json`、MIT LICENSE、`.gitattributes`、部署教程。

### 之前（仓库建立前，未打 tag）

- 0.1.0：一条图文从上传到发布的完整链路（干跑 + 真发）。
- 0.2.0：配乐（搜索关键词 → 取第一条 → 点「使用」，从 create 请求体回读 `music_id` 验证）。
- 0.3.0：按频率自动发布（心跳、抖动、每天上限、草稿不占名额）与设置页。

[0.6.0]: https://github.com/Lyuchen0720/dsh-douyin-note/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Lyuchen0720/dsh-douyin-note/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Lyuchen0720/dsh-douyin-note/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Lyuchen0720/dsh-douyin-note/releases/tag/v0.4.0
