import { App, TFile, normalizePath } from 'obsidian';
import { LocalFileInfo, MarkdownProcessResult, ProcessContext, FrontMatterData } from './types';
import { Debug } from './debug';
import { CALLOUT_TYPE_MAPPING } from './constants';

/**
 * Markdown 内容处理器
 * 负责处理 Obsidian 中的 Markdown 内容，使其适合在飞书中显示
 */
export class MarkdownProcessor {
	private localFiles: LocalFileInfo[] = [];
	private app: App;

	constructor(app: App) {
		this.app = app;
	}
	/**
	 * 处理 Markdown 内容
	 * @param content 原始 Markdown 内容
	 * @returns 处理后的 Markdown 内容
	 */
	process(content: string): string {
		let processedContent = content;

		// 处理各种 Obsidian 特有语法
		processedContent = this.processWikiLinks(processedContent);
		processedContent = this.processBlockReferences(processedContent);
		processedContent = this.processTags(processedContent);
		processedContent = this.processEmbeds(processedContent);
		processedContent = this.processImages(processedContent);
		processedContent = this.cleanupWhitespace(processedContent);

		return processedContent;
	}

	/**
	 * 处理 Wiki 链接 [[link]]
	 */
	private processWikiLinks(content: string, context?: ProcessContext): string {
		// 匹配 [[link]] 或 [[link|display]]
		return content.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (match, link, _, display) => {
			// 检查是否为文件引用（有文件扩展名）
			if (this.isFileReference(link)) {
				// 根据设置决定是否处理文件
				const isImage = this.isImageFile(link);
				const shouldProcess = isImage
					? (context?.enableLocalImageUpload !== false)
					: (context?.enableLocalAttachmentUpload !== false);

				if (shouldProcess) {
					const placeholder = this.generatePlaceholder();
					const fileInfo: LocalFileInfo = {
						originalPath: link,
						fileName: this.extractFileName(link),
						placeholder: placeholder,
						isImage: isImage,
						altText: display || link
					};
					this.localFiles.push(fileInfo);
					return placeholder;
				} else {
					// 如果设置禁用了文件上传，保持原始链接
					return match; // 保持原有的 [[link|display]] 格式
				}
			} else {
				// 检查是否为双链引用的markdown文件
				const linkedFile = this.findLinkedMarkdownFile(link);
				if (linkedFile && context && context.enableSubDocumentUpload !== false) {
					// 检查是否已经处理过此文件（防止循环引用）
					const normalizedPath = normalizePath(linkedFile.path);
					if (context.processedFiles.has(normalizedPath)) {
						Debug.warn(`⚠️ Circular reference detected for file: ${normalizedPath}`);
						const displayText = display || link;
						return `📝 ${displayText} (循环引用)`;
					}

					// 检查递归深度
					if (context.currentDepth >= context.maxDepth) {
						Debug.warn(`⚠️ Max depth reached for file: ${normalizedPath}`);
						const displayText = display || link;
						return `📝 ${displayText} (深度限制)`;
					}

					// 创建子文档占位符
					const placeholder = this.generatePlaceholder();
					const fileInfo: LocalFileInfo = {
						originalPath: linkedFile.path,
						fileName: linkedFile.basename,
						placeholder: placeholder,
						isImage: false,
						isSubDocument: true,
						altText: display || link
					};
					this.localFiles.push(fileInfo);
					return placeholder;
				} else {
					// 普通的Wiki链接，保持原有逻辑
					const displayText = display || link;
					return `📝 ${displayText}`;
				}
			}
		});
	}

	/**
	 * 处理块引用 [[file#^block]]
	 */
	private processBlockReferences(content: string): string {
		// 匹配块引用
		return content.replace(/\[\[([^#\]]+)#\^([^\]]+)\]\]/g, (match, file, block) => {
			return `📝 ${file} (块引用: ${block})`;
		});
	}

	/**
	 * 处理标签 #tag
	 */
	private processTags(content: string): string {
		// 保持标签原样，但确保格式正确
		return content.replace(/#([a-zA-Z0-9_\u4e00-\u9fff]+)/g, (match, tag) => {
			return `#${tag}`;
		});
	}

	/**
	 * 处理嵌入内容 ![[file]]
	 */
	private processEmbeds(content: string, context?: ProcessContext): string {
		// 匹配嵌入语法，生成占位符
		return content.replace(/!\[\[([^\]]+)\]\]/g, (match, file) => {
			// 根据设置决定是否处理文件
			const isImage = this.isImageFile(file);
			const shouldProcess = isImage
				? (context?.enableLocalImageUpload !== false)
				: (context?.enableLocalAttachmentUpload !== false);

			if (shouldProcess) {
				const placeholder = this.generatePlaceholder();
				const fileInfo: LocalFileInfo = {
					originalPath: file,
					fileName: this.extractFileName(file),
					placeholder: placeholder,
					isImage: isImage,
					altText: file
				};
				this.localFiles.push(fileInfo);
				return placeholder;
			} else {
				// 如果设置禁用了文件上传，保持原有格式
				return match; // 保持原有的 ![[file]] 格式
			}
		});
	}

	/**
	 * 处理图片链接
	 */
	private processImages(content: string, context?: ProcessContext): string {
		// 处理本地图片路径，生成占位符
		return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
			// 如果是网络图片，保持原样
			if (src.startsWith('http://') || src.startsWith('https://')) {
				return match;
			}

			// 根据设置决定是否处理本地图片
			if (context?.enableLocalImageUpload !== false) {
				// 如果是本地图片，生成占位符
				const placeholder = this.generatePlaceholder();
				const altText = alt || '图片';
				const fileInfo: LocalFileInfo = {
					originalPath: src,
					fileName: this.extractFileName(src),
					placeholder: placeholder,
					isImage: true,
					altText: altText
				};
				this.localFiles.push(fileInfo);
				return placeholder;
			} else {
				// 如果设置禁用了图片上传，保持原有格式
				return match; // 保持原有的 ![alt](src) 格式
			}
		});
	}

	/**
	 * 处理普通链接，确保特殊协议链接保持可点击状态
	 */
	private processLinks(content: string): string {
		// 处理普通的 [text](url) 格式链接
		return content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
			// 检查是否为 Obsidian 协议链接
			if (url.startsWith('obsidian://')) {
				// 简单地去掉中括号，保留文本和URL
				// 格式：文本(obsidian://...)
				return `${text}(${url})`;
			}

			// 其他链接保持原样
			return match;
		});
	}

	/**
	 * 清理多余的空白字符
	 */
	private cleanupWhitespace(content: string): string {
		// 移除多余的空行（超过2个连续换行）
		content = content.replace(/\n{3,}/g, '\n\n');
		
		// 移除行尾空格
		content = content.replace(/[ \t]+$/gm, '');
		
		// 确保文件末尾有且仅有一个换行
		content = content.replace(/\s+$/, '\n');
		
		return content;
	}

	/**
	 * 处理 Obsidian 特有的代码块语法
	 */
	private processCodeBlocks(content: string): string {
		// 保持所有代码块原样，包括 Mermaid
		return content.replace(/```(\w+)[\s\S]*?```/g, (match, language) => {
			// 保持所有代码块原样
			return match;
		});
	}



	/**
	 * 处理数学公式
	 */
	private processMathFormulas(content: string): string {
		// 处理行内数学公式 $formula$
		content = content.replace(/\$([^$]+)\$/g, (match, formula) => {
			return `📐 数学公式: ${formula}`;
		});

		// 处理块级数学公式 $$formula$$
		content = content.replace(/\$\$([^$]+)\$\$/g, (match, formula) => {
			return `\n📐 数学公式块:\n${formula}\n`;
		});

		return content;
	}

	/**
	 * 处理 Obsidian 的高亮语法
	 */
	private processHighlights(content: string): string {
		// 处理高亮 ==text==，转换为带有高亮标记的文本
		return content.replace(/==([^=]+)==/g, (match, text) => {
			return `<mark>${text}</mark>`; // 使用 HTML mark 标签表示高亮
		});
	}

	/**
	 * 处理 Obsidian Callout 块
	 * 使用改进的 Markdown 格式化方案，在飞书中显示为引用块
	 */
	private processCallouts(content: string): string {
		// 改进的正则表达式，支持折叠语法和更复杂的内容
		// 格式：> [!TYPE]- 或 > [!TYPE] 标题（可选）
		// 后续行：> 内容（可能包含空行）
		const calloutRegex = /^>\s*\[!([^\]]+)\](-?)\s*([^\n]*)\n((?:(?:>[^\n]*|)\n?)*?)(?=\n(?!>)|$)/gm;

		return content.replace(calloutRegex, (match, type, foldable, title, body) => {
			// 获取 callout 类型（转为小写，移除可能的折叠标记）
			const calloutType = type.toLowerCase().trim();

			// 从映射表中获取样式信息，如果没有找到则使用默认样式
			const styleInfo = CALLOUT_TYPE_MAPPING[calloutType] || CALLOUT_TYPE_MAPPING['default'];

			// 处理标题（如果有的话）
			let calloutTitle = title.trim() || styleInfo.title;

			// 转义标题中的 Markdown 特殊字符，避免格式冲突
			calloutTitle = this.escapeMarkdownInTitle(calloutTitle);

			// 处理内容，移除每行开头的 > 符号，保持原有的格式结构
			const lines = body.split('\n');
			const processedLines = lines
				.map(line => {
					// 移除开头的 > 符号，但保持其他格式
					if (line.startsWith('>')) {
						return line.replace(/^>\s?/, '');
					}
					return line; // 保持空行
				})
				.filter((line, index, arr) => {
					// 移除末尾的连续空行，但保持中间的空行
					if (line === '' && index === arr.length - 1) {
						return false;
					}
					return true;
				});

			const calloutContent = processedLines.join('\n');

			// 生成改进的引用块格式
			const formattedTitle = `**${styleInfo.emoji} ${calloutTitle}**`;

			// 将内容的每一行都加上引用符号，保持原有的缩进和格式
			const quotedContent = calloutContent
				.split('\n')
				.map(line => {
					if (line.trim() === '') {
						return '>'; // 空行也要有引用符号
					}
					return `> ${line}`;
				})
				.join('\n');

			return `\n> ${formattedTitle}\n>\n${quotedContent}\n\n`;
		});
	}

	/**
	 * 处理标题中的特殊字符，避免与外层粗体标记冲突
	 */
	private escapeMarkdownInTitle(title: string): string {
		// 只处理可能与外层 ** 冲突的字符
		// 将 ** 替换为单个 * 以避免冲突，其他字符保持原样
		return title.replace(/\*\*/g, '*');
	}

	/**
	 * 完整处理（包含所有功能）
	 */
	processComplete(content: string): string {
		let processedContent = content;

		// 按顺序处理各种语法
		processedContent = this.processWikiLinks(processedContent);
		processedContent = this.processBlockReferences(processedContent);
		processedContent = this.processEmbeds(processedContent);
		processedContent = this.processImages(processedContent);
		processedContent = this.processLinks(processedContent); // 处理普通链接
		processedContent = this.processTags(processedContent);
		processedContent = this.processHighlights(processedContent);
		processedContent = this.processMathFormulas(processedContent);
		processedContent = this.processCodeBlocks(processedContent);
		processedContent = this.cleanupWhitespace(processedContent);

		return processedContent;
	}

	/**
	 * 完整处理并返回文件信息（新方法）
	 */
	processCompleteWithFiles(
		content: string,
		maxDepth: number = 3,
		frontMatterHandling: 'remove' | 'keep-as-code' = 'remove',
		enableSubDocumentUpload: boolean = true,
		enableLocalImageUpload: boolean = true,
		enableLocalAttachmentUpload: boolean = true,
		titleSource: 'filename' | 'frontmatter' = 'filename'
	): MarkdownProcessResult {
		// 重置本地文件列表
		this.localFiles = [];

		// 处理 Front Matter
		const { content: processedContent, frontMatter } = this.processFrontMatter(content, frontMatterHandling);

		// 创建处理上下文
		const context: ProcessContext = {
			maxDepth: maxDepth,
			currentDepth: 0,
			processedFiles: new Set<string>(),
			enableSubDocumentUpload,
			enableLocalImageUpload,
			enableLocalAttachmentUpload,
			frontMatterHandling,
			titleSource
		};

		const finalContent = this.processCompleteWithContext(processedContent, context);

		return {
			content: finalContent,
			localFiles: [...this.localFiles],
			frontMatter: frontMatter,
			extractedTitle: frontMatter?.title || null
		};
	}

	/**
	 * 生成占位符
	 */
	private generatePlaceholder(): string {
		const timestamp = Date.now();
		const randomId = Math.random().toString(36).substring(2, 8);
		return `__FEISHU_FILE_${timestamp}_${randomId}__`;
	}

	/**
	 * 从路径中提取文件名
	 */
	private extractFileName(path: string): string {
		// 移除路径分隔符，获取文件名
		const fileName = path.split(/[/\\]/).pop() || path;
		return fileName;
	}

	/**
	 * 判断是否为文件引用（有文件扩展名）
	 */
	private isFileReference(path: string): boolean {
		// 检查是否包含文件扩展名
		const fileName = this.extractFileName(path);
		return fileName.includes('.') && fileName.lastIndexOf('.') > 0;
	}

	/**
	 * 判断是否为图片文件
	 */
	private isImageFile(fileName: string): boolean {
		const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp'];
		const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
		return imageExtensions.includes(ext);
	}

	/**
	 * 获取收集到的本地文件信息
	 */
	getLocalFiles(): LocalFileInfo[] {
		return [...this.localFiles];
	}

	/**
	 * 清空本地文件信息
	 */
	clearLocalFiles(): void {
		this.localFiles = [];
	}

	/**
	 * 查找双链引用的Markdown文件
	 */
	private findLinkedMarkdownFile(linkText: string): TFile | null {
		try {
			// 清理链接文本
			let cleanLink = linkText.trim();

			// 移除可能的路径前缀
			cleanLink = cleanLink.replace(/^\.\//, '').replace(/^\//, '');

			// 如果没有扩展名，尝试添加.md
			if (!cleanLink.includes('.')) {
				cleanLink = cleanLink + '.md';
			}

			// 规范化路径
			const normalizedPath = normalizePath(cleanLink);

			// 首先尝试直接路径匹配
			let file = this.app.vault.getFileByPath(normalizedPath);

			if (!file) {
				// 如果直接路径不匹配，尝试按文件名查找
				const fileName = normalizedPath.split('/').pop()?.toLowerCase();
				if (fileName) {
					const allFiles = this.app.vault.getMarkdownFiles();
					file = allFiles.find(f => f.name.toLowerCase() === fileName) || null;
				}
			}

			if (!file) {
				// 最后尝试模糊匹配（不包含扩展名的情况）
				const baseName = linkText.trim().toLowerCase();
				const allFiles = this.app.vault.getMarkdownFiles();
				file = allFiles.find(f => f.basename.toLowerCase() === baseName) || null;
			}

			if (file) {
				Debug.log(`✅ Found linked markdown file: "${linkText}" -> "${file.path}"`);
			} else {
				Debug.log(`❌ Linked markdown file not found: "${linkText}"`);
			}

			return file;
		} catch (error) {
			Debug.error(`Error finding linked file for "${linkText}":`, error);
			return null;
		}
	}

	/**
	 * 处理子文档内容（带递归控制）
	 */
	async processSubDocument(
		file: TFile,
		context: ProcessContext,
		frontMatterHandling: 'remove' | 'keep-as-code' = 'remove',
		titleSource: 'filename' | 'frontmatter' = 'filename'
	): Promise<MarkdownProcessResult> {
		try {
			// 添加到已处理文件集合
			const normalizedPath = normalizePath(file.path);
			context.processedFiles.add(normalizedPath);

			// 读取文件内容
			const content = await this.app.vault.read(file);

			// 处理 Front Matter（与主文档保持一致）
			const { content: processedContent, frontMatter } = this.processFrontMatter(content, frontMatterHandling);

			// 提取标题（与主文档保持一致）
			const extractedTitle = this.extractTitle(file.basename, frontMatter, titleSource);

			// 创建子上下文
			const subContext: ProcessContext = {
				...context,
				currentDepth: context.currentDepth + 1
			};

			// 重置本地文件列表（为子文档处理）
			const originalFiles = [...this.localFiles];
			this.localFiles = [];

			// 处理子文档内容
			const finalContent = this.processCompleteWithContext(processedContent, subContext);

			// 获取子文档的文件列表
			const subDocumentFiles = [...this.localFiles];

			// 恢复原始文件列表
			this.localFiles = originalFiles;

			return {
				content: finalContent,
				localFiles: subDocumentFiles,
				frontMatter: frontMatter,
				extractedTitle: extractedTitle
			};
		} catch (error) {
			Debug.error(`Error processing sub-document ${file.path}:`, error);
			return {
				content: `❌ 无法读取子文档: ${file.basename}`,
				localFiles: [],
				frontMatter: null,
				extractedTitle: null
			};
		}
	}

	/**
	 * 带上下文的完整处理方法
	 */
	private processCompleteWithContext(content: string, context?: ProcessContext): string {
		let processedContent = content;

		// 按顺序处理各种语法
		processedContent = this.processCallouts(processedContent); // 先处理 Callout，因为它们是块级元素
		processedContent = this.processWikiLinks(processedContent, context);
		processedContent = this.processBlockReferences(processedContent);
		processedContent = this.processEmbeds(processedContent, context);
		processedContent = this.processImages(processedContent, context);
		processedContent = this.processLinks(processedContent); // 处理普通链接，确保特殊协议链接保持可点击
		processedContent = this.processTags(processedContent);
		processedContent = this.processHighlights(processedContent);
		processedContent = this.processMathFormulas(processedContent);
		processedContent = this.processCodeBlocks(processedContent);
		processedContent = this.cleanupWhitespace(processedContent);

		return processedContent;
	}

	/**
	 * 解析 YAML Front Matter
	 * @param content 原始内容
	 * @returns 解析结果，包含 Front Matter 数据和剩余内容
	 */
	private parseFrontMatter(content: string): { frontMatter: FrontMatterData | null, content: string } {
		// 检查是否以 --- 开头
		if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
			return { frontMatter: null, content };
		}

		// 查找结束的 ---
		const lines = content.split('\n');
		let endIndex = -1;

		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === '---') {
				endIndex = i;
				break;
			}
		}

		if (endIndex === -1) {
			// 没有找到结束标记，不是有效的 Front Matter
			return { frontMatter: null, content };
		}

		// 提取 YAML 内容
		const yamlContent = lines.slice(1, endIndex).join('\n');
		const remainingContent = lines.slice(endIndex + 1).join('\n');

		try {
			// 简单的 YAML 解析（仅支持基本的 key: value 格式）
			const frontMatter = this.parseSimpleYaml(yamlContent);
			return { frontMatter, content: remainingContent };
		} catch (error) {
			Debug.warn('Failed to parse Front Matter:', error);
			return { frontMatter: null, content };
		}
	}

	/**
	 * 简单的 YAML 解析器（仅支持基本的 key: value 格式）
	 * @param yamlContent YAML 内容
	 * @returns 解析后的对象
	 */
	private parseSimpleYaml(yamlContent: string): FrontMatterData {
		const result: FrontMatterData = {};
		const lines = yamlContent.split('\n');

		for (const line of lines) {
			const trimmedLine = line.trim();
			if (!trimmedLine || trimmedLine.startsWith('#')) {
				continue; // 跳过空行和注释
			}

			const colonIndex = trimmedLine.indexOf(':');
			if (colonIndex === -1) {
				continue; // 跳过无效行
			}

			const key = trimmedLine.substring(0, colonIndex).trim();
			let value = trimmedLine.substring(colonIndex + 1).trim();

			// 移除引号
			if ((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}

			result[key] = value;
		}

		return result;
	}

	/**
	 * 根据设置处理 Front Matter
	 * @param content 原始内容
	 * @param frontMatterHandling 处理方式
	 * @returns 处理后的内容和 Front Matter 数据
	 */
	processFrontMatter(content: string, frontMatterHandling: 'remove' | 'keep-as-code'): {
		content: string,
		frontMatter: FrontMatterData | null
	} {
		const { frontMatter, content: contentWithoutFrontMatter } = this.parseFrontMatter(content);

		if (!frontMatter) {
			return { content, frontMatter: null };
		}

		if (frontMatterHandling === 'remove') {
			return { content: contentWithoutFrontMatter, frontMatter };
		} else {
			// 保留为代码块
			const yamlLines = content.split('\n');
			let endIndex = -1;

			for (let i = 1; i < yamlLines.length; i++) {
				if (yamlLines[i].trim() === '---') {
					endIndex = i;
					break;
				}
			}

			if (endIndex !== -1) {
				const yamlContent = yamlLines.slice(1, endIndex).join('\n');
				const codeBlock = '```yaml\n' + yamlContent + '\n```\n\n';
				return {
					content: codeBlock + contentWithoutFrontMatter,
					frontMatter
				};
			}
		}

		return { content: contentWithoutFrontMatter, frontMatter };
	}

	/**
	 * 根据设置提取文档标题
	 * @param fileName 文件名（不含扩展名）
	 * @param frontMatter Front Matter 数据
	 * @param titleSource 标题来源设置
	 * @returns 提取的标题
	 */
	extractTitle(
		fileName: string,
		frontMatter: FrontMatterData | null,
		titleSource: 'filename' | 'frontmatter'
	): string {
		if (titleSource === 'frontmatter' && frontMatter?.title) {
			// 优先使用 Front Matter 中的 title
			return frontMatter.title;
		}

		// 回退到文件名
		return fileName;
	}

	/**
	 * 在文件内容中添加或更新分享标记到 Front Matter
	 * @param content 原始文件内容
	 * @param shareUrl 分享链接
	 * @returns 更新后的文件内容
	 */
	addShareMarkToFrontMatter(content: string, shareUrl: string): string {
		// 获取东8区时间
		const now = new Date();
		const chinaTime = new Date(now.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
		const currentTime = chinaTime.toISOString().replace('Z', '+08:00');

		// 解析现有的 Front Matter
		const { frontMatter, content: contentWithoutFrontMatter } = this.parseFrontMatter(content);

		// 创建或更新分享标记
		const updatedFrontMatter: FrontMatterData = {
			...frontMatter,
			feishushare: true,
			feishu_url: shareUrl,
			feishu_shared_at: currentTime
		};

		// 重新构建 Front Matter
		const frontMatterLines = ['---'];

		// 添加所有字段
		for (const [key, value] of Object.entries(updatedFrontMatter)) {
			if (value !== null && value !== undefined) {
				if (typeof value === 'string') {
					// 如果字符串包含特殊字符，用引号包围
					if (value.includes(':') || value.includes('#') || value.includes('[') || value.includes(']')) {
						frontMatterLines.push(`${key}: "${value}"`);
					} else {
						frontMatterLines.push(`${key}: ${value}`);
					}
				} else {
					frontMatterLines.push(`${key}: ${value}`);
				}
			}
		}

		frontMatterLines.push('---');

		// 组合最终内容
		return frontMatterLines.join('\n') + '\n' + contentWithoutFrontMatter;
	}
}
