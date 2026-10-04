# 用 Agent 维护构建中心

日常维护的工作目录是中央 build repo。workflow 是构建定义的唯一来源；先读根目录 [AGENTS.md](../AGENTS.md)，再读本次实际运行的 `.github/workflows/<name>.yml`。不要仅凭 demo 推断真实项目的命令和路径。

默认每个项目都独立，不共享版本，也不汇总到一个产品。只有明确需要消费另一个 job 的产物时，才增加项目间的 `needs`。多个项目共用 runner 配置、secrets 或工具链，不构成构建依赖。新增独立项目应参考 [independent-projects.yml](../examples/independent-projects.yml)。

项目规模增大后，可以在中央 repo 内拆分 workflows。planner 的图边界是一份 workflow；不要用 `needs` 引用另一份 workflow 的 job。跨 workflows 共用配置使用仓库 vars、secrets 和原生复用机制，不假设顶层 env 会自动跨文件继承。

跨组织接入先读[分发接入](./distribution.md)，明确源码、中央构建、每个发布目的地的权限边界。维护者固定接收方信任的 repository/workflow/branch，调用方只传运行与产物标识。request_id 用于关联，不是认证或去重机制。向导产出的 YAML 是普通初稿；提交之后直接维护该文件，不新增 manifest。

## 给 Agent 一个可执行的任务

说明要接入的源码仓库、job ID、依赖的 jobs、源码 ref、runner 和工具链、构建命令、输出目录，以及产物应保持加密还是允许公开。引用现有 secret 名称即可，不要把令牌值或产物密钥贴进任务、提交或运行日志。

独立项目只需 `needs: plan`，不必导出给其他 job 使用的 artifact ID。如果用户明确要求依赖，Agent 应先检查上游真正输出了什么、下游需要放到哪里。新增 `needs` 只创建调度依赖；文件依赖还需要上游导出 `steps.upload.outputs.artifact-id`，下游把它传给 `download`。新增 job 时，`needs` 要直接包含 planner，标准 `if` 中的 job ID 要与当前 job 一致。

共享配置优先复用现有 `env`、仓库 vars 和 secrets。中央源码与私有源码分别 checkout 到 `hub/`、`source/`；Action 的相对 `path` 基于 workspace，`run` 的目录则由 `working-directory` 决定。完整契约在[工作流接入](./configuration.md)，不要在新文件里发明另一套规则。

如果任务只涉及构建链，修改 YAML 和必要的项目构建脚本即可。只有需要改变目标选择、传输或加密行为时，才修改 `src/`、Action metadata 和测试；对应的入口说明在[架构模块图](./architecture.md)。

## 修改后怎样验证

在中央仓库安装 Node.js 24 或更新版本，以及 actionlint。首次准备工作区时运行 `npm ci --ignore-scripts`。下面以私有项目示例为例；把文件名和目标换成实际修改的值：

```sh
node bin/buildgraph.js validate .github/workflows/independent-projects.yml
node bin/buildgraph.js plan .github/workflows/independent-projects.yml --target site
node bin/buildgraph.js plan .github/workflows/independent-projects.yml --target site,backup
actionlint -shellcheck='' .github/workflows/independent-projects.yml
git diff --check
```

选择 site 时应只有 site，选择 site,backup 时才同时包含两者。新增另一个目标时，也检查它的上游集合，并检查一个无关目标，防止错误依赖把无关项目加入构建。CLI 只解析与规划，不会执行源码构建或验证远端凭证；自定义 job 条件仍需要按 GitHub 的语义审查。

修改 Buildgraph 的 JS、Action inputs 或依赖时，额外运行仓库的实现检查。`npm run build` 生成的 `dist/` 必须一起提交，不能直接编辑生成文件：

```sh
npm run build
npm run check
actionlint -shellcheck='' .github/workflows/*.yml examples/*.yml
```

