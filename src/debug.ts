// 调试工具类 - 调试模式开启
export class Debug {
    private static enabled = true; // 开启调试模式（诊断临时文件删除问题）
    private static verboseMode = true; // 开启详细日志

    static log(...args: any[]) {
        if (this.enabled) {
            const timestamp = new Date().toISOString().substring(11, 23);
            console.log(`[Feishu ${timestamp}]`, ...args);
        }
    }

    static warn(...args: any[]) {
        if (this.enabled) {
            const timestamp = new Date().toISOString().substring(11, 23);
            console.warn(`[Feishu ${timestamp}] ⚠️`, ...args);
        }
    }

    static error(...args: any[]) {
        if (this.enabled) {
            const timestamp = new Date().toISOString().substring(11, 23);
            console.error(`[Feishu ${timestamp}] ❌`, ...args);
        }
    }

    static verbose(...args: any[]) {
        if (this.enabled && this.verboseMode) {
            const timestamp = new Date().toISOString().substring(11, 23);
            console.log(`[Feishu ${timestamp}] 🔍`, ...args);
        }
    }

    static step(stepName: string, ...args: any[]) {
        if (this.enabled) {
            const timestamp = new Date().toISOString().substring(11, 23);
            console.log(`[Feishu ${timestamp}] 📋 STEP: ${stepName}`, ...args);
        }
    }

    static api(method: string, url: string, data?: any) {
        if (this.enabled && this.verboseMode) {
            const timestamp = new Date().toISOString().substring(11, 23);
            console.log(`[Feishu ${timestamp}] 🌐 API: ${method} ${url}`, data ? data : '');
        }
    }

    static result(operation: string, success: boolean, data?: any) {
        if (this.enabled) {
            const timestamp = new Date().toISOString().substring(11, 23);
            const icon = success ? '✅' : '❌';
            console.log(`[Feishu ${timestamp}] ${icon} ${operation}:`, data ? data : '');
        }
    }

    static enable() {
        this.enabled = true;
        console.log('[Feishu] 🔧 Debug logging enabled');
    }

    static disable() {
        this.enabled = false;
        console.log('[Feishu] 🔇 Debug logging disabled');
    }

    static enableVerbose() {
        this.verboseMode = true;
        console.log('[Feishu] 🔍 Verbose logging enabled');
    }

    static disableVerbose() {
        this.verboseMode = false;
        console.log('[Feishu] 🤫 Verbose logging disabled');
    }

    static isEnabled(): boolean {
        return this.enabled;
    }

    static isVerbose(): boolean {
        return this.verboseMode;
    }

    static getStatus(): string {
        return `Debug: ${this.enabled ? 'ON' : 'OFF'}, Verbose: ${this.verboseMode ? 'ON' : 'OFF'}`;
    }
}
