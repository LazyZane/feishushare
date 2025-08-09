// DOM工具类 - 安全的DOM操作，避免使用innerHTML
export class DomUtils {
    /**
     * 安全地设置元素内容，避免XSS风险
     */
    static setContent(element: HTMLElement, content: string) {
        element.textContent = content;
    }

    /**
     * 创建带有文本内容的元素
     */
    static createElementWithText(tag: string, text: string, className?: string): HTMLElement {
        const element = document.createElement(tag);
        element.textContent = text;
        if (className) {
            element.className = className;
        }
        return element;
    }

    /**
     * 创建带有HTML结构的复杂元素（安全版本）
     */
    static createAuthStatusElement(isAuthed: boolean, userInfo?: any): HTMLElement {
        const container = document.createElement('div');
        container.className = 'setting-item-description';

        if (isAuthed && userInfo) {
            // 已授权状态
            const statusSpan = document.createElement('span');
            statusSpan.className = 'auth-status-success';
            statusSpan.textContent = '✅ 已授权';
            container.appendChild(statusSpan);

            container.appendChild(document.createElement('br'));

            const userLabel = document.createElement('strong');
            userLabel.textContent = '用户：';
            container.appendChild(userLabel);
            container.appendChild(document.createTextNode(userInfo.name));

            container.appendChild(document.createElement('br'));

            const emailLabel = document.createElement('strong');
            emailLabel.textContent = '邮箱：';
            container.appendChild(emailLabel);
            container.appendChild(document.createTextNode(userInfo.email));
        } else {
            // 未授权状态
            const statusSpan = document.createElement('span');
            statusSpan.className = 'auth-status-error';
            statusSpan.textContent = '❌ 未授权';
            container.appendChild(statusSpan);
        }

        return container;
    }

    /**
     * 创建使用说明元素
     */
    static createUsageInstructions(): HTMLElement {
        const container = document.createElement('div');
        container.className = 'setting-item-description';

        const ol = document.createElement('ol');

        const steps = [
            '配置应用：在飞书开放平台创建应用，获取App ID和App Secret',
            '设置回调：配置OAuth回调地址（推荐使用默认地址）',
            '完成授权：点击"一键授权"按钮完成用户授权',
            '选择文件夹：选择文档保存的目标文件夹',
            '开始使用：在编辑器中右键选择"分享到飞书"'
        ];

        steps.forEach(step => {
            const li = document.createElement('li');
            const strong = document.createElement('strong');
            const [title, ...rest] = step.split('：');
            strong.textContent = title + '：';
            li.appendChild(strong);
            li.appendChild(document.createTextNode(rest.join('：')));
            ol.appendChild(li);
        });

        container.appendChild(ol);
        return container;
    }

    /**
     * 创建手动授权说明
     */
    static createManualAuthInstructions(): HTMLElement {
        const container = document.createElement('div');
        container.className = 'setting-item-description feishu-setting-description';

        const title = document.createElement('p');
        const titleStrong = document.createElement('strong');
        titleStrong.textContent = '🚀 简化授权流程 - 只需复制粘贴URL：';
        title.appendChild(titleStrong);
        container.appendChild(title);

        const ol = document.createElement('ol');
        const steps = [
            '点击下方"生成授权链接"按钮',
            '复制生成的授权URL，在浏览器中打开',
            '完成飞书授权后，复制浏览器地址栏的完整URL',
            '将完整的回调URL粘贴到下方输入框',
            '点击"完成授权"按钮'
        ];

        steps.forEach(step => {
            const li = document.createElement('li');
            li.textContent = step;
            ol.appendChild(li);
        });

        container.appendChild(ol);

        const note = document.createElement('p');
        const noteStrong = document.createElement('strong');
        noteStrong.textContent = '注意：';
        note.appendChild(noteStrong);
        note.appendChild(document.createTextNode('回调URL包含授权码，请完整复制'));
        container.appendChild(note);

        return container;
    }

    /**
     * 创建插件描述
     */
    static createPluginDescription(): HTMLElement {
        const container = document.createElement('div');
        container.className = 'setting-item-description';

        const p1 = document.createElement('p');
        p1.textContent = '直连飞书API，回调地址仅中转无记录。';
        container.appendChild(p1);

        const p2 = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = '特点：';
        p2.appendChild(strong);
        p2.appendChild(document.createTextNode('无依赖、更安全、响应更快'));
        container.appendChild(p2);

        return container;
    }

    /**
     * 添加CSS类
     */
    static addClass(element: HTMLElement, className: string) {
        element.classList.add(className);
    }

    /**
     * 移除CSS类
     */
    static removeClass(element: HTMLElement, className: string) {
        element.classList.remove(className);
    }

    /**
     * 切换CSS类
     */
    static toggleClass(element: HTMLElement, className: string) {
        element.classList.toggle(className);
    }
}
