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
    message += `\n🛒 SUPER (≥60% OFF)\n`;
    for (const o of offers.filter(o => o.category === 'supermercado')) {
      const parts = o.description.split(' - ');
      const name = parts.length > 1 ? parts.slice(1).join(' - ') : o.description;
      const short = name.length > 60 ? name.substring(0, 57) + '...' : name;
      message += `${o.discount}% ${short}\n`;
    }
    message += `\n🍽️ RESTAURANTES (>70% OFF)\n`;
    for (const o of offers.filter(o => o.category === 'restaurante')) {
      message += `${o.discount}% ${o.restaurant}\n`;
    }
  }

  if (cheapProducts.length > 0) {
    message += `\n💰 BARATOS (<$100)\n`;
    for (const o of cheapProducts) {
      message += `$${o.currentPrice} ${o.description}\n`;
    }
  }

  await sendTelegramMessage(token, chatId, message);
}

async function sendTelegramMessage(token, chatId, text) {
  try {
    const url = `${API_BASE}${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
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
