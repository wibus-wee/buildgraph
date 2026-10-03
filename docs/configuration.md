# 配置参考

[JSON Schema](../schema.json) 与运行时校验来自同一份 [schema.js](../src/schema.js)。JSON 中使用 `$schema` 字段可获得编辑器补全。未知字段会报错。

## 顶层

| 字段 | 契约 |
| --- | --- |
| `version` | 必须为 `1` |
| `name` | Actions 工作流名称 |
| `defaultTarget` | 默认目标节点，必须存在 |
| `nodes` | 1–200 个节点，以节点 ID 为键 |
| `defaults` | 公共 runner、超时、env、auth 和产物密钥 secret 名 |
| `auth` | 可复用的源码认证配置，以 profile ID 为键 |

节点 ID 和 profile ID 以小写字母开头，只含小写字母、数字、下划线，最长 48 字符。`plan` 和 `bg_` 前缀保留给编译器。

## 默认值与变量

| `defaults` 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `runner` | `ubuntu-latest` | 节点默认 runner |
| `timeoutMinutes` | `30` | 单个节点最大运行时间，范围 1–360 |
| `env` | `{}` | 公共字符串环境变量；节点同名值覆盖默认值 |
| `auth` | 无 | source 默认使用的认证 profile；未设置时使用当前 job 的 `github.token`，适用于公开源码 |
| `artifactKeySecret` | `BUILDGRAPH_ARTIFACT_KEY` | 包装、恢复加密产物时读取的 secret 名称 |

runner 支持 `ubuntu-latest`、`ubuntu-24.04`、`ubuntu-22.04`、`macos-latest`、`macos-15`、`macos-14`、`windows-latest`、`windows-2025`、`windows-2022`。此版本面向 GitHub.com 的托管 runner；不支持 GHES、自托管 runner、container 或矩阵节点。

`env` 支持 GitHub 表达式，例如 `"API_ORIGIN": "${{ vars.API_ORIGIN }}"`。公共配置放在 build repo 的 variables 即可，不需要组织账号。机密配置使用 `secrets`，并尽量限定在真正需要它的 step 上。共享默认 env 不会传给 plan job。

节点和默认 env 不能覆盖 `BUILDGRAPH_*`、`GITHUB_*`、`RUNNER_*` 和 `NODE_OPTIONS`。构建可读取以下路径，路径均为绝对路径：

| 自动变量 | 内容 |
| --- | --- |
| `BUILDGRAPH_NODE` | 当前节点 ID |
| `BUILDGRAPH_HUB` | 本次 checkout 的 build repo，包含配置、脚本 |
| `BUILDGRAPH_INPUTS` | 依赖产物根目录；直接上游的输出位于 `<根目录>/<节点 ID>` |
| `BUILDGRAPH_OUTPUT` | 本节点要导出的专用目录，运行 steps 前已创建 |

## 节点

| 字段 | 契约 |
| --- | --- |
| `needs` | 直接依赖节点 ID 数组，默认 `[]`；不允许环、重复或不存在的节点 |
| `source` | 可选源码仓库；未设置时，run steps 在 build hub 中执行 |
| `steps` | 必须至少一个 GitHub Actions step，`run` 或 `uses` 二选一 |
| `output` | 可选输出声明；存在则打包 `BUILDGRAPH_OUTPUT`，为空目录会失败 |
| `runner` / `timeoutMinutes` / `env` | 覆盖公共默认值 |
| `environment` | 可选 GitHub environment 名称，如 `production`；必须按预期预先配置保护规则 |
| `permissions` | job 的 `GITHUB_TOKEN` 权限；默认 `contents: read`，其余权限未授予 |
| `concurrency` | 可选固定资源名，生成 `cancel-in-progress: false`，适用于同一发布目标 |

`steps` 支持 `name`、`id`、`run`、`uses`、`shell`、`working-directory`、`if`、`env`、`with`、`continue-on-error`、`timeout-minutes`。steps 本身是受信任的工作流代码，使用 Actions 的表达式规则。自定义 step ID 不能使用 `bg_` 前缀。

run steps 默认 shell 为 `bash`，有 source 时默认工作目录为 `source/`，否则为 `hub/`。`uses` 的相对路径仍以 workspace 为根，例如 `./hub/.github/actions/custom`。工具链安装也是普通 step，可以使用 setup-node、setup-python 等 Action；请固定第三方 Action 的 commit SHA。

