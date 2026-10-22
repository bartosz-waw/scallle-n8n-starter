#!/usr/bin/env node
// A job signed by SCALLLE'S OWN SENDER is accepted by this template.
//
//   node test/app-signed-job.mjs     (a second or two; no n8n needs to run)
//
// test/fixtures/app-signed-job.json is made by Scallle's real signer and
// copied here unchanged apart from its note. Test values only: a made-up n8n secret, business and
// run (its Ed25519 half is for the Vercel Workflows starter and isn't used
// here).
//
//   · what the Webhook node's JWT Auth does with a passphrase: n8n's own
//     jsonwebtoken, `verify(token, secret, { algorithms: ['HS256'] })`
//     (n8n-nodes-base Webhook/utils.js). Needs test/setup.sh first, or
//     N8N_JSONWEBTOKEN pointing at a jsonwebtoken folder; skipped otherwise;
//   · the contract's rules as "Check the job" applies them: iss, the 5-minute
//     lifetime, the body's hash, aud = the connection, sub = the run;
//   · the template's own "Check the job" code, run on the job with its four
//     `// scallle:…` lines filled in as Scallle's download fills them: it says
//     genuine, and a test run;
//   · the template's own "Prepare the prompt" code, run on the job: Claude
//     gets its item, what each field is, about this run and the row it may
//     fill, each in its own tags, and the extra rules.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const job = JSON.parse(readFileSync(join(here, 'fixtures', 'app-signed-job.json'), 'utf8'))
const template = JSON.parse(readFileSync(process.env.TEMPLATE ?? join(here, '..', 'scallle-step.json'), 'utf8'))
const token = job.headers.authorization.split(' ')[1]
const body = JSON.parse(job.body)

/** n8n's own jsonwebtoken, from the local n8n runtime (test/setup.sh), or
 *  wherever N8N_JSONWEBTOKEN points. */
function n8nJsonwebtoken() {
  const candidates = [process.env.N8N_JSONWEBTOKEN, join(here, '.runtime', 'node_modules', 'jsonwebtoken')].filter(Boolean)
  for (const p of candidates) {
    if (existsSync(p)) return createRequire(import.meta.url)(p)
  }
  return null
}
const jwt = n8nJsonwebtoken()

test('the Webhook node’s JWT Auth (n8n’s own jsonwebtoken, passphrase, HS256) verifies it', { skip: !jwt && 'n8n isn’t installed for the test: run test/setup.sh' }, () => {
  const at = job.now_ms / 1000
  const payload = jwt.verify(token, job.secret, { algorithms: ['HS256'], clockTimestamp: at })
  assert.equal(payload.sub, body.run.id)
  assert.throws(() => jwt.verify(token, 'another-secret', { algorithms: ['HS256'], clockTimestamp: at }))
  assert.throws(() => jwt.verify(token, job.secret, { algorithms: ['HS256'], clockTimestamp: at + 301 }), /expired/)
})

test('the contract’s rules pass: iss, 5-minute lifetime, body hash, aud, sub', () => {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  assert.equal(claims.iss, 'scallle')
  assert.ok(claims.exp - claims.iat <= 300)
  assert.ok(Math.abs(job.now_ms / 1000 - claims.iat) <= 300)
  assert.equal(String(claims.body_sha256).toLowerCase(), createHash('sha256').update(job.body, 'utf8').digest('hex'))
  assert.equal(claims.aud, body.connection_id)
  assert.equal(claims.sub, body.run.id)
  assert.match(body.run.id, /^[A-Za-z0-9_-]+$/)
})

/** Runs the template's "Check the job" code as n8n would, at the fixture's time. */
function runCheckTheJob(fill, receivedSha256 = createHash('sha256').update(job.body, 'utf8').digest('hex')) {
  const node = template.nodes.find((n) => n.name === 'Check the job')
  assert.ok(node, 'the template has a "Check the job" node')
  const code = String(node.parameters.jsCode)
    .split('\n')
    .map((line) => {
      const key = /\/\/ scallle:(\w+)$/.exec(line)?.[1]
      if (!key) return line
      assert.ok(key in fill, `a fill-in line for ${key}`)
      return line.replace(/'[^']*'/, `'${fill[key]}'`)
    })
    .join('\n')
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  const inputs = {
    'Scallle job': { json: { jwtPayload: claims, body } },
  }
  const $ = (name) => ({ first: () => inputs[name] })
  const $input = { first: () => ({ json: { received_body_sha256: receivedSha256 } }) }
  class FixtureDate extends Date {
    static now() {
      return job.now_ms
    }
  }
  return new Function('$', '$input', 'Date', code)($, $input, FixtureDate)[0].json
}

const FILL = {
  app_url: job.app_origin,
  workspace_id: body.run.workspace_id,
  connection_id: body.connection_id,
  automation_id: body.run.automation_id,
}

test('the template’s own “Check the job” says genuine, and a test run', () => {
  assert.deepEqual(runCheckTheJob(FILL), { genuine: true, reason: null, test: true })
})

test('…and refuses it for another business, or with the body changed', () => {
  const other = runCheckTheJob({ ...FILL, workspace_id: '99999999-9999-4999-8999-999999999999' })
  assert.deepEqual(other, { genuine: false, reason: 'This job is for a different business.' })
  const changed = runCheckTheJob(FILL, createHash('sha256').update(job.body.replace('Sam', 'Sal'), 'utf8').digest('hex'))
  assert.deepEqual(changed, { genuine: false, reason: 'This job was changed after Scallle signed it.' })
})

test('the template’s own “Prepare the prompt” gives Claude everything the real job describes, as data', () => {
  const node = template.nodes.find((n) => n.name === 'Prepare the prompt')
  assert.ok(node, 'the template has a "Prepare the prompt" node')
  const $ = (name) => ({ first: () => ({ 'Scallle job': { json: { body } } })[name] })
  const { user, rules } = new Function('$', String(node.parameters.jsCode))($)[0].json
  assert.ok(user.startsWith('<item>\n' + JSON.stringify(body.item, null, 2) + '\n</item>\n'))
  assert.ok(user.includes('<fields>\n- customer_name: “Customer name” (text, required)\n- enquiry: “Enquiry” (text)\n</fields>'))
  assert.ok(user.includes('<about_this_run>\n' + JSON.stringify(body.context, null, 2) + '\n</about_this_run>'))
  assert.ok(user.includes('<fill>\n- follow_up: “Follow-up email” (text)\n</fill>'))
  assert.ok(!user.includes('<sent_back_note>'), 'no note on this job')
  assert.match(rules, /^\n- Besides <item>/)
  assert.match(rules, /\n- There is a <fill> list/)
})
