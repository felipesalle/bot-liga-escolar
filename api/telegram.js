const admin = require('firebase-admin');
const axios = require('axios');

// Inicializar Firebase Admin una sola vez
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

module.exports = async (req, res) => {
  // Solo procesar peticiones POST enviadas por Telegram
  if (req.method !== 'POST') {
    return res.status(200).send('Bot activo');
  }

  try {
    const update = req.body;

    if (update && update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim().toLowerCase();

      // Comando: /tabla o tabla
      if (text === '/tabla' || text === 'tabla') {
        const snapshot = await db.collection('tabla_posiciones')
          .orderBy('puntos', 'desc')
          .get();

        if (snapshot.empty) {
          await enviarMensaje(chatId, '⚠️ No hay datos registrados en la tabla.');
          return res.status(200).send('OK');
        }

        let mensaje = '<b>🏆 CLASIFICACIÓN LIGA ESCOLAR</b>\n';
        mensaje += '<pre>';
        mensaje += 'Pos Equipo       Pts\n';
        mensaje += '--------------------\n';

        let pos = 1;
        snapshot.forEach((doc) => {
          const data = doc.data();
          const equipo = (data.equipo || 'Equipo').substring(0, 10).padEnd(11, ' ');
          const pts = String(data.puntos || 0).padStart(3, ' ');
          mensaje += `${pos}.  ${equipo}${pts}\n`;
          pos++;
        });
        mensaje += '</pre>';

        await enviarMensaje(chatId, mensaje);

      // Comando: /jornada o jornada
      } else if (text === '/jornada' || text === 'jornada') {
        await enviarMensaje(chatId, '📅 <b>Próximos Partidos:</b>\n10:00 AM - 6to A vs 5to B');
      
      } else {
        await enviarMensaje(chatId, 'Usa los comandos /tabla o /jornada para consultar la liga.');
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error procesando el mensaje:', error);
    return res.status(500).send('Error interno');
  }
};

async function enviarMensaje(chatId, texto) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: texto,
    parse_mode: 'HTML'
  });
}