#!/usr/bin/env node
// Release script for opencode-idea.
//
// Usage:
//   node scripts/release.mjs            # bump patch (0.0.1 -> 0.0.2), then publish
//   node scripts/release.mjs --bump     # bump patch version only, do not publish
//   node scripts/release.mjs --dry-run  # bump + test + npm publish --dry-run
//   node scripts/release.mjs --check    # verify local version / npm dist-tags, no changes
//
// Rules (see AGENTS.md):
//   * package name is fixed: opencode-idea
//   * only the smallest version position (patch) is bumped
//   * minor / major bumps are refused here; do them manually with user approval
//   * a version already published on npm is never reused or overwritten
//   * package.json, package-lock.json and src/mcp/idea.js clientInfo.version
//     are kept in sync
//   * a real publish starts from a clean working tree; the bump below dirties
//     the tree on purpose, so the cleanliness check runs before the bump

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'opencode-idea';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = new Set(process.argv.slice(2));
const bumpOnly = args.has('--bump');
const dryRun = args.has('--dry-run');
const checkOnly = args.has('--check');

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
}

function npmView(...spec) {
  try {
    return execFileSync('npm', ['view', ...spec, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`unsupported version format: ${version}`);
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function publishedVersions() {
  const raw = npmView(PACKAGE_NAME, 'versions');
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function latestTag() {
  const raw = npmView(PACKAGE_NAME, 'dist-tags');
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return entry?.latest;
}

/**
 * npm answers a publish with `202`: the tarball is accepted but processed
 * asynchronously, so `latest` can lag behind by minutes. Polling turns that
 * lag into a wait instead of a false "publish failed".
 *
 * @param {string} expected
 * @param {number} attempts total number of `latest` reads
 * @param {number} delayMs pause between reads
 */
async function waitForLatest(expected, attempts = 12, delayMs = 15_000) {
  let tag = latestTag();
  for (let attempt = 1; attempt < attempts && tag !== expected; attempt += 1) {
    console.log(
      `[release] npm latest is ${tag ?? '(unknown)'}, waiting for ${expected} (${attempt}/${attempts - 1})`,
    );
    await sleep(delayMs);
    tag = latestTag();
  }
  return tag;
}

function syncFiles(previousVersion, nextVersion) {
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');

  packageJson.version = nextVersion;
  packageLock.version = nextVersion;
  if (packageLock.packages?.['']) packageLock.packages[''].version = nextVersion;

  writeFileSync(resolve(ROOT, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(resolve(ROOT, 'package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`);

  // MCP clientInfo.version must match the package version.
  const ideaMcpPath = resolve(ROOT, 'src/mcp/idea.js');
  const ideaMcp = readFileSync(ideaMcpPath, 'utf8');
  const updatedIdeaMcp = ideaMcp
    .split(`version: '${previousVersion}'`)
    .join(`version: '${nextVersion}'`);
  if (updatedIdeaMcp === ideaMcp) {
    throw new Error("src/mcp/idea.js: clientInfo version not found; expected two occurrences");
  }
  writeFileSync(ideaMcpPath, updatedIdeaMcp);

}

function assertCleanGit() {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (status) {
    console.error('\n[release] working tree is not clean. Commit or stash first:\n');
    console.error(status);
    process.exit(1);
  }
}

async function main() {
  const currentVersion = readJson('package.json').version;
  const published = publishedVersions();

  if (checkOnly) {
    console.log(`[release] package:  ${PACKAGE_NAME}`);
    console.log(`[release] local:    ${currentVersion}`);
    console.log(`[release] npm latest: ${latestTag() ?? '(none)'}`);
    console.log(`[release] npm versions: ${published.length ? published.join(', ') : '(none)'}`);
    return;
  }

  // A real publish must start from a clean tree. The version bump below dirties
  // the tree on purpose, so this check has to run before it, never after.
  if (!bumpOnly && !dryRun) assertCleanGit();

  // npm versions are immutable: always move to the next free patch. Published
  // versions are skipped so a half-finished local state can never overwrite one.
  let nextVersion = bumpPatch(currentVersion);
  while (published.includes(nextVersion)) nextVersion = bumpPatch(nextVersion);
  console.log(
    `[release] ${PACKAGE_NAME}: ${currentVersion} -> ${nextVersion}` +
      (published.includes(currentVersion) ? ' (current already on npm)' : ''),
  );

  syncFiles(currentVersion, nextVersion);

  if (bumpOnly) {
    console.log('[release] bumped files only. Publish later with: npm publish');
    return;
  }

  console.log('[release] running npm test');
  run('npm', ['test']);

  if (dryRun) {
    console.log('[release] running npm publish --dry-run');
    run('npm', ['publish', '--dry-run']);
    console.log(`[release] dry-run complete. Files are bumped to ${nextVersion}.`);
    return;
  }

  console.log('[release] running npm publish');
  run('npm', ['publish']);

  console.log('[release] verifying dist-tags (npm processed the publish asynchronously)');
  const tag = await waitForLatest(nextVersion);
  console.log(`[release] npm latest: ${tag ?? '(unknown)'}`);
  if (tag !== nextVersion) {
    console.error(
      `\n[release] latest is ${tag ?? 'unknown'}, expected ${nextVersion}.\n` +
        '[release] the publish was accepted; if latest updates later, nothing left to do.\n',
    );
    process.exit(1);
  }
  console.log(`[release] published ${PACKAGE_NAME}@${nextVersion}`);
}

await main();
