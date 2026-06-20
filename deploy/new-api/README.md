# new-api 本地联调

## 拓扑

```text
Browser :3000 -> new-api -> host.docker.internal:8787 -> HAPS -> Official API
                                                   -> Redis :6379
```

## 启动

```bash
export NEW_API_SESSION_SECRET="$(openssl rand -hex 32)"
export NEW_API_CRYPTO_SECRET="$(openssl rand -hex 32)"
docker compose up -d
```

管理面板地址：<http://127.0.0.1:3000>

首次访问时按页面提示创建管理员。创建渠道时，将上游 Base URL 配置为：

```text
http://host.docker.internal:8787
```

渠道 Key 使用 HAPS `.env` 中的 `PROXY_BEARER_TOKEN`，不要填写真实上游 API Key。

## 停止

```bash
docker compose stop
```

SQLite 数据保存在 `data/`，停止或重建容器不会删除面板数据。
