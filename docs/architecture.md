# 架构与执行边界

Buildgraph 将公开 build repo 作为构建控制中心。源码仓库、GitHub 托管 runner 和最终发布目标由图连接；GitHub 负责调度 jobs，Buildgraph 负责校验、生成和产物封装。

| 模块 | 入口 | 责任 |
| --- | --- | --- |
| 配置契约 | [schema.js](../src/schema.js)、[graph.js](../src/graph.js) | 结构校验、环检测、目标闭包、ref 覆盖 |
| 编译器 | [compiler.js](../src/compiler.js) | 生成静态 job DAG、认证步骤、产物下载与上传 |
| Action | [action.yml](../action.yml)、[action.js](../src/action.js) | plan、prepare、pack、unpack；提交的 bundle 可直接 uses |
| 产物协议 | [artifacts.js](../src/artifacts.js) | tar 打包、加密、认证、受限解包 |
| 本地工具 | [CLI](../bin/buildgraph.js) | 验证、计划、编译、检查生成文件、生成密钥 |

## 编译与执行

配置中的每个节点生成独立 job。`needs` 在工作流开始之前就确定，因此图修改后必须重新生成并提交 YAML；运行中不会动态添加 jobs，也没有轮询其他 workflow 或额外 dispatch 链。

每次 `workflow_dispatch` 首先运行 plan job。它校验整个图，再计算目标及其所有上游节点，输出所选 ID 数组和 source refs。每个生成的节点 job 同时依赖 plan 和其直接上游，并根据选中集合决定是否执行。公共依赖只出现一个 job，图中独立分支交给 GitHub 并行调度。

plan 会比较当前配置 digest 和工作流内记录的 digest，拒绝配置已经修改但工作流未更新的运行。CI 的 `check` 还会发现编译器更新后 YAML 未重新生成。digest 使用解析后的 JSON 序列化结果，忽略空白但保留属性顺序。

节点先 checkout 中央仓库及可选源码，再恢复上游产物，执行用户 steps，最后封装输出。所有需要传递的文件都必须显式写入独立的 output 目录。工作区及明文中间文件只保存在该节点的托管 runner 上；节点之间通过 artifact 传输。

## 失败与重跑

plan 失败时不运行构建节点。源码 checkout、恢复、用户 steps 或上传失败时，该 job 失败，GitHub 的 `needs` 规则跳过下游，其他独立分支可以继续。生成的节点不会用 `always()` 绕过依赖失败。用户 steps 自行指定的 `continue-on-error` 遵循 GitHub 原有语义。

没有构建自动重试、部署回滚或事务。发布节点要自行设计可重入操作，并用 `concurrency` 限制同一资源的并发发布。GitHub concurrency 不是完整 FIFO 队列：即便不取消正在执行的 job，新的等待项也可能替换已有等待项。

同一次 run 的重跑使用 `run_attempt` 创建新的 artifact 名称，消费者通过上游的 artifact ID 读取结果；成功且未重跑的上游可继续提供原产物。若 artifact 已过期或密钥已轮换，需要重跑对应上游或整个工作流。

## 产物协议

普通文件先被封装成 portable gzip tar，常规执行权限保留。加密格式为 `BG01 | nonce(12) | tag(16) | ciphertext`，使用 AES-256-GCM。附加认证数据包含格式版本，以及调用方传入的 `run_id:manifest_digest:producer_id`；不同生产者或配置的密文不能互换。

加密在上传前完成；密钥只通过 pack/unpack Action inputs 注入，不放入工作流输出、artifact 或默认构建 env。恢复时先在临时文件中验证完整认证标签，然后检查 archive 路径、条目类型，再解包到临时目录并移动到目标。拒绝路径穿越、绝对路径、链接、`.git` 和特殊文件。目标目录必须尚不存在，失败时不会暴露一个恢复了一半的 inputs 目录。

公开模式也执行相同的文件封装和解包检查，但不加密。Actions download-artifact 同时检查平台提供的 artifact digest。加密密钥持有者仍然可以生成有效密文，因此加密提供存储保密与传输完整性，不在有相同权限的构建参与者之间建立隔离。

## 公开数据与信任边界

公开 build repo 的工作流、配置、仓库名、运行记录、日志和摘要是公开信息。公开仓库的 artifact 可被有读取权限且已登录 GitHub 的用户下载；`encrypted` 模式只使其中的内容成为密文，不隐藏 artifact 大小或节点关系。标记 `public`、上传 Release 或向外部部署是明确的公开出口。

Secrets 的日志遮罩不会自动隐藏源码、仓库名、sourcemap 或构建工具打印的上下文。配置和源码中的命令都必须受信任；构建脚本与 Action 在同一 job 上运行，恶意代码可能读取同一 runner 的文件或影响后续步骤。这个方案不适合执行不受信任的任意仓库或 PR 代码。

构建入口只有 `workflow_dispatch`，仓库写权限及 dispatch 权限属于信任边界。保护中央仓库分支，并在真实发布节点使用事先配置好的 environments。测试用 CI 可以处理 `pull_request`，但不使用任何源码访问凭证或真实 artifact 密钥。

## 官方文档依据

- [Workflow syntax / needs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)：依赖成功后执行，以及失败、跳过的传播规则。
- [workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)：手动/API 触发和默认分支要求。
- [actions/checkout](https://github.com/actions/checkout)：跨私有仓库凭证和 persist-credentials。
- [actions/create-github-app-token](https://github.com/actions/create-github-app-token)：安装令牌的仓库范围和权限缩减。
- [下载工作流 artifact](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)：artifact 可读性及登录要求。
- [actions/upload-artifact](https://github.com/actions/upload-artifact)：artifact 生命周期、权限保留限制和打包行为。
- [Concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)：等待运行的替换行为。
