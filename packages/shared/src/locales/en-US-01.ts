export const EN_US_01 = {
  'ai.search_title': 'Web search',
  'ai.skills_title': 'Skills',
  'ai.mcp_client_title': 'MCP connections',
  'ai.skills_runner_warning':
    'Approved skill scripts run as your current user and can ' +
    'access the filesystem and network. Their working ' +
    'directory is not a sandbox. Only run skills you trust.',
  'settings.transfer_export_completed': 'Export completed',
  'settings.transfer_conflict': 'If a note already exists',
  'settings.transfer_skip': 'Skip existing',
  'settings.transfer_newer': 'Keep newer',
  'settings.transfer_duplicate': 'Duplicate',
  'settings.transfer_phase_validating': 'Validating',
  'settings.transfer_phase_reading': 'Reading',
  'settings.transfer_phase_writing': 'Writing',
  'settings.transfer_phase_uploading': 'Uploading',
  'settings.transfer_phase_finalizing': 'Finishing',
  'mobile.account': 'Me',
  'mobile.view': 'View',
  'mobile.menu': 'Menu',
  'mobile.back_to_account': 'Back to Me',
  'app.boot_label': 'Preparing your notebook…',
  'app.document_title': 'AutoNote',
  'app.meta_description':
    'A private, self-hosted Markdown notebook built on ' + 'Cloudflare.',
  'api.error.bad_request': 'The request is invalid',
  'api.error.conflict':
    'This content was changed elsewhere. Refresh and try ' + 'again',
  'api.error.forbidden': 'You do not have permission to perform this action',
  'api.error.internal': 'Internal server error',
  'api.error.invalid_avatar': 'The avatar is invalid or too large',
  'api.error.invalid_credentials': 'Incorrect username or password',
  'api.error.invalid_two_factor_code':
    'The verification code is incorrect or has already been ' + 'used',
  'api.error.invalid_profile_name': 'The display name is invalid',
  'api.error.invalid_username': 'The username format is invalid',
  'api.error.not_found': 'The requested item does not exist',
  'api.error.payload_too_large': 'The content is too large',
  'api.error.registration_closed': 'Registration is closed for this instance',
  'api.error.server_misconfigured': 'The server configuration is incomplete',
  'api.error.storage_unavailable': 'Storage is temporarily unavailable',
  'api.error.too_many_attempts': 'Too many attempts. Try again later',
  'api.error.two_factor_already_enabled':
    'Two-step verification is already enabled',
  'api.error.two_factor_challenge_expired':
    'The sign-in verification expired. Enter your password ' + 'again',
  'api.error.two_factor_not_enabled': 'Two-step verification is not enabled',
  'api.error.two_factor_setup_expired':
    'The setup session expired. Start again',
  'api.error.two_factor_unavailable':
    'The authenticator secret is unavailable. Use a recovery ' + 'code instead',
  'api.error.unauthenticated': 'Please sign in first',
  'api.error.username_taken': 'That username is already in use',
  'api.error.weak_password': 'The password is too weak',
  'api.error.wrong_password': 'The current password is incorrect',
  'api.error.unknown': 'Request failed',
  'api.error.cancelled': 'Request cancelled',
  'api.error.invalid_response': 'The server returned an invalid response',
  'api.error.offline': 'You are offline',
  'api.error.request_timeout': 'The request timed out',
  'backup.error.storage_service':
    'The storage service returned an error. Check the ' +
    'configuration and try again',
  'backup.service.access_key_invalid': 'The Access Key is invalid',
  'backup.service.access_key_missing': 'Access Key or Secret Key is missing',
  'backup.service.archive_missing': 'The backup archive was not generated',
  'backup.service.bucket_missing': 'Enter a bucket name',
  'backup.service.bucket_not_found':
    'The bucket does not exist or the endpoint is incorrect',
  'backup.service.bucket_region_mismatch':
    'The bucket region does not match. Check region and ' + 'endpoint',
  'backup.service.bucket_write_forbidden':
    'The key is invalid or lacks write access to this bucket',
  'backup.service.connection_failed_network':
    'Could not connect. Check DNS, the port, and the TLS ' + 'certificate',
  'backup.service.connection_failed_url': 'Could not connect. Check the URL',
  'backup.service.connection_ok':
    'Connection succeeded with read and write access',
  'backup.service.connection_timeout':
    'Connection timed out. Check the network and URL',
  'backup.service.credentials_decrypt_failed':
    'Backup credentials could not be decrypted. Enter them again in Settings',
  'backup.service.credentials_required': 'Enter credentials before testing',
  'backup.service.cross_origin_redirect':
    'WebDAV redirected to another origin. Enter the final HTTPS URL to protect credentials',
  'backup.service.folder_permission_missing':
    'Permission to create folders is missing',
  'backup.service.no_enabled_targets': 'No backup targets are enabled',
  'backup.service.path_missing': 'The path does not exist. Check the URL',
  'backup.service.path_style_required':
    'The service does not support this operation. Enable ' +
    'path-style access',
  'backup.service.read_back_mismatch':
    'The data read after writing did not match. Check the ' +
    'storage gateway or proxy',
  'backup.service.read_back_mismatch_webdav':
    'The data read after writing did not match. Check the WebDAV gateway or proxy',
  'backup.service.request_rejected':
    'The request was rejected. Check region and endpoint',
  'backup.service.signature_mismatch':
    'Signature mismatch. Check the Secret Key and region',
  'backup.service.storage_full': 'The server is out of storage',
  'backup.service.too_many_redirects': 'Too many WebDAV redirects',
  'backup.service.transfer_incomplete': 'Backup transfer did not complete',
  'backup.service.webdav_credentials_missing':
    'WebDAV username or password is missing',
  'backup.service.webdav_url_missing': 'Enter a WebDAV URL',
  'backup.service.write_access_missing': 'Write access is missing',
  'backup.service.write_access_missing_after_connect':
    'Connected, but write access is missing',
  'backup.service.cleanup_failed':
    'Read and write succeeded, but the test file could not ' +
    'be removed: HTTP {status}',
  'backup.service.create_folder_failed':
    'Creating folder {path} failed: HTTP {status}',
  'backup.service.http_error': 'Server returned HTTP {status}',
  'backup.service.path_not_found': 'Path not found: {path}',
  'backup.service.read_failed': 'Write succeeded but read failed: {details}',
  'backup.service.upload_failed': 'Upload {path} failed: HTTP {status}',
  'backup.service.write_test_failed': 'Write test failed: HTTP {status}',
  'api.no_network_connection': 'No network connection',
  'api.invalid_server_response': 'The server returned an invalid response',
  'api.request_failed_status': 'Request failed ({status})',
  'api.request_timed_out': 'The request timed out',
  'app.missing_root_mount_point': 'Missing #root mount point',
  'app.something_went_wrong': 'Something went wrong',
  'app.error_boundary_description':
    'An unexpected error occurred. Please reload the page to ' + 'continue.',
  'app.reload': 'Reload',
  'app.section_unavailable': 'This section is temporarily unavailable',
  'auth.already_have_an_account_sign_in': 'Already have an account? Sign in',
  'auth.tagline': 'Capture every thought. Connect every idea.',
  'auth.confirm_password': 'Confirm Password',
  'auth.create_owner_account': 'Create owner account',
  'auth.create_the_owner_account_this_step_appears_only_once':
    'Create the owner account. This step appears only once.',
  'auth.authenticator_code': 'Authenticator code',
  'auth.back_to_password': 'Back to password',
  'auth.enter_a_username_and_password': 'Enter a username and password',
  'auth.enter_authenticator_code':
    'Enter the 6-digit code from your authenticator app',
  'auth.enter_recovery_code': 'Enter one of your recovery codes',
  'auth.live_split_view_markdown_preview_realtime_multi_device_sync_multiple_web':
    'Live split-view Markdown preview · Realtime multi-device sync · Multiple WebDAV / S3 backups',
  'auth.network_error_try_again': 'Network error. Try again',
  'auth.no_account_create_one': 'No account? Create one',
  'auth.password_minimum_8_characters': 'Password (minimum 8 characters)',
  'auth.recovery_code': 'Recovery code',
  'auth.recovery_code_used': 'Recovery code used',
  'auth.recovery_codes_remaining':
    'You have {count} unused recovery code(s) remaining. Replace them in Settings if needed.',
  'auth.self_hosted_on_cloudflare_workers_your_data_is_yours':
    'Private notes · Your data stays under your control',
  'auth.sign_in': 'Sign in',
  'auth.sign_up': 'Sign up',
  'auth.this_is_a_private_instance_registration_is_closed_so_only_existing_accou':
    'This is a private instance. Registration is closed, so only existing accounts can sign in.',
  'auth.two_step_verification_description':
    'Your password was accepted. Enter a second verification code to finish signing in.',
  'auth.use_authenticator_code': 'Use authenticator code',
  'auth.use_recovery_code': 'Use recovery code',
  'auth.verify_and_sign_in': 'Verify and sign in',
  'command.add_current_note_to_favorites': 'Add current note to favorites',
  'command.archive_current_note': 'Archive current note',
  'command.change_accent_color': 'Change accent color',
  'command.check_uncheck_tasks': 'Check/uncheck tasks',
  'command.code_block_language_autocomplete':
    'Code block (language autocomplete)',
  'command.commands': 'Commands',
  'command.content_match': 'Content match',
  'command.continue_lists_automatically_press_enter_on_an_empty_item_to_exit':
    'Continue lists automatically; press Enter on an empty item to exit',
  'command.create_note_value0': 'Create note “{value0}”',
  'command.delete_line': 'Delete line',
  'command.export_all_notes_zip': 'Export all notes (ZIP)',
  'command.find_and_replace_in_this_note': 'Find and replace in this note',
  'command.heading_1_same_pattern_for_2_6': 'Heading 1 (same pattern for 2–6)',
  'command.insert_tag_autocomplete': 'Insert tag (autocomplete)',
  'command.jump_to_the_next_cell_in_the_table':
    'Jump to the next cell in the table',
  'command.keyboard_shortcuts': 'Keyboard shortcuts',
  'command.keyboard_shortcuts_021cf9': 'Keyboard shortcuts',
  'command.layout_editor_only': 'Layout: Editor only',
  'command.layout_preview_only': 'Layout: Preview only',
  'command.layout_split_view': 'Layout: Split view',
  'command.link_to_another_note_autocomplete':
    'Link to another note (autocomplete)',
  'command.move_line_down': 'Move line down',
  'command.move_line_up': 'Move line up',
  'command.move_the_current_note_to_trash': 'Move the current note to trash',
  'command.no_matching_results': 'No matching results',
  'command.open_favorites': 'Open favorites',
  'command.open_graph': 'Open graph',
  'command.open_trash': 'Open trash',
  'command.recently_opened': 'Recently opened',
  'command.redo': 'Redo',
  'command.remove_current_note_from_favorites':
    'Remove current note from favorites',
  'command.search_notes_or_type_a_command': 'Search notes or type a command…',
  'command.select': 'Select',
  'command.share_current_note': 'Share current note',
  'command.switch_to_dark_theme': 'Switch to dark theme',
  'command.switch_to_light_theme': 'Switch to light theme',
  'command.triggered_as_you_type': 'Triggered as you type',
  'command.use_nearly_every_action_without_touching_the_mouse':
    'Use nearly every action without touching the mouse',
  'attachments.cleanup': 'Clean up unreferenced',
  'attachments.cleanup_confirm': 'Clean up unreferenced attachments?',
  'attachments.cleanup_confirm_description':
    'Only attachments that no longer appear in any note body will be deleted. This cannot be undone.',
  'attachments.cleanup_failed': 'Cleanup failed',
  'attachments.cleaned_value0': 'Cleaned up {value0} attachments',
  'attachments.delete': 'Delete attachment',
  'attachments.delete_confirm_value0': 'Delete attachment "{value0}"?',
  'attachments.delete_failed': 'Could not delete attachment',
  'attachments.deleted': 'Attachment deleted',
  'attachments.empty':
    'No attachments yet. Paste or drag an image into a note ' +
    'to upload one.',
  'attachments.filter_all': 'All',
  'attachments.filter_documents': 'Documents',
  'attachments.filter_images': 'Images',
  'attachments.filter_other': 'Other',
  'attachments.freed_value0': 'Freed {value0}',
  'attachments.load_failed': 'Could not load more attachments',
  'attachments.load_more': 'Load more',
  'attachments.manage': 'Manage attachments',
  'attachments.manage_description':
    'View, filter, and delete every uploaded attachment.',
  'attachments.none_match': 'No matching attachments',
  'attachments.nothing_to_clean': 'No attachments to clean up',
  'attachments.referenced_value0': '{value0} references',
  'attachments.shown_value0': 'Showing {value0} attachments',
  'attachments.total_value0': '{value0} attachments',
  'attachments.unreferenced': 'Unreferenced',
  'common.about': 'About ',
  'common.access_control': 'Access control',
  'common.access_passcode': 'Access passcode',
  'common.action_failed': 'Action failed',
  'common.backlinks': 'Backlinks',
  'common.bold': 'Bold',
  'common.cancel': 'Cancel',
  'common.clear': 'Clear',
  'common.close': 'Close',
  'common.collapse': 'Collapse',
  'common.command_palette': 'Command palette',
  'common.continue': 'Continue',
  'common.copied': 'Copied',
  'common.copy': 'Copy',
  'common.created': 'Created',
  'common.current_note': 'Current note',
} as const
