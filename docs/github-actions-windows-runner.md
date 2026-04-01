# 使用 GitHub Actions 的 Windows Runner 为 LazyShell 打 Windows 包

本文档面向当前仓库 `LazyShell`，目标是让你在 macOS 上开发，但把 Windows 安装包交给 GitHub Actions 的 Windows runner 去构建。

适用前提：

- 仓库已推送到 GitHub
- 你对该仓库有写权限
- 你希望生成 Windows 可用的安装包，而不是在本机 macOS 上交叉编译

这也是当前更稳妥的方案。对 Tauri 来说，Windows 包最好在 Windows 环境里直接构建。

## 一、先理解 Windows runner 是什么

GitHub Actions 的 `windows-latest` 是 GitHub 提供的一台临时 Windows 虚拟机。

每次工作流运行时，GitHub 会：

1. 拉取你的仓库代码
2. 在一台全新的 Windows 虚拟机里执行步骤
3. 安装 Node、Rust、依赖
4. 执行 `npm run tauri:build`
5. 产出 `.exe`、`.msi` 等 Windows 安装包
6. 把产物上传为 Actions artifact，或者直接上传到 GitHub Release

你不需要自己准备 Windows 电脑。

## 二、这个仓库当前和打包相关的现状

根据当前仓库配置：

- 前端构建命令是 `npm run build`
- Tauri 构建命令是 `npm run tauri:build`
- Tauri 配置文件是 `src-tauri/tauri.conf.json`
- 当前 `bundle.targets` 是 `"all"`
- 仓库里还没有现成的 `.github/workflows/*.yml`

这意味着你只需要新增 GitHub Actions 工作流，就可以让 GitHub 帮你打 Windows 包。

## 三、你要做的整体流程

推荐按这个顺序：

1. 先在 GitHub 仓库里启用 Actions
2. 新建工作流文件 `.github/workflows/build-windows.yml`
3. 提交并 push 到 GitHub
4. 在 GitHub 的 Actions 页面观察构建日志
5. 从 Artifacts 下载 Windows 包
6. 确认没问题后，再决定要不要自动发 Release

先跑通“构建并上传 artifact”，再做“自动发版”，更容易排错。

## 四、第一步：确认 GitHub 仓库允许跑 Actions

打开仓库页面后检查：

1. 进入 GitHub 仓库主页
2. 点击 `Actions`
3. 如果 GitHub 提示启用 Actions，按提示开启
4. 如果仓库是私有仓库，再确认你的 GitHub 套餐有可用的 Actions minutes

说明：

- 公共仓库通常更容易直接使用标准 runner
- 私有仓库也可以使用，但会消耗 GitHub Actions 分钟数

## 五、第二步：新增工作流文件

在仓库中新建文件：

```text
.github/workflows/build-windows.yml
```

建议先用下面这个“只构建，不自动发 Release”的版本。

这个版本最适合第一次接入。

```yaml
name: Build Windows App

on:
  workflow_dispatch:
  push:
    branches:
      - main

jobs:
  build-windows:
    runs-on: windows-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install Rust toolchain
        uses: dtolnay/rust-toolchain@stable

      - name: Install frontend dependencies
        run: npm install

      - name: Build Tauri app for Windows
        run: npm run tauri:build

      - name: Upload Windows bundles
        uses: actions/upload-artifact@v4
        with:
          name: LazyShell-windows-bundle
          path: |
            src-tauri/target/release/bundle/msi/*.msi
            src-tauri/target/release/bundle/nsis/*.exe
          if-no-files-found: error
```

## 六、这份工作流每一段是在做什么

### 1. `on`

```yaml
on:
  workflow_dispatch:
  push:
    branches:
      - main
```

含义：

- `workflow_dispatch`：允许你在 GitHub 页面手动点按钮运行
- `push` 到 `main`：每次推送到主分支自动构建

如果你不想每次 push 都打包，可以先只保留：

```yaml
on:
  workflow_dispatch:
```

这样最安全，只有你手动点击才会构建。

### 2. `runs-on: windows-latest`

```yaml
runs-on: windows-latest
```

这是关键配置，意思是：

- 这份 job 不在 Linux 跑
- 不在 macOS 跑
- 而是在 GitHub 提供的 Windows runner 上跑

