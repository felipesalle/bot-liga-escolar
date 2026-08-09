const admin = require('firebase-admin');
const axios = require('axios');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Mapeo de ligas hacia los IDs de documentos en Firestore
const LIGAS = {
  'primaria': { id: 'lasalle-primaria-deportes', nombre: '🏫 PRIMARIA' },
  'secundaria': { id: 'lasalle-secundaria-deportes', nombre: '🏫 SECUNDARIA' },
  'prepa': { id: 'lasalle-prepa-deportes', nombre: '🏫 PREPA' } // Ajusta el ID según lo tengas guardado
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot activo');

  try {
    const update = req.body;

    // 1. Manejo de botones (Callback Queries)
    if (update.callback_query) {
      const callback = update.callback_query;
      const chatId = callback.message.chat.id;
      const data = callback.data; // Formato esperado: "tabla_secundaria" o "tabla_primaria"

      if (data.startsWith('tabla_')) {
        const nivel = data.split('_')[1];
        await responderTablaLiga(chatId, nivel);
      }

      return res.status(200).send('OK');
    }

    // 2. Manejo de mensajes de texto normales
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim().toLowerCase();

      if (text === '/tabla' || text === 'tabla' || text === '/start') {
        // Enviar menú con botones para elegir la liga
        await enviarMenuLigas(chatId);
      } else if (text === '/primaria' || text === 'primaria') {
        await responderTablaLiga(chatId, 'primaria');
      } else if (text === '/secundaria' || text === 'secundaria') {
        await responderTablaLiga(chatId, 'secundaria');
      } else if (text === '/prepa' || text === 'prepa') {
        await responderTablaLiga(chatId, 'prepa');
      } else {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Selecciona una opción usando /tabla para ver las ligas disponibles.'
        });
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error procesando el mensaje:', error);
    return res.status(500).send('Error interno');
  }
};

// Función para enviar botones interactivos
async function enviarMenuLigas(chatId) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: '<b>🏆 SELECCIONA LA LIGA A CONSULTAR:</b>',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🏫 Primaria', callback_data: 'tabla_primaria' }],
        [{ text: '🏫 Secundaria', callback_data: 'tabla_secundaria' }],
        [{ text: '🏫 Prepa', callback_data: 'tabla_prepa' }]
      ]
    }
  });
}

// Función para leer la subcolección y enviar la tabla
async function responderTablaLiga(chatId, nivel) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: '⚠️ Liga no encontrada.'
    });
    return;
  }

  // Consulta la ruta específica: artifacts -> ID_LIGA -> public -> data
  const docRef = db.collection('artifacts')
    .doc(configLiga.id)
    .collection('public')
    .doc('data');

  const docSnap = await docRef.get();

  if (!docSnap.exists) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `⚠️ No se encontraron datos guardados para ${configLiga.nombre}.`
    });
    return;
  }

  const datos = docSnap.data();
  // Ajusta 'tabla' o 'equipos' según la propiedad dentro de 'data'
  const listaEquipos = datos.tabla || datos.equipos || [];

  if (listaEquipos.length === 0) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `⚠️ La tabla de ${configLiga.nombre} está vacía.`
    });
    return;
  }

  // Ordenar equipos por puntos de mayor a menor
  listaEquipos.sort((a, b) => (b.puntos || 0) - (a.puntos || 0));

  let mensaje = `<b>🏆 CLASIFICACIÓN - ${configLiga.nombre}</b>\n`;
  mensaje += '<pre>';
  mensaje += 'Pos Equipo       Pts\n';
  mensaje += '--------------------\n';

  listaEquipos.forEach((item, index) => {
    const pos = String(index + 1).padEnd(2, ' ');
    const equipo = (item.equipo || item.nombre || 'Equipo').substring(0, 10).padEnd(11, ' ');
    const pts = String(item.puntos || item.pts || 0).padStart(3, ' ');
    mensaje += `${pos}. ${equipo}${pts}\n`;
  });
  mensaje += '</pre>';

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: mensaje,
    parse_mode: 'HTML'
  });
}