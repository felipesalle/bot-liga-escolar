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
        await enviarMenuTorneos(chatId, nivel, false);
      }
      // Mostrar historicos (ej: "historicos_primaria")
      else if (data.startsWith('historicos_')) {
        const nivel = data.split('_')[1];
        await enviarMenuTorneos(chatId, nivel, true);
      }
      // Torneo seleccionado (ej: "torneo_primaria_IDTORNEO")
      else if (data.startsWith('torneo_')) {
        const parts = data.split('_');
        const nivel = parts[1];
        const tournamentId = parts.slice(2).join('_');
        await enviarMenuCategorias(chatId, nivel, tournamentId);
      }
      // Liga/Categoría seleccionada (ej: "verliga_primaria_IDLIGA")
      else if (data.startsWith('verliga_')) {
        const parts = data.split('_');
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
        await enviarMenuTorneos(chatId, 'primaria', false);
      } else if (text === '/secundaria' || text === 'secundaria') {
        await enviarMenuTorneos(chatId, 'secundaria', false);
      } else if (text === '/prepa' || text === 'prepa') {
        await enviarMenuTorneos(chatId, 'prepa', false);
      } else {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Selecciona una opción usando /tabla para ver los niveles disponibles.'
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

// Menú Nivel 2: Seleccionar Campeonato / Torneo
async function enviarMenuTorneos(chatId, nivel, mostrarHistoricos = false) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) return;

  let torneos = [];

  for (const docId of configLiga.ids) {
    const snap = await db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data')
      .collection('tournaments')
      .get();

    if (!snap.empty) {
      snap.forEach(doc => {
        const d = doc.data();
        torneos.push({
          id: doc.id,
          nombre: d.name || d.nombre || doc.id,
          deporte: d.sport || d.deporte || '',
          createdAt: d.createdAt || ''
        });
      });
      break;
    }
  }

  // Ordenar por fecha de creación descendente (más reciente primero)
  torneos.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  if (torneos.length === 0) {
    // Si no se usaron torneos en este documento, pasamos directo a listar categorias
    await enviarMenuCategorias(chatId, nivel, 'all');
    return;
  }

  const inline_keyboard = [];

  if (!mostrarHistoricos) {
    // Mostrar el Torneo Actual (el primero de la lista ordenada)
    const actual = torneos[0];
    inline_keyboard.push([
      { text: `⭐ ${actual.nombre}`, callback_data: `torneo_${nivel}_${actual.id}` }
    ]);

    // Si hay más de 1 torneo, mostrar opción para históricos
    if (torneos.length > 1) {
      inline_keyboard.push([
        { text: '📜 Ver Campeonatos Anteriores / Históricos', callback_data: `historicos_${nivel}` }
      ]);
    }
  } else {
    // Mostrar TODOS los torneos pasados y actuales
    torneos.forEach((t, idx) => {
      const tag = idx === 0 ? ' (Actual)' : ' (Histórico)';
      inline_keyboard.push([
        { text: `🏆 ${t.nombre}${tag}`, callback_data: `torneo_${nivel}_${t.id}` }
      ]);
    });
  }

  const titulo = mostrarHistoricos
    ? `<b>📜 CAMPEONATOS HISTÓRICOS - ${configLiga.nombre}:</b>`
    : `<b>🏆 CAMPEONATO ACTUAL - ${configLiga.nombre}:</b>`;

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: `${titulo}\nSelecciona el torneo a consultar:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard }
  });
}

// Menú Nivel 3: Seleccionar Liga / Categoría dentro de un Torneo
async function enviarMenuCategorias(chatId, nivel, tournamentId) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) return;

  let listaCategorias = [];

  for (const docId of configLiga.ids) {
    const leaguesSnap = await db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data')
      .collection('leagues')
      .get();

    if (!leaguesSnap.empty) {
      leaguesSnap.forEach(doc => {
        const d = doc.data();
        // Filtrar por torneo si tournamentId no es 'all' y la liga especifica su tournamentId
        if (tournamentId === 'all' || !d.tournamentId || d.tournamentId === tournamentId) {
          listaCategorias.push({
            id: doc.id,
            nombre: d.name || d.nombre || d.title || doc.id,
            deporte: d.sport || d.deporte || ''
          });
        }
      });
      break;
    }
  }

  if (listaCategorias.length === 0) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `⚠️ No se encontraron categorías/ligas registradas para el torneo seleccionado en ${configLiga.nombre}.`
    });
    return;
  }

  const inline_keyboard = [];
  for (let i = 0; i < listaCategorias.length; i += 2) {
    const row = [];
    const cat1 = listaCategorias[i];
    row.push({ text: `⚽ ${cat1.nombre}`, callback_data: `verliga_${nivel}_${cat1.id}` });

    if (i + 1 < listaCategorias.length) {
      const cat2 = listaCategorias[i + 1];
      row.push({ text: `⚽ ${cat2.nombre}`, callback_data: `verliga_${nivel}_${cat2.id}` });
    }
    inline_keyboard.push(row);
  }

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: `<b>📋 CATEGORÍAS / LIGAS DISPONIBLES - ${configLiga.nombre}:</b>\nSelecciona la categoría que deseas consultar:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard }
  });
}

