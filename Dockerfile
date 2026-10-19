# syntax=docker/dockerfile:1
#
# ICPC 备赛工作台 —— Web 版容器镜像。
#
# 架构：单容器单进程。入口复用 server/src/sea.ts 的非 SEA 分支——它同时服务
# 全部 /api 路由、client/dist 静态前端（含 SPA 刷新兜底）和 /widget 页面，
# 与桌面版共享同一条启动逻辑，避免两套部署行为分叉。
#
# 运行时产物化：构建阶段用 esbuild 把 sea.ts 连同 server/src、shared/src 与全部
# npm 依赖打成单文件 server/dist/sea.cjs（配置与桌面 SEA 打包同源，见
# server/scripts/build-server-bundle.mjs），运行阶段只执行 `node dist/sea.cjs`。
# 镜像里没有任何 .ts 源码、不需要 tsx、也不需要 node_modules——运行时不再转译，
# 依赖版本由构建阶段锁定，启动也更快。
#
# 数据：一切运行时数据（SQLite WAL、uploads、knowledge、backups）都落在
# 容器内 /app/server/data，必须挂卷持久化。
#
# 安全：默认以非 root 的 node 用户运行；应用本身无认证，端口映射建议只绑
# 宿主机回环（如 -p 127.0.0.1:3080:3001），对外暴露请自行加反代 + 认证。
#
# 自更新：源码运行时 APP_VERSION=dev，应用内「软件更新」不会提示（桌面版
# 自更新产物是 Windows exe，容器内更新 = 拉取新镜像）。

# ---------- 1) 全量依赖（前端构建需要 vite 等 devDeps） ----------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/
RUN npm ci

# ---------- 2) 前端构建 → client/dist ----------
FROM deps AS web-build
COPY client/ client/
COPY shared/ shared/
RUN npm run build

# ---------- 3) 服务端 bundle → server/dist/sea.cjs ----------
# esbuild 是 server 的 devDep（与桌面 SEA 打包共用），只在构建阶段需要。
# 这一阶段刻意只拷源码、不拷 server/dist（.dockerignore 也排除了它），
# 保证产物一定来自当前源码而不是宿主机的陈旧文件。
FROM deps AS server-bundle
COPY server/src/ server/src/
COPY server/scripts/build-server-bundle.mjs server/scripts/esbuild-import-meta.mjs server/scripts/
COPY shared/ shared/
RUN node server/scripts/build-server-bundle.mjs \
 && node -e "require('node:fs').accessSync('server/dist/sea.cjs')"

# ---------- 4) Typst：下载官方 musl 二进制并做 SHA256 校验 ----------
# 脚本自带 linux-amd64/arm64 资产表与哈希校验，产物落在 /app/server/vendor/typst。
# 非 SEA 分支走磁盘 fallback（templates/typst.ts 的 vendoredTypstPath），
# 所以运行镜像必须保留 server/vendor/typst 的原始目录布局。
FROM node:24-alpine AS typst
RUN apk add --no-cache tar xz
WORKDIR /app/server
COPY server/scripts/prepare-typst.mjs scripts/
RUN node scripts/prepare-typst.mjs

# ---------- 5) 运行镜像 ----------
FROM node:24-alpine

# 运行时资源清单（bundle 按磁盘路径读取，绝对路径由 src/server-root.ts 锚定 /app/server）：
#   src/db/schema.sql               建表语句（非 SEA 分支直接读盘）
#   src/ai/*.md                     计划/助手/标题提示词
#   src/data/bank-builtin.json      内置题库
#   src/knowledge/{taxonomy,rules}.json  知识点体系与 L1 规则表
#   src/public/widget.html          /widget 页面
# 少任何一项都不会在构建期报错，只会在运行时按功能静默失效——新增磁盘资源时
# 必须同步这份清单（git 里没有的路径 COPY 会直接失败，算是最后一道保险）。
RUN apk add --no-cache tzdata
# HOST=0.0.0.0：容器内必须绑所有网卡，docker run -p 的端口映射才对外可达。
# 服务端默认仍是 127.0.0.1，只有镜像内显式设置了该变量。
# ICPC_DOCKER=1：isDockerRuntime 的最可靠判据（/.dockerenv 是兜底），
# 决定恢复点相关文案与「重启容器」端点是否启用。
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    TZ=Asia/Shanghai \
    ICPC_DOCKER=1
WORKDIR /app
COPY LICENSE CREDITS.md ./
COPY server/package.json server/config.example.json ./server/
COPY --from=server-bundle /app/server/dist/sea.cjs ./server/dist/sea.cjs
COPY server/src/db/schema.sql ./server/src/db/schema.sql
COPY server/src/ai/plan-prompt.md server/src/ai/assistant-prompt.md server/src/ai/title-prompt.md ./server/src/ai/
COPY server/src/data/bank-builtin.json ./server/src/data/bank-builtin.json
COPY server/src/knowledge/taxonomy.json server/src/knowledge/rules.json ./server/src/knowledge/
COPY server/src/public/widget.html ./server/src/public/widget.html
# typst 阶段的 vendor 必须放在上面这些 COPY 之后：server/vendor 已被 .dockerignore
# 排除出构建上下文，二者不会冲突
COPY --from=typst /app/server/vendor ./server/vendor
COPY --from=web-build /app/client/dist ./client/dist
RUN mkdir -p /app/server/data \
 && chown -R node:node /app/server/data
USER node
WORKDIR /app/server
EXPOSE 3001
VOLUME /app/server/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1
# 直接跑 bundle：启动期不转译、不装依赖；SIGTERM 由 sea.ts 的优雅退出处理
# （先停接新连接 → 等在途请求收尾 → 关 SQLite 让 WAL checkpoint → 退出）
CMD ["node", "dist/sea.cjs"]
