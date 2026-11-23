import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';

test('locates legacy body attributes and executable inline scripts in an HTML file', async () => {
  const html = [
    '<!doctype html>',
    '<body ONUNLOAD="cleanup()">',
    '  <script>window.addEventListener("unload", cleanup);</script>',
    '  <script type="module">',
    '    self["onunload"] = cleanup;',
    '  </script>',
    '  <script type="application/json">{"onunload":"cleanup"}</script>',
    '  <script src="app.js">{unused script body}</script>',
    '  <!-- <body onunload="ignored()"> -->',
  ].join('\r\n');

  const { findings, errors } = await scan(html, '.html');
  assert.deepEqual(errors, []);
  assert.deepEqual(findings.sort((a, b) => a.line - b.line), [
    { line: 2, column: 7, kind: 'unload-attribute' },
    { line: 3, column: 11, kind: 'unload-listener' },
    { line: 5, column: 5, kind: 'unload-assignment' },
  ]);
});

test('finds a legacy attribute on a body tag following an implicit body', async () => {
  const result = await scan('<div>Toolbar</div>\n<body onunload="cleanup()">', '.htm');
  assert.deepEqual(result, {
    findings: [{ line: 2, column: 7, kind: 'unload-attribute' }],
    errors: [],
  });
});

test('checks direct assignments and iframe listeners without matching comments or unrelated events', async () => {
  const script = [
    '// window.onunload = cleanup;',
    'const example = "addEventListener(\'unload\', cleanup)";',
    'const unrelated = { onunload: cleanup };',
    'window.addEventListener("beforeunload", cleanup);',
    'socket.addEventListener("unload", cleanup);',
    'onunload = cleanup;',
    'iframe.contentWindow?.addEventListener(`unload`, cleanup);',
  ].join('\n');

  assert.deepEqual(await scan(script, '.js'), {
    findings: [
      { line: 6, column: 1, kind: 'unload-assignment' },
      { line: 7, column: 1, kind: 'unload-listener' },
    ],
    errors: [],
  });
  assert.deepEqual((await scan('return;\nwindow.onunload = cleanup;', '.cjs')).errors, []);
});

test('reports embedded JavaScript errors at the HTML location', async () => {
  const result = await scan('<script>const value = ;</script>', '.htm');
  assert.deepEqual(result.errors, [{ line: 1, column: 23, message: 'Unexpected token' }]);
});

test('CLI outputs JSON, skips dependencies, and distinguishes findings from incomplete scans', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'check-unload-'));
  const dependencies = join(fixture, 'node_modules');
  const ignored = join(dependencies, 'ignored.js');
  const clean = join(fixture, 'clean.js');
  const legacy = join(fixture, 'legacy.js');
  t.after(async () => {
    await Promise.all([ignored, clean, legacy].map((file) => rm(file, { force: true })));
    await rmdir(dependencies);
    await rmdir(fixture);
  });
  await mkdir(dependencies);
  await writeFile(ignored, '{ invalid');
  await writeFile(clean, 'window.addEventListener("pagehide", cleanup);');
  await writeFile(legacy, 'window.onunload = cleanup;');

  const cli = fileURLToPath(new URL('../bin/check-unload.js', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, '--json', ...args], {
    cwd: fixture,
    encoding: 'utf8',
  });

  assert.equal(run('clean.js').status, 0);
  const result = run('.', 'legacy.js');
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.filesScanned, 2);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].file, 'legacy.js');
  assert.deepEqual(report.errors, []);

  const incomplete = run('missing.js', 'legacy.js');
  assert.equal(incomplete.status, 2);
  assert.equal(JSON.parse(incomplete.stdout).findings.length, 1);
  assert.equal(JSON.parse(incomplete.stdout).errors[0].file, 'missing.js');
});
