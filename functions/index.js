const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: 'europe-west2' }); // closest to UK

// ─── Helpers to read Firestore data ────────────────────────────────────────

async function getPlayers() {
  const doc = await db.collection('data').doc('players').get();
  return doc.exists ? JSON.parse(doc.data().list) : [];
}

async function getMatches() {
  const doc = await db.collection('data').doc('matches').get();
  return doc.exists ? JSON.parse(doc.data().list) : [];
}

// ─── Tool definitions (what Claude can call) ────────────────────────────────

const TOOLS = [
  {
    name: 'get_all_players',
    description: 'Returns the full squad list with each player\'s season totals for goals, assists, and Coach Player of the Match (C-POTM) awards.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_all_matches',
    description: 'Returns all matches with full details: opponent, date, score, home/away, competition, status, and every goal/assist event.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_player_stats',
    description: 'Returns detailed stats for a single named player: their goals, assists, C-POTM awards, and a list of every match event they were involved in.',
    input_schema: {
      type: 'object',
      properties: {
        player_name: {
          type: 'string',
          description: 'The player\'s name (case-insensitive partial match is fine)'
        }
      },
      required: ['player_name']
    }
  },
  {
    name: 'get_match_details',
    description: 'Returns full details of a specific match: score, scorers, assists, opponent, date, home/away, competition, and match report if available.',
    input_schema: {
      type: 'object',
      properties: {
        opponent: {
          type: 'string',
          description: 'Opponent team name (partial match is fine)'
        },
        date: {
          type: 'string',
          description: 'Match date in YYYY-MM-DD format (optional, helps narrow down if multiple matches vs same opponent)'
        }
      },
      required: ['opponent']
    }
  },
  {
    name: 'get_recent_form',
    description: 'Returns results and scorers from the last N completed matches to assess recent team form.',
    input_schema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of recent matches to return (default 5)'
        }
      }
    }
  },
  {
    name: 'get_top_scorers',
    description: 'Returns a ranked list of top goal scorers and top assisters for the season.',
    input_schema: { type: 'object', properties: {} }
  }
];

// ─── Tool execution ──────────────────────────────────────────────────────────

