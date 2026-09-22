const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Initialize presales table
pool.query(`
  CREATE TABLE IF NOT EXISTS presales (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    plan VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.error('Table creation error:', err));

// Waitlist endpoint
app.post('/api/waitlist', async (req, res) => {
  const { name, email, plan } = req.body;

  if (!name || !email || !plan) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Save to Neon
    const result = await pool.query(
      'INSERT INTO presales (name, email, plan) VALUES ($1, $2, $3) RETURNING id',
      [name, email, plan]
    );

    // Send to Brevo
    await axios.post('https://api.brevo.com/v3/contacts/doubleOptinConfirmation', 
      {
        email,
        attributes: { FIRSTNAME: name, PLAN: plan },
        listIds: [parseInt(process.env.BREVO_LIST_ID)]
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`ScriptBox Pro running on port ${PORT}`);
});
