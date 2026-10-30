/**
 * A phone hands the product over to a computer: the phone's own share sheet (mail, a message to oneself, AirDrop),
 * else the link copied. Nothing is sent by the server.
 */

/** The address a computer opens: a network open in this tab has no address of its own elsewhere, so it is Home. */
export const linkForComputer = (href = typeof window !== "undefined" ? window.location.href : "/") => {
  try {
    const url = new URL(href);
    if (/^\/r\//.test(url.pathname)) return `${url.origin}/`;
    return url.href;
  } catch {
    return href;
  }
};

/** "shared" | "cancelled" | "copied" | "failed". */
export async function sendToComputer({ url, title, text }) {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ title, text, url });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
    }
  }
  return copyLink(url);
}

export async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}
