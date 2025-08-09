/**
 * 飞书API配置常量
 */

export const FEISHU_CONFIG = {
	// API 基础地址
	BASE_URL: 'https://open.feishu.cn/open-apis',
	
	// OAuth 相关地址
	AUTHORIZE_URL: 'https://open.feishu.cn/open-apis/authen/v1/authorize',
	TOKEN_URL: 'https://open.feishu.cn/open-apis/authen/v1/access_token',
	REFRESH_TOKEN_URL: 'https://open.feishu.cn/open-apis/authen/v1/refresh_access_token',
	
	// API 权限范围
	SCOPES: 'contact:user.base:readonly docx:document drive:drive',
	
	// 文件上传相关
	UPLOAD_URL: 'https://open.feishu.cn/open-apis/drive/v1/files/upload_all',
	
	// 文档创建相关
	DOC_CREATE_URL: 'https://open.feishu.cn/open-apis/docx/v1/documents',
	
	// 文件夹相关
	FOLDER_LIST_URL: 'https://open.feishu.cn/open-apis/drive/v1/files',
	
	// 用户信息
	USER_INFO_URL: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
};

export const DEFAULT_SETTINGS: Partial<FeishuSettings> = {
	appId: '',
	appSecret: '',
	callbackUrl: 'https://md2feishu.xinqi.life/oauth-callback',
	accessToken: '',
	refreshToken: '',
	userInfo: null,
	defaultFolderId: '',
	defaultFolderName: '我的空间',
};

export const FEISHU_ERROR_MESSAGES: Record<number, string> = {
	1061002: '参数错误，请检查文件格式和大小',
	1061005: '文件大小超出限制',
	1061006: '文件类型不支持',
	99991663: 'access_token 无效',
	99991664: 'access_token 已过期',
	99991665: 'refresh_token 无效',
	99991666: 'refresh_token 已过期',
};

import type { FeishuSettings } from './types';
