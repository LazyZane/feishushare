# 飞书分享 (Feishu Share)

一个强大的 Obsidian 插件，让你轻松将 Markdown 文档分享到飞书云文档。

## ✨ 特性

- 🚀 **一键分享** - 直接将笔记转换为飞书文档
- 🔐 **安全可靠** - 使用官方 OAuth 2.0 授权，数据安全有保障
- 📁 **智能文件夹** - 支持选择目标文件夹，文档分类更清晰
- 🎨 **格式保持** - 完美保持 Markdown 格式，包括图片、表格、代码块
- 📎 **文件上传** - 自动上传本地图片和附件到飞书文档
- 📄 **子文档支持** - 支持嵌入的 Markdown 文件作为子文档链接
- 🔍 **智能占位符** - 优化的占位符搜索，支持早期退出和性能优化
- ⚡ **响应迅速** - 直接调用飞书 API，无需第三方代理
- 🌐 **多端同步** - 分享后的文档可在飞书各端查看和编辑

## 📦 安装

### 从 Obsidian 社区插件市场安装（推荐）
1. 打开 Obsidian 设置
2. 进入"第三方插件"页面
3. 关闭"安全模式"
4. 点击"浏览社区插件"
5. 搜索"飞书分享"或"Feishu Share"
6. 点击安装并启用

### 手动安装
1. 从 [Releases](https://github.com/Astral719/obsidian-feishu-oauth-proxy/releases) 下载最新版本
2. 解压到 Obsidian 插件目录：`{vault}/.obsidian/plugins/obsidian-feishu-direct/`
3. 重启 Obsidian 并在设置中启用插件

## ⚙️ 配置指南

### 第一步：创建飞书应用
1. 访问 [飞书开放平台](https://open.feishu.cn/)
2. 创建"企业自建应用"
3. 记录 **App ID** 和 **App Secret**
4. 在"权限管理"中添加以下权限：
   - `contact:user.base:readonly` - 获取用户基本信息
   - `docx:document` - 创建、编辑文档
   - `drive:drive` - 访问云空间文件

### 第二步：配置回调地址
在应用的"安全设置" → "重定向URL"中添加：
```
https://md2feishu.xinqi.life/oauth-callback
```

### 第三步：插件授权
1. 在 Obsidian 插件设置中输入 App ID 和 App Secret
2. 点击"🚀 一键授权"按钮
3. 在弹出的浏览器中完成飞书登录授权
4. 授权成功后即可开始使用

## 🚀 使用方法

### 分享笔记到飞书
有多种方式可以分享你的笔记：

1. **命令面板**：`Ctrl+P` (Windows) 或 `Cmd+P` (Mac) → 搜索"分享当前笔记到飞书"
2. **右键菜单**：在编辑器中右键 → 点击"📤 分享到飞书"
3. **文件管理器**：在文件列表中右键 MD 文件 → "📤 分享到飞书"

### 文件和附件处理
插件会自动处理以下内容：

#### 📎 本地文件上传
- **图片文件**：`![alt](./image.png)` 或 `![[image.png]]`
- **附件文件**：`![[document.pdf]]` 或 `![[spreadsheet.xlsx]]`
- **支持格式**：图片（PNG、JPG、GIF等）、文档（PDF、DOCX等）、表格（XLSX、CSV等）

#### 📄 子文档嵌入
- **Markdown文件**：`![[other-note.md]]`
- 会作为子文档上传到飞书，并在原位置插入文档链接
- 支持递归处理子文档中的文件引用

#### 🔍 处理流程
1. **内容转换**：将本地文件引用替换为占位符
2. **文档导入**：上传Markdown内容到飞书
3. **文件上传**：逐个上传本地文件到飞书文档
4. **占位符替换**：将占位符替换为实际的文件块
5. **子文档处理**：处理嵌入的Markdown文件

### 选择目标文件夹
- 在插件设置中点击"📁 选择文件夹"
- 浏览你的飞书云空间文件夹
- 选择合适的文件夹作为默认保存位置
- 未选择时将保存到"我的空间"根目录

### 分享结果
分享成功后会显示：
- ✅ 成功提示和文档链接
- 📋 一键复制链接功能
- 📎 附件上传状态和结果
- 🗑️ 自动清理临时文件

## 🔍 技术实现

### 核心架构
```
Obsidian插件 → 直接调用飞书API
```

### 主要功能
- **OAuth授权** - 标准OAuth 2.0流程，支持自动重新授权
- **文件上传** - 使用FormData直接上传，支持多种文件格式
- **智能占位符** - 预编译正则表达式，支持早期退出优化
- **子文档处理** - 递归处理嵌入的Markdown文件
- **Token管理** - 自动刷新访问令牌，智能重试机制
- **错误处理** - 友好的错误提示和多重备用方案

### API调用
```typescript
// 文件上传示例
const formData = new FormData();
formData.append('file_name', fileName);
formData.append('parent_type', 'explorer');
formData.append('size', content.length.toString());
formData.append('file', blob, fileName);

const response = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/upload_all', {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${accessToken}`,
    },
    body: formData
});
```

## 🛠️ 开发

### 项目结构
```
src/
├── main.ts                 # 主插件类
├── feishu-api.ts           # 飞书API服务（完整功能）
├── markdown-processor.ts   # Markdown内容处理器
├── settings.ts             # 设置界面
├── manual-auth-modal.ts    # 手动授权模态框
├── folder-select-modal.ts  # 文件夹选择模态框
├── dom-utils.ts            # DOM工具函数
├── debug.ts                # 调试工具
├── types.ts                # 类型定义
└── constants.ts            # 常量配置
```

### 构建命令
```bash
npm run dev     # 开发模式（监听文件变化）
npm run build   # 生产构建
```

## 🔧 故障排除

### 常见问题

1. **授权失败**
   - 检查App ID和App Secret是否正确
   - 确认飞书应用权限配置
   - 验证OAuth回调地址

2. **上传失败**
   - 检查文件大小（飞书有限制）
   - 确认访问令牌有效性
   - 查看控制台错误信息

3. **Token过期**
   - 插件会自动尝试刷新Token
   - 如果刷新失败，需要重新授权

### 调试方法
1. 打开Obsidian开发者工具（`Ctrl+Shift+I`）
2. 查看Console标签页的日志
3. 检查Network标签页的API请求

## 📝 更新日志

### v2.1.0 (最新)
- 🎉 **文件上传功能** - 支持自动上传本地图片和附件
- 📄 **子文档支持** - 支持嵌入Markdown文件作为子文档链接
- 🔍 **性能优化** - 智能占位符搜索，支持早期退出
- 🔧 **错误处理** - 增强的错误处理和重试机制
- ⚡ **用户体验** - 实时进度提示和状态更新

### v2.0.0
- 🎉 首个Direct版本发布
- ✅ 直接调用飞书API，无需代理
- ✅ 完整的OAuth授权流程
- ✅ 支持基础文档分享
- ✅ 友好的用户界面

## 🤝 贡献

欢迎提交Issue和Pull Request！

## 📄 许可证

MIT License
