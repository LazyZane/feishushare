import { Notice, requestUrl, App, TFile, normalizePath } from 'obsidian';
import {
	FeishuSettings,
	FeishuOAuthResponse,
	ShareResult,
	FeishuUserInfo,
	FeishuFileUploadResponse,
	LocalFileInfo,
	MarkdownProcessResult,
	FeishuDocBlocksResponse,
	FeishuBlockCreateResponse,
	PlaceholderBlock,
	SubDocumentResult
} from './types';
import { FEISHU_CONFIG, FEISHU_ERROR_MESSAGES } from './constants';
import { Debug } from './debug';
import { MarkdownProcessor } from './markdown-processor';

/**
 * 飞书 API 服务类 - 直接实现版本
 */
export class FeishuApiService {
	private settings: FeishuSettings;
	private app: App;
	private markdownProcessor: MarkdownProcessor;

	constructor(settings: FeishuSettings, app: App) {
		this.settings = settings;
		this.app = app;
		this.markdownProcessor = new MarkdownProcessor(app);
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
				Debug.error('OAuth error:', error);
				return false;
			}

			if (!code) {
				Debug.error('No authorization code in callback');
				return false;
			}

			// 验证state（如果需要）
			const savedState = localStorage.getItem('feishu-oauth-state');
			if (savedState && state !== savedState) {
				Debug.error('State mismatch');
				return false;
			}

