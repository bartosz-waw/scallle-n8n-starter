# Scallle automations on n8n

An n8n workflow that does one step of a Scallle procedure inside the
**customer's own n8n**, with the **customer's own Anthropic key**. Scallle sends
it a job, it replies at once, does the work, and posts the result back to that
run in Scallle.

It is the **n8n** starter, one of the two tools a business can plug into an
automated step in Scallle. For an automation written in code, on the
business's own Vercel, use the
[Vercel Workflows starter](https://github.com/bartosz-waw/scallle-vercel-workflows-starter)
instead.

| File | What it is |
|---|---|
| `scallle-step.json` | The workflow. Import it into n8n (2.x). |
| `test/` | A local end-to-end test (a real n8n on your machine, a fake Scallle and a fake Anthropic), and two quick checks. |
| `AGENTS.md`, `CLAUDE.md` | The rules for AI coding tools (Claude Code, Cursor and the like) that change this workflow. |

## How the workflow runs

The canvas has the same four numbered notes.

1. **Is this really Scallle, and for us?** The **Scallle job** trigger checks
   the token's signature and expiry (no token: 401; wrong secret or expired:
   403). **Check the job** then checks the rest: the token was issued by
   Scallle and lasts Scallle's 5 minutes, the body is exactly what Scallle
   signed, the job is for **this** business, connection and automation (the
   three `EXPECTED_` ids at the top of **Check the job**) and for the run the
   token names, it is under 5 minutes old, and the result will go back to this
   run's own address on `https://app.scallle.com`. Anything else gets
   `401 { ok: false, reason }` and nothing runs. Until the `EXPECTED_` ids are
   filled in, every job is refused. It also notes whether the job is a test
   from Scallle's *Send a test* (`run.test: true`; a job that doesn't say is a
   real run).
