// Two small local servers the end-to-end test points n8n at:
//
//   - a stand-in for Scallle's callback endpoint, which records every result
//     POSTed to /api/automations/<automation id>/runs/<run id>?token=...
//   - a stand-in for Anthropic's Messages API (POST /v1/messages), which the
//     template's Anthropic credential reaches through its "Base URL" field.
//
// Both keep everything in memory, keyed by run id, so test cases can run in
// parallel. Nothing here talks to the internet.

import { createServer } from 'node:http'

/** Read a request body as text. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

/**
 * Scallle's callback endpoint. Like the real one, it answers 200 to every
 * well-formed result, and `{ ok: false, reason: 'run closed' }` to a repeat.
 * A run whose id starts with "flaky-" gets one 503 first, to exercise n8n's
 * Retry On Fail; one starting "flaky-long-" gets three, more than one round of
 * Retry On Fail, to exercise the template's "When to try again" loop.
 *
 * It also stands in for an outside app a workflow acts on (an Outlook draft,
 * say): a POST to /app-action/<run id> is counted, so a test can tell whether
 * a step on the "Real run, not a test?" branch ran.
 */
export async function startCallbackServer() {
  const results = [] // { runId, automationId, token, body, at }
  const attempts = new Map() // runId -> number of POSTs
  const appActions = new Map() // runId -> number of POSTs to /app-action/<run id>
  const appActionBodies = new Map() // runId -> the JSON bodies of those POSTs
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const action = /^\/app-action\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'POST' && action) {
      const raw = await readBody(req)
      appActions.set(action[1], (appActions.get(action[1]) ?? 0) + 1)
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {}
      appActionBodies.set(action[1], [...(appActionBodies.get(action[1]) ?? []), parsed])
      return sendJson(res, 200, { ok: true })
    }
    const match = /^\/api\/automations\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname)
    if (req.method !== 'POST' || !match) return sendJson(res, 404, { ok: false })
    const [, automationId, runId] = match
    const raw = await readBody(req)
    const tries = (attempts.get(runId) ?? 0) + 1
    attempts.set(runId, tries)
    const failFirst = runId.startsWith('flaky-long-') ? 3 : runId.startsWith('flaky-') ? 1 : 0
    if (tries <= failFirst) {
      return sendJson(res, 503, { ok: false, reason: 'try again' })
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      return sendJson(res, 400, { ok: false, reason: 'not json' })
    }
    const closed = results.some((r) => r.runId === runId)
    results.push({ runId, automationId, token: url.searchParams.get('token'), body, at: Date.now() })
    return sendJson(res, 200, closed ? { ok: false, reason: 'run closed' } : { ok: true })
  })
  const port = await listen(server)
  return {
    origin: `http://127.0.0.1:${port}`,
    resultsFor: (runId) => results.filter((r) => r.runId === runId),
    attemptsFor: (runId) => attempts.get(runId) ?? 0,
    appActionsFor: (runId) => appActions.get(runId) ?? 0,
    appActionBodiesFor: (runId) => appActionBodies.get(runId) ?? [],
    all: () => results,
    /** Wait until `count` results have arrived for a run (or give up). */
    async waitFor(runId, count = 1, timeoutMs = 30_000) {
      const end = Date.now() + timeoutMs
      while (Date.now() < end) {
        if (results.filter((r) => r.runId === runId).length >= count) break
        await new Promise((r) => setTimeout(r, 100))
      }
      return results.filter((r) => r.runId === runId)
    },
    close: () => new Promise((r) => server.close(r)),
  }
}

