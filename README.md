# PostHog bell counter

A sales bell that rings when someone claims a device, and an LED panel that
shows how many have been claimed this month.

The bell is a hobby servo. The panel is four daisy-chained MAX7219 modules. Both
are drivers on **one** ESP32-C6 running the [Jettyd](https://jettyd.com)
firmware SDK, commanded over the Jettyd public API. The trigger is a PostHog
webhook on `device_claimed`; the number is whatever PostHog says the number is.

```
                                   ┌─────────────────────────────┐
  PostHog  ──── webhook ─────────► │                             │
  (device_claimed)                 │   this service              │
                                   │                             │
                                   │   1. servo.rotate ──────────┼──┐
  PostHog  ◄─── HogQL query ───────┤   2. count = Σ projects     │  │
  (POSTHOG_PROJECT_IDS)            │   3. display.set ───────────┼──┤
                                   │                             │  │
                                   └─────────────────────────────┘  │
                                                                    ▼
                                            Jettyd API ──► ESP32-C6 ──┬─ servo (GPIO3)
                                     POST /v1/devices/{id}/commands   └─ MAX7219 panel
```

## The one design decision worth reading

**This service does not count anything.**

The obvious implementation keeps a tally, increments it on each webhook, and
pushes it to the panel. That version is wrong within a day: a webhook retried by
PostHog double-counts, a webhook dropped during a deploy under-counts, a restart
loses the tally, and nothing ever notices because the number still *looks*
plausible. There is no way to tell a correct 47 from an incorrect 47.

So the webhook is treated purely as a **doorbell** — it says "something
happened", nothing more. The number is fetched fresh from PostHog on every
single run. Replayed webhooks are harmless, dropped webhooks self-heal on the
next event or the next reconcile, and a restart converges immediately. There is
no counter file, no in-memory tally, and a test that greps the source to keep it
that way.

## What happens on a webhook

Strictly in this order:

1. **Ring.** `servo.rotate` to the strike angle, hold, and the firmware returns
   the horn to its home position. The service **awaits this attempt** before
   moving on — the bell is the reaction to the event, and it should not be
   delayed behind an analytics query.
2. **Count.** Ask each configured PostHog project for its current-calendar-month
   `device_claimed` count, and sum them.
3. **Show.** `display.set` that total on the **same device**.

Two failure rules make this behave sensibly on a desk:

- **A failed strike does not stop the count.** If `servo.rotate` errors, the run
  logs it and carries on to steps 2 and 3. A silent bell showing the right
  number beats a ringing bell showing a stale one.
- **A partial answer never reaches the panel.** If *any* project fails to
  answer, `display.set` is skipped entirely and the panel keeps its last good
  value. A partial sum is indistinguishable from a real one once it is four
  glowing digits, which makes it the more dangerous failure.

## Concurrency

Claims arrive in bursts, and a bell that is already swinging must not be told to
swing again. Runs are **serialised**, and everything arriving mid-run is
**coalesced** into a single follow-up run:

```
webhooks:   │ 1  2 3 4 5 │
runs:       │ ─── A ───────── B ─── │      5 webhooks → 2 strikes
                 ↑            ↑
                 run for #1   one run covering #2–#5
```

Requests 2–5 all fold into the same follow-up run. Scheduled reconciliation
queues behind an in-flight strike rather than interleaving with it, so a
`display.set` can never land in the middle of somebody else's chain. If a
reconcile is already queued, the next one is skipped rather than stacked.

### The webhook answers before the run

A delivery is acknowledged with **`202 Accepted`** immediately, and the run
happens after the response is sent.

This is what keeps coalescing meaningful. A run is a servo strike plus one
PostHog query per project, each allowed `REQUEST_TIMEOUT_MS`; answering only
once it finished put the response inside PostHog's delivery-timeout window, and
PostHog answers a timeout by retrying. A retry landing *after* the first run
completed is not concurrent with anything, so the runner has nothing to coalesce
it with — it is simply a second strike for a single claim. Acknowledging first
takes the response time out of the equation entirely.

The trade is that the acknowledgement cannot report the outcome, because there
isn't one yet. It carries no run id either: a coalesced delivery never gets its
own run, so there would be nothing honest to put there. The outcome shows up in
the `webhook.run_settled` log line and in `/healthz` `last_run`.

## Reconciliation

Webhooks are the fast path; reconciliation is the correctness path. Every
`RECONCILE_INTERVAL_MINUTES` (default **15**) the service re-queries PostHog and
repaints the panel — **without ringing the bell**, because no new claim
happened. This is what recovers from a dropped webhook, a paused destination, or
a restart mid-month. Set it to `0` to disable.

## Setup

Requires Node.js **≥ 20.6**. There are **no dependencies** — no `npm install`,
nothing to audit, no lockfile to keep current.

```bash
git clone https://github.com/jettydiot/posthog-bell-counter-demo.git
cd posthog-bell-counter-demo
cp .env.example .env      # then fill it in — see below
npm test
node --env-file=.env src/index.js
```

### Configuration

Every value is read from the environment. Nothing has a default that could stand
in for a credential, and a missing one is a hard startup failure that names
every problem at once.

| Variable | Required | Default | What it does |
|---|:---:|---|---|
| `WEBHOOK_SECRET` | ✅ | — | Shared secret in the `x-webhook-secret` header. Min 16 chars |
| `JETTYD_BASE_URL` | ✅ | — | e.g. `https://api.jettyd.com` |
| `JETTYD_API_TOKEN` | ✅ | — | API key or JWT, sent as `Bearer` |
| `JETTYD_DEVICE_ID` | ✅ | — | The **one** combined device — servo and panel both |
| `POSTHOG_API_KEY` | ✅ | — | Personal API key with the `query:read` scope |
| `POSTHOG_HOST` | | `eu.posthog.com` | PostHog instance |
| `POSTHOG_PROJECT_IDS` | ✅ | — | Comma-separated project ids to sum. No default — this repository is public, and a default would mean shipping someone's real project ids in the source |
| `POSTHOG_EVENT` | | `device_claimed` | Event to count |
| `BELL_REST_ANGLE` | | `90` | Rest position; **must match `home_angle`** in `firmware/device.yaml` |
| `BELL_STRIKE_ANGLE` | | `45` | Strike position |
| `BELL_HOLD_MS` | | `250` | Dwell at the strike position before returning |
| `RECONCILE_INTERVAL_MINUTES` | | `15` | Re-query cadence; `0` disables |
| `HOST` | | `0.0.0.0` | Bind address |
| `PORT` | | `3000` | Bind port |
| `REQUEST_TIMEOUT_MS` | | `10000` | Per outbound HTTP request |
| `LOG_LEVEL` | | `info` | `debug` \| `info` \| `warn` \| `error` |

The service owns the **out** half of the swing and the firmware owns the
**back** half — `servo.rotate` returns the horn to the servo's configured
`home_angle`. If `BELL_REST_ANGLE` and `home_angle` disagree, the service's logs
and `/healthz` will describe a rest position the hardware does not use.

## PostHog setup

1. **Personal API key.** Settings → Personal API keys → create one scoped to
   `query:read` for every project you are counting. Put it in
   `POSTHOG_API_KEY`, and list the project ids in `POSTHOG_PROJECT_IDS`.
2. **Webhook destination.** In each project: Data pipelines → Destinations → new
   **Webhook**.
   - URL: `https://<your-host>/webhook/posthog`
   - Method: `POST`
   - Filter: only the `device_claimed` event
   - Headers: `x-webhook-secret: <your WEBHOOK_SECRET>`
3. **Test it.** Fire PostHog's test event, or:
   ```bash
   curl -X POST http://localhost:3000/webhook/posthog \
     -H "x-webhook-secret: $WEBHOOK_SECRET" \
     -H 'Content-Type: application/json' \
     -d '{"event":"device_claimed"}'
   ```

That returns `202 {"accepted":true}` straight away; watch the logs or
`/healthz` for what the run did.

The service does not filter on the event name — the destination's own filter
does that. Any authenticated POST rings the bell and repaints the panel, which
is also what makes the `curl` above a valid end-to-end test.

The count query PostHog actually runs:

```sql
SELECT count() FROM events
WHERE event = 'device_claimed'
  AND timestamp >= toStartOfMonth(now('UTC'))
  AND timestamp <  toStartOfMonth(now('UTC')) + toIntervalMonth(1)
```

The month boundary is evaluated by PostHog, not by this process, so it is the
same boundary across restarts and time zones. Month rollover needs no code: the
first query in the new month simply returns a smaller number, and the panel
follows it down.

## Jettyd setup

1. Flash and claim the device — see **[`firmware/README.md`](firmware/README.md)**.
   ⚠️ It documents a **required** MAX7219 chain-order fix that is not yet
   upstream; without it the panel reads `09` instead of `90`.
2. Confirm the manifest lists both drivers:
   ```
   {"drivers":["display","servo"],"firmware":"1.0.0","chip":"esp32c6"}
   ```
3. Copy the device UUID into `JETTYD_DEVICE_ID`, and mint an API token with
   permission to issue commands to it.

Command envelopes, for reference:

```jsonc
// the strike — out to 45°, hold 250 ms, firmware returns to home_angle
{ "command_type": "servo.rotate", "payload": { "angle": 45, "hold_ms": 250 } }

// the count
{ "command_type": "display.set",  "payload": { "value": 42 } }
```

It is `command_type` / `payload` — never `action` / `params`.

## Wiring

One ESP32-C6, one servo, one 4-module MAX7219 panel.

| Signal | GPIO |
|---|---|
| MAX7219 `DIN` | **10** |
| MAX7219 `CLK` | **8** |
| MAX7219 `CS` / `LOAD` | **9** |
| Servo signal | **3** |

Power both the panel and the servo from an **external 5 V supply** with its
ground tied to the board's. A bell striker stalls at the end of its swing, and
that current spike will brown out an ESP32-C6 running off USB — which looks
exactly like a firmware crash and wastes an afternoon. Full table and
bench-test commands in [`firmware/README.md`](firmware/README.md).

## Running it

### Local

```bash
node --env-file=.env src/index.js
```

### Docker

```bash
cp .env.example .env      # fill it in
docker compose up --build
```

The compose file publishes on `127.0.0.1:3000` only, runs the container
read-only with all capabilities dropped, and health-checks `/healthz`. Put a
TLS-terminating reverse proxy or a tunnel in front before letting PostHog reach
it — the shared secret travels in a header, and plaintext HTTP over the internet
gives it away.

```bash
docker build -t posthog-bell-counter .      # without compose
docker run --rm -p 127.0.0.1:3000:3000 --env-file .env posthog-bell-counter
```

The image is `node:22-alpine` plus the source: no dependencies to install, runs
as the non-root `node` user, `tini` as PID 1 so `docker stop` reaches the
graceful shutdown handler.

### Health

```bash
curl -s localhost:3000/healthz | jq
```

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime_seconds": 3641,
  "busy": false,
  "reconcile_interval_minutes": 15,
  "bell": { "restAngle": 90, "strikeAngle": 45, "holdMs": 250 },
  "last_run": {
    "at": "2026-08-13T11:04:22.118Z",
    "trigger": "webhook",
    "ok": true,
    "bell_ok": true,
    "count": 42,
    "displayed": true,
    "duration_ms": 812
  }
}
```

`status` is `degraded` when the last run failed. It is deliberately still
HTTP 200 — the process is alive, PostHog is not, and a restart would not help.

The probe needs no authentication, so its body is public if the service is.
That is why it carries no deployment identifiers. Send the shared secret to get
the descriptive fields as well — `device_id`, `jettyd_base_url`,
`posthog_projects`, `posthog_event`, `posthog_host`:

```bash
curl -s localhost:3000/healthz -H "x-webhook-secret: $WEBHOOK_SECRET" | jq
```

None of those are credentials, but they are the inputs to the Jettyd command
API and the PostHog query API, and an anonymous caller has no business being
handed them. A wrong secret is not an error here — it just gets the short body.
A liveness probe that starts returning 401 is how a healthy service gets
restarted.

### Logs

One JSON object per line, so `docker logs bell-counter | jq -c 'select(.run_id)'`
gets you a run at a time.

```json
{"ts":"…","level":"info","event":"webhook.accepted","event_name":"device_claimed"}
{"ts":"…","level":"info","event":"run.started","run_id":"run-7","kind":"bell","trigger":"webhook","requests":1}
{"ts":"…","level":"info","event":"bell.rang","run_id":"run-7","angle":45,"rest_angle":90,"hold_ms":250}
{"ts":"…","level":"info","event":"query.completed","run_id":"run-7","count":42,"per_project":{"100001":30,"100002":9,"100003":3}}
{"ts":"…","level":"info","event":"display.updated","run_id":"run-7","count":42}
{"ts":"…","level":"info","event":"run.finished","run_id":"run-7","ok":true,"count":42,"duration_ms":812}
{"ts":"…","level":"info","event":"webhook.run_settled","run_id":"run-7","ok":true,"count":42,"displayed":true,"coalesced_requests":1}
```

Useful events: `webhook.rejected`, `webhook.run_settled`, `run.coalesced`,
`bell.failed`, `posthog.project_failed`, `query.failed`, `display.failed`,
`reconcile.scheduled`, `reconcile.skipped`.

`ts`, `level` and `event` are written last, so a caller field of the same name
cannot capture them — a PostHog payload carries its own `event`, and a line
whose `event` had been rewritten would be invisible to the very filter used to
look for it.

## Security

- **Secrets are environment-only.** Nothing is read from disk by the service,
  nothing is baked into the image, and no credential has a default. Startup
  fails loudly on a missing one.
- **The webhook secret is compared in constant time.** Both sides are SHA-256
  hashed first so the comparison is fixed-width — guarding `timingSafeEqual`
  with a length check would leak the secret's length through timing.
  See [`src/secret.js`](src/secret.js).
- **Authentication happens before the body is read**, so an unauthenticated
  caller cannot make the service buffer anything, and can never reach the
  hardware. Bodies are capped at 256 KiB.
- **Secrets are scrubbed from errors.** Upstream error bodies pass through
  `redact()` before being logged, and tests assert that neither the API key nor
  the Jettyd token appears in an error message, a response body, or a log line.
- **CI blocks committed credentials** — a job fails the build on a tracked
  `.env` or a `phx_`/`phc_`/`ft_`/`dk_` literal anywhere in the tree.
- **The container is hardened**: non-root, read-only filesystem, all
  capabilities dropped, `no-new-privileges`, loopback-only publish.
- **Rotate the PostHog key** if it has ever been in a shell history, a log, or a
  chat message. Scope it to `query:read` and nothing more.

## Tests

```bash
npm test          # 95 tests, no network, no device, no real timers
```

Every collaborator — `fetch`, the clock, the timers, the log sink — is injected,
so nothing is monkey-patched onto a global and every test is deterministic.

| File | Covers |
|---|---|
| `ordering.test.js` | Strict servo → PostHog → display order; that no query starts before the strike has settled; that reconcile never rings |
| `webhook-auth.test.js` | Valid secret accepted; wrong, missing, prefix and padded secrets rejected with no outbound calls; constant-time compare; the secret never echoed; the 256 KiB body cap |
| `webhook-ack.test.js` | 202 returned while the strike is still in flight; the run completes afterwards; the outcome reaches the logs and `/healthz`; a burst still coalesces |
| `http-timeout.test.js` | The request deadline stays live through the response body read, so a stalled body cannot pin a run open |
| `posthog-aggregate.test.js` | Summing across every configured project; query shape; per-project endpoints; every all-or-nothing failure mode (non-2xx, connection error, bad shape, negative or non-numeric count) |
| `runner-resilience.test.js` | Bell failure still queries and still displays; any project failure suppresses `display.set` entirely; display failure reported not swallowed; every path — including the internal fallback and a skipped reconcile — produces the same result shape |
| `concurrency.test.js` | Never two strikes in flight; a burst of five coalesces to two runs; each run's chain stays contiguous; reconcile queues behind a strike and is skipped rather than stacked |
| `command-payloads.test.js` | The exact `servo.rotate` and `display.set` envelopes, headers, and that both go to the same device URL |
| `scheduler.test.js` | 15-minute default; configured override; `0` disables; ticks reconcile; a failing tick does not kill the timer; a tick never calls `trigger()` |
| `no-local-increment.test.js` | The same PostHog answer twice displays the same number twice; the count follows PostHog downwards; no counter file and no local increment in the source |
| `config.test.js` | Required variables, defaults, validation, and that the redacted summary holds no secrets |
| `health.test.js` | Shape, `degraded` state, no secrets in the body |
| `logging.test.js` | One JSON object per line, level threshold, `run_id` correlation across a whole run, and that a payload field cannot shadow the log event name |

## Filming and post checklist

The demo is three seconds long and the failure modes are all silent, so run
through this before recording.

**Before**

- [ ] External 5 V supply on the servo, ground common with the board. Not USB.
- [ ] Bell physically positioned: at `BELL_STRIKE_ANGLE` the clapper *strikes*;
      at `BELL_REST_ANGLE` it clears the bell entirely. Nothing rattles at rest.
- [ ] `BELL_REST_ANGLE` matches `home_angle` in `firmware/device.yaml`.
- [ ] Module-order patch applied — the panel must read `90`, not `09`.
      Send `display.set` with `1234` and read it left to right.
- [ ] `curl localhost:3000/healthz` → `"status": "ok"`, `last_run.ok: true`.
- [ ] Fire one test webhook. Bell rings, panel updates, and the count matches
      PostHog's own insight for the month.
- [ ] `idle_detach: true` confirmed — listen for servo hum between strikes; the
      microphone will pick it up even when the horn looks still.
- [ ] `LOG_LEVEL=info`, and the log terminal is on screen if you want it in shot.
- [ ] Panel brightness set for the camera, not for the room. `brightness: 1` is
      usually right; LEDs blow out on video far sooner than they do by eye.

**During**

- [ ] Get the panel's *before* value in shot — the change is the story.
- [ ] Fire the event and hold the shot: bell, then a beat, then the panel. The
      panel lags by however long PostHog takes, and that gap is the demo.
- [ ] One take with the bell close-mic'd; the strike is the sound the video needs.
- [ ] A second take framing the whole rig — bell, panel, board — for the cut-in.
- [ ] Trigger a real claim, not just a `curl`, for at least one take.

**Watch for**

- [ ] A *stale* panel after the bell means PostHog is late or a project errored.
      Check `query.failed` in the log before re-shooting.
- [ ] Rapid retakes coalesce — five triggers give **two** strikes, by design.
      Leave a few seconds between takes if you want five rings.
- [ ] Reconcile fires every 15 minutes and will repaint the panel mid-take with
      no bell. Set `RECONCILE_INTERVAL_MINUTES=0` while filming if that would
      confuse the shot.

**After**

- [ ] Scrub the footage for the panel showing anything unexpected mid-take.
- [ ] Blur or cut any frame showing `.env`, a terminal with a token, the PostHog
      key in a URL bar, or the device UUID if you would rather not publish it.
- [ ] Rotate `WEBHOOK_SECRET` and the PostHog key if either appeared on screen.
- [ ] Re-enable reconciliation if you disabled it.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Panel reads `09` instead of `90` | MAX7219 chain-order bug — still on upstream `main` | Apply `firmware/display-module-order.patch`, rebuild, reflash |
| Bell rings, panel never changes | A PostHog project failed; the display is suppressed by design | Look for `posthog.project_failed` — check the key's scope covers *all* projects in `POSTHOG_PROJECT_IDS` |
| Panel updates, bell silent | `servo.rotate` failed, or it succeeded and the geometry is wrong | `bell.failed` in the log means the command failed. No such line means the strike angle does not reach the bell |
| 401 on every webhook | Secret mismatch, or PostHog is not sending the header | `webhook.rejected` logs *which* — missing vs mismatch |
| Startup exits immediately | Missing or invalid config | The error names every problem at once; compare against `.env.example` |
| Five claims, only two rings | Working as designed — coalescing | Space the events out, or accept it: the panel is still correct |
| Count is right but low by a project | A project id is missing from `POSTHOG_PROJECT_IDS` | `query.completed` logs `per_project` — compare against PostHog |
| Servo hums or jitters at rest | `idle_detach` disabled, or the horn is mechanically loaded at rest | Set `idle_detach: true`; reposition so the clapper is unloaded at rest |
| Board resets when the bell rings | Servo current spike browning out the supply | External 5 V for the servo, common ground. Not USB |
| Count resets to a small number on the 1st | Working as designed — it is a monthly count | Nothing to do |
| `display.set` accepted but panel blank | Panel on 3V3 | Move it to 5 V |
| Health shows `degraded`, service otherwise fine | The last run failed | `last_run.error.stage` names the stage — `query` or `display` |

## Layout

```
src/
  index.js      wiring, graceful shutdown
  config.js     environment parsing and validation
  server.js     HTTP: /webhook/posthog, /healthz
  runner.js     the run loop — serialisation, coalescing, ordering
  posthog.js    the authoritative count, all-or-nothing
  jettyd.js     the two command envelopes
  scheduler.js  periodic reconciliation
  secret.js     constant-time compare, redaction
  logger.js     structured JSON logging
  http.js       the one outbound HTTP call
test/           see the table above
firmware/       device.yaml, main.c, the required SDK patch
```

## Licence

MIT — see [LICENSE](LICENSE).
