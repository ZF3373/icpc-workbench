# CREDITS · 第三方依赖与声明

ICPC 备赛工作台 的原创代码、界面设计与品牌图标以 [MIT License](./LICENSE) 发布。
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

## 其他声明

- 品牌 logo（favicon / 应用图标）为本仓库原创设计
- 各 OJ（Codeforces / AtCoder / 洛谷 / 牛客）的数据通过其公开接口获取，
  本项目与其无隶属关系；洛谷接口为社区非官方 API，版权归洛谷所有
- AI 训练计划功能调用用户自行配置的 OpenAI 兼容服务，本项目不内置任何模型
