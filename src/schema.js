const id = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,47}$' };
const secretName = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' };
const env = {
  type: 'object',
  propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
  additionalProperties: { type: 'string' },
};
const runner = { type: 'string', enum: ['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04', 'macos-latest', 'macos-15', 'macos-14', 'windows-latest', 'windows-2025', 'windows-2022'] };

export const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Buildgraph manifest v1',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'name', 'defaultTarget', 'nodes'],
  properties: {
    $schema: { type: 'string' },
    version: { const: 1 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    defaultTarget: id,
    defaults: {
      type: 'object', additionalProperties: false,
      properties: {
        runner, env, auth: id,
        timeoutMinutes: { type: 'integer', minimum: 1, maximum: 360 },
        artifactKeySecret: secretName,
      },
    },
    auth: {
      type: 'object', propertyNames: id,
      additionalProperties: {
        oneOf: [
          {
            type: 'object', additionalProperties: false,
            required: ['type', 'clientIdVariable', 'privateKeySecret'],
            properties: { type: { const: 'app' }, clientIdVariable: secretName, privateKeySecret: secretName },
          },
          {
            type: 'object', additionalProperties: false,
            required: ['type', 'tokenSecret'],
            properties: { type: { const: 'token' }, tokenSecret: secretName },
          },
        ],
      },
    },
    nodes: {
      type: 'object', minProperties: 1, maxProperties: 200, propertyNames: id,
      additionalProperties: {
        type: 'object', additionalProperties: false, required: ['steps'],
        properties: {
          needs: { type: 'array', uniqueItems: true, items: id },
          runner, env,
          timeoutMinutes: { type: 'integer', minimum: 1, maximum: 360 },
          environment: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,255}$' },
          concurrency: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' },
          permissions: {
            type: 'object',
            propertyNames: { enum: ['actions', 'artifact-metadata', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'id-token', 'issues', 'models', 'packages', 'pages', 'pull-requests', 'security-events', 'statuses'] },
            additionalProperties: { enum: ['read', 'write', 'none'] },
          },
          source: {
            type: 'object', additionalProperties: false, required: ['repository', 'ref'],
            properties: {
              repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
              ref: { type: 'string', minLength: 1, maxLength: 256 },
              auth: id,
              fetchDepth: { type: 'integer', minimum: 0 },
              submodules: { enum: [false, true, 'recursive'] },
              lfs: { type: 'boolean' },
            },
          },
          output: {
            type: 'object', additionalProperties: false,
            properties: {
              visibility: { enum: ['encrypted', 'public'] },
              retentionDays: { type: 'integer', minimum: 1, maximum: 90 },
            },
          },
          steps: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', additionalProperties: false,
              oneOf: [{ required: ['run'], not: { required: ['uses'] } }, { required: ['uses'], not: { required: ['run'] } }],
              properties: {
                name: { type: 'string' }, id,
                run: { type: 'string', minLength: 1 },
                uses: { type: 'string', minLength: 1 },
                shell: { type: 'string' },
                'working-directory': { type: 'string' },
                if: { type: ['string', 'boolean'] }, env,
                with: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
                'continue-on-error': { type: 'boolean' },
                'timeout-minutes': { type: 'integer', minimum: 1 },
              },
            },
          },
        },
      },
    },
  },
};
