# Agent: session retention

Part of [#17](https://github.com/mitchellknoth/mitchellknoth.github.io/issues/17) (M3 of
[#13](https://github.com/mitchellknoth/mitchellknoth.github.io/issues/13)).

## The TTL

**A visitor session is deleted 24 hours after its first question.** The value is `SESSION_TTL_SECONDS` in
`wrangler.jsonc` (`86400`). The same value is the `Max-Age` of the `__Host-agent_session` cookie, counted from when
the session was created, so a browser stops sending the session name before the session is deleted.

| What | Kept for |
|---|---|
| The conversation: questions, answers, tool calls (Pi's `pi_*` tables) | until the session is deleted |
| The session's message counter and expiry (`visitor_meta`) | until the session is deleted |
| The session object's job queue and alarm | until the session is deleted |
| Prompts in AI Gateway logs | not stored (`collectLog: false` in `worker/session.ts`) |
| Blocked IPs in the `guard` object | until each entry's own expiry (`worker/guard.ts`) |

The clock starts at the first question and later questions don't extend it, so no conversation is held longer than
the TTL after it began.

## How the purge works

`worker/session.ts` implements it. Each visitor session is one Durable Object, and Pi Durable can't delete a
conversation by itself, so the whole object is deleted:

1. The first question writes `expires_at` (now + TTL) and queues one Lifecycle host job, `session-ttl`, due then.
   The Agents SDK Lifecycle owns the object's single alarm, so the purge is a Lifecycle job rather than a
   hand-set alarm.
2. When the alarm fires, Lifecycle runs the job. The job checks `expires_at` again: if it hasn't passed, the job
   reschedules itself.
3. Once it has passed, and no question is still being answered, the job disables the object's alarms, closes the
   Pi harness, calls `ctx.storage.deleteAll()`, deletes the alarm, and resets the object so nothing stays in memory.
   A question that arrives while this runs is answered as expired and doesn't touch storage. If a step fails, the
   object is still reset, and the next question finds `expires_at` in the past and queues the purge again.

A question that arrives after expiry but before the purge runs is refused without reaching the model:
`POST /agent/ask` returns `401 {"error":"no_session"}`, and the visitor starts a new session. If someone replays an
old session name after the purge, it opens an empty object; nothing from the old conversation survives.

`worker/test/session.test.ts` covers the schedule, the expired refusal, and the purge, including Pi's tables.

## Changing the TTL

Change `SESSION_TTL_SECONDS` in `wrangler.jsonc`. New sessions use the new value. Sessions that already started keep
the expiry fixed at their first question.

Pi Durable is experimental, and a conversation stored by a newer Pi minor version can't be read after a rollback.
The short TTL bounds that risk to sessions from the last day.

## Still to check on a deployment

- Set a short TTL on workers.dev (for example `SESSION_TTL_SECONDS = "120"`), ask one question, wait past the TTL,
  and confirm in the Worker's logs that the session object's alarm ran without an error.
- Then send the old cookie by hand (a browser has dropped it by then): the question should be treated as a new
  session, with its message count starting again from one.
