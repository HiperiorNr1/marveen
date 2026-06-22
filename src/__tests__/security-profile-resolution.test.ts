import { describe, it, expect } from 'vitest'
import { resolveSecurityProfileId } from '../web/agent-team.js'

// Role-derived applier-pool resolution (per-agent Supabase governance).
// resolveSecurityProfileId(storedProfile, team) ->
//   explicit non-default profile wins, else role==='leader' ? 'applier' : 'default'.
describe('resolveSecurityProfileId', () => {
  it('respects an explicit non-default profile (override)', () => {
    expect(resolveSecurityProfileId('sub-dev', { role: 'member' })).toBe('sub-dev')
    expect(resolveSecurityProfileId('applier', { role: 'leader' })).toBe('applier')
    expect(resolveSecurityProfileId('sub-dev', { role: 'leader' })).toBe('sub-dev')
  })

  it('role-derives a leader to the applier pool', () => {
    expect(resolveSecurityProfileId('default', { role: 'leader' })).toBe('applier')
    expect(resolveSecurityProfileId(null, { role: 'leader' })).toBe('applier')
    expect(resolveSecurityProfileId(undefined, { role: 'leader' })).toBe('applier')
    // explicit 'default' on a leader still resolves to applier (role wins over the fallback value)
    expect(resolveSecurityProfileId('default', { role: 'leader' })).toBe('applier')
  })

  it('role-derives every non-leader to the denied default (deny-by-default)', () => {
    // CRITICAL: a default-team member (reportsTo=null is the DEFAULT) must NOT be
    // exempted. The signal is role, not reportsTo -- otherwise deny-by-default breaks.
    expect(resolveSecurityProfileId('default', { role: 'member' })).toBe('default')
    expect(resolveSecurityProfileId(null, { role: 'member' })).toBe('default')
    expect(resolveSecurityProfileId(undefined, { role: 'member' })).toBe('default')
    expect(resolveSecurityProfileId('', { role: 'member' })).toBe('default')
    expect(resolveSecurityProfileId('  ', { role: 'member' })).toBe('default')
  })

  it('is name-agnostic (keys off role only)', () => {
    // Same role -> same result regardless of any agent identity; the resolver
    // takes no name, so a customer install elevates its own leader, not ours.
    expect(resolveSecurityProfileId(null, { role: 'leader' })).toBe('applier')
    expect(resolveSecurityProfileId(null, { role: 'member' })).toBe('default')
  })
})
