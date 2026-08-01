/**
 * Text markers for `user.message` content that Forge itself injected into a
 * session, as opposed to a message a human typed (issue #61). Kept in their
 * own dependency-free module so the injector (server/tick/ci.ts, which pulls
 * in server-only db/Octokit) and the renderer (session-log-format.ts, loaded
 * into client bundles) can agree on the text without the renderer importing
 * server code.
 */
export const CI_RETRY_PROMPT_PREFIX = 'CI failed on the PR you opened.';
