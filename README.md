# 🛡️ SQL Sentinel Action

**The code reviewer for AI-written SQL** — *"built the code reviewer for AI-written SQL."*

A GitHub Action that reviews SQL statements added in a pull request: it validates
every added statement against your repo's schema, explains it in plain English, and
flags dangerous changes as a sticky PR comment. Deterministic, $0 to run — no LLM,
no external API, no database connection. It reuses the
[SQL Sentinel](https://k1sh0r3.github.io/SQLSentinel/) validator, vendored in `src/`.

## Usage

```yaml
# .github/workflows/sql-review.yml
name: SQL review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  sql-sentinel:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # needed to post the review comment
    steps:
      - uses: actions/checkout@v4
      - uses: k1sh0r3/sql-sentinel-action@v1
        with:
          schema_path: db/schema.sql
          dialect: postgres
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `schema_path` | `schema.sql` | Path to your schema file (`CREATE TABLE` statements), relative to the repo root. |
| `dialect` | `postgres` | SQL dialect: `postgres`, `mysql`, `bigquery`, `snowflake`, `sqlite`, `trino`. |
| `file_pattern` | `**/*.sql` | Glob for SQL files to review (`*` and `**` supported). |
| `fail_on` | `blocked` | Fail the check at this verdict: `never`, `review`, or `blocked`. `review` fails on review-or-worse. |
| `post_comment` | `true` | Post/update a sticky PR comment with the review. |
| `github_token` | `${{ github.token }}` | Token for the GitHub API (listing PR files, posting comments). |

## Outputs

| Output | Description |
|---|---|
| `verdict` | Overall verdict: `safe`, `review`, or `blocked`. |

## What the PR comment looks like

```markdown
## 🛡️ SQL Sentinel — AI-written SQL review

**Verdict: 🚫 BLOCKED**

> ⚠️ **Dangerous changes detected** — at least one statement has errors. Review before merging.

### `migrations/042_backfill.sql` — 🚫 BLOCKED

<details>
<summary><code>Statement 1</code> — 🚫 blocked</summary>

```sql
DELETE FROM orders
```

**What it does:** Deletes EVERY row from orders. This empties the table.

**Issues:**
- ❌ `DESTRUCTIVE_NO_WHERE` — DELETE without WHERE affects every row in the table.
  - 💡 Add a WHERE clause — or run a SELECT with the same filter first to preview the blast radius.
</details>

---
*Reviewed 1 added statement(s) in 1 file(s) against `db/schema.sql` (postgres).
Static analysis only — row counts and runtime behavior can't be known without executing.*
```

The comment is **sticky**: the action finds its previous comment via the
`<!-- sql-sentinel -->` marker and updates it in place instead of spamming new
ones on every push.

## Checks

13 check codes, same as the web app: unknown tables/columns (with did-you-mean
suggestions), `DELETE`/`UPDATE` without `WHERE`, `DROP`/`TRUNCATE` (always an
error), cross/implicit-cross joins, type mismatches, ambiguous columns, possible
PII column access, missing `LIMIT`, `SELECT *`. Verdicts: `✅ SAFE` / `⚠️ REVIEW` /
`🚫 BLOCKED`.

## Honest limits

- **Added-lines-only analysis.** The action sees the added lines of each diff
  hunk, not the whole file — a hunk can slice a statement in half. A
  `PARSE_ERROR` is therefore reported as a *warning* ("may be truncated by the
  diff"), not an error, so truncated fragments never fail your build. The
  vendored validator itself is untouched.
- **PII detection is name-only** (`email`, `ssn`, `phone`, …) — a tripwire, not a guarantee.
- **Static analysis can't know row counts.** `DELETE` *with* a `WHERE` passes
  with a warning advising a `SELECT` preview first.
- **Missing schema degrades gracefully.** If `schema.sql` isn't found, the action
  warns loudly and still runs parse + destructive-operation checks.
- **No LLM, no guessing.** Explanations are template-based; where certainty is
  impossible the validator says "unknown" instead of faking it.

## Development

Zero npm dependencies, no build step — `action.yml` runs `src/index.js` on
`node20` with global `fetch` and the vendored UMD modules.

```bash
node tests/run.js   # 44 tests, no npm
```

## License

MIT — see [LICENSE](LICENSE).
