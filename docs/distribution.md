# 跨组织分发与双向触发

每个项目独立选择目的地：保留在中央仓库，或者从 `my/buildgraph` 发布到多个组织自己的 distribution repo。配置仍是普通 workflow YAML。

| 示例 | 放置位置 | 行为 |
| --- | --- | --- |
| [project-backup.yml](../examples/project-backup.yml) | 中央 repo 的 `.github/workflows/` | 构建 backup；deliver 向指定仓库创建 Release |
| [project-photo.yml](../examples/project-photo.yml) | 中央 repo 的 `.github/workflows/` | 构建 photo；deliver 分别触发两个组织的 publish.yml |
| [request-build.yml](../examples/request-build.yml) | 分发 repo 的 `.github/workflows/` | 请求中央 photo 构建，并等待对应运行 |
| [publish.yml](../examples/publish.yml) | 每个 photo 分发 repo 的 `.github/workflows/` | 校验产物来源、解密，再发布到自己仓库 |

## 选择并接入分发方式

直接发布只需复制 project-backup.yml，替换源码、命令和 matrix 中的目的地。目标仓库可以没有 workflow，但需要已有默认分支。中央 job 用目标令牌创建 Release；省略 `--target` 使用分发仓库的默认分支，不能把中央 SHA 当作另一个仓库的 tag 目标。

需要每个组织自行审批、签名或发布时，复制 project-photo.yml 到中央 repo，把 publish.yml 放到每个目的地。替换 `my/buildgraph`、源码、目的地及接收端固定的 `source-workflow`。接收端示例 checkout Buildgraph 的 main 便于首次接入；生产环境将它固定为审核后的 Buildgraph commit SHA。

中央模板默认 `target=build`，只保存加密产物；`target=deliver` 才公开分发。配置中央和接收端的 `production` environment，在 GitHub Settings 中设置所需审批规则；仅在 YAML 写 environment 名字不会启用审批。

同一项目的多个目的地使用原生 matrix，`fail-fast: false` 允许分别完成。不同产品使用独立 workflow 或 jobs，版本、产物和发布互不绑定。

## 跨组织授权

中央仓库用 `SOURCE_READ_TOKEN` 读取源码、`BUILDGRAPH_ARTIFACT_KEY` 加密产物。分发另外配置 `DISTRIBUTION_APP_CLIENT_ID` variable 与 `DISTRIBUTION_APP_PRIVATE_KEY` secret。把该 App 安装到各目标组织，只授权必要仓库。直接 Release 需要 Contents: write；dispatch 需要 Actions: write。每个 matrix job 按 owner 取得对应 installation token，一个组织的 token 不会自动覆盖其他组织。

远端 publish.yml 使用 `BUILD_APP_CLIENT_ID`、`BUILD_APP_PRIVATE_KEY`，App 在中央仓库的安装需要 Actions: read；同时使用 request-build.yml 时还需要 Actions: write。接收方取得与生产者相同的产物密钥；可按项目使用不同 secret 名称，避免所有项目共享解密能力。直接接收 Release 的仓库不需要该密钥。

默认 `GITHUB_TOKEN` 只覆盖当前 repo。跨 repo 操作使用 App token，publish.yml 发布到自己仓库才使用自身 `GITHUB_TOKEN`。

## 双向 workflow_dispatch

分发仓库运行 request-build.yml → 中央 project-photo.yml 的 deliver 目标 → 各目的地 publish.yml。中央等待发布完成，最初的请求再取得中央结果。每一跳都是 workflow_dispatch。

`request_id` 关联运行名称和日志，不是凭证，也不保证去重。请求和发布采用不同入口，发布入口不会再请求构建。相互等待的 workflows 不能共用阻塞彼此的 concurrency group。`needs` 仍只连接同一 workflow，跨 workflow 等待由 dispatch step 完成。

### dispatch Action

```yaml
- uses: ./hub/dispatch
  id: remote
  with:
    repository: org-a/photo-distribution
    workflow: publish.yml
    ref: main
    token: ${{ steps.destination.outputs.token }}
    wait: 'true'
    inputs: |
      source_run_id: ${{ toJSON(github.run_id) }}
      artifact_id: ${{ toJSON(needs.build.outputs.artifact_id) }}
      artifact_digest: ${{ toJSON(needs.build.outputs.artifact_digest) }}
      request_id: ${{ toJSON(inputs.request_id || github.run_id) }}
```

