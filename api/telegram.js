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
  'primaria': { ids: ['lasalle-primaria-deportes', 'lasalle-primaria', 'primaria'], nombre: '🏫 PRIMARIA', code: 'p' },
  'secundaria': { ids: ['lasalle-secundaria-deportes', 'lasalle-secundaria', 'secundaria'], nombre: '🏫 SECUNDARIA', code: 's' },
  'prepa': { ids: ['default-app-id', 'default-app-io', 'lasalle-prepa-deportes', 'lasalle-prepa', 'prepa'], nombre: '🏫 PREPA', code: 'e' }
};

const CODE_TO_NIVEL = {
  'p': 'primaria',
  's': 'secundaria',
  'e': 'prepa'
};

// Caché en memoria para guardar resultados de Firestore en warm instances (TTL: 5 minutos)
const memoryCache = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getCachedDocs(docId, collectionName, queryWhereField = null, queryWhereValue = null) {
  const cacheKey = `${docId}_${collectionName}_${queryWhereField || 'all'}_${queryWhereValue || 'all'}`;
  const now = Date.now();

  if (memoryCache[cacheKey] && (now - memoryCache[cacheKey].timestamp < CACHE_TTL_MS)) {
    return memoryCache[cacheKey].data;
  }

  let ref = db.collection('artifacts')
    .doc(docId)
    .collection('public')
    .doc('data')
    .collection(collectionName);

  if (queryWhereField && queryWhereValue) {
    ref = ref.where(queryWhereField, '==', queryWhereValue);
  }

  const snap = await ref.get();
  const docs = [];
  if (!snap.empty) {
    snap.forEach(d => {
      docs.push({ id: d.id, ...d.data() });
    });
  }

  memoryCache[cacheKey] = {
    timestamp: now,
    data: docs
  };

  return docs;
}

