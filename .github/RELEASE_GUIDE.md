# GitHub Actions 自动发布指南

本项目已配置 GitHub Actions 工作流程，可以在推送版本标签时自动创建 Release。

## 使用方法

### 1. 创建并推送版本标签

```bash
# 创建标签（推荐使用语义化版本号）
git tag -a v0.1.0 -m "Release version 0.1.0"

# 推送标签到远程仓库
git push Github v0.1.0

# 或者推送所有标签
git push Github --tags
```

### 2. 自动化流程

推送标签后，GitHub Actions 将自动执行以下操作：

1. **检出代码** - 获取完整的 Git 历史
2. **提取版本号** - 从标签名称提取版本信息
3. **生成更新日志** - 自动提取两个 tag 之间的所有提交记录
4. **打包扩展** - 创建浏览器扩展 ZIP 包
5. **打包源代码** - 创建完整源代码 ZIP 包
6. **创建 Release** - 发布到 GitHub Releases 页面

### 3. 版本号规范

建议使用语义化版本号格式：`vX.Y.Z`

- `v1.0.0` - 正式版本
- `v0.1.0` - 初始版本
- `v1.2.3-alpha` - Alpha 测试版（会标记为预发布）
- `v1.2.3-beta` - Beta 测试版（会标记为预发布）
- `v1.2.3-rc.1` - Release Candidate（会标记为预发布）

### 4. 生成的文件

每次发布会自动生成以下文件：

```
AIhubEnhenced-v0.1.0.zip              # 浏览器扩展包（用户安装）
AIhubEnhenced-source-v0.1.0.zip       # 完整源代码
Source code (zip)                      # GitHub 自动生成
Source code (tar.gz)                   # GitHub 自动生成
```

## 更新日志生成规则

工作流会自动分析 Git 提交记录并生成更新日志：

- 如果是第一个标签：显示所有历史提交
- 如果存在上一个标签：显示两个标签之间的提交
- 每条提交格式：`- 提交信息 (commit hash)`
- 自动过滤合并提交

## 示例：发布新版本

```bash
# 1. 确保代码已提交
git add .
git commit -m "feat: 新增批量导出功能"

# 2. 创建版本标签
git tag -a v0.2.0 -m "版本 0.2.0 - 新增批量导出功能"

# 3. 推送代码和标签
git push Github main
git push Github v0.2.0

# 4. 等待 GitHub Actions 完成（约 1-2 分钟）

# 5. 访问 Releases 页面查看发布结果
# https://github.com/Sxuan-Coder/AIhubEnhenced/releases
```

## 手动触发（如果需要）

如果自动发布失败，可以手动操作：

```bash
# 删除远程标签
git push Github --delete v0.1.0

# 删除本地标签
git tag -d v0.1.0

# 重新创建并推送
git tag -a v0.1.0 -m "Release version 0.1.0"
git push Github v0.1.0
```

## 查看工作流状态

1. 访问 GitHub 仓库
2. 点击 "Actions" 选项卡
3. 查看 "自动发布 Release" 工作流的运行状态
4. 点击具体的运行记录查看详细日志

## 权限说明

工作流需要以下权限（已配置）：

- `contents: write` - 创建 Release 和上传文件

## 常见问题

### Q: 工作流没有触发？
A: 确保标签格式为 `v*.*.*`（如 v0.1.0），其他格式不会触发。

### Q: Release 创建失败？
A: 检查 Actions 页面的错误日志，通常是权限或文件路径问题。

### Q: 如何修改更新日志内容？
A: 发布后可以在 Releases 页面手动编辑 Release 描述。

### Q: 如何删除错误的 Release？
A: 在 Releases 页面找到对应版本，点击 "Delete" 按钮。

## 工作流配置文件

位置：`.github/workflows/release.yml`

修改此文件后，需要提交并推送到仓库才能生效。
