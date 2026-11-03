export const EN_US_MESSAGES_6 = {
  'seed.welcome_note':
    '---\ntitle: Welcome to AutoNote\ntags: [getting-st' +
    'arted, AutoNote]\naliases:\n  - User guide\n---\n\n# ' +
    'Welcome to AutoNote\n\n> [!TIP] Five things to kno' +
    'w first\n> - This is your private Markdown notebo' +
    'ok; note bodies always remain plain text.\n> - Co' +
    'ntent saves automatically, remains editable offl' +
    'ine, and uploads after reconnection.\n> - Common ' +
    'create, move, organize, and delete actions take ' +
    'effect locally first and roll back safely if per' +
    'sistence fails.\n> - The title at the top of a no' +
    'te is independently editable and does not have t' +
    'o match the first body line.\n> - MCP is entirely' +
    ' optional and requires account authorization bef' +
    'ore it can read notes.\n\nOrganize notes on the le' +
    'ft. Choose live preview to edit content in place' +
    ', split view for source and preview side by side' +
    ' on desktop and stacked on mobile, or reading mo' +
    'de to browse the rendered document. There is no ' +
    'proprietary document format: every `.md` file in' +
    ' a backup opens in any text editor.\n\n## Try thes' +
    'e now\n\n- [ ] Click this checkbox and see its sta' +
    'te saved\n  - [ ] Nested tasks update their exact' +
    ' source line too\n- [ ] Select text and press `Ct' +
    'rl + B` to make it bold\n- [ ] Press `Ctrl + K` t' +
    'o open the command palette\n- [ ] Add a `#tag`, o' +
    'r click [[My first note]] to create a linked not' +
    'e\n- [ ] Click the title above this note and give' +
    ' it a name different from the body\n- [ ] Create ' +
    'a subfolder, then drag it into another folder or' +
    ' sibling position\n- [ ] Alt-click another note, ' +
    'or choose **Open to side**, to work with two not' +
    'es at once\n- [ ] Install AutoNote as an offline-' +
    'capable PWA under **Settings → About**\n- [ ] Ope' +
    'n **Settings → MCP** to review private AI connec' +
    'tions and permissions\n- [ ] Add a backup target ' +
    'under **Settings → Backup**\n- [ ] Create a passw' +
    'ord-protected share for a note\n\n> [!NOTE] Add a ' +
    'backup\n> Open **Settings → Backup**, add a WebDA' +
    'V or S3 target, test the connection, and run one' +
    ' **Back up now**.\n\n> [!NOTE] Create a secure sha' +
    're\n> Open **Share** from any note, then set an a' +
    'ccess password and expiration. Attachments in a ' +
    'protected share are available only after passwor' +
    'd verification.\n\n## Essential Windows shortcuts\n' +
    '\n| Shortcut | Action |\n| --- | --- |\n| `Ctrl + K' +
    '` | Open the command palette |\n| `Ctrl + P` | Qu' +
    'ickly open a note |\n| `Ctrl + N` | Create a note' +
    ' |\n| `Ctrl + Shift + F` | Search all notes |\n| `' +
    'Ctrl + ,` | Open settings |\n| `Ctrl + \\` | Cycle' +
    ' editor, split, and preview layouts |\n| `Ctrl + ' +
    'S` | Save now; normal edits save automatically |' +
    '\n| `Ctrl + B / I / E` | Bold, italic, and inline' +
    ' code |\n| `Ctrl + 1…6` | Set heading levels one ' +
    'through six |\n| `Shift + ?` | Show every shortcu' +
    't |\n\n## Why it works for long-term notes\n\n:::: t' +
    'abs\n::: tab-item Writing\nIndependent titles, sou' +
    'rce editing, live preview, synchronized scrollin' +
    'g, focus and typewriter modes, an outline, and v' +
    'ersion history.\n:::\n\n::: tab-item Organization\nT' +
    'welve levels of drag-sortable folders, inline `#' +
    'tags`, `[[wiki links]]`, backlinks, a graph, and' +
    ' full-text search. On desktop, open a second not' +
    'e to the side and choose edit, split, or preview' +
    ' independently in each active group. Deleting a ' +
    'folder promotes its children and moves direct no' +
    'tes to the parent.\n:::\n\n::: tab-item Search & AI' +
    '\nKeyboard command-palette navigation, keyword se' +
    'arch, and optional Workers AI semantic/hybrid se' +
    'arch. Every account has a separate index, with a' +
    'utomatic keyword fallback when AI is unavailable' +
    '.\n:::\n\n::: tab-item Safety & backup\nSelf-hosting' +
    ', an installable PWA, offline editing, multi-dev' +
    'ice sync, and conflict copies. Back up to severa' +
    'l WebDAV or S3 targets and export readable Markd' +
    'own, attachments, and complete structured data.\n' +
    ':::\n::::\n\n## Private MCP (optional)\n\nUnder **Set' +
    'tings → MCP**, the owner can enable the remote M' +
    'CP service and each account can separately decid' +
    'e whether to allow writes or moves to trash:\n\n- ' +
    'Full MCP clients such as Codex and Claude Code a' +
    'uthorize through OAuth 2.1 with PKCE. You can re' +
    'voke one client or every grant at any time.\n- Sc' +
    'ripts and minimal clients without OAuth can use ' +
    'an `ink_...` API key. A key is shown once, store' +
    'd only as a hash, and can be revoked at any time' +
    '.\n- MCP can search, read bounded ranges, inspect' +
    ' outlines/folders/tags/links, and—with explicit ' +
    'permission—safely create, edit, organize, trash,' +
    ' or restore notes. Permanent purge is never expo' +
    'sed.\n- With Workers AI configured, AutoNote buil' +
    'ds a per-account semantic index and combines sem' +
    'antic and keyword results. The index can be rebu' +
    'ilt or cleared, and content changes are indexed ' +
    'in the background.\n\n> [!WARNING] Check an extern' +
    "al AI client's privacy policy before connecting\n" +
    '> AutoNote isolates accounts and enforces permis' +
    'sions, but content an authorized client actually' +
    ' reads is then processed by that client.\n\n## Mar' +
    'kdown quick reference\n\nUnder each example title,' +
    ' the **rendered result** is on the left and the ' +
    '**copyable source** is on the right.\n\n### Inline' +
    ' styles\n\n| Rendered result | Source |\n| --- | --' +
    '- |\n| **Bold** | `**Bold**` |\n| *Italic* | `*Ita' +
    'lic*` |\n| ~~Strikethrough~~ | `~~Strikethrough~~' +
    '` |\n| ==Highlight== | `==Highlight==` |\n| `Inlin' +
    'e code` | `` `Inline code` `` |\n\n### Links, imag' +
    'es, and note relationships\n\n~~~~md-example title' +
    '="Link"\n[Open the example site](https://example.' +
    'com)\n~~~~\n\n~~~~md-example title="Image"\n![AutoNo' +
    'te project logo](/autonote-logo.png "AutoNote pr' +
    'oject logo")\n~~~~\n\n~~~~md-example title="Wiki li' +
    'nks"\n[[My first note|Open or create a note]] · [' +
    '[Welcome to AutoNote#Markdown quick reference|Ju' +
    'mp to this section]]\n~~~~\n\n~~~~md-example title=' +
    '"Block ID and reference"\nThis content can be add' +
    'ressed precisely. ^markdown-demo\n\nClick [[#^mark' +
    'down-demo]] to return to it.\n~~~~\n\n~~~~md-exampl' +
    'e title="Note embed"\nThis content is embedded ag' +
    'ain below. ^embed-demo\n\n![[#^embed-demo|Embedded' +
    ' result]]\n~~~~\n\n~~~~md-example title="Footnote"\n' +
    'This sentence has an additional note.[^markdown-' +
    'footnote]\n\n[^markdown-footnote]: This is the ren' +
    'dered footnote. Use its links to move between th' +
    'e reference and definition.\n~~~~\n\nObsidian comme' +
    'nts are hidden in preview: `%% one line %%`, or ' +
    'place `%%` markers around multiple lines.\n\n### M' +
    'ath and diagrams\n\n~~~~md-example title="Math"\nIn' +
    'line math: $E = mc^2$\n\n$$\na^2 + b^2 = c^2\n$$\n~~~' +
    '~\n\n~~~~md-example title="Mermaid diagram"\n```mer' +
    'maid\nflowchart LR\n  A[Markdown source] --> B[Liv' +
    'e preview]\n```\n~~~~\n\n### Modern block extensions' +
    '\n\n~~~~md-example title="Obsidian callout"\n> [!NO' +
    'TE]- Folded callout with a custom title\n> Put ex' +
    'planations, tasks, lists, or other Markdown here' +
    '.\n>\n> > [!TIP]+ Expanded nested callout\n> > Nest' +
    'ed callouts use the same syntax.\n~~~~\n\n~~~~md-ex' +
    'ample title="Folded details block"\n::: details [' +
    'Click to expand]\nThis content is hidden until th' +
    'e details block is opened.\n:::\n~~~~\n\n~~~~md-exam' +
    'ple title="Tabs"\n:::: tabs\n::: tab-item First ta' +
    'b\nThis is the first tab panel.\n:::\n\n::: tab-item' +
    ' Second tab\nThis is the second tab panel.\n:::\n::' +
    '::\n~~~~\n\n~~~~md-example title="Code block with a' +
    ' title, line numbers, and highlighting"\n```ts ti' +
    'tle="hello.ts" line-numbers {2}\nconst name = \'Au' +
    "toNote'\nconsole.log(`Hello, ${name}!`)\n```\n~~~~\n" +
    '\n## Saving, syncing, and recovery\n\nChanges save ' +
    'automatically and sync to your other devices. Yo' +
    'u can keep editing offline, and queued writes re' +
    'play in order after reconnection. Everyday actio' +
    'ns appear locally first and roll back only if ba' +
    'ckground persistence fails; stale sync responses' +
    ' cannot overwrite newer local state.\n\nInstall th' +
    'e PWA under **Settings → About**. Application up' +
    'dates wait for confirmation and flush pending no' +
    'te writes before refreshing; only the owner rece' +
    'ives deployment-version reminders. Existing data' +
    'bases upgrade through versioned, idempotent migr' +
    'ations, but keep a current backup before updatin' +
    'g a self-hosted deployment.\n\nAdd several WebDAV/' +
    'S3 destinations and a schedule under **Settings ' +
    '→ Backup**. Import or export `.md`, `.zip`, and ' +
    'complete JSON archives under **Settings → Data**' +
    '.\n\n> [!WARNING] Backup is not sync\n> Keep backup' +
    's with at least two independent providers, and o' +
    'ccasionally perform a real restore to prove they' +
    ' work.\n\n## You are ready\n\nPress `Ctrl + ,` to ch' +
    'ange the interface language, theme, typography, ' +
    'editor, sync, or backup settings. You now know e' +
    'verything needed to use AutoNote. Keep this note' +
    ' as a reference or delete it and start writing. ' +
    '#getting-started\n',
  'gallery.title': 'AutoNote UI Gallery',
  'gallery.development_only': 'Development only',
  'gallery.description':
    'Components use isolated state and never access a' + ' note backend.',
  'gallery.actions': 'Actions and feedback',
  'gallery.show_notification': 'Show notification',
  'gallery.open_dialog': 'Open dialog',
  'gallery.open_drawer': 'Open drawer',
  'gallery.ask_confirmation': 'Ask confirmation',
  'gallery.disabled_action': 'Disabled action',
  'gallery.controls': 'Gallery control states',
  'gallery.long_title': 'Long note title',
  'gallery.input_help': 'Inputs retain a visible accessible label.',
  'gallery.validation': 'Validation state',
  'gallery.validation_message': 'Example validation message',
  'gallery.enable_preview': 'Enable isolated preview',
  'gallery.keyboard_help': 'The control remains keyboard accessible.',
  'gallery.completed_tasks': 'Include completed tasks',
  'gallery.editor_layout': 'Editor layout',
  'gallery.editor_size': 'Editor size: {size}',
  'gallery.dialog_title': 'Gallery dialog',
  'gallery.dialog_description':
    'Escape closes this overlay and restores focus to' + ' its trigger.',
  'gallery.close_dialog': 'Close dialog',
  'gallery.drawer_title': 'Gallery drawer',
  'gallery.drawer_description': 'Mobile overlay preview',
  'gallery.close_drawer': 'Close drawer',
  'gallery.feedback': 'Gallery notification',
  'gallery.confirmation_title': 'Confirmation',
  'gallery.confirmation_body': 'This is an isolated gallery action.',
  'gallery.long_title_value':
    'A long title remains readable without changing t' +
    'he shared control layout',
  'gallery.validation_value': 'Invalid gallery state',
  'gallery.live': 'Live',
  'gallery.split': 'Split',
  'gallery.preview': 'Preview',
  'workspace.preview.expand_code': 'Expand code',
  'workspace.front_matter': 'Front Matter',
  'workspace.live_label': 'Live',
  'workspace.split_label': 'Split',
  'workspace.preview_label': 'Preview',
  'settings.desktop': 'Desktop',
} as const
