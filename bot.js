/**
 * bot.js — Instagram Account Monitor (v5)
 *
 * Commands:
 *   /help                        — How to use the bot (visible to everyone)
 *   /monitor add <username>      — Auto-detects live/banned and monitors accordingly
 *   /monitor list                — Active watching list (owner + permitted users only)
 *   /monitor status <username>   — Live status check
 *   /monitor remove <username>   — Remove + archive to Old Clients
 *   /monitor grant <user>        — Owner only: grant access
 *   /monitor revoke <user>       — Owner only: revoke access
 *
 * v5 additions:
 *   — ADMIN LOG CHANNEL: Every command any user runs, every bot reply, and every
 *     ban/unban notification is silently mirrored to a private admin-only channel.
 *     Only owner + granted users can see it (set LOG_CHANNEL_ID in .env).
 *   — /help command: shows all user-facing commands with descriptions.
 */

require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  Events,
} = require("discord.js");

const { monitoringBase, oldClients, permissions, MAX_ACTIVE } = require("./store");
const { checkAccount, STATUS, jitter, formatCount } = require("./instagramChecker");

// ── Env validation ─────────────────────────────────────────────────────────
const REQUIRED_ENV = ["DISCORD_TOKEN", "DISCORD_CHANNEL_ID", "DISCORD_GUILD_ID"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key] || process.env[key].includes("your_")) {
    console.error(`❌  Missing env var: ${key}. Edit your .env file.`);
    process.exit(1);
  }
}
if (!process.env.LOG_CHANNEL_ID || process.env.LOG_CHANNEL_ID.includes("your_")) {
  console.warn("⚠️  LOG_CHANNEL_ID not set — admin activity logging is disabled.");
}

const TOKEN          = process.env.DISCORD_TOKEN;
const CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID;
const GUILD_ID       = process.env.DISCORD_GUILD_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;
const BASE_INTERVAL  = parseInt(process.env.CHECK_INTERVAL_MS || "12000", 10);

// ── Discord client ─────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Slash command definitions ──────────────────────────────────────────────
const userOpt   = (opt) => opt.setName("username").setDescription("Instagram username (without @)").setRequired(true);
const memberOpt = (opt) => opt.setName("user").setDescription("Discord user to grant/revoke access").setRequired(true);

const commands = [
  // /help — visible to everyone
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("How to use the Instagram Monitor bot")
    .toJSON(),

  // /monitor — main command
  new SlashCommandBuilder()
    .setName("monitor")
    .setDescription("Instagram account monitor — track bans and recoveries")
    .addSubcommand((s) => s.setName("add")    .setDescription("Add an Instagram account to monitor").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("list")   .setDescription("Show currently active watching list"))
    .addSubcommand((s) => s.setName("status") .setDescription("Check the current status of a monitored account").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("remove") .setDescription("Stop monitoring an account").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("grant")  .setDescription("(Owner) Grant a user access").addUserOption(memberOpt))
    .addSubcommand((s) => s.setName("revoke") .setDescription("(Owner) Revoke a user's access").addUserOption(memberOpt))
    .toJSON(),
];

// ── Register slash commands ────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("📡 Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ADMIN ACTIVITY LOG
// Silently mirrors all user commands + bot responses + ban/unban alerts
// to the private LOG_CHANNEL_ID. Only owner + granted users should have
// read access to that channel in Discord's channel permission settings.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Send a log entry to the admin log channel.
 *
 * @param {Object} opts
 * @param {"COMMAND"|"BOT_RESPONSE"|"ALERT"|"SYSTEM"} opts.type
 * @param {string}  opts.title       — Short title shown in embed
 * @param {string}  opts.description — Full detail text
 * @param {number}  [opts.color]     — Embed colour (defaults per type)
 * @param {Object}  [opts.user]      — Discord user object who ran the command
 * @param {string}  [opts.guild]     — Guild/channel context string
 * @param {Array}   [opts.fields]    — Extra embed fields
 */