只有直接 `needs` 且声明 output 的节点会被下载到 inputs。祖先节点的产物不会自动透传；需要时把它明确加入 `needs`。不存在隐式依赖推断、增量缓存或自动版本计算。

## 源码

`source` 必须包含 `repository: "owner/repo"` 和 `ref: "branch、tag 或 commit SHA"`。可选 `auth` 指定 profile；`fetchDepth` 默认 `1`，`0` 获取完整历史；`submodules` 默认为 `false`，可为 `true` 或 `"recursive"`；`lfs` 默认 `false`。

checkout 使用 `persist-credentials: false`，运行摘要记录实际源码 commit。分支和 tag 在各自 job checkout 时解析，不在 plan 时锁定；要固定全图源码，使用每个 source 节点的 commit SHA。手动输入 refs 不允许表达式或换行。

## 认证

GitHub App profile：

```json
{
  "type": "app",
  "clientIdVariable": "SOURCE_APP_CLIENT_ID",
  "privateKeySecret": "SOURCE_APP_PRIVATE_KEY"
}
```

App 安装在源码仓库所在账号，授权所需仓库的 Contents: read。client ID 放 build repo 的 Actions variable，私钥放其 Actions secret。每个 source job 申请仅覆盖该仓库的 Contents: read 令牌，并由官方 create-github-app-token Action 在 job 结束时撤销。对于跨私有仓库 submodules，单仓库 App token 不足以访问其他仓库；此时使用授权所有所需 submodule 仓库的 PAT profile。

Fine-grained PAT profile：

```json
{ "type": "token", "tokenSecret": "SOURCE_READ_TOKEN" }
```

PAT 放在 build repo 的 Actions secret 中，限定需要的源码仓库和 Contents: read。所有认证只从中央仓库读取；不会读取源码仓库自身的 Actions secrets。

## 产物

| `output` 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `visibility` | `encrypted` | `encrypted` 上传 AES-256-GCM 密文；`public` 上传明文 tar.gz |
| `retentionDays` | `7` | Actions artifact 保留 1–90 天，仍受仓库策略限制 |

密钥必须是 32 字节的 hex 编码（64 字符）。`buildgraph keygen` 生成新密钥，但不保存。生产者和消费者必须使用同一密钥；environment secret 不能用不同值意外覆盖同名密钥。密钥轮换后历史密文不能用新密钥恢复，部分 job 重跑也可能受影响。

打包会包含输出目录内的隐藏文件，保留常规文件的执行权限；拒绝 `.git`、符号链接和特殊文件。需要分发符号链接的工具包时，先在构建 step 内自行打包成普通 archive 文件，再放入输出目录。默认打包格式及信任边界见[架构说明](./architecture.md#产物协议)。

输出 artifact 名为 `bg-<run_id>-<run_attempt>-<node>`，内含 `output.bgenc` 或 `output.tar.gz`。下游按上游 job 输出的 artifact ID 精确下载，不按最新名称匹配。最终 artifact 有保留期限；需要长期或匿名下载时，用发布节点将选定文件上传到中央仓库 Releases 或其他托管服务。

## CLI

在仓库根目录执行 `node bin/buildgraph.js <命令>`；作为依赖安装后可以用 `buildgraph`。

| 命令 | 行为 |
| --- | --- |
| `validate [file]` | 校验整个图，即使部分节点不在当前目标链路中 |
| `plan [file] --target a,b --refs '{"a":"SHA"}'` | 输出目标、拓扑顺序、源码 refs 和配置 digest；不构建 |
| `compile [file] --output path` | 生成 dispatch 工作流，默认输出 `.github/workflows/build.yml` |
| `check [file] --output path` | 校验工作流是否与当前配置及编译器一致；不改文件 |
| `keygen` | 向 stdout 输出新加密密钥，可直接管道传入 `gh secret set` |

默认配置文件为 `buildgraph.json`。compile/check 可传 `--action-ref owner/repo@<40 位 commit SHA>` 来使用远程 Action，默认 `./hub` 使用中央仓库内提交的 Action bundle。配置文件路径必须位于当前 build repo 中。

编译后的 dispatch inputs 为 `target`、`refs` 和 `plan_only`。工作流必须先存在于默认分支，才可通过 `workflow_dispatch` 触发。`plan_only=true` 只运行无源码凭证的 plan job。
