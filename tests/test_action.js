/* SQL Sentinel Action tests — plain node, no npm.
 * Mocks fetch, uses temp dirs for GITHUB_WORKSPACE + event payload.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const action = require('../src/index.js');

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { passed += 1; console.log('  ok  ' + name); }
  else { failed += 1; failures.push(name); console.log('  FAIL ' + name); }
}

function makeWorkspace(withSchema) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-'));
  if (withSchema) {
    fs.writeFileSync(path.join(dir, 'schema.sql'),
      'CREATE TABLE orders (id INT, total DECIMAL(10,2), status VARCHAR(20));\n' +
      'CREATE TABLE customers (id INT, name VARCHAR(100));\n');
  }
  const event = {
    repository: { full_name: 'k1sh0r3/test-repo' },
    pull_request: { number: 7, head: { sha: 'abc123' } }
  };
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(event));
  return { dir: dir, eventPath: eventPath };
}

function baseEnv(ws, overrides) {
  const env = {
    GITHUB_EVENT_PATH: ws.eventPath,
    GITHUB_WORKSPACE: ws.dir,
    INPUT_SCHEMA_PATH: 'schema.sql',
    INPUT_DIALECT: 'postgres',
    INPUT_FILE_PATTERN: '**/*.sql',
    INPUT_FAIL_ON: 'blocked',
    INPUT_POST_COMMENT: 'true',
    INPUT_GITHUB_TOKEN: 'fake-token'
  };
  return Object.assign(env, overrides || {});
}

// Flexible mock fetch: routes are { match(url, method), respond(url, method) }
// or { match, status, body }. Records every call.
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    calls.push({ method: method, url: url, body: opts && opts.body });
    const route = routes.find((r) => r.match(url, method));
    if (!route) throw new Error('unexpected fetch: ' + method + ' ' + url);
    const resp = typeof route.respond === 'function' ? route.respond(url, method) : route;
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => resp.body
    };
  };
  fn.calls = calls;
  return fn;
}

const FILES = (url) => url.includes('/pulls/7/files');
const COMMENTS = (url) => url.includes('/issues/7/comments');

function sqlFile(filename, patch, status) {
  return { filename: filename, status: status || 'modified', patch: patch };
}

const BAD_PATCH = 'diff --git a/migrations/bad.sql b/migrations/bad.sql\n' +
  '+++ b/migrations/bad.sql\n' +
  '@@ -0,0 +1,2 @@\n' +
  '+-- Dangerous\n' +
  '+DELETE FROM orders;';

const GOOD_PATCH = 'diff --git a/migrations/good.sql b/migrations/good.sql\n' +
  '+++ b/migrations/good.sql\n' +
  '@@ -0,0 +1,6 @@\n' +
  '+SELECT id, total\n' +
  '+FROM orders\n' +
  "+WHERE status = 'paid'\n" +
  '+ORDER BY total DESC\n' +
  '+LIMIT 10;';

const REVIEW_PATCH = 'diff --git a/migrations/q.sql b/migrations/q.sql\n' +
  '+++ b/migrations/q.sql\n' +
  '@@ -0,0 +1,1 @@\n' +
  '+SELECT id FROM orders;';

