export interface LeaderClaim {
  readonly clientId: string
  readonly at: number
}

export function compareClaims(left: LeaderClaim, right: LeaderClaim): number {
  return left.at - right.at || left.clientId.localeCompare(right.clientId)
}