async function executeTool(name, input) {
  const players = await getPlayers();
  const matches = await getMatches();

  if (name === 'get_all_players') {
    return players.map(p => ({
      name: p.name,
      goals: p.goals || 0,
      assists: p.assists || 0,
      cpotm: p.motm || 0
    }));
  }

  if (name === 'get_all_matches') {
    return matches.map(m => ({
      opponent: m.opponent,
      date: m.date,
      score: `${(m.events || []).filter(e => e.type === 'goal' && !e.ownGoal).length} - ${m.scoreOpp || 0}`,
      status: m.status,
      homeAway: m.homeAway,
      competition: m.competition,
      scorers: (m.events || []).filter(e => e.type === 'goal' && !e.ownGoal).map(e => ({
        player: e.player, time: e.time, penalty: e.penalty, assist: e.assistBy
      })),
      ownGoals: (m.events || []).filter(e => e.ownGoal).length,
      report: m.reportPublished ? m.report : null
    }));
  }

  if (name === 'get_player_stats') {
    const query = input.player_name.toLowerCase();
    const player = players.find(p => p.name.toLowerCase().includes(query));
    if (!player) return { error: `No player found matching "${input.player_name}"` };

    const involvement = [];
    matches.forEach(m => {
      (m.events || []).forEach(e => {
        if (e.player === player.name || e.assistBy === player.name) {
          involvement.push({
            match: `vs ${m.opponent}`,
            date: m.date,
            type: e.player === player.name ? e.type : 'assist',
            time: e.time,
            penalty: e.penalty || false
          });
        }
      });
    });

    return {
      name: player.name,
      goals: player.goals || 0,
      assists: player.assists || 0,
      cpotm: player.motm || 0,
      involvement
    };
  }

  if (name === 'get_match_details') {
    const query = input.opponent.toLowerCase();
    let candidates = matches.filter(m => (m.opponent || '').toLowerCase().includes(query));
    if (input.date) candidates = candidates.filter(m => m.date === input.date);
    if (candidates.length === 0) return { error: `No match found vs "${input.opponent}"` };

    // Return most recent if multiple
    const m = candidates.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    const sumasGoals = (m.events || []).filter(e => e.type === 'goal' && !e.ownGoal).length;
    return {
      opponent: m.opponent,
      date: m.date,
      homeAway: m.homeAway,
      competition: m.competition,
      location: m.location,
      linesman: m.linesman,
      score: `${sumasGoals} - ${m.scoreOpp || 0}`,
      result: sumasGoals > (m.scoreOpp || 0) ? 'WIN' : sumasGoals < (m.scoreOpp || 0) ? 'LOSS' : 'DRAW',
      status: m.status,
      goals: (m.events || []).filter(e => e.type === 'goal' && !e.ownGoal).map(e => ({
        scorer: e.player, time: e.time, penalty: e.penalty, assistBy: e.assistBy || null
      })),
      ownGoals: (m.events || []).filter(e => e.ownGoal).length,
      report: m.reportPublished ? m.report : null,
      cpotm: m.motm || null
    };
  }

  if (name === 'get_recent_form') {
    const count = input.count || 5;
    const ended = matches
      .filter(m => m.status === 'ended')
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, count);

    return ended.map(m => {
      const sumasGoals = (m.events || []).filter(e => e.type === 'goal' && !e.ownGoal).length;
      const opp = m.scoreOpp || 0;
      return {
        opponent: m.opponent,
        date: m.date,
        score: `${sumasGoals} - ${opp}`,
        result: sumasGoals > opp ? 'WIN' : sumasGoals < opp ? 'LOSS' : 'DRAW',
        scorers: (m.events || []).filter(e => e.type === 'goal' && !e.ownGoal).map(e => e.player),
        cpotm: m.motm || null
      };
    });
  }

  if (name === 'get_top_scorers') {
    const sorted = [...players].sort((a, b) => (b.goals || 0) - (a.goals || 0));
    const topAssists = [...players].sort((a, b) => (b.assists || 0) - (a.assists || 0));
    return {
      topScorers: sorted.slice(0, 5).map(p => ({ name: p.name, goals: p.goals || 0 })),
      topAssists: topAssists.slice(0, 5).map(p => ({ name: p.name, assists: p.assists || 0 })),
      topCpotm: [...players].sort((a, b) => (b.motm || 0) - (a.motm || 0))
        .slice(0, 3).map(p => ({ name: p.name, awards: p.motm || 0 }))
    };
  }

  return { error: `Unknown tool: ${name}` };
}

// ─── Main Cloud Function ─────────────────────────────────────────────────────

exports.sumasAI = onRequest(async (req, res) => {
  // CORS — allow requests from GitHub Pages or local dev
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    res.status(400).json({ error: 'Missing query' });
    return;
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY  // set via: firebase functions:secrets:set ANTHROPIC_API_KEY
  });

  const messages = [{ role: 'user', content: query }];

  const SYSTEM = `You are the SUMAS FC stats assistant. SUMAS FC is an under-11s football club.
You have access to live data from their Firestore database via tools.
Keep answers friendly, concise, and focused on the football. Use the tools to look up real data before answering.
When generating a match report, write in an enthusiastic but factual style suitable for parents and players.
Refer to the team as "SUMAS" or "the boys". Avoid making up statistics — always use the tool data.`;

  try {
    let response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: SYSTEM,
      tools: TOOLS,
      messages
    });

    // Agentic loop — keep going while Claude wants to call tools
    let iterations = 0;
    while (response.stop_reason === 'tool_use' && iterations < 10) {
      iterations++;
      const toolUses = response.content.filter(b => b.type === 'tool_use');

      // Execute all requested tools in parallel
      const toolResults = await Promise.all(
        toolUses.map(async tool => {
          const result = await executeTool(tool.name, tool.input);
          return {
            type: 'tool_result',
            tool_use_id: tool.id,
            content: JSON.stringify(result)
          };
        })
      );

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        system: SYSTEM,
        tools: TOOLS,
        messages
      });
    }

    const answer = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    res.json({ answer });

  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'AI request failed', detail: err.message });
  }
});
