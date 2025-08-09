import { App, Modal, Notice } from 'obsidian';
import { FeishuApiService } from './feishu-api';

export interface FeishuFolder {
	folder_token?: string; // 兼容旧版本
	token?: string;        // API实际返回的属性名
	name: string;
	type: string;
	parent_token?: string;
}

export interface FeishuFolderListResponse {
	code: number;
	msg: string;
	data: {
		folders: FeishuFolder[];
		has_more: boolean;
		next_page_token?: string;
	};
}

/**
 * 文件夹选择模态框
 */
export class FolderSelectModal extends Modal {
	private feishuApi: FeishuApiService;
	private onSelect: (folder: FeishuFolder | null) => void;
	private folders: FeishuFolder[] = [];
	private currentPath: FeishuFolder[] = [];
	private loading = false;

	constructor(
		app: App,
		feishuApi: FeishuApiService,
		onSelect: (folder: FeishuFolder | null) => void
	) {
		super(app);
		this.feishuApi = feishuApi;
		this.onSelect = onSelect;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		// 设置模态框标题
		contentEl.createEl('h2', { text: '选择文件夹' });

		// 创建面包屑导航
		this.createBreadcrumb(contentEl);

		// 创建文件夹列表容器
		const listContainer = contentEl.createDiv('folder-list-container');
		listContainer.style.cssText = `
			max-height: 400px;
			overflow-y: auto;
			border: 1px solid var(--background-modifier-border);
			border-radius: 8px;
			margin: 16px 0;
		`;

		// 创建按钮容器
		const buttonContainer = contentEl.createDiv('button-container');
		buttonContainer.style.cssText = `
			display: flex;
			justify-content: space-between;
			margin-top: 16px;
		`;

		// 选择当前文件夹按钮
		const selectButton = buttonContainer.createEl('button', {
			text: '选择当前文件夹',
			cls: 'mod-cta'
		});
		selectButton.onclick = () => {
			const currentFolder = this.currentPath.length > 0 
				? this.currentPath[this.currentPath.length - 1] 
				: null;
			this.onSelect(currentFolder);
			this.close();
		};

		// 取消按钮
		const cancelButton = buttonContainer.createEl('button', {
			text: '取消'
		});
		cancelButton.onclick = () => {
			this.close();
		};

		// 加载初始文件夹列表
		this.loadFolders(listContainer);
	}

	/**
	 * 创建面包屑导航
	 */
	private createBreadcrumb(containerEl: HTMLElement) {
		const breadcrumbEl = containerEl.createDiv('folder-breadcrumb');
		breadcrumbEl.style.cssText = `
			display: flex;
			align-items: center;
			gap: 8px;
			margin: 16px 0;
			padding: 8px 12px;
			background: var(--background-secondary);
			border-radius: 6px;
			font-size: 14px;
		`;

		// 根目录
		const rootEl = breadcrumbEl.createSpan('breadcrumb-item');
		rootEl.textContent = '我的空间';
		rootEl.style.cssText = `
			cursor: pointer;
			color: var(--text-accent);
			text-decoration: underline;
		`;
		rootEl.onclick = () => this.navigateToRoot();

		// 路径中的文件夹
		this.currentPath.forEach((folder, index) => {
			// 分隔符
			breadcrumbEl.createSpan('breadcrumb-separator').textContent = ' / ';

			// 文件夹名
			const folderEl = breadcrumbEl.createSpan('breadcrumb-item');
			folderEl.textContent = folder.name;
			
			if (index < this.currentPath.length - 1) {
				// 不是最后一个，可以点击
				folderEl.style.cssText = `
					cursor: pointer;
					color: var(--text-accent);
					text-decoration: underline;
				`;
				folderEl.onclick = () => this.navigateToFolder(index);
			} else {
				// 最后一个，当前位置
				folderEl.style.cssText = `
					font-weight: bold;
					color: var(--text-normal);
				`;
			}
		});
	}

