import { LIMITS } from '@shared/constants'
import type { AppLocale } from '@shared/types'
import type {
  AuthRequest,
  ClientInfo,
} from '@cloudflare/workers-oauth-provider'
import { MCP_SCOPES } from '../mcp/settings'
import { authorizationCopy, languageSwitchUrl } from './mcp-authorize-copy'
import { escapeHtml, logoMark } from './mcp-authorize-utils'

export function consentPage(input: {
  client: ClientInfo
  request: AuthRequest
  csrf: string
  userName: string
  action: string
  locale: AppLocale
  currentUrl: string
}): string {
  const requested = new Set(
    input.request.scope.length ? input.request.scope : [MCP_SCOPES.read],
  )
  const wantsWrite = requested.has(MCP_SCOPES.write)
  const wantsTrash = requested.has(MCP_SCOPES.trash)
  const copy = authorizationCopy(input.locale)
  const clientName = escapeHtml(input.client.clientName || copy.mcpClient)
  return page(
    `
    <div class="panel-body">
      <section class="request-card">
        <span class="brand-mark">${logoMark()}</span>
        <div class="request-copy">
          <div class="title-line">
            <h1>${copy.accessTitle(clientName)}</h1>
            <span class="badge">OAuth</span>
          </div>
          <p>${copy.signedInAs}<strong class="account">\
${escapeHtml(input.userName)}</strong>${copy.accountOnly}</p>
        </div>
      </section>
      <form method="post" action="${escapeHtml(input.action)}">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
        <section class="form-section" aria-labelledby="permissions-title">
          <h2 id="permissions-title">${copy.permissions}</h2>
          <div class="settings-list">
            <label class="setting-row fixed">
              <span class="setting-copy"><strong>${copy.readTitle}</strong><\
small>${copy.readDetail}</small></span>
              <input class="switch" type="checkbox" checked disabled aria-la\
bel="${copy.readRequiredAria}">
            </label>
            <input type="hidden" name="scope" value="${MCP_SCOPES.read}">
            \
${
  wantsWrite
    ? permission(MCP_SCOPES.write, copy.writeTitle, copy.writeDetail, true)
    : ''
}
            \
${
  wantsTrash
    ? permission(MCP_SCOPES.trash, copy.trashTitle, copy.trashDetail, false)
    : ''
}
          </div>
        </section>
        <section class="form-section" aria-labelledby="privacy-title">
          <h2 id="privacy-title">${copy.privacy}</h2>
          <div class="privacy-row">
            <span class="privacy-icon" aria-hidden="true"><svg viewBox="0 0 \
24 24"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"></path>\
<path d="m9 12 2 2 4-4"></path></svg></span>
            <p>${copy.privacyDetail(clientName)}</p>
          </div>
        </section>
        <div class="actions">
          <button class="secondary" name="decision" value="deny">\
${copy.cancel}</button>
          <button class="primary" name="decision" value="approve">\
${copy.allowAccess}</button>
        </div>
      </form>
    </div>`,
    input.locale,
    input.currentUrl,
  )
}

export function permission(
  scope: string,
  title: string,
  detail: string,
  checked: boolean,
): string {
  return `<label class="setting-row"><span class="setting-copy"><strong>\
${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span><inp\
ut class="switch" type="checkbox" name="scope" value="${escapeHtml(scope)}" \
aria-label="${escapeHtml(title)}" ${checked ? 'checked' : ''}></label>`
}

