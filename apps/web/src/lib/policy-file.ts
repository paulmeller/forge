import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { AutoMergePolicy } from '@forge/db';

/**
 * The `.forge/policy.yml` format.
 *
 * `.strict()` throughout is the point, not pedantry: a policy file is how an
 * operator authorises autonomous merges, and an ignored typo (`autoMerg:`)
 * would read as "not configured" — leaving a gate in a state they believe
 * they changed. An unknown key is an error the repo page shows them.
 */
const autoMergeSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxAdditions: z.number().int().positive().optional(),
    maxDeletions: z.number().int().positive().optional(),
    maxFilesChanged: z.number().int().positive().optional(),
    requiredChecks: z.array(z.string()).optional(),
    allowedPathPatterns: z.array(z.string()).optional(),
    requireHumanApproval: z.boolean().optional(),
  })
  .strict();

const policySchema = z
  .object({
    gates: z
      .object({
        ci: z.boolean().default(true),
        selfVerify: z.boolean().default(true),
        aiReview: z.boolean().default(true),
      })
      .strict()
      // Zod 4 uses a default as the OUTPUT without re-parsing it, so an empty
      // object here would skip every inner field default and yield undefined
      // gates. Spell the defaults out.
      .default({ ci: true, selfVerify: true, aiReview: true }),
    autoMerge: autoMergeSchema.default({ enabled: false }),
    requirePlanApproval: z.boolean().default(false),
    budgets: z
      .object({
        taskTokens: z.number().int().positive().nullable().default(null),
        taskTurns: z.number().int().positive().nullable().default(null),
        noProgressTokens: z.number().int().positive().nullable().default(null),
      })
      .strict()
      .default({ taskTokens: null, taskTurns: null, noProgressTokens: null }),
    concurrencyCap: z.number().int().positive().nullable().default(null),
  })
  .strict();

export type ForgePolicy = {
  gates: { ci: boolean; selfVerify: boolean; aiReview: boolean };
  autoMerge: AutoMergePolicy;
  requirePlanApproval: boolean;
  budgets: { taskTokens: number | null; taskTurns: number | null; noProgressTokens: number | null };
  concurrencyCap: number | null;
};

export type ParseResult = { ok: true; policy: ForgePolicy } | { ok: false; error: string };

/** Safe defaults: auto-merge off, every gate on. What an omitted file means. */
export const DEFAULT_POLICY: ForgePolicy = policySchema.parse({}) as ForgePolicy;

export function parsePolicyFile(source: string): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    return { ok: false, error: `invalid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  // An empty document parses to null/undefined — a deliberate "use defaults",
  // which is what the template degrades to if its body is deleted.
  if (raw === null || raw === undefined) return { ok: true, policy: DEFAULT_POLICY };

  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return { ok: false, error };
  }
  return { ok: true, policy: parsed.data as ForgePolicy };
}

/**
 * The file Forge proposes in the onboarding pull request.
 *
 * Written as commented YAML rather than generated from the schema: the PR is
 * the operator's first real explanation of what Forge will do, so the comments
 * are the feature. Every value here is the safe default — merging it changes
 * nothing about how Forge behaves except that it may now run at all.
 */
export function policyFileTemplate(opts: { repo: string; verifyCommand: string | null }): string {
  const verify = opts.verifyCommand ?? '(none detected — set one in AGENTS.md)';
  return `# Forge policy for ${opts.repo}
#
# Merging this file authorises Forge to dispatch coding agents against this
# repository. Until it is merged, Forge does nothing here.
#
# This file is the complete policy for this repo: when it is present the
# Settings page shows these values read-only, and changing policy means
# changing this file. Detected verify command: ${verify}

gates:
  ci: true          # never merge without CI green
  selfVerify: true  # check the change against its acceptance criteria
  aiReview: true    # independent review of the diff

autoMerge:
  enabled: false    # every change waits for a human. Turn on deliberately.

requirePlanApproval: false

budgets:
  taskTokens: null        # null = use the deployment default
  taskTurns: null
  noProgressTokens: null

concurrencyCap: null      # null = use the deployment default
`;
}
