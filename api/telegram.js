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

      // Nivel seleccionado (ej: "nivel_primaria")
      if (data.startsWith('nivel_')) {
        const nivel = data.split('_')[1];
        await enviarMenuCategorias(chatId, nivel);
      }
      // Liga/Categoría seleccionada (ej: "verliga_primaria_IDLIGA")
      else if (data.startsWith('verliga_')) {
        const parts = data.split('_'); // ['verliga', nivel, leagueId...]
        const nivel = parts[1];
        const leagueId = parts.slice(2).join('_');
        await responderTablaEspecifica(chatId, nivel, leagueId);
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
        await enviarMenuCategorias(chatId, 'primaria');
      } else if (text === '/secundaria' || text === 'secundaria') {
        await enviarMenuCategorias(chatId, 'secundaria');
      } else if (text === '/prepa' || text === 'prepa') {
        await enviarMenuCategorias(chatId, 'prepa');
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

// Menú Nivel 1: Seleccionar Nivel (Primaria, Secundaria, Prepa)
async function enviarMenuLigas(chatId) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: '<b>🏆 SELECCIONA EL NIVEL A CONSULTAR:</b>',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🏫 Primaria', callback_data: 'nivel_primaria' }],
        [{ text: '🏫 Secundaria', callback_data: 'nivel_secundaria' }],
        [{ text: '🏫 Prepa', callback_data: 'nivel_prepa' }]
      ]
    }
  });
}

// Menú Nivel 2: Seleccionar Liga / Categoría específica para ese nivel
async function enviarMenuCategorias(chatId, nivel) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: '⚠️ Nivel no encontrado.'
    });
    return;
  }

  let listaCategorias = [];

  for (const docId of configLiga.ids) {
    // Buscar en subcolección 'leagues'
    const leaguesSnap = await db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data')
      .collection('leagues')
      .get();

    if (!leaguesSnap.empty) {
      leaguesSnap.forEach(doc => {
        const d = doc.data();
        listaCategorias.push({
          id: doc.id,
          nombre: d.nombre || d.name || d.title || d.liga || doc.id,
          deporte: d.deporte || d.sport || ''
        });
      });
      break;
    }

    // Buscar en subcolección 'tournaments'
    const tournamentsSnap = await db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data')
      .collection('tournaments')
      .get();

    if (!tournamentsSnap.empty) {
      tournamentsSnap.forEach(doc => {
        const d = doc.data();
        listaCategorias.push({
          id: doc.id,
          nombre: d.nombre || d.name || d.title || doc.id,
          deporte: d.deporte || d.sport || ''
        });
      });
      break;
    }
  }

  if (listaCategorias.length === 0) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `⚠️ No se encontraron categorías disponibles para ${configLiga.nombre}.`
    });
    return;
  }

  // Generar botones interactivos (máximo 2 por fila para mejor visualización)
  const inline_keyboard = [];
  for (let i = 0; i < listaCategorias.length; i += 2) {
    const row = [];
    const cat1 = listaCategorias[i];
    const icon1 = cat1.deporte ? '🏆' : '🏆';
    row.push({ text: `${icon1} ${cat1.nombre}`, callback_data: `verliga_${nivel}_${cat1.id}` });

    if (i + 1 < listaCategorias.length) {
      const cat2 = listaCategorias[i + 1];
      const icon2 = cat2.deporte ? '🏆' : '🏆';
      row.push({ text: `${icon2} ${cat2.nombre}`, callback_data: `verliga_${nivel}_${cat2.id}` });
    }
    inline_keyboard.push(row);
  }

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: `<b>📋 CATEGORÍAS / LIGAS DISPONIBLES - ${configLiga.nombre}:</b>\nSelecciona la liga que deseas consultar:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard }
  });
}

// Responde con la tabla de clasificación de una Liga/Categoría específica
async function responderTablaEspecifica(chatId, nivel, leagueId) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) return;

  let listaEquipos = [];
  let nombreLiga = 'LIGA';

  for (const docId of configLiga.ids) {
    // 1. Intentar obtener el nombre de la liga
    const leagueDoc = await db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data')
      .collection('leagues')
      .doc(leagueId)
      .get();

    if (leagueDoc.exists) {
      const ld = leagueDoc.data();
      nombreLiga = ld.nombre || ld.name || ld.title || leagueId;
    }

    // 2. Obtener los equipos de esa liga
    const teamsSnap = await db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data')
      .collection('teams')
      .get();

    if (!teamsSnap.empty) {
      teamsSnap.forEach(doc => {
        const d = doc.data();
        // Filtrar equipos que pertenecen a esta liga específica
        const coincideLiga = (
          d.leagueId === leagueId ||
          d.ligaId === leagueId ||
          d.tournamentId === leagueId ||
          d.categoriaId === leagueId ||
          d.league === leagueId
        );

        if (coincideLiga) {
          listaEquipos.push({
            equipo: d.nombre || d.equipo || d.name || d.team || doc.id,
            puntos: d.puntos ?? d.pts ?? d.points ?? d.score ?? 0,
            pj: d.pj ?? d.jugados ?? d.played ?? 0,
            pg: d.pg ?? d.ganados ?? d.won ?? 0,
            pe: d.pe ?? d.empatados ?? d.drawn ?? 0,
            pp: d.pp ?? d.perdidos ?? d.lost ?? 0
          });
        }
      });

      // Si no hubo filtro exacto pero existen equipos en la subcolección, los tomamos todos si solo hay 1 liga
      if (listaEquipos.length === 0 && teamsSnap.size > 0) {
        teamsSnap.forEach(doc => {
          const d = doc.data();
          listaEquipos.push({
            equipo: d.nombre || d.equipo || d.name || d.team || doc.id,
            puntos: d.puntos ?? d.pts ?? d.points ?? d.score ?? 0
          });
        });
      }

      if (listaEquipos.length > 0) break;
    }
  }

  if (listaEquipos.length === 0) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `⚠️ No se encontraron equipos registrados para la categoría <b>${nombreLiga}</b>.`,
      parse_mode: 'HTML'
    });
    return;
  }

  // Ordenar equipos por puntos de mayor a menor
  listaEquipos.sort((a, b) => (b.puntos || 0) - (a.puntos || 0));

  let mensaje = `<b>🏆 CLASIFICACIÓN - ${configLiga.nombre}</b>\n`;
  mensaje += `📌 <b>Categoría:</b> ${nombreLiga}\n\n`;
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