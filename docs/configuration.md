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
    - uses: ./hub/plan
      id: graph
      with:
        workflow: hub/.github/workflows/build.yml
        target: ${{ inputs.target }}
```

每个受目标选择控制的 job 在 `needs` 中直接列出 `plan` 和自己的上游，并添加选择条件：

```yaml
needs: [plan, core]
if: ${{ contains(fromJSON(needs.plan.outputs.selected), 'app') }}
```

条件中的 job ID 要与当前 job 一致。planner 只计算集合；执行、条件和失败传播由 GitHub 处理。直接依赖 `plan` 才能读取 `needs.plan.outputs`。如果工作流提供 `plan_only`，将 `!inputs.plan_only &&` 加入每个构建 job 的条件。

Action 和 CLI 识别上述标准条件（可带 `!inputs.plan_only &&`），发现条件中的 ID 不匹配、planner 名错误或缺少直接 planner 依赖时失败，并指出修改位置。直接依赖 planner、但条件缺失或使用其他表达式的 job 会收到 warning；自定义表达式不被求值或禁止。这项检查不保证任意条件都正确，仍需 actionlint 和实际运行验证。

`target` 是以逗号分隔的 job IDs。可在 `on.workflow_dispatch.inputs.target.default` 设置默认值。planner job 默认叫 `plan`；其他名称通过 Action 的 `planner-job` input 指定。planner 本身不能是目标，也不能依赖其他 jobs。

planner 读取静态 `needs`，不执行表达式或递归进入被调用的 reusable workflow。矩阵 job 作为一个节点选择，选中后由 GitHub 展开所有矩阵组合。未选中的 job 只有写了上述条件才会跳过；普通的清理或摘要 job 仍按其原生条件执行。

## 私有源码与 ref

互不相关的项目从 [independent-projects.yml](../examples/independent-projects.yml) 开始，复制到 `.github/workflows/independent-projects.yml`，替换各自的 `repository` 和构建命令。site 与 backup 都只依赖 planner；目标填 site、backup 或 site,backup，分别选择一个或两个项目。它们的 refs、输出与版本互不绑定。

确实存在源码构建依赖时，参考 [private-projects.yml](../examples/private-projects.yml)，复制到 `.github/workflows/private-projects.yml`。以下以这个 core→app 示例说明 refs。两种模板都在中央 repo 配置 `SOURCE_READ_TOKEN` secret，限定所需源码仓库的 Contents: read 权限。

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

`BUILDGRAPH_INPUTS` 和 `BUILDGRAPH_OUTPUT` 是演示采用的普通环境变量约定，不是 planner 自动注入的配置。上传、下载通过 `path` 接收目录，也可以直接写 `source/dist`。Action 的相对路径基于 workspace，不受 `defaults.run.working-directory` 影响；后者只控制 run steps。

示例使用 GitHub 支持的 YAML anchors / aliases 复用 checkout、打包、上传等重复步骤。也可以拆成 composite actions 或 reusable workflows。顶层 env 不会自动传入被调用的 reusable workflow；跨 workflow 复用配置时使用 inputs、vars 和显式 secrets 传递。

## Action inputs

推荐直接 uses 三个独立入口，无须设置 operation：

| 入口 | 输入 | 结果 |
| --- | --- | --- |
| [plan](../plan/action.yml) | 必填 `workflow`；可选 `target`、`planner-job`（默认 plan） | 输出 `selected` 数组字符串，供原生 `fromJSON` 消费 |
| [upload](../upload/action.yml) | 必填 `path`；可选 `visibility`、`key`、`retention-days` | 打包并上传，输出 `artifact-id`、`artifact-name`、`artifact-digest` |
| [download](../download/action.yml) | 必填 `artifact-id`、`path`；可选 `visibility`、`key` | 下载、验证并恢复；输出 `path` 绝对路径 |

上传和下载的 visibility 都默认 `encrypted`，需提供 64 个 hex 字符的 key。双方显式 `visibility: public` 才能传递明文 tar.gz，不自动降级。使用 `secrets.BUILDGRAPH_ARTIFACT_KEY` 传递 key，生产者和消费者必须取得相同值，尤其注意 environment 中的同名 secret 覆盖。

context 和 artifact 名自动生成，不需要配置。每次上传都有唯一名称，矩阵并行上传也不会冲突。消费者只接受同一 run 内的一个 artifact ID，不按名称搜索最新产物；仍需为矩阵消费者明确列出对应 ID。不要通过矩阵 job 的单个输出聚合所有子任务产物，GitHub 不保证这个输出代表哪个子任务。

`path` 是一个目录，不支持 glob。上传目录必须存在且非空；下载目标必须尚不存在，父目录自动创建。`retention-days` 默认 7，0 使用仓库默认值，平台可按仓库上限缩短保留时间。打包和传输的临时文件在成功或失败后清理；runner 被强制终止时仍依赖 runner 的生命周期清理。

打包包含指定目录里的隐藏文件，保留常规文件的执行权限；拒绝 `.git`、符号链接和特殊文件。需要传递符号链接的工具包时，可先自行打包成普通 archive 文件，再交给 pack。

上游用 job output 导出上传得到的 artifact ID，下游显式传入该 ID：

```yaml
outputs:
  artifact_id: ${{ steps.upload.outputs.artifact-id }}
```

传输使用 GitHub Actions 的运行时凭证，不需要另传 token，只支持 GitHub.com 上的当前 run；同一 run 的早期 attempt 产物也可使用。列举采用官方 SDK，最多可查到 1000 个 run artifacts；超过限制时查不到的 ID 会失败，不会换用其他产物。下载 digest 缺失或不匹配时失败。长期或匿名分发可通过最后一个 job 发布到中央仓库 Releases；示例使用项目名前缀区分版本。

根 [action.yml](../action.yml) 保留低层兼容入口：`operation: plan` 使用相同 planner inputs；`prepare` 接收 `directory`、`inputs-directory`、`source-directory`，创建目录并记录源码 SHA；`pack` 接收 `directory`、`visibility`、`key`、显式 `context`，输出临时 `archive`；`unpack` 额外接收 `archive` 并恢复目录。低层 pack/unpack 不负责网络传输，其加密模式必须由调用方传入同一非空 context；不要与新的自动上下文传输混用。

## CLI

| 命令 | 行为 |
| --- | --- |
| `buildgraph validate [workflow.yml]` | 校验 YAML、完整 job 依赖图与标准选择条件接线 |
| `buildgraph plan [workflow.yml] --target a,b` | 计算目标闭包，输出可供工具读取的结果 |
| `buildgraph keygen` | 生成新的 artifact 密钥到 stdout，可直接管道传入 `gh secret set` |

默认工作流为 `.github/workflows/build.yml`；validate 和 plan 均可用 `--planner-job` 指定 planner 名。CLI 不执行工作流、不改写 YAML。完整 Actions 语法校验使用 actionlint，GitHub 负责最终执行验证。
