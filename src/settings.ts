import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import FeishuPlugin from '../main';
import { ManualAuthModal } from './manual-auth-modal';
import { FolderSelectModal } from './folder-select-modal';

export class FeishuSettingTab extends PluginSettingTab {
	plugin: FeishuPlugin;

	constructor(app: App, plugin: FeishuPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// 标题和说明
		containerEl.createEl('h2', { text: '飞书分享设置' });
		
		const descEl = containerEl.createDiv('setting-item-description');
		descEl.innerHTML = `
			<p>直连飞书API，回调地址仅中转无记录。</p>
			<p><strong>特点：</strong>无依赖、更安全、响应更快</p>
		`;

		// 应用配置部分
		containerEl.createEl('h3', { text: '🔧 应用配置' });

		// App ID
		new Setting(containerEl)
			.setName('App ID')
			.setDesc('飞书应用的 App ID')
			.addText(text => text
				.setPlaceholder('输入飞书应用的 App ID')
				.setValue(this.plugin.settings.appId)
				.onChange(async (value) => {
					this.plugin.settings.appId = value.trim();
					await this.plugin.saveSettings();
					}));

		// App Secret
		new Setting(containerEl)
			.setName('App Secret')
			.setDesc('飞书应用的 App Secret')
			.addText(text => {
				text.setPlaceholder('输入飞书应用的 App Secret')
					.setValue(this.plugin.settings.appSecret)
					.onChange(async (value) => {
						this.plugin.settings.appSecret = value.trim();
						await this.plugin.saveSettings();
						});
				text.inputEl.type = 'password';
			});

		// 回调地址
		new Setting(containerEl)
			.setName('OAuth回调地址')
			.setDesc('obsidian需web回调中转，例如：https://md2feishu.xinqi.life/oauth-callback')
			.addText(text => text
				.setPlaceholder('https://md2feishu.xinqi.life/oauth-callback')
				.setValue(this.plugin.settings.callbackUrl)
				.onChange(async (value) => {
					this.plugin.settings.callbackUrl = value.trim();
					await this.plugin.saveSettings();
					}));

		// 授权部分
		containerEl.createEl('h3', { text: '🔐 授权管理' });

		// 当前授权状态
		const authStatusEl = containerEl.createDiv('setting-item');
		const authStatusInfo = authStatusEl.createDiv('setting-item-info');
		authStatusInfo.createDiv('setting-item-name').setText('授权状态');
		
		const statusDesc = authStatusInfo.createDiv('setting-item-description');
		if (this.plugin.settings.userInfo) {
			statusDesc.innerHTML = `
				<span style="color: var(--text-success);">✅ 已授权</span><br>
				<strong>用户：</strong>${this.plugin.settings.userInfo.name}<br>
				<strong>邮箱：</strong>${this.plugin.settings.userInfo.email}
			`;
		} else {
			statusDesc.innerHTML = '<span style="color: var(--text-error);">❌ 未授权</span>';
		}

		// 自动授权按钮（推荐）
		new Setting(containerEl)
			.setName('🚀 一键授权（推荐）')
			.setDesc('自动打开浏览器完成授权，通过云端回调自动返回授权结果，无需手动操作')
			.addButton(button => {
				button
					.setButtonText('🚀 一键授权')
					.setCta()
					.onClick(() => {
						this.startAutoAuth();
					});
			});

		// 手动授权按钮（备用）
		new Setting(containerEl)
			.setName('📝 手动授权（备用）')
			.setDesc('如果一键授权遇到问题，可以使用传统的手动复制粘贴授权方式')
			.addButton(button => {
				button
					.setButtonText('手动授权')
					.onClick(() => {
						this.startManualAuth();
					});
			});

		// 清除授权
		if (this.plugin.settings.userInfo) {
			new Setting(containerEl)
				.setName('清除授权')
				.setDesc('清除当前的授权信息')
				.addButton(button => {
					button
						.setButtonText('🗑️ 清除授权')
						.setWarning()
						.onClick(async () => {
							this.plugin.settings.accessToken = '';
							this.plugin.settings.refreshToken = '';
							this.plugin.settings.userInfo = null;
							await this.plugin.saveSettings();
							this.plugin.feishuApi.updateSettings(this.plugin.settings);
							new Notice('✅ 授权信息已清除');
							this.display(); // 刷新界面
						});
				});
		}

		// 文件夹设置部分（仅在已授权时显示）
		if (this.plugin.settings.userInfo) {
			containerEl.createEl('h3', { text: '📁 默认文件夹' });

			// 当前默认文件夹显示
			new Setting(containerEl)
				.setName('当前默认文件夹')
				.setDesc(`文档将保存到：${this.plugin.settings.defaultFolderName || '我的空间'}${this.plugin.settings.defaultFolderId ? ` (ID: ${this.plugin.settings.defaultFolderId})` : ''}`)
				.addButton(button => {
					button
						.setButtonText('📁 选择文件夹')
						.onClick(() => {
							this.showFolderSelectModal();
						});
				});
		}

		// 使用说明部分
		containerEl.createEl('h3', { text: '📖 使用说明' });

		const usageEl = containerEl.createDiv('setting-item-description');

		// 详细使用说明链接
		const usageLinkDiv = usageEl.createDiv('feishu-usage-link');
		usageLinkDiv.createEl('strong', { text: '📚 详细使用说明' });
		usageLinkDiv.createEl('br');
		const usageLink = usageLinkDiv.createEl('a', {
			text: '🔗 点击查看完整使用教程',
			href: 'https://l0c34idk7v.feishu.cn/docx/Zk2VdWJPfoqmZhxPSJmcMfSbnHe'
		});
		usageLink.target = '_blank';

		// 快速配置指南
		const guideDiv = usageEl.createDiv('feishu-usage-guide');

		const guideTitle = guideDiv.createEl('strong', {
			text: '📋 快速配置指南',
			cls: 'feishu-usage-guide-title'
		});

		const stepsList = guideDiv.createEl('ol');

		// 步骤1
		const step1 = stepsList.createEl('li');
		step1.createEl('strong', { text: '创建飞书应用：' });
		step1.appendText('访问 ');
		const platformLink = step1.createEl('a', {
			text: '飞书开放平台 🔗',
			href: 'https://open.feishu.cn/app'
		});
		platformLink.target = '_blank';
		step1.appendText(' 创建"企业自建应用"，获取App ID和App Secret');

		// 步骤2
		const step2 = stepsList.createEl('li');
		step2.createEl('strong', { text: '配置OAuth回调：' });
		step2.appendText('在飞书应用"安全设置"中添加回调地址：');
		step2.createEl('br');
		step2.createEl('code', { text: 'https://md2feishu.xinqi.life/oauth-callback' });
		step2.createEl('br');
		step2.createEl('span', {
			text: '💡 默认使用我们的回调服务，代码开源可自行部署',
			cls: 'hint'
		});

		// 步骤3
		const step3 = stepsList.createEl('li');
		step3.createEl('strong', { text: '添加应用权限：' });
		step3.appendText('在"权限管理"中添加以下权限：');
		const permList = step3.createEl('ul');
		permList.createEl('li', { text: 'contact:user.base:readonly - 获取用户基本信息' });
		permList.createEl('li', { text: 'docx:document - 创建、编辑文档' });
		permList.createEl('li', { text: 'drive:drive - 访问云空间文件' });

		// 步骤4
		const step4 = stepsList.createEl('li');
		step4.createEl('strong', { text: '完成授权：' });
		step4.appendText('在上方输入App ID和App Secret，点击"🚀 一键授权"');

		// 步骤5
		const step5 = stepsList.createEl('li');
		step5.createEl('strong', { text: '选择文件夹：' });
		step5.appendText('授权后可选择默认保存文件夹（可选）');

		// 步骤6
		const step6 = stepsList.createEl('li');
		step6.createEl('strong', { text: '开始使用：' });
		step6.appendText('右键MD文件选择"📤 分享到飞书"，或使用命令面板');

		// 功能特色
		const featuresDiv = usageEl.createDiv('feishu-usage-guide');
		featuresDiv.createEl('strong', {
			text: '🎉 功能特色：',
			cls: 'feishu-usage-guide-title'
		});

		const featuresList = featuresDiv.createEl('ul');
		featuresList.createEl('li', { text: '✅ 智能授权：自动检测token状态，失效时自动重新授权' });
		featuresList.createEl('li', { text: '✅ 无缝分享：一键分享，自动处理授权和转换流程' });
		featuresList.createEl('li', { text: '✅ 格式保持：完美保持Markdown格式，包括图片、表格、代码块' });
		featuresList.createEl('li', { text: '✅ 智能处理：自动处理Obsidian双向链接、标签等语法' });
		featuresList.createEl('li', { text: '✅ 可视化选择：支持浏览和选择目标文件夹' });
		featuresList.createEl('li', { text: '✅ 一键复制：分享成功后可一键复制文档链接' });

	// 添加"了解作者"按钮
	this.addAuthorSection(containerEl);
}

private addAuthorSection(containerEl: HTMLElement) {
	// 添加分隔线
	containerEl.createEl('hr', { cls: 'feishu-author-separator' });

	// 创建作者信息区域
	const authorSection = containerEl.createDiv({ cls: 'feishu-author-section' });

	// 添加标题
	authorSection.createEl('h4', {
		text: '👨‍💻 了解作者',
		cls: 'feishu-author-title'
	});

	// 添加描述
	authorSection.createEl('p', {
		text: '想了解更多关于作者和其他项目的信息？',
		cls: 'feishu-author-description'
	});

	// 添加按钮
	const authorButton = authorSection.createEl('button', {
		text: '🌐 访问作者主页',
		cls: 'feishu-author-button'
	});

	authorButton.addEventListener('click', () => {
		window.open('https://ai.xinqi.life/about', '_blank');
	});
}

