const API_BASE = 'https://api.telegram.org/bot';

export async function sendMessage(offers, cheapProducts = []) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('[Telegram] Token o Chat ID no configurados');
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

  await sendTelegramMessage(token, chatId, message);
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
  console.log(`[Telegram] Mensaje total: ${totalLen} chars, ${chunks.length} parte(s)`);

  try {
    const url = `${API_BASE}${token}/sendMessage`;
    for (let i = 0; i < chunks.length; i++) {
      const part = i > 0 ? `📊 (parte ${i + 1})\n${chunks[i]}` : chunks[i];
      console.log(`[Telegram] Parte ${i + 1}: ${part.length} chars`);
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
        console.error(`[Telegram] Error parte ${i + 1}: ${data.description}`);
      } else {
        console.log(`[Telegram] Parte ${i + 1}/${chunks.length} enviada`);
      }
    }
  } catch (err) {
    console.error(`[Telegram] Error: ${err.message}`);
  }
}