加密或传输行为变更需要覆盖认证失败、错误输入、临时目录清理和真实传递。图文修改检查链接、场景可编辑性和 PNG 阅读效果，不需要为了文案重复触发带私有源码凭证的构建。

修改 Pages 时先读 [界面维护说明](../site/README.md)，运行 `npm run build:site` 和 `node --test test/site.test.js`，用静态服务器预览 `_site/`。检查原生拓扑、筛选与键盘导航，以及四步接入流程的三种分发模式、返回编辑、YAML 下载和 GitHub 编辑入口；在深浅主题与窄屏检查布局，同时验证 catalog 加载失败和公开 API 不可用时的恢复入口。不要把展示目录变成项目配置来源。

跨运行传输改动使用 handoff-test.yml 验证完整 round trip；它只消费合成测试内容，不发布 Release。跨组织 installation 权限仍需在实际组织验证，不能从同仓库测试推断通过。

提交前审阅 diff，尤其是新增的 checkout 仓库、上传目录、`visibility: public`、权限、environment 和 Release 命令。按任务授权提交、推送与 dispatch；验证构建优先选择只构建的目标，不把 `publish` 当成通用测试目标。

新 workflow 首次需要出现在默认分支，才能通过 `workflow_dispatch` 触发。代码可先在分支验证，随后按仓库已有审阅流程合并。已有 workflow 可在 Run workflow 中选择测试分支，但 planner checkout 的 YAML 必须与该次运行版本一致。

## 运行失败，怎样定位

先记录 workflow、run URL、目标、源码 refs 和失败 job。查看第一个失败的 job；下游显示 skipped 往往只是原生 `needs` 的失败传播，不是另一个故障。不要用 `always()` 或 `continue-on-error` 掩盖上游失败。

plan 失败时，检查 job ID、循环依赖、标准选择条件和当前 checkout 的 workflow 路径。checkout 失败时，检查 ref 和令牌是否覆盖正确源码仓库，不输出令牌。download 失败时，核对上游输出的 artifact ID、产物是否过期、双方 visibility 和使用的 secret 名称；不要关闭摘要或认证检查来让它通过。

如果只是瞬时服务故障，可以重跑失败 job。未重跑的上游产物只要仍在同一 run 中、未过期且密钥未变，就可继续使用。产物过期或密钥已轮换时，需要重跑生产者及受影响的下游。修改中央仓库的 workflow 或工具实现后，应发起新的运行；GitHub 的 Re-run 使用原运行的中央仓库 ref/SHA，不能借此验证刚推送的修复。私有源码另行 checkout，branch/tag 可能在重跑时解析到新版本；要复现整条链路，应给私有源码也传入固定 commit SHA。

Agent 的交付应给出修改文件、实际依赖变化、本地校验结果，以及在任务授权了真实运行时的 run URL、执行/跳过节点和产物结果。没有真实运行就明确说未运行，不能把 planner 的输出当成构建通过。

## 图与系统一起维护

[buildgraph.excalidraw](./diagrams/buildgraph.excalidraw) 是 README 架构图的可编辑源文件，[buildgraph.png](./diagrams/buildgraph.png) 是它的导出结果。图表达的是通用拓扑和操作路径，不要求每新增一个业务项目就把它画进去；更改仓库边界、Action 职责或维护路径时才同步图。

将源文件拖入 [Excalidraw](https://excalidraw.com)，修改原生形状、连线和文字。保持私有仓库在公开 repo 边界外，runner jobs 在运行区内。独立项目之间留白、不连依赖边；真实依赖才连线，各项目保留自己的产物出口。不要把所有项目汇合成一个 bundle，也不要把解释段落塞进节点。

保存 `.excalidraw`，全选图形，以白色背景、浅色模式、2× 分辨率导出 PNG，并启用嵌入场景。覆盖对应 PNG 后，在 README 的实际显示宽度检查标签、箭头、裁切和字体，再提交这两个文件。修改 PNG 本身会让源图与 README 分离，应始终从 Excalidraw 重新导出。