// Función auxiliar ultra-robusta de 3 niveles con fallback garantizado
async function sendTelegramMessage(chatId, text, options = {}) {
  try {
    // Intento 1: Mensaje original (con HTML y botones)
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text,
      ...options
    });
  } catch (err) {
    console.error('Error enviando mensaje Telegram (Intento 1 HTML):', err?.response?.data || err.message);
    try {
      // Intento 2: Texto plano con botones (por si falló la sintaxis HTML)
      const plainText = text.replace(/<[^>]*>/g, '');
      const fallbackOptions = { ...options };
      delete fallbackOptions.parse_mode;

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: plainText,
        ...fallbackOptions
      });
    } catch (err2) {
      console.error('Error enviando mensaje Telegram (Intento 2 Botones):', err2?.response?.data || err2.message);
      try {
        // Intento 3: Texto plano limpio sin botones (Garantía absoluta de entrega)
        const plainText = text.replace(/<[^>]*>/g, '');
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: plainText
        });
      } catch (err3) {
        console.error('Error crítico final Telegram:', err3?.response?.data || err3.message);
      }
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getSportEmoji(deporte) {
  if (!deporte) return '🏅';
  const dep = deporte.toLowerCase();
  if (dep.includes('fút') || dep.includes('fut') || dep.includes('socc')) return '⚽';
  if (dep.includes('básq') || dep.includes('basq') || dep.includes('basket')) return '🏀';
  if (dep.includes('volei') || dep.includes('volli') || dep.includes('voley')) return '🏐';
  if (dep.includes('béis') || dep.includes('beis')) return '⚾';
  return '🏅';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot activo');

  try {
    const update = req.body;

    // 1. Manejo de botones (Callback Queries)
    if (update.callback_query) {
      const callback = update.callback_query;
      const chatId = callback.message.chat.id;
      const data = callback.data;

      if (data.startsWith('mod_')) {
        const modo = data.split('_')[1];
        if (modo === 'buscar') {
          await sendTelegramMessage(chatId, '🔍 <b>BÚSQUEDA DE EQUIPO</b>\n\nEscribe el nombre de tu equipo directamente o usa el comando <code>/equipo</code>.\nEjemplo: <code>/equipo Mexico</code> o <code>/buscar Perú</code>', { parse_mode: 'HTML' });
        } else {
          await enviarMenuLigas(chatId, modo);
        }
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
      } else if (data.startsWith('vq_')) {
        const parts = data.split('_');
        const code = parts[1];
        const nivel = CODE_TO_NIVEL[code] || code;
        const teamId = parts.slice(2).join('_');
        await responderDetalleEquipo(chatId, nivel, teamId);
      } else if (data.startsWith('verequipo_')) {
        const parts = data.split('_');
        const nivel = parts[1];
        const teamId = parts.slice(2).join('_');
        await responderDetalleEquipo(chatId, nivel, teamId);
      }

      return res.status(200).send('OK');
    }

    // 2. Manejo de mensajes de texto normales
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();
      const lower = text.toLowerCase();

      if (lower === '/start' || lower === '/menu' || lower === 'menu') {
        await enviarMenuInicio(chatId);
      } else if (lower === '/tabla' || lower === 'tabla' || lower === 'clasificacion') {
        await enviarMenuLigas(chatId, 'tabla');
      } else if (lower === '/anotadores' || lower === 'anotadores' || lower === '/goleadores' || lower === 'goleadores') {
        await enviarMenuLigas(chatId, 'anotadores');
      } else if (lower === '/jornada' || lower === 'jornada' || lower === '/partidos' || lower === 'partidos' || lower === '/rol' || lower === 'rol') {
        await enviarMenuLigas(chatId, 'partidos');
      } else if (lower.startsWith('/equipo') || lower.startsWith('/buscar') || lower.startsWith('equipo ') || lower.startsWith('buscar ')) {
        const query = text.replace(/^\/(equipo|buscar)\s*/i, '').replace(/^(equipo|buscar)\s*/i, '').trim();
        if (!query) {
          await sendTelegramMessage(chatId, 'Escribe el nombre del equipo después del comando.\nEjemplo: <code>/equipo Mexico</code> o <code>/buscar Perú</code>', { parse_mode: 'HTML' });
        } else {
          await buscarEquipo(chatId, query);
        }
      } else if (lower === '/primaria' || lower === 'primaria') {
        await enviarMenuTorneos(chatId, 'tabla', 'primaria', false);
      } else if (lower === '/secundaria' || lower === 'secundaria') {
        await enviarMenuTorneos(chatId, 'tabla', 'secundaria', false);
      } else if (lower === '/prepa' || lower === 'prepa') {
        await enviarMenuTorneos(chatId, 'tabla', 'prepa', false);
      } else {
        await buscarEquipo(chatId, text);
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error procesando el mensaje:', error);
    try {
      const chatId = req.body?.message?.chat?.id || req.body?.callback_query?.message?.chat?.id;
      if (chatId) {
        const errStr = String(error?.message || error);
        if (errStr.includes('RESOURCE_EXHAUSTED')) {
          await sendTelegramMessage(chatId, '⚠️ <b>LÍMITE DE CONSULTAS ALCANZADO</b>\n\nLa base de datos (Firebase) ha alcanzado su cuota diaria gratuita de lecturas. Por favor, intenta de nuevo más tarde o mañana cuando se reinicie la cuota.', { parse_mode: 'HTML' });
        } else {
          await sendTelegramMessage(chatId, '⚠️ Ocurrió un error al procesar tu solicitud. Por favor intenta de nuevo en unos momentos.');
        }
      }
    } catch (e) {
      console.error('Error enviando notificación de error a Telegram:', e);
    }
    return res.status(200).send('OK');
  }
};

// Menú Inicio
async function enviarMenuInicio(chatId) {
  await sendTelegramMessage(chatId, '<b>⚽ BIENVENIDO AL BOT DE LIGAS ESCOLARES 🏆</b>\n\n¿Qué información deseas consultar?', {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🏆 Ver Clasificación / Posiciones', callback_data: 'mod_tabla' }],
        [{ text: '⚽ Ver Tabla de Anotadores / Goleadores', callback_data: 'mod_anotadores' }],
        [{ text: '📅 Ver Próximos Partidos / Rol de Juegos', callback_data: 'mod_partidos' }],
        [{ text: '🔍 Buscar Mi Equipo', callback_data: 'mod_buscar' }]
      ]
    }
  });
}

