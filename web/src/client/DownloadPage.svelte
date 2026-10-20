<script lang="ts">
  import Download from '@lucide/svelte/icons/download'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import Logo from '@app/components/primitives/Logo.svelte'
  import type { I18nState } from '@app/i18n/runtime.svelte'

  let { language }: { language: I18nState } = $props()
  const releasesUrl = 'https://github.com/OurAIApps/AutoNote/releases/latest'
</script>

<svelte:head>
  <title>{language.t('download.page_title')}</title>
  <meta name="description" content={language.t('download.page_description')} />
</svelte:head>

<div class="download-page">
  <header>
    <a class="brand" href="/" rel="external" aria-label={language.t('download.back_home')}>
      <Logo size={24} /><span>{language.t('common.product_name')}</span>
    </a>
    <a href={releasesUrl} target="_blank" rel="noopener noreferrer">
      {language.t('download.view_releases')}
      <ExternalLink size={14} aria-hidden="true" />
    </a>
  </header>
  <main>
    <div class="intro">
      <p>{language.t('download.eyebrow')}</p>
      <h1>{language.t('download.title')}</h1>
      <p class="lede">{language.t('download.description')}</p>
    </div>
    <section aria-label={language.t('download.page_title')}>
      <div class="option">
        <h2>{language.t('download.setup_title')}</h2>
        <p>{language.t('download.setup_description')}</p>
        <a class="download primary" href={`${releasesUrl}/download/AutoNote-windows-setup.exe`} rel="external">
          <Download size={16} aria-hidden="true" />{language.t('download.setup_title')}
        </a>
      </div>
      <div class="option">
        <h2>{language.t('download.portable_title')}</h2>
        <p>{language.t('download.portable_description')}</p>
        <a class="download" href={`${releasesUrl}/download/AutoNote-windows-portable.zip`} rel="external">
          <Download size={16} aria-hidden="true" />{language.t('download.portable_title')}
        </a>
      </div>
      <div class="option">
        <h2>{language.t('download.macos_title')}</h2>
        <p>{language.t('download.macos_description')}</p>
        <a class="download" href={`${releasesUrl}/download/AutoNote-macos-arm64.dmg`} rel="external">
          <Download size={16} aria-hidden="true" />{language.t('download.macos_title')}
        </a>
      </div>
      <div class="option">
        <h2>{language.t('download.appimage_title')}</h2>
        <p>{language.t('download.appimage_description')}</p>
        <a class="download" href={`${releasesUrl}/download/AutoNote-linux-x64.AppImage`} rel="external">
          <Download size={16} aria-hidden="true" />{language.t('download.appimage_title')}
        </a>
      </div>
      <div class="option">
        <h2>{language.t('download.deb_title')}</h2>
        <p>{language.t('download.deb_description')}</p>
        <a class="download" href={`${releasesUrl}/download/AutoNote-linux-x64.deb`} rel="external">
          <Download size={16} aria-hidden="true" />{language.t('download.deb_title')}
        </a>
      </div>
      <div class="notes">
        <p>{language.t('download.webview_note')}</p>
        <p>{language.t('download.data_note')}</p>
        <p>{language.t('download.macos_note')}</p>
        <p>{language.t('download.linux_note')}</p>
        <p>{language.t('download.release_note')}</p>
      </div>
    </section>
  </main>
</div>

<style>
  .download-page {
    height: 100dvh;
    overflow-y: auto;
    overflow-x: clip;
    background: var(--bg-base);
    color: var(--text-primary);
  }
  header,
  main {
    max-width: 1080px;
    margin: 0 auto;
    padding: 24px;
  }
  header,
  a {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  header {
    justify-content: space-between;
  }
  a {
    width: fit-content;
    color: var(--text-secondary);
    text-decoration: none;
    white-space: nowrap;
  }
  a:hover {
    color: var(--accent);
  }
  a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
  }
  a:active {
    opacity: 0.8;
  }
  .brand {
    color: var(--text-primary);
    font-weight: 600;
  }
  main {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: start;
    gap: 64px;
    padding-top: 80px;
    padding-bottom: 112px;
  }
  h1 {
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-serif);
    font-size: clamp(36px, 5vw, 60px);
    font-weight: 600;
    line-height: 1.15;
    margin: 16px 0 24px;
  }
  h2 {
    font-size: 18px;
    margin: 0 0 8px;
  }
  p {
    color: var(--text-secondary);
    line-height: 1.7;
    margin: 0;
  }
  .notes p {
    overflow-wrap: anywhere;
  }
  .lede {
    font-size: 16px;
  }
  .option {
    padding: 24px 0;
    border-top: 1px solid var(--border-subtle);
  }
  .download {
    margin-top: 16px;
    padding: 12px 16px;
    border: 1px solid var(--border-default);
    border-radius: var(--r-md);
    color: var(--text-primary);
  }
  .download:hover {
    background: var(--bg-hover);
  }
  .primary {
    background: var(--accent);
    color: var(--accent-contrast);
    border-color: var(--accent);
  }
  .primary:hover {
    background: var(--accent-hover);
    color: var(--accent-contrast);
  }
  .notes {
    padding-top: 16px;
    border-top: 1px solid var(--border-subtle);
  }
  .notes p {
    margin-bottom: 8px;
    font-size: 12px;
  }
  @media (max-width: 720px) {
    header {
      font-size: 12px;
    }
    main {
      grid-template-columns: minmax(0, 1fr);
      gap: 40px;
      padding-top: 40px;
      padding-bottom: 64px;
    }
  }
</style>
