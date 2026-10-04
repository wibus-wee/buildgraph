# Bundled dependency notices

The build reads license files from the installed packages that esbuild includes in the Action bundle. These files preserve notices for packages that omit a standalone license file from their npm tarball:

| Package | Source |
| --- | --- |
| `@nodable/entities` 3.1.0 | [upstream license](https://github.com/nodable/val-parsers/blob/main/LICENSE) |
| `binary` 0.3.0 | [GitHub Action dependency notice](https://github.com/actions/download-artifact/blob/v8.0.1/.licenses/npm/binary.dep.yml) |
| `chainsaw` 0.1.0 | [GitHub Action dependency notice](https://github.com/actions/download-artifact/blob/v8.0.1/.licenses/npm/chainsaw.dep.yml) |
| `buffers` 0.1.1 | Package metadata attribution; the package does not declare a license |

`isarray` carries its full license in its installed README. Regenerate `dist/licenses.txt` with `npm run build`; review these source notices when upgrading their packages.
