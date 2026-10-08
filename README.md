# dsh-relay-balance · 中转站余额角标

在 DSH 界面角落常驻一枚余额胶囊，**同时**显示多个 API 中转站的账户余额。

支持 **sub2api** 与 **new-api** 两派面板，支持「账号密码 / 手动令牌 / 会话 Cookie」三种凭证来源。

## 效果

- **角标**：默认右下角（可拖到任意角落），三种显示模式：
  - `合计` — 所有站点余额之和 + `N 站`；
  - `当前站` — 跟随设置里的「当前站」；
  - `轮播` — 每 6 秒轮换一个站点。

  前置状态点：绿 = 全部正常 / 黄 = 部分异常或查询中 / 红 = 全部失败。
- **详情面板**：点角标展开 —— 合计大字、`N / M 站正常`、站点列表（名称、余额、主机、分组、并发、更新时间、错误原因），每行带 `刷新` `编辑` `删除`。
- **添加站点**：面板内 `+ 添加站点` 就地展开表单（名称 / 面板地址 / 登录方式 / 凭证 / 启用），带「测试连接」。
- **设置**：刷新间隔（秒）、角标位置、角标显示模式、当前站、自动刷新、显示订阅。

## 安装

```powershell
dsh plugin --profile desktop add github:<你的用户名>/dsh-relay-balance
```

想锁死版本（避免上游改动影响到你）：

```powershell
dsh plugin --profile desktop add github:<你的用户名>/dsh-relay-balance#<commit-sha>
```

也可以直接把本目录当本地包装：

```powershell
dsh plugin --profile desktop add "<本目录绝对路径>"
```

装完确认 profile 的 `package.json`（`~/.dsh/profiles/desktop/package.json`）里 `dsh.profile.bundles` 数组末尾含 `"dsh-relay-balance"`，然后重启 dsh。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-relay-balance
```

## 添加站点

点角标 → `+ 添加站点`，填名称与**面板地址**（中转站首页地址，例如 `https://你的面板域名`），插件会自动探测面板方言，再按方言给出对应字段。

### 面板方言

| 方言 | 判定依据 | API 根 | 读余额 |
|---|---|---|---|
| `sub2api` | `GET /api/v1/settings/public` 有响应 | `{站点根}/api/v1` | `GET /api/v1/user/profile` |
| `newapi` | `GET /api/status` 返回 `success: true` | 站点根（无 `/api/v1` 前缀） | `GET /api/user/self`，余额 = `quota / quota_per_unit` |

### 三种凭证来源

| 方式 | 适用场景 | 怎么拿 |
|---|---|---|
| **账号密码** | 面板开放服务端密码登录（`password_login_enabled: true`） | 直接填用户名与密码。勾「记住密码」会把密码明文写进本机配置文件 |
| **手动令牌** | 面板能签发长期令牌 | **new-api 系**：面板左侧边栏 →「个人设置」→「安全与访问」→「访问令牌」→「重新生成」，复制只显示一次的那串系统访问令牌（详见下节）；**sub2api 系**：F12 → Application → Local Storage 复制 `auth_token`（建议连 `refresh_token` 一起填） |
| **会话 Cookie** | 开了 Cloudflare 人机验证、服务端密码登录被上游拒的站点 | F12 → Application → Cookies → 复制 `new_api_refresh` 的值粘进来 |

> **人机验证的岔路**：new-api 面板若开了 Turnstile（`/api/status` 里 `turnstile_check: true`），服务端密码登录会被上游直接拒（报 `Turnstile token 为空`）；sub2api 系同理（`settings/public` 里 `turnstile_enabled: true`）。这两类站点只能走手动令牌或会话 Cookie。

### new-api 的「系统访问令牌」怎么拿

new-api 系的令牌**不在 Local Storage 里**，得让面板自己签发：

1. 用浏览器登录该站点面板。
2. 左侧边栏 →「个人设置」→「安全与访问」（地址栏形如 `https://面板域名/security`）。
3. 找到「访问令牌」区块 → 点「重新生成」。这一步会先弹「安全验证」，要求再输一次登录密码。
4. 弹出来的那串就是系统访问令牌，**只显示这一次**，复制走。

拿到之后：点角标 → 该站点 `编辑` → 登录方式选「手动令牌」→ 粘到**第一个框 `auth_token`** → 保存。

