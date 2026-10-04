# Buildgraph maintenance

Read [the maintenance workflow](docs/maintenance.md) before changing a user's build chain. Read the actual workflow being changed; the demo is not the source of truth for another workflow.

- Each hand-written `.github/workflows/<name>.yml` is authoritative for its own graph; `build.yml` is the demo. Edit native Actions `jobs`, `needs`, and `steps` directly. Do not add a separate manifest, configuration DSL, or workflow generator.
- `src/graph.js` reads native job IDs and `needs` for target planning. Wiring diagnostics recognize the documented selection condition; they do not evaluate expressions. Leave steps, matrices, environments, permissions, and expression semantics to GitHub and actionlint.
- `npm run build` produces the committed Action bundle in `dist/`. Keep the npm library and GitHub Action behavior identical.
- Preserve dispatch-only build entry points, native `needs` failure propagation, explicit artifact visibility, and producer-scoped artifact IDs.
- Treat projects as independent by default. Add build dependencies only when one project actually consumes another's result; sharing a build repo does not imply a shared product, bundle, release, or version.
- Run `npm run build`, `npm run check`, and `actionlint -shellcheck='' .github/workflows/*.yml examples/*.yml` for relevant changes. Test artifact protocol changes with tampered input and a real round trip.
- Documentation contracts live in `docs/configuration.md`; architecture and trust boundaries live in `docs/architecture.md`. Link from README rather than duplicating their full contracts.
- `docs/diagrams/buildgraph.excalidraw` owns the README drawing. Update its native elements and export `buildgraph.png` together when architecture changes; inspect the PNG at README width. Keep the drawing spatial and diagrammatic, with short labels instead of prose cards.
