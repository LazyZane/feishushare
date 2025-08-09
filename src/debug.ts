// 调试工具类 - 生产环境下禁用日志输出
export class Debug {
    private static enabled = false; // 生产环境设为false

    static log(...args: any[]) {
        if (this.enabled) {
            console.log('[Feishu]', ...args);
        }
    }

    static warn(...args: any[]) {
        if (this.enabled) {
            console.warn('[Feishu]', ...args);
        }
    }

    static error(...args: any[]) {
        // 错误信息始终输出，但添加前缀
        console.error('[Feishu]', ...args);
    }

    static enable() {
        this.enabled = true;
    }

    static disable() {
        this.enabled = false;
    }
}
