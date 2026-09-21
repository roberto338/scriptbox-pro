import express from 'express';
import pg from 'pg';
import dotenv from 'dotenv';
import cors from 'cors';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// Database connection
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize database
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS presales (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        plan VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        confirmed BOOLEAN DEFAULT FALSE
      );
    `);
    console.log('✅ Database initialized');
  } catch (error) {
    console.error('❌ Database init error:', error.message);
  }
}

initDatabase();

// API Routes
app.post('/api/waitlist', async (req, res) => {
  const { name, email, plan } = req.body;

  if (!name || !email || !plan) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Insert into database
    const result = await pool.query(
      'INSERT INTO presales (name, email, plan) VALUES ($1, $2, $3) RETURNING id',
      [name, email, plan]
    );

    // Send to Brevo
    if (process.env.BREVO_API_KEY && process.env.BREVO_LIST_ID) {
      try {
        await axios.post(
          'https://api.brevo.com/v3/contacts',
          {
            email: email,
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
        console.log(`✅ Email ${email} added to Brevo`);
      } catch (brevoError) {
        console.error('⚠️ Brevo error:', brevoError.message);
        // Continue even if Brevo fails
      }
    }

    res.status(201).json({
      success: true,
      id: result.rows[0].id,
      message: 'Welcome to the waitlist!'
    });
  } catch (error) {
    console.error('❌ API error:', error.message);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Start server
app.listen(port, () => {
  console.log(`🚀 ScriptBox Pro running on port ${port}`);
});
