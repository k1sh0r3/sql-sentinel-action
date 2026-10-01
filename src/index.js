#!/usr/bin/env node
/* SQL Sentinel Action — "the code reviewer for AI-written SQL."
 *
 * Reviews SQL statements added in a pull request: validates them against the
 * repo's schema, explains them in plain English, and posts a sticky PR comment.
 * Zero npm dependencies — reads INPUT_* env vars directly, uses global fetch,
 * and the vendored UMD validator + SQL parser in this directory.
 *
 * Design note (honest): the action only sees the ADDED lines of each diff
 * hunk, so a hunk can slice a statement in half. A PARSE_ERROR therefore means
 * "could not parse this fragment — it may be truncated by the diff" and is
 * reported as a WARNING, not an error. The validator itself is untouched.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SqlSentinel = require('./validator.js');
const NodeSQLParser = require('./node-sql-parser.umd.js');

const sentinel = SqlSentinel.createValidator(NodeSQLParser.Parser);

const MARKER = '<!-- sql-sentinel -->';
const RANK = { safe: 0, review: 1, unknown: 1, blocked: 2 };
const FAIL_RANK = { never: -1, review: 1, blocked: 2 };

/* ---------------- inputs ---------------- */

function getInput(env, name, fallback) {
  const key = 'INPUT_' + String(name).toUpperCase().replace(/[ -]/g, '_');
  const v = env[key];
  if (v == null || String(v).trim() === '') return fallback;
  return String(v).trim();
}

function getBoolInput(env, name, fallback) {
  const v = getInput(env, name, fallback ? 'true' : 'false');
  return !/^(false|0|no)$/i.test(v.trim());
}

function normalizeDialect(d) {
  const s = String(d || '').toLowerCase().trim();
  const map = {
    postgres: 'postgresql', pg: 'postgresql', pgsql: 'postgresql',
    mariadb: 'mysql',
    prestodb: 'trino', trinosql: 'trino'
  };
  if (map[s]) return map[s];
  if (['bigquery', 'mysql', 'postgresql', 'snowflake', 'sqlite', 'trino'].includes(s)) return s;
  return 'postgresql';
}

/* ---------------- glob ---------------- */

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Small glob matcher: supports `*`, `?` and `**` (`**/` crosses directories,
// including zero directories, so `**/*.sql` matches `001.sql` too).
function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }
        else { re += '.*'; i += 2; }
      } else { re += '[^/]*'; i += 1; }
    } else if (c === '?') {
      re += '[^/]'; i += 1;
    } else {
      re += escapeRegExp(c); i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

function globMatch(pattern, filename) {
  try { return globToRegExp(pattern).test(filename); }
  catch (e) { return false; }
}

/* ---------------- diff → statements ---------------- */

// Collect added lines from a unified diff patch and split them into candidate
// SQL statements on `;`. Skips the `+++`/`---` headers and the
// "\ No newline at end of file" marker. Empty fragments are dropped.
function extractStatements(patch) {
  const added = [];
  for (const raw of String(patch || '').split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) added.push(raw.slice(1));
  }
  return added.join('\n').split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/* ---------------- GitHub API (fetch only) ---------------- */

async function api(fetchFn, token, method, url, body) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sql-sentinel-action'
  };
  if (token) headers['Authorization'] = 'Bearer ' + token; // never logged
  const res = await fetchFn(url, {
    method: method,
    headers: headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) {
    throw new Error('GitHub API ' + method + ' failed with status ' + res.status);
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data: data };
}

async function listPrFiles(fetchFn, token, owner, repo, pr) {
  const files = [];
  let page = 1;
  for (;;) {
    const url = 'https://api.github.com/repos/' + owner + '/' + repo +
      '/pulls/' + pr + '/files?per_page=100&page=' + page;
    const r = await api(fetchFn, token, 'GET', url);
    if (!Array.isArray(r.data) || r.data.length === 0) break;
    files.push(...r.data);
    if (r.data.length < 100) break;
    page += 1;
  }
  return files;
}

async function findStickyComment(fetchFn, token, owner, repo, pr) {
  let page = 1;
  for (;;) {
    const url = 'https://api.github.com/repos/' + owner + '/' + repo +
      '/issues/' + pr + '/comments?per_page=100&page=' + page;
    const r = await api(fetchFn, token, 'GET', url);
    if (!Array.isArray(r.data) || r.data.length === 0) return null;
    for (const c of r.data) {
      if (c && typeof c.body === 'string' && c.body.indexOf(MARKER) !== -1) return c;
    }
    if (r.data.length < 100) return null;
    page += 1;
  }
}

