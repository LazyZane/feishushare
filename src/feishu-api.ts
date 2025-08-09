import { Notice, requestUrl, App, TFile, normalizePath } from 'obsidian';
import {
	FeishuSettings,
	FeishuOAuthResponse,
	FeishuApiError,
	ShareResult,
	FeishuUserInfo,
	FeishuFileUploadResponse,
	FeishuDocCreateResponse,
	FeishuFolderListResponse,
	LocalFileInfo,
	MarkdownProcessResult,
	FeishuDocBlocksResponse,
	FeishuBlockCreateResponse,
	PlaceholderBlock,
	SubDocumentResult
} from './types';
import { FEISHU_CONFIG, FEISHU_ERROR_MESSAGES } from './constants';

/**
 * 飞书 API 服务类 - 直接实现版本
 */
export class FeishuApiService {
	private settings: FeishuSettings;
	private app: App;

	constructor(settings: FeishuSettings, app: App) {
		this.settings = settings;
		this.app = app;
	}

	/**
	 * 更新设置
	 */
	updateSettings(settings: FeishuSettings) {
		this.settings = settings;
	}

	/**
	 * 生成授权 URL
	 */
	generateAuthUrl(): string {
		if (!this.settings.appId || !this.settings.appSecret) {
			throw new Error('请先在设置中配置飞书应用的 App ID 和 App Secret');
		}

		const state = this.generateRandomState();
		localStorage.setItem('feishu-oauth-state', state);

		// 使用配置的回调地址
		const redirectUri = this.settings.callbackUrl;

		const params = new URLSearchParams({
			app_id: this.settings.appId,
			redirect_uri: redirectUri,
			scope: FEISHU_CONFIG.SCOPES,
			state: state,
			response_type: 'code',
		});

		const authUrl = `${FEISHU_CONFIG.AUTHORIZE_URL}?${params.toString()}`;
		return authUrl;
	}



	/**
	 * 处理授权回调（从协议处理器调用）
	 */
	async processCallback(callbackUrl: string): Promise<boolean> {
		try {
			// 解析URL参数
			const url = new URL(callbackUrl);
			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');
			const error = url.searchParams.get('error');

			if (error) {
				console.error('OAuth error:', error);
				return false;
			}

			if (!code) {
				console.error('No authorization code in callback');
				return false;
			}

			// 验证state（如果需要）
			const savedState = localStorage.getItem('feishu-oauth-state');
			if (savedState && state !== savedState) {
				console.error('State mismatch');
				return false;
			}

			// 交换授权码获取token
			return await this.handleOAuthCallback(code);

		} catch (error) {
			console.error('Process callback error:', error);
			return false;
		}
	}

	/**
	 * 处理授权回调
	 */
	async handleOAuthCallback(authCode: string): Promise<boolean> {
		try {
			if (!this.settings.appId || !this.settings.appSecret) {
				throw new Error('应用配置不完整');
			}

			// 获取访问令牌
			const tokenResponse = await this.exchangeCodeForToken(authCode);
			
			if (!tokenResponse.success) {
				throw new Error(tokenResponse.error || '获取访问令牌失败');
			}

			// 获取用户信息
			const userInfo = await this.getUserInfo();
			
			if (userInfo) {
				this.settings.userInfo = userInfo;
				new Notice('✅ 飞书授权成功！');
				return true;
			} else {
				throw new Error('获取用户信息失败');
			}

		} catch (error) {
			console.error('OAuth callback error:', error);
			new Notice(`❌ 授权失败: ${error.message}`);
			return false;
		}
	}

	/**
	 * 使用授权码换取访问令牌
	 */
	private async exchangeCodeForToken(code: string): Promise<{success: boolean, error?: string}> {
		try {
			// 方案1：尝试使用应用凭证获取app_access_token，然后用于OAuth
			const appTokenResponse = await requestUrl({
				url: 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					app_id: this.settings.appId,
					app_secret: this.settings.appSecret
				})
			});

			const appTokenData = appTokenResponse.json || JSON.parse(appTokenResponse.text);
			if (appTokenData.code !== 0) {
				console.error('Failed to get app access token:', appTokenData);
				return { success: false, error: `获取应用令牌失败: ${appTokenData.msg}` };
			}

			const appAccessToken = appTokenData.app_access_token;
			// 方案2：使用app_access_token进行用户授权码交换
			const requestBody = {
				grant_type: 'authorization_code',
				code: code
			};

