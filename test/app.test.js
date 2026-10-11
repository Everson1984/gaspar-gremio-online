process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.VOTER_CODE_SECRET = 'test-voter-code-secret';

const request = require('supertest');
const { app, db } = require('../server');

function csrfToken(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error('CSRF token not found in page');
  return match[1];
}

beforeEach(() => {
  db.prepare('DELETE FROM voter_codes').run();
  db.prepare('DELETE FROM candidates').run();
  db.prepare("UPDATE election_settings SET status = 'setup' WHERE id = 1").run();
});

afterAll(() => db.close());

test('admin can prepare an election and each code casts only one anonymous vote', async () => {
  const admin = request.agent(app);
  let response = await admin.get('/admin');
  expect(response.status).toBe(302);
  expect(response.headers.location).toBe('/admin/login');

  response = await admin.get('/admin/login');
  const loginToken = csrfToken(response.text);
  response = await admin.post('/admin/login').type('form').send({
    _csrf: loginToken,
    password: 'test-admin-password'
  });
  expect(response.status).toBe(302);
  expect(response.headers.location).toBe('/admin');

  response = await admin.get('/admin');
  const setupToken = csrfToken(response.text);
  response = await admin.post('/admin/candidates').type('form').send({
    _csrf: setupToken,
    name: 'Chapa Estudantil',
    group_name: 'Turma 3A',
    proposal: 'Mais atividades culturais'
  });
  expect(response.status).toBe(302);

  await admin.post('/admin/codes').type('form').send({ _csrf: setupToken, count: 1 }).expect(302);
  response = await admin.get('/admin');
  const codeMatch = response.text.match(/id="new-voter-codes"[^>]*>([^<]+)<\/textarea>/);
  expect(codeMatch).not.toBeNull();
  const code = codeMatch[1].trim();

  await admin.post('/admin/election').type('form').send({
    _csrf: csrfToken(response.text),
    action: 'open'
  }).expect(302);

  const voter = request.agent(app);
  response = await voter.get('/');
  const voteToken = csrfToken(response.text);
  await voter.post('/vote').type('form').send({
    _csrf: voteToken,
    candidate_id: 1,
    code
  }).expect(302);

  response = await voter.post('/vote').type('form').send({
    _csrf: voteToken,
    candidate_id: 1,
    code
  });
  expect(response.status).toBe(400);
  expect(response.text).toContain('Código inválido ou já utilizado.');

  expect(db.prepare('SELECT vote_count FROM candidates WHERE id = 1').get().vote_count).toBe(1);
  expect(db.prepare('SELECT used FROM voter_codes').get().used).toBe(1);
  expect(db.prepare('SELECT code_hash FROM voter_codes').get().code_hash).not.toBe(code);
});

test('a post without a valid CSRF token is rejected', async () => {
  const response = await request(app).post('/vote').type('form').send({
    candidate_id: 1,
    code: 'A'.repeat(32)
  });
  expect(response.status).toBe(403);
});
