import type {
  OrganizeMutationEntity,
  OrganizeSnapshot,
  OrganizeStateAdapter,
} from './mutation-utils'

interface ActiveMutation {
  mutationId: string
  entity: OrganizeMutationEntity
  before: object
  patch: object
  apply(snapshot: OrganizeSnapshot): Partial<OrganizeSnapshot>
  rollback(snapshot: OrganizeSnapshot): Partial<OrganizeSnapshot>
}
export interface MutationQueueContext {
  tails: Map<OrganizeMutationEntity, Promise<void>>
  pending: Map<OrganizeMutationEntity, ActiveMutation[]>
  state: OrganizeStateAdapter
}
export async function enqueueMutation<T>(
  context: MutationQueueContext,
  mutation: ActiveMutation,
  operation: () => Promise<T>,
  adopt: (result: T) => Promise<void>,
): Promise<T> {
  const previous = context.tails.get(mutation.entity) ?? Promise.resolve()
  const run = previous.then(async () => {
    try {
      const result = await operation()
      const remaining = (context.pending.get(mutation.entity) ?? []).filter(
        (item) => item.mutationId !== mutation.mutationId,
      )
      if (remaining.length > 0) context.pending.set(mutation.entity, remaining)
      else context.pending.delete(mutation.entity)
      await adopt(result)
      return result
    } catch (error) {
      const remaining = (context.pending.get(mutation.entity) ?? []).filter(
        (item) => item.mutationId !== mutation.mutationId,
      )
      if (remaining.length > 0) context.pending.set(mutation.entity, remaining)
      else context.pending.delete(mutation.entity)
      context.state.write(mutation.rollback(context.state.read()))
      for (const group of context.pending.values())
        for (const pending of group)
          context.state.write(pending.apply(context.state.read()))
      throw error
    } finally {
      const group = (context.pending.get(mutation.entity) ?? []).filter(
        (item) => item.mutationId !== mutation.mutationId,
      )
      if (group.length > 0) context.pending.set(mutation.entity, group)
      else context.pending.delete(mutation.entity)
    }
  })
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  context.tails.set(mutation.entity, tail)
  void tail.then(() => {
    if (context.tails.get(mutation.entity) === tail)
      context.tails.delete(mutation.entity)
  })
  return run
}
