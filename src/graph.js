import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

const has = (object, key) => Object.hasOwn(object, key);
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const jobID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function parseWorkflow(source) {
  const document = parseDocument(source, { version: '1.2', uniqueKeys: true, merge: false });
  if (document.errors.length) throw new Error(`Invalid workflow YAML: ${document.errors[0].message}`);
  return validate(document.toJS({ maxAliasCount: 100 }));
}

export async function readWorkflow(file) {
  if (!/\.ya?ml$/i.test(file)) throw new Error('Expected a native GitHub Actions .yml or .yaml workflow');
  return parseWorkflow(await readFile(file, 'utf8'));
}

export function dependencies(workflow, id) {
  if (!has(workflow.jobs, id)) throw new Error(`Unknown job: ${id}`);
  const needs = workflow.jobs[id].needs;
  return needs === undefined ? [] : typeof needs === 'string' ? [needs] : needs;
}

/** Checks job IDs and dependency edges only. GitHub/actionlint own the rest of the native workflow contract. */
export function validate(workflow) {
  if (!mapping(workflow) || !mapping(workflow.jobs) || !Object.keys(workflow.jobs).length) throw new Error('Workflow must contain a nonempty jobs mapping');
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (!jobID.test(id) || !mapping(job)) throw new Error(`Invalid job definition: ${id}`);
    const needs = dependencies(workflow, id);
    if (!Array.isArray(needs) || needs.some(dep => typeof dep !== 'string' || !jobID.test(dep))) throw new Error(`${id}: needs must be a job ID or an array of job IDs`);
    if (new Set(needs).size !== needs.length) throw new Error(`${id}: duplicate dependency in needs`);
    for (const dep of needs) {
      if (!has(workflow.jobs, dep)) throw new Error(`${id}: unknown dependency ${dep}`);
    }
  }
  topologicalOrder(workflow);
  return workflow;
}

function topologicalOrder(workflow, roots = Object.keys(workflow.jobs)) {
  const result = [], state = new Map(), stack = [];
  function visit(id) {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`Dependency cycle: ${[...stack.slice(stack.indexOf(id)), id].join(' -> ')}`);
    state.set(id, 1);
    stack.push(id);
    for (const dep of dependencies(workflow, id)) visit(dep);
    stack.pop();
    state.set(id, 2);
    result.push(id);
  }
  for (const root of roots) visit(root);
  return result;
}

/** Returns target jobs plus prerequisites, excluding the planner job. Does not evaluate GitHub expressions or expand matrices. */
export function plan(workflow, { target, plannerJob = 'plan' } = {}) {
  validate(workflow);
  target ??= workflow.on?.workflow_dispatch?.inputs?.target?.default;
  if (typeof target !== 'string') throw new Error('Provide target job IDs or set on.workflow_dispatch.inputs.target.default');
  const targets = [...new Set(target.split(',').map(s => s.trim()).filter(Boolean))];
  if (!targets.length) throw new Error('Select at least one target job');
  if (has(workflow.jobs, plannerJob) && dependencies(workflow, plannerJob).length) throw new Error(`Planner job ${plannerJob} must not depend on other jobs`);
  for (const id of targets) {
    if (!has(workflow.jobs, id)) throw new Error(`Unknown target job: ${id}`);
    if (id === plannerJob) throw new Error(`The planner job ${plannerJob} cannot be a build target`);
  }
  const selected = topologicalOrder(workflow, targets).filter(id => id !== plannerJob);
  return { targets, selected };
}

export function order(workflow) {
  validate(workflow);
  return topologicalOrder(workflow);
}
