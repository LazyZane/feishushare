// 调试工具类 - 生产模式
export class Debug {
    private static enabled = false; // 关闭调试模式
    private static verboseMode = false; // 关闭详细日志

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
