# ScriptBox Pro MVP

Plateforme de génération de scripts IA en un clic.

## Installation locale

```bash
npm install
cp .env.example .env
# Éditez .env avec vos variables
npm start
```

L'app tourne sur `http://localhost:5000`

## Déploiement Render

1. Connecter GitHub à Render
2. Créer un Web Service pointant sur ce repo
3. Ajouter les variables d'env Render
4. Render déploie automatiquement

## Stack

- Node.js + Express
- React (frontend)
- PostgreSQL (Neon)
- Brevo (email)
