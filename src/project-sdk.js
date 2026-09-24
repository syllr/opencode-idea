// Reads the project SDK configuration from the JetBrains `.idea` directory and
// turns it into environment variables (JAVA_HOME, VIRTUAL_ENV, GOROOT, ...).
//
// Sources:
//   * `.idea/*.iml`      -> <orderEntry type="jdk" jdkName="..." jdkType="..."/>
//   * `.idea/misc.xml`   -> <component name="ProjectRootManager" project-jdk-name=... project-jdk-type=.../>

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Read and map the project SDK env from `.idea`. Never throws.
 *
 * @param {string} projectPath
 * @param {{ home?: string }} [options]
 * @returns {{ env: Record<string, string>, prependPath: string[] }}
 */
export function readProjectSdk(projectPath, options = {}) {
  const ideaDir = path.join(projectPath, '.idea');
  if (!existsSync(ideaDir)) return { env: {}, prependPath: [] };

  const imls = [];
  try {
    for (const file of readdirSync(ideaDir)) {
      if (file.endsWith('.iml')) imls.push(readFileSync(path.join(ideaDir, file), 'utf8'));
    }
  } catch {
    // ignore unreadable module files
  }
  const misc = readText(path.join(ideaDir, 'misc.xml'));
  return parseIdeaSdk({
    imls,
    misc,
    projectPath,
    home: options.home ?? process.env.HOME,
  });
}

/**
 * Pure parser: `.idea` XML text -> env vars.
 *
 * @param {{ imls?: string[], misc?: string, projectPath?: string, home?: string }} input
 * @returns {{ env: Record<string, string>, prependPath: string[] }}
 */
export function parseIdeaSdk({ imls = [], misc = '', projectPath = '', home } = {}) {
  const sdks = [];
  for (const iml of imls) {
    for (const match of iml.matchAll(/<orderEntry\b[^>]*>/g)) {
      const tag = match[0];
      if (!/\btype="jdk"/.test(tag)) continue;
      const name = attr(tag, 'jdkName');
      if (name) sdks.push({ name, type: attr(tag, 'jdkType') });
    }
  }
  const projectName = attr(misc, 'project-jdk-name');
  if (projectName) sdks.push({ name: projectName, type: attr(misc, 'project-jdk-type') });

  const env = {};
  const prependPath = [];
  for (const sdk of sdks) {
    const resolved = resolveSdkPath(sdk.name, { projectPath, home });
    if (!resolved) continue;
    const type = (sdk.type ?? '').toLowerCase();
    if (type.includes('python') || type.includes('virtualenv')) {
      env.VIRTUAL_ENV = resolved;
      prependPath.push(path.join(resolved, 'bin'));
    } else if (type.includes('java') || type.includes('jdk')) {
      env.JAVA_HOME = resolved;
      prependPath.push(path.join(resolved, 'bin'));
    } else if (type.includes('go')) {
      env.GOROOT = resolved;
      prependPath.push(path.join(resolved, 'bin'));
    } else if (type.includes('node')) {
      prependPath.push(path.join(resolved, 'bin'));
    }
  }
  return { env, prependPath: [...new Set(prependPath)] };
}

function attr(text, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(text);
  return match ? match[1] : undefined;
}

function resolveSdkPath(name, { projectPath, home }) {
  if (!name) return undefined;
  let value = name;
  if (projectPath) value = value.replaceAll('$PROJECT_DIR$', projectPath);
  if (home) value = value.replace(/^~(?=\/|$)/, home);
  if (path.isAbsolute(value)) return value;

  // Symbolic SDK name (e.g. a Java SDK called "17"): try common registries.
  const candidates = [
    home ? path.join(home, '.sdkman/candidates/java', name) : undefined,
    home ? path.join(home, '.jdks', name) : undefined,
    `/Library/Java/JavaVirtualMachines/${name}/Contents/Home`,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
