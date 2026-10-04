# Buildgraph maintenance

- `.github/workflows/build.yml` is the authoritative, hand-written graph. Edit native Actions `jobs`, `needs`, and `steps` directly. Do not add a separate manifest, configuration DSL, or workflow generator.
- `src/graph.js` reads native job IDs and `needs` for target planning. Wiring diagnostics recognize the documented selection condition; they do not evaluate expressions. Leave steps, matrices, environments, permissions, and expression semantics to GitHub and actionlint.
- `npm run build` produces the committed Action bundle in `dist/`. Keep the npm library and GitHub Action behavior identical.
- Preserve dispatch-only build entry points, native `needs` failure propagation, explicit artifact visibility, and producer-scoped artifact IDs.
- Run `npm run build`, `npm run check`, and `actionlint -shellcheck='' .github/workflows/*.yml examples/private-projects.yml` for relevant changes. Test artifact protocol changes with tampered input and a real round trip.
- Documentation contracts live in `docs/configuration.md`; architecture and trust boundaries live in `docs/architecture.md`. Link from README rather than duplicating their full contracts.
