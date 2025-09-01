## TDD 技术设计文档（feishushare）

本次为“最小变更版TDD”，仅覆盖你批准需要立刻整改的范围：
1) 移除内联样式/JS设样式，优先使用 Obsidian 内置类；
2) 统一日志门面，移除直接 `console.*`；
3) 收紧 TypeScript 编译严格性；
4) 补齐 `main.ts` 的关键 `any` 类型；
其余（如长方法拆分）暂缓。

### 1. 目标与范围
- 安全与规范：彻底移除插件运行侧的内联样式和直接 `console.*` 调用，符合《obsidian开发规范》与 GitHub 审查要求。
- 类型安全：开启 `noImplicitAny` 并补齐受影响的最小类型，以确保构建可通过。
- 兼容性：不引入新依赖，不改变现有交互流程与功能结果。

### 2. 受影响文件
- `main.ts`：
  - 通知按钮容器与按钮移除 `style.cssText`，改用 `setting-item-control`、`mod-cta`、`mod-muted` 等内置类；
  - 将 API 测试命令中的 `console.*` 切换为 `this.log(...)`；
  - 将 `handleOAuthCallback(params:any)` 与 `showSuccessNotification(result:any)` 等改为强类型；
  - `checkUpdateMode(frontMatter:any)` 改为 `Record<string, unknown>|null`；
- `src/settings.ts`：移除所有内联样式，替换直接 `console.*` 为 `Debug.*`（按需动态导入避免循环依赖）。
- `src/wiki-select-modal.ts`、`src/folder-select-modal.ts`、`src/manual-auth-modal.ts`：
  - 删除 `style.cssText` 与 `element.style.*`；
  - 替换直接 `console.*` 为 `Debug.*`；
  - 使用 `setting-item` / `setting-item-control` / `mod-cta` / `mod-muted` / 自定义轻量 class（仅 class 声明，不附带 style）。
- `tsconfig.json`：`target: ES2018`、`noImplicitAny: true`、`allowJs: false`、`lib: [DOM, ES2018]`。

### 3. 设计要点
- 样式策略：
  - 优先使用 Obsidian 内置类以实现常见布局（按钮行、强调按钮、弱化按钮、描述文本等）。
  - 悬停与点击态不以 JS 动态设色，统一改为切换语义类，如 `is-hover`；不提供自定义颜色，由主题接管。
  - 不新增 `styles.css`（最小变更原则）。如后续需要可再补充主题友好的类定义。
- 日志策略：
  - 所有运行侧日志统一通过 `Debug` 或 `this.log(...)` 输出；`Debug` 在生产默认禁用，避免污染控制台。
  - 避免在日志中输出敏感信息。
- 类型策略：
  - 仅为构建必需位置补齐类型（OAuth 回调参数、分享结果、frontMatter 检查入参）。
  - 其余 `any` 大量集中在 `feishu-api.ts` 的第三方响应/块结构解析中，本轮不触及以保持最小变更。

### 4. 验收标准
- 代码层面：
  - 全项目无 `innerHTML/outerHTML`，无 `style.cssText` 或 `element.style.*`（OAuth HTML 静态页不在本轮范围内）。
  - 无运行侧直接 `console.*`（保留 `src/debug.ts` 内部实现）。
  - `tsc --noEmit --skipLibCheck` 通过；`node esbuild.config.mjs production` 构建成功。
- 运行层面：
  - 通知与各模态布局和交互不回退，按钮可点击，状态文本正常。
  - 分享流程全链路不受影响（包含更新模式、Front Matter 回写等）。

### 5. 风险与回退
- 风险：移除内联样式后部分间距和视觉弱化效果可能与主题存在细微差异。
- 回退：如出现可用性问题，可在不违反规范的前提下新增小型 `styles.css` 并仅定义语义类（非内联动态样式）。

### 6. 实施清单（已完成）
- 移除 `main.ts` 通知 UI 的内联样式；
- 清理 `src/settings.ts`、`src/wiki-select-modal.ts`、`src/folder-select-modal.ts`、`src/manual-auth-modal.ts` 的内联样式与直接 `console`；
- 收紧 `tsconfig.json` 严格性；
- `main.ts` 关键 `any` → 强类型化。

### 7. 不在本次范围（保留原状）
- 长方法拆分（如 `shareFile`）：待后续迭代。


### 0. 背景与目标
- 依据已确认 PRD：
  - 当目标类型为“知识库”时，主文档与子文档都落在知识库对应位置（未配置节点则落到该知识库根）。
  - 提供“代码块过滤（多选）”能力：勾选的代码块语言在上传前移除；未勾选则按原样保留。
  - 统一 Front Matter 时间戳为东八区 `YYYY-MM-DD HH:mm`。
  - 子文档内 callout 与主文档一致地被正确转换（无占位符残留）。
  - 设置页交互精简：状态分组清晰、无“一键自检”。

