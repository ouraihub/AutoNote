export const EN_US_MESSAGES_4 = {
  'settings.relay_api_key_placeholder': '<your access key>',
  'settings.relay_enable': 'Enable relay',
  'settings.relay_enable_desc':
    'Turn off to pause the relay. Access keys and rep' +
    'ositories are kept and work again once enabled.',
  'settings.relay_endpoint': 'Relay URL',
  'settings.relay_intro':
    'Use your configured models from omp and other Op' +
    'enAI or Anthropic compatible clients. Real provi' +
    'der keys stay in AutoNote.',
  'settings.relay_key_expires': 'expires {time}',
  'settings.relay_key_last_used': 'last used {time}',
  'settings.relay_key_name': 'Access key name',
  'settings.relay_key_name_placeholder': 'e.g. laptop-omp',
  'settings.relay_key_name_required': 'Enter a name for the access key',
  'settings.relay_key_never_expires': 'never expires',
  'settings.relay_key_revoke_desc':
    'Clients using this key stop working immediately.',
  'settings.relay_key_revoke_title': 'Revoke this access key?',
  'settings.relay_key_today': '{count} requests today',
  'settings.relay_keys': 'Access keys',
  'settings.relay_keys_desc':
    'Send as Authorization: Bearer or x-api-key. Up t' +
    'o 20 manual keys; GitHub keys have a separate li' +
    'mit of 20 per repository. Each key can use all o' +
    'f your providers.',
  'settings.relay_keys_empty': 'No access keys yet.',
  'settings.relay_loading': 'Loading model relay…',
  'settings.relay_models_yml': 'omp models.yml',
  'settings.relay_paused': 'Paused',
  'settings.relay_paused_notice':
    'Model relay is paused. Relay requests return 503' + '.',
  'settings.relay_repo': 'Repository',
  'settings.relay_repo_add': 'Add repository',
  'settings.relay_repo_invalid': 'Enter the repository as owner/repo',
  'settings.relay_repo_placeholder': 'owner/repo',
  'settings.relay_repo_remove': 'Remove repository',
  'settings.relay_repo_remove_desc':
    'Workflow runs in this repository can no longer g' +
    'et temporary access keys.',
  'settings.relay_repo_remove_title': 'Remove this repository?',
  'settings.relay_repos': 'GitHub repositories',
  'settings.relay_ref': 'Trusted branch',
  'settings.relay_ref_invalid':
    'Enter the branch as refs/heads/name or refs/tags' + '/name',
  'settings.relay_ref_placeholder': 'refs/heads/main',
  'settings.relay_repos_desc':
    'Only the specified workflow on the exact trusted' +
    ' ref, triggered by push, workflow_dispatch or sc' +
    'hedule, can exchange an OIDC token for a 6-hour ' +
    'access key. The first successful exchange pins t' +
    'he repository ID; replacing the repository requi' +
    'res removing and registering it again.',
  'settings.relay_repos_empty': 'No repositories registered.',
  'settings.relay_running': 'Running',
  'settings.relay_setup': 'Setup',
  'settings.relay_setup_desc':
    'discovery: openai-models-list lists all of your ' +
    'enabled models automatically.',
  'settings.relay_workflow': 'Allowed workflow',
  'settings.relay_workflow_invalid':
    'Enter the workflow as owner/repo/.github/workflo' + 'ws/file.yml',
  'settings.relay_workflow_placeholder':
    'owner/repo/.github/workflows/agent.yml',
  'settings.refresh_avatars': 'Refresh five',
  'settings.rebuild_failed': 'Rebuild failed',
  'settings.rebuild_index': 'Rebuild index',
  'settings.rebuild_search_index': 'Rebuild search index',
  'settings.rebuilt_the_index_for_value0_notes':
    'Rebuilt the index for {value0} notes',
  'settings.receive_changes_from_other_devices_quickly':
    'Show changes from your other devices as soon as ' + 'possible',
  'settings.registration_closed': 'Registration closed',
  'settings.registration_open': 'Registration open',
  'settings.registration_status': 'Registration status',
  'settings.region': 'Region',
  'settings.restore_backup_folder': 'Restore AutoNote backup folder',
  'settings.restore_backup_folder_description':
    'Select a folder extracted from the new ZIP, or a' +
    ' legacy backup root containing attachments and s' +
    'napshots. AutoNote verifies COMPLETE and restore' +
    's it in bounded batches.',
  'settings.reloaded_all_data': 'Up to date',
  'settings.render_and_using_katex': 'Display inline and block math',
  'settings.render_mermaid_code_blocks_into_flowcharts':
    'Display Mermaid code blocks as diagrams',
  'settings.runs_from_cloudflare_cron_the_page_does_not_need_to_stay_open':
    'Back up automatically on the selected schedule; ' +
    'this page does not need to stay open',
  'settings.s3_backup': 'S3 backup',
  'settings.s3_compatible': 'S3 compatible',
  'settings.s3_compatible_object_storage_wi\
th_10_gb_free_and_no_credit_card_required':
    'S3-compatible object storage with 10 GB free and' +
    ' no credit card required.',
  'settings.s3_compatible_object_storage_wi\
th_10_gb_free_but_it_requires_credit_card':
    'S3-compatible object storage with 10 GB free, bu' +
    't it requires credit card verification.',
  'settings.s3_compatible_object_storage_wi\
th_5_gb_free_and_no_credit_card_required':
    'S3-compatible object storage with 5 GB free and ' +
    'no credit card required.',
  'settings.scheduled': 'Scheduled',
  'settings.scroll_sync': 'Scroll sync',
  'settings.collapse_long_code_blocks': 'Collapse long code blocks',
  'settings.collapse_long_code_blocks_description':
    'Show a compact preview and let readers expand co' + 'de when needed',
  'settings.code_block_collapse_after': 'Collapse after',
  'settings.lines': ' lines',
  'settings.sec': ' sec',
  'settings.select_file': 'Select file',
  'settings.select_backup_folder': 'Select backup folder',
  'settings.selected_avatar': 'Selected avatar',
  'settings.select_object_read_write_for_permissions_and_create_it_directly':
    ', select Object Read & Write for permissions, an' +
    'd create it directly.',
  'settings.secret_access_key': 'Secret Access Key',
  'settings.serif': 'serif',
  'settings.show_line_numbers': 'Show line numbers',
  'settings.show_outline_by_default': 'Show outline by default',
  'settings.show_toolbar': 'Show toolbar',
  'settings.sign_in_security': 'Sign-in security',
  'settings.sign_up': 'Sign up',
  'settings.simplified_chinese': 'Simplified Chinese',
  'settings.spellcheck': 'Spellcheck',
  'settings.standard': 'Standard',
  'settings.store_backups_in_this_directory\
_or_leave_blank_to_use_the_root_directory':
    'Store backups in this directory, or leave blank ' +
    'to use the root directory',
  'settings.structured_note_data_without_at\
tachment_binaries_download_zip_for_a_comp':
    'Structured note data without attachment binaries' +
    '. Download ZIP for a complete backup',
  'settings.subdirectory': 'subdirectory',
  'settings.supports_md_txt_zip_and_autonot\
e_json_exports_for_matching_ids_the_newer':
    'Supports .md, .txt, .zip, and AutoNote .json exp' +
    'orts. For matching IDs, the newer note wins.',
  'settings.sync': 'Sync',
  'settings.sync_now': 'Sync now',
  'settings.system': 'System',
  'settings.test': 'Test',
  'settings.test_connection': 'Test connection',
  'settings.the_local_cache_will_be_cleared\
_and_the_cloud_data_will_not_be_affected':
    'The local cache will be cleared, and the cloud d' +
    'ata will not be affected.',
  'settings.theme': 'Theme',
  'settings.then_open': 'Then open',
  'settings.there_are_no_attachments_to_clean':
    'There are no attachments to clean',
  'settings.this_device_will_be_signed_out_\
and_its_local_cache_cleared_cloud_data_is':
    'This device will be signed out and its local cac' +
    'he cleared. Cloud data is unaffected.',
  'settings.totp_authenticator_code': 'Current authenticator code',
  'settings.totp_code_or_recovery': 'Authenticator or recovery code',
  'settings.totp_code_or_recovery_placeholder': '6-digit code or recovery code',
  'settings.totp_confirm_code': 'Enter the 6-digit code shown in the app',
  'settings.totp_confirm_disable': 'Disable two-step verification',
  'settings.totp_confirm_enable': 'Verify and enable',
  'settings.totp_copy_all': 'Copy all',
  'settings.totp_copy_failed':
    'Could not copy. Select and copy the value manual' + 'ly.',
  'settings.totp_disable': 'Disable',
  'settings.totp_disable_description':
    'Enter your password and either a current authent' +
    'icator code or an unused recovery code. Other de' +
    'vices will be signed out.',
  'settings.totp_disable_title': 'Disable two-step verification?',
  'settings.totp_disabled': 'Two-step verification disabled',
  'settings.totp_disabled_description':
    'Add an authenticator app code after your passwor' +
    'd to protect new sign-ins.',
  'settings.totp_enable': 'Enable',
  'settings.totp_enable_password_description':
    'Confirm your current password before linking an ' + 'authenticator app.',
  'settings.totp_enabled': 'Two-step verification enabled',
  'settings.totp_enabled_description':
    'New sign-ins require an authenticator or recover' +
    'y code. {count} recovery code(s) remain.',
  'settings.totp_enter_code_or_recovery':
    'Enter an authenticator or recovery code',
  'settings.totp_enter_six_digit_code':
    'Enter a valid 6-digit authenticator code',
  'settings.totp_generate_new_codes': 'Replace recovery codes',
  'settings.totp_load_failed': 'Could not load two-step verification status',
  'settings.totp_loading': 'Loading two-step verification…',
  'settings.totp_manage': 'Manage',
  'settings.totp_manual_secret': 'Manual setup key',
  'settings.totp_other_sessions_revoked':
    'Other signed-in devices have been logged out.',
  'settings.totp_qr_code_title': 'Authenticator setup QR code',
  'settings.totp_recovery_codes': 'Recovery codes',
  'settings.totp_recovery_codes_copied': 'Recovery codes copied',
  'settings.totp_recovery_codes_once':
    'Each code works once. Store them somewhere priva' +
    'te; they will not be shown again.',
  'settings.totp_recovery_codes_replaced': 'Recovery codes replaced',
  'settings.totp_recovery_file_title':
    'AutoNote two-step verification recovery codes',
  'settings.totp_recovery_file_warning':
    'Keep these codes private. Each code can be used ' +
    'once to sign in or disable two-step verification' +
    '.',
  'settings.totp_regenerate_description':
    'Replacing these codes immediately invalidates ev' +
    'ery previous recovery code. Confirm with your pa' +
    'ssword and authenticator.',
  'settings.totp_save_recovery_codes': 'Save these recovery codes now',
  'settings.totp_saved_codes': 'I saved these codes',
  'settings.totp_scan_qr': 'Scan with your authenticator app',
  'settings.totp_scan_qr_description':
    'Use any TOTP-compatible app, then enter its curr' +
    'ent 6-digit code to confirm setup.',
  'settings.totp_secret_copied': 'Setup key copied',
  'settings.totp_title': 'Two-step verification (TOTP)',
  'settings.totp_unavailable_description':
    'The server credential vault is unavailable, so T' +
    'OTP cannot be enabled safely.',
  'settings.to_add_users_open_registration_\
under_settings_account_they_can_then_crea':
    'To add users, open registration under Settings →' +
    ' Account. They can then create an account with a' +
    ' username and password.',
  'settings.total_words': 'Total words',
  'settings.try_this_when_your_search_results_don_t_look_right':
    "Try this when your search results don't look rig" + 'ht',
  'settings.type': 'Type',
  'settings.typewriter_mode': 'Typewriter mode',
  'settings.unchanged': '•••••••• (unchanged)',
  'settings.up_to_10_gb': 'Up to 10 GB',
  'settings.update_failed': 'Update failed',
  'settings.upload_local_image': 'Upload a local image',
  'settings.uploaded_avatar': 'Uploaded local image',
  'settings.use_name_avatar': 'Use name avatar',
  'settings.username_is_sign_in_id':
    '@username is your sign-in ID and does not change' +
    ' with your display name.',
  'settings.use_an_app_specific_password_when_possible':
    'Use an app-specific password when possible',
  'settings.use_any_name_you_like_and_create_it':
    ', use any name you like, and create it.',
  'settings.use_connection_id_as_your_webda\
v_username_and_apps_password_as_your_webd':
    'Use Connection ID as your WebDAV username and Ap' +
    'ps Password as your WebDAV password.',
  'settings.use_keyid_as_access_key_id_and_applicationkey_as_secret_access_key':
    'Use keyID as Access Key ID and applicationKey as' + ' Secret Access Key.',
  'settings.use_path_style_access_recommended_for_most_compatible_services':
    'Use path-style access (recommended for most comp' + 'atible services)',
  'settings.use_url_as_the_webdav_server_url':
    'Use https://webdav.pcloud.com/ as the WebDAV ser' + 'ver URL.',
  'settings.use_your_registration_email_as_\
the_webdav_username_and_your_account_pass':
    'Use your registration email as the WebDAV userna' +
    'me and your account password as the WebDAV passw' +
    'ord.',
  'settings.username_value0_changing_the_password_signs_out_other_devices':
    'Username: {value0}. Changing the password signs ' + 'out other devices.',
  'settings.value0_backup_targets_active': '{value0} backup targets active',
  'settings.value0_changes_will_upload_automatically_after_reconnecting':
    '{value0} changes will upload automatically after' + ' reconnecting',
  'settings.value0_files_value1_value2': '{value0} files · {value1} · {value2}',
  'settings.value0_notes_value1': '{value0} notes · {value1}',
  'settings.version': 'Version',
  'settings.version_history': 'Version history',
  'settings.webdav_address': 'WebDAV address',
  'settings.webdav_backup': 'WebDAV backup',
  'settings.wide': 'Wide',
  'settings.writing_mode': 'Writing mode',
  'share.1_day': '1 day',
  'share.30_days': '30 days',
  'share.7_days': '7 days',
  'share.active': 'Active',
  'share.anyone_who_gets_the_link_will_immediately_lose_access':
    'Anyone who gets the link will immediately lose a' + 'ccess.',
  'share.ask_the_person_who_shared_this_note_for_its_passcode':
    'Ask the person who shared this note for its pass' + 'code',
  'share.content_unavailable': 'Content unavailable',
  'share.could_not_load_list': 'Could not load shared notes',
  'share.done': 'Done',
  'share.embedded_private_notes_are_not_included_in_public_shares':
    'Embedded private notes are not included in publi' + 'c shares',
  'share.expiration': 'Expiration',
  'share.expired': 'Expired',
  'share.expires_value0': 'Expires {value0}',
  'share.generate_public_link': 'Generate public link',
  'share.incorrect_passcode': 'Incorrect passcode',
  'share.in_trash': 'In trash',
  'share.enter_a_passcode': 'Enter a passcode first',
  'share.passcode_too_short': 'The passcode must be at least 4 characters',
  'share.keep_current_expiration': 'Keep current',
  'share.leave_blank_to_keep_the_current_passcode':
    'Leave blank to keep the current passcode',
  'share.link_revoked': 'Link revoked',
  'share.loading_share_status': 'Loading share status…',
  'share.manage': 'Manage',
  'share.could_not_load_sharing_status': 'Could not load sharing status',
  'share.never_expires': 'Never expires',
  'share.never_expires_71ab34': 'Never expires',
  'share.no_matching_shares': 'No matching shares',
  'share.no_shared_notes': 'No shared notes yet',
  'share.open_link': 'Open link',
  'share.opening': 'Opening…',
  'share.passcode': 'Passcode',
  'share.passcode_protected': 'Passcode protected',
  'share.public_link': 'Public link',
  'share.public_link_created': 'Public link created',
  'share.public_links_are_read_only_visito\
rs_can_see_only_the_latest_version_of_t':
    'Public links are read-only. Visitors can view on' +
    'ly the latest content of this note and cannot ac' +
    'cess other notes.',
  'share.refresh_list': 'Refresh shared notes',
  'share.require_a_passcode_to_view_this_note':
    'Require a passcode to view this note',
  'share.revoke_link': 'Revoke link',
  'share.revoke_this_public_link': 'Revoke this public link?',
  'share.set_a_passcode': 'Set a passcode',
  'share.search_shared_notes': 'Search shared notes or links',
  'share.share_note': 'Share note',
  'share.shared_notes': 'Shared notes',
  'share.shared_notes_description':
    'View and manage every public link you created.',
  'share.shared_via_site': 'Shared via {site}',
  'share.sharing_settings_updated': 'Sharing settings updated',
  'share.switch_theme': 'Switch theme',
  'share.source_note_unavailable': 'The source note is unavailable',
  'share.tasks_in_public_shares_are_read_only':
    'Tasks in public shares are read-only',
  'share.this_note_requires_a_password': 'This note requires a password',
  'share.unchanged': '•••••• (unchanged)',
  'share.update_settings': 'Update settings',
  'share.view_content': 'View content',
  'share.visits': ' visits',
  'shell.add_to_remove_from_favorites': 'Add to / remove from favorites',
  'shell.collapse_expand_list': 'Collapse/expand list',
  'shell.cycle_editor_split_preview':
    'Cycle live preview / split view / reading mode',
  'shell.global': 'Global',
  'shell.keyboard_shortcuts': 'Keyboard shortcuts',
  'shell.layout_preferences_not_saved':
    'Layout preferences could not be saved on this de' + 'vice',
  'shell.mobile_navigation': 'Mobile navigation',
  'shell.offline': 'Offline',
  'shell.offline_changes_are_saved_locally':
    'Offline · changes are saved locally',
  'shell.offline_value0_changes_pending': 'Offline · {value0} changes pending',
  'shell.quick_open': 'Quick open',
  'shell.resize_navigation_panel': 'Resize navigation panel',
  'shell.resize_note_list': 'Resize note list',
  'shell.resize_note_panes': 'Resize note panes',
  'shell.save_now': 'Save now',
  'shell.saving': 'Saving…',
  'shell.search_all_notes': 'Search all notes',
  'shell.search_notes_or_run_a_command': 'Search notes or run a command…',
  'shell.show_hide_outline': 'Show/hide outline',
  'shell.synced': 'Synced',
  'shell.synced_value0': 'Synced · {value0}',
  'shell.unsaved_changes': 'Unsaved changes',
  'sidebar.account_and_settings': 'Account and settings',
  'sidebar.collapse': 'Collapse',
  'sidebar.collapse_navigation': 'Collapse navigation',
  'sidebar.create_first_folder': 'Create first folder',
  'sidebar.create_new_note_here': 'Create new note here',
  'sidebar.delete_folder': 'Delete folder',
  'sidebar.delete_folder_value0': 'Delete folder "{value0}"?',
  'sidebar.expand': 'Expand',
  'sidebar.expand_navigation': 'Expand navigation',
  'sidebar.failed_to_create_folder': 'Failed to create folder',
  'sidebar.log_out': 'Log out',
  'sidebar.member': 'Member',
  'sidebar.move_earlier': 'Move earlier',
  'sidebar.move_failed': 'Move failed',
  'sidebar.move_later': 'Move later',
  'sidebar.move_out_one_level': 'Move out one level',
  'folders.appearance': 'Folder appearance',
  'folders.choose_parent': 'Choose parent folder',
  'folders.color': 'Color',
  'folders.delete_contents_move_up':
    '{value0} direct notes and {value1} child folders' +
    ' will move up one level. Notes inside child fold' +
    'ers stay in those folders.',
  'folders.delete_title': 'Delete folder "{name}"?',
  'folders.delete_contents_trash':
    'The entire subtree will be deleted and {value0} ' +
    'notes will move to trash. Notes are not permanen' +
    'tly deleted.',
  'folders.move_cycle':
    'A folder cannot be moved into itself or its desc' + 'endants.',
  'folders.move_depth':
    'The moved subtree exceeds the folder depth limit' + '.',
  'folders.move_contents_up': 'Move contents up',
  'folders.delete_subtree_description':
    'Delete the entire subtree and move every contain' +
    'ed note to trash; notes are not permanently dele' +
    'ted.',
  'folders.delete_subtree': 'Delete subtree and trash notes',
} as const
