# 工作流接入

构建图直接保存在 `.github/workflows/*.yml`，使用 GitHub 原生 workflow 语法。以下表格说明每个关注点在 YAML 中的位置。

| 关注点 | 原生配置位置 |
| --- | --- |
| 手动触发、目标、源码 ref | `on.workflow_dispatch.inputs` |
| 构建依赖 | `jobs.<id>.needs` |
| 公共 / 项目配置 | 顶层或 job 的 `env`，以及 `${{ vars.NAME }}` |
| 私有源码 checkout | 普通 `actions/checkout` step 的 `with.repository/ref/token` |
| 构建命令和工具链 | `steps.run`、`steps.uses` |
| runner、并发、矩阵、发布保护 | `runs-on`、`concurrency`、`strategy`、`environment` |
| 权限与凭证 | `permissions`、`${{ secrets.NAME }}` |

## 选择目标

添加一个没有上游依赖的 `plan` job，checkout 当前运行版本的中央 repo，然后读取当前工作流：

```yaml
plan:
  runs-on: ubuntu-latest
  outputs:
    selected: ${{ steps.graph.outputs.selected }}
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      with:
        path: hub
        persist-credentials: false
    - uses: ./hub
      id: graph
      with:
        operation: plan
        workflow: hub/.github/workflows/build.yml
        target: ${{ inputs.target }}
```

每个受目标选择控制的 job 在 `needs` 中直接列出 `plan` 和自己的上游，并添加选择条件：

```yaml
needs: [plan, core]
if: ${{ contains(fromJSON(needs.plan.outputs.selected), 'app') }}
```

条件中的 job ID 要与当前 job 一致。planner 只计算集合；执行、条件和失败传播由 GitHub 处理。直接依赖 `plan` 才能读取 `needs.plan.outputs`。如果工作流提供 `plan_only`，将 `!inputs.plan_only &&` 加入每个构建 job 的条件。

`target` 是以逗号分隔的 job IDs。可在 `on.workflow_dispatch.inputs.target.default` 设置默认值。planner job 默认叫 `plan`；其他名称通过 Action 的 `planner-job` input 指定。planner 本身不能是目标，也不能依赖其他 jobs。

planner 读取静态 `needs`，不执行表达式或递归进入被调用的 reusable workflow。矩阵 job 作为一个节点选择，选中后由 GitHub 展开所有矩阵组合。未选中的 job 只有写了上述条件才会跳过；普通的清理或摘要 job 仍按其原生条件执行。

## 私有源码与 ref

把 [private-projects.yml](../examples/private-projects.yml) 复制到 `.github/workflows/private-projects.yml`，替换 `repository` 和构建命令。在中央 repo 配置 `SOURCE_READ_TOKEN` secret，限定所需源码仓库的 Contents: read 权限。

示例的 `core_ref` 和 `app_ref` 都是普通的 dispatch 字符串输入：

```sh
gh workflow run private-projects.yml -f target=app \
  -f core_ref=<commit-sha> -f app_ref=<commit-sha>
```

checkout 在各自 job 开始时解析 branch/tag；使用 commit SHA 可以锁定整条链路的源码。ref 作为 checkout 的 input 传递，不拼进 shell 命令。源码与中央 repo 分别 checkout 到 `source/` 和 `hub/`，避免覆盖本地 Action。

也可以直接用官方 GitHub App Action 代替 PAT：

```yaml
- uses: actions/create-github-app-token@v3.2.0
  id: source-token
  with:
    client-id: ${{ vars.SOURCE_APP_CLIENT_ID }}
    private-key: ${{ secrets.SOURCE_APP_PRIVATE_KEY }}
    owner: your-org
    repositories: private-core
    permission-contents: read
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
  with:
    repository: your-org/private-core
    ref: ${{ inputs.core_ref }}
    token: ${{ steps.source-token.outputs.token }}
    path: source
    persist-credentials: false
```

