/**
 * The variables Node.js reads for its built-in proxy support, in the order it reads them: the
 * lowercase spelling wins when both are set.
 */
const PROXY_VARIABLES = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;

function isHttpProxyUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Name the proxy variable this process has configured but Node.js fetch is not using, if any.
 *
 * Node.js fetch ignores `HTTPS_PROXY` and friends unless `NODE_USE_ENV_PROXY=1` (or
 * `--use-env-proxy`) was set at startup, while curl, git and npm all honor them. The result is a
 * terminal where curl reaches the API through the proxy and a Node.js tool in the same shell goes
 * out directly - and fails in a way that points nowhere near the proxy.
 *
 * Only `http:` and `https:` proxy URLs count. Node.js refuses to start with anything else in those
 * variables once env proxy support is on, so pointing a `socks5://` user at the switch would trade
 * a failed request for a process that does not start.
 */
export function unusedProxyVariable(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): string | undefined {
  if (env.NODE_USE_ENV_PROXY === "1") return undefined;
  if (execArgv.includes("--use-env-proxy")) return undefined;
  if ((env.NODE_OPTIONS ?? "").includes("--use-env-proxy")) return undefined;
  const configured = PROXY_VARIABLES.filter((name) => (env[name] ?? "") !== "");
  if (configured.length === 0) return undefined;
  if (!configured.every((name) => isHttpProxyUrl(env[name] ?? ""))) return undefined;
  return configured[0];
}

/** The sentence that explains an ignored proxy, or `undefined` when there is nothing to explain. */
export function unusedProxyHint(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): string | undefined {
  const variable = unusedProxyVariable(env, execArgv);
  if (variable === undefined) return undefined;
  return (
    `${variable} is set, but this request did not use it: Node.js fetch ignores proxy variables` +
    " unless NODE_USE_ENV_PROXY=1 is also set (Node.js 22.21+ or 24+)."
  );
}
