# CREDITS · 第三方依赖与声明

ICPC 备赛工作台 的原创代码、界面设计与品牌图标以 [GPL-3.0 License](./LICENSE)（GNU 通用公共许可证 v3.0）发布。
软件构建依赖大量优秀的开源项目，主要直接依赖如下（传递依赖以各自包内声明的许可证为准，
完整清单可在仓库根目录执行 `npx license-checker --summary` 查看）。

## 前端（client/）

| 依赖 | 许可证 | 用途 |
| --- | --- | --- |
| [React](https://react.dev) | MIT | UI 框架 |
| [Ant Design](https://ant.design) | MIT | 组件库 |
| [@ant-design/icons](https://ant.design) | MIT | 图标 |
| [React Router](https://reactrouter.com) | MIT | 路由 |
| [Recharts](https://recharts.org) | MIT | 图表 |
| [Day.js](https://day.js.org) | MIT | 日期处理 |
| [react-markdown](https://github.com/remarkjs/react-markdown) / remark-gfm | MIT | Markdown 渲染 |
| [Vite (rolldown-vite)](https://vite.dev) | MIT | 构建工具 |

## 后端（server/）

| 依赖 | 许可证 | 用途 |
| --- | --- | --- |
| [Express](https://expressjs.com) | MIT | Web 服务框架 |
| Node.js 内置 `node:sqlite` | Node.js License（MIT 衍生） | 本地数据库（零原生依赖） |
| [tsx](https://tsx.is) | MIT | 开发期 TS 执行 |
| [esbuild](https://esbuild.github.io) | MIT | SEA 打包 bundle |

## 桌面壳（desktop/）

| 依赖 | 许可证 | 用途 |
| --- | --- | --- |
| [Tauri](https://tauri.app) | MIT / Apache-2.0 | 原生窗口与 WebView 壳 |
| [tauri-plugin-single-instance](https://tauri.app) | MIT / Apache-2.0 | 单实例 |
| [reqwest](https://github.com/seanmonstar/reqwest) / [tokio](https://tokio.rs) / [futures](https://rust-lang.github.io/futures-rs/) | MIT / Apache-2.0 | Rust 异步与 HTTP（服务探测） |
| [@tauri-apps/cli](https://tauri.app) | MIT / Apache-2.0 | NSIS 安装程序打包 |
| NSIS | zlib/libpng | 安装器运行时（Tauri 自动下载） |

## 工具链

| 依赖 | 许可证 | 用途 |
| --- | --- | --- |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | 类型系统 |
| [oxlint](https://oxc.rs) | MIT | Lint |
| [@resvg/resvg-js](https://github.com/nickbabcock/resvg-js) （内置 [resvg](https://github.com/linebender/resvg)） | MIT | 品牌 SVG → 多尺寸图标 |

## 依赖安全覆盖（`package.json` 的 `overrides`）

`package.json` 是 JSON，不便写注释；而 `overrides` 里的每一项都是**供应链漏洞修复**，
不是随手升级，改动前请先读这一节。四项均只收紧到上游版本约束本就允许的修复版，
没有强制不兼容升级：

| 包 | 收紧到 | 原因 | 依赖链 / 是否进产物 |
| --- | --- | --- | --- |
| `adm-zip` | `^0.6.1` | 修复 0.6.0 及以下的多项漏洞：异步 DEFLATE 解压未处理 error 事件导致进程崩溃（GHSA-8238-w5pm-2374，high）、解压炸弹防护可被「声明解压后大小为 0」绕过（GHSA-rcw4-f5rp-g42v，high）、解压保留 SUID/SGID 位导致本地提权（CVE-2026-102282，high），另有两条 medium | `server → epub2`；**进产物**（EPub 附件解析，输入为不可信文件，需保留） |
| `shell-quote` | `^1.12.0` | `quote()` 遇 `{ comment }` 后跟含换行的 token 会产出行注入（CVE-2026-102422，critical） | 根 `devDependencies/concurrently`；仅开发期，不进产物 |
| `proxy-addr` | `^2.0.8` | IPv4-mapped IPv6 的信任子网判断有误，可伪造来源 IP（CVE-2026-90711，critical） | `server → express`；进产物（本仓库未使用 trust proxy，当前不可利用，仍升级消警） |
| `source-map-js` | `^1.2.2` | 构造的 source map section offset 可拖死事件循环（CVE-2026-93749，high） | `client → vite → postcss`；仅构建期 |

`npm audit` 因本地镜像源不提供审计接口，需临时切官方源复核：
`npm audit --registry=https://registry.npmjs.org`。有意不修的条目（katex / sprintf-js / uuid 等）
及其可达性论证见提交 `3765cd6` 的说明。

## 其他声明

- 品牌 logo（favicon / 应用图标）为本仓库原创设计
- 各 OJ（Codeforces / AtCoder / 洛谷 / 牛客）的数据通过其公开接口获取，
  本项目与其无隶属关系；洛谷接口为社区非官方 API，版权归洛谷所有
- AI 训练计划功能调用用户自行配置的 OpenAI 兼容服务，本项目不内置任何模型