async function adminLog({ type, title, description, color, user, guild, fields = [] }) {
  if (!LOG_CHANNEL_ID) return; // logging disabled
  const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!logChannel) return;

  const typeColors = {
    COMMAND:      0x5865f2, // indigo  — user ran a command
    BOT_RESPONSE: 0x36393f, // dark    — what the bot replied
    ALERT:        0xff9900, // orange  — ban/unban notification sent
    SYSTEM:       0x888888, // grey    — bot startup / resume
  };

  const typeLabels = {
    COMMAND:      "📥 USER COMMAND",
    BOT_RESPONSE: "📤 BOT RESPONSE",
    ALERT:        "🔔 ALERT SENT",
    SYSTEM:       "⚙️ SYSTEM",
  };

  const embed = new EmbedBuilder()
    .setColor(color ?? typeColors[type] ?? 0x888888)
    .setTitle(`${typeLabels[type] ?? type} — ${title}`)
    .setDescription(description || "_no detail_")
    .setTimestamp();

  if (user) {
    embed.setAuthor({
      name: `${user.tag} (ID: ${user.id})`,
      iconURL: user.displayAvatarURL?.() || undefined,
    });
  }

  if (guild) embed.setFooter({ text: guild });

  if (fields.length) embed.addFields(fields);

  await logChannel.send({ embeds: [embed] }).catch((e) =>
    console.error("Admin log send failed:", e.message)
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!ms || ms < 0) return "unknown";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function tsField(isoString) {
  if (!isoString) return "Never";
  return `<t:${Math.floor(new Date(isoString).getTime() / 1000)}:F>`;
}

function tsRelative(isoString) {
  if (!isoString) return "Never";
  return `<t:${Math.floor(new Date(isoString).getTime() / 1000)}:R>`;
}

function validateUsername(username) {
  return /^[a-zA-Z0-9._]{1,30}$/.test(username);
}

function getAlertMentionIds(account) {
  const { ownerId, allowedUsers } = permissions.listAllowed();
  const ids = new Set();
  if (account.addedById) ids.add(account.addedById);
  if (ownerId) ids.add(ownerId);
  if (Array.isArray(allowedUsers)) allowedUsers.forEach((id) => ids.add(id));
  return [...ids];
}

function resolveProfilePic(username, scrapedUrl) {
  return scrapedUrl || `https://unavatar.io/instagram/${username}`;
}

function buildProfileFields(profile, label = "📸 Last Known Profile Stats") {
  if (!profile || (profile.followers === null && profile.following === null)) {
    return [{ name: label, value: "_Stats unavailable — Instagram did not expose public data._", inline: false }];
  }
  const lines = [];
  if (profile.displayName) lines.push(`**Name:** ${profile.displayName}`);
  lines.push(`**👥 Followers:** ${formatCount(profile.followers) ?? "N/A"}`);
  lines.push(`**➡️ Following:** ${formatCount(profile.following) ?? "N/A"}`);
  if (profile.posts !== null) lines.push(`**🖼️ Posts:** ${formatCount(profile.posts)}`);
  if (profile.isPrivate) lines.push(`**🔒 Account Type:** Private`);
  return [{ name: label, value: lines.join("\n"), inline: false }];
}

// ── Notification: LIVE account just got BANNED ────────────────────────────
async function notifyAccountBanned(username, account) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const now           = Date.now();
  const timeTaken     = account.addedAt ? formatDuration(now - new Date(account.addedAt).getTime()) : "unknown";
  const bannedAt      = new Date(now).toISOString();
  const mentionIds    = getAlertMentionIds(account);
  const pings         = mentionIds.map((id) => `<@${id}>`).join(" ");
  const adderPing     = account.addedById ? `<@${account.addedById}>` : `**${account.addedBy}**`;
  const cachedProfile = account.cachedProfile || null;
  const picUrl        = resolveProfilePic(username, cachedProfile?.profilePicUrl);

  const embed = new EmbedBuilder()
    .setColor(0xff2200)
    .setTitle("🚨  Target Account Has Been Banned!")
    .setDescription(`Hey ${adderPing}!\n\nYour target **@${username}** has just been **BANNED / DELETED** from Instagram.`)
    .setThumbnail(picUrl)
    .addFields(
      { name: "🎯 Target Account",    value: `[@${username}](https://instagram.com/${username})`, inline: true  },
      { name: "👤 Added By",          value: account.addedBy,                                     inline: true  },
      { name: "🕐 Banned At",         value: tsField(bannedAt),                                   inline: false },
      { name: "⏱️ Time Taken to Ban", value: timeTaken,                                           inline: true  },
      { name: "🔢 Total Checks Done", value: account.checkCount.toLocaleString(),                 inline: true  },
      ...buildProfileFields(cachedProfile, "📸 Profile Stats at Time of Ban"),
    )
    .setFooter({ text: "Instagram Monitor • Archived to Old Clients automatically" })
    .setTimestamp();

  await channel.send({ content: pings, embeds: [embed], allowedMentions: { users: mentionIds } });

  // ── Admin log: alert was sent ───────────────────────────────────────────
  await adminLog({
    type: "ALERT",
    title: `@${username} — BANNED`,
    color: 0xff2200,
    description:
      `🚨 **Ban detected** for \`@${username}\`.\n` +
      `Notification sent to: ${pings}\n\n` +
      `**Added by:** ${account.addedBy} (ID: \`${account.addedById ?? "unknown"}\`)\n` +
      `**Banned at:** ${new Date(bannedAt).toUTCString()}\n` +
      `**Time taken:** ${timeTaken}\n` +
      `**Checks done:** ${account.checkCount.toLocaleString()}`,
    fields: buildProfileFields(cachedProfile, "📸 Profile Stats at Ban"),
  });
}