### 1. 变更范围
- 代码：`src/settings.ts`、`src/markdown-processor.ts`、`src/feishu-api.ts`、`main.ts`、`src/constants.ts`、`src/types.ts`、`README.md`（文档）。
- 不改动构建与打包；不新增外部依赖。

### 2. 配置与数据结构
- 新增设置项：
  - `codeBlockFilterLanguages: string[]`（默认 `[]`，大小写不敏感，表示需过滤的 fenced code block 语言列表）。
- 文件与类型：
  - `src/types.ts` 的 `FeishuSettings` 增加 `codeBlockFilterLanguages: string[]`。
  - `src/constants.ts` 的 `DEFAULT_SETTINGS` 增加 `codeBlockFilterLanguages: []`。
- 设置页 UI：
  - 在“内容排除/代码块过滤”分组增加一个“多行文本输入框（每行一个语言）”。说明：大小写不敏感，仅匹配 fenced code 的 info string 首段语言标识。

### 3. 设置页交互与授权前置
- 授权状态条：沿用现有授权信息显示与“重新授权”入口（不新增自检按钮）。
- 目标与位置：
  - 选择“知识库/云空间”后，点击“更改位置”分别弹出对应模态。
  - 在 `FeishuSettingTab.showFolderSelectModal()` 与 `showWikiSelectModal()` 入口调用 `plugin.ensureValidAuth()`：
    - 若返回 `false`：显示 `new Notice('❌ 请先在设置中完成飞书授权')`，并直接 return（不打开模态、不发起请求）。
    - 若返回 `true`：继续打开选择模态。
- 文案统一：将“Front Matter 处理”展示文案改为“文档属性（Front Matter）”。

