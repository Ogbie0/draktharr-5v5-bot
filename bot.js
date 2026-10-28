/**
 * DRAKTHARR - Gelişmiş Discord 5v5 Özel Oyun Lobi, Draft, Ses Kanalı & Liderlik Botu (Tek Dosya)
 * Runtime target: Node.js >=22.5.0 / >=24.x; npm install discord.js@14.25.1
 * Çalıştırma: node bot.js (veya node bot.cjs)
 * Test Modu: node bot.js --test
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomInt } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Yerel .env dosyasını otomatik yükle (harici paket gerektirmez)
(function loadDotEnv() {
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env')
  ];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (key && !process.env[key]) {
          process.env[key] = val;
        }
      }
    } catch {}
  }
})();

// ============================================================================
// 1. AYARLAR (Varsayılan ID'ler ve Ortam Değişkenleri)
// ============================================================================
const AYARLAR = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || '',
  CLIENT_ID: process.env.CLIENT_ID || '1556235493119889480',
  GUILD_ID: process.env.GUILD_ID || '1492677428722663462',
  CREATOR_ROLE_ID: process.env.CREATOR_ROLE_ID || '1562108250843775058',
  VOICE_CATEGORY_ID: process.env.VOICE_CATEGORY_ID || '1556346787663708402',
  LOBBY_VOICE_ID: process.env.LOBBY_VOICE_ID || '1546912598048383046',
  DB_PATH: process.env.DB_PATH || path.join(__dirname, 'draktharr.sqlite')
};

// Sadece Mavi ve Kırmızı takım emojileri
const TEAM_EMOJI = {
  BLUE: '\u{1F535}', // 🔵
  RED: '\u{1F534}'   // 🔴
};

// Discord ANSI Renk Kodları (Mavi / Kırmızı ve Kaptanlar için Koyu/Kalın)
const ANSI = {
  RESET: '\u001b[0m',
  BLUE: '\u001b[0;34m',
  BLUE_BOLD: '\u001b[1;34m',
  RED: '\u001b[0;31m',
  RED_BOLD: '\u001b[1;31m',
  WHITE: '\u001b[0;37m',
  WHITE_BOLD: '\u001b[1;37m',
  GRAY: '\u001b[0;30m'
};

const LANES = ['Top Lane', 'Jungle', 'Mid Lane', 'ADC', 'Support'];

const ACTIVE = state => state !== 'CLOSED';
const isBotUser = uid => String(uid ?? '').startsWith('bot_');

function check(ok, message) {
  if (!ok) throw new Error(message);
}

function clean(value, max) {
  const s = String(value ?? '').trim();
  check(s.length > 0 && s.length <= max, `Alan 1-${max} karakter olmalı.`);
  return s;
}

function formatPlayerMention(m) {
  if (!m) return '-';
  if (isBotUser(m.id)) {
    return `\`${m.nick}\``;
  }
  return `<@${m.id}>`;
}

function getTeamName(l, team) {
  if (team === 'BLUE') return l.blueTeamName || 'Mavi Takım';
  if (team === 'RED') return l.redTeamName || 'Kırmızı Takım';
  return '';
}

function formatColoredPlayer(l, m) {
  if (!m) return `${ANSI.GRAY}Boş${ANSI.RESET}`;
  const isCap = m.id === l.blue || m.id === l.red;
  const label = isCap ? `${m.nick} (KAPTAN)` : `${m.nick}`;
  if (m.team === 'BLUE') {
    return isCap
      ? `${ANSI.BLUE_BOLD}${label}${ANSI.RESET}`
      : `${ANSI.BLUE}${label}${ANSI.RESET}`;
  }
  if (m.team === 'RED') {
    return isCap
      ? `${ANSI.RED_BOLD}${label}${ANSI.RESET}`
      : `${ANSI.RED}${label}${ANSI.RESET}`;
  }
  return `${ANSI.WHITE}${label}${ANSI.RESET}`;
}

// ============================================================================
// 2. 5v5 LOBİ VE OYUN MANTIĞI (STATE MACHINE)
// ============================================================================
function newLobby(guild, channel, owner, name, password, link) {
  name = clean(name, 60);
  password = clean(password, 80);
  link = clean(link, 500);

  if (!/^https?:\/\//i.test(link)) {
    link = `https://${link}`;
  }

  let url;
  try {
    url = new URL(link);
  } catch {
    throw new Error('Geçersiz lobi linki. (Örn: https://lol.com/lobby)');
  }

  check(
    ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password,
    'Link http/https olmalı ve kullanıcı bilgisi içermemeli.'
  );

  return {
    id: randomUUID(),
    guild,
    channel,
    owner,
    name,
    password,
    link: url.href,
    message: null,
    state: 'WAITING', // WAITING | DRAFT | READY | PLAYING | CLOSED
    members: [],      // { id, nick, lane, team: null | 'BLUE' | 'RED' }
    blue: null,       // Mavi kaptan user ID
    red: null,        // Kırmızı kaptan user ID
    blueTeamName: 'Mavi Takım',
    redTeamName: 'Kırmızı Takım',
    turn: 'BLUE',     // Seçim sırası
    revision: 0,
    picks: [],
    blueVoiceId: null,
    redVoiceId: null,
    winner: null,     // 'BLUE' | 'RED' | null
    created: new Date().toISOString(),
    finishedAt: null
  };
}

function captain(l, team) {
  return team === 'BLUE' ? l.blue : l.red;
}

function member(l, uid) {
  return l.members.find(m => m.id === uid);
}

function eligible(l, uid, team) {
  const m = member(l, uid);
  return (
    !!m &&
    !m.team &&
    !l.members.some(x => x.team === team && x.lane === m.lane)
  );
}

function mutate(l, actor, action, data = {}) {
  check(ACTIVE(l.state), 'Bu lobi artık kapalı.');

  const onlyOwner = () =>
    check(actor === l.owner, 'Bu işlemi sadece lobi kurucusu yapabilir.');

  const onlyWaiting = () =>
    check(l.state === 'WAITING', 'Seçimler veya maç başladı; kadro ve kaptanlar kilitli.');

  switch (action) {
    case 'join': {
      onlyWaiting();
      const lane = Number(data.lane);
      check(Number.isInteger(lane) && lane >= 0 && lane < 5, 'Geçersiz koridor.');

      const existing = member(l, actor);
      if (existing) {
        check(existing.lane !== lane, 'Zaten bu koridordasın.');
        check(
          l.members.filter(m => m.lane === lane).length < 2,
          `${LANES[lane]} koridoru dolu (2/2).`
        );
        if (l.blue === actor || l.red === actor) {
          l.blue = l.red = null;
          l.members.forEach(m => { m.team = null; });
        }
        existing.lane = lane;
        existing.nick = clean(data.nick, 80);
        break;
      }

      check(l.members.length < 10, 'Lobi tamamen dolu (10/10).');
      check(
        l.members.filter(m => m.lane === lane).length < 2,
        `${LANES[lane]} koridoru dolu (2/2).`
      );

      l.members.push({
        id: actor,
        nick: clean(data.nick, 80),
        lane,
        team: null
      });
      break;
    }

    case 'leave': {
      onlyWaiting();
      check(member(l, actor), 'Zaten bu lobide değilsin.');

      l.members = l.members.filter(m => m.id !== actor);

      if (l.blue === actor || l.red === actor) {
        l.blue = l.red = null;
        l.members.forEach(m => { m.team = null; });
      }
      break;
    }

    case 'kick': {
      onlyWaiting();
      if (!data.force) onlyOwner();
      const target = member(l, data.target);
      check(target, 'Bu oyuncu lobide bulunamadı.');

      l.members = l.members.filter(m => m.id !== data.target);
      if (l.blue === data.target || l.red === data.target) {
        l.blue = l.red = null;
        l.members.forEach(m => { m.team = null; });
      }
      break;
    }

    case 'setTeamName': {
      const isOwner = actor === l.owner;
      const isBlueCap = actor === l.blue;
      const isRedCap = actor === l.red;
      check(
        isOwner || isBlueCap || isRedCap,
        'Takım ismini sadece takım kaptanları veya lobi kurucusu değiştirebilir.'
      );

      if (data.blueName !== undefined && String(data.blueName).trim().length > 0) {
        check(isBlueCap || isOwner, 'Mavi takımın adını sadece Mavi Kaptan veya kurucu değiştirebilir.');
        l.blueTeamName = clean(data.blueName, 35);
      }
      if (data.redName !== undefined && String(data.redName).trim().length > 0) {
        check(isRedCap || isOwner, 'Kırmızı takımın adını sadece Kırmızı Kaptan veya kurucu değiştirebilir.');
        l.redTeamName = clean(data.redName, 35);
      }
      break;
    }

    case 'fillBots': {
      onlyOwner();
      onlyWaiting();

      const targetCount = Number(data.targetCount ?? 10);
      const includeOwner = data.includeOwner !== false;

      if (includeOwner && !member(l, actor) && l.members.length < targetCount) {
        const openLane = [0, 1, 2, 3, 4].find(
          laneIdx => l.members.filter(m => m.lane === laneIdx).length < 2
        );
        if (openLane !== undefined) {
          const ownerNick = clean(data.ownerNick || 'Kurucu', 80);
          l.members.push({
            id: actor,
            nick: ownerNick,
            lane: openLane,
            team: null
          });
        }
      }

      let botCounter = 1;
      for (let laneIdx = 0; laneIdx < 5; laneIdx++) {
        while (
          l.members.filter(m => m.lane === laneIdx).length < 2 &&
          l.members.length < targetCount
        ) {
          const shortLane = LANES[laneIdx].split(' ')[0];
          const botId = `bot_${laneIdx}_${botCounter}_${randomInt(100, 999)}`;
          const botNick = `TestBot_${shortLane}_${botCounter}`;
          l.members.push({
            id: botId,
            nick: botNick,
            lane: laneIdx,
            team: null
          });
          botCounter++;
        }
      }

      if (data.autoCaptains && l.members.length === 10 && (!l.blue || !l.red)) {
        const ownerMem = member(l, actor);
        const capLane = ownerMem ? ownerMem.lane : 0;
        const pair = l.members.filter(m => m.lane === capLane);
        if (pair.length === 2) {
          const first = ownerMem || pair[0];
          const second = pair.find(m => m.id !== first.id) || pair[1];
          l.blue = first.id;
          l.red = second.id;
          l.members.forEach(x => {
            x.team = x.id === l.blue ? 'BLUE' : x.id === l.red ? 'RED' : null;
          });
        }
      }
      break;
    }

    case 'blue':
    case 'red': {
      onlyOwner();
      onlyWaiting();

      const m = member(l, data.target);
      check(m, 'Seçilen kaptan lobideki oyunculardan biri olmalı.');

      const other = action === 'blue' ? l.red : l.blue;
      check(other !== m.id, 'Aynı oyuncu hem Mavi hem Kırmızı kaptan olamaz.');

      if (other) {
        check(
          member(l, other).lane === m.lane,
          'İki kaptan da aynı koridordan seçilmelidir!'
        );
      }

      l[action] = m.id;
      l.members.forEach(x => {
        x.team = x.id === l.blue ? 'BLUE' : x.id === l.red ? 'RED' : null;
      });
      break;
    }

    case 'randomCaptains': {
      onlyOwner();
      onlyWaiting();

      const fullLanes = [0, 1, 2, 3, 4].filter(
        lane => l.members.filter(m => m.lane === lane).length === 2
      );
      check(
        fullLanes.length > 0,
        'Rastgele kaptan seçebilmek için en az bir koridorda 2 oyuncu bulunmalıdır.'
      );

      const chosenLane = fullLanes[randomInt(0, fullLanes.length)];
      const pair = l.members.filter(m => m.lane === chosenLane);
      const swap = randomInt(0, 2) === 1;

      l.blue = swap ? pair[0].id : pair[1].id;
      l.red = swap ? pair[1].id : pair[0].id;

      l.members.forEach(x => {
        x.team = x.id === l.blue ? 'BLUE' : x.id === l.red ? 'RED' : null;
      });
      break;
    }

    case 'resetCaptains': {
      onlyOwner();
      onlyWaiting();
      l.blue = l.red = null;
      l.members.forEach(m => { m.team = null; });
      break;
    }

    case 'startDraft': {
      onlyOwner();
      onlyWaiting();
      check(
        l.members.length === 10 && l.blue && l.red,
        'Seçimleri başlatmak için 10 oyuncu ve 2 kaptan seçilmiş olmalıdır.'
      );
      check(
        LANES.every((_, i) => l.members.filter(m => m.lane === i).length === 2),
        'Her koridorda tam 2 oyuncu bulunmalıdır.'
      );

      l.state = 'DRAFT';
      l.turn = 'BLUE';
      break;
    }

    case 'pick': {
      check(l.state === 'DRAFT', 'Şu anda aktif bir oyuncu seçimi yok.');
      const currentCap = captain(l, l.turn);
      const canActAsCap =
        actor === currentCap || (isBotUser(currentCap) && actor === l.owner);
      check(canActAsCap, 'Seçim sırası sende değil!');
      check(
        Number(data.revision) === l.revision,
        'Bu seçim menüsü eski kaldı. Lütfen tekrar "Oyuncu Seç" butonuna bas.'
      );
      check(
        eligible(l, data.target, l.turn),
        'Bu oyuncu zaten seçilmiş veya takımında bu koridor dolu.'
      );

      const picked = member(l, data.target);
      const otherTeam = l.turn === 'BLUE' ? 'RED' : 'BLUE';
      picked.team = l.turn;

      l.picks.push({
        order: l.picks.length + 1,
        captain: currentCap,
        player: picked.id,
        team: l.turn
      });

      // Aynı koridordaki karşı oyuncuyu otomatik olarak diğer takıma ata
      const oppositePlayer = l.members.find(
        m => m.lane === picked.lane && m.id !== picked.id && !m.team
      );
      if (oppositePlayer) {
        oppositePlayer.team = otherTeam;
        l.picks.push({
          order: l.picks.length + 1,
          captain: captain(l, otherTeam) || currentCap,
          player: oppositePlayer.id,
          team: otherTeam
        });
      }

      if (l.members.every(m => m.team)) {
        l.state = 'READY';
      } else {
        l.turn = otherTeam;
      }
      break;
    }

    case 'startMatch': {
      onlyOwner();
      check(
        l.state === 'READY',
        'Maçı başlatmak için önce oyuncu seçimlerinin (Draft) tamamlanması gerekir.'
      );
      l.state = 'PLAYING';
      if (data.blueVoiceId) l.blueVoiceId = data.blueVoiceId;
      if (data.redVoiceId) l.redVoiceId = data.redVoiceId;
      break;
    }

    case 'finishMatch': {
      onlyOwner();
      check(
        l.state === 'PLAYING' || l.state === 'READY',
        'Maç henüz hazır değil veya zaten bitmiş.'
      );
      check(
        data.winner === 'BLUE' || data.winner === 'RED',
        'Geçerli bir kazanan takım seçilmedi.'
      );
      l.winner = data.winner;
      l.finishedAt = new Date().toISOString();
      l.state = 'CLOSED';
      break;
    }

    case 'close': {
      if (!data.force) onlyOwner();
      l.state = 'CLOSED';
      break;
    }

    default:
      throw new Error('Bilinmeyen işlem.');
  }

  l.revision++;
  return l;
}

// ============================================================================
// 3. VERİTABANI KATMANI (SQLite - 5v5 Lobi & Liderlik Tablosu)
// ============================================================================
class Store {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);

    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;

      CREATE TABLE IF NOT EXISTS lobbies(
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(
          state IN ('WAITING','DRAFT','READY','PLAYING','CLOSED')
        ),
        payload TEXT NOT NULL,
        dirty INTEGER NOT NULL DEFAULT 1
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_active_channel
      ON lobbies(guild_id, channel_id)
      WHERE state != 'CLOSED';

      CREATE TABLE IF NOT EXISTS lobby_members(
        lobby_id TEXT NOT NULL REFERENCES lobbies(id),
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        lane INTEGER NOT NULL CHECK(lane BETWEEN 0 AND 4),
        slot INTEGER NOT NULL CHECK(slot IN (0,1)),
        team TEXT CHECK(team IN ('BLUE','RED')),
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        PRIMARY KEY(lobby_id, user_id),
        UNIQUE(lobby_id, lane, slot)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_active_player
      ON lobby_members(guild_id, user_id)
      WHERE active = 1;

      CREATE UNIQUE INDEX IF NOT EXISTS one_team_lane
      ON lobby_members(lobby_id, team, lane)
      WHERE team IS NOT NULL;

      CREATE TABLE IF NOT EXISTS draft_picks(
        lobby_id TEXT NOT NULL REFERENCES lobbies(id),
        pick_order INTEGER NOT NULL,
        captain_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        team TEXT NOT NULL,
        PRIMARY KEY(lobby_id, pick_order),
        UNIQUE(lobby_id, player_id)
      );

      CREATE TABLE IF NOT EXISTS leaderboard(
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        net_score INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS lobby_events(
        id INTEGER PRIMARY KEY,
        lobby_id TEXT NOT NULL REFERENCES lobbies(id),
        actor_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  get(id) {
    const r = this.db.prepare('SELECT payload FROM lobbies WHERE id=?').get(id);
    return r ? JSON.parse(r.payload) : null;
  }

  channel(g, c) {
    const r = this.db.prepare(`
      SELECT payload FROM lobbies
      WHERE guild_id=? AND channel_id=? AND state!='CLOSED'
    `).get(g, c);
    return r ? JSON.parse(r.payload) : null;
  }

  activeLobbies(g) {
    return this.db.prepare(`
      SELECT payload FROM lobbies
      WHERE guild_id=? AND state!='CLOSED'
    `).all(g).map(r => JSON.parse(r.payload));
  }

  getMatchHistory(guildId, limit = 10) {
    return this.db.prepare(`
      SELECT payload FROM lobbies
      WHERE guild_id=? AND state='CLOSED'
      ORDER BY rowid DESC
    `).all(guildId)
      .map(r => JSON.parse(r.payload))
      .filter(l => l.winner === 'BLUE' || l.winner === 'RED')
      .slice(0, limit);
  }

  activeMember(g, u) {
    return this.db.prepare(`
      SELECT lobby_id FROM lobby_members
      WHERE guild_id=? AND user_id=? AND active=1
    `).get(g, u);
  }

  save(l, actor, event) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO lobbies(id, guild_id, channel_id, state, payload, dirty)
        VALUES(?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET
          state=excluded.state,
          payload=excluded.payload,
          dirty=1
      `).run(l.id, l.guild, l.channel, l.state, JSON.stringify(l));

      this.db.prepare('DELETE FROM lobby_members WHERE lobby_id=?').run(l.id);

      const slots = [0, 0, 0, 0, 0];
      for (const m of l.members) {
        this.db.prepare(`
          INSERT INTO lobby_members VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          l.id,
          l.guild,
          m.id,
          m.nick,
          m.lane,
          slots[m.lane]++,
          m.team,
          ACTIVE(l.state) ? 1 : 0
        );
      }

      this.db.prepare('DELETE FROM draft_picks WHERE lobby_id=?').run(l.id);
      for (const p of l.picks) {
        this.db.prepare(`
          INSERT INTO draft_picks VALUES(?, ?, ?, ?, ?)
        `).run(l.id, p.order, p.captain, p.player, p.team);
      }

      if (event === 'FINISH_MATCH' && (l.winner === 'BLUE' || l.winner === 'RED')) {
        for (const m of l.members) {
          if (isBotUser(m.id)) continue;
          const isWinner = m.team === l.winner;
          const winAdd = isWinner ? 1 : 0;
          const lossAdd = isWinner ? 0 : 1;
          const scoreDelta = isWinner ? 1 : -1;

          this.db.prepare(`
            INSERT INTO leaderboard(guild_id, user_id, nickname, wins, losses, net_score, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(guild_id, user_id) DO UPDATE SET
              nickname = excluded.nickname,
              wins = leaderboard.wins + ?,
              losses = leaderboard.losses + ?,
              net_score = leaderboard.net_score + ?,
              updated_at = CURRENT_TIMESTAMP
          `).run(
            l.guild,
            m.id,
            m.nick,
            winAdd,
            lossAdd,
            scoreDelta,
            winAdd,
            lossAdd,
            scoreDelta
          );
        }
      }

      this.db.prepare(`
        INSERT INTO lobby_events(lobby_id, actor_id, event_type)
        VALUES(?, ?, ?)
      `).run(l.id, actor, event);

      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  setMessage(l, messageId) {
    l.message = messageId;
    this.db.prepare('UPDATE lobbies SET payload=? WHERE id=?').run(JSON.stringify(l), l.id);
  }

  getLeaderboard(guildId, limit = 15) {
    return this.db.prepare(`
      SELECT user_id, nickname, wins, losses, net_score
      FROM leaderboard
      WHERE guild_id = ?
      ORDER BY net_score DESC, wins DESC, losses ASC
      LIMIT ?
    `).all(guildId, limit);
  }

  getPlayerStats(guildId, userId) {
    const all = this.db.prepare(`
      SELECT user_id, nickname, wins, losses, net_score
      FROM leaderboard
      WHERE guild_id = ?
      ORDER BY net_score DESC, wins DESC, losses ASC
    `).all(guildId);
    const idx = all.findIndex(r => r.user_id === userId);
    if (idx === -1) return null;
    return {
      ...all[idx],
      rank: idx + 1,
      totalPlayers: all.length
    };
  }

  clearLeaderboard(guildId, userId = null) {
    if (userId) {
      const info = this.db.prepare(
        'DELETE FROM leaderboard WHERE guild_id = ? AND user_id = ?'
      ).run(guildId, userId);
      return info.changes;
    }
    const info = this.db.prepare(
      'DELETE FROM leaderboard WHERE guild_id = ?'
    ).run(guildId);
    return info.changes;
  }
}

// ============================================================================
// 4. DISCORD ARAYÜZ OLUŞTURUCULARI (5v5 LOBİ, LİDERLİK VE GEÇMİŞ MAÇLAR)
// ============================================================================
function createDiscordBuilders() {
  const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType
  } = require('discord.js');

  function makeBtn({ id, label, emoji, style = ButtonStyle.Secondary, disabled = false }) {
    const b = new ButtonBuilder()
      .setCustomId(String(id))
      .setLabel(String(label))
      .setStyle(style)
      .setDisabled(Boolean(disabled));
    if (typeof emoji === 'string' && emoji.trim().length > 0) {
      b.setEmoji({ name: emoji.trim() });
    }
    return b;
  }

  function buildTeamAnsiBlock(l, teamKey) {
    const isBlue = teamKey === 'BLUE';
    const teamColor = isBlue ? ANSI.BLUE : ANSI.RED;
    const capBoldColor = isBlue ? ANSI.BLUE_BOLD : ANSI.RED_BOLD;
    const tName = getTeamName(l, teamKey);
    const winSuffix =
      l.winner === teamKey
        ? ' [KAZANAN +1]'
        : l.winner && l.winner !== teamKey
          ? ' [-1]'
          : '';

    const header = `${capBoldColor}${tName}${winSuffix}${ANSI.RESET}`;
    const divider = `${ANSI.GRAY}${'─'.repeat(24)}${ANSI.RESET}`;

    const rows = LANES.map((laneName, idx) => {
      const p = l.members.find(m => m.team === teamKey && m.lane === idx);
      const paddedLane = laneName.padEnd(8, ' ');
      if (!p) {
        return `${ANSI.GRAY}${paddedLane}: Boş${ANSI.RESET}`;
      }
      const isCap = p.id === captain(l, teamKey);
      if (isCap) {
        return `${capBoldColor}${paddedLane}: ${p.nick} (KAPTAN)${ANSI.RESET}`;
      }
      return `${teamColor}${paddedLane}: ${p.nick}${ANSI.RESET}`;
    });

    return '```ansi\n' + [header, divider, ...rows].join('\n') + '\n```';
  }

  function buildLanesAnsiBlock(l) {
    const lines = LANES.map((laneName, idx) => {
      const inLane = l.members.filter(m => m.lane === idx);
      const paddedLane = `${laneName} (${inLane.length}/2)`.padEnd(14, ' ');
      const formatted = inLane.length
        ? inLane.map(m => formatColoredPlayer(l, m)).join(` ${ANSI.GRAY}|${ANSI.RESET} `)
        : `${ANSI.GRAY}Boş${ANSI.RESET}`;
      return `${ANSI.WHITE_BOLD}${paddedLane}:${ANSI.RESET} ${formatted}`;
    });
    return '```ansi\n' + lines.join('\n') + '\n```';
  }

  function buildLobbyPayload(l) {
    const stateColors = {
      WAITING: 0x3498db,
      DRAFT: 0xf1c40f,
      READY: 0x2ecc71,
      PLAYING: 0x9b59b6,
      CLOSED: 0x95a5a6
    };

    const blueName = getTeamName(l, 'BLUE');
    const redName = getTeamName(l, 'RED');

    const currentCapId = captain(l, l.turn);
    const currentCapMember = currentCapId ? member(l, currentCapId) : null;
    const capTurnText =
      l.turn === 'BLUE'
        ? `${TEAM_EMOJI.BLUE} **${blueName} Kaptanı (${currentCapMember ? currentCapMember.nick : '-'})**`
        : `${TEAM_EMOJI.RED} **${redName} Kaptanı (${currentCapMember ? currentCapMember.nick : '-'})**`;

    const stateLabels = {
      WAITING: 'Oyuncular ve Kaptanlar Bekleniyor',
      DRAFT: `Oyuncu Seçimi — Sıra: ${capTurnText}`,
      READY: 'Takımlar Hazır (Maçın Başlatılması Bekleniyor)',
      PLAYING: 'Maç Devam Ediyor',
      CLOSED: l.winner
        ? `Maç Tamamlandı — Kazanan: ${l.winner === 'BLUE' ? `${TEAM_EMOJI.BLUE} **${blueName}**` : `${TEAM_EMOJI.RED} **${redName}**`}`
        : 'Lobi Kapatıldı'
    };

    const embed = new EmbedBuilder()
      .setColor(stateColors[l.state] || 0x3498db)
      .setTitle(`${l.name} — 5v5 Lobi`)
      .setDescription(
        `**Durum:** ${stateLabels[l.state]}\n` +
        `**Kurucu:** <@${l.owner}> | **Oyuncular:** \`${l.members.length}/10\`\n` +
        `*Lobiye katılan oyuncular şifre ve davet linkini görmek için **Şifre & Link** butonuna tıklayabilir.*`
      )
      .addFields(
        {
          name: 'Koridorlar',
          value: buildLanesAnsiBlock(l),
          inline: false
        },
        {
          name: `${TEAM_EMOJI.BLUE} ${blueName} ${l.winner === 'BLUE' ? '(+1 Win)' : l.winner === 'RED' ? '(-1 Lose)' : ''}`,
          value: buildTeamAnsiBlock(l, 'BLUE'),
          inline: false
        },
        {
          name: `${TEAM_EMOJI.RED} ${redName} ${l.winner === 'RED' ? '(+1 Win)' : l.winner === 'BLUE' ? '(-1 Lose)' : ''}`,
          value: buildTeamAnsiBlock(l, 'RED'),
          inline: false
        }
      )
      .setTimestamp(new Date(l.created));

    if (l.blueVoiceId || l.redVoiceId) {
      embed.addFields({
        name: 'Ses Kanalları',
        value:
          `${TEAM_EMOJI.BLUE} **${blueName}:** ${l.blueVoiceId ? `<#${l.blueVoiceId}>` : '*Yok*'}\n` +
          `${TEAM_EMOJI.RED} **${redName}:** ${l.redVoiceId ? `<#${l.redVoiceId}>` : '*Yok*'}`,
        inline: false
      });
    }

    const components = [];

    if (l.state === 'WAITING') {
      const laneRow = new ActionRowBuilder();
      LANES.forEach((laneName, idx) => {
        const count = l.members.filter(m => m.lane === idx).length;
        laneRow.addComponents(
          makeBtn({
            id: `l:${l.id}:join:${idx}`,
            label: `${laneName} (${count}/2)`,
            style: count >= 2 ? ButtonStyle.Secondary : ButtonStyle.Primary,
            disabled: count >= 2
          })
        );
      });
      components.push(laneRow);

      const playerRow = new ActionRowBuilder().addComponents(
        makeBtn({
          id: `l:${l.id}:leave`,
          label: 'Lobiden Ayrıl',
          style: ButtonStyle.Danger
        }),
        makeBtn({
          id: `l:${l.id}:secret`,
          label: 'Şifre & Link',
          style: ButtonStyle.Success
        }),
        makeBtn({
          id: `l:${l.id}:teamNameModal`,
          label: 'Takım Adı Belirle',
          style: ButtonStyle.Secondary,
          disabled: !l.blue && !l.red
        }),
        makeBtn({
          id: `l:${l.id}:leaderboard`,
          label: 'Liderlik Tablosu',
          style: ButtonStyle.Secondary
        }),
        makeBtn({
          id: `l:${l.id}:fillBots`,
          label: 'Botlarla Doldur',
          style: ButtonStyle.Secondary,
          disabled: l.members.length >= 10
        })
      );
      components.push(playerRow);

      const ownerRow = new ActionRowBuilder().addComponents(
        makeBtn({
          id: `l:${l.id}:capMenu`,
          label: 'Kaptan Seç',
          style: ButtonStyle.Primary,
          disabled: l.members.length < 2
        }),
        makeBtn({
          id: `l:${l.id}:capRand`,
          label: 'Rastgele Kaptan',
          style: ButtonStyle.Primary,
          disabled: l.members.length < 2
        }),
        makeBtn({
          id: `l:${l.id}:capReset`,
          label: 'Kaptan Sıfırla',
          style: ButtonStyle.Secondary,
          disabled: !l.blue && !l.red
        }),
        makeBtn({
          id: `l:${l.id}:startDraft`,
          label: 'Seçimleri Başlat',
          style: ButtonStyle.Success,
          disabled: !(l.members.length === 10 && l.blue && l.red)
        }),
        makeBtn({
          id: `l:${l.id}:close`,
          label: 'Lobiyi Kapat',
          style: ButtonStyle.Danger
        })
      );
      components.push(ownerRow);
    } else if (l.state === 'DRAFT') {
      const draftRow = new ActionRowBuilder().addComponents(
        makeBtn({
          id: `l:${l.id}:openPick`,
          label: `Oyuncu Seç (${l.turn === 'BLUE' ? blueName : redName})`.slice(0, 80),
          emoji: l.turn === 'BLUE' ? TEAM_EMOJI.BLUE : TEAM_EMOJI.RED,
          style: ButtonStyle.Primary
        }),
        makeBtn({
          id: `l:${l.id}:teamNameModal`,
          label: 'Takım Adı Belirle',
          style: ButtonStyle.Secondary
        }),
        makeBtn({
          id: `l:${l.id}:secret`,
          label: 'Şifre & Link',
          style: ButtonStyle.Success
        }),
        makeBtn({
          id: `l:${l.id}:coinflip`,
          label: 'Yazı Tura',
          style: ButtonStyle.Secondary
        }),
        makeBtn({
          id: `l:${l.id}:close`,
          label: 'Lobiyi İptal Et',
          style: ButtonStyle.Danger
        })
      );
      components.push(draftRow);
    } else if (l.state === 'READY') {
      const readyRow = new ActionRowBuilder().addComponents(
        makeBtn({
          id: `l:${l.id}:startMatch`,
          label: 'Maçı Başlat (Ses Odalarını Aç)',
          style: ButtonStyle.Success
        }),
        makeBtn({
          id: `l:${l.id}:teamNameModal`,
          label: 'Takım Adı Belirle',
          style: ButtonStyle.Secondary
        }),
        makeBtn({
          id: `l:${l.id}:finishMenu`,
          label: 'Maçı Bitir',
          style: ButtonStyle.Primary
        }),
        makeBtn({
          id: `l:${l.id}:secret`,
          label: 'Şifre & Link',
          style: ButtonStyle.Secondary
        }),
        makeBtn({
          id: `l:${l.id}:close`,
          label: 'İptal Et',
          style: ButtonStyle.Danger
        })
      );
      components.push(readyRow);
    } else if (l.state === 'PLAYING') {
      const playingRow = new ActionRowBuilder().addComponents(
        makeBtn({
          id: `l:${l.id}:finishMenu`,
          label: 'Maçı Bitir',
          style: ButtonStyle.Success
        }),
        makeBtn({
          id: `l:${l.id}:moveVoice`,
          label: 'Ses Odalarına Çek',
          style: ButtonStyle.Primary
        }),
        makeBtn({
          id: `l:${l.id}:secret`,
          label: 'Şifre & Link',
          style: ButtonStyle.Secondary
        }),
        makeBtn({
          id: `l:${l.id}:coinflip`,
          label: 'Yazı Tura',
          style: ButtonStyle.Secondary
        }),
        makeBtn({
          id: `l:${l.id}:close`,
          label: 'Maçı İptal Et',
          style: ButtonStyle.Danger
        })
      );
      components.push(playingRow);
    }

    return { embeds: [embed], components };
  }

  function buildLeaderboardEmbed(store, guildId) {
    const rows = store.getLeaderboard(guildId, 15);
    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('5v5 Liderlik Tablosu')
      .setDescription(
        rows.length === 0
          ? '*Henüz tamamlanmış bir maç kaydı bulunmuyor.*'
          : rows
              .map((r, i) => {
                const total = r.wins + r.losses;
                const wr = total > 0 ? Math.round((r.wins / total) * 100) : 0;
                const netStr = r.net_score >= 0 ? `+${r.net_score}` : `${r.net_score}`;
                return `\`#${i + 1}\` <@${r.user_id}> (\`${r.nickname}\`) — **Puan:** \`${netStr}\` | **G:** \`${r.wins}\` / **M:** \`${r.losses}\` (%${wr})`;
              })
              .join('\n')
      )
      .setTimestamp();
    return embed;
  }

  function buildMatchHistoryPayload(store, guildId) {
    const matches = store.getMatchHistory(guildId, 10);
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('Geçmiş 5v5 Maçlar')
      .setTimestamp();

    if (matches.length === 0) {
      embed.setDescription('*Henüz tamamlanmış bir 5v5 maç kaydı bulunmuyor.*');
      return { embeds: [embed], components: [] };
    }

    const blocks = matches.map((m, idx) => {
      const blueName = getTeamName(m, 'BLUE');
      const redName = getTeamName(m, 'RED');
      const blueCap = member(m, m.blue)?.nick || '-';
      const redCap = member(m, m.red)?.nick || '-';
      const dateStr = new Date(m.finishedAt || m.created).toLocaleString('tr-TR');
      const winText =
        m.winner === 'BLUE'
          ? `${ANSI.BLUE_BOLD}Kazanan: ${blueName}${ANSI.RESET}`
          : `${ANSI.RED_BOLD}Kazanan: ${redName}${ANSI.RESET}`;

      return (
        `\`#${idx + 1}\` **${m.name}** (${dateStr})\n` +
        '```ansi\n' +
        `${ANSI.BLUE_BOLD}${blueName} (Kaptan: ${blueCap})${ANSI.RESET} vs ${ANSI.RED_BOLD}${redName} (Kaptan: ${redCap})${ANSI.RESET}\n` +
        `${winText}\n` +
        '```'
      );
    });

    embed.setDescription(blocks.join('\n'));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('cmd:historyDetail')
      .setPlaceholder('Detaylı kadrosunu görmek istediğin maçı seç...')
      .addOptions(
        matches.map((m, idx) => {
          const blueName = getTeamName(m, 'BLUE');
          const redName = getTeamName(m, 'RED');
          const winnerName = m.winner === 'BLUE' ? blueName : redName;
          return {
            label: `#${idx + 1} ${m.name} (${blueName} vs ${redName})`.slice(0, 100),
            description: `Kazanan: ${winnerName}`.slice(0, 100),
            value: m.id
          };
        })
      );

    return {
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(selectMenu)]
    };
  }

  // Sadece 5v5 Lobi, Draft, Ses Kanalı ve Liderlik Komutları (12 Komut)
  const commands = [
    new SlashCommandBuilder()
      .setName('lobi-kur')
      .setDescription('Yeni bir 5v5 özel oyun lobisi oluşturur (Sadece yetkili rol).')
      .addStringOption(opt => opt.setName('ad').setDescription('Lobinin adı').setRequired(true))
      .addStringOption(opt => opt.setName('sifre').setDescription('Lobi şifresi').setRequired(true))
      .addStringOption(opt => opt.setName('link').setDescription('Lobi davet linki').setRequired(true)),
    new SlashCommandBuilder()
      .setName('deneme-lobisi-kur')
      .setDescription('Lobi sistemini hızlıca test etmek için hazır deneme lobisi kurar.')
      .addStringOption(opt =>
        opt
          .setName('mod')
          .setDescription('Deneme lobisinin başlangıç durumu')
          .setRequired(false)
          .addChoices(
            { name: '10/10 Dolu & Kaptanlar Hazır (Hemen Draft Testi)', value: 'dolu_hazir' },
            { name: '9/10 Dolu (1 Koridor Boş - Katılma Testi)', value: 'dolu_9' },
            { name: '0/10 Boş Deneme Lobisi', value: 'bos' }
          )
      ),
    new SlashCommandBuilder()
      .setName('lobi-kapat')
      .setDescription('Hangi kanaldaki aktif lobinin kapatılacağını seçerek lobiyi kapatır.')
      .addChannelOption(opt =>
        opt
          .setName('kanal')
          .setDescription('Kapatılacak lobinin bulunduğu kanal (Boş bırakırsanız aktif lobiler listelenir)')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('takim-adi')
      .setDescription('Aktif lobideki takımınızın adını değiştirir (Kaptanlar veya Lobi Kurucusu).')
      .addStringOption(opt => opt.setName('isim').setDescription('Yeni takım adı').setRequired(true))
      .addStringOption(opt =>
        opt
          .setName('takim')
          .setDescription('Hangi takımın adı değiştirilecek?')
          .setRequired(false)
          .addChoices(
            { name: 'Mavi Takım', value: 'BLUE' },
            { name: 'Kırmızı Takım', value: 'RED' }
          )
      ),
    new SlashCommandBuilder()
      .setName('oyuncu-cikar')
      .setDescription('Bu kanaldaki aktif lobiden bir oyuncuyu çıkarır (Kurucu veya Yetkili).')
      .addUserOption(opt => opt.setName('oyuncu').setDescription('Lobiden çıkarılacak oyuncu').setRequired(true)),
    new SlashCommandBuilder()
      .setName('gecmis-maclar')
      .setDescription('Sunucuda tamamlanan geçmiş 5v5 maçları, kadroları ve sonuçlarını gösterir.'),
    new SlashCommandBuilder()
      .setName('liderlik-tablosu')
      .setDescription('Sunucudaki 5v5 +1 Win / -1 Lose liderlik sıralamasını gösterir.'),
    new SlashCommandBuilder()
      .setName('liderlik-sifirla')
      .setDescription('Liderlik tablosunu tamamen temizler veya tek bir oyuncunun puanını sıfırlar (Yetkili).')
      .addUserOption(opt => opt.setName('oyuncu').setDescription('Sadece belirli bir oyuncuyu sıfırlamak için seçin').setRequired(false)),
    new SlashCommandBuilder()
      .setName('istatistik')
      .setDescription('Bir oyuncunun sunucu içi 5v5 özel maç istatistiklerini gösterir.')
      .addUserOption(opt => opt.setName('oyuncu').setDescription('İstatistiği görüntülenecek oyuncu').setRequired(false)),
    new SlashCommandBuilder()
      .setName('aktif-lobiler')
      .setDescription('Sunucuda şu anda açık olan tüm 5v5 lobileri listeler.'),
    new SlashCommandBuilder()
      .setName('rastgele-koridor')
      .setDescription('Bulunduğunuz ses kanalındaki veya lobideki oyunculara rastgele 5 koridor dağıtır.'),
    new SlashCommandBuilder()
      .setName('yazi-tura')
      .setDescription('Yazı tura atar.')
  ].map(c => c.toJSON());

  return {
    makeBtn,
    buildTeamAnsiBlock,
    buildLanesAnsiBlock,
    buildLobbyPayload,
    buildLeaderboardEmbed,
    buildMatchHistoryPayload,
    commands,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
  };
}

// ============================================================================
// 5. TEST MODU (`node bot.js --test`)
// ============================================================================
async function runTests() {
  const assert = require('node:assert/strict');
  const store = new Store(':memory:');
  const {
    buildLobbyPayload,
    buildLeaderboardEmbed,
    buildMatchHistoryPayload,
    commands
  } = createDiscordBuilders();

  assert.equal(commands.length, 12, 'Sadece 12 adet 5v5 slash komutu tanımlı olmalı');

  const l = newLobby('g1', 'c1', 'owner1', 'Test Lobi', 'gizli123', 'lol.com/lobby');
  store.save(l, 'owner1', 'CREATE');

  for (let i = 0; i < 10; i++) {
    const uid = `10000000000000000${i}`;
    mutate(l, uid, 'join', {
      lane: Math.floor(i / 2),
      nick: `Oyuncu_${i}`
    });
  }

  mutate(l, 'owner1', 'randomCaptains');
  mutate(l, l.blue, 'setTeamName', { blueName: 'Anadolu Kartalları' });
  mutate(l, l.red, 'setTeamName', { redName: 'Kızıl Ejderler' });
  mutate(l, 'owner1', 'startDraft');

  let pickCount = 0;
  while (l.state === 'DRAFT') {
    const cap = captain(l, l.turn);
    const nextPick = l.members.find(m => eligible(l, m.id, l.turn));
    mutate(l, cap, 'pick', { target: nextPick.id, revision: l.revision });
    pickCount++;
  }
  assert.equal(pickCount, 4, '4 seçimde 8 oyuncu otomatik karşı takıma atanmalı');
  assert.equal(l.state, 'READY');

  mutate(l, 'owner1', 'finishMatch', { winner: 'BLUE' });
  store.save(l, 'owner1', 'FINISH_MATCH');
  assert.equal(store.getMatchHistory('g1').length, 1);

  const lb = store.getLeaderboard('g1');
  assert.equal(lb.length, 10, '10 gerçek oyuncu liderlik tablosuna kaydedilmeli');
  const pStats = store.getPlayerStats('g1', '100000000000000000');
  assert(pStats && (pStats.wins === 1 || pStats.losses === 1));

  assert(buildLobbyPayload(l).embeds[0].toJSON());
  assert(buildLeaderboardEmbed(store, 'g1').toJSON());
  assert(buildMatchHistoryPayload(store, 'g1').embeds[0].toJSON());

  console.log('PASS: Sadece 5v5 Lobi, Draft, Ses Kanalı ve Liderlik Tablosu testleri başarılı!');
}

// ============================================================================
// 6. BOT BAŞLATMA VE ETKİLEŞİM YÖNETİCİSİ
// ============================================================================
async function startBot() {
  const {
    Client,
    Events,
    GatewayIntentBits,
    REST,
    Routes,
    ChannelType,
    PermissionFlagsBits,
    MessageFlags
  } = require('discord.js');

  const store = new Store(AYARLAR.DB_PATH);
  const {
    makeBtn,
    buildLobbyPayload,
    buildLeaderboardEmbed,
    buildMatchHistoryPayload,
    commands,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
  } = createDiscordBuilders();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers
    ]
  });

  // Maç bittiğinde veya lobi kapandığında oyuncuları 1546912598048383046 ses kanalına geri atar ve takım odalarını siler
  async function returnPlayersAndCleanupVoice(guild, l) {
    if (!guild) return;

    const targetLobbyVoiceId = AYARLAR.LOBBY_VOICE_ID;
    let lobbyVoiceChannel = null;
    if (targetLobbyVoiceId) {
      lobbyVoiceChannel =
        guild.channels.cache.get(targetLobbyVoiceId) ||
        (await guild.channels.fetch(targetLobbyVoiceId).catch(() => null));
    }

    if (lobbyVoiceChannel) {
      const userIdsToMove = new Set(
        l.members.filter(m => !isBotUser(m.id)).map(m => m.id)
      );

      for (const cid of [l.blueVoiceId, l.redVoiceId]) {
        if (!cid) continue;
        const ch = guild.channels.cache.get(cid);
        if (ch?.members) {
          for (const [memberId] of ch.members) {
            userIdsToMove.add(memberId);
          }
        }
      }

      for (const uid of userIdsToMove) {
        try {
          const gm =
            guild.members.cache.get(uid) ||
            (await guild.members.fetch(uid).catch(() => null));
          if (gm?.voice?.channelId && gm.voice.channelId !== lobbyVoiceChannel.id) {
            await gm.voice.setChannel(lobbyVoiceChannel.id);
          }
        } catch {}
      }
    }

    for (const cid of [l.blueVoiceId, l.redVoiceId]) {
      if (!cid) continue;
      try {
        const ch =
          guild.channels.cache.get(cid) ||
          (await guild.channels.fetch(cid).catch(() => null));
        if (ch) await ch.delete('5v5 Lobi sona erdi.');
      } catch {}
    }
  }

  async function refreshLobbyMessage(guild, l) {
    if (!l.message) return;
    try {
      const ch = guild.channels.cache.get(l.channel) || (await guild.channels.fetch(l.channel));
      const msg = await ch.messages.fetch(l.message);
      await msg.edit(buildLobbyPayload(l));
    } catch {}
  }

  function hasLobbyPermission(interaction) {
    const roleExistsInGuild = interaction.guild?.roles?.cache?.has(AYARLAR.CREATOR_ROLE_ID);
    const hasCreatorRole = interaction.member?.roles?.cache?.has(AYARLAR.CREATOR_ROLE_ID);
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    return {
      allowed: roleExistsInGuild ? Boolean(hasCreatorRole || isAdmin) : Boolean(isAdmin),
      roleExistsInGuild
    };
  }

  async function registerGuildCommands(guildId, guildName = guildId) {
    const rest = new REST({ version: '10' }).setToken(AYARLAR.DISCORD_TOKEN);
    try {
      await rest.put(
        Routes.applicationGuildCommands(AYARLAR.CLIENT_ID, guildId),
        { body: commands }
      );
      console.log(`Slash komutları yüklendi (${commands.length} komut): ${guildName} (${guildId})`);
    } catch (err) {
      console.error(`Komut yükleme hatası (${guildName}):`, err.message);
    }
  }

  client.once(Events.ClientReady, async readyClient => {
    console.log(`Bot giriş yaptı: ${readyClient.user.tag}`);
    const guildIds = new Set([
      AYARLAR.GUILD_ID,
      ...readyClient.guilds.cache.keys()
    ]);
    for (const gid of guildIds) {
      if (!gid) continue;
      const g = readyClient.guilds.cache.get(gid);
      await registerGuildCommands(gid, g ? g.name : gid);
    }
  });

  client.on(Events.GuildCreate, async guild => {
    await registerGuildCommands(guild.id, guild.name);
  });

  client.on(Events.InteractionCreate, async interaction => {
    try {
      // ======================================================================
      // A. SLASH KOMUTLARI (12 ADET 5v5 KOMUTU)
      // ======================================================================
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'yazi-tura') {
          const sonuc = randomInt(0, 2) === 0 ? '**YAZI** geldi!' : '**TURA** geldi!';
          return interaction.reply({ content: `<@${interaction.user.id}> para attı: ${sonuc}` });
        }

        if (interaction.commandName === 'liderlik-tablosu') {
          const embed = buildLeaderboardEmbed(store, interaction.guildId);
          return interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'gecmis-maclar') {
          const payload = buildMatchHistoryPayload(store, interaction.guildId);
          return interaction.reply(payload);
        }

        if (interaction.commandName === 'liderlik-sifirla') {
          const perm = hasLobbyPermission(interaction);
          if (!perm.allowed) {
            return interaction.reply({
              content: 'Liderlik tablosunu sıfırlamak için yetkili rolüne veya **Yönetici** yetkisine sahip olmalısın.',
              flags: MessageFlags.Ephemeral
            });
          }

          const targetUser = interaction.options.getUser('oyuncu');
          if (targetUser) {
            const count = store.clearLeaderboard(interaction.guildId, targetUser.id);
            return interaction.reply({
              content: count > 0
                ? `<@${targetUser.id}> adlı oyuncunun liderlik tablosu verileri sıfırlandı.`
                : `<@${targetUser.id}> için liderlik tablosunda kayıt bulunamadı.`
            });
          }

          const count = store.clearLeaderboard(interaction.guildId);
          return interaction.reply({
            content: `Liderlik tablosu tamamen temizlendi (Silinen kayıt sayısı: **${count}**).`
          });
        }

        if (interaction.commandName === 'istatistik') {
          const targetUser = interaction.options.getUser('oyuncu') || interaction.user;
          const stats = store.getPlayerStats(interaction.guildId, targetUser.id);

          if (!stats) {
            return interaction.reply({
              content: `<@${targetUser.id}> için henüz tamamlanmış bir 5v5 maç kaydı bulunmuyor.`,
              flags: MessageFlags.Ephemeral
            });
          }

          const total = stats.wins + stats.losses;
          const wr = total > 0 ? Math.round((stats.wins / total) * 100) : 0;
          const netStr = stats.net_score >= 0 ? `+${stats.net_score}` : `${stats.net_score}`;

          const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle(`${stats.nickname} — 5v5 Oyuncu İstatistikleri`)
            .setDescription(
              `**Oyuncu:** <@${stats.user_id}>\n` +
              `**Sıralama:** \`#${stats.rank} / ${stats.totalPlayers}\`\n` +
              `**Net Puan:** \`${netStr}\`\n` +
              `**Galibiyet / Mağlubiyet:** \`${stats.wins}G\` / \`${stats.losses}M\` (Toplam: \`${total}\`)\n` +
              `**Kazanma Oranı:** \`%${wr}\``
            )
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'aktif-lobiler') {
          const list = store.activeLobbies(interaction.guildId);
          if (list.length === 0) {
            return interaction.reply({
              content: 'Şu anda bu sunucuda aktif bir 5v5 lobisi bulunmuyor.',
              flags: MessageFlags.Ephemeral
            });
          }

          const lines = list.map((item, idx) => {
            const blueName = getTeamName(item, 'BLUE');
            const redName = getTeamName(item, 'RED');
            return `\`#${idx + 1}\` <#${item.channel}> — **${item.name}** | Durum: \`${item.state}\` | Oyuncular: \`${item.members.length}/10\` | ${TEAM_EMOJI.BLUE} **${blueName}** vs ${TEAM_EMOJI.RED} **${redName}**`;
          });

          const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('Aktif 5v5 Lobileri')
            .setDescription(lines.join('\n'))
            .setTimestamp();

          return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (interaction.commandName === 'rastgele-koridor') {
          const voiceChannel = interaction.member?.voice?.channel;
          let pool = [];

          if (voiceChannel) {
            pool = [...voiceChannel.members.values()]
              .filter(m => !m.user.bot)
              .map(m => `<@${m.id}>`);
          }

          if (pool.length === 0) {
            const chLobby = store.channel(interaction.guildId, interaction.channelId);
            if (chLobby && chLobby.members.length > 0) {
              pool = chLobby.members.map(m => formatPlayerMention(m));
            }
          }

          const shuffledLanes = [...LANES];
          for (let i = shuffledLanes.length - 1; i > 0; i--) {
            const j = randomInt(0, i + 1);
            [shuffledLanes[i], shuffledLanes[j]] = [shuffledLanes[j], shuffledLanes[i]];
          }

          if (pool.length >= 2) {
            const shuffledPlayers = [...pool];
            for (let i = shuffledPlayers.length - 1; i > 0; i--) {
              const j = randomInt(0, i + 1);
              [shuffledPlayers[i], shuffledPlayers[j]] = [shuffledPlayers[j], shuffledPlayers[i]];
            }
            const assigned = shuffledLanes.map((lane, idx) => {
              const p = shuffledPlayers[idx] || '*Boş*';
              return `**${lane}:** ${p}`;
            });
            return interaction.reply({
              content: `**Rastgele Koridor Dağılımı:**\n${assigned.join('\n')}`
            });
          }

          const singleLane = LANES[randomInt(0, LANES.length)];
          return interaction.reply({
            content: `<@${interaction.user.id}> için rastgele seçilen koridor: **${singleLane}**`
          });
        }

        if (interaction.commandName === 'takim-adi') {
          const l = store.channel(interaction.guildId, interaction.channelId);
          check(l, 'Bu kanalda aktif bir lobi bulunamadı.');

          const newName = interaction.options.getString('isim', true);
          const chosenTeam = interaction.options.getString('takim');
          const uid = interaction.user.id;

          let targetTeam = chosenTeam;
          if (!targetTeam) {
            if (uid === l.blue) targetTeam = 'BLUE';
            else if (uid === l.red) targetTeam = 'RED';
            else if (uid === l.owner) targetTeam = 'BLUE';
          }

          check(
            targetTeam === 'BLUE' || targetTeam === 'RED',
            'Takım adını değiştirmek için Mavi/Kırmızı kaptan veya lobi kurucusu olmalısın.'
          );

          mutate(l, uid, 'setTeamName', {
            blueName: targetTeam === 'BLUE' ? newName : undefined,
            redName: targetTeam === 'RED' ? newName : undefined
          });
          store.save(l, uid, 'SET_TEAM_NAME');

          if (l.state === 'PLAYING') {
            const voiceId = targetTeam === 'BLUE' ? l.blueVoiceId : l.redVoiceId;
            if (voiceId) {
              const ch = interaction.guild?.channels?.cache?.get(voiceId);
              const emoji = targetTeam === 'BLUE' ? TEAM_EMOJI.BLUE : TEAM_EMOJI.RED;
              if (ch) await ch.setName(`${emoji} ${getTeamName(l, targetTeam)}`.slice(0, 95)).catch(() => {});
            }
          }

          await refreshLobbyMessage(interaction.guild, l);
          return interaction.reply({
            content: `${targetTeam === 'BLUE' ? TEAM_EMOJI.BLUE : TEAM_EMOJI.RED} Takım adı **${getTeamName(l, targetTeam)}** olarak güncellendi.`,
            flags: MessageFlags.Ephemeral
          });
        }

        if (interaction.commandName === 'oyuncu-cikar') {
          const l = store.channel(interaction.guildId, interaction.channelId);
          check(l, 'Bu kanalda aktif bir lobi bulunamadı.');

          const perm = hasLobbyPermission(interaction);
          const canKick = perm.allowed || interaction.user.id === l.owner;
          check(canKick, 'Oyuncu çıkarmak için lobi kurucusu veya yetkili olmalısın.');

          const targetUser = interaction.options.getUser('oyuncu', true);
          mutate(l, interaction.user.id, 'kick', {
            target: targetUser.id,
            force: true
          });
          store.save(l, interaction.user.id, 'KICK');
          await refreshLobbyMessage(interaction.guild, l);

          return interaction.reply({
            content: `<@${targetUser.id}> lobiden çıkarıldı.`,
            flags: MessageFlags.Ephemeral
          });
        }

        if (interaction.commandName === 'lobi-kur') {
          const perm = hasLobbyPermission(interaction);
          if (!perm.allowed) {
            return interaction.reply({
              content: perm.roleExistsInGuild
                ? `Lobi kurmak için <@&${AYARLAR.CREATOR_ROLE_ID}> rolüne veya **Yönetici** yetkisine sahip olmalısın.`
                : 'Bu sunucuda lobi kurmak için **Yönetici** yetkisine sahip olmalısın.',
              flags: MessageFlags.Ephemeral
            });
          }

          const existingChannelLobby = store.channel(interaction.guildId, interaction.channelId);
          if (existingChannelLobby) {
            return interaction.reply({
              content: 'Bu kanalda zaten aktif bir lobi var. Önce `/lobi-kapat` ile mevcut lobiyi kapatmalısınız.',
              flags: MessageFlags.Ephemeral
            });
          }

          const ad = interaction.options.getString('ad', true);
          const sifre = interaction.options.getString('sifre', true);
          const link = interaction.options.getString('link', true);

          const l = newLobby(
            interaction.guildId,
            interaction.channelId,
            interaction.user.id,
            ad,
            sifre,
            link
          );

          const payload = buildLobbyPayload(l);
          store.save(l, interaction.user.id, 'CREATE');

          try {
            const reply = await interaction.reply({
              ...payload,
              withResponse: true
            });
            const msgId = reply.resource?.message?.id || (await interaction.fetchReply()).id;
            store.setMessage(l, msgId);
          } catch (replyErr) {
            mutate(l, interaction.user.id, 'close', { force: true });
            store.save(l, interaction.user.id, 'CLOSE');
            throw replyErr;
          }
          return;
        }

        if (interaction.commandName === 'deneme-lobisi-kur') {
          const perm = hasLobbyPermission(interaction);
          if (!perm.allowed) {
            return interaction.reply({
              content: perm.roleExistsInGuild
                ? `Deneme lobisi kurmak için <@&${AYARLAR.CREATOR_ROLE_ID}> rolüne veya **Yönetici** yetkisine sahip olmalısın.`
                : 'Bu sunucuda deneme lobisi kurmak için **Yönetici** yetkisine sahip olmalısın.',
              flags: MessageFlags.Ephemeral
            });
          }

          const existingChannelLobby = store.channel(interaction.guildId, interaction.channelId);
          if (existingChannelLobby) {
            return interaction.reply({
              content: 'Bu kanalda zaten aktif bir lobi var. Önce `/lobi-kapat` ile mevcut lobiyi kapatmalısınız.',
              flags: MessageFlags.Ephemeral
            });
          }

          const mod = interaction.options.getString('mod') || 'dolu_hazir';
          const discordName =
            interaction.member?.displayName ||
            interaction.user.globalName ||
            interaction.user.username;

          const l = newLobby(
            interaction.guildId,
            interaction.channelId,
            interaction.user.id,
            'Deneme 5v5 Lobisi',
            'deneme123',
            'https://leagueoflegends.com'
          );

          if (mod === 'dolu_hazir') {
            const activeOther = store.activeMember(interaction.guildId, interaction.user.id);
            mutate(l, interaction.user.id, 'fillBots', {
              targetCount: 10,
              includeOwner: !activeOther,
              ownerNick: discordName,
              autoCaptains: true
            });
          } else if (mod === 'dolu_9') {
            mutate(l, interaction.user.id, 'fillBots', {
              targetCount: 9,
              includeOwner: false,
              autoCaptains: false
            });
          }

          const payload = buildLobbyPayload(l);
          store.save(l, interaction.user.id, 'CREATE_TEST');

          try {
            const reply = await interaction.reply({
              ...payload,
              withResponse: true
            });
            const msgId = reply.resource?.message?.id || (await interaction.fetchReply()).id;
            store.setMessage(l, msgId);
          } catch (replyErr) {
            mutate(l, interaction.user.id, 'close', { force: true });
            store.save(l, interaction.user.id, 'CLOSE');
            throw replyErr;
          }
          return;
        }

        if (interaction.commandName === 'lobi-kapat') {
          const perm = hasLobbyPermission(interaction);
          const hasStaffPerm = perm.allowed;
          const selectedChannel = interaction.options.getChannel('kanal');

          if (selectedChannel) {
            const targetLobby = store.channel(interaction.guildId, selectedChannel.id);
            if (!targetLobby) {
              return interaction.reply({
                content: `<#${selectedChannel.id}> kanalında şu anda aktif bir lobi bulunmuyor.`,
                flags: MessageFlags.Ephemeral
              });
            }

            if (!hasStaffPerm && targetLobby.owner !== interaction.user.id) {
              return interaction.reply({
                content: `<#${selectedChannel.id}> kanalındaki lobiyi sadece lobi kurucusu (<@${targetLobby.owner}>) veya yetkili rol kapatabilir.`,
                flags: MessageFlags.Ephemeral
              });
            }

            mutate(targetLobby, interaction.user.id, 'close', { force: true });
            store.save(targetLobby, interaction.user.id, 'CLOSE');
            await returnPlayersAndCleanupVoice(interaction.guild, targetLobby);
            await refreshLobbyMessage(interaction.guild, targetLobby);

            return interaction.reply({
              content: `<#${selectedChannel.id}> kanalındaki **${targetLobby.name}** lobisi kapatıldı.`,
              flags: MessageFlags.Ephemeral
            });
          }

          const activeList = store
            .activeLobbies(interaction.guildId)
            .filter(item => hasStaffPerm || item.owner === interaction.user.id);

          if (activeList.length === 0) {
            return interaction.reply({
              content: 'Bu sunucuda kapatabileceğin aktif bir lobi bulunmuyor.',
              flags: MessageFlags.Ephemeral
            });
          }

          const options = activeList.slice(0, 24).map(item => {
            const chName = interaction.guild?.channels?.cache?.get(item.channel)?.name || item.channel;
            return {
              label: `#${chName} — ${item.name}`.slice(0, 100),
              description: `Durum: ${item.state} | Oyuncular: ${item.members.length}/10`,
              value: item.id
            };
          });

          if (activeList.length > 1) {
            options.push({
              label: 'Tüm Aktif Lobileri Kapat',
              description: `Toplam ${activeList.length} aktif lobinin tamamını kapatır`,
              value: 'ALL'
            });
          }

          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('cmd:closeLobbySelect')
            .setPlaceholder('Kapatmak istediğin lobinin kanalını seç...')
            .addOptions(options);

          return interaction.reply({
            content: '**Hangi kanaldaki aktif lobiyi kapatmak istiyorsun?** Aşağıdaki menüden seç:',
            components: [new ActionRowBuilder().addComponents(selectMenu)],
            flags: MessageFlags.Ephemeral
          });
        }
      }

      // ======================================================================
      // B. MODAL (TAKIM ADI BELİRLEME PENCERESİ) YANITI
      // ======================================================================
      if (interaction.isModalSubmit()) {
        const parts = interaction.customId.split(':');
        if (parts[0] === 'l' && parts[2] === 'teamNameSubmit') {
          const lobbyId = parts[1];
          const l = store.get(lobbyId);
          check(l && ACTIVE(l.state), 'Bu lobi bulunamadı veya kapatılmış.');

          const uid = interaction.user.id;
          const isOwner = uid === l.owner;
          const isBlueCap = uid === l.blue;
          const isRedCap = uid === l.red;
          check(
            isOwner || isBlueCap || isRedCap,
            'Takım adını sadece kaptanlar veya lobi kurucusu değiştirebilir.'
          );

          let blueInput = null;
          let redInput = null;
          try {
            blueInput = interaction.fields.getTextInputValue('blueTeamName');
          } catch {}
          try {
            redInput = interaction.fields.getTextInputValue('redTeamName');
          } catch {}

          mutate(l, uid, 'setTeamName', {
            blueName: (isBlueCap || isOwner) && blueInput ? blueInput : undefined,
            redName: (isRedCap || isOwner) && redInput ? redInput : undefined
          });
          store.save(l, uid, 'SET_TEAM_NAME');

          await refreshLobbyMessage(interaction.guild, l);
          return interaction.reply({
            content: `Takım isimleri güncellendi: ${TEAM_EMOJI.BLUE} **${getTeamName(l, 'BLUE')}** vs ${TEAM_EMOJI.RED} **${getTeamName(l, 'RED')}**`,
            flags: MessageFlags.Ephemeral
          });
        }
        return;
      }

      if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

      // ======================================================================
      // C. 5v5 LOBİ & GEÇMİŞ MAÇ ETKİLEŞİMLERİ
      // ======================================================================
      const customParts = interaction.customId.split(':');

      if (interaction.isStringSelectMenu() && interaction.customId === 'cmd:historyDetail') {
        const matchId = interaction.values[0];
        const m = store.get(matchId);
        check(m, 'Seçilen maç kaydı bulunamadı.');

        const payload = buildLobbyPayload(m);
        return interaction.reply({
          embeds: payload.embeds,
          flags: MessageFlags.Ephemeral
        });
      }

      if (interaction.isStringSelectMenu() && interaction.customId === 'cmd:closeLobbySelect') {
        const perm = hasLobbyPermission(interaction);
        const hasStaffPerm = perm.allowed;

        const chosen = interaction.values[0];
        if (chosen === 'ALL') {
          const activeList = store
            .activeLobbies(interaction.guildId)
            .filter(item => hasStaffPerm || item.owner === interaction.user.id);

          for (const item of activeList) {
            mutate(item, interaction.user.id, 'close', { force: true });
            store.save(item, interaction.user.id, 'CLOSE');
            await returnPlayersAndCleanupVoice(interaction.guild, item);
            await refreshLobbyMessage(interaction.guild, item);
          }

          return interaction.update({
            content: `Toplam **${activeList.length}** aktif lobi kapatıldı.`,
            components: []
          });
        }

        const targetLobby = store.get(chosen);
        check(targetLobby && ACTIVE(targetLobby.state), 'Bu lobi zaten kapatılmış veya bulunamadı.');
        check(
          hasStaffPerm || targetLobby.owner === interaction.user.id,
          'Bu lobiyi kapatma yetkin yok.'
        );

        mutate(targetLobby, interaction.user.id, 'close', { force: true });
        store.save(targetLobby, interaction.user.id, 'CLOSE');
        await returnPlayersAndCleanupVoice(interaction.guild, targetLobby);
        await refreshLobbyMessage(interaction.guild, targetLobby);

        return interaction.update({
          content: `<#${targetLobby.channel}> kanalındaki **${targetLobby.name}** lobisi kapatıldı.`,
          components: []
        });
      }

      if (customParts[0] !== 'l') return;

      const [, lobbyId, action, arg] = customParts;
      const l = store.get(lobbyId);

      if (!l) {
        return interaction.reply({
          content: 'Bu lobi bulunamadı.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === 'teamNameModal') {
        const uid = interaction.user.id;
        const isOwner = uid === l.owner;
        const isBlueCap = uid === l.blue;
        const isRedCap = uid === l.red;

        check(
          isOwner || isBlueCap || isRedCap,
          'Takım ismini sadece Mavi Kaptan, Kırmızı Kaptan veya Lobi Kurucusu belirleyebilir!'
        );

        const modal = new ModalBuilder()
          .setCustomId(`l:${l.id}:teamNameSubmit`)
          .setTitle('Takım Adı Belirle');

        if (isBlueCap || (isOwner && !isRedCap)) {
          const blueInput = new TextInputBuilder()
            .setCustomId('blueTeamName')
            .setLabel('Mavi Takım Adı')
            .setStyle(TextInputStyle.Short)
            .setValue(getTeamName(l, 'BLUE'))
            .setMaxLength(35)
            .setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(blueInput));
        }

        if (isRedCap || (isOwner && !isBlueCap)) {
          const redInput = new TextInputBuilder()
            .setCustomId('redTeamName')
            .setLabel('Kırmızı Takım Adı')
            .setStyle(TextInputStyle.Short)
            .setValue(getTeamName(l, 'RED'))
            .setMaxLength(35)
            .setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(redInput));
        }

        if (isOwner && ((isBlueCap && isBotUser(l.red)) || (isRedCap && isBotUser(l.blue)))) {
          modal.setComponents([]);
          const blueInput = new TextInputBuilder()
            .setCustomId('blueTeamName')
            .setLabel('Mavi Takım Adı')
            .setStyle(TextInputStyle.Short)
            .setValue(getTeamName(l, 'BLUE'))
            .setMaxLength(35)
            .setRequired(true);
          const redInput = new TextInputBuilder()
            .setCustomId('redTeamName')
            .setLabel('Kırmızı Takım Adı')
            .setStyle(TextInputStyle.Short)
            .setValue(getTeamName(l, 'RED'))
            .setMaxLength(35)
            .setRequired(true);
          modal.addComponents(
            new ActionRowBuilder().addComponents(blueInput),
            new ActionRowBuilder().addComponents(redInput)
          );
        }

        return interaction.showModal(modal);
      }

      if (action === 'coinflip') {
        const sonuc = randomInt(0, 2) === 0 ? '**YAZI**' : '**TURA**';
        return interaction.reply({
          content: `<@${interaction.user.id}> lobi için yazı tura attı: ${sonuc} geldi!`
        });
      }

      if (action === 'leaderboard') {
        return interaction.reply({
          embeds: [buildLeaderboardEmbed(store, interaction.guildId)],
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === 'secret') {
        const isParticipant = member(l, interaction.user.id) || interaction.user.id === l.owner;
        check(
          isParticipant,
          'Lobi şifresini ve linkini sadece **lobiye katılan oyuncular** görebilir!'
        );
        return interaction.reply({
          content:
            `**${l.name} — Lobi Bilgileri**\n` +
            `**Şifre:** \`${l.password}\`\n` +
            `**Davet Linki:** ${l.link}`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === 'join') {
        const activeOther = store.activeMember(interaction.guildId, interaction.user.id);
        if (activeOther && activeOther.lobby_id !== l.id) {
          throw new Error('Başka bir aktif lobide yer alıyorsun. Önce oradan ayrılmalısın.');
        }

        const discordName =
          interaction.member?.displayName ||
          interaction.user.globalName ||
          interaction.user.username;

        mutate(l, interaction.user.id, 'join', {
          lane: Number(arg),
          nick: discordName
        });

        store.save(l, interaction.user.id, 'JOIN');
        await interaction.update(buildLobbyPayload(l));

        await interaction.followUp({
          content:
            `**${LANES[Number(arg)]}** koridoruna \`${discordName}\` ismiyle katıldın.\n` +
            `**Lobi Şifresi:** \`${l.password}\`\n` +
            `**Lobi Linki:** ${l.link}`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (action === 'leave') {
        mutate(l, interaction.user.id, 'leave');
        store.save(l, interaction.user.id, 'LEAVE');
        return interaction.update(buildLobbyPayload(l));
      }

      if (action === 'fillBots') {
        const discordName =
          interaction.member?.displayName ||
          interaction.user.globalName ||
          interaction.user.username;
        const activeOther = store.activeMember(interaction.guildId, interaction.user.id);
        const canAddOwner = !activeOther || activeOther.lobby_id === l.id;

        mutate(l, interaction.user.id, 'fillBots', {
          targetCount: 10,
          includeOwner: canAddOwner,
          ownerNick: discordName,
          autoCaptains: true
        });
        store.save(l, interaction.user.id, 'FILL_BOTS');
        return interaction.update(buildLobbyPayload(l));
      }

      if (action === 'capRand') {
        mutate(l, interaction.user.id, 'randomCaptains');
        store.save(l, interaction.user.id, 'RANDOM_CAPTAINS');
        return interaction.update(buildLobbyPayload(l));
      }

      if (action === 'capReset') {
        mutate(l, interaction.user.id, 'resetCaptains');
        store.save(l, interaction.user.id, 'RESET_CAPTAINS');
        return interaction.update(buildLobbyPayload(l));
      }

      if (action === 'capMenu') {
        check(interaction.user.id === l.owner, 'Sadece lobi kurucusu kaptan seçebilir.');
        check(l.state === 'WAITING', 'Seçimler başladıktan sonra kaptan değiştirilemez.');

        const eligiblePlayers = l.members.filter(
          m => l.members.filter(x => x.lane === m.lane).length === 2
        );
        check(
          eligiblePlayers.length >= 2,
          'Kaptanlar aynı koridordan seçilmek zorunda olduğu için en az bir koridorda 2 oyuncu bulunmalıdır!'
        );

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`l:${l.id}:setBlueCap`)
          .setPlaceholder('Mavi Takım Kaptanını Seç (Karşıdaki Otomatik Kırmızı Olur)')
          .addOptions(
            eligiblePlayers.map(m => ({
              label: `${m.nick} (${LANES[m.lane]})`.slice(0, 100),
              description: `${LANES[m.lane]} koridorundan Mavi Kaptan olarak ata`,
              value: m.id
            }))
          );

        return interaction.reply({
          content: `${TEAM_EMOJI.BLUE} **Mavi Takım Kaptanını** seçin (Aynı koridordaki diğer oyuncu otomatik olarak ${TEAM_EMOJI.RED} **Kırmızı Kaptan** atanacaktır):`,
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === 'setBlueCap' && interaction.isStringSelectMenu()) {
        const blueId = interaction.values[0];
        const blueMember = member(l, blueId);
        check(blueMember, 'Oyuncu lobide bulunamadı.');

        const redMember = l.members.find(
          m => m.lane === blueMember.lane && m.id !== blueId
        );
        check(redMember, 'Seçilen oyuncunun koridorunda ikinci bir oyuncu yok.');

        mutate(l, interaction.user.id, 'resetCaptains');
        mutate(l, interaction.user.id, 'blue', { target: blueId });
        mutate(l, interaction.user.id, 'red', { target: redMember.id });

        store.save(l, interaction.user.id, 'SET_CAPTAINS');
        await refreshLobbyMessage(interaction.guild, l);

        return interaction.update({
          content: `Kaptanlar ayarlandı: ${TEAM_EMOJI.BLUE} **${getTeamName(l, 'BLUE')}:** **${blueMember.nick} (Kaptan)** | ${TEAM_EMOJI.RED} **${getTeamName(l, 'RED')}:** **${redMember.nick} (Kaptan)**`,
          components: []
        });
      }

      if (action === 'startDraft') {
        mutate(l, interaction.user.id, 'startDraft');
        store.save(l, interaction.user.id, 'START_DRAFT');
        return interaction.update(buildLobbyPayload(l));
      }

      if (action === 'openPick') {
        check(l.state === 'DRAFT', 'Şu anda aktif seçim yok.');
        const currentCap = captain(l, l.turn);
        const canPick =
          interaction.user.id === currentCap ||
          (isBotUser(currentCap) && interaction.user.id === l.owner);

        check(
          canPick,
          `Sıra sende değil! Şu an seçim sırası: ${formatPlayerMention(member(l, currentCap))}`
        );

        const activeTeamName = getTeamName(l, l.turn);
        const choices = l.members.filter(m => eligible(l, m.id, l.turn));
        check(choices.length > 0, 'Seçilebilecek uygun oyuncu kalmadı.');

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`l:${l.id}:pick:${l.revision}`)
          .setPlaceholder(`${activeTeamName} İçin Oyuncu Seç (Karşıdaki Diğer Takıma Geçer)`)
          .addOptions(
            choices.map(m => {
              const opp = l.members.find(x => x.lane === m.lane && x.id !== m.id && !x.team);
              const oppInfo = opp ? ` | Karşıya: ${opp.nick}` : '';
              return {
                label: `${m.nick} — ${LANES[m.lane]}`.trim().slice(0, 100),
                description: `${LANES[m.lane]} (${activeTeamName}${oppInfo})`.slice(0, 100),
                value: m.id
              };
            })
          );

        return interaction.reply({
          content: `**${l.turn === 'BLUE' ? TEAM_EMOJI.BLUE : TEAM_EMOJI.RED} ${activeTeamName}** için kadroya katmak istediğin oyuncuyu seç *(Aynı koridordaki diğer oyuncu otomatik olarak karşı takıma atanacaktır)*:`,
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === 'pick' && interaction.isStringSelectMenu()) {
        const pickedTeam = l.turn;
        const otherTeam = pickedTeam === 'BLUE' ? 'RED' : 'BLUE';
        const targetId = interaction.values[0];
        const targetMem = member(l, targetId);
        const oppositeMem = targetMem
          ? l.members.find(m => m.lane === targetMem.lane && m.id !== targetMem.id && !m.team)
          : null;

        mutate(l, interaction.user.id, 'pick', {
          target: targetId,
          revision: Number(arg)
        });

        store.save(l, interaction.user.id, 'PICK');
        await refreshLobbyMessage(interaction.guild, l);

        const pickedTeamLabel = `${pickedTeam === 'BLUE' ? TEAM_EMOJI.BLUE : TEAM_EMOJI.RED} **${getTeamName(l, pickedTeam)}**`;
        const otherTeamLabel = `${otherTeam === 'BLUE' ? TEAM_EMOJI.BLUE : TEAM_EMOJI.RED} **${getTeamName(l, otherTeam)}**`;

        return interaction.update({
          content: oppositeMem
            ? `${formatPlayerMention(targetMem)} ${pickedTeamLabel} kadrosuna eklendi; aynı koridordaki ${formatPlayerMention(oppositeMem)} otomatik olarak ${otherTeamLabel} kadrosuna atandı.`
            : `${formatPlayerMention(targetMem)} ${pickedTeamLabel} kadrosuna eklendi.`,
          components: []
        });
      }

      if (action === 'startMatch') {
        check(interaction.user.id === l.owner, 'Maçı sadece lobi kurucusu başlatabilir.');
        check(l.state === 'READY', 'Takımlar henüz hazır değil.');

        await interaction.deferUpdate();

        const guild = interaction.guild;
        const blueMembers = l.members.filter(m => m.team === 'BLUE' && !isBotUser(m.id));
        const redMembers = l.members.filter(m => m.team === 'RED' && !isBotUser(m.id));

        const buildOverwrites = teamMembers => [
          {
            id: guild.id,
            allow: [PermissionFlagsBits.ViewChannel],
            deny: [PermissionFlagsBits.Connect]
          },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.MoveMembers,
              PermissionFlagsBits.ManageChannels
            ]
          },
          ...teamMembers
            .filter(m => /^\d+$/.test(String(m.id)))
            .map(m => ({
              id: m.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak
              ]
            }))
        ];

        const hasConfiguredCategory =
          AYARLAR.VOICE_CATEGORY_ID &&
          guild.channels.cache.has(AYARLAR.VOICE_CATEGORY_ID);
        const categoryId = hasConfiguredCategory
          ? AYARLAR.VOICE_CATEGORY_ID
          : interaction.channel?.parentId || null;

        const blueVoiceName = `${TEAM_EMOJI.BLUE} ${getTeamName(l, 'BLUE')}`.slice(0, 95);
        const redVoiceName = `${TEAM_EMOJI.RED} ${getTeamName(l, 'RED')}`.slice(0, 95);

        const blueChannel = await guild.channels.create({
          name: blueVoiceName,
          type: ChannelType.GuildVoice,
          parent: categoryId,
          permissionOverwrites: buildOverwrites(blueMembers)
        });

        const redChannel = await guild.channels.create({
          name: redVoiceName,
          type: ChannelType.GuildVoice,
          parent: categoryId,
          permissionOverwrites: buildOverwrites(redMembers)
        });

        mutate(l, interaction.user.id, 'startMatch', {
          blueVoiceId: blueChannel.id,
          redVoiceId: redChannel.id
        });
        store.save(l, interaction.user.id, 'START_MATCH');

        for (const m of l.members) {
          if (isBotUser(m.id)) continue;
          try {
            const guildMember =
              guild.members.cache.get(m.id) || (await guild.members.fetch(m.id).catch(() => null));
            if (guildMember?.voice?.channelId) {
              const targetChannelId = m.team === 'BLUE' ? blueChannel.id : redChannel.id;
              await guildMember.voice.setChannel(targetChannelId);
            }
          } catch {}
        }

        await interaction.editReply(buildLobbyPayload(l));
        return;
      }

      if (action === 'moveVoice') {
        check(interaction.user.id === l.owner, 'Sadece lobi kurucusu kullanabilir.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let moved = 0;
        for (const m of l.members) {
          if (isBotUser(m.id)) continue;
          try {
            const gm =
              interaction.guild.members.cache.get(m.id) ||
              (await interaction.guild.members.fetch(m.id).catch(() => null));
            if (gm?.voice?.channelId) {
              const target = m.team === 'BLUE' ? l.blueVoiceId : l.redVoiceId;
              if (target && gm.voice.channelId !== target) {
                await gm.voice.setChannel(target);
                moved++;
              }
            }
          } catch {}
        }

        return interaction.editReply({
          content: `Ses kanalında bulunan **${moved}** oyuncu kendi takım odasına taşındı.`
        });
      }

      if (action === 'finishMenu') {
        check(interaction.user.id === l.owner, 'Maçı sadece lobi kurucusu bitirebilir.');

        const blueName = getTeamName(l, 'BLUE');
        const redName = getTeamName(l, 'RED');

        const row = new ActionRowBuilder().addComponents(
          makeBtn({
            id: `l:${l.id}:win:BLUE`,
            label: `${blueName} Kazandı (+1 Win)`.slice(0, 80),
            emoji: TEAM_EMOJI.BLUE,
            style: ButtonStyle.Primary
          }),
          makeBtn({
            id: `l:${l.id}:win:RED`,
            label: `${redName} Kazandı (+1 Win)`.slice(0, 80),
            emoji: TEAM_EMOJI.RED,
            style: ButtonStyle.Danger
          })
        );

        return interaction.reply({
          content: `**Maçı kazanan takımı seçin.** (Kazanan takıma +1 Win, kaybeden takıma -1 Lose yazılır; oyuncular <#${AYARLAR.LOBBY_VOICE_ID}> ses kanalına geri taşınır ve takım odaları kapatılır):`,
          components: [row],
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === 'win') {
        check(interaction.user.id === l.owner, 'Sadece lobi kurucusu kazananı seçebilir.');
        await interaction.deferUpdate();

        mutate(l, interaction.user.id, 'finishMatch', { winner: arg });
        store.save(l, interaction.user.id, 'FINISH_MATCH');

        await returnPlayersAndCleanupVoice(interaction.guild, l);
        await refreshLobbyMessage(interaction.guild, l);

        const winningTeamLabel =
          arg === 'BLUE'
            ? `${TEAM_EMOJI.BLUE} ${getTeamName(l, 'BLUE')}`
            : `${TEAM_EMOJI.RED} ${getTeamName(l, 'RED')}`;

        return interaction.editReply({
          content: `Maç sona erdi. **${winningTeamLabel}** kazandı olarak kaydedildi, oyuncular <#${AYARLAR.LOBBY_VOICE_ID}> ses kanalına geri taşındı ve liderlik tablosu güncellendi.`,
          components: []
        });
      }

      if (action === 'close') {
        const perm = hasLobbyPermission(interaction);
        const canForceClose = perm.allowed || interaction.user.id === l.owner;
        check(canForceClose, 'Bu lobiyi sadece lobi kurucusu veya yetkili kapatabilir.');

        mutate(l, interaction.user.id, 'close', { force: true });
        store.save(l, interaction.user.id, 'CLOSE');
        await returnPlayersAndCleanupVoice(interaction.guild, l);
        return interaction.update(buildLobbyPayload(l));
      }
    } catch (err) {
      console.error('Interaction Hatası:', err);
      const msg = `Hata: ${err.message || 'Bir sorun oluştu.'}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  client.on('error', err => {
    console.error('Discord Client Hatası:', err);
  });
  process.on('unhandledRejection', err => {
    console.error('Yakalanmayan Promise Hatası:', err);
  });

  await client.login(AYARLAR.DISCORD_TOKEN);
}

if (require.main !== module) {
  module.exports = { Store, createDiscordBuilders, AYARLAR, newLobby, mutate };
} else if (process.argv.includes('--test')) {
  runTests();
} else {
  startBot();
}
