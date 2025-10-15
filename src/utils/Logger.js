function pad(num, len = 2) {
    return String(num).padStart(len, '0');
}

function buildTimestamp() {
    const now = new Date();
    const y = now.getFullYear();
    const m = pad(now.getMonth() + 1);
    const d = pad(now.getDate());
    const hh = pad(now.getHours());
    const mm = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    const ms = pad(now.getMilliseconds(), 3);
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}.${ms}`;
}

function formatLine(level, scope, args) {
    const prefix = `[${buildTimestamp()}] [${level}] [${scope}]`;
    return [prefix, ...args];
}

function createLogger(scope = 'app') {
    const label = scope || 'app';
    return {
        info: (...args) => console.log(...formatLine('INFO', label, args)),
        warn: (...args) => console.warn(...formatLine('WARN', label, args)),
        error: (...args) => console.error(...formatLine('ERROR', label, args))
    };
}

module.exports = {
    createLogger
};
