import { stringify } from 'yaml';
import { digest, order, validate } from './graph.js';
import { actions } from './actions.js';

const expr = value => '${{ ' + value + ' }}';
const workspace = expr('github.workspace');
const secret = name => expr(`secrets.${name}`);
const visibility = node => node.output?.visibility ?? 'encrypted';

/** Generates a dispatch-only native DAG. Commit the result before dispatching; runtime jobs cannot add needs edges. */
export function compile(manifest, { manifestPath = 'buildgraph.json', actionRef = './hub' } = {}) {
  validate(manifest);
  if (!/^[A-Za-z0-9_./-]+\.json$/.test(manifestPath) || manifestPath.startsWith('/') || manifestPath.split('/').includes('..')) throw new Error('manifestPath must be a relative JSON path inside the hub');
  if (actionRef !== './hub' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(actionRef)) throw new Error('actionRef must be ./hub or owner/repository@<40-character commit SHA>');
  const defaults = manifest.defaults ?? {};
  const key = secret(defaults.artifactKeySecret ?? 'BUILDGRAPH_ARTIFACT_KEY');
  const hash = digest(manifest);
  const checkoutHub = () => ({ name: 'Checkout build hub', uses: actions.checkout, with: { path: 'hub', 'persist-credentials': false } });
  const useTool = (name, operation, inputs = {}) => ({ name, uses: actionRef, with: { operation, ...inputs } });
  const artifactContext = id => `${expr('github.run_id')}:${hash}:${id}`;
  const jobs = {
    plan: {
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 5,
      outputs: { selected: expr('steps.bg_plan.outputs.selected'), refs: expr('steps.bg_plan.outputs.refs') },
      steps: [checkoutHub(), {
        ...useTool('Validate and select dependency closure', 'plan', {
          manifest: `hub/${manifestPath}`, target: expr('inputs.target'), refs: expr('inputs.refs'), 'expected-digest': hash,
        }),
        id: 'bg_plan',
      }],
    },
  };
  for (const id of order(manifest)) {
    const node = manifest.nodes[id];
    const steps = [checkoutHub()];
    if (node.source) {
      const profile = manifest.auth?.[node.source.auth ?? defaults.auth];
      let token = expr('github.token');
      if (profile?.type === 'app') {
        const [owner, repo] = node.source.repository.split('/');
        steps.push({
          name: 'Create source-only installation token', id: 'bg_source_token', uses: actions.appToken,
          with: { 'client-id': expr(`vars.${profile.clientIdVariable}`), 'private-key': secret(profile.privateKeySecret), owner, repositories: repo, 'permission-contents': 'read' },
        });
        token = expr('steps.bg_source_token.outputs.token');
      } else if (profile?.type === 'token') token = secret(profile.tokenSecret);
      steps.push({
        name: 'Checkout source', uses: actions.checkout,
        with: {
          repository: node.source.repository, ref: expr(`fromJSON(needs.plan.outputs.refs).${id}`), path: 'source', token,
          'persist-credentials': false, 'fetch-depth': node.source.fetchDepth ?? 1,
          submodules: node.source.submodules ?? false, lfs: node.source.lfs ?? false,
        },
      });
    }
    steps.push(useTool('Prepare node workspace', 'prepare', { directory: `${workspace}/output`, 'inputs-directory': `${workspace}/inputs`, node: id, 'source-directory': node.source ? `${workspace}/source` : `${workspace}/hub` }));
    for (const dep of node.needs ?? []) {
      if (!manifest.nodes[dep].output) continue;
      const mode = visibility(manifest.nodes[dep]);
      const transfer = `${workspace}/.buildgraph-transfer/${dep}`;
      steps.push({
        name: `Download ${dep}`, uses: actions.download,
        with: { 'artifact-ids': expr(`needs.${dep}.outputs.artifact_id`), path: transfer, 'digest-mismatch': 'error' },
      });
      steps.push(useTool(`Restore ${dep}`, 'unpack', {
        archive: `${transfer}/output.${mode === 'encrypted' ? 'bgenc' : 'tar.gz'}`,
        directory: `${workspace}/inputs/${dep}`, visibility: mode, context: artifactContext(dep),
        ...(mode === 'encrypted' ? { key } : {}),
      }));
    }
    steps.push(...node.steps);
    if (node.output) {
      const mode = visibility(node);
      steps.push({
        ...useTool('Package node output', 'pack', {
          directory: `${workspace}/output`, visibility: mode, context: artifactContext(id),
          ...(mode === 'encrypted' ? { key } : {}),
        }), id: 'bg_pack',
      });
      steps.push({
        name: `Upload ${mode} output`, id: 'bg_upload', uses: actions.upload,
        with: {
          name: `bg-${expr('github.run_id')}-${expr('github.run_attempt')}-${id}`,
          path: expr('steps.bg_pack.outputs.archive'), 'if-no-files-found': 'error',
          'retention-days': node.output.retentionDays ?? 7, 'compression-level': 0,
        },
      });
    }
    jobs[id] = {
      name: id, needs: ['plan', ...(node.needs ?? [])],
      if: expr(`!inputs.plan_only && contains(fromJSON(needs.plan.outputs.selected), '${id}')`),
      'runs-on': node.runner ?? defaults.runner ?? 'ubuntu-latest',
      'timeout-minutes': node.timeoutMinutes ?? defaults.timeoutMinutes ?? 30,
      permissions: { contents: 'read', ...node.permissions },
      ...(node.environment ? { environment: node.environment } : {}),
      ...(node.concurrency ? { concurrency: { group: node.concurrency, 'cancel-in-progress': false } } : {}),
      defaults: { run: { shell: 'bash', 'working-directory': node.source ? 'source' : 'hub' } },
      env: {
        ...defaults.env, ...node.env,
        BUILDGRAPH_NODE: id, BUILDGRAPH_INPUTS: `${workspace}/inputs`,
        BUILDGRAPH_OUTPUT: `${workspace}/output`, BUILDGRAPH_HUB: `${workspace}/hub`,
      },
      ...(node.output ? { outputs: { artifact_id: expr('steps.bg_upload.outputs.artifact-id') } } : {}),
      steps,
    };
  }
  const workflow = {
    name: manifest.name,
    'run-name': `${manifest.name}: ${expr('inputs.target')}`,
    on: { workflow_dispatch: { inputs: {
      target: { description: 'Target node IDs, separated by commas; prerequisites are included', required: true, type: 'string', default: manifest.defaultTarget },
      refs: { description: 'Optional JSON map of source node IDs to Git refs or commit SHAs', required: false, type: 'string', default: '{}' },
      plan_only: { description: 'Validate and show the selected graph without building', required: false, type: 'boolean', default: false },
    } } },
    permissions: { contents: 'read' },
    jobs,
  };
  return `# Generated by Buildgraph from ${manifestPath}. Edit the manifest and regenerate.\n# Manifest SHA-256: ${hash}\n` + stringify(workflow, { lineWidth: 0, aliasDuplicateObjects: false });
}
