import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import { schema } from './schema.js';

const validateSchema = new Ajv({ allErrors: true, strictRequired: false, allowUnionTypes: true }).compile(schema);
const has = (object, key) => Object.hasOwn(object, key);

export function digest(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export async function readManifest(file) {
  return validate(JSON.parse(await readFile(file, 'utf8')));
}

/** Validates the whole graph, including unreachable nodes; returns the input without mutation. */
export function validate(manifest) {
  if (!validateSchema(manifest)) {
    throw new Error(`Invalid manifest: ${validateSchema.errors.map(e => `${e.instancePath || '/'} ${e.message}${e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`).join('; ')}`);
  }
  const { nodes, defaults = {}, auth = {} } = manifest;
  if (!has(nodes, manifest.defaultTarget)) throw new Error(`Unknown defaultTarget: ${manifest.defaultTarget}`);
  if (defaults.auth && !has(auth, defaults.auth)) throw new Error(`Unknown default auth profile: ${defaults.auth}`);
  for (const [name, node] of Object.entries(nodes)) {
    if (name === 'plan' || name.startsWith('bg_')) throw new Error(`Reserved node name: ${name}`);
    for (const dep of node.needs ?? []) {
      if (!has(nodes, dep)) throw new Error(`${name}: unknown dependency ${dep}`);
    }
    const profile = node.source?.auth ?? defaults.auth;
    if (node.source && profile && !has(auth, profile)) throw new Error(`${name}: unknown auth profile ${profile}`);
    if (node.source && /[\r\n\x00]|\$\{\{/.test(node.source.ref)) throw new Error(`${name}: source.ref must be a literal Git ref`);
    for (const key of Object.keys({ ...defaults.env, ...node.env })) {
      if (/^(BUILDGRAPH_|GITHUB_|RUNNER_|NODE_OPTIONS$)/i.test(key)) throw new Error(`${name}: reserved environment variable ${key}`);
    }
    const seen = new Set();
    for (const step of node.steps) {
      if (step.id?.startsWith('bg_')) throw new Error(`${name}: step IDs starting with bg_ are reserved`);
      if (step.id && seen.has(step.id)) throw new Error(`${name}: duplicate step ID ${step.id}`);
      seen.add(step.id);
      if (step.run && step.with) throw new Error(`${name}: with is only valid for a uses step`);
      if (step.uses && (step.shell || step['working-directory'])) throw new Error(`${name}: shell/working-directory require a run step`);
    }
    if (node.permissions?.contents === 'none') throw new Error(`${name}: contents: read is required to checkout the build hub`);
    if (node.permissions?.['id-token'] === 'read') throw new Error(`${name}: id-token supports write or none`);
    if (node.permissions?.models === 'write') throw new Error(`${name}: models supports read or none`);
  }
  topologicalOrder(nodes);
  return manifest;
}

function topologicalOrder(nodes, roots = Object.keys(nodes)) {
  const result = [], state = new Map(), stack = [];
  function visit(id) {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`Dependency cycle: ${[...stack.slice(stack.indexOf(id)), id].join(' -> ')}`);
    state.set(id, 1);
    stack.push(id);
    for (const dep of nodes[id].needs ?? []) visit(dep);
    stack.pop();
    state.set(id, 2);
    result.push(id);
  }
  for (const root of roots) visit(root);
  return result;
}

/** Selects targets plus all prerequisites. refs only overrides selected source nodes, never repositories or commands. */
export function plan(manifest, { target = manifest.defaultTarget, refs = {} } = {}) {
  validate(manifest);
  if (typeof target !== 'string') throw new Error('target must be a comma-separated string of node IDs');
  const targets = [...new Set(target.split(',').map(s => s.trim()).filter(Boolean))];
  if (!targets.length) throw new Error('Select at least one target');
  for (const id of targets) if (!has(manifest.nodes, id)) throw new Error(`Unknown target: ${id}`);
  if (!refs || Array.isArray(refs) || typeof refs !== 'object') throw new Error('refs must be a JSON object keyed by source node ID');
  const selected = topologicalOrder(manifest.nodes, targets);
  const sourceRefs = Object.fromEntries(selected.filter(id => manifest.nodes[id].source).map(id => [id, manifest.nodes[id].source.ref]));
  for (const [id, ref] of Object.entries(refs)) {
    if (!has(sourceRefs, id)) throw new Error(`refs.${id}: not a selected source node`);
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 256 || /[\r\n\x00]|\$\{\{/.test(ref)) throw new Error(`refs.${id}: expected a literal Git ref or commit SHA`);
    sourceRefs[id] = ref;
  }
  return { targets, selected, refs: sourceRefs, digest: digest(manifest) };
}

export function order(manifest) {
  validate(manifest);
  return topologicalOrder(manifest.nodes);
}
