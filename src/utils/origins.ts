/**
 * Browser origins the API accepts.
 *
 * `https://www.kimates.com` and `https://kimates.com` are different origins to a
 * browser, and nginx serves the site under both names. The frontend bundle always
 * calls the apex, so a visitor who arrives on the www form makes a *cross-origin* API
 * call: the browser sends a preflight, the API answers it with
 * `Access-Control-Allow-Origin: https://kimates.com`, that doesn't match the caller,
 * and the browser drops the request before it is ever sent.
 *
 * The failure is invisible from the server's side — the preflight returns 204 and
 * looks fine in the logs — while the user gets a fully rendered page where nothing
 * works. It broke login for days for anyone whose browser autocompleted "www.".
 *
 * nginx now redirects www to the apex, which prevents new cases. This exists because
 * that redirect can't reach everyone: a client with the service worker already
 * registered under www keeps serving pages from cache without a navigation, so no
 * redirect ever fires for them. Accepting both origins is what unbreaks those users.
 */
export function buildAllowedOrigins(frontendBaseUrl: string): string[] {
  const origins = new Set<string>();

  let url: URL;
  try {
    url = new URL(frontendBaseUrl);
  } catch {
    // Not a URL we can reason about — trust it verbatim rather than locking everyone
    // out over a malformed env var.
    return [frontendBaseUrl];
  }

  const { protocol, host } = url;
  origins.add(`${protocol}//${host}`);

  // Pair each host with its counterpart, so the allowlist is correct whichever form
  // FRONTEND_BASE_URL is configured with.
  if (host.startsWith("www.")) {
    origins.add(`${protocol}//${host.slice(4)}`);
  } else {
    origins.add(`${protocol}//www.${host}`);
  }

  return [...origins];
}
