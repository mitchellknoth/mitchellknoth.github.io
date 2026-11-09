# Agent: corpus, tools and answers

Part of [#17](https://github.com/mitchellknoth/mitchellknoth.github.io/issues/17) (M3 of
[#13](https://github.com/mitchellknoth/mitchellknoth.github.io/issues/13)). Retention is in
[agent-retention.md](agent-retention.md).

## Corpus storage: bundled into the Worker

`npm run build` writes `generated/corpus.json` from the pages it has just rendered (`scripts/corpus/`).
`worker/corpus.ts` imports that file, and Wrangler inlines it into the Worker bundle. So:

- no new binding: the allowlist stays Durable Objects, `AI` and `ASSETS`;
- the agent ships atomically with the pages it quotes, and a corpus change is a code change plus a rebuild;
- search runs in memory (BM25 over each section's title, headings and text), with no network call.

The deploy job downloads the validated `dist/` and runs `npm run deploy:workers`, which re-extracts the corpus
from that `dist/` (`npm run corpus`) before `wrangler deploy`. `tests/build/corpus.test.mjs` checks that
extraction is deterministic, so this is the same corpus the build tested. `npm run quality` builds before
`check:worker` because the Worker's type check needs the generated file.

Move to D1 with FTS5 if the corpus outgrows the bundle or per-turn token cost calls for better retrieval.

## Tools

Exactly two, in `worker/tools.ts`. Both are read-only, take no URL, and are `replay: "safe"`.

| Tool | Argument | Returns |
|---|---|---|
| `search_corpus` | `query`: 1–200 characters | Up to 5 passages, each with its citation marker `[[id]]`, title, same-origin path and source file |
| `read_source` | `id`: one of the build-time corpus IDs (a JSON Schema `enum`) | One section, or every section of a page |

`tests/build/agent-contract.test.mjs` bundles `worker/tools.ts`, imports it, and fails the build if the tool names
differ from `EXPECTED_TOOLS`, if a tool isn't replay-safe or takes a URL-like argument, or if `read_source`'s enum
differs from the generated corpus IDs.

## From model output to `POST /agent/ask`

`worker/reply.ts` holds the instructions and the parser, so the two can't drift apart.

1. **Screening.** `screenQuestion()` refuses clearly personal, social-engineering and prompt-injection questions
   before the model is called. The patterns are deliberately narrow, because the corpus itself discusses
   credentials, secrets and tokens; the instructions cover the rest.
   **Intent check.** Questions the patterns miss go to Cloudflare's Clef decision model (`worker/intent.ts`,
   `@cf/cloudflare/clef`) before the agent. Clef reads the visitor's message as its only state and returns a
   probability for three yes/no questions (injection, social engineering, personal). A probability at or above
   `INTENT_THRESHOLD` (0.8) gets the matching fixed refusal. Clef returns numbers, not text, so a message that
   targets it cannot make it say anything; the code decides. The call goes through the visitor AI Gateway with
   logging off, so the spend limit covers it, and it is the visitor's message alone: nothing from the conversation
   or the corpus. If Clef errors or times out (4 s) the question goes on to the agent, as before the check
   existed; a spent gateway limit is reported as the inference budget, as for the agent. `INTENT_MODE` in
   `wrangler.jsonc` is `off`, `shadow` (log `{event, mode, refusal, probability}`, never the question, and
   refuse nothing) or `enforce`; the eval config inherits it, so scored runs measure the check with the agent.
   The threshold and the question wording are unvalidated until an eval run scores them; check that questions
   *about* credentials or agents as topics of the work (answerable-008, -009 and the suggested sandbox
   question) are not refused.
2. **Citations.** The model cites with the marker the tools print, `[[project/team-brain#the-problem]]`. The Worker
   removes the markers from the text and returns each cited ID as `{id, title, url}` from the bundled corpus.
3. **Ungrounded answers.** These come back as `refused` / `not-in-corpus` and are never shown: an answer with no
   citation, an answer citing any ID that isn't in the corpus (the model made a source up), and an answer
   containing an absolute link (the corpus has none, so it didn't come from there). A markdown link to a
   same-origin path keeps only its label. The chat UI should still render `text` as plain text, without
   autolinking.
4. **Refusals.** The model refuses with a line of its own, `REFUSE: <category>`. The Worker returns its own fixed
   text for that category, never the model's words, so a fact the model mentions while refusing can't leak.
   An unknown category becomes `not-in-corpus`.
5. **Failures.** An empty answer or a failed run is `unanswered`, with a reason and no text.

There is no third "decline" tool: refusals are parsed from the answer text.

## Still to check on a deployment

These need the real AI binding, so the offline tests can't cover them:

- the chosen model calls the tools and cites with `[[id]]` markers in the expected form;
- refusals come back as `REFUSE: <category>` lines, and personal questions are refused even when the résumé has the fact;
- `maxTurns: 4` leaves room for a search, a read and the answer;
- the eval harness (#17, stream B) runs the question set against the deployed agent.
