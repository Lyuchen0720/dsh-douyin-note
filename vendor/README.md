# vendor/dsh-douyin-scroll

这里放的是「刷抖音」插件（`dsh-douyin-scroll`）的**原样副本**，不是我们的代码。

图文插件需要它的两样东西：

1. **登录态** —— 它扫码登录后写下的 `$DSH_HOME/douyin-duty/chrome-profile`（浏览器 profile + Cookie）；
2. **它的工具** —— 首次使用时用它的 `douyin_login_save` / 二维码登录把抖音号登上。

装本插件时会自动把这个副本挂进 cordis（`cordis.patch.yml` 里 id 为 `douyin-scroll-embedded` 的那一行）。
如果本机已经单独装了「刷抖音」（工具表里已有 `douyin_status`），这一行会自动跳过，不会重复注册。

## 来源

- 上游仓库：https://github.com/NEWJO123/dsh-douyin-scroll
- 版本：`0.7.10`
- 提交：`2ea5f546680b13c0ed6e1f0f210e6239e752e4bc`（2026-11-13）
- 许可证：MIT（见同目录 `LICENSE`，版权归上游作者）

## 更新

```bash
git clone --depth 1 https://github.com/NEWJO123/dsh-douyin-scroll.git /tmp/scroll
rsync -a --delete --exclude .git --exclude node_modules \
  /tmp/scroll/ E:/工作区/dsh-douyin-note/vendor/dsh-douyin-scroll/
```

然后 `git -C E:/工作区/dsh-douyin-note status` 看一遍改动、同步本文件的版本号和提交号，再提交。
上游的行为（登录流程、家目录结构）一变，我们的 `lib/paths.mjs` 里的 `scrollStatus()` 也要跟着核对。
