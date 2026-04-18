/**
 * instagramChecker.js
 * Checks if an Instagram account is accessible (unbanned).
 * When accessible, also scrapes public profile stats:
 *   followers, following, post count, display name, profile picture URL.
 * No login required — public profile page only.
 */

const axios = require("axios");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

let uaIndex = 0;
function getNextUserAgent() {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex++;
  return ua;
}

function jitter(baseMs) {
  const variance = 3000;
  return baseMs + Math.floor(Math.random() * variance * 2) - variance;
}

const STATUS = {
  BANNED: "BANNED",
  ACCESSIBLE: "ACCESSIBLE",
  RATE_LIMITED: "RATE_LIMITED",
  ERROR: "ERROR",
};

/**
 * Format a raw number into a readable string.
 * e.g. 1234567 → "1.2M", 45300 → "45.3K"
 */
function formatCount(n) {
  if (n === null || n === undefined) return "N/A";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

/**
 * Try to extract profile stats from the raw HTML of an Instagram profile page.
 * Instagram embeds a JSON blob in a <script> tag — we parse that.
 *
 * Returns:
 * {
 *   followers:    number | null,
 *   following:    number | null,
 *   posts:        number | null,
 *   displayName:  string | null,
 *   profilePicUrl: string | null,   ← full-size HD picture URL from the page
 *   isPrivate:    boolean,
 * }
 */
function extractProfileStats(html, username) {
  const stats = {
    followers: null,
    following: null,
    posts: null,
    displayName: null,
    profilePicUrl: null,
    isPrivate: false,
  };

  try {
    // ── Method 1: shared_data JSON blob (older Instagram pages) ─────────────
    const sharedDataMatch = html.match(/window\._sharedData\s*=\s*(\{.+?\});<\/script>/s);
    if (sharedDataMatch) {
      const json = JSON.parse(sharedDataMatch[1]);
      const user = json?.entry_data?.ProfilePage?.[0]?.graphql?.user;
      if (user) {
        stats.followers    = user.edge_followed_by?.count ?? null;
        stats.following    = user.edge_follow?.count       ?? null;
        stats.posts        = user.edge_owner_to_timeline_media?.count ?? null;
        stats.displayName  = user.full_name  || null;
        stats.profilePicUrl = user.profile_pic_url_hd || user.profile_pic_url || null;
        stats.isPrivate    = user.is_private ?? false;
        return stats;
      }
    }

    // ── Method 2: __additionalDataLoaded / push JSON (newer pages) ──────────
    const additionalMatch = html.match(/{"require":\[\["ScheduledServerJS".*?"user":\{(.+?)"id":"\d+"/s);
    if (additionalMatch) {
      // Try to grab individual fields from the raw JSON fragment
      const frag = additionalMatch[0];

      const followersM = frag.match(/"edge_followed_by":\{"count":(\d+)/);
      const followingM = frag.match(/"edge_follow":\{"count":(\d+)/);
      const postsM     = frag.match(/"edge_owner_to_timeline_media":\{"count":(\d+)/);
      const nameM      = frag.match(/"full_name":"([^"]+)"/);
      const picM       = frag.match(/"profile_pic_url_hd":"([^"]+)"/);
      const picFallM   = frag.match(/"profile_pic_url":"([^"]+)"/);
      const privateM   = frag.match(/"is_private":(true|false)/);

      if (followersM) stats.followers   = parseInt(followersM[1], 10);
      if (followingM) stats.following   = parseInt(followingM[1], 10);
      if (postsM)     stats.posts       = parseInt(postsM[1], 10);
      if (nameM)      stats.displayName = nameM[1].replace(/\\u([\dA-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      if (picM || picFallM) {
        // Instagram escapes forward slashes in JSON: \/  → /
        stats.profilePicUrl = (picM?.[1] || picFallM?.[1]).replace(/\\\//g, "/");
      }
      if (privateM)   stats.isPrivate   = privateM[1] === "true";

      if (stats.followers !== null) return stats; // got at least followers, good enough
    }

    // ── Method 3: meta tags as last resort (less data but reliable) ─────────
    const descM = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
               || html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (descM) {
      // Format: "123K Followers, 456 Following, 789 Posts - See Instagram..."
      const desc = descM[1];
      const fM = desc.match(/([\d,.]+[KMB]?)\s+Followers?/i);
      const gM = desc.match(/([\d,.]+[KMB]?)\s+Following/i);
      const pM = desc.match(/([\d,.]+[KMB]?)\s+Posts?/i);
      if (fM) stats.followers = parseAbbreviated(fM[1]);
      if (gM) stats.following = parseAbbreviated(gM[1]);
      if (pM) stats.posts     = parseAbbreviated(pM[1]);
    }

    // Profile pic from og:image meta tag
    const picMetaM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (picMetaM) stats.profilePicUrl = picMetaM[1];

    // Display name from og:title
    const titleM = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (titleM) {
      // Format: "Display Name (@username) • Instagram..."
      const nameMatch = titleM[1].match(/^(.+?)\s*\(@/);
      if (nameMatch) stats.displayName = nameMatch[1].trim();
    }

  } catch (e) {
    // Parsing failed silently — stats remain null
  }

  return stats;
}

/**
 * Parse abbreviated numbers like "1.2M", "45.3K", "1,234" → raw number
 */
function parseAbbreviated(str) {
  if (!str) return null;
  const clean = str.replace(/,/g, "");
  if (/B$/i.test(clean)) return Math.round(parseFloat(clean) * 1_000_000_000);
  if (/M$/i.test(clean)) return Math.round(parseFloat(clean) * 1_000_000);
  if (/K$/i.test(clean)) return Math.round(parseFloat(clean) * 1_000);
  return parseInt(clean, 10) || null;
}

/**
 * Check if an Instagram username is currently accessible.
 * When accessible, also returns profile stats.
 *
 * @param {string} username
 * @returns {{
 *   status: string,
 *   checkedAt: Date,
 *   detail: string,
 *   profile: {
 *     followers: number|null,
 *     following: number|null,
 *     posts: number|null,
 *     displayName: string|null,
 *     profilePicUrl: string|null,
 *     isPrivate: boolean
 *   } | null
 * }}
 */
async function checkAccount(username) {
  const url       = `https://www.instagram.com/${username}/`;
  const checkedAt = new Date();

  try {
    const response = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 3,
      headers: {
        "User-Agent": getNextUserAgent(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Cache-Control": "max-age=0",
      },
      validateStatus: () => true,
    });

    const { status: httpStatus, data } = response;

    if (httpStatus === 429) {
      return { status: STATUS.RATE_LIMITED, checkedAt, detail: "Rate limited by Instagram. Backing off.", profile: null };
    }

    if (httpStatus === 404) {
      return { status: STATUS.BANNED, checkedAt, detail: "Profile not found (404).", profile: null };
    }

    if (httpStatus === 200) {
      const isSorryPage =
        data.includes("Sorry, this page isn") ||
        data.includes("isn't available") ||
        data.includes("page not available");

      if (isSorryPage) {
        return { status: STATUS.BANNED, checkedAt, detail: "Page shows 'not available' message.", profile: null };
      }

      const hasProfile =
        data.includes(`"username":"${username}"`) ||
        data.includes(`/@${username}`) ||
        data.includes(`"ProfilePage"`) ||
        data.includes(`instagram.com/${username}`);

      if (hasProfile) {
        // ✅ Profile is live — extract stats from the page
        const profile = extractProfileStats(data, username);
        return { status: STATUS.ACCESSIBLE, checkedAt, detail: "Profile is publicly accessible.", profile };
      }

      return { status: STATUS.BANNED, checkedAt, detail: "Ambiguous response — treating as unavailable.", profile: null };
    }

    return { status: STATUS.BANNED, checkedAt, detail: `HTTP ${httpStatus}`, profile: null };

  } catch (err) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { status: STATUS.ERROR, checkedAt, detail: "Request timed out.", profile: null };
    }
    return { status: STATUS.ERROR, checkedAt, detail: err.message, profile: null };
  }
}

module.exports = { checkAccount, STATUS, jitter, formatCount };
