/**
 * Skills barrel — single import target for "register every skill on boot".
 *
 * Importing this file triggers each skill's bottom-of-file
 * `registerSkill(handler)` side-effect. Used by:
 *   - `apps/agent/src/index.ts`  (agent boot path)
 *   - `apps/agent/src/ai/brain.ts` (lists skills in the system prompt)
 *   - `apps/agent/src/cli/agent-plan.ts` (manual plan runs)
 *   - tests
 */
import { listSkills } from "./runtime";

// Side-effect import — each one triggers its own registerSkill().
// Order is irrelevant for the registry; the order here is just narrative.
import "./wallet-bootstrap";
import "./token-scout";
import "./audit-jetton";
import "./trade-plan";
import "./manual-override";

/**
 * Render the available-skills block for the brain's system prompt so the
 * ReAct agent knows which composable skills it can invoke.
 */
export function availableSkillsSection(): string {
    const skills = listSkills();
    if (skills.length === 0) return "(no skills registered)";
    const lines = ["AVAILABLE SKILLS (compose these via tools registered to the LLM — invoke by name):"];
    for (const s of skills) {
        lines.push(
            `- ${s.name}@${s.version}: ${s.description}`,
        );
        if (s.requires?.tools && s.requires.tools.length) {
            lines.push(`    requires tools: ${s.requires.tools.join(", ")}`);
        }
        if (s.requires?.env && s.requires.env.length) {
            lines.push(`    requires env: ${s.requires.env.join(", ")}`);
        }
    }
    return lines.join("\n");
}
