/**
 * Pretty logger used across the agent runtime.
 *
 * v2: adds `redirectToStderr()` so the MCP stdio server process can move
 * its log lines off stdout (which carries the JSON-RPC stream) without
 * changing every callsite. The default (stdout for INFO/OK/TRADE/BANNER;
 * stderr for WARN/ERR/DEBUG) keeps the agent runtime's behaviour
 * identical to v1.
 */
const C = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
    bold: "\x1b[1m",
};

const ts = () => new Date().toISOString().slice(11, 23);

// Toggle for the MCP stdio standalone process. When true, every log line
// (info/ok/warn/err/trade/banner) goes to stderr to keep the stdio stream
// free for JSON-RPC frames.
let _forceStderr = false;

export function redirectToStderr(): void { _forceStderr = true; }
export function isRedirectedToStderr(): boolean { return _forceStderr; }

function fmt(level: string, color: string, tag: string, msg: string, extra?: any): string {
    const head = `${C.gray}${ts()}${C.reset} ${color}${level.padEnd(5)}${C.reset} ${C.bold}${C.magenta}${tag}${C.reset}`;
    const ex = extra !== undefined ? ` ${C.gray}${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 600)}${C.reset}` : "";
    return `${head} ${msg}${ex}`;
}

function emit(stream: "stdout" | "stderr", level: string, color: string, tag: string, msg: string, extra?: any): void {
    const line = fmt(level, color, tag, msg, extra);
    if (_forceStderr) {
        process.stderr.write(line + "\n");
        return;
    }
    // Default: warnings/errors/debug to stderr, everything else to stdout.
    if (stream === "stderr") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
}

export const log = {
    info: (tag: string, msg: string, extra?: any) => emit("stdout", "INFO", C.blue, tag, msg, extra),
    ok:   (tag: string, msg: string, extra?: any) => emit("stdout", " OK ", C.green, tag, msg, extra),
    warn: (tag: string, msg: string, extra?: any) => emit("stderr", "WARN", C.yellow, tag, msg, extra),
    err:  (tag: string, msg: string, extra?: any) => emit("stderr", " ERR ", C.red, tag, msg, extra),
    debug: (tag: string, msg: string, extra?: any) => {
        if (_forceStderr || process.env.DEBUG) emit("stderr", " DBG ", C.cyan, tag, msg, extra);
    },
    trade: (tag: string, msg: string, extra?: any) => emit("stdout", "TRADE", C.magenta, tag, msg, extra),
    banner: (title: string, sub = "") => {
        const line = "═".repeat(60);
        emit("stdout", "", C.cyan, "", `\n${line}`);
        emit("stdout", "", C.bold, "", ` ${title}`);
        if (sub) emit("stdout", "", C.gray, "", ` ${sub}`);
        emit("stdout", "", C.cyan, "", `${line}\n`);
    },
};
