import { Plugin, Notice, TFile, Menu, Editor, MarkdownView } from 'obsidian';
import { FeishuSettings } from './src/types';
import { DEFAULT_SETTINGS } from './src/constants';
import { FeishuApiService } from './src/feishu-api';
import { FeishuSettingTab } from './src/settings';
import { MarkdownProcessor } from './src/markdown-processor';
import { Debug } from './src/debug';

export default class FeishuPlugin extends Plugin {
	settings: FeishuSettings;
	feishuApi: FeishuApiService;
	markdownProcessor: MarkdownProcessor;

	async onload(): Promise<void> {
		// 加载设置
		await this.loadSettings();

		// 初始化服务
		this.feishuApi = new FeishuApiService(this.settings, this.app);
		this.markdownProcessor = new MarkdownProcessor(this.app);

		// 注册自定义协议处理器，实现自动授权回调
		this.registerObsidianProtocolHandler('feishu-auth', (params) => {
			this.handleOAuthCallback(params);
		});

		// 添加设置页面
		this.addSettingTab(new FeishuSettingTab(this.app, this));

		// 注册命令和菜单
		this.registerCommands();
		this.registerMenus();
	}

	onunload(): void {
		// 清理资源
	}

	/**
	 * 注册插件命令
	 */
	private registerCommands(): void {
		this.addCommand({
			id: 'share-current-note',
			name: '分享当前笔记到飞书',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.shareCurrentNote();
			}
		});
	}

	/**
	 * 注册右键菜单
	 */
	private registerMenus(): void {
		// 添加文件右键菜单
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TFile) => {
				if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item) => {
						item
							.setTitle('📤 分享到飞书')
							.setIcon('share')
							.onClick(() => {
								this.shareFile(file);
							});
					});
				}
			})
		);

		// 添加编辑器右键菜单
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
				menu.addItem((item) => {
					item
						.setTitle('📤 分享到飞书')
						.setIcon('share')
						.onClick(() => {
							this.shareCurrentNote();
						});
				});
			})
		);
	}

	async loadSettings(): Promise<void> {
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		if (this.feishuApi) {
			this.feishuApi.updateSettings(this.settings);
		}
	}

	/**
	 * 处理OAuth回调
	 */
	private async handleOAuthCallback(params: any): Promise<void> {
		this.log('Processing OAuth callback');

		if (params.code) {
			new Notice('🔄 正在处理授权回调...');

			try {
				const success = await this.feishuApi.processCallback(`obsidian://feishu-auth?${new URLSearchParams(params).toString()}`);

				if (success) {
					this.log('OAuth authorization successful');
					new Notice('🎉 自动授权成功！');
					await this.saveSettings();

					// 通知设置页面刷新和分享流程继续 - 使用自定义事件
					window.dispatchEvent(new CustomEvent('feishu-auth-success', {
						detail: {
							timestamp: Date.now(),
							source: 'oauth-callback'
						}
					}));
				} else {
					this.log('OAuth authorization failed', 'warn');
					new Notice('❌ 授权处理失败，请重试');
				}
			} catch (error) {
				this.handleError(error as Error, 'OAuth回调处理');
			}
		} else if (params.error) {
			const errorMsg = params.error_description || params.error;
			this.log(`OAuth error: ${errorMsg}`, 'error');
			new Notice(`❌ 授权失败: ${errorMsg}`);
		} else {
			this.log('Invalid OAuth callback parameters', 'warn');
			new Notice('❌ 无效的授权回调');
		}
	}

	/**
	 * 分享当前笔记
	 */
	async shareCurrentNote(): Promise<void> {
		this.log('Attempting to share current note');

		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			this.log('No active file found', 'warn');
			new Notice('❌ 没有打开的笔记');
			return;
		}

		if (activeFile.extension !== 'md') {
			this.log(`Unsupported file type: ${activeFile.extension}`, 'warn');
			new Notice('❌ 只支持分享 Markdown 文件');
			return;
		}

		this.log(`Sharing file: ${activeFile.path}`);
		await this.shareFile(activeFile);
	}

	/**
	 * 分享指定文件
	 */
	async shareFile(file: TFile): Promise<void> {
		this.log(`Starting file share process for: ${file.path}`);

		// 创建持续状态提示
		const statusNotice = new Notice('🔄 正在分享到飞书...', 0); // 0表示不自动消失

		try {
			// 检查基本授权状态
			if (!this.settings.accessToken || !this.settings.userInfo) {
				this.log('Authorization required', 'warn');
				statusNotice.hide();
				new Notice('❌ 请先在设置中完成飞书授权');
				return;
			}

			// 读取文件内容
			this.log('Reading file content');
			const rawContent = await this.app.vault.read(file);

			// 使用Markdown处理器处理内容（包含文件信息和Front Matter处理）
			const processResult = this.markdownProcessor.processCompleteWithFiles(
				rawContent,
				3, // maxDepth
				this.settings.frontMatterHandling,
				this.settings.enableSubDocumentUpload,
				this.settings.enableLocalImageUpload,
				this.settings.enableLocalAttachmentUpload
			);

			// 根据设置提取文档标题
			const title = this.markdownProcessor.extractTitle(
				file.basename,
				processResult.frontMatter,
				this.settings.titleSource
			);
			this.log(`Processing file with title: ${title}`);

			// 调用API分享（内部会自动检查和刷新token，如果需要重新授权会等待完成）
			const result = await this.feishuApi.shareMarkdownWithFiles(title, processResult, statusNotice);

			// 隐藏状态提示
			statusNotice.hide();

			if (result.success) {
				this.log(`File shared successfully: ${result.title}`);

				// 如果启用了分享标记功能且获取到了分享链接，则更新文件的 Front Matter
				if (this.settings.enableShareMarkInFrontMatter && result.url) {
					try {
						this.log('Adding share mark to front matter');
						const updatedContent = this.markdownProcessor.addShareMarkToFrontMatter(rawContent, result.url);
						await this.app.vault.modify(file, updatedContent);
						this.log('Share mark added successfully');
					} catch (error) {
						this.log(`Failed to add share mark: ${error.message}`, 'warn');
						// 不影响主要的分享成功流程，只记录警告
					}
				}

				this.showSuccessNotification(result);
			} else {
				this.log(`Share failed: ${result.error}`, 'error');
				new Notice(`❌ 分享失败：${result.error}`);
			}

		} catch (error) {
			// 确保隐藏状态提示
			statusNotice.hide();
			this.handleError(error as Error, '文件分享');
		}
	}

	/**
	 * 检查并刷新token
	 */
	async ensureValidAuth(): Promise<boolean> {
		if (!this.settings.accessToken) {
			return false;
		}

		// 这里可以添加token有效性检查和自动刷新逻辑
		// 暂时简单返回true
		return true;
	}

	/**
	 * 显示分享成功的通知
	 */
	private showSuccessNotification(result: any): void {
		if (result.url) {
			// 创建简化的成功通知，包含复制和打开功能
			const message = `✅ 分享成功！文档：${result.title}`;
			const notice = new Notice(message, 8000);

			// 创建按钮容器
			const buttonContainer = notice.noticeEl.createEl('div');
			buttonContainer.style.cssText = `
				display: flex;
				gap: 8px;
				margin-top: 8px;
			`;

			// 添加复制链接功能
			const copyButton = buttonContainer.createEl('button', {
				text: '📋 复制链接',
				cls: 'mod-cta'
			});
			copyButton.style.cssText = `flex: 1;`;

			copyButton.onclick = async () => {
				try {
					await navigator.clipboard.writeText(result.url);
					this.log('URL copied to clipboard');
					copyButton.textContent = '✅ 已复制';
					setTimeout(() => {
						copyButton.textContent = '📋 复制链接';
					}, 2000);
				} catch (error) {
					this.log(`Failed to copy URL: ${(error as Error).message}`, 'error');
					new Notice('❌ 复制失败');
				}
			};

			// 添加打开链接功能
			const openButton = buttonContainer.createEl('button', {
				text: '🔗 打开',
				cls: 'mod-muted'
			});
			openButton.style.cssText = `flex: 1;`;

			openButton.onclick = () => {
				if (result.url) {
					window.open(result.url, '_blank');
				}
			};
		} else {
			// 没有URL时的简单成功通知
			new Notice(`✅ 分享成功！文档标题：${result.title}`);
		}
	}

	/**
	 * 统一的错误处理方法
	 */
	private handleError(error: Error, context: string, userMessage?: string): void {
		Debug.error(`${context}:`, error);

		const message = userMessage || `❌ ${context}失败: ${error.message}`;
		new Notice(message);
	}

	/**
	 * 统一的日志记录方法
	 */
	private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
		switch (level) {
			case 'error':
				Debug.error(message);
				break;
			case 'warn':
				Debug.warn(message);
				break;
			default:
				Debug.log(message);
		}
	}
}
