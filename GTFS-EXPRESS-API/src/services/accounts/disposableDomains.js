/**
 * Throwaway e-mail services refused for the free trial, given once per address. Signing in stays open to any address.
 * A brake, not a wall: what makes collecting trials pointless is that no modified GTFS leaves one.
 */

"use strict";

const DOMAINS = new Set([
  "yopmail.com", "yopmail.fr", "yopmail.net", "cool.fr.nf", "jetable.fr.nf", "nospam.ze.tc", "nomail.xl.cx", "mega.zik.dj", "speed.1s.fr",
  "courriel.fr.nf", "moncourrier.fr.nf", "monemail.fr.nf", "monmail.fr.nf", "jetable.org", "jetable.com", "jetable.net",
  "mailinator.com", "mailinator.net", "mailinator2.com", "notmailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org",
  "guerrillamail.biz", "guerrillamail.de", "guerrillamail.info", "guerrillamailblock.com", "grr.la", "sharklasers.com", "pokemail.net", "spam4.me",
  "10minutemail.com", "10minutemail.net", "10minutemail.co.uk", "20minutemail.com", "minuteinbox.com", "temp-mail.org", "temp-mail.io",
  "tempmail.com", "tempmail.net", "tempmail.dev", "tempmail.plus", "tempmail.us.com", "tempmailo.com", "tmpmail.org", "tmpmail.net", "tempr.email",
  "tempinbox.com", "tempail.com", "temporary-mail.net", "mail-temp.com", "mailtemp.net", "mytemp.email", "emailtemporanea.com", "mail.tm",
  "mailgw.com", "1secmail.com", "1secmail.net", "1secmail.org", "emlpro.com", "emltmp.com", "dropmail.me", "linshiyouxiang.net",
  "discard.email", "discardmail.com", "dispostable.com", "maildrop.cc", "mailnesia.com", "mintemail.com", "mohmal.com", "getnada.com",
  "nada.email", "throwawaymail.com", "trashmail.com", "trashmail.de", "trashmail.net", "trashmail.me", "trashmail.io", "wegwerfmail.de",
  "wegwerfmail.net", "einrot.com", "spamgourmet.com", "mailpoof.com", "fakeinbox.com", "fakemail.net", "emailondeck.com", "burnermail.io",
  "inboxkitten.com", "mailcatch.com", "spambox.us", "spamex.com", "incognitomail.org", "mailforspam.com", "crazymailing.com", "moakt.com",
  "tmail.ws", "harakirimail.com", "mvrht.com", "byom.de", "owlymail.com", "mailsac.com", "anonbox.net", "spam.la", "filzmail.com",
  "luxusmail.org", "gufum.com", "33mail.com", "anonaddy.me", "duck.com",
]);

/** Subdomains of a listed domain count as listed. */
const isDisposable = (emailOrDomain) => {
  const text = String(emailOrDomain || "").trim().toLowerCase();
  const domain = text.includes("@") ? text.slice(text.lastIndexOf("@") + 1) : text;
  if (!domain) return false;
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) if (DOMAINS.has(parts.slice(i).join("."))) return true;
  return false;
};

module.exports = { isDisposable, DOMAINS };
