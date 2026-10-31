import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { registerNotesListRoutes } from './notes-list'
import { registerNotesWriteRoutes } from './notes-write'
import { registerNotesLifecycleRoutes } from './notes-lifecycle'
import { registerNotesVersionRoutes } from './notes-versions'
import { registerNotesBacklinkRoutes } from './notes-backlinks'

export const notesRoutes = new Hono<AppBindings>()
notesRoutes.use('*', requireAuth)
registerNotesListRoutes(notesRoutes)
registerNotesWriteRoutes(notesRoutes)
registerNotesLifecycleRoutes(notesRoutes)
registerNotesVersionRoutes(notesRoutes)
registerNotesBacklinkRoutes(notesRoutes)
