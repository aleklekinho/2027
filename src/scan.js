import { finished } from 'node:stream/promises';
import { parse as parseJavaScript } from 'acorn';
import { simple as walkJavaScript } from 'acorn-walk';
import { SAXParser } from 'parse5-sax-parser';

const browserGlobals = new Set(['window', 'self', 'globalThis', 'document', 'top', 'parent']);
// JavaScript MIME type essences from the HTML standard.
const javaScriptTypes = /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:javascript1\.[0-5]|jscript|livescript))$/;

function staticString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
}

function propertyName(node) {
  return node.computed ? staticString(node.property) : node.property.name;
}

function isBrowserReceiver(node) {
  if (node.type === 'Identifier') return browserGlobals.has(node.name);
  if (node.type !== 'MemberExpression') return false;
  if (propertyName(node) === 'contentWindow') return true;
  return node.computed && node.object.type === 'Identifier' && node.object.name === 'frames';
}

function isUnloadAssignment(node) {
  if (node.type === 'Identifier') return node.name === 'onunload';
  return node.type === 'MemberExpression' && propertyName(node) === 'onunload'
    && isBrowserReceiver(node.object);
}

function isUnloadRegistration(node) {
  if (staticString(node.arguments[0]) !== 'unload') return false;
  const { callee } = node;
  if (callee.type === 'Identifier') return callee.name === 'addEventListener';
  return callee.type === 'MemberExpression' && propertyName(callee) === 'addEventListener'
    && isBrowserReceiver(callee.object);
}

function scanJavaScript(source, types, start = { line: 1, column: 1 }) {
  const settings = { ecmaVersion: 'latest', locations: true, allowHashBang: true };
  const findings = [];
  const errors = [];
  const locate = ({ line, column }) => ({
    line: start.line + line - 1,
    column: column + (line === 1 ? start.column : 1),
  });

  let ast;
  let parseError;
  for (const sourceType of types) {
    try {
      ast = parseJavaScript(source, { ...settings, sourceType });
      break;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      parseError ??= error;
    }
  }

  if (!ast) {
    const message = parseError.message.replace(/ \(\d+:\d+\)$/, '');
    errors.push({ ...locate(parseError.loc), message });
    return { findings, errors };
  }

  walkJavaScript(ast, {
    AssignmentExpression(node) {
      if (isUnloadAssignment(node.left)) {
        findings.push({ ...locate(node.loc.start), kind: 'unload-assignment' });
      }
    },
    CallExpression(node) {
      if (isUnloadRegistration(node)) {
        findings.push({ ...locate(node.loc.start), kind: 'unload-listener' });
      }
    },
  });
  return { findings, errors };
}

function inlineScriptType(attrs) {
  if (attrs.some(({ name }) => name === 'src')) return;
  const type = attrs.find(({ name }) => name === 'type')?.value.trim().toLowerCase() ?? '';
  if (type === 'module') return 'module';
  if (!type || javaScriptTypes.test(type.split(';', 1)[0].trim())) return 'script';
}

async function scanHtml(source) {
  const findings = [];
  const errors = [];
  const parser = new SAXParser({ sourceCodeLocationInfo: true });
  let script;

  function finishScript(endOffset) {
    if (!script) return;
    const { location, sourceType } = script;
    const result = scanJavaScript(source.slice(location.endOffset, endOffset), [sourceType], {
      line: location.endLine,
      column: location.endCol,
    });
    findings.push(...result.findings);
    errors.push(...result.errors);
    script = undefined;
  }

  parser.on('startTag', ({ tagName, attrs, sourceCodeLocation: location }) => {
    const attribute = location?.attrs?.onunload;
    if (attribute && (tagName === 'body' || tagName === 'frameset')) {
      findings.push({ line: attribute.startLine, column: attribute.startCol, kind: 'unload-attribute' });
    }
    if (tagName === 'script' && location) {
      const sourceType = inlineScriptType(attrs);
      if (sourceType) script = { location, sourceType };
    }
  });
  parser.on('endTag', ({ tagName, sourceCodeLocation }) => {
    if (tagName === 'script') finishScript(sourceCodeLocation?.startOffset);
  });

  const completion = finished(parser);
  parser.resume();
  parser.end(source);
  await completion;
  finishScript(source.length);
  return { findings, errors };
}

export const supportedExtensions = new Set(['.html', '.htm', '.js', '.mjs', '.cjs']);

export async function scan(source, extension) {
  if (extension === '.html' || extension === '.htm') return scanHtml(source);
  if (extension === '.mjs') return scanJavaScript(source, ['module']);
  if (extension === '.cjs') return scanJavaScript(source, ['commonjs']);
  return scanJavaScript(source, ['module', 'script']);
}
