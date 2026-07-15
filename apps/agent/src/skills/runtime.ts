/**
 * Skills runtime — Claude-style reusable behavior packs.
 *
 * A *skill* is a named, versioned, manifest-validated composition of
 * existing agent tools (or downstream API calls) that the chief orchestrator
 * (the ReAct brain in `ai/brain.ts`) and operator CLIs both invoke.
 *
 * Manifests live next to their executor:
 *
 *     apps/agent/src/skills/<skill-name>/
 *         ├── manifest.ts   —  SkillManifest + Zod input/output schema
 *         └── index.ts      —  `execute(input, ctx) → output`
 *
 * The runtime below: validates manifests on `register`, exposes a flat
 * `invoke(name, input)` for callers, and returns a stable list for the brain
 * to enumerate.
 *
 * Skills intentionally compose EXISTING primitives — wallet, dex, audit,
 * tonapi, webhook. They do NOT own new state and never log mnemonics.
 */
import { z } from "zod";
import { log } from "../logger";

export const SkillManifestSchema = z.object({
    name: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,40}$/, "lowercase + dashes, e.g. 'wallet-bootstrap'"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "semver required"),
    description: z
        .string()
        .min(20, "description must be at least 20 chars so the LLM understands when to call it"),
    requires: z
        .object({
            env: z.array(z.string()).optional(),
            tools: z.array(z.string()).optional(),
        })
        .optional(),
    inputSchema: z.record(z.any()),
    outputSchema: z.record(z.any()),
    examples: z.array(z.string()).optional(),
    /** "low"/"mid"/"high" gate — defaults to ["low","mid","high"] (all tiers). */
    allowsTiers: z.array(z.enum(["low", "mid", "high"])).optional(),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export interface SkillContext {
    /** Tool handle map. Keys are the existing MCP/LangChain tool names so
     *  skills can reuse the agent's tool layer without going through HTTP. */
    tools: Record<string, (input: any) => Promise<any>>;
    /** Current tier (e.g. 'low'). Skills that execute trades MUST respect it. */
    tier: "low" | "mid" | "high";
    /** Caller-supplied extra context (e.g. from the radar pipeline). */
    extra?: Record<string, any>;
}

export interface SkillHandler<I = any, O = any> {
    manifest: SkillManifest;
    execute: (input: I, ctx: SkillContext) => Promise<O>;
}

// ─────────────────────────────────────────────────────────────────
// Internal registry. Insertion order = enumeration order.
// ─────────────────────────────────────────────────────────────────
const REGISTRY = new Map<string, SkillHandler>();

export function registerSkill<I, O>(handler: SkillHandler<I, O>): void {
    const parsed = SkillManifestSchema.safeParse(handler.manifest);
    if (!parsed.success) {
        throw new Error(
            `registerSkill(${handler.manifest.name ?? "<unnamed>"}): manifest invalid → ${parsed.error.message}`,
        );
    }
    if (REGISTRY.has(parsed.data.name)) {
        throw new Error(`skill "${parsed.data.name}" already registered`);
    }
    REGISTRY.set(parsed.data.name, handler as SkillHandler);
    log.ok("SKILLS", `registered ${parsed.data.name}@${parsed.data.version}`);
}

export function listSkills(): SkillManifest[] {
    return Array.from(REGISTRY.values()).map((h) => h.manifest);
}

export function getSkill(name: string): SkillHandler | undefined {
    return REGISTRY.get(name);
}

export async function invokeSkill<I, O>(
    name: string,
    input: I,
    ctx: SkillContext,
): Promise<{ ok: true; output: O } | { ok: false; error: string }> {
    const handler = REGISTRY.get(name);
    if (!handler) {
        return { ok: false, error: `unknown skill "${name}" (registered: ${Array.from(REGISTRY.keys()).join(", ") || "none"})` };
    }
    try {
        const output = await handler.execute(input, ctx);
        return { ok: true, output: output as O };
    } catch (e: any) {
        log.err("SKILLS", `${name} failed: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

/**
 * Compose a registry of MCP-tool handles into a SkillContext. Convenience
 * for callers building context from the LangChain tool map directly.
 *
 * Currently unused internally but exported because:
 *   • the CLI/test scaffolding builds skill contexts this way, and
 *   • future skill runners that consume the MCP server's tools list will
 *     reuse this helper rather than re-deriving the (input) => invoke closure.
 */
export function buildContext(opts: {
    tools: Record<string, { invoke: (input: any) => Promise<any> }>;
    tier: "low" | "mid" | "high";
    extra?: Record<string, any>;
}): SkillContext {
    const tools: Record<string, (input: any) => Promise<any>> = {};
    for (const [k, v] of Object.entries(opts.tools)) {
        tools[k] = (i) => v.invoke(i);
    }
    return { tools, tier: opts.tier, extra: opts.extra };
}