/**
 * Anthropic's Messages API, non-streaming (n8n's Anthropic node sends plain
 * JSON requests). It checks the request the way the real API would for
 * claude-opus-5-5, and picks a behaviour from the item's "scenario" field,
 * which arrives inside the user message:
 *
 *   ok (default)  a normal answer: an (empty) thinking block, then text
 *   slow          the same, after 3 seconds
 *   ai-500        500 api_error
 *   ai-401        401 authentication_error
 *   refusal       stop_reason "refusal" with stop_details
 *   max-tokens    stop_reason "max_tokens"
 *   fill          the draft inside <result> tags, then a <field> for each row
 *                 the user message's <fill> lists (a number row gets " 3 ",
 *                 any other "Filled by the mock: <name>") and one row nobody
 *                 asked for ("not_asked_for"), to prove it is dropped. The
 *                 first row's tag is written inside <result>, to prove it
 *                 fills its row and its markup is taken out of the draft
 */
export async function startAnthropicMock() {
  const calls = [] // { runId, scenario, headers, body, at, answeredAt }
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/messages') {
      return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } })
    }
    const body = JSON.parse(await readBody(req))
    const user = (body.messages ?? []).find((m) => m.role === 'user')
    const userText = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '')
    const scenario = /"scenario":\s*"([^"]+)"/.exec(userText)?.[1] ?? 'ok'
    const runId = /"run_marker":\s*"([^"]+)"/.exec(userText)?.[1] ?? null
    const call = { runId, scenario, headers: req.headers, body, userText, at: Date.now(), answeredAt: null }
    calls.push(call)
    const answer = (status, payload) => {
      call.answeredAt = Date.now()
      sendJson(res, status, payload)
    }
    const invalid = (message) =>
      answer(400, { type: 'error', error: { type: 'invalid_request_error', message } })

    // What the real API refuses for this model.
    if (!req.headers['x-api-key']) {
      return answer(401, { type: 'error', error: { type: 'authentication_error', message: 'x-api-key header is required' } })
    }
    if (!req.headers['anthropic-version']) return invalid('anthropic-version header is required')
    if (body.stream) return invalid('this mock answers non-streaming requests only')
    for (const field of ['temperature', 'top_p', 'top_k']) {
      if (body[field] !== undefined) return invalid(`${field} is not supported on this model`)
    }
    if (body.thinking?.type === 'disabled' || body.thinking?.budget_tokens) {
      return invalid('thinking cannot be disabled or budgeted on this model')
    }

    const message = (content, stopReason, extra = {}) => ({
      id: `msg_mock_${calls.length}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 412, output_tokens: 57, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ...extra,
    })
    const thinking = { type: 'thinking', thinking: '', signature: 'mock-signature' }

    switch (scenario) {
      case 'ai-500':
        return answer(500, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } })
      case 'ai-401':
        return answer(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
      case 'refusal':
        return answer(200, message([], 'refusal', {
          stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined by the mock.' },
        }))
      case 'max-tokens':
        return answer(200, message([thinking, { type: 'text', text: 'DRAFT: the start of an answer that' }], 'max_tokens'))
      case 'fill': {
        const list = /<fill>\n([\s\S]*?)\n<\/fill>/.exec(userText)?.[1] ?? ''
        const fields = list.split('\n').flatMap((line) => {
          const name = /^- ([A-Za-z0-9_-]+): /.exec(line)?.[1]
          const value = /\((?:number)[,)]/.test(line) ? ' 3 ' : `Filled by the mock: ${name}`
          return name ? [`<field name="${name}">${value}</field>`] : []
        })
        const [first = '', ...rest] = fields
        const text = [`<result>DRAFT: Weekly check-in summary for the item.\n${first}</result>`, ...rest,
          '<field name="not_asked_for">dropped</field>'].join('\n')
        return answer(200, message([thinking, { type: 'text', text }], 'end_turn'))
      }
      case 'slow':
        await new Promise((r) => setTimeout(r, 3000))
      // falls through
      default:
        return answer(200, message([thinking, { type: 'text', text: 'DRAFT: Weekly check-in summary for the item.' }], 'end_turn'))
    }
  })
  const port = await listen(server)
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    callsFor: (runId) => calls.filter((c) => c.runId === runId),
    all: () => calls,
    close: () => new Promise((r) => server.close(r)),
  }
}
