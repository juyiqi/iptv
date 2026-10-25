# iptv（快手直播定制构建）

这是 [akiralereal/iptv](https://github.com/akiralereal/iptv) 的**构建仓库**，不是完整源码。

本仓库只保存对上游的改动（`overlay/` 目录），GitHub Actions 在构建时自动拉取上游最新源码、叠加改动，产出多架构镜像发布到 GHCR：

```
ghcr.io/juyiqi/iptv:latest
```

## 叠加内容

- **快手直播模块**（`overlay/extractors/kuaishou-live/`）
  - 手动房间模式：填直播间链接 + 快手登录 Cookie，只看指定主播
  - 分类自动收录模式：50 个官方分区可选
  - FLV 由本机转发，仅放行 `*.pull.yximgs.com`
- `extractors/registry.js`：登记上述模块
- `scripts/test-kuaishou.mjs`：模块离线测试（35 项）

## 日常使用

改了 `overlay/` 里的任何文件，push 到 main 就会自动重建镜像；也可以到 Actions 页手动 Run workflow。

NAS 上拉取：

```bash
docker pull ghcr.io/juyiqi/iptv:latest
```

> 首次构建后 GHCR 包默认是私有的，需要到 GitHub → 头像 → Packages → iptv → Package settings 改成 Public，之后 NAS 才能免登录拉取。

## 与上游同步

镜像始终基于**当时最新的上游 main** 构建（每次触发都重新 clone）。若上游改了 `extractors/registry.js` 等被我们覆盖的文件，重新对齐一次 overlay 即可。
