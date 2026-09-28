# Screen Inspector

Refresh display metadata and enter a small rectangle fully inside one display. Capture is initiated only by the Capture region button. The captured PNG data URL stays in the window for preview, is not exported or persisted, and never enters logs or storage. The last rectangle is saved in app-scoped storage. There is no mouse click, OCR, network request, Python dependency, or automatic capture.

From the repository root, build with `npm run mini -- build screen-inspector`, check with `npm run mini -- validate screen-inspector`, and start with `npm run mini -- run screen-inspector`. The CLI `monitors` command lists displays (`npm run mini -- invoke screen-inspector monitors`). A disabled App must be enabled through the management center or `mini enable screen-inspector`. Validation checks static manifest/artifact consistency only; Windows mixed-DPI and negative-origin capture accuracy still requires real desktop testing.
