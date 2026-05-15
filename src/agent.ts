import { query } from '@anthropic-ai/claude-agent-sdk'
import { PROJECT_ROOT } from './config.js'
import { recordTokenUsage } from './db.js'

const TYPING_REFRESH_MS = 4000
import { logger } from './logger.js'

const AGENT_TIMEOUT_MS = Number(process.env.MARVEEN_AGENT_TIMEOUT_MS) || 20 * 60 * 1000

// When runAgent is called for pure text generation (CLAUDE.md / SOUL.md /
// skill-md / prompt expansion / memory categorization), the model must not
// Write the file itself -- otherwise it sometimes does, then returns a short
// "Kész, létrehoztam" status instead of the markdown content, silently
// corrupting the target file the caller goes on to write.
const DEFAULT_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task']

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  allowTools = false,
  cwd: string = PROJECT_ROOT,
  env?: Record<string, string | undefined>,
  agentId: string = 'marveen-service',
): Promise<{ text: string | null; newSessionId?: string }> {
  let newSessionId: string | undefined
  let resultText: string | null = null

  const typingInterval = onTyping ? setInterval(onTyping, TYPING_REFRESH_MS) : undefined
  const abortController = new AbortController()
  const timeout = setTimeout(() => {
    logger.warn({ timeoutMs: AGENT_TIMEOUT_MS }, 'Agent timeout, megszakitas...')
    abortController.abort()
  }, AGENT_TIMEOUT_MS)

  try {
    const events = query({
      prompt: message,
      options: {
        abortController,
        cwd,
        permissionMode: 'bypassPermissions',
        ...(allowTools ? {} : { disallowedTools: DEFAULT_DISALLOWED_TOOLS }),
        ...(sessionId ? { resume: sessionId } : {}),
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
    })

    for await (const event of events) {
      if (event.type === 'system' && 'subtype' in event && (event as any).subtype === 'init') {
        newSessionId = (event as any).sessionId as string
      }
      if (event.type === 'result') {
        const r = event as any
        resultText = r.result as string ?? null
        // The SDK result event carries the canonical per-call usage and
        // its own total_cost_usd. We log verbatim so the pricing table
        // stays in one place (the SDK), and so we capture both Pro/Max
        // subscription credits and API-key spend on the same axis.
        try {
          const usage = r.usage ?? {}
          recordTokenUsage({
            agentId,
            sessionId: typeof r.session_id === 'string' ? r.session_id : null,
            numTurns: typeof r.num_turns === 'number' ? r.num_turns : null,
            durationMs: typeof r.duration_ms === 'number' ? r.duration_ms : null,
            isError: r.is_error === true,
            totalCostUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : 0,
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
            cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
            cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0),
            modelUsage: r.modelUsage && typeof r.modelUsage === 'object' ? r.modelUsage : {},
          })
        } catch (err) {
          logger.warn({ err }, 'Failed to record token usage')
        }
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError' || abortController.signal.aborted) {
      logger.warn('Agent megszakitva timeout miatt')
      const mins = Math.round(AGENT_TIMEOUT_MS / 60000)
      resultText = `A feldolgozas tullepte a ${mins} perces idokorlatot. Probald rovidebben megfogalmazni, vagy bontsd tobb lepesre.`
    } else {
      logger.error({ err }, 'Agent hiba')
      throw err instanceof Error ? err : new Error(String(err))
    }
  } finally {
    clearTimeout(timeout)
    if (typingInterval) clearInterval(typingInterval)
  }

  return { text: resultText, newSessionId }
}
