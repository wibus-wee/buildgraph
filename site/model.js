/** Display data is derived from native YAML; it never drives workflow execution. */
export function describeWorkflow(file, workflow) {
  const jobs = Object.entries(workflow.jobs).map(([id, job]) => ({
    id,
    name: typeof job.name === 'string' ? job.name : id,
    reusable: typeof job.uses === 'string' ? job.uses : null,
    needs: typeof job.needs === 'string' ? [job.needs] : job.needs || [],
    runner:
      typeof job['runs-on'] === 'string'
        ? job['runs-on']
        : Array.isArray(job['runs-on'])
          ? job['runs-on'].join(', ')
          : job['runs-on']
            ? [
                job['runs-on'].group,
                ...(Array.isArray(job['runs-on'].labels) ? job['runs-on'].labels : [job['runs-on'].labels]),
              ]
                .filter(Boolean)
                .join(', ')
            : 'Defined by reusable workflow',
    steps: (job.steps || []).map(
      (step) => step.name || (step.uses ? step.uses.split('@')[0] : 'Run command'),
    ),
    planner: (job.steps || []).some((step) => /(?:^|\/)plan(?:@|$)/.test(step.uses || '')),
  }));
  return {
    file,
    name: typeof workflow.name === 'string' ? workflow.name : file,
    targets:
      workflow.on?.workflow_dispatch?.inputs?.target?.options ||
      (workflow.on?.workflow_dispatch?.inputs?.target && jobs.some((job) => job.planner)
        ? jobs.filter((job) => !job.planner).map((job) => job.id)
        : []),
    jobs,
  };
}

/** Assigns each native job to a dependency column without inventing inter-project edges. */
export function layoutGraph(jobs) {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const ranks = new Map();
  const visiting = new Set();
  function rank(id) {
    if (ranks.has(id)) return ranks.get(id);
    if (visiting.has(id)) throw new Error('The workflow contains a dependency cycle.');
    if (!byId.has(id)) throw new Error('The workflow references a missing job.');
    visiting.add(id);
    const needs = byId.get(id).needs;
    const value = needs.length ? Math.max(...needs.map(rank)) + 1 : 0;
    ranks.set(id, value);
    visiting.delete(id);
    return value;
  }
  jobs.forEach((job) => rank(job.id));
  const columns = Array.from({ length: Math.max(0, ...ranks.values()) + 1 }, () => []);
  jobs.forEach((job) => columns[ranks.get(job.id)].push(job));
  const rows = Math.max(1, ...columns.map((column) => column.length));
  const height = Math.max(250, rows * 104 + 72);
  const width = Math.max(500, columns.length * 196 + 48);
  const nodes = columns.flatMap((column, col) =>
    column.map((job, row) => ({
      ...job,
      x: 44 + col * 196 + (width - columns.length * 196 - 48) / 2,
      y: (height - column.length * 104) / 2 + row * 104 + 20,
    })),
  );
  return { nodes, width, height };
}

export function filterWorkflows(workflows, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return workflows.filter((workflow) =>
    words.every((word) =>
      `${workflow.name} ${workflow.file} ${workflow.targets.join(' ')}`.toLowerCase().includes(word),
    ),
  );
}

export function statusLabel(run) {
  if (!run) return { label: 'Not available', tone: 'neutral' };
  const value = run.conclusion || run.status;
  return (
    {
      success: { label: 'Passed', tone: 'success' },
      failure: { label: 'Failed', tone: 'error' },
      timed_out: { label: 'Timed out', tone: 'error' },
      cancelled: { label: 'Cancelled', tone: 'neutral' },
      skipped: { label: 'Skipped', tone: 'neutral' },
      in_progress: { label: 'Running', tone: 'active' },
      queued: { label: 'Queued', tone: 'warning' },
      waiting: { label: 'Waiting', tone: 'warning' },
      requested: { label: 'Requested', tone: 'warning' },
    }[value] || { label: value?.replaceAll('_', ' ') || 'Pending', tone: 'neutral' }
  );
}

export function latestFor(workflow, runs) {
  return runs.find((run) => run.path?.split('@')[0] === `.github/workflows/${workflow.file}`);
}
