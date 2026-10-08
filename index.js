// 中转站余额角标（宿主半部）— 多站点配置读写 / 凭证续期 / 余额抓取 / HTTP 接口
//
// 数据通道：HTTP（/relay-balance 前缀路由），浏览器半部通过 fetch 调用。
// 上游（中转站面板 API，默认 https://sub.0000.icu/api/v1）：
//   GET  /user/profile   Authorization: Bearer <access_token>
//                        → { code: 0, data: { ...user, balance, concurrency, ... } }
//   POST /auth/refresh   { refresh_token }
//                        → { code: 0, data: { access_token, refresh_token, expires_in } }
//   POST /auth/login     { email, password, turnstile_token?, tencent_captcha_ticket? }
//                        → { code: 0, data: { access_token, refresh_token, expires_in, user } }
//                           或 { code: 0, data: { requires_2fa: true, temp_token } } → POST /auth/login/2fa
//   GET  /settings/public（无需鉴权）→ 该站登录前置条件（是否强制人机验证等）
// 多站点：每个站点独立持有凭证、独立续期、独立轮询，互不干扰；新增/删除站点不需要重启。
// 凭证不落明文日志、不回报文给浏览器；配置文件以 0600 权限写入。
// 持久化：~/.dsh/storages/dsh-relay-balance/config.json（v2 结构，v1 自动迁移）
// 热重载：profile patch 里给 hmr 打开本目录监听后，保存本文件即重载宿主半部，不必重启 dsh。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'dsh-relay-balance'
export const inject = ['webServer', 'dshHomePath']

/** 新增站点时的默认面板地址（面板里可改） */
const DEFAULT_BASE_URL = 'https://sub.0000.icu'
/** 默认自动刷新间隔（ms） */
const DEFAULT_INTERVAL_MS = 60_000
/** 间隔下限：避免把上游面板打成限流 */
const MIN_INTERVAL_MS = 15_000
/** 间隔上限：一天 */
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 单次上游请求超时（ms） */
const REQUEST_TIMEOUT_MS = 15_000
/** 令牌剩余寿命低于该值就提前续期（ms） */
const TOKEN_SKEW_MS = 120_000
/** 调度器心跳（ms）：只决定「什么时候该去问一次」，与真实刷新间隔解耦 */
const TICK_MS = 5_000
/** 站点数量上限：角标是给人瞄一眼的，不是监控大盘 */
const MAX_SITES = 12
/** 首次拉取按站点索引错开（ms），避免多站点同时打满上游 */
const STAGGER_MS = 400

/** 允许的角标位置 */
const CORNERS = ['br', 'bl', 'tr', 'tl']
/** 角标显示模式：合计 / 当前站 / 轮播 */
const BADGE_MODES = ['total', 'active', 'rotate']

/** 凭证来源：password = 用账号密码向服务端登录；token = 手动粘贴面板令牌 */
const LOGIN_MODES = ['password', 'token']
/** sub2api 方言的上游端点（均挂在 /api/v1 下） */
const PUBLIC_SETTINGS_PATH = '/settings/public'
const LOGIN_PATH = '/auth/login'
const LOGIN_2FA_PATH = '/auth/login/2fa'

/**
 * 面板方言。两派中转站面板的 API 形状完全不同，插件必须分派：
 * - sub2api：API 根是 {站点根}/api/v1；登录 POST /auth/login {email,password} 换 Bearer 令牌
 * - newapi（new-api / one-api 及其分支）：API 根就是站点根；登录
 *   POST /api/user/login?turnstile= {username,password} 直接返回 Bearer 令牌
 *   （响应体的 data 就是认证包 {access_token, token_type, access_expires_at, session, user}）；
 *   余额看 GET /api/user/self 的 quota 字段（额度单位，要按 quota_per_unit 折算）；
 *   令牌过期用 POST /api/user/auth/refresh 原地轮换：凭证是登录/轮换时下发的 new_api_refresh cookie
 *   （实测只带 X-Auth-Session 头会被上游 401 拒），换成功会下发新 cookie，必须跟着更新。
 *   旧版 new-api 没有这套认证包，会退回下发 session Cookie —— 这条兜底保留但不作主路径。
 */
const FLAVORS = ['sub2api', 'newapi']
const DEFAULT_FLAVOR = 'sub2api'
const NEWAPI_STATUS_PATH = '/api/status'
const NEWAPI_LOGIN_PATH = '/api/user/login'
const NEWAPI_LOGIN_2FA_PATH = '/api/user/login/2fa'
const NEWAPI_SELF_PATH = '/api/user/self'
const NEWAPI_REFRESH_PATH = '/api/user/auth/refresh'
/** 旧版 new-api 的长期令牌端点（新版前端已不用，仅作兜底） */
const NEWAPI_TOKEN_PATH = '/api/user/token'
/** new-api 没探到 quota_per_unit 时的兜底换算率（上游默认 500000 额度 = 1 USD） */
const NEWAPI_FALLBACK_QUOTA_PER_UNIT = 500_000
/** new-api 的 access token 只活 900 秒；剩余不足这个秒数就先轮换，别等过期后多吃一次 401 */
const NEWAPI_REFRESH_MARGIN_SEC = 120

const CONFIG_VERSION = 3

const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  enabled: true,
  intervalMs: DEFAULT_INTERVAL_MS,
  corner: 'br',
  showSubscriptions: true,
  badgeMode: 'total',
  activeSiteId: null,
  sites: [],
}

function clampInterval(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)))
}

