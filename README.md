# DeepSeek Harness 桌面客户端

把 DeepSeek Harness 的浏览器 UI 封装成一个独立的 Windows 桌面客户端：应用启动时自动拉起 `dsh web` 服务，并在原生窗口里展示界面。你不再需要手动开终端、跑命令、再开浏览器。

> 环境依赖：Windows 上**默认**需要 [Node.js](https://nodejs.org/)（服务以**系统 Node** 作为子进程运行）。如果你没装 Node.js，客户端在启动时会**检测并引导你安装**：既可自动下载便携版 Node（免管理员权限，下载到用户目录），也可指定已有的 node.exe。

## 功能

- 自动启动 / 停止 `dsh web` 服务（`--no-open`，不抢浏览器）。
- **Node.js 检测与安装**：
  - 启动时自动检测可用 Node：配置 `nodeBin` → 环境变量 `DSH_CLIENT_NODE` → 客户端自带的便携版缓存 → 系统 PATH。
  - 都没找到时弹窗让你选：**自动下载并安装便携版 Node.js（推荐）** / **选择已有的 node.exe** / 退出。
  - 自动安装过程有进度条；装好后写入 `config.json`，之后直接复用。
  - 托盘与菜单提供“检查 / 安装 Node.js”，随时重测或重装。
- 智能端口策略：
  - 首选端口（默认 `3080`）上**已有** DSH 服务 → 直接“挂接”复用，不再重复启动；
  - 首选端口被**其它**程序占用 → 自动换一个空闲端口；
  - 没有现成服务 → 自己启动一个。
- 关闭窗口即退出并清理服务进程（含子进程树）。
- 服务意外退出时提示重启。
- 系统托盘 + 中文菜单：打开主界面 / 重启服务 / 检查 Node.js / 打开工作区 / 打开日志 / 退出。
- 单实例锁，避免多个客户端互相抢端口。
- **插件可选安装**：安装向导中提供「安装内置插件（推荐）」勾选项，在**正式安装完成之前**决定并随配置生效（写入 `plugin-choice.json`）；便携版 / 开发模式无安装向导，改为首次启动时询问一次。
- **开机自启**：菜单中一键开启/关闭跟随系统登录自动启动（打包环境写入 Windows 登录项）。
- **配置变更引导**：修改远程访问等需要重启才生效的配置后，一键「立即重启服务」使其生效。

## 目录结构

```
├── main.js            Electron 主进程（窗口、托盘、菜单、服务生命周期、Node 检测/安装）
├── preload.js         主窗口安全桥（contextIsolation）
├── progress-preload.js 安装进度窗口的安全桥
├── lib/dsh-server.js  启动/挂接 dsh 服务的共享逻辑（含 Node 下载/解压/检测）
├── scripts/
│   ├── smoke.js       无 Electron 的端到端冒烟测试
│   └── make-icon.ps1  生成 build/ 下的应用/托盘图标
├── build/             图标（icon.ico / icon.png）+ 安装向导自定义页（installer.nsh）
├── assets/            运行时资源（tray.png 托盘图标）
└── package.json       electron-builder 打包配置
```

## 本地运行（开发）

```powershell
npm install        # 安装依赖（会下载 Electron，可能较慢）
npm start          # 启动 Electron 客户端；首次运行会自动初始化 dsh web profile
```

设 `DSH_CLIENT_DEV=1` 或传 `--dev` 可以打开调试日志。

## 冒烟测试（不启动 GUI）

验证“解析 node/dsh → 选端口 → 拉起服务 → 等到就绪”这一整条链路：

```powershell
npm run smoke
```

## 打包

```powershell
npm run dist           # 生成 NSIS 安装包 + 便携版（x64）
npm run dist:dir       # 只生成解包目录，便于调试
```

产物输出到 `dist/`：

- `DSH-Desktop-Setup-<version>.exe` —— 安装向导（可选安装目录、创建桌面/开始菜单快捷方式）
- `DSH-Desktop-Portable-<version>.exe` —— 免安装便携版

> 打包配置要点：`asar: false` 且 `npmRebuild: false`。因为 dsh 服务要作为**系统 Node** 的子进程运行（且依赖 sharp/koffi/node-pty 等预编译原生模块），所以不能把原生依赖重编译成 Electron 的 ABI，也不能把服务塞进 asar。

## 配置

`%APPDATA%\<AppName>\config.json`（首次运行自动生成），字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `3080` | 首选监听端口 |
| `host` | `127.0.0.1` | 监听地址 |
| `workspace` | `文档\DSH Workspace` | dsh 工作区根目录 |
| `dshHome` | 继承环境变量 | `$DSH_HOME`，默认 `~/.dsh` |
| `dshBin` | 自动解析 | 指定 `bin.js` 路径 |
| `nodeBin` | 自动解析 | 指定 `node.exe` 路径 |
| `installPlugins` | 安装向导勾选；便携版首次询问 | 是否自动安装内置插件（安装后不再提供开关） |
| `autoLaunch` | `false` | 是否开机自启 |

也可用环境变量覆盖：`DSH_CLIENT_NODE`、`DSH_CLIENT_DSH_BIN`、`DSH_CLIENT_WORKSPACE`。

日志在 `%APPDATA%\<AppName>\logs\server.log`。

## 已知说明

- 首次使用某台机器时，`dsh web` 会自动初始化 `$DSH_HOME/profiles/web`（与官方 CLI 一致）。
- 若在“已有客户端/dsh 在跑”时新开本客户端，会复用现有服务而非再开一个实例，避免共享 profile/会话时互相写冲突。
- **内置插件真实安装**：`ensurePlugins` 会为 web profile 生成**独立、真实的 `node_modules`**（用系统 Node 的 npm 安装 `@linxin666/dsh-web-all`、`dshmarket`、`dsh-find-plugin` 及关键 peer `@deepseek-ai/cordis`）。**不要**把它建成指向应用捆绑目录的 junction——junction 会让插件市场/更新里的 pnpm 写入直接落到应用 `node_modules`，导致原子重命名失败（如 `lightningcss-win32-x64-msvc`）并可能损坏应用依赖。首次真实安装需要联网，之后复用。
- **打包坑**：electron-builder 只收集“依赖树”里的包，会跳过 `peerDependencies`。DSH 内部有不少包（如 `@deepseek-ai/dsh-app-boot` 对 `@deepseek-ai/cordis-plugin-group`）是以 peer 依赖方式声明的，会被打包裁剪掉，导致运行时报 `ERR_MODULE_NOT_FOUND`。已把这些 peer 包显式加入 `dependencies` 修正。若改 DSH 版本后重启出现同样报错，用 `npm run dist` 前先对照 `node_modules\@deepseek-ai` 与打包产物中缺失的包并补进 `dependencies`。