> **别粘到「会话 Cookie」框里。** 那个框要的是浏览器 DevTools 里的 `new_api_refresh` cookie，和令牌完全是两回事；粘错了上游会回 `Unauthorized, invalid access token`（浏览器/插件把这个错原样透出来）。
>
> 这串令牌可以直接打 `GET /api/user/self`（`Authorization: Bearer <token>`）读余额，而且**不占**关键操作限流额度（见下节）—— 所以开不了服务端登录的站点，优先用它，而不是会话 Cookie。

也可以不经 UI，直接调宿主接口写进去：

```powershell
curl.exe -X POST http://127.0.0.1:19387/relay-balance/sites `
  -H 'Content-Type: application/json' `
  --data-binary '{"action":"update","id":"<站点id>","site":{"accessToken":"<系统访问令牌>"}}'
```

`<站点id>` 从 `GET /relay-balance/state` 的 `sites[].id` 取。

### 令牌续期

- **sub2api**：用 `refresh_token` 打 `POST /api/v1/auth/refresh` 换新令牌。
- **newapi**：access token 只活 900 秒。插件在剩余不足 120 秒时，用 **`new_api_refresh` cookie** 打 `POST /api/user/auth/refresh` 原地轮换。实测只带 `X-Auth-Session` 头会被上游 401 拒 —— **cookie 才是唯一凭证**，轮换下发的新 cookie 会跟着更新。

### 关键操作限流（0.3.0）

new-api 对 **登录 / `auth/refresh` / 安全验证 / 重新生成令牌** 有一份**按 IP 计**的硬预算（`CriticalRateLimit`，默认 **20 次 / 20 分钟**；`middleware/rate-limit.go` 里 `key = mark + ClientIP()`）。浏览器和插件同一个出口 IP，**共用同一个桶** —— 插件打多了，你自己的面板登录就会吃 429。

0.3.0 之前，插件对「有 Cookie 但没令牌」的站点**每个刷新周期都调一次 `auth/refresh`**；间隔设成 30 秒就是 20 分钟 40 次，是配额的两倍，必然把整台机器的额度打爆，面板登录跟着一起被挡。

现在的做法：

- **全局预算** `CRITICAL_BUDGET = 8`，所有 new-api 站点**共享**一份，剩下 12 次留给浏览器 —— 宁可角标数字旧一点，也不能把面板登录挡住。
- **429 退避**：按站点独立，首次撞到就退满一个上游窗口（20 分钟），连续失败翻倍，上限 6 小时；一旦成功立刻清零。
- 被闸门拦下时不再硬发请求：站点状态直接给出原因（`本机关键操作预算已用尽（上游按 IP 计 20 分钟一档），暂缓` / `上游限流退避中（还需 N 秒）`），快照里另有 `rateLimitedUntil`，也不会再级联成一串 401。

> 想彻底不占这份额度，就用**系统访问令牌**（见上节）—— `GET /api/user/self` 不受 `CriticalRateLimit` 保护，`PUT /api/user/self` 才受。
>
> 已经吃到 429 了怎么办：停手等 20 分钟让窗口滑过去，别反复重试（每试一次都算一次，窗口会一直往后推）。

## 设置项

| 项 | 默认 | 说明 |
|---|---|---|
| 刷新间隔 | 60 秒 | 下限 15 秒，上限 24 小时，自动夹取 |
| 角标位置 | 右下 | `br` / `bl` / `tr` / `tl` |
| 角标显示 | 合计 | `合计` / `当前站` / `轮播` |
| 当前站 | — | `当前站` 模式下显示哪个站点 |
| 自动刷新 | 开 | |
| 显示订阅 | 开 | |

站点上限 12 个。

## 宿主接口

