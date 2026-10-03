# 架构与执行边界

公开 build repo 内的原生 workflow YAML 同时是 GitHub 的执行定义和 Buildgraph 的依赖图输入。GitHub 负责调度，Buildgraph 只辅助目标选择和产物封装。

| 模块 | 入口 | 责任 |
| --- | --- | --- |
| 构建定义 | [build.yml](../.github/workflows/build.yml) | `workflow_dispatch`、jobs、needs、steps、凭证及发布 |
| Planner | [graph.js](../src/graph.js) | 读取 YAML，校验依赖、检测环、计算目标闭包 |
| Action | [action.yml](../action.yml)、[action.js](../src/action.js) | plan、prepare、pack、unpack，可直接 uses |
| 产物协议 | [artifacts.js](../src/artifacts.js) | tar 打包、加密、认证、受限解包 |
| 本地工具 | [CLI](../bin/buildgraph.js) | 校验、查看计划、生成新密钥 |

## 执行

workflow_dispatch 首先运行 plan job。它 checkout 当前运行版本的中央仓库，读取当前 workflow 文件的 `jobs` 和 `needs`，计算选中目标及其所有上游。输出中不含 planner 自身。工作流的 job-level `if` 使用这个集合决定执行哪些 jobs。

GitHub 的 `needs` 保持原样：公共依赖只有一个 job，独立分支可以并行，汇合节点等待所有直接上游。planner 不解释 steps、env、secrets、矩阵或 job 条件，也不修改正在执行的工作流。读取的是被 checkout 的 YAML；plan 中不要另行 checkout 一个不同于本次执行版本的 ref。

读取使用 YAML 1.2，保留 `on` 键，支持 anchors 和 aliases，拒绝重复键、无效 needs、缺失依赖和循环。GitHub/actionlint 负责完整的工作流语法。Planner 可分析原生矩阵与 reusable workflow job 的外层依赖，但不会展开其内部节点。

构建 job 显式 checkout 私有源码、下载所需上游 artifact、恢复到 inputs，执行构建，再打包 output。目录、认证、变量和权限直接写在 YAML 中。pack 不会自动上传任何文件，上传和发布仍是可见的标准 steps。

## 失败与重跑

示例每个构建 job 都直接依赖 plan。计划失败时不运行构建。checkout、恢复、用户 step 或上传失败时，GitHub 根据 `needs` 跳过下游，独立分支可继续。示例没有用 `always()` 绕过失败传播；自行添加条件或 `continue-on-error` 时遵循 Actions 语义。

没有隐式构建重试、部署回滚或发布事务。需要互斥发布时使用 job 的 `concurrency`。GitHub concurrency 不保证 FIFO，新的等待项可能替换已有等待项。

示例 artifact 名包含 run_id、run_attempt 和 job ID；下游按上游导出的 artifact ID 读取。重跑单个节点可以继续使用同一 run 中未重跑的上游产物。密钥轮换或 artifact 过期后，需要重跑相关上游或全图。

## 产物协议

文件先封装成 portable gzip tar。加密格式是 `BG01 | nonce(12) | tag(16) | ciphertext`，采用 AES-256-GCM。附加认证数据为格式标记加调用方传入的 context；工作流示例用 run、中央仓库 commit 和生产者 job ID 区分产物。

加密完成后才把 archive 路径交给 upload-artifact。恢复时先在临时文件中验证完整认证标签，再检查 archive 路径及类型，最后解包到临时目录并移动到目标。拒绝路径穿越、绝对路径、链接、`.git` 和特殊文件；失败不会暴露恢复了一半的 inputs 目录。

public 模式执行同样的文件封装和路径检查，但不加密。download-artifact 同时校验平台 artifact digest。拥有相同密钥的参与者可以创建有效密文；此机制保护存储内容和传输完整性，不隔离同一密钥的持有者。

## 公开数据与信任边界

公开 repo 的工作流、源码仓库名、运行记录、摘要和日志均可公开读取。已登录且有读取权限的用户可以下载 artifact。加密只保护 artifact 内的内容，不隐藏大小、名称、时间或节点关系。public artifact、Release 和外部部署是显式的数据出口。

Secret 遮罩不会自动隐藏源码、sourcemap 或构建工具打印的上下文。构建命令和第三方 Action 都必须受信任：同一 job 中的代码可能读取 runner 文件或影响后续步骤。不要用携带私有源码凭证的工作流执行不受信任的 PR 代码。

示例采用 GitHub.com 托管 runner。若使用自托管 runner，持久化工作区的隔离与清理需自行承担。中央仓库写权限和 dispatch 权限属于信任边界，真实发布节点应使用预先配置好的 environments。测试 CI 不使用私有源码凭证或真实产物密钥。

## 官方文档

- [Workflow syntax / needs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)：原生依赖与失败传播。
- [workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)：触发和默认分支要求。
- [YAML anchors / reusable workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)：原生复用机制和变量边界。
- [actions/checkout](https://github.com/actions/checkout)：跨私有仓库凭证、persist-credentials。
- [actions/create-github-app-token](https://github.com/actions/create-github-app-token)：安装令牌和权限缩减。
- [下载 artifact](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)：可读性和登录要求。
- [actions/upload-artifact](https://github.com/actions/upload-artifact)：生命周期及文件权限限制。
- [Concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)：等待项的替换规则。