async function runAll() {
  /* ---- 1. glob matcher ---- */
  ok(action.globMatch('**/*.sql', 'migrations/001.sql'), 'glob ** matches nested file');
  ok(action.globMatch('**/*.sql', '001.sql'), 'glob ** matches root file');
  ok(!action.globMatch('**/*.sql', 'src/app.js'), 'glob ** rejects non-sql');
  ok(!action.globMatch('**/*.sql', 'migrations/001.sql.bak'), 'glob ** rejects wrong extension');
  ok(action.globMatch('migrations/*.sql', 'migrations/001.sql'), 'glob * matches one level');
  ok(!action.globMatch('migrations/*.sql', 'migrations/sub/001.sql'), 'glob * does not cross /');
  ok(!action.globMatch('*.sql', 'migrations/001.sql'), 'root glob does not match nested');

  /* ---- 2. diff → statements ---- */
  const stmts = action.extractStatements(
    '--- a/migrations/x.sql\n+++ b/migrations/x.sql\n@@ -1,2 +1,3 @@\n context\n-old line\n+SELECT 1;\n+DELETE FROM orders;\n\\ No newline at end of file\n');
  ok(stmts.length === 2 && stmts[0] === 'SELECT 1' && stmts[1] === 'DELETE FROM orders',
    'extractStatements takes added lines, skips headers/markers, splits on ;');
  ok(action.extractStatements('').length === 0, 'extractStatements empty patch → []');

  /* ---- 3. dialect normalization ---- */
  ok(action.normalizeDialect('postgres') === 'postgresql', 'postgres → postgresql');
  ok(action.normalizeDialect('pg') === 'postgresql', 'pg → postgresql');
  ok(action.normalizeDialect('mysql') === 'mysql', 'mysql passthrough');
  ok(action.normalizeDialect('weird') === 'postgresql', 'unknown dialect falls back');

  /* ---- 4. end-to-end blocked + comment created ---- */
  {
    const ws = makeWorkspace(true);
    const posted = [];
    const f = mockFetch([
      { match: (u, m) => m === 'GET' && FILES(u), status: 200, body: [sqlFile('migrations/bad.sql', BAD_PATCH)] },
      { match: (u, m) => m === 'GET' && COMMENTS(u), status: 200, body: [] },
      { match: (u, m) => m === 'POST' && COMMENTS(u), respond: (u) => { posted.push(u); return { status: 201, body: { id: 1 } }; } }
    ]);
    const r = await action.run({ env: baseEnv(ws), fetchFn: f });
    ok(r.verdict === 'blocked', 'DELETE without WHERE → blocked verdict');
    ok(r.exitCode === 1, 'fail_on=blocked exits 1 on blocked');
    ok(r.outputs.verdict === 'blocked', 'verdict output is set');
    ok(r.commentAction === 'created', 'sticky comment created when none exists');
    ok(posted.length === 1, 'exactly one POST to create comment');
    const body = JSON.parse(f.calls.find((c) => c.method === 'POST').body).body;
    ok(body.includes('<!-- sql-sentinel -->'), 'comment contains the marker');
    ok(body.includes('🚫 BLOCKED'), 'comment shows BLOCKED badge');
    ok(body.includes('DESTRUCTIVE_NO_WHERE'), 'comment names the issue code');
    ok(body.includes('<details>'), 'comment has collapsible statement sections');
    ok(body.includes('What it does:'), 'comment includes plain-English explanation');
    ok(!f.calls.some((c) => c.url.includes('fake-token')), 'token never appears in a URL');
  }

  /* ---- 5. sticky comment update ---- */
  {
    const ws = makeWorkspace(true);
    const f = mockFetch([
      { match: (u, m) => m === 'GET' && FILES(u), status: 200, body: [sqlFile('migrations/bad.sql', BAD_PATCH)] },
      { match: (u, m) => m === 'GET' && COMMENTS(u), status: 200, body: [{ id: 123, body: 'old\n<!-- sql-sentinel -->' }] },
      { match: (u, m) => m === 'PATCH' && u.includes('/issues/comments/123'), status: 200, body: { id: 123 } }
    ]);
    const r = await action.run({ env: baseEnv(ws), fetchFn: f });
    ok(r.commentAction === 'updated', 'existing marker comment is PATCHed');
    ok(!f.calls.some((c) => c.method === 'POST'), 'no POST when updating existing comment');
  }

  /* ---- 6. fail_on behavior ---- */
  {
    // review verdict (MISSING_LIMIT warning), fail_on=review → fail
    const ws = makeWorkspace(true);
    const f = mockFetch([
      { match: (u, m) => m === 'GET' && FILES(u), status: 200, body: [sqlFile('migrations/q.sql', REVIEW_PATCH)] },
      { match: (u, m) => m === 'GET' && COMMENTS(u), status: 200, body: [] },
      { match: (u, m) => m === 'POST' && COMMENTS(u), status: 201, body: { id: 1 } }
    ]);
    const r = await action.run({ env: baseEnv(ws, { INPUT_FAIL_ON: 'review' }), fetchFn: f });
    ok(r.verdict === 'review', 'missing LIMIT → review verdict');
    ok(r.exitCode === 1, 'fail_on=review exits 1 on review');

    const ws2 = makeWorkspace(true);
    const f2 = mockFetch([
      { match: (u, m) => m === 'GET' && FILES(u), status: 200, body: [sqlFile('migrations/q.sql', REVIEW_PATCH)] },
      { match: (u, m) => m === 'GET' && COMMENTS(u), status: 200, body: [] },
      { match: (u, m) => m === 'POST' && COMMENTS(u), status: 201, body: { id: 1 } }
    ]);
    const r2 = await action.run({ env: baseEnv(ws2, { INPUT_FAIL_ON: 'blocked' }), fetchFn: f2 });
    ok(r2.exitCode === 0, 'fail_on=blocked passes on review');

    const ws3 = makeWorkspace(true);
    const f3 = mockFetch([
      { match: (u, m) => m === 'GET' && FILES(u), status: 200, body: [sqlFile('migrations/bad.sql', BAD_PATCH)] },
      { match: (u, m) => m === 'GET' && COMMENTS(u), status: 200, body: [] },
      { match: (u, m) => m === 'POST' && COMMENTS(u), status: 201, body: { id: 1 } }
    ]);
    const r3 = await action.run({ env: baseEnv(ws3, { INPUT_FAIL_ON: 'never' }), fetchFn: f3 });
    ok(r3.verdict === 'blocked' && r3.exitCode === 0, 'fail_on=never never fails');
  }

  /* ---- 7. missing schema degrades gracefully ---- */
  {
    const ws = makeWorkspace(false); // no schema.sql
    let commentBody = '';
    const f = mockFetch([
      { match: (u, m) => m === 'GET' && FILES(u), status: 200, body: [sqlFile('migrations/bad.sql', BAD_PATCH)] },
      { match: (u, m) => m === 'GET' && COMMENTS(u), status: 200, body: [] },
      { match: (u, m) => m === 'POST' && COMMENTS(u), respond: (u, m) => { return { status: 201, body: { id: 1 } }; } }
    ]);
    const origPost = f;
    const r = await action.run({ env: baseEnv(ws), fetchFn: origPost });
    const postCall = origPost.calls.find((c) => c.method === 'POST');
    commentBody = JSON.parse(postCall.body).body;
    ok(r.warnings.some((w) => w.includes('Schema file not found')), 'missing schema produces a loud warning');
    ok(r.verdict === 'blocked', 'destructive-op check still blocks without schema');
    ok(r.exitCode === 1, 'still fails on blocked without schema');
    ok(commentBody.includes('table/column checks were skipped'), 'comment says checks were skipped');
  }

  /* ---- 8. safe query path ---- */
  {
    const ws = makeWorkspace(true);
    const f = mockFetch([
      { match: (u, m) => m === 'GET' && FILES(u), status: 200, body: [sqlFile('migrations/good.sql', GOOD_PATCH)] },
      { match: (u, m) => m === 'GET' && COMMENTS(u), status: 200, body: [] },
      { match: (u, m) => m === 'POST' && COMMENTS(u), status: 201, body: { id: 1 } }
    ]);
    const r = await action.run({ env: baseEnv(ws), fetchFn: f });
    const body = JSON.parse(f.calls.find((c) => c.method === 'POST').body).body;
    ok(r.verdict === 'safe' && r.exitCode === 0, 'clean query → safe, exit 0');
    ok(body.includes('✅ SAFE'), 'comment shows SAFE badge');
  }

  /* ---- 9. truncated diff fragment → warning, not error ---- */
  {
    const ws = makeWorkspace(true);
    const truncPatch = '+++ b/migrations/t.sql\n@@ -0,0 +1,1 @@\n+SELECT id FROM';
    const f = mockFetch([
      { match: (u, m) => m === 'GET' && FILES(u), status: 200, body: [sqlFile('migrations/t.sql', truncPatch)] },
      { match: (u, m) => m === 'GET' && COMMENTS(u), status: 200, body: [] },
      { match: (u, m) => m === 'POST' && COMMENTS(u), status: 201, body: { id: 1 } }
    ]);
    const r = await action.run({ env: baseEnv(ws), fetchFn: f });
    const body = JSON.parse(f.calls.find((c) => c.method === 'POST').body).body;
    ok(r.verdict === 'review', 'parse failure downgraded to review (not blocked)');
    ok(r.exitCode === 0, 'default fail_on=blocked does not fail on truncated fragment');
    ok(body.includes('PARSE_ERROR'), 'comment still shows the parse problem');
  }

  /* ---- 10. no matching files / removed files ---- */
  {
    const ws = makeWorkspace(true);
    const f = mockFetch([
      { match: (u, m) => m === 'GET' && FILES(u), status: 200, body: [
        sqlFile('src/app.js', '+++ b/src/app.js\n+const x = 1;'),
        sqlFile('migrations/old.sql', '--- a/migrations/old.sql\n-DELETED', 'removed')
      ] }
    ]);
    const r = await action.run({ env: baseEnv(ws), fetchFn: f });
    ok(r.verdict === 'safe', 'no SQL changes → safe');
    ok(r.commentAction === 'skipped', 'no comment posted when nothing to review');
    ok(!f.calls.some((c) => c.method === 'POST' || c.method === 'PATCH'), 'no comment API writes');
  }

  /* ---- 11. pagination over PR files ---- */
  {
    const ws = makeWorkspace(true);
    const page1 = [];
    for (let i = 0; i < 100; i++) page1.push(sqlFile('migrations/f' + i + '.sql', GOOD_PATCH));
    const f = mockFetch([
      { match: (u, m) => m === 'GET' && FILES(u) && u.includes('&page=1'), status: 200, body: page1 },
      { match: (u, m) => m === 'GET' && FILES(u) && u.includes('&page=2'), status: 200, body: [sqlFile('migrations/bad.sql', BAD_PATCH)] },
      { match: (u, m) => m === 'GET' && COMMENTS(u), status: 200, body: [] },
      { match: (u, m) => m === 'POST' && COMMENTS(u), status: 201, body: { id: 1 } }
    ]);
    const r = await action.run({ env: baseEnv(ws), fetchFn: f });
    ok(r.statementCount === 101, 'paginated file list is fully walked (101 statements)');
    ok(r.verdict === 'blocked', 'worst verdict wins across pages');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) { console.log('failures: ' + failures.join(', ')); process.exit(1); }
}

runAll().catch((e) => { console.error('test harness error:', e); process.exit(1); });