// ── Notification: BANNED account just got UNBANNED ────────────────────────
async function notifyAccountUnbanned(username, account, freshProfile) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const now        = Date.now();
  const timeTaken  = account.addedAt ? formatDuration(now - new Date(account.addedAt).getTime()) : "unknown";
  const unbannedAt = new Date(now).toISOString();
  const mentionIds = getAlertMentionIds(account);
  const pings      = mentionIds.map((id) => `<@${id}>`).join(" ");
  const adderPing  = account.addedById ? `<@${account.addedById}>` : `**${account.addedBy}**`;
  const picUrl     = resolveProfilePic(username, freshProfile?.profilePicUrl);

  const embed = new EmbedBuilder()
    .setColor(0x00ff88)
    .setTitle("✅  Client Account Has Been Recovered!")
    .setDescription(`Hey ${adderPing}!\n\nYour client's account **@${username}** is now **UN-BANNED** and back on Instagram! 🎉`)
    .setThumbnail(picUrl)
    .addFields(
      { name: "🎯 Client Account",      value: `[@${username}](https://instagram.com/${username})`, inline: true  },
      { name: "👤 Added By",            value: account.addedBy,                                     inline: true  },
      { name: "🕐 Unbanned At",         value: tsField(unbannedAt),                                 inline: false },
      { name: "⏱️ Time Taken to Unban", value: timeTaken,                                           inline: true  },
      { name: "🔢 Total Checks Done",   value: account.checkCount.toLocaleString(),                 inline: true  },
      ...buildProfileFields(freshProfile, "📸 Current Profile Stats"),
    )
    .setFooter({ text: "Instagram Monitor • Archived to Old Clients automatically" })
    .setTimestamp();

  await channel.send({ content: pings, embeds: [embed], allowedMentions: { users: mentionIds } });

  // ── Admin log: alert was sent ───────────────────────────────────────────
  await adminLog({
    type: "ALERT",
    title: `@${username} — UNBANNED / RECOVERED`,
    color: 0x00ff88,
    description:
      `✅ **Unban detected** for \`@${username}\`.\n` +
      `Notification sent to: ${pings}\n\n` +
      `**Added by:** ${account.addedBy} (ID: \`${account.addedById ?? "unknown"}\`)\n` +
      `**Unbanned at:** ${new Date(unbannedAt).toUTCString()}\n` +
      `**Time taken:** ${timeTaken}\n` +
      `**Checks done:** ${account.checkCount.toLocaleString()}`,
    fields: buildProfileFields(freshProfile, "📸 Profile Stats at Recovery"),
  });
}

// ── Archive helpers ────────────────────────────────────────────────────────
function archiveRecord(record, reason) {
  const timeTaken  = record.addedAt ? Date.now() - new Date(record.addedAt).getTime() : null;
  const resolution =
    reason === "BAN_DETECTED"     ? `Banned after ${formatDuration(timeTaken)} of monitoring.` :
    reason === "UNBAN_DETECTED"   ? `Recovered after ${formatDuration(timeTaken)} of monitoring.` :
    reason === "MANUALLY_REMOVED" ? "Manually removed from monitoring." : "Archived.";
  oldClients.archive(record, reason, resolution);
}

function archiveAndStop(username, reason) {
  stopMonitoring(username);
  const record = monitoringBase.get(username);
  if (record) {
    archiveRecord(record, reason);
    monitoringBase.update(username, { active: false });
  }
}

// ── Monitor loops ──────────────────────────────────────────────────────────
const activeTimers = {};