/** 去掉用户可能连带复制的 `Bearer ` 前缀与首尾空白/引号 */
function cleanToken(value) {
  return String(value ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim()
}

/**
 * 会话 Cookie 归一：new-api 的续期凭证是 new_api_refresh cookie，
 * 用户从 DevTools 里往往只复制到值（没有 `名字=`），而请求头必须是完整形式，
 * 所以不带 `=` 时补上 cookie 名。
 */
function cleanCookie(value) {
  const raw = String(value ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
  if (!raw) return ''
  return raw.includes('=') ? raw : 'new_api_refresh=' + raw
}

/** 面板 API 根：sub2api 挂在 /api/v1 下，new-api 的 API 根就是站点根 */
function apiBaseOf(baseUrl, flavor = DEFAULT_FLAVOR) {
  const base = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  if (flavor === 'newapi') return base.replace(/\/api\/v1$/i, '')
  return /\/api\/v1$/i.test(base) ? base : base + '/api/v1'
}

/** 站点根（用于展示与跳转） */
function siteRootOf(baseUrl, flavor = DEFAULT_FLAVOR) {
  return apiBaseOf(baseUrl, flavor).replace(/\/api\/v1$/i, '')
}

/** 从地址里取主机名，作为站点默认名称 */
function hostOf(baseUrl) {
  const root = siteRootOf(baseUrl)
  try {
    return new URL(root).host || root
  } catch {
    return root.replace(/^https?:\/\//i, '')
  }
}

function isValidBaseUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function newSiteId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 解出 JWT 的 exp（秒）；非 JWT / 解不出返回 0 */
function jwtExp(token) {
  const parts = String(token || '').split('.')
  if (parts.length < 2) return 0
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    const exp = Number(json && json.exp)
    return Number.isFinite(exp) ? exp : 0
  } catch {
    return 0
  }
}

function normalizeSite(raw) {
  if (!raw || typeof raw !== 'object') return null
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : ''
  if (!baseUrl) return null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newSiteId(),
    name: (name || hostOf(baseUrl)).slice(0, 40),
    baseUrl,
    accessToken: cleanToken(raw.accessToken),
    refreshToken: cleanToken(raw.refreshToken),
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    loginMode: LOGIN_MODES.includes(raw.loginMode) ? raw.loginMode : 'token',
    flavor: FLAVORS.includes(raw.flavor) ? raw.flavor : DEFAULT_FLAVOR,
    loginEmail: typeof raw.loginEmail === 'string' ? raw.loginEmail.trim() : '',
    // new-api 方言：登录返回 access_token + session.sid（续期用 X-Auth-Session）；
    // 只有旧版面板才下发 session Cookie，这条兜底保留
    sessionCookie: typeof raw.sessionCookie === 'string' ? cleanCookie(raw.sessionCookie) : '',
    sessionSid: typeof raw.sessionSid === 'string' ? raw.sessionSid.trim() : '',
    accessExpiresAt:
      typeof raw.accessExpiresAt === 'number' && Number.isFinite(raw.accessExpiresAt) ? raw.accessExpiresAt : null,
    // 密码只在用户勾了「记住密码」时才有值；不记住时登录成功即丢弃，不落盘
    password: typeof raw.password === 'string' ? raw.password : '',
    rememberPassword: raw.rememberPassword !== false,
    // 站点登录前置条件缓存（/settings/public 探测结果），仅用于表单提示
    capabilities: raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : null,
  }
}

/**
 * v1（顶层单站点 baseUrl/accessToken）→ v2（sites 数组）。
 * 迁移只在没有 sites 数组时发生，用户主动删空站点不会被旧字段复活。
 */
function normalizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG, sites: [] }
  if (!raw || typeof raw !== 'object') return out

  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (raw.intervalMs !== undefined) out.intervalMs = clampInterval(raw.intervalMs)
  if (typeof raw.corner === 'string' && CORNERS.includes(raw.corner)) out.corner = raw.corner
  if (typeof raw.showSubscriptions === 'boolean') out.showSubscriptions = raw.showSubscriptions
  if (typeof raw.badgeMode === 'string' && BADGE_MODES.includes(raw.badgeMode)) out.badgeMode = raw.badgeMode

  const list = Array.isArray(raw.sites) ? raw.sites : []
  for (const item of list) {
    if (out.sites.length >= MAX_SITES) break
    const site = normalizeSite(item)
    if (site) out.sites.push(site)
  }

  const legacyBase = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
  if (out.sites.length === 0 && legacyBase) {
    const site = normalizeSite({
      baseUrl: legacyBase,
      accessToken: raw.accessToken,
      refreshToken: raw.refreshToken,
      name: hostOf(legacyBase),
    })
    if (site) out.sites.push(site)
  }

  // v2 → v3：站点新增「登录方式」。老站点按有没有令牌推断来源，升级后行为不变。
  if (raw.version === 2) {
    for (const site of out.sites) {
      site.loginMode = site.accessToken || site.refreshToken ? 'token' : 'password'
    }
  }

  const ids = new Set(out.sites.map((site) => site.id))
  out.activeSiteId =
    typeof raw.activeSiteId === 'string' && ids.has(raw.activeSiteId) ? raw.activeSiteId : out.sites[0]?.id ?? null
  return out
}

/** 落盘前裁掉不该持久化的字段（站点顺序与凭证保留） */
function serializableConfig(config) {
  return {
    version: CONFIG_VERSION,
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    corner: config.corner,
    showSubscriptions: config.showSubscriptions,
    badgeMode: config.badgeMode,
    activeSiteId: config.activeSiteId,
    sites: config.sites.map((site) => ({
      id: site.id,
      name: site.name,
      baseUrl: site.baseUrl,
      accessToken: site.accessToken,
      refreshToken: site.refreshToken,
      enabled: site.enabled,
      loginMode: site.loginMode,
      flavor: site.flavor,
      loginEmail: site.loginEmail,
      password: site.password,
      sessionCookie: site.sessionCookie,
      sessionSid: site.sessionSid,
      accessExpiresAt: site.accessExpiresAt,
      rememberPassword: site.rememberPassword,
      capabilities: site.capabilities,
    })),
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * 中转站面板统一响应包 `{ code, message, data }` → `{ ok, data | message }`。
 * 少数端点直接返回裸对象，这里一并容忍。
 */
function unwrapEnvelope(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: '上游响应不是 JSON 对象' }
  if ('code' in body) {
    if (body.code === 0) return { ok: true, data: body.data === undefined ? null : body.data }
    return { ok: false, message: String(body.message || `上游错误码 ${body.code}`) }
  }
  return { ok: true, data: body }
}

/**
 * new-api 响应包 `{ success, message, code, data }` → `{ ok, data | message }`。
 * 成功时 data 才是真载荷，要像 sub2api 那样剥一层，否则余额字段永远取不到。
 */
function unwrapNewApi(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: '上游响应不是 JSON 对象' }
  if (body.success === false) {
    return {
      ok: false,
      message: typeof body.message === 'string' && body.message ? body.message : '上游返回失败',
      reason: typeof body.code === 'string' ? body.code : '',
    }
  }
  return { ok: true, data: body.data === undefined ? body : body.data }
}

/** 取响应的 Set-Cookie 列表（三条来源合并去重，任一来源为空都不影响其它来源） */
function readSetCookie(res) {
  const found = []
  const push = (value) => {
    if (Array.isArray(value)) for (const item of value) if (item) found.push(String(item))
    else if (value) found.push(String(value))
  }
  try {
    if (typeof res.headers.getSetCookie === 'function') push(res.headers.getSetCookie())
  } catch {
    // 继续走下面的兜底
  }
  try {
    const raw = typeof res.headers.raw === 'function' ? res.headers.raw() : null
    if (raw) push(raw['set-cookie'])
  } catch {
    // 继续走下面的兜底
  }
  try {
    push(res.headers.get('set-cookie'))
  } catch {
    // 三家都没有就是空
  }
  return [...new Set(found)]
}

/** 从 Set-Cookie 列表里摘出 `name=value`，供后续请求带 Cookie 用 */
function pickCookie(list, name) {
  for (const item of list || []) {
    const matched = /^([^=;\s]+)=([^;]*)/.exec(String(item).trim())
    if (matched && matched[1] === name) return matched[1] + '=' + matched[2]
  }
  return ''
}

/**
 * 上游失败响应 → 归一化错误对象。
 * 面板错误包是 `{code, message, reason}`，但 reason 不一定有；两者都缺时退回状态码。
 */
function upstreamFailure(res) {
  const body = res.body
  if (!body || typeof body !== 'object') {
    return { status: res.status, message: `HTTP ${res.status}`, reason: '' }
  }
  return {
    status: res.status,
    message: typeof body.message === 'string' && body.message ? body.message : `HTTP ${res.status}`,
    reason: typeof body.reason === 'string' ? body.reason : '',
  }
}

