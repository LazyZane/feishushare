/**
 * 飞书分享插件类型定义
 */

/**
 * 文档标题来源选项
 */
export type TitleSource = 'filename' | 'frontmatter';

/**
 * Front Matter 处理方式选项
 */
export type FrontMatterHandling = 'remove' | 'keep-as-code';

/**
 * 链接分享权限类型
 */
export type LinkSharePermission = 'tenant_readable' | 'tenant_editable' | 'anyone_readable' | 'anyone_editable';

export interface FeishuSettings {
	appId: string;
	appSecret: string;
	callbackUrl: string;
	accessToken: string;
	refreshToken: string;
	userInfo: FeishuUserInfo | null;
	defaultFolderId: string;
	defaultFolderName: string;
	titleSource: TitleSource;
	frontMatterHandling: FrontMatterHandling;
	// 新增：链接分享设置
	enableLinkShare: boolean;
	linkSharePermission: LinkSharePermission;
	// 新增：内容处理设置
	enableSubDocumentUpload: boolean;
	enableLocalImageUpload: boolean;
	enableLocalAttachmentUpload: boolean;
	// 新增：分享标记设置
	enableShareMarkInFrontMatter: boolean;
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
	isSubDocument?: boolean;  // 新增：标识是否为子文档（双链引用的md文件）
	altText?: string;
}

/**
 * Front Matter 解析结果
 */
export interface FrontMatterData {
	title?: string;
	[key: string]: any;
}

/**
 * Markdown处理结果
 */
export interface MarkdownProcessResult {
	content: string;
	localFiles: LocalFileInfo[];
	frontMatter: FrontMatterData | null;
	extractedTitle: string | null;
}

/**
 * 子文档处理结果
 */
export interface SubDocumentResult {
	success: boolean;
	documentToken?: string;
	url?: string;
	title?: string;
	error?: string;
}

/**
 * 处理上下文（用于控制递归深度和防止循环引用）
 */
export interface ProcessContext {
	maxDepth: number;
	currentDepth: number;
	processedFiles: Set<string>; // 防止循环引用
	parentDocumentId?: string;   // 父文档ID，用于建立关联
	// 内容处理设置
	enableSubDocumentUpload?: boolean;
	enableLocalImageUpload?: boolean;
	enableLocalAttachmentUpload?: boolean;
	// Front Matter 处理设置
	frontMatterHandling?: 'remove' | 'keep-as-code';
	titleSource?: 'filename' | 'frontmatter';
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
