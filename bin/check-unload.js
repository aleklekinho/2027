#!/usr/bin/env node
import { lstat, readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scan, supportedExtensions } from '../src/scan.js';

const help = `Usage: check-unload [--json] [path ...]

Scan .html, .htm, .js, .mjs and .cjs files for legacy unload handlers.
Defaults to the current directory. Skips .git, node_modules and symbolic links
when walking directories.

Exit status: 0 clean, 1 findings, 2 input or scan errors.`;
const messages = {
  'unload-listener': 'Legacy unload event listener',
  'unload-assignment': 'Legacy onunload assignment',
  'unload-attribute': 'Legacy inline onunload handler',
};

async function run() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' } },
  });
  if (values.help) {
    console.log(help);
    return 0;
  }

  const paths = positionals.length ? positionals : ['.'];
  const findings = [];
  const errors = [];
  const seen = new Set();
  let filesScanned = 0;

  async function visit(path, entry) {
    const file = relative(process.cwd(), path) || '.';
    try {
      const info = entry ?? await lstat(path);
      if (info.isDirectory()) {
        const children = await readdir(path, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (child.isSymbolicLink() || child.name === '.git' || child.name === 'node_modules') continue;
          await visit(join(path, child.name), child);
        }
        return;
      }

      const extension = extname(path).toLowerCase();
      if (!info.isFile() || !supportedExtensions.has(extension)) {
        if (!entry) errors.push({ file, message: 'Expected a directory or a supported source file' });
        return;
      }
      if (seen.has(path)) return;
      seen.add(path);

      const result = await scan(await readFile(path, 'utf8'), extension);
      filesScanned++;
      result.findings.sort((a, b) => a.line - b.line || a.column - b.column);
      for (const finding of result.findings) {
        findings.push({ file, ...finding, message: messages[finding.kind] });
      }
      for (const error of result.errors) errors.push({ file, ...error });
    } catch (error) {
      errors.push({ file, message: error.message });
    }
  }

  for (const path of paths) await visit(resolve(path));

  if (values.json) {
    console.log(JSON.stringify({ filesScanned, findings, errors }, null, 2));
  } else {
    for (const finding of findings) {
      console.log(`${finding.file}:${finding.line}:${finding.column}: ${finding.message}`);
    }
    for (const error of errors) {
      const location = error.line ? `:${error.line}:${error.column}` : '';
      console.error(`${error.file}${location}: ${error.message}`);
    }
    console.log(`Scanned ${filesScanned} file(s). ${findings.length} finding(s), ${errors.length} error(s).`);
  }

  if (errors.length) return 2;
  return findings.length ? 1 : 0;
}

try {
  process.exitCode = await run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
