# Buildgraph maintenance

- `buildgraph.json` owns the demo graph. Edit it and run `npm run generate`; do not hand-edit generated workflows.
- `src/schema.js` owns configuration structure. `npm run build` generates `schema.json` and the committed Action bundle in `dist/`.
- Keep the npm library and GitHub Action behavior identical. The planner must validate the entire graph before checkout credentials are used.
- Preserve dispatch-only build entry points, native `needs` failure propagation, explicit artifact visibility, and producer-scoped artifact IDs.
- Run `npm run build`, `npm run generate`, `npm run check`, and `actionlint -shellcheck=''` for relevant changes. Test artifact protocol changes with tampered input and a real round trip.
- Documentation contracts live in `docs/configuration.md`; architecture and trust boundaries live in `docs/architecture.md`. Link from README rather than duplicating their full contracts.