	private startAutoAuth() {
		if (!this.plugin.settings.appId || !this.plugin.settings.appSecret) {
			new Notice('❌ 请先配置 App ID 和 App Secret');
			console.error('Missing App ID or App Secret');
			return;
		}

		// 确保API服务有最新的设置
		this.plugin.feishuApi.updateSettings(this.plugin.settings);
		try {
			// 生成授权URL并打开浏览器
			const authUrl = this.plugin.feishuApi.generateAuthUrl();
			// 打开浏览器进行授权
			window.open(authUrl, '_blank');

			new Notice('🔄 已打开浏览器进行授权，完成后将自动返回Obsidian');

			// 监听授权成功事件
			const successHandler = () => {
				this.display(); // 刷新设置界面
				window.removeEventListener('feishu-auth-success', successHandler);
			};

			window.addEventListener('feishu-auth-success', successHandler);

		} catch (error) {
			console.error('Auto auth error:', error);
			new Notice(`❌ 自动授权失败: ${error.message}`);
		}
	}

	private startManualAuth(): void {
		if (!this.plugin.settings.appId || !this.plugin.settings.appSecret) {
			new Notice('❌ 请先配置 App ID 和 App Secret');
			return;
		}

		try {
			// 确保API服务有最新的设置
			this.plugin.feishuApi.updateSettings(this.plugin.settings);
			const modal = new ManualAuthModal(
				this.app,
				this.plugin.feishuApi,
				async () => {
					// 授权成功回调
					await this.plugin.saveSettings();
					this.display(); // 刷新设置界面
				}
			);
			modal.open();
		} catch (error) {
			console.error('[Feishu Plugin] Failed to start manual auth:', error);
			new Notice('❌ 启动授权失败，请重试');
		}
	}

