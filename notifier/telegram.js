import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import {
  parseOfferCommand,
  enqueueCuratedOffer,
  readCuratedQueue,
  clearCuratedQueue,
  takeCuratedOffers,
  formatOfferSummary,
  summarizeCuratedOffer,
  OFFER_COMMAND_HELP,
} from '../scrapers/curated.js';
import { deduplicateOffers, filterNewOffers, detectFlashDeals } from '../utils/filter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBSCRIBERS_FILE = join(__dirname, '..', 'data', 'subscribers.json');
const HISTORY_FILE = join(__dirname, '..', 'data', 'history.json');
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

function extractCommand(text, command) {
  const match = String(text ?? '').trim().match(
    new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?(?:\\s+([\\s\\S]*))?$`, 'i')
  );
  return match ? (match[1] ?? '') : null;
}

async function publishCuratedQueue(token, chatId) {
  const { offers, errors, commit } = takeCuratedOffers(undefined, { consume: false });

  for (const error of errors) {
    console.error(`[Curado] Oferta inválida conservada en cola: ${error.error}`);
  }

  if (offers.length === 0) {
    commit();
    const suffix = errors.length ? ` (${errors.length} inválida(s) conservada(s) en cola)` : '';
    await sendTelegramMessage(token, chatId, `📭 No hay ofertas válidas en la cola${suffix}.`);
    return;
  }

  const discountOffers = deduplicateOffers(offers.filter(o => !o.isCheapProduct));
  const cheapProducts = deduplicateOffers(offers.filter(o => o.isCheapProduct));

  const newDiscounts = filterNewOffers(discountOffers, HISTORY_FILE);
  const newCheap = filterNewOffers(cheapProducts, HISTORY_FILE);
  const flashDeals = detectFlashDeals(discountOffers, HISTORY_FILE);
  const hasNewContent = newDiscounts.length > 0 || newCheap.length > 0 || flashDeals.length > 0;

  if (hasNewContent) {
    await sendMessage(newDiscounts, newCheap, flashDeals);
  }

  const committed = commit();
  if (!committed.ok) {
    console.error(`[Curado] ${committed.error}`);
  }

  const invalid = errors.length ? ` (${errors.length} inválida(s) conservada(s) en cola)` : '';
  const result = hasNewContent
    ? `✅ Publicación enviada: ${newDiscounts.length} ofertas + ${newCheap.length} baratos + ${flashDeals.length} flash${invalid}.`
    : `ℹ️ La cola se procesó, pero no había ofertas nuevas para publicar${invalid}.`;
  await sendTelegramMessage(token, chatId, result);
}

async function handleAdminMessage(token, chatId, text) {
  const offerBody = extractCommand(text, 'oferta');
  if (offerBody !== null) {
    if (!offerBody.trim()) {
      await sendTelegramMessage(token, chatId, `ℹ️ ${OFFER_COMMAND_HELP}`);
      return;
    }

    if (offerBody.trim().toLowerCase() === 'clear') {
      const removed = clearCuratedQueue();
      await sendTelegramMessage(token, chatId, `🗑️ Cola curada vaciada (${removed} oferta(s) descartada(s)).`);
      return;
    }

    const parsed = parseOfferCommand(text);
    if (!parsed.ok) {
      await sendTelegramMessage(token, chatId, `❌ ${parsed.error}\n\n${OFFER_COMMAND_HELP}`);
      return;
    }

    const queued = enqueueCuratedOffer(parsed.offer);
    if (!queued.ok) {
      await sendTelegramMessage(token, chatId, `❌ ${queued.error}`);
      return;
    }

    await sendTelegramMessage(
      token,
      chatId,
      `✅ Oferta encolada: ${formatOfferSummary(queued.offer)}\nPendientes en cola: ${queued.pending}\nUsá /ofertas para revisar o /publicar para enviar ahora.`
    );
    return;
  }

  if (extractCommand(text, 'ofertas') !== null) {
    const queue = readCuratedQueue();
    if (queue.length === 0) {
      await sendTelegramMessage(token, chatId, '📭 La cola curada está vacía.');
      return;
    }

    const lines = queue.map((raw, index) => `${index + 1}. ${summarizeCuratedOffer(raw)}`);
    await sendTelegramMessage(token, chatId, `📋 Cola curada (${queue.length})\n\n${lines.join('\n')}`);
    return;
  }

  if (extractCommand(text, 'publicar') !== null) {
    await publishCuratedQueue(token, chatId);
  }
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

      if (text === '/start' || text === '/start@' + config.telegram.botUsername) {
        if (!subscribers.includes(chatId)) {
          subscribers.push(chatId);
          console.log(`[Telegram] Nuevo suscriptor: ${chatId} (${firstName})`);
        }
      }

      const adminChatId = config.telegram.adminChatId;
      if (adminChatId && chatId === adminChatId && text) {
        try {
          await handleAdminMessage(token, chatId, text);
        } catch (e) {
          console.error(`[Telegram] Error procesando comando admin: ${e.message}`);
        }
      }
    }

    saveSubscribers(subscribers, offset);
  } catch (e) {
    console.log(`[Telegram] Poll error: ${e.message}`);
  }

  return subscribers;
}

export async function sendMessage(offers, cheapProducts = [], flashDeals = [], options = {}) {
  const { token } = config.telegram;
  const { ids: subscribers } = loadSubscribers();

  if (offers.length === 0 && cheapProducts.length === 0 && flashDeals.length === 0) {
    console.log('[Telegram] No hay ofertas nuevas para enviar');
    return;
  }

  let message = `🎯 OFERTAS ${config.city.toUpperCase()}\n${'─'.repeat(20)}\n`;

  if (offers.length > 0) {
    const superOffers = offers.filter(o => o.category === 'supermercado').sort((a, b) => b.discount - a.discount);
    const restaurantOffers = offers.filter(o => o.category === 'restaurante').sort((a, b) => b.discount - a.discount);

    if (superOffers.length > 0) {
      message += `\n🛒 SUPERMERCADO\n`;
      const byPlatform = {};
      for (const o of superOffers) {
        if (!byPlatform[o.platform]) byPlatform[o.platform] = {};
        if (!byPlatform[o.platform][o.restaurant]) byPlatform[o.platform][o.restaurant] = [];
        byPlatform[o.platform][o.restaurant].push(o);
      }
      for (const [platform, stores] of Object.entries(byPlatform)) {
        for (const [store, items] of Object.entries(stores)) {
          message += `\n📍 ${platform} — ${store}\n`;
          const sorted = items.sort((a, b) => {
            if (a.promoType && !b.promoType) return 1;
            if (!a.promoType && b.promoType) return -1;
            return b.discount - a.discount;
          });
          for (const o of sorted) {
            const name = o.name || o.description?.replace(/^\d+%\s*(OFF\s*)?/, '').replace(/\s*-\s*.+$/, '') || '';
            const short = name.length > 40 ? name.substring(0, 37) + '...' : name;
            const price = o.currentPrice || o.originalPrice || '';
            const tag = o.promoType ? ` [${o.promoType}]` : '';
            message += `- ${o.discount}%${tag} ${short} ${price}\n`;
          }
        }
      }
    }

    if (restaurantOffers.length > 0) {
      message += `\n🍽️ RESTAURANTES\n`;
      for (const o of restaurantOffers) {
        message += `- ${o.discount}% ${o.platform} — ${o.restaurant}\n`;
      }
    }
  }

  if (cheapProducts.length > 0) {
    message += `\n💰 BARATOS (<$${config.maxPriceCheap})\n`;
    for (const o of cheapProducts) {
      const name = o.name || o.description?.replace(/^\$[\d.,]+\s*-\s*/, '') || '';
      const short = name.length > 40 ? name.substring(0, 37) + '...' : name;
      const price = o.currentPrice || '';
      const where = o.restaurant ? ` (${o.restaurant})` : '';
      message += `- ${price} ${short}${where}\n`;
    }
  }

  if (flashDeals.length > 0) {
    message += `\n⚡ FLASH DEALS (>${config.discounts.flashThreshold}% OFF)\n`;
    for (const o of flashDeals) {
      const name = o.name || o.description?.replace(/^\d+%\s*(OFF\s*)?/, '').replace(/\s*-\s*.+$/, '') || '';
      const short = name.length > 40 ? name.substring(0, 37) + '...' : name;
      const price = o.currentPrice || o.originalPrice || '';
      message += `- ${o.discount}% ${short} ${price}\n`;
    }
  }

  if (options.dryRun) {
    console.log(`\n[DRY-RUN] Mensaje que se enviaría a ${subscribers.length} suscriptor(es):\n`);
    console.log(message);
    return;
  }

  if (!token) {
    console.error('[Telegram] Token no configurado');
    return;
  }

  if (subscribers.length === 0) {
    console.log('[Telegram] No hay suscriptores');
    return;
  }

  await Promise.all(subscribers.map(chatId => sendTelegramMessage(token, chatId, message)));
}

async function sendTelegramMessage(token, chatId, text) {
  const MAX = 3900;
  const chunks = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > MAX && current.length > 0) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current.length > 0) chunks.push(current);

  const totalLen = chunks.reduce((a, c) => a + c.length, 0);
  console.log(`[Telegram] Chat ${chatId}: ${totalLen} chars, ${chunks.length} parte(s)`);

  try {
    const url = `${API_BASE}${token}/sendMessage`;
    for (let i = 0; i < chunks.length; i++) {
      const part = i > 0 ? `📌 \`(continúa — parte ${i + 1}/${chunks.length})\`\n${chunks[i]}` : chunks[i];
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
