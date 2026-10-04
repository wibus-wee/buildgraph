# 复用 Action 和 JS 库

| 方式 | 适用情况 |
| --- | --- |
| Fork 本仓库 | 直接编辑现成工作流，把它作为公开构建中心 |
| `uses: wibus-wee/buildgraph/{plan,upload,download}@<SHA>` | 在已有原生 YAML 中选择对应 Action 入口 |
| CLI / JS 库 | 本地查看依赖闭包，或在其他工具中读取工作流 |

## 在现有 workflow 中 uses

把 `<SHA>` 替换为已审核的 40 位 commit SHA。这些 steps 在你的工作流中运行，读取你的 YAML 和你的 secrets：

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      selected: ${{ steps.graph.outputs.selected }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: wibus-wee/buildgraph/plan@<SHA>
        id: graph
        with:
          workflow: .github/workflows/build.yml
          target: ${{ inputs.target }}
  app:
    needs: plan
    if: ${{ contains(fromJSON(needs.plan.outputs.selected), 'app') }}
    runs-on: ubuntu-latest
    steps:
      - run: echo 'Replace with your checkout and build steps'
```

只需在顶部声明正常的 `on.workflow_dispatch.inputs.target`。添加项目时编辑 jobs，添加依赖时编辑 needs。无须安装 npm 包或运行生成命令。

上传使用 `wibus-wee/buildgraph/upload@<SHA>`，下载使用 `wibus-wee/buildgraph/download@<SHA>`。两者只需目录、key，以及下载时的上游 artifact ID。完整 inputs、job outputs 和权限配置参考[工作流接入](./configuration.md#action-inputs)与[实际工作流](../.github/workflows/build.yml)。如果只需按原生 needs 运行全图，可以省略 planner，单独使用产物操作。

## 本地 CLI

项目尚未发布到 npm registry，可以按 commit 从 GitHub 安装：

```sh
npm install --save-dev github:wibus-wee/buildgraph#<SHA>
npx buildgraph validate .github/workflows/build.yml
npx buildgraph plan .github/workflows/build.yml --target app
```

CLI 读取标准 YAML，不改写工作流。`keygen` 仅用于首次配置或明确的密钥轮换。

## JS API

```js
import { readWorkflow, plan } from '@wibus-wee/buildgraph';

const workflow = await readWorkflow('.github/workflows/build.yml');
const execution = plan(workflow, { target: 'app' });
console.log(execution.selected);
```

| 导出 | 契约 |
| --- | --- |
| `readWorkflow(file)` | 异步读取 `.yml` / `.yaml` 并校验 job 依赖 |
| `parseWorkflow(source)` | 解析 YAML 1.2 文本并校验；拒绝重复键，限制 alias 展开 |
| `validate(workflow)` | 只校验 job IDs、needs 及环；返回原对象，不修改输入 |
| `dependencies(workflow, id)` | 返回某个 job 的直接 needs 数组，支持原生 string / array 写法 |
| `plan(workflow, options?)` | 返回 `{targets, selected}`；selected 为去重的拓扑序，不包含 planner |
| `order(workflow)` | 返回全图拓扑序，包含 planner |
| `diagnoseWiring(workflow, {plannerJob}?)` | 返回 `{level, job, message}[]`；检查标准选择条件，任意表达式不求值 |
| `pack(options)` | 异步打包并返回临时 archive 路径，上传后调用方可清理父目录 |
| `unpack(options)` | 异步验证并恢复到尚不存在的目录，返回目标路径；失败清理临时内容 |

plan 的 options 为 `target` 和 `plannerJob`。target 缺省时读取工作流的 dispatch target 默认值；plannerJob 默认 `plan`。plan 不评估 GitHub 表达式、job if 或矩阵，不执行构建命令。错误均通过 Error 抛出。

pack/unpack 的 options 为 `directory`、`visibility`（默认 encrypted）、`key`、`context` 和可选 `tempRoot`；unpack 还需 `archive`。key 为 64 字符 hex，context 用于绑定生产者身份；public 模式不需要 key。协议由[架构说明](./architecture.md#产物协议)定义。
