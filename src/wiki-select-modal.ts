import { App, Modal, Notice } from 'obsidian';
import { FeishuApiService } from './feishu-api';
import { WikiSpace, WikiNode } from './types';

/**
 * 知识库选择模态框
 */
export class WikiSelectModal extends Modal {
	private feishuApi: FeishuApiService;
	private onSelect: (space: WikiSpace | null, node: WikiNode | null) => void;
	private spaces: WikiSpace[] = [];
	private nodes: WikiNode[] = [];
	private currentSpace: WikiSpace | null = null;
	private currentPath: WikiNode[] = [];
	private loading = false;
	private mode: 'space' | 'node' = 'space';

	constructor(
		app: App,
		feishuApi: FeishuApiService,
		onSelect: (space: WikiSpace | null, node: WikiNode | null) => void
	) {
		super(app);
		this.feishuApi = feishuApi;
		this.onSelect = onSelect;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		// 设置模态框标题
		contentEl.createEl('h2', { text: '选择知识库位置' });

		// 创建导航区域
		this.createNavigation(contentEl);

		// 创建列表容器
		const listContainer = contentEl.createDiv('wiki-list-container');
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

		// 选择当前位置按钮
		const selectButton = buttonContainer.createEl('button', {
			text: '选择当前位置',
			cls: 'mod-cta'
		});
		selectButton.onclick = () => {
			const currentNode = this.currentPath.length > 0 
				? this.currentPath[this.currentPath.length - 1] 
				: null;
			this.onSelect(this.currentSpace, currentNode);
			this.close();
		};

		// 取消按钮
		const cancelButton = buttonContainer.createEl('button', {
			text: '取消'
		});
		cancelButton.onclick = () => {
			this.close();
		};

		// 加载初始数据
		this.loadSpaces(listContainer);
	}

	/**
	 * 创建导航区域
	 */
	private createNavigation(containerEl: HTMLElement) {
		const navEl = containerEl.createDiv('wiki-navigation');
		navEl.style.cssText = `
			display: flex;
			align-items: center;
			gap: 8px;
			margin: 16px 0;
			padding: 8px 12px;
			background: var(--background-secondary);
			border-radius: 6px;
			font-size: 14px;
		`;

		if (this.mode === 'space') {
			navEl.createSpan('nav-item').textContent = '选择知识库';
		} else {
			// 知识库名称
			const spaceEl = navEl.createSpan('nav-item');
			spaceEl.textContent = this.currentSpace?.name || '未知知识库';
			spaceEl.style.cssText = `
				cursor: pointer;
				color: var(--text-accent);
				text-decoration: underline;
			`;
			spaceEl.onclick = () => this.backToSpaceSelection();

			// 路径中的节点
			this.currentPath.forEach((node, index) => {
				// 分隔符
				navEl.createSpan('nav-separator').textContent = ' / ';

				// 节点名
				const nodeEl = navEl.createSpan('nav-item');
				nodeEl.textContent = node.title;
				
				if (index < this.currentPath.length - 1) {
					// 不是最后一个，可以点击
					nodeEl.style.cssText = `
						cursor: pointer;
						color: var(--text-accent);
						text-decoration: underline;
					`;
					nodeEl.onclick = () => this.navigateToNode(index);
				} else {
					// 最后一个，当前位置
					nodeEl.style.cssText = `
						font-weight: bold;
						color: var(--text-normal);
					`;
				}
			});
		}
	}

