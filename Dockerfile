# ---------- 阶段 1:构建前端 ----------
# public/ 在 .gitignore 里,产物必须在镜像内构建;vite outDir=../public
FROM node:22-alpine AS webbuild
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- 阶段 2:运行镜像 ----------
# 服务端零 npm 依赖(纯 Node 标准库,node:sqlite 需 >=22.5),无需 npm install
FROM node:22-alpine
WORKDIR /app
ENV HOST=0.0.0.0 PORT=3050 CCP_DATA_DIR=/app/data
COPY server.mjs config.default.json package.json ./
COPY src/ ./src/
COPY --from=webbuild /app/public ./public
VOLUME ["/app/data"]
EXPOSE 3050
CMD ["node", "server.mjs"]
