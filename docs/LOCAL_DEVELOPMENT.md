# HAPS Proxy + New API 本地联调指南

## 1. 前端代码在哪里

当前仓库中的 `src/` 是 HAPS Proxy 后端，不包含 New API 前端源码。

New API 管理面板来自官方镜像 `calciumion/new-api:latest`。镜像中已经包含编译后的前端页面和 Go 后端，因此访问 `http://127.0.0.1:3000` 时看到的是容器内的 New API 页面。

如果需要修改 New API 页面本身，请单独克隆官方仓库：<https://github.com/QuantumNous/new-api>。

## 2. 本地架构

```text
浏览器
  └─ http://127.0.0.1:3000
       └─ New API 管理面板（Docker）
            └─ http://host.docker.internal:8787
                 └─ HAPS Proxy（Node.js）
                      ├─ Redis 账号池 :6379
                      └─ 官方大模型 API
```

## 3. 首次准备

### 3.1 配置 HAPS

```bash
cd /Users/joshuayang/Desktop/code/project/haps-proxy
cp .env.example .env
```

至少修改以下配置，不要使用示例值：

```dotenv
PROXY_BEARER_TOKEN=供-New-API-调用-HAPS-的随机密码
ADMIN_API_KEY=账号池管理接口的随机密码
```

安装依赖并构建：

```bash
nvm use 20
npm ci
npm run build
```

### 3.2 启动 Redis

首次创建：

```bash
docker run --name haps-proxy-redis \
  --restart unless-stopped \
  -p 6379:6379 \
  -d redis:7-alpine
```

以后只需：

```bash
docker start haps-proxy-redis
```

### 3.3 启动 New API

```bash
cd /Users/joshuayang/Desktop/code/project/haps-proxy/deploy/new-api
export NEW_API_SESSION_SECRET="$(openssl rand -hex 32)"
export NEW_API_CRYPTO_SECRET="$(openssl rand -hex 32)"
docker compose up -d
```

SQLite 数据保存在 `deploy/new-api/data/`。

## 4. 同时运行前后端

终端一运行 HAPS：

```bash
cd /Users/joshuayang/Desktop/code/project/haps-proxy
nvm use 20
npm run dev
```

终端二确认容器：

```bash
docker start haps-proxy-redis haps-new-api
docker ps
```

访问地址：

- New API 面板：<http://127.0.0.1:3000>
- HAPS 健康检查：<http://127.0.0.1:8787/health>

## 5. New API 首次初始化

1. 打开 <http://127.0.0.1:3000/setup>。
2. 创建管理员账号和密码。
3. 登录后进入渠道管理。
4. 创建 OpenAI 兼容的自定义渠道。
5. Base URL 填写 `http://host.docker.internal:8787`。
6. 渠道 Key 填写 HAPS `.env` 中的 `PROXY_BEARER_TOKEN`，不要填写真实上游 Key。

## 6. 注入合法持有的上游 Key

```bash
curl http://127.0.0.1:8787/admin/accounts/batch-inject \
  -H "Content-Type: application/json" \
  -H "X-Admin-Api-Key: <ADMIN_API_KEY>" \
  -d '{
    "pool_type": "static",
    "keys": ["sk-your-official-api-key"]
  }'
```

查询账号池状态：

```bash
curl http://127.0.0.1:8787/admin/stats \
  -H "X-Admin-Api-Key: <ADMIN_API_KEY>"
```

## 7. 验证运行状态

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:3000/api/status
docker exec haps-proxy-redis redis-cli ping
```

预期结果分别包含 `status: ok`、`success: true` 和 `PONG`。

## 8. 停止服务

在 HAPS 终端按 `Control + C`，然后执行：

```bash
docker stop haps-new-api haps-proxy-redis
```

停止容器不会删除 New API 数据或 Redis 容器。

## 9. 当前能力边界

HAPS 当前注入接口接收 `sk-*` 格式的官方 API Key。Codex 订阅账号使用 OAuth JSON 凭据，与普通 API Key 不同，暂未接入当前代理链路。
