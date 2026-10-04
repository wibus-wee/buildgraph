import { stringify } from 'yaml';

export const pins = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  node: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  go: 'actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e',
  app: 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
};
const expression = (text) => '${{ ' + text + ' }}';
const checkout = () => ({ uses: pins.checkout, with: { path: 'hub', 'persist-credentials': false } });
const repoPattern = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/;

/** Produces a starting YAML file for human review. No generated manifest is consumed at runtime. */
export function newWorkflow({
  project,
  source,
  stack = 'node',
  command,
  output,
  mode = 'artifact',
  destinations = '',
}) {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(project))
    throw new Error('项目 ID 请使用小写字母、数字、短横线或下划线，并以字母开头。');
  if (!repoPattern.test(source) || source.includes('${{'))
    throw new Error('源码仓库请填写 owner/repository。');
  if (!['node', 'go', 'custom'].includes(stack) || !['artifact', 'release', 'dispatch'].includes(mode))
    throw new Error('请选择有效的构建和分发方式。');
  if (!command?.trim() || !output?.trim()) throw new Error('请填写构建命令和输出目录。');
  if (!/^source\/[A-Za-z0-9_./-]+$/.test(output) || output.split('/').includes('..'))
    throw new Error('输出目录必须在 source/ 下，例如 source/dist。');
  const targets = [
    ...new Set(
      destinations
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  if (mode !== 'artifact' && (!targets.length || targets.some((x) => !repoPattern.test(x))))
    throw new Error('请填写至少一个 owner/repository 分发仓库，每行一个。');
  const file = `project-${project}.yml`;
  const buildSteps = [
    checkout(),
    {
      uses: pins.checkout,
      with: {
        repository: source,
        ref: expression('inputs.source_ref'),
        token: expression('secrets.SOURCE_READ_TOKEN'),
        path: 'source',
        'persist-credentials': false,
      },
    },
  ];
  if (stack === 'node') buildSteps.push({ uses: pins.node, with: { 'node-version': '24' } });
  if (stack === 'go')
    buildSteps.push({ uses: pins.go, with: { 'go-version-file': 'source/go.mod', cache: false } });
  buildSteps.push(
    { name: 'Build', 'working-directory': 'source', run: command },
    {
      uses: './hub/upload',
      id: 'upload',
      with: { path: output, key: expression('secrets.BUILDGRAPH_ARTIFACT_KEY') },
    },
  );
  const workflow = {
    name: project,
    'run-name': `${project} · ` + expression('inputs.request_id || github.run_id'),
    on: {
      workflow_dispatch: {
        inputs: {
          target: {
            description: mode === 'artifact' ? 'build' : 'build or deliver (publishes outputs)',
            type: 'choice',
            options: mode === 'artifact' ? ['build'] : ['build', 'deliver'],
            default: 'build',
          },
          source_ref: { description: 'Source branch, tag, or commit SHA', type: 'string', default: 'main' },
          request_id: {
            description: 'Optional correlation ID; not an authorization credential',
            type: 'string',
          },
        },
      },
    },
    permissions: { contents: 'read' },
    jobs: {
      plan: {
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 5,
        outputs: { selected: expression('steps.graph.outputs.selected') },
        steps: [
          checkout(),
          {
            uses: './hub/plan',
            id: 'graph',
            with: { workflow: `hub/.github/workflows/${file}`, target: expression('inputs.target') },
          },
        ],
      },
      build: {
        needs: 'plan',
        if: expression("contains(fromJSON(needs.plan.outputs.selected), 'build')"),
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 30,
        outputs: {
          artifact_id: expression('steps.upload.outputs.artifact-id'),
          artifact_digest: expression('steps.upload.outputs.artifact-digest'),
        },
        steps: buildSteps,
      },
    },
  };
  if (mode !== 'artifact') {
    const permissions =
      mode === 'release' ? { 'permission-contents': 'write' } : { 'permission-actions': 'write' };
    const steps = [
      checkout(),
      {
        uses: pins.app,
        id: 'destination',
        with: {
          'client-id': expression('vars.DISTRIBUTION_APP_CLIENT_ID'),
          'private-key': expression('secrets.DISTRIBUTION_APP_PRIVATE_KEY'),
          owner: expression('matrix.owner'),
          repositories: expression('matrix.name'),
          ...permissions,
        },
      },
    ];
    if (mode === 'release')
      steps.push(
        {
          uses: './hub/download',
          with: {
            'artifact-id': expression('needs.build.outputs.artifact_id'),
            path: 'release-output',
            key: expression('secrets.BUILDGRAPH_ARTIFACT_KEY'),
          },
        },
        {
          name: 'Publish release',
          env: {
            GH_TOKEN: expression('steps.destination.outputs.token'),
            DESTINATION: expression('matrix.repository'),
            RELEASE_TAG: `${project}-` + expression('github.run_id'),
            REQUEST_ID: expression('inputs.request_id'),
            BUILD_URL:
              'https://github.com/' +
              expression('github.repository') +
              '/actions/runs/' +
              expression('github.run_id'),
          },
          run: 'tar -czf "$RUNNER_TEMP/output.tar.gz" -C release-output .\ngh release create "$RELEASE_TAG" "$RUNNER_TEMP/output.tar.gz" --repo "$DESTINATION" --title "$RELEASE_TAG" --notes "Build: $BUILD_URL; request: $REQUEST_ID"',
        },
      );
    else
      steps.push({
        uses: './hub/dispatch',
        id: 'publish',
        with: {
          repository: expression('matrix.repository'),
          workflow: 'publish.yml',
          ref: 'main',
          token: expression('steps.destination.outputs.token'),
          wait: 'true',
          inputs:
            'source_run_id: ' +
            expression('toJSON(github.run_id)') +
            '\nartifact_id: ' +
            expression('toJSON(needs.build.outputs.artifact_id)') +
            '\nartifact_digest: ' +
            expression('toJSON(needs.build.outputs.artifact_digest)') +
            '\nrequest_id: ' +
            expression('toJSON(inputs.request_id || github.run_id)') +
            '\n',
        },
      });
    workflow.jobs.deliver = {
      needs: ['plan', 'build'],
      if: expression("contains(fromJSON(needs.plan.outputs.selected), 'deliver')"),
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 40,
      environment: 'production',
      strategy: {
        'fail-fast': false,
        matrix: {
          include: targets.map((repository) => ({
            repository,
            owner: repository.split('/')[0],
            name: repository.split('/')[1],
          })),
        },
      },
      concurrency: {
        group: `${project}-deliver-` + expression('matrix.repository'),
        'cancel-in-progress': false,
      },
      steps,
    };
  }
  return {
    filename: file,
    yaml:
      '# Review repository permissions, build commands, and output visibility before merging.\n' +
      stringify(workflow, { lineWidth: 0 }),
    secrets: [
      'SOURCE_READ_TOKEN',
      'BUILDGRAPH_ARTIFACT_KEY',
      ...(mode === 'artifact' ? [] : ['DISTRIBUTION_APP_PRIVATE_KEY']),
    ],
    variables: mode === 'artifact' ? [] : ['DISTRIBUTION_APP_CLIENT_ID'],
  };
}