// Responde con la tabla calculada a partir de los marcadores en 'matches'
async function responderTablaEspecifica(chatId, nivel, leagueId) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) return;

  let equiposMap = {};
  let nombreLiga = 'LIGA';

  for (const docId of configLiga.ids) {
    // 1. Obtener nombre de la liga
    const leagueDoc = await db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data')
      .collection('leagues')
      .doc(leagueId)
      .get();

    if (leagueDoc.exists) {
      const ld = leagueDoc.data();
      nombreLiga = ld.name || ld.nombre || ld.title || leagueId;
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
        if (!d.leagueId || d.leagueId === leagueId) {
          equiposMap[doc.id] = {
            id: doc.id,
            equipo: d.name || d.nombre || d.equipo || doc.id,
            pj: 0,
            pg: 0,
            pe: 0,
            pp: 0,
            gf: 0,
            gc: 0,
            dg: 0,
            puntos: 0
          };
        }
      });
    }

    // 3. Obtener los partidos de esa liga para calcular puntos a partir de scoreHome y scoreAway
    const matchesSnap = await db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data')
      .collection('matches')
      .get();

    if (!matchesSnap.empty) {
      matchesSnap.forEach(doc => {
        const m = doc.data();
        if (m.leagueId === leagueId && typeof m.scoreHome === 'number' && typeof m.scoreAway === 'number') {
          const home = equiposMap[m.homeTeamId];
          const away = equiposMap[m.awayTeamId];

          if (home) {
            home.pj += 1;
            home.gf += m.scoreHome;
            home.gc += m.scoreAway;
          }
          if (away) {
            away.pj += 1;
            away.gf += m.scoreAway;
            away.gc += m.scoreHome;
          }

          if (home && away) {
            if (m.scoreHome > m.scoreAway) {
              home.pg += 1;
              home.puntos += 3;
              away.pp += 1;
            } else if (m.scoreAway > m.scoreHome) {
              away.pg += 1;
              away.puntos += 3;
              home.pp += 1;
            } else {
              home.pe += 1;
              home.puntos += 1;
              away.pe += 1;
              away.puntos += 1;
            }
          }
        }
      });
    }

    if (Object.keys(equiposMap).length > 0) break;
  }

  const listaEquipos = Object.values(equiposMap);

  if (listaEquipos.length === 0) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `⚠️ No se encontraron equipos registrados para la categoría <b>${nombreLiga}</b>.`,
      parse_mode: 'HTML'
    });
    return;
  }

  // Calcular diferencia de goles y ordenar (Puntos desc, DG desc, GF desc)
  listaEquipos.forEach(item => {
    item.dg = item.gf - item.gc;
  });

  listaEquipos.sort((a, b) => {
    if (b.puntos !== a.puntos) return b.puntos - a.puntos;
    if (b.dg !== a.dg) return b.dg - a.dg;
    return b.gf - a.gf;
  });

  let mensaje = `<b>🏆 CLASIFICACIÓN - ${configLiga.nombre}</b>\n`;
  mensaje += `📌 <b>Categoría:</b> ${nombreLiga}\n\n`;
  mensaje += '<pre>';
  mensaje += 'Pos Equipo       PJ  Pts\n';
  mensaje += '------------------------\n';

  listaEquipos.forEach((item, index) => {
    const pos = String(index + 1).padEnd(2, ' ');
    const equipo = String(item.equipo).substring(0, 10).padEnd(11, ' ');
    const pj = String(item.pj).padStart(2, ' ');
    const pts = String(item.puntos).padStart(4, ' ');
    mensaje += `${pos}. ${equipo}${pj}${pts}\n`;
  });
  mensaje += '</pre>';

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: mensaje,
    parse_mode: 'HTML'
  });
}