import { App, Modal, Setting, Notice } from 'obsidian';
import { FeishuApiService } from './feishu-api';

export class ManualAuthModal extends Modal {
	private feishuApi: FeishuApiService;
	private onSuccess: () => void;

	constructor(app: App, feishuApi: FeishuApiService, onSuccess: () => void) {
		super(app);
		this.feishuApi = feishuApi;
		this.onSuccess = onSuccess;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: '🔐 飞书手动授权' });

		// 说明文字
		const descEl = contentEl.createDiv('setting-item-description');
		descEl.style.marginBottom = '20px';

		const titleP = descEl.createEl('p');
		const titleStrong = titleP.createEl('strong');
		titleStrong.textContent = '🚀 简化授权流程 - 只需复制粘贴URL：';

		const stepsList = descEl.createEl('ol');
		stepsList.createEl('li').textContent = '点击下方的"打开授权页面"按钮';
		stepsList.createEl('li').textContent = '在弹出的飞书页面中登录并确认授权';
		stepsList.createEl('li').textContent = '授权成功后，会跳转到一个显示错误的页面（这是正常的）';
		const step4 = stepsList.createEl('li');
		step4.createEl('strong').textContent = '复制浏览器地址栏的完整URL';
		step4.appendText('（包含 code= 参数）');
		stepsList.createEl('li').textContent = '将完整URL粘贴到下方输入框中';
		stepsList.createEl('li').textContent = '点击"完成授权"按钮';

		const tipDiv = descEl.createDiv();
		tipDiv.style.cssText = `
			background: var(--background-modifier-success);
			padding: 10px;
			border-radius: 4px;
			margin-top: 10px;
		`;
		const tipStrong = tipDiv.createEl('strong');
		tipStrong.textContent = '💡 提示：';
		tipDiv.appendText('无需手动提取授权码，直接复制完整的回调URL即可！');

		// 打开授权页面按钮
		new Setting(contentEl)
			.setName('第一步：打开授权页面')
			.setDesc('点击按钮在浏览器中打开飞书授权页面')
			.addButton(button => {
				button
					.setButtonText('🌐 打开授权页面')
					.setCta()
					.onClick(() => {
						try {
							const authUrl = this.feishuApi.generateAuthUrl();
							window.open(authUrl, '_blank');
							new Notice('✅ 授权页面已打开，请在浏览器中完成授权');
						} catch (error) {
							new Notice(`❌ 生成授权链接失败: ${error.message}`);
						}
					});
			});

		// 输入授权回调URL
		let callbackUrl = '';
		new Setting(contentEl)
			.setName('第二步：粘贴回调URL')
			.setDesc('从浏览器地址栏复制完整的回调URL并粘贴到此处')
			.addTextArea(text => {
				text
					.setPlaceholder('粘贴完整的回调URL，例如：https://example.com/callback?code=xxx&state=xxx')
					.setValue(callbackUrl)
					.onChange(value => {
						callbackUrl = value.trim();
					});
				text.inputEl.style.width = '100%';
				text.inputEl.style.height = '80px';
			});

		// 完成授权按钮
		new Setting(contentEl)
			.setName('第三步：完成授权')
			.setDesc('解析回调URL并完成授权流程')
			.addButton(button => {
				button
					.setButtonText('✅ 完成授权')
					.setCta()
					.onClick(async () => {
						await this.processCallback(callbackUrl);
					});
			});

		// 取消按钮
		new Setting(contentEl)
			.addButton(button => {
				button
					.setButtonText('取消')
					.onClick(() => {
						this.close();
					});
			});
	}

	private async processCallback(callbackUrl: string) {
		try {
			if (!callbackUrl) {
				new Notice('❌ 请先粘贴回调URL');
				return;
			}

			// 解析URL中的授权码
			const url = new URL(callbackUrl);
			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');

			if (!code) {
				new Notice('❌ 回调URL中未找到授权码，请检查URL是否完整');
				return;
			}

			// 验证state（如果有的话）
			const savedState = localStorage.getItem('feishu-oauth-state');
			if (savedState && state !== savedState) {
				new Notice('❌ 状态验证失败，请重新授权');
				return;
			}

			new Notice('🔄 正在处理授权...');

			// 处理授权回调
			const success = await this.feishuApi.handleOAuthCallback(code);

			if (success) {
				new Notice('🎉 授权成功！');
				this.onSuccess();
				this.close();
			} else {
				new Notice('❌ 授权处理失败，请重试');
			}

		} catch (error) {
			console.error('Process callback error:', error);
			new Notice(`❌ 处理授权时发生错误: ${error.message}`);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