// Menú Nivel 1: Seleccionar Nivel
async function enviarMenuLigas(chatId, modo = 'tabla') {
  let tituloModo = '🏆 CLASIFICACIÓN';
  if (modo === 'anotadores') tituloModo = '⚽ ANOTADORES';
  if (modo === 'partidos') tituloModo = '📅 PRÓXIMOS PARTIDOS / ROL';

  await sendTelegramMessage(chatId, `<b>${tituloModo} - SELECCIONA EL NIVEL:</b>`, {
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
    const docs = await getCachedDocs(docId, 'tournaments');
    if (docs.length > 0) {
      docs.forEach(d => {
        torneos.push({
          id: d.id,
          nombre: d.name || d.nombre || d.id,
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
      { text: `⭐ ${escapeHtml(actual.nombre)}`, callback_data: `torneo_${modo}_${nivel}_${actual.id}` }
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
        { text: `🏆 ${escapeHtml(t.nombre)}${tag}`, callback_data: `torneo_${modo}_${nivel}_${t.id}` }
      ]);
    });
  }

  let tituloModo = '🏆 CLASIFICACIÓN';
  if (modo === 'anotadores') tituloModo = '⚽ ANOTADORES';
  if (modo === 'partidos') tituloModo = '📅 ROL DE JUEGOS';

  const titulo = mostrarHistoricos
    ? `<b>📜 CAMPEONATOS HISTÓRICOS (${tituloModo}) - ${configLiga.nombre}:</b>`
    : `<b>🏆 CAMPEONATO ACTUAL (${tituloModo}) - ${configLiga.nombre}:</b>`;

  await sendTelegramMessage(chatId, `${titulo}\nSelecciona el torneo a consultar:`, {
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
    const docs = await getCachedDocs(docId, 'leagues');
    if (docs.length > 0) {
      docs.forEach(d => {
        if (tournamentId === 'all' || !d.tournamentId || d.tournamentId === tournamentId) {
          listaCategorias.push({
            id: d.id,
            nombre: d.name || d.nombre || d.title || d.id,
            deporte: d.sport || d.deporte || ''
          });
        }
      });
      break;
    }
  }

  if (listaCategorias.length === 0) {
    await sendTelegramMessage(chatId, `⚠️ No se encontraron categorías/ligas registradas para el torneo seleccionado en ${configLiga.nombre}.`);
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

  await sendTelegramMessage(chatId, `<b>📋 CATEGORÍAS (${tituloModo}) - ${configLiga.nombre}:</b>\nSelecciona la categoría a consultar:`, {
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
    const leaguesDocs = await getCachedDocs(docId, 'leagues');
    const targetLeague = leaguesDocs.find(l => l.id === leagueId);
    if (targetLeague) {
      nombreLiga = targetLeague.name || targetLeague.nombre || targetLeague.title || leagueId;
    }

    const teamsDocs = await getCachedDocs(docId, 'teams');
    if (teamsDocs.length > 0) {
      teamsDocs.forEach(d => {
        if (!d.leagueId || d.leagueId === leagueId) {
          equiposMap[d.id] = {
            id: d.id,
            equipo: d.name || d.nombre || d.equipo || d.id,
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

    // Filtrar partidos exclusivamente por leagueId en la consulta
    const matchesDocs = await getCachedDocs(docId, 'matches', 'leagueId', leagueId);
    if (matchesDocs.length > 0) {
      matchesDocs.forEach(m => {
        const sHome = (m.scoreHome !== null && m.scoreHome !== undefined && m.scoreHome !== '') ? Number(m.scoreHome) : null;
        const sAway = (m.scoreAway !== null && m.scoreAway !== undefined && m.scoreAway !== '') ? Number(m.scoreAway) : null;
        const esJugado = sHome !== null && !isNaN(sHome) && sAway !== null && !isNaN(sAway);

        if (esJugado) {
          const home = equiposMap[m.homeTeamId];
          const away = equiposMap[m.awayTeamId];

          if (home) {
            home.pj += 1;
            home.gf += sHome;
            home.gc += sAway;
          }
          if (away) {
            away.pj += 1;
            away.gf += sAway;
            away.gc += sHome;
          }

          if (home && away) {
            if (sHome > sAway) {
              home.pg += 1;
              home.puntos += 3;
              away.pp += 1;
            } else if (sAway > sHome) {
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
    await sendTelegramMessage(chatId, `⚠️ No se encontraron equipos registrados para la categoría <b>${escapeHtml(nombreLiga)}</b>.`, { parse_mode: 'HTML' });
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

  let mensaje = `<b>🏆 CLASIFICACIÓN - ${escapeHtml(configLiga.nombre)}</b>\n`;
  mensaje += `📌 <b>Categoría:</b> ${escapeHtml(nombreLiga)}\n\n`;
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

  await sendTelegramMessage(chatId, mensaje, { parse_mode: 'HTML' });
}

// Responde con la tabla de goleadores/anotadores
async function responderAnotadoresEspecifica(chatId, nivel, leagueId) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) return;

  let nombreLiga = 'LIGA';
  let playersMap = {};
  let teamsMap = {};
  let goleadoresMap = {};

  for (const docId of configLiga.ids) {
    const leaguesDocs = await getCachedDocs(docId, 'leagues');
    const targetLeague = leaguesDocs.find(l => l.id === leagueId);
    if (targetLeague) {
      nombreLiga = targetLeague.name || targetLeague.nombre || targetLeague.title || leagueId;
    }

    const teamsDocs = await getCachedDocs(docId, 'teams');
    if (teamsDocs.length > 0) {
      teamsDocs.forEach(d => {
        teamsMap[d.id] = d.name || d.nombre || d.equipo || d.id;
      });
    }

    const playersDocs = await getCachedDocs(docId, 'players');
    if (playersDocs.length > 0) {
      playersDocs.forEach(d => {
        playersMap[d.id] = {
          name: d.name || d.nombre || d.id,
          teamId: d.teamId || ''
        };
      });
    }

    const matchesDocs = await getCachedDocs(docId, 'matches', 'leagueId', leagueId);
    if (matchesDocs.length > 0) {
      matchesDocs.forEach(m => {
        if (Array.isArray(m.scorers)) {
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
    await sendTelegramMessage(chatId, `⚠️ No hay goles registrados aún para la categoría <b>${escapeHtml(nombreLiga)}</b>.`, { parse_mode: 'HTML' });
    return;
  }

  listaGoleadores.sort((a, b) => b.goles - a.goles);

  let mensaje = `<b>⚽ TABLA DE ANOTADORES - ${escapeHtml(configLiga.nombre)}</b>\n`;
  mensaje += `📌 <b>Categoría:</b> ${escapeHtml(nombreLiga)}\n\n`;
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

  await sendTelegramMessage(chatId, mensaje, { parse_mode: 'HTML' });
}

// Responde con el Rol de Juegos / Próximos Partidos
async function responderPartidosEspecifica(chatId, nivel, leagueId) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) return;

  let nombreLiga = 'LIGA';
  let teamsMap = {};
  let proximosPartidos = [];

  for (const docId of configLiga.ids) {
    const leaguesDocs = await getCachedDocs(docId, 'leagues');
    const targetLeague = leaguesDocs.find(l => l.id === leagueId);
    if (targetLeague) {
      nombreLiga = targetLeague.name || targetLeague.nombre || targetLeague.title || leagueId;
    }

    const teamsDocs = await getCachedDocs(docId, 'teams');
    if (teamsDocs.length > 0) {
      teamsDocs.forEach(d => {
        teamsMap[d.id] = d.name || d.nombre || d.equipo || d.id;
      });
    }

    const matchesDocs = await getCachedDocs(docId, 'matches', 'leagueId', leagueId);
    if (matchesDocs.length > 0) {
      matchesDocs.forEach(m => {
        const sHome = (m.scoreHome !== null && m.scoreHome !== undefined && m.scoreHome !== '') ? Number(m.scoreHome) : null;
        const sAway = (m.scoreAway !== null && m.scoreAway !== undefined && m.scoreAway !== '') ? Number(m.scoreAway) : null;
        const sinJugar = sHome === null || isNaN(sHome) || sAway === null || isNaN(sAway);

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
      });
    }

    if (proximosPartidos.length > 0) break;
  }

  if (proximosPartidos.length === 0) {
    await sendTelegramMessage(chatId, `⚠️ No hay próximos partidos programados actualmente para la categoría <b>${escapeHtml(nombreLiga)}</b>.`, { parse_mode: 'HTML' });
    return;
  }

  proximosPartidos.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

  const partidosPorFecha = {};
  proximosPartidos.forEach(p => {
    if (!partidosPorFecha[p.fecha]) partidosPorFecha[p.fecha] = [];
    partidosPorFecha[p.fecha].push(p);
  });

  let mensaje = `<b>📅 ROL DE JUEGOS - ${escapeHtml(configLiga.nombre)}</b>\n`;
  mensaje += `📌 <b>Categoría:</b> ${escapeHtml(nombreLiga)}\n\n`;

  for (const [fecha, partidos] of Object.entries(partidosPorFecha)) {
    mensaje += `🗓 <b>Fecha: ${escapeHtml(fecha)}</b>\n`;
    partidos.forEach(p => {
      let extra = '';
      if (p.hora) extra += ` (${escapeHtml(p.hora)}`;
      if (p.cancha) extra += extra ? ` - ${escapeHtml(p.cancha)})` : ` (${escapeHtml(p.cancha)})`;
      else if (extra) extra += ')';

      mensaje += `  • <b>${escapeHtml(p.homeName)}</b> 🆚 <b>${escapeHtml(p.awayName)}</b>${extra}\n`;
    });
    mensaje += '\n';
  }

  await sendTelegramMessage(chatId, mensaje, { parse_mode: 'HTML' });
}

// Búsqueda rápida optimizada por nombre de equipo
async function buscarEquipo(chatId, query) {
  const queryLower = query.toLowerCase().trim();

  const promesas = Object.entries(LIGAS).map(async ([nivelKey, configLiga]) => {
    for (const docId of configLiga.ids) {
      const teamsDocs = await getCachedDocs(docId, 'teams');

      if (teamsDocs.length > 0) {
        const matching = [];
        teamsDocs.forEach(d => {
          const name = d.name || d.nombre || d.equipo || '';
          if (name.toLowerCase().includes(queryLower)) {
            matching.push({
              teamId: d.id,
              teamName: name,
              leagueId: d.leagueId || '',
              nivel: nivelKey,
              nivelNombre: configLiga.nombre,
              docCode: configLiga.code || nivelKey[0],
              docId
            });
          }
        });
        if (matching.length > 0) return matching;
      }
    }
    return [];
  });

  const resultadosPorNivel = await Promise.all(promesas);
  const coincidencias = resultadosPorNivel.flat();

  if (coincidencias.length === 0) {
    await sendTelegramMessage(chatId, `⚠️ No se encontró ningún equipo que coincida con "<b>${escapeHtml(query)}</b>".`, { parse_mode: 'HTML' });
    return;
  }

  if (coincidencias.length === 1) {
    await responderDetalleEquipo(chatId, coincidencias[0].nivel, coincidencias[0].teamId);
  } else {
    for (const c of coincidencias) {
      if (c.leagueId) {
        const leaguesDocs = await getCachedDocs(c.docId, 'leagues');
        const lData = leaguesDocs.find(l => l.id === c.leagueId);
        if (lData) {
          c.nombreLiga = lData.name || lData.nombre || lData.title || 'Categoría';
        }
      }
      if (!c.nombreLiga) c.nombreLiga = 'Categoría';
    }

    const inline_keyboard = coincidencias.map(c => {
      const code = c.docCode || 'p';
      const labelText = `⚽ ${c.teamName} - ${c.nombreLiga} (${c.nivelNombre})`.substring(0, 50);
      return [
        {
          text: labelText,
          callback_data: `vq_${code}_${c.teamId}`
        }
      ];
    });

    await sendTelegramMessage(chatId, `🔍 Se encontraron <b>${coincidencias.length} equipos</b> que coinciden con "<b>${escapeHtml(query)}</b>". Selecciona el que deseas consultar:`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard }
    });
  }
}

// Genera la tarjeta con la ficha del equipo
async function responderDetalleEquipo(chatId, nivel, teamId) {
  const configLiga = LIGAS[nivel];
  if (!configLiga) return;

  let teamObj = null;
  let nombreLiga = 'LIGA';
  let deporteLiga = '';
  let teamsMap = {};
  let partidosEquipo = [];

  for (const docId of configLiga.ids) {
    const teamsDocs = await getCachedDocs(docId, 'teams');
    if (teamsDocs.length > 0) {
      teamsDocs.forEach(d => {
        const tName = d.name || d.nombre || d.equipo || d.id;
        teamsMap[d.id] = tName;
        if (d.id === teamId) {
          teamObj = { id: d.id, name: tName, leagueId: d.leagueId || '' };
        }
      });
    }

    if (!teamObj) continue;

    if (teamObj.leagueId) {
      const leaguesDocs = await getCachedDocs(docId, 'leagues');
      const ld = leaguesDocs.find(l => l.id === teamObj.leagueId);
      if (ld) {
        nombreLiga = ld.name || ld.nombre || ld.title || teamObj.leagueId;
        deporteLiga = ld.sport || ld.deporte || '';

        if (!deporteLiga && ld.tournamentId) {
          const tourDocs = await getCachedDocs(docId, 'tournaments');
          const tData = tourDocs.find(t => t.id === ld.tournamentId);
          if (tData) {
            deporteLiga = tData.sport || tData.deporte || '';
          }
        }
      }
    }

    const matchesDocs = await getCachedDocs(docId, 'matches', 'leagueId', teamObj.leagueId);
    if (matchesDocs.length > 0) {
      matchesDocs.forEach(m => {
        if (m.homeTeamId === teamId || m.awayTeamId === teamId) {
          partidosEquipo.push(m);
        }
      });
    }

    break;
  }

  if (!teamObj) {
    await sendTelegramMessage(chatId, '⚠️ No se encontró la información detallada para este equipo.');
    return;
  }

  let pj = 0, pg = 0, pe = 0, pp = 0, gf = 0, gc = 0, puntos = 0;
  let ultimoPartido = null;
  let proximoPartido = null;

  partidosEquipo.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  partidosEquipo.forEach(m => {
    const sHome = (m.scoreHome !== null && m.scoreHome !== undefined && m.scoreHome !== '') ? Number(m.scoreHome) : null;
    const sAway = (m.scoreAway !== null && m.scoreAway !== undefined && m.scoreAway !== '') ? Number(m.scoreAway) : null;
    const esJugado = sHome !== null && !isNaN(sHome) && sAway !== null && !isNaN(sAway);

    const esHome = m.homeTeamId === teamId;
    const rivalId = esHome ? m.awayTeamId : m.homeTeamId;
    const rivalName = teamsMap[rivalId] || 'Rival';

    if (esJugado) {
      const gE = esHome ? sHome : sAway;
      const gR = esHome ? sAway : sHome;

      ultimoPartido = {
        fecha: m.date || '',
        golesEquipo: gE,
        golesRival: gR,
        rivalName
      };

      pj += 1;
      gf += gE;
      gc += gR;

      if (gE > gR) {
        pg += 1;
        puntos += 3;
      } else if (gR > gE) {
        pp += 1;
      } else {
        pe += 1;
        puntos += 1;
      }
    } else if (!proximoPartido) {
      proximoPartido = {
        fecha: m.date || 'Por definir',
        hora: m.time || m.hora || '',
        cancha: m.cancha || m.field || m.location || '',
        rivalName
      };
    }
  });

  const dg = gf - gc;
  const sportEmoji = getSportEmoji(deporteLiga);

  let mensaje = `<b>⚽ FICHA DE EQUIPO - ${escapeHtml(teamObj.name)}</b>\n`;
  mensaje += `📌 <b>Categoría:</b> ${escapeHtml(nombreLiga)} (${configLiga.nombre})\n`;
  if (deporteLiga) {
    mensaje += `${sportEmoji} <b>Deporte:</b> ${escapeHtml(deporteLiga)}\n`;
  }
  mensaje += `\n`;

  mensaje += `📊 <b>Estadísticas en esta Liga:</b>\n`;
  mensaje += ` • <b>Puntos:</b> ${puntos} Pts (en ${pj} PJ)\n`;
  mensaje += ` • <b>Rendimiento:</b> ${pg} PG - ${pe} PE - ${pp} PP\n`;
  mensaje += ` • <b>Goles:</b> ${gf} a favor, ${gc} en contra (DG: ${dg >= 0 ? '+' + dg : dg})\n\n`;

  if (ultimoPartido) {
    mensaje += `⚽ <b>Último Partido Jugado:</b>\n`;
    mensaje += `  ${escapeHtml(teamObj.name)} ${ultimoPartido.golesEquipo} 🆚 ${ultimoPartido.golesRival} ${escapeHtml(ultimoPartido.rivalName)} (${escapeHtml(ultimoPartido.fecha)})\n\n`;
  }

  if (proximoPartido) {
    let extra = '';
    if (proximoPartido.hora) extra += ` (${escapeHtml(proximoPartido.hora)}`;
    if (proximoPartido.cancha) extra += extra ? ` - ${escapeHtml(proximoPartido.cancha)})` : ` (${escapeHtml(proximoPartido.cancha)})`;
    else if (extra) extra += ')';

    mensaje += `📅 <b>Próximo Partido Programado:</b>\n`;
    mensaje += `  ${escapeHtml(teamObj.name)} 🆚 <b>${escapeHtml(proximoPartido.rivalName)}</b> el ${escapeHtml(proximoPartido.fecha)}${extra}\n`;
  } else {
    mensaje += `📅 <b>Próximo Partido:</b> No hay partidos agendados.\n`;
  }

  await sendTelegramMessage(chatId, mensaje, { parse_mode: 'HTML' });
}