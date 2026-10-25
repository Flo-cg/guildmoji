'use strict';

const { createLimiter } = require('./limit');

const API_BASE = 'https://discord.com/api/v10';
const CDN_BASE = 'https://cdn.discordapp.com';
const MEDIA_BASE = 'https://media.discordapp.net';
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const apiLimiter = createLimiter(5);

class DiscordError extends Error {
  constructor(message, status = 0, code = undefined) {
    super(message);
    this.name = 'DiscordError';
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function drain(res) {
  try {
    await res.arrayBuffer();
  } catch {
    /* ignore */
  }
}

async function apiRequest(route, { auth, method = 'GET', retries = 4 } = {}) {
  const url = route.startsWith('http') ? route : API_BASE + route;

  return apiLimiter(async () => {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: auth,
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
            'X-Discord-Locale': 'en-US',
          },
          signal: AbortSignal.timeout(25000),
        });
      } catch (err) {
        lastError = new DiscordError(`Could not reach Discord: ${err.message}`);
        if (attempt === retries) throw lastError;
        await sleep(400 * 2 ** attempt + Math.random() * 300);
        continue;
      }

      if (res.status === 429) {
        let wait = Number(res.headers.get('retry-after')) * 1000;
        try {
          const body = await res.json();
          if (body && Number(body.retry_after) > 0) wait = Number(body.retry_after) * 1000;
        } catch {
          /* ignore */
        }
        if (!Number.isFinite(wait) || wait <= 0) wait = 1000 * 2 ** attempt;
        wait = Math.min(wait, 60000) + 250 + Math.random() * 250;
        lastError = new DiscordError('Discord rate limit reached', 429);
        if (attempt === retries) throw lastError;
        await sleep(wait);
        continue;
      }

      if (res.status >= 500) {
        lastError = new DiscordError(`Discord server error (HTTP ${res.status})`, res.status);
        if (attempt === retries) throw lastError;
        await drain(res);
        await sleep(500 * 2 ** attempt + Math.random() * 300);
        continue;
      }

      if (!res.ok) {
        let body = {};
        try {
          body = await res.json();
        } catch {
          /* ignore */
        }
        const message =
          typeof body.message === 'string' && body.message
            ? body.message
            : `Discord request failed (HTTP ${res.status})`;
        throw new DiscordError(message, res.status, body.code);
      }

      return res;
    }

    throw lastError || new DiscordError('Discord request failed');
  });
}

async function getMe(auth) {
  const res = await apiRequest('/users/@me', { auth });
  return res.json();
}

/**
 * Accepts a user token, bot token with/without the "Bot " prefix, or Bearer token.
 */
async function resolveAuth(rawToken) {
  let token = String(rawToken || '').trim();
  token = token.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!token) throw new DiscordError('Please enter a token.', 400);
  if (/\s/.test(token)) throw new DiscordError('That does not look like a Discord token.', 400);
  if (token.length > 200) throw new DiscordError('That token is too long.', 400);

  const attempts = /^(Bot|Bearer)\s/i.test(token) ? [token] : [token, `Bot ${token}`];
  let lastError = null;

  for (const auth of attempts) {
    try {
      const user = await getMe(auth);
      return { auth, user };
    } catch (err) {
      lastError = err;
      if (err.status !== 401 && err.status !== 400) throw err;
    }
  }

  if (lastError && lastError.status === 429) throw lastError;
  throw new DiscordError(
    'Discord rejected this token. It may have been copied incorrectly or logged out (changing your password invalidates it).',
    401,
  );
}

async function listGuilds(auth) {
  const guilds = [];
  let after = '0';

  for (;;) {
    const res = await apiRequest(
      `/users/@me/guilds?limit=200&after=${encodeURIComponent(after)}`,
      { auth },
    );
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    guilds.push(...page);
    if (page.length < 200) break;
    after = page[page.length - 1].id;
    if (guilds.length > 4000) break;
  }

  return guilds;
}

function emojiPreview(emoji) {
  const ext = emoji.animated ? 'webp' : 'png';
  return `${MEDIA_BASE}/emojis/${emoji.id}.${ext}?size=96`;
}

function stickerPreview(sticker) {
  if (sticker.format_type === 3) return null;
  // The .webp variant of a sticker is a small, static first frame. The .png
  // variant of an animated sticker is a multi-megabyte APNG, which would make
  // large grids very heavy.
  return `${MEDIA_BASE}/stickers/${sticker.id}.webp?size=160`;
}

const STICKER_FORMATS = { 1: 'png', 2: 'apng', 3: 'lottie', 4: 'gif' };

/**
 * Fetch every guild, emoji and sticker reachable by this account.
 */
async function collectEverything(auth, { onGuild } = {}) {
  const guilds = await listGuilds(auth);
  guilds.sort((a, b) => a.name.localeCompare(b.name));

  const items = [];
  const errors = [];
  const summaries = guilds.map((guild) => ({
    id: guild.id,
    name: guild.name,
    icon: guild.icon ? `${CDN_BASE}/icons/${guild.id}/${guild.icon}.png?size=64` : null,
    emojiCount: 0,
    stickerCount: 0,
    error: null,
  }));
  const summaryById = new Map(summaries.map((s) => [s.id, s]));

  let doneGuilds = 0;

  async function loadGuild(guild, summary) {
    const [emojiResult, stickerResult] = await Promise.allSettled([
      apiRequest(`/guilds/${guild.id}/emojis`, { auth }).then((res) => res.json()),
      apiRequest(`/guilds/${guild.id}/stickers`, { auth }).then((res) => res.json()),
    ]);

    if (emojiResult.status === 'fulfilled' && Array.isArray(emojiResult.value)) {
      for (const emoji of emojiResult.value) {
        if (!emoji || !emoji.id) continue;
        items.push({
          id: emoji.id,
          kind: 'emoji',
          name: emoji.name || `emoji_${emoji.id}`,
          guildId: guild.id,
          guildName: guild.name,
          animated: Boolean(emoji.animated),
          available: emoji.available !== false,
          managed: Boolean(emoji.managed),
          format: emoji.animated ? 'gif' : 'png',
          preview: emojiPreview(emoji),
        });
        summary.emojiCount += 1;
      }
    } else {
      const reason =
        emojiResult.status === 'rejected'
          ? emojiResult.reason.message
          : 'Unexpected response from Discord';
      if (emojiResult.status === 'rejected' && emojiResult.reason.status === 401) {
        throw emojiResult.reason;
      }
      errors.push({ guildId: guild.id, guildName: guild.name, kind: 'emojis', message: reason });
      summary.error = reason;
    }

    if (stickerResult.status === 'fulfilled' && Array.isArray(stickerResult.value)) {
      for (const sticker of stickerResult.value) {
        if (!sticker || !sticker.id) continue;
        items.push({
          id: sticker.id,
          kind: 'sticker',
          name: sticker.name || `sticker_${sticker.id}`,
          guildId: guild.id,
          guildName: guild.name,
          animated: sticker.format_type === 2 || sticker.format_type === 4,
          available: sticker.available !== false,
          format: STICKER_FORMATS[sticker.format_type] || 'unknown',
          formatType: sticker.format_type,
          description: sticker.description || '',
          preview: stickerPreview(sticker),
        });
        summary.stickerCount += 1;
      }
    } else {
      const reason =
        stickerResult.status === 'rejected'
          ? stickerResult.reason.message
          : 'Unexpected response from Discord';
      if (stickerResult.status === 'rejected' && stickerResult.reason.status === 401) {
        throw stickerResult.reason;
      }
      errors.push({ guildId: guild.id, guildName: guild.name, kind: 'stickers', message: reason });
      summary.error = summary.error || reason;
    }

    doneGuilds += 1;
    if (onGuild) onGuild(doneGuilds, guilds.length);
  }

  const limit = 4;
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const guild = guilds[index];
      if (!guild) return;
      await loadGuild(guild, summaryById.get(guild.id));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, guilds.length) }, () => worker()));

  items.sort((a, b) => {
    const guildCompare = a.guildName.localeCompare(b.guildName);
    if (guildCompare !== 0) return guildCompare;
    if (a.kind !== b.kind) return a.kind === 'emoji' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    items,
    guilds: summaries,
    errors,
    fetchedAt: Date.now(),
  };
}

function publicUser(user) {
  if (!user) return null;
  let avatar = null;
  if (user.avatar) {
    avatar = `${CDN_BASE}/avatars/${user.id}/${user.avatar}.png?size=80`;
  } else {
    const index = Number((BigInt(user.id) >> 22n) % 6n);
    avatar = `${CDN_BASE}/embed/avatars/${index}.png`;
  }
  return {
    id: user.id,
    username: user.username,
    globalName: user.global_name || null,
    discriminator: user.discriminator || '0',
    bot: Boolean(user.bot),
    avatar,
  };
}

module.exports = {
  DiscordError,
  resolveAuth,
  collectEverything,
  publicUser,
  apiRequest,
  API_BASE,
  CDN_BASE,
  MEDIA_BASE,
  USER_AGENT,
};
