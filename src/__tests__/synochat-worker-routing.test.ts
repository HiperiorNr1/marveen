import { describe, it, expect } from 'vitest'
import { resolveSessionForAgent } from '../web/synochat-worker.js'
import { MAIN_AGENT_ID } from '../config.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
import { agentSessionName } from '../web/agent-process.js'

// Locks the Phase-2 inbound routing convention. The plugin's HTTP listener
// stamps incoming_messages.agent at ingest based on the bot-token map; the
// worker resolves that slug into a tmux session via this helper.
//
// Two distinct conventions, lifted from the actual spawners:
//   - Main agent  -> MAIN_CHANNELS_SESSION = `${MAIN_AGENT_ID}-channels`
//     (main-agent.ts:9, started by channels.sh + systemd).
//   - Sub-agents  -> agentSessionName(slug) = `agent-${slug}`
//     (agent-process.ts:31, started by startAgentProcess via the dashboard).
// Cross-talk risk if we route a sub-agent into `${slug}-channels`: the
// session doesn't exist, isSessionReadyForPrompt returns false, and the row
// stays pending forever. So we DELEGATE to the same helper the spawner uses.
describe('resolveSessionForAgent', () => {
  it('routes the main agent slug back to MAIN_CHANNELS_SESSION', () => {
    expect(resolveSessionForAgent(MAIN_AGENT_ID)).toBe(MAIN_CHANNELS_SESSION)
  })

  it('routes a sub-agent slug to agentSessionName(slug) = `agent-${slug}`', () => {
    expect(resolveSessionForAgent('kelvin')).toBe(agentSessionName('kelvin'))
    expect(resolveSessionForAgent('kelvin')).toBe('agent-kelvin')
    expect(resolveSessionForAgent('dia')).toBe(agentSessionName('dia'))
    expect(resolveSessionForAgent('dia')).toBe('agent-dia')
  })

  it('falls back to MAIN_CHANNELS_SESSION for legacy rows with no agent', () => {
    expect(resolveSessionForAgent(null)).toBe(MAIN_CHANNELS_SESSION)
    expect(resolveSessionForAgent(undefined)).toBe(MAIN_CHANNELS_SESSION)
    expect(resolveSessionForAgent('')).toBe(MAIN_CHANNELS_SESSION)
  })
})
