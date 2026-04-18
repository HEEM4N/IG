/**
 * store.js
 * Two databases:
 *   1. monitoring_base.json  — active accounts being tracked right now (200 slots)
 *   2. old_clients.json      — archived accounts: completed, removed, or resolved
 */

const fs   = require("fs");
const path = require("path");

const MONITORING_DB = path.join(__dirname, "monitoring_base.json");
const OLD_CLIENTS_DB = path.join(__dirname, "old_clients.json");
const PERMISSIONS_DB = path.join(__dirname, "permissions.json");

const MAX_ACTIVE = 200;

// ── File helpers ───────────────────────────────────────────────────────────
function loadFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return {}; }
}
function saveFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ── MONITORING BASE ────────────────────────────────────────────────────────
/**
 * Record shape:
 * {
 *   username        — Instagram handle
 *   addedAt         — ISO timestamp when added
 *   addedBy         — Discord user tag of who added it
 *   addedById       — Discord user ID of who added it
 *   mode            — "WATCH_FOR_BAN" (live → watching for ban/delete)
 *                     "WATCH_FOR_UNBAN" (banned → watching for recovery)
 *   initialStatus   — ACCESSIBLE | BANNED (status at time of adding)
 *   lastChecked     — ISO timestamp of last check
 *   lastStatus      — last known status
 *   checkCount      — total checks performed
 *   eventDetectedAt — ISO timestamp when ban/unban was detected
 *   active          — true while actively monitoring
 * }
 */
const monitoringBase = {
  getAll()    { return loadFile(MONITORING_DB); },
  getActive() {
    const all = loadFile(MONITORING_DB);
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v.active));
  },
  get(username) {
    return loadFile(MONITORING_DB)[username.toLowerCase()] || null;
  },

  add(username, discordUserTag, discordUserId, mode, initialStatus) {
    const all = loadFile(MONITORING_DB);
    const key = username.toLowerCase();
    if (all[key] && all[key].active) return { ok: false, reason: "already_monitored" };
    const activeCount = Object.values(all).filter((a) => a.active).length;
    if (activeCount >= MAX_ACTIVE) return { ok: false, reason: "max_reached" };

    all[key] = {
      username: key,
      addedAt: new Date().toISOString(),
      addedBy: discordUserTag,
      addedById: discordUserId,
      mode,
      initialStatus,
      lastChecked: null,
      lastStatus: initialStatus,
      checkCount: 0,
      eventDetectedAt: null,
      active: true,
    };
    saveFile(MONITORING_DB, all);
    return { ok: true };
  },

  update(username, fields) {
    const all = loadFile(MONITORING_DB);
    const key = username.toLowerCase();
    if (!all[key]) return;
    all[key] = { ...all[key], ...fields };
    saveFile(MONITORING_DB, all);
  },

  markInactive(username) {
    this.update(username, { active: false });
  },

  list() { return Object.values(loadFile(MONITORING_DB)); },
  listActive() { return Object.values(this.getActive()); },
  activeCount() { return Object.values(loadFile(MONITORING_DB)).filter((a) => a.active).length; },
};

// ── OLD CLIENTS ────────────────────────────────────────────────────────────
/**
 * Archive record shape (same fields + resolution info):
 * {
 *   ...all fields from monitoring_base record,
 *   archivedAt      — ISO timestamp when moved to archive
 *   archiveReason   — "BAN_DETECTED" | "UNBAN_DETECTED" | "MANUALLY_REMOVED"
 *   resolution      — human-readable summary
 *   timeTaken       — ms from addedAt → eventDetectedAt (or archival)
 * }
 */
const oldClients = {
  getAll()  { return loadFile(OLD_CLIENTS_DB); },
  get(username) { return loadFile(OLD_CLIENTS_DB)[username.toLowerCase()] || null; },

  archive(record, archiveReason, resolution) {
    const all = loadFile(OLD_CLIENTS_DB);
    const key = record.username.toLowerCase();
    const now = Date.now();
    const timeTaken = record.addedAt ? now - new Date(record.addedAt).getTime() : null;

    // Keep history: if username was archived before, store it under a timestamped key
    const archiveKey = all[key]
      ? `${key}_${new Date(record.addedAt).getTime()}`
      : key;

    all[archiveKey] = {
      ...record,
      active: false,
      archivedAt: new Date().toISOString(),
      archiveReason,
      resolution,
      timeTaken,
    };
    saveFile(OLD_CLIENTS_DB, all);
    return archiveKey;
  },

  list() { return Object.values(loadFile(OLD_CLIENTS_DB)); },
};

// ── PERMISSIONS ────────────────────────────────────────────────────────────
/**
 * Stores which Discord user IDs are allowed to use /monitor list
 * { ownerId: "...", allowedUsers: ["id1", "id2", ...] }
 */
const permissions = {
  load() { return loadFile(PERMISSIONS_DB); },
  save(data) { saveFile(PERMISSIONS_DB, data); },

  isOwner(userId) {
    const data = this.load();
    return data.ownerId === userId;
  },

  setOwner(userId) {
    const data = this.load();
    data.ownerId = userId;
    this.save(data);
  },

  canViewList(userId) {
    const data = this.load();
    if (!data.ownerId) return true; // no owner set yet, anyone can view
    if (data.ownerId === userId) return true;
    return Array.isArray(data.allowedUsers) && data.allowedUsers.includes(userId);
  },

  grantAccess(userId) {
    const data = this.load();
    if (!data.allowedUsers) data.allowedUsers = [];
    if (!data.allowedUsers.includes(userId)) data.allowedUsers.push(userId);
    this.save(data);
  },

  revokeAccess(userId) {
    const data = this.load();
    if (!data.allowedUsers) return;
    data.allowedUsers = data.allowedUsers.filter((id) => id !== userId);
    this.save(data);
  },

  listAllowed() {
    const data = this.load();
    return { ownerId: data.ownerId || null, allowedUsers: data.allowedUsers || [] };
  },
};

module.exports = { monitoringBase, oldClients, permissions, MAX_ACTIVE };
