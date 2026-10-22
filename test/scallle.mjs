// Plays Scallle's side of the contract (docs/automation-connector-contract.md
// in scallle-app): builds a job, signs it the way Scallle signs jobs for n8n,
// and POSTs it. Node built-ins only.

import { createHash, createHmac, randomUUID } from 'node:crypto'

const base64url = (input) => Buffer.from(input).toString('base64url')

/**
 * HS256 JWT with the contract's claims:
 *   iss "scallle", aud connection_id, sub run.id, iat now, exp now + 300 s,
 *   jti unique per send, body_sha256 = hex SHA-256 of the exact body bytes.
 * `overrides` replaces claims, to build the bad tokens the tests need.
 */
export function signJob(bodyBytes, job, secret, overrides = {}) {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: 'scallle',
    aud: job.connection_id,
    sub: job.run.id,
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
    body_sha256: createHash('sha256').update(bodyBytes).digest('hex'),
    ...overrides,
  }
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify(claims))
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

/** A job shaped exactly like §1 of the contract. `test: true` marks it a test
 *  job, as Scallle's "Send a test" does (run.test); left out, the job says
 *  nothing about it, as jobs from before run.test do. `context`, `fields`,
 *  `fill` and `sentBackNote` (step.sent_back_note) are only in the job when
 *  given, so by default it is the shape a Scallle from before 21 Oct 2026
 *  sends. */
export function makeJob({
  runId, connectionId, automationId, workspaceId, callbackOrigin, item, procedure, test,
  context, fields, fill, sentBackNote,
}) {
  return {
    version: 1,
    connection_id: connectionId,
    issued_at: new Date().toISOString(),
    run: { id: runId, automation_id: automationId, workspace_id: workspaceId, ...(test === undefined ? {} : { test }) },
    step: {
      title: 'Summarise the weekly check-in',
      procedure: procedure ?? 'Write a three-line summary of the check-in for the key worker. Flag anything that needs a follow-up.',
      ...(sentBackNote === undefined ? {} : { sent_back_note: sentBackNote }),
    },
    ...(context === undefined ? {} : { context }),
    item,
    ...(fields === undefined ? {} : { fields }),
    ...(fill === undefined ? {} : { fill }),
    callback: {
      url: `${callbackOrigin}/api/automations/${automationId}/runs/${runId}?token=cb-${runId}`,
    },
  }
}

/**
 * POST a job to the n8n webhook. Returns the status, the parsed reply and how
 * long the reply took. `bodyBytes` lets a test send bytes other than the ones
 * it signed; `token: null` sends no Authorization header.
 */
export async function sendJob(webhookUrl, { job, bodyBytes, token }) {
  const bytes = bodyBytes ?? Buffer.from(JSON.stringify(job))
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const started = Date.now()
  const res = await fetch(webhookUrl, { method: 'POST', headers, body: bytes, redirect: 'manual' })
  const text = await res.text()
  const replyAt = Date.now()
  let reply = text
  try {
    reply = JSON.parse(text)
  } catch {}
  return { status: res.status, reply, ms: replyAt - started, sentAt: started, replyAt }
}