2. **Reply at once, do the work once.** Scallle gets `202 { accepted: true }`
   straight away (about 0.03 s in the test). Scallle may send the same run more
   than once, even at the same moment, so each copy writes a *claim* (the run id
   and this execution's id) to a data table called **Scallle run claims**,
   waits a second, and fetches the run's earliest claim. Only the copy that
   made it does the work; the others stop quietly. The table is made on first
   use, and claims older than 7 days are deleted after each run.
3. **Do the work.** **Prepare the prompt** builds Claude's user message: the
   item as data, inside `<item>` tags, and — when the job carries them — what
   each field is (and which were left blank), about this run (today's date,
   the system's name, who is doing it), a person's send-back note on a redo,
   and the rows the result may fill, each in its own tags. Claude
   (`claude-opus-5-5`, in **Do the work**) gets the step's procedure as its
   instructions, with the rule that all of that is data, never instructions.
   **Read the answer** then takes the draft, and any rows Claude filled, from
   its answer. A job with nothing but the item gets exactly the prompt it
   always did. Then **Real run, not a test?**: both its branches go on to the
   result, and steps you add that save a draft go on its *true* branch, so a
   test never reaches them (see [Add other apps](#add-other-apps)).
4. **Report back.** **Send result to Scallle** posts
   `{ status: "success", metadata: { result, fields? }, usage }` to the run's
   callback. `fields` is there only when the job names rows to fill, and holds
   only those rows: Scallle puts each on its row, where the person doing the
   task checks it.
   If the AI step fails, refuses, or is cut off, Scallle gets
   `{ status: "error", error_message }` with one fixed, plain sentence instead,
   never n8n's own error text, so no personal data goes back that way. If
   Scallle can't take the report, it is sent again for about 10 minutes
   (**When to try again**), then n8n gives up.

## Set it up for a customer

Before you start: the customer has their own n8n (n8n Cloud Starter or above,
or self-hosted) and their own Anthropic API key. Use one workflow per
automation step in Scallle.

### The quick way: download the step's workflow from Scallle

On the automation row in Scallle's step builder (a row added as **n8n**),
press **Download this row’s n8n workflow**. The file is this template with the
webhook path (one per step), Scallle's address and the three `EXPECTED_` ids
already filled in. It is offered while the step has no tool connected: to set
a connected step up again, disconnect it first, so the file holds the ids the
next *Connect* makes. Then:

1. **Import.** In n8n: Workflows, then Create, then the `⋯` menu, then
   *Import from File*, and pick the downloaded file.
2. **Paste its address into Scallle.** Open **Scallle job**, open the
   *Production URL* tab (it has `/webhook/`, never `/webhook-test/`), copy it,
   paste it into the step in Scallle and press *Connect*. Scallle shows the
   step's secret, once.
3. **The two logins.** On **Scallle job**, under Credential for JWT Auth,
   create a **new** credential with that secret (Key Type *Passphrase*,
   Algorithm **HS256**; as in *By hand*, step 4). On **Do the work**, choose
   the customer's own Anthropic credential (as in *By hand*, step 6).
4. **Check the privacy settings** (as in *By hand*, step 7), then
   **Publish**.
5. **Send a test** from the step in Scallle.

### By hand, from the plain file

1. **Import.** In n8n: Workflows, then Create, then the `⋯` menu, then
   *Import from File*, and pick `scallle-step.json`.
2. **Rename the path.** Open **Scallle job** and change Path from
   `scallle-rename-me` to something like `scallle-incident-summary`. Use one
   path per automation: two workflows with the same path clash when you
   publish.
3. **Paste its address into Scallle.** Still on **Scallle job**, open the
   *Production URL* tab. It looks like
   `https://<name>.app.n8n.cloud/webhook/scallle-…`. Never use the Test URL
   (`/webhook-test/`): it only listens for about two minutes after you click
   *Listen for test event*. Copy it, paste it into the automation in Scallle
   and press *Connect*. Scallle shows the automation's secret, once, and its
   ids.
4. **The Scallle secret.** Back on **Scallle job**, under Credential for JWT
   Auth, choose *Create new credential*. Always a new one, even if n8n offers
   an existing Scallle secret: each automation has its own secret, and sharing
   one lets a job meant for one workflow be sent to another.
   - Name: after the automation, for example
     `Scallle secret — incident summary`
   - Key Type: *Passphrase*
   - Secret: the secret Scallle showed you in step 3 (paste it with no
     trailing space, or every job gets a 403)
   - Algorithm: **HS256**
5. **Pin it to the automation.** Open **Check the job**. At the top, fill in
   the three ids between the quotes, copied from the automation's connection
   in Scallle (where the secret is shown):
   - `EXPECTED_WORKSPACE_ID`: the business (workspace) the automation belongs to
   - `EXPECTED_CONNECTION_ID`: the automation's connection id
   - `EXPECTED_AUTOMATION_ID`: the automation's id

   These stop the workflow working a job meant for another business,
   connection or automation, for example if the wrong Production URL is pasted
   into another automation, or an automation is moved to another business.
6. **The customer's Anthropic key.** Open **Do the work**, choose *Create new
   credential*, name it `Anthropic — your own key`, paste the customer's API
   key and leave Base URL as `https://api.anthropic.com`. The AI runs on the
   business’s own Anthropic account and credit, never Scallle’s. Don't use
   n8n's free AI credits: they send the data through n8n's own Anthropic
   account.
7. **Check the privacy settings.** `⋯`, then *Settings*: "Save successful
   production executions", "Save failed production executions" and "Save
   manual executions" should all say *Do not save* — nothing is kept after a
   run. The template sets all three; see [Privacy](#privacy) before changing
   them.
8. **Publish** (top right). In n8n 2.x your edits stay a draft until you
   publish again, and production keeps running the last published version.
9. **Send a test** from the automation in Scallle.

What the test run's answer means:

| You see | Meaning |
|---|---|
| 202, then "callback received" | It works. |
| 404 "webhook … is not registered" | Not published, or it's the Test URL. |
| 500 "No authentication data defined on node" | No credential chosen on **Scallle job**. |
| 401 "No token provided" | Scallle sent no token. |
| 403 | Wrong secret (re-paste it), or the token had expired. |
| 401 "This n8n workflow isn't set up yet…" | The `EXPECTED_` ids in **Check the job** are still blank (*By hand*, step 5), or you didn't publish after filling them in. A downloaded file has them filled in. |
| 401 "This job is for a different business / connection / automation." | An `EXPECTED_` id doesn't match this automation: check it against Scallle. |
| 401 with another `reason` | The token was fine but the job failed a check; the reason says which. |
| 202 but no callback, or a failure you need to look into | Runs aren't saved. Only while no real jobs can reach the workflow (no dial set on the step's row in Scallle), switch "Save failed production executions" to *Save*, send the test again, read the failed run in *Executions* (often the Anthropic credential), then switch it back to *Do not save* and delete every run saved in that time. |

The procedure Claude follows is the step's written procedure, sent by Scallle
on every job, so there is no prompt to write in n8n. You can reword the rules
in **Do the work**'s System Message if a customer needs it.

## Add other apps

Put app nodes (Outlook, SharePoint, Excel, Google Sheets…) between **Is this
copy first?** and **Prepare the prompt** to fetch what Claude needs, and hand
what they fetch to Claude in **Prepare the prompt**, in its own tags beside
`<item>` (its comment says how). Or put them on the *true* branch of **Real
run, not a test?**, between it and **Prepare the result**, to save Claude's
draft: save `$('Read the answer').first().json.draft`, never **Do the
work**'s raw answer, which may hold the field tags (**Prepare the result**
reads **Do the work** and **Read the answer** by name). Keep to these rules:

- **A test from Scallle never acts.** Scallle's *Send a test* marks its job
  `run.test: true`, and **Real run, not a test?** sends it down the *false*
  branch, straight to the result. So anything that saves, sends or changes
  something outside goes on the *true* branch, never before **Do the work**.
  A job that doesn't say (from a Scallle before `run.test`) is a real run.
- **Draft, don't act.** Create an Outlook *draft*, never send; write to a
  drafts folder, never overwrite. A person approves the result in Scallle (the
  step set to *Reviewed*) and only then does anything get sent, by a separate
  step. Whatever this workflow already did has happened, approved or not.
- **A node that acts outside skips on a test, and confirms with Scallle
  first.** When the job’s `run.test` is `true` (*Send a test*, *Execute*), skip
  anything that sends, writes or books and return what it would have done.
  On a real run, confirm with Scallle through the run’s own callback link and
  token (on Scallle’s address, never one from the job) before acting, and act
  only on Scallle’s yes. (The rule stands now; Scallle’s side of the
  confirmation comes later — until then, draft, don’t act.)
- **Never connect a tool to Do the work.** n8n's Anthropic node accepts tools
  (other nodes Claude can call). A tool that sends or changes anything lets an
  item that says "email this to…" make Claude act instead of draft. Fetch what
  Claude needs before **Do the work**; act on its draft after a person
  approves it.
- **Item data is data.** Don't let an item field choose who gets an email,
  which file is changed, or what Claude is told to do. Instructions come from
  the step's procedure and from this workflow. The same goes for anything an
  app node fetches: it goes in the user message, added in **Prepare the
  prompt** beside the item, never in **Do the work**'s System Message. A
  person's send-back note is data too: it may say what to change in the
  draft, never what the rules are.
- **Each workflow has its own logins.** Give each node you add a new
  credential made for this workflow only, with only the access this step
  needs — never one another automation uses, even if n8n offers it. (The
  business’s Anthropic credential on **Do the work** may be shared.)
- **Report failures.** On each node you add, set Settings, then *On Error* to
  *Continue (using error output)*, and wire the error output to **Plain error
  message**. Scallle is then told which step failed, by name ("The 'Fetch from
  SharePoint' step failed in n8n…"), instead of waiting 20 minutes. The test
  checks exactly this.
- **Keep Prepare the result last** before **Send result to Scallle**, so the
  callback keeps its shape.

Changing it with an AI coding tool? Give the tool your workflow as a file:
the step's download, or in n8n the workflow's `⋯` menu, then *Download*. On
the step in Scallle, press **Copy for your AI**: it copies a brief for that
one step (its name, instructions, what it receives, what Scallle expects
back and its automation id). Paste it as the task. The tool reads
`AGENTS.md` here for the rules, which win over anything in a brief. When
it's done, unpublish the old workflow (two workflows with the same path
clash), import the changed file, check its two credentials, **Publish**, and
press *Send a test* in Scallle.

Microsoft 365 (Outlook, SharePoint, OneDrive, Excel) signs in with OAuth. For a
business tenant this normally needs an *app registration* in the customer's
Microsoft Entra admin centre, approved (admin consent) by their Microsoft 365
admin. Ask for the narrowest permissions the step needs, for example reading
one site, and creating mail drafts rather than sending mail.

## Bring a workflow made before this release up to date

A workflow made from this starter before 21 Oct 2026 still works: it ignores
what it doesn't know in a job and drafts from the item as before. It just
doesn't fill the rows after the step in Scallle, pass a person's send-back
note to Claude, or read the about-this-run values. If it has no **Read the
answer** step, it is one of these. To bring it up to date:

1. **A new file.** In Scallle, disconnect the step, then press **Download
   this row’s n8n workflow** (as in *The quick way*): the file has the new
   steps and the ids the next *Connect* makes.
2. **Your app nodes.** Import it into n8n and move your own app nodes across
   from the old workflow, wired as in *Add other apps*: fetching nodes before
   **Prepare the prompt** (with what they fetch handed over in it), saving
   nodes on the *true* branch of **Real run, not a test?**, saving
   `$('Read the answer').first().json.draft`.
3. **Swap them over.** Unpublish the old workflow (two workflows with the same
   path clash). Paste the new one's *Production URL* into the step in Scallle
   and press *Connect*: Scallle shows the step's new secret, once.
4. **The two logins.** On **Scallle job**, create a **new** JWT Auth credential
   with that secret; on **Do the work**, choose the business's own Anthropic
   credential (as in *The quick way*, step 3).
5. **Check the privacy settings**, **Publish**, then press *Send a test* on
   the step in Scallle.

## Privacy

The customer here may hold special-category data (for example, about the
people a care or housing provider supports). What the template does, and what n8n does
underneath it. The local test checks each of these against n8n 2.41.7:

- **Successful runs are not saved** (*Do not save*). Be aware of what that
  means in n8n: the run is written while it happens and marked deleted when it
  finishes; with n8n's default settings its clean-up removes it for good about
  an hour later (it runs every 15 minutes with a 1-hour buffer). If you
  self-host, keep execution
  pruning on (`EXECUTIONS_DATA_PRUNE`, on by default), or those deleted runs
  are never removed.
- **Failed runs are not saved either** (*Do not save*): nothing is kept after
  a run. Scallle still gets the plain sentence saying what failed. A saved
  failed run would hold the item, the callback address with its per-run
  token, and the request's signed token (n8n 2.41.7 stores the headers as
  received), for 7 days on n8n Cloud Starter or 30 on Pro — so to look into a
  failure, switch saving on only while no real jobs can reach the workflow
  (no dial set on the step's row in Scallle), send a test, then switch it off
  and delete every run saved in that time.
- **Runs from the editor are not saved** ("Save manual executions": *Do not
  save*), so testing with a real item from the n8n editor leaves no copy.
- **The claims table** (**Scallle run claims**, under the project's *Data
  tables*) holds only run ids and n8n execution ids, for 7 days. No item data.
- **What goes back to Scallle on a failure** is always one of the fixed
  sentences in **Plain error message** or **Prepare the result**. n8n's own
  error text is never passed on.
- **n8n's own logs** (its console log and event log) held no item data and no
  tokens in the test.
- **Where the data lives.** n8n Cloud stores it in the EU (Frankfurt); there is
  no UK region. Sign n8n's DPA. For the most sensitive data, self-hosting in the
  UK keeps everything where the customer chooses.
- **Send less.** Have Scallle send only the item fields the step needs: every
  field you send lands in n8n's history whenever a run fails.

## Limits

- **Once per run: what is guaranteed.** Within one n8n project, a run id is
  worked at most once, however many copies of it arrive and however close
  together, for 7 days (the claims are then deleted, and by then Scallle has
  long since given the step to a person). The test sends 8 runs, each twice at
  the same instant and once more while the first copy is working, with 5 runs
  at once as on n8n Cloud Starter: each run was worked once. What it rests on:
  claims are numbered in the order n8n saves them, and every copy looks only
  after waiting a second, so a claim saved at the same instant is always seen.
  Two things to know:
  - If n8n can't save or read a claim (the data table is full or was deleted),
    the step is not done and Scallle gets a plain error naming the claims
    table. If another copy of that run was being worked at that moment,
    Scallle hears from both.
  - Keep exactly one data table whose name contains "Scallle run claims" in
    the project, and don't rename it. n8n finds it by name and matches any
    name that *contains* that phrase, so a second such table can make every
    run stop before any work (kept as failed in n8n; Scallle gets no
    callback). If the table is deleted, the next run makes a new, empty one;
    a repeat of a run that arrives across that moment could be worked again.
- **Reply time.** n8n Cloud cuts a webhook reply at 100 seconds (a 524). This
  workflow replies before any work starts, so that never applies.
- **Runs at once.** n8n Cloud Starter runs 5 at a time and queues the rest; time
  in the queue counts towards Scallle's 20-minute wait. Starter allows 2,500
  runs a month. A job refused by **Check the job** still counts as a run; one
  refused by the token check (401/403 from the trigger) does not. A repeated
  copy of a run counts as a run too.
- **RAM.** Trial and Starter have 320 MiB per instance, which long AI work
  hits before any time limit. The free trial also stops a run after 180 seconds.
- **5 minutes per call.** n8n gives up on any HTTP call, the AI step included,
  after 5 minutes. That is why the AI step's answer is capped at 8,000 tokens
  (Maximum Number of Tokens), which is plenty for a step's draft and comes back
  well inside 5 minutes. Raise it only a little: an answer that takes longer
  fails as "couldn't be reached", after being paid for.
- **Retries.** n8n's *Retry On Fail* retries on any error; it can't tell a
  4xx from a 5xx. The report back to Scallle is tried twice, 5 seconds apart,
  each try waiting at most 15 seconds for an answer; if both fail, **When to
  try again** waits (15 s, 30 s, then a minute at a time) and sends it again,
  for about 10 minutes in all. That is safe because Scallle answers 200 to a
  repeat; the contract says to retry
  only on network errors and 5xx, so a 4xx from Scallle is retried here when
  it needn't be. Each wait is a minute or less, so n8n keeps the run in memory
  while it waits rather than saving it (with the item) to its database; a
  waiting run still holds one of Starter's 5 places. Even if every try times
  out it ends within about 15 minutes. Then **Couldn't report back** stops
  the run, and Scallle hands the step to a person after 20 minutes. The AI
  step is tried 3 times, which costs about 10 seconds on an error that won't
  go away (a bad key), and at worst about 15 minutes if every try hits the
  5-minute limit, still inside Scallle's 20. If you set a workflow timeout in
  the workflow's settings, keep it above 25 minutes.
- **What n8n's Anthropic node can't set.** It can't choose Claude's effort or
  turn on Anthropic's server-side fallback. Opus 5.5 then runs at its default
  effort (medium), and a refusal comes back to Scallle as a plain failure
  rather than being retried on a fallback model. If a customer needs either,
  use the
  [Vercel Workflows starter](https://github.com/bartosz-waw/scallle-vercel-workflows-starter)
  instead.
- **Don't set Temperature, Top P or Top K** on **Do the work**: Opus 5.5 rejects
  them (400).
- **Changing Scallle's address.** It is the `SCALLLE_ORIGIN` line at the top of
  **Check the job**. Keep the `// scallle:…` ending on it and on the three
  `EXPECTED_` lines: Scallle's download and the test find the lines by it. If
  you rename **Scallle job**, **Check the job**, **Prepare the prompt**, **Do
  the work**, **Read the answer**, **Prepare the result**, **Plain error
  message**, **Claim this run** or **Find the first claim**, check the Code
  nodes and expressions that refer to them by name.

## Test it locally

Needs Node 24 or newer, and about 2.5 GB of disk (3.7 GB while installing).

From this folder:

```bash
test/setup.sh                  # once: installs n8n 2.41.7 into test/.runtime (2–3 minutes)
node test/e2e.mjs              # about 95 seconds; prints PASS/FAIL per check
node test/app-signed-job.mjs   # about a second: a job from Scallle's real sender passes "Check the job"
node test/agents-md.mjs        # about a second: AGENTS.md still names this workflow's nodes and rules
```

`app-signed-job.mjs` checks the token with n8n's own code only once
`setup.sh` has run; before that, it skips that one check. There is no
`package.json` and nothing else to install: the tests use Node's own modules
and the n8n that `setup.sh` installs.

`e2e.mjs` starts a fake Scallle callback endpoint and a fake Anthropic API,
imports the credentials and seven test copies of the workflow into a throwaway
n8n folder (SQLite) with the n8n CLI, publishes them, starts n8n with n8n
Cloud Starter's limit of 5 runs at once, then plays Scallle: it signs jobs
exactly as the contract says (HS256; `iss`, `aud`, `sub`, `iat`, `exp`, `jti`,
`body_sha256`) and checks every reply and callback. The test copies change only
the credential ids, the webhook path, `SCALLLE_ORIGIN` (pointed at the fake
Scallle) and the `EXPECTED_` ids; the Anthropic node is the real one, pointed
at the fake API through its credential's Base URL. One copy is set up for the
same automation (to show a replayed job isn't worked twice), one for another
automation (to show it is refused), one is left with blank `EXPECTED_` ids,
one adds a failing app step, one can't save its claim, and one adds a step on
the real-run branch (to show a test job skips it, and that it saves the draft
from **Read the answer**). One job carries every part a job can describe
(what each field is, about this run, a send-back note, rows to fill), to show
each reaches Claude as data and only the rows in `fill` come back. Every secret is made
up per run. Its files are in `test/.scratch/`, including n8n's log
(`N8N_LOG_LEVEL=debug node test/e2e.mjs` for more detail).

To test a copy you exported from n8n after editing it, or one downloaded from
a step in Scallle: `TEMPLATE=path/to/export.json node test/e2e.mjs`. The
test fills in the four `// scallle:…` lines in **Check the job** whatever they
hold, and the checks rely on the template's node names.

What the test does not cover: n8n Cloud itself, the editor's *Import from File*
(the CLI imports the same JSON), real Anthropic, Postgres (n8n's other
database: claims are numbered the same way there, but it isn't tested), and
app nodes you add. On Node 25, n8n's default expression sandbox (isolated-vm)
can't be built yet, so the test runs n8n with `N8N_EXPRESSION_ENGINE=legacy`;
n8n Cloud runs its own default. The template's expressions are simple
JavaScript (property reads, `JSON.stringify`, `String()` and
`$now.minus({ days: 7 })`), which both engines run.