	/**
	 * 加载知识库列表
	 */
	private async loadSpaces(containerEl: HTMLElement) {
		if (this.loading) return;

		this.loading = true;
		containerEl.empty();

		// 显示加载状态
		const loadingEl = containerEl.createDiv('loading-indicator');
		loadingEl.textContent = '正在加载知识库列表...';
		loadingEl.style.cssText = `
			text-align: center;
			padding: 20px;
			color: var(--text-muted);
		`;

		try {
			this.spaces = await this.feishuApi.getWikiSpaceList();

			// 清除加载状态
			containerEl.empty();

			// 显示知识库列表
			this.renderSpaceList(containerEl);

		} catch (error) {
			console.error('Failed to load wiki spaces:', error);
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
	 * 渲染知识库列表
	 */
	private renderSpaceList(containerEl: HTMLElement) {
		if (this.spaces.length === 0) {
			const emptyEl = containerEl.createDiv('empty-message');
			emptyEl.textContent = '没有可访问的知识库';
			emptyEl.style.cssText = `
				text-align: center;
				padding: 20px;
				color: var(--text-muted);
			`;
			return;
		}

		this.spaces.forEach(space => {
			const spaceEl = containerEl.createDiv('space-item');
			spaceEl.style.cssText = `
				display: flex;
				align-items: center;
				padding: 12px 16px;
				cursor: pointer;
				border-bottom: 1px solid var(--background-modifier-border);
				transition: background-color 0.2s;
			`;

			// 知识库图标
			const iconEl = spaceEl.createSpan('space-icon');
			iconEl.textContent = '📚';
			iconEl.style.cssText = `
				margin-right: 12px;
				font-size: 16px;
			`;

			// 知识库信息
			const infoEl = spaceEl.createDiv('space-info');
			infoEl.style.cssText = `flex: 1;`;

			const nameEl = infoEl.createDiv('space-name');
			nameEl.textContent = space.name;
			nameEl.style.cssText = `
				font-size: 14px;
				font-weight: 500;
			`;

			if (space.description) {
				const descEl = infoEl.createDiv('space-desc');
				descEl.textContent = space.description;
				descEl.style.cssText = `
					font-size: 12px;
					color: var(--text-muted);
					margin-top: 2px;
				`;
			}

			// 悬停效果
			spaceEl.onmouseenter = () => {
				spaceEl.style.backgroundColor = 'var(--background-modifier-hover)';
			};
			spaceEl.onmouseleave = () => {
				spaceEl.style.backgroundColor = '';
			};

			// 点击进入知识库
			spaceEl.onclick = () => {
				this.enterSpace(space);
			};
		});
	}

	/**
	 * 进入知识库
	 */
	private async enterSpace(space: WikiSpace) {
		this.currentSpace = space;
		this.currentPath = [];
		this.mode = 'node';

		// 重新创建导航
		const navEl = this.contentEl.querySelector('.wiki-navigation');
		if (navEl) {
			navEl.remove();
			this.createNavigation(this.contentEl);
		}

		// 重新加载节点列表
		const listContainer = this.contentEl.querySelector('.wiki-list-container') as HTMLElement;
		if (listContainer) {
			await this.loadNodes(listContainer);
		}
	}

	/**
	 * 返回知识库选择
	 */
	private async backToSpaceSelection() {
		this.currentSpace = null;
		this.currentPath = [];
		this.mode = 'space';

		// 重新创建导航
		const navEl = this.contentEl.querySelector('.wiki-navigation');
		if (navEl) {
			navEl.remove();
			this.createNavigation(this.contentEl);
		}

		// 重新加载知识库列表
		const listContainer = this.contentEl.querySelector('.wiki-list-container') as HTMLElement;
		if (listContainer) {
			await this.loadSpaces(listContainer);
		}
	}

	/**
	 * 加载节点列表
	 */
	private async loadNodes(containerEl: HTMLElement) {
		if (this.loading || !this.currentSpace) return;

		this.loading = true;
		containerEl.empty();

		// 显示加载状态
		const loadingEl = containerEl.createDiv('loading-indicator');
		loadingEl.textContent = '正在加载节点列表...';
		loadingEl.style.cssText = `
			text-align: center;
			padding: 20px;
			color: var(--text-muted);
		`;

		try {
			const parentNodeToken = this.currentPath.length > 0
				? this.currentPath[this.currentPath.length - 1].node_token
				: undefined;

			this.nodes = await this.feishuApi.getWikiNodeList(this.currentSpace.space_id, parentNodeToken);

			// 清除加载状态
			containerEl.empty();

			// 显示节点列表
			this.renderNodeList(containerEl);

		} catch (error) {
			console.error('Failed to load wiki nodes:', error);
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
	 * 渲染节点列表
	 */
	private renderNodeList(containerEl: HTMLElement) {
		// 过滤出文件夹类型的节点
		const folderNodes = this.nodes.filter(node => node.has_child);

		if (folderNodes.length === 0) {
			const emptyEl = containerEl.createDiv('empty-message');
			emptyEl.textContent = '此位置没有子文件夹';
			emptyEl.style.cssText = `
				text-align: center;
				padding: 20px;
				color: var(--text-muted);
			`;
			return;
		}

		folderNodes.forEach(node => {
			const nodeEl = containerEl.createDiv('node-item');
			nodeEl.style.cssText = `
				display: flex;
				align-items: center;
				padding: 12px 16px;
				cursor: pointer;
				border-bottom: 1px solid var(--background-modifier-border);
				transition: background-color 0.2s;
			`;

			// 节点图标
			const iconEl = nodeEl.createSpan('node-icon');
			iconEl.textContent = '📁';
			iconEl.style.cssText = `
				margin-right: 12px;
				font-size: 16px;
			`;

			// 节点名称
			const nameEl = nodeEl.createSpan('node-name');
			nameEl.textContent = node.title;
			nameEl.style.cssText = `
				flex: 1;
				font-size: 14px;
			`;

			// 悬停效果
			nodeEl.onmouseenter = () => {
				nodeEl.style.backgroundColor = 'var(--background-modifier-hover)';
			};
			nodeEl.onmouseleave = () => {
				nodeEl.style.backgroundColor = '';
			};

			// 点击进入节点
			nodeEl.onclick = () => {
				this.enterNode(node);
			};
		});
	}

	/**
	 * 进入节点
	 */
	private async enterNode(node: WikiNode) {
		// 检查是否已经在当前路径中，避免重复添加
		const existingIndex = this.currentPath.findIndex(n => n.node_token === node.node_token);

		if (existingIndex >= 0) {
			// 如果节点已存在，截断到该位置
			this.currentPath = this.currentPath.slice(0, existingIndex + 1);
		} else {
			// 如果节点不存在，添加到路径末尾
			this.currentPath.push(node);
		}

		// 重新创建导航
		const navEl = this.contentEl.querySelector('.wiki-navigation');
		if (navEl) {
			navEl.remove();
			this.createNavigation(this.contentEl);
		}

		// 重新加载节点列表
		const listContainer = this.contentEl.querySelector('.wiki-list-container') as HTMLElement;
		if (listContainer) {
			await this.loadNodes(listContainer);
		}
	}

	/**
	 * 导航到指定层级的节点
	 */
	private async navigateToNode(index: number) {
		this.currentPath = this.currentPath.slice(0, index + 1);
		
		// 重新创建导航
		const navEl = this.contentEl.querySelector('.wiki-navigation');
		if (navEl) {
			navEl.remove();
			this.createNavigation(this.contentEl);
		}

		// 重新加载节点列表
		const listContainer = this.contentEl.querySelector('.wiki-list-container') as HTMLElement;
		if (listContainer) {
			await this.loadNodes(listContainer);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
