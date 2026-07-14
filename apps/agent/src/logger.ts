/**
 * Pretty logger used across the agent runtime.
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

function fmt(level: string, color: string, tag: string, msg: string, extra?: any): string {
    const head = `${C.gray}${ts()}${C.reset} ${color}${level.padEnd(5)}${C.reset} ${C.bold}${C.magenta}${tag}${C.reset}`;
    const ex = extra !== undefined ? ` ${C.gray}${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 600)}${C.reset}` : "";
    return `${head} ${msg}${ex}`;
}

export const log = {
    info: (tag: string, msg: string, extra?: any) => console.log(fmt("INFO", C.blue, tag, msg, extra)),
    ok: (tag: string, msg: string, extra?: any) => console.log(fmt(" OK ", C.green, tag, msg, extra)),
    warn: (tag: string, msg: string, extra?: any) => console.warn(fmt("WARN", C.yellow, tag, msg, extra)),
    err: (tag: string, msg: string, extra?: any) => console.error(fmt(" ERR ", C.red, tag, msg, extra)),
    debug: (tag: string, msg: string, extra?: any) => {
        if (process.env.DEBUG) console.log(fmt(" DBG ", C.cyan, tag, msg, extra));
    },
    trade: (tag: string, msg: string, extra?: any) => console.log(fmt("TRADE", C.magenta, tag, msg, extra)),
    banner: (title: string, sub = "") => {
        const line = "═".repeat(60);
        console.log(`\n${C.cyan}${line}${C.reset}`);
        console.log(`${C.bold}${C.cyan} ${title}${C.reset}`);
        if (sub) console.log(` ${C.gray}${sub}${C.reset}`);
        console.log(`${C.cyan}${line}${C.reset}\n`);
    },
};
