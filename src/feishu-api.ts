import { Notice, requestUrl, App, TFile, normalizePath } from 'obsidian';
import {
	FeishuSettings,
	FeishuOAuthResponse,
	ShareResult,
	FeishuUserInfo,
	FeishuFileUploadResponse,
	LocalFileInfo,
	CalloutInfo,
	MarkdownProcessResult,
	FeishuDocBlocksResponse,
	FeishuBlockCreateResponse,
	PlaceholderBlock,
	SubDocumentResult,
	WikiSpace,
	WikiNode,
	WikiSpaceListResponse,
	WikiNodeListResponse,
	MoveDocToWikiResponse
} from './types';
import { FEISHU_CONFIG, FEISHU_ERROR_MESSAGES } from './constants';
import { Debug } from './debug';
import { MarkdownProcessor } from './markdown-processor';

/**
 * 智能频率控制器
 * 用于控制API调用频率，避免触发飞书的频率限制
 */
class RateLimitController {
	private lastCallTime: number = 0;
	private callCount: number = 0;
	private resetTime: number = 0;

	/**
	 * 智能节流控制
	 * @param apiType API类型，不同类型有不同的频率限制
	 */
	async throttle(apiType: 'document' | 'import' | 'block'): Promise<void> {
		const limits = {
			document: { perSecond: 2, perMinute: 90 }, // 保守一些，避免触发限制
			import: { perSecond: 1, perMinute: 90 },
			block: { perSecond: 2, perMinute: 150 }
		};

		const limit = limits[apiType];
		const now = Date.now();

		// 重置计数器（每分钟）
		if (now - this.resetTime > 60000) {
			this.callCount = 0;
			this.resetTime = now;
		}

		// 检查每分钟限制
		if (this.callCount >= limit.perMinute) {
			const waitTime = 60000 - (now - this.resetTime);
			Debug.log(`⏳ Rate limit reached, waiting ${waitTime}ms...`);
			await new Promise(resolve => setTimeout(resolve, waitTime));
			this.callCount = 0;
			this.resetTime = Date.now();
		}

		// 检查每秒限制
		const timeSinceLastCall = now - this.lastCallTime;
		const minInterval = 1000 / limit.perSecond;

		if (timeSinceLastCall < minInterval) {
			const waitTime = minInterval - timeSinceLastCall;
			await new Promise(resolve => setTimeout(resolve, waitTime));
		}

		this.lastCallTime = Date.now();
		this.callCount++;
	}
}

/**
 * 图片处理服务类
 * 负责图片的下载、本地读取、上传到飞书等功能
 */
class ImageProcessingService {
	private app: App;
	private settings: FeishuSettings;
	private feishuService: FeishuApiService;

	constructor(app: App, settings: FeishuSettings, feishuService: FeishuApiService) {
		this.app = app;
		this.settings = settings;
		this.feishuService = feishuService;
	}

	/**
	 * 更新设置
	 */
	updateSettings(settings: FeishuSettings) {
		this.settings = settings;
	}

	/**
	 * 判断是否为网络图片
	 */
	private isNetworkImage(path: string): boolean {
		return path.startsWith('http://') || path.startsWith('https://');
	}

	/**
	 * 判断是否为图床图片（常见图床域名）
	 */
	private isImageHosting(url: string): boolean {
		const imageHostingDomains = [
			'imgur.com', 'i.imgur.com',
			'github.com', 'raw.githubusercontent.com',
			'gitee.com', 'gitee.io',
			'sm.ms', 'i.loli.net',
			'qiniu.com', 'qiniucdn.com',
			'aliyuncs.com', 'alicdn.com',
			'tencent-cloud.com', 'myqcloud.com',
			'jsdelivr.net', 'unpkg.com',
			'picgo.org', 'pic.rmb.bdstatic.com'
		];

		try {
			const urlObj = new URL(url);
			return imageHostingDomains.some(domain =>
				urlObj.hostname.includes(domain) || urlObj.hostname.endsWith(domain)
			);
		} catch {
			return false;
		}
	}