/** 把上游黑话翻译成「下一步该干什么」，而不是原样甩给用户 */
function loginHint(err) {
  if (err.reason === 'TURNSTILE_VERIFICATION_FAILED' || /turnstile/i.test(err.message)) {
    return '该站点启用了 Cloudflare 人机验证，服务端账号密码登录会被上游直接拒绝。请在该站点面板登录后，改用「手动令牌」方式。'
  }
  if (err.reason === 'AUTH_UNAUTHORIZED') return '该站点的访问令牌无效或已过期，请重新登录。'
  if (/username or password is incorrect|user has been banned/i.test(err.message)) {
    return '账号或密码不正确，或该账号已被封禁。'
  }
  if (err.reason === 'INVALID_CREDENTIALS' || err.status === 401) return '账号或密码不正确。'
  if (err.status === 403) return '账号被禁用或未激活。'
  if (err.status === 429) return '触发上游限流，稍后再试。'
  if (err.status >= 500) return '上游服务异常，稍后再试。'
  return ''
}

/** 从任意形状里尽力取出「订阅」摘要；取不出就返回 null（宁可不显示也不显示错的） */
function extractSubscriptions(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.list)
        ? data.list
        : Array.isArray(data?.subscriptions)
          ? data.subscriptions
          : null
  if (!list) return null
  const active = list.filter((item) => item && (item.status === undefined || item.status === 'active'))
  let expiresAt = null
  for (const item of active) {
    const raw = item?.expires_at ?? item?.expire_at ?? item?.end_at
    if (!raw) continue
    const ts = Date.parse(String(raw))
    if (!Number.isFinite(ts)) continue
    if (expiresAt === null || ts > expiresAt) expiresAt = ts
  }
  return {
    total: list.length,
    active: active.length,
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  }
}

function idleSiteState() {
  return {
    status: 'idle',
    balance: null,
    siteName: null,
    account: null,
    subscriptions: null,
    updatedAt: null,
    error: null,
  }
}

/**
 * 占住自己的路由。
 * webserver 的 register() 返回 disposer 但不会自动随 fiber 注销，且同名路由重复注册会直接抛错。
 * 0.1.x 把注册放在 fiber 之外，热重载/停用后会留下孤儿路由；这里先清掉同名残留再注册，
 * 于是「热重载」「停用后重新启用」都能正常挂上。字段名对不上时退回普通注册，不改变原有行为。
 */
function claimRoute(ctx, spec) {
  const table = ctx.webServer?.[spec.kind === 'exact' ? 'exact' : 'prefixes']
  if (table && typeof table.delete === 'function' && table.has(spec.path)) table.delete(spec.path)
  return ctx.webServer.register(spec)
}

