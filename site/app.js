import { newWorkflow } from './workflow.js';

const $ = (id) => document.getElementById(id);
const form = $('wizard');
let result;
let config;
function invalidate() {
  result = undefined;
  $('copy').disabled = $('download').disabled = true;
  $('github-edit').hidden = true;
  $('feedback').textContent = '';
  $('yaml').textContent = '配置已更改，请重新预览。';
}
form.addEventListener('input', invalidate);
form.addEventListener('change', invalidate);
form.elements.mode.addEventListener('change', () => {
  const mode = form.elements.mode.value;
  $('destinations-label').hidden = mode === 'artifact';
  $('mode-note').textContent =
    mode === 'artifact'
      ? '默认加密保存。项目之间不会自动建立依赖。'
      : mode === 'release'
        ? '选择 deliver 才会公开发布。请先授权 GitHub App，并配置 production environment。'
        : '目标仓库需先安装 publish.yml。构建中心会等待对应发布运行完成。';
});
form.elements.stack.addEventListener('change', () => {
  if (form.elements.stack.value === 'go')
    form.elements.command.value = 'mkdir -p dist\ngo build -o dist/app ./cmd/app';
  else if (form.elements.stack.value === 'node') form.elements.command.value = 'npm ci\nnpm run build';
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  $('error').textContent = '';
  try {
    const data = Object.fromEntries(new FormData(form));
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(data.hub))
      throw new Error('构建中心请填写 owner/repository。');
    result = newWorkflow(data);
    $('yaml').textContent = result.yaml;
    $('filename').textContent = '.github/workflows/' + result.filename;
    $('credentials').textContent =
      '需要配置的 Secrets：' +
      result.secrets.join('、') +
      (result.variables.length ? '；Variables：' + result.variables.join('、') : '') +
      '。';
    $('copy').disabled = $('download').disabled = false;
    // GitHub authenticates and reviews the edit; the page never receives a credential.
    const branch = data.hub === config?.repository ? config.branch : 'HEAD';
    const url = new URL(`https://github.com/${data.hub}/new/${encodeURIComponent(branch)}`);
    url.searchParams.set('filename', '.github/workflows/' + result.filename);
    url.searchParams.set('value', result.yaml);
    $('github-edit').href = url.href;
    $('github-edit').hidden = url.href.length > 8000;
    $('next-step').textContent =
      (url.href.length > 8000
        ? '内容较长，请下载文件后提交。'
        : '在 GitHub 新建文件，按仓库流程提交 PR 或提交。') +
      '审阅合并后，在 Actions 选择 build；明确要分发时选择 deliver。';
  } catch (error) {
    invalidate();
    $('error').textContent = error.message;
  }
});
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(result.yaml);
    $('feedback').textContent = '已复制 YAML。';
  } catch {
    $('feedback').textContent = '浏览器未允许复制，请使用下载文件。';
  }
});
$('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([result.yaml], { type: 'application/yaml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = result.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('feedback').textContent = '已下载。将文件放入构建中心的 .github/workflows/，审阅后提交。';
});
function link(label, href) {
  const a = document.createElement('a');
  a.textContent = label;
  a.href = href;
  return a;
}
try {
  const response = await fetch('./catalog.json');
  if (!response.ok) throw new Error('catalog unavailable');
  config = await response.json();
  $('hub').value = config.repository;
  const root = `https://github.com/${config.repository}`;
  $('all-runs').href = root + '/actions';
  $('docs').href = root + '#readme';
  $('source-link').href = root;
  $('distribution-docs').href = root + '/blob/' + encodeURIComponent(config.branch) + '/docs/distribution.md';
  $('catalog-status').textContent =
    `${config.repository} · ${config.workflows.length} 个可手动触发的工作流。状态从 GitHub 公开 API 读取。`;
  for (const workflow of config.workflows) {
    const article = document.createElement('article');
    article.className = 'workflow';
    const title = document.createElement('h3');
    title.textContent = workflow.name;
    const details = document.createElement('p');
    details.textContent = workflow.targets.length
      ? 'targets: ' + workflow.targets.join(' / ')
      : workflow.file;
    const status = document.createElement('p');
    status.className = 'status';
    status.textContent = '状态读取中…';
    const links = document.createElement('div');
    links.className = 'links';
    links.append(
      link('运行 / 历史 ↗', `${root}/actions/workflows/${workflow.file}`),
      link(
        '查看 YAML ↗',
        `${root}/blob/${encodeURIComponent(config.branch)}/.github/workflows/${workflow.file}`,
      ),
    );
    article.append(title, details, status, links);
    $('catalog').append(article);
    fetch(
      `https://api.github.com/repos/${config.repository}/actions/workflows/${workflow.file}/runs?per_page=1`,
      { signal: AbortSignal.timeout(8000) },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await response.json();
        const run = data.workflow_runs?.[0];
        status.textContent = run
          ? `最近运行 · ${run.conclusion || run.status} · #${run.run_number}`
          : '尚无运行';
      })
      .catch(() => {
        status.textContent = '状态暂不可用 · 可在 GitHub 查看';
      });
  }
} catch {
  $('catalog-status').textContent = '暂时无法读取工作流目录。仍可填写构建中心并生成 YAML。';
  $('all-runs').hidden = true;
}
