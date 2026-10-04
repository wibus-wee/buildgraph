# Pages workspace

A static workspace for discovering native workflows, inspecting their job dependencies, and preparing a new independent project. The [distribution guide](../docs/distribution.md#pages-工作区) owns onboarding, authorization, and deployment instructions.

| Area | Entry point | Responsibility |
| --- | --- | --- |
| Workspace | [app.js](./app.js), [index.html](./index.html) | Navigation, job inspection, public activity, and the four-step setup flow. |
| Display model | [model.js](./model.js), [site build](../scripts/build-site.js) | Derive a catalog from dispatchable workflows and lay out declared `needs` edges. |
| Workflow draft | [workflow.js](./workflow.js) | Produce reviewable native YAML and required credential names. |
| Visual system | [style.css](./style.css), [icons.js](./icons.js) | Theme tokens, responsive layouts, and the local icon set. |

## Data and state

The site build reads `.github/workflows/*.yml` and emits `_site/catalog.json`. Only workflows with `workflow_dispatch` appear. The catalog contains job IDs, dependency edges, runner descriptions, step labels, and target choices; it excludes command bodies and credential values. Native YAML remains authoritative. The graph shows declared dependencies, including planner control edges; it does not predict expression results, matrix expansion, job execution, or cross-repository topology.

The browser requests the repository’s most recent 30 runs from GitHub’s unauthenticated API. Workflow rows match by workflow path, not display name. “No recent run” means no match in that bounded result, not that a workflow has never run. Network and rate-limit failures keep GitHub links and project setup usable; a failed refresh retains previously loaded activity and labels it as such. A missing catalog has an explicit retry state.

Hash routes preserve the active view, selected workflow/job, filter, and setup step. Draft fields remain in memory when navigating within the workspace; refreshing discards them. Only the theme preference is stored locally. No credentials, form drafts, analytics, or authenticated writes are sent by the site. Opening the GitHub editor intentionally puts the generated YAML in that URL; enter secret names in workflows, never secret values.

## Interaction and visual rules

The overview prioritizes topology; Workflows prioritizes the searchable list. Job nodes are keyboard-operable buttons, with dependencies and steps available as text. Project setup follows Source → Build → Distribution → Review, preserves inputs while moving backward, validates before advancing, and downloads ordinary YAML. Changing toolchains preserves edited commands. GitHub owns submission, review, and execution.

Use Geist for interface text and Geist Mono for identifiers and code. Fonts are self-hosted with their OFL licenses in [fonts/](./fonts/). Neutral surfaces establish hierarchy; the accent marks selection and focus, while run statuses always include a text label. Keep navigation quiet and the current task prominent. Avoid decorative metrics, fake activity, and product-wide release assumptions.

Native links, forms, radios, selects, and dialogs own semantics. Preserve focus on view/step changes, visible keyboard focus, reduced-motion behavior, and browser back navigation. Mobile keeps graph and code scrolling inside their own regions. `/` focuses the workflow filter, `N` opens setup outside text fields, and `⌘K` / `Ctrl K` opens workspace search.

Design references: [Vercel design](https://vercel.com/design), [design.md](https://vercel.com/design.md), [Web Interface Guidelines](https://vercel.com/design/guidelines), and Linear’s official [UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) and [design refresh](https://linear.app/now/behind-the-latest-design-refresh). Their hierarchy, typography, density, and interaction principles inform this interface; Buildgraph keeps its own identity.

## Local verification

```sh
npm run build:site
node --test test/site.test.js
python3 -m http.server 4190 --bind 127.0.0.1 --directory _site
```

Check all three distribution modes through validation, backward navigation, review, copy/download, and the GitHub editor link. Validate downloaded YAML with the Buildgraph CLI and actionlint. Inspect desktop and narrow layouts in both themes, keyboard-only navigation, the command dialog, long names, empty search, and catalog/API failures. Check that unrelated projects gain no graph edges and no synthetic statuses appear. Do not dispatch a release just to test the interface.

`_site/` is generated and ignored. Commit site sources; the Pages workflow builds and deploys them. Agent maintenance starts with [AGENTS.md](../AGENTS.md) and the [maintenance guide](../docs/maintenance.md).
