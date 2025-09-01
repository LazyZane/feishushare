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

/**
 * 目标类型：云空间或知识库
 */
export type TargetType = 'drive' | 'wiki';

/**
 * 知识库空间信息
 */
export interface WikiSpace {
	space_id: string;
	name: string;
	description?: string;
	space_type: string;
	visibility: string;
}

/**
 * 知识库节点信息
 */
export interface WikiNode {
	space_id: string;
	node_token: string;
	obj_token: string;
	obj_type: string;
	parent_node_token?: string;
	title: string;
	has_child: boolean;
	node_type?: string;
	creator?: string;
	owner?: string;
}

export interface FeishuSettings {
	appId: string;
	appSecret: string;
	callbackUrl: string;
	accessToken: string;
	refreshToken: string;
	userInfo: FeishuUserInfo | null;

	// 新增：目标类型选择
	targetType: TargetType;

	// 云空间设置（原有）
	defaultFolderId: string;
	defaultFolderName: string;

	// 知识库设置（新增）
	defaultWikiSpaceId: string;
	defaultWikiSpaceName: string;
	defaultWikiNodeToken: string;
	defaultWikiNodeName: string;

	titleSource: TitleSource;
	frontMatterHandling: FrontMatterHandling;
	// 新增：链接分享设置
	enableLinkShare: boolean;
	linkSharePermission: LinkSharePermission;
	// 新增：内容处理设置
	enableSubDocumentUpload: boolean;
	enableLocalImageUpload: boolean;
	enableLocalAttachmentUpload: boolean;
	// 新增：代码块过滤（多选，命中则移除）
	codeBlockFilterLanguages: string[];
	// 新增：分享标记设置
	enableShareMarkInFrontMatter: boolean;
	// 新增：通知抑制设置（取消分享状态通知）
	suppressShareNotices: boolean;
	// 新增：简洁成功通知（仅一行提示）
	simpleSuccessNotice: boolean;
}

export interface FeishuUserInfo {
	name: string;
	avatar_url: string;
	email: string;
	user_id: string;
}

export interface FeishuOAuthResponse {
	code: number;
	msg?: string;
	// v1 API格式
	data?: {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		token_type: string;
	};
	// v2 API格式（直接在根级别）
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	token_type?: string;
	// v2 API错误格式
	error?: string;
	error_description?: string;
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
	sourceFileToken?: string; // 源文件token，用于临时文档清理
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
 * 知识库空间列表响应
 */
export interface WikiSpaceListResponse {
	code: number;
	msg: string;
	data: {
		items: WikiSpace[];
		page_token?: string;
		has_more: boolean;
	};
}

/**
 * 知识库节点列表响应
 */
export interface WikiNodeListResponse {
	code: number;
	msg: string;
	data: {
		items: WikiNode[];
		page_token?: string;
		has_more: boolean;
	};
}

/**
 * 移动文档到知识库响应
 */
export interface MoveDocToWikiResponse {
	code: number;
	msg: string;
	data: {
		wiki_token?: string;
		task_id?: string;
		applied?: boolean;
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
	isCallout?: boolean;      // 新增：标识是否为 Callout 块
	altText?: string;
}

/**
 * Callout 块信息
 */
export interface CalloutInfo {
	placeholder: string;
	type: string;
	title: string;
	content: string;
	foldable: boolean;
	backgroundColor?: number; // 1-15，对应飞书高亮块背景色
	borderColor?: number;     // 1-7，对应飞书高亮块边框色
	textColor?: number;       // 1-7，对应飞书高亮块文字颜色
	emojiId?: string;         // 表情图标
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
	calloutBlocks?: CalloutInfo[];  // 新增：Callout 块信息
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
	// 代码块过滤设置：命中语言则移除对应 fenced code block
	codeBlockFilterLanguages?: string[];
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
	fileInfo?: LocalFileInfo;     // 文件信息（可选，用于文件/图片）
	calloutInfo?: CalloutInfo;    // Callout 信息（可选，用于 Callout 块）
}
