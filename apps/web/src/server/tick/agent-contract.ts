/**
 * Checks a backend agent's own configured instructions — its persistent
 * system prompt, delivered into the sandbox as CLAUDE.md or equivalent —
 * against the contract Forge's dispatch loop depends on:
 *
 *   - work is committed (the #56 salvage push has nothing to push otherwise)
 *   - the agent pushes to the branch Forge named, not one of its own
 *   - the agent does not open the pull request (Forge does; the sandbox
 *     can't reach api.github.com)
 *   - a verification failure does not mean withholding work
 *
 * Forge composes its half of the prompt fresh every dispatch from AGENTS.md
 * + the task goal, but the agent record is configured out-of-band and can
 * silently drift out of step with it — #58 was fixed in AGENTS.md while the
 * agent's own system prompt still said the opposite, and the agent (correctly,
 * from its perspective) obeyed its own instructions, discarding the fix (#66).
 *
 * This is a denylist, not a whitelist: each rule below is a phrase that has
 * actually caused an incident, not an attempt to prove a prompt "correct". A
 * denylist hit is a strong, specific signal; a miss says nothing — an
 * instructions string that matches nothing here is unknown, not vouched for.
 */

export type ContractViolation = { rule: string; detail: string };

type Rule = {
  rule: string;
  pattern: RegExp;
  detail: string;
};

// Checked immediately before a match to rule out the negated form of the same
// phrase ("do not open a pull request") — that phrasing is the CORRECT
// instruction (it's what AGENTS.md itself says), not a violation of it.
const NEGATION_RE = /\b(?:do not|don't|never|must not|should not|won't|shouldn't)\s*$/i;

const RULES: Rule[] = [
  {
    rule: 'withholds_work',
    pattern: /\b(?:do not|don't|never)\s+(?:push|commit)\b/i,
    detail:
      'instructs the agent not to push/commit — the #56 salvage push has nothing to push otherwise',
  },
  {
    rule: 'withholds_work',
    pattern: /\bwithhold(?:s|ing)?\b.{0,40}\b(?:work|changes|commit|fix)\b/i,
    detail:
      'instructs the agent to withhold work — a verification failure must not mean withholding it (CI runs the same checks on the pull request)',
  },
  {
    rule: 'hardcoded_path',
    // Common sandbox/workstation roots. Not exhaustive by design — a denylist
    // trades recall for precision; see module doc.
    pattern: /\/(?:home|Users|root|mnt|workspace)\/[^\s'"`]+/i,
    detail: 'hardcodes an absolute repo path — the sandbox path is not fixed across runs',
  },
  {
    rule: 'opens_pr',
    pattern: /\b(?:open|create)s?\s+(?:a|the)?\s*(?:pull request|pr)\b/i,
    detail:
      'instructs the agent to open the pull request — Forge opens it; the sandbox cannot reach api.github.com',
  },
  {
    rule: 'opens_pr',
    pattern: /\b(?:git merge|merges?\s+(?:the\s+)?(?:pull request|pr|branch))\b/i,
    detail: 'instructs the agent to merge — Forge owns merging, not the agent',
  },
];

/** True when a negation phrase immediately precedes the match. */
function isNegated(system: string, matchIndex: number): boolean {
  const before = system.slice(Math.max(0, matchIndex - 30), matchIndex);
  return NEGATION_RE.test(before);
}

export function checkAgentInstructions(system: string | null | undefined): ContractViolation[] {
  if (!system) return [];

  const violations: ContractViolation[] = [];
  for (const { rule, pattern, detail } of RULES) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(system)) !== null) {
      if (!isNegated(system, match.index)) {
        violations.push({ rule, detail });
        break; // one violation per rule pattern is enough signal
      }
      if (match[0].length === 0) re.lastIndex += 1; // guard against zero-width loops
    }
  }
  return violations;
}