export function loginPage(
  clientName: string,
  locale: AppLocale,
  currentUrl: string,
): string {
  const copy = authorizationCopy(locale)
  return page(
    `
    <div class="panel-body">
      <section class="request-card">
        <span class="brand-mark">${logoMark()}</span>
        <div class="request-copy">
          <h1>${copy.signInTitle(escapeHtml(clientName))}</h1>
          <p>${copy.passwordOnly}</p>
        </div>
      </section>
      <form id="login" class="login-form">
        <section class="form-section" aria-labelledby="account-title">
          <h2 id="account-title">${copy.autonoteAccount}</h2>
          <label class="field"><span>${copy.username}</span><input name="use\
rname" autocomplete="username" maxlength="32" required autofocus></label>
          <label class="field"><span>${copy.password}</span><input name="pas\
sword" type="password" autocomplete="current-password" maxlength="\
${LIMITS.passwordMaxLength}" required></label>
        </section>
        <p id="error" class="error" role="alert"></p>
        <button class="primary wide" type="submit">${copy.signInContinue}</b\
utton>
      </form>
      <p class="foot">${copy.needAccount}</p>
    </div>
    <script>
      document.getElementById('login').addEventListener('submit', async (eve\
nt) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const button = event.currentTarget.querySelector('button');
        const error = document.getElementById('error');
        button.disabled = true; error.textContent = '';
        try {
          const response = await fetch('/api/auth/login', {
            method: 'POST', credentials: 'same-origin',
            headers: {'Content-Type':'application/json','X-AutoNote-Client':\
'1'},
            body: JSON.stringify({username: form.get('username'), password: \
form.get('password')})
          });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(body?.error?.message || \
${JSON.stringify(copy.signInFailed)});
          }
          location.reload();
        } catch (reason) { error.textContent = reason.message || \
${JSON.stringify(copy.signInFailed)}; button.disabled = false; }
      });
    </script>`,
    locale,
    currentUrl,
  )
}

export function errorPage(
  message: string,
  locale: AppLocale,
  currentUrl: string,
): string {
  const copy = authorizationCopy(locale)
  return page(
    `
    <div class="panel-body">
      <section class="request-card">
        <span class="brand-mark">${logoMark()}</span>
        <div class="request-copy"><h1>${copy.authorizationFailed}</h1><p>\
${escapeHtml(message)}</p></div>
      </section>
      <div class="actions"><a class="primary link" href="/">\
${copy.openAutoNote}</a></div>
    </div>`,
    locale,
    currentUrl,
  )
}

