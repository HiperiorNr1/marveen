import { describe, it, expect } from 'vitest'
import { resolveSessionForAgent } from '../web/synochat-worker.js'
import { MAIN_AGENT_ID } from '../config.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

// Locks the Phase-2 inbound routing convention. The plugin's HTTP listener
// stamps incoming_messages.agent at ingest based on the bot-token map; the
// worker resolves that slug into a tmux session via this helper. The mapping
// MUST be {slug: `${slug}-channels`} so it matches main-agent.ts:9 for the
// main agent AND extends consistently to sub-agents.
describe('resolveSessionForAgent', () => {
  it('routes the main agent slug back to MAIN_CHANNELS_SESSION', () => {
    expect(resolveSessionForAgent(MAIN_AGENT_ID)).toBe(MAIN_CHANNELS_SESSION)
  })

  it('routes a sub-agent slug to `${slug}-channels`', () => {
    expect(resolveSessionForAgent('kelvin')).toBe('kelvin-channels')
    expect(resolveSessionForAgent('dia')).toBe('dia-channels')
  })

  it('falls back to MAIN_CHANNELS_SESSION for legacy rows with no agent', () => {
    expect(resolveSessionForAgent(null)).toBe(MAIN_CHANNELS_SESSION)
    expect(resolveSessionForAgent(undefined)).toBe(MAIN_CHANNELS_SESSION)
    expect(resolveSessionForAgent('')).toBe(MAIN_CHANNELS_SESSION)
  })
})