			const response = await requestUrl({
				url: FEISHU_CONFIG.TOKEN_URL,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${appAccessToken}`
				},
				body: JSON.stringify(requestBody)
			});

			// 尝试不同的方式获取响应数据
			let data: FeishuOAuthResponse;

			if (response.json && typeof response.json === 'object') {
				// 如果json是对象，直接使用
				data = response.json;
				} else if (response.text) {
				// 如果有text属性，解析JSON
				const responseText = response.text;
				data = JSON.parse(responseText);
			} else {
				// 尝试调用json()方法
				console.log('Trying to call response.json()...');
				data = await response.json();
			}

			if (data.code === 0) {
				this.settings.accessToken = data.data.access_token;
				this.settings.refreshToken = data.data.refresh_token;
				return { success: true };
			} else {
				console.error('Token exchange failed:', data);
				return { success: false, error: data.msg };
			}

		} catch (error) {
			console.error('Token exchange error:', error);
			return { success: false, error: error.message };
		}
	}

	/**
	 * 获取用户信息
	 */
	async getUserInfo(): Promise<FeishuUserInfo | null> {
		try {
			const response = await requestUrl({
				url: FEISHU_CONFIG.USER_INFO_URL,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json',
				}
			});

			const data = response.json || JSON.parse(response.text);

			if (data.code === 0) {
				return {
					name: data.data.name,
					avatar_url: data.data.avatar_url,
					email: data.data.email,
					user_id: data.data.user_id
				};
			} else {
				console.error('Get user info failed:', data);
				return null;
			}

		} catch (error) {
			console.error('Get user info error:', error);
			return null;
		}
	}

	/**
	 * 分享 Markdown 到飞书（带文件处理的完整流程）
	 */
	async shareMarkdownWithFiles(title: string, processResult: MarkdownProcessResult, statusNotice?: Notice): Promise<ShareResult> {
		try {
			// 更新状态：检查授权
			if (statusNotice) {
				statusNotice.setMessage('🔍 正在检查授权状态...');
			}

			// 检查并确保token有效
			const tokenValid = await this.ensureValidTokenWithReauth(statusNotice);
			if (!tokenValid) {
				throw new Error('授权失效且重新授权失败，请手动重新授权');
			}

			// 更新状态：开始上传
			if (statusNotice) {
				statusNotice.setMessage('📤 正在上传文件到飞书...');
			}

			// 第一步：上传 Markdown 文件
			const uploadResult = await this.uploadMarkdownFile(title, processResult.content);

			if (!uploadResult.success) {
				throw new Error(uploadResult.error || '文件上传失败');
			}

			if (!uploadResult.fileToken) {
				throw new Error('文件上传成功但未获取到文件令牌');
			}

			// 构建回退URL
			const fallbackFileUrl = uploadResult.url || `https://feishu.cn/file/${uploadResult.fileToken}`;

			// 第二步：尝试导入任务（15秒超时策略）
			try {
				// 处理文件名：移除 .md 扩展名
				const cleanTitle = title.endsWith('.md') ? title.slice(0, -3) : title;
				const importResult = await this.createImportTaskWithCorrectFolder(uploadResult.fileToken, cleanTitle);
				if (importResult.success && importResult.ticket) {
					// 第三步：等待导入完成（15秒超时）
					console.log('Step 3: Waiting for import completion (15s timeout)...');
					const finalResult = await this.waitForImportCompletionWithTimeout(importResult.ticket, 15000);
					if (finalResult.success && finalResult.documentToken) {
						const docUrl = `https://feishu.cn/docx/${finalResult.documentToken}`;

						// 第四步：处理子文档和文件上传（如果有本地文件）
						if (processResult.localFiles.length > 0) {
							try {
								// 分离子文档和普通文件
								const subDocuments = processResult.localFiles.filter(f => f.isSubDocument);
								const regularFiles = processResult.localFiles.filter(f => !f.isSubDocument);

								// 先处理子文档上传
								if (subDocuments.length > 0) {
									if (statusNotice) {
										statusNotice.setMessage(`📄 正在处理 ${subDocuments.length} 个子文档...`);
									}
									await this.processSubDocuments(finalResult.documentToken, subDocuments, statusNotice);
								}

								// 再处理普通文件上传
								if (regularFiles.length > 0) {
									if (statusNotice) {
										statusNotice.setMessage(`📎 正在处理 ${regularFiles.length} 个附件...`);
									}
									await this.processFileUploads(finalResult.documentToken, regularFiles, statusNotice);
								}
							} catch (fileError) {
								console.warn('⚠️ File upload processing failed:', fileError);
								// 文件上传失败不影响主流程，继续返回文档链接
							}
						}

						// 第五步：删除源文件（转换成功后）
						try {
							await this.deleteSourceFile(uploadResult.fileToken);
						} catch (deleteError) {
							console.warn('⚠️ Failed to delete source file:', deleteError.message);
							// 不影响主流程，继续返回成功结果
						}

						return {
							success: true,
							title: cleanTitle,
							url: docUrl
						};
					} else {
						console.warn('⚠️ Import task failed or timed out, falling back to file URL');
						console.warn('Final result details:', finalResult);
						return {
							success: true,
							title: title,
							url: fallbackFileUrl
						};
					}
				} else {
					console.warn('⚠️ Failed to create import task, falling back to file URL');
					console.warn('Import result details:', importResult);
					return {
						success: true,
						title: title,
						url: fallbackFileUrl
					};
				}
			} catch (importError) {
				console.warn('⚠️ Import process failed, falling back to file URL:', importError.message);
				console.error('Import error details:', importError);
				return {
					success: true,
					title: title,
					url: fallbackFileUrl
				};
			}

		} catch (error) {
			console.error('Share markdown error:', error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * 分享 Markdown 到飞书（完整流程：上传 → 转换 → 删除源文件）
	 */
	async shareMarkdown(title: string, content: string, statusNotice?: Notice): Promise<ShareResult> {
		try {
			// 更新状态：检查授权
			if (statusNotice) {
				statusNotice.setMessage('🔍 正在检查授权状态...');
			}

			// 检查并确保token有效
			const tokenValid = await this.ensureValidTokenWithReauth(statusNotice);
			if (!tokenValid) {
				throw new Error('授权失效且重新授权失败，请手动重新授权');
			}

			// 更新状态：开始上传
			if (statusNotice) {
				statusNotice.setMessage('📤 正在上传文件到飞书...');
			}

			// 第一步：上传 Markdown 文件
			const uploadResult = await this.uploadMarkdownFile(title, content);

			if (!uploadResult.success) {
				throw new Error(uploadResult.error || '文件上传失败');
			}

			if (!uploadResult.fileToken) {
				throw new Error('文件上传成功但未获取到文件令牌');
			}

			const fallbackFileUrl = `https://feishu.cn/file/${uploadResult.fileToken}`;

			// 更新状态：转换文档
			if (statusNotice) {
				statusNotice.setMessage('🔄 正在转换为飞书文档...');
			}

			// 第二步：尝试导入任务（15秒超时策略）
			try {
				// 处理文件名：移除 .md 扩展名
				const cleanTitle = title.endsWith('.md') ? title.slice(0, -3) : title;
				const importResult = await this.createImportTaskWithCorrectFolder(uploadResult.fileToken, cleanTitle);
				if (importResult.success && importResult.ticket) {
					// 第三步：等待导入完成（15秒超时）
					console.log('Step 3: Waiting for import completion (15s timeout)...');
					const finalResult = await this.waitForImportCompletionWithTimeout(importResult.ticket, 15000);
					if (finalResult.success && finalResult.documentToken) {
						const docUrl = `https://feishu.cn/docx/${finalResult.documentToken}`;
						// 第四步：删除源文件（转换成功后）
						try {
							await this.deleteSourceFile(uploadResult.fileToken);
							} catch (deleteError) {
							console.warn('⚠️ Failed to delete source file:', deleteError.message);
							// 不影响主流程，继续返回成功结果
						}

						return {
							success: true,
							title: cleanTitle,
							url: docUrl
						};
					} else {
						console.warn('⚠️ Import task failed or timed out, falling back to file URL');
						console.warn('Final result details:', finalResult);
						return {
							success: true,
							title: title,
							url: fallbackFileUrl
						};
					}
				} else {
					console.warn('⚠️ Failed to create import task, falling back to file URL');
					console.warn('Import result details:', importResult);
					return {
						success: true,
						title: title,
						url: fallbackFileUrl
					};
				}
			} catch (importError) {
				console.warn('⚠️ Import process failed, falling back to file URL:', importError.message);
				console.error('Import error details:', importError);
				return {
					success: true,
					title: title,
					url: fallbackFileUrl
				};
			}

		} catch (error) {
			console.error('Share markdown error:', error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * 获取文件夹列表
	 */
	async getFolderList(parentFolderId?: string): Promise<any> {
		try {
			// 确保token有效
			const tokenValid = await this.ensureValidToken();
			if (!tokenValid) {
				throw new Error('Token无效，请重新授权');
			}

			const url = `${FEISHU_CONFIG.BASE_URL}/drive/v1/files`;
			const params = new URLSearchParams({
				folder_token: parentFolderId || '',
				page_size: '50'
			});

			const response = await requestUrl({
				url: `${url}?${params.toString()}`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				}
			});

			const data = response.json || JSON.parse(response.text);

			if (data.code === 0) {
				// 过滤出文件夹，并确保属性名一致
				const folders = data.data.files
					.filter((file: any) => file.type === 'folder')
					.map((file: any) => ({
						...file,
						folder_token: file.token, // 添加兼容属性
						token: file.token         // 保留原始属性
					}));
				return {
					code: 0,
					data: {
						folders: folders,
						has_more: data.data.has_more
					}
				};
			} else {
				throw new Error(data.msg || '获取文件夹列表失败');
			}

		} catch (error) {
			console.error('Get folder list error:', error);
			throw error;
		}
	}

	/**
	 * 上传 Markdown 文件到飞书
	 */
	private async uploadMarkdownFile(fileName: string, content: string): Promise<{success: boolean, fileToken?: string, url?: string, error?: string}> {
		try {
			// 确保token有效
			const tokenValid = await this.ensureValidToken();
			if (!tokenValid) {
				throw new Error('Token无效，请重新授权');
			}

			// 使用固定的boundary（与成功版本一致）
			const boundary = '---7MA4YWxkTrZu0gW';
			const finalFileName = fileName.endsWith('.md') ? fileName : `${fileName}.md`;

			// 将内容转换为UTF-8字节
			const utf8Content = new TextEncoder().encode(content);
			const contentLength = utf8Content.length;

			// 手动构建multipart/form-data（完全按照成功的Python版本格式）
			const parts: string[] = [];

			// 1. file_name
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="file_name"`);
			parts.push('');
			parts.push(finalFileName);

			// 2. parent_type
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="parent_type"`);
			parts.push('');
			parts.push('explorer');

			// 3. size (使用UTF-8字节长度)
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="size"`);
			parts.push('');
			parts.push(contentLength.toString());

			// 4. parent_node (如果有)
			if (this.settings.defaultFolderId && this.settings.defaultFolderId !== '' && this.settings.defaultFolderId !== 'nodcn2EG5YG1i5Rsh5uZs0FsUje') {
				parts.push(`--${boundary}`);
				parts.push(`Content-Disposition: form-data; name="parent_node"`);
				parts.push('');
				parts.push(this.settings.defaultFolderId);
				console.log('📁 Upload: Using custom folder:', this.settings.defaultFolderId, '(' + this.settings.defaultFolderName + ')');
			} else {
				console.log('📁 Upload: Using root folder (我的空间) - no parent_node specified');
			}

			// 5. file (最后)
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="file"; filename="${finalFileName}"`);
			parts.push(`Content-Type: text/markdown`);
			parts.push('');

			// 组合文本部分
			const textPart = parts.join('\r\n') + '\r\n';
			const endBoundary = `\r\n--${boundary}--\r\n`;

			// 创建完整的请求体（文本 + 文件内容 + 结束边界）
			const textPartBytes = new TextEncoder().encode(textPart);
			const endBoundaryBytes = new TextEncoder().encode(endBoundary);

			const totalLength = textPartBytes.length + utf8Content.length + endBoundaryBytes.length;
			const bodyBytes = new Uint8Array(totalLength);

			let offset = 0;
			bodyBytes.set(textPartBytes, offset);
			offset += textPartBytes.length;
			bodyBytes.set(utf8Content, offset);
			offset += utf8Content.length;
			bodyBytes.set(endBoundaryBytes, offset);

			const response = await requestUrl({
				url: FEISHU_CONFIG.UPLOAD_URL,
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': `multipart/form-data; boundary=${boundary}`,
				},
				body: bodyBytes.buffer
			});

			const data: FeishuFileUploadResponse = response.json || JSON.parse(response.text);

			if (data.code === 0) {
				// 构建文件访问URL
				const fileUrl = `https://feishu.cn/file/${data.data.file_token}`;

				return {
					success: true,
					fileToken: data.data.file_token,
					url: fileUrl
				};
			} else {
				const errorMsg = FEISHU_ERROR_MESSAGES[data.code] || data.msg || '上传失败';
				console.error('Upload failed:', data);
				return {
					success: false,
					error: errorMsg
				};
			}

		} catch (error) {
			console.error('Upload file error:', error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * 刷新访问令牌
	 */
	async refreshAccessToken(): Promise<boolean> {
		try {
			if (!this.settings.refreshToken) {
				return false;
			}

			const response = await requestUrl({
				url: FEISHU_CONFIG.REFRESH_TOKEN_URL,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					grant_type: 'refresh_token',
					refresh_token: this.settings.refreshToken
				})
			});

			const data: FeishuOAuthResponse = response.json || JSON.parse(response.text);

			if (data.code === 0) {
				this.settings.accessToken = data.data.access_token;
				this.settings.refreshToken = data.data.refresh_token;
				return true;
			} else {
				console.error('Token refresh failed:', data);
				return false;
			}

		} catch (error) {
			console.error('Token refresh error:', error);
			return false;
		}
	}

	/**
	 * 生成随机状态值
	 */
	private generateRandomState(): string {
		return Math.random().toString(36).substring(2, 15) + 
			   Math.random().toString(36).substring(2, 15);
	}

	/**
	 * 检查并刷新token
	 */
	private async ensureValidToken(): Promise<boolean> {
		if (!this.settings.accessToken) {
			return false;
		}

		// 简单测试token是否有效
		try {
			const response = await requestUrl({
				url: FEISHU_CONFIG.USER_INFO_URL,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
				}
			});

			const data = response.json || JSON.parse(response.text);

			if (data.code === 0) {
				return true;
			} else if (data.code === 99991664) {
				// Token过期，尝试刷新
				return await this.refreshAccessToken();
			} else {
				return false;
			}

		} catch (error) {
			console.error('Token validation error:', error);
			return false;
		}
	}

	/**
	 * 增强的token验证，支持自动重新授权
	 */
	async ensureValidTokenWithReauth(statusNotice?: Notice): Promise<boolean> {
		if (!this.settings.accessToken) {
			return await this.triggerReauth('没有访问令牌', statusNotice);
		}

		// 测试当前token是否有效
		try {
			const response = await requestUrl({
				url: FEISHU_CONFIG.USER_INFO_URL,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
				}
			});

			const data = response.json || JSON.parse(response.text);

			if (data.code === 0) {
				return true;
			} else if (this.isTokenExpiredError(data.code)) {
				// Token过期，尝试刷新
				const refreshSuccess = await this.refreshAccessToken();

				if (refreshSuccess) {
					return true;
				} else {
					const reauthSuccess = await this.triggerReauth('Token刷新失败', statusNotice);
					if (reauthSuccess) {
						return true;
					}
					return false;
				}
			} else {
				const reauthSuccess = await this.triggerReauth(`Token无效 (错误码: ${data.code})`, statusNotice);
				if (reauthSuccess) {
					return true;
				}
				return false;
			}

		} catch (error) {
			console.error('Token验证出错:', error);
			const reauthSuccess = await this.triggerReauth('Token验证出错', statusNotice);
			if (reauthSuccess) {
				return true;
			}
			return false;
		}
	}

	/**
	 * 判断是否为token过期相关的错误码
	 */
	private isTokenExpiredError(code: number): boolean {
		// 常见的token过期错误码
		const expiredCodes = [
			99991664, // access_token expired
			99991663, // access_token invalid
			99991665, // refresh_token expired
			99991666, // refresh_token invalid
			1, // 通用的无效token错误
		];
		return expiredCodes.includes(code);
	}

	/**
	 * 触发重新授权流程，支持等待授权完成
	 */
	private async triggerReauth(reason: string, statusNotice?: Notice): Promise<boolean> {
		// 更新状态提示
		if (statusNotice) {
			statusNotice.setMessage(`🔄 ${reason}，正在自动重新授权...`);
		} else {
			new Notice(`🔄 ${reason}，正在自动重新授权...`);
		}

		try {
			// 检查应用配置
			if (!this.settings.appId || !this.settings.appSecret) {
				const errorMsg = '❌ 应用配置不完整，请在设置中配置 App ID 和 App Secret';
				if (statusNotice) {
					statusNotice.setMessage(errorMsg);
					setTimeout(() => statusNotice.hide(), 3000);
				} else {
					new Notice(errorMsg);
				}
				return false;
			}

			// 生成授权URL
			const authUrl = this.generateAuthUrl();
			// 打开浏览器进行授权
			window.open(authUrl, '_blank');

			// 更新状态：等待授权
			if (statusNotice) {
				statusNotice.setMessage('🌐 已打开浏览器进行重新授权，完成后将自动继续分享...');
			} else {
				new Notice('🌐 已打开浏览器进行重新授权，完成后将自动继续分享...');
			}

			// 等待授权完成
			return await this.waitForReauth(statusNotice);

		} catch (error) {
			console.error('重新授权失败:', error);
			new Notice(`❌ 重新授权失败: ${error.message}`);
			return false;
		}
	}

	/**
	 * 等待重新授权完成
	 */
	private async waitForReauth(statusNotice?: Notice): Promise<boolean> {
		return new Promise((resolve) => {
			// 设置超时时间（5分钟）
			const timeout = setTimeout(() => {
				window.removeEventListener('feishu-auth-success', successHandler);

				const timeoutMsg = '⏰ 授权等待超时，请手动重试分享';
				if (statusNotice) {
					statusNotice.setMessage(timeoutMsg);
					setTimeout(() => statusNotice.hide(), 3000);
				} else {
					new Notice(timeoutMsg);
				}
				resolve(false);
			}, 5 * 60 * 1000); // 5分钟超时

			// 监听授权成功事件
			const successHandler = () => {
				clearTimeout(timeout);
				window.removeEventListener('feishu-auth-success', successHandler);

				// 更新状态：授权成功，继续分享
				if (statusNotice) {
					statusNotice.setMessage('✅ 授权成功，正在继续分享...');
				}

				// 短暂延迟确保设置已保存
				setTimeout(() => {
					resolve(true);
				}, 1000);
			};

			window.addEventListener('feishu-auth-success', successHandler);
		});
	}

	/**
	 * 创建导入任务（带正确的文件夹设置）
	 */
	private async createImportTaskWithCorrectFolder(fileToken: string, title: string): Promise<{success: boolean, ticket?: string, error?: string}> {
		try {
			// 使用正确的point格式（与成功版本一致）
			const importData = {
				file_extension: 'md',
				file_token: fileToken,
				type: 'docx',
				file_name: title,
				point: {
					mount_type: 1, // 1=云空间
					mount_key: this.settings.defaultFolderId || 'nodcn2EG5YG1i5Rsh5uZs0FsUje' // 使用设置的文件夹或默认根文件夹
				}
			};

			if (this.settings.defaultFolderId && this.settings.defaultFolderId !== '' && this.settings.defaultFolderId !== 'nodcn2EG5YG1i5Rsh5uZs0FsUje') {
				console.log('✅ Import: Using custom folder:', this.settings.defaultFolderId, '(' + this.settings.defaultFolderName + ')');
			} else {
				console.log('✅ Import: Using default root folder (我的空间)');
			}

			console.log('Import task request:', JSON.stringify(importData, null, 2));

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/drive/v1/import_tasks`,
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(importData)
			});

			const data = response.json || JSON.parse(response.text);
			console.log('Import task response:', JSON.stringify(data, null, 2));

			if (data.code === 0) {
				return {
					success: true,
					ticket: data.data.ticket
				};
			} else {
				return {
					success: false,
					error: data.msg || '创建导入任务失败'
				};
			}

		} catch (error) {
			console.error('Create import task error:', error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * 等待导入完成（带超时）
	 */
	private async waitForImportCompletionWithTimeout(ticket: string, timeoutMs: number): Promise<{success: boolean, documentToken?: string, error?: string}> {
		console.log(`🚀 [NEW CODE] Starting import completion check with ticket: ${ticket}, timeout: ${timeoutMs}ms`);
		const startTime = Date.now();
		const maxAttempts = 25;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const elapsedTime = Date.now() - startTime;

			// 检查是否超时
			if (elapsedTime >= timeoutMs) {
				console.warn(`Import timeout after ${elapsedTime}ms`);
				return {
					success: false,
					error: `导入任务超时 (${timeoutMs}ms)`
				};
			}

			try {
				const result = await this.checkImportStatus(ticket);

				if (result.success && (result.status === 3 || result.status === 0)) {
					if (result.documentToken) {
						const totalTime = Date.now() - startTime;
						return {
							success: true,
							documentToken: result.documentToken
						};
					} else {
						console.warn('Import completed but no document token returned, continuing to wait...');
					}
				} else if (result.success && result.status === 2) {
					// 导入显示失败，但检查是否有document token
					console.log(`🔍 Status 2 detected. Document token: ${result.documentToken || 'none'}`);
					if (result.documentToken) {
						console.log(`✅ Import completed despite failure status, got document token: ${result.documentToken}`);
						return {
							success: true,
							documentToken: result.documentToken
						};
					} else {
						console.warn(`⚠️ Import shows failure status (${result.status}), no document token yet. Attempt ${attempt}/8, continuing to wait...`);
						if (attempt <= 8) { // 前8次尝试时，即使显示失败也继续等待
							// 继续等待
						} else {
							// 8次后才真正认为失败
							console.error('❌ Import failed after extended waiting');
							return {
								success: false,
								error: '导入任务失败'
							};
						}
					}
				} else {
					console.log(`📊 Other status: ${result.status}, success: ${result.success}`);
					}

				// 渐进式延迟
				if (attempt < maxAttempts) {
					const delay = this.getDelayForAttempt(attempt);
					await new Promise(resolve => setTimeout(resolve, delay));
				}

			} catch (error) {
				console.error('Check import status error:', error);
				// 继续尝试
				const delay = this.getDelayForAttempt(attempt);
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}

		// 超时
		return {
			success: false,
			error: '导入任务超时'
		};
	}

	/**
	 * 获取渐进式延迟时间
	 */
	private getDelayForAttempt(attempt: number): number {
		// 渐进式延迟策略：
		// 前3次：1秒 (快速检查)
		// 4-8次：2秒 (正常检查)
		// 9次以后：3秒 (慢速检查)
		if (attempt <= 3) {
			return 1000; // 1秒
		} else if (attempt <= 8) {
			return 2000; // 2秒
		} else {
			return 3000; // 3秒
		}
	}

	/**
	 * 检查导入状态
	 */
	private async checkImportStatus(ticket: string): Promise<{success: boolean, status?: number, documentToken?: string, error?: string}> {
		try {
			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/drive/v1/import_tasks/${ticket}`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				}
			});