生产配置中也应将 App Action 固定到审核后的 commit SHA。App 必须安装在源码仓库所在账号并获授权。若源码使用其他私有仓库的 submodules，令牌也要覆盖这些仓库。所有 secrets 来自中央 build repo，不会自动取得源码仓库的 Actions secrets。

## 公共变量与复用

使用原生顶层 `env` 共享配置，job 或 step 的同名值可以覆盖它。可用仓库 variables 管理跨 workflow 的通用值：

```yaml
env:
  CI: 'true'
  API_ORIGIN: ${{ vars.API_ORIGIN }}
  BUILDGRAPH_INPUTS: ${{ github.workspace }}/inputs
  BUILDGRAPH_OUTPUT: ${{ github.workspace }}/output
```

`BUILDGRAPH_INPUTS` 和 `BUILDGRAPH_OUTPUT` 是示例采用的普通环境变量约定，不是 planner 自动注入的配置。prepare/pack/unpack 通过显式 inputs 接收目录。默认工作目录、shell 等直接使用 Actions 的 `defaults.run`。

示例使用 GitHub 支持的 YAML anchors / aliases 复用 checkout、打包、上传等重复步骤。也可以拆成 composite actions 或 reusable workflows。顶层 env 不会自动传入被调用的 reusable workflow；跨 workflow 复用配置时使用 inputs、vars 和显式 secrets 传递。

## Action inputs

根 [action.yml](../action.yml) 提供四个 operation：

| operation | 输入 | 结果 |
| --- | --- | --- |
| `plan` | `workflow`，可选 `target`、`planner-job` | 输出 `selected`（JSON 数组字符串，供 Actions `fromJSON` 消费） |
| `prepare` | `directory`、`inputs-directory`、`source-directory` | 创建输出 / 输入根目录，在摘要记录源码 commit |
| `pack` | `directory`，可选 `visibility`、`key`、`context` | 输出临时 `archive` 绝对路径；由普通 upload-artifact step 上传 |
| `unpack` | `archive`、`directory`，可选 `visibility`、`key`、`context` | 验证并恢复下载的 artifact；目标目录必须尚不存在 |

产物 visibility 默认 `encrypted`，需提供 64 个 hex 字符的 key 和非空 context。显式 `visibility: public` 上传明文 tar.gz，不需要 key。使用 `secrets.BUILDGRAPH_ARTIFACT_KEY` 传递 key，生产者和消费者必须取得相同值，尤其注意 environment 中的同名 secret 覆盖。

示例 context 为 `<github.run_id>:<github.sha>:<producer-job-id>`，消费者必须填写上游的 ID。矩阵生产者还需要在 context 和 artifact 名中加入唯一的矩阵维度，并为消费者明确列出对应 artifact。不要通过矩阵 job 的单个输出聚合所有子任务产物；GitHub 不保证这个输出代表哪个子任务。

打包包含指定目录里的隐藏文件，保留常规文件的执行权限；拒绝 `.git`、符号链接和特殊文件。需要传递符号链接的工具包时，可先自行打包成普通 archive 文件，再交给 pack。

上游用 job output 导出上传得到的 artifact ID，下游显式下载该 ID。retention、名称、上传/下载选项都在原生 Action step 中配置。长期或匿名分发可通过最后一个 job 发布到中央仓库 Releases；示例使用项目名前缀区分版本。

## CLI

| 命令 | 行为 |
| --- | --- |
| `buildgraph validate [workflow.yml]` | 校验 YAML 与完整 job 依赖图 |
| `buildgraph plan [workflow.yml] --target a,b` | 计算目标闭包，输出可供工具读取的结果 |
| `buildgraph keygen` | 生成新的 artifact 密钥到 stdout，可直接管道传入 `gh secret set` |

默认工作流为 `.github/workflows/build.yml`；`plan` 可用 `--planner-job` 指定 planner 名。CLI 不执行工作流、不改写 YAML。完整 Actions 语法校验使用 actionlint，GitHub 负责最终执行验证。
