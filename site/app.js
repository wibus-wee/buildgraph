import { newWorkflow } from './workflow.js';
import { filterWorkflows, latestFor, layoutGraph, statusLabel } from './model.js';
import { icon, mountIcons } from './icons.js';

const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const steps = ['source', 'build', 'distribution', 'review'];
const form = $('wizard');
let config;
let runs = [];
let activity = 'loading';
let activityError = '';
let result;
let currentStage = 0;
let currentView;
let dirty = false;
let toastTimer;
let activityBusy = false;
const scrollPositions = new Map();
let routeKey = location.hash;

mountIcons();

function route() {
  const [name, query = ''] = location.hash.slice(1).split('?');
  return {
    view: ['overview', 'workflows', 'runs', 'new'].includes(name) ? name : 'overview',
    params: new URLSearchParams(query),
  };
}
function url(view, values = {}) {
  const params = new URLSearchParams(
    Object.entries(values).filter(([, value]) => value !== '' && value != null),
  );
  return '#' + view + (params.size ? '?' + params : '');
}
function replaceRoute(view, values) {
  history.replaceState(null, '', url(view, values));
  routeKey = location.hash;
}
function root() {
  return 'https://github.com/' + (config?.repository || 'wibus-wee/buildgraph');
}
function workflowUrl(workflow) {
  return root() + '/actions/workflows/' + encodeURIComponent(workflow.file);
}
function sourceUrl(workflow) {
  return (
    root() +
    '/blob/' +
    encodeURIComponent(config?.branch || 'main') +
    '/.github/workflows/' +
    encodeURIComponent(workflow.file)
  );
}
function notify(message, success = true) {
  clearTimeout(toastTimer);
  $('toast').innerHTML = icon(success ? 'check' : 'info') + '<span>' + escape(message) + '</span>';
  $('toast').hidden = false;
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 5000);
}
function status(run) {
  const { label, tone } = statusLabel(run);
  return '<span class="status ' + tone + '"><span class="status-dot"></span>' + escape(label) + '</span>';
}
function selectedWorkflow() {
  return (
    config?.workflows.find((workflow) => workflow.file === route().params.get('workflow')) ||
    config?.workflows.find((workflow) => workflow.targets.length) ||
    config?.workflows[0]
  );
}
function renderGraph() {
  const workflow = selectedWorkflow();
  $('graph-panel').hidden = !workflow;
  if (!workflow) return;
  $('graph-workflow').value = workflow.file;
  $('graph-run').href = workflowUrl(workflow);
  $('graph-source').href = sourceUrl(workflow);
  $('graph-file').textContent = '.github/workflows/' + workflow.file;
  const selected = route().params.get('job');
  const layout = layoutGraph(workflow.jobs);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const edges = layout.nodes
    .flatMap((node) =>
      node.needs.map((id) => {
        const parent = byId.get(id);
        const x1 = parent.x + 154,
          y1 = parent.y + 32,
          x2 = node.x,
          y2 = node.y + 32;
        const highlighted = selected === node.id || selected === id;
        // Planning dependencies are control edges, drawn separately from build dependencies.
        let path;
        if (x2 - x1 > 100) {
          const lane = 22 + layout.nodes.findIndex((item) => item.id === node.id) * 5;
          path =
            'M' + x1 + ' ' + y1 + ' H' + (x1 + 15) + ' V' + lane + ' H' + (x2 - 17) + ' V' + y2 + ' H' + x2;
        } else {
          const mid = (x1 + x2) / 2;
          path = 'M' + x1 + ' ' + y1 + ' C' + mid + ' ' + y1 + ' ' + mid + ' ' + y2 + ' ' + x2 + ' ' + y2;
        }
        return (
          '<path class="edge ' +
          (parent.planner ? 'control ' : '') +
          (highlighted ? 'selected' : '') +
          '" d="' +
          path +
          '"/>'
        );
      }),
    )
    .join('');
  const buttons = layout.nodes
    .map(
      (node) =>
        '<button class="job-node" data-job="' +
        escape(node.id) +
        '" style="left:' +
        node.x +
        'px;top:' +
        node.y +
        'px" aria-pressed="' +
        (selected === node.id) +
        '" aria-label="Inspect ' +
        escape(node.id) +
        '">' +
        icon(node.planner ? 'branch' : 'terminal') +
        '<span><strong>' +
        escape(node.id) +
        '</strong><small>' +
        (node.planner
          ? 'Target selection'
          : node.reusable
            ? 'Reusable workflow'
            : node.steps.length + (node.steps.length === 1 ? ' step' : ' steps')) +
        '</small></span></button>',
    )
    .join('');
  const viewport = $('graph-viewport');
  const scrollLeft = viewport.scrollLeft;
  viewport.innerHTML =
    '<div class="graph-inner" style="width:' +
    layout.width +
    'px;height:' +
    layout.height +
    'px"><svg aria-hidden="true" viewBox="0 0 ' +
    layout.width +
    ' ' +
    layout.height +
    '">' +
    edges +
    '</svg>' +
    buttons +
    '</div>';
  viewport.scrollLeft = scrollLeft;
  const job = byId.get(selected);
  $('job-inspector').hidden = !job;
  if (job)
    $('job-inspector').innerHTML =
      '<div class="job-summary"><h3>' +
      escape(job.id) +
      '</h3><span>' +
      (job.planner ? 'Planner' : 'Workflow job') +
      '</span></div><dl><dt>Runner</dt><dd class="mono">' +
      escape(job.runner) +
      '</dd><dt style="margin-top:10px">Needs</dt><dd class="mono">' +
      escape(job.needs.join(', ') || 'No dependencies') +
      '</dd></dl><div>' +
      (job.reusable
        ? '<h3>Called workflow</h3><code>' + escape(job.reusable) + '</code>'
        : '<h3>Steps</h3><ul>' +
          job.steps.map((step) => '<li>' + escape(step) + '</li>').join('') +
          '</ul>') +
      '</div>';
}
function renderWorkflows() {
  if (!config) return;
  const query = route().params.get('q') || '';
  const filtered = filterWorkflows(config.workflows, query);
  $('list-count').textContent = query
    ? filtered.length + ' / ' + config.workflows.length
    : config.workflows.length;
  $('workflow-list').innerHTML = filtered.length
    ? filtered
        .map((workflow) => {
          const run = latestFor(workflow, runs);
          const runStatus = run
            ? status(run)
            : '<span class="status neutral"><span class="status-dot"></span>' +
              (activity === 'loading' ? 'Loading…' : activity === 'ready' ? 'No recent run' : 'Unavailable') +
              '</span>';
          return (
            '<tr><td><div class="workflow-name">' +
            icon('workflow') +
            '<a href="' +
            escape(url('workflows', { workflow: workflow.file, q: query })) +
            '"><strong>' +
            escape(workflow.name) +
            '</strong><code translate="no">' +
            escape(workflow.file) +
            '</code></a></div></td><td class="target-cell">' +
            (workflow.targets.length
              ? workflow.targets.length + (workflow.targets.length === 1 ? ' target' : ' targets')
              : 'Manual dispatch') +
            '</td><td>' +
            (run
              ? '<a href="' +
                escape(root() + '/actions/runs/' + run.id) +
                '" aria-label="' +
                escape(workflow.name + ': ' + statusLabel(run).label) +
                '">' +
                runStatus +
                '</a>'
              : runStatus) +
            '</td><td><div class="row-actions"><a class="icon-button" href="' +
            escape(sourceUrl(workflow)) +
            '" aria-label="View YAML for ' +
            escape(workflow.name) +
            '" title="View YAML">' +
            icon('code') +
            '</a><a class="icon-button" href="' +
            escape(workflowUrl(workflow)) +
            '" aria-label="Run ' +
            escape(workflow.name) +
            ' on GitHub" title="Run on GitHub">' +
            icon('play') +
            '</a></div></td></tr>'
          );
        })
        .join('')
    : '<tr><td colspan="4" class="empty-cell"><strong>' +
      (query ? 'No matching workflows' : 'Your first workflow starts here') +
      '</strong>' +
      (query
        ? 'Try another name, filename, or target.<br><button class="button small" id="clear-search">Clear search</button>'
        : 'Connect a project to add its native Actions workflow.<br><a class="button small" href="#new">Connect a project</a>') +
      '</td></tr>';
  $('filter-status').textContent = filtered.length + ' workflows shown.';
}
function renderRuns() {
  if (activity !== 'ready' && !runs.length) {
    const loading = activity === 'loading';
    $('run-history').innerHTML =
      '<div class="empty-state">' +
      icon(loading ? 'clock' : 'github') +
      '<h2>' +
      (loading ? 'Fetching recent runs…' : 'Activity is available on GitHub') +
      '</h2><p>' +
      escape(
        loading
          ? 'Loading the most recent runs in this repository.'
          : activityError || 'Couldn’t reach GitHub. Try refreshing, or open the run history directly.',
      ) +
      '</p>' +
      (!loading
        ? '<a class="button" href="' +
          escape(root() + '/actions') +
          '">Open GitHub Actions ' +
          icon('external') +
          '</a>'
        : '') +
      '</div>';
    return;
  }
  if (!runs.length) {
    $('run-history').innerHTML =
      '<div class="empty-state">' +
      icon('clock') +
      '<h2>No runs yet</h2><p>Open a workflow on GitHub to start its first run.</p><a href="#workflows" class="button">Explore workflows ' +
      icon('arrow-right') +
      '</a></div>';
    return;
  }
  $('run-history').innerHTML =
    '<div class="table-wrap"><table class="run-table"><caption class="sr-only">Most recent 30 workflow runs</caption><thead><tr><th>Run</th><th>Status</th><th>Branch</th><th class="align-right">Started</th></tr></thead><tbody>' +
    runs
      .map((run) => {
        const date = new Date(run.created_at);
        return (
          '<tr><td><a class="run-title" href="' +
          escape(root() + '/actions/runs/' + run.id) +
          '">' +
          escape(run.display_title || run.name) +
          '</a><span class="run-meta">' +
          escape(run.name) +
          ' · #' +
          escape(run.run_number) +
          '</span></td><td>' +
          status(run) +
          '</td><td class="mono">' +
          escape(run.head_branch || '—') +
          '</td><td class="align-right"><time datetime="' +
          escape(run.created_at) +
          '" title="' +
          escape(date.toLocaleString()) +
          '">' +
          escape(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) +
          '</time></td></tr>'
        );
      })
      .join('') +
    '</tbody></table></div>';
}
async function loadRuns() {
  if (!config || activityBusy) return;
  activityBusy = true;
  activity = 'loading';
  activityError = '';
  $('refresh-runs').disabled = true;
  $('activity-state').innerHTML = '<span class="status-dot"></span>Refreshing GitHub activity…';
  renderRuns();
  try {
    const response = await fetch(
      'https://api.github.com/repos/' + config.repository + '/actions/runs?per_page=30',
      { signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) {
      activityError =
        response.status === 403 || response.status === 429
          ? 'GitHub’s public API is rate limited. You can still view every run on GitHub.'
          : 'GitHub is temporarily unavailable. Try refreshing or open Actions directly.';
      throw new Error('Activity unavailable');
    }
    const data = await response.json();
    if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid activity response');
    runs = data.workflow_runs;
    activity = 'ready';
    $('activity-state').innerHTML =
      '<span class="status-dot"></span>GitHub activity updated ' +
      escape(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
  } catch {
    activity = 'error';
    $('activity-state').innerHTML =
      '<span class="status-dot"></span>' +
      (runs.length ? 'Showing previously loaded activity · ' : '') +
      'Live activity unavailable. <a href="' +
      root() +
      '/actions">View on GitHub ↗</a>';
  } finally {
    activityBusy = false;
    $('refresh-runs').disabled = false;
    renderWorkflows();
    renderRuns();
  }
}
async function loadCatalog() {
  $('retry-catalog').disabled = true;
  try {
    const response = await fetch('./catalog.json', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Catalog unavailable');
    const next = await response.json();
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(next.repository) || !Array.isArray(next.workflows))
      throw new Error('Invalid catalog');
    config = next;
    const [owner, repository] = config.repository.split('/');
    $('workspace-owner').textContent = owner;
    $('workspace-repo').textContent = repository;
    $('workspace-avatar').textContent = owner[0].toUpperCase();
    $('breadcrumb-repo').textContent = repository;
    $('workspace-link').href = $('github-link').href = root();
    $('all-runs').href = root() + '/actions';
    $('edit-workflows').href = root() + '/tree/' + encodeURIComponent(config.branch) + '/.github/workflows';
    $('branch-name').textContent = config.branch;
    $('workflow-count').textContent = $('nav-count').textContent = config.workflows.length;
    $('target-count').textContent = config.workflows.reduce(
      (sum, workflow) => sum + workflow.targets.length,
      0,
    );
    if (!$('hub').value) $('hub').value = config.repository;
    document.querySelectorAll('[data-doc]').forEach((link) => {
      link.href = root() + '/blob/' + encodeURIComponent(config.branch) + '/' + link.dataset.doc;
    });
    $('graph-workflow').innerHTML = config.workflows
      .map(
        (workflow) => '<option value="' + escape(workflow.file) + '">' + escape(workflow.name) + '</option>',
      )
      .join('');
    $('graph-workflow').disabled = false;
    $('catalog-error').hidden = true;
    renderRoute(false);
    updateDraft();
    loadRuns();
  } catch {
    $('catalog-error').hidden = false;
    $('graph-panel').hidden = true;
    $('workflow-list').innerHTML =
      '<tr><td colspan="4" class="empty-cell">Workflow catalog unavailable. Retry above or connect a new project.</td></tr>';
    activity = 'error';
    $('activity-state').textContent = 'Catalog unavailable · Project setup is still available.';
    renderRuns();
  } finally {
    $('retry-catalog').disabled = false;
  }
}
function formData() {
  const data = Object.fromEntries(new FormData(form));
  for (const key of ['hub', 'source', 'project', 'output', 'destinations']) data[key] = data[key].trim();
  return data;
}
function validateStage(stage, show = true) {
  const data = formData();
  const repository = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/;
  const errors = {};
  if (stage === 0) {
    if (!repository.test(data.hub)) errors.hub = 'Enter the build repository as owner/repository.';
    if (!repository.test(data.source)) errors.source = 'Enter the source repository as owner/repository.';
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(data.project))
      errors.project =
        'Start with a lowercase letter. Use up to 40 letters, numbers, hyphens, or underscores.';
    if (
      config?.repository.toLowerCase() === data.hub.toLowerCase() &&
      config.workflows.some((workflow) => workflow.file === 'project-' + data.project + '.yml')
    )
      errors.project = 'This workflow already exists. Choose a new ID or edit the existing YAML.';
  }
  if (stage === 1) {
    if (!data.command.trim()) errors.command = 'Add at least one build command.';
    if (!/^source\/[A-Za-z0-9_./-]+$/.test(data.output) || data.output.split('/').includes('..'))
      errors.output = 'Use a directory inside source/, such as source/dist.';
  }
  if (stage === 2 && data.mode !== 'artifact') {
    const destinations = data.destinations
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!destinations.length || destinations.some((value) => !repository.test(value)))
      errors.destinations = 'Enter at least one owner/repository. Put each destination on its own line.';
  }
  if (show) {
    const fields =
      stage === 0 ? ['hub', 'source', 'project'] : stage === 1 ? ['command', 'output'] : ['destinations'];
    for (const name of fields) {
      $(name).setAttribute('aria-invalid', String(Boolean(errors[name])));
      $(name + '-error').textContent = errors[name] || '';
      $(name + '-error').hidden = !errors[name];
    }
    const first = Object.keys(errors)[0];
    if (first) $(first).focus();
  }
  return Object.keys(errors).length === 0;
}
function updateDraft() {
  const data = formData();
  $('preview-source').textContent = data.source || 'Your private source';
  $('preview-hub').textContent = data.hub || 'Your build repository';
  $('preview-file').textContent = data.project ? 'project-' + data.project + '.yml' : 'project-name.yml';
  $('destination-field').hidden = data.mode === 'artifact';
  $('preview-action').textContent = {
    artifact: 'encrypt & upload',
    release: 'publish release',
    dispatch: 'workflow_dispatch',
  }[data.mode];
  $('preview-destination-label').textContent = data.mode === 'artifact' ? 'Output' : 'Distribution';
  const destinations = data.destinations
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  $('preview-destination').textContent =
    data.mode === 'artifact'
      ? 'Encrypted artifact'
      : destinations.length
        ? destinations[0] + (destinations.length > 1 ? ' + ' + (destinations.length - 1) + ' more' : '')
        : 'Your distribution repository';
  $('delivery-note').innerHTML =
    icon('info') +
    '<span>' +
    {
      artifact: 'Artifacts are encrypted before upload. Only holders of your key can restore them.',
      release:
        'The build target keeps output encrypted. Choose deliver explicitly to publish a public Release.',
      dispatch:
        'Each destination needs a publish.yml workflow and its own authorization. The hub waits for its result.',
    }[data.mode] +
    '</span>';
}
function showStage(requested, focus = false) {
  let stage = requested;
  for (let i = 0; i < requested; i++)
    if (!validateStage(i, false)) {
      stage = i;
      break;
    }
  currentStage = stage;
  if (stage !== requested) replaceRoute('new', { step: steps[stage] });
  document.querySelectorAll('[data-stage]').forEach((fieldset) => {
    fieldset.hidden = Number(fieldset.dataset.stage) !== stage;
  });
  document.querySelectorAll('[data-step-link]').forEach((link) => {
    const value = Number(link.dataset.stepLink);
    if (value === stage) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
    link.classList.toggle('complete', value < stage);
  });
  $('setup-layout').hidden = stage === 3;
  $('review-panel').hidden = stage !== 3;
  $('step-back').hidden = stage === 0;
  if (stage < 3)
    $('step-next').innerHTML =
      ['Configure build', 'Choose distribution', 'Review workflow'][stage] + icon('arrow-right');
  $('wizard-error').textContent = '';
  if (stage === 3) {
    renderReview();
    if (focus) $('review-title').focus({ preventScroll: true });
  } else if (focus)
    document
      .querySelector('[data-stage="' + stage + '"] input, [data-stage="' + stage + '"] select')
      ?.focus({ preventScroll: true });
}
function renderReview() {
  try {
    const data = formData();
    result = newWorkflow(data);
    $('filename').textContent = result.filename;
    $('yaml').innerHTML = result.yaml
      .trimEnd()
      .split('\n')
      .map((line) => {
        const value = escape(line);
        const content = /^\s*#/.test(line)
          ? '<span class="yaml-comment">' + value + '</span>'
          : value.replace(/^(\s*(?:- )?)([\w-]+)(:)/, '$1<span class="yaml-key">$2</span>$3');
        return '<span class="code-line">' + content + '</span>';
      })
      .join('\n');
    $('credentials').innerHTML = [
      ['Secrets', result.secrets],
      ['Variables', result.variables],
    ]
      .filter(([, names]) => names.length)
      .map(
        ([label, names]) =>
          '<div class="credential-group"><h4>' +
          label +
          '</h4>' +
          names.map((name) => '<code>' + escape(name) + '</code>').join('') +
          '</div>',
      )
      .join('');
    $('secrets-link').href = 'https://github.com/' + data.hub + '/settings/secrets/actions';
    const branch = data.hub.toLowerCase() === config?.repository.toLowerCase() ? config.branch : 'HEAD';
    const edit = new URL('https://github.com/' + data.hub + '/new/' + encodeURIComponent(branch));
    edit.searchParams.set('filename', '.github/workflows/' + result.filename);
    edit.searchParams.set('value', result.yaml);
    $('github-edit').href = edit.href;
    $('github-edit').hidden = edit.href.length > 8000;
    $('github-edit-help').textContent =
      edit.href.length > 8000
        ? 'This workflow is too long for a GitHub link. Download the file and commit it under .github/workflows/.'
        : 'Review the file, then submit a commit or pull request on GitHub.';
    $('review-run-help').innerHTML =
      'After merging, open <strong>' +
      escape(data.project) +
      '</strong> in Actions and choose <code>build</code>.' +
      (data.mode === 'artifact'
        ? ' The output stays encrypted.'
        : ' Choose <code>deliver</code> only when you’re ready to publish.');
    $('receiver-guide').hidden = data.mode !== 'dispatch';
  } catch (error) {
    result = undefined;
    $('setup-layout').hidden = false;
    $('review-panel').hidden = true;
    showStage(2);
    replaceRoute('new', { step: 'distribution' });
    $('wizard-error').textContent = error.message;
  }
}
function renderRoute(moveFocus = true) {
  const { view, params } = route();
  const changedView = view !== currentView;
  currentView = view;
  document.body.classList.toggle('view-workflows', view === 'workflows');
  const workspace = document.querySelector('.workspace-body');
  const first = view === 'workflows' ? document.querySelector('.workflow-section') : $('graph-panel');
  if (workspace.firstElementChild !== first) workspace.prepend(first);
  $('workspace-view').hidden = !['overview', 'workflows'].includes(view);
  $('runs-view').hidden = view !== 'runs';
  $('new-view').hidden = view !== 'new';
  const title = { overview: 'Overview', workflows: 'Workflows', runs: 'Run history', new: 'New project' }[
    view
  ];
  $('breadcrumb-page').textContent = title;
  document.title = title + ' · Buildgraph';
  $('page-title').textContent = view === 'workflows' ? 'Workflows' : 'Build workspace';
  $('page-description').textContent =
    view === 'workflows'
      ? 'Inspect a workflow, explore its jobs, or start a run on GitHub.'
      : 'Independent projects. One place to build and distribute.';
  $('workspace-meta').hidden = view === 'workflows';
  document.querySelectorAll('[data-nav]').forEach((link) => {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('workflow-search').value = params.get('q') || '';
  if (view === 'new') showStage(Math.max(0, steps.indexOf(params.get('step') || 'source')), moveFocus);
  if (['overview', 'workflows'].includes(view)) {
    renderGraph();
    renderWorkflows();
  }
  if (view === 'runs') renderRuns();
  if (changedView && moveFocus && view !== 'new') $('main').focus({ preventScroll: true });
  if ($('mobile-dialog').open) $('mobile-dialog').close();
}
window.addEventListener('hashchange', () => {
  scrollPositions.set(routeKey, window.scrollY);
  routeKey = location.hash;
  const previousView = currentView;
  renderRoute();
  if (previousView !== currentView || currentView === 'new')
    window.scrollTo(0, scrollPositions.get(routeKey) || 0);
  if (currentView === 'workflows' && route().params.has('workflow')) {
    $('graph-viewport').focus({ preventScroll: true });
    $('graph-panel').scrollIntoView({ block: 'start' });
  }
});
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  $('main').focus();
  window.scrollTo(0, 0);
});
$('graph-workflow').addEventListener('change', (event) => {
  location.hash = url(route().view, { workflow: event.target.value, q: $('workflow-search').value });
});
$('graph-viewport').addEventListener('click', (event) => {
  const button = event.target.closest('[data-job]');
  if (!button) return;
  const id = button.dataset.job;
  replaceRoute(route().view, {
    workflow: selectedWorkflow().file,
    q: $('workflow-search').value,
    job: route().params.get('job') === id ? '' : id,
  });
  renderGraph();
  [...$('graph-viewport').querySelectorAll('[data-job]')]
    .find((node) => node.dataset.job === id)
    ?.focus({ preventScroll: true });
});
$('workflow-search').addEventListener('input', (event) => {
  const { view, params } = route();
  replaceRoute(view, { workflow: params.get('workflow'), job: params.get('job'), q: event.target.value });
  renderWorkflows();
});
$('workflow-list').addEventListener('click', (event) => {
  if (event.target.closest('#clear-search')) {
    $('workflow-search').value = '';
    $('workflow-search').dispatchEvent(new Event('input'));
    $('workflow-search').focus();
  }
});
form.addEventListener('input', () => {
  dirty = true;
  result = undefined;
  updateDraft();
});
form.addEventListener('change', () => {
  dirty = true;
  result = undefined;
  updateDraft();
});
$('stack').addEventListener('change', () => {
  const defaults = { node: 'npm ci\nnpm run build', go: 'mkdir -p dist\ngo build -o dist/app ./cmd/app' };
  const command = $('command');
  if (
    defaults[$('stack').value] &&
    (!command.value.trim() || Object.values(defaults).includes(command.value))
  ) {
    command.value = defaults[$('stack').value];
  }
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (validateStage(currentStage)) location.hash = url('new', { step: steps[currentStage + 1] });
});
form.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    form.requestSubmit();
  }
});
document.querySelectorAll('[data-step-link]').forEach((link) =>
  link.addEventListener('click', (event) => {
    const next = Number(link.dataset.stepLink);
    if (next > currentStage && !validateStage(currentStage)) event.preventDefault();
  }),
);
$('step-back').addEventListener('click', () => {
  location.hash = url('new', { step: steps[currentStage - 1] });
});
$('review-back').addEventListener('click', () => {
  location.hash = url('new', { step: 'distribution' });
});
$('copy').addEventListener('click', async () => {
  if (!result) return;
  try {
    await navigator.clipboard.writeText(result.yaml);
    notify('Workflow copied to clipboard.');
  } catch {
    notify('Clipboard access is unavailable. Download the YAML instead.', false);
  }
});
$('download').addEventListener('click', () => {
  if (!result) return;
  const href = URL.createObjectURL(new Blob([result.yaml], { type: 'application/yaml' }));
  const link = document.createElement('a');
  link.href = href;
  link.download = result.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  dirty = false;
  notify('Downloaded ' + result.filename);
});
$('github-edit').addEventListener('click', () => {
  dirty = false;
});
window.addEventListener('beforeunload', (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
$('refresh-runs').addEventListener('click', loadRuns);
$('retry-catalog').addEventListener('click', loadCatalog);

function renderCommands() {
  const query = $('command-search').value.toLowerCase().trim();
  const navigation = [
    ['overview', 'Overview', 'overview'],
    ['workflows', 'Workflows', 'workflow'],
    ['runs', 'Run history', 'clock'],
    ['new', 'New project', 'plus'],
  ].filter(([, label]) => label.toLowerCase().includes(query));
  const workflows = filterWorkflows(config?.workflows || [], query);
  $('command-results').innerHTML =
    (navigation.length
      ? '<p class="command-group-label">Go to</p>' +
        navigation
          .map(
            ([view, label, glyph]) =>
              '<a class="command-result" href="#' + view + '">' + icon(glyph) + escape(label) + '</a>',
          )
          .join('')
      : '') +
    (workflows.length
      ? '<p class="command-group-label">Workflows</p>' +
        workflows
          .map(
            (workflow) =>
              '<a class="command-result" href="' +
              escape(url('workflows', { workflow: workflow.file })) +
              '">' +
              icon('workflow') +
              '<span>' +
              escape(workflow.name) +
              '</span><small>' +
              workflow.jobs.length +
              (workflow.jobs.length === 1 ? ' job' : ' jobs') +
              '</small></a>',
          )
          .join('')
      : '') +
    (!navigation.length && !workflows.length
      ? '<p class="empty-cell">No results. Try a workflow name or target.</p>'
      : '');
}
function openCommands() {
  if ($('command-dialog').open) return;
  if ($('mobile-dialog').open) $('mobile-dialog').close();
  $('command-search').value = '';
  renderCommands();
  $('command-dialog').showModal();
  $('command-search').focus();
}
document
  .querySelectorAll('[data-command]')
  .forEach((button) => button.addEventListener('click', openCommands));
$('command-search').addEventListener('input', renderCommands);
$('command-close').addEventListener('click', () => $('command-dialog').close());
$('command-results').addEventListener('click', (event) => {
  if (event.target.closest('a')) $('command-dialog').close();
});
$('command-dialog').addEventListener('keydown', (event) => {
  const links = [...$('command-results').querySelectorAll('a')];
  const index = links.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const next =
      index < 0
        ? event.key === 'ArrowDown'
          ? 0
          : links.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
    links[next]?.focus();
  }
  if (event.key === 'Enter' && document.activeElement === $('command-search')) {
    event.preventDefault();
    links[0]?.click();
  }
});
$('mobile-menu').addEventListener('click', () => $('mobile-dialog').showModal());
$('mobile-close').addEventListener('click', () => $('mobile-dialog').close());
$('mobile-dialog').addEventListener('click', (event) => {
  if (event.target.closest('a')) $('mobile-dialog').close();
});
for (const id of ['command-dialog', 'mobile-dialog'])
  $(id).addEventListener('click', (event) => {
    if (event.target === $(id)) $(id).close();
  });
window.addEventListener('keydown', (event) => {
  const editing =
    /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) ||
    document.activeElement.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openCommands();
  }
  if (!editing && !$('command-dialog').open && !$('mobile-dialog').open) {
    if (event.key === '/' && ['overview', 'workflows'].includes(currentView)) {
      event.preventDefault();
      $('workflow-search').focus();
    }
    if (event.key.toLowerCase() === 'n' && !event.metaKey && !event.ctrlKey && !event.altKey)
      location.hash = '#new';
  }
});
function toggleTheme() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('buildgraph-theme', theme);
  } catch {}
  syncTheme();
}
$('theme-toggle').addEventListener('click', toggleTheme);
$('mobile-theme').addEventListener('click', toggleTheme);
function syncTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('theme-toggle').setAttribute('aria-label', 'Switch to ' + (dark ? 'light' : 'dark') + ' theme');
  $('mobile-theme-label').textContent = 'Switch to ' + (dark ? 'light' : 'dark') + ' theme';
  document.querySelector('meta[name=theme-color]').content = dark ? '#101012' : '#ffffff';
}
if (!/Mac|iPhone|iPad/.test(navigator.platform))
  document.querySelectorAll('.command-key').forEach((key) => {
    key.textContent = 'Ctrl K';
  });
syncTheme();
renderRoute(false);
updateDraft();
loadCatalog();