export function apply(ctx) {
  const configPath = ctx.dshHomePath('storages', 'dsh-relay-balance', 'config.json')

  const rawConfig = loadConfig()
  let config = normalizeConfig(rawConfig)

  /** 站点状态：id → 状态对象 */
  const states = new Map()
  /** 站点在途请求：id → Promise（并发调用共享同一次） */
  const inFlight = new Map()
  /** 站点下次到期时间：id → epoch ms */
  const nextAt = new Map()

  for (const site of config.sites) states.set(site.id, idleSiteState())

  function loadConfig() {
    try {
      if (!existsSync(configPath)) return null
      return JSON.parse(readFileSync(configPath, 'utf8'))
    } catch (err) {
      console.warn('[relay-balance] 配置读取失败，回退默认值：' + err.message)
      return null
    }
  }

  function saveConfig() {
    try {
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, JSON.stringify(serializableConfig(config), null, 2) + '\n', { mode: 0o600 })
    } catch (err) {
      console.warn('[relay-balance] 配置写入失败：' + err.message)
    }
  }

  // v1 或首次运行：立刻按 v2 结构落盘，避免下次启动重复迁移
  if (!rawConfig || rawConfig.version !== CONFIG_VERSION) saveConfig()

  function siteById(id) {
    return config.sites.find((site) => site.id === id) ?? null
  }

  function isUsable(site) {
    return Boolean(
      site.enabled && (site.accessToken || site.refreshToken || site.sessionCookie || site.sessionSid),
    )
  }

  function stateOf(site) {
    let state = states.get(site.id)
    if (!state) {
      state = idleSiteState()
      states.set(site.id, state)
    }
    return state
  }

  /**
   * 带超时的上游请求；返回状态码 + 已解析响应体（解析失败为 null）+ Set-Cookie 列表。
   * site 只用到 baseUrl 与 flavor，探测阶段可以直接传临时对象。
   */
  async function apiRequest(site, path, { method = 'GET', token, body, cookie, sessionSid } = {}) {
    const headers = { Accept: 'application/json' }
    if (token) headers.Authorization = 'Bearer ' + token
    if (cookie) headers.Cookie = cookie
    if (sessionSid) headers['X-Auth-Session'] = sessionSid
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(apiBaseOf(site.baseUrl, site.flavor) + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    return { status: res.status, ok: res.ok, body: parsed, setCookie: readSetCookie(res) }
  }

  /** GET /settings/public：无需鉴权，用来判断该站能不能走服务端密码登录 */
  async function fetchPublicSettings(baseUrl) {
    try {
      const res = await apiRequest({ baseUrl }, PUBLIC_SETTINGS_PATH, { method: 'GET' })
      if (!res.ok) return null
      const unwrapped = unwrapEnvelope(res.body)
      const data = unwrapped.ok ? unwrapped.data : res.body
      if (!data || typeof data !== 'object') return null
      return {
        turnstileEnabled: data.turnstile_enabled === true,
        turnstileSiteKey: typeof data.turnstile_site_key === 'string' ? data.turnstile_site_key : '',
        totpEnabled: data.totp_enabled === true,
        passkeyEnabled: data.passkey_enabled === true,
        loginAgreementEnabled: data.login_agreement_enabled === true,
        passwordResetEnabled: data.password_reset_enabled === true,
        probedAt: new Date().toISOString(),
      }
    } catch {
      return null
    }
  }

  /**
   * 探测面板方言与登录前置条件。先按 sub2api 试 /api/v1/settings/public，
   * 不成立再按 new-api 试 /api/status；两个都不像就返回 null（维持旧行为）。
   */
  async function probePanel(baseUrl) {
    const settings = await fetchPublicSettings(baseUrl)
    if (settings) return { flavor: 'sub2api', capabilities: settings }

    try {
      const res = await apiRequest({ baseUrl, flavor: 'newapi' }, NEWAPI_STATUS_PATH, { method: 'GET' })
      const body = res.body && typeof res.body === 'object' ? res.body : null
      const data = body && body.data && typeof body.data === 'object' ? body.data : null
      if (
        res.ok &&
        body &&
        body.success === true &&
        data &&
        (data.version || data.system_name || data.quota_per_unit !== undefined)
      ) {
        const quotaPerUnit = Number(data.quota_per_unit)
        return {
          flavor: 'newapi',
          capabilities: {
            systemName: typeof data.system_name === 'string' ? data.system_name : '',
            version: typeof data.version === 'string' ? data.version : '',
            turnstileEnabled: data.turnstile_check === true,
            turnstileSiteKey: typeof data.turnstile_site_key === 'string' ? data.turnstile_site_key : '',
            passwordLoginEnabled: data.password_login_enabled !== false,
            passkeyEnabled: data.passkey_login === true,
            quotaPerUnit: Number.isFinite(quotaPerUnit) && quotaPerUnit > 0 ? quotaPerUnit : 0,
            quotaDisplayType: typeof data.quota_display_type === 'string' ? data.quota_display_type : '',
            usdExchangeRate: Number.isFinite(Number(data.usd_exchange_rate)) ? Number(data.usd_exchange_rate) : null,
            probedAt: new Date().toISOString(),
          },
        }
      }
    } catch {
      // 探测失败等于方言未知，交给调用方的默认值
    }
    return null
  }

  /** POST /auth/login */
  function loginRequest(baseUrl, { email, password, turnstileToken, captchaTicket }) {
    const body = { email, password }
    if (turnstileToken) body.turnstile_token = turnstileToken
    if (captchaTicket) body.tencent_captcha_ticket = captchaTicket
    return apiRequest({ baseUrl }, LOGIN_PATH, { method: 'POST', body })
  }

  /** POST /auth/login/2fa */
  function login2faRequest(baseUrl, { tempToken, code }) {
    return apiRequest({ baseUrl }, LOGIN_2FA_PATH, { method: 'POST', body: { temp_token: tempToken, code } })
  }

  /**
   * 从 new-api 的认证包里抽出插件要存的东西。
   * 新版（v1.0.0-rc.x）响应体是 `{success, message, data}`，`data` 就是认证包；
   * 旧版会直接下发 session Cookie，两者都认，谁先命中用谁。
   */
  function readNewApiAuth(body, setCookie) {
    const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : null
    const session = data && data.session && typeof data.session === 'object' ? data.session : null
    return {
      accessToken: cleanToken(data && data.access_token),
      sessionSid: typeof (session && session.sid) === 'string' ? session.sid : '',
      accessExpiresAt:
        data && typeof data.access_expires_at === 'number' && Number.isFinite(data.access_expires_at)
          ? data.access_expires_at
          : null,
      // 轮换凭证是登录/轮换时下发的 new_api_refresh cookie（实测只带 X-Auth-Session 头会被上游 401 拒），
      // 旧版面板才下发 session cookie —— 两个名字都试，优先 new_api_refresh
      sessionCookie: pickCookie(setCookie, 'new_api_refresh') || pickCookie(setCookie, 'session'),
      accountName: typeof (data && data.user && data.user.username) === 'string' ? data.user.username : '',
    }
  }

  /**
   * new-api 登录。主路径：POST /api/user/login?turnstile= {username,password}
   * → 响应体 data 里带 access_token 与 session.sid。
   * 旧版面板没有认证包，会下发 session Cookie，这条兜底保留。
   */
  async function newApiLogin(baseUrl, { username, password }) {
    const res = await apiRequest({ baseUrl, flavor: 'newapi' }, NEWAPI_LOGIN_PATH + '?turnstile=', {
      method: 'POST',
      body: { username, password },
    })
    const body = res.body && typeof res.body === 'object' ? res.body : null
    if (res.status !== 200 || !body || body.success !== true) {
      return {
        ok: false,
        status: res.status,
        message: (body && typeof body.message === 'string' && body.message) || `HTTP ${res.status}`,
        reason: body && typeof body.code === 'string' ? body.code : '',
        need2fa: Boolean(body && (body.data && body.data.requires_2fa)),
      }
    }
    const auth = readNewApiAuth(body, res.setCookie)
    if (!auth.accessToken && !auth.sessionSid && !auth.sessionCookie) {
      const shape = JSON.stringify(body).slice(0, 240)
      return {
        ok: false,
        status: res.status,
        message: `登录成功但响应里既没有 access_token、也没有 session.sid、也没有 session Cookie。上游返回：${shape}`,
        reason: 'NO_CREDENTIAL',
      }
    }
    return { ok: true, ...auth }
  }

  /**
   * new-api 令牌轮换：POST /api/user/auth/refresh，成功后原地换新令牌。
   * 凭证以 new_api_refresh cookie 为主路径（实测 cookie 单独就能换到新包，只带 X-Auth-Session 头会被 401 拒），
   * 同时也带 sid 头，兼容那些只认头的分支。
   */
  async function newApiRefresh(site) {
    if (!site.sessionCookie && !site.sessionSid) return false
    try {
      const res = await apiRequest(site, NEWAPI_REFRESH_PATH, {
        method: 'POST',
        cookie: site.sessionCookie || undefined,
        sessionSid: site.sessionSid || undefined,
      })
      if (res.status !== 200) return false
      const body = res.body && typeof res.body === 'object' ? res.body : null
      if (!body || body.success !== true) return false
      const auth = readNewApiAuth(body, res.setCookie)
      if (!auth.accessToken) return false
      site.accessToken = auth.accessToken
      if (auth.sessionSid) site.sessionSid = auth.sessionSid
      if (auth.accessExpiresAt) site.accessExpiresAt = auth.accessExpiresAt
      // 上游每次轮换都会下发新的 new_api_refresh cookie，必须跟着更新，否则下次就换不动了
      if (auth.sessionCookie) site.sessionCookie = auth.sessionCookie
      saveConfig()
      return true
    } catch {
      return false
    }
  }

  /** 重新登录的冷却表（site id → 上次尝试的毫秒时间戳），避免每 30 秒轮询都打一次登录接口 */
  const reloginAt = new Map()
  const RELOGIN_COOLDOWN_MS = 60_000

  /**
   * 轮换凭证也失效时（cookie 被上游清空、会话被别处登录顶掉）的最后一条路：
   * 用保存的账号密码重新登录一次。只有勾了「记住密码」的站点有密码可用。
   */
  async function newApiRelogin(site) {
    if (!site.loginEmail || !site.password) return false
    const last = reloginAt.get(site.id) || 0
    if (Date.now() - last < RELOGIN_COOLDOWN_MS) return false
    reloginAt.set(site.id, Date.now())
    try {
      const auth = await newApiLogin(site.baseUrl, { username: site.loginEmail, password: site.password })
      if (!auth.ok) return false
      if (auth.accessToken) site.accessToken = auth.accessToken
      if (auth.sessionSid) site.sessionSid = auth.sessionSid
      if (auth.sessionCookie) site.sessionCookie = auth.sessionCookie
      if (auth.accessExpiresAt) site.accessExpiresAt = auth.accessExpiresAt
      saveConfig()
      return true
    } catch {
      return false
    }
  }

  /**
   * 读 new-api 的 /api/user/self。退化顺序：Bearer → 用 X-Auth-Session 换新令牌重试
   * → 用保存的密码重新登录 → 退回登录时下发的 session Cookie（旧版面板）。
   * 返回 apiRequest 的原始结果，交给调用方统一按 new-api 信封解包。
   */
  async function newApiSelf(site) {
    if (!site.accessToken && !site.sessionSid && !site.sessionCookie) {
      throw new Error('未配置凭证：请用账号密码登录，或填入面板设置页的系统访问令牌')
    }
    // 令牌快到期就先换一个：new-api 的 access token 只活 900 秒，拖到过期后即使轮换凭证还在，
    // 也要先吃一次 401 才回得来
    if (site.accessToken && site.accessExpiresAt && (site.sessionCookie || site.sessionSid)) {
      const left = site.accessExpiresAt - Math.floor(Date.now() / 1000)
      if (left < NEWAPI_REFRESH_MARGIN_SEC) await newApiRefresh(site)
    }
    // 只有轮换凭证没有令牌（例如令牌已被上游清掉）时，先换一个出来
    if (!site.accessToken && (site.sessionCookie || site.sessionSid)) await newApiRefresh(site)
    if (site.accessToken) {
      let res = await apiRequest(site, NEWAPI_SELF_PATH, { token: site.accessToken })
      if (res.status === 401 && (await newApiRefresh(site))) {
        res = await apiRequest(site, NEWAPI_SELF_PATH, { token: site.accessToken })
      }
      // 轮换也救不回来（cookie 被清、会话被顶）：用保存的密码重新登录一次
      if (res.status === 401 && (await newApiRelogin(site))) {
        res = await apiRequest(site, NEWAPI_SELF_PATH, { token: site.accessToken })
      }
      if (res.status !== 401) return res
      // 令牌彻底不认了：退回 session Cookie（只有旧版面板有），没有就把 401 原样报上去
      if (site.sessionCookie) return apiRequest(site, NEWAPI_SELF_PATH, { cookie: site.sessionCookie })
      return res
    }
    if (site.sessionCookie) return apiRequest(site, NEWAPI_SELF_PATH, { cookie: site.sessionCookie })
    throw new Error('登录会话已失效：请重新用账号密码登录')
  }

  /** 用 refresh_token 换新令牌；成功即落盘 */
  async function renewTokens(site) {
    if (!site.refreshToken) return false
    try {
      const res = await apiRequest(site, '/auth/refresh', {
        method: 'POST',
        body: { refresh_token: site.refreshToken },
      })
      const unwrapped = unwrapEnvelope(res.body)
      const data = unwrapped.ok ? unwrapped.data : null
      const accessToken = cleanToken(data && data.access_token)
      if (!accessToken) return false
      site.accessToken = accessToken
      const refreshToken = cleanToken(data && data.refresh_token)
      if (refreshToken) site.refreshToken = refreshToken
      saveConfig()
      return true
    } catch (err) {
      console.warn('[relay-balance] ' + hostOf(site.baseUrl) + ' 令牌续期失败：' + err.message)
      return false
    }
  }

  /** 确保 access_token 可用（缺失或临近过期时先续期） */
  async function ensureToken(site) {
    if (!site.accessToken && !site.refreshToken) {
      throw new Error('未配置凭证：请在站点面板登录后，从浏览器 localStorage 复制 auth_token 填进来')
    }
    const exp = jwtExp(site.accessToken)
    const expiring = exp > 0 && exp * 1000 - Date.now() < TOKEN_SKEW_MS
    if (!site.accessToken || expiring) {
      const renewed = await renewTokens(site)
      if (!renewed && !site.accessToken) {
        throw new Error('access_token 已过期且 refresh_token 续期失败，请重新登录面板复制凭证')
      }
    }
  }

  /** 订阅信息是可选装饰：任何失败都只返回 null，不影响余额本身 */
  async function fetchSubscriptions(site) {
    try {
      const res = await apiRequest(site, '/subscriptions/summary', { token: site.accessToken })
      if (!res.ok) return null
      const unwrapped = unwrapEnvelope(res.body)
      if (!unwrapped.ok) return null
      return extractSubscriptions(unwrapped.data)
    } catch {
      return null
    }
  }

  /** 抓一个站点的余额并落到该站状态；并发调用共享同一个在途请求 */
  function refreshSite(site) {
    const existing = inFlight.get(site.id)
    if (existing) return existing

    const task = (async () => {
      const previous = stateOf(site)
      states.set(site.id, { ...previous, status: 'loading', error: null })
      try {
        let res
        if (site.flavor === 'newapi') {
          res = await newApiSelf(site)
        } else {
          await ensureToken(site)
          res = await apiRequest(site, '/user/profile', { token: site.accessToken })
          if (res.status === 401 && (await renewTokens(site))) {
            res = await apiRequest(site, '/user/profile', { token: site.accessToken })
          }
        }

        const unwrapped = site.flavor === 'newapi' ? unwrapNewApi(res.body) : unwrapEnvelope(res.body)
        if (!unwrapped.ok) throw new Error(unwrapped.message || `上游返回 HTTP ${res.status}`)

        const user = unwrapped.data && typeof unwrapped.data === 'object' ? unwrapped.data : {}
        // new-api 的 quota 是额度单位，必须按 quota_per_unit 折算成 USD，否则跟 sub2api 的余额没法相加
        let rawBalance
        if (site.flavor === 'newapi') {
          const quota = Number(user.quota)
          const perUnit =
            Number(site.capabilities && site.capabilities.quotaPerUnit) || NEWAPI_FALLBACK_QUOTA_PER_UNIT
          rawBalance = Number.isFinite(quota) ? quota / perUnit : null
        } else {
          rawBalance = user.balance ?? user.quota ?? user.remain_quota
        }
        const balance = Number(rawBalance)
        if (rawBalance !== undefined && rawBalance !== null && !Number.isFinite(balance)) {
          throw new Error('上游 balance 字段不是数字')
        }

        states.set(site.id, {
          status: 'ok',
          balance: rawBalance === undefined || rawBalance === null ? null : balance,
          siteName:
            typeof user.site_name === 'string'
              ? user.site_name
              : String((site.capabilities && site.capabilities.systemName) || '') || null,
          account: {
            id: user.id ?? null,
            username: user.username ?? null,
            email: user.email ?? null,
            group: user.group ?? user.group_name ?? null,
            concurrency: Number.isFinite(Number(user.concurrency)) ? Number(user.concurrency) : null,
          },
          subscriptions: config.showSubscriptions ? await fetchSubscriptions(site) : null,
          updatedAt: new Date().toISOString(),
          error: null,
        })
      } catch (err) {
        states.set(site.id, {
          ...stateOf(site),
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          updatedAt: new Date().toISOString(),
        })
      } finally {
        inFlight.delete(site.id)
        nextAt.set(site.id, Date.now() + config.intervalMs)
      }
      return stateOf(site)
    })()

    inFlight.set(site.id, task)
    return task
  }

  /** 刷新全部站点；`id` 给定时只刷一个 */
  async function refreshAll(id) {
    const targets = id ? config.sites.filter((site) => site.id === id) : config.sites
    await Promise.allSettled(targets.filter(isUsable).map((site) => refreshSite(site)))
  }

  /** 回报给浏览器的安全快照：绝不含令牌明文，只给「有没有」与到期时间 */
  function siteSnapshot(site) {
    const state = stateOf(site)
    const exp = jwtExp(site.accessToken)
    return {
      id: site.id,
      name: site.name,
      baseUrl: site.baseUrl,
      siteRoot: siteRootOf(site.baseUrl, site.flavor),
      flavor: site.flavor,
      enabled: site.enabled,
      configured: Boolean(site.accessToken || site.refreshToken || site.sessionCookie || site.sessionSid),
      hasAccessToken: Boolean(site.accessToken),
      hasRefreshToken: Boolean(site.refreshToken),
      hasSessionCookie: Boolean(site.sessionCookie),
      hasSessionSid: Boolean(site.sessionSid),
      tokenExpiresAt: exp > 0 ? new Date(exp * 1000).toISOString() : null,
      // new-api 的 access_expires_at 是 unix 秒
      accessExpiresAt:
        typeof site.accessExpiresAt === 'number' ? new Date(site.accessExpiresAt * 1000).toISOString() : null,
      loginMode: site.loginMode,
      loginEmail: site.loginEmail,
      hasPassword: Boolean(site.password),
      rememberPassword: site.rememberPassword,
      capabilities: site.capabilities,
      status: state.status,
      balance: state.balance,
      siteName: state.siteName,
      account: state.account,
      subscriptions: config.showSubscriptions ? state.subscriptions : null,
      updatedAt: state.updatedAt,
      error: state.error,
    }
  }

  function snapshot() {
    const sites = config.sites.map(siteSnapshot)

    let total = 0
    let hasTotal = false
    let configured = 0
    let ok = 0
    let error = 0
    let loading = 0
    let updatedAt = null
    for (const site of sites) {
      if (site.configured) configured += 1
      if (typeof site.balance === 'number' && Number.isFinite(site.balance)) {
        total += site.balance
        hasTotal = true
      }
      if (site.status === 'ok') ok += 1
      else if (site.status === 'error') error += 1
      else if (site.status === 'loading') loading += 1
      if (site.updatedAt && (updatedAt === null || site.updatedAt > updatedAt)) updatedAt = site.updatedAt
    }

    let status = 'idle'
    if (sites.length === 0 || configured === 0) status = 'idle'
    else if (ok === 0 && loading > 0) status = 'loading'
    else if (error > 0 && ok === 0) status = 'error'
    else if (error > 0) status = 'partial'
    else if (ok > 0) status = 'ok'
    else status = 'loading'

    return {
      status,
      totalBalance: hasTotal ? total : null,
      counts: { sites: sites.length, configured, ok, error, loading },
      sites,
      updatedAt,
      config: {
        enabled: config.enabled,
        intervalMs: config.intervalMs,
        corner: config.corner,
        showSubscriptions: config.showSubscriptions,
        badgeMode: config.badgeMode,
        activeSiteId: config.activeSiteId,
        corners: CORNERS,
        badgeModes: BADGE_MODES,
        maxSites: MAX_SITES,
        configPath,
      },
    }
  }

  /** 新增站点：地址必填，凭证可后补 */
  function addSite(input) {
    if (config.sites.length >= MAX_SITES) throw new Error(`最多只能添加 ${MAX_SITES} 个站点`)
    const baseUrl = String(input.baseUrl || '').trim()
    if (!isValidBaseUrl(baseUrl)) throw new Error('站点地址必须以 http:// 或 https:// 开头')
    const site = normalizeSite({ ...input, baseUrl })
    if (!site) throw new Error('站点信息不完整')
    if (config.sites.some((item) => item.baseUrl === site.baseUrl)) {
      throw new Error('该站点已在列表里：' + site.baseUrl)
    }
    config.sites.push(site)
    states.set(site.id, idleSiteState())
    if (!config.activeSiteId) config.activeSiteId = site.id
    return site
  }

  /** 更新站点：只覆盖显式传入的字段 */
  function updateSite(id, input) {
    const site = siteById(id)
    if (!site) throw new Error('站点不存在：' + id)
    let baseChanged = false
    if (input.baseUrl !== undefined) {
      const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '')
      if (!isValidBaseUrl(baseUrl)) throw new Error('站点地址必须以 http:// 或 https:// 开头')
      baseChanged = baseUrl !== site.baseUrl
      site.baseUrl = baseUrl
    }
    if (input.name !== undefined) {
      const name = String(input.name || '').trim()
      site.name = (name || hostOf(site.baseUrl)).slice(0, 40)
    }
    if (input.accessToken !== undefined) site.accessToken = cleanToken(input.accessToken)
    if (input.refreshToken !== undefined) site.refreshToken = cleanToken(input.refreshToken)
    if (input.sessionCookie !== undefined) site.sessionCookie = cleanCookie(input.sessionCookie)
    if (input.sessionSid !== undefined) site.sessionSid = String(input.sessionSid || '').trim()
    if (input.accessExpiresAt !== undefined) {
      site.accessExpiresAt = Number.isFinite(Number(input.accessExpiresAt)) ? Number(input.accessExpiresAt) : null
    }
    if (FLAVORS.includes(input.flavor)) site.flavor = input.flavor
    if (input.enabled !== undefined) site.enabled = Boolean(input.enabled)
    if (input.loginMode !== undefined) {
      site.loginMode = LOGIN_MODES.includes(input.loginMode) ? input.loginMode : 'token'
    }
    if (input.loginEmail !== undefined) site.loginEmail = String(input.loginEmail || '').trim()
    // 密码与令牌同款约定：不传 = 保持原值，传空字符串才清空
    if (input.password !== undefined) site.password = String(input.password || '')
    if (input.rememberPassword !== undefined) site.rememberPassword = Boolean(input.rememberPassword)
    // 换站点等于换账号：旧令牌/旧账号对新站点无意义，清掉避免拿错误凭证反复撞 401
    if (baseChanged) {
      if (input.accessToken === undefined) site.accessToken = ''
      if (input.refreshToken === undefined) site.refreshToken = ''
      if (input.sessionCookie === undefined) site.sessionCookie = ''
      if (input.sessionSid === undefined) site.sessionSid = ''
      if (input.accessExpiresAt === undefined) site.accessExpiresAt = null
      if (input.loginEmail === undefined) site.loginEmail = ''
      if (input.password === undefined) site.password = ''
      site.capabilities = null
    }
    return site
  }

  function removeSite(id) {
    const index = config.sites.findIndex((site) => site.id === id)
    if (index < 0) throw new Error('站点不存在：' + id)
    config.sites.splice(index, 1)
    states.delete(id)
    inFlight.delete(id)
    nextAt.delete(id)
    if (config.activeSiteId === id) config.activeSiteId = config.sites[0]?.id ?? null
  }

  // 定时轮询：心跳固定，真正的刷新节奏由 nextAt 控制，
  // 这样改配置、增删站点都不需要重建定时器。
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (!config.enabled) return
      const now = Date.now()
      for (const site of config.sites) {
        if (!isUsable(site)) continue
        if (now < (nextAt.get(site.id) ?? 0)) continue
        nextAt.set(site.id, now + config.intervalMs)
        void refreshSite(site)
      }
    }, TICK_MS)
    return () => clearInterval(timer)
  })

  // 启动后稍等一拍再拉首次（不跟界面首屏抢带宽），多站点按索引错开
  ctx.effect(() => {
    const timers = []
    const boot = setTimeout(() => {
      if (!config.enabled) return
      config.sites.forEach((site, index) => {
        if (!isUsable(site)) return
        timers.push(setTimeout(() => void refreshSite(site), index * STAGGER_MS))
      })
    }, 1500)
    return () => {
      clearTimeout(boot)
      for (const timer of timers) clearTimeout(timer)
    }
  })

  // 路由注册返回 disposer，必须挂到本 fiber 的 effect 上：热重载或停用插件时先注销，
  // 否则下一次 apply 会撞上 webserver 的「duplicate prefix route」而整半部起不来。
  ctx.effect(() => claimRoute(ctx, {
    kind: 'prefix',
    path: '/relay-balance',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        const route = url.pathname.replace(/\/+$/, '')

        if (req.method === 'GET' && route === '/relay-balance/state') {
          if (url.searchParams.get('refresh') === '1') await refreshAll(url.searchParams.get('id') || undefined)
          sendJson(res, 200, { ok: true, state: snapshot() })
          return
        }

        if (req.method === 'POST' && route === '/relay-balance/refresh') {
          const body = await readJsonBody(req)
          await refreshAll(body.id ? String(body.id) : undefined)
          sendJson(res, 200, { ok: true, state: snapshot() })
          return
        }

        // 全局设置（不含站点与凭证）
        if (req.method === 'POST' && route === '/relay-balance/config') {
          const body = await readJsonBody(req)
          if (body.enabled !== undefined) config.enabled = Boolean(body.enabled)
          if (body.intervalMs !== undefined) config.intervalMs = clampInterval(body.intervalMs)
          if (body.corner !== undefined) config.corner = CORNERS.includes(body.corner) ? body.corner : 'br'
          if (body.showSubscriptions !== undefined) config.showSubscriptions = Boolean(body.showSubscriptions)
          if (body.badgeMode !== undefined) {
            config.badgeMode = BADGE_MODES.includes(body.badgeMode) ? body.badgeMode : 'total'
          }
          if (body.activeSiteId !== undefined) {
            config.activeSiteId = siteById(String(body.activeSiteId)) ? String(body.activeSiteId) : config.activeSiteId
          }
          saveConfig()
          if (config.enabled) await refreshAll()
          sendJson(res, 200, { ok: true, state: snapshot() })
          return
        }

        // 站点增删改
        if (req.method === 'POST' && route === '/relay-balance/sites') {
          const body = await readJsonBody(req)
          const action = String(body.action || '')
          if (action === 'add') {
            const site = addSite(body.site || {})
            saveConfig()
            if (config.enabled && isUsable(site)) await refreshSite(site)
          } else if (action === 'update') {
            const site = updateSite(String(body.id || ''), body.site || {})
            saveConfig()
            nextAt.delete(site.id)
            if (config.enabled && isUsable(site)) await refreshSite(site)
          } else if (action === 'remove') {
            removeSite(String(body.id || ''))
            saveConfig()
          } else {
            throw new Error('未知 action：' + action)
          }
          sendJson(res, 200, { ok: true, state: snapshot() })
          return
        }

        // 站点方言与登录前置条件探测：只读上游，不落盘、不改配置
        if (req.method === 'GET' && route === '/relay-balance/settings') {
          const baseUrl = String(url.searchParams.get('baseUrl') || '').trim()
          if (!isValidBaseUrl(baseUrl)) throw new Error('站点地址必须以 http:// 或 https:// 开头')
          const probed = await probePanel(baseUrl)
          sendJson(res, 200, {
            ok: true,
            flavor: probed ? probed.flavor : null,
            capabilities: probed ? probed.capabilities : null,
          })
          return
        }

        // 账号密码登录：成功即把令牌写进该站点，之后完全复用既有的续期/轮询链路
        if (req.method === 'POST' && route === '/relay-balance/login') {
          const body = await readJsonBody(req)
          const email = String(body.email || '').trim()
          const password = String(body.password || '')
          const code = String(body.code || '').trim()
          const tempToken = cleanToken(body.tempToken)
          // 必填项按方言判：new-api 用 username、sub2api 用 email，而方言要探测之后才知道，
          // 所以两个分支各自校验，这里不能先按 sub2api 的字段名拦下来

          // 目标站点：以表单当前填写的地址为准。地址被改过就当新目标处理，
          // 免得拿旧地址去登录、却把新主机的令牌写进旧站点。
          const typed = String(body.baseUrl || '').trim().replace(/\/+$/, '')
          let site = body.id ? siteById(String(body.id)) : null
          if (site && typed && typed !== site.baseUrl) site = null
          let baseUrl = site ? site.baseUrl : typed
          if (!site) {
            if (!isValidBaseUrl(baseUrl)) throw new Error('站点地址必须以 http:// 或 https:// 开头')
            site = config.sites.find((item) => item.baseUrl === baseUrl) ?? null
          }

          const probed = await probePanel(baseUrl)
          const flavor = probed ? probed.flavor : site ? site.flavor : DEFAULT_FLAVOR
          const capabilities = probed ? probed.capabilities : null

          // new-api 方言：username/password 直登，不涉及 turnstile，也没有 2FA 中转令牌
          if (flavor === 'newapi') {
            const account = String(body.username || email).trim()
            if (!account) throw new Error('请填写账号')
            if (!password) throw new Error('请填写密码')
            const result = await newApiLogin(baseUrl, { username: account, password })
            if (!result.ok) {
              const error = { status: result.status, message: result.message, reason: result.reason || '' }
              sendJson(res, 200, { ok: false, error, hint: loginHint(error), state: snapshot() })
              return
            }
            if (!site) site = addSite({ baseUrl, name: body.name, loginMode: 'password' })
            site.flavor = 'newapi'
            site.accessToken = result.accessToken
            site.sessionSid = result.sessionSid || ''
            site.accessExpiresAt = result.accessExpiresAt ?? null
            site.sessionCookie = result.sessionCookie || ''
            site.loginMode = 'password'
            site.loginEmail = account
            site.rememberPassword = body.rememberPassword === true
            // 与「手动令牌」同款约定：不勾记住密码就不把密码落盘，但这次登录已经拿到了令牌
            site.password = body.rememberPassword === true && password ? password : ''
            if (capabilities) site.capabilities = capabilities
            saveConfig()

            nextAt.delete(site.id)
            if (config.enabled) await refreshSite(site)
            sendJson(res, 200, { ok: true, account: { username: account }, hint: '', state: snapshot() })
            return
          }

          // sub2api：邮箱 + 密码，或 2FA 中转令牌 + 验证码
          if (!email) throw new Error('请填写账号邮箱')
          if (!password && !tempToken) throw new Error('请填写密码')

          const upstream = tempToken
            ? await login2faRequest(baseUrl, { tempToken, code })
            : await loginRequest(baseUrl, {
                email,
                password,
                turnstileToken: body.turnstileToken,
                captchaTicket: body.captchaTicket,
              })

          if (!upstream.ok) {
            const error = upstreamFailure(upstream)
            sendJson(res, 200, { ok: false, error, hint: loginHint(error), state: snapshot() })
            return
          }

          const unwrapped = unwrapEnvelope(upstream.body)
          const data = unwrapped.ok ? unwrapped.data : null

          if (data && data.requires_2fa === true) {
            sendJson(res, 200, {
              ok: false,
              need2fa: true,
              tempToken: cleanToken(data.temp_token),
              hint: '该账号启用了两步验证，请输入验证器里的 6 位动态码。',
              state: snapshot(),
            })
            return
          }

          const accessToken = cleanToken(data && data.access_token)
          const refreshToken = cleanToken(data && data.refresh_token)
          if (!accessToken) {
            sendJson(res, 200, {
              ok: false,
              error: { status: upstream.status, message: '登录响应里没有 access_token', reason: 'NO_TOKEN' },
              hint: '',
              state: snapshot(),
            })
            return
          }

          if (!site) site = addSite({ baseUrl, name: body.name, loginMode: 'password' })
          site.flavor = 'sub2api'
          site.accessToken = accessToken
          if (refreshToken) site.refreshToken = refreshToken
          site.loginMode = 'password'
          site.loginEmail = email
          site.rememberPassword = body.rememberPassword === true
          // 只有勾了「记住密码」才留密码，否则只留令牌（refresh_token 可续期约 30 天）。
          // 走 2FA 那一趟请求里不带 password，别把上一趟存下的密码抹成空串。
          if (body.rememberPassword === true) {
            if (password) site.password = password
          } else {
            site.password = ''
          }
          if (capabilities) site.capabilities = capabilities
          saveConfig()

          nextAt.delete(site.id)
          if (config.enabled) await refreshSite(site)
          sendJson(res, 200, {
            ok: true,
            account: data && data.user && typeof data.user === 'object' ? data.user : null,
            hint: '',
            state: snapshot(),
          })
          return
        }

        // 用「即将保存但还没保存」的凭证试一次连通性
        if (req.method === 'POST' && route === '/relay-balance/test') {
          const body = await readJsonBody(req)
          const saved = body.id ? siteById(String(body.id)) : null
          const baseUrl = String(body.baseUrl || saved?.baseUrl || config.sites[0]?.baseUrl || DEFAULT_BASE_URL).trim()
          if (!isValidBaseUrl(baseUrl)) throw new Error('站点地址必须以 http:// 或 https:// 开头')
          const accessToken = body.accessToken !== undefined ? cleanToken(body.accessToken) : (saved?.accessToken ?? '')
          const refreshToken = body.refreshToken !== undefined ? cleanToken(body.refreshToken) : (saved?.refreshToken ?? '')

          const probed = await probePanel(baseUrl)
          const flavor = probed ? probed.flavor : saved ? saved.flavor : DEFAULT_FLAVOR

          // new-api：Bearer 打 /api/user/self，令牌过期用 X-Auth-Session 换新后重试，
          // 旧版面板还能退回 session Cookie
          if (flavor === 'newapi') {
            const token = accessToken || (saved?.accessToken ?? '')
            const sid = body.sessionSid !== undefined ? String(body.sessionSid || '').trim() : (saved?.sessionSid ?? '')
            // 会话 Cookie 也允许现传（apiling 这类开了人机验证的站点，服务端登录走不通，
            // 只能让用户从浏览器 DevTools 里把 new_api_refresh cookie 粘进来）
            const cookie =
              body.sessionCookie !== undefined
                ? cleanCookie(body.sessionCookie)
                : saved && saved.sessionCookie
                  ? saved.sessionCookie
                  : ''
            if (!token && !sid && !cookie) throw new Error('请先用账号密码登录，或填入面板设置页的系统访问令牌')
            const probe = await newApiSelf({ baseUrl, flavor, accessToken: token, sessionSid: sid, sessionCookie: cookie })
            const unwrappedNew = unwrapNewApi(probe.body)
            if (!unwrappedNew.ok) {
              sendJson(res, 200, { ok: false, message: unwrappedNew.message || `HTTP ${probe.status}` })
              return
            }
            const me = unwrappedNew.data && typeof unwrappedNew.data === 'object' ? unwrappedNew.data : {}
            const quota = Number(me.quota)
            const perUnit =
              Number(probed && probed.capabilities && probed.capabilities.quotaPerUnit) || NEWAPI_FALLBACK_QUOTA_PER_UNIT
            sendJson(res, 200, {
              ok: true,
              siteRoot: siteRootOf(baseUrl, flavor),
              name: hostOf(baseUrl),
              flavor,
              balance: Number.isFinite(quota) ? quota / perUnit : null,
              account: { username: me.username ?? null, email: me.email ?? null },
              renewed: null,
            })
            return
          }

          if (!accessToken && !refreshToken) throw new Error('请先填入 auth_token')

          let token = accessToken
          let renewed = null
          if (!token || (jwtExp(token) > 0 && jwtExp(token) * 1000 - Date.now() < TOKEN_SKEW_MS)) {
            if (!refreshToken) throw new Error('access_token 已过期，且没有 refresh_token 可用于续期')
            const res2 = await fetch(apiBaseOf(baseUrl) + '/auth/refresh', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ refresh_token: refreshToken }),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
            const text = await res2.text()
            let parsed = null
            try {
              parsed = text ? JSON.parse(text) : null
            } catch {
              parsed = null
            }
            const unwrapped = unwrapEnvelope(parsed)
            const data = unwrapped.ok ? unwrapped.data : null
            const fresh = cleanToken(data && data.access_token)
            if (!fresh) throw new Error('续期失败：' + (unwrapped.ok ? '上游未返回 access_token' : unwrapped.message))
            token = fresh
            renewed = { accessToken: fresh, refreshToken: cleanToken(data && data.refresh_token) || refreshToken }
          }

          const res2 = await fetch(apiBaseOf(baseUrl) + '/user/profile', {
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
          const text = await res2.text()
          let parsed = null
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            parsed = null
          }
          const unwrapped = unwrapEnvelope(parsed)
          if (!unwrapped.ok) {
            sendJson(res, 200, { ok: false, message: unwrapped.message || `HTTP ${res2.status}` })
            return
          }
          const user = unwrapped.data && typeof unwrapped.data === 'object' ? unwrapped.data : {}
          sendJson(res, 200, {
            ok: true,
            siteRoot: siteRootOf(baseUrl, 'sub2api'),
            name: hostOf(baseUrl),
            flavor: 'sub2api',
            balance: Number.isFinite(Number(user.balance)) ? Number(user.balance) : null,
            account: { username: user.username ?? null, email: user.email ?? null },
            renewed,
          })
          return
        }

        sendJson(res, 404, { ok: false, message: 'not found' })
      } catch (err) {
        sendJson(res, 400, { ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  console.log(
    '[relay-balance] 已挂载：' +
      (config.sites.length === 0
        ? '暂无站点（在角标面板里添加）'
        : config.sites.length + ' 个站点 · ' + config.sites.map((site) => hostOf(site.baseUrl)).join(', ')),
  )
}
