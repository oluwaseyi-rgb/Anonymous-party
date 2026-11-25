require('dotenv').config({ path: '.env.local' });
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const http = require('node:http');
const fs = require('node:fs');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: true } });
const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL = Math.max(1, Number(process.env.ROOM_TTL_HOURS) || 12) * 60 * 60 * 1000;
const HOST_RECONNECT_GRACE_MS = Math.max(1, Number(process.env.HOST_RECONNECT_GRACE_MINUTES) || 30) * 60 * 1000;
const rooms = new Map();
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const PHOTO_BUCKET = process.env.SUPABASE_STORAGE_BUCKET;
const games = [
  { id: 'most-likely', name: "Who’s Most Likely?", emoji: '👀', description: 'Point the spotlight at the friend who fits the prompt.' },
  { id: 'smash-or-pass', name: 'Smash or Pass', emoji: '✨', description: 'A playful, opt-in photo voting game.' },
  { id: 'unpopular-opinions', name: 'Unpopular Opinions', emoji: '🌶️', description: 'Agree or disagree with a spicy take.' },
  { id: 'expose-friends', name: 'Expose Your Friends', emoji: '🫣', description: 'Pick the friend who best matches the prompt.' },
  { id: 'confessions', name: 'Anonymous Confessions', emoji: '🤫', description: 'Share a light confession and react together.' }
];
const prompts = [
  'Who’s most likely to become famous and still reply “who’s this?”',
  'Who’s most likely to get lost using a map inside a shopping mall?',
  'Who’s most likely to accidentally start a new holiday?',
  'Who’s most likely to bring snacks for a five-minute trip?',
  'Who’s most likely to become a millionaire and forget their friends?',
  'Who’s most likely to laugh at the worst possible moment?',
  'Who’s most likely to survive a week with no phone?',
  'Who’s most likely to turn a small story into a three-part series?',
  'Who’s most likely to adopt a very unusual pet?',
  'Who’s most likely to win an argument using completely made-up facts?',
  'Who’s most likely to plan a trip and forget the tickets?',
  'Who’s most likely to become the group’s unofficial life coach?'
];
const opinionPrompts = ['University grades don’t determine intelligence.','Breakfast food is good at every hour.','Voice notes should never be longer than one minute.','The best seat on any bus is by the window.','Group projects are secretly character tests.','A plan made in the group chat is not a real plan until someone confirms it.','The last slice of pizza belongs to whoever asks first.','Being five minutes early is actually being on time.'];
const exposePrompts = ['Who would sell out the group for ₦1 million?','Who would accidentally become the group’s manager?','Who would bring the most unnecessary item on a camping trip?','Who is most likely to forget why they opened the fridge?','Who could talk their way into a free dessert?','Who would start a side quest during a quick errand?','Who is secretly the most competitive?','Who would get adopted by a stranger’s family at a party?'];
const confessions = ['I once waved back at someone who wasn’t waving at me, then committed to it.','I have opened the fridge, forgotten why, and closed it like I meant to.','I rehearse phone calls before making them.','I have a playlist for a situation that has never happened.','I pretend to understand a film ending and then search it later.','I have walked into a room and immediately forgotten my mission.','I have sent a screenshot to the person in the screenshot.','I have an oddly specific fear of automatic doors not opening.'];
const reactions = ['😂','😭','😳','❤️'];
// When bundled for Netlify, __dirname no longer points at the repo root, so fall back to the working directory.
const PUBLIC_DIR = [path.join(__dirname, 'public'), path.join(process.cwd(), 'public')].find(dir => fs.existsSync(path.join(dir, 'index.html'))) || path.join(__dirname, 'public');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(express.static(PUBLIC_DIR));
app.get('/api/games', (_req, res) => res.json(games));
app.get('/api/prompt-pools', (_req, res) => res.json({ 'most-likely': prompts, 'unpopular-opinions': opinionPrompts, 'expose-friends': exposePrompts }));
app.get('/api/room/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room || room.status === 'ended' || room.expiresAt < Date.now()) return res.status(404).json({ error: 'This room has ended or the invitation has expired.' });
  res.json({ roomId: room.id, status: room.status, gameId: room.gameId, round: room.round ? { prompt: room.round.prompt, status: room.round.status } : null });
});
app.get(/^\/(?!api\/|socket\.io\/|assets\/).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

function makeRoom() {
  let id;
  do { id = crypto.randomBytes(4).toString('hex').toUpperCase(); } while (rooms.has(id));
  const now = Date.now();
  const room = { id, status: 'lobby', createdAt: now, expiresAt: now + ROOM_TTL, hostId: null, actingHostId: null, players: new Map(), gameId: 'most-likely', round: null, roundNumber: 0, gameVote: null, scores: new Map(), confessions: [], selectedBuiltInPrompts: {}, customPrompts: { 'most-likely': [], 'unpopular-opinions': [], 'expose-friends': [] }, promptModes: { 'most-likely': 'mixed', 'unpopular-opinions': 'mixed', 'expose-friends': 'mixed' }, promptIndices: {} };
  rooms.set(id, room);
  return room;
}
function publicState(room) {
  const players = [...room.players.values()].map(p => ({ id: p.id, nickname: p.nickname, avatar: p.avatar, host: p.id === room.hostId || p.id === room.actingHostId, ready: p.ready, connected: p.connected, inRound: Boolean(room.round?.status==='active'&&room.round.eligible.includes(p.id)), photoConsent: Boolean(p.photoConsent), score: room.scores.get(p.id) || 0 }));
  const votes = room.round ? [...room.round.votes.keys()] : [];
  const submittedCount=room.gameId==='smash-or-pass'&&room.round?.photoVotes?[...room.round.photoVotes.values()].reduce((n,votes)=>n+votes.size,0):(room.round?.playerAnswers?.size||0);
  return { roomId: room.id, status: room.status, hostId: room.hostId, players, playerCount: players.length, gameId: room.gameId, gameName: games.find(g => g.id === room.gameId)?.name, roundNumber: room.roundNumber, promptModes: room.promptModes, selectedBuiltInPrompts: room.selectedBuiltInPrompts, customPromptCounts: Object.fromEntries(Object.entries(room.customPrompts).map(([id,list])=>[id,list.length])), confessionHistory: room.confessions, round: room.round ? { prompt: room.round.prompt, status: room.round.status, submittedCount, eligibleCount: room.round.eligible.length, photoDeck: room.round.photoDeck?.map(({id,ownerId,nickname,photo})=>({id,ownerId,nickname,photo})) || [], photoResults: room.round.status === 'results' ? room.round.photoResults : null, result: room.round.status === 'results' ? room.round.result : null } : null, gameVote: room.gameVote ? { options: room.gameVote.options, votes: Object.fromEntries(room.gameVote.votes), result: room.gameVote.result } : null, leaderboard: players.sort((a,b) => b.score-a.score).map((p,i) => ({...p, rank:i+1})) };
  return { roomId: room.id, status: room.status, hostId: room.hostId, players, playerCount: players.length, gameId: room.gameId, gameName: games.find(g => g.id === room.gameId)?.name, roundNumber: room.roundNumber, promptModes: room.promptModes, selectedBuiltInPrompts: room.selectedBuiltInPrompts, customPromptCounts: Object.fromEntries(Object.entries(room.customPrompts).map(([id,list])=>[id,list.length])), round: room.round ? { prompt: room.round.prompt, status: room.round.status, submittedCount, eligibleCount: room.round.eligible.length, photoDeck: room.round.photoDeck?.map(({id,ownerId,nickname,photo})=>({id,ownerId,nickname,photo})) || [], photoResults: room.round.status === 'results' ? room.round.photoResults : null, result: room.round.status === 'results' ? room.round.result : null } : null, gameVote: room.gameVote ? { options: room.gameVote.options, votes: Object.fromEntries(room.gameVote.votes), result: room.gameVote.result } : null, leaderboard: players.sort((a,b) => b.score-a.score).map((p,i) => ({...p, rank:i+1})) };
}
function stateFor(room, playerId) { const state=publicState(room); if(room.round){state.round.mine=room.round.playerAnswers.has(playerId);state.round.inRound=room.round.eligible.includes(playerId);state.round.personal=room.round.personal.get(playerId)||null; state.round.myReaction=room.round.reactions.get(playerId)||null;const votes=room.round.photoVotes?.get(playerId)||new Map();state.round.myPhotoVotes=Object.fromEntries(votes);state.round.currentPhotoId=room.round.photoDeck?.find(photo=>photo.ownerId!==playerId&&!votes.has(photo.id))?.id||null;} return state; }
function emitState(room) { for(const p of room.players.values()) if(p.socketId) io.to(p.socketId).emit('room:state', stateFor(room,p.id)); }
function fail(socket, message) { socket.emit('app:error', { message }); }
function clearRoundTimer(room) { if (room.round?.timer) clearTimeout(room.round.timer); }
function closeRound(room) {
  if (!room.round || room.round.status !== 'active') return;
  clearRoundTimer(room);
  room.round.status = 'results';
  const tally = {};
  if(['most-likely','expose-friends'].includes(room.gameId)) { for (const id of room.round.eligible) tally[id]=0; for (const answer of room.round.playerAnswers.values()) if(answer.type==='target') tally[answer.value]=(tally[answer.value]||0)+1; }
  else if(room.gameId==='unpopular-opinions') { tally.agree=0;tally.disagree=0; for(const a of room.round.playerAnswers.values())if(a.type==='choice')tally[a.value]++; }
  else if(room.gameId==='smash-or-pass') { const deck=room.round.photoDeck||[];room.round.photoResults=deck.map(photo=>{let smash=0,pass=0;const reasons=[];for(const [voter,votes] of room.round.photoVotes||[]){const vote=votes.get(photo.id);if(!vote)continue;if(vote.value==='smash')smash++;else pass++;if(vote.reason)reasons.push(vote.reason);}tally[photo.id]=smash;return {...photo,smash,pass,reasons};}).sort((a,b)=>b.smash-a.smash||a.nickname.localeCompare(b.nickname)); }
  const max = Math.max(0, ...Object.values(tally));
  const winners = ['most-likely','expose-friends'].includes(room.gameId) ? Object.entries(tally).filter(([,n])=>n===max&&n>0).map(([id])=>id) : [];
  const voterCount = room.gameId==='smash-or-pass'?[...(room.round.photoVotes?.values()||[])].reduce((n,votes)=>n+votes.size,0):room.round.playerAnswers.size;
  // Participation earns one point; a player who votes for a top result gets one bonus point.
  for (const [voter,answer] of room.round.playerAnswers) if(answer.type!=='skip') room.scores.set(voter, (room.scores.get(voter) || 0) + 1);
  if(room.gameId==='smash-or-pass')for(const [voter,votes] of room.round.photoVotes)if(votes.size)room.scores.set(voter,(room.scores.get(voter)||0)+1);
  if (winners.length === 1) for (const [voter,answer] of room.round.playerAnswers) if (answer.type==='target'&&answer.value === winners[0]) room.scores.set(voter, (room.scores.get(voter) || 0) + 1);
  const confessionPosts=room.gameId==='confessions'?[...room.round.personal.entries()].map(([id,post])=>({text:post.text,author:post.reveal?room.players.get(id)?.nickname:null})):[];
  room.round.result = { tally, winnerIds: winners, votesCast: voterCount, eligibleCount: room.round.eligible.length, scoring: '1 point for participating; 1 bonus point for choosing the sole top-voted player.' , confession: room.round.confession, confessionPosts, reactions:Object.fromEntries(room.round.reactions)};
  emitState(room);
}
function startRound(room) {
  clearRoundTimer(room);
  const eligible = [...room.players.values()].filter(p => p.connected).map(p => p.id);
  if (eligible.length < 2) return false;
  room.roundNumber++;
  const promptPools={'most-likely':prompts,'unpopular-opinions':opinionPrompts,'expose-friends':exposePrompts};
  const seq=room.roundNumber-1;
  let prompt;
  if(promptPools[room.gameId]){const defaults=promptPools[room.gameId],custom=room.customPrompts[room.gameId]||[],mode=room.promptModes[room.gameId]||'mixed';const pool=mode==='defaults'||!custom.length?defaults:mode==='custom'?custom:[...defaults,...custom];const index=room.promptIndices[`${room.gameId}:${mode}`]||0;prompt=room.selectedBuiltInPrompts[room.gameId]||pool[index%pool.length];room.promptIndices[`${room.gameId}:${mode}`]=index+1;}
  else prompt=room.gameId==='smash-or-pass'?'Smash or Pass':'Drop a light confession. It stays anonymous unless you reveal yourself.';
  room.round = { number: room.roundNumber, prompt, eligible, playerAnswers:new Map(), personal:new Map(), reactions:new Map(), photos:new Map(), photoDeck:[], photoVotes:new Map(), reports:new Set(), confession: room.gameId==='confessions'?confessions[seq%confessions.length]:null, votes:new Map(), status: 'active', startedAt: Date.now(), result: null };
  if(room.gameId==='smash-or-pass'){room.round.photoDeck=eligible.filter(id=>room.players.get(id)?.photoConsent&&room.players.get(id)?.photo).map(id=>({id,ownerId:id,nickname:room.players.get(id).nickname,photo:room.players.get(id).photo}));room.round.prompt='Smash or Pass';}
  room.status = 'playing';
  emitState(room);
  return true;
}
function getRoom(socket) { return socket.data.roomId ? rooms.get(socket.data.roomId) : null; }
function isHost(room, socket) { return room?.hostId === socket.data.playerId || room?.actingHostId === socket.data.playerId; }

io.on('connection', socket => {
  socket.on('room:create', ({ nickname, avatar } = {}, ack = () => {}) => {
    const clean = String(nickname || '').trim().slice(0, 20);
    if (!clean) return ack({ ok: false, error: 'Choose a nickname first.' });
    const room = makeRoom();
    const player = { id: crypto.randomUUID(), nickname: clean, avatar: validAvatar(avatar), ready: true, connected: true, joinedAt: Date.now(), disconnectedAt: null };
    const player = { id: crypto.randomUUID(), nickname: clean, avatar: validAvatar(avatar), ready: true, connected: true, joinedAt: Date.now(), disconnectedAt: null, mentionNotifications: [] };
    room.hostId = player.id; player.socketId=socket.id; room.players.set(player.id, player); room.scores.set(player.id, 0);
    socket.data.roomId = room.id; socket.data.playerId = player.id; socket.join(room.id);
    ack({ ok: true, roomId: room.id, playerId: player.id, host: true, expiresAt: room.expiresAt }); emitState(room);
    socket.data.roomId = room.id; socket.data.playerId = player.id; socket.join(room.id); socket.emit('confession:history', room.confessions); if(player.mentionNotifications?.length){for(const notification of player.mentionNotifications)socket.emit('confession:mentioned',notification);player.mentionNotifications=[];} ack({ ok: true, roomId: room.id, playerId: player.id, host: true, expiresAt: room.expiresAt }); emitState(room);
  });
  socket.on('room:join', ({ roomId, nickname, avatar, playerId } = {}, ack = () => {}) => {
    const room = rooms.get(String(roomId || '').toUpperCase());
    if (!room || room.status === 'ended' || room.expiresAt < Date.now()) return ack({ ok: false, error: 'That invitation has expired or the room has ended.' });
    let player = room.players.get(playerId);
    if (!player) {
      const clean = String(nickname || '').trim().slice(0, 20);
      if (!clean) return ack({ ok: false, error: 'Choose a nickname first.' });
      player = { id: crypto.randomUUID(), nickname: clean, avatar: validAvatar(avatar), ready: false, connected: true, joinedAt: Date.now(), disconnectedAt: null };
      player = { id: crypto.randomUUID(), nickname: clean, avatar: validAvatar(avatar), ready: false, connected: true, joinedAt: Date.now(), disconnectedAt: null, mentionNotifications: [] };
      room.players.set(player.id, player); room.scores.set(player.id, 0);
    } else { player.connected = true; player.disconnectedAt = null; }
    player.socketId=socket.id;
    if (player.id === room.hostId && room.hostDisconnectTimer) {
      clearTimeout(room.hostDisconnectTimer);
      room.hostDisconnectTimer = null;
      room.actingHostId = null;
    }
    socket.data.roomId = room.id; socket.data.playerId = player.id; socket.join(room.id);
    socket.data.roomId = room.id; socket.data.playerId = player.id; socket.join(room.id); socket.emit('confession:history', room.confessions); if(player.mentionNotifications?.length){for(const notification of player.mentionNotifications)socket.emit('confession:mentioned',notification);player.mentionNotifications=[];}
    ack({ ok: true, roomId: room.id, playerId: player.id, host: player.id === room.hostId || player.id === room.actingHostId }); emitState(room);
  });
  socket.on('player:ready', ({ ready } = {}) => { const room = getRoom(socket); const p = room?.players.get(socket.data.playerId); if (!p || room.status !== 'lobby') return; p.ready = Boolean(ready); emitState(room); });
  socket.on('prompt:mode',({gameId,mode}={})=>{const room=getRoom(socket);if(!isHost(room,socket)||!['lobby','playing'].includes(room.status)||room.round?.status==='active')return fail(socket,'The host can change prompt settings between rounds.');if(!room.customPrompts[gameId]||!['defaults','custom','mixed'].includes(mode))return fail(socket,'Choose a supported prompt game and source.');if(mode==='custom'&&!room.customPrompts[gameId].length)return fail(socket,'Add at least one custom prompt for this game first.');room.promptModes[gameId]=mode;if(mode!=='defaults')delete room.selectedBuiltInPrompts[gameId];emitState(room);socket.emit('app:notice',{message:`Prompt source updated to ${mode}.`});});
  socket.on('prompt:built-in:select',({gameId,prompt}={})=>{const room=getRoom(socket);if(!isHost(room,socket)||!['lobby','playing'].includes(room.status)||room.round?.status==='active')return fail(socket,'The host can choose prompts between rounds.');const pools={'most-likely':prompts,'unpopular-opinions':opinionPrompts,'expose-friends':exposePrompts};if(room.promptModes[gameId]!=='defaults'||!pools[gameId]?.includes(prompt))return fail(socket,'Choose a built-in prompt for the selected game.');room.selectedBuiltInPrompts[gameId]=prompt;emitState(room);});
  socket.on('prompt:add',({gameId,prompt}={},ack=()=>{})=>{const room=getRoom(socket),reject=message=>ack({ok:false,error:message});if(!isHost(room,socket)||!['lobby','playing'].includes(room.status)||room.round?.status==='active')return reject('The host can add prompts between rounds.');if(!room.customPrompts[gameId])return reject('Custom prompts are available for Who’s Most Likely?, Unpopular Opinions, and Expose Your Friends.');const clean=String(prompt||'').trim().replace(/\s+/g,' ').slice(0,180);if(clean.length<8)return reject('Write a prompt with at least 8 characters.');const list=room.customPrompts[gameId];if(list.length>=30)return reject('This room has reached its 30 custom prompt limit for this game.');if(list.some(item=>item.toLowerCase()===clean.toLowerCase()))return reject('That prompt has already been added.');list.push(clean);emitState(room);ack({ok:true,count:list.length});});
  socket.on('confession:submit',({text,mentions}={})=>{const room=getRoom(socket),p=room?.players.get(socket.data.playerId);if(!room||!p||!p.connected||room.status==='ended'||room.status==='host-paused')return fail(socket,'This room is paused or closed.');const clean=String(text||'').trim().replace(/https?:\/\/\S+/gi,'[link removed]').slice(0,240);if(clean.length<2)return fail(socket,'Write a short thought before sending.');if(room.confessions.length>=200)return fail(socket,'This room has reached its 200-message history limit.');const validMentions=(Array.isArray(mentions)?mentions:[]).slice(0,20).map(m=>{const player=room.players.get(String(m?.id||""));return player&&player.nickname===m?.nickname&&clean.includes(`@${player.nickname}`)?{id:player.id,nickname:player.nickname}:null;}).filter(Boolean);const post={id:crypto.randomUUID(),text:clean,mentions:validMentions,createdAt:Date.now(),reactions:{}};room.confessions.push(post);if(room.gameId==='confessions'&&room.round?.status==='active'&&room.round.eligible.includes(p.id)&&!room.round.playerAnswers.has(p.id)){room.round.playerAnswers.set(p.id,{type:'confession'});room.round.personal.set(p.id,{text:clean,reveal:false});}io.to(room.id).emit('confession:new',{id:post.id,text:post.text,mentions:post.mentions,createdAt:post.createdAt});emitState(room);});
  socket.on('confession:submit',({text,mentions}={})=>{const room=getRoom(socket),p=room?.players.get(socket.data.playerId);if(!room||!p||!p.connected||room.status==='ended'||room.status==='host-paused')return fail(socket,'This room is paused or closed.');const clean=String(text||'').trim().replace(/https?:\/\/\S+/gi,'[link removed]').slice(0,240);if(clean.length<2)return fail(socket,'Write a short thought before sending.');const validMentions=(Array.isArray(mentions)?mentions:[]).slice(0,20).map(m=>{const player=room.players.get(String(m?.id||""));return player&&player.nickname===m?.nickname&&clean.includes(`@${player.nickname}`)?{id:player.id,nickname:player.nickname}:null;}).filter(Boolean);const post={id:crypto.randomUUID(),text:clean,mentions:validMentions,createdAt:Date.now(),reactions:{}};room.confessions.push(post);for(const mention of new Map(validMentions.map(item=>[item.id,item])).values()){const tagged=room.players.get(mention.id);if(!tagged)continue;const notification={postId:post.id,nickname:mention.nickname};if(tagged.connected&&tagged.socketId)io.to(tagged.socketId).emit('confession:mentioned',notification);else{if(!Array.isArray(tagged.mentionNotifications))tagged.mentionNotifications=[];tagged.mentionNotifications.push(notification);}}if(room.gameId==='confessions'&&room.round?.status==='active'&&room.round.eligible.includes(p.id)&&!room.round.playerAnswers.has(p.id)){room.round.playerAnswers.set(p.id,{type:'confession'});room.round.personal.set(p.id,{text:clean,reveal:false});}io.to(room.id).emit('confession:new',{id:post.id,text:post.text,mentions:post.mentions,createdAt:post.createdAt});emitState(room);});
  socket.on('game:select', ({ gameId } = {}) => { const room = getRoom(socket); if (!isHost(room,socket) || !['lobby','playing'].includes(room.status) || (room.round?.status==='active') || !games.some(g=>g.id===gameId)) return fail(socket,'Only the host can select a game between rounds.'); room.gameId=gameId; room.gameVote=null; if(room.status==='playing')room.status='lobby'; emitState(room); });
  socket.on('game:vote:start', ({ options } = {}) => { const room=getRoom(socket); if(!isHost(room,socket)||!['lobby','playing'].includes(room.status)||room.round?.status==='active')return fail(socket,'Only the host can open a game vote between rounds.'); const list=[...new Set((options||[]).filter(id=>games.some(g=>g.id===id)) )].slice(0,5); if(list.length<2)return fail(socket,'Choose at least two games for the poll.'); room.gameVote={options:list,votes:new Map(),result:null}; emitState(room); });
  socket.on('game:vote', ({ gameId } = {}) => { const room=getRoom(socket); const p=room?.players.get(socket.data.playerId); if(!room?.gameVote||!p?.connected||!room.gameVote.options.includes(gameId)||room.gameVote.result)return fail(socket,'That game vote is closed.'); room.gameVote.votes.set(p.id,gameId); emitState(room); });
  socket.on('game:vote:resolve', ({ gameId } = {}) => { const room=getRoom(socket); if(!isHost(room,socket)||!room.gameVote)return fail(socket,'Only the host can resolve the poll.'); const counts=Object.fromEntries(room.gameVote.options.map(id=>[id,0])); for(const id of room.gameVote.votes.values())counts[id]++; const max=Math.max(...Object.values(counts)); const tied=Object.entries(counts).filter(([,n])=>n===max).map(([id])=>id); if(tied.length>1&&!tied.includes(gameId))return fail(socket,'Choose one of the tied games.'); room.gameId=tied.length===1?tied[0]:gameId; room.gameVote.result={counts,selected:room.gameId}; room.status='lobby'; room.round=null; emitState(room); });
  socket.on('game:start', () => { const room=getRoom(socket); if(!isHost(room,socket)||!['lobby','playing'].includes(room.status)||room.round?.status==='active')return fail(socket,'Only the host can start a game or round between rounds.'); if(room.players.size<2)return fail(socket,'At least two players must join before the game can start.'); if(!startRound(room))return fail(socket,'At least two players must be connected to start.'); });
  socket.on('round:end', () => { const room=getRoom(socket); if(!isHost(room,socket)||room.status!=='playing'||room.round?.status!=='active')return fail(socket,'Only the host can end the active round.'); closeRound(room); });
  socket.on('round:vote', ({ targetId } = {}) => { const room=getRoom(socket), p=room?.players.get(socket.data.playerId), round=room?.round; if(!p||!round||round.status!=='active')return fail(socket,'Voting is closed.'); if(!round.eligible.includes(p.id))return fail(socket,'You are not part of this round.'); if(round.playerAnswers.has(p.id))return fail(socket,'Your answer is already locked.'); if(targetId===p.id)return fail(socket,'You can’t vote for yourself.'); if(!round.eligible.includes(targetId))return fail(socket,'Choose a player who is in this round.'); round.playerAnswers.set(p.id,{type:'target',value:targetId}); emitState(room); });
  socket.on('round:skip',()=>{const room=getRoom(socket),p=room?.players.get(socket.data.playerId),r=room?.round;if(!p||room.status==='host-paused'||room.gameId!=='expose-friends'||!r||r.status!=='active'||r.playerAnswers.has(p.id))return fail(socket,'This round cannot be skipped now.');r.playerAnswers.set(p.id,{type:'skip'});emitState(room);});
  socket.on('game:answer', ({value}={})=>{const room=getRoom(socket),p=room?.players.get(socket.data.playerId),r=room?.round;if(!p||room.status==='host-paused'||!r||r.status!=='active'||r.playerAnswers.has(p.id))return fail(socket,'Your answer is already locked or this round is paused or closed.');const allowed=room.gameId==='unpopular-opinions'?['agree','disagree']:room.gameId==='smash-or-pass'?['smash','pass']:[];if(!allowed.includes(value))return fail(socket,'That answer is not valid for this game.');if(room.gameId==='smash-or-pass'&&p.id===r.photoOwner)return fail(socket,'You can’t vote on your own photo.');r.playerAnswers.set(p.id,{type:'choice',value});emitState(room);});
  socket.on('smash:vote',({photoId,value,reason}={})=>{const room=getRoom(socket),p=room?.players.get(socket.data.playerId),r=room?.round;if(!p||room.status==='host-paused'||room.gameId!=='smash-or-pass'||!r||r.status!=='active'||!r.eligible.includes(p.id))return fail(socket,'This photo round is closed or you are not in it.');const photo=r.photoDeck.find(item=>item.id===photoId);if(!photo||photo.ownerId===p.id)return fail(socket,'You cannot vote on your own photo.');if(!['smash','pass'].includes(value))return fail(socket,'Choose Smash or Pass.');let votes=r.photoVotes.get(p.id);if(!votes){votes=new Map();r.photoVotes.set(p.id,votes);}if(votes.has(photoId))return fail(socket,'You already voted on this photo.');const clean=String(reason||'').trim().replace(/https?:\/\/\S+/gi,'[link removed]').slice(0,160);votes.set(photoId,{value,reason:clean});emitState(room);});
  socket.on('game:confess',({text,reveal}={})=>{const room=getRoom(socket),p=room?.players.get(socket.data.playerId),r=room?.round;if(!p||room.status==='host-paused'||room.gameId!=='confessions'||!r||r.status!=='active'||r.playerAnswers.has(p.id))return fail(socket,'Confession round is paused, closed or you already submitted.');const clean=String(text||'').trim().replace(/https?:\/\/\S+/gi,'[link removed]').slice(0,240);if(!clean)return fail(socket,'Write a short confession first.');r.playerAnswers.set(p.id,{type:'confession'});r.personal.set(p.id,{text:clean,reveal:Boolean(reveal)});r.confession=clean;emitState(room);});
  socket.on('game:react',({emoji}={})=>{const room=getRoom(socket),p=room?.players.get(socket.data.playerId),r=room?.round;if(!p||!r||r.status!=='results'||!reactions.includes(emoji))return fail(socket,'That reaction is not available.');r.reactions.set(p.id,emoji);emitState(room);});
  socket.on('photo:consent',async({photo}={})=>{const room=getRoom(socket),p=room?.players.get(socket.data.playerId);if(!p||!photo||typeof photo!=='string'||photo.length>700000||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo))return fail(socket,'Use a valid image under 512 KB.');if(!supabase)return fail(socket,'Photo storage is not configured. Add the Supabase URL and service-role key to the server .env, then restart it.');try{const [,meta,data]=photo.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);const buffer=Buffer.from(data,'base64');if(buffer.length>512*1024)return fail(socket,'The compressed image must be under 512 KB.');const ext=meta==='jpeg'?'jpg':meta;const objectPath=`${room.id}/${p.id}/${crypto.randomUUID()}.${ext}`;const {error}=await supabase.storage.from(PHOTO_BUCKET).upload(objectPath,buffer,{contentType:`image/${meta}`,upsert:false});if(error)throw error;const {data:signed,error:signError}=await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(objectPath,Math.floor(ROOM_TTL/1000));if(signError)throw signError;if(supabase&&p.photoPath)await supabase.storage.from(PHOTO_BUCKET).remove([p.photoPath]);p.photo=signed.signedUrl;p.photoPath=objectPath;p.photoConsent=true;const round=room.round;if(room.gameId==='smash-or-pass'&&round?.status==='active'&&round.eligible.includes(p.id)){const existing=round.photoDeck.find(item=>item.ownerId===p.id);const card={id:p.id,ownerId:p.id,nickname:p.nickname,photo:p.photo};if(existing)Object.assign(existing,card);else round.photoDeck.push(card);}emitState(room);}catch(error){console.error('Photo upload failed:',error.message);fail(socket,'Photo upload failed. Check the private storage bucket and try again.');}});
  socket.on('photo:remove',async()=>{const room=getRoom(socket),p=room?.players.get(socket.data.playerId);if(!p)return;if(supabase&&p.photoPath){const {error}=await supabase.storage.from(PHOTO_BUCKET).remove([p.photoPath]);if(error)console.error('Photo removal failed:',error.message);}p.photo=null;p.photoPath=null;p.photoConsent=false;if(room.round?.status==='active'&&room.round.photoDeck){room.round.photoDeck=room.round.photoDeck.filter(item=>item.ownerId!==p.id);}emitState(room);});
  socket.on('photo:report',({photoId}={})=>{const room=getRoom(socket),p=room?.players.get(socket.data.playerId),r=room?.round;if(!p||!r||r.status!=='active')return;const card=r.photoDeck.find(item=>item.id===photoId);if(!card)return;let reports=r.reportsByPhoto?.get(photoId);if(!reports){if(!r.reportsByPhoto)r.reportsByPhoto=new Map();reports=new Set();r.reportsByPhoto.set(photoId,reports);}reports.add(p.id);if(reports.size>=2){const owner=room.players.get(card.ownerId);if(owner){owner.photo=null;owner.photoConsent=false;}r.photoDeck=r.photoDeck.filter(item=>item.id!==photoId);}emitState(room);});
  socket.on('round:next', () => { const room=getRoom(socket); if(!isHost(room,socket)||room.status!=='playing'||room.round?.status!=='results')return fail(socket,'The host can start the next round after results.'); if(!startRound(room))return fail(socket,'At least two players must be connected.'); });
  socket.on('round:restart', () => { const room=getRoom(socket); if(!isHost(room,socket)||room.status!=='playing')return fail(socket,'Only the host can restart a round.'); room.roundNumber--; if(!startRound(room))return fail(socket,'At least two players must be connected.'); });
  socket.on('session:end', () => { const room=getRoom(socket); if(!isHost(room,socket))return fail(socket,'Only the host can end this session.'); clearRoundTimer(room); room.status='ended'; io.to(room.id).emit('room:ended'); rooms.delete(room.id); });
  socket.on('disconnect', () => { const room=getRoom(socket); const p=room?.players.get(socket.data.playerId); if(!room||!p)return; if(p.socketId!==socket.id)return;p.socketId=null;p.connected=false; p.disconnectedAt=Date.now(); if(p.id===room.hostId||p.id===room.actingHostId){if(p.id===room.hostId){room.actingHostId=[...room.players.values()].find(player=>player.connected&&player.id!==p.id)?.id||null;room.hostDisconnectTimer=setTimeout(()=>{const current=rooms.get(room.id);const hostPlayer=current?.players.get(current.hostId);if(current===room&&!hostPlayer?.connected){current.status='ended';io.to(room.id).emit('room:ended',{reason:'host-timeout'});rooms.delete(room.id);}},HOST_RECONNECT_GRACE_MS);room.hostDisconnectTimer.unref?.();}else{room.actingHostId=[...room.players.values()].find(player=>player.connected&&player.id!==p.id&&player.id!==room.hostId)?.id||null;} } emitState(room); });
});
function validAvatar(value) { if(typeof value!=='string')return ''; if(value.length<=120000&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value))return value; return ['😎','🧢','😈','🌼','🐸','🦋','🧋','🪩','🐻','🍒','🦊','🌈'].includes(value)?value:''; }
setInterval(()=>{ const now=Date.now(); for(const [id,room] of rooms){ for(const [pid,p] of room.players){ if(!p.connected&&p.disconnectedAt&&now-p.disconnectedAt>ROOM_TTL)room.players.delete(pid); } if(room.expiresAt<now){clearRoundTimer(room);io.to(id).emit('room:ended');rooms.delete(id);} } },60_000).unref();
server.listen(PORT, () => console.log(`Anonymous Party listening on http://localhost:${PORT}`));
