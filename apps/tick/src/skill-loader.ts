import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';

import { skills, type LoopPolicy, type Skill } from '@forge/db';

import { db } from './db';

export type SkillDefinition = {
  slug: string;
  name: string;
  version: string;
  description: string;
  promptTemplate: string;
  allowedTools: string[] | null;
  loopPolicy: LoopPolicy | null;
};

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Split optional YAML frontmatter from a SKILL.md body. Parsed with a real YAML
 * library so multi-line `acceptanceCriteria: |` block scalars round-trip (a
 * hand-parser would silently truncate them — directly weakening the verify gate).
 * Pure — exported for testing. The body is returned with the frontmatter stripped
 * so the agent prompt is unchanged.
 */
export function parseFrontmatter(raw: string): { loopPolicy: LoopPolicy | null; body: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { loopPolicy: null, body: raw };
  const body = raw.slice(m[0].length);
  try {
    const fm = parseYaml(m[1] ?? '') as { loopPolicy?: LoopPolicy } | null;
    const loopPolicy = fm && typeof fm === 'object' && fm.loopPolicy ? fm.loopPolicy : null;
    return { loopPolicy, body };
  } catch {
    // Malformed frontmatter — keep the body, ignore the policy.
    return { loopPolicy: null, body };
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_DIR = resolve(__dirname, '../../../../skills');

/**
 * Load curated skill definitions from the `skills/` directory at repo root.
 * Each subdirectory is a skill identified by its directory name (slug).
 *
 * Expected layout:
 *   skills/<slug>/SKILL.md     — required, the prompt template
 *   skills/<slug>/tools.json   — optional, { allowedTools: string[] }
 */
export function loadSkillsFromDisk(): SkillDefinition[] {
  if (!existsSync(SKILLS_DIR)) return [];

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  const defs: SkillDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const dir = join(SKILLS_DIR, slug);

    const skillMdPath = join(dir, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    const rawMd = readFileSync(skillMdPath, 'utf-8');
    const { loopPolicy, body: promptTemplate } = parseFrontmatter(rawMd);

    // Extract name from first markdown heading
    const headingMatch = promptTemplate.match(/^#\s+(.+)$/m);
    const name = headingMatch?.[1]?.trim() ?? slug;

    // Extract first non-heading paragraph as description
    const lines = promptTemplate.split('\n');
    let description = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') continue;
      description = trimmed;
      break;
    }

    let allowedTools: string[] | null = null;
    const toolsPath = join(dir, 'tools.json');
    if (existsSync(toolsPath)) {
      try {
        const raw = JSON.parse(readFileSync(toolsPath, 'utf-8')) as {
          allowedTools?: string[];
        };
        if (Array.isArray(raw.allowedTools)) {
          allowedTools = raw.allowedTools;
        }
      } catch {
        // Invalid tools.json — skip tool restrictions
      }
    }

    defs.push({
      slug,
      name,
      version: '1.0.0',
      description,
      promptTemplate,
      allowedTools,
      loopPolicy,
    });
  }

  return defs;
}

/**
 * Sync on-disk skill definitions into the database. Inserts new skills,
 * updates existing ones if the prompt template or tools changed.
 */
export async function syncSkillsToDb(): Promise<{ inserted: number; updated: number }> {
  const defs = loadSkillsFromDisk();
  let inserted = 0;
  let updated = 0;

  for (const def of defs) {
    const [existing] = await db.select().from(skills).where(eq(skills.slug, def.slug)).limit(1);

    if (!existing) {
      await db.insert(skills).values({
        id: `skl_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        name: def.name,
        slug: def.slug,
        version: def.version,
        description: def.description,
        promptTemplate: def.promptTemplate,
        allowedTools: def.allowedTools,
        loopPolicy: def.loopPolicy,
        builtIn: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      inserted += 1;
    } else if (
      existing.promptTemplate !== def.promptTemplate ||
      JSON.stringify(existing.allowedTools) !== JSON.stringify(def.allowedTools) ||
      JSON.stringify(existing.loopPolicy) !== JSON.stringify(def.loopPolicy)
    ) {
      await db
        .update(skills)
        .set({
          name: def.name,
          description: def.description,
          promptTemplate: def.promptTemplate,
          allowedTools: def.allowedTools,
          loopPolicy: def.loopPolicy,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, existing.id));
      updated += 1;
    }
  }

  return { inserted, updated };
}

/**
 * Get a skill by ID from the database. Returns null if not found.
 */
export async function getSkill(skillId: string): Promise<Skill | null> {
  const [row] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  return row ?? null;
}

/**
 * List all available skills (built-in + BYO).
 */
export async function listSkills(): Promise<Skill[]> {
  return db.select().from(skills);
}
