/* SQL Sentinel validator — schema parsing, SQL validation, plain-English
 * explanation. Dependency-free except for the SQL parser class injected via
 * createValidator(). Works in node (tests) and the browser.
 * Usage: const v = SqlSentinel.createValidator(ParserClass);
 *        const schema = v.parseSchema(ddlText, 'postgresql');
 *        const report = v.validate(sqlText, schema, 'postgresql');
 *        const words  = v.explain(sqlText, schema, 'postgresql');
 * Honesty rule: where certainty is impossible, say "unknown" — never fake it.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.SqlSentinel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- string utils ---------------- */
  function norm(s) {
    return String(s == null ? '' : s).replace(/["'`\[\]]/g, '').trim();
  }
  function normLower(s) { return norm(s).toLowerCase(); }

  function levenshtein(a, b) {
    a = String(a); b = String(b);
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  function didYouMean(name, candidates, maxN) {
    maxN = maxN || 3;
    const scored = [];
    for (const c of candidates) {
      const d = levenshtein(normLower(name), normLower(c));
      const threshold = Math.max(2, Math.floor(String(c).length / 3));
      if (d > 0 && d <= threshold) scored.push({ c: c, d: d });
    }
    scored.sort((x, y) => x.d - y.d);
    return scored.slice(0, maxN).map((x) => x.c);
  }

  /* ---------------- PII heuristics ---------------- */
  // Name-based only — a heuristic, reported as "possible PII", never certain.
  var PII_PATTERNS = [
    /ssn|social.?security/i,
    /\bemail\b|e.?mail/i,
    /phone|mobile|telephone|\btel\b/i,
    /first.?name|last.?name|full.?name|given.?name|surname/i,
    /\baddress\b|street|city|\bzip\b|postal/i,
    /\bdob\b|birth.?date|date.?of.?birth/i,
    /credit.?card|card.?number|\bcvv\b|pan\b/i,
    /passport|driver.?licen[cs]e/i,
    /\bsalary\b|wage|income|compensation/i,
    /password|passwd|\bsecret\b|api.?key|token/i,
    /bank.?account|account.?number|routing.?number|iban/i
  ];
  function isPiiColumn(colName) {
    return PII_PATTERNS.some(function (re) { return re.test(String(colName)); });
  }

  /* ---------------- type categories ---------------- */
  function typeCategory(dataType) {
    const t = String(dataType || '').toUpperCase();
    if (/INT|INTEGER|BIGINT|SMALLINT|TINYINT|NUMERIC|DECIMAL|FLOAT|DOUBLE|REAL|SERIAL|MONEY/.test(t)) return 'number';
    if (/BOOL/.test(t)) return 'boolean';
    if (/DATE|TIME/.test(t)) return 'datetime';
    if (/CHAR|TEXT|STRING|CLOB|UUID|ENUM/.test(t)) return 'string';
    if (/ARRAY|STRUCT|JSON|VARIANT|OBJECT|GEOGRAPHY|BYTE/.test(t)) return 'complex';
    return 'unknown';
  }

  /* ---------------- AST accessors ----------------
   * node-sql-parser is inconsistent: identifiers may be strings or
   * {type:'default', value:'x'} objects; column may be '*' or an object. */
  function nameOf(node) {
    if (node == null) return null;
    if (typeof node === 'string') return norm(node);
    if (typeof node === 'object') {
      if (typeof node.value === 'string') return norm(node.value);
      if (node.expr) return nameOf(node.expr);
    }
    return null;
  }
  function tableRefName(t) { return nameOf(t); }   // from-entry table or column_ref table
  function colRefName(c) {                          // column_ref column
    if (c === '*') return '*';
    return nameOf(c);
  }

  function walk(node, cb) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n, cb); return; }
    cb(node);
    for (const k of Object.keys(node)) walk(node[k], cb);
  }

  /* ---------------- validator factory ---------------- */
  function createValidator(ParserClass) {
    const DIALECTS = ['bigquery', 'mysql', 'postgresql', 'snowflake', 'sqlite', 'trino'];

    function orderedDialects(preferred) {
      const out = [];
      if (preferred) out.push(preferred);
      for (const d of DIALECTS) if (!out.includes(d)) out.push(d);
      return out;
    }

    function tryParse(sql, preferredDialect) {
      let lastErr = null;
      for (const d of orderedDialects(preferredDialect)) {
        try {
          const parser = new ParserClass();
          const res = parser.parse(sql, { database: d });
          const ast = res && res.ast;
          const stmts = Array.isArray(ast) ? ast : [ast];
          return { stmts: stmts, dialect: d };
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    }

    /* ============ parseSchema ============ */
    function parseSchema(ddlText, dialect) {
      const schema = { tables: {}, errors: [], dialect: dialect || null };
      const chunks = String(ddlText || '').split(/;/).map((s) => s.trim()).filter(Boolean);
      for (const chunk of chunks) {
        let parsed = null, lastErr = null;
        for (const d of orderedDialects(dialect)) {
          try {
            const parser = new ParserClass();
            parsed = { res: parser.parse(chunk + ';', { database: d }), d: d };
            break;
          } catch (e) { lastErr = e; }
        }
        if (!parsed) {
          schema.errors.push('Could not parse: ' + chunk.slice(0, 80));
          continue;
        }
        const stmts = Array.isArray(parsed.res.ast) ? parsed.res.ast : [parsed.res.ast];
        for (const st of stmts) {
          if (!st || st.type !== 'create') continue;
          if (!/table/i.test(st.keyword || '')) continue;
          const tblArr = st.table || [];
          const tname = tableRefName(tblArr[tblArr.length - 1] && tblArr[tblArr.length - 1].table);
          if (!tname) continue;
          const cols = {};
          const defs = st.create_definitions || [];
          for (const def of defs) {
            if (!def || def.resource !== 'column' || !def.column) continue;
            const cn = colRefName(def.column.column != null ? def.column.column : def.column);
            if (!cn || cn === '*') continue;
            const dt = def.definition && def.definition.dataType ? def.definition.dataType : 'UNKNOWN';
            cols[cn.toLowerCase()] = { name: cn, type: String(dt), category: typeCategory(dt), pii: isPiiColumn(cn) };
          }
          schema.tables[tname.toLowerCase()] = {
            name: tname,
            columns: cols,
            pii: Object.values(cols).filter((c) => c.pii).map((c) => c.name)
          };
        }
      }
      return schema;
    }

    /* ============ scope building ============ */
    // scope: Map lowerKey -> { label, columns: {lowerName: {name,type,category,pii}} | null (unknown) }
    function buildScope(stmt, schema) {
      const scope = new Map();
      // CTEs first: known names, unknown columns (honest).
      // node-sql-parser puts WITH entries in an array: [{name, stmt}, …]
      try {
        const withClause = stmt.with;
        const ctes = Array.isArray(withClause) ? withClause
          : (withClause && (withClause.name || withClause.ctes || withClause.tables)) || [];
        if (Array.isArray(ctes)) {
          for (const c of ctes) {
            const nm = nameOf((c && c.name) || c);
            if (nm) scope.set(nm.toLowerCase(), { label: nm, columns: null, kind: 'cte' });
          }
        }
      } catch (e) { /* unknown WITH shape — skip, stay honest */ }

      const from = stmt.from || [];
      for (const f of from) {
        if (!f) continue;
        if (f.expr) { // derived table / subquery: known alias, unknown columns
          const al = nameOf(f.as);
          if (al) scope.set(al.toLowerCase(), { label: al, columns: null, kind: 'subquery' });
          continue;
        }
        const tname = tableRefName(f.table);
        if (!tname) continue;
        let alias = nameOf(f.as);
        if (alias && alias.toUpperCase() === 'CROSS') alias = null; // parser quirk: CROSS JOIN -> as:'CROSS'
        const existing = scope.get(tname.toLowerCase());
        if (existing && existing.kind !== 'table') {
          // CTE / subquery name shadows any real table — keep the honest entry
          if (alias) scope.set(alias.toLowerCase(), existing);
          continue;
        }
        const entry = { label: alias || tname, columns: null, kind: 'table', realName: tname };
        const tbl = schema.tables[tname.toLowerCase()];
        if (tbl) entry.columns = tbl.columns;
        scope.set(tname.toLowerCase(), entry);
        if (alias) scope.set(alias.toLowerCase(), entry);
      }
      return scope;
    }

    function resolveColumn(colRef, scope) {
      // returns { found: [{table, col}], qualifierKnown }
      const cname = colRefName(colRef.column);
      const tqual = colRef.table != null ? tableRefName(colRef.table) : null;
      if (cname === '*') return { star: true, qualifier: tqual };
      const qkey = tqual ? tqual.toLowerCase() : null;
      if (qkey && !scope.has(qkey)) return { found: [], qualifierKnown: false, qualifier: tqual };
      const tables = qkey ? [scope.get(qkey)] : Array.from(scope.values());
      const seen = new Set();
      const found = [];
      let unknownTables = 0;
      for (const t of tables) {
        if (!t || t.columns == null) { unknownTables++; continue; } // can't judge — don't error
        const hit = t.columns[cname.toLowerCase()];
        if (hit && !seen.has(t.label)) { seen.add(t.label); found.push({ table: t, col: hit }); }
      }
      // dedupe same real table under two keys
      const uniq = [];
      const seenReal = new Set();
      for (const f of found) {
        const rk = (f.table.realName || f.table.label).toLowerCase();
        if (!seenReal.has(rk)) { seenReal.add(rk); uniq.push(f); }
      }
      return { found: uniq, qualifierKnown: true, qualifier: tqual, unknownTables: unknownTables };
    }

    function allKnownColumns(scope) {
      const out = [];
      for (const t of scope.values()) {
        if (t.columns) for (const k of Object.keys(t.columns)) out.push(t.columns[k].name);
      }
      return out;
    }

    function inferType(expr, scope) {
      if (!expr || typeof expr !== 'object') return 'unknown';
      switch (expr.type) {
        case 'column_ref': {
          const r = resolveColumn(expr, scope);
          if (r.found && r.found.length === 1) return r.found[0].col.category || 'unknown';
          return 'unknown';
        }
        case 'number': return 'number';
        case 'single_quote_string':
        case 'double_quote_string': return 'string';
        case 'bool':
        case 'boolean': return 'boolean';
        case 'null': return 'unknown';
        case 'aggr_func': {
          const nm = String(expr.name || '').toUpperCase();
          if (nm === 'COUNT' || nm === 'SUM' || nm === 'AVG') return 'number';
          if (nm === 'MIN' || nm === 'MAX') {
            const args = expr.args && expr.args.expr ? [expr.args.expr] : (expr.args && expr.args.value) || [];
            const arr = Array.isArray(args) ? args : [args];
            return arr.length ? inferType(arr[0], scope) : 'unknown';
          }
          return 'unknown';
        }
        default: return 'unknown';
      }
    }

    function typesClash(a, b) {
      const known = ['number', 'string', 'boolean', 'datetime'];
      if (!known.includes(a) || !known.includes(b)) return false;
      if (a === b) return false;
      if ((a === 'datetime' && b === 'string') || (a === 'string' && b === 'datetime')) return false; // date literals are idiomatic
      return true;
    }

    /* ============ validate ============ */
    function issue(severity, code, message, suggestion) {
      return { severity: severity, code: code, message: message, suggestion: suggestion || null };
    }

    function validate(sqlText, schema, dialect) {
      const issues = [];
      schema = schema || { tables: {} };
      const hasSchema = schema && schema.tables && Object.keys(schema.tables).length > 0;
      let parsed;
      try {
        parsed = tryParse(String(sqlText || '').trim(), dialect);
      } catch (e) {
        return {
          ok: false, dialect: dialect || null, parsedDialect: null, statementType: null,
          issues: [issue('error', 'PARSE_ERROR',
            'Could not parse the SQL: ' + String(e && e.message || e).split('\n')[0].slice(0, 200),
            'Check the syntax for the selected dialect, or try another dialect.')]
        };
      }
      if (parsed.stmts.length > 1) {
        issues.push(issue('warning', 'MULTI_STATEMENT',
          'Multiple statements found — only the first was validated.',
          'Validate statements one at a time for a complete report.'));
      }
      const stmt = parsed.stmts[0];
      if (!stmt || !stmt.type) {
        issues.push(issue('error', 'EMPTY', 'No statement found.', 'Paste a SQL statement to validate.'));
        return { ok: false, dialect: dialect, parsedDialect: parsed.dialect, statementType: null, issues: issues };
      }
      const type = String(stmt.type).toLowerCase();
      if (!hasSchema && (type === 'select' || type === 'insert')) {
        issues.push(issue('info', 'SCHEMA_MISSING',
          'No schema provided — table/column existence checks were skipped.',
          'Paste your CREATE TABLE statements to enable full validation.'));
      }

      if (type === 'select') validateSelect(stmt, schema, issues);
      else if (type === 'delete' || type === 'update') validateWrite(stmt, schema, issues, type);
      else if (type === 'drop' || type === 'truncate') {
        issues.push(issue('error', 'DESTRUCTIVE_UNBOUNDED',
          type.toUpperCase() + ' is irreversible — it removes the entire table and its data.',
          'This statement should never run from an AI-generated query without human sign-off.'));
      }
      else if (type === 'insert') validateInsert(stmt, schema, issues);
      else {
        issues.push(issue('info', 'UNKNOWN_STATEMENT',
          'Statement type "' + type + '" is not covered by the validator.',
          'Only SELECT / INSERT / UPDATE / DELETE / DROP / TRUNCATE are checked.'));
      }

      const ok = !issues.some((i) => i.severity === 'error');
      return { ok: ok, dialect: dialect || null, parsedDialect: parsed.dialect, statementType: type, issues: issues };
    }

    function checkTableExists(tname, schema, issues) {
      if (!tname || !schema.tables) return true;
      if (!schema.tables[tname.toLowerCase()]) {
        const sugg = didYouMean(tname, Object.values(schema.tables).map((t) => t.name));
        issues.push(issue('error', 'UNKNOWN_TABLE',
          'Unknown table "' + tname + '"' + (sugg.length ? ' — did you mean ' + sugg.map((s) => '"' + s + '"').join(', ') + '?' : '.'),
          sugg.length ? 'Fix the table name.' : 'Check the table name against your schema.'));
        return false;
      }
      return true;
    }

    function validateSelect(stmt, schema, issues) {
      const scope = buildScope(stmt, schema);
      const hasSchema = schema.tables && Object.keys(schema.tables).length > 0;

      // table existence (CTE / subquery aliases are known names — skip them)
      if (hasSchema) {
        for (const f of (stmt.from || [])) {
          if (f && f.table) {
            const tname = tableRefName(f.table);
            const entry = tname && scope.get(tname.toLowerCase());
            if (entry && entry.kind !== 'table') continue;
            checkTableExists(tname, schema, issues);
          }
        }
      }

      // collect column refs from everywhere (with clause origin for alias handling)
      const refs = [];
      const pushRefs = (node, clause) => walk(node, (n) => { if (n.type === 'column_ref') refs.push({ n: n, clause: clause }); });
      pushRefs(stmt.columns, 'columns');
      if (stmt.where) pushRefs(stmt.where, 'where');
      if (stmt.having) pushRefs(stmt.having, 'having');
      for (const f of (stmt.from || [])) if (f && f.on) pushRefs(f.on, 'join');
      if (stmt.groupby) pushRefs(stmt.groupby, 'groupby');
      if (stmt.orderby) pushRefs(stmt.orderby, 'orderby');

      // SELECT output names (explicit aliases + bare column names) — legal in
      // ORDER BY / GROUP BY / HAVING in most dialects.
      const outputNames = new Set();
      for (const c of (stmt.columns || [])) {
        if (c.as) outputNames.add(String(c.as).toLowerCase());
        else if (c.expr && c.expr.type === 'column_ref') {
          const cn = colRefName(c.expr.column);
          if (cn && cn !== '*') outputNames.add(cn.toLowerCase());
        }
      }

      let starAll = false;
      const piiHits = new Set();
      for (const ref of refs) {
        const r = ref.n;
        const cname = colRefName(r.column);
        if (cname === '*') {
          const tqual = r.table != null ? tableRefName(r.table) : null;
          if (!tqual) starAll = true;
          else if (hasSchema && tqual && !scope.has(tqual.toLowerCase())) {
            issues.push(issue('error', 'UNKNOWN_TABLE', 'Unknown table "' + tqual + '" in "' + tqual + '.*".', 'Check the table name.'));
          }
          continue;
        }
        const res = resolveColumn(r, scope);
        if (!res.qualifierKnown) {
          const sugg = didYouMean(res.qualifier, Array.from(scope.keys()));
          issues.push(issue('error', 'UNKNOWN_TABLE',
            'Unknown table or alias "' + res.qualifier + '"' + (sugg.length ? ' — did you mean "' + sugg[0] + '"?' : '.'),
            'Check the alias in FROM/JOIN.'));
          continue;
        }
        if (!hasSchema) continue;
        if (res.found.length === 0) {
          // ORDER BY / GROUP BY / HAVING may reference a SELECT alias — legal SQL.
          if ((ref.clause === 'orderby' || ref.clause === 'having' || ref.clause === 'groupby') &&
              outputNames.has(cname.toLowerCase())) continue;
          // If any in-scope table has unknown columns (CTE, subquery), the
          // column could legitimately come from there — stay honest, skip.
          if (res.unknownTables > 0) continue;
          const sugg = didYouMean(cname, allKnownColumns(scope));
          issues.push(issue('error', 'UNKNOWN_COLUMN',
            'Unknown column "' + (res.qualifier ? res.qualifier + '.' : '') + cname + '"' +
            (sugg.length ? ' — did you mean ' + sugg.map((s) => '"' + s + '"').join(', ') + '?' : '.'),
            sugg.length ? 'Fix the column name.' : 'Check the column name against your schema.'));
        } else {
          if (res.found.length > 1 && !res.qualifier) {
            issues.push(issue('warning', 'AMBIGUOUS_COLUMN',
              'Column "' + cname + '" exists in multiple tables (' +
              res.found.map((f) => f.table.realName || f.table.label).join(', ') + ').',
              'Qualify it explicitly, e.g. ' + (res.found[0].table.realName || res.found[0].table.label) + '.' + cname + '.'));
          }
          for (const f of res.found) if (f.col.pii) piiHits.add(f.col.name);
        }
      }
      if (starAll) {
        issues.push(issue('info', 'SELECT_STAR',
          'SELECT * returns every column, including ones you may not need.',
          'List columns explicitly for clarity and to avoid surprises when the schema changes.'));
      }

      // join checks
      const from = stmt.from || [];
      for (let i = 1; i < from.length; i++) {
        const f = from[i];
        if (!f) continue;
        if (f.join && f.on == null && f.using == null) {
          issues.push(issue('warning', 'CROSS_JOIN',
            'JOIN on "' + (tableRefName(f.table) || 'table') + '" has no ON condition — every row pairs with every row.',
            'Add an ON condition, or use CROSS JOIN deliberately if that is the intent.'));
        } else if (!f.join) {
          issues.push(issue('warning', 'IMPLICIT_CROSS_JOIN',
            'Comma join on "' + (tableRefName(f.table) || 'table') + '" has no join condition.',
            'Use explicit JOIN … ON syntax so the join condition is visible.'));
        }
      }

      // type-mismatch checks in comparisons (WHERE, JOIN ON, HAVING)
      const CMP = ['=', '<', '>', '<=', '>=', '<>', '!='];
      function checkComparisons(node) {
        walk(node, (n) => {
          if (n.type === 'binary_expr' && CMP.includes(String(n.operator).toUpperCase())) {
            const a = inferType(n.left, scope), b = inferType(n.right, scope);
            if (typesClash(a, b)) {
              issues.push(issue('warning', 'TYPE_MISMATCH',
                'Comparing ' + a + ' to ' + b + ' ("' + exprSummary(n) + '").',
                'Comparing mismatched types can silently return wrong results — cast explicitly.'));
            }
          }
        });
      }
      if (stmt.where) checkComparisons(stmt.where);
      if (stmt.having) checkComparisons(stmt.having);
      for (const f of from) if (f && f.on) checkComparisons(f.on);

      // missing LIMIT heuristic (parser emits an empty limit object when absent)
      const hasLimit = !!(stmt.limit && stmt.limit.value && stmt.limit.value.length);
      const hasAgg = (function () {
        let found = false;
        walk(stmt.columns, (n) => { if (n.type === 'aggr_func') found = true; });
        return found;
      })();
      if (!hasLimit && !hasAgg && from.length > 0) {
        issues.push(issue('warning', 'MISSING_LIMIT',
          'No LIMIT — this query can return the entire table.',
          'Add a LIMIT while exploring, or confirm a full scan is intended.'));
      }

      if (piiHits.size) {
        issues.push(issue('warning', 'PII_ACCESS',
          'Possible PII accessed: ' + Array.from(piiHits).join(', ') + '.',
          'Confirm these columns are needed — avoid selecting PII you will not use.'));
      }
    }

    function exprSummary(n) {
      try {
        const L = n.left && n.left.type === 'column_ref' ? shortRef(n.left) : inferType(n.left, new Map());
        const R = n.right && n.right.type === 'column_ref' ? shortRef(n.right) : inferType(n.right, new Map());
        return L + ' ' + n.operator + ' ' + R;
      } catch (e) { return 'comparison'; }
    }
    function shortRef(r) {
      const t = r.table != null ? tableRefName(r.table) : null;
      const c = colRefName(r.column);
      return (t ? t + '.' : '') + c;
    }

    function validateWrite(stmt, schema, issues, type) {
      const hasSchema = schema.tables && Object.keys(schema.tables).length > 0;
      const tblArr = stmt.table || [];
      const tname = tableRefName(tblArr[0] && (tblArr[0].table || tblArr[0]));
      if (hasSchema && tname) checkTableExists(tname, schema, issues);
      if (type === 'update' && hasSchema && tname && stmt.set) {
        const tbl = schema.tables[tname.toLowerCase()];
        for (const s of stmt.set) {
          const cn = s && s.column != null ? colRefName(s.column) : (s && s.type === 'column_ref' ? colRefName(s.column) : null);
          if (cn && tbl && tbl.columns && !tbl.columns[cn.toLowerCase()]) {
            const sugg = didYouMean(cn, Object.values(tbl.columns).map((c) => c.name));
            issues.push(issue('error', 'UNKNOWN_COLUMN',
              'Unknown column "' + cn + '" in UPDATE' + (sugg.length ? ' — did you mean "' + sugg[0] + '"?' : '.'),
              'Check the column name.'));
          }
        }
      }
      const label = type.toUpperCase();
      if (stmt.where == null) {
        issues.push(issue('error', 'DESTRUCTIVE_NO_WHERE',
          label + ' without WHERE affects every row in the table.',
          'Add a WHERE clause — or run a SELECT with the same filter first to preview the blast radius.'));
      } else {
        issues.push(issue('warning', 'DESTRUCTIVE_WHERE',
          label + ' with WHERE will modify real data.',
          'Preview with SELECT … WHERE <same condition> before running. This tool never executes anything.'));
      }
    }

    function validateInsert(stmt, schema, issues) {
      const hasSchema = schema.tables && Object.keys(schema.tables).length > 0;
      if (!hasSchema) return;
      const tblArr = stmt.table || [];
      const tname = tableRefName(tblArr[0] && tblArr[0].table);
      if (!tname || !checkTableExists(tname, schema, issues)) return;
      const tbl = schema.tables[tname.toLowerCase()];
      for (const c of (stmt.columns || [])) {
        const cn = nameOf(c);
        if (cn && tbl.columns && !tbl.columns[cn.toLowerCase()]) {
          const sugg = didYouMean(cn, Object.values(tbl.columns).map((x) => x.name));
          issues.push(issue('error', 'UNKNOWN_COLUMN',
            'Unknown column "' + cn + '" in INSERT into "' + tname + '"' +
            (sugg.length ? ' — did you mean "' + sugg[0] + '"?' : '.'),
            sugg.length ? 'Fix the column name.' : 'Check the column name against your schema.'));
        }
      }
    }

    /* ============ explain ============ */
    const OP_WORDS = {
      '=': 'is', '>': 'is greater than', '<': 'is less than',
      '>=': 'is at least', '<=': 'is at most',
      '<>': 'is not', '!=': 'is not',
      'AND': 'and', 'OR': 'or', 'NOT': 'not',
      'LIKE': 'matches', 'NOT LIKE': 'does not match',
      'IN': 'is one of', 'NOT IN': 'is not one of',
      'IS': 'is', 'IS NOT': 'is not',
      'BETWEEN': 'is between'
    };

    function exprToWords(e) {
      if (!e || typeof e !== 'object') return '…';
      switch (e.type) {
        case 'column_ref': {
          const t = e.table != null ? tableRefName(e.table) : null;
          const c = colRefName(e.column);
          return c === '*' ? (t ? 'all columns of ' + t : 'all columns') : (t ? t + '.' + c : c);
        }
        case 'number': return String(e.value);
        case 'single_quote_string': return "'" + e.value + "'";
        case 'double_quote_string': return '"' + e.value + '"';
        case 'bool':
        case 'boolean': return String(e.value);
        case 'null': return 'NULL';
        case 'star': return 'all columns';
        case 'aggr_func': {
          const nm = String(e.name || '').toUpperCase();
          const args = e.args ? argToWords(e.args) : '';
          if (nm === 'COUNT' && /all columns|\*/.test(args)) return 'the number of rows';
          if (nm === 'COUNT') return 'the count of ' + args;
          if (nm === 'SUM') return 'the total of ' + args;
          if (nm === 'AVG') return 'the average of ' + args;
          if (nm === 'MIN') return 'the smallest ' + args;
          if (nm === 'MAX') return 'the largest ' + args;
          return nm.toLowerCase() + '(' + args + ')';
        }
        case 'binary_expr': {
          const op = String(e.operator || '').toUpperCase();
          const word = OP_WORDS[op] || OP_WORDS[e.operator] || op.toLowerCase();
          if (op === 'AND' || op === 'OR') return exprToWords(e.left) + ' ' + word + ' ' + exprToWords(e.right);
          if (op === 'NOT') return 'not (' + exprToWords(e.left || e.right) + ')';
          return exprToWords(e.left) + ' ' + word + ' ' + exprToWords(e.right);
        }
        case 'unary_expr':
          return (e.operator || '').toLowerCase() + ' ' + exprToWords(e.expr);
        case 'function': {
          const nm = nameOf(e.name) || 'function';
          return nm.toLowerCase() + '(…)';
        }
        default:
          if (e.value != null && typeof e.value !== 'object') return String(e.value);
          return 'an expression';
      }
    }
    function argToWords(args) {
      if (!args) return '';
      if (args.expr) return exprToWords(args.expr);
      if (Array.isArray(args.value)) return args.value.map(exprToWords).join(', ');
      if (args.value && typeof args.value === 'object') return exprToWords(args.value);
      return '';
    }

    function explainSelect(stmt) {
      const parts = [];
      const from = stmt.from || [];
      if (from.length) {
        const first = from[0];
        let s = 'Starts from the ' + (tableRefName(first.table) || 'table') +
          (first.as && String(first.as).toUpperCase() !== 'CROSS' ? ' (called "' + nameOf(first.as) + '")' : '');
        for (let i = 1; i < from.length; i++) {
          const f = from[i];
          s += ',' + (f.join ? '' : ' cross') + ' joined with the ' + (tableRefName(f.table) || 'table') +
            (f.as && String(f.as).toUpperCase() !== 'CROSS' ? ' (called "' + nameOf(f.as) + '")' : '');
          if (f.on) s += ' where ' + exprToWords(f.on);
          else if (f.using) s += ' using shared columns';
          else s += ' (no join condition — every row pairs with every row)';
        }
        parts.push(s + '.');
      }
      if (stmt.where) parts.push('Keeps only rows where ' + exprToWords(stmt.where) + '.');
      const gb = stmt.groupby && stmt.groupby.columns;
      if (gb && gb.length) {
        parts.push('Groups rows by ' + gb.map((g) => exprToWords(g.expr || g)).join(', ') + '.');
      }
      if (stmt.having) parts.push('Keeps only groups where ' + exprToWords(stmt.having) + '.');
      const cols = stmt.columns || [];
      if (cols.length === 1 && cols[0].expr && cols[0].expr.type === 'star') {
        parts.push('Returns all columns.');
      } else if (cols.length) {
        const descs = cols.map((c) => {
          const w = exprToWords(c.expr);
          return c.as ? w + ' (shown as "' + c.as + '")' : w;
        });
        parts.push('Returns ' + descs.join(', ') + '.');
      }
      if (stmt.orderby && stmt.orderby.length) {
        const o = stmt.orderby.map((x) =>
          exprToWords(x.expr) + (String(x.type).toUpperCase() === 'DESC' ? ' (highest first)' : ' (lowest first)')).join(', ');
        parts.push('Sorts by ' + o + '.');
      }
      const lim = stmt.limit && stmt.limit.value && stmt.limit.value.length ? stmt.limit.value : null;
      if (lim) {
        const v = lim;
        const n = Array.isArray(v) ? (v[0] && v[0].value != null ? v[0].value : '?') : (v && v.value != null ? v.value : '?');
        parts.push('Returns only the first ' + n + ' rows.');
      }
      return parts.join(' ');
    }

    function explain(sqlText, schema, dialect) {
      try {
        const parsed = tryParse(String(sqlText || '').trim(), dialect);
        const stmt = parsed.stmts[0];
        if (!stmt || !stmt.type) return 'Nothing to explain — no statement found.';
        const type = String(stmt.type).toLowerCase();
        if (type === 'select') return explainSelect(stmt) || 'A SELECT query.';
        if (type === 'delete') {
          const t = stmt.from && stmt.from[0] ? tableRefName(stmt.from[0].table) : 'the table';
          return stmt.where
            ? 'Deletes rows from ' + t + ' where ' + exprToWords(stmt.where) + '. Everything else is kept.'
            : 'Deletes EVERY row from ' + t + '. This empties the table.';
        }
        if (type === 'update') {
          const t = stmt.table && stmt.table[0] ? tableRefName(stmt.table[0].table || stmt.table[0]) : 'the table';
          const sets = (stmt.set || []).map((s) => {
            const cn = s.column != null ? colRefName(typeof s.column === 'object' ? s.column.column || s.column : s.column) : '?';
            return 'sets ' + cn + ' to ' + exprToWords(s.value);
          }).join(', ');
          return stmt.where
            ? 'Updates ' + t + ': ' + sets + ', for rows where ' + exprToWords(stmt.where) + '.'
            : 'Updates EVERY row in ' + t + ': ' + sets + '.';
        }
        if (type === 'drop') return 'Drops (deletes) the entire table — structure and data are gone.';
        if (type === 'truncate') return 'Removes every row from the table instantly. The structure stays, the data does not.';
        if (type === 'insert') return 'Inserts new rows into the table.';
        return 'A ' + type.toUpperCase() + ' statement.';
      } catch (e) {
        return 'Could not explain this statement — it did not parse.';
      }
    }

    function verdict(report) {
      if (!report || !report.issues) return 'unknown';
      if (report.issues.some((i) => i.severity === 'error')) return 'blocked';
      if (report.issues.some((i) => i.severity === 'warning')) return 'review';
      return 'safe';
    }

    return { parseSchema, validate, explain, verdict, isPiiColumn, typeCategory, didYouMean };
  }

  return { createValidator };
});
