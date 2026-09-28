# Loom — Personal Mini App Host (MVP)

个人桌面小工具的统一宿主。外部 Coding Agent 通过 `mini` CLI 完成创建、开发、运行、调试;最终用户通过 Launcher(Command Palette / 托盘)使用。设计文档见 `docs/loom-mvp-prd.md`。

## 结构

```text
host/   Electron 主进程:Registry、Runtime(utilityProcess)、全部 host.* 服务、Launcher、控制通道
sdk/    @mini/sdk:App 使用的统一 API(构建时由 CLI alias 注入,App 无需安装)
cli/    mini 命令行:create / build / dev / run / stop / reload / invoke / logs / validate
apps/   Mini App 目录(一个 App 一个目录,app.yaml 描述)
data/   运行数据:logs / storage / runtime.json(控制通道地址+token)
```

## 快速开始

```bash
npm install
npm run build          # 构建 host + cli

npm run mini -- create hello        # 创建一个 App
npm run mini -- run hello           # 自动拉起 Host + 构建并运行
npm run mini -- invoke hello ping
npm run mini -- logs hello --follow
npm run mini -- dev hello           # watch + 自动 reload
```

Launcher:托盘图标或 `Ctrl+Shift+M`。Host 未运行时,需要 Host 的 CLI 命令会自动拉起它。

## 最重要的一条验收标准

> Coding Agent 从需求到运行结果,除了 OS 必须的权限确认外,不需要操作 Host GUI。
