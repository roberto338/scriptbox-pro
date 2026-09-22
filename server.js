const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');

console.error('[DEBUG] Starting server...');
dotenv.config();
console.error('[DEBUG] Config loaded');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// POST /api/waitlist
app.post('/api/waitlist', async (req, res) => {
  const { name, email, plan } = req.body;

  if (!name || !email || !plan) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    // Store in Neon
    const query = 'INSERT INTO presales (name, email, plan) VALUES ($1, $2, $3) RETURNING id';
    const result = await pool.query(query, [name, email, plan]);

    // Send to Brevo
    try {
      await axios.post('https://api.brevo.com/v3/contacts', {
        email,
        attributes: { NAME: name, PLAN: plan },
        listIds: [parseInt(process.env.BREVO_LIST_ID || 2)],
        updateEnabled: true
      }, {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        }
      });
    } catch (brevoError) {
      console.error('Brevo error:', brevoError.message);
      // Continue anyway - DB insert succeeded
    }

    res.status(201).json({ id: result.rows[0].id, message: 'Added to waitlist' });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/presales (for testing)
app.get('/api/presales', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM presales ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ScriptBox Pro listening on port ${PORT}`);
});
