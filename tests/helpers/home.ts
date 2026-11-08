/**
 * The environment for a CLI run in a temp home: HOME and USERPROFILE point
 * there, and the variables that would lead kim to the real agent or config
 * folders anyway (Claude Code's CLAUDE_CONFIG_DIR among them) are dropped.
 */
export function homeEnv(
  home: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "APPDATA",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "CLAUDE_CODE_REMOTE",
    "CLAUDE_CODE_REMOTE_SESSION_ID",
  ])
    delete env[name];
  return { ...env, ...extra };
}
