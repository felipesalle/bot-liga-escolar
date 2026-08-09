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
  'primaria': { ids: ['lasalle-primaria-deportes', 'lasalle-primaria', 'primaria'], nombre: '🏫 PRIMARIA' },
  'secundaria': { ids: ['lasalle-secundaria-deportes', 'lasalle-secundaria', 'secundaria'], nombre: '🏫 SECUNDARIA' },
  'prepa': { ids: ['default-app-id', 'default-app-io', 'lasalle-prepa-deportes', 'lasalle-prepa', 'prepa'], nombre: '🏫 PREPA' }
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot activo');

  try {
    const update = req.body;

    // 1. Manejo de botones (Callback Queries)
    if (update.callback_query) {
      const callback = update.callback_query;
      const chatId = callback.message.chat.id;
      const data = callback.data;

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

async function responderTablaLiga(chatId, nivel) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: '⚠️ Liga no encontrada.'
    });
    return;
  }

  let listaEquipos = [];
  let ligaEncontrada = false;
  const subcoleccionesPosibles = ['teams', 'equipos', 'standings', 'posiciones'];

  for (const docId of configLiga.ids) {
    // 1. Probar subcolecciones dentro de artifacts -> docId -> public -> data -> [subcol]
    for (const subcol of subcoleccionesPosibles) {
      const snap = await db.collection('artifacts')
        .doc(docId)
        .collection('public')
        .doc('data')
        .collection(subcol)
        .get();

      if (!snap.empty) {
        ligaEncontrada = true;
        snap.forEach(doc => {
          const d = doc.data();
          listaEquipos.push({
            equipo: d.nombre || d.equipo || d.name || d.team || d.teamName || doc.id,
            puntos: d.puntos ?? d.pts ?? d.points ?? d.score ?? 0
          });
        });
        break;
      }
    }

    if (ligaEncontrada) break;

    // 2. Probar subcolecciones directamente en artifacts -> docId -> [subcol]
    for (const subcol of subcoleccionesPosibles) {
      const snap = await db.collection('artifacts')
        .doc(docId)
        .collection(subcol)
        .get();

      if (!snap.empty) {
        ligaEncontrada = true;
        snap.forEach(doc => {
          const d = doc.data();
          listaEquipos.push({
            equipo: d.nombre || d.equipo || d.name || d.team || d.teamName || doc.id,
            puntos: d.puntos ?? d.pts ?? d.points ?? d.score ?? 0
          });
        });
        break;
      }
    }

    if (ligaEncontrada) break;

    // 3. Probar documento en artifacts -> docId -> public -> data
    const dataDocSnap = await db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data')
      .get();

    if (dataDocSnap.exists) {
      const datos = dataDocSnap.data();
      const equipos = datos.tabla || datos.equipos || datos.teams || datos.standings || [];
      if (Array.isArray(equipos) && equipos.length > 0) {
        ligaEncontrada = true;
        listaEquipos = equipos.map(item => ({
          equipo: item.equipo || item.nombre || item.name || item.team || 'Equipo',
          puntos: item.puntos ?? item.pts ?? item.points ?? item.score ?? 0
        }));
        break;
      }
    }

    // 4. Probar documento directo en artifacts -> docId
    const rootDocSnap = await db.collection('artifacts').doc(docId).get();
    if (rootDocSnap.exists) {
      const datos = rootDocSnap.data();
      const equipos = datos.tabla || datos.equipos || datos.teams || datos.standings || [];
      if (Array.isArray(equipos) && equipos.length > 0) {
        ligaEncontrada = true;
        listaEquipos = equipos.map(item => ({
          equipo: item.equipo || item.nombre || item.name || item.team || 'Equipo',
          puntos: item.puntos ?? item.pts ?? item.points ?? item.score ?? 0
        }));
        break;
      }
    }
  }

  if (!ligaEncontrada || listaEquipos.length === 0) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `⚠️ No se encontraron datos guardados para ${configLiga.nombre}.`
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
    const equipo = String(item.equipo).substring(0, 10).padEnd(11, ' ');
    const pts = String(item.puntos).padStart(3, ' ');
    mensaje += `${pos}. ${equipo}${pts}\n`;
  });
  mensaje += '</pre>';

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: mensaje,
    parse_mode: 'HTML'
  });
}