这就是“让 GitHub 帮你用 Windows 打包”的核心。

### 3. `actions/checkout`

```yaml
- uses: actions/checkout@v4
```

作用是把你的仓库代码拉到 runner 里。

没有这一步，后面的构建命令拿不到项目文件。

### 4. `actions/setup-node`

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20
    cache: npm
```

作用：

- 安装 Node.js 20
- 启用 npm 缓存，加快后续构建

你的仓库现在用的是 `npm`，所以这里直接配 `cache: npm`。

### 5. `dtolnay/rust-toolchain`

```yaml
- uses: dtolnay/rust-toolchain@stable
```

作用：

- 在 Windows runner 上安装 Rust stable 工具链

Tauri 的 Rust 后端和 bundler 都依赖 Rust。

### 6. `npm install`

```yaml
- run: npm install
```

作用：

- 安装前端依赖
- 安装 `@tauri-apps/cli`

这个仓库 `package.json` 已经定义了：

- `tauri:build`: `tauri build`

所以依赖装好后，`npm run tauri:build` 就能直接跑。

### 7. `npm run tauri:build`

```yaml
- run: npm run tauri:build
```

作用：

- 先根据 `tauri.conf.json` 运行 `beforeBuildCommand`
- 当前仓库里这个命令是 `npm run build`
- 然后执行 Tauri 的 Windows 打包流程

正常情况下它会在 Windows runner 上生成类似这些产物：

- `src-tauri/target/release/bundle/msi/*.msi`
- `src-tauri/target/release/bundle/nsis/*.exe`

### 8. `actions/upload-artifact`

```yaml
- uses: actions/upload-artifact@v4
```

作用：

- 把构建好的 Windows 安装包保存到这次 Actions 运行记录里

构建完成后，你可以直接去 GitHub 页面下载，不需要再登录 runner。

## 七、第三步：把工作流提交到仓库

本地执行：

```bash
git checkout -b chore/add-windows-build-workflow
git add .github/workflows/build-windows.yml
git commit -m "增加 Windows 打包工作流"
git push -u origin chore/add-windows-build-workflow
```

然后：

1. 发起 Pull Request
2. 合并到 `main`

如果你的工作流监听的是 `push` 到 `main`，合并后就会自动执行。

如果你只配置了 `workflow_dispatch`，那就需要手动运行。

## 八、第四步：手动触发一次构建

如果你保留了：

```yaml
on:
  workflow_dispatch:
```

则可以这样手动触发：

1. 打开 GitHub 仓库
2. 点击 `Actions`
3. 左侧找到 `Build Windows App`
4. 点击 `Run workflow`
5. 选择分支，一般选 `main`
6. 点击确认运行

## 九、第五步：下载构建产物

工作流成功后：

1. 打开这次 Actions run
2. 页面右侧或底部找到 `Artifacts`
3. 下载 `LazyShell-windows-bundle`
4. 解压后可以看到 `.msi` 或 `.exe`

这两个文件给 Windows 用户即可。

一般建议优先测试：

- NSIS 的 `setup.exe`
- MSI 的安装包

看哪个更适合你的分发方式。

## 十、如果你想自动发 GitHub Release

当你已经确认“只构建 artifact”没问题后，再考虑自动发版。

Tauri 官方提供了专门的 Action：`tauri-apps/tauri-action`。

它可以：

- 构建 Tauri 应用
- 创建 GitHub Release
- 自动上传安装包到 Release

下面给你一个适合当前仓库的基础版本。

新建文件：

```text
.github/workflows/release-windows.yml
```

内容示例：

```yaml
name: Release Windows App

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

jobs:
  release-windows:
    permissions:
      contents: write
    runs-on: windows-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install Rust toolchain
        uses: dtolnay/rust-toolchain@stable

      - name: Install frontend dependencies
        run: npm install

      - name: Build and upload release assets
        uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: app-v__VERSION__
          releaseName: "LazyShell v__VERSION__"
          releaseBody: "Windows installer built by GitHub Actions."
          releaseDraft: true
          prerelease: false
```

## 十一、这份 Release 工作流的关键点

### 1. `permissions: contents: write`

```yaml
permissions:
  contents: write
```

没有这项权限，工作流不能创建或更新 GitHub Release。

### 2. `GITHUB_TOKEN`

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

这是 GitHub 在工作流运行时自动提供的令牌。

它通常不需要你手动创建，只要仓库 Actions 权限正常即可。

但你要检查仓库设置里是否允许：

- Actions 有读写仓库内容权限

检查位置通常在：

`Settings` -> `Actions` -> `General`

你需要关注：

- Workflow permissions
- 建议至少允许 `Read and write permissions`

### 3. `tagName: app-v__VERSION__`

这里的 `__VERSION__` 会被 Tauri 自动替换成应用版本号。

你当前仓库版本在：

- `src-tauri/tauri.conf.json`

当前值是：

```json
"version": "0.1.0"
```

那么 release tag 最终会类似：

```text
app-v0.1.0
```

## 十二、推荐你采用的实际策略

对于这个仓库，我建议分两阶段：

### 阶段 1：先做 build artifact

只用：

- `.github/workflows/build-windows.yml`

目的：

- 先确认 Windows runner 能稳定打包
- 先确认依赖、Rust、Tauri bundler 都没问题
- 先确认你下载到的 `.exe` / `.msi` 能正常安装

### 阶段 2：再做 Release 自动发版

等第一阶段稳定后，再接：

- `.github/workflows/release-windows.yml`

这样问题更容易定位，不会把“构建失败”和“发布失败”混在一起。

## 十三、常见问题

### 1. 为什么我在 macOS 本地能开发，但还要用 Windows runner 打包？

因为 Windows 安装包最稳的方式就是在 Windows 环境里直接构建。

尤其是：

- `.msi`
- 一些签名或 installer 相关流程

在 Windows runner 上更少踩坑。

### 2. `windows-latest` 会不会变？

会。

`windows-latest` 是一个移动标签，GitHub 可能把它指向新的 Windows 镜像。

如果你追求稳定，可以固定为：

```yaml
runs-on: windows-2022
```

如果你想先图省事，继续用：

```yaml
runs-on: windows-latest
```

即可。

### 3. 我需要自己安装 NSIS、WiX、Visual Studio Build Tools 吗？

通常不需要手动预装全部内容。

GitHub 的 Windows runner 已经预装了很多常用工具，Tauri 在标准 Windows runner 上通常可以直接构建。

如果后续日志里明确提示某个工具缺失，再按错误信息补装。

### 4. 为什么建议先上传 artifact，不直接发 Release？

因为第一次接入时最常见的问题是：

- 依赖安装失败
- Rust 构建失败
- Windows bundler 失败
- 路径写错导致产物上传失败

先把“构建成功”单独跑通，排错成本最低。

### 5. Actions 失败后怎么排查？

看这几个步骤的日志：

1. `Install frontend dependencies`
2. `Build Tauri app for Windows`
3. `Upload Windows bundles`

最常见的判断方式：

- 如果 `npm install` 失败，先看依赖或 lockfile
- 如果 `tauri build` 失败，重点看 Rust、Tauri bundler、前端构建日志
- 如果 `upload-artifact` 失败，通常是产物路径写错，或者前一步没有真正生成安装包

## 十四、给 LazyShell 的推荐最终版本

如果你现在就要落地，我建议先只放这一份：

```text
.github/workflows/build-windows.yml
```

内容就用前面第一个示例。

原因很直接：

- 仓库当前还没有 Actions 工作流
- 先解决“Windows runner 能不能稳定产包”
- 跑通以后再接 GitHub Release，不会把问题复杂化

## 十五、你完成后应该看到什么结果

成功后，你会得到这条稳定链路：

1. 你在 macOS 写代码并 push
2. GitHub Actions 在 Windows runner 上执行构建
3. Tauri 生成 Windows 安装包
4. 你从 Actions artifacts 下载 `.exe` 或 `.msi`
5. 把它发给 Windows 用户安装

这就是“在 macOS 开发，但给 Windows 用户交付安装包”的标准做法。

## 参考资料

- GitHub Docs, Using GitHub-hosted runners: https://docs.github.com/en/actions/how-tos/manage-runners/github-hosted-runners/use-github-hosted-runners
- GitHub Docs, GitHub-hosted runners reference: https://docs.github.com/actions/reference/runners/github-hosted-runners
- Tauri Action README: https://github.com/tauri-apps/tauri-action