const AUTH_STYLE = [
  '\n    :root{color-scheme:light;--bg-sunken:#f1efe9;--bg-base:#f7f5f1;',
  '--bg-overlay:#fff;--bg-inset:oklch(96.8% .005 90);--bg-hover:oklch(2',
  '0% .01 265/4%);--border-subtle:oklch(20% .01 265/7%);--border-defaul',
  't:oklch(20% .01 265/11%);--border-strong:oklch(20% .01 265/17%);--te',
  'xt-primary:oklch(21% .01 265);--text-secondary:oklch(44% .01 265);--',
  'text-tertiary:oklch(58% .009 265);--text-quaternary:oklch(70% .007 2',
  '65);--accent:oklch(54% .15 30);--accent-hover:oklch(48.5% .155 30);-',
  '-accent-contrast:oklch(99% 0 0);--accent-soft:color-mix(in oklab,var',
  '(--accent) 14%,transparent);--accent-ring:color-mix(in oklab,var(--a',
  'ccent) 34%,transparent);--brand-accent:#bb4430;--danger:oklch(64% .1',
  '9 22);--shadow-modal:0 0 0 1px oklch(20% .01 265/7%),0 8px 16px -4px',
  ' oklch(20% .01 265/8%),0 24px 48px -12px oklch(20% .01 265/16%)}\n   ',
  ' *{box-sizing:border-box}html{min-height:100%;background:var(--bg-su',
  'nken)}body{min-height:100vh;min-height:100dvh;margin:0;display:grid;',
  'place-items:center;padding:24px;background:var(--bg-sunken);color:va',
  "r(--text-primary);font-family:'Inter Variable',-apple-system,BlinkMa",
  "cSystemFont,'Segoe UI Variable Text','Segoe UI',Inter,Roboto,'PingFa",
  "ng SC','Microsoft YaHei UI',sans-serif;-webkit-font-smoothing:antial",
  'iased}.panel{width:min(100%,560px);overflow:hidden;border:1px solid ',
  'var(--border-default);border-radius:20px;background:var(--bg-overlay',
  ');box-shadow:var(--shadow-modal)}.panel-header{display:flex;height:4',
  '8px;align-items:center;border-bottom:1px solid var(--border-subtle);',
  'padding:0 20px;font-size:14px;font-weight:600;letter-spacing:-.012em',
  '}.header-subtitle{margin-left:8px;border-left:1px solid var(--border',
  '-default);padding-left:8px;color:var(--text-tertiary);font-size:11.5',
  'px;font-weight:400;letter-spacing:0}.panel-body{padding:18px 20px 20',
  'px}.request-card{display:flex;align-items:flex-start;gap:12px;border',
  ':1px solid var(--border-subtle);border-radius:12px;background:var(--',
  'bg-base);padding:14px}.brand-mark{display:grid;width:34px;height:34p',
  'x;flex:none;place-items:center}.logo{display:block;width:32px;height',
  ':32px}.logo rect{fill:var(--text-primary)}.logo path{fill:var(--bran',
  'd-accent)}.request-copy{min-width:0;flex:1}.title-line{display:flex;',
  'min-width:0;flex-wrap:wrap;align-items:center;gap:7px}.request-copy ',
  'h1{margin:0;color:var(--text-primary);font-size:15px;font-weight:600',
  ';line-height:1.35;letter-spacing:-.012em;overflow-wrap:anywhere}.req',
  'uest-copy p{margin:4px 0 0;color:var(--text-tertiary);font-size:11.5',
  'px;line-height:1.55}.account{color:var(--text-secondary);font-weight',
  ':600}.badge{border-radius:999px;background:var(--accent-soft);paddin',
  'g:2px 6px;color:var(--accent);font-size:10px;font-weight:600;line-he',
  'ight:1.4}.form-section{margin-top:20px}.form-section h2{margin:0 0 4',
  'px;padding:0 1px;color:var(--text-quaternary);font-size:10.5px;font-',
  'weight:600;line-height:1.4;letter-spacing:.055em;text-transform:uppe',
  'rcase}.settings-list{width:100%}.setting-row{display:flex;min-height',
  ':58px;align-items:center;justify-content:space-between;gap:24px;bord',
  'er-bottom:1px solid var(--border-subtle);padding:10px 1px}.setting-r',
  'ow:not(.fixed){cursor:pointer}.setting-copy{min-width:0;flex:1}.sett',
  'ing-copy strong{display:block;color:var(--text-primary);font-size:13',
  'px;font-weight:500;line-height:1.4}.setting-copy small{display:block',
  ';margin-top:2px;color:var(--text-tertiary);font-size:11.5px;line-hei',
  'ght:1.48}.switch{position:relative;width:34px;height:20px;flex:none;',
  'appearance:none;border:0;border-radius:999px;background:var(--border',
  '-strong);cursor:pointer;transition:background-color 180ms ease}.swit',
  'ch:after{position:absolute;top:2px;left:2px;width:16px;height:16px;b',
  'order-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.16',
  ");content:'';transition:transform 180ms ease}.switch:checked{backgro",
  'und:var(--accent)}.switch:checked:after{transform:translateX(14px)}.',
  'switch:disabled{cursor:not-allowed;opacity:.46}.switch:focus-visible',
  '{outline:2px solid var(--accent);outline-offset:3px}.privacy-row{dis',
  'play:flex;align-items:flex-start;gap:10px;border:1px solid var(--bor',
  'der-subtle);border-radius:12px;background:var(--bg-base);padding:12p',
  'x}.privacy-icon{display:grid;width:26px;height:26px;flex:none;place-',
  'items:center;border-radius:8px;background:var(--accent-soft);color:v',
  'ar(--accent)}.privacy-icon svg{width:14px;height:14px;fill:none;stro',
  'ke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoi',
  'n:round}.privacy-row p{margin:0;color:var(--text-tertiary);font-size',
  ':11.5px;line-height:1.55}.actions{display:flex;justify-content:flex-',
  'end;gap:8px;margin-top:18px}button,.link{display:inline-flex;min-hei',
  'ght:32px;align-items:center;justify-content:center;border-radius:8px',
  ';padding:0 12px;font-family:inherit;font-size:12.5px;font-weight:500',
  ';text-decoration:none;cursor:pointer;transition:background-color 130',
  'ms ease,border-color 130ms ease,filter 130ms ease}.primary{border:1p',
  'x solid transparent;background:var(--accent);color:var(--accent-cont',
  'rast);box-shadow:0 1px 2px rgba(0,0,0,.14)}.primary:hover{background',
  ':var(--accent-hover)}.secondary{border:1px solid var(--border-defaul',
  't);background:transparent;color:var(--text-secondary)}.secondary:hov',
  'er{border-color:var(--border-strong);background:var(--bg-hover);colo',
  'r:var(--text-primary)}button:focus-visible,.link:focus-visible,.fiel',
  'd input:focus-visible{outline:2px solid var(--accent-ring);outline-o',
  'ffset:2px}button:disabled{cursor:wait;opacity:.5}.login-form .form-s',
  'ection{margin-top:18px}.field{display:grid;gap:5px;margin-top:11px;c',
  'olor:var(--text-secondary);font-size:11.5px;font-weight:500}.field i',
  'nput{width:100%;height:36px;border:1px solid var(--border-default);b',
  'order-radius:8px;background:var(--bg-inset);padding:0 10px;color:var',
  '(--text-primary);font-family:inherit;font-size:13px;font-weight:400;',
  'outline:none;transition:border-color 130ms ease,box-shadow 130ms eas',
  'e}.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px',
  ' var(--accent-ring)}.error{margin:9px 0 0;color:var(--danger);font-s',
  'ize:11.5px;line-height:1.45}.error:empty{display:none}.wide{width:10',
  '0%;margin-top:14px}.foot{margin:12px 0 0;text-align:center;color:var',
  '(--text-quaternary);font-size:10.5px;line-height:1.5}\n    @media(pre',
  'fers-color-scheme:dark){:root{color-scheme:dark;--bg-sunken:#131110;',
  '--bg-base:#181614;--bg-overlay:oklch(27% .012 265);--bg-inset:oklch(',
  '14% .008 265);--bg-hover:oklch(100% 0 0/4.5%);--border-subtle:oklch(',
  '100% 0 0/6%);--border-default:oklch(100% 0 0/10%);--border-strong:ok',
  'lch(100% 0 0/17%);--text-primary:oklch(93% .004 265);--text-secondar',
  'y:oklch(72% .008 265);--text-tertiary:oklch(56% .009 265);--text-qua',
  'ternary:oklch(43% .008 265);--accent:oklch(66.5% .15 32);--accent-ho',
  'ver:oklch(71% .145 32);--brand-accent:#e0664a;--danger:oklch(68% .18',
  '5 22);--shadow-modal:0 0 0 1px oklch(100% 0 0/8%),0 16px 40px -8px o',
  'klch(0% 0 0/65%),0 40px 80px -20px oklch(0% 0 0/55%)}}\n    .panel-he',
  'ader{justify-content:space-between;gap:16px}.panel-heading{display:f',
  'lex;min-width:0;align-items:center}.language-switch{display:inline-f',
  'lex;height:28px;flex:none;align-items:center;justify-content:center;',
  'border:1px solid var(--border-default);border-radius:8px;padding:0 8',
  'px;color:var(--text-tertiary);font-size:11.5px;font-weight:500;text-',
  'decoration:none;transition:background-color 130ms ease,border-color ',
  '130ms ease,color 130ms ease}.language-switch:hover{border-color:var(',
  '--border-strong);background:var(--bg-hover);color:var(--text-primary',
  ')}.language-switch:focus-visible{outline:2px solid var(--accent-ring',
  ');outline-offset:2px}\n    @media(max-width:520px){body{padding:12px}',
  '.panel{border-radius:16px}.panel-header{padding:0 16px}.panel-body{p',
  'adding:16px}.setting-row{gap:16px}.actions{padding-bottom:max(0px,en',
  'v(safe-area-inset-bottom))}}\n  ',
].join('')

function page(content: string, locale: AppLocale, currentUrl: string): string {
  const copy = authorizationCopy(locale)
  const nextLocale = locale === 'zh-CN' ? 'en-US' : 'zh-CN'
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">\
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Au\
toNote · ${escapeHtml(copy.authorization)}</title><style>${AUTH_STYLE}</styl\
e></head><body><main class="panel"><header class="panel-header"><div class="\
panel-heading"><span>${escapeHtml(copy.header)}</span><span class="header-su\
btitle">${escapeHtml(copy.authorization)}</span></div><a class="language-swi\
tch" href="${escapeHtml(languageSwitchUrl(currentUrl, locale))}" hreflang="\
${nextLocale}" aria-label="${escapeHtml(copy.switchAria)}">\
${escapeHtml(copy.switchLabel)}</a></header>${content}</main></body></html>`
}
