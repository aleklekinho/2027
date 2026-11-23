# check-unload

Find browser `unload` handlers that may stop running in Chrome. The CLI scans local HTML and JavaScript files and reports each match with its file, line, and column. Chrome 155 completed the rollout that disables `unload` by default. [Chrome for Developers](https://developer.chrome.com/blog/unload-deprecated-in-chrome)

## Run locally

Requires Node.js 22 or later and npm.

```sh
git clone https://github.com/aleklekinho/2027.git
cd 2027
npm ci
node bin/check-unload.js ./path/to/your/site
```

Pass files, directories, or both. Omit paths to scan the current directory. Use `--json` for machine-readable findings and errors.

```text
public/index.html:12:7: Legacy inline onunload handler
public/app.js:23:1: Legacy unload event listener
Scanned 2 file(s). 2 finding(s), 0 error(s).
```

| Exit status | Meaning |
| --- | --- |
| `0` | Scan completed with no findings. |
| `1` | Scan completed with at least one finding. |
| `2` | An input, read, or syntax error prevented a complete scan. |

## Detection scope

- HTML and HTM files are checked for `onunload` attributes on `body` and `frameset`, plus handlers in inline classic and module scripts.
- JavaScript, MJS, and CJS files are checked for `onunload` assignments and `addEventListener('unload', ...)` calls on common browser globals and iframe `contentWindow` properties. To check a script loaded via `src`, pass the local source file or its parent directory.
- The scanner recognizes literal event names and browser receivers syntactically. It does not resolve aliases, variable scope, custom wrappers, or dynamically computed event names. It does not parse TypeScript or JSX. Directory scans skip `.git`, `node_modules`, and symbolic links.

Choose replacements based on what the handler does. Use `visibilitychange` to persist state when the document becomes hidden, or evaluate `pagehide` for navigation-related cleanup. When cleanup runs on `pagehide`, test restoration from the back/forward cache. The CLI reports locations for review and leaves files untouched. [Chrome migration guidance](https://developer.chrome.com/docs/web-platform/deprecating-unload)

## Development

Run `npm ci` and `npm test`.

The tool found one inline `onunload` handler in each of the 11 Commander HTML files from MeshCentral 1.3.1, including the original case described in [MeshCentral #8335](https://github.com/Ylianst/MeshCentral/issues/8335). To reproduce the main example from this checkout, run:

```sh
git clone --depth 1 --branch 1.3.1 https://github.com/Ylianst/MeshCentral.git ../meshcentral-1.3.1
node bin/check-unload.js ../meshcentral-1.3.1/public/commander.htm
```

Licensed under the [MIT License](LICENSE).
