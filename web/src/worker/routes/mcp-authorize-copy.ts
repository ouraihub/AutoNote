import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { AppLocale } from '@shared/types'
import type { AppBindings } from '../env'

export const LOCALE_COOKIE = 'autonote_mcp_locale'
export const LOCALE_QUERY = 'autonote_lang'

export function authorizationCopy(locale: AppLocale) {
  if (locale === 'zh-CN') {
    return {
      header: 'MCP',
      authorization: '授权',
      switchLabel: 'EN',
      switchAria: '切换为英文',
      mcpClient: 'MCP 客户端',
      accessTitle: (clientName: string) => `${clientName} 请求访问`,
      signedInAs: '已登录为 ',
      accountOnly: '。仅可访问此账户的笔记。',
      permissions: '权限',
      readTitle: '读取与搜索笔记',
      readDetail: '必需。连接的 AI 客户端只会收到工具选中的笔记内容。',
      readRequiredAria: '读取与搜索笔记为必需权限',
      writeTitle: '\u4fee\u6539\u7b14\u8bb0\u5e93',
      writeDetail:
        '\u53ef\u4fee\u6539\u7b14\u8bb0\u3001\u76ee\u5f55\u3001\u6807\
\u7b7e\u3001\u5c5e\u6027\u548c\u9644\u4ef6\uff0c\u4e5f\u53ef\u6309\u660e\
\u786e\u8bf7\u6c42\u521b\u5efa\u5171\u4eab\u94fe\u63a5\u6216\u8fd0\u884c\
\u5df2\u914d\u7f6e\u7684\u5907\u4efd\uff1b\u5199\u5165\u5305\u542b\u51b2\
\u7a81\u4fdd\u62a4\u548c\u5e42\u7b49\u952e\u3002',
      trashTitle: '移入回收站',
      trashDetail: '仅软删除；MCP 不提供永久清除功能。',
      privacy: '隐私',
      privacyDetail: (clientName: string) =>
        `Cloudflare 托管静态加密的服务数据。只有工具读取笔记时，内容才会发送给 ${clientName}，之后由该客户端的隐私\
政策约束。`,
      cancel: '取消',
      allowAccess: '允许访问',
      signInTitle: (clientName: string) => `登录以授权 ${clientName}`,
      passwordOnly: '密码只会发送到当前 AutoNote 部署。',
      autonoteAccount: 'AutoNote 账户',
      username: '用户名',
      password: '密码',
      signInContinue: '登录并继续',
      needAccount: '还没有账户？请先在另一个标签页打开 AutoNote。',
      signInFailed: '登录失败',
      authorizationFailed: '授权失败',
      openAutoNote: '打开 AutoNote',
      mcpDisabled: 'MCP 已在 AutoNote 设置中停用。',
      unknownClient: '未知的 OAuth 客户端。',
      sessionExpired: 'AutoNote 会话已过期，请登录后重试。',
    }
  }
  return {
    header: 'MCP',
    authorization: 'Authorization',
    switchLabel: '中文',
    switchAria: 'Switch to Chinese',
    mcpClient: 'MCP client',
    accessTitle: (clientName: string) => `${clientName} wants access`,
    signedInAs: 'Signed in as ',
    accountOnly: '. Only this account’s notes are available.',
    permissions: 'Permissions',
    readTitle: 'Read and search notes',
    readDetail:
      'Required. Selected note text is returned to the connected AI client.',
    readRequiredAria: 'Read and search notes is required',
    writeTitle: 'Modify the note library',
    writeDetail:
      'May modify notes, folders, tags, properties, and attachments, and m\
ay create shares or run configured backups when explicitly requested. Writ\
es use conflict protection and idempotency keys.',
    trashTitle: 'Move notes to trash',
    trashDetail:
      'Soft-delete only. Permanent purge is not exposed through MCP.',
    privacy: 'Privacy',
    privacyDetail: (clientName: string) =>
      `Cloudflare hosts the encrypted-at-rest service data. Note content i\
s sent to ${clientName} only when a tool reads it, then follows that clien\
t’s privacy policy.`,
    cancel: 'Cancel',
    allowAccess: 'Allow access',
    signInTitle: (clientName: string) => `Sign in to authorize ${clientName}`,
    passwordOnly: 'Your password is sent only to this AutoNote deployment.',
    autonoteAccount: 'AutoNote account',
    username: 'Username',
    password: 'Password',
    signInContinue: 'Sign in and continue',
    needAccount: 'Need an account? Open AutoNote in another tab first.',
    signInFailed: 'Sign-in failed',
    authorizationFailed: 'Authorization failed',
    openAutoNote: 'Open AutoNote',
    mcpDisabled: 'MCP is disabled in AutoNote settings.',
    unknownClient: 'Unknown OAuth client.',
    sessionExpired: 'Your AutoNote session expired. Sign in and try again.',
  }
}

export function applyLocalePreference(
  c: Context<AppBindings>,
): Response | null {
  const url = new URL(c.req.url)
  const requested = url.searchParams.get(LOCALE_QUERY)
  if (requested === null) return null
  url.searchParams.delete(LOCALE_QUERY)
  if (isAppLocale(requested)) {
    setCookie(c, LOCALE_COOKIE, requested, {
      path: '/authorize',
      sameSite: 'Lax',
      secure: url.protocol === 'https:',
      maxAge: 365 * 24 * 60 * 60,
    })
  }
  return c.redirect(url.toString(), 302)
}

export function authorizationLocale(c: Context<AppBindings>): AppLocale {
  const stored = getCookie(c, LOCALE_COOKIE)
  if (isAppLocale(stored)) return stored
  const user = c.get('user')
  if (user) {
    try {
      const settings = JSON.parse(user.settingsRaw) as {
        appearance?: { language?: unknown }
      }
      if (isAppLocale(settings.appearance?.language))
        return settings.appearance.language
    } catch {}
  }
  return c.req.header('Accept-Language')?.toLowerCase().startsWith('en')
    ? 'en-US'
    : 'zh-CN'
}

export function languageSwitchUrl(
  currentUrl: string,
  locale: AppLocale,
): string {
  const url = new URL(currentUrl)
  url.searchParams.set(LOCALE_QUERY, locale === 'zh-CN' ? 'en-US' : 'zh-CN')
  return url.pathname + url.search
}

function isAppLocale(value: unknown): value is AppLocale {
  return value === 'zh-CN' || value === 'en-US'
}
