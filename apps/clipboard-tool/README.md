# Clipboard Tool

Choose Clean spacing or Format lines, then explicitly apply to the current text clipboard. CLI commands `clean` and `format` perform the same action: `npm run mini -- invoke clipboard-tool clean`. No background clipboard listener, network access, or stored text is used. Only the chosen mode is persisted; logs contain operation type and changed status, never clipboard content. Avoid processing confidential clipboard data in any tool.

From the repository root, build with `npm run mini -- build clipboard-tool`, check with `npm run mini -- validate clipboard-tool`, and start with `npm run mini -- run clipboard-tool`. Notifications are best-effort and do not prove the clipboard update succeeded. A disabled App must be enabled through the management center or `mini enable clipboard-tool`; validation checks static manifest/artifact consistency, not actual clipboard or notification behavior on Windows.
