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

  const superOffers = offers.filter(o => o.category === 'supermercado');
  const restaurantOffers = offers.filter(o => o.category === 'restaurante');

  let message = `OFERTAS EN CÓRDOBA\n`;
  message += `${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}\n\n`;

  if (superOffers.length > 0) {
    message += `🛒 SUPER / MERCADO (>60% OFF)\n`;
    message += `─`.repeat(30) + `\n`;

    const byStore = {};
    for (const o of superOffers) {
      if (!byStore[o.restaurant]) byStore[o.restaurant] = [];
      byStore[o.restaurant].push(o);
    }

    for (const [store, items] of Object.entries(byStore)) {
      message += `\n<b>${store}</b>\n`;
      for (const item of items.slice(0, 5)) {
        const priceInfo = item.originalPrice && item.currentPrice
          ? ` <s>${item.originalPrice}</s> → ${item.currentPrice}`
          : '';
        message += `  ${item.discount}% OFF | ${item.description.split(' - ').slice(1).join(' - ') || item.description}${priceInfo}\n`;
      }
      if (items.length > 5) {
        message += `  ... y ${items.length - 5} más\n`;
      }
    }
    message += '\n';
  }

  if (restaurantOffers.length > 0) {
    message += `🍽️ RESTAURANTES (>70% OFF)\n`;
    message += `─`.repeat(30) + `\n`;

    const byPlatform = {};
    for (const o of restaurantOffers) {
      const key = o.platform;
      if (!byPlatform[key]) byPlatform[key] = [];
      byPlatform[key].push(o);
    }

    for (const [platform, items] of Object.entries(byPlatform)) {
      message += `\n${platformEmoji(platform)} ${platform}\n`;
      for (const item of items.slice(0, 8)) {
        const eta = item.deliveryTime ? ` (${item.deliveryTime})` : '';
        message += `  ${item.discount}% OFF | ${item.restaurant}${eta}\n`;
        if (item.url) message += `  ${item.url}\n`;
      }
      if (items.length > 8) {
        message += `  ... y ${items.length - 8} más\n`;
      }
    }
    message += '\n';
  }

  if (superOffers.length === 0 && restaurantOffers.length > 0) {
    message += `_Sin ofertas de supermercado hoy_\n\n`;
  }

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

function platformEmoji(platform) {
  const emojis = { Rappi: '🟠', PedidosYa: '🔴', UberEats: '🟢' };
  return emojis[platform] || '⚪';
}
