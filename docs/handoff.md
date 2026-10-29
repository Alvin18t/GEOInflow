# GEOInflow 部署交接

更新时间：2026-10-29。源码工作区原为干净状态，无需 WIP 分支；本文记录本机部署与接手入口，不包含凭据。

## 项目概况

- 目标：自托管网站访问、AI 搜索引荐、AI 爬虫日志、内容覆盖与 GEO 证据分析。
- 目标用户：企业/内容/媒体/文档站点的站长、GEO 运营及多站点分析维护者。
- 仓库地址：https://github.com/Alvin18t/GEOInflow （交接 fork，默认分支 `main`）；上游：https://github.com/yaojingang/GEOInflow 。
- 线上地址：https://app.geoflowusd.org；本机入口 `http://127.0.0.1:3002`。
- 技术栈：Next.js/Node.js 22、pnpm、PostgreSQL 16、Redis、Docker Compose、Colima、Cloudflare Tunnel；独立日志与分析 worker。

## 当前状态

- 使用 `scripts/liekan-deploy.sh` 完成一键部署，保留官方示例、迁移和随机本地配置。
- 2026-10-29 复核：Colima 正常；`app`、`log-worker`、`analytics-worker`、PostgreSQL、Redis 五个服务均 healthy；本机 `/api/heartbeat` 返回 `{"ok":true}`。
- Cloudflare Tunnel 进程运行中，把 `app.geoflowusd.org` 转发到 `127.0.0.1:3002`；未覆盖主域和 `www` 的现有 Laravel 站点。
- 初始管理员密码已更换，当前凭据只保存在 macOS Keychain；仓库和本文不记录值。
- 本机容器仍运行 2026-10-27 已验证 revision `8058869`。上游 `main` 在 2026-10-29 重写并前进到 `beef996`；该新 revision 尚未对现有数据执行升级验收。
- 最近一次上游改动为 PR #17 合并已验证的 Gitee clean history（`beef996`）；本次参与内容为安装、配置、凭据加固和上线。

## 未完成任务

1. **P0：建立备份与恢复演练。** 当前服务依赖单台 Mac，尚无已验证的异机恢复。验收：PostgreSQL、`.env`、必要配置和上传/地理资源有加密备份；在隔离环境完成恢复、登录、heartbeat 和示例/真实站点核对。
2. **P0：评估并演练上游升级。** 源码已到 `beef996`，生产仍为 `8058869`；剩余在数据库副本上运行迁移、示例/凭据保留和回滚检查。验收：隔离升级通过全套部署检查，现有管理员、数据、删除标记和统计口径保持，回滚可用后才更新生产。
3. **P1：接入首个真实站点并验证证据链。** 当前系统健康与页面可达，真实浏览器追踪、服务器日志、内容清单和转化数据尚未完整接入。验收：同一站点完成 tracker、日志、sitemap/CSV、首轮分析；页面覆盖、crawler 身份、失败响应与 AI 引荐均显示实际数据及缺口。
4. **P1：迁移到可持续运行环境。** 现网依赖此 Mac 联网、不休眠、Colima 和 Tunnel 持续运行。验收：迁移到长期在线主机或明确保留本机方案并增加开机自启、健康监控、磁盘/数据库告警和故障恢复时限。

## 已知问题

- 本机 DNS 曾缓存 `app.geoflowusd.org` 的旧 NXDOMAIN；公共 DNS 与公网 HTTPS 已生效。复现：本机解析失败而 `1.1.1.1` 可解析。已尝试刷新/等待缓存，根因属于本地缓存，应用无需改码。
- 线上可用性依赖 Mac、Colima 与 cloudflared；任一停止都会中断服务。
- Docker 首次构建曾因缺少 BuildKit/buildx 失败；安装 Homebrew `docker-buildx` 后解决。
- 浏览器追踪只有在可信 CDN 入口提供可用身份字段时才能进入合格 PV/UV；缺少日志/内容清单时 crawler 覆盖结论会标记缺口。

## 关键决策

- 使用 `app.geoflowusd.org`，保留主域和 `www` 的 Laravel 服务。
- 应用只绑定 `127.0.0.1:3002`，公网流量经 Cloudflare Tunnel；可信客户端 IP 读取 Cloudflare 入口头。
- 部署采用独立 PostgreSQL/Redis 数据和官方脚本，不修改其他 Umami/Laravel 实例及数据卷。
- 保留 cookieless 默认与明确证据状态；抓取、索引、模型训练、回答引用和转化分别取证。
- AI 分析默认关闭；没有凭据时核心访问/爬虫分析仍可运行。

## 运行与部署

```bash
colima start --cpu 4 --memory 6
sh scripts/liekan-deploy.sh
docker compose -f docker-compose.liekan.yml ps
curl -fsS http://127.0.0.1:3002/api/heartbeat
docker compose -f docker-compose.liekan.yml logs --since=10m app log-worker analytics-worker
```

开发入口按 README：`pnpm install --frozen-lockfile`，依次构建数据库/迁移/OpenAPI/packages/tracker/recorder/worker，再执行 `pnpm dev --port 3302`。主要环境变量名：`APP_SECRET`、`DATABASE_URL`、`TWO_FACTOR_ENCRYPTION_KEY`、`POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`CLIENT_IP_HEADER`、`LIEKAN_PUBLIC_URL`、`DEFAULT_LOCALE`、`LIEKAN_AI_ENABLED`、`API_KEY_ENABLED`、`DISABLE_TELEMETRY`、`NEXT_TELEMETRY_DISABLED`；可选 Cloudflare/地理/AI 变量见 `docker-compose.liekan.yml` 和 `docs/deployment.md`。

## 外部依赖

- Cloudflare DNS/Tunnel：路由在 Cloudflare Zero Trust；本机 ingress 在 `~/.cloudflared/config.yml`，修改前保留备份。
- Colima、Docker CLI/Compose/Buildx：本机容器运行时；Colima 已配置登录启动。
- PostgreSQL/Redis：Compose 内持久数据与分析缓存；卷与备份由运维负责。
- macOS Keychain：管理员凭据的唯一已记录存放位置；服务名用于检索，本文不写值。
- 可选 Cloudflare Zone OAuth、MaxMind/DB-IP、模型供应商：配置位置在管理 UI、`.env` 与部署文档。

## 下一步

先执行 `docker compose -f docker-compose.liekan.yml ps` 和 heartbeat，然后按 `docs/deployment.md` 导出数据库备份，在隔离 Compose 项目中从 `8058869` 恢复并升级到 `beef996`。迁移、凭据、示例、删除标记和回滚全部通过后再考虑生产升级；所有上线改动遵守 `AGENTS.md` 的分支、验证和 GitHub/Gitee 双推规则。