### 4. Markdown 处理设计
#### 4.1 代码块过滤（fenced code block）
- 过滤时机：在 `MarkdownProcessor` 的早期处理阶段（在扫描本地文件、callout 等之前）。
- 作用范围：主文档与子文档的 Markdown 均执行相同过滤。
- 识别规则：
  - 匹配 ``` 或 ~~~ 包裹的 fenced code block；
  - 解析 info string 的首段语言标识（如 `meta-bind-embed`、`dataviewjs`），忽略大小写与后续附加修饰（行号、标题等）。
- 行为：若语言命中 `settings.codeBlockFilterLanguages`，则整段代码块从内容中移除；否则原样保留。
- 伪代码：
```
languages = settings.codeBlockFilterLanguages.map(toLower)
content = content.replaceAll(fencedCodeBlockRegex, (full, fence, info, body) => {
  lang = extractFirstLanguageToken(info).toLowerCase()
  return languages.includes(lang) ? '' : full
})
```
- 正则建议（说明性）：
  - 捕获三元组：fence 起始、info string、内容体；
  - 使用非贪婪匹配并考虑不同 fence 符号与缩进；
  - 注意 Windows 换行兼容。

#### 4.2 子文档 callout 处理
- 现状：主文档在导入为文档后会执行占位符替换（包含 callout 占位符）。
- 设计：对子文档也执行同等流程：
  - 在 `processSubDocuments()` 内，对每个子文档对应的 Markdown 再次通过 `MarkdownProcessor.processCompleteWithFiles(...)` 生成其独立的 `localFiles` 与 `calloutBlocks`；
  - 子文档导入/创建成功拿到 `documentToken` 后，调用 `processAllPlaceholders(documentToken, subRegularFiles, subCalloutBlocks, ...)`；
  - 这样可消除子文档中 callout 占位符残留。

### 5. 知识库路径策略（主/子文档）
- 主文档：维持现有“上传→导入→移动到知识库”的流程。
- 子文档：两种实现路径（二选一，按最小改动优先 B）：
  - A（直接在知识库创建）：若有稳定 API 直接在知识库空间/节点创建文档，优先使用。否则回退 B；
  - B（与主文档一致）：上传生成云文档 → 调用 `moveDocToWiki(spaceId, token, 'docx', nodeToken?)` 移动至知识库；
    - `spaceId = settings.defaultWikiSpaceId`；
    - `nodeToken = settings.defaultWikiNodeToken || undefined`（未配置节点时传 `undefined`，落在知识库根）。
- 更新模式：在 `updateExistingDocument()` 路径中，复用上述子文档处理逻辑，确保新建/更新一致。

### 6. 时间戳格式统一
- 位置：`main.ts` 的 `updateShareTimestamp()` 与 `src/markdown-processor.ts` 的 `addShareMarkToFrontMatter()`。
- 实现：
  - 新增内部工具 `formatChinaTimeYYYYMMDDHHmm(date: Date): string`：
    - 计算东八区时间：`new Date(now.getTime() + 8*60*60*1000)`（与现有保持一致的简化处理）；
    - 格式化为 `YYYY-MM-DD HH:mm`；
    - 注意补零与跨日。
  - 两处写入 `feishu_shared_at: "YYYY-MM-DD HH:mm"`。

### 7. 错误处理与提示
- 未授权：在设置入口提前拦截并提示；不打开选择模态，不发起 API 请求。
- 知识库移动失败：不影响主文档创建完成；对失败的子文档移动记录警告，并在最终 Notice 中总结“部分子文档未移动至知识库”。（遵循 YAGNI，暂不做复杂回退逻辑）
- 子文档占位符替换失败：仅影响对应块，整体流程继续（已有策略沿用）。

### 8. 流程概述（targetType=wiki）
1) 主文档：上传→导入→（若开启）设置分享权限→移动至知识库→处理主文档占位符（文件+callout）。
2) 子文档集合：
   - 逐个子文档读取 Markdown → 代码块过滤 → 生成 `localFiles + calloutBlocks`；
   - 上传→导入→（可选）权限→移动至知识库；
   - 对该子文档调用 `processAllPlaceholders(documentToken, subRegularFiles, subCalloutBlocks)`；
   - 回写主文档中子文档链接（链接形态不强制要求）。

### 9. 具体改动清单（按文件）
- `src/types.ts`
  - `FeishuSettings` 增加 `codeBlockFilterLanguages: string[]`。
- `src/constants.ts`
  - `DEFAULT_SETTINGS` 增加 `codeBlockFilterLanguages: []`。
- `src/settings.ts`
  - 在“内容排除/代码块过滤”分组新增多行文本输入，每行一个语言；读写 `settings.codeBlockFilterLanguages`；
  - `showFolderSelectModal()` / `showWikiSelectModal()` 入口加 `await plugin.ensureValidAuth()` 前置校验；
  - 文案将“Front Matter 处理”对外展示为“文档属性（Front Matter）”。
- `src/markdown-processor.ts`
  - 在 `process(...)` 调度链前段插入 `filterFencedCodeBlocksByLanguage(settings.codeBlockFilterLanguages)`；
  - 暴露/复用用于子文档处理的 `processCompleteWithFiles(...)`；
  - 不改变现有占位符、图片、附件、callout 的既有逻辑。
- `src/feishu-api.ts`
  - 在 `processSubDocuments(...)` 中：
    - 对每个子文档执行完整处理与导入；
    - 在 `targetType=wiki` 时，导入成功后调用 `moveDocToWiki(spaceId, docToken, 'docx', nodeToken?)`；
    - 随后对该子文档调用 `processAllPlaceholders(docToken, subRegularFiles, subCalloutBlocks)`；
  - 在 `updateExistingDocument(...)` 路径保持与新建一致。
- `main.ts`
  - `updateShareTimestamp()` 改为使用 `YYYY-MM-DD HH:mm`；
  - 其他逻辑不变。
- `README.md`
  - 新增“代码块过滤”说明与示例；更新权限清单（含 `user_access_token`、`wiki:wiki`）。

### 10. 测试用例（要点）
- 未授权打开位置选择：提示并中断；无网络请求。
- 选择知识库根/节点后分享：主/子文档均在知识库路径；子文档链接可用。
- 子文档包含 callout：子文档内不出现占位符；样式正确。
- 代码块过滤：
  - 设置为 `meta-bind-embed` 后，含该语言的 fenced code 在飞书侧消失；
  - 清空后恢复保留为代码文本；
  - 多语言多行输入均生效，大小写混写也生效。
- 时间戳：Front Matter 中写入 `YYYY-MM-DD HH:mm`，新建与更新一致。

### 11. 风险与回退
- 风险：
  - 知识库移动接口频控或权限不足导致部分子文档未能移动。
  - 子文档再次解析带来少量额外耗时。
- 回退：
  - 移动失败不阻断主流程；最终 Notice 提示“部分子文档未移动至知识库”。

### 12. 实施计划（分步）
1) types/constants：新增字段与默认值。
2) settings：新增代码块过滤 UI；入口授权前置；文案统一。
3) markdown-processor：实现 fenced 代码块过滤；保持既有处理顺序。
4) feishu-api：完善 `processSubDocuments`（导入→移动→占位符替换）。
5) 时间戳格式调整：`main.ts` 与 `markdown-processor.ts`。
6) README 文档补充。

### 13. 依赖与外部接口
- 仅使用现有飞书 API（导入、移动到知识库、权限设置、列表查询等）。若实现细节需确认，将在实现阶段查阅官方文档并对参数做最小化调整（不引入新权限范围）。


