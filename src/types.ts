/**
 * 飞书分享插件类型定义
 */

export interface FeishuSettings {
	appId: string;
	appSecret: string;
	callbackUrl: string;
	accessToken: string;
	refreshToken: string;
	userInfo: FeishuUserInfo | null;
	defaultFolderId: string;
	defaultFolderName: string;
}

export interface FeishuUserInfo {
	name: string;
	avatar_url: string;
	email: string;
	user_id: string;
}

export interface FeishuOAuthResponse {
	code: number;
	msg: string;
	data: {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		token_type: string;
	};
}

export interface FeishuApiError {
	code: number;
	msg: string;
}

export interface ShareResult {
	success: boolean;
	url?: string;
	title?: string;
	error?: string;
}

export interface FeishuFileUploadResponse {
	code: number;
	msg: string;
	data: {
		file_token: string;
	};
}

export interface FeishuDocCreateResponse {
	code: number;
	msg: string;
	data: {
		document: {
			document_id: string;
			revision_id: number;
			title: string;
		};
	};
}

export interface FeishuFolderListResponse {
	code: number;
	msg: string;
	data: {
		files: Array<{
			token: string;
			name: string;
			type: string;
			parent_token: string;
			url: string;
			created_time: string;
			modified_time: string;
		}>;
		has_more: boolean;
		page_token: string;
	};
}

/**
 * 本地文件信息
 */
export interface LocalFileInfo {
	originalPath: string;
	fileName: string;
	placeholder: string;
	isImage: boolean;
	altText?: string;
}

/**
 * Markdown处理结果
 */
export interface MarkdownProcessResult {
	content: string;
	localFiles: LocalFileInfo[];
}

/**
 * 飞书文档块响应
 */
export interface FeishuDocBlocksResponse {
	code: number;
	msg: string;
	data: {
		items: Array<{
			block_id: string;
			block_type: number;
			parent_id: string;
			children: string[];
			text?: {
				elements: Array<{
					text_run?: {
						content: string;
					};
				}>;
			};
		}>;
		has_more: boolean;
		page_token: string;
	};
}

/**
 * 飞书块创建响应
 */
export interface FeishuBlockCreateResponse {
	code: number;
	msg: string;
	data: {
		children: Array<{
			block_id: string;
			block_type: number;
			children?: string[];
		}>;
	};
}

/**
 * 占位符块信息
 */
export interface PlaceholderBlock {
	blockId: string;
	parentId: string;
	index: number;
	placeholder: string;
	fileInfo: LocalFileInfo;
}