	/**
	 * 显示文件夹选择模态框
	 */
	private showFolderSelectModal(): void {
		try {
			const modal = new FolderSelectModal(
				this.app,
				this.plugin.feishuApi,
				async (selectedFolder) => {
					try {
						if (selectedFolder) {
							// 用户选择了一个文件夹
							// 兼容两种属性名：folder_token 和 token
							this.plugin.settings.defaultFolderId = selectedFolder.folder_token || selectedFolder.token || '';
							this.plugin.settings.defaultFolderName = selectedFolder.name;
						} else {
							// 用户选择了根目录（我的空间）
							console.log('[Feishu Plugin] Root folder selected (我的空间)');
							this.plugin.settings.defaultFolderId = '';
							this.plugin.settings.defaultFolderName = '我的空间';
						}

						await this.plugin.saveSettings();
						new Notice('✅ 默认文件夹设置已保存');
						this.display(); // 刷新设置界面
					} catch (error) {
						console.error('[Feishu Plugin] Failed to save folder settings:', error);
						new Notice('❌ 保存文件夹设置失败');
					}
				}
			);

			modal.open();
		} catch (error) {
			console.error('[Feishu Plugin] Failed to open folder selection modal:', error);
			new Notice('❌ 打开文件夹选择失败');
		}
	}
}
