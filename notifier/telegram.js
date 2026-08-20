const API_BASE = 'https://api.telegram.org/bot';

export async function sendMessage(offers) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('[Telegram] Token o Chat ID no configurados');
    return;
  }

  if (offers.length === 0) {
    console.log('[Telegram] No hay ofertas nuevas para enviar');
    return;
  }

  const header = `OFERTONES ENCONTRADOS ${offers.length} ofertas >${process.env.MIN_DISCOUNT || '60'}% OFF\n\n`;

  const grouped = groupByPlatform(offers);
  let message = header;

  for (const [platform, platformOffers] of Object.entries(grouped)) {
    message += `${platformEmoji(platform)} ${platform.toUpperCase()}\n`;
    message += '─'.repeat(25) + '\n';

    for (const offer of platformOffers.slice(0, 10)) {
      message += formatOffer(offer) + '\n';
    }

    if (platformOffers.length > 10) {
      message += `  ... y ${platformOffers.length - 10} mas\n`;
    }
    message += '\n';
  }

  message += `Actualizado: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`;

  try {
    const url = `${API_BASE}${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();
    if (!data.ok) {
      console.error(`[Telegram] Error: ${data.description}`);
    } else {
      console.log(`[Telegram] Mensaje enviado a chat ${chatId}`);
    }
  } catch (err) {
    console.error(`[Telegram] Error: ${err.message}`);
  }
}

function formatOffer(offer) {
  const priceInfo = offer.originalPrice && offer.currentPrice
    ? ` ($${offer.originalPrice} -> $${offer.currentPrice})`
    : '';
  const link = offer.url ? `\n  ${offer.url}` : '';
  return `  ${offer.discount}% OFF | ${offer.restaurant}${priceInfo}\n  ${offer.description}${link}`;
}

function groupByPlatform(offers) {
  const groups = {};
  for (const offer of offers) {
    if (!groups[offer.platform]) groups[offer.platform] = [];
    groups[offer.platform].push(offer);
  }
  return groups;
}

function platformEmoji(platform) {
  const emojis = { Rappi: '🟠', PedidosYa: '🔴', UberEats: '🟢' };
  return emojis[platform] || '⚪';
}
