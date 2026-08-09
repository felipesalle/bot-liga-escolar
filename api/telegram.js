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
      const data = callback.data; // Formato: "action_tipo_nivel_extra"

      if (data.startsWith('mod_')) {
        const modo = data.split('_')[1]; // 'tabla', 'anotadores', 'partidos'
        await enviarMenuLigas(chatId, modo);
      } else if (data.startsWith('nivel_')) {
        const [, modo, nivel] = data.split('_');
        await enviarMenuTorneos(chatId, modo, nivel, false);
      } else if (data.startsWith('historicos_')) {
        const [, modo, nivel] = data.split('_');
        await enviarMenuTorneos(chatId, modo, nivel, true);
      } else if (data.startsWith('torneo_')) {
        const parts = data.split('_');
        const modo = parts[1];
        const nivel = parts[2];
        const tournamentId = parts.slice(3).join('_');
        await enviarMenuCategorias(chatId, modo, nivel, tournamentId);
      } else if (data.startsWith('verliga_')) {
        const parts = data.split('_');
        const modo = parts[1];
        const nivel = parts[2];
        const leagueId = parts.slice(3).join('_');

        if (modo === 'anotadores') {
          await responderAnotadoresEspecifica(chatId, nivel, leagueId);
        } else if (modo === 'partidos') {
          await responderPartidosEspecifica(chatId, nivel, leagueId);
        } else {
          await responderTablaEspecifica(chatId, nivel, leagueId);
        }
      }

      return res.status(200).send('OK');
    }

    // 2. Manejo de mensajes de texto normales
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim().toLowerCase();

      if (text === '/start' || text === '/menu' || text === 'menu') {
        await enviarMenuInicio(chatId);
      } else if (text === '/tabla' || text === 'tabla' || text === 'clasificacion') {
        await enviarMenuLigas(chatId, 'tabla');
      } else if (text === '/anotadores' || text === 'anotadores' || text === '/goleadores' || text === 'goleadores') {
        await enviarMenuLigas(chatId, 'anotadores');
      } else if (text === '/jornada' || text === 'jornada' || text === '/partidos' || text === 'partidos' || text === '/rol' || text === 'rol') {
        await enviarMenuLigas(chatId, 'partidos');
      } else if (text === '/primaria' || text === 'primaria') {
        await enviarMenuTorneos(chatId, 'tabla', 'primaria', false);
      } else if (text === '/secundaria' || text === 'secundaria') {
        await enviarMenuTorneos(chatId, 'tabla', 'secundaria', false);
      } else if (text === '/prepa' || text === 'prepa') {
        await enviarMenuTorneos(chatId, 'tabla', 'prepa', false);
      } else {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Selecciona una opción usando los comandos:\n🏆 /tabla - Ver Clasificación\n⚽ /anotadores - Ver Goleadores\n📅 /partidos - Ver Rol de Juegos / Próximos Partidos'
        });
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error procesando el mensaje:', error);
    return res.status(500).send('Error interno');
  }
};

// Menú Inicio: Elegir entre Clasificación, Anotadores y Próximos Partidos
async function enviarMenuInicio(chatId) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: '<b>⚽ BIENVENIDO AL BOT DE LIGAS ESCOLARES 🏆</b>\n\n¿Qué información deseas consultar?',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🏆 Ver Clasificación / Posiciones', callback_data: 'mod_tabla' }],
        [{ text: '⚽ Ver Tabla de Anotadores / Goleadores', callback_data: 'mod_anotadores' }],
        [{ text: '📅 Ver Próximos Partidos / Rol de Juegos', callback_data: 'mod_partidos' }]
      ]
    }
  });
}

// Menú Nivel 1: Seleccionar Nivel
async function enviarMenuLigas(chatId, modo = 'tabla') {
  let tituloModo = '🏆 CLASIFICACIÓN';
  if (modo === 'anotadores') tituloModo = '⚽ ANOTADORES';
  if (modo === 'partidos') tituloModo = '📅 PRÓXIMOS PARTIDOS / ROL';

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: `<b>${tituloModo} - SELECCIONA EL NIVEL:</b>`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🏫 Primaria', callback_data: `nivel_${modo}_primaria` }],
        [{ text: '🏫 Secundaria', callback_data: `nivel_${modo}_secundaria` }],
        [{ text: '🏫 Prepa', callback_data: `nivel_${modo}_prepa` }]
      ]
    }
  });
}