			const data = response.json || JSON.parse(response.text);
			console.log('📋 Import status response:', JSON.stringify(data, null, 2));

			if (data.code === 0) {
				const result = data.data.result;
				console.log(`📊 Import status: ${result.job_status}, token: ${result.token || 'none'}`);
				return {
					success: true,
					status: result.job_status,
					documentToken: result.token
				};
			} else {
				console.error('❌ Import status check failed:', data);
				return {
					success: false,
					error: data.msg || '检查导入状态失败'
				};
			}

		} catch (error) {
			console.error('Check import status error:', error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * 删除源文件
	 */
	private async deleteSourceFile(fileToken: string): Promise<void> {
		try {
			// 方法1：尝试移动到回收站
			let response;
			try {
				response = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/drive/v1/files/${fileToken}/trash`,
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({})
				});
			} catch (trashError) {
				console.warn('⚠️ Trash method failed, trying direct delete...');
				// 方法2：尝试直接删除
				response = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/drive/v1/files/${fileToken}?type=file`,
					method: 'DELETE',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					}
				});
			}

			if (response.status !== 200) {
				throw new Error(`删除请求失败，状态码: ${response.status}`);
			}

			const data = response.json || JSON.parse(response.text);

			if (data.code !== 0) {
				console.warn('⚠️ Delete API returned non-zero code:', data.code, data.msg);
				// 不抛出错误，因为文件可能已经被删除或移动
				console.log('📝 Source file deletion completed (may have been moved to trash)');
			} else {
				}

		} catch (error) {
			console.error('❌ Delete source file error:', error);
			// 不抛出错误，避免影响整个分享流程
			}
	}

	/**
	 * 查找文档中的占位符文本块
	 */
	private async findPlaceholderBlocks(documentId: string, localFiles: LocalFileInfo[]): Promise<PlaceholderBlock[]> {
		try {
			const placeholderBlocks: PlaceholderBlock[] = [];
			let pageToken = '';
			let hasMore = true;

			// 创建占位符到文件信息的映射
			const placeholderMap = new Map<string, LocalFileInfo>();
			localFiles.forEach(file => {
				placeholderMap.set(file.placeholder, file);
			});

			while (hasMore) {
				const response = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks`,
					method: 'GET',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						page_size: 500,
						page_token: pageToken
					})
				});

				const data: FeishuDocBlocksResponse = response.json || JSON.parse(response.text);

				if (data.code !== 0) {
					throw new Error(data.msg || '获取文档块失败');
				}

				// 遍历所有块，查找包含占位符的文本块
				data.data.items.forEach((block, index) => {
					if (block.text && block.text.elements) {
						block.text.elements.forEach(element => {
							if (element.text_run && element.text_run.content) {
								const content = element.text_run.content;
								console.log(`🔍 Checking block content: "${content}"`);

								// 检查是否包含占位符（支持多种格式）
								for (const [placeholder, fileInfo] of placeholderMap) {
									// 原始格式：__FEISHU_FILE_timestamp_randomid__
									// 飞书处理后格式：!FEISHU_FILE_timestamp_randomid
									const cleanPlaceholder = placeholder.replace(/^__/, '').replace(/__$/, '');

									if (content.includes(placeholder) ||
										content.includes(`!${cleanPlaceholder}`) ||
										content.includes(cleanPlaceholder)) {
										console.log(`✅ Found placeholder match: "${placeholder}" in "${content}"`);
										placeholderBlocks.push({
											blockId: block.block_id,
											parentId: block.parent_id,
											index: index,
											placeholder: placeholder,
											fileInfo: fileInfo
										});
									}
								}
							}
						});
					}
				});

				hasMore = data.data.has_more;
				pageToken = data.data.page_token;
			}

			console.log(`🔍 Found ${placeholderBlocks.length} placeholder blocks`);
			return placeholderBlocks;

		} catch (error) {
			console.error('Find placeholder blocks error:', error);
			throw error;
		}
	}

	/**
	 * 在占位符位置插入文件块或图片块
	 */
	private async insertFileBlock(documentId: string, placeholderBlock: PlaceholderBlock): Promise<string> {
		try {
			const blockType = placeholderBlock.fileInfo.isImage ? 27 : 23; // 27=图片块, 23=文件块
			const blockContent = placeholderBlock.fileInfo.isImage ? { image: {} } : { file: {} };

			const requestData = {
				index: placeholderBlock.index,
				children: [
					{
						block_type: blockType,
						...blockContent
					}
				]
			};

			console.log(`🔧 Inserting ${placeholderBlock.fileInfo.isImage ? 'image' : 'file'} block:`, requestData);

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${placeholderBlock.parentId}/children`,
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestData)
			});

			const data: FeishuBlockCreateResponse = response.json || JSON.parse(response.text);
			console.log(`📋 Insert block response:`, data);

			if (data.code !== 0) {
				throw new Error(data.msg || '插入文件块失败');
			}

			const createdBlock = data.data.children[0];
			let targetBlockId = createdBlock.block_id;

			// 对于文件块，检查是否返回了View Block，如果是则需要获取其子块（File Block）
			if (!placeholderBlock.fileInfo.isImage && createdBlock.block_type === 33) {
				console.log(`📋 Created View Block for file, getting child File Block...`);
				// 如果创建的是View Block（block_type: 33），需要获取其子块（File Block）
				if (createdBlock.children && createdBlock.children.length > 0) {
					targetBlockId = createdBlock.children[0];
					console.log(`✅ Found File Block ID: ${targetBlockId}`);
				} else {
					console.warn('⚠️ View Block created but no child File Block found');
				}
			}

			console.log(`✅ Inserted ${placeholderBlock.fileInfo.isImage ? 'image' : 'file'} block: ${targetBlockId}`);
			return targetBlockId;

		} catch (error) {
			console.error('Insert file block error:', error);
			throw error;
		}
	}

	/**
	 * 上传文件素材到飞书文档
	 */
	private async uploadFileToDocument(documentId: string, blockId: string, fileInfo: LocalFileInfo, fileContent: ArrayBuffer): Promise<string> {
		try {
			// 确保token有效
			const tokenValid = await this.ensureValidToken();
			if (!tokenValid) {
				throw new Error('Token无效，请重新授权');
			}

			const boundary = '---7MA4YWxkTrZu0gW';
			const parentType = fileInfo.isImage ? 'docx_image' : 'docx_file';
			const contentLength = fileContent.byteLength;

			// 手动构建multipart/form-data
			const parts: string[] = [];

			// 1. file_name
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="file_name"`);
			parts.push('');
			parts.push(fileInfo.fileName);

			// 2. parent_type
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="parent_type"`);
			parts.push('');
			parts.push(parentType);

			// 3. parent_node
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="parent_node"`);
			parts.push('');
			parts.push(blockId);

			// 4. size
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="size"`);
			parts.push('');
			parts.push(contentLength.toString());

			// 5. extra
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="extra"`);
			parts.push('');
			parts.push(`{"drive_route_token":"${documentId}"}`);

			// 6. file
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="file"`);
			parts.push('Content-Type: application/octet-stream');
			parts.push('');

			const textPart = parts.join('\r\n') + '\r\n';
			const endBoundary = `\r\n--${boundary}--\r\n`;

			// 构建完整的请求体
			const textPartBytes = new TextEncoder().encode(textPart);
			const endBoundaryBytes = new TextEncoder().encode(endBoundary);
			const totalLength = textPartBytes.length + contentLength + endBoundaryBytes.length;

			const bodyBytes = new Uint8Array(totalLength);
			let offset = 0;
			bodyBytes.set(textPartBytes, offset);
			offset += textPartBytes.length;
			bodyBytes.set(new Uint8Array(fileContent), offset);
			offset += contentLength;
			bodyBytes.set(endBoundaryBytes, offset);

			const response = await requestUrl({
				url: FEISHU_CONFIG.UPLOAD_URL,
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': `multipart/form-data; boundary=${boundary}`,
				},
				body: bodyBytes.buffer
			});

			const data: FeishuFileUploadResponse = response.json || JSON.parse(response.text);

			if (data.code === 0) {
				console.log(`✅ Uploaded ${fileInfo.isImage ? 'image' : 'file'} material: ${data.data.file_token}`);
				return data.data.file_token;
			} else {
				const errorMsg = FEISHU_ERROR_MESSAGES[data.code] || data.msg || '上传文件素材失败';
				throw new Error(errorMsg);
			}

		} catch (error) {
			console.error('Upload file to document error:', error);
			throw error;
		}
	}

	/**
	 * 设置文件块内容
	 */
	private async setFileBlockContent(documentId: string, blockId: string, fileToken: string, isImage: boolean): Promise<void> {
		try {
			const requestData = isImage ?
				{ replace_image: { token: fileToken } } :
				{ replace_file: { token: fileToken } };

			console.log(`🔧 Setting ${isImage ? 'image' : 'file'} block content:`, {
				documentId,
				blockId,
				fileToken,
				requestData
			});

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${blockId}`,
				method: 'PATCH',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestData)
			});

			console.log(`📋 Set block content response status: ${response.status}`);
			const data = response.json || JSON.parse(response.text);
			console.log(`📋 Set block content response:`, data);

			if (data.code !== 0) {
				throw new Error(data.msg || '设置文件块内容失败');
			}

			console.log(`✅ Set ${isImage ? 'image' : 'file'} block content: ${blockId}`);

		} catch (error) {
			console.error('Set file block content error:', error);
			// 添加更详细的错误信息
			if (error.message && error.message.includes('400')) {
				console.error('❌ 400 Error details: This might be due to:');
				console.error('  1. Invalid file token or block ID');
				console.error('  2. File type not supported for this block type');
				console.error('  3. Block already has content');
				console.error('  4. API parameter format issue');
			}
			throw error;
		}
	}

	/**
	 * 替换占位符文本为文件名
	 */
	private async replacePlaceholderWithFileName(documentId: string, placeholderBlock: PlaceholderBlock, fileName: string): Promise<void> {
		try {
			// 替换占位符文本为文件名
			const requestData = {
				update_text_elements: {
					elements: [
						{
							text_run: {
								content: `📎 ${fileName}`
							}
						}
					]
				}
			};

			console.log(`🔧 Replacing placeholder with filename: ${fileName}`);

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${placeholderBlock.blockId}`,
				method: 'PATCH',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestData)
			});

			const data = response.json || JSON.parse(response.text);
			console.log(`📋 Replace with filename response:`, data);

			if (data.code !== 0) {
				console.warn(`⚠️ Failed to replace with filename: ${data.msg}, trying empty text...`);
				await this.replacePlaceholderText(documentId, placeholderBlock);
			} else {
				console.log(`✅ Replaced placeholder with filename: ${fileName}`);
			}

		} catch (error) {
			console.error('Replace placeholder with filename error:', error);
			// 如果替换失败，尝试空文本
			try {
				await this.replacePlaceholderText(documentId, placeholderBlock);
			} catch (fallbackError) {
				console.error('All replacement methods failed:', fallbackError);
			}
		}
	}

	/**
	 * 替换占位符文本为空文本
	 */
	private async replacePlaceholderText(documentId: string, placeholderBlock: PlaceholderBlock): Promise<void> {
		try {
			// 方法1：尝试替换文本内容为空
			const requestData = {
				update_text_elements: {
					elements: [
						{
							text_run: {
								content: ""
							}
						}
					]
				}
			};

			console.log(`🔧 Replacing placeholder text in block: ${placeholderBlock.blockId}`);

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${placeholderBlock.blockId}`,
				method: 'PATCH',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestData)
			});

			const data = response.json || JSON.parse(response.text);
			console.log(`📋 Replace placeholder response:`, data);

			if (data.code !== 0) {
				console.warn(`⚠️ Failed to replace placeholder text: ${data.msg}, trying delete method...`);
				// 如果替换失败，尝试删除方法
				await this.deletePlaceholderBlock(documentId, placeholderBlock);
			} else {
				console.log(`✅ Replaced placeholder text in block: ${placeholderBlock.blockId}`);
			}

		} catch (error) {
			console.error('Replace placeholder text error:', error);
			// 如果替换失败，尝试删除方法
			try {
				await this.deletePlaceholderBlock(documentId, placeholderBlock);
			} catch (deleteError) {
				console.error('Both replace and delete failed:', deleteError);
			}
		}
	}

	/**
	 * 删除占位符文本块（备用方法）
	 */
	private async deletePlaceholderBlock(documentId: string, placeholderBlock: PlaceholderBlock): Promise<void> {
		try {
			const requestData = {
				start_index: placeholderBlock.index,
				end_index: placeholderBlock.index + 1
			};

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${placeholderBlock.parentId}/children/batch_delete`,
				method: 'DELETE',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestData)
			});

			const data = response.json || JSON.parse(response.text);

			if (data.code !== 0) {
				throw new Error(data.msg || '删除占位符块失败');
			}

			console.log(`✅ Deleted placeholder block: ${placeholderBlock.blockId}`);

		} catch (error) {
			console.error('Delete placeholder block error:', error);
			throw error;
		}
	}

	/**
	 * 读取本地文件内容
	 */
	private async readLocalFile(filePath: string): Promise<ArrayBuffer | null> {
		try {
			// 清理和规范化路径
			let cleanPath = filePath.trim();

			// 移除开头的 ./ 或 .\
			cleanPath = cleanPath.replace(/^\.[\\/]/, '');

			// 规范化路径
			const normalizedPath = normalizePath(cleanPath);

			console.log(`🔍 Trying to read file: "${filePath}" -> "${normalizedPath}"`);

			// 获取文件对象
			let file = this.app.vault.getFileByPath(normalizedPath);

			if (!file) {
				// 尝试在所有文件中查找同名文件
				const allFiles = this.app.vault.getFiles();
				const fileName = normalizedPath.split('/').pop()?.toLowerCase();

				if (fileName) {
					const foundFile = allFiles.find(f => f.name.toLowerCase() === fileName);
					if (foundFile) {
						file = foundFile;
						console.log(`✅ Found file by name: ${file.path}`);
					}
				}
			}

			if (!file) {
				console.warn(`❌ File not found: ${normalizedPath}`);
				// 列出可能的文件供调试
				const allFiles = this.app.vault.getFiles();
				const similarFiles = allFiles.filter(f => f.name.includes(normalizedPath.split('/').pop() || ''));
				if (similarFiles.length > 0) {
					console.log('📋 Similar files found:', similarFiles.map(f => f.path));
				}
				return null;
			}

			// 读取二进制内容
			const content = await this.app.vault.readBinary(file);
			console.log(`✅ Successfully read file: ${file.path} (${content.byteLength} bytes)`);
			return content;

		} catch (error) {
			console.error(`❌ Error reading local file ${filePath}:`, error);
			return null;
		}
	}

	/**
	 * 处理第三阶段：文件上传和替换占位符
	 */
	async processFileUploads(documentId: string, localFiles: LocalFileInfo[], statusNotice?: Notice): Promise<void> {
		if (localFiles.length === 0) {
			console.log('📝 No local files to process');
			return;
		}

		try {
			if (statusNotice) {
				statusNotice.setMessage(`🔍 正在查找占位符 (${localFiles.length} 个文件)...`);
			}

			// 第一步：查找占位符文本块
			const placeholderBlocks = await this.findPlaceholderBlocks(documentId, localFiles);

			if (placeholderBlocks.length === 0) {
				console.warn('⚠️ No placeholder blocks found in document');
				return;
			}

			console.log(`🎯 Found ${placeholderBlocks.length} placeholder blocks to process`);

			// 按照原始文件顺序排序占位符块
			const sortedPlaceholderBlocks = this.sortPlaceholdersByOriginalOrder(placeholderBlocks, localFiles);
			console.log(`📋 Sorted placeholder blocks by original order`);

			// 处理每个占位符块
			for (let i = 0; i < sortedPlaceholderBlocks.length; i++) {
				const placeholderBlock = sortedPlaceholderBlocks[i];
				const fileInfo = placeholderBlock.fileInfo;

				if (statusNotice) {
					statusNotice.setMessage(`📤 正在上传文件 ${i + 1}/${sortedPlaceholderBlocks.length}: ${fileInfo.fileName}...`);
				}

				try {
					// 第二步：读取本地文件内容
					const fileContent = await this.readLocalFile(fileInfo.originalPath);
					if (!fileContent) {
						console.warn(`⚠️ Could not read file: ${fileInfo.originalPath}, skipping...`);
						continue;
					}

					// 第三步：调整插入位置（考虑之前插入的文件块）
					const adjustedPlaceholderBlock = {
						...placeholderBlock,
						index: placeholderBlock.index + i // 每插入一个文件，后续文件的位置需要向后移动
					};
					console.log(`📍 Adjusted insert position for ${fileInfo.fileName}: ${placeholderBlock.index} -> ${adjustedPlaceholderBlock.index}`);

					// 第四步：先创建文件块并上传文件
					const newBlockId = await this.insertFileBlock(documentId, adjustedPlaceholderBlock);
					const fileToken = await this.uploadFileToDocument(documentId, newBlockId, fileInfo, fileContent);
					await this.setFileBlockContent(documentId, newBlockId, fileToken, fileInfo.isImage);

					// 第五步：等待文件设置完成
					console.log('⏳ Waiting 2 seconds for file content to be set...');
					await new Promise(resolve => setTimeout(resolve, 2000));

					// 第六步：替换占位符文本为空文本（移除占位符）
					await this.replacePlaceholderText(documentId, placeholderBlock);

					console.log(`✅ Successfully processed file: ${fileInfo.fileName}`);

				} catch (fileError) {
					console.error(`❌ Failed to process file ${fileInfo.fileName}:`, fileError);
					// 继续处理其他文件，不中断整个流程
				}
			}

			console.log(`🎉 File upload processing completed: ${sortedPlaceholderBlocks.length} files processed`);

		} catch (error) {
			console.error('Process file uploads error:', error);
			throw error;
		}
	}

	/**
	 * 按照原始文件顺序排序占位符块
	 */
	private sortPlaceholdersByOriginalOrder(placeholderBlocks: PlaceholderBlock[], localFiles: LocalFileInfo[]): PlaceholderBlock[] {
		console.log('📋 Original localFiles order:');
		localFiles.forEach((file, index) => {
			console.log(`  ${index}: ${file.fileName} -> ${file.placeholder}`);
		});

		console.log('📋 Found placeholder blocks:');
		placeholderBlocks.forEach((block, index) => {
			console.log(`  ${index}: ${block.fileInfo.fileName} -> ${block.placeholder} (index: ${block.index})`);
		});

		// 创建文件顺序映射（基于localFiles数组的顺序）
		const fileOrderMap = new Map<string, number>();
		localFiles.forEach((file, index) => {
			fileOrderMap.set(file.placeholder, index);
		});

		// 按照原始顺序排序（优先使用localFiles顺序，其次使用文档中的index）
		const sorted = placeholderBlocks.sort((a, b) => {
			const orderA = fileOrderMap.get(a.placeholder) ?? 999;
			const orderB = fileOrderMap.get(b.placeholder) ?? 999;
			console.log(`🔄 Comparing: ${a.fileInfo.fileName}(order:${orderA}, index:${a.index}) vs ${b.fileInfo.fileName}(order:${orderB}, index:${b.index})`);

			// 如果localFiles顺序不同，使用localFiles顺序
			if (orderA !== orderB) {
				return orderA - orderB;
			}

			// 如果localFiles顺序相同，使用文档中的index
			return a.index - b.index;
		});

		console.log('📋 Sorted placeholder blocks:');
		sorted.forEach((block, index) => {
			console.log(`  ${index}: ${block.fileInfo.fileName} -> ${block.placeholder}`);
		});

		return sorted;
	}

	/**
	 * 处理子文档上传
	 */
	private async processSubDocuments(parentDocumentId: string, subDocuments: LocalFileInfo[], statusNotice?: Notice): Promise<void> {
		console.log(`🚀 Starting sub-document processing for ${subDocuments.length} documents`);

		for (let i = 0; i < subDocuments.length; i++) {
			const subDoc = subDocuments[i];

			try {
				if (statusNotice) {
					statusNotice.setMessage(`📄 正在处理子文档 ${i + 1}/${subDocuments.length}: ${subDoc.fileName}...`);
				}

				console.log(`📄 Processing sub-document: ${subDoc.fileName} (${subDoc.originalPath})`);

				// 读取子文档内容
				const subDocContent = await this.readSubDocumentContent(subDoc.originalPath);
				if (!subDocContent) {
					console.warn(`⚠️ Could not read sub-document: ${subDoc.originalPath}, skipping...`);
					continue;
				}

				// 上传子文档到飞书
				const subDocResult = await this.uploadSubDocument(subDoc.fileName, subDocContent);
				if (!subDocResult.success) {
					console.warn(`⚠️ Failed to upload sub-document: ${subDoc.fileName}, error: ${subDocResult.error}`);
					continue;
				}

				// 在父文档中插入子文档链接
				await this.insertSubDocumentLink(parentDocumentId, subDoc, subDocResult);

				console.log(`✅ Successfully processed sub-document: ${subDoc.fileName}`);

			} catch (error) {
				console.error(`❌ Error processing sub-document ${subDoc.fileName}:`, error);
				// 继续处理下一个子文档
			}
		}

		console.log(`✅ Completed sub-document processing`);
	}

	/**
	 * 读取子文档内容
	 */
	private async readSubDocumentContent(filePath: string): Promise<string | null> {
		try {
			// 清理和规范化路径
			let cleanPath = filePath.trim();
			const normalizedPath = normalizePath(cleanPath);

			console.log(`🔍 Reading sub-document: "${filePath}" -> "${normalizedPath}"`);

			// 获取文件对象
			let file = this.app.vault.getFileByPath(normalizedPath);

			if (!file) {
				// 尝试在所有Markdown文件中查找
				const allFiles = this.app.vault.getMarkdownFiles();
				const fileName = normalizedPath.split('/').pop()?.toLowerCase();

				if (fileName) {
					const foundFile = allFiles.find(f => f.name.toLowerCase() === fileName);
					if (foundFile) {
						file = foundFile;
						console.log(`✅ Found sub-document by name: ${file.path}`);
					}
				}
			}

			if (!file) {
				console.warn(`❌ Sub-document not found: ${normalizedPath}`);
				return null;
			}

			// 读取文本内容
			const content = await this.app.vault.read(file);
			console.log(`✅ Successfully read sub-document: ${file.path} (${content.length} characters)`);
			return content;

		} catch (error) {
			console.error(`❌ Error reading sub-document ${filePath}:`, error);
			return null;
		}
	}

	/**
	 * 上传子文档到飞书
	 */
	private async uploadSubDocument(title: string, content: string): Promise<SubDocumentResult> {
		try {
			console.log(`📤 Uploading sub-document: ${title}`);

			// 使用现有的上传方法
			const uploadResult = await this.uploadMarkdownFile(title, content);
			if (!uploadResult.success) {
				return {
					success: false,
					error: uploadResult.error || '子文档上传失败'
				};
			}

			// 创建导入任务
			const cleanTitle = title.endsWith('.md') ? title.slice(0, -3) : title;
			const importResult = await this.createImportTaskWithCorrectFolder(uploadResult.fileToken!, cleanTitle);

			if (!importResult.success) {
				return {
					success: false,
					error: importResult.error || '子文档导入任务创建失败'
				};
			}

			// 等待导入完成
			const finalResult = await this.waitForImportCompletionWithTimeout(importResult.ticket!, 15000);

			if (finalResult.success && finalResult.documentToken) {
				const docUrl = `https://feishu.cn/docx/${finalResult.documentToken}`;

				// 删除源文件
				try {
					await this.deleteSourceFile(uploadResult.fileToken!);
				} catch (deleteError) {
					console.warn('⚠️ Failed to delete sub-document source file:', deleteError);
				}

				return {
					success: true,
					documentToken: finalResult.documentToken,
					url: docUrl,
					title: cleanTitle
				};
			} else {
				return {
					success: false,
					error: '子文档导入超时或失败'
				};
			}

		} catch (error) {
			console.error('Upload sub-document error:', error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * 在父文档中插入子文档链接
	 */
	private async insertSubDocumentLink(parentDocumentId: string, subDocInfo: LocalFileInfo, subDocResult: SubDocumentResult): Promise<void> {
		try {
			console.log(`🔗 Inserting sub-document link for: ${subDocInfo.fileName}`);

			// 查找占位符位置
			const placeholderBlocks = await this.findPlaceholderBlocks(parentDocumentId, [subDocInfo]);

			if (placeholderBlocks.length === 0) {
				console.warn(`⚠️ No placeholder found for sub-document: ${subDocInfo.fileName}`);
				return;
			}

			const placeholderBlock = placeholderBlocks[0];

			// 创建链接文本
			const linkText = `📄 [${subDocResult.title}](${subDocResult.url})`;

			// 替换占位符为链接
			await this.replaceTextInBlock(parentDocumentId, placeholderBlock.blockId, linkText);

			console.log(`✅ Successfully inserted sub-document link: ${subDocInfo.fileName}`);

		} catch (error) {
			console.error(`❌ Error inserting sub-document link for ${subDocInfo.fileName}:`, error);
		}
	}

	/**
	 * 替换文档块中的文本
	 */
	private async replaceTextInBlock(documentId: string, blockId: string, newText: string): Promise<void> {
		try {
			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${blockId}`,
				method: 'PATCH',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					elements: [
						{
							text_run: {
								content: newText
							}
						}
					]
				})
			});

			const data = response.json || JSON.parse(response.text);
			if (data.code !== 0) {
				throw new Error(data.msg || '替换文本失败');
			}

			console.log(`✅ Successfully replaced text in block: ${blockId}`);

		} catch (error) {
			console.error(`❌ Error replacing text in block ${blockId}:`, error);
			throw error;
		}
	}
}
