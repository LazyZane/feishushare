---
title: 这是来自Front Matter的标题
author: 测试作者
date: 2024-01-01
tags: [test, frontmatter]
---

# 测试文档

这是一个用于测试Front Matter功能的文档。

## 功能测试

1. **标题提取测试**：
   - 当设置为"frontmatter"时，应该使用"这是来自Front Matter的标题"
   - 当设置为"filename"时，应该使用文件名"test-frontmatter"

2. **Front Matter处理测试**：
   - 当设置为"remove"时，上面的YAML部分应该被移除
   - 当设置为"keep-as-code"时，应该转换为yaml代码块

## 内容示例

这里有一些==高亮文本==和普通内容。

```javascript
console.log("这是代码块");
```

> [!NOTE] 这是一个callout块
> 用于测试callout转换功能

![图片示例](image.png)

[[双链测试]]

#标签测试
