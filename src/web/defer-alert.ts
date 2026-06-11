import { logger } from '../logger.js'
import { notifyChannel } from '../notify.js'

// Operator alert for messages stuck behind a deferral. Two causes qualify:
//   'human'   -- the interference guard keeps deferring because a human
//                client is active in the target pane;
//   'blocked' -- the session never becomes ready (modal / unknown pane
//                state) despite the proactive unblock attempts.
// 'busy' never alerts: a long-running turn is normal operation.
//
// Delivery route is notifyChannel (direct Bot API POST from this process),
// NOT an inter-agent relay -- the relay rides the same message-router whose
// stall this alert reports, so it could strand alongside the message.
//
// Dedup is per message key, in-memory: one alert per stuck message, cleared
// on delivery/failure so the set stays bounded. A dashboard restart resets
// it (worst case: one repeat alert per still-stuck message) -- accepted.

export type DeferCause = 'human' | 'blocked' | 'busy'

export const DEFER_ALERT_AFTER_MS = 10 * 60 * 1000

// Pure decision, unit-tested separately from the I/O below.
export function shouldSendDeferAlert(
  ageMs: number,
  cause: DeferCause,
  alreadySent: boolean,
  thresholdMs: number = DEFER_ALERT_AFTER_MS,
): boolean {
  return !alreadySent && cause !== 'busy' && ageMs > thresholdMs
}

const sentAlertKeys = new Set<string>()

const CAUSE_LABEL: Record<Exclude<DeferCause, 'busy'>, string> = {
  human: 'emberi kliens aktiv a pane-ben, az injektalas halasztva',
  blocked: 'a session nem fogad promptot (modal vagy ismeretlen pane-allapot)',
}

export function maybeSendDeferAlert(opts: {
  key: string
  ageMs: number
  cause: DeferCause
  session: string
  what: string
}): void {
  if (!shouldSendDeferAlert(opts.ageMs, opts.cause, sentAlertKeys.has(opts.key))) return
  sentAlertKeys.add(opts.key)
  const ageMin = Math.round(opts.ageMs / 60_000)
  logger.warn(
    { key: opts.key, session: opts.session, cause: opts.cause, ageMin },
    'Delivery deferred past alert threshold -- notifying operator',
  )
  const causeLabel = CAUSE_LABEL[opts.cause as Exclude<DeferCause, 'busy'>]
  void notifyChannel(
    `⏳ Kezbesites elakadva: ${opts.what} mar ${ageMin} perce var a(z) ${opts.session} session-re. Ok: ${causeLabel}. Az uzenet nem veszett el, kezbesitjuk amint a session felszabadul.`,
  ).catch(() => { /* notifyChannel already logs internally */ })
}

export function clearDeferAlert(key: string): void {
  sentAlertKeys.delete(key)
}