async function postStickyComment(fetchFn, token, owner, repo, pr, body) {
  const existing = await findStickyComment(fetchFn, token, owner, repo, pr);
  if (existing) {
    const url = 'https://api.github.com/repos/' + owner + '/' + repo +
      '/issues/comments/' + existing.id;
    await api(fetchFn, token, 'PATCH', url, { body: body });
    return 'updated';
  }
  const url = 'https://api.github.com/repos/' + owner + '/' + repo +
    '/issues/' + pr + '/comments';
  await api(fetchFn, token, 'POST', url, { body: body });
  return 'created';
}

/* ---------------- validation ---------------- */

// Action-level policy: a PARSE_ERROR is a diff-fragment artifact as often as a
// real syntax problem, so it counts as a warning here (it does NOT change the
// vendored validator's own severity).
function actionIssues(report) {
  return (report.issues || []).map((i) => {
    if (i.code === 'PARSE_ERROR' && i.severity === 'error') {
      return Object.assign({}, i, {
        severity: 'warning',
        message: i.message + ' (This may be a statement truncated by the diff, not a real syntax error.)'
      });
    }
    return i;
  });
}

function statementVerdict(issues) {
  if (issues.some((i) => i.severity === 'error')) return 'blocked';
  if (issues.some((i) => i.severity === 'warning')) return 'review';
  return 'safe';
}

/* ---------------- comment markdown ---------------- */

const VERDICT_BADGE = { safe: '✅ SAFE', review: '⚠️ REVIEW', blocked: '🚫 BLOCKED', unknown: '❓ UNKNOWN' };
const STMT_ICON = { safe: '✅', review: '⚠️', blocked: '🚫', unknown: '❓' };
const SEV_ICON = { error: '❌', warning: '⚠️', info: 'ℹ️' };

function escBackticks(s) {
  return String(s).replace(/`/g, "'");
}

function issueLines(issues) {
  if (!issues.length) return '_No issues found._';
  return issues.map((i) => {
    const icon = SEV_ICON[i.severity] || '•';
    let line = '- ' + icon + ' `' + escBackticks(i.code) + '` — ' + escBackticks(i.message);
    if (i.suggestion) line += '\n  - 💡 ' + escBackticks(i.suggestion);
    return line;
  }).join('\n');
}

function buildComment(review) {
  const L = [];
  L.push(MARKER);
  L.push('## 🛡️ SQL Sentinel — AI-written SQL review');
  L.push('');
  L.push('**Verdict: ' + (VERDICT_BADGE[review.verdict] || review.verdict) + '**');
  L.push('');
  if (review.verdict === 'blocked') {
    L.push('> ⚠️ **Dangerous changes detected** — at least one statement has errors. Review before merging.');
    L.push('');
  }
  for (const f of review.files) {
    L.push('### `' + f.filename + '` — ' + (VERDICT_BADGE[f.verdict] || f.verdict));
    L.push('');
    f.statements.forEach((s, idx) => {
      L.push('<details>');
      L.push('<summary><code>Statement ' + (idx + 1) + '</code> — ' + (STMT_ICON[s.verdict] || '') + ' ' + s.verdict + '</summary>');
      L.push('');
      L.push('```sql');
      L.push(s.sql);
      L.push('```');
      L.push('');
      L.push('**What it does:** ' + escBackticks(s.explanation));
      L.push('');
      L.push('**Issues:**');
      L.push(issueLines(s.issues));
      L.push('');
      L.push('</details>');
      L.push('');
    });
  }
  L.push('---');
  L.push('*Reviewed ' + review.statementCount + ' added statement(s) in ' + review.files.length +
    ' file(s) against `' + review.schemaPath + '` (' + review.dialect + '). ' +
    'Static analysis only — row counts and runtime behavior can\'t be known without executing.*');
  if (review.schemaMissing) {
    L.push('*⚠️ Schema file not found: table/column checks were skipped, but parse and destructive-operation checks still ran.*');
  }
  return L.join('\n');
}

/* ---------------- main flow ---------------- */