	/**
	 * 加载文件夹列表
	 */
	private async loadFolders(containerEl: HTMLElement) {
		if (this.loading) return;

		this.loading = true;
		containerEl.empty();

		// 显示加载状态
		const loadingEl = containerEl.createDiv('loading-indicator');
		loadingEl.textContent = '正在加载文件夹...';
		loadingEl.style.cssText = `
			text-align: center;
			padding: 20px;
			color: var(--text-muted);
		`;

		try {
			const parentFolderId = this.currentPath.length > 0
				? (this.currentPath[this.currentPath.length - 1].folder_token || this.currentPath[this.currentPath.length - 1].token)
				: undefined;

			const response = await this.feishuApi.getFolderList(parentFolderId);
			this.folders = response.data.folders;

			// 清除加载状态
			containerEl.empty();

			// 显示文件夹列表
			this.renderFolderList(containerEl);

		} catch (error) {
			console.error('Failed to load folders:', error);
			containerEl.empty();
			
			const errorEl = containerEl.createDiv('error-message');
			errorEl.textContent = `加载失败: ${error.message}`;
			errorEl.style.cssText = `
				text-align: center;
				padding: 20px;
				color: var(--text-error);
			`;
		} finally {
			this.loading = false;
		}
	}

	/**
	 * 渲染文件夹列表
	 */
	private renderFolderList(containerEl: HTMLElement) {
		if (this.folders.length === 0) {
			const emptyEl = containerEl.createDiv('empty-message');
			emptyEl.textContent = '此文件夹为空';
			emptyEl.style.cssText = `
				text-align: center;
				padding: 20px;
				color: var(--text-muted);
			`;
			return;
		}

		this.folders.forEach(folder => {
			const folderEl = containerEl.createDiv('folder-item');
			folderEl.style.cssText = `
				display: flex;
				align-items: center;
				padding: 12px 16px;
				cursor: pointer;
				border-bottom: 1px solid var(--background-modifier-border);
				transition: background-color 0.2s;
			`;

			// 文件夹图标
			const iconEl = folderEl.createSpan('folder-icon');
			iconEl.textContent = '📁';
			iconEl.style.cssText = `
				margin-right: 12px;
				font-size: 16px;
			`;

			// 文件夹名称
			const nameEl = folderEl.createSpan('folder-name');
			nameEl.textContent = folder.name;
			nameEl.style.cssText = `
				flex: 1;
				font-size: 14px;
			`;

			// 悬停效果
			folderEl.onmouseenter = () => {
				folderEl.style.backgroundColor = 'var(--background-modifier-hover)';
			};
			folderEl.onmouseleave = () => {
				folderEl.style.backgroundColor = '';
			};

			// 点击进入文件夹
			folderEl.onclick = () => {
				this.enterFolder(folder);
			};
		});
	}

	/**
	 * 进入文件夹
	 */
	private async enterFolder(folder: FeishuFolder) {
		// 检查是否已经在当前路径中，避免重复添加
		const existingIndex = this.currentPath.findIndex(f =>
			(f.folder_token || f.token) === (folder.folder_token || folder.token)
		);

		if (existingIndex >= 0) {
			// 如果文件夹已存在，截断到该位置
			this.currentPath = this.currentPath.slice(0, existingIndex + 1);
		} else {
			// 如果文件夹不存在，添加到路径末尾
			this.currentPath.push(folder);
		}

		// 重新创建面包屑
		const breadcrumbEl = this.contentEl.querySelector('.folder-breadcrumb');
		if (breadcrumbEl) {
			breadcrumbEl.remove();
			this.createBreadcrumb(this.contentEl);
		}

		// 重新加载文件夹列表
		const listContainer = this.contentEl.querySelector('.folder-list-container') as HTMLElement;
		if (listContainer) {
			await this.loadFolders(listContainer);
		}
	}

	/**
	 * 导航到根目录
	 */
	private async navigateToRoot() {
		this.currentPath = [];
		
		// 重新创建面包屑
		const breadcrumbEl = this.contentEl.querySelector('.folder-breadcrumb');
		if (breadcrumbEl) {
			breadcrumbEl.remove();
			this.createBreadcrumb(this.contentEl);
		}

		// 重新加载文件夹列表
		const listContainer = this.contentEl.querySelector('.folder-list-container') as HTMLElement;
		if (listContainer) {
			await this.loadFolders(listContainer);
		}
	}

	/**
	 * 导航到指定层级的文件夹
	 */
	private async navigateToFolder(index: number) {
		this.currentPath = this.currentPath.slice(0, index + 1);
		
		// 重新创建面包屑
		const breadcrumbEl = this.contentEl.querySelector('.folder-breadcrumb');
		if (breadcrumbEl) {
			breadcrumbEl.remove();
			this.createBreadcrumb(this.contentEl);
		}

		// 重新加载文件夹列表
		const listContainer = this.contentEl.querySelector('.folder-list-container') as HTMLElement;
		if (listContainer) {
			await this.loadFolders(listContainer);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