async function scheduleCheck(username) {
  const account = monitoringBase.get(username);
  if (!account || !account.active) return;

  activeTimers[username] = setTimeout(async () => {
    const result = await checkAccount(username);
    const prev   = monitoringBase.get(username);
    if (!prev || !prev.active) return;

    const updates = {
      lastChecked: result.checkedAt.toISOString(),
      lastStatus:  result.status,
      checkCount:  (prev.checkCount || 0) + 1,
    };
    if (prev.mode === "WATCH_FOR_BAN" && result.status === STATUS.ACCESSIBLE && result.profile) {
      updates.cachedProfile = result.profile;
    }
    monitoringBase.update(username, updates);

    console.log(`[${new Date().toLocaleTimeString()}] @${username} (${prev.mode}) → ${result.status}`);

    if (result.status === STATUS.RATE_LIMITED) {
      console.warn(`⚠️  Rate limited on @${username}. Backing off 60s.`);
      activeTimers[username] = setTimeout(() => scheduleCheck(username), 60000);
      return;
    }
    if (result.status === STATUS.ERROR) { scheduleCheck(username); return; }

    const updated = monitoringBase.get(username);

    if (updated.mode === "WATCH_FOR_BAN" && result.status === STATUS.BANNED) {
      monitoringBase.update(username, { active: false, eventDetectedAt: result.checkedAt.toISOString(), lastStatus: STATUS.BANNED });
      const finalRecord = monitoringBase.get(username);
      archiveRecord(finalRecord, "BAN_DETECTED");
      await notifyAccountBanned(username, finalRecord);
      return;
    }

    if (updated.mode === "WATCH_FOR_UNBAN" && result.status === STATUS.ACCESSIBLE) {
      monitoringBase.update(username, { active: false, eventDetectedAt: result.checkedAt.toISOString(), lastStatus: STATUS.ACCESSIBLE, cachedProfile: result.profile });
      const finalRecord = monitoringBase.get(username);
      archiveRecord(finalRecord, "UNBAN_DETECTED");
      await notifyAccountUnbanned(username, finalRecord, result.profile);
      return;
    }

    scheduleCheck(username);
  }, jitter(BASE_INTERVAL));
}

function startMonitoring(username) {
  if (activeTimers[username]) clearTimeout(activeTimers[username]);
  scheduleCheck(username);
}

function stopMonitoring(username) {
  if (activeTimers[username]) { clearTimeout(activeTimers[username]); delete activeTimers[username]; }
}

