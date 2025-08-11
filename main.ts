import { Plugin, Notice, TFile, Menu, Editor, MarkdownView, Modal } from 'obsidian';
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



		// 添加调试控制命令
		this.addCommand({
			id: 'toggle-feishu-debug',
			name: '🔧 切换飞书调试日志',
			callback: () => {
				if (Debug.isEnabled()) {
					Debug.disable();
					new Notice('🔇 飞书调试日志已关闭');
				} else {
					Debug.enable();
					new Notice('🔧 飞书调试日志已开启');
				}
			}
		});

		// 添加详细日志控制命令
		this.addCommand({
			id: 'toggle-feishu-verbose',
			name: '🔍 切换飞书详细日志',
			callback: () => {
				if (Debug.isVerbose()) {
					Debug.disableVerbose();
					new Notice('🤫 飞书详细日志已关闭');
				} else {
					Debug.enableVerbose();
					new Notice('🔍 飞书详细日志已开启');
				}
			}
		});

		// 添加日志状态查看命令
		this.addCommand({
			id: 'show-feishu-debug-status',
			name: '📊 查看飞书调试状态',
			callback: () => {
				const status = Debug.getStatus();
				new Notice(`📊 飞书调试状态: ${status}`, 3000);
				Debug.log('📊 Current debug status:', status);
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

			// 确保文件已保存到磁盘
			this.log('Ensuring file is saved to disk');
			await this.ensureFileSaved(file);

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
				this.settings.enableLocalAttachmentUpload,
				this.settings.titleSource
			);

			// 根据设置提取文档标题
			const title = this.markdownProcessor.extractTitle(
				file.basename,
				processResult.frontMatter,
				this.settings.titleSource
			);
			this.log(`Processing file with title: ${title}`);

			// 检查是否为更新模式（存在feishushare标记）
			const isUpdateMode = this.checkUpdateMode(processResult.frontMatter);
			let result: any;
			let urlChanged = false;

			if (isUpdateMode.shouldUpdate) {
				this.log(`Update mode detected for existing document: ${isUpdateMode.feishuUrl}`);
				statusNotice.setMessage('🔍 检查现有文档可访问性...');

				// 检查现有URL是否可访问
				const urlAccessible = await this.feishuApi.checkDocumentUrlAccessibility(isUpdateMode.feishuUrl!);

				if (urlAccessible.isAccessible) {
					this.log('Existing document is accessible, updating content');
					statusNotice.setMessage('🔄 正在更新现有文档...');

					// 调用更新现有文档的方法
					result = await this.feishuApi.updateExistingDocument(
						isUpdateMode.feishuUrl!,
						title,
						processResult,
						statusNotice
					);
				} else if (urlAccessible.needsReauth) {
					this.log(`Token needs reauth, will retry after authorization: ${urlAccessible.error}`);
					statusNotice.setMessage('🔑 需要重新授权，授权后将重试更新...');

					// 需要重新授权，先创建新文档（这会触发授权流程）
					result = await this.feishuApi.shareMarkdownWithFiles(title, processResult, statusNotice);

					// 授权成功后，重新检查原文档
					if (result.success) {
						this.log('Authorization completed, retrying original document access');
						statusNotice.setMessage('🔄 重新检查原文档可访问性...');

						const retryAccessible = await this.feishuApi.checkDocumentUrlAccessibility(isUpdateMode.feishuUrl!);

						if (retryAccessible.isAccessible) {
							this.log('Original document is now accessible after reauth, updating it');
							statusNotice.setMessage('🔄 正在更新原文档...');

							// 删除刚创建的临时文档
							try {
								const tempDocId = this.feishuApi.extractDocumentIdFromUrl(result.url);
								if (tempDocId) {
									await this.feishuApi.deleteDocument(tempDocId);
									this.log('Temporary document deleted after successful reauth');
								}
							} catch (deleteError) {
								this.log(`Failed to delete temporary document: ${deleteError.message}`, 'warn');
							}

							// 更新原文档
							result = await this.feishuApi.updateExistingDocument(
								isUpdateMode.feishuUrl!,
								title,
								processResult,
								statusNotice
							);
						} else {
							this.log(`Original document still not accessible after reauth: ${retryAccessible.error}, using new document`);
							urlChanged = true;

							if (result.success) {
								this.log(`Document URL changed from ${isUpdateMode.feishuUrl} to ${result.url}`);
							}
						}
					}
				} else {
					this.log(`Existing document is not accessible: ${urlAccessible.error}, creating new document`);
					statusNotice.setMessage('📄 原文档不可访问，正在创建新文档...');

					// 原文档不可访问，创建新文档
					result = await this.feishuApi.shareMarkdownWithFiles(title, processResult, statusNotice);
					urlChanged = true;

					if (result.success) {
						this.log(`Document URL changed from ${isUpdateMode.feishuUrl} to ${result.url}`);
					}
				}
			} else {
				this.log('Normal share mode detected, creating new document');

				// 调用API分享（内部会自动检查和刷新token，如果需要重新授权会等待完成）
				result = await this.feishuApi.shareMarkdownWithFiles(title, processResult, statusNotice);
			}

			// 隐藏状态提示
			statusNotice.hide();

			if (result.success) {
				if (isUpdateMode.shouldUpdate && !urlChanged) {
					this.log(`Document updated successfully: ${result.title}`);

					// 更新模式：只更新feishu_shared_at时间戳
					if (this.settings.enableShareMarkInFrontMatter) {
						try {
							this.log('Updating share timestamp in front matter');
							const updatedContent = this.updateShareTimestamp(rawContent);
							await this.app.vault.modify(file, updatedContent);
							this.log('Share timestamp updated successfully');
						} catch (error) {
							this.log(`Failed to update share timestamp: ${error.message}`, 'warn');
						}
					}
				} else {
					// 新分享模式或URL发生变化的情况
					if (urlChanged) {
						this.log(`Document URL changed, updating front matter: ${result.title}`);
					} else {
						this.log(`File shared successfully: ${result.title}`);
					}

					// 添加完整的分享标记（新分享或URL变化）
					if (this.settings.enableShareMarkInFrontMatter && result.url) {
						try {
							this.log('Adding/updating share mark in front matter');
							const updatedContent = this.markdownProcessor.addShareMarkToFrontMatter(rawContent, result.url);
							await this.app.vault.modify(file, updatedContent);
							this.log('Share mark added/updated successfully');

							// 如果URL发生了变化，显示特殊通知
							if (urlChanged && isUpdateMode.shouldUpdate) {
								new Notice(`📄 文档链接已更新（原链接不可访问）\n新链接：${result.url}`, 8000);
							}
						} catch (error) {
							this.log(`Failed to add/update share mark: ${error.message}`, 'warn');
							// 不影响主要的分享成功流程，只记录警告
						}
					}
				}

				this.showSuccessNotification(result);
			} else {
				const operation = isUpdateMode.shouldUpdate ? '更新' : '分享';
				this.log(`${operation} failed: ${result.error}`, 'error');
				new Notice(`❌ ${operation}失败：${result.error}`);
			}

		} catch (error) {
			// 确保隐藏状态提示
			statusNotice.hide();
			this.handleError(error as Error, '文件分享');
		}
	}



	/**
	 * 确保文件已保存到磁盘
	 * @param file 要检查的文件
	 */
	private async ensureFileSaved(file: TFile): Promise<void> {
		try {
			// 检查文件是否有未保存的修改
			const currentMtime = file.stat.mtime;

			Debug.verbose(`File mtime: ${currentMtime}`);

			// 如果文件最近被修改，等待一小段时间确保保存完成
			const now = Date.now();
			const timeSinceModification = now - currentMtime;

			if (timeSinceModification < 1000) { // 如果1秒内有修改
				Debug.verbose(`File was recently modified (${timeSinceModification}ms ago), waiting for save...`);

				// 等待文件保存
				await new Promise(resolve => setTimeout(resolve, 500));

				// 强制刷新文件缓存
				await this.app.vault.adapter.stat(file.path);

				Debug.verbose(`File save wait completed`);
			}

			// 额外的安全检查：如果当前文件正在编辑，尝试触发保存
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile && activeFile.path === file.path) {
				Debug.verbose(`File is currently active, ensuring it's saved`);

				// 使用workspace的方式触发保存
				const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeLeaf && activeLeaf.file?.path === file.path) {
					// 触发编辑器保存
					await activeLeaf.save();
				}

				// 再等待一小段时间
				await new Promise(resolve => setTimeout(resolve, 200));
			}

		} catch (error) {
			Debug.warn('Error ensuring file is saved:', error);
			// 不抛出错误，继续执行
		}
	}

	/**
	 * 检查是否为更新模式
	 * @param frontMatter Front Matter数据
	 * @returns 更新模式检查结果
	 */
	private checkUpdateMode(frontMatter: any): {shouldUpdate: boolean, feishuUrl?: string} {
		if (!frontMatter) {
			return { shouldUpdate: false };
		}

		// 检查是否存在feishushare标记和feishu_url
		const hasFeishuShare = frontMatter.feishushare === true || frontMatter.feishushare === 'true';
		const feishuUrl = frontMatter.feishu_url;

		if (hasFeishuShare && feishuUrl && typeof feishuUrl === 'string') {
			this.log(`Found feishushare marker with URL: ${feishuUrl}`);
			return {
				shouldUpdate: true,
				feishuUrl: feishuUrl
			};
		}

		return { shouldUpdate: false };
	}

	/**
	 * 更新分享时间戳
	 * @param content 原始文件内容
	 * @returns 更新后的文件内容
	 */
	private updateShareTimestamp(content: string): string {
		// 获取东8区时间
		const now = new Date();
		const chinaTime = new Date(now.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
		const currentTime = chinaTime.toISOString().replace('Z', '+08:00');

		// 解析现有的 Front Matter
		const { frontMatter, content: contentWithoutFrontMatter } = this.markdownProcessor.processFrontMatter(content, 'remove');

		if (!frontMatter) {
			// 如果没有Front Matter，直接返回原内容
			return content;
		}

		// 更新时间戳
		const updatedFrontMatter = {
			...frontMatter,
			feishu_shared_at: currentTime
		};

		// 重新构建 Front Matter
		const frontMatterLines = ['---'];
		for (const [key, value] of Object.entries(updatedFrontMatter)) {
			if (value != null) {
				if (typeof value === 'string') {
					// 检查是否需要引号
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

		return frontMatterLines.join('\n') + '\n' + contentWithoutFrontMatter;
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
