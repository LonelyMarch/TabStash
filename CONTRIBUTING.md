# 贡献指南

欢迎报告问题和提交改进。开始前请阅读 [README](./README.md)，确认目标浏览器、现有功能和已知限制。

## 分支模型

- `master` 是默认分支和稳定发布分支。初始化提交之后，只接受**本仓库 `dev` → `master`** 的发布 Pull Request，并使用 **Create a merge commit** 合并。
- `dev` 是日常开发分支。维护者在 `dev` 提交；外部贡献者从 `dev` 创建自己的分支，Pull Request 目标也设为 `dev`。
- 不直接向 `master` 提交或推送功能、修复及文档变更，也不通过 squash 或 rebase 将 `dev` 合入 `master`。已推送的 `dev` 历史不使用强制推送改写。

维护者开始日常开发前运行：

```powershell
git switch dev
git pull --ff-only origin dev
```

发布时先在 `dev` 完成版本号、更新日志和验证，再从本仓库 `dev` 向 `master` 创建 Pull Request。发布 PR 标题与合并提交标题均使用 `chore(release): 发布 vX.Y.Z`，其中版本号须与 `package.json` 一致。合并后在 `master` 创建对应版本标签。仓库内的 PR 检查会验证来源和标题，`master` 推送审计会检查合并历史。

创建 GitHub 仓库后，维护者还须在仓库设置中把默认分支设为 `master`，并为 `master` 启用分支规则：要求 Pull Request、要求 `validate` 与 `checks` 检查通过、禁止强制推送和删除，不设置绕过者。工作流检查本身不能阻止有权限者直接推送；该分支规则是合并约束生效的必要条件。

## 提交问题

请说明使用的 Edge 或 Chrome 版本、TabStash 版本、复现步骤、预期行为与实际行为。界面问题可附截图；提交前请遮盖网址、账号、归档标题等私人信息。不要在 Issue 中附上浏览器配置目录、扩展存储数据或包含本机路径的日志。

## 开发流程

需要 Node.js 22+ 和 pnpm 11。在项目根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm dev:edge
```

开发 Chrome 版本可使用 `pnpm dev:chrome`。代码按现有目录职责放置：`src/domain/` 存放纯业务规则，`src/application/` 组织用例流程，`src/infrastructure/` 封装浏览器 API 与持久化，`entrypoints/` 放置扩展入口。修改行为时补充能验证实际边界的测试；涉及归档和恢复的数据变更时，特别检查旧数据兼容与失败后的数据保留。

## 提交规范

提交信息使用以下格式，`scope` 必填：

```text
<type>(<scope>): <简短说明>
```

常用 `type`：`feat`（新功能）、`fix`（修复）、`docs`（文档）、`refactor`（重构）、`test`（测试）、`chore`（维护）、`build`（构建）、`ci`（持续集成）。`scope` 使用稳定的小写模块或领域名，例如 `archive`、`sidepanel`、`storage`、`readme` 或 `release`。标题用一句话说明实际改动，不写无意义的“更新代码”。例如：

```text
feat(archive): 支持按窗口归档标签组
fix(sidepanel): 修正浅色模式的内置页图标
docs(readme): 补充贡献指南
```

不兼容变更在类型后加 `!`，并在提交正文中写明迁移影响，例如 `feat(storage)!: 调整归档数据格式`。一个提交尽量只解决一个明确问题；提交前检查差异，避免混入构建产物或个人配置。

## 检查与 Pull Request

提交代码前至少运行：

```powershell
pnpm typecheck
pnpm lint
pnpm test
```

修改浏览器交互、权限、外观或打包流程时，再运行适用的构建与端到端检查：

```powershell
pnpm build
pnpm build:chrome
pnpm install:chrome-test
pnpm test:e2e
pnpm zip
pnpm zip:chrome
pnpm check:package
```

端到端测试需要可启动图形浏览器的 Windows 环境。仅修改文档时，无需运行浏览器测试。普通 Pull Request 的目标分支为 `dev`，请写明变更目的、测试结果、未覆盖的浏览器行为，以及相关 Issue；用户可见变化请同步更新 [CHANGELOG](./CHANGELOG.md) 的 `Unreleased` 小节。

## 隐私与授权

不要提交本机绝对路径、账号、真实浏览记录、私有配置、环境变量文件、测试报告或构建产物。提交截图和日志前请检查是否包含个人信息。新增第三方字体、图标或其他资源时，请记录来源并附上相应授权文件。项目源码采用 [AGPL-3.0-only](./LICENSE)。
