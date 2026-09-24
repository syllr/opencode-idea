import { describe, expect, it } from 'vitest';
import { parseIdeaSdk } from './project-sdk.js';

const PYTHON_IML = `<module type="WEB_MODULE" version="4">
  <component name="NewModuleRootManager">
    <content url="file://$MODULE_DIR$" />
    <orderEntry type="jdk" jdkName="~/proj/.venv" jdkType="Python SDK" />
    <orderEntry type="sourceFolder" forTests="false" />
  </component>
</module>`;

describe('parseIdeaSdk', () => {
  it('maps a path-like Python SDK to VIRTUAL_ENV + PATH', () => {
    const result = parseIdeaSdk({ imls: [PYTHON_IML], projectPath: '/proj', home: '/home/u' });
    expect(result.env.VIRTUAL_ENV).toBe('/home/u/proj/.venv');
    expect(result.prependPath).toContain('/home/u/proj/.venv/bin');
  });

  it('expands $PROJECT_DIR$ and maps a Java SDK to JAVA_HOME', () => {
    const iml = '<orderEntry type="jdk" jdkName="$PROJECT_DIR$/jbr" jdkType="JavaSDK" />';
    const result = parseIdeaSdk({ imls: [iml], projectPath: '/p', home: '/h' });
    expect(result.env.JAVA_HOME).toBe('/p/jbr');
    expect(result.prependPath).toContain('/p/jbr/bin');
  });

  it('maps a Go SDK to GOROOT', () => {
    const iml = '<orderEntry type="jdk" jdkName="/usr/local/go" jdkType="Go SDK" />';
    const result = parseIdeaSdk({ imls: [iml], projectPath: '/p', home: '/h' });
    expect(result.env.GOROOT).toBe('/usr/local/go');
  });

  it('reads the project SDK from misc.xml', () => {
    const misc = '<component name="ProjectRootManager" project-jdk-name="/jdk/17" project-jdk-type="JavaSDK" />';
    const result = parseIdeaSdk({ misc, projectPath: '/p', home: '/h' });
    expect(result.env.JAVA_HOME).toBe('/jdk/17');
  });

  it('skips symbolic names that cannot be resolved', () => {
    const iml = '<orderEntry type="jdk" jdkName="17" jdkType="JavaSDK" />';
    const result = parseIdeaSdk({ imls: [iml], projectPath: '/p', home: '/nonexistent-home-xyz' });
    expect(result.env.JAVA_HOME).toBeUndefined();
  });

  it('returns empty for no SDK entries', () => {
    expect(parseIdeaSdk({ imls: ['<module />'], misc: '' })).toEqual({ env: {}, prependPath: [] });
  });
});