宿主半部在 `/relay-balance` 前缀下提供：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/relay-balance/state` | 多站点快照；`?refresh=1` 强制刷新全部，`?refresh=1&id=<站点>` 只刷一个 |
| POST | `/relay-balance/refresh` | 立即刷新；body `{ id }` 只刷指定站点 |
| POST | `/relay-balance/config` | 全局设置（`intervalMs` / `corner` / `badgeMode` / `activeSiteId` / `showSubscriptions` / `enabled`） |
| POST | `/relay-balance/sites` | 站点增删改：`{ action: 'add' \| 'update' \| 'remove', id?, site? }` |
| GET | `/relay-balance/settings` | 探测面板方言与能力；`?baseUrl=<面板地址>` |
| POST | `/relay-balance/login` | 用账号密码向面板登录并保存站点：`{ id?, name?, baseUrl, username?, email?, password?, code?, tempToken?, rememberPassword? }` |
| POST | `/relay-balance/test` | 用未保存的凭证试连通性，不写配置、不触发续期 |

快照结构：

```jsonc
{
  "status": "ok | partial | error | loading | idle",
  "totalBalance": 10.77,            // 无有效余额时为 null
  "counts": { "sites": 2, "configured": 2, "ok": 1, "error": 1, "loading": 0 },
  "sites": [{ "id", "name", "baseUrl", "flavor", "loginMode", "enabled", "configured",
              "status", "balance", "account", "error", "updatedAt",
              "hasAccessToken", "hasRefreshToken", "tokenExpiresAt",
              "hasSessionSid", "hasSessionCookie", "accessExpiresAt",
              "rateLimitedUntil" }],   // 撞了上游关键限流时是退避截止时间，否则 null
  "config": { "intervalMs", "corner", "badgeMode", "activeSiteId", ... }
}
```

## 上游对接

### sub2api 系

```
GET  {site}/api/v1/settings/public              → 探测方言与能力
POST {site}/api/v1/auth/login   { email, password, turnstile_token?, tencent_captcha_ticket? }
GET  {site}/api/v1/user/profile  Authorization: Bearer <access_token>
POST {site}/api/v1/auth/refresh  { refresh_token }
```

### new-api 系

```
GET  {site}/api/status                          → 探测方言与能力
POST {site}/api/user/login?turnstile=  { username, password }
GET  {site}/api/user/self         Authorization: Bearer <access_token>
POST {site}/api/user/auth/refresh Cookie: new_api_refresh=<...>
```

## 配置文件

落盘在 `~/.dsh/storages/dsh-relay-balance/config.json`，权限 0600。

```jsonc
{
  "version": 3,
  "enabled": true,
  "intervalMs": 60000,        // 下限 15000，自动夹取
  "corner": "br",             // br | bl | tr | tl
  "badgeMode": "total",       // total | active | rotate
  "activeSiteId": "<id>",
  "showSubscriptions": true,
  "sites": [
    {
      "id": "<id>",
      "name": "示例站",
      "baseUrl": "https://面板域名",
      "flavor": "newapi",           // sub2api | newapi
      "loginMode": "password",      // password | token
      "accessToken": "...",
      "refreshToken": "",           // sub2api 续期用
      "sessionSid": "...",          // new-api 会话 ID
      "sessionCookie": "new_api_refresh=...",  // new-api 轮换凭证
      "accessExpiresAt": 1791478655,           // unix 秒
      "loginEmail": "...",
      "password": "",               // 勾「记住密码」才写
      "rememberPassword": false,
      "enabled": true
    }
  ]
}
```

0.1.x 的单站点格式（顶层 `baseUrl` / `accessToken`）与 v2 结构在加载时自动迁移并回写。

## 安全说明

- **凭证只留在宿主进程内**。快照只暴露 `hasAccessToken` / `hasRefreshToken` / `hasSessionSid` / `hasSessionCookie` / `tokenExpiresAt` / `accessExpiresAt` 这些布尔与时间字段，令牌既不返回浏览器也不写日志。
- 「记住密码」会把面板密码**明文**存进上面那个本机配置文件（仅本机，0600）。不勾则只保留令牌 / 会话。
- `POST /sites` 换掉某站 `baseUrl` 时会清掉该站的旧令牌，避免把 A 站的 token 发给 B 站。

## 开发

- **浏览器半部**（角标 UI）：改完 `lib/client.js` 由 `dsh-client-hmr` 每 500ms stat 入口产物，自动热重载，不用刷新页面。
- **宿主半部**（抓取/续期/HTTP 接口）：默认要重启 dsh。想改完即生效，在 profile patch 里给 `hmr` 打开源码目录监听：

  ```yaml
  - id: hmr
    config:
      root:
        - '<插件源码绝对路径>'
  ```

## 文件

- `index.js` — 宿主半部：配置读写与迁移、方言探测、JWT 到期预判、令牌续期、多站点调度、`/relay-balance` 路由。
- `lib/client.js` — 浏览器半部：`shell.overlay` 席位的角标与面板。
- `cordis.patch.yml` — bundle 挂载声明。

## License

MIT
