require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const session = require('express-session');

const app = express();
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'voting.sqlite');
const sessionSecret = process.env.SESSION_SECRET || 'development-only-change-this-secret';
const voterCodeSecret = process.env.VOTER_CODE_SECRET || sessionSecret;
const adminPasswordHash = process.env.ADMIN_PASSWORD
  ? bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10)
  : null;

if (process.env.NODE_ENV === 'production') {
  for (const [name, value] of Object.entries({
    SESSION_SECRET: process.env.SESSION_SECRET,
    VOTER_CODE_SECRET: process.env.VOTER_CODE_SECRET,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD
  })) {
    if (!value) throw new Error(`${name} must be configured in production`);
  }
}

if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
const db = new Database(databasePath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS election_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL CHECK (status IN ('setup', 'open', 'closed'))
  );
  INSERT OR IGNORE INTO election_settings (id, status) VALUES (1, 'setup');

  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    group_name TEXT NOT NULL DEFAULT '',
    proposal TEXT NOT NULL DEFAULT '',
    vote_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS voter_codes (
    code_hash TEXT PRIMARY KEY,
    used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
  ) WITHOUT ROWID;
`);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(helmet());
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  name: 'gaspar-vote',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (req.method === 'POST') {
    const submitted = req.body._csrf;
    const expected = req.session.csrfToken;
    if (typeof submitted !== 'string' || submitted.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))) {
      return res.status(403).send('Sessão expirada. Atualize a página e tente novamente.');
    }
  }
  next();
});

function getElection() {
  return db.prepare('SELECT status FROM election_settings WHERE id = 1').get();
}

function getCandidates() {
  return db.prepare('SELECT id, name, group_name, proposal, vote_count FROM candidates ORDER BY name').all();
}

function hashCode(code) {
  return crypto.createHmac('sha256', voterCodeSecret).update(code).digest('hex');
}

function pageMessage(req) {
  return req.query.message || null;
}

app.get('/', (req, res) => {
  const election = getElection();
  res.render('index', {
    election,
    candidates: getCandidates(),
    message: pageMessage(req)
  });
});

app.post('/vote', (req, res) => {
  const candidateId = Number.parseInt(req.body.candidate_id, 10);
  const code = typeof req.body.code === 'string'
    ? req.body.code.replace(/[^a-f0-9]/gi, '').toUpperCase()
    : '';

  if (!Number.isInteger(candidateId) || !code || code.length !== 32) {
    return res.status(400).render('index', {
      election: getElection(),
      candidates: getCandidates(),
      message: 'Confira o código e a opção escolhida.'
    });
  }

  const castVote = db.transaction(() => {
    if (getElection().status !== 'open') return 'closed';
    const candidate = db.prepare('SELECT id FROM candidates WHERE id = ?').get(candidateId);
    if (!candidate) return 'invalid_candidate';

    const voterCode = db.prepare('SELECT used FROM voter_codes WHERE code_hash = ?').get(hashCode(code));
    if (!voterCode || voterCode.used) return 'invalid_code';

    db.prepare('UPDATE voter_codes SET used = 1 WHERE code_hash = ?').run(hashCode(code));
    db.prepare('UPDATE candidates SET vote_count = vote_count + 1 WHERE id = ?').run(candidateId);
    return 'success';
  });

  const result = castVote();
  if (result !== 'success') {
    const messages = {
      closed: 'A votação não está aberta no momento.',
      invalid_candidate: 'A opção escolhida não está disponível.',
      invalid_code: 'Código inválido ou já utilizado.'
    };
    return res.status(400).render('index', {
      election: getElection(),
      candidates: getCandidates(),
      message: messages[result]
    });
  }

  res.redirect('/?message=' + encodeURIComponent('Voto registrado. Obrigado por participar!'));
});

app.get('/admin/login', (req, res) => {
  res.render('login', { message: pageMessage(req) });
});

app.post('/admin/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false
}), (req, res, next) => {
  if (!adminPasswordHash) {
    return res.status(503).render('login', {
      message: 'A senha administrativa ainda não foi configurada no servidor.'
    });
  }

  if (typeof req.body.password !== 'string' || !bcrypt.compareSync(req.body.password, adminPasswordHash)) {
    return res.status(401).render('login', { message: 'Senha incorreta.' });
  }

  req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.isAdmin = true;
    req.session.save((saveError) => {
      if (saveError) return next(saveError);
      res.redirect('/admin');
    });
  });
});

app.use('/admin', (req, res, next) => {
  if (!req.session.isAdmin) return res.redirect('/admin/login');
  next();
});

app.get('/admin', (req, res) => {
  const election = getElection();
  const codeStats = db.prepare(`
    SELECT COUNT(*) AS total, SUM(used) AS used FROM voter_codes
  `).get();
  const newCodes = req.session.newCodes || [];
  delete req.session.newCodes;
  res.render('admin', {
    election,
    candidates: getCandidates(),
    codeStats: { total: codeStats.total, used: codeStats.used || 0 },
    newCodes,
    message: pageMessage(req)
  });
});

app.post('/admin/candidates', (req, res) => {
  if (getElection().status !== 'setup') {
    return res.redirect('/admin?message=' + encodeURIComponent('As opções só podem ser alteradas antes da votação.'));
  }
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const groupName = typeof req.body.group_name === 'string' ? req.body.group_name.trim() : '';
  const proposal = typeof req.body.proposal === 'string' ? req.body.proposal.trim() : '';
  if (!name || name.length > 80 || groupName.length > 80 || proposal.length > 500) {
    return res.redirect('/admin?message=' + encodeURIComponent('Confira os campos da candidatura.'));
  }
  db.prepare('INSERT INTO candidates (name, group_name, proposal) VALUES (?, ?, ?)')
    .run(name, groupName, proposal);
  res.redirect('/admin?message=' + encodeURIComponent('Opção adicionada.'));
});

app.post('/admin/codes', (req, res, next) => {
  if (getElection().status !== 'setup') {
    return res.redirect('/admin?message=' + encodeURIComponent('Novos códigos só podem ser criados antes da votação.'));
  }
  const count = Number.parseInt(req.body.count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    return res.redirect('/admin?message=' + encodeURIComponent('Gere entre 1 e 500 códigos por vez.'));
  }

  const codes = [];
  const insertCode = db.prepare('INSERT INTO voter_codes (code_hash) VALUES (?)');
  const createCodes = db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const code = crypto.randomBytes(16).toString('hex').toUpperCase();
      insertCode.run(hashCode(code));
      codes.push(code);
    }
  });

  try {
    createCodes();
  } catch (error) {
    return next(error);
  }
  req.session.newCodes = codes;
  req.session.save((error) => {
    if (error) return next(error);
    res.redirect('/admin');
  });
});

app.post('/admin/election', (req, res) => {
  const currentStatus = getElection().status;
  if (req.body.action === 'open' && currentStatus === 'setup') {
    const candidateCount = db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count;
    const availableCodeCount = db.prepare('SELECT COUNT(*) AS count FROM voter_codes WHERE used = 0').get().count;
    if (!candidateCount || !availableCodeCount) {
      return res.redirect('/admin?message=' + encodeURIComponent('Adicione candidaturas e gere códigos antes de abrir a votação.'));
    }
    db.prepare("UPDATE election_settings SET status = 'open' WHERE id = 1").run();
    return res.redirect('/admin?message=' + encodeURIComponent('Votação aberta.'));
  }
  if (req.body.action === 'close' && currentStatus === 'open') {
    db.prepare("UPDATE election_settings SET status = 'closed' WHERE id = 1").run();
    return res.redirect('/admin?message=' + encodeURIComponent('Votação encerrada. Resultado disponível abaixo.'));
  }
  res.redirect('/admin?message=' + encodeURIComponent('Ação indisponível para o estado atual.'));
});

app.post('/admin/logout', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('gaspar-vote');
    res.redirect('/');
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).send('Ocorreu um erro interno. Tente novamente mais tarde.');
});

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT, 10) || 3000;
  app.listen(port, () => console.log(`Aplicativo de votação disponível em http://localhost:${port}`));
}

module.exports = { app, db };