function resumeAll() {
  const active = Object.keys(monitoringBase.getActive());
  if (active.length) {
    console.log(`▶️  Resuming monitoring for: ${active.join(", ")}`);
    active.forEach(startMonitoring);
    adminLog({ type: "SYSTEM", title: "Bot Restarted — Monitoring Resumed", description: `Resumed monitoring for **${active.length}** account(s): ${active.map((u) => `\`@${u}\``).join(", ")}` });
  } else {
    console.log("📭 No active accounts to resume.");
    adminLog({ type: "SYSTEM", title: "Bot Started", description: "No active accounts in Monitoring Base. Ready for new entries." });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// INTERACTION HANDLER
// ══════════════════════════════════════════════════════════════════════════
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /help ──────────────────────────────────────────────────────────────
  if (commandName === "help") {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📖  Instagram Monitor — Help")
      .setDescription(
        "This bot monitors Instagram accounts and alerts you the moment they get **banned** or **unbanned**.\n" +
        "Simply add an account and the bot handles everything automatically."
      )
      .addFields(
        {
          name: "➕  `/monitor add <username>`",
          value:
            "Add an Instagram account to monitor.\n" +
            "• If the account is **live**, the bot watches for it getting banned/deleted.\n" +
            "• If the account is **already banned**, the bot watches for it coming back.\n" +
            "_The bot auto-detects which mode to use — just add the username._",
          inline: false,
        },
        {
          name: "📋  `/monitor list`",
          value:
            "Shows all accounts currently being actively monitored, their status, who added them, and how long they've been watched.\n" +
            "_Access is restricted to permitted users only._",
          inline: false,
        },
        {
          name: "🔍  `/monitor status <username>`",
          value:
            "Runs an immediate live check on a monitored account right now and shows you its current status, profile stats, and check history.",
          inline: false,
        },
        {
          name: "🗑️  `/monitor remove <username>`",
          value:
            "Stops monitoring an account and moves it to the archived Old Clients database. The history is kept permanently.",
          inline: false,
        },
        {
          name: "🔔  How notifications work",
          value:
            "When a **ban** or **unban** is detected, the bot sends an alert in the notification channel that includes:\n" +
            "• The exact time of the event\n" +
            "• How long it took from when you added it\n" +
            "• Follower count, following count, post count\n" +
            "• Profile picture\n" +
            "The message stays in the channel permanently.",
          inline: false,
        },
        {
          name: "⚠️  Accuracy note",
          value:
            "The bot checks every ~12 seconds using Instagram's public page. No login is required. " +
            "Accuracy is ~95% — Instagram occasionally returns ambiguous pages.",
          inline: false,
        },
      )
      .setFooter({ text: "Instagram Monitor • Use /monitor add <username> to get started" })
      .setTimestamp();

    // Log the /help command usage
    await adminLog({
      type: "COMMAND",
      title: "/help",
      description: `<@${interaction.user.id}> used \`/help\``,
      user: interaction.user,
      guild: `Server: ${interaction.guild?.name ?? "DM"} | Channel: #${interaction.channel?.name ?? "unknown"}`,
    });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── All /monitor subcommands ───────────────────────────────────────────
  if (commandName !== "monitor") return;

  const sub      = interaction.options.getSubcommand();
  const rawUser  = interaction.options.getString("username") || "";
  const username = rawUser.toLowerCase().replace(/^@/, "");

  // Shared context string for log footer
  const logContext = `Server: ${interaction.guild?.name ?? "DM"} | Channel: #${interaction.channel?.name ?? "unknown"}`;

  // ── /monitor grant ─────────────────────────────────────────────────────
  if (sub === "grant") {
    const perms = permissions.load();
    if (!perms.ownerId) {
      permissions.setOwner(interaction.user.id);
    } else if (!permissions.isOwner(interaction.user.id)) {
      await adminLog({
        type: "COMMAND",
        title: "/monitor grant — DENIED",
        description: `<@${interaction.user.id}> tried to use \`/monitor grant\` but is **not the owner**. Access denied.`,
        color: 0xff4444,
        user: interaction.user,
        guild: logContext,
      });
      return interaction.reply({ content: "❌ Only the **owner** can grant access.", ephemeral: true });
    }
    const target = interaction.options.getUser("user");
    permissions.grantAccess(target.id);

    await adminLog({
      type: "COMMAND",
      title: "/monitor grant",
      description: `<@${interaction.user.id}> granted access to <@${target.id}> (\`${target.tag}\`).\nThey can now use \`/monitor list\` and will be pinged on all alerts.`,
      user: interaction.user,
      guild: logContext,
    });

    return interaction.reply({ content: `✅ **${target.tag}** can now use \`/monitor list\` and will be pinged on all ban/unban alerts.`, ephemeral: true });
  }

  // ── /monitor revoke ────────────────────────────────────────────────────
  if (sub === "revoke") {
    if (!permissions.isOwner(interaction.user.id)) {
      await adminLog({
        type: "COMMAND",
        title: "/monitor revoke — DENIED",
        description: `<@${interaction.user.id}> tried to use \`/monitor revoke\` but is **not the owner**. Access denied.`,
        color: 0xff4444,
        user: interaction.user,
        guild: logContext,
      });
      return interaction.reply({ content: "❌ Only the **owner** can revoke access.", ephemeral: true });
    }
    const target = interaction.options.getUser("user");
    permissions.revokeAccess(target.id);

    await adminLog({
      type: "COMMAND",
      title: "/monitor revoke",
      description: `<@${interaction.user.id}> revoked access from <@${target.id}> (\`${target.tag}\`).\nThey can no longer use \`/monitor list\` and will not be pinged on alerts.`,
      user: interaction.user,
      guild: logContext,
    });

    return interaction.reply({ content: `🚫 **${target.tag}** no longer has access to \`/monitor list\` and will no longer be pinged on alerts.`, ephemeral: true });
  }

  // ── /monitor add ───────────────────────────────────────────────────────
  if (sub === "add") {
    if (!validateUsername(username)) {
      await adminLog({
        type: "COMMAND",
        title: "/monitor add — INVALID USERNAME",
        description: `<@${interaction.user.id}> tried to add \`${username || "(empty)"}\` — invalid format, rejected.`,
        color: 0xff4444,
        user: interaction.user,
        guild: logContext,
      });
      return interaction.reply({ content: "❌ Invalid Instagram username. Use only letters, numbers, `.` and `_`.", ephemeral: true });
    }

    if (monitoringBase.get(username)?.active) {
      await adminLog({
        type: "COMMAND",
        title: "/monitor add — ALREADY MONITORED",
        description: `<@${interaction.user.id}> tried to add \`@${username}\` but it's already being monitored.`,
        color: 0xffaa00,
        user: interaction.user,
        guild: logContext,
      });
      return interaction.reply({ content: `⚠️ **@${username}** is already being monitored.`, ephemeral: true });
    }

    if (monitoringBase.activeCount() >= MAX_ACTIVE) {
      await adminLog({
        type: "COMMAND",
        title: "/monitor add — SLOTS FULL",
        description: `<@${interaction.user.id}> tried to add \`@${username}\` but the Monitoring Base is full (${MAX_ACTIVE} slots).`,
        color: 0xff4444,
        user: interaction.user,
        guild: logContext,
      });
      return interaction.reply({ content: `❌ Monitoring Base is full (${MAX_ACTIVE} slots). Remove an account first.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const firstCheck = await checkAccount(username);
    const mode       = firstCheck.status === STATUS.ACCESSIBLE ? "WATCH_FOR_BAN" : "WATCH_FOR_UNBAN";

    const added = monitoringBase.add(username, interaction.user.tag, interaction.user.id, mode,
      firstCheck.status === STATUS.ACCESSIBLE ? "ACCESSIBLE" : "BANNED");

    if (!added.ok) {
      if (added.reason === "already_monitored") return interaction.editReply({ content: `⚠️ **@${username}** is already being monitored.` });
      if (added.reason === "max_reached")       return interaction.editReply({ content: `❌ Monitoring Base is full (${MAX_ACTIVE} slots).` });
    }

    monitoringBase.update(username, {
      lastChecked: firstCheck.checkedAt.toISOString(),
      lastStatus:  firstCheck.status,
      checkCount:  1,
      cachedProfile: firstCheck.profile || null,
    });

    startMonitoring(username);

    const picUrl = resolveProfilePic(username, firstCheck.profile?.profilePicUrl);
    const modeText = mode === "WATCH_FOR_BAN"
      ? "Account is **LIVE** — watching for ban/deletion"
      : "Account is **BANNED** — watching for recovery/unban";

    let embed;
    if (mode === "WATCH_FOR_BAN") {
      embed = new EmbedBuilder()
        .setColor(0x00cc55)
        .setTitle("🟢  Account Is Live — Monitoring for Ban")
        .setThumbnail(picUrl)
        .setDescription(`**@${username}** is currently **LIVE** on Instagram.\n\nYou'll be notified the moment this account gets **banned or deactivated**.`)
        .addFields(
          { name: "🎯 Target",         value: `[@${username}](https://instagram.com/${username})`, inline: true },
          { name: "📊 Current Status", value: "🟢 LIVE / ACCESSIBLE",                             inline: true },
          { name: "👤 Added By",       value: interaction.user.tag,                                inline: true },
          { name: "🔔 Watching For",   value: "Ban / Deletion / Deactivation",                    inline: false },
          ...buildProfileFields(firstCheck.profile, "📸 Current Profile Stats"),
        )
        .setFooter({ text: "Instagram Monitor • Monitoring Base" })
        .setTimestamp();
    } else {
      embed = new EmbedBuilder()
        .setColor(0xff4444)
        .setTitle("🔴  Account Is Banned — Monitoring for Recovery")
        .setThumbnail(picUrl)
        .setDescription(`**@${username}** is currently **BANNED** on Instagram.\n\nYou'll be notified the moment this account gets **un-banned or recovered**.`)
        .addFields(
          { name: "🎯 Client Account", value: `[@${username}](https://instagram.com/${username})`, inline: true },
          { name: "📊 Current Status", value: "🔴 BANNED",                                        inline: true },
          { name: "👤 Added By",       value: interaction.user.tag,                                inline: true },
          { name: "🔔 Watching For",   value: "Unban / Account Recovery",                         inline: false },
          { name: "📸 Profile Stats",  value: "_Not available — account is currently banned._",   inline: false },
        )
        .setFooter({ text: "Instagram Monitor • Monitoring Base" })
        .setTimestamp();
    }

    // ── Admin log ─────────────────────────────────────────────────────────
    await adminLog({
      type: "COMMAND",
      title: `/monitor add — @${username}`,
      description:
        `<@${interaction.user.id}> added \`@${username}\` to the Monitoring Base.\n\n` +
        `**Mode:** ${modeText}\n` +
        `**Initial status:** ${firstCheck.status}\n` +
        `**Slots used:** ${monitoringBase.activeCount()}/${MAX_ACTIVE}`,
      color: mode === "WATCH_FOR_BAN" ? 0x00cc55 : 0xff4444,
      user: interaction.user,
      guild: logContext,
      fields: buildProfileFields(firstCheck.profile, "📸 Profile Stats at Add Time"),
    });

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /monitor list ──────────────────────────────────────────────────────
  if (sub === "list") {
    if (!permissions.canViewList(interaction.user.id)) {
      await adminLog({
        type: "COMMAND",
        title: "/monitor list — ACCESS DENIED",
        description: `<@${interaction.user.id}> tried to use \`/monitor list\` but does **not have permission**.`,
        color: 0xff4444,
        user: interaction.user,
        guild: logContext,
      });
      return interaction.reply({ content: "🔒 You don't have permission to view the monitor list. Ask the owner to run `/monitor grant @you`.", ephemeral: true });
    }

    const active = monitoringBase.listActive();

    if (!active.length) {
      await adminLog({
        type: "COMMAND",
        title: "/monitor list — EMPTY",
        description: `<@${interaction.user.id}> viewed the monitor list — no active accounts.`,
        user: interaction.user,
        guild: logContext,
      });
      return interaction.reply({ content: "📭 No accounts are currently being monitored. Use `/monitor add <username>` to get started.", ephemeral: true });
    }

    const watchingBan   = active.filter((a) => a.mode === "WATCH_FOR_BAN");
    const watchingUnban = active.filter((a) => a.mode === "WATCH_FOR_UNBAN");

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📡  Active Monitoring List")
      .setDescription(`**${active.length}** account(s) currently being watched — **${active.length}/${MAX_ACTIVE}** slots used.`)
      .setFooter({ text: "Instagram Monitor • Active Only" })
      .setTimestamp();

    if (watchingBan.length) {
      embed.addFields({
        name: `🟢 LIVE — Watching for Ban (${watchingBan.length})`,
        value: watchingBan.map((a) => {
          const f = a.cachedProfile?.followers != null ? ` · ${formatCount(a.cachedProfile.followers)} followers` : "";
          return `🟢 **@${a.username}**${f}\n┣ Added by: \`${a.addedBy}\`\n┣ Added: ${tsRelative(a.addedAt)}\n┗ Checks so far: ${a.checkCount.toLocaleString()}`;
        }).join("\n\n"),
      });
    }

    if (watchingUnban.length) {
      embed.addFields({
        name: `🔴 BANNED — Watching for Recovery (${watchingUnban.length})`,
        value: watchingUnban.map((a) =>
          `🔴 **@${a.username}**\n┣ Added by: \`${a.addedBy}\`\n┣ Added: ${tsRelative(a.addedAt)}\n┗ Checks so far: ${a.checkCount.toLocaleString()}`
        ).join("\n\n"),
      });
    }

    // ── Admin log ─────────────────────────────────────────────────────────
    await adminLog({
      type: "COMMAND",
      title: "/monitor list — VIEWED",
      description:
        `<@${interaction.user.id}> viewed the active monitoring list.\n\n` +
        `**Total active:** ${active.length}/${MAX_ACTIVE}\n` +
        `**Watching for ban:** ${watchingBan.length}\n` +
        `**Watching for unban:** ${watchingUnban.length}\n\n` +
        `**Accounts:** ${active.map((a) => `\`@${a.username}\``).join(", ")}`,
      user: interaction.user,
      guild: logContext,
    });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /monitor status ────────────────────────────────────────────────────
  if (sub === "status") {
    if (!username)
      return interaction.reply({ content: "❌ Please provide an Instagram username.", ephemeral: true });

    const account = monitoringBase.get(username);
    if (!account) {
      await adminLog({
        type: "COMMAND",
        title: `/monitor status — @${username} NOT FOUND`,
        description: `<@${interaction.user.id}> ran \`/monitor status ${username}\` but that account is not in the Monitoring Base.`,
        color: 0xff4444,
        user: interaction.user,
        guild: logContext,
      });
      return interaction.reply({ content: `❌ **@${username}** is not in the active Monitoring Base.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const result = await checkAccount(username);
    const profileUpdate = result.profile ? { cachedProfile: result.profile } : {};
    monitoringBase.update(username, {
      lastChecked: result.checkedAt.toISOString(),
      lastStatus:  result.status,
      checkCount:  (account.checkCount || 0) + 1,
      ...profileUpdate,
    });

    const updated   = monitoringBase.get(username);
    const color     = result.status === STATUS.ACCESSIBLE ? 0x00ff88 : result.status === STATUS.RATE_LIMITED ? 0xffcc00 : 0xff4444;
    const modeLabel = updated.mode === "WATCH_FOR_BAN" ? "🟢 Watching for Ban/Deletion" : "🔴 Watching for Unban/Recovery";
    const sEmoji    = { BANNED: "🔴", ACCESSIBLE: "🟢", RATE_LIMITED: "🟡", ERROR: "⚠️" };
    const picUrl    = resolveProfilePic(username, updated.cachedProfile?.profilePicUrl);

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`📊 Status Check — @${username}`)
      .setThumbnail(picUrl)
      .addFields(
        { name: "📊 Current Status",  value: `${sEmoji[result.status] || "⏳"} ${result.status}`, inline: true  },
        { name: "🎯 Monitor Mode",    value: modeLabel,                                             inline: true  },
        { name: "👤 Added By",        value: updated.addedBy,                                       inline: true  },
        { name: "🔢 Total Checks",    value: updated.checkCount.toLocaleString(),                   inline: true  },
        { name: "📅 Added",           value: tsField(updated.addedAt),                              inline: true  },
        { name: "🕐 Last Checked",    value: tsField(updated.lastChecked),                          inline: true  },
        { name: "🔍 Detail",          value: result.detail,                                         inline: false },
        ...buildProfileFields(updated.cachedProfile, "📸 Profile Stats"),
      )
      .setFooter({ text: "Instagram Monitor • Monitoring Base" })
      .setTimestamp();

    // ── Admin log ─────────────────────────────────────────────────────────
    await adminLog({
      type: "COMMAND",
      title: `/monitor status — @${username}`,
      description:
        `<@${interaction.user.id}> ran a manual status check on \`@${username}\`.\n\n` +
        `**Result:** ${sEmoji[result.status] ?? "⏳"} ${result.status}\n` +
        `**Detail:** ${result.detail}\n` +
        `**Mode:** ${modeLabel}\n` +
        `**Total checks:** ${updated.checkCount.toLocaleString()}`,
      color,
      user: interaction.user,
      guild: logContext,
      fields: buildProfileFields(updated.cachedProfile, "📸 Profile Stats"),
    });

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /monitor remove ────────────────────────────────────────────────────
  if (sub === "remove") {
    if (!username)
      return interaction.reply({ content: "❌ Please provide an Instagram username.", ephemeral: true });

    const account = monitoringBase.get(username);
    if (!account) {
      await adminLog({
        type: "COMMAND",
        title: `/monitor remove — @${username} NOT FOUND`,
        description: `<@${interaction.user.id}> tried to remove \`@${username}\` but it's not in the Monitoring Base.`,
        color: 0xff4444,
        user: interaction.user,
        guild: logContext,
      });
      return interaction.reply({ content: `❌ **@${username}** is not in the active Monitoring Base.`, ephemeral: true });
    }

    archiveAndStop(username, "MANUALLY_REMOVED");

    const embed = new EmbedBuilder()
      .setColor(0x888888)
      .setTitle("🗑️  Account Removed & Archived")
      .setDescription(`**@${username}** has been removed from active monitoring and saved to the **Old Clients** archive.`)
      .addFields(
        { name: "👤 Was Added By", value: account.addedBy,          inline: true },
        { name: "📅 Was Added On", value: tsField(account.addedAt), inline: true },
        { name: "🔢 Total Checks", value: `${account.checkCount}`,  inline: true }
      )
      .setFooter({ text: "Instagram Monitor • Archived to Old Clients" })
      .setTimestamp();

    // ── Admin log ─────────────────────────────────────────────────────────
    await adminLog({
      type: "COMMAND",
      title: `/monitor remove — @${username}`,
      description:
        `<@${interaction.user.id}> **manually removed** \`@${username}\` from the Monitoring Base.\n\n` +
        `**Originally added by:** ${account.addedBy} (ID: \`${account.addedById ?? "unknown"}\`)\n` +
        `**Added on:** ${new Date(account.addedAt).toUTCString()}\n` +
        `**Total checks done:** ${account.checkCount.toLocaleString()}\n` +
        `**Archived to:** Old Clients database`,
      color: 0x888888,
      user: interaction.user,
      guild: logContext,
    });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// ── Ready ──────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`\n✅ Logged in as ${client.user.tag}`);
  console.log(`📡 Notification channel: ${CHANNEL_ID}`);
  console.log(`📦 Max monitoring slots: ${MAX_ACTIVE}`);
  console.log(`🔐 Admin log channel: ${LOG_CHANNEL_ID ?? "NOT SET (logging disabled)"}`);
  await registerCommands();
  resumeAll();
  console.log("\n🤖 Bot is running. Use /monitor in Discord.\n");
});

client.login(TOKEN);
