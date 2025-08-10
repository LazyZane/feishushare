# 飞书OAuth回调中转服务

这是一个专门用于处理飞书OAuth回调并自动跳转到Obsidian的中转服务。

## 🚀 快速部署到Vercel

### 1. 部署步骤

```bash
# 进入项目目录
cd feishu-oauth-callback

# 安装Vercel CLI（如果没有安装）
npm i -g vercel

# 登录Vercel
vercel login

# 部署
vercel --prod
```

### 2. 配置飞书应用

部署完成后，将获得一个Vercel域名，例如：
```
https://your-project-name.vercel.app
```

在飞书开发者后台设置回调地址为：
```
https://your-project-name.vercel.app/oauth-callback
```

### 3. 工作流程

```
用户授权 → 飞书回调 → Vercel中转页面 → 自动跳转到Obsidian
```

## 📁 项目结构

```
feishu-oauth-callback/
├── package.json          # 项目配置
├── vercel.json           # Vercel部署配置
├── public/
│   └── oauth-callback.html  # 回调处理页面
└── README.md             # 说明文档
```

## ✨ 功能特性

- ✅ 自动跳转到Obsidian
- ✅ 优雅的错误处理
- ✅ 手动跳转备用方案
- ✅ 美观的用户界面
- ✅ 详细的调试信息
- ✅ 移动端适配

## 🔧 自定义域名（可选）

如果你有自己的域名，可以在Vercel中配置：

1. 在Vercel项目设置中添加自定义域名
2. 更新飞书回调地址为你的域名
3. 更新Obsidian插件中的回调地址配置

## 🐛 调试

页面底部有"显示调试信息"链接，可以查看详细的回调参数和错误信息。
