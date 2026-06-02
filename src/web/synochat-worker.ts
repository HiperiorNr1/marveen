import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { wrapUntrusted, UNTRUSTED_PREAMBLE } from '../prompt-safety.js'
import { sendPromptToSession, isSessionReadyForPrompt } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { getSecret } from './vault.js'

// The synology-chat plugin (a separate Bun process) writes inbound messages
// into this SQLite queue. We poll it here and inject each pending message
// into the main agent's tmux session so the agent can reply with the
// plugin's mcp__synology-chat__reply tool. This is the bridge that connects
// the two otherwise-independent directions of the channel.
//
// Path must match SYNOLOGY_CHAT_QUEUE_DB_PATH in the plugin's .env (absolute
// and shared, so the plugin's two A1 instances and this worker all agree).
const QUEUE_DB = join(PROJECT_ROOT, 'store', 'synochat-queue.db')
const POLL_MS = 5000
const BATCH = 5

// Liveness ack: the moment a message is handed to the agent we send a short
// "seen, working on it" line back to the channel. Lets the human tell the
// chain is alive (worker running + session ready) without waiting for the
// real reply -- if no ack lands, the system is down and they can react.
const ACK_TEXT = '👀 dolgozom rajta'
// Same vault key the plugin's .env points SYNOLOGY_CHAT_INCOMING_WEBHOOK_URL at;
// the URL carries the incoming-webhook token in its query string.
const INCOMING_URL_VAULT_KEY = 'incoming_webhook_url_efi-ai'

// Fire-and-forget POST to Synology's incoming webhook, mirroring the plugin's
// callReply payload shape (user_ids targets the DM/channel). Never throws into
// the poll loop -- a failed ack must not stall delivery.
async function sendSynoAck(channelId: string, threadId?: string): Promise<void> {
  const url = getSecret(INCOMING_URL_VAULT_KEY)
  if (!url) {
    logger.warn('SynoChat ack skipped: incoming webhook URL not in vault')
    return
  }
  const payload: { text: string; user_ids: number[]; thread_id?: number } = {
    text: ACK_TEXT,
    user_ids: [Number(channelId)],
  }
  // Keep the ack in the same thread as the reply so a topic stays in one chain.
  const tid = Number(threadId)
  if (Number.isFinite(tid) && tid > 0) payload.thread_id = tid
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    logger.warn({ status: res.status }, 'SynoChat ack POST non-OK')
  }
}

function pollOnce(): void {
  if (!existsSync(QUEUE_DB)) return
  // Don't inject while the session is busy/parked -- leave the rows pending
  // and retry next tick (mirrors the schedule-runner's skip-if-busy posture).
  if (!isSessionReadyForPrompt(MAIN_CHANNELS_SESSION)) return

  let db: Database.Database | undefined
  try {
    db = new Database(QUEUE_DB)
    db.pragma('busy_timeout = 5000')
    const pending = db
      .prepare(
        `SELECT id, user_id, username, channel_id, text, post_id, thread_id
         FROM incoming_messages WHERE status='pending'
         ORDER BY id ASC LIMIT ?`,
      )
      .all(BATCH) as Array<{
        id: number
        user_id: string
        username: string
        channel_id: string
        text: string
        post_id: string | null
        thread_id: string | null
      }>

    for (const msg of pending) {
      // SynoChat input is external (a colleague typed it) -> untrusted.
      const wrapped = wrapUntrusted(`synology-chat:user-${msg.user_id}`, msg.text)
      // Thread target: if the colleague already wrote inside a thread, reuse it;
      // otherwise root a new thread on this message's post_id. Keeps each topic
      // in one chain instead of scattering replies across the chat.
      const replyThreadId =
        msg.thread_id && msg.thread_id !== '0' ? msg.thread_id : msg.post_id || ''
      const threadHint = replyThreadId ? `, thread_id=${replyThreadId}` : ''
      const prompt =
        `${UNTRUSTED_PREAMBLE}\n` +
        `[Synology Chat uzenet -- user_id=${msg.user_id} (${msg.username || 'ismeretlen'}), channel_id=${msg.channel_id}]:\n` +
        `${wrapped}\n` +
        `Valaszolj a mcp__synology-chat__reply tool-lal (channel_id=${msg.channel_id}${threadHint}). ` +
        `A thread_id-t add at valtozatlanul, hogy a valasz a kerdes hozzaszolas-lancaba keruljon. ` +
        `A SynoChat a belso kollegak csatornaja; tartsd szem elott az ugyfel-PII vedelmet.`
      try {
        sendPromptToSession(MAIN_CHANNELS_SESSION, prompt)
        db.prepare(
          "UPDATE incoming_messages SET status='delivered', delivered_at=strftime('%s','now') WHERE id=?",
        ).run(msg.id)
        logger.info({ id: msg.id, user: msg.user_id }, 'SynoChat message delivered to agent')
        // Liveness ack -- fire-and-forget so a slow/failed POST never stalls
        // the loop or blocks the next message's delivery. Same thread as reply.
        void sendSynoAck(msg.channel_id, replyThreadId).catch((err) =>
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), id: msg.id },
            'SynoChat ack failed',
          ),
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        db.prepare(
          "UPDATE incoming_messages SET status='failed', failed_at=strftime('%s','now'), last_error=? WHERE id=?",
        ).run(errMsg, msg.id)
        logger.warn({ err: errMsg, id: msg.id }, 'SynoChat delivery to agent failed')
      }
    }
  } catch (err) {
    logger.warn({ err }, 'SynoChat worker poll error')
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}

export function startSynoChatWorker(): ReturnType<typeof setInterval> {
  return setInterval(pollOnce, POLL_MS)
}
