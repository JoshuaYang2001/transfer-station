# HAPS Proxy - Hybrid Account Pool Proxy

> 基于 Node.js + TypeScript + Fastify + Redis 的大模型 API 混合账号池代理服务

本地同时运行 HAPS Proxy 与 New API 管理面板，请参考 [本地联调指南](docs/LOCAL_DEVELOPMENT.md)。

## 项目结构

```
haps-proxy/
├── src/
│   ├── config/
│   │   └── index.ts          # 配置管理（环境变量）
│   ├── redis/
│   │   └── client.ts         # Redis 客户端封装（ioredis）
│   ├── services/
│   │   └── account-pool.ts   # ✅ 账号池核心 Redis 操作
│   ├── routes/
│   │   ├── admin.ts          # ✅ 管理接口（批量注入等）
│   │   └── proxy.ts          # 代理路由（核心逆向代理框架）
│   ├── plugins/
│   │   └── auth.ts           # 鉴权插件（Proxy Bearer + Admin Key）
│   ├── janitor/
│   │   └── index.ts          # ✅ 定时清理任务
│   ├── types/
│   │   └── index.ts          # TypeScript 类型定义
│   └── index.ts              # Fastify 入口
├── package.json
├── tsconfig.json
└── .env.example
```

---

## 第一步完成：Redis 数据结构设计 + 账号注入接口

### 1. Redis 数据结构设计

| Key | 类型 | 用途 |
|-----|------|------|
| `haps:accounts` | Hash | 全局账号哈希表。Field = 真实 API Key，Value = JSON 元数据（pool_type/status/fail_count/时间戳等） |
| `haps:pool:ephemeral:active` | List | 活跃流动号轮询队列（LPOP/RPUSH 实现轮转） |
| `haps:pool:static:active` | List | 活跃稳定号轮询队列 |

**账号元数据结构 (`AccountMeta`)**：
```typescript
{
  pool_type: 'static' | 'ephemeral',
  status: 'active' | 'cooldown' | 'banned',
  fail_count: number,
  created_at: number,
  updated_at: number,
  cooldown_until?: number,  // 冷却截止时间戳
  banned_at?: number        // 封禁时间戳
}
```

**负载均衡策略**：使用 `LPOP` 取出使用 → 成功后 `RPUSH` 放回队尾 → 天然实现轮询（Round-Robin）

### 2. 账号池核心方法 (AccountPool 类)

- `batchInject(poolType, keys)` - 批量注入（去重、格式校验、Lua 原子写入）
- `popActiveKey()` - 轮询取出一个可用 Key（优先 ephemeral，降级 static）
- `returnKey(key, poolType)` - 使用成功后放回队列
- `markBanned(key)` - 标记封禁并从活跃队列移除（对应 401）
- `markCooldown(key)` - 标记冷却并从活跃队列移除（对应 429）
- `restoreFromCooldown(key)` - 冷却到期后恢复
- `janitorRestoreCooldown()` - 定时任务：扫描冷却过期账号放回活跃池
- `janitorPurgeBanned()` - 定时任务：清理死号释放内存
- `getStats()` - 池统计信息

### 3. 账号注入接口

**接口**：`POST /admin/accounts/batch-inject`

**鉴权**：请求头 `X-Admin-Api-Key: <your-admin-key>`

**请求体**：
```json
{
  "pool_type": "ephemeral",
  "keys": ["sk-xxxxxx1", "sk-xxxxxx2", "sk-xxxxxx3"]
}
```

**响应**：
```json
{
  "success": true,
  "pool_type": "ephemeral",
  "injected": 95,
  "duplicates": 3,
  "invalid": 2
}
```

注入过程会先在请求内规范化并去重，再通过单次 Redis Lua 脚本原子执行
`HEXISTS + HSET + RPUSH`。并发请求注入相同 Key 时，只会有一个请求成功写入，
避免哈希表与活跃队列之间状态不一致或出现重复队列项。

### 4. 其他已实现接口

- `GET /health` - 健康检查
- `GET /admin/stats` - 池状态统计（需要 Admin Key）

### 5. Janitor 定时任务

- **每小时 (`0 * * * *`)**：扫描所有 `cooldown` 状态 Key，冷却到期的自动放回 active 队列
- **每天凌晨 (`0 0 * * *`)**：清理所有 `banned` 状态死号，释放 Redis 内存

---

## 启动方式

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 设置你的密码和 Redis 地址

# 3. 开发模式运行（热重载）
npm run dev

# 4. 生产构建
npm run build
npm start
```

---

## 下一步待实现

- 核心逆向代理路由的流式处理优化和完善（框架已搭好）
- 无缝重试切号逻辑的端到端验证
- 可观测性（metrics / logging 增强）
