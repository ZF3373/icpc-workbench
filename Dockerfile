# syntax=docker/dockerfile:1
#
# ICPC 备赛工作台 —— Web 版容器镜像。
#
# 架构：单容器单进程。入口复用 server/src/sea.ts 的非 SEA 分支——它同时服务
# 全部 /api 路由、client/dist 静态前端（含 SPA 刷新兜底）和 /widget 页面，
# 与桌面版共享同一条启动逻辑，避免两套部署行为分叉。
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

# ---------- 3) 服务端生产依赖（剔除 typescript/esbuild/tauri-cli 等 devDeps） ----------
FROM node:24-alpine AS server-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/
RUN npm ci --omit=dev

# ---------- 4) Typst：下载官方 musl 二进制并做 SHA256 校验 ----------
# 脚本自带 linux-amd64/arm64 资产表与哈希校验，产物落在 /app/server/vendor/typst
FROM node:24-alpine AS typst
RUN apk add --no-cache tar xz
WORKDIR /app/server
COPY server/scripts/prepare-typst.mjs scripts/
RUN node scripts/prepare-typst.mjs

# ---------- 5) 运行镜像 ----------
FROM node:24-alpine
RUN apk add --no-cache tzdata
# HOST=0.0.0.0：容器内必须绑所有网卡，docker run -p 的端口映射才对外可达。
# 服务端默认仍是 127.0.0.1，只有镜像内显式设置了该变量。
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    TZ=Asia/Shanghai
WORKDIR /app
COPY LICENSE CREDITS.md ./
COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY shared/ ./shared/
COPY server/ ./server/
# typst 阶段的 vendor 拷在 COPY server/ 之后：server/vendor 已被 .dockerignore
# 排除出构建上下文，二者不会冲突，这里只为了让依赖顺序更直观
COPY --from=typst /app/server/vendor ./server/vendor
COPY --from=web-build /app/client/dist ./client/dist
# tsx 是 server 的 devDep（运行器），全局安装避免把整个 devDeps 带进镜像
RUN npm install -g tsx@^4 \
 && mkdir -p /app/server/data \
 && chown -R node:node /app/server/data
USER node
WORKDIR /app/server
EXPOSE 3001
VOLUME /app/server/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health >/dev/null 2>&1 || exit 1
CMD ["tsx", "src/sea.ts"]
