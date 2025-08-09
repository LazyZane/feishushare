# Front Matter 功能说明

## 新增功能

本次更新为 Obsidian 飞书分享插件添加了两个重要的新功能：

### 1. 文档标题来源选择

**位置**：插件设置 → 内容处理设置 → 文档标题来源

**选项**：
- **文件名 (Filename)** - 默认选项，使用文件名作为飞书文档标题
- **YAML Front Matter 的 "title" 属性** - 优先使用 Front Matter 中的 title 字段

**逻辑**：
- 当选择"YAML Front Matter"时，插件会首先尝试从文档顶部的 YAML 区域读取 `title` 字段
- 如果 `title` 字段不存在或为空，会自动回退使用文件名
- 当选择"文件名"时，始终使用文件名作为标题

### 2. Front Matter 处理方式

**位置**：插件设置 → 内容处理设置 → Front Matter 处理

**选项**：
- **移除 (Remove)** - 默认选项，在分享时完全移除 YAML Front Matter 部分
- **保留为代码块 (Keep as Code Block)** - 将 YAML Front Matter 转换为 yaml 代码块保留在文档中

## 使用示例

### 示例 1：使用 Front Matter 标题

**原始文档** (`my-note.md`)：
```markdown
---
title: 我的重要笔记
author: 张三
date: 2024-01-01
---

# 文档内容

这是笔记的正文内容。
```

**设置配置**：
- 文档标题来源：YAML Front Matter 的 "title" 属性
- Front Matter 处理：移除

**分享结果**：
- 飞书文档标题：`我的重要笔记`
- 文档内容：不包含 YAML 部分，直接从 `# 文档内容` 开始

### 示例 2：保留 Front Matter 为代码块

**设置配置**：
- 文档标题来源：文件名
- Front Matter 处理：保留为代码块

**分享结果**：
- 飞书文档标题：`my-note`
- 文档内容：
```yaml
title: 我的重要笔记
author: 张三
date: 2024-01-01
```

# 文档内容

这是笔记的正文内容。

### 示例 3：没有 Front Matter 的文档

**原始文档** (`simple-note.md`)：
```markdown
# 简单笔记

这是一个没有 Front Matter 的普通笔记。
```

**任何设置配置下的结果**：
- 飞书文档标题：`simple-note`
- 文档内容：保持原样

## 技术实现

### Front Matter 解析
- 支持标准的 YAML Front Matter 格式（以 `---` 开始和结束）
- 实现了简单的 YAML 解析器，支持基本的 `key: value` 格式
- 自动处理引号包围的值
- 忽略注释行和空行

### 标题提取逻辑
- 优先级：Front Matter title > 文件名
- 自动回退机制确保始终有有效的标题
- 支持中文和特殊字符

### 向后兼容
- 所有现有功能保持不变
- 默认设置与之前版本行为一致
- 不影响现有用户的使用体验

## 注意事项

1. **YAML 格式要求**：Front Matter 必须位于文档最开头，以 `---` 开始和结束
2. **title 字段**：只有名为 `title` 的字段会被用作文档标题
3. **编码支持**：完全支持中文和 Unicode 字符
4. **错误处理**：如果 YAML 解析失败，会自动回退到移除模式
5. **性能影响**：Front Matter 解析对性能影响极小

## 更新日志

- ✅ 添加文档标题来源选择功能
- ✅ 添加 Front Matter 处理方式选择功能  
- ✅ 实现 YAML Front Matter 解析器
- ✅ 实现标题提取逻辑和回退机制
- ✅ 更新设置界面UI
- ✅ 完整的类型定义和错误处理
- ✅ 向后兼容性保证
