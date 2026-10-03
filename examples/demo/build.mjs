import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

const node = process.argv[2];
const output = process.env.BUILDGRAPH_OUTPUT;
const inputs = process.env.BUILDGRAPH_INPUTS;
if (!output || !inputs) throw new Error('Run through Buildgraph or set BUILDGRAPH_OUTPUT and BUILDGRAPH_INPUTS');
await mkdir(output, { recursive: true });
if (node === 'core') {
  await writeFile(join(output, 'core.json'), JSON.stringify({ greeting: 'Built from a shared dependency', flavor: process.env.BUILD_FLAVOR }));
} else if (node === 'web' || node === 'cli') {
  const core = JSON.parse(await readFile(join(inputs, 'core', 'core.json'), 'utf8'));
  if (node === 'web') await writeFile(join(output, 'index.html'), `<!doctype html><title>Buildgraph</title><h1>${core.greeting}</h1>\n`);
  else {
    const executable = join(output, 'hello.mjs');
    await writeFile(executable, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(core.greeting)});\n`);
    await chmod(executable, 0o755);
  }
} else if (node === 'bundle') {
  for (const [dependency, file] of [['web', 'index.html'], ['cli', 'hello.mjs']]) {
    await writeFile(join(output, file), await readFile(join(inputs, dependency, file)));
  }
  await chmod(join(output, 'hello.mjs'), 0o755);
  await writeFile(join(output, 'README.txt'), 'The web and CLI outputs were built in parallel from the same core artifact.\n');
} else if (node === 'independent') await writeFile(join(output, 'independent.txt'), 'This target is not a dependency of bundle.\n');
else throw new Error(`Unknown demo node: ${node}`);
