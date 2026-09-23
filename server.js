const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

dotenv.config();

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const PLANS = {
  '29': { name: 'ScriptBox Pro Starter', amount: 2900 },
  '79': { name: 'ScriptBox Pro Pro', amount: 7900 }
};

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// En-têtes de sécurité HTTP (équivalent helmet, sans dépendance)
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'"
  ].join('; '));
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(cors());

// Accès admin : en-tête "x-admin-token" ou "Authorization: Bearer <token>" = ADMIN_TOKEN
function isAdmin(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const auth = req.get('authorization') || '';
  const given = req.get('x-admin-token') || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Non autorisé' });
}

// PostgreSQL Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Schéma auto-réparé au démarrage (idempotent)
async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS presales (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    plan VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`ALTER TABLE presales
    ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP`);
  console.log('DB schema OK');
}

async function markPaid(session) {
  await pool.query(
    `UPDATE presales SET paid = true, paid_at = NOW(),
       stripe_customer_id = $1, stripe_subscription_id = $2
     WHERE email = $3`,
    [session.customer || null, session.subscription || null,
     session.metadata && session.metadata.email || session.customer_email]
  );
}

// Webhook Stripe : doit recevoir le corps brut, donc AVANT express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Webhook not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send('Bad signature');
  }
  try {
    if (event.type === 'checkout.session.completed') {
      await markPaid(event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      await pool.query('UPDATE presales SET paid = false WHERE stripe_subscription_id = $1', [event.data.object.id]);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Handler error');
  }
});

app.use(express.json());

// SEO : robots.txt et sitemap.xml (URL de base = PUBLIC_URL ou hôte de la requête)
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /success.html\n\nSitemap: ${baseUrl(req)}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <url><loc>${baseUrl(req)}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n` +
    `</urlset>\n`
  );
});

app.use(express.static('public'));

function baseUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

// POST /api/waitlist : enregistre le lead puis ouvre Stripe Checkout
app.post('/api/waitlist', async (req, res) => {
  const { name, email, plan } = req.body;

  if (!name || !email || !plan) {
    return res.status(400).json({ error: 'Champs manquants' });
  }
  if (!PLANS[plan]) {
    return res.status(400).json({ error: 'Plan invalide' });
  }

  let id;
  try {
    // Upsert : un email déjà inscrit ne provoque plus d'erreur 500
    const result = await pool.query(
      `INSERT INTO presales (name, email, plan) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan
       RETURNING id, paid`,
      [name, email, plan]
    );
    id = result.rows[0].id;
    if (result.rows[0].paid) {
      return res.status(200).json({ id, message: 'Déjà abonné', alreadyPaid: true });
    }
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({ error: 'Database error' });
  }

  // Brevo (non bloquant)
  axios.post('https://api.brevo.com/v3/contacts', {
    email,
    attributes: { NAME: name, PLAN: plan },
    listIds: [parseInt(process.env.BREVO_LIST_ID || '2', 10)],
    updateEnabled: true
  }, {
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' }
  }).catch(e => console.error('Brevo error:', e.response ? JSON.stringify(e.response.data) : e.message));

  if (!stripe) {
    return res.status(201).json({ id, message: 'Ajouté à la waitlist (paiement indisponible)' });
  }

  try {
    const p = PLANS[plan];
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: p.amount,
          recurring: { interval: 'month' },
          product_data: { name: p.name }
        }
      }],
      metadata: { email, plan, presale_id: String(id) },
      success_url: `${baseUrl(req)}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl(req)}/?canceled=1`
    });
    res.status(201).json({ id, url: session.url });
  } catch (error) {
    console.error('Stripe error:', error.message);
    res.status(201).json({ id, message: 'Ajouté à la waitlist (paiement momentanément indisponible)' });
  }
});

// Vérification au retour de Stripe (filet de sécurité si le webhook tarde)
app.get('/api/checkout/verify', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe non configuré' });
  try {
    const session = await stripe.checkout.sessions.retrieve(String(req.query.session_id || ''));
    const paid = session.payment_status === 'paid' || session.status === 'complete';
    if (paid) await markPaid(session);
    res.json({ paid, email: session.customer_email, plan: session.metadata && session.metadata.plan });
  } catch (error) {
    console.error('Verify error:', error.message);
    res.status(400).json({ error: 'Session invalide' });
  }
});

// GET /api/health : public = {"ok":true} uniquement ; détail Stripe/webhook réservé à l'admin
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    if (isAdmin(req)) {
      return res.json({ ok: true, stripe: !!stripe, webhook: !!process.env.STRIPE_WEBHOOK_SECRET });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// GET /api/presales : liste des inscrits, réservée à l'admin (données personnelles)
app.get('/api/presales', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, plan, paid, created_at FROM presales ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

const PORT = process.env.PORT || 3000;
migrate()
  .catch(e => console.error('Migration error:', e.message))
  .finally(() => {
    app.listen(PORT, () => console.log(`ScriptBox Pro listening on port ${PORT}`));
  });