必填 repository、workflow 文件名、ref 和 token。inputs 是原生 dispatch inputs 的 YAML mapping，最多 25 个 string、boolean 或有限 number，不接受嵌套结构、null 和重复键。动态字符串用 `toJSON` 引用，防止换行或冒号改变 YAML 结构。不要把 secret 作为 dispatch input 传输。

Action 使用 GitHub.com API `2026-03-10` 取得精确的 workflow_run_id，不搜索“最新运行”。输出 `run-id`、`run-url`。wait 默认 false；true 时每 10 秒查询同一 run，输出 conclusion，仅 success 通过。timeout-seconds 默认 1800，范围 1–21600；外围 job 超时和 token 有效期也必须足够。

POST 不自动重试。网络错误或缺少 run ID 时，请求可能已经送达，先查看目标 Actions 再决定是否重发。等待超时、API 错误或取消调用方都不会取消远端运行，也不表示发布未发生。

## 接收跨运行产物

download 的当前运行模式不变。跨运行需同时传入 source-repository、source-run-id、source-workflow、source-branch 和具有源仓库 Actions: read 的 token。仍需 artifact-id、path、visibility 和所需 key；expected-digest 可额外绑定生产者 upload 返回的 SHA-256。

接收方把 repository、workflow 路径和 branch 固定在可信 YAML 中，不由请求方任意指定。Action 检查 run ID、workflow 路径、branch、head repository 和 workflow_dispatch 事件；检查 artifact 属于该 run、head SHA 一致且尚未过期。source-branch 仅支持分支，不支持 tag。

解密上下文来自 GitHub 返回的生产者 repo、run ID、SHA 和 artifact 名称，不使用接收方运行上下文。平台 digest、可选 expected-digest、加密认证及受限解包都必须通过。

生产者可能正在等待接收方，因此不要求整个来源 run 已结束；已上传的产物可以消费。这不保证来源运行最终成功或业务构建正确。可信分支、workflow 编辑和 dispatch 权限仍由仓库管理；共享密钥持有者也不因加密而互相隔离。

## 重跑与部分成功

没有跨组织发布事务或 exactly-once 保证。示例用生产者 run ID 组成 Release tag；同一 run 重跑时，已存在的 Release 会让创建失败，不会被覆盖。先核对 Release 和原运行，再补发失败目的地或发起新构建。

某目的地失败不会撤销其他目的地的发布。concurrency 只限制并发，不是持久化去重队列；GitHub 还可能替换等待中的运行。

[handoff-test.yml](../.github/workflows/handoff-test.yml) 用合成内容验证加密上传、dispatch、跨运行下载和等待，不创建 Release。接收端固定信任该 workflow 的 main 分支。同仓库测试不能代替各组织 App installation 的权限验证。

## Pages 工作区

[Pages](https://wibus-wee.github.io/buildgraph/) 的 Overview 展示所选 workflow 的原生 jobs/needs 拓扑，点击节点查看 runner、步骤和直接依赖。Workflows 支持按名称、文件名和 target 筛选；Run history 读取公开 API 最近 30 次运行。拓扑表示声明的依赖，不表示本次执行状态，也不会把不同 workflow 或独立项目连成一个产品。

点击 New project，依次填写 Source、Build、Distribution，在 Review 检查 YAML 和需要配置的 secret/variable 名称。可复制、下载或跳转 GitHub 新建文件；用户在 GitHub 提交或发起 PR，审阅后加入默认分支。返回前一步保留输入，刷新会丢弃草稿。页面不接收 token、不自动提交、不直接 dispatch；仅保存主题偏好。

源码与界面维护说明在 [site/](../site/)，`npm run build:site` 输出 `_site/`。catalog.json 是从实际 workflows 派生的展示数据，不是需要维护的配置。向导不会覆写已有 workflow；后续直接修改 YAML。页面显示的是当前站点所属构建仓库的工作流；表单填写其他 build repo 不会切换该目录。

Fork 后在 Settings → Pages 将 Source 设为 GitHub Actions，再运行 Pages workflow。默认监听 main；若使用其他默认分支，同时修改 pages.yml 的 push 分支，并为站点构建设置 SITE_BRANCH。公开 API 限流或不可用时，仍可通过 GitHub 链接查看状态并使用 YAML 向导。

需要页面内登录、自动开 PR 或 dispatch 时，再接 GitHub App 后端处理认证与项目授权。不要把 App 私钥、共享 PAT 或产物密钥嵌入页面。新项目命令和分发目的地必须经可信维护者审阅后才能使用中央 secrets。

## GitHub 文档

[Dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[Artifact API](https://docs.github.com/en/rest/actions/artifacts)、[Installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)、[Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)。
