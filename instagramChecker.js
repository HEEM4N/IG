/**
 * instagramChecker.js
 * Checks if an Instagram account is accessible (unbanned) via HikerAPI.
 * Also returns public profile stats: followers, following, post count,
 * display name, and profile picture URL.
 *
 * API: https://hikerapi.com
 * Endpoint: GET https://api.hikerapi.com/v1/user/by/username?username=<username>
 * Auth: x-access-key header (set HIKER_API_KEY in your .env)
 */

const axios = require("axios");

const HIKER_API_BASE = "https://api.hikerapi.com";
const HIKER_API_KEY  = process.env.HIKER_API_KEY;

function jitter(baseMs) {
  const variance = 5000;
  return baseMs + Math.floor(Math.random() * variance * 2) - variance;
}

const STATUS = {
  BANNED:       "BANNED",
  ACCESSIBLE:   "ACCESSIBLE",
  RATE_LIMITED: "RATE_LIMITED",
  ERROR:        "ERROR",
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
 * Check if an Instagram username is currently accessible via HikerAPI.
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
  const checkedAt = new Date();

  if (!HIKER_API_KEY) {
    return {
      status: STATUS.ERROR,
      checkedAt,
      detail: "HIKER_API_KEY is not set in environment variables.",
      profile: null,
    };
  }

  try {
    const response = await axios.get(`${HIKER_API_BASE}/v1/user/by/username`, {
      params:  { username },
      headers: { "x-access-key": HIKER_API_KEY },
      timeout: 15000,
      validateStatus: () => true,
    });

    const { status: httpStatus, data } = response;

    // ── Rate limited ──────────────────────────────────────────────────────
    if (httpStatus === 429) {
      return {
        status: STATUS.RATE_LIMITED,
        checkedAt,
        detail: "Rate limited by HikerAPI. Backing off.",
        profile: null,
      };
    }

    // ── Unauthorized ──────────────────────────────────────────────────────
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        status: STATUS.ERROR,
        checkedAt,
        detail: `HikerAPI auth error (HTTP ${httpStatus}). Check your HIKER_API_KEY.`,
        profile: null,
      };
    }

    // ── Account not found / banned ─────────────────────────────────────────
    if (httpStatus === 404) {
      return {
        status: STATUS.BANNED,
        checkedAt,
        detail: "Account not found via HikerAPI (404) — likely banned or deleted.",
        profile: null,
      };
    }

    // ── Successful response ────────────────────────────────────────────────
    if (httpStatus === 200 && data && data.username) {
      const profile = {
        followers:    data.follower_count    ?? null,
        following:    data.following_count   ?? null,
        posts:        data.media_count       ?? null,
        displayName:  data.full_name         || null,
        profilePicUrl: data.profile_pic_url  || null,
        isPrivate:    data.is_private        ?? false,
      };

      return {
        status: STATUS.ACCESSIBLE,
        checkedAt,
        detail: "Profile is publicly accessible.",
        profile,
      };
    }

    // ── API returned 200 but empty/null user ───────────────────────────────
    if (httpStatus === 200 && (!data || !data.username)) {
      return {
        status: STATUS.BANNED,
        checkedAt,
        detail: "HikerAPI returned empty user — account likely banned or deleted.",
        profile: null,
      };
    }

    // ── Unexpected response ────────────────────────────────────────────────
    return {
      status: STATUS.ERROR,
      checkedAt,
      detail: `Unexpected HTTP ${httpStatus} from HikerAPI.`,
      profile: null,
    };

  } catch (err) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { status: STATUS.ERROR, checkedAt, detail: "Request to HikerAPI timed out.", profile: null };
    }
    return { status: STATUS.ERROR, checkedAt, detail: err.message, profile: null };
  }
}

module.exports = { checkAccount, STATUS, jitter, formatCount };
