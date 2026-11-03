export const EN_US_MESSAGES_5 = {
  'folders.drop_top_level': 'Drop here to move to the top level',
  'notes.select_all': 'Select all',
  'notes.load_more': 'Load more',
  'notes.batch_result': '{success} succeeded / {failed} failed',
  'notes.batch_failure': '{title} ({id}): {error}',
  'common.changes_not_saved':
    'The note body is not safely saved; the operation' + ' was cancelled.',
  'desktop.startupFailed':
    'AutoNote could not open the local notebook. Chec' +
    'k that the application directory is writable, th' +
    'en retry.',
  'desktop.retry': 'Retry',
  'host.diagnostics': 'Diagnostics',
  'host.diagnostics_export': 'Export diagnostics',
  'host.diagnostics_notice':
    'Exports only the application version, browser ca' +
    'pabilities and the last 200 redacted logs. Resou' +
    'rce identifiers may be included; note bodies and' +
    ' credentials are excluded.',
  'host.demo_notice':
    'Demo mode: data stays in this page’s memory and ' +
    'resets on reload. No real backup or MCP service ' +
    'is contacted.',
  'host.demo_credentials': 'Demo login: admin / password',
  'host.retry_after_seconds': 'Try again in {seconds} seconds.',
  'pwa.install_help': 'Use your browser’s menu to install AutoNote.',
  'pwa.offline_boundary':
    'Offline readiness covers only static interface r' +
    'esources. Note bodies and attachments are not do' +
    'wnloaded automatically.',
  'pwa.static_boundary':
    'Only static interface resources are cached. Prev' +
    'iously read and cached note bodies can open offl' +
    'ine; attachments and public shares require a con' +
    'nection.',
  'pwa.install_unavailable':
    'Your browser does not offer an install button. U' +
    'se its menu to add AutoNote to the home screen.',
  'pwa.update_blocked':
    'Changes could not be saved safely. The update is' +
    ' deferred; keep your edits and retry.',
  'pwa.operation_failed': 'The operation failed. Try again later.',
  'pwa.prepare_offline': 'Prepare offline resources',
  'desktop.closeToTray': 'Hide to tray on close',
  'desktop.closeToTrayHint': 'Local edits are saved before hiding.',
  'desktop.globalShortcut': 'Enable global new-note shortcut',
  'desktop.shortcutCombination': 'Shortcut combination',
  'desktop.trayUnavailable':
    'System tray unavailable; closing quits the appli' + 'cation.',
  'desktop.logUnavailable': 'Logging unavailable; note saving is unaffected.',
  'desktop.openLogFolder': 'Open log folder',
  'desktop.schemaVersion': 'Database schema',
  'desktop.showLogs': 'Show background logs',
  'desktop.showLogsHint':
    'Logs are read only while this settings view is o' +
    'pen; background logging is unchanged.',
  'desktop.logsTitle': 'Background logs',
  'desktop.logsRecent': 'Last {count} records · refreshes every 2 seconds',
  'desktop.logsOnlyProblems': 'Problems only',
  'desktop.logsRefresh': 'Refresh',
  'desktop.logsReadFailed': 'Could not read logs. Try again.',
  'desktop.logsNoProblems': 'No warnings or errors.',
  'desktop.logsEmpty': 'No logs yet.',
  'desktop.logsRecords': 'Log records',
  'desktop.prefsReadFailed': 'Could not read interface preferences.',
  'desktop.prefsSaveFailed': 'Could not save interface preferences.',
  'desktop.shortcutUnavailable':
    'Shortcut unavailable; the previous shortcut is u' + 'nchanged.',
  'desktop.mcpRunning': 'Listening on {endpoint}',
  'desktop.mcpStopped': 'Local MCP service is stopped.',
  'desktop.mcpStart': 'Start',
  'desktop.mcpStop': 'Stop',
  'desktop.mcpPort': 'Loopback port',
  'desktop.mcpPortHint':
    'Only 127.0.0.1 is bound. Stop the service to cha' +
    'nge the port (1024–65535).',
  'desktop.mcpPortInUse':
    'That port is in use by another program. Pick a d' + 'ifferent port.',
  'desktop.mcpConfigSnippet': 'Client configuration (shown once)',
  'desktopSync.readStatusFailed': 'Could not read sync status',
  'desktopSync.operationFailed': 'Sync operation failed',
  'desktopSync.unbindTitle': 'Unbind synchronization?',
  'desktopSync.unbindBody':
    'Sync stops. Local notes, folders and tags stay, ' +
    'and everything is uploaded again after you bind.',
  'desktopSync.bindingHeading': 'Remote sync binding',
  'desktopSync.siteOrigin': 'Site origin',
  'desktopSync.username': 'Username',
  'desktopSync.password': 'Password',
  'desktopSync.signIn': 'Sign in',
  'desktopSync.totpCode': 'Authentication or recovery code',
  'desktopSync.verify': 'Verify',
  'desktopSync.mergeExplain':
    'Binding merges both sides by note id. When a not' +
    'e differs, both versions are kept: the remote on' +
    'e under its id and yours as a conflict copy.',
  'desktopSync.previewBinding': 'Preview binding',
  'desktopSync.previewCounts':
    'Local only {localOnly} · Remote only {remoteOnly' +
    '} · Same {same} · Different {different}',
  'desktopSync.confirmBinding': 'Confirm binding',
  'desktopSync.statusHeading': 'Sync status',
  'desktopSync.phase': 'Status',
  'desktopSync.phase_unbound': 'Not bound',
  'desktopSync.phase_idle': 'Running',
  'desktopSync.phase_syncing': 'Syncing',
  'desktopSync.phase_paused': 'Stopped',
  'desktopSync.site': 'Site',
  'desktopSync.account': 'Account',
  'desktopSync.pending': 'Waiting to upload',
  'desktopSync.lastSuccess': 'Last successful sync',
  'desktopSync.never': 'Never',
  'desktopSync.error': 'Error',
  'desktopSync.start': 'Start sync',
  'desktopSync.stop': 'Stop sync',
  'desktopSync.unbind': 'Unbind',
  'desktopSync.menuSignIn': 'Sign in to sync…',
  'desktopSync.menuUnbind': 'Unbind sync',
  'folders.icon': 'Icon',
  'folders.includes_subfolders': 'Includes notes in subfolders',
  'folders.move_to': 'Move to…',
  'folders.no_color': 'No color',
  'folders.no_icon': 'Default icon',
  'folders.name': 'Folder name',
  'folders.color_red': 'Red',
  'folders.color_orange': 'Orange',
  'folders.color_yellow': 'Yellow',
  'folders.color_lime': 'Green',
  'folders.color_emerald': 'Emerald',
  'folders.color_cyan': 'Cyan',
  'folders.color_indigo': 'Indigo',
  'folders.color_purple': 'Purple',
  'folders.color_pink': 'Pink',
  'folders.color_slate': 'Gray',
  'folders.custom_icon': 'Custom (type any emoji)',
  'ai.settings_title': 'Model service',
  'ai.kit_message': '{text}',
  'ai.kit_confirm_title': '{title}',
  'ai.kit_confirm_body': '{body}',
  'ai.error_unauthorized': 'The model service rejected the API key.',
  'ai.error_upstream': 'The model service returned an error.',
  'ai.error_needs_config':
    'Set up a model and API key in Model service sett' + 'ings.',
  'ai.roles': 'Roles',
  'ai.role_chat': 'Chat model',
  'ai.role_chat_desc': 'Used for conversations. Required.',
  'ai.role_writing': 'Writing model',
  'ai.role_writing_desc': 'Used for AI writing.',
  'ai.role_none': 'Not set',
  'ai.role_painting': 'Painting model',
  'ai.role_painting_desc':
    'Image model the chat model calls when “Generate ' + 'image” is on.',
  'ai.role_clear': 'Clear',
  'ai.role_follow_chat': 'Follow chat model',
  'ai.role_follow_chat_current': 'Follow chat model ({label})',
  'chat.title': 'AI chat',
  'chat.toggle': 'Toggle AI chat',
  'writing.polish': 'Polish',
  'writing.rewrite': 'Rewrite',
  'writing.shorten': 'Shorten',
  'writing.expand': 'Expand',
  'writing.continue': 'Continue writing',
  'writing.generate_next': 'Generate next',
  'writing.preview_title': 'AI suggestion',
  'writing.using_chat_fallback':
    'Using the chat model because no writing model is' + ' configured.',
  'writing.selection_changed': 'The note changed. Select the text again.',
  'writing.stop': 'Stop',
  'writing.copy': 'Copy',
  'writing.insert': 'Insert at cursor',
  'writing.replace': 'Replace original',
  'folders.no_match': 'No matching folders',
  'folders.search': 'Search folders',
  'folders.top_level': 'Top level',
  'sidebar.new_subfolder': 'New subfolder',
  'sidebar.rename': 'Rename',
  'sidebar.rename_failed': 'Rename failed',
  'sidebar.show_all_value0_tags': 'Show all {value0} tags',
  'sidebar.switch_to_dark': 'Switch to dark',
  'sidebar.switch_to_light': 'Switch to light',
  'sidebar.the_value0_notes_inside_move_up_one_level_and_are_not_deleted':
    'The {value0} notes inside move up one level and ' + 'are not deleted.',
  'sidebar.this_folder_is_empty': 'This folder is empty.',
  'tags.change_color': 'Change color',
  'tags.clear_color': 'Clear color',
  'tags.color': 'Color',
  'tags.color_failed': 'Could not update color',
  'tags.create_failed': 'Could not create tag',
  'tags.create_first': 'Create your first tag',
  'tags.delete': 'Delete tag',
  'tags.delete_title':
    'Delete tag "{name}"? It will also be removed fro' +
    'm related note bodies.',
  'tags.delete_confirm_value0':
    'Delete tag "{value0}"? It will also be removed f' +
    'rom the related note bodies.',
  'tags.delete_failed': 'Could not delete tag',
  'tags.deleted': 'Tag deleted',
  'tags.delete_description_value0':
    'It is used by {value0} active notes. Matching co' +
    'ntent in archived notes and trash will also be h' +
    'andled, with a version kept for every changed no' +
    'te.',
  'tags.invalid_name': 'Tag names cannot contain spaces or #',
  'tags.merge': 'Merge tags',
  'tags.merge_confirm_value0_value1': 'Merge "{value0}" into "{value1}"?',
  'tags.merge_description':
    'The two tags will become one, and related note b' +
    'odies and metadata will use the existing tag nam' +
    'e.',
  'tags.new': 'New tag',
  'tags.new_placeholder': 'Tag name',
  'tags.rename': 'Rename',
  'tags.rename_failed': 'Could not rename tag',
  'tags.renamed': 'Tag renamed',
  'tags.updated_note_bodies_value0':
    'Updated {value0} note bodies. Open notes were re' + 'freshed too.',
  'time.just_now': 'Just now',
  'time.this_month': 'This month',
  'time.this_week': 'This week',
  'time.today': 'Today',
  'time.yesterday': 'Yesterday',
  'workspace.reading_mode': 'Reading mode',
  'workspace.live_preview': 'Live preview',
  'workspace.live_preview_hint':
    'Click to edit; move the cursor away to render. C' +
    'trl / ⌘ + click to open links',
  'workspace.a_snapshot_is_saved_every_few_minutes_or_after_larger_edits':
    'A snapshot is saved every few minutes or after l' + 'arger edits',
  'workspace.autosave_for_value0': 'Autosave for “{value0}”',
  'workspace.back_to_notes': 'Back to notes',
  'workspace.block_id': 'Block ID',
  'workspace.block_reference': 'Block reference',
  'workspace.callout': 'Callout',
  'workspace.characters': ' characters',
  'workspace.close_right_note': 'Close right note',
  'workspace.choose_a_note_or_write_a_new_one':
    'Choose a note, or write a new one',
  'workspace.code_block': 'Code block',
  'workspace.details_block': 'Details block',
  'workspace.differences_from_current_content':
    'Differences from current content',
  'workspace.divider': 'Divider',
  'workspace.edit_only': 'Edit only',
  'workspace.enhanced_code_block': 'Enhanced code block',
  'workspace.export': 'Export',
  'workspace.export_failed': 'Export failed',
  'workspace.export_html': 'Export as HTML',
  'workspace.export_markdown': 'Export as Markdown',
  'workspace.export_pdf': 'Export as PDF',
  'workspace.footnote': 'Footnote',
  'workspace.heading_value0': 'Heading {value0}',
  'workspace.inline_math': 'Inline math',
  'workspace.insert_image': 'Insert image',
  'workspace.insert_tag': 'Insert tag',
  'workspace.large_content_using_a_faster_comparison':
    'Large content · using a faster comparison',
  'workspace.latest': 'Latest',
  'workspace.layout': 'Layout',
  'workspace.left_note_pane': 'Left note pane',
  'workspace.link': 'Link',
  'workspace.loading_note_content': 'Loading note content',
  'workspace.note_title': 'Note title',
  'workspace.math': 'Math',
  'workspace.mermaid_diagram': 'Mermaid diagram',
  'workspace.more_blocks': 'More blocks',
  'workspace.more_inline_styles': 'More inline styles',
  'workspace.could_not_load_backlinks': 'Could not load backlinks',
  'workspace.could_not_load_version': 'Could not load this version',
  'workspace.could_not_load_version_history': 'Could not load version history',
  'workspace.no_notes_link_here_yet_write': 'No notes link here yet. Write ',
  'workspace.no_version_history_yet': 'No version history yet',
  'workspace.note_embed': 'Note embed',
  'workspace.note_syntax': 'Note syntax',
  'workspace.open_a_note_from_the_list_or_press_shortcut_to_create_one':
    'Open a note from the list, or press {shortcut} t' + 'o create one',
  'workspace.preview_only': 'Preview only',
  'workspace.remote_image': 'Remote image',
  'workspace.resize_editor_and_preview_panes':
    'Resize editor and preview panes',
  'workspace.right_note_pane': 'Right note pane',
  'workspace.restore_this_version': 'Restore this version?',
  'workspace.restore_this_version_da5169': 'Restore this version',
  'workspace.restored_to_selected_version': 'Restored to selected version',
  'workspace.share': 'Share',
  'workspace.split_view': 'Split view',
  'workspace.table': 'Table',
  'workspace.the_current_content_will_be_aut\
omatically_saved_as_a_new_version_first_a':
    'The current content will be automatically saved ' +
    'as a new version first and will not be lost.',
  'workspace.title': '[[title]]',
  'workspace.title_748d7d': 'Title',
  'workspace.title_level': 'Title level',
  'workspace.upload_failed': 'Upload failed',
  'workspace.value0_unchanged_lines_hidden':
    '… {value0} unchanged lines hidden …',
  'workspace.will_appear_here': 'will appear here.',
} as const
