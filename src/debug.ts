// 调试工具类 - 生产环境下禁用所有日志输出
export class Debug {
    private static enabled = false; // 生产环境设为false，可通过设置启用

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
        // 生产环境下也禁用错误日志，避免污染控制台
        if (this.enabled) {
            console.error('[Feishu]', ...args);
        }
    }

    static enable() {
        this.enabled = true;
    }

    static disable() {
        this.enabled = false;
    }

    static isEnabled(): boolean {
        return this.enabled;
    }
}
