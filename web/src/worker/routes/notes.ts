import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { historyRoutes } from './notes/history'
import { listRoutes } from './notes/list'
import { mutationRoutes } from './notes/mutation'
import { versionRoutes } from './notes/versions'

export const notesRoutes = new Hono<AppBindings>()

notesRoutes.use('*', requireAuth)
notesRoutes.route('/', listRoutes)
notesRoutes.route('/', mutationRoutes)
notesRoutes.route('/', historyRoutes)
notesRoutes.route('/', versionRoutes)

