# syntax=docker/dockerfile:1

# ---------- 构建阶段 ----------
FROM node:24-alpine AS build
WORKDIR /app

# 与 CI 保持一致的 pnpm 版本
RUN npm install -g pnpm@12.6.0

# 先装依赖，利用层缓存：源码变动不会重新安装依赖
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# 前端直连的 API 地址，构建时注入为 __API_ORIGIN__
ARG API_ORIGIN=https://api.deepseek.com
ENV API_ORIGIN=${API_ORIGIN}

RUN pnpm build

# ---------- 运行阶段 ----------
FROM nginx:alpine

# 站点配置（仅 server 块，覆盖默认站点）
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 静态产物
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1

STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
