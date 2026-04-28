import { Octokit } from '@octokit/rest';

import { env } from './env';

export const AGENTS_MD_MAX_CHARS = 8000;

const FILE_CANDIDATES = [
  'AGENTS.md',
  '.github/AGENTS.md',
  'CLAUDE.md',
  '.claude/AGENTS.md',
];

// Cache: key = "owner/repo:missionId", value = content or null
const cache = new Map<string, string | null>();

let octokit: Octokit | undefined;
function client(): Octokit {
  if (!octokit) {
    if (!env.GITHUB_APP_TOKEN) return new Octokit();
    octokit = new Octokit({ auth: env.GITHUB_APP_TOKEN });
  }
  return octokit;
}

/**
 * Fetch the AGENTS.md (or CLAUDE.md) content for a repo.
 * Cached per repo+mission so we don't re-fetch for every task in the same mission.
 */
export async function fetchAgentsMd(
  repo: string,
  missionId: string,
): Promise<{ content: string | null; file: string | null; truncated: boolean }> {
  const cacheKey = `${repo}:${missionId}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)!;
    return { content: cached, file: null, truncated: false };
  }

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    cache.set(cacheKey, null);
    return { content: null, file: null, truncated: false };
  }

  const gh = client();

  for (const path of FILE_CANDIDATES) {
    try {
      const { data } = await gh.repos.getContent({ owner, repo: repoName, path });
      if ('content' in data && typeof data.content === 'string') {
        let content = Buffer.from(data.content, 'base64').toString('utf-8');
        let truncated = false;
        if (content.length > AGENTS_MD_MAX_CHARS) {
          content = truncateAgentsMd(content);
          truncated = true;
        }
        cache.set(cacheKey, content);
        return { content, file: path, truncated };
      }
    } catch {
      continue;
    }
  }

  cache.set(cacheKey, null);
  return { content: null, file: null, truncated: false };
}

export function truncateAgentsMd(content: string): string {
  if (content.length <= AGENTS_MD_MAX_CHARS) return content;
  return content.slice(0, AGENTS_MD_MAX_CHARS) + '\n\n[... truncated at 8000 chars. See full file in repo.]';
}

/** Clear cache entries for a mission (call when mission completes). */
export function clearAgentsMdCache(missionId: string): void {
  for (const key of cache.keys()) {
    if (key.endsWith(`:${missionId}`)) {
      cache.delete(key);
    }
  }
}