// Menú Nivel 2: Seleccionar Campeonato / Torneo
async function enviarMenuTorneos(chatId, modo, nivel, mostrarHistoricos = false) {
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

  torneos.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  if (torneos.length === 0) {
    await enviarMenuCategorias(chatId, modo, nivel, 'all');
    return;
  }

  const inline_keyboard = [];

  if (!mostrarHistoricos) {
    const actual = torneos[0];
    inline_keyboard.push([
      { text: `⭐ ${actual.nombre}`, callback_data: `torneo_${modo}_${nivel}_${actual.id}` }
    ]);

    if (torneos.length > 1) {
      inline_keyboard.push([
        { text: '📜 Ver Campeonatos Anteriores / Históricos', callback_data: `historicos_${modo}_${nivel}` }
      ]);
    }
  } else {
    torneos.forEach((t, idx) => {
      const tag = idx === 0 ? ' (Actual)' : ' (Histórico)';
      inline_keyboard.push([
        { text: `🏆 ${t.nombre}${tag}`, callback_data: `torneo_${modo}_${nivel}_${t.id}` }
      ]);
    });
  }

  let tituloModo = '🏆 CLASIFICACIÓN';
  if (modo === 'anotadores') tituloModo = '⚽ ANOTADORES';
  if (modo === 'partidos') tituloModo = '📅 ROL DE JUEGOS';

  const titulo = mostrarHistoricos
    ? `<b>📜 CAMPEONATOS HISTÓRICOS (${tituloModo}) - ${configLiga.nombre}:</b>`
    : `<b>🏆 CAMPEONATO ACTUAL (${tituloModo}) - ${configLiga.nombre}:</b>`;

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: `${titulo}\nSelecciona el torneo a consultar:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard }
  });
}

// Menú Nivel 3: Seleccionar Liga / Categoría dentro de un Torneo
async function enviarMenuCategorias(chatId, modo, nivel, tournamentId) {
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

  let icon = '🏆';
  if (modo === 'anotadores') icon = '⚽';
  if (modo === 'partidos') icon = '📅';

  const inline_keyboard = [];
  for (let i = 0; i < listaCategorias.length; i += 2) {
    const row = [];
    const cat1 = listaCategorias[i];
    row.push({ text: `${icon} ${cat1.nombre}`, callback_data: `verliga_${modo}_${nivel}_${cat1.id}` });

    if (i + 1 < listaCategorias.length) {
      const cat2 = listaCategorias[i + 1];
      row.push({ text: `${icon} ${cat2.nombre}`, callback_data: `verliga_${modo}_${nivel}_${cat2.id}` });
    }
    inline_keyboard.push(row);
  }

  let tituloModo = '🏆 CLASIFICACIÓN';
  if (modo === 'anotadores') tituloModo = '⚽ ANOTADORES';
  if (modo === 'partidos') tituloModo = '📅 ROL DE JUEGOS';

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: `<b>📋 CATEGORÍAS (${tituloModo}) - ${configLiga.nombre}:</b>\nSelecciona la categoría a consultar:`,
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
    const dataRef = db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data');

    const leagueDoc = await dataRef.collection('leagues').doc(leagueId).get();
    if (leagueDoc.exists) {
      const ld = leagueDoc.data();
      nombreLiga = ld.name || ld.nombre || ld.title || leagueId;
    }

    const teamsSnap = await dataRef.collection('teams').get();
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

    const matchesSnap = await dataRef.collection('matches').get();
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

// Responde con la tabla de goleadores/anotadores para una Liga/Categoría específica
async function responderAnotadoresEspecifica(chatId, nivel, leagueId) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) return;

  let nombreLiga = 'LIGA';
  let playersMap = {};
  let teamsMap = {};
  let goleadoresMap = {};

  for (const docId of configLiga.ids) {
    const dataRef = db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data');

    const leagueDoc = await dataRef.collection('leagues').doc(leagueId).get();
    if (leagueDoc.exists) {
      const ld = leagueDoc.data();
      nombreLiga = ld.name || ld.nombre || ld.title || leagueId;
    }

    const teamsSnap = await dataRef.collection('teams').get();
    if (!teamsSnap.empty) {
      teamsSnap.forEach(doc => {
        const d = doc.data();
        teamsMap[doc.id] = d.name || d.nombre || d.equipo || doc.id;
      });
    }

    const playersSnap = await dataRef.collection('players').get();
    if (!playersSnap.empty) {
      playersSnap.forEach(doc => {
        const d = doc.data();
        playersMap[doc.id] = {
          name: d.name || d.nombre || doc.id,
          teamId: d.teamId || ''
        };
      });
    }

    const matchesSnap = await dataRef.collection('matches').get();
    if (!matchesSnap.empty) {
      matchesSnap.forEach(doc => {
        const m = doc.data();
        if (m.leagueId === leagueId && Array.isArray(m.scorers)) {
          m.scorers.forEach(item => {
            if (!item || !item.playerId) return;
            const pId = item.playerId;
            const tId = item.teamId || (playersMap[pId] ? playersMap[pId].teamId : '');
            const golesCount = Number(item.count || item.goals || 1);

            const playerName = playersMap[pId] ? playersMap[pId].name : 'Jugador';
            const teamName = teamsMap[tId] || 'Equipo';

            if (!goleadoresMap[pId]) {
              goleadoresMap[pId] = {
                name: playerName,
                teamName: teamName,
                goles: 0
              };
            }
            goleadoresMap[pId].goles += golesCount;
          });
        }
      });
    }

    if (Object.keys(goleadoresMap).length > 0) break;
  }

  const listaGoleadores = Object.values(goleadoresMap);

  if (listaGoleadores.length === 0) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `⚠️ No hay goles registrados aún para la categoría <b>${nombreLiga}</b>.`,
      parse_mode: 'HTML'
    });
    return;
  }

  listaGoleadores.sort((a, b) => b.goles - a.goles);

  let mensaje = `<b>⚽ TABLA DE ANOTADORES - ${configLiga.nombre}</b>\n`;
  mensaje += `📌 <b>Categoría:</b> ${nombreLiga}\n\n`;
  mensaje += '<pre>';
  mensaje += 'Pos Jugador       Equipo      Goles\n';
  mensaje += '-----------------------------------\n';

  listaGoleadores.slice(0, 15).forEach((item, index) => {
    const pos = String(index + 1).padEnd(2, ' ');
    const jugador = String(item.name).substring(0, 12).padEnd(13, ' ');
    const equipo = String(item.teamName).substring(0, 10).padEnd(11, ' ');
    const goles = String(item.goles).padStart(5, ' ');
    mensaje += `${pos}. ${jugador}${equipo}${goles}\n`;
  });
  mensaje += '</pre>';

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: mensaje,
    parse_mode: 'HTML'
  });
}

// Responde con el Rol de Juegos / Próximos Partidos para una Liga/Categoría específica
async function responderPartidosEspecifica(chatId, nivel, leagueId) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) return;

  let nombreLiga = 'LIGA';
  let teamsMap = {};
  let proximosPartidos = [];

  for (const docId of configLiga.ids) {
    const dataRef = db.collection('artifacts')
      .doc(docId)
      .collection('public')
      .doc('data');

    const leagueDoc = await dataRef.collection('leagues').doc(leagueId).get();
    if (leagueDoc.exists) {
      const ld = leagueDoc.data();
      nombreLiga = ld.name || ld.nombre || ld.title || leagueId;
    }

    const teamsSnap = await dataRef.collection('teams').get();
    if (!teamsSnap.empty) {
      teamsSnap.forEach(doc => {
        const d = doc.data();
        teamsMap[doc.id] = d.name || d.nombre || d.equipo || doc.id;
      });
    }

    const matchesSnap = await dataRef.collection('matches').get();
    if (!matchesSnap.empty) {
      matchesSnap.forEach(doc => {
        const m = doc.data();
        if (m.leagueId === leagueId) {
          // Si scoreHome es null o no es numero, es un proximo partido sin jugar
          const sinJugar = (m.scoreHome === null || m.scoreHome === undefined || typeof m.scoreHome !== 'number');

          if (sinJugar) {
            const homeName = teamsMap[m.homeTeamId] || 'Equipo Local';
            const awayName = teamsMap[m.awayTeamId] || 'Equipo Visitante';
            const fecha = m.date || m.fecha || 'Por definir';
            const hora = m.time || m.hora || '';
            const cancha = m.cancha || m.field || m.location || '';

            proximosPartidos.push({
              fecha,
              hora,
              cancha,
              homeName,
              awayName
            });
          }
        }
      });
    }

    if (proximosPartidos.length > 0) break;
  }

  if (proximosPartidos.length === 0) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `⚠️ No hay próximos partidos programados actualmente para la categoría <b>${nombreLiga}</b>.`,
      parse_mode: 'HTML'
    });
    return;
  }

  // Ordenar por fecha ascendente
  proximosPartidos.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

  // Agrupar por fecha
  const partidosPorFecha = {};
  proximosPartidos.forEach(p => {
    if (!partidosPorFecha[p.fecha]) partidosPorFecha[p.fecha] = [];
    partidosPorFecha[p.fecha].push(p);
  });

  let mensaje = `<b>📅 ROL DE JUEGOS - ${configLiga.nombre}</b>\n`;
  mensaje += `📌 <b>Categoría:</b> ${nombreLiga}\n\n`;

  for (const [fecha, partidos] of Object.entries(partidosPorFecha)) {
    mensaje += `🗓 <b>Fecha: ${fecha}</b>\n`;
    partidos.forEach(p => {
      let extra = '';
      if (p.hora) extra += ` (${p.hora}`;
      if (p.cancha) extra += extra ? ` - ${p.cancha})` : ` (${p.cancha})`;
      else if (extra) extra += ')';

      mensaje += `  • <b>${p.homeName}</b> 🆚 <b>${p.awayName}</b>${extra}\n`;
    });
    mensaje += '\n';
  }

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: mensaje,
    parse_mode: 'HTML'
  });
}