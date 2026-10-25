'use strict';

/**
 * Fetch interceptor used by the end-to-end test. It keeps the test completely
 * offline while exercising the real Discord client, download and conversion
 * code paths with tiny local fixtures.
 */

const fs = require('node:fs');
const path = require('node:path');

const PNG = fs.readFileSync(path.join(__dirname, 'fixtures', 'emoji.png'));
const APNG = fs.readFileSync(path.join(__dirname, 'fixtures', 'sticker.png'));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function image(data) {
  return new Response(data, { status: 200, headers: { 'content-type': 'image/png' } });
}

const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const host = url.hostname;
  const route = url.pathname;

  if (host === 'discord.com') {
    if (route === '/api/v10/users/@me') {
      return json({
        id: '123456789012345678',
        username: 'test_user',
        global_name: 'Test User',
        discriminator: '0',
        avatar: null,
        bot: false,
      });
    }
    if (route === '/api/v10/users/@me/guilds') {
      return json([
        { id: '100000000000000001', name: 'Mock Guild', icon: null },
        { id: '100000000000000002', name: 'Broken Guild', icon: null },
      ]);
    }
    if (route === '/api/v10/guilds/100000000000000001/emojis') {
      return json([
        { id: '111111111111111111', name: 'blob_happy', animated: true, available: true },
        { id: '111111111111111112', name: 'blob_sad', animated: false, available: true },
      ]);
    }
    if (route === '/api/v10/guilds/100000000000000001/stickers') {
      return json([
        { id: '222222222222222222', name: 'Wave', format_type: 2, available: true },
      ]);
    }
    if (route === '/api/v10/guilds/100000000000000002/emojis') {
      return json({ message: 'Missing Access', code: 50001 }, 403);
    }
    if (route === '/api/v10/guilds/100000000000000002/stickers') {
      return json([]);
    }
    return json({ message: `Unexpected Discord route: ${route}`, code: 0 }, 404);
  }

  if (host === 'cdn.discordapp.com' || host === 'media.discordapp.net') {
    if (route.startsWith('/stickers/333333333333333333.')) {
      return new Response('not found', { status: 404 });
    }
    if (route.startsWith('/stickers/')) return image(APNG);
    if (route.startsWith('/emojis/')) return image(PNG);
  }

  return json({ message: `Unexpected fetch: ${url}` }, 500);
};

globalThis.__realFetch = realFetch;
