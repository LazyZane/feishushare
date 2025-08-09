import { LocalFileInfo, MarkdownProcessResult } from './types';

/**
 * Markdown 内容处理器
 * 负责处理 Obsidian 中的 Markdown 内容，使其适合在飞书中显示
 */
export class MarkdownProcessor {
	private localFiles: LocalFileInfo[] = [];
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
	private processWikiLinks(content: string): string {
		// 匹配 [[link]] 或 [[link|display]]
		return content.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (match, link, _, display) => {
			// 检查是否为文件引用（有文件扩展名）
			if (this.isFileReference(link)) {
				const placeholder = this.generatePlaceholder();
				const fileInfo: LocalFileInfo = {
					originalPath: link,
					fileName: this.extractFileName(link),
					placeholder: placeholder,
					isImage: this.isImageFile(link),
					altText: display || link
				};
				this.localFiles.push(fileInfo);
				return placeholder;
			} else {
				// 普通的Wiki链接，保持原有逻辑
				const displayText = display || link;
				return `📝 ${displayText}`;
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
	private processEmbeds(content: string): string {
		// 匹配嵌入语法，生成占位符
		return content.replace(/!\[\[([^\]]+)\]\]/g, (match, file) => {
			const placeholder = this.generatePlaceholder();
			const fileInfo: LocalFileInfo = {
				originalPath: file,
				fileName: this.extractFileName(file),
				placeholder: placeholder,
				isImage: this.isImageFile(file),
				altText: file
			};
			this.localFiles.push(fileInfo);
			return placeholder;
		});
	}

	/**
	 * 处理图片链接
	 */
	private processImages(content: string): string {
		// 处理本地图片路径，生成占位符
		return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
			// 如果是网络图片，保持原样
			if (src.startsWith('http://') || src.startsWith('https://')) {
				return match;
			}

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
		// 处理带有 Obsidian 插件的代码块
		return content.replace(/```(\w+)[\s\S]*?```/g, (match) => {
			// 保持代码块原样，但可以在这里添加特殊处理
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
		// 处理高亮 ==text==
		return content.replace(/==([^=]+)==/g, (match, text) => {
			return `**${text}**`; // 转换为粗体
		});
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
	processCompleteWithFiles(content: string): MarkdownProcessResult {
		// 重置本地文件列表
		this.localFiles = [];

		const processedContent = this.processComplete(content);

		return {
			content: processedContent,
			localFiles: [...this.localFiles]
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
}
