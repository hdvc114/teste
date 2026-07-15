const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const OpenAI = require('openai');
require('dotenv/config');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const openai = new OpenAI({
  apiKey: 'ollama',
  baseURL: 'http://localhost:11434/v1',
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/chat', (req, res) => {
  const sessionId = uuidv4();
  res.redirect(`/chat/${sessionId}`);
});

app.get('/chat/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  let conversation = await pool.query(
    'SELECT * FROM conversations WHERE session_id = $1',
    [sessionId]
  );
  if (conversation.rows.length === 0) {
    conversation = await pool.query(
      'INSERT INTO conversations (session_id, messages) VALUES ($1, \'[]\'::jsonb) RETURNING *',
      [sessionId]
    );
  }
  res.render('chat', {
    sessionId,
    messages: conversation.rows[0].messages,
  });
});

app.post('/chat/:sessionId/message', async (req, res) => {
  const { sessionId } = req.params;
  const { message } = req.body;

  let conv = await pool.query(
    'SELECT * FROM conversations WHERE session_id = $1',
    [sessionId]
  );

  if (conv.rows.length === 0) {
    conv = await pool.query(
      'INSERT INTO conversations (session_id, messages) VALUES ($1, \'[]\'::jsonb) RETURNING *',
      [sessionId]
    );
  }

  const storedMessages = conv.rows[0].messages || [];
  const apiMessages = storedMessages.map(m => ({
    role: m.role === 'ai' ? 'assistant' : m.role,
    content: m.content,
  }));
  apiMessages.push({ role: 'user', content: message });

  const completion = await openai.chat.completions.create({
    model: 'llama3.2:3b',
    messages: [
      {
        role: 'system',
        content: 'Você é um assistente amigável de uma plataforma chamada Projects, onde pessoas compartilham ideias e projetos. Ajude o usuário a refinar sua ideia e incentive-o a enviar o projeto quando estiver pronto. Responda em português de forma natural e conversacional.',
      },
      ...apiMessages,
    ],
  });

  const aiResponse = completion.choices[0].message.content;

  storedMessages.push({ role: 'user', content: message, timestamp: new Date() });
  storedMessages.push({ role: 'ai', content: aiResponse, timestamp: new Date() });

  await pool.query(
    'UPDATE conversations SET messages = $1, updated_at = NOW() WHERE session_id = $2',
    [JSON.stringify(storedMessages), sessionId]
  );

  res.json({ messages: storedMessages });
});

app.post('/chat/:sessionId/project', async (req, res) => {
  const { sessionId } = req.params;
  const { title, description, creator_name, creator_email } = req.body;

  let conv = await pool.query(
    'SELECT id FROM conversations WHERE session_id = $1',
    [sessionId]
  );

  if (conv.rows.length === 0) {
    conv = await pool.query(
      'INSERT INTO conversations (session_id, messages) VALUES ($1, \'[]\'::jsonb) RETURNING *',
      [sessionId]
    );
  }

  const project = await pool.query(
    `INSERT INTO projects (title, description, creator_name, creator_email, conversation_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [title, description, creator_name, creator_email, conv.rows[0].id]
  );

  const messages = conv.rows[0].messages || [];
  messages.push({
    role: 'system',
    content: `Projeto enviado: ${title}`,
    timestamp: new Date(),
  });

  await pool.query(
    'UPDATE conversations SET messages = $1, updated_at = NOW() WHERE session_id = $2',
    [JSON.stringify(messages), sessionId]
  );

  res.json({ success: true, project: project.rows[0] });
});

app.get('/marketing', async (req, res) => {
  const projects = await pool.query(
    `SELECT p.*, c.messages as conversation_messages
     FROM projects p
     LEFT JOIN conversations c ON c.id = p.conversation_id
     ORDER BY p.created_at DESC`
  );

  const responses = await pool.query(
    'SELECT * FROM responses ORDER BY created_at DESC'
  );

  const responsesByProject = {};
  responses.rows.forEach(r => {
    if (!responsesByProject[r.project_id]) responsesByProject[r.project_id] = [];
    responsesByProject[r.project_id].push(r);
  });

  res.render('marketing', {
    projects: projects.rows,
    responsesByProject,
  });
});

app.post('/marketing/respond/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const { message } = req.body;

  await pool.query(
    'INSERT INTO responses (project_id, message) VALUES ($1, $2)',
    [projectId, message]
  );

  res.redirect('/marketing');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