	/**
	 * 下载网络图片
	 */
	private async downloadImage(url: string): Promise<ArrayBuffer> {
		try {
			Debug.log(`📥 Downloading image from: ${url}`);

			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
				}
			});

			if (response.status !== 200) {
				throw new Error(`HTTP ${response.status}: Request failed`);
			}

			const arrayBuffer = response.arrayBuffer;
			Debug.log(`✅ Successfully downloaded image: ${arrayBuffer.byteLength} bytes`);
			return arrayBuffer;

		} catch (error) {
			Debug.error(`❌ Failed to download image from ${url}:`, error);
			throw new Error(`图片下载失败: ${error.message}`);
		}
	}

	/**
	 * 读取本地图片
	 */
	private async readLocalImage(path: string): Promise<ArrayBuffer> {
		try {
			Debug.log(`📁 Reading local image: ${path}`);

			// 规范化路径
			const normalizedPath = normalizePath(path);

			// 检查文件是否存在
			const exists = await this.app.vault.adapter.exists(normalizedPath);
			if (!exists) {
				throw new Error(`文件不存在: ${normalizedPath}`);
			}

			// 读取二进制数据
			const arrayBuffer = await this.app.vault.adapter.readBinary(normalizedPath);
			Debug.log(`✅ Successfully read local image: ${arrayBuffer.byteLength} bytes`);
			return arrayBuffer;

		} catch (error) {
			Debug.error(`❌ Failed to read local image ${path}:`, error);
			throw new Error(`本地图片读取失败: ${error.message}`);
		}
	}

	/**
	 * 上传图片到飞书文档的指定图片块
	 */
	private async uploadImageToDocument(
		documentId: string,
		blockId: string,
		imageData: ArrayBuffer,
		fileName: string
	): Promise<string> {
		try {
			Debug.log(`📤 Uploading image to document ${documentId}, block ${blockId}`);

			// 确保token有效
			const tokenValid = await this.feishuService.ensureValidToken();
			if (!tokenValid) {
				throw new Error('Token无效，请重新授权');
			}

			// 使用与uploadFileToDocument相同的逻辑
			const boundary = '---7MA4YWxkTrZu0gW';
			const contentLength = imageData.byteLength;

			// 构建multipart/form-data的文本部分
			const textPart = [
				`--${boundary}`,
				`Content-Disposition: form-data; name="file_name"`,
				'',
				fileName,
				`--${boundary}`,
				`Content-Disposition: form-data; name="parent_type"`,
				'',
				'docx_image',
				`--${boundary}`,
				`Content-Disposition: form-data; name="parent_node"`,
				'',
				blockId,
				`--${boundary}`,
				`Content-Disposition: form-data; name="size"`,
				'',
				contentLength.toString(),
				`--${boundary}`,
				`Content-Disposition: form-data; name="extra"`,
				'',
				JSON.stringify({ drive_route_token: documentId }),
				`--${boundary}`,
				`Content-Disposition: form-data; name="file"; filename="${fileName}"`,
				`Content-Type: ${this.getImageMimeType(fileName)}`,
				'',
				''
			].join('\r\n');

			const endBoundary = `\r\n--${boundary}--\r\n`;

			// 构建完整的请求体
			const textPartBytes = new TextEncoder().encode(textPart);
			const endBoundaryBytes = new TextEncoder().encode(endBoundary);
			const totalLength = textPartBytes.length + contentLength + endBoundaryBytes.length;

			const bodyBytes = new Uint8Array(totalLength);
			let offset = 0;
			bodyBytes.set(textPartBytes, offset);
			offset += textPartBytes.length;
			bodyBytes.set(new Uint8Array(imageData), offset);
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

			const data = response.json || JSON.parse(response.text);

			if (data.code !== 0) {
				throw new Error(data.msg || '图片上传失败');
			}

			const fileToken = data.data.file_token;
			Debug.log(`✅ Successfully uploaded image, token: ${fileToken}`);
			return fileToken;

		} catch (error) {
			Debug.error(`❌ Failed to upload image to document:`, error);
			throw new Error(`图片上传失败: ${error.message}`);
		}
	}

	/**
	 * 获取图片的MIME类型
	 */
	private getImageMimeType(fileName: string): string {
		const ext = fileName.toLowerCase().split('.').pop();
		switch (ext) {
			case 'jpg':
			case 'jpeg':
				return 'image/jpeg';
			case 'png':
				return 'image/png';
			case 'gif':
				return 'image/gif';
			case 'webp':
				return 'image/webp';
			case 'svg':
				return 'image/svg+xml';
			case 'bmp':
				return 'image/bmp';
			default:
				return 'image/jpeg'; // 默认
		}
	}

	/**
	 * 处理图片块：下载图床图片或读取本地图片，然后上传到飞书
	 */
	async processImageBlock(
		documentId: string,
		blockId: string,
		localFile: LocalFileInfo
	): Promise<string> {
		try {
			Debug.log(`🖼️ Processing image block: ${localFile.fileName}`);

			let imageData: ArrayBuffer;

			if (this.isNetworkImage(localFile.originalPath)) {
				// 下载网络图片
				imageData = await this.downloadImage(localFile.originalPath);
			} else {
				// 读取本地图片
				imageData = await this.readLocalImage(localFile.originalPath);
			}

			// 上传到飞书
			const fileToken = await this.uploadImageToDocument(
				documentId,
				blockId,
				imageData,
				localFile.fileName
			);

			Debug.log(`✅ Image block processed successfully: ${fileToken}`);
			return fileToken;

		} catch (error) {
			Debug.error(`❌ Failed to process image block:`, error);
			throw error;
		}
	}

	/**
	 * 批量处理图片块
	 */
	async processImageBlocks(
		documentId: string,
		imageBlockMap: Map<string, LocalFileInfo>
	): Promise<Map<string, string>> {
		const results = new Map<string, string>();

		for (const [blockId, localFile] of imageBlockMap) {
			try {
				const fileToken = await this.processImageBlock(documentId, blockId, localFile);
				results.set(blockId, fileToken);
			} catch (error) {
				Debug.warn(`⚠️ Failed to process image block ${blockId}, skipping...`);
				// 继续处理其他图片，不中断整个流程
			}
		}

		return results;
	}

	/**
	 * 更新图片块的token
	 */
	async updateImageBlockToken(
		documentId: string,
		blockId: string,
		fileToken: string
	): Promise<void> {
		try {
			Debug.log(`🔄 Updating image block ${blockId} with token ${fileToken}`);

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${blockId}`,
				method: 'PATCH',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					replace_image: {
						token: fileToken
					}
				})
			});

			const data = response.json || JSON.parse(response.text);

			if (data.code !== 0) {
				throw new Error(data.msg || '图片块更新失败');
			}

			Debug.log(`✅ Successfully updated image block ${blockId}`);

		} catch (error) {
			Debug.error(`❌ Failed to update image block:`, error);
			throw new Error(`图片块更新失败: ${error.message}`);
		}
	}

	/**
	 * 创建图片占位符文本块
	 */
	createImagePlaceholderBlock(sourceBlock: any): any {
		const imageInfo = {
			width: sourceBlock.image?.width || '未知',
			height: sourceBlock.image?.height || '未知',
			token: sourceBlock.image?.token || '无',
			align: sourceBlock.image?.align || 1
		};

		const placeholderText = `🖼️ [图片占位符]\n` +
			`📐 尺寸: ${imageInfo.width}×${imageInfo.height}px\n` +
			`🔗 原始Token: ${imageInfo.token}\n` +
			`💡 说明: 由于飞书API限制，图片无法跨文档复制\n` +
			`🛠️ 解决方案: 请手动重新插入图片，或使用插件的"重新处理图片"功能`;

		return {
			block_type: 2, // 文本块
			text: {
				elements: [{
					text_run: {
						content: placeholderText
					}
				}]
			}
		};
	}

	/**
	 * 从飞书下载图片
	 */
	async downloadImageFromFeishu(imageToken: string): Promise<ArrayBuffer> {
		try {
			Debug.log(`📥 Downloading image from Feishu with token: ${imageToken}`);

			// 确保token有效
			const tokenValid = await this.feishuService.ensureValidToken();
			if (!tokenValid) {
				throw new Error('Token无效，请重新授权');
			}

			// 使用飞书的素材下载API
			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/drive/v1/medias/${imageToken}/download`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`
				}
			});

			if (response.status !== 200) {
				throw new Error(`HTTP ${response.status}: Download failed`);
			}

			const arrayBuffer = response.arrayBuffer;
			Debug.log(`✅ Successfully downloaded image: ${arrayBuffer.byteLength} bytes`);
			return arrayBuffer;

		} catch (error) {
			Debug.error(`❌ Failed to download image from Feishu:`, error);
			throw new Error(`图片下载失败: ${error.message}`);
		}
	}

	/**
	 * 重新处理图片块：下载原图片并重新上传
	 */
	async reprocessImageBlock(
		documentId: string,
		imageBlock: any,
		sourceImageToken: string
	): Promise<boolean> {
		try {
			Debug.log(`🔄 Reprocessing image block ${imageBlock.block_id} with source token ${sourceImageToken}`);

			// 1. 从飞书下载原图片
			const imageData = await this.downloadImageFromFeishu(sourceImageToken);

			// 2. 生成文件名
			const fileName = `image_${Date.now()}.jpg`;

			// 3. 上传到目标图片块
			const newFileToken = await this.uploadImageToDocument(
				documentId,
				imageBlock.block_id,
				imageData,
				fileName
			);

			// 4. 更新图片块的token
			await this.updateImageBlockToken(
				documentId,
				imageBlock.block_id,
				newFileToken
			);

			Debug.log(`✅ Successfully reprocessed image block ${imageBlock.block_id}`);
			return true;

		} catch (error) {
			Debug.error(`❌ Failed to reprocess image block ${imageBlock.block_id}:`, error);
			return false;
		}
	}
}

/**
 * 飞书 API 服务类 - 直接实现版本
 */
export class FeishuApiService {
	private settings: FeishuSettings;
	private app: App;
	private markdownProcessor: MarkdownProcessor;
	private rateLimitController: RateLimitController;
	private imageProcessingService: ImageProcessingService;
	private refreshPromise: Promise<boolean> | null = null; // 防止并发刷新

	constructor(settings: FeishuSettings, app: App) {
		this.settings = settings;
		this.app = app;
		this.markdownProcessor = new MarkdownProcessor(app);
		this.rateLimitController = new RateLimitController();
		this.imageProcessingService = new ImageProcessingService(app, settings, this);
	}

	/**
	 * 更新设置
	 */
	updateSettings(settings: FeishuSettings) {
		this.settings = settings;
		this.imageProcessingService.updateSettings(settings);
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
			client_id: this.settings.appId,
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
	 * 使用授权码换取访问令牌（v2 API）
	 */
	private async exchangeCodeForToken(code: string): Promise<{success: boolean, error?: string}> {
		try {
			// 使用v2 API直接交换token
			const requestBody = {
				grant_type: 'authorization_code',
				client_id: this.settings.appId,
				client_secret: this.settings.appSecret,
				code: code,
				redirect_uri: this.settings.callbackUrl  // 必须与授权时使用的redirect_uri一致
			};



			let response: any;
			try {
				response = await requestUrl({
					url: FEISHU_CONFIG.TOKEN_URL,
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(requestBody)
				});
			} catch (httpError) {
				Debug.error('❌ HTTP request failed:', httpError);

				// 尝试从错误中提取响应信息
				if (httpError.response) {
					Debug.error('Error response status:', httpError.response.status);
					Debug.error('Error response headers:', httpError.response.headers);
					Debug.error('Error response body:', httpError.response.body);
				}

				throw httpError;
			}

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
				// 支持v1和v2 API格式
				const accessToken = data.access_token || data.data?.access_token;
				const refreshToken = data.refresh_token || data.data?.refresh_token;

				if (accessToken) {
					this.settings.accessToken = accessToken;
					this.settings.refreshToken = refreshToken || '';
					return { success: true };
				} else {
					Debug.error('❌ No access token in response:', data);
					return { success: false, error: 'No access token received' };
				}
			} else {
				Debug.error('❌ Token exchange failed:', data);
				return { success: false, error: data.error_description || data.msg || `Error code: ${data.code}` };
			}

		} catch (error) {
			Debug.error('Token exchange error:', error);

			// 尝试获取更详细的错误信息
			if (error.response) {
				Debug.error('Error response status:', error.response.status);
				Debug.error('Error response data:', error.response.data);
			}

			// 如果是requestUrl的错误，尝试解析响应
			if (error.message && error.message.includes('Request failed, status 400')) {
				Debug.error('400 Bad Request - checking request format...');
				Debug.error('Request URL:', FEISHU_CONFIG.TOKEN_URL);
				Debug.error('App ID:', this.settings.appId ? 'Present' : 'Missing');
				Debug.error('App Secret:', this.settings.appSecret ? 'Present' : 'Missing');
			}

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
	 * @param isTemporary 是否为临时文档（临时文档不删除源文件）
	 */
	async shareMarkdownWithFiles(title: string, processResult: MarkdownProcessResult, statusNotice?: Notice, isTemporary: boolean = false): Promise<ShareResult> {
		try {
			// 更新状态：检查授权
			if (statusNotice) {
				statusNotice.setMessage('🔍 正在检查授权状态...');
			}

			// 检查并确保token有效
			const tokenValid = await this.ensureValidTokenWithReauth(statusNotice);
			if (!tokenValid) {
				// 提供更友好的错误信息和指导
				const errorMsg = '授权未完成。请点击分享按钮重新尝试，并确保在浏览器中完成授权流程。';
				if (statusNotice) {
					statusNotice.setMessage(`❌ ${errorMsg}`);
					setTimeout(() => statusNotice.hide(), 8000);
				}
				throw new Error(errorMsg);
			}

			// 根据目标类型选择不同的分享流程
			if (this.settings.targetType === 'wiki') {
				return await this.shareToWiki(title, processResult, statusNotice, isTemporary);
			} else {
				return await this.shareToDrive(title, processResult, statusNotice, isTemporary);
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
	 * 分享到云空间（原有逻辑）
	 */
	private async shareToDrive(title: string, processResult: MarkdownProcessResult, statusNotice?: Notice, isTemporary: boolean = false): Promise<ShareResult> {
		try {

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
					Debug.log(`🔍 IMPORT RESULT DEBUG: success=${finalResult.success}, documentToken=${finalResult.documentToken}`);
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

						// 第五步：处理子文档和文件上传（如果有本地文件或 Callout 块）
						const hasLocalFiles = processResult.localFiles.length > 0;
						const hasCalloutBlocks = processResult.calloutBlocks && processResult.calloutBlocks.length > 0;

						Debug.log(`🔍 NEW MODE DEBUG: hasLocalFiles=${hasLocalFiles}, hasCalloutBlocks=${hasCalloutBlocks}`);
						Debug.log(`🔍 NEW MODE DEBUG: localFiles.length=${processResult.localFiles.length}`);
						Debug.log(`🔍 NEW MODE DEBUG: calloutBlocks=`, processResult.calloutBlocks);

						if (hasLocalFiles || hasCalloutBlocks) {
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

								// 再处理普通文件和 Callout 块
								if (regularFiles.length > 0 || hasCalloutBlocks) {
									await this.processAllPlaceholders(
										finalResult.documentToken,
										regularFiles,
										processResult.calloutBlocks,
										statusNotice
									);
								}
							} catch (fileError) {
								Debug.warn('⚠️ File upload processing failed:', fileError);
								// 文件上传失败不影响主流程，继续返回文档链接
							}
						}

						// 第六步：源文件自动删除
						// 注意：使用素材上传API，导入完成后源文件会自动被删除
						Debug.log(`📝 Source file will be automatically deleted by Feishu after import: ${uploadResult.fileToken}`);

						const result = {
							success: true,
							title: cleanTitle,
							url: docUrl,
							sourceFileToken: isTemporary ? uploadResult.fileToken : undefined
						};

						if (isTemporary && uploadResult.fileToken) {
							Debug.log(`📝 Returning source file token for temporary document: ${uploadResult.fileToken}`);
						}

						Debug.log(`✅ Document creation completed successfully: ${docUrl}`);
						return result;
					} else {
						Debug.warn('⚠️ Import task failed or timed out, falling back to file URL');
						Debug.warn('Final result details:', finalResult);
						return {
							success: true,
							title: title,
							url: fallbackFileUrl,
							sourceFileToken: isTemporary ? uploadResult.fileToken : undefined
						};
					}
				} else {
					Debug.warn('⚠️ Failed to create import task, falling back to file URL');
					Debug.warn('Import result details:', importResult);
					return {
						success: true,
						title: title,
						url: fallbackFileUrl,
						sourceFileToken: isTemporary ? uploadResult.fileToken : undefined
					};
				}
			} catch (importError) {
				Debug.warn('⚠️ Import process failed, falling back to file URL:', importError.message);
				Debug.error('Import error details:', importError);
				return {
					success: true,
					title: title,
					url: fallbackFileUrl,
					sourceFileToken: isTemporary ? uploadResult.fileToken : undefined
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
	 * 分享到知识库（新逻辑）
	 */
	private async shareToWiki(title: string, processResult: MarkdownProcessResult, statusNotice?: Notice, isTemporary: boolean = false): Promise<ShareResult> {
		try {
			// 更新状态：开始上传
			if (statusNotice) {
				statusNotice.setMessage('📤 正在上传文件到飞书云空间...');
			}

			// 第一步：先上传到云空间（临时）
			const uploadResult = await this.uploadMarkdownFile(title, processResult.content);

			if (!uploadResult.success) {
				throw new Error(uploadResult.error || '文件上传失败');
			}

			if (!uploadResult.fileToken) {
				throw new Error('文件上传成功但未获取到文件令牌');
			}

			// 第二步：导入为云文档
			if (statusNotice) {
				statusNotice.setMessage('🔄 正在转换为飞书文档...');
			}

			const cleanTitle = title.endsWith('.md') ? title.slice(0, -3) : title;
			const importResult = await this.createImportTaskWithCorrectFolder(uploadResult.fileToken, cleanTitle);

			if (!importResult.success || !importResult.ticket) {
				throw new Error('创建导入任务失败');
			}

			// 第三步：等待导入完成
			const finalResult = await this.waitForImportCompletionWithTimeout(importResult.ticket, 15000);

			if (!finalResult.success || !finalResult.documentToken) {
				throw new Error('文档导入失败或超时');
			}

			// 第四步：移动到知识库
			if (statusNotice) {
				statusNotice.setMessage('📚 正在移动到知识库...');
			}

			const moveResult = await this.moveDocToWiki(
				this.settings.defaultWikiSpaceId,
				finalResult.documentToken,
				'docx',
				this.settings.defaultWikiNodeToken || undefined
			);

			if (!moveResult.success) {
				// 移动失败，但文档已创建，返回云文档链接作为备选
				Debug.warn('⚠️ Failed to move to wiki, falling back to cloud document');
				const docUrl = `https://feishu.cn/docx/${finalResult.documentToken}`;
				return {
					success: true,
					title: cleanTitle,
					url: docUrl,
					sourceFileToken: isTemporary ? uploadResult.fileToken : undefined
				};
			}

			// 第五步：处理文件上传（如果有本地文件）
			let finalDocumentToken = finalResult.documentToken;
			// 始终使用云文档URL，便于后续更新操作
			let finalUrl = `https://feishu.cn/docx/${finalResult.documentToken}`;

			// 注意：即使移动到知识库成功，我们仍然保存云文档URL
			// 这样更新文档时可以直接使用云文档API，避免复杂的知识库URL解析

			// 处理本地文件和 Callout 块上传
			const hasLocalFiles = processResult.localFiles.length > 0;
			const hasCalloutBlocks = processResult.calloutBlocks && processResult.calloutBlocks.length > 0;

			Debug.log(`🔍 WIKI MODE DEBUG: hasLocalFiles=${hasLocalFiles}, hasCalloutBlocks=${hasCalloutBlocks}`);
			Debug.log(`🔍 WIKI MODE DEBUG: localFiles.length=${processResult.localFiles.length}`);
			Debug.log(`🔍 WIKI MODE DEBUG: calloutBlocks=`, processResult.calloutBlocks);

			if (hasLocalFiles || hasCalloutBlocks) {
				try {
					// 分离子文档和普通文件
					const subDocuments = processResult.localFiles.filter(f => f.isSubDocument);
					const regularFiles = processResult.localFiles.filter(f => !f.isSubDocument);

					// 先处理子文档上传
					if (subDocuments.length > 0) {
						if (statusNotice) {
							statusNotice.setMessage(`📄 正在处理 ${subDocuments.length} 个子文档...`);
						}
						await this.processSubDocuments(finalDocumentToken, subDocuments, statusNotice);
					}

					// 再处理普通文件和 Callout 块
					if (regularFiles.length > 0 || hasCalloutBlocks) {
						await this.processAllPlaceholders(
							finalDocumentToken,
							regularFiles,
							processResult.calloutBlocks,
							statusNotice
						);
					}
				} catch (fileError) {
					Debug.warn('⚠️ File upload processing failed:', fileError);
					// 文件上传失败不影响主流程
				}
			}

			// 第六步：设置权限（如果启用）
			if (this.settings.enableLinkShare && finalDocumentToken) {
				try {
					if (statusNotice) {
						statusNotice.setMessage('🔗 正在设置文档分享权限...');
					}
					await this.setDocumentSharePermissions(finalDocumentToken, true);
					Debug.log('✅ Document share permissions set successfully');
				} catch (permissionError) {
					Debug.warn('⚠️ Failed to set document share permissions:', permissionError);
					// 权限设置失败不影响主流程
				}
			}

			return {
				success: true,
				title: cleanTitle,
				url: finalUrl,
				sourceFileToken: isTemporary ? uploadResult.fileToken : undefined
			};

		} catch (error) {
			Debug.error('Share to wiki error:', error);
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
				// 提供更友好的错误信息和指导
				const errorMsg = '授权未完成。请点击分享按钮重新尝试，并确保在浏览器中完成授权流程。';
				if (statusNotice) {
					statusNotice.setMessage(`❌ ${errorMsg}`);
					setTimeout(() => statusNotice.hide(), 8000);
				}
				throw new Error(errorMsg);
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

						// 源文件自动删除（素材上传API特性）
						Debug.log(`📝 Source file will be automatically deleted by Feishu: ${uploadResult.fileToken}`);

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
	 * 获取应用访问令牌 (tenant_access_token)
	 */
	private async getTenantAccessToken(): Promise<string | null> {
		try {
			if (!this.settings.appId || !this.settings.appSecret) {
				Debug.error('❌ App ID or App Secret not configured');
				return null;
			}

			const requestBody = {
				app_id: this.settings.appId,
				app_secret: this.settings.appSecret
			};

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/auth/v3/tenant_access_token/internal`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestBody)
			});

			const data = response.json || JSON.parse(response.text);
			Debug.log(`📋 Tenant token response:`, data);

			if (data.code === 0) {
				Debug.log(`✅ Got tenant access token`);
				return data.tenant_access_token;
			} else {
				Debug.error(`❌ Failed to get tenant token - Code: ${data.code}, Message: ${data.msg}`);
				return null;
			}

		} catch (error) {
			Debug.error('❌ Get tenant token error:', error);
			return null;
		}
	}

	/**
	 * 测试API连接和token有效性
	 */
	async testApiConnection(): Promise<{success: boolean, error?: string, userInfo?: any}> {
		try {
			if (!this.settings.accessToken) {
				return { success: false, error: 'No access token available' };
			}

			Debug.log(`🧪 Testing API connection with user info endpoint`);

			const response = await requestUrl({
				url: FEISHU_CONFIG.USER_INFO_URL,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				}
			});

			Debug.log(`📥 User info response status: ${response.status}`);
			Debug.log(`📥 User info response:`, response.json);

			const data = response.json || JSON.parse(response.text);

			if (data.code === 0) {
				return { success: true, userInfo: data.data };
			} else {
				return { success: false, error: `API Error: ${data.code} - ${data.msg}` };
			}

		} catch (error) {
			Debug.error('❌ API connection test failed:', error);
			return { success: false, error: error.message };
		}
	}

	/**
	 * 获取知识空间列表
	 */
	async getWikiSpaceList(): Promise<WikiSpace[]> {
		try {
			// 首先尝试使用用户token
			let token: string | null = this.settings.accessToken;
			let tokenType = 'user';

			Debug.log(`🔍 Initial token check - User token available: ${!!token}`);
			if (token) {
				Debug.log(`🔑 User token preview: ${token.substring(0, 20)}...`);
			}

			if (!token) {
				Debug.log('🔍 No user token, trying tenant token...');
				token = await this.getTenantAccessToken();
				tokenType = 'tenant';
				if (token) {
					Debug.log(`🔑 Tenant token preview: ${token.substring(0, 20)}...`);
				}
			}

			if (!token) {
				Debug.error('❌ No valid token available');
				throw new Error('无法获取有效的访问令牌，请重新授权');
			}

			Debug.log(`✅ Using ${tokenType} token for API call`);

			// 先测试API连接
			if (tokenType === 'user') {
				Debug.log(`🧪 Testing API connection before wiki call...`);
				const testResult = await this.testApiConnection();
				Debug.log(`🧪 API test result:`, testResult);

				if (!testResult.success) {
					Debug.error(`❌ API connection test failed: ${testResult.error}`);
					// 继续尝试，但记录错误
				} else {
					Debug.log(`✅ API connection test passed`);
				}
			}

			const url = `${FEISHU_CONFIG.BASE_URL}/wiki/v2/spaces`;
			const params = new URLSearchParams({
				page_size: '50'
			});

			Debug.log(`🔍 Calling wiki API: ${url}?${params.toString()}`);
			Debug.log(`🔑 Using ${tokenType} token: ${token.substring(0, 20)}...`);

			// 使用更详细的错误捕获
			let response: any;
			let responseData: any;

			try {
				Debug.log(`🚀 Making request to: ${url}?${params.toString()}`);
				Debug.log(`🔑 Authorization header: Bearer ${token.substring(0, 10)}...`);

				response = await requestUrl({
					url: `${url}?${params.toString()}`,
					method: 'GET',
					headers: {
						'Authorization': `Bearer ${token}`,
						'Content-Type': 'application/json'
					}
				});

				Debug.log(`📥 Response received - Status: ${response.status}`);
				Debug.log(`📥 Response headers:`, response.headers);
				Debug.log(`📥 Response text:`, response.text);
				Debug.log(`📥 Response json:`, response.json);

				responseData = response.json || JSON.parse(response.text);
				Debug.log(`📋 Parsed response data:`, responseData);

			} catch (requestError) {
				Debug.error(`❌ Request failed with error:`, requestError);
				Debug.error(`❌ Error type: ${typeof requestError}`);
				Debug.error(`❌ Error constructor: ${requestError.constructor.name}`);

				// 检查错误对象的所有属性
				for (const key in requestError) {
					Debug.log(`❌ Error.${key}:`, requestError[key]);
				}

				// 尝试获取响应体内容
				if (requestError.status === 400 && requestError.headers) {
					Debug.log(`🔍 Attempting to extract response body from 400 error...`);

					// 对于400错误，Obsidian的requestUrl可能会将响应体放在不同的地方
					// 让我们尝试直接重新发送请求来获取响应体
					try {
						const errorResponse = await fetch(`${url}?${params.toString()}`, {
							method: 'GET',
							headers: {
								'Authorization': `Bearer ${token}`,
								'Content-Type': 'application/json'
							}
						});

						const errorText = await errorResponse.text();
						Debug.log(`🔍 Fetch response status: ${errorResponse.status}`);
						Debug.log(`🔍 Fetch response text: ${errorText}`);

						if (errorText) {
							try {
								const errorData = JSON.parse(errorText);
								Debug.log(`🔍 Parsed error data from fetch:`, errorData);
							} catch (parseError) {
								Debug.log(`🔍 Failed to parse fetch response as JSON:`, parseError);
							}
						}
					} catch (fetchError) {
						Debug.log(`🔍 Fetch attempt failed:`, fetchError);
					}
				}

				throw requestError;
			}

			const data: WikiSpaceListResponse = responseData;

			if (data.code === 0) {
				Debug.log(`✅ Successfully got ${data.data.items.length} wiki spaces`);
				return data.data.items;
			} else {
				Debug.error(`❌ Wiki API error - Code: ${data.code}, Message: ${data.msg}`);

				// 如果使用用户token失败，尝试应用token
				if (tokenType === 'user') {
					Debug.log('🔄 User token failed, trying tenant token...');
					const tenantToken = await this.getTenantAccessToken();
					if (tenantToken) {
						const retryResponse = await requestUrl({
							url: `${url}?${params.toString()}`,
							method: 'GET',
							headers: {
								'Authorization': `Bearer ${tenantToken}`,
								'Content-Type': 'application/json'
							}
						});

						const retryData: WikiSpaceListResponse = retryResponse.json || JSON.parse(retryResponse.text);
						if (retryData.code === 0) {
							Debug.log(`✅ Successfully got ${retryData.data.items.length} wiki spaces with tenant token`);
							return retryData.data.items;
						}
					}
				}

				throw new Error(data.msg || '获取知识空间列表失败');
			}

		} catch (error) {
			Debug.error('❌ Get wiki space list error:', error);

			// 尝试解析更详细的错误信息
			let errorMessage = 'Unknown error';
			let errorCode: string | number = 'Unknown';
			let responseText = '';
			let errorData: any = null;
			let fullErrorInfo = '';

			try {
				// 记录完整的错误对象信息
				fullErrorInfo = JSON.stringify(error, Object.getOwnPropertyNames(error), 2);
				Debug.error(`❌ Complete error object: ${fullErrorInfo}`);

				if (error.message) {
					errorMessage = error.message;
				}

				// 检查是否有status信息
				if (error.status) {
					errorCode = error.status;
				}

				// 对于Obsidian的requestUrl，错误响应可能直接在error对象中
				if (error.text) {
					responseText = error.text;
					Debug.log(`📥 Error response text from error.text: ${responseText}`);
				}

				if (error.json) {
					errorData = error.json;
					responseText = JSON.stringify(errorData);
					Debug.log(`📥 Error response json from error.json:`, errorData);

					if (errorData.code) {
						errorCode = errorData.code;
					}
					if (errorData.msg || errorData.message) {
						errorMessage = errorData.msg || errorData.message;
					}
				}

				// 如果是requestUrl的错误，尝试从响应中获取更多信息
				if (error.response) {
					responseText = error.response.text || error.response.data || '';
					Debug.log(`📥 Error response text from error.response: ${responseText}`);

					if (responseText && !errorData) {
						try {
							errorData = JSON.parse(responseText);
							errorCode = errorData.code || errorCode;
							errorMessage = errorData.msg || errorData.message || errorMessage;
							Debug.log(`📋 Parsed error data from response:`, errorData);
						} catch (parseError) {
							Debug.log('Failed to parse error response:', parseError);
						}
					}
				}

				// 尝试从错误消息中提取更多信息
				if (errorMessage.includes('Request failed, status')) {
					const statusMatch = errorMessage.match(/status (\d+)/);
					if (statusMatch) {
						errorCode = parseInt(statusMatch[1]);
						Debug.log(`📋 Extracted status code from message: ${errorCode}`);
					}
				}

			} catch (parseError) {
				Debug.log('Error parsing error details:', parseError);
			}

			Debug.error(`❌ Final Error Summary:`);
			Debug.error(`   - Code: ${errorCode}`);
			Debug.error(`   - Message: ${errorMessage}`);
			Debug.error(`   - Response Text: ${responseText}`);
			Debug.error(`   - Error Data: ${errorData ? JSON.stringify(errorData) : 'null'}`);

			// 提供更详细的错误信息
			const isPermissionError = errorMessage.includes('400') ||
									  errorCode === '400' ||
									  errorCode === 400 ||
									  errorCode === '131006' ||
									  errorMessage.includes('permission') ||
									  errorMessage.includes('权限');

			if (isPermissionError) {
				throw new Error(`获取知识库列表失败 (错误码: ${errorCode})：\n${errorMessage}\n\n可能的解决方案：\n1. 检查应用是否已申请知识库相关权限（wiki:wiki 或 wiki:wiki.readonly）\n2. 确认应用已被添加为知识库成员或管理员\n3. 验证App ID和App Secret配置是否正确\n4. 检查应用是否已正确发布\n5. 详细配置方法请参考飞书开发文档\n\n调试信息：\n- 响应文本: ${responseText}\n- 错误数据: ${errorData ? JSON.stringify(errorData, null, 2) : 'null'}\n- 完整错误: ${fullErrorInfo}`);
			}

			throw new Error(`获取知识库列表失败：${errorMessage} (错误码: ${errorCode})\n\n调试信息：\n- 响应文本: ${responseText}\n- 完整错误: ${fullErrorInfo}`);
		}
	}

	/**
	 * 获取知识库节点列表
	 */
	async getWikiNodeList(spaceId: string, parentNodeToken?: string): Promise<WikiNode[]> {
		try {
			// 确保token有效
			const tokenValid = await this.ensureValidToken();
			if (!tokenValid) {
				throw new Error('Token无效，请重新授权');
			}

			const url = `${FEISHU_CONFIG.BASE_URL}/wiki/v2/spaces/${spaceId}/nodes`;
			const params = new URLSearchParams({
				page_size: '50'
			});

			if (parentNodeToken) {
				params.append('parent_node_token', parentNodeToken);
			}

			const response = await requestUrl({
				url: `${url}?${params.toString()}`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				}
			});

			const data: WikiNodeListResponse = response.json || JSON.parse(response.text);

			if (data.code === 0) {
				return data.data.items;
			} else {
				throw new Error(data.msg || '获取知识库节点列表失败');
			}

		} catch (error) {
			Debug.error('Get wiki node list error:', error);

			// 提供更详细的错误信息
			if (error.message && error.message.includes('400')) {
				throw new Error('获取知识库节点列表失败：权限不足。请确保：\n1. 应用已申请知识库相关权限（wiki:wiki 或 wiki:wiki.readonly）\n2. 应用已被添加为知识库成员或管理员\n3. 详细配置方法请参考飞书开发文档');
			}

			throw error;
		}
	}

	/**
	 * 将云文档移动到知识库
	 */
	async moveDocToWiki(
		spaceId: string,
		objToken: string,
		objType: string,
		parentNodeToken?: string
	): Promise<{success: boolean, wikiToken?: string, taskId?: string, error?: string}> {
		try {
			// 确保token有效
			const tokenValid = await this.ensureValidToken();
			if (!tokenValid) {
				throw new Error('Token无效，请重新授权');
			}

			const url = `${FEISHU_CONFIG.BASE_URL}/wiki/v2/spaces/${spaceId}/nodes/move_docs_to_wiki`;

			const requestData: any = {
				obj_type: objType,
				obj_token: objToken
			};

			if (parentNodeToken) {
				requestData.parent_wiki_token = parentNodeToken;
			}

			const response = await requestUrl({
				url: url,
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestData)
			});

			const data: MoveDocToWikiResponse = response.json || JSON.parse(response.text);

			if (data.code === 0) {
				return {
					success: true,
					wikiToken: data.data.wiki_token,
					taskId: data.data.task_id
				};
			} else {
				return {
					success: false,
					error: data.msg || '移动文档到知识库失败'
				};
			}

		} catch (error) {
			Debug.error('Move doc to wiki error:', error);
			return {
				success: false,
				error: error.message
			};
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

			// 2. parent_type (素材上传API使用固定值)
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="parent_type"`);
			parts.push('');
			parts.push('ccm_import_open');

			// 3. size (使用UTF-8字节长度)
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="size"`);
			parts.push('');
			parts.push(contentLength.toString());

			// 4. extra (素材上传API必需参数)
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="extra"`);
			parts.push('');
			parts.push('{"obj_type":"docx","file_extension":"md"}');

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
	 * 刷新访问令牌（带并发保护）
	 */
	async refreshAccessToken(): Promise<boolean> {
		// 如果已有刷新请求在进行中，等待其完成
		if (this.refreshPromise) {
			Debug.log('🔄 Refresh already in progress, waiting...');
			return await this.refreshPromise;
		}

		// 创建新的刷新Promise
		this.refreshPromise = this.doRefreshAccessToken();

		try {
			const result = await this.refreshPromise;
			return result;
		} finally {
			// 清除Promise，允许下次刷新
			this.refreshPromise = null;
		}
	}

	/**
	 * 实际执行刷新的方法
	 */
	private async doRefreshAccessToken(): Promise<boolean> {
		try {
			if (!this.settings.refreshToken) {
				Debug.error('❌ No refresh token available');
				return false;
			}

			Debug.log('🔄 Attempting token refresh...');

			const requestBody = {
				grant_type: 'refresh_token',
				client_id: this.settings.appId,
				client_secret: this.settings.appSecret,
				refresh_token: this.settings.refreshToken
			};

			const response = await requestUrl({
				url: FEISHU_CONFIG.REFRESH_TOKEN_URL,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestBody)
			});

			Debug.log('📋 Refresh response status:', response.status);

			const data: FeishuOAuthResponse = response.json || JSON.parse(response.text);
			Debug.log('📋 Refresh response data:', data);

			if (data.code === 0) {
				// 支持v1和v2 API格式
				const accessToken = data.access_token || data.data?.access_token;
				const refreshToken = data.refresh_token || data.data?.refresh_token;

				if (accessToken) {
					this.settings.accessToken = accessToken;
					this.settings.refreshToken = refreshToken || '';

					Debug.log('✅ Token refresh successful, tokens updated');
					return true;
				} else {
					Debug.error('❌ No access token in refresh response:', data);
					return false;
				}
			} else {
				Debug.error('❌ Token refresh failed with code:', data.code);
				Debug.error('❌ Error message:', data.msg || data.error_description || 'Unknown error');
				Debug.error('❌ Full response:', data);
				return false;
			}

		} catch (error) {
			Debug.error('❌ Token refresh error:', error);

			// 尝试从错误中提取更多信息
			if (error.message && error.message.includes('Request failed, status 400')) {
				Debug.error('❌ 400 Bad Request - Refresh token is invalid or expired');
				Debug.error('💡 Solution: Clear authorization in settings and re-authorize');

				// 自动清除无效的refresh_token，避免重复尝试
				this.settings.refreshToken = '';
				Debug.log('🧹 Cleared invalid refresh token');
			}

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
	async ensureValidToken(): Promise<boolean> {
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
			} else if (this.isTokenExpiredError(data.code)) {
				// Token过期，尝试刷新
				Debug.log(`⚠️ Token expired (code: ${data.code}), attempting refresh`);
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
		Debug.log('🔍 Starting token validation with reauth support');

		if (!this.settings.accessToken) {
			Debug.log('❌ No access token available, triggering reauth');
			// 对于手动清除授权的情况，提供更友好的提示
			if (statusNotice) {
				statusNotice.setMessage('🔑 检测到需要重新授权，正在自动打开授权页面...');
			}
			return await this.triggerReauth('需要重新授权', statusNotice);
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
				Debug.log('✅ Token is valid');
				return true;
			} else if (this.isTokenExpiredError(data.code)) {
				Debug.log(`⚠️ Token expired (code: ${data.code}), attempting refresh`);
				// Token过期，尝试刷新
				const refreshSuccess = await this.refreshAccessToken();

				if (refreshSuccess) {
					Debug.log('✅ Token refreshed successfully');
					return true;
				} else {
					Debug.log('❌ Token refresh failed, triggering reauth');
					const reauthSuccess = await this.triggerReauth('Token刷新失败', statusNotice);
					if (reauthSuccess) {
						Debug.log('✅ Reauth completed successfully');
						return true;
					}
					Debug.log('❌ Reauth failed');
					return false;
				}
			} else {
				Debug.log(`❌ Token invalid (code: ${data.code}), triggering reauth`);
				const reauthSuccess = await this.triggerReauth(`Token无效 (错误码: ${data.code})`, statusNotice);
				if (reauthSuccess) {
					Debug.log('✅ Reauth completed successfully');
					return true;
				}
				Debug.log('❌ Reauth failed');
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
			20005,    // 另一种token无效错误码
			1,        // 通用的无效token错误
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
				statusNotice.setMessage('🌐 已打开浏览器进行授权，请在浏览器中完成授权后返回...');
			} else {
				new Notice('🌐 已打开浏览器进行授权，请在浏览器中完成授权后返回...');
			}

			// 等待授权完成
			const authResult = await this.waitForReauth(statusNotice);

			if (!authResult) {
				// 授权失败或超时，提供更友好的错误信息
				const retryMsg = '⏰ 授权超时或失败。请确保在浏览器中完成授权，然后重新尝试分享。';
				if (statusNotice) {
					statusNotice.setMessage(retryMsg);
					setTimeout(() => statusNotice.hide(), 5000);
				} else {
					new Notice(retryMsg);
				}
			}

			return authResult;

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
			// 应用频率控制
			await this.rateLimitController.throttle('import');

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
			// 应用频率控制
			await this.rateLimitController.throttle('import');

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
	private async findPlaceholderBlocks(documentId: string, localFiles: LocalFileInfo[], calloutBlocks?: CalloutInfo[]): Promise<PlaceholderBlock[]> {
		try {
			const placeholderBlocks: PlaceholderBlock[] = [];
			let pageToken = '';
			let hasMore = true;

			// 预编译占位符模式（方案3：智能搜索优化）
			const placeholderPatterns = this.compilePlaceholderPatterns(localFiles, calloutBlocks);

			// 收集所有占位符（文件 + Callout）
			const allPlaceholders = [
				...localFiles.map(f => f.placeholder),
				...(calloutBlocks?.map(c => c.placeholder) || [])
			];
			const remainingPlaceholders = new Set(allPlaceholders);
			const totalPlaceholders = allPlaceholders.length;

			Debug.log(`🔍 Searching for ${remainingPlaceholders.size} placeholders in document (${localFiles.length} files + ${calloutBlocks?.length || 0} callouts)...`);

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
					Debug.log(`✅ All ${totalPlaceholders} placeholders found, stopping search early`);
					break;
				}

				hasMore = data.data.has_more;
				pageToken = data.data.page_token;
			}

			Debug.log(`🎯 Found ${placeholderBlocks.length}/${totalPlaceholders} placeholder blocks`);
			return placeholderBlocks;

		} catch (error) {
			Debug.error('Find placeholder blocks error:', error);
			throw error;
		}
	}

	/**
	 * 预编译占位符模式（方案3优化）
	 */
	private compilePlaceholderPatterns(localFiles: LocalFileInfo[], calloutBlocks?: CalloutInfo[]): Map<string, {fileInfo?: LocalFileInfo, calloutInfo?: CalloutInfo, patterns: RegExp[]}> {
		const patterns = new Map<string, {fileInfo?: LocalFileInfo, calloutInfo?: CalloutInfo, patterns: RegExp[]}>();

		// 处理文件占位符
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

		// 处理 Callout 占位符
		if (calloutBlocks) {
			calloutBlocks.forEach(calloutInfo => {
				const placeholder = calloutInfo.placeholder;
				const cleanPlaceholder = placeholder.replace(/^__/, '').replace(/__$/, '');

				// 预编译所有可能的占位符格式的正则表达式
				const regexPatterns = [
					new RegExp(this.escapeRegExp(placeholder)), // 原始格式
					new RegExp(this.escapeRegExp(`!${cleanPlaceholder}`)), // 飞书处理后格式
					new RegExp(this.escapeRegExp(cleanPlaceholder)) // 清理后格式
				];

				patterns.set(placeholder, {
					calloutInfo,
					patterns: regexPatterns
				});
			});
		}

		return patterns;
	}

	/**
	 * 在块列表中搜索占位符（优化版本）
	 */
	private searchPlaceholdersInBlocks(
		blocks: any[],
		placeholderPatterns: Map<string, {fileInfo?: LocalFileInfo, calloutInfo?: CalloutInfo, patterns: RegExp[]}>,
		remainingPlaceholders: Set<string>
	): PlaceholderBlock[] {
		const foundBlocks: PlaceholderBlock[] = [];

		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			const block = blocks[blockIndex];

			// 处理文本块、标题块、列表块等包含文本内容的块
			let textData = null;
			if (block.text && block.text.elements) {
				textData = block.text;
			} else if (block.heading1 && block.heading1.elements) {
				textData = block.heading1;
			} else if (block.heading2 && block.heading2.elements) {
				textData = block.heading2;
			} else if (block.heading3 && block.heading3.elements) {
				textData = block.heading3;
			} else if (block.heading4 && block.heading4.elements) {
				textData = block.heading4;
			} else if (block.heading5 && block.heading5.elements) {
				textData = block.heading5;
			} else if (block.heading6 && block.heading6.elements) {
				textData = block.heading6;
			} else if (block.heading7 && block.heading7.elements) {
				textData = block.heading7;
			} else if (block.heading8 && block.heading8.elements) {
				textData = block.heading8;
			} else if (block.heading9 && block.heading9.elements) {
				textData = block.heading9;
			} else if (block.bullet && block.bullet.elements) {
				textData = block.bullet; // 无序列表块
			} else if (block.ordered && block.ordered.elements) {
				textData = block.ordered; // 有序列表块
			}

			if (!textData) {
				continue;
			}

			// 提取块的所有文本内容
			const blockContent = this.extractBlockTextContentFromData(textData);

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

					// 计算块在其父块中的正确索引
					const parentBlock = blocks.find(b => b.block_id === block.parent_id);
					let correctIndex = 0;
					if (parentBlock && parentBlock.children) {
						correctIndex = parentBlock.children.indexOf(block.block_id);
						if (correctIndex === -1) {
							correctIndex = 0; // 如果找不到，默认为0
						}
					}

					const placeholderBlock: PlaceholderBlock = {
						blockId: block.block_id,
						parentId: block.parent_id,
						index: correctIndex,
						placeholder: placeholder
					};

					Debug.log(`📍 Placeholder block position: parentId=${block.parent_id}, index=${correctIndex} (was ${blockIndex})`);

					// 根据类型添加相应的信息
					if (patternInfo.fileInfo) {
						placeholderBlock.fileInfo = patternInfo.fileInfo;
					}
					if (patternInfo.calloutInfo) {
						placeholderBlock.calloutInfo = patternInfo.calloutInfo;
					}

					foundBlocks.push(placeholderBlock);

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
		// 处理不同类型的块
		let textData = null;
		if (block.text && block.text.elements) {
			textData = block.text;
		} else if (block.bullet && block.bullet.elements) {
			textData = block.bullet;
		} else if (block.ordered && block.ordered.elements) {
			textData = block.ordered;
		}

		if (!textData) {
			return '';
		}

		return this.extractBlockTextContentFromData(textData);
	}

	/**
	 * 从文本数据中提取文本内容
	 */
	private extractBlockTextContentFromData(textData: any): string {
		return textData.elements
			.filter((element: any) => element.text_run && element.text_run.content)
			.map((element: any) => element.text_run.content)
			.join('');
	}

	/**
	 * 检查文本是否包含占位符特征（快速预筛选）
	 */
	private hasPlaceholderFeatures(content: string): boolean {
		// 快速检查是否包含占位符的特征字符串
		return content.includes('OB_CONTENT_') || content.includes('__OB_CONTENT_') ||
		       content.includes('FEISHU_FILE_') || content.includes('__FEISHU_FILE_'); // 保持向后兼容
	}

	/**
	 * 转义正则表达式特殊字符
	 */
	private escapeRegExp(string: string): string {
		return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/**
	 * 在占位符位置插入 Callout 块（简化版本，避免复杂重试逻辑）
	 */
	private async insertCalloutBlock(documentId: string, placeholderBlock: PlaceholderBlock): Promise<string> {
		if (!placeholderBlock.calloutInfo) {
			throw new Error('Callout 信息缺失');
		}

		const calloutInfo = placeholderBlock.calloutInfo;
		Debug.log(`🎨 Creating Callout block: ${calloutInfo.type}`);
		Debug.log(`📍 Position: parentId=${placeholderBlock.parentId}, index=${placeholderBlock.index}`);
		Debug.log(`🎨 Style: bg=${calloutInfo.backgroundColor}, border=${calloutInfo.borderColor}, text=${calloutInfo.textColor}`);
		Debug.log(`📝 Content: title="${calloutInfo.title}", content="${calloutInfo.content}"`);
		Debug.log(`🔗 Placeholder: ${calloutInfo.placeholder}`);

		try {
			// 创建 Callout Block (Block Type 19)
			const requestData = {
				index: placeholderBlock.index,
				children: [{
					block_type: 19, // callout
					callout: {
						background_color: calloutInfo.backgroundColor,
						border_color: calloutInfo.borderColor,
						text_color: calloutInfo.textColor
					}
				}]
			};

			Debug.log(`🌐 API Request: POST ${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${placeholderBlock.parentId}/children`);
			Debug.log(`📤 Request body:`, JSON.stringify(requestData, null, 2));

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${placeholderBlock.parentId}/children`,
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(requestData)
			});

			Debug.log(`📥 API Response status: ${response.status}`);
			const data: FeishuBlockCreateResponse = response.json || JSON.parse(response.text);
			Debug.log(`📥 API Response data:`, JSON.stringify(data, null, 2));

			if (data.code !== 0) {
				Debug.error(`❌ Callout block creation failed: code=${data.code}, msg=${data.msg}`);
				throw new Error(data.msg || '插入 Callout 块失败');
			}

			const calloutBlockId = data.data.children[0].block_id;
			Debug.log(`✅ Created Callout block: ${calloutBlockId}`);

			// 添加延迟避免频率限制
			await new Promise(resolve => setTimeout(resolve, 500));

			// 在 Callout Block 内添加标题和内容（简化版本）
			Debug.log(`🔍 NEW MODE: About to call addCalloutContentSimple for Callout: ${calloutInfo.type}`);
			await this.addCalloutContentSimple(documentId, calloutBlockId, calloutInfo);

			return calloutBlockId;

		} catch (error) {
			Debug.error('Insert Callout block error:', error);
			throw error;
		}
	}

	/**
	 * 在 Callout 块内添加标题和内容（简化版本）
	 */
	private async addCalloutContentSimple(documentId: string, calloutBlockId: string, calloutInfo: CalloutInfo): Promise<void> {
		try {
			// 创建标题文本块（加粗）
			const titleRequestData = {
				index: 0,
				children: [{
					block_type: 2, // 文本块
					text: {
						elements: [{
							text_run: {
								content: calloutInfo.title,
								text_element_style: {
									bold: true
								}
							}
						}]
					}
				}]
			};

			Debug.log(`📝 Adding title to Callout block: ${calloutBlockId}`);
			const titleResponse = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${calloutBlockId}/children`,
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(titleRequestData)
			});

			const titleData = titleResponse.json || JSON.parse(titleResponse.text);
			if (titleData.code !== 0) {
				throw new Error(titleData.msg || '添加标题失败');
			}
			Debug.log(`✅ Successfully added title to Callout block`);

			// 如果有内容，添加内容文本块
			if (calloutInfo.content.trim()) {
				// 添加延迟避免频率限制
				await new Promise(resolve => setTimeout(resolve, 800));

				// 解析 Markdown 内容为富文本元素
				Debug.log(`🎨 Original Markdown content: "${calloutInfo.content}"`);
				const contentElements = this.parseMarkdownToTextElements(calloutInfo.content);
				Debug.log(`🎨 Parsed ${contentElements.length} text elements from Markdown content`);
				Debug.log(`🎨 Parsed elements:`, JSON.stringify(contentElements, null, 2));

				const contentRequestData = {
					index: 1,
					children: [{
						block_type: 2, // 文本块
						text: {
							elements: contentElements
						}
					}]
				};

				Debug.log(`📝 Adding content to Callout block: ${calloutBlockId}`);
				const contentResponse = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${calloutBlockId}/children`,
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(contentRequestData)
				});

				const contentData = contentResponse.json || JSON.parse(contentResponse.text);
				if (contentData.code !== 0) {
					throw new Error(contentData.msg || '添加内容失败');
				}
				Debug.log(`✅ Successfully added content to Callout block`);
			}

			Debug.log(`✅ Added content to Callout block: ${calloutBlockId}`);

		} catch (error) {
			Debug.error('Add Callout content error:', error);
			throw error;
		}
	}

	/**
	 * 解析 Markdown 文本为飞书富文本元素
	 */
	private parseMarkdownToTextElements(markdown: string): any[] {
		const elements: any[] = [];

		// 简单的 Markdown 解析器
		// 支持：**粗体**、*斜体*、`代码`、~~删除线~~、==高亮==（按粗体处理）

		let currentIndex = 0;
		const text = markdown;

		while (currentIndex < text.length) {
			// 查找下一个格式标记
			const highlightMatch = text.substring(currentIndex).match(/^==(.+?)==/);
			const boldMatch = text.substring(currentIndex).match(/^\*\*(.*?)\*\*/);
			const italicMatch = text.substring(currentIndex).match(/^\*(.*?)\*/);
			const codeMatch = text.substring(currentIndex).match(/^`(.*?)`/);
			const strikeMatch = text.substring(currentIndex).match(/^~~(.*?)~~/);

			if (highlightMatch) {
				// ==高亮== 作为粗体处理
				elements.push({
					text_run: {
						content: highlightMatch[1],
						text_element_style: { bold: true }
					}
				});
				currentIndex += highlightMatch[0].length;
			} else if (boldMatch) {
				// 粗体
				elements.push({
					text_run: {
						content: boldMatch[1],
						text_element_style: {
							bold: true
						}
					}
				});
				currentIndex += boldMatch[0].length;
			} else if (italicMatch && !text.substring(currentIndex).startsWith('**')) {
				// 斜体（确保不是粗体的一部分）
				elements.push({
					text_run: {
						content: italicMatch[1],
						text_element_style: {
							italic: true
						}
					}
				});
				currentIndex += italicMatch[0].length;
			} else if (codeMatch) {
				// 行内代码
				elements.push({
					text_run: {
						content: codeMatch[1],
						text_element_style: {
							inline_code: true
						}
					}
				});
				currentIndex += codeMatch[0].length;
			} else if (strikeMatch) {
				// 删除线
				elements.push({
					text_run: {
						content: strikeMatch[1],
						text_element_style: {
							strikethrough: true
						}
					}
				});
				currentIndex += strikeMatch[0].length;
			} else {
				// 普通文本，查找到下一个格式标记或字符串结尾
				let nextFormatIndex = text.length;
				const nextHighlight = text.indexOf('==', currentIndex);
				const nextBold = text.indexOf('**', currentIndex);
				const nextItalic = text.indexOf('*', currentIndex);
				const nextCode = text.indexOf('`', currentIndex);
				const nextStrike = text.indexOf('~~', currentIndex);

				[nextHighlight, nextBold, nextItalic, nextCode, nextStrike].forEach(index => {
					if (index !== -1 && index < nextFormatIndex) {
						nextFormatIndex = index;
					}
				});

				const plainText = text.substring(currentIndex, nextFormatIndex);
				if (plainText) {
					elements.push({
						text_run: {
							content: plainText
						}
					});
				}
				currentIndex = nextFormatIndex;
			}
		}

		return elements;
	}

	/**
	 * 在 Callout 块内添加标题和内容（带重试机制）
	 */
	private async addCalloutContent(documentId: string, calloutBlockId: string, calloutInfo: CalloutInfo): Promise<void> {
		// 创建标题文本块（加粗）
		await this.addCalloutContentWithRetry(documentId, calloutBlockId, {
			index: 0,
			children: [{
				block_type: 2, // 文本块
				text: {
					elements: [{
						text_run: {
							content: calloutInfo.title,
							text_element_style: {
								bold: true
							}
						}
					}]
				}
			}]
		}, 'title');

		// 如果有内容，添加内容文本块
		if (calloutInfo.content.trim()) {
			// 添加延迟避免频率限制
			const delay = 800; // 800ms延迟
			Debug.log(`⏱️ Waiting ${delay}ms before adding content...`);
			await new Promise(resolve => setTimeout(resolve, delay));

			// 解析 Markdown 内容为富文本元素
			Debug.log(`🎨 Original Markdown content: "${calloutInfo.content}"`);
			const contentElements = this.parseMarkdownToTextElements(calloutInfo.content);
			Debug.log(`🎨 Parsed ${contentElements.length} text elements from Markdown content`);
			Debug.log(`🎨 Parsed elements:`, JSON.stringify(contentElements, null, 2));

			await this.addCalloutContentWithRetry(documentId, calloutBlockId, {
				index: 1,
				children: [{
					block_type: 2, // 文本块
					text: {
						elements: contentElements
					}
				}]
			}, 'content');
		}

		Debug.log(`✅ Added content to Callout block: ${calloutBlockId}`);
	}

	/**
	 * 添加 Callout 内容的重试方法
	 */
	private async addCalloutContentWithRetry(
		documentId: string,
		calloutBlockId: string,
		requestData: any,
		contentType: string
	): Promise<void> {
		const maxRetries = 3;
		let lastError: Error | null = null;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				if (attempt > 1) {
					const delay = Math.min(2000 * Math.pow(2, attempt - 1), 10000); // 指数退避，最大10秒
					Debug.log(`⏱️ Waiting ${delay}ms before retry attempt ${attempt} for ${contentType}...`);
					await new Promise(resolve => setTimeout(resolve, delay));
				}

				Debug.log(`📝 Adding ${contentType} to Callout block (attempt ${attempt}/${maxRetries}): ${calloutBlockId}`);

				const response = await requestUrl({
					url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${calloutBlockId}/children`,
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${this.settings.accessToken}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(requestData)
				});

				const data = response.json || JSON.parse(response.text);

				if (data.code !== 0) {
					throw new Error(data.msg || `添加 ${contentType} 失败`);
				}

				Debug.log(`✅ Successfully added ${contentType} to Callout block`);
				return; // 成功，退出重试循环

			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				Debug.warn(`⚠️ Add ${contentType} attempt ${attempt} failed:`, lastError.message);

				// 检查是否是频率限制错误
				if (lastError.message.includes('429') && attempt < maxRetries) {
					// 尝试从响应头获取重置时间
					const resetTime = this.extractRateLimitReset(error);
					if (resetTime > 0) {
						Debug.log(`🔄 Rate limit detected, will wait ${resetTime}s as suggested by server...`);
						await new Promise(resolve => setTimeout(resolve, resetTime * 1000));
					}
					continue;
				}

				// 如果不是频率限制错误或已达到最大重试次数，抛出错误
				if (attempt === maxRetries) {
					Debug.error(`❌ All ${maxRetries} attempts failed for adding ${contentType} to Callout block`);
					throw lastError;
				}
			}
		}
	}

	/**
	 * 从错误响应中提取频率限制重置时间
	 */
	private extractRateLimitReset(error: any): number {
		try {
			// 尝试从错误对象中提取响应头信息
			if (error && error.headers && error.headers['x-ogw-ratelimit-reset']) {
				const resetTime = parseInt(error.headers['x-ogw-ratelimit-reset']);
				if (!isNaN(resetTime) && resetTime > 0) {
					return Math.min(resetTime, 60); // 最大等待60秒
				}
			}
		} catch (e) {
			Debug.warn('Failed to extract rate limit reset time:', e);
		}
		return 0; // 如果无法提取，返回0
	}

	/**
	 * 在占位符位置插入文件块或图片块
	 */
	private async insertFileBlock(documentId: string, placeholderBlock: PlaceholderBlock): Promise<string> {
		try {
			if (!placeholderBlock.fileInfo) {
				throw new Error('文件信息缺失');
			}

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
				if (block) {
					// 使用修复后的方法获取块内容（支持列表块）
					const blockContent = this.extractBlockTextContent(block);
					Debug.log(`🔍 Checking block ${placeholderBlock.blockId} (type: ${block.block_type}): "${blockContent.substring(0, 100)}..."`);

					if (blockContent.length === 0) {
						Debug.log(`⚠️ Block has no text content: ${placeholderBlock.blockId}`);
						continue;
					}

					// 检查是否仍包含占位符文本（考虑多种格式）
					const originalPlaceholder = placeholderBlock.placeholder; // __FEISHU_FILE_xxx__
					const cleanPlaceholder = originalPlaceholder.replace(/^__/, '').replace(/__$/, ''); // FEISHU_FILE_xxx
					const feishuPlaceholder = `!${cleanPlaceholder}!`; // !FEISHU_FILE_xxx!

					const hasOriginal = blockContent.includes(originalPlaceholder);
					const hasFeishu = blockContent.includes(feishuPlaceholder);
					const hasClean = blockContent.includes(cleanPlaceholder);

					if (hasOriginal || hasFeishu || hasClean) {
						const foundFormat = hasOriginal ? 'original' : hasFeishu ? 'feishu' : 'clean';
						Debug.log(`✅ Found remaining placeholder: ${originalPlaceholder} (format: ${foundFormat}) in block type ${block.block_type}`);
						remainingPlaceholders.push(placeholderBlock);
					} else {
						Debug.log(`❌ Placeholder already cleaned: ${originalPlaceholder}`);
					}
				} else {
					Debug.log(`⚠️ Block not found: ${placeholderBlock.blockId}`);
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
			Debug.log(`⚠️ Batch replacement requires individual processing for precise placeholder removal, falling back to individual replacement...`);

			// 批量替换无法精确处理占位符（需要保留其他文本），直接使用逐个替换
			await this.fallbackIndividualReplace(documentId, placeholderBlocks);

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
			Debug.log(`🔧 Starting placeholder replacement for block: ${placeholderBlock.blockId}`);
			Debug.log(`🎯 Target placeholder: ${placeholderBlock.placeholder}`);

			// 获取当前块的内容
			const blockInfo = await this.getBlockContent(documentId, placeholderBlock.blockId);
			if (!blockInfo) {
				Debug.warn(`⚠️ Cannot get block content for ${placeholderBlock.blockId}, trying delete method...`);
				await this.deletePlaceholderBlock(documentId, placeholderBlock);
				return;
			}

			Debug.log(`📋 Retrieved ${blockInfo.elements.length} elements from block`);
			blockInfo.elements.forEach((element, index) => {
				if (element.text_run) {
					Debug.log(`  Element ${index + 1}: "${element.text_run.content}"`);
				}
			});

			// 分析占位符后的内容，决定处理策略
			const afterContent = this.extractContentAfterPlaceholder(blockInfo.elements, placeholderBlock.placeholder);
			Debug.log(`🔍 Content after placeholder: "${afterContent}"`);

			if (afterContent && this.shouldCreateSeparateBlock(afterContent)) {
				// 需要创建独立块的情况
				await this.handlePlaceholderWithSeparateBlock(documentId, placeholderBlock, afterContent);
			} else {
				// 常规替换处理
				await this.handlePlaceholderWithTextReplacement(documentId, placeholderBlock, blockInfo);
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
	 * 提取占位符后的内容
	 */
	private extractContentAfterPlaceholder(elements: any[], targetPlaceholder: string): string | null {
		const cleanPlaceholder = targetPlaceholder.replace(/^__/, '').replace(/__$/, '');
		const possiblePlaceholders = [
			targetPlaceholder,
			`!${cleanPlaceholder}!`,
			cleanPlaceholder,
			`!${cleanPlaceholder}`,
			`${cleanPlaceholder}!`
		];

		for (const element of elements) {
			if (element.text_run && element.text_run.content) {
				const content = element.text_run.content;

				for (const placeholder of possiblePlaceholders) {
					const placeholderIndex = content.indexOf(placeholder);
					if (placeholderIndex !== -1) {
						const afterContent = content.substring(placeholderIndex + placeholder.length);
						return afterContent.length > 0 ? afterContent : null;
					}
				}
			}
		}
		return null;
	}

	/**
	 * 判断是否需要为后续内容创建独立的块
	 */
	private shouldCreateSeparateBlock(afterContent: string): boolean {
		const trimmed = afterContent.trim();

		// 检查是否是分隔符
		if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
			Debug.log(`🔍 Detected separator: "${trimmed}"`);
			return true;
		}

		// 检查是否是以换行符开头的实质内容
		if (afterContent.startsWith('\n') && trimmed.length > 0 && !trimmed.startsWith('!')) {
			Debug.log(`🔍 Detected content after newline: "${trimmed}"`);
			return true;
		}

		return false;
	}

	/**
	 * 处理需要创建独立块的占位符
	 */
	private async handlePlaceholderWithSeparateBlock(documentId: string, placeholderBlock: PlaceholderBlock, afterContent: string): Promise<void> {
		Debug.log(`🔧 Handling placeholder with separate block creation`);

		try {
			// 1. 先删除包含占位符的原始块
			await this.deletePlaceholderBlock(documentId, placeholderBlock);

			// 2. 创建新的文本块来放置后续内容
			const trimmedContent = afterContent.trim();
			if (trimmedContent.length > 0) {
				Debug.log(`📝 Creating new block for content: "${trimmedContent}"`);

				const requestData = {
					index: placeholderBlock.index,
					children: [{
						block_type: 2, // 文本块
						text: {
							elements: [{
								text_run: {
									content: trimmedContent
								}
							}]
						}
					}]
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

				const data = response.json || JSON.parse(response.text);
				if (data.code !== 0) {
					Debug.warn(`⚠️ Failed to create new block: ${data.msg}`);
				} else {
					Debug.log(`✅ Successfully created new block for content`);
				}
			}

		} catch (error) {
			Debug.error('Handle placeholder with separate block error:', error);
			throw error;
		}
	}

	/**
	 * 处理常规文本替换的占位符
	 */
	private async handlePlaceholderWithTextReplacement(documentId: string, placeholderBlock: PlaceholderBlock, blockInfo: any): Promise<void> {
		Debug.log(`🔧 Handling placeholder with text replacement`);

		// 构建新的文本元素数组，移除占位符但保留其他文本
		const newElements = this.buildTextElementsWithoutPlaceholder(blockInfo.elements, placeholderBlock.placeholder);

		Debug.log(`🔄 Built ${newElements.length} new elements after placeholder removal`);
		newElements.forEach((element, index) => {
			if (element.text_run) {
				Debug.log(`  New Element ${index + 1}: "${element.text_run.content}"`);
			}
		});

		const requestData = {
			update_text_elements: {
				elements: newElements
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
	}

	/**
	 * 批量删除占位符文本块（带延迟避免频率限制）
	 */
	private async batchDeletePlaceholderBlocks(documentId: string, placeholderBlocks: PlaceholderBlock[]): Promise<void> {
		Debug.log(`🗑️ Batch deleting ${placeholderBlocks.length} placeholder blocks...`);

		for (let i = 0; i < placeholderBlocks.length; i++) {
			const placeholderBlock = placeholderBlocks[i];

			try {
				// 在删除操作之间添加延迟以避免频率限制
				if (i > 0) {
					const delay = 500; // 500ms延迟
					Debug.log(`⏱️ Waiting ${delay}ms between deletions...`);
					await new Promise(resolve => setTimeout(resolve, delay));
				}

				await this.deletePlaceholderBlock(documentId, placeholderBlock);
				Debug.log(`✅ Deleted placeholder block: ${placeholderBlock.blockId}`);
			} catch (error) {
				Debug.error(`❌ Failed to delete placeholder block ${placeholderBlock.blockId}:`, error);
				// 继续删除其他块，不中断整个流程
			}
		}
	}

	/**
	 * 通过占位符文本删除块（更精确的方法）
	 */
	private async deleteBlockByPlaceholderText(documentId: string, placeholderText: string): Promise<void> {
		try {
			Debug.log(`🔍 Searching for block containing placeholder text: ${placeholderText}`);

			// 获取文档所有块
			const allBlocks = await this.getAllDocumentBlocks(documentId);

			// 查找包含占位符文本的块
			let targetBlock: any = null;
			let targetParentId: string = '';
			let targetIndex: number = -1;

			Debug.log(`🔍 Analyzing ${allBlocks.length} blocks for placeholder text...`);

			for (const block of allBlocks) {
				// 检查文本块和标题块
				let textData: any = null;
				let blockTypeDesc = '';

				if (block.block_type === 2 && block.text && block.text.elements) {
					textData = block.text;
					blockTypeDesc = 'text block';
				} else if (block.block_type === 3 && block.heading1 && block.heading1.elements) {
					textData = block.heading1;
					blockTypeDesc = 'heading1 block';
				} else if (block.block_type === 4 && block.heading2 && block.heading2.elements) {
					textData = block.heading2;
					blockTypeDesc = 'heading2 block';
				} else if (block.block_type === 5 && block.heading3 && block.heading3.elements) {
					textData = block.heading3;
					blockTypeDesc = 'heading3 block';
				} else if (block.block_type === 6 && block.heading4 && block.heading4.elements) {
					textData = block.heading4;
					blockTypeDesc = 'heading4 block';
				} else if (block.block_type === 7 && block.heading5 && block.heading5.elements) {
					textData = block.heading5;
					blockTypeDesc = 'heading5 block';
				} else if (block.block_type === 8 && block.heading6 && block.heading6.elements) {
					textData = block.heading6;
					blockTypeDesc = 'heading6 block';
				} else if (block.block_type === 9 && block.heading7 && block.heading7.elements) {
					textData = block.heading7;
					blockTypeDesc = 'heading7 block';
				} else if (block.block_type === 10 && block.heading8 && block.heading8.elements) {
					textData = block.heading8;
					blockTypeDesc = 'heading8 block';
				} else if (block.block_type === 11 && block.heading9 && block.heading9.elements) {
					textData = block.heading9;
					blockTypeDesc = 'heading9 block';
				}

				if (textData) {
					Debug.log(`📄 Checking ${blockTypeDesc}: ${block.block_id}, elements: ${textData.elements.length}`);

					// 收集所有文本内容
					let fullText = '';
					for (const element of textData.elements) {
						if (element.text_run && element.text_run.content) {
							fullText += element.text_run.content;
							Debug.log(`📝 Text element: "${element.text_run.content}"`);
						}
					}

					Debug.log(`📄 Full text content: "${fullText}"`);

					// 检查完整文本是否包含占位符（去掉前后的下划线）
					const cleanPlaceholderText = placeholderText.replace(/^__/, '').replace(/__$/, '');
					Debug.log(`🔍 Comparing: "${fullText}" contains "${cleanPlaceholderText}"?`);

					if (fullText.includes(cleanPlaceholderText)) {
						Debug.log(`🎯 Found placeholder in block: ${block.block_id}`);

						// 检查是否整个块只包含占位符（可以直接删除）
						const trimmedFullText = fullText.trim();
						const trimmedPlaceholder = cleanPlaceholderText.trim();

						if (trimmedFullText === trimmedPlaceholder) {
							Debug.log(`🎯 Block contains only placeholder, will delete entire block`);
							targetBlock = block;
							targetParentId = block.parent_id;
							break;
						} else {
							Debug.log(`🎯 Block contains placeholder + other text, will update block content`);
							Debug.log(`📝 Full text: "${fullText}"`);
							Debug.log(`📝 Placeholder: "${cleanPlaceholderText}"`);

							// 更新块内容，移除占位符
							await this.updateBlockContentRemovePlaceholder(documentId, block, textData, cleanPlaceholderText);
							return; // 已处理完成，直接返回
						}
					}
				}
			}

			if (!targetBlock) {
				Debug.warn(`⚠️ Placeholder text not found: ${placeholderText}`);
				return;
			}

			// 找到目标块在父块中的索引
			const parentBlock = allBlocks.find(b => b.block_id === targetParentId);
			if (parentBlock && parentBlock.children) {
				targetIndex = parentBlock.children.indexOf(targetBlock.block_id);
			}

			if (targetIndex === -1) {
				Debug.warn(`⚠️ Could not find index for block: ${targetBlock.block_id}`);
				return;
			}

			Debug.log(`🎯 Found placeholder block: ${targetBlock.block_id} at index ${targetIndex} in parent ${targetParentId}`);

			// 删除块
			const requestData = {
				start_index: targetIndex,
				end_index: targetIndex + 1
			};

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${targetParentId}/children/batch_delete`,
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

			Debug.log(`✅ Successfully deleted placeholder block: ${targetBlock.block_id}`);

		} catch (error) {
			Debug.error('Delete placeholder by text error:', error);
			throw error;
		}
	}

	/**
	 * 更新块内容，移除占位符但保留其他文字
	 */
	private async updateBlockContentRemovePlaceholder(
		documentId: string,
		block: any,
		textData: any,
		placeholderText: string
	): Promise<void> {
		try {
			Debug.log(`🔧 Updating block content to remove placeholder: ${block.block_id}`);

			// 构建新的文本元素数组，移除包含占位符的元素
			const newElements: any[] = [];

			for (const element of textData.elements) {
				if (element.text_run && element.text_run.content) {
					const content = element.text_run.content;

					if (content.includes(placeholderText)) {
						// 如果元素包含占位符，移除占位符部分
						const cleanedContent = content.replace(placeholderText, '').trim();

						if (cleanedContent.length > 0) {
							// 如果还有其他内容，保留
							newElements.push({
								text_run: {
									content: cleanedContent,
									text_element_style: element.text_run.text_element_style || {}
								}
							});
							Debug.log(`📝 Kept cleaned content: "${cleanedContent}"`);
						} else {
							Debug.log(`📝 Removed element containing only placeholder`);
						}
					} else {
						// 不包含占位符的元素直接保留
						newElements.push(element);
						Debug.log(`📝 Kept element: "${content}"`);
					}
				}
			}

			if (newElements.length === 0) {
				Debug.log(`⚠️ No content left after removing placeholder, will delete entire block`);
				// 如果没有内容了，删除整个块
				const parentBlock = await this.findParentBlock(block.block_id);
				if (parentBlock) {
					await this.deleteBlockFromParent(parentBlock.block_id, block.block_id);
				}
				return;
			}

			// 更新块内容 - 使用飞书API正确的格式
			const updateData = {
				update_text_elements: {
					elements: newElements
				}
			};

			Debug.log(`📤 Update request data:`, JSON.stringify(updateData, null, 2));

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${documentId}/blocks/${block.block_id}`,
				method: 'PATCH',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(updateData)
			});

			const data = response.json || JSON.parse(response.text);

			if (data.code !== 0) {
				throw new Error(data.msg || '更新块内容失败');
			}

			Debug.log(`✅ Successfully updated block content: ${block.block_id}`);

		} catch (error) {
			Debug.error('Update block content error:', error);
			throw error;
		}
	}

	/**
	 * 查找块的父块
	 */
	private async findParentBlock(blockId: string): Promise<any> {
		// 这里需要实现查找父块的逻辑
		// 暂时返回null，如果需要可以进一步实现
		return null;
	}

	/**
	 * 从父块中删除指定的子块
	 */
	private async deleteBlockFromParent(parentId: string, blockId: string): Promise<void> {
		// 这里需要实现从父块删除子块的逻辑
		// 暂时留空，如果需要可以进一步实现
	}

	/**
	 * 删除占位符文本块（备用方法，带重试机制）
	 */
	private async deletePlaceholderBlock(documentId: string, placeholderBlock: PlaceholderBlock): Promise<void> {
		const maxRetries = 3;
		let lastError: Error | null = null;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				// 添加延迟以避免频率限制
				if (attempt > 1) {
					const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 指数退避，最大5秒
					Debug.log(`⏱️ Waiting ${delay}ms before retry attempt ${attempt}...`);
					await new Promise(resolve => setTimeout(resolve, delay));
				}

				const requestData = {
					start_index: placeholderBlock.index,
					end_index: placeholderBlock.index + 1
				};

				Debug.log(`🗑️ Attempting to delete placeholder block (attempt ${attempt}/${maxRetries}): ${placeholderBlock.blockId}`);

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
				return; // 成功，退出重试循环

			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				Debug.warn(`⚠️ Delete attempt ${attempt} failed:`, lastError.message);

				// 如果是频率限制错误且还有重试机会，继续重试
				if (lastError.message.includes('429') && attempt < maxRetries) {
					Debug.log(`🔄 Rate limit hit, will retry (${attempt}/${maxRetries})...`);
					continue;
				}

				// 如果不是频率限制错误或已达到最大重试次数，抛出错误
				if (attempt === maxRetries) {
					Debug.error(`❌ All ${maxRetries} delete attempts failed for block ${placeholderBlock.blockId}`);
					throw lastError;
				}
			}
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
	 * 处理所有占位符：文件、图片和 Callout 块
	 */
	async processAllPlaceholders(documentId: string, localFiles: LocalFileInfo[], calloutBlocks?: CalloutInfo[], statusNotice?: Notice): Promise<void> {
		const totalItems = localFiles.length + (calloutBlocks?.length || 0);
		Debug.log(`🎯 Processing placeholders: ${localFiles.length} files + ${calloutBlocks?.length || 0} callouts = ${totalItems} total`);

		if (calloutBlocks && calloutBlocks.length > 0) {
			Debug.log('📋 Callout blocks to process:');
			calloutBlocks.forEach((callout, index) => {
				Debug.log(`  ${index + 1}: ${callout.type} - "${callout.title}" (placeholder: ${callout.placeholder})`);
			});
		}

		if (totalItems === 0) {
			Debug.log('📝 No placeholders to process');
			return;
		}

		try {
			if (statusNotice) {
				statusNotice.setMessage(`🔍 正在查找占位符 (${totalItems} 个项目)...`);
			}

			// 第一步：查找占位符文本块
			const placeholderBlocks = await this.findPlaceholderBlocks(documentId, localFiles, calloutBlocks);

			if (placeholderBlocks.length === 0) {
				Debug.warn('⚠️ No placeholder blocks found in document');
				return;
			}

			Debug.log(`🎯 Found ${placeholderBlocks.length} placeholder blocks to process`);

			// 分离不同类型的占位符
			const fileBlocks = placeholderBlocks.filter(block => block.fileInfo);
			const calloutPlaceholderBlocks = placeholderBlocks.filter(block => block.calloutInfo);

			// 第二步：处理 Callout 块（优先处理，因为不需要文件上传）
			if (calloutPlaceholderBlocks.length > 0) {
				// 为了防止插入时索引位移导致的顺序错乱：
				// 1) 先按父块分组并在每个父块内按 index 升序处理
				// 2) 针对同一父块，记录已插入数量，对后续插入做动态偏移
				const groupedByParent = new Map<string, typeof calloutPlaceholderBlocks>();
				for (const block of calloutPlaceholderBlocks) {
					const list = groupedByParent.get(block.parentId) || [];
					list.push(block);
					groupedByParent.set(block.parentId, list);
				}

				// 汇总排序后的队列（保持跨父块的稳定顺序：按 parentId 分组后依次处理，每组内按 index 升序）
				const sortedCalloutBlocks: typeof calloutPlaceholderBlocks = [];
				for (const [, list] of groupedByParent) {
					list.sort((a, b) => a.index - b.index);
					sortedCalloutBlocks.push(...list);
				}

				// 记录每个父块已插入的数量
				const insertedCountByParent = new Map<string, number>();
				if (statusNotice) {
					statusNotice.setMessage(`🎨 正在创建 ${calloutPlaceholderBlocks.length} 个高亮块...`);
				}

				const processedCalloutBlocks: PlaceholderBlock[] = [];

				for (let i = 0; i < sortedCalloutBlocks.length; i++) {
					const placeholderBlock = sortedCalloutBlocks[i];
					try {
						// 在每个 Callout 块创建之间添加延迟避免频率限制
						if (i > 0) {
							const delay = 1500; // 1.5秒延迟，确保不超过频率限制
							Debug.log(`⏱️ Waiting ${delay}ms between Callout block creations...`);
							await new Promise(resolve => setTimeout(resolve, delay));
						}

						// 动态调整插入索引：同一父块内，后续插入需要加上已插入数量的偏移
						const alreadyInserted = insertedCountByParent.get(placeholderBlock.parentId) || 0;
						const adjustedPlaceholderBlock: PlaceholderBlock = {
							...placeholderBlock,
							index: placeholderBlock.index + alreadyInserted
						};

						await this.insertCalloutBlock(documentId, adjustedPlaceholderBlock);
						processedCalloutBlocks.push(placeholderBlock);
						insertedCountByParent.set(placeholderBlock.parentId, alreadyInserted + 1);
						Debug.log(`✅ Successfully created Callout block: ${placeholderBlock.calloutInfo?.type}`);
					} catch (error) {
						Debug.error(`❌ Failed to create Callout block:`, error);
					}
				}

				// 删除成功创建的 Callout 占位符块
				if (processedCalloutBlocks.length > 0) {
					if (statusNotice) {
						statusNotice.setMessage(`🧹 正在清理 ${processedCalloutBlocks.length} 个占位符...`);
					}

					// 在删除操作前添加延迟，确保 Callout 创建完成
					const delay = 2000; // 增加到2秒延迟，确保创建完成
					Debug.log(`⏱️ Waiting ${delay}ms before deleting placeholders...`);
					await new Promise(resolve => setTimeout(resolve, delay));

					// 使用更精确的删除方法：直接删除包含占位符文本的块
					Debug.log(`🔍 Searching for placeholder text blocks to delete...`);

					for (const calloutInfo of calloutBlocks || []) {
						try {
							await this.deleteBlockByPlaceholderText(documentId, calloutInfo.placeholder);
						} catch (error) {
							Debug.error(`❌ Failed to delete placeholder for ${calloutInfo.placeholder}:`, error);
						}
					}
				}
			}

			// 第三步：处理文件块
			if (fileBlocks.length > 0) {
				await this.processFileBlocks(documentId, fileBlocks, statusNotice);
			}

		} catch (error) {
			Debug.error('Process all placeholders error:', error);
			throw error;
		}
	}

	/**
	 * 处理文件块（从原有逻辑提取）
	 */
	private async processFileBlocks(documentId: string, placeholderBlocks: PlaceholderBlock[], statusNotice?: Notice): Promise<void> {
		// 按照原始文件顺序排序占位符块
		const sortedPlaceholderBlocks = placeholderBlocks.filter(block => block.fileInfo);

		if (sortedPlaceholderBlocks.length === 0) {
			return;
		}

		// 并行读取所有文件内容
		if (statusNotice) {
			statusNotice.setMessage(`📖 正在并行读取 ${sortedPlaceholderBlocks.length} 个文件...`);
		}

		const fileReadPromises = sortedPlaceholderBlocks.map(async (placeholderBlock) => {
			try {
				const fileContent = await this.readLocalFile(placeholderBlock.fileInfo!.originalPath);
				return { placeholderBlock, fileContent, success: !!fileContent };
			} catch (error) {
				Debug.warn(`⚠️ Failed to read file: ${placeholderBlock.fileInfo!.originalPath}`, error);
				return { placeholderBlock, fileContent: null, success: false };
			}
		});

		const fileReadResults = await Promise.all(fileReadPromises);
		const validFiles = fileReadResults.filter(result => result.success);
		Debug.log(`📁 Successfully read ${validFiles.length}/${sortedPlaceholderBlocks.length} files`);

		// 串行处理文件上传（避免并发限制）
		const processedBlocks: PlaceholderBlock[] = [];
		for (let i = 0; i < validFiles.length; i++) {
			const { placeholderBlock, fileContent } = validFiles[i];
			const fileInfo = placeholderBlock.fileInfo!;

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

		// 批量替换占位符文本
		if (processedBlocks.length > 0) {
			if (statusNotice) {
				statusNotice.setMessage(`🔄 正在清理 ${processedBlocks.length} 个占位符...`);
			}
			await this.batchReplacePlaceholderText(documentId, processedBlocks);
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
					if (!placeholderBlock.fileInfo) {
						throw new Error('File info is missing');
					}
					const fileContent = await this.readLocalFile(placeholderBlock.fileInfo.originalPath);
					return { placeholderBlock, fileContent, success: !!fileContent };
				} catch (error) {
					Debug.warn(`⚠️ Failed to read file: ${placeholderBlock.fileInfo?.originalPath || 'unknown'}`, error);
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

				if (!fileInfo) {
					Debug.warn(`⚠️ Skipping file processing: fileInfo is missing`);
					continue;
				}

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
			const fileName = block.fileInfo?.fileName || block.calloutInfo?.type || 'unknown';
			Debug.log(`  ${index}: ${fileName} -> ${block.placeholder} (index: ${block.index})`);
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
			const nameA = a.fileInfo?.fileName || a.calloutInfo?.type || 'unknown';
			const nameB = b.fileInfo?.fileName || b.calloutInfo?.type || 'unknown';
			Debug.log(`🔄 Comparing: ${nameA}(order:${orderA}, index:${a.index}) vs ${nameB}(order:${orderB}, index:${b.index})`);

			// 如果localFiles顺序不同，使用localFiles顺序
			if (orderA !== orderB) {
				return orderA - orderB;
			}

			// 如果localFiles顺序相同，使用文档中的index
			return a.index - b.index;
		});

		Debug.log('📋 Sorted placeholder blocks:');
		sorted.forEach((block, index) => {
			const fileName = block.fileInfo?.fileName || block.calloutInfo?.type || 'unknown';
			Debug.log(`  ${index}: ${fileName} -> ${block.placeholder}`);
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
					this.settings.titleSource,
					this.settings.codeBlockFilterLanguages || []
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

				// 目标为知识库时，确保子文档也移动到知识库对应路径（未配置节点则根目录）
				try {
					if (this.settings.targetType === 'wiki' && this.settings.defaultWikiSpaceId) {
						// 获取子文档 token（新建为 subDocResult.documentToken；复用URL时从URL提取）
						let subDocToken = subDocResult.documentToken;
						if (!subDocToken && subDocResult.url) {
							subDocToken = this.extractDocumentIdFromUrl(subDocResult.url) || undefined;
						}
						if (subDocToken) {
							const targetNode = this.settings.defaultWikiNodeToken || undefined;
							Debug.log(`📚 Moving sub-document to wiki: space=${this.settings.defaultWikiSpaceId}, node=${targetNode || 'root'}`);
							await this.moveDocToWiki(
								this.settings.defaultWikiSpaceId,
								subDocToken,
								'docx',
								targetNode
							);
						}
					}
				} catch (moveError) {
					Debug.warn(`⚠️ Failed to move sub-document to wiki: ${subDoc.fileName}`, moveError);
					// 移动失败不影响主流程
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

				// 无论新建还是复用URL，都需要处理子文档内的 Callout 占位符替换
				try {
					const targetDocToken = subDocResult.documentToken || (subDocResult.url ? this.extractDocumentIdFromUrl(subDocResult.url) || undefined : undefined);
					if (targetDocToken && processResult.calloutBlocks && processResult.calloutBlocks.length > 0) {
						Debug.log(`🎨 Processing ${processResult.calloutBlocks.length} callouts in sub-document: ${subDoc.fileName}`);
						await this.processAllPlaceholders(
							targetDocToken,
							[], // 子文档文件已在上面处理，这里仅处理 callout
							processResult.calloutBlocks,
							statusNotice
						);
					}
				} catch (calloutError) {
					Debug.warn(`⚠️ Failed to process callouts in sub-document ${subDoc.fileName}:`, calloutError);
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

			const block = data.data?.block;
			if (!block) {
				Debug.error(`❌ No block data found for ${blockId}`);
				return null;
			}

			// 根据块类型获取相应的文本元素
			let elements: any[] = [];

			if (block.text && block.text.elements) {
				elements = block.text.elements;
			} else if (block.bullet && block.bullet.elements) {
				elements = block.bullet.elements;
			} else if (block.ordered && block.ordered.elements) {
				elements = block.ordered.elements;
			} else {
				Debug.warn(`⚠️ No text elements found in block ${blockId}, block type: ${block.block_type}`);
				return { elements: [] };
			}

			Debug.log(`📋 Retrieved ${elements.length} elements from block ${blockId}`);
			return { elements };

		} catch (error) {
			Debug.error(`❌ Error getting block content for ${blockId}:`, error);
			return null;
		}
	}

	/**
	 * 构建移除占位符的文本元素数组（保留其他文本）
	 */
	private buildTextElementsWithoutPlaceholder(originalElements: any[], targetPlaceholder: string): any[] {
		Debug.log(`🔧 Building text elements without placeholder: ${targetPlaceholder}`);
		const newElements: any[] = [];

		// 检查所有可能的占位符格式
		const cleanPlaceholder = targetPlaceholder.replace(/^__/, '').replace(/__$/, '');
		const possiblePlaceholders = [
			targetPlaceholder,                    // __OB_CONTENT_xxx__
			`!${cleanPlaceholder}!`,             // !OB_CONTENT_xxx!
			cleanPlaceholder,                    // OB_CONTENT_xxx
			`!${cleanPlaceholder}`,              // !OB_CONTENT_xxx (缺少结尾感叹号)
			`${cleanPlaceholder}!`               // OB_CONTENT_xxx! (缺少开头感叹号)
		];

		Debug.log(`🎯 Clean placeholder: ${cleanPlaceholder}`);
		Debug.log(`🔍 Possible placeholder formats:`, possiblePlaceholders);

		// 遍历原始元素，查找并移除占位符
		for (let i = 0; i < originalElements.length; i++) {
			const element = originalElements[i];
			if (element.text_run && element.text_run.content) {
				let content = element.text_run.content;
				let foundPlaceholder = false;

				Debug.log(`📝 Processing element ${i + 1}: "${content}"`);

				// 检查并移除所有可能的占位符格式
				for (const placeholder of possiblePlaceholders) {
					const placeholderIndex = content.indexOf(placeholder);
					if (placeholderIndex !== -1) {
						Debug.log(`✅ Found placeholder "${placeholder}" at position ${placeholderIndex}`);

						// 找到占位符，分割文本
						const beforePlaceholder = content.substring(0, placeholderIndex);
						const afterPlaceholder = content.substring(placeholderIndex + placeholder.length);

						Debug.log(`  Before: "${beforePlaceholder}"`);
						Debug.log(`  After: "${afterPlaceholder}"`);

						// 添加占位符前的文本
						if (beforePlaceholder.length > 0) {
							newElements.push({
								text_run: {
									content: beforePlaceholder,
									text_element_style: element.text_run.text_element_style
								}
							});
							Debug.log(`  ➕ Added before text: "${beforePlaceholder}"`);
						}

						// 添加占位符后的文本
						if (afterPlaceholder.length > 0) {
							// 特殊处理：检查是否只包含换行符和分隔符
							const trimmedAfter = afterPlaceholder.trim();
							Debug.log(`  🔍 After placeholder analysis: length=${afterPlaceholder.length}, trimmed="${trimmedAfter}"`);

							// 如果只是换行符开头的分隔符（如 "\n---"），需要特殊处理
							if (afterPlaceholder.startsWith('\n') && (trimmedAfter === '---' || trimmedAfter === '')) {
								Debug.log(`  ⚠️ Detected separator or empty content after newline, adjusting format`);
								// 移除开头的换行符，让分隔符单独成行
								const cleanContent = afterPlaceholder.replace(/^\n+/, '');
								if (cleanContent.length > 0) {
									newElements.push({
										text_run: {
											content: cleanContent,
											text_element_style: element.text_run.text_element_style
										}
									});
									Debug.log(`  ➕ Added cleaned after text: "${cleanContent}"`);
								}
							} else {
								newElements.push({
									text_run: {
										content: afterPlaceholder,
										text_element_style: element.text_run.text_element_style
									}
								});
								Debug.log(`  ➕ Added after text: "${afterPlaceholder}"`);
							}
						}

						foundPlaceholder = true;
						break; // 找到一个占位符就停止
					}
				}

				// 如果没有找到完整占位符，检查是否有残留的感叹号模式
				if (!foundPlaceholder) {
					// 检查是否只是残留的感叹号（如 "解决 !" 或单独的 "!"）
					const trimmedContent = content.trim();
					Debug.log(`🔍 No placeholder found, checking for residual exclamation: "${trimmedContent}"`);

					// 检查是否是单独的感叹号或以感叹号结尾的短文本
					if (trimmedContent === '!' || (trimmedContent.endsWith('!') && trimmedContent.length <= 10)) {
						Debug.log(`⚠️ Detected residual exclamation mark pattern`);

						if (trimmedContent === '!') {
							// 单独的感叹号，直接跳过（不添加到新元素中）
							Debug.log(`✅ Removed standalone exclamation mark`);
							foundPlaceholder = true;
						} else {
							// 以感叹号结尾的文本，移除感叹号
							const withoutExclamation = content.replace(/\s*!\s*$/, '');
							if (withoutExclamation.length > 0) {
								newElements.push({
									text_run: {
										content: withoutExclamation,
										text_element_style: element.text_run.text_element_style
									}
								});
								Debug.log(`✅ Removed trailing exclamation, new content: "${withoutExclamation}"`);
								foundPlaceholder = true;
							}
						}
					}
				}

				// 如果仍然没有找到占位符，保持原样
				if (!foundPlaceholder) {
					newElements.push(element);
					Debug.log(`❌ No placeholder or residual pattern found, keeping original: "${content}"`);
				}
			} else {
				// 非文本元素，保持原样
				newElements.push(element);
			}
		}

		// 如果所有元素都被清除了，添加一个空的文本元素
		if (newElements.length === 0) {
			Debug.log(`⚠️ All elements were removed, adding empty text element to prevent API error`);
			newElements.push({
				text_run: {
					content: '',
					text_element_style: {}
				}
			});
		}

		Debug.log(`🔄 Final result: ${newElements.length} elements`);
		newElements.forEach((element, index) => {
			if (element.text_run) {
				Debug.log(`  Final Element ${index + 1}: "${element.text_run.content}"`);
			}
		});

		return newElements;
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
		// 尝试访问文档，如果失败则尝试刷新Token后重试
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				Debug.log(`🔐 Checking document access: ${documentId}`);

				// 第一次尝试前，确保token有效
				if (attempt === 1) {
					const tokenValid = await this.ensureValidToken();
					if (!tokenValid) {
						return { hasAccess: false, error: 'Token无效，请重新授权', needsReauth: true };
					}
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
				} else if (this.isTokenExpiredError(data.code)) {
					// Token失效，如果是第一次尝试，则尝试刷新后重试
					if (attempt === 1) {
						const refreshSuccess = await this.refreshAccessToken();
						if (refreshSuccess) {
							continue; // 重试
						} else {
							return { hasAccess: false, error: 'Token已失效', needsReauth: true };
						}
					} else {
						// 第二次尝试仍然失败
						return { hasAccess: false, error: 'Token已失效', needsReauth: true };
					}
				} else {
					return { hasAccess: false, error: data.msg || '文档访问检查失败' };
				}

			} catch (error) {
				Debug.error(`Check document access error (attempt ${attempt}):`, error);

				// 检查是否是Token相关的错误
				const errorMessage = error instanceof Error ? error.message : '文档访问检查失败';
				const isTokenError = errorMessage.includes('401') ||
									errorMessage.includes('403') ||
									errorMessage.includes('Unauthorized') ||
									errorMessage.includes('status 401') ||
									errorMessage.includes('status 403');

				if (isTokenError && attempt === 1) {
					// 第一次尝试遇到Token错误，尝试刷新后重试
					const refreshSuccess = await this.refreshAccessToken();
					if (refreshSuccess) {
						continue; // 重试
					}
				}

				// 如果不是Token错误，或者是第二次尝试，或者刷新失败，则返回错误
				return {
					hasAccess: false,
					error: errorMessage,
					needsReauth: isTokenError
				};
			}
		}

		// 如果两次尝试都失败，返回默认错误
		return { hasAccess: false, error: '文档访问检查失败', needsReauth: true };
	}

	/**
	 * 将内容复制到目标文档
	 * @param sourceDocumentId 源文档ID
	 * @param targetDocumentId 目标文档ID
	 * @param localFiles 本地文件列表
	 * @param calloutBlocks Callout 块列表
	 * @returns 复制操作结果
	 */
	async copyContentToDocument(
		sourceDocumentId: string,
		targetDocumentId: string,
		localFiles: LocalFileInfo[],
		calloutBlocks?: CalloutInfo[]
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

			// 处理图片块（下载并重新上传）
			try {
				await this.processImageBlocksAfterCopy(
					sourceDocumentId,
					targetDocumentId,
					sourceBlocks
				);
			} catch (imageError) {
				Debug.error('❌ Failed to process image blocks:', imageError);
				// 不抛出错误，因为内容复制已经成功，图片处理失败不应该影响整体流程
			}

			// 处理占位符（仅 Callout 块；文件在后续独立流程处理，避免重复）
			const hasLocalFiles = false;
			const hasCalloutBlocks = calloutBlocks && calloutBlocks.length > 0;

			if (hasLocalFiles || hasCalloutBlocks) {
				Debug.log(`🎯 Processing placeholders after content copy: ${localFiles?.length || 0} files + ${calloutBlocks?.length || 0} callouts`);

				try {
					await this.processAllPlaceholders(
						targetDocumentId,
						[],
						calloutBlocks
					);
					Debug.log(`✅ Successfully processed all placeholders`);
				} catch (placeholderError) {
					Debug.error('❌ Failed to process placeholders:', placeholderError);
					// 不抛出错误，因为内容复制已经成功，占位符处理失败不应该影响整体流程
				}
			}

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
	 * 在复制完成后处理图片块
	 * 尝试从源文档的图片块中提取图片并重新上传到目标文档
	 */
	private async processImageBlocksAfterCopy(
		sourceDocumentId: string,
		targetDocumentId: string,
		sourceBlocks: any[]
	): Promise<void> {
		try {
			Debug.log(`🖼️ Processing image blocks after copy...`);

			// 获取目标文档的所有块
			const targetBlocks = await this.getAllDocumentBlocks(targetDocumentId);

			// 找到所有的图片块
			const imageBlocks = targetBlocks.filter(block => block.block_type === 27);

			if (imageBlocks.length === 0) {
				Debug.log('📄 No image blocks found in target document');
				return;
			}

			Debug.log(`🖼️ Found ${imageBlocks.length} image blocks to process`);

			// 创建源图片块的映射，用于查找对应的源token
			const sourceImageMap = new Map<number, string>();
			let sourceImageIndex = 0;

			// 遍历源文档块，收集图片token
			for (const sourceBlock of sourceBlocks) {
				if (sourceBlock.block_type === 27 && sourceBlock.image?.token) {
					sourceImageMap.set(sourceImageIndex, sourceBlock.image.token);
					sourceImageIndex++;
				}
			}

			// 对于每个图片块，尝试处理
			let targetImageIndex = 0;
			for (const imageBlock of imageBlocks) {
				try {
					// 检查图片块是否为空（没有token）
					if (!imageBlock.image?.token) {
						Debug.log(`🖼️ Processing empty image block: ${imageBlock.block_id}`);

						// 尝试从源图片块映射中获取对应的token
						const sourceToken = sourceImageMap.get(targetImageIndex);
						if (sourceToken) {
							Debug.log(`🔄 Found source token for image block ${imageBlock.block_id}: ${sourceToken}`);

							// 使用图片处理服务重新处理图片块
							const success = await this.imageProcessingService.reprocessImageBlock(
								targetDocumentId,
								imageBlock,
								sourceToken
							);

							if (success) {
								Debug.log(`✅ Successfully reprocessed image block ${imageBlock.block_id}`);
							} else {
								Debug.warn(`⚠️ Failed to reprocess image block ${imageBlock.block_id}`);
							}
						} else {
							Debug.warn(`⚠️ No source token found for image block ${imageBlock.block_id}`);
						}
					} else {
						Debug.log(`✅ Image block ${imageBlock.block_id} already has token: ${imageBlock.image.token}`);
					}

					targetImageIndex++;
				} catch (blockError) {
					Debug.error(`❌ Failed to process image block ${imageBlock.block_id}:`, blockError);
					// 继续处理其他图片块
					targetImageIndex++;
				}
			}

			Debug.log(`✅ Completed processing image blocks`);

		} catch (error) {
			Debug.error('❌ Failed to process image blocks after copy:', error);
			throw error;
		}
	}

	/**
	 * 复制块到目标文档（轻量化改造：支持批量嵌套复制）
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

			// 尝试批量嵌套复制，如果失败则回退到逐个复制
			const batchResult = await this.tryBatchNestedCopy(blockIds, blockMap, targetDocumentId, targetParentId);

			if (batchResult.success) {
				Debug.log(`✅ Successfully batch copied ${blockIds.length} blocks`);
				return { success: true };
			} else {
				Debug.warn(`⚠️ Batch copy failed, falling back to individual copy: ${batchResult.error}`);
				return await this.fallbackToIndividualCopy(blockIds, blockMap, targetDocumentId, targetParentId);
			}

		} catch (error) {
			Debug.error('Copy blocks to target error:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : '复制块到目标文档失败'
			};
		}
	}

	/**
	 * 尝试批量嵌套复制（支持智能分批）
	 */
	private async tryBatchNestedCopy(
		blockIds: string[],
		blockMap: Map<string, any>,
		targetDocumentId: string,
		targetParentId: string
	): Promise<{success: boolean, error?: string}> {
		try {
			// 构建嵌套块数据结构
			const nestedBlocks = this.buildNestedBlocksFromSource(blockIds, blockMap);

			if (nestedBlocks.length === 0) {
				return { success: true }; // 没有块需要复制
			}

			// 计算总块数
			const totalBlocks = this.countTotalBlocks(nestedBlocks);
			Debug.log(`📊 Total blocks to copy: ${totalBlocks} (root blocks: ${nestedBlocks.length})`);

			// 如果总块数超过1000，进行智能分批
			if (totalBlocks > 1000) {
				Debug.log(`📦 Block count exceeds 1000, splitting into batches...`);
				return await this.batchCopyInChunks(nestedBlocks, targetDocumentId, targetParentId);
			}

			// 单批次复制
			Debug.log(`🚀 Attempting single batch copy of ${nestedBlocks.length} root blocks (${totalBlocks} total blocks)`);
			return await this.executeSingleBatch(nestedBlocks, targetDocumentId, targetParentId);

		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : '批量嵌套复制失败'
			};
		}
	}

	/**
	 * 执行单批次复制
	 */
	private async executeSingleBatch(
		nestedBlocks: any[],
		targetDocumentId: string,
		targetParentId: string
	): Promise<{success: boolean, error?: string}> {
		try {
			Debug.log(`🚀 Attempting batch copy of ${nestedBlocks.length} blocks`);

			const response = await requestUrl({
				url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${targetDocumentId}/blocks/${targetParentId}/children`,
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.accessToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					children: nestedBlocks
				})
			});

			const data = response.json || JSON.parse(response.text);

			if (data.code !== 0) {
				Debug.error(`❌ Batch copy failed: ${data.msg}`);
				return {
					success: false,
					error: data.msg || '批量创建嵌套块失败'
				};
			}

			return { success: true };

		} catch (error) {
			Debug.error('❌ Single batch execution error:', error);

			// 尝试从错误中提取响应信息
			if (error && typeof error === 'object' && 'response' in error) {
				try {
					const response = (error as any).response;
					Debug.error('❌ Error response status:', response?.status);
					Debug.error('❌ Error response text:', response?.text);
				} catch (parseError) {
					Debug.error('❌ Failed to parse error response:', parseError);
				}
			}

			// 提供更详细的错误信息
			let errorMessage = '单批次复制失败';
			if (error instanceof Error) {
				errorMessage = error.message;
				if (error.message.includes('status 400')) {
					errorMessage += ' (可能是块数据格式问题或包含无效的图片块)';
				}
			}

			return {
				success: false,
				error: errorMessage
			};
		}
	}

	/**
	 * 智能分批复制（处理超过1000个块的情况）
	 */
	private async batchCopyInChunks(
		nestedBlocks: any[],
		targetDocumentId: string,
		targetParentId: string
	): Promise<{success: boolean, error?: string}> {
		try {
			const batches = this.splitBlocksIntoBatches(nestedBlocks, 800); // 使用800作为安全边界
			Debug.log(`📦 Split into ${batches.length} batches`);

			let currentParentId = targetParentId;

			for (let i = 0; i < batches.length; i++) {
				const batch = batches[i];
				const batchSize = this.countTotalBlocks(batch);

				Debug.log(`📦 Processing batch ${i + 1}/${batches.length} (${batchSize} blocks)`);

				// 执行当前批次
				const batchResult = await this.executeSingleBatch(batch, targetDocumentId, currentParentId);

				if (!batchResult.success) {
					return {
						success: false,
						error: `Batch ${i + 1} failed: ${batchResult.error}`
					};
				}

				// 添加批次间延迟，避免频率限制
				if (i < batches.length - 1) {
					const delay = 500; // 500ms延迟
					Debug.log(`⏱️ Waiting ${delay}ms between batches...`);
					await new Promise(resolve => setTimeout(resolve, delay));
				}
			}

			Debug.log(`✅ Successfully completed all ${batches.length} batches`);
			return { success: true };

		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : '分批复制失败'
			};
		}
	}

	/**
	 * 将块分割成批次（智能分割，保持块的完整性）
	 */
	private splitBlocksIntoBatches(blocks: any[], maxBlocksPerBatch: number): any[][] {
		const batches: any[][] = [];
		let currentBatch: any[] = [];
		let currentBatchSize = 0;

		for (const block of blocks) {
			const blockSize = this.countTotalBlocks([block]);

			// 如果单个块就超过限制，单独成批
			if (blockSize > maxBlocksPerBatch) {
				// 先保存当前批次（如果有内容）
				if (currentBatch.length > 0) {
					batches.push([...currentBatch]);
					currentBatch = [];
					currentBatchSize = 0;
				}

				// 单个大块独立成批
				batches.push([block]);
				continue;
			}

			// 检查加入当前块后是否超过限制
			if (currentBatchSize + blockSize > maxBlocksPerBatch && currentBatch.length > 0) {
				// 保存当前批次，开始新批次
				batches.push([...currentBatch]);
				currentBatch = [block];
				currentBatchSize = blockSize;
			} else {
				// 加入当前批次
				currentBatch.push(block);
				currentBatchSize += blockSize;
			}
		}

		// 保存最后一个批次
		if (currentBatch.length > 0) {
			batches.push(currentBatch);
		}

		return batches;
	}

	/**
	 * 回退到逐个复制（保持原有逻辑）
	 */
	private async fallbackToIndividualCopy(
		blockIds: string[],
		blockMap: Map<string, any>,
		targetDocumentId: string,
		targetParentId: string
	): Promise<{success: boolean, error?: string}> {
		try {
			Debug.log(`📋 Falling back to individual copy for ${blockIds.length} blocks`);

			// 按顺序复制每个块（原有逻辑）
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
			Debug.error('Fallback individual copy error:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : '逐个复制失败'
			};
		}
	}

	/**
	 * 从源块构建嵌套块数据结构
	 */
	private buildNestedBlocksFromSource(blockIds: string[], blockMap: Map<string, any>): any[] {
		const nestedBlocks: any[] = [];

		for (const blockId of blockIds) {
			const sourceBlock = blockMap.get(blockId);
			if (!sourceBlock) {
				Debug.warn(`⚠️ Source block not found: ${blockId}`);
				continue;
			}

			// 特殊处理：跳过空图片块（批量创建不支持）
			if (sourceBlock.block_type === 27 && (!sourceBlock.image || !sourceBlock.image.token)) {
				Debug.warn(`⚠️ Skipping empty image block in batch copy: ${sourceBlock.block_id}`);
				continue;
			}

			// 构建块数据（复用现有的buildBlockDataForCopy逻辑）
			const blockData = this.buildBlockDataForCopy(sourceBlock);

			// 递归处理子块
			if (sourceBlock.children && sourceBlock.children.length > 0) {
				blockData.children = this.buildNestedBlocksFromSource(sourceBlock.children, blockMap);
			}

			nestedBlocks.push(blockData);
		}

		return nestedBlocks;
	}

	/**
	 * 计算嵌套块结构中的总块数
	 */
	private countTotalBlocks(blocks: any[]): number {
		let count = 0;

		for (const block of blocks) {
			count++; // 当前块

			// 递归计算子块
			if (block.children && Array.isArray(block.children)) {
				count += this.countTotalBlocks(block.children);
			}
		}

		return count;
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
				// 应用频率控制
				await this.rateLimitController.throttle('block');

				// 特殊处理：如果是图片块且没有有效数据，跳过
				if (sourceBlock.block_type === 27 && (!sourceBlock.image || !sourceBlock.image.token)) {
					Debug.warn(`⚠️ Skipping empty image block: ${sourceBlock.block_id}`);
					return; // 直接跳过，不报错
				}

				// 构建块创建请求数据
				const blockData = this.buildBlockDataForCopy(sourceBlock);

				const requestData = {
					children: [blockData]
				};

				// 添加详细的调试信息
				if (sourceBlock.block_type === 27) {
					Debug.log(`🖼️ Image block copy request data:`, JSON.stringify(requestData, null, 2));
					Debug.log(`🖼️ Original image block:`, JSON.stringify(sourceBlock, null, 2));
				}

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

				let response;
				try {
					response = await requestUrl({
						url: `${FEISHU_CONFIG.BASE_URL}/docx/v1/documents/${targetDocumentId}/blocks/${targetParentId}/children`,
						method: 'POST',
						headers: {
							'Authorization': `Bearer ${this.settings.accessToken}`,
							'Content-Type': 'application/json'
						},
						body: JSON.stringify(requestData)
					});

					// 添加详细的响应信息
					if (sourceBlock.block_type === 27) {
						Debug.log(`🖼️ Image block API response status: ${response.status}`);
						Debug.log(`🖼️ Image block API response:`, response.json || response.text);
					}
				} catch (requestError) {
					// 捕获请求错误并尝试获取响应内容
					if (sourceBlock.block_type === 27) {
						Debug.log(`🖼️ Image block request failed:`, requestError);
						Debug.log(`🖼️ Error message:`, requestError.message);
						Debug.log(`🖼️ Error status:`, requestError.status);

						// 尝试从不同属性获取响应内容
						if (requestError.response) {
							Debug.log(`🖼️ Error response:`, requestError.response);
						}
						if (requestError.json) {
							Debug.log(`🖼️ Error json:`, requestError.json);
						}
						if (requestError.text) {
							Debug.log(`🖼️ Error text:`, requestError.text);
						}
						if (requestError.data) {
							Debug.log(`🖼️ Error data:`, requestError.data);
						}
					}
					throw requestError;
				}

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
						// 如果是图片块错误，记录警告但不中断流程
						if (sourceBlock.block_type === 27) {
							Debug.warn(`⚠️ Image block copy failed due to rate limit, continuing...`);
							return; // 不抛出错误，继续流程
						}
						throw new Error(`API频率限制，重试${maxRetries}次后仍失败: ${error.message}`);
					}
					// 继续重试
				} else {
					// 其他错误处理
					Debug.error('Copy individual block error:', error);

					// 添加详细的错误信息捕获
					if (sourceBlock.block_type === 27) {
						Debug.log(`🖼️ Image block API error details:`, error);
						// 尝试从不同的错误对象中获取响应信息
						if (error.response) {
							Debug.log(`🖼️ Error response status:`, error.response.status);
							Debug.log(`🖼️ Error response data:`, error.response.data);
						} else if (error.json) {
							Debug.log(`🖼️ Error json:`, error.json);
						} else if (error.text) {
							Debug.log(`🖼️ Error text:`, error.text);
						}
					}

					if (retryCount >= maxRetries) {
						// 如果是图片块错误，记录警告但不中断流程
						if (sourceBlock.block_type === 27) {
							Debug.warn(`⚠️ Image block copy failed after ${maxRetries} attempts, continuing...`);
							return; // 不抛出错误，继续流程
						}
						throw error;
					}

					// 指数退避重试
					const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 5000);
					await new Promise(resolve => setTimeout(resolve, delay));
				}
			}
		}
	}

	/**
	 * 构建用于复制的块数据
	 * @param sourceBlock 源块数据
	 * @param processResult 可选的处理结果，用于图片处理
	 * @returns 用于创建的块数据
	 */
	private buildBlockDataForCopy(sourceBlock: any, processResult?: MarkdownProcessResult): any {
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

			case 22: // ISV块或其他特殊块
				// 尝试保持原始结构，如果有文本内容则保留
				if (sourceBlock.text) {
					return {
						block_type: 2, // 转为文本块但保留内容
						text: sourceBlock.text
					};
				}
				return {
					block_type: blockType, // 保持原始类型
					...sourceBlock
				};

			case 27: // 图片块
				return this.buildImageBlockData(sourceBlock, processResult);

			case 33: // View块（文件块容器）
				return {
					block_type: 33,
					view: sourceBlock.view || {}
				};

			default:
				// 对于其他类型的块，尝试保持原始结构并保留文本内容
				Debug.warn(`⚠️ Unsupported block type for copy: ${blockType}`);

				// 如果有文本内容，保留文本内容
				if (sourceBlock.text) {
					return {
						block_type: 2, // 转为文本块但保留内容
						text: sourceBlock.text
					};
				}

				// 否则尝试保持原始结构
				return {
					block_type: blockType,
					...sourceBlock
				};
		}
	}

	/**
	 * 构建图片块数据
	 * @param sourceBlock 源图片块
	 * @param processResult 处理结果，包含本地文件信息
	 * @returns 图片块数据或占位符文本块
	 */
	private buildImageBlockData(sourceBlock: any, processResult?: MarkdownProcessResult): any {
		// 对于跨文档复制的图片块，我们需要重新处理
		// 暂时创建占位符，后续在复制完成后进行图片处理
		if (sourceBlock.image?.token) {
			// 这是一个来自其他文档的图片块，token无法跨文档使用
			// 创建空图片块，后续通过图片处理服务填充
			return {
				block_type: 27,
				image: {
					width: sourceBlock.image?.width || 100,
					height: sourceBlock.image?.height || 100,
					align: sourceBlock.image?.align || 1
				}
			};
		} else {
			// 转换为图片占位符文本块
			return this.imageProcessingService.createImagePlaceholderBlock(sourceBlock);
		}
	}

	/**
	 * 查找图片块对应的本地文件信息
	 * @param sourceBlock 源图片块
	 * @param processResult 处理结果
	 * @returns 本地文件信息或null
	 */
	private findLocalFileForImageBlock(sourceBlock: any, processResult?: MarkdownProcessResult): LocalFileInfo | null {
		if (!processResult || !processResult.localFiles) {
			return null;
		}

		// 通过图片token或其他标识符查找对应的本地文件
		// 这里需要根据实际的数据结构来实现匹配逻辑
		const imageToken = sourceBlock.image?.token;
		if (!imageToken) {
			return null;
		}

		// 查找匹配的本地文件
		return processResult.localFiles.find(file =>
			file.isImage && (
				file.placeholder.includes(imageToken) ||
				file.fileName.includes(imageToken) ||
				// 可以添加更多匹配逻辑
				false
			)
		) || null;
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
		let tempSourceFileToken: string | null = null; // 临时文档的源文件token
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

			// 4. 创建临时文档用于导入新内容（不处理文件，保留占位符）
			if (statusNotice) {
				statusNotice.setMessage('📄 正在创建临时文档...');
			}

			// 创建不包含文件的processResult，保留占位符
			const tempProcessResult: MarkdownProcessResult = {
				content: processResult.content,
				localFiles: [], // 不处理文件，保留占位符
				frontMatter: processResult.frontMatter,
				extractedTitle: processResult.extractedTitle
			};

			// 对于更新操作，临时文档始终在云空间创建（避免知识库中的临时文档无法删除）
			const tempResult = await this.shareToDrive(title + '_temp', tempProcessResult, statusNotice, true);
			if (!tempResult.success) {
				throw new Error(tempResult.error || '创建临时文档失败');
			}

			// 5. 提取临时文档ID和源文件token
			tempDocumentId = this.extractDocumentIdFromUrl(tempResult.url!);
			if (!tempDocumentId) {
				throw new Error('无法从临时文档URL中提取文档ID');
			}

			// 保存临时文档的源文件token，用于后续清理
			tempSourceFileToken = tempResult.sourceFileToken || null;

			Debug.log(`✅ Temporary document created: ${tempDocumentId}`);
			if (tempSourceFileToken) {
				Debug.log(`📝 Temporary source file token saved: ${tempSourceFileToken}`);
			}

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
				[],
				processResult.calloutBlocks
			);

			if (!copyResult.success) {
				throw new Error(copyResult.error || '复制内容失败');
			}

			// 8. 处理子文档和文件上传（如果有本地文件）
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
						await this.processSubDocuments(documentId, subDocuments, statusNotice);
					}

					// 再处理普通文件上传
					if (regularFiles.length > 0) {
						if (statusNotice) {
							statusNotice.setMessage(`📎 正在处理 ${regularFiles.length} 个附件...`);
						}
						await this.processFileUploads(documentId, regularFiles, statusNotice);
					}
				} catch (fileError) {
					Debug.warn('⚠️ File upload failed, but document content was updated:', fileError);
					// 文件上传失败不影响主要内容更新
				}
			}

			// 9. 删除临时文档和源文件
			try {
				if (statusNotice) {
					statusNotice.setMessage('🗑️ 正在清理临时文档...');
				}

				// 先删除临时文档
				await this.deleteDocument(tempDocumentId);
				tempDocumentId = null; // 标记已删除
				Debug.log('✅ Temporary document deleted successfully');

				// 临时文档的源文件已在shareMarkdownWithFiles中处理，无需重复删除
				Debug.log('📝 Temporary source file handled by shareMarkdownWithFiles, no additional deletion needed');
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
			await this.handleUpdateError(error, documentId, tempDocumentId, tempSourceFileToken, originalContentBackup, title, statusNotice);

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
	 * @param tempSourceFileToken 临时文档源文件token
	 * @param originalContentBackup 原始内容备份
	 * @param title 文档标题（用于构建临时文件名）
	 * @param statusNotice 状态通知
	 */
	private async handleUpdateError(
		error: any,
		documentId: string | null,
		tempDocumentId: string | null,
		tempSourceFileToken: string | null,
		originalContentBackup: any[] | null,
		title: string,
		statusNotice?: Notice
	): Promise<void> {
		try {
			Debug.log('🔄 Starting error handling and rollback process...');

			// 1. 清理临时文档和源文件
			if (tempDocumentId) {
				try {
					if (statusNotice) {
						statusNotice.setMessage('🗑️ 正在清理临时文档...');
					}

					// 先删除临时文档
					await this.deleteDocument(tempDocumentId);
					Debug.log('✅ Temporary document cleaned up');

					// 临时文档的源文件已在shareMarkdownWithFiles中处理，无需重复删除
					Debug.log('📝 Temporary source file handled by shareMarkdownWithFiles, no additional cleanup needed');
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
