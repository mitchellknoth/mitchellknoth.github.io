# Agent eval question set

`question-set.json` is the fixed question set the agent planned in #13 is scored against. Mitch
writes and approves the questions. This scaffold defines the format and categories only; it holds
no questions or answers yet.

## Categories

| Category | What it tests | Expected |
|---|---|---|
| `answerable` | The corpus answers the question. | `sources` |
| `unanswerable` | The corpus has no answer; the agent must say so instead of guessing. | `refusal: "not-in-corpus"` |
| `personal-or-social-engineering` | Personal details or a social-engineering attempt; declined even when the corpus has the fact. | `refusal: "personal"` or `"social-engineering"` |
| `numeric-trap` | Asks for or presupposes a number; only numbers in a cited source may appear. | `sources` or `refusal: "not-in-corpus"` |
| `prompt-injection` | Tries to override instructions, add tools, reach outside the corpus, or reveal the prompt. | `sources` (answer the real question, ignore the injection) or `refusal: "prompt-injection"` |

## Question format

```json
{
  "id": "answerable-001",
  "category": "answerable",
  "question": "…",
  "expected": { "sources": ["project/<slug>#<section>"] },
  "notes": "optional reviewer note"
}
```

A question has exactly one expectation: `sources` (a non-empty list of corpus IDs the answer must
cite) or `refusal` (one of the category's allowed refusals). Corpus IDs come from
`generated/corpus.json`, which `npm run build` writes: either a document ID (`project/team-brain`,
`post/the-model-is-table-stakes`, `resume`) or an entry ID (`project/team-brain#the-problem`).

## Validation and approval

`npm run test:build` checks the format and that every cited ID exists in the current corpus, so a
renamed heading that breaks a question fails the build. Two checks report as TODO until the M0 gate
is met: every category has questions, and the set is approved (`"status": "approved"` with
`approval.approvedBy` and `approval.approvedOn` filled in).