			// 交换授权码获取token
			return await this.handleOAuthCallback(code);

		} catch (error) {
			Debug.error('Process callback error:', error);
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
			Debug.error('OAuth callback error:', error);
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
				Debug.error('Failed to get app access token:', appTokenData);
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
				Debug.log('Trying to call response.json()...');
				data = await response.json();
			}

			if (data.code === 0) {
				this.settings.accessToken = data.data.access_token;
				this.settings.refreshToken = data.data.refresh_token;
				return { success: true };
			} else {
				Debug.error('Token exchange failed:', data);
				return { success: false, error: data.msg };
			}

		} catch (error) {
			Debug.error('Token exchange error:', error);
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
				Debug.error('Get user info failed:', data);
				return null;
			}

		} catch (error) {
			Debug.error('Get user info error:', error);
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
					Debug.log('Step 3: Waiting for import completion (15s timeout)...');
					const finalResult = await this.waitForImportCompletionWithTimeout(importResult.ticket, 15000);
					if (finalResult.success && finalResult.documentToken) {
						const docUrl = `https://feishu.cn/docx/${finalResult.documentToken}`;

						// 第四步：并行处理权限设置和源文件删除
						const parallelTasks: Promise<void>[] = [];

						// 权限设置任务
						if (this.settings.enableLinkShare && finalResult.documentToken) {
							const permissionTask = (async () => {
								try {
									if (statusNotice) {
										statusNotice.setMessage('🔗 正在设置文档分享权限...');
									}

									// 新创建的文档，跳过权限检查直接设置
									await this.setDocumentSharePermissions(finalResult.documentToken!, true);
									Debug.log('✅ Document share permissions set successfully');
								} catch (permissionError) {
									Debug.warn('⚠️ Failed to set document share permissions:', permissionError);
									// 权限设置失败不影响主流程
								}
							})();
							parallelTasks.push(permissionTask);
						}

						// 等待所有并行任务完成
						if (parallelTasks.length > 0) {
							await Promise.allSettled(parallelTasks);
						}

						// 第五步：处理子文档和文件上传（如果有本地文件）
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
								Debug.warn('⚠️ File upload processing failed:', fileError);
								// 文件上传失败不影响主流程，继续返回文档链接
							}
						}

						// 第六步：删除源文件（转换成功后）
						try {
							await this.deleteSourceFile(uploadResult.fileToken);
						} catch (deleteError) {
							Debug.warn('⚠️ Failed to delete source file:', deleteError.message);
							// 不影响主流程，继续返回成功结果
						}

						return {
							success: true,
							title: cleanTitle,
							url: docUrl
						};
					} else {
						Debug.warn('⚠️ Import task failed or timed out, falling back to file URL');
						Debug.warn('Final result details:', finalResult);
						return {
							success: true,
							title: title,
							url: fallbackFileUrl
						};
					}
				} else {
					Debug.warn('⚠️ Failed to create import task, falling back to file URL');
					Debug.warn('Import result details:', importResult);
					return {
						success: true,
						title: title,
						url: fallbackFileUrl
					};
				}
			} catch (importError) {
				Debug.warn('⚠️ Import process failed, falling back to file URL:', importError.message);
				Debug.error('Import error details:', importError);
				return {
					success: true,
					title: title,
					url: fallbackFileUrl
				};
			}

		} catch (error) {
			Debug.error('Share markdown error:', error);
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
					Debug.log('Step 3: Waiting for import completion (15s timeout)...');
					const finalResult = await this.waitForImportCompletionWithTimeout(importResult.ticket, 15000);
					if (finalResult.success && finalResult.documentToken) {
						const docUrl = `https://feishu.cn/docx/${finalResult.documentToken}`;

						// 第四步：并行处理权限设置和源文件删除
						const parallelTasks: Promise<void>[] = [];

						// 权限设置任务
						if (this.settings.enableLinkShare && finalResult.documentToken) {
							const permissionTask = (async () => {
								try {
									if (statusNotice) {
										statusNotice.setMessage('🔗 正在设置文档分享权限...');
									}

									// 新创建的文档，跳过权限检查直接设置
									await this.setDocumentSharePermissions(finalResult.documentToken!, true);
									Debug.log('✅ Document share permissions set successfully');
								} catch (permissionError) {
									Debug.warn('⚠️ Failed to set document share permissions:', permissionError);
									// 权限设置失败不影响主流程
								}
							})();
							parallelTasks.push(permissionTask);
						}

						// 源文件删除任务
						const deleteTask = (async () => {
							try {
								await this.deleteSourceFile(uploadResult.fileToken!);
							} catch (deleteError) {
								Debug.warn('⚠️ Failed to delete source file:', deleteError);
								// 不影响主流程，继续返回成功结果
							}
						})();
						parallelTasks.push(deleteTask);

						// 等待所有并行任务完成
						await Promise.allSettled(parallelTasks);



						return {
							success: true,
							title: cleanTitle,
							url: docUrl
						};
					} else {
						Debug.warn('⚠️ Import task failed or timed out, falling back to file URL');
						Debug.warn('Final result details:', finalResult);
						return {
							success: true,
							title: title,
							url: fallbackFileUrl
						};
					}
				} else {
					Debug.warn('⚠️ Failed to create import task, falling back to file URL');
					Debug.warn('Import result details:', importResult);
					return {
						success: true,
						title: title,
						url: fallbackFileUrl
					};
				}
			} catch (importError) {
				Debug.warn('⚠️ Import process failed, falling back to file URL:', importError.message);
				Debug.error('Import error details:', importError);
				return {
					success: true,
					title: title,
					url: fallbackFileUrl
				};
			}

		} catch (error) {
			Debug.error('Share markdown error:', error);
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
			Debug.error('Get folder list error:', error);
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
				// 使用自定义文件夹
			} else {
				// 使用根文件夹
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
				Debug.error('Upload failed:', data);
				return {
					success: false,
					error: errorMsg
				};
			}

		} catch (error) {
			Debug.error('Upload file error:', error);
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
				Debug.error('Token refresh failed:', data);
				return false;
			}

		} catch (error) {
			Debug.error('Token refresh error:', error);
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
			Debug.error('Token validation error:', error);
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
			Debug.error('Token验证出错:', error);
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
			Debug.error('重新授权失败:', error);
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

			// 使用配置的文件夹或默认根文件夹

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
			Debug.error('Create import task error:', error);
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
		const startTime = Date.now();
		const maxAttempts = 25;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const elapsedTime = Date.now() - startTime;

			// 检查是否超时
			if (elapsedTime >= timeoutMs) {
				Debug.warn(`Import timeout after ${elapsedTime}ms`);
				return {
					success: false,
					error: `导入任务超时 (${timeoutMs}ms)`
				};
			}

			try {
				const result = await this.checkImportStatus(ticket);

				if (result.success && (result.status === 3 || result.status === 0)) {
					if (result.documentToken) {
						return {
							success: true,
							documentToken: result.documentToken
						};
					} else {
						Debug.warn('Import completed but no document token returned, continuing to wait...');
					}
				} else if (result.success && result.status === 2) {
					// 导入显示失败，但检查是否有document token
					Debug.log(`🔍 Status 2 detected. Document token: ${result.documentToken || 'none'}`);
					if (result.documentToken) {
						Debug.log(`✅ Import completed despite failure status, got document token: ${result.documentToken}`);
						return {
							success: true,
							documentToken: result.documentToken
						};
					} else {
						Debug.warn(`⚠️ Import shows failure status (${result.status}), no document token yet. Attempt ${attempt}/8, continuing to wait...`);
						if (attempt <= 8) { // 前8次尝试时，即使显示失败也继续等待
							// 继续等待
						} else {
							// 8次后才真正认为失败
							Debug.error('❌ Import failed after extended waiting');
							return {
								success: false,
								error: '导入任务失败'
							};
						}
					}
				} else {
					Debug.log(`📊 Other status: ${result.status}, success: ${result.success}`);
					}

				// 渐进式延迟
				if (attempt < maxAttempts) {
					const delay = this.getDelayForAttempt(attempt);
					await new Promise(resolve => setTimeout(resolve, delay));
				}

			} catch (error) {
				Debug.error('Check import status error:', error);
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

			if (data.code === 0) {
				const result = data.data.result;
				return {
					success: true,
					status: result.job_status,
					documentToken: result.token
				};
			} else {
				Debug.error('❌ Import status check failed:', data);
				return {
					success: false,
					error: data.msg || '检查导入状态失败'
				};
			}

		} catch (error) {
			Debug.error('Check import status error:', error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * 删除源文件（改进版本）
	 */
	private async deleteSourceFile(fileToken: string): Promise<void> {
		try {
			Debug.verbose(`🗑️ Attempting to delete source file: ${fileToken}`);

			// 先检查文件是否存在
			let fileExists = false;
			try {
				const checkResponse = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/drive/v1/files/${fileToken}/meta`,
					method: 'GET',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					}
				});

				const checkData = checkResponse.json || JSON.parse(checkResponse.text);
				fileExists = checkData.code === 0;
				Debug.verbose(`🗑️ File existence check: ${fileExists ? 'exists' : 'not found'}`);

			} catch (checkError) {
				Debug.verbose(`🗑️ File existence check failed, assuming file exists:`, checkError.message);
				fileExists = true; // 假设文件存在，继续删除流程
			}

			if (!fileExists) {
				Debug.log(`📝 Source file ${fileToken} does not exist, skipping deletion`);
				return;
			}

			// 方法1：尝试移动到回收站
			let response: any;
			let deleteMethod = 'trash';

			try {
				Debug.verbose(`🗑️ Trying trash method for file: ${fileToken}`);
				response = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/drive/v1/files/${fileToken}/trash`,
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({})
				});

				Debug.verbose(`🗑️ Trash method response status: ${response.status}`);

			} catch (trashError) {
				const errorMsg = trashError.message || trashError.toString();

				// 如果是404错误，说明文件已经不存在了
				if (errorMsg.includes('404')) {
					Debug.log(`📝 Source file ${fileToken} not found (404), likely already deleted`);
					return;
				}

				Debug.warn(`⚠️ Trash method failed for ${fileToken}:`, errorMsg);
				Debug.log('🔄 Falling back to direct delete method...');

				deleteMethod = 'direct';

				// 方法2：尝试直接删除
				try {
					response = await requestUrl({
						url: `${FEISHU_CONFIG.BASE_URL}/drive/v1/files/${fileToken}?type=file`,
						method: 'DELETE',
						headers: {
							'Authorization': `Bearer ${this.settings.accessToken}`,
							'Content-Type': 'application/json'
						}
					});

					Debug.verbose(`🗑️ Direct delete response status: ${response.status}`);

				} catch (directError) {
					const directErrorMsg = directError.message || directError.toString();

					// 如果直接删除也是404，说明文件确实不存在
					if (directErrorMsg.includes('404')) {
						Debug.log(`📝 Source file ${fileToken} not found during direct delete, likely already deleted`);
						return;
					}

					throw directError; // 其他错误继续抛出
				}
			}

			// 检查响应状态
			if (response.status !== 200) {
				throw new Error(`删除请求失败，状态码: ${response.status}`);
			}

			const data = response.json || JSON.parse(response.text);
			Debug.verbose(`🗑️ Delete response data:`, data);

			if (data.code !== 0) {
				Debug.warn(`⚠️ Delete API returned non-zero code: ${data.code} - ${data.msg}`);
				// 不抛出错误，因为文件可能已经被删除或移动
				Debug.log(`📝 Source file deletion completed with warning (method: ${deleteMethod})`);
			} else {
				Debug.log(`✅ Source file deleted successfully using ${deleteMethod} method: ${fileToken}`);
			}

		} catch (error) {
			Debug.error('❌ Delete source file error:', error);
			Debug.warn(`⚠️ Failed to delete source file ${fileToken}, but continuing with process`);
			// 不抛出错误，避免影响整个分享流程
		}
	}

	/**
	 * 查找文档中的占位符文本块（优化版本）
	 */
	private async findPlaceholderBlocks(documentId: string, localFiles: LocalFileInfo[]): Promise<PlaceholderBlock[]> {
		try {
			const placeholderBlocks: PlaceholderBlock[] = [];
			let pageToken = '';
			let hasMore = true;

			// 预编译占位符模式（方案3：智能搜索优化）
			const placeholderPatterns = this.compilePlaceholderPatterns(localFiles);
			const remainingPlaceholders = new Set(localFiles.map(f => f.placeholder));

			Debug.log(`🔍 Searching for ${remainingPlaceholders.size} placeholders in document...`);

			while (hasMore && remainingPlaceholders.size > 0) { // 方案1：早期退出
				// 构建查询参数
				const params = new URLSearchParams({
					page_size: '500'
				});
				if (pageToken) {
					params.append('page_token', pageToken);
				}

				const response = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks?${params.toString()}`,
					method: 'GET',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					}
				});

				const data: FeishuDocBlocksResponse = response.json || JSON.parse(response.text);

				if (data.code !== 0) {
					throw new Error(data.msg || '获取文档块失败');
				}

				// 优化的块遍历逻辑
				const foundInThisPage = this.searchPlaceholdersInBlocks(
					data.data.items,
					placeholderPatterns,
					remainingPlaceholders
				);

				placeholderBlocks.push(...foundInThisPage);

				// 方案1：早期退出 - 所有占位符都找到了就停止
				if (remainingPlaceholders.size === 0) {
					Debug.log(`✅ All ${localFiles.length} placeholders found, stopping search early`);
					break;
				}

				hasMore = data.data.has_more;
				pageToken = data.data.page_token;
			}

			Debug.log(`🎯 Found ${placeholderBlocks.length}/${localFiles.length} placeholder blocks`);
			return placeholderBlocks;

		} catch (error) {
			Debug.error('Find placeholder blocks error:', error);
			throw error;
		}
	}

	/**
	 * 预编译占位符模式（方案3优化）
	 */
	private compilePlaceholderPatterns(localFiles: LocalFileInfo[]): Map<string, {fileInfo: LocalFileInfo, patterns: RegExp[]}> {
		const patterns = new Map<string, {fileInfo: LocalFileInfo, patterns: RegExp[]}>();

		localFiles.forEach(fileInfo => {
			const placeholder = fileInfo.placeholder;
			const cleanPlaceholder = placeholder.replace(/^__/, '').replace(/__$/, '');

			// 预编译所有可能的占位符格式的正则表达式
			const regexPatterns = [
				new RegExp(this.escapeRegExp(placeholder)), // 原始格式
				new RegExp(this.escapeRegExp(`!${cleanPlaceholder}`)), // 飞书处理后格式
				new RegExp(this.escapeRegExp(cleanPlaceholder)) // 清理后格式
			];

			patterns.set(placeholder, {
				fileInfo,
				patterns: regexPatterns
			});
		});

		return patterns;
	}

	/**
	 * 在块列表中搜索占位符（优化版本）
	 */
	private searchPlaceholdersInBlocks(
		blocks: any[],
		placeholderPatterns: Map<string, {fileInfo: LocalFileInfo, patterns: RegExp[]}>,
		remainingPlaceholders: Set<string>
	): PlaceholderBlock[] {
		const foundBlocks: PlaceholderBlock[] = [];

		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			const block = blocks[blockIndex];

			// 只处理文本块
			if (!block.text || !block.text.elements) {
				continue;
			}

			// 提取块的所有文本内容
			const blockContent = this.extractBlockTextContent(block);

			// 如果块内容不包含占位符特征，跳过
			if (!this.hasPlaceholderFeatures(blockContent)) {
				continue;
			}

			// 检查剩余的占位符
			for (const placeholder of remainingPlaceholders) {
				const patternInfo = placeholderPatterns.get(placeholder);
				if (!patternInfo) continue;

				// 使用预编译的正则表达式进行匹配
				const isMatch = patternInfo.patterns.some(pattern => pattern.test(blockContent));

				if (isMatch) {
					Debug.log(`✅ Found placeholder: "${placeholder}" in block ${block.block_id}`);

					foundBlocks.push({
						blockId: block.block_id,
						parentId: block.parent_id,
						index: blockIndex,
						placeholder: placeholder,
						fileInfo: patternInfo.fileInfo
					});

					// 从剩余列表中移除已找到的占位符
					remainingPlaceholders.delete(placeholder);

					// 如果所有占位符都找到了，可以提前退出
					if (remainingPlaceholders.size === 0) {
						return foundBlocks;
					}
				}
			}
		}

		return foundBlocks;
	}

	/**
	 * 提取块的文本内容
	 */
	private extractBlockTextContent(block: any): string {
		return block.text.elements
			.filter((element: any) => element.text_run && element.text_run.content)
			.map((element: any) => element.text_run.content)
			.join('');
	}

	/**
	 * 检查文本是否包含占位符特征（快速预筛选）
	 */
	private hasPlaceholderFeatures(content: string): boolean {
		// 快速检查是否包含占位符的特征字符串
		return content.includes('FEISHU_FILE_') || content.includes('__FEISHU_FILE_');
	}

	/**
	 * 转义正则表达式特殊字符
	 */
	private escapeRegExp(string: string): string {
		return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

			if (data.code !== 0) {
				throw new Error(data.msg || '插入文件块失败');
			}

			const createdBlock = data.data.children[0];
			let targetBlockId = createdBlock.block_id;

			// 对于文件块，检查是否返回了View Block，如果是则需要获取其子块（File Block）
			if (!placeholderBlock.fileInfo.isImage && createdBlock.block_type === 33) {
				// 如果创建的是View Block（block_type: 33），需要获取其子块（File Block）
				if (createdBlock.children && createdBlock.children.length > 0) {
					targetBlockId = createdBlock.children[0];
				} else {
					Debug.warn('⚠️ View Block created but no child File Block found');
				}
			}
			return targetBlockId;

		} catch (error) {
			Debug.error('Insert file block error:', error);
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
				Debug.log(`✅ Uploaded ${fileInfo.isImage ? 'image' : 'file'} material: ${data.data.file_token}`);
				return data.data.file_token;
			} else {
				const errorMsg = FEISHU_ERROR_MESSAGES[data.code] || data.msg || '上传文件素材失败';
				throw new Error(errorMsg);
			}

		} catch (error) {
			Debug.error('Upload file to document error:', error);
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

			Debug.log(`🔧 Setting ${isImage ? 'image' : 'file'} block content:`, {
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

			Debug.log(`📋 Set block content response status: ${response.status}`);
			const data = response.json || JSON.parse(response.text);
			Debug.log(`📋 Set block content response:`, data);

			if (data.code !== 0) {
				throw new Error(data.msg || '设置文件块内容失败');
			}

			Debug.log(`✅ Set ${isImage ? 'image' : 'file'} block content: ${blockId}`);

		} catch (error) {
			Debug.error('Set file block content error:', error);
			// 添加更详细的错误信息
			if (error.message && error.message.includes('400')) {
				Debug.error('❌ 400 Error details: This might be due to:');
				Debug.error('  1. Invalid file token or block ID');
				Debug.error('  2. File type not supported for this block type');
				Debug.error('  3. Block already has content');
				Debug.error('  4. API parameter format issue');
			}
			throw error;
		}
	}



	/**
	 * 查找仍然存在的占位符
	 */
	private async findRemainingPlaceholders(documentId: string, placeholderBlocks: PlaceholderBlock[]): Promise<PlaceholderBlock[]> {
		try {
			Debug.log(`🔍 Checking ${placeholderBlocks.length} placeholders for remaining content...`);
			const remainingPlaceholders: PlaceholderBlock[] = [];
			const checkedBlocks = new Set<string>(); // 防止重复检查

			// 获取文档的所有块
			let pageToken = '';
			let hasMore = true;
			let allBlocks: any[] = [];

			// 先收集所有块
			while (hasMore) {
				const response = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks?page_size=500${pageToken ? `&page_token=${pageToken}` : ''}`,
					method: 'GET',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					}
				});

				const data: FeishuDocBlocksResponse = response.json || JSON.parse(response.text);

				if (data.code !== 0) {
					Debug.warn('Failed to get document blocks for placeholder check:', data.msg);
					break;
				}

				allBlocks.push(...data.data.items);
				hasMore = data.data.has_more;
				pageToken = data.data.page_token;
			}

			Debug.log(`📋 Retrieved ${allBlocks.length} blocks from document`);

			// 检查每个占位符是否仍然存在
			for (const placeholderBlock of placeholderBlocks) {
				if (checkedBlocks.has(placeholderBlock.blockId)) {
					continue; // 跳过已检查的块
				}
				checkedBlocks.add(placeholderBlock.blockId);

				const block = allBlocks.find(item => item.block_id === placeholderBlock.blockId);
				if (block && block.text) {
					const blockContent = this.extractBlockTextContent(block);
					Debug.log(`🔍 Checking block ${placeholderBlock.blockId}: "${blockContent.substring(0, 100)}..."`);

					// 检查是否仍包含占位符文本（考虑多种格式）
					const originalPlaceholder = placeholderBlock.placeholder; // __FEISHU_FILE_xxx__
					const cleanPlaceholder = originalPlaceholder.replace(/^__/, '').replace(/__$/, ''); // FEISHU_FILE_xxx
					const feishuPlaceholder = `!${cleanPlaceholder}!`; // !FEISHU_FILE_xxx!

					const hasOriginal = blockContent.includes(originalPlaceholder);
					const hasFeishu = blockContent.includes(feishuPlaceholder);
					const hasClean = blockContent.includes(cleanPlaceholder);

					if (hasOriginal || hasFeishu || hasClean) {
						const foundFormat = hasOriginal ? 'original' : hasFeishu ? 'feishu' : 'clean';
						Debug.log(`✅ Found remaining placeholder: ${originalPlaceholder} (format: ${foundFormat})`);
						remainingPlaceholders.push(placeholderBlock);
					} else {
						Debug.log(`❌ Placeholder already cleaned: ${originalPlaceholder}`);
					}
				} else {
					Debug.log(`⚠️ Block not found or has no text: ${placeholderBlock.blockId}`);
				}
			}

			Debug.log(`🎯 Found ${remainingPlaceholders.length} remaining placeholders out of ${placeholderBlocks.length}`);
			return remainingPlaceholders;

		} catch (error) {
			Debug.error('Error finding remaining placeholders:', error);
			// 如果检查失败，返回所有占位符（保守处理）
			Debug.log('🔄 Falling back to processing all placeholders due to error');
			return placeholderBlocks;
		}
	}

	/**
	 * 批量替换占位符文本为空文本（优化版本）
	 */
	private async batchReplacePlaceholderText(documentId: string, placeholderBlocks: PlaceholderBlock[]): Promise<void> {
		if (placeholderBlocks.length === 0) {
			return;
		}

		try {
			Debug.log(`🔧 Batch replacing ${placeholderBlocks.length} placeholder texts...`);

			// 构建批量更新请求
			const requests = placeholderBlocks.map(placeholderBlock => ({
				block_id: placeholderBlock.blockId,
				update_text_elements: {
					elements: [
						{
							text_run: {
								content: ""
							}
						}
					]
				}
			}));

			const requestData = {
				requests: requests
			};

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/batch_update`,
				method: 'PATCH',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestData)
			});

			const data = response.json || JSON.parse(response.text);
			Debug.log(`📋 Batch replace placeholder response:`, data);

			if (data.code !== 0) {
				Debug.warn(`⚠️ Batch replace failed: ${data.msg}, falling back to individual replacement...`);
				// 如果批量替换失败，回退到逐个替换
				await this.fallbackIndividualReplace(documentId, placeholderBlocks);
			} else {
				Debug.log(`✅ Successfully batch replaced ${placeholderBlocks.length} placeholder texts`);
			}

		} catch (error) {
			Debug.error('Batch replace placeholder text error:', error);
			// 如果批量替换失败，回退到逐个替换
			await this.fallbackIndividualReplace(documentId, placeholderBlocks);
		}
	}

	/**
	 * 回退到逐个替换占位符文本
	 */
	private async fallbackIndividualReplace(documentId: string, placeholderBlocks: PlaceholderBlock[]): Promise<void> {
		Debug.log(`🔄 Falling back to individual replacement for ${placeholderBlocks.length} blocks...`);

		for (const placeholderBlock of placeholderBlocks) {
			try {
				await this.replacePlaceholderText(documentId, placeholderBlock);
			} catch (error) {
				Debug.error(`❌ Failed to replace placeholder ${placeholderBlock.blockId}:`, error);
			}
		}
	}

	/**
	 * 替换占位符文本为空文本（单个）
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

			Debug.log(`🔧 Replacing placeholder text in block: ${placeholderBlock.blockId}`);

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
			Debug.log(`📋 Replace placeholder response:`, data);

			if (data.code !== 0) {
				Debug.warn(`⚠️ Failed to replace placeholder text: ${data.msg}, trying delete method...`);
				// 如果替换失败，尝试删除方法
				await this.deletePlaceholderBlock(documentId, placeholderBlock);
			} else {
				Debug.log(`✅ Replaced placeholder text in block: ${placeholderBlock.blockId}`);
			}

		} catch (error) {
			Debug.error('Replace placeholder text error:', error);
			// 如果替换失败，尝试删除方法
			try {
				await this.deletePlaceholderBlock(documentId, placeholderBlock);
			} catch (deleteError) {
				Debug.error('Both replace and delete failed:', deleteError);
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

			Debug.log(`✅ Deleted placeholder block: ${placeholderBlock.blockId}`);

		} catch (error) {
			Debug.error('Delete placeholder block error:', error);
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

			Debug.log(`🔍 Trying to read file: "${filePath}" -> "${normalizedPath}"`);

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
						Debug.log(`✅ Found file by name: ${file.path}`);
					}
				}
			}

			if (!file) {
				Debug.warn(`❌ File not found: ${normalizedPath}`);
				// 列出可能的文件供调试
				const allFiles = this.app.vault.getFiles();
				const similarFiles = allFiles.filter(f => f.name.includes(normalizedPath.split('/').pop() || ''));
				if (similarFiles.length > 0) {
					Debug.log('📋 Similar files found:', similarFiles.map(f => f.path));
				}
				return null;
			}

			// 读取二进制内容
			const content = await this.app.vault.readBinary(file);
			Debug.log(`✅ Successfully read file: ${file.path} (${content.byteLength} bytes)`);
			return content;

		} catch (error) {
			Debug.error(`❌ Error reading local file ${filePath}:`, error);
			return null;
		}
	}

	/**
	 * 处理第三阶段：文件上传和替换占位符（优化版本）
	 */
	async processFileUploads(documentId: string, localFiles: LocalFileInfo[], statusNotice?: Notice): Promise<void> {
		if (localFiles.length === 0) {
			Debug.log('📝 No local files to process');
			return;
		}

		try {
			if (statusNotice) {
				statusNotice.setMessage(`🔍 正在查找占位符 (${localFiles.length} 个文件)...`);
			}

			// 第一步：查找占位符文本块
			const placeholderBlocks = await this.findPlaceholderBlocks(documentId, localFiles);

			if (placeholderBlocks.length === 0) {
				Debug.warn('⚠️ No placeholder blocks found in document');
				return;
			}

			Debug.log(`🎯 Found ${placeholderBlocks.length} placeholder blocks to process`);

			// 按照原始文件顺序排序占位符块
			const sortedPlaceholderBlocks = this.sortPlaceholdersByOriginalOrder(placeholderBlocks, localFiles);
			Debug.log(`📋 Sorted placeholder blocks by original order`);

			// 第二步：并行读取所有文件内容（优化：并发读取）
			if (statusNotice) {
				statusNotice.setMessage(`📖 正在并行读取 ${sortedPlaceholderBlocks.length} 个文件...`);
			}

			const fileReadPromises = sortedPlaceholderBlocks.map(async (placeholderBlock) => {
				try {
					const fileContent = await this.readLocalFile(placeholderBlock.fileInfo.originalPath);
					return { placeholderBlock, fileContent, success: !!fileContent };
				} catch (error) {
					Debug.warn(`⚠️ Failed to read file: ${placeholderBlock.fileInfo.originalPath}`, error);
					return { placeholderBlock, fileContent: null, success: false };
				}
			});

			const fileReadResults = await Promise.all(fileReadPromises);
			const validFiles = fileReadResults.filter(result => result.success);
			Debug.log(`� Successfully read ${validFiles.length}/${sortedPlaceholderBlocks.length} files`);

			// 第三步：按顺序处理文件上传（必须串行，因为API限制）
			const processedBlocks: PlaceholderBlock[] = [];
			for (let i = 0; i < validFiles.length; i++) {
				const { placeholderBlock, fileContent } = validFiles[i];
				const fileInfo = placeholderBlock.fileInfo;

				if (statusNotice) {
					statusNotice.setMessage(`📤 正在上传文件 ${i + 1}/${validFiles.length}: ${fileInfo.fileName}...`);
				}

				try {
					// 调整插入位置（考虑之前插入的文件块）
					const adjustedPlaceholderBlock = {
						...placeholderBlock,
						index: placeholderBlock.index + i
					};
					Debug.log(`📍 Adjusted insert position for ${fileInfo.fileName}: ${placeholderBlock.index} -> ${adjustedPlaceholderBlock.index}`);

					// 创建文件块并上传文件
					const newBlockId = await this.insertFileBlock(documentId, adjustedPlaceholderBlock);
					const fileToken = await this.uploadFileToDocument(documentId, newBlockId, fileInfo, fileContent!);
					await this.setFileBlockContent(documentId, newBlockId, fileToken, fileInfo.isImage);

					processedBlocks.push(placeholderBlock);
					Debug.log(`✅ Successfully processed file: ${fileInfo.fileName}`);

				} catch (fileError) {
					Debug.error(`❌ Failed to process file ${fileInfo.fileName}:`, fileError);
					// 继续处理其他文件，不中断整个流程
				}
			}

			// 第四步：批量替换占位符文本（优化：批量操作）
			if (processedBlocks.length > 0) {
				if (statusNotice) {
					statusNotice.setMessage(`🔄 正在检查并清理 ${processedBlocks.length} 个占位符...`);
				}

				// 重新查找仍然存在的占位符（因为子文档处理可能已经清理了一些）
				const remainingPlaceholders = await this.findRemainingPlaceholders(documentId, processedBlocks);

				if (remainingPlaceholders.length > 0) {
					Debug.log(`🔄 Found ${remainingPlaceholders.length} remaining placeholders to clean up`);
					await this.batchReplacePlaceholderText(documentId, remainingPlaceholders);
				} else {
					Debug.log(`✅ All placeholders have already been cleaned up`);
				}
			}

			Debug.log(`🎉 File upload processing completed: ${processedBlocks.length} files processed`);

		} catch (error) {
			Debug.error('Process file uploads error:', error);
			throw error;
		}
	}

	/**
	 * 按照原始文件顺序排序占位符块
	 */
	private sortPlaceholdersByOriginalOrder(placeholderBlocks: PlaceholderBlock[], localFiles: LocalFileInfo[]): PlaceholderBlock[] {
		Debug.log('📋 Original localFiles order:');
		localFiles.forEach((file, index) => {
			Debug.log(`  ${index}: ${file.fileName} -> ${file.placeholder}`);
		});

		Debug.log('📋 Found placeholder blocks:');
		placeholderBlocks.forEach((block, index) => {
			Debug.log(`  ${index}: ${block.fileInfo.fileName} -> ${block.placeholder} (index: ${block.index})`);
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
			Debug.log(`🔄 Comparing: ${a.fileInfo.fileName}(order:${orderA}, index:${a.index}) vs ${b.fileInfo.fileName}(order:${orderB}, index:${b.index})`);

			// 如果localFiles顺序不同，使用localFiles顺序
			if (orderA !== orderB) {
				return orderA - orderB;
			}

			// 如果localFiles顺序相同，使用文档中的index
			return a.index - b.index;
		});

		Debug.log('📋 Sorted placeholder blocks:');
		sorted.forEach((block, index) => {
			Debug.log(`  ${index}: ${block.fileInfo.fileName} -> ${block.placeholder}`);
		});

		return sorted;
	}

	/**
	 * 处理子文档上传
	 */
	private async processSubDocuments(parentDocumentId: string, subDocuments: LocalFileInfo[], statusNotice?: Notice): Promise<void> {
		Debug.log(`🚀 Starting sub-document processing for ${subDocuments.length} documents`);

		for (let i = 0; i < subDocuments.length; i++) {
			const subDoc = subDocuments[i];

			try {
				if (statusNotice) {
					statusNotice.setMessage(`📄 正在处理子文档 ${i + 1}/${subDocuments.length}: ${subDoc.fileName}...`);
				}

				Debug.log(`📄 Processing sub-document: ${subDoc.fileName} (${subDoc.originalPath})`);

				// 读取子文档内容
				const subDocContent = await this.readSubDocumentContent(subDoc.originalPath);
				if (!subDocContent) {
					Debug.warn(`⚠️ Could not read sub-document: ${subDoc.originalPath}, skipping...`);
					continue;
				}

				// 处理子文档内容（与主文档保持一致的 Front Matter 处理）
				const processResult = this.markdownProcessor.processCompleteWithFiles(
					subDocContent,
					3, // maxDepth
					this.settings.frontMatterHandling,
					false, // 子文档中禁用子文档上传，避免无限递归
					this.settings.enableLocalImageUpload,
					this.settings.enableLocalAttachmentUpload,
					this.settings.titleSource
				);

				// 根据设置提取子文档标题
				const subDocTitle = this.markdownProcessor.extractTitle(
					subDoc.fileName.replace('.md', ''),
					processResult.frontMatter,
					this.settings.titleSource
				);

				// 检查子文档是否已有飞书URL
				Debug.step(`Processing sub-document: ${subDoc.fileName}`);
				Debug.verbose(`Sub-document path: ${subDoc.originalPath}`);
				Debug.verbose(`Sub-document title: ${subDocTitle}`);
				Debug.verbose(`Front Matter:`, processResult.frontMatter);

				const existingUrl = this.getExistingFeishuUrl(processResult.frontMatter);
				let subDocResult: SubDocumentResult;
				let urlChanged = false;

				Debug.verbose(`Existing URL check result: ${existingUrl || 'No URL found'}`);

				if (existingUrl) {
					Debug.step(`Sub-document has existing URL, checking accessibility`);
					Debug.log(`📋 Sub-document already has URL: ${subDoc.fileName} -> ${existingUrl}`);

					// 检查现有URL是否可访问
					Debug.verbose(`Checking URL accessibility for: ${existingUrl}`);
					const urlAccessible = await this.checkDocumentUrlAccessibility(existingUrl);
					Debug.verbose(`URL accessibility result:`, urlAccessible);

					if (urlAccessible.isAccessible) {
						Debug.step(`URL is accessible, reusing without any operations`);
						Debug.log(`✅ Existing URL is accessible, reusing directly: ${existingUrl}`);

						// 直接使用现有URL，不做任何导入或更新操作
						const documentId = this.extractDocumentIdFromUrl(existingUrl);
						Debug.verbose(`Extracted document ID: ${documentId}`);

						subDocResult = {
							success: true,
							documentToken: documentId || undefined,
							url: existingUrl,
							title: subDocTitle
						};

						Debug.result(`Sub-document URL reused`, true, {
							fileName: subDoc.fileName,
							url: existingUrl,
							documentId: documentId
						});
					} else if (urlAccessible.needsReauth) {
						Debug.step(`Sub-document needs reauth, token should already be refreshed by main document`);
						Debug.log(`🔑 Sub-document URL needs reauth, retrying: ${subDoc.fileName}`);

						// 主文档应该已经处理了重新授权，直接重试
						const retryAccessible = await this.checkDocumentUrlAccessibility(existingUrl);
						Debug.verbose(`Retry accessibility result:`, retryAccessible);

						if (retryAccessible.isAccessible) {
							Debug.step(`URL is now accessible after reauth, reusing`);
							Debug.log(`✅ Sub-document URL accessible after reauth: ${existingUrl}`);

							const documentId = this.extractDocumentIdFromUrl(existingUrl);
							subDocResult = {
								success: true,
								documentToken: documentId || undefined,
								url: existingUrl,
								title: subDocTitle
							};

							Debug.result(`Sub-document URL reused after reauth`, true, {
								fileName: subDoc.fileName,
								url: existingUrl,
								documentId: documentId
							});
						} else {
							Debug.step(`URL still not accessible after reauth, creating new document`);
							Debug.warn(`⚠️ Sub-document URL still not accessible after reauth: ${existingUrl}, reason: ${retryAccessible.error}`);

							subDocResult = await this.uploadSubDocument(subDocTitle, processResult.content, statusNotice);
							urlChanged = true;

							if (subDocResult.success) {
								Debug.result(`Sub-document URL changed after failed reauth`, true, {
									fileName: subDoc.fileName,
									oldUrl: existingUrl,
									newUrl: subDocResult.url
								});
							}
						}
					} else {
						Debug.step(`URL is not accessible, creating new document`);
						Debug.warn(`⚠️ Existing URL is not accessible: ${existingUrl}, reason: ${urlAccessible.error}`);
						Debug.log(`📤 Creating new sub-document to replace inaccessible one: ${subDoc.fileName}`);

						// URL不可访问，创建新文档
						Debug.verbose(`Starting uploadSubDocument for: ${subDoc.fileName}`);
						subDocResult = await this.uploadSubDocument(subDocTitle, processResult.content, statusNotice);
						urlChanged = true;

						if (subDocResult.success) {
							Debug.result(`Sub-document URL changed`, true, {
								fileName: subDoc.fileName,
								oldUrl: existingUrl,
								newUrl: subDocResult.url
							});
						}
					}
				} else {
					Debug.step(`No existing URL, creating new document`);

					// 检查是否之前应该有URL但丢失了
					const hasFeishuSharedAt = processResult.frontMatter?.feishu_shared_at;
					if (hasFeishuSharedAt) {
						Debug.warn(`⚠️ Sub-document has feishu_shared_at but no feishu_url, URL may have been lost: ${subDoc.fileName}`);
						Debug.warn(`⚠️ This may indicate a previous sharing issue or manual Front Matter modification`);
					}

					Debug.log(`📤 Sub-document has no existing URL, creating new: ${subDoc.fileName}`);

					// 没有现有URL，正常上传
					Debug.verbose(`Starting uploadSubDocument for new document: ${subDoc.fileName}`);
					subDocResult = await this.uploadSubDocument(subDocTitle, processResult.content, statusNotice);
				}

				if (!subDocResult.success) {
					Debug.warn(`⚠️ Failed to process sub-document: ${subDoc.fileName}, error: ${subDocResult.error}`);
					continue;
				}

				// 只有在创建新文档时才处理本地文件（复用URL时不需要处理）
				if (!existingUrl || urlChanged) {
					// 处理子文档内部的本地文件（图片、附件等）
					if (processResult.localFiles.length > 0 && subDocResult.documentToken) {
						try {
							Debug.log(`📎 Processing ${processResult.localFiles.length} local files in sub-document: ${subDoc.fileName}`);
							await this.processFileUploads(subDocResult.documentToken, processResult.localFiles, statusNotice);
							Debug.log(`✅ Successfully processed local files in sub-document: ${subDoc.fileName}`);
						} catch (fileError) {
							Debug.warn(`⚠️ Failed to process local files in sub-document ${subDoc.fileName}:`, fileError);
							// 文件处理失败不影响子文档上传成功
						}
					}
				} else {
					Debug.log(`📋 Skipping file processing for sub-document with existing URL: ${subDoc.fileName}`);
				}

				// 在父文档中插入子文档链接
				await this.insertSubDocumentLink(parentDocumentId, subDoc, subDocResult);

				// 更新子文档的 Front Matter
				if (this.settings.enableShareMarkInFrontMatter && subDocResult.url) {
					try {
						const subDocFile = this.app.vault.getAbstractFileByPath(subDoc.originalPath);
						if (subDocFile instanceof TFile) {
							let shouldUpdateFrontMatter = false;
							let notificationMessage = '';

							if (urlChanged) {
								// URL发生了变化，需要更新并提醒用户
								Debug.log(`🔄 URL changed for sub-document: ${subDoc.fileName}`);
								Debug.log(`   Old URL: ${existingUrl}`);
								Debug.log(`   New URL: ${subDocResult.url}`);
								shouldUpdateFrontMatter = true;
								notificationMessage = `子文档 "${subDoc.fileName}" 的飞书链接已更新（原链接不可访问）`;
							} else if (!existingUrl) {
								// 新文档，添加标记
								Debug.log(`📝 Adding share mark to new sub-document: ${subDoc.fileName}`);
								shouldUpdateFrontMatter = true;
							} else {
								// URL没有变化，不需要更新Front Matter
								Debug.log(`📋 Sub-document URL unchanged, skipping Front Matter update: ${subDoc.fileName}`);
							}

							if (shouldUpdateFrontMatter) {
								const updatedSubDocContent = this.markdownProcessor.addShareMarkToFrontMatter(subDocContent, subDocResult.url);
								await this.app.vault.modify(subDocFile, updatedSubDocContent);
								Debug.log(`✅ Share mark updated for sub-document: ${subDoc.fileName}`);

								// 如果URL发生了变化，显示通知
								if (notificationMessage) {
									new Notice(notificationMessage, 5000);
								}
							}
						} else {
							Debug.warn(`⚠️ Could not find sub-document file: ${subDoc.originalPath}`);
						}
					} catch (error) {
						Debug.warn(`⚠️ Failed to update share mark for sub-document ${subDoc.fileName}: ${error.message}`);
						// 不影响主要的分享成功流程，只记录警告
					}
				}

				Debug.log(`✅ Successfully processed sub-document: ${subDoc.fileName}`);

			} catch (error) {
				Debug.error(`❌ Error processing sub-document ${subDoc.fileName}:`, error);
				// 继续处理下一个子文档
			}
		}

		Debug.log(`✅ Completed sub-document processing`);
	}

	/**
	 * 读取子文档内容
	 */
	private async readSubDocumentContent(filePath: string): Promise<string | null> {
		try {
			// 清理和规范化路径
			let cleanPath = filePath.trim();
			const normalizedPath = normalizePath(cleanPath);

			Debug.log(`🔍 Reading sub-document: "${filePath}" -> "${normalizedPath}"`);

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
						Debug.log(`✅ Found sub-document by name: ${file.path}`);
					}
				}
			}

			if (!file) {
				Debug.warn(`❌ Sub-document not found: ${normalizedPath}`);
				return null;
			}

			// 读取文本内容
			const content = await this.app.vault.read(file);
			Debug.log(`✅ Successfully read sub-document: ${file.path} (${content.length} characters)`);
			return content;

		} catch (error) {
			Debug.error(`❌ Error reading sub-document ${filePath}:`, error);
			return null;
		}
	}

	/**
	 * 从Front Matter中获取现有的飞书URL
	 * @param frontMatter Front Matter数据
	 * @returns 现有的飞书URL，如果没有则返回null
	 */
	private getExistingFeishuUrl(frontMatter: any): string | null {
		Debug.verbose(`Checking Front Matter for existing URL:`, frontMatter);

		if (!frontMatter) {
			Debug.verbose(`No Front Matter found`);
			return null;
		}

		const feishuUrl = frontMatter.feishu_url;
		Debug.verbose(`feishu_url field value:`, feishuUrl);

		if (feishuUrl && typeof feishuUrl === 'string' && feishuUrl.trim()) {
			Debug.result(`Found existing Feishu URL`, true, feishuUrl);
			return feishuUrl.trim();
		}

		Debug.verbose(`No valid Feishu URL found in Front Matter`);
		return null;
	}

	/**
	 * 检查文档URL的可访问性（支持重新授权后重试）
	 * @param feishuUrl 飞书文档URL
	 * @returns 可访问性检查结果
	 */
	async checkDocumentUrlAccessibility(feishuUrl: string): Promise<{isAccessible: boolean, error?: string, needsReauth?: boolean}> {
		try {
			Debug.step(`Checking document URL accessibility`);
			Debug.verbose(`Target URL: ${feishuUrl}`);

			// 从URL提取文档ID
			const documentId = this.extractDocumentIdFromUrl(feishuUrl);
			Debug.verbose(`Extracted document ID: ${documentId}`);

			if (!documentId) {
				Debug.result(`URL format validation`, false, 'Cannot extract document ID');
				return { isAccessible: false, error: 'URL格式无效，无法提取文档ID' };
			}

			// 检查文档访问权限
			Debug.verbose(`Checking document access for ID: ${documentId}`);
			const accessCheck = await this.checkDocumentAccess(documentId);
			Debug.verbose(`Access check result:`, accessCheck);

			if (accessCheck.hasAccess) {
				Debug.result(`Document URL accessibility`, true, feishuUrl);
				return { isAccessible: true };
			} else if (accessCheck.needsReauth) {
				Debug.result(`Document URL accessibility`, false, {
					url: feishuUrl,
					reason: accessCheck.error,
					needsReauth: true
				});
				return { isAccessible: false, error: accessCheck.error, needsReauth: true };
			} else {
				Debug.result(`Document URL accessibility`, false, {
					url: feishuUrl,
					reason: accessCheck.error
				});
				return { isAccessible: false, error: accessCheck.error };
			}

		} catch (error) {
			Debug.error('Check document URL accessibility error:', error);
			return {
				isAccessible: false,
				error: error instanceof Error ? error.message : '检查URL可访问性失败'
			};
		}
	}

	/**
	 * 更新文档内容（简化版本，用于子文档更新）
	 * @param documentId 文档ID
	 * @param processResult Markdown处理结果
	 * @param statusNotice 状态通知
	 */
	private async updateDocumentContent(
		documentId: string,
		processResult: MarkdownProcessResult,
		statusNotice?: Notice
	): Promise<void> {
		try {
			Debug.log(`🔄 Updating document content: ${documentId}`);

			// 1. 清空现有文档内容
			if (statusNotice) {
				statusNotice.setMessage('🧹 正在清空子文档内容...');
			}

			const clearResult = await this.clearDocumentContent(documentId);
			if (!clearResult.success) {
				throw new Error(clearResult.error || '清空文档内容失败');
			}

			// 2. 创建临时文档用于导入新内容
			if (statusNotice) {
				statusNotice.setMessage('📄 正在创建临时文档...');
			}

			const tempResult = await this.shareMarkdownWithFiles('temp_subdoc_' + Date.now(), processResult, statusNotice);
			if (!tempResult.success) {
				throw new Error(tempResult.error || '创建临时文档失败');
			}

			// 3. 提取临时文档ID
			const tempDocumentId = this.extractDocumentIdFromUrl(tempResult.url!);
			if (!tempDocumentId) {
				throw new Error('无法从临时文档URL中提取文档ID');
			}

			try {
				// 4. 复制临时文档内容到目标文档
				if (statusNotice) {
					statusNotice.setMessage('📋 正在复制内容到子文档...');
				}

				const copyResult = await this.copyContentToDocument(
					tempDocumentId,
					documentId,
					processResult.localFiles
				);

				if (!copyResult.success) {
					throw new Error(copyResult.error || '复制内容失败');
				}

				Debug.log(`✅ Sub-document content updated successfully: ${documentId}`);

			} finally {
				// 5. 删除临时文档
				try {
					await this.deleteDocument(tempDocumentId);
					Debug.log('✅ Temporary sub-document deleted successfully');
				} catch (deleteError) {
					Debug.warn('⚠️ Failed to delete temporary sub-document:', deleteError);
				}
			}

		} catch (error) {
			Debug.error('Update document content error:', error);
			throw error;
		}
	}

	/**
	 * 上传子文档到飞书
	 */
	private async uploadSubDocument(title: string, content: string, statusNotice?: Notice): Promise<SubDocumentResult> {
		try {
			Debug.log(`📤 Uploading sub-document: ${title}`);

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

				// 并行处理权限设置和源文件删除
				const parallelTasks: Promise<void>[] = [];

				// 权限设置任务（如果启用了链接分享）
				if (this.settings.enableLinkShare) {
					const permissionTask = (async () => {
						try {
							if (statusNotice) {
								statusNotice.setMessage(`🔗 正在设置子文档权限: ${cleanTitle}...`);
							}
							Debug.log(`🔗 Setting permissions for sub-document: ${cleanTitle}`);
							// 新创建的子文档，跳过权限检查直接设置
							await this.setDocumentSharePermissions(finalResult.documentToken!, true);
							Debug.log(`✅ Sub-document permissions set successfully: ${cleanTitle}`);
						} catch (permissionError) {
							Debug.warn(`⚠️ Failed to set sub-document permissions for ${cleanTitle}:`, permissionError);
							// 权限设置失败不影响主流程
						}
					})();
					parallelTasks.push(permissionTask);
				}

				// 源文件删除任务
				const deleteTask = (async () => {
					try {
						await this.deleteSourceFile(uploadResult.fileToken!);
					} catch (deleteError) {
						Debug.warn('⚠️ Failed to delete sub-document source file:', deleteError);
					}
				})();
				parallelTasks.push(deleteTask);

				// 等待所有并行任务完成
				await Promise.allSettled(parallelTasks);

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
			Debug.error('Upload sub-document error:', error);
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
			Debug.log(`🔗 Inserting sub-document link for: ${subDocInfo.fileName}`);

			// 查找占位符位置
			const placeholderBlocks = await this.findPlaceholderBlocks(parentDocumentId, [subDocInfo]);

			if (placeholderBlocks.length === 0) {
				Debug.warn(`⚠️ No placeholder found for sub-document: ${subDocInfo.fileName}`);
				return;
			}

			const placeholderBlock = placeholderBlocks[0];

			// 替换占位符为超链接（去掉前后下划线，因为飞书会自动去除）
			const cleanPlaceholder = subDocInfo.placeholder.replace(/^__/, '').replace(/__$/, '');
			await this.replaceTextWithLink(parentDocumentId, placeholderBlock.blockId, subDocResult.title!, subDocResult.url!, cleanPlaceholder);

			Debug.log(`✅ Successfully inserted sub-document link: ${subDocInfo.fileName}`);

		} catch (error) {
			Debug.error(`❌ Error inserting sub-document link for ${subDocInfo.fileName}:`, error);
		}
	}

	/**
	 * 获取文档块的内容
	 */
	private async getBlockContent(documentId: string, blockId: string): Promise<{ elements: any[] } | null> {
		try {
			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${blockId}`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				}
			});

			const data = response.json || JSON.parse(response.text);
			if (data.code !== 0) {
				Debug.error(`❌ Failed to get block content: ${data.msg}`);
				return null;
			}

			// 返回文本元素数组
			return {
				elements: data.data?.block?.text?.elements || []
			};

		} catch (error) {
			Debug.error(`❌ Error getting block content for ${blockId}:`, error);
			return null;
		}
	}

	/**
	 * 构建包含链接的文本元素数组（保留上下文）
	 */
	private buildTextElementsWithLink(originalElements: any[], linkText: string, linkUrl: string, targetPlaceholder: string): any[] {
		const encodedUrl = encodeURIComponent(linkUrl);
		const newElements: any[] = [];

		// 遍历原始元素，查找并替换占位符
		for (const element of originalElements) {
			if (element.text_run && element.text_run.content) {
				const content = element.text_run.content;

				// 检查是否包含目标占位符
				const placeholderIndex = content.indexOf(targetPlaceholder);

				if (placeholderIndex !== -1) {
					// 找到目标占位符，分割文本
					const beforePlaceholder = content.substring(0, placeholderIndex);
					const afterPlaceholder = content.substring(placeholderIndex + targetPlaceholder.length);

					// 添加占位符前的文本
					if (beforePlaceholder.length > 0) {
						newElements.push({
							text_run: {
								content: beforePlaceholder,
								text_element_style: element.text_run.text_element_style
							}
						});
					}

					// 添加链接元素
					newElements.push({
						text_run: {
							content: linkText,
							text_element_style: {
								...element.text_run.text_element_style,
								link: {
									url: encodedUrl
								}
							}
						}
					});

					// 添加占位符后的文本
					if (afterPlaceholder.length > 0) {
						newElements.push({
							text_run: {
								content: afterPlaceholder,
								text_element_style: element.text_run.text_element_style
							}
						});
					}
				} else {
					// 没有占位符，保持原样
					newElements.push(element);
				}
			} else {
				// 非文本元素，保持原样
				newElements.push(element);
			}
		}

		return newElements;
	}

	/**
	 * 替换文档块中的占位符为超链接（保留上下文）
	 */
	private async replaceTextWithLink(documentId: string, blockId: string, linkText: string, linkUrl: string, placeholder: string): Promise<void> {
		try {
			// 第一步：获取当前块的内容
			const blockInfo = await this.getBlockContent(documentId, blockId);
			if (!blockInfo) {
				throw new Error('无法获取块内容');
			}

			// 第二步：查找占位符并构建新的文本元素数组
			const newElements = this.buildTextElementsWithLink(blockInfo.elements, linkText, linkUrl, placeholder);

			// 第三步：更新块内容
			const requestData = {
				update_text_elements: {
					elements: newElements
				}
			};

			Debug.log(`🔗 Replacing placeholder in block ${blockId} with link: "${linkText}" -> "${linkUrl}"`);

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${blockId}`,
				method: 'PATCH',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestData)
			});

			const data = response.json || JSON.parse(response.text);
			if (data.code !== 0) {
				throw new Error(data.msg || '替换文本为链接失败');
			}

			Debug.log(`✅ Successfully replaced placeholder with link in block ${blockId}`);

		} catch (error) {
			Debug.error(`❌ Error replacing placeholder with link in block ${blockId}:`, error);
			throw error;
		}
	}



	/**
	 * 设置文档分享权限
	 * 使用 PATCH /open-apis/drive/v2/permissions/{token}/public API
	 */
	async setDocumentSharePermissions(documentToken: string, skipPermissionCheck: boolean = false): Promise<void> {
		try {
			// 确保token有效
			const tokenValid = await this.ensureValidToken();
			if (!tokenValid) {
				throw new Error('Token无效，请重新授权');
			}

			// 检查当前权限设置，判断是否需要修改（除非明确跳过检查）
			if (!skipPermissionCheck) {
				try {
					const currentPermissions = await this.getDocumentPermissions(documentToken);
					const currentLinkShare = currentPermissions.link_share_entity;
					const targetLinkShare = this.settings.linkSharePermission;

					// 只在权限需要修改时继续
					if (currentLinkShare === targetLinkShare) {
						Debug.log(`✅ Document permissions already correct: ${currentLinkShare}`);
						return;
					}
					Debug.log(`🔄 Document permissions need update: ${currentLinkShare} → ${targetLinkShare}`);
				} catch (getError) {
					Debug.warn('⚠️ Failed to get current permissions, proceeding with update:', getError);
				}
			} else {
				Debug.log(`🔧 Setting document permissions (skipping check): ${this.settings.linkSharePermission}`);
			}

			// 构建权限设置请求数据
			const requestData: any = {};

			// 根据设置配置链接分享权限
			if (this.settings.enableLinkShare) {
				requestData.link_share_entity = this.settings.linkSharePermission;

				// 根据分享范围设置外部访问权限
				if (this.settings.linkSharePermission === 'anyone_readable' || this.settings.linkSharePermission === 'anyone_editable') {
					// 互联网访问：必须设置为 open
					requestData.external_access_entity = 'open';
				} else {
					// 组织内访问：可以设置为 open 或 close，这里设置为 open 以确保功能正常
					requestData.external_access_entity = 'open';
				}

				// 设置谁可以查看、添加、移除协作者
				requestData.share_entity = 'anyone'; // 任何有权限的人都可以查看协作者

				// 设置协作者管理权限
				requestData.manage_collaborator_entity = 'collaborator_can_view'; // 协作者可以查看其他协作者
			}

			Debug.log(`🔧 Setting document share permissions for ${documentToken}:`, requestData);

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/drive/v2/permissions/${documentToken}/public?type=docx`,
				method: 'PATCH',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestData)
			});

			Debug.log(`📋 Set document permissions response status: ${response.status}`);

			// 处理不同的响应格式
			let data: any;
			try {
				data = response.json || JSON.parse(response.text);
			} catch (parseError) {
				Debug.error('❌ Failed to parse response:', response.text);
				throw new Error(`API响应解析失败: ${response.status} - ${response.text}`);
			}

			Debug.log(`📋 Set document permissions response data:`, data);

			if (data.code !== 0) {
				Debug.error('❌ API returned error:', {
					code: data.code,
					msg: data.msg,
					requestData: requestData,
					documentToken: documentToken
				});
				throw new Error(`设置文档分享权限失败 (${data.code}): ${data.msg}`);
			}

			Debug.log(`✅ Successfully set document share permissions for ${documentToken}`);

		} catch (error) {
			Debug.error('Set document share permissions error:', error);
			throw error;
		}
	}

	/**
	 * 获取文档当前权限设置
	 * 使用 GET /open-apis/drive/v2/permissions/{token}/public API
	 */
	async getDocumentPermissions(documentToken: string): Promise<any> {
		try {
			// 确保token有效
			const tokenValid = await this.ensureValidToken();
			if (!tokenValid) {
				throw new Error('Token无效，请重新授权');
			}

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/drive/v2/permissions/${documentToken}/public?type=docx`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				}
			});

			const data = response.json || JSON.parse(response.text);

			if (data.code !== 0) {
				throw new Error(data.msg || '获取文档权限设置失败');
			}

			return data.data.permission_public;

		} catch (error) {
			Debug.error('Get document permissions error:', error);
			throw error;
		}
	}

	/**
	 * 获取文档的所有块
	 * @param documentId 文档ID
	 * @returns 文档的所有块数据
	 */
	async getAllDocumentBlocks(documentId: string): Promise<any[]> {
		try {
			Debug.log(`📋 Getting all blocks for document: ${documentId}`);

			let allBlocks: any[] = [];
			let pageToken = '';
			let hasMore = true;

			while (hasMore) {
				const params = new URLSearchParams({
					page_size: '500'
				});

				if (pageToken) {
					params.append('page_token', pageToken);
				}

				const response = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks?${params.toString()}`,
					method: 'GET',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					}
				});

				const data: FeishuDocBlocksResponse = response.json || JSON.parse(response.text);

				if (data.code !== 0) {
					throw new Error(data.msg || '获取文档块失败');
				}

				allBlocks.push(...data.data.items);
				hasMore = data.data.has_more;
				pageToken = data.data.page_token;
			}

			Debug.log(`📋 Retrieved ${allBlocks.length} blocks from document`);
			return allBlocks;

		} catch (error) {
			Debug.error('Get all document blocks error:', error);
			throw error;
		}
	}

	/**
	 * 清空文档内容（保留根块）
	 * @param documentId 文档ID
	 * @returns 清空操作结果
	 */
	async clearDocumentContent(documentId: string): Promise<{success: boolean, error?: string}> {
		try {
			Debug.log(`🧹 Starting to clear document content: ${documentId}`);

			// 确保token有效
			const tokenValid = await this.ensureValidToken();
			if (!tokenValid) {
				throw new Error('Token无效，请重新授权');
			}

			// 获取文档的所有块
			const allBlocks = await this.getAllDocumentBlocks(documentId);

			if (allBlocks.length === 0) {
				Debug.log('📄 Document is already empty');
				return { success: true };
			}

			// 找到根块（page类型的块）
			const rootBlock = allBlocks.find(block => block.block_type === 1); // 1 = page
			if (!rootBlock) {
				throw new Error('未找到文档根块');
			}

			Debug.log(`📄 Found root block: ${rootBlock.block_id}`);

			// 获取根块的直接子块
			const rootChildren = rootBlock.children || [];

			if (rootChildren.length === 0) {
				Debug.log('📄 Document has no content to clear');
				return { success: true };
			}

			Debug.log(`🗑️ Found ${rootChildren.length} child blocks to delete`);

			// 批量删除根块的所有子块
			const deleteResult = await this.batchDeleteBlocks(documentId, rootBlock.block_id, 0, rootChildren.length);

			if (deleteResult.success) {
				Debug.log(`✅ Successfully cleared document content: ${rootChildren.length} blocks deleted`);
				return { success: true };
			} else {
				throw new Error(deleteResult.error || '批量删除失败');
			}

		} catch (error) {
			Debug.error('Clear document content error:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : '清空文档内容失败'
			};
		}
	}

	/**
	 * 批量删除块
	 * @param documentId 文档ID
	 * @param parentBlockId 父块ID
	 * @param startIndex 开始索引
	 * @param endIndex 结束索引
	 * @returns 删除操作结果
	 */
	private async batchDeleteBlocks(
		documentId: string,
		parentBlockId: string,
		startIndex: number,
		endIndex: number
	): Promise<{success: boolean, error?: string}> {
		try {
			Debug.log(`🗑️ Batch deleting blocks from ${startIndex} to ${endIndex} in parent ${parentBlockId}`);

			const requestData = {
				start_index: startIndex,
				end_index: endIndex
			};

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children/batch_delete`,
				method: 'DELETE',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestData)
			});

			const data = response.json || JSON.parse(response.text);

			if (data.code !== 0) {
				throw new Error(data.msg || '批量删除块失败');
			}

			Debug.log(`✅ Successfully deleted blocks from ${startIndex} to ${endIndex}`);
			return { success: true };

		} catch (error) {
			Debug.error('Batch delete blocks error:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : '批量删除块失败'
			};
		}
	}

	// 文档ID缓存，避免重复提取
	private documentIdCache = new Map<string, string | null>();

	/**
	 * 从飞书文档URL中提取文档ID（带缓存）
	 * @param feishuUrl 飞书文档URL
	 * @returns 文档ID，如果解析失败返回null
	 */
	extractDocumentIdFromUrl(feishuUrl: string): string | null {
		try {
			// 检查缓存
			if (this.documentIdCache.has(feishuUrl)) {
				const cachedId = this.documentIdCache.get(feishuUrl);
				Debug.verbose(`🔍 Using cached document ID for: ${feishuUrl} -> ${cachedId}`);
				return cachedId || null;
			}

			Debug.verbose(`🔍 Extracting document ID from URL: ${feishuUrl}`);

			// 支持多种飞书文档URL格式
			const patterns = [
				/\/docx\/([a-zA-Z0-9]+)/,  // https://feishu.cn/docx/doxcnXXXXXX
				/\/docs\/([a-zA-Z0-9]+)/,  // https://feishu.cn/docs/doccnXXXXXX (旧版)
				/documents\/([a-zA-Z0-9]+)/, // API格式
			];

			for (const pattern of patterns) {
				const match = feishuUrl.match(pattern);
				if (match && match[1]) {
					const documentId = match[1];
					Debug.log(`✅ Extracted document ID: ${documentId}`);

					// 缓存结果
					this.documentIdCache.set(feishuUrl, documentId);
					return documentId;
				}
			}

			Debug.warn(`⚠️ Could not extract document ID from URL: ${feishuUrl}`);

			// 缓存失败结果
			this.documentIdCache.set(feishuUrl, null);
			return null;

		} catch (error) {
			Debug.error('Extract document ID error:', error);

			// 缓存失败结果
			this.documentIdCache.set(feishuUrl, null);
			return null;
		}
	}

	/**
	 * 检查文档访问权限
	 * @param documentId 文档ID
	 * @returns 权限检查结果
	 */
	async checkDocumentAccess(documentId: string): Promise<{hasAccess: boolean, error?: string, needsReauth?: boolean}> {
		try {
			Debug.log(`🔐 Checking document access: ${documentId}`);

			// 确保token有效
			const tokenValid = await this.ensureValidToken();
			if (!tokenValid) {
				return { hasAccess: false, error: 'Token无效，请重新授权', needsReauth: true };
			}

			// 尝试获取文档基本信息来验证访问权限
			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				}
			});

			const data = response.json || JSON.parse(response.text);

			if (data.code === 0) {
				Debug.log(`✅ Document access confirmed: ${documentId}`);
				return { hasAccess: true };
			} else if (data.code === 403) {
				return { hasAccess: false, error: '没有访问该文档的权限' };
			} else if (data.code === 404) {
				return { hasAccess: false, error: '文档不存在或已被删除' };
			} else if (data.code === 99991663) {
				// Token失效的特定错误码
				return { hasAccess: false, error: 'Token已失效', needsReauth: true };
			} else {
				return { hasAccess: false, error: data.msg || '文档访问检查失败' };
			}

		} catch (error) {
			Debug.error('Check document access error:', error);
			return {
				hasAccess: false,
				error: error instanceof Error ? error.message : '文档访问检查失败'
			};
		}
	}

	/**
	 * 将内容复制到目标文档
	 * @param sourceDocumentId 源文档ID
	 * @param targetDocumentId 目标文档ID
	 * @param localFiles 本地文件列表
	 * @returns 复制操作结果
	 */
	async copyContentToDocument(
		sourceDocumentId: string,
		targetDocumentId: string,
		localFiles: LocalFileInfo[]
	): Promise<{success: boolean, error?: string}> {
		try {
			Debug.log(`📋 Copying content from ${sourceDocumentId} to ${targetDocumentId}`);

			// 1. 获取源文档的所有块
			const sourceBlocks = await this.getAllDocumentBlocks(sourceDocumentId);

			// 2. 找到源文档的根块
			const sourceRootBlock = sourceBlocks.find(block => block.block_type === 1); // 1 = page
			if (!sourceRootBlock) {
				throw new Error('源文档根块未找到');
			}

			// 3. 获取源文档根块的子块
			const sourceChildren = sourceRootBlock.children || [];
			if (sourceChildren.length === 0) {
				Debug.log('📄 Source document has no content to copy');
				return { success: true };
			}

			// 4. 获取目标文档的根块
			const targetBlocks = await this.getAllDocumentBlocks(targetDocumentId);
			const targetRootBlock = targetBlocks.find(block => block.block_type === 1);
			if (!targetRootBlock) {
				throw new Error('目标文档根块未找到');
			}

			Debug.log(`📋 Found ${sourceChildren.length} blocks to copy`);

			// 5. 复制每个子块到目标文档
			const copyResult = await this.copyBlocksToTarget(
				sourceDocumentId,
				targetDocumentId,
				sourceChildren,
				targetRootBlock.block_id
			);

			if (!copyResult.success) {
				throw new Error(copyResult.error || '复制块失败');
			}

			Debug.log(`✅ Successfully copied ${sourceChildren.length} blocks to target document`);
			return { success: true };

		} catch (error) {
			Debug.error('Copy content to document error:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : '复制文档内容失败'
			};
		}
	}

	/**
	 * 复制块到目标文档
	 * @param sourceDocumentId 源文档ID
	 * @param targetDocumentId 目标文档ID
	 * @param blockIds 要复制的块ID列表
	 * @param targetParentId 目标父块ID
	 * @returns 复制操作结果
	 */
	private async copyBlocksToTarget(
		sourceDocumentId: string,
		targetDocumentId: string,
		blockIds: string[],
		targetParentId: string
	): Promise<{success: boolean, error?: string}> {
		try {
			Debug.log(`📋 Copying ${blockIds.length} blocks to target parent: ${targetParentId}`);

			// 获取源文档的所有块数据
			const sourceBlocks = await this.getAllDocumentBlocks(sourceDocumentId);
			const blockMap = new Map(sourceBlocks.map(block => [block.block_id, block]));

			// 按顺序复制每个块
			for (let i = 0; i < blockIds.length; i++) {
				const blockId = blockIds[i];
				const sourceBlock = blockMap.get(blockId);

				if (!sourceBlock) {
					Debug.warn(`⚠️ Source block not found: ${blockId}`);
					continue;
				}

				try {
					// 在复制块之间添加延迟以避免频率限制
					if (i > 0) {
						const delay = 300; // 300ms延迟
						Debug.verbose(`⏱️ Waiting ${delay}ms between block copies...`);
						await new Promise(resolve => setTimeout(resolve, delay));
					}

					await this.copyIndividualBlock(sourceBlock, targetDocumentId, targetParentId);
					Debug.log(`✅ Copied block ${i + 1}/${blockIds.length}: ${blockId}`);
				} catch (blockError) {
					Debug.error(`❌ Failed to copy block ${blockId}:`, blockError);
					// 继续复制其他块，不中断整个流程
				}
			}

			return { success: true };

		} catch (error) {
			Debug.error('Copy blocks to target error:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : '复制块到目标文档失败'
			};
		}
	}

	/**
	 * 复制单个块到目标文档（支持重试和频率限制处理）
	 * @param sourceBlock 源块数据
	 * @param targetDocumentId 目标文档ID
	 * @param targetParentId 目标父块ID
	 */
	private async copyIndividualBlock(
		sourceBlock: any,
		targetDocumentId: string,
		targetParentId: string
	): Promise<void> {
		const maxRetries = 3;
		let retryCount = 0;

		while (retryCount < maxRetries) {
			try {
				// 构建块创建请求数据
				const blockData = this.buildBlockDataForCopy(sourceBlock);

				const requestData = {
					children: [blockData]
				};

				Debug.verbose(`📝 Creating block in target document (attempt ${retryCount + 1}/${maxRetries}):`, {
					type: sourceBlock.block_type,
					targetParent: targetParentId
				});

				// 添加延迟以避免频率限制
				if (retryCount > 0) {
					const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 5000); // 指数退避，最大5秒
					Debug.verbose(`⏱️ Waiting ${delay}ms before retry...`);
					await new Promise(resolve => setTimeout(resolve, delay));
				}

				const response = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${targetDocumentId}/blocks/${targetParentId}/children`,
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(requestData)
				});

				const data = response.json || JSON.parse(response.text);

				if (data.code !== 0) {
					throw new Error(data.msg || '创建块失败');
				}

				Debug.log(`✅ Successfully created block in target document`);
				return; // 成功，退出重试循环

			} catch (error) {
				retryCount++;

				// 检查是否是频率限制错误
				if (error.message.includes('429') || error.message.includes('Request failed, status 429')) {
					Debug.warn(`⚠️ Rate limit hit, retrying... (${retryCount}/${maxRetries})`);

					if (retryCount >= maxRetries) {
						Debug.error(`❌ Max retries reached for rate limit, giving up on block`);
						throw new Error(`API频率限制，重试${maxRetries}次后仍失败: ${error.message}`);
					}
					// 继续重试
				} else {
					// 其他错误，直接抛出
					Debug.error('Copy individual block error:', error);
					throw error;
				}
			}
		}
	}

	/**
	 * 构建用于复制的块数据
	 * @param sourceBlock 源块数据
	 * @returns 用于创建的块数据
	 */
	private buildBlockDataForCopy(sourceBlock: any): any {
		const blockType = sourceBlock.block_type;

		// 根据块类型构建相应的数据结构
		switch (blockType) {
			case 2: // text
				return {
					block_type: 2,
					text: sourceBlock.text || { elements: [{ text_run: { content: '' } }] }
				};

			case 3: // heading1
			case 4: // heading2
			case 5: // heading3
			case 6: // heading4
			case 7: // heading5
			case 8: // heading6
			case 9: // heading7
			case 10: // heading8
			case 11: // heading9
				return {
					block_type: blockType,
					[this.getHeadingFieldName(blockType)]: sourceBlock[this.getHeadingFieldName(blockType)] || { elements: [{ text_run: { content: '' } }] }
				};

			case 12: // bullet
				return {
					block_type: 12,
					bullet: sourceBlock.bullet || { elements: [{ text_run: { content: '' } }] }
				};

			case 13: // ordered
				return {
					block_type: 13,
					ordered: sourceBlock.ordered || { elements: [{ text_run: { content: '' } }] }
				};

			case 14: // code
				return {
					block_type: 14,
					code: sourceBlock.code || { elements: [{ text_run: { content: '' } }] }
				};

			case 15: // quote
				return {
					block_type: 15,
					quote: sourceBlock.quote || { elements: [{ text_run: { content: '' } }] }
				};

			case 17: // todo
				return {
					block_type: 17,
					todo: sourceBlock.todo || { elements: [{ text_run: { content: '' } }] }
				};

			default:
				// 对于其他类型的块，尝试保持原始结构
				Debug.warn(`⚠️ Unsupported block type for copy: ${blockType}`);
				return {
					block_type: 2, // 默认转为文本块
					text: { elements: [{ text_run: { content: `[不支持的块类型: ${blockType}]` } }] }
				};
		}
	}

	/**
	 * 获取标题块的字段名
	 * @param blockType 块类型
	 * @returns 字段名
	 */
	private getHeadingFieldName(blockType: number): string {
		const headingMap: { [key: number]: string } = {
			3: 'heading1',
			4: 'heading2',
			5: 'heading3',
			6: 'heading4',
			7: 'heading5',
			8: 'heading6',
			9: 'heading7',
			10: 'heading8',
			11: 'heading9'
		};
		return headingMap[blockType] || 'text';
	}

	/**
	 * 更新现有飞书文档
	 * @param feishuUrl 现有文档的飞书URL
	 * @param title 文档标题
	 * @param processResult Markdown处理结果
	 * @param statusNotice 状态通知
	 * @returns 更新结果
	 */
	async updateExistingDocument(
		feishuUrl: string,
		title: string,
		processResult: MarkdownProcessResult,
		statusNotice?: Notice
	): Promise<ShareResult> {
		let tempDocumentId: string | null = null;
		let originalContentBackup: any[] | null = null;
		let documentId: string | null = null;

		try {
			Debug.log(`🔄 Starting document update process for: ${feishuUrl}`);

			if (statusNotice) {
				statusNotice.setMessage('🔍 正在解析文档链接...');
			}

			// 1. 从URL提取文档ID
			documentId = this.extractDocumentIdFromUrl(feishuUrl);
			if (!documentId) {
				throw new Error('无法从URL中提取文档ID，请检查链接格式是否正确');
			}

			// 2. 跳过重复的访问权限检查（在主流程中已经检查过）
			Debug.verbose(`📋 Skipping duplicate access check for document: ${documentId}`);
			if (statusNotice) {
				statusNotice.setMessage('💾 正在备份原始文档内容...');
			}

			// 3. 备份原始内容（用于回滚）
			if (statusNotice) {
				statusNotice.setMessage('💾 正在备份原始文档内容...');
			}

			try {
				originalContentBackup = await this.getAllDocumentBlocks(documentId);
				Debug.log(`✅ Original content backed up: ${originalContentBackup.length} blocks`);
			} catch (backupError) {
				Debug.warn('⚠️ Failed to backup original content:', backupError);
				// 继续执行，但记录警告
			}

			// 4. 创建临时文档用于导入新内容
			if (statusNotice) {
				statusNotice.setMessage('📄 正在创建临时文档...');
			}

			const tempResult = await this.shareMarkdownWithFiles(title + '_temp', processResult, statusNotice);
			if (!tempResult.success) {
				throw new Error(tempResult.error || '创建临时文档失败');
			}

			// 5. 提取临时文档ID
			tempDocumentId = this.extractDocumentIdFromUrl(tempResult.url!);
			if (!tempDocumentId) {
				throw new Error('无法从临时文档URL中提取文档ID');
			}

			Debug.log(`✅ Temporary document created: ${tempDocumentId}`);

			// 6. 清空现有文档内容
			if (statusNotice) {
				statusNotice.setMessage('🧹 正在清空现有文档内容...');
			}

			const clearResult = await this.clearDocumentContent(documentId);
			if (!clearResult.success) {
				throw new Error(clearResult.error || '清空文档内容失败');
			}

			// 7. 复制临时文档内容到目标文档
			if (statusNotice) {
				statusNotice.setMessage('📋 正在复制内容到目标文档...');
			}

			const copyResult = await this.copyContentToDocument(
				tempDocumentId,
				documentId,
				processResult.localFiles
			);

			if (!copyResult.success) {
				throw new Error(copyResult.error || '复制内容失败');
			}

			// 8. 处理本地文件上传（如果有）
			if (processResult.localFiles.length > 0) {
				if (statusNotice) {
					statusNotice.setMessage(`📎 正在处理 ${processResult.localFiles.length} 个本地文件...`);
				}

				try {
					await this.processFileUploads(documentId, processResult.localFiles, statusNotice);
				} catch (fileError) {
					Debug.warn('⚠️ File upload failed, but document content was updated:', fileError);
					// 文件上传失败不影响主要内容更新
				}
			}

			// 9. 删除临时文档
			try {
				if (statusNotice) {
					statusNotice.setMessage('🗑️ 正在清理临时文档...');
				}
				await this.deleteDocument(tempDocumentId);
				tempDocumentId = null; // 标记已删除
				Debug.log('✅ Temporary document deleted successfully');
			} catch (deleteError) {
				Debug.warn('⚠️ Failed to delete temporary document:', deleteError);
				// 不影响主流程，只记录警告
			}

			Debug.log(`✅ Document update completed successfully: ${feishuUrl}`);

			return {
				success: true,
				url: feishuUrl, // 返回原始URL
				title: title
			};

		} catch (error) {
			Debug.error('Update existing document error:', error);

			// 错误处理和回滚逻辑
			await this.handleUpdateError(error, documentId, tempDocumentId, originalContentBackup, statusNotice);

			return {
				success: false,
				error: error instanceof Error ? error.message : '更新文档失败'
			};
		}
	}

	/**
	 * 处理更新错误和回滚
	 * @param error 错误对象
	 * @param documentId 目标文档ID
	 * @param tempDocumentId 临时文档ID
	 * @param originalContentBackup 原始内容备份
	 * @param statusNotice 状态通知
	 */
	private async handleUpdateError(
		error: any,
		documentId: string | null,
		tempDocumentId: string | null,
		originalContentBackup: any[] | null,
		statusNotice?: Notice
	): Promise<void> {
		try {
			Debug.log('🔄 Starting error handling and rollback process...');

			// 1. 清理临时文档
			if (tempDocumentId) {
				try {
					if (statusNotice) {
						statusNotice.setMessage('🗑️ 正在清理临时文档...');
					}
					await this.deleteDocument(tempDocumentId);
					Debug.log('✅ Temporary document cleaned up');
				} catch (cleanupError) {
					Debug.warn('⚠️ Failed to cleanup temporary document:', cleanupError);
				}
			}

			// 2. 尝试回滚原始内容（如果有备份且文档ID有效）
			if (documentId && originalContentBackup && originalContentBackup.length > 0) {
				try {
					if (statusNotice) {
						statusNotice.setMessage('🔄 正在尝试回滚到原始内容...');
					}

					const rollbackResult = await this.rollbackDocumentContent(documentId, originalContentBackup);
					if (rollbackResult.success) {
						Debug.log('✅ Successfully rolled back to original content');
						if (statusNotice) {
							statusNotice.setMessage('✅ 已回滚到原始内容');
						}
					} else {
						Debug.warn('⚠️ Failed to rollback content:', rollbackResult.error);
					}
				} catch (rollbackError) {
					Debug.error('❌ Rollback failed:', rollbackError);
				}
			}

			// 3. 记录详细错误信息
			Debug.error('📋 Update error details:', {
				originalError: error,
				documentId,
				tempDocumentId,
				hasBackup: !!originalContentBackup,
				backupSize: originalContentBackup?.length || 0
			});

		} catch (handlerError) {
			Debug.error('❌ Error in error handler:', handlerError);
		}
	}

	/**
	 * 回滚文档内容
	 * @param documentId 文档ID
	 * @param originalContent 原始内容备份
	 * @returns 回滚结果
	 */
	private async rollbackDocumentContent(
		documentId: string,
		originalContent: any[]
	): Promise<{success: boolean, error?: string}> {
		try {
			Debug.log(`🔄 Rolling back document content: ${originalContent.length} blocks`);

			// 注意：这是一个简化的回滚实现
			// 在实际生产环境中，可能需要更复杂的逻辑来完全恢复文档结构

			// 1. 清空当前内容
			const clearResult = await this.clearDocumentContent(documentId);
			if (!clearResult.success) {
				throw new Error(clearResult.error || '清空文档失败');
			}

			// 2. 重建内容（简化版本 - 只恢复文本内容）
			const rootBlock = originalContent.find(block => block.block_type === 1);
			if (!rootBlock || !rootBlock.children || rootBlock.children.length === 0) {
				Debug.log('📄 No content to restore');
				return { success: true };
			}

			// 创建基本的文本块来恢复内容
			const restoreBlocks = originalContent
				.filter(block => rootBlock.children.includes(block.block_id))
				.map(block => this.buildBlockDataForCopy(block));

			if (restoreBlocks.length > 0) {
				const requestData = { children: restoreBlocks };

				const response = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${rootBlock.block_id}/children`,
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(requestData)
				});

				const data = response.json || JSON.parse(response.text);
				if (data.code !== 0) {
					throw new Error(data.msg || '恢复内容失败');
				}
			}

			Debug.log(`✅ Successfully rolled back ${restoreBlocks.length} blocks`);
			return { success: true };

		} catch (error) {
			Debug.error('Rollback document content error:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : '回滚失败'
			};
		}
	}

	/**
	 * 删除文档
	 * @param documentId 文档ID
	 */
	async deleteDocument(documentId: string): Promise<void> {
		try {
			Debug.log(`🗑️ Starting to delete document: ${documentId}`);

			// 确保token有效
			const tokenValid = await this.ensureValidToken();
			if (!tokenValid) {
				throw new Error('Token无效，无法删除文档');
			}

			// 构建删除API URL，添加type参数指定为docx类型
			const deleteUrl = `${FEISHU_CONFIG.BASE_URL}/drive/v1/files/${documentId}?type=docx`;

			Debug.log(`🔗 Delete API URL: ${deleteUrl}`);
			Debug.log(`🔑 Using access token: ${this.settings.accessToken ? this.settings.accessToken.substring(0, 10) + '...' : 'null'}`);

			const response = await requestUrl({
				url: deleteUrl,
				method: 'DELETE',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				}
			});

			Debug.log(`📡 Delete response status: ${response.status}`);

			// 只记录关键的响应头信息，避免日志过于冗长
			const keyHeaders = {
				'content-type': response.headers['content-type'],
				'request-id': response.headers['request-id'],
				'x-tt-logid': response.headers['x-tt-logid']
			};
			Debug.verbose(`📡 Delete response headers (key):`, keyHeaders);

			let data: any;
			try {
				data = response.json || JSON.parse(response.text);
				Debug.log(`📡 Delete response:`, {
					code: data.code,
					msg: data.msg,
					success: data.code === 0
				});
			} catch (parseError) {
				Debug.log(`📡 Delete response text:`, response.text);
				throw new Error(`解析删除响应失败: ${parseError.message}`);
			}

			if (data.code !== 0) {
				Debug.error(`❌ Delete failed with code ${data.code}: ${data.msg}`);
				throw new Error(`删除文档失败 (${data.code}): ${data.msg || '未知错误'}`);
			}

			Debug.log(`✅ Document deleted successfully: ${documentId}`);

			// 如果返回了task_id，说明是异步删除
			if (data.data && data.data.task_id) {
				Debug.log(`📋 Async delete task created: ${data.data.task_id}`);
			}

		} catch (error) {
			Debug.error('Delete document error details:', {
				documentId,
				error: error.message,
				stack: error.stack
			});
			throw error;
		}
	}



	/**
	 * 验证文档链接分享是否生效
	 * 通过分析权限设置来判断链接分享的实际效果
	 */
	async verifyDocumentLinkSharing(documentToken: string): Promise<{
		isLinkSharingEnabled: boolean;
		shareScope: 'tenant' | 'internet' | 'none';
		accessLevel: 'readable' | 'editable' | 'none';
		explanation: string;
	}> {
		try {
			const permissions = await this.getDocumentPermissions(documentToken);

			Debug.log('🔍 Analyzing document permissions:', permissions);

			// 分析链接分享设置
			const linkShareEntity = permissions.link_share_entity;
			const externalAccessEntity = permissions.external_access_entity;

			let isLinkSharingEnabled = false;
			let shareScope: 'tenant' | 'internet' | 'none' = 'none';
			let accessLevel: 'readable' | 'editable' | 'none' = 'none';
			let explanation = '';

			if (linkShareEntity === 'close') {
				explanation = '链接分享已关闭，只有协作者可以访问文档';
			} else if (linkShareEntity === 'tenant_readable') {
				isLinkSharingEnabled = true;
				shareScope = 'tenant';
				accessLevel = 'readable';
				explanation = '组织内获得链接的人可以阅读文档';
			} else if (linkShareEntity === 'tenant_editable') {
				isLinkSharingEnabled = true;
				shareScope = 'tenant';
				accessLevel = 'editable';
				explanation = '组织内获得链接的人可以编辑文档';
			} else if (linkShareEntity === 'anyone_can_view' && externalAccessEntity === 'open') {
				isLinkSharingEnabled = true;
				shareScope = 'internet';
				accessLevel = 'readable';
				explanation = '互联网上获得链接的任何人都可以阅读文档';
			} else if (linkShareEntity === 'anyone_can_edit' && externalAccessEntity === 'open') {
				isLinkSharingEnabled = true;
				shareScope = 'internet';
				accessLevel = 'editable';
				explanation = '互联网上获得链接的任何人都可以编辑文档';
			} else {
				explanation = `未知的链接分享设置: ${linkShareEntity}, external_access: ${externalAccessEntity}`;
			}

			const result = {
				isLinkSharingEnabled,
				shareScope,
				accessLevel,
				explanation
			};

			Debug.log('📊 Link sharing analysis result:', result);
			return result;

		} catch (error) {
			Debug.error('Verify document link sharing error:', error);
			throw error;
		}
	}
}
