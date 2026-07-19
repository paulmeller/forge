import { createSign } from 'node:crypto';

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Sign a GitHub App JWT (RS256) for app-level API calls — installation
 * token exchange, installation lookup. `nowMs` is injectable for tests;
 * defaults to the real clock. Per GitHub's docs: `iat` gets a 60s
 * clock-drift buffer, `exp` sits at the 10-minute cap.
 */
export function signGithubAppJwt(
  appId: string,
  privateKeyPem: string,
  nowMs: number = Date.now(),
): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const iat = Math.floor(nowMs / 1000) - 60;
  const exp = iat + 600;
  const payload = { iat, exp, iss: appId };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${unsigned}.${base64url(signature)}`;
}

export type InstallationAccount = { login: string; type: string };

/** GET /app/installations/{id} — the account (user or org) that installed the app. */
export async function getInstallationAccount(
  installationId: number,
  appId: string,
  privateKeyPem: string,
): Promise<InstallationAccount> {
  const jwt = signGithubAppJwt(appId, privateKeyPem);
  const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch installation ${installationId}: ${res.status}`);
  }
  const json = (await res.json()) as { account?: { login?: string; type?: string } };
  return {
    login: json.account?.login ?? 'unknown',
    type: json.account?.type ?? 'User',
  };
}

/** POST /app/installations/{id}/access_tokens — a short-lived installation token. */
export async function createInstallationAccessToken(
  installationId: number,
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const jwt = signGithubAppJwt(appId, privateKeyPem);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to create installation token for ${installationId}: ${res.status}`);
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error('GitHub did not return an installation token');
  return json.token;
}

const MAX_REPO_PAGES = 10;

/** GET /installation/repositories — every repo this installation can access, paginated. */
export async function listInstallationRepositories(installationToken: string): Promise<string[]> {
  const repos: string[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const url = new URL('https://api.github.com/installation/repositories');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${installationToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to list installation repositories: ${res.status}`);
    }
    const json = (await res.json()) as { repositories?: Array<{ full_name: string }> };
    const items = json.repositories ?? [];
    repos.push(...items.map((r) => r.full_name));
    if (items.length < 100) break;
  }
  return repos;
}