async function run(deps) {
  const env = deps.env || {};
  const fetchFn = deps.fetchFn;
  const warnings = [];
  const outputs = {};

  const schemaPath = getInput(env, 'schema_path', 'schema.sql');
  const dialect = normalizeDialect(getInput(env, 'dialect', 'postgres'));
  const filePattern = getInput(env, 'file_pattern', '**/*.sql');
  let failOn = getInput(env, 'fail_on', 'blocked').toLowerCase();
  if (!FAIL_RANK.hasOwnProperty(failOn)) {
    warnings.push('Unknown fail_on "' + failOn + '" — defaulting to "blocked".');
    failOn = 'blocked';
  }
  const postComment = getBoolInput(env, 'post_comment', true);
  const token = getInput(env, 'github_token', '');

  // --- event payload ---
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set — this action only runs on pull_request events.');
  let event;
  try {
    event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  } catch (e) {
    throw new Error('Could not read GITHUB_EVENT_PATH: ' + e.message);
  }
  const fullName = event.repository && event.repository.full_name;
  const prNumber = event.pull_request && event.pull_request.number;
  if (!fullName || !prNumber) {
    throw new Error('Event payload is not a pull_request event (missing repository.full_name or pull_request.number).');
  }
  const slash = fullName.indexOf('/');
  const owner = fullName.slice(0, slash);
  const repo = fullName.slice(slash + 1);

  // --- schema ---
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const schemaFile = path.resolve(workspace, schemaPath);
  let schema = { tables: {}, errors: [], dialect: dialect };
  let schemaMissing = false;
  if (!fs.existsSync(schemaFile)) {
    schemaMissing = true;
    warnings.push('Schema file not found at "' + schemaPath + '" — table/column existence checks skipped; parse and destructive-operation checks still ran.');
  } else {
    const ddl = fs.readFileSync(schemaFile, 'utf8');
    schema = sentinel.parseSchema(ddl, dialect);
    if (schema.errors && schema.errors.length) {
      warnings.push('Schema file had ' + schema.errors.length + ' chunk(s) that did not parse: ' + schema.errors.slice(0, 3).join(' | '));
    }
  }

  // --- PR files ---
  const allFiles = await listPrFiles(fetchFn, token, owner, repo, prNumber);
  const matched = allFiles.filter((f) =>
    f && f.status !== 'removed' && f.patch && globMatch(filePattern, f.filename || ''));

  const files = [];
  let statementCount = 0;
  for (const f of matched) {
    const stmts = extractStatements(f.patch);
    const statements = [];
    for (const sql of stmts) {
      const report = sentinel.validate(sql, schema, dialect);
      const issues = actionIssues(report);
      const verdict = statementVerdict(issues);
      let explanation;
      try { explanation = sentinel.explain(sql, schema, dialect); }
      catch (e) { explanation = 'Could not explain this statement.'; }
      statements.push({ sql: sql, verdict: verdict, issues: issues, explanation: explanation });
      statementCount += 1;
    }
    if (!statements.length) continue;
    let fileVerdict = 'safe';
    for (const s of statements) {
      if (RANK[s.verdict] > RANK[fileVerdict]) fileVerdict = s.verdict;
    }
    files.push({ filename: f.filename, verdict: fileVerdict, statements: statements });
  }

  let verdict = 'safe';
  for (const f of files) {
    if (RANK[f.verdict] > RANK[verdict]) verdict = f.verdict;
  }

  outputs.verdict = verdict;

  let commentAction = 'skipped';
  if (files.length > 0 && postComment) {
    if (!token) {
      warnings.push('post_comment is true but no github_token was provided — skipping PR comment.');
    } else {
      const body = buildComment({
        verdict: verdict, files: files, statementCount: statementCount,
        schemaPath: schemaPath, dialect: dialect, schemaMissing: schemaMissing
      });
      commentAction = await postStickyComment(fetchFn, token, owner, repo, prNumber, body);
    }
  }

  const exitCode = failOn === 'never' ? 0 : (RANK[verdict] >= FAIL_RANK[failOn] ? 1 : 0);

  return { verdict: verdict, exitCode: exitCode, outputs: outputs, warnings: warnings,
           commentAction: commentAction, filesReviewed: files.length, statementCount: statementCount };
}

async function main() {
  try {
    const result = await run({ env: process.env, fetchFn: fetch });
    for (const w of result.warnings) console.log('::warning::' + w);
    const outFile = process.env.GITHUB_OUTPUT;
    if (outFile) {
      fs.appendFileSync(outFile, 'verdict=' + result.verdict + '\n');
    } else {
      console.log('::set-output name=verdict::' + result.verdict);
    }
    console.log('SQL Sentinel verdict: ' + result.verdict +
      ' (' + result.filesReviewed + ' file(s), ' + result.statementCount + ' statement(s), comment ' + result.commentAction + ')');
    process.exitCode = result.exitCode;
  } catch (e) {
    console.log('::error::' + String(e && e.message || e));
    process.exitCode = 1;
  }
}

module.exports = { run, getInput, normalizeDialect, globMatch, extractStatements,
                   actionIssues, statementVerdict, buildComment, MARKER };

if (require.main === module) main();
