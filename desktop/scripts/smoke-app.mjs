import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { currentArtifacts, noLinks, sha256 } from './release-artifacts.mjs'
import { powershell, recorder, requireDesktop } from './interactive-evidence.mjs'

export const windowCases = ['edit-attachment', 'single-instance', 'tray', 'shortcut-conflict', 'shortcut-change', 'save-failure', 'slow-commit', 'offline-exit', 'import-exit', 'mcp-sync-concurrent', 'backup-both-directions', 'dpi-monitor', 'restart-readback', 'portable-move', 'unwritable-startup', 'cache-location']
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  requireDesktop()
  const release = currentArtifacts()
  let source = process.argv[2] ? path.resolve(process.argv[2]) : null
  if (source) noLinks(source)
  const running = spawnSync('tasklist', ['/fi', 'IMAGENAME eq AutoNote.exe', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
  if (running.status !== 0 || /"AutoNote\.exe"/i.test(running.stdout)) throw new Error('Close every existing AutoNote instance before isolated smoke (single-instance is session-wide)')
  const stage = mkdtempSync(path.join(tmpdir(), 'AutoNote 实窗 smoke '))
  let appDir = stage
  let exe = path.join(stage, 'AutoNote.exe')
  if (!source) {
    const portable = release.artifacts.find(item => item.kind === 'portable').file
    powershell('Expand-Archive -LiteralPath $env:AUTONOTE_ZIP -DestinationPath $env:AUTONOTE_UNPACK', { AUTONOTE_ZIP: portable, AUTONOTE_UNPACK: path.join(stage, 'candidate') })
    source = path.join(stage, 'candidate/AutoNote/AutoNote.exe')
  }
  if (sha256(source) !== release.exeSha256) throw new Error('Smoke executable must be the exact current portable candidate')
  copyFileSync(source, exe)
  const image = path.join(stage, 'smoke-image.png')
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN3sAAAAASUVORK5CYII=', 'base64'))
  const marker = `AutoNote-window-${randomUUID()}`
  const evidence = recorder(path.join(stage, 'evidence'), 'window', release)
  let child
  let exited
  const launch = () => {
    child = spawn(exe, [], { cwd: tmpdir(), stdio: 'ignore' })
    exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code)) })
  }
  const normalExit = async () => {
    console.log('Use the application Exit action (not taskkill/Task Manager). Waiting for normal exit...')
    let timer
    try {
      const code = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Normal exit timed out; do not count force-kill as success')), 120_000) })])
      if (code !== 0) throw new Error(`Application did not exit normally: ${code}`)
    } finally { clearTimeout(timer) }
  }
  const assertLibrary = () => {
    const data = path.join(appDir, 'data')
    const db = new DatabaseSync(path.join(data, 'library.db'), { readOnly: true })
    try {
      const note = db.prepare('SELECT id,content,rev FROM notes WHERE instr(content,?)>0 AND deleted_at IS NULL').get(marker)
      if (!note || !note.content.includes(`${marker}-FINAL`)) throw new Error('Last input is not durably saved')
      const attachments = db.prepare('SELECT id,sha256 FROM attachments').all()
      if (!attachments.some(item => {
        const object = path.join(data, 'files', item.id)
        noLinks(object)
        return note.content.includes(`/api/files/${item.id}`) && item.sha256 === sha256(image) && existsSync(object) && sha256(object) === item.sha256
      })) throw new Error('Saved note does not reference intact uploaded fixture bytes')
      return { noteId: note.id, rev: note.rev, contentSha256: sha256Buffer(note.content), attachmentSha256: sha256(image) }
    } finally { db.close() }
  }
  function sha256Buffer(value) { return createHash('sha256').update(value).digest('hex') }
  try {
    launch()
    await evidence.capture('edit-attachment', `In the real editor create a note containing ${marker}; upload ${image} using the actual UI and verify the preview, then type ${marker}-FINAL.`, 'Editor and image preview are visible; the marker is complete')
    const second = spawn(exe, [], { cwd: tmpdir(), stdio: 'ignore' })
    let secondTimer
    const secondCode = await new Promise((resolve, reject) => {
      second.once('error', reject)
      second.once('exit', code => { clearTimeout(secondTimer); resolve(code) })
      secondTimer = setTimeout(() => reject(new Error('Second instance did not exit')), 20_000)
    })
    if (secondCode !== 0) throw new Error('Second instance failed')
    await evidence.capture('single-instance', 'Observe the first window after second-process launch, then hide/minimize it and launch the isolated exe again.', 'First window restores/focuses; only one main window/service exists')
    await evidence.capture('tray', 'Enable close-to-tray, edit, close X, use tray Open/New Note via mouse/keyboard and restore the marker note. Disable close-to-tray before continuing.', 'Hide saves first; Open restores; New Note occurs once; disabling tray cannot leave an unreachable process')
    await evidence.capture('shortcut-conflict', 'Reserve a combination with another program; assign it in desktop settings and test the previous combination.', 'Conflict is explicit; old combination still works')
    await evidence.capture('shortcut-change', 'Assign an unused new combination, trigger it from another foreground app and test the old combination. Use tray Exit before continuing.', 'Pressed creates one note; old key no longer triggers; tray Exit saves and frees the key')
    await normalExit(); launch()
    await evidence.capture('save-failure', 'Verify changed shortcut persisted. Cause a real isolated disk-full/ACL local-save failure; edit and request Exit, then restore writability and retry without discarding.', 'Shortcut persists; save failure keeps window and exact dirty buffer; retry saves')
    await evidence.capture('slow-commit', `Throttle isolated disk using sustained I/O; type ${marker}-FINAL rapidly and immediately Exit. Do not manually restart.`, 'Exit waits for the local commit; no forced termination')
    await normalExit(); evidence.report.slowCommitReadback = assertLibrary(); launch()
    evidence.report.slowCommitUiReadback = await evidence.ask('Read the marker note in this restarted editor; record its complete actual FINAL suffix.')
    await evidence.capture('offline-exit', 'Configure isolated Web sync, disconnect network, edit and normally Exit. Do not manually restart.', 'Local save finishes without waiting for remote connectivity')
    await normalExit(); launch()
    evidence.report.offlineUiReadback = await evidence.ask('Read the offline-edited note in this restarted editor; record the actual saved text.')
    await evidence.capture('import-exit', 'Start large import and request Exit during committing/finalizing. Do not manually restart.', 'Exit waits for real terminal result rather than interrupting commit')
    await normalExit(); launch()
    evidence.report.importUiReadback = await evidence.ask('Record actual imported note count and attachment hash after restart: complete old or new state, not partial.')
    await evidence.capture('mcp-sync-concurrent', 'Against isolated libraries, concurrently edit via GUI/MCP/remote sync; hold a dirty GUI buffer while external change lands; reactivate window.', 'External organization/note changes appear; dirty buffer remains; conflict is explicit; no accepted writes disappear')
    await evidence.capture('backup-both-directions', 'Export fixture note/image to Web; read there; export Web ZIP/JSON and restore to another isolated desktop library; compare organization/state and attachment hash.', 'Both directions restore real data and attachment bytes; JSON is not claimed as binary backup')
    await evidence.capture('dpi-monitor', 'Move/resize on second monitor, change DPI, remove monitor and normally Exit. Do not manually restart.', 'Normal window state is saved; hidden/minimized bounds do not replace it')
    await normalExit(); launch()
    evidence.report.restoredBounds = await evidence.ask('Record actual restarted bounds/DPI and operable title bar after monitor removal.')
    console.log(`Return to the marker note, append exactly ${marker}-FINAL, then normally Exit.`)
    await normalExit(); evidence.report.readback = assertLibrary(); launch()
    await evidence.capture('restart-readback', 'Read the marker note in the real editor and inspect its image; normally Exit before continuing.', 'Actual FINAL suffix and image read back exactly')
    await normalExit()
    const moved = path.join(stage, '移动 portable folder')
    cpSync(path.join(stage, 'data'), path.join(moved, 'data'), { recursive: true })
    copyFileSync(source, path.join(moved, 'AutoNote.exe'))
    appDir = moved; exe = path.join(moved, 'AutoNote.exe')
    const beforeMove = assertLibrary()
    launch()
    await evidence.capture('portable-move', 'Use the relocated window: inspect marker note, image, theme/UI preferences and window state. Original directory is retained for comparison.', 'Library, image, WebView preferences and window state follow the portable folder despite a different cwd')
    await normalExit()
    if (JSON.stringify(beforeMove) !== JSON.stringify(assertLibrary())) throw new Error('Portable move changed note/attachment readback')
    await evidence.capture('unwritable-startup', 'Copy only this exe to an isolated directory and deny the test user write permission via Windows Security/ACL; launch it from another cwd. Restore ACL afterward; inspect cwd/TEMP for unintended new libraries.', 'Startup explicitly fails, no fallback library is created in cwd/TEMP/APPDATA')
    if (!existsSync(path.join(appDir, 'data/webview/EBWebView'))) throw new Error('WebView cache is not portable')
    await evidence.capture('cache-location', `Inspect WebView2 process command line for the relocated exe and ${path.join(appDir, 'data/webview/EBWebView')}.`, 'Actual --user-data-dir is beside the relocated exe, not system AppData; ordinary logs/state/preferences also remain there')
    evidence.report.status = 'passed'
  } finally {
    evidence.close()
    console.log(`Isolated library and screenshots retained: ${stage}`)
    // Failure cleanup only. This never substitutes for the normal-exit assertions.
    if (child && child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'inherit' })
  }
}
