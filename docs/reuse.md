# 在其他构建中心复用

| 方式 | 适用情况 |
| --- | --- |
| Fork 本仓库 | 直接把此仓库变成自己的公开 build hub，默认使用 `./hub` Action |
| 安装 JS 库和 CLI | 已有公开 build repo，需要生成其中的 workflow |
| `uses: wibus-wee/buildgraph@<SHA>` | 执行 planner 或 pack/unpack；生成的工作流会自动插入这些调用 |

## 生成远程 Action 工作流

项目尚未发布到 npm registry，可按 commit 从 GitHub 安装。在你的中央 build repo 根目录执行，替换 `<SHA>` 为已审核的 40 位 commit SHA：

```sh
npm install --save-dev github:wibus-wee/buildgraph#<SHA>
npx buildgraph compile buildgraph.json \
  --action-ref wibus-wee/buildgraph@<SHA> \
  --output .github/workflows/build.yml
```

提交配置、lockfile 和生成的工作流。生成物会 checkout 你的中央 repo 到 `hub/`，从远程 commit 加载 Buildgraph Action；source、secrets、variables 和 Releases 都属于你的中央 repo。构建仍在你的公开 repo 中运行，不会调用本项目仓库的 workflow。

更新 library 和 Action 时使用同一个 SHA，再重新生成 YAML。远程模式不需要把本项目源码或 bundle 复制进你的 repo；`check` 必须使用与 `compile` 相同的 `--action-ref`。

## JS API

```js
import { readManifest, plan, compile } from '@wibus-wee/buildgraph';

const graph = await readManifest('buildgraph.json');
const execution = plan(graph, { target: 'app', refs: { core: '<commit-sha>' } });
console.log(execution.selected);

const yaml = compile(graph, {
  manifestPath: 'buildgraph.json',
  actionRef: 'wibus-wee/buildgraph@<40-character-commit-sha>',
});
```

| 导出 | 契约 |
| --- | --- |
| `validate(manifest)` | 校验结构及完整图，成功返回原对象；不修改输入，失败抛 Error |
| `readManifest(file)` | 异步读取 JSON 并校验 |
| `plan(manifest, options?)` | 返回 `{targets, selected, refs, digest}`；selected 为去重的拓扑序，只包含目标闭包 |
| `order(manifest)` | 校验后返回全图拓扑序 |
| `digest(manifest)` | 对 JSON 序列化结果计算 SHA-256；本身不做校验 |
| `compile(manifest, options?)` | 返回 YAML 字符串，不写文件；选项见上例 |
| `pack(options)` | 异步打包，返回临时 archive 绝对路径；上传完成后调用者可清理其父目录 |
| `unpack(options)` | 异步认证并恢复到尚不存在的目录，返回最终目录路径；失败抛错并清理临时内容 |

pack/unpack 选项为 `directory`、`visibility`（默认 encrypted）、`key`、`context` 和可选 `tempRoot`；unpack 额外需要 `archive`。key 为 64 位 hex 字符串，context 标识这份产物的 run、配置和生产者。公共模式不需要 key。具体格式及安全边界由[产物协议](./architecture.md#产物协议)定义。

## 直接使用 planner Action

```yaml
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
    with:
      persist-credentials: false
  - uses: wibus-wee/buildgraph@<40-character-commit-sha>
    id: graph
    with:
      operation: plan
      manifest: buildgraph.json
      target: app
      refs: '{}'
```

planner 的 `selected` 和 `refs` outputs 是 JSON 字符串，`digest` 是配置 SHA-256。此 Action 仅计算执行计划；要获得实际 job DAG，使用编译器生成 workflow。其余 operation inputs 见 [action.yml](../action.yml)，通常由编译器填写。
