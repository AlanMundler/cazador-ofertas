import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBSCRIBERS_FILE = join(__dirname, '..', 'data', 'subscribers.json');
const API_BASE = 'https://api.telegram.org/bot';

function loadSubscribers() {
  try {
    if (!existsSync(SUBSCRIBERS_FILE)) return { ids: [], offset: 0 };
    const raw = JSON.parse(readFileSync(SUBSCRIBERS_FILE, 'utf-8'));
    if (Array.isArray(raw)) return { ids: raw, offset: 0 };
    return { ids: raw.ids || [], offset: raw.offset || 0 };
  } catch {
    return { ids: [], offset: 0 };
  }
}

function saveSubscribers(ids, offset) {
  const dir = join(__dirname, '..', 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SUBSCRIBERS_FILE, JSON.stringify({ ids: [...new Set(ids)], offset }, null, 2));
}

export async function pollUpdates(token) {
  const { ids: subscribers, offset: savedOffset } = loadSubscribers();
  let offset = savedOffset;

  try {
    const resp = await fetch(`${API_BASE}${token}/getUpdates?offset=${offset}&limit=10&timeout=1`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    if (!data.ok) return subscribers;

    for (const update of data.result) {
      offset = update.update_id + 1;
      const msg = update.message || update.my_chat_member;
      if (!msg) continue;

      const chatId = msg.chat.id;
      const text = msg.text || '';
      const firstName = msg.chat.first_name || 'Alguien';

      if (text === '/start' || text === '/start@' + process.env.BOT_USERNAME) {
        if (!subscribers.includes(chatId)) {
          subscribers.push(chatId);
          console.log(`[Telegram] Nuevo suscriptor: ${chatId} (${firstName})`);
        }
      }
    }

    saveSubscribers(subscribers, offset);
  } catch (e) {
    console.log(`[Telegram] Poll error: ${e.message}`);
  }

  return subscribers;
}

async function sendDirect(token, chatId, text) {
  try {
    await fetch(`${API_BASE}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

export async function sendMessage(offers, cheapProducts = []) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[Telegram] Token no configurado');
    return;
  }

  const { ids: subscribers } = loadSubscribers();
  if (subscribers.length === 0) {
    console.log('[Telegram] No hay suscriptores');
    return;
  }

  if (offers.length === 0 && cheapProducts.length === 0) {
    console.log('[Telegram] No hay ofertas nuevas para enviar');
    return;
  }

  let message = `OFERTAS CÓRDOBA\n`;

  if (offers.length > 0) {
    const superOffers = offers.filter(o => o.category === 'supermercado').sort((a, b) => b.discount - a.discount);
    const restaurantOffers = offers.filter(o => o.category === 'restaurante').sort((a, b) => b.discount - a.discount);

    if (superOffers.length > 0) {
      message += `\n🛒 SUPER (≥50% OFF)\n`;
      const byPlatform = {};
      for (const o of superOffers) {
        if (!byPlatform[o.platform]) byPlatform[o.platform] = {};
        if (!byPlatform[o.platform][o.restaurant]) byPlatform[o.platform][o.restaurant] = [];
        byPlatform[o.platform][o.restaurant].push(o);
      }
      for (const [platform, stores] of Object.entries(byPlatform)) {
        for (const [store, items] of Object.entries(stores)) {
          message += `\n${platform} - ${store}\n`;
          for (const o of items.sort((a, b) => b.discount - a.discount)) {
            const name = o.name || o.description || '';
            const short = name.length > 50 ? name.substring(0, 47) + '...' : name;
            message += `${o.discount}% ${short}\n`;
          }
        }
      }
    }

    if (restaurantOffers.length > 0) {
      message += `\n🍽️ RESTAURANTES (≥60% OFF)\n`;
      for (const o of restaurantOffers) {
        message += `${o.discount}% ${o.platform} - ${o.restaurant}\n`;
      }
    }
  }

  if (cheapProducts.length > 0) {
    message += `\n💰 BARATOS (<$100)\n`;
    for (const o of cheapProducts) {
      const name = o.name || o.description || '';
      message += `$${o.currentPrice} ${name}\n`;
    }
  }

  for (const chatId of subscribers) {
    await sendTelegramMessage(token, chatId, message);
  }
}

async function sendTelegramMessage(token, chatId, text) {
  const MAX = 3900;
  const chunks = [];

  while (text.length > MAX) {
    let splitAt = text.lastIndexOf('\n', MAX);
    if (splitAt < MAX / 2) splitAt = MAX;
    chunks.push(text.substring(0, splitAt));
    text = text.substring(splitAt);
  }
  chunks.push(text);

  const totalLen = chunks.reduce((a, c) => a + c.length, 0);
  console.log(`[Telegram] Chat ${chatId}: ${totalLen} chars, ${chunks.length} parte(s)`);

  try {
    const url = `${API_BASE}${token}/sendMessage`;
    for (let i = 0; i < chunks.length; i++) {
      const part = i > 0 ? `📊 (parte ${i + 1})\n${chunks[i]}` : chunks[i];
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: part,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await res.json();
      if (!data.ok) {
        console.error(`[Telegram] Error chat ${chatId} parte ${i + 1}: ${data.description}`);
        if (data.description && data.description.includes('blocked')) {
          const { ids: subs, offset } = loadSubscribers();
          saveSubscribers(subs.filter(id => id !== chatId), offset);
          console.log(`[Telegram] Suscriptor ${chatId} bloqueado, eliminado`);
        }
      } else {
        console.log(`[Telegram] Chat ${chatId} parte ${i + 1}/${chunks.length} enviada`);
      }
    }
  } catch (err) {
    console.error(`[Telegram] Error: ${err.message}`);
  }
}
