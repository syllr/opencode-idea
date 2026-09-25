// Local-development entrypoint.
//
// OpenCode V2 resolves a *directory* plugin by looking for `<dir>/server.*` or
// `<dir>/index.*` (it does not read `package.json#main` for local directories).
// Published consumers resolve the package by name through `main` (./src/index.js).
// This file lets the repository be loaded directly as a local plugin:
//
//   "plugins": [{ "package": "/path/to/opencode-jetbrains-mcp", "options": { ... } }]
//
// See README.md § "本地开发 / 真机验证".
export { default } from './src/index.js';
