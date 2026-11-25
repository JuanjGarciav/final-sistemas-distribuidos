'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const os = require('os');
const { Pool } = require('pg');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_STRESS_MB = parseInt(process.env.MAX_STRESS_MB || '110', 10);
const MAX_RSS_GUARD_MB = parseInt(process.env.MAX_RSS_GUARD_MB || '185', 10);

// PostgreSQL connection pool using environment variables injected by Kubernetes
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'appuser',
  password: process.env.DB_PASSWORD || 'apppassword',
  database: process.env.DB_NAME || 'inventorydb',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Prevent unhandled pool errors from crashing Node.js when PostgreSQL restarts
pool.on('error', (err) => {
  console.error('[DB] Unexpected idle client error (will recover automatically):', err.message);
});

let dbReady = false;
let initRetryTimer = null;

// Track allocated buffers for the /stress-memory endpoint
const stressAllocations = [];
let totalAllocatedStressMB = 0;

const TRANSIENT_PG_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMemoryStatsMB() {
  const mem = process.memoryUsage();
  return {
    rss: Number((mem.rss / (1024 * 1024)).toFixed(2)),
    heapTotal: Number((mem.heapTotal / (1024 * 1024)).toFixed(2)),
    heapUsed: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
    external: Number((mem.external / (1024 * 1024)).toFixed(2)),
  };
}

async function ensureSchema() {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      category VARCHAR(80) NOT NULL,
      price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await pool.query(createTableSQL);
}

async function initDatabaseWithRetry(attempt = 1) {
  try {
    await pool.query('SELECT 1');
    await ensureSchema();
    dbReady = true;
    console.log(`[DB] Connected to PostgreSQL (${process.env.DB_HOST || 'localhost'}) and verified schema.`);
  } catch (err) {
    dbReady = false;
    const delayMs = Math.min(2000 * attempt, 10000);
    console.error(`[DB] Connection attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`);
    initRetryTimer = setTimeout(() => {
      initDatabaseWithRetry(attempt + 1);
    }, delayMs);
  }
}

async function queryWithRetry(sql, params = [], maxAttempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await pool.query(sql, params);
      if (!dbReady) {
        await ensureSchema();
        dbReady = true;
      }
      return result;
    } catch (err) {
      lastError = err;
      const isTransient =
        TRANSIENT_PG_CODES.has(err.code) ||
        /Connection terminated|ECONNREFUSED|timeout/i.test(err.message);

      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }

      dbReady = false;
      const backoffMs = 500 * attempt;
      console.warn(`[DB] Transient query error (attempt ${attempt}/${maxAttempts}): ${err.message}. Retrying in ${backoffMs}ms...`);
      await sleep(backoffMs);
    }
  }
  throw lastError;
}

function validateProductPayload(body) {
  const errors = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const price = Number(body.price);
  const stock = Number(body.stock);

  if (name.length < 2 || name.length > 120) {
    errors.push('El nombre debe tener entre 2 y 120 caracteres.');
  }
  if (category.length < 2 || category.length > 80) {
    errors.push('La categoria debe tener entre 2 y 80 caracteres.');
  }
  if (!Number.isFinite(price) || price < 0) {
    errors.push('El precio debe ser un numero mayor o igual a 0.');
  }
  if (!Number.isInteger(stock) || stock < 0) {
    errors.push('El stock debe ser un numero entero mayor o igual a 0.');
  }

  return {
    valid: errors.length === 0,
    errors,
    data: { name, category, price: Number(price.toFixed(2)), stock, description },
  };
}

function parsePositiveId(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  return id;
}

function releaseAllStressBuffers() {
  let releasedMB = 0;
  while (stressAllocations.length > 0) {
    const item = stressAllocations.pop();
    clearTimeout(item.timer);
    releasedMB += item.mb;
  }
  totalAllocatedStressMB = 0;
  return releasedMB;
}

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader('X-Pod-Name', os.hostname());
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Liveness probe: verifies Express event loop is responsive
app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'ok',
    pod: os.hostname(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// Readiness probe: verifies PostgreSQL connectivity
app.get('/readyz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    if (!dbReady) {
      await ensureSchema();
      dbReady = true;
    }
    res.status(200).json({
      status: 'ready',
      database: 'connected',
      pod: os.hostname(),
    });
  } catch (err) {
    dbReady = false;
    res.status(503).json({
      status: 'not_ready',
      database: 'disconnected',
      pod: os.hostname(),
      error: err.message,
    });
  }
});

// Runtime metadata for UI banner and live verification
app.get('/api/info', async (req, res) => {
  let databaseStatus = 'connected';
  try {
    await pool.query('SELECT 1');
    dbReady = true;
  } catch (_err) {
    databaseStatus = 'reconnecting';
    dbReady = false;
  }

  res.status(200).json({
    pod: os.hostname(),
    databaseStatus,
    allocatedStressMB: totalAllocatedStressMB,
    memoryUsageMB: getMemoryStatsMB(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// Controlled memory stress endpoint to trigger memory-based HPA without OOMKill
app.get('/stress-memory', (req, res) => {
  if (req.query.release === 'true') {
    const releasedMB = releaseAllStressBuffers();
    return res.status(200).json({
      status: 'released',
      pod: os.hostname(),
      releasedMB,
      totalStressMB: totalAllocatedStressMB,
      memoryUsageMB: getMemoryStatsMB(),
    });
  }

  const requestedMB = Math.min(Math.max(parseInt(req.query.mb || '25', 10) || 25, 1), 64);
  const ttlSeconds = Math.min(Math.max(parseInt(req.query.ttl || '90', 10) || 90, 5), 300);

  const currentMemory = getMemoryStatsMB();
  const remainingByCap = Math.max(0, MAX_STRESS_MB - totalAllocatedStressMB);
  const remainingByRssGuard = Math.max(0, Math.floor(MAX_RSS_GUARD_MB - currentMemory.rss));
  const actualMB = Math.min(requestedMB, remainingByCap, remainingByRssGuard);

  if (actualMB > 0) {
    // Fill buffer with non-zero bytes so the OS commits physical RAM pages immediately
    const buffer = Buffer.alloc(actualMB * 1024 * 1024, 0x41);
    const entry = { mb: actualMB, buffer, timer: null };

    entry.timer = setTimeout(() => {
      const idx = stressAllocations.indexOf(entry);
      if (idx !== -1) {
        stressAllocations.splice(idx, 1);
        totalAllocatedStressMB = Math.max(0, totalAllocatedStressMB - entry.mb);
      }
    }, ttlSeconds * 1000);

    stressAllocations.push(entry);
    totalAllocatedStressMB += actualMB;
  }

  return res.status(200).json({
    status: actualMB > 0 ? 'allocated' : 'capped_safe_limit',
    pod: os.hostname(),
    requestedMB,
    allocatedNowMB: actualMB,
    totalStressMB: totalAllocatedStressMB,
    ttlSeconds,
    memoryUsageMB: getMemoryStatsMB(),
  });
});

app.delete('/stress-memory', (req, res) => {
  const releasedMB = releaseAllStressBuffers();
  res.status(200).json({
    status: 'released',
    pod: os.hostname(),
    releasedMB,
    totalStressMB: totalAllocatedStressMB,
    memoryUsageMB: getMemoryStatsMB(),
  });
});

// CRUD API: Products
app.get('/api/products', async (req, res) => {
  try {
    const result = await queryWithRetry(
      'SELECT id, name, category, price, stock, description, created_at, updated_at FROM products ORDER BY id DESC'
    );
    res.status(200).json({
      pod: os.hostname(),
      count: result.rows.length,
      items: result.rows,
    });
  } catch (err) {
    console.error('[API] GET /api/products error:', err.message);
    res.status(503).json({
      error: 'No se pudo consultar el inventario en la base de datos. Reintente en unos segundos.',
    });
  }
});

app.get('/api/products/:id', async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'ID de producto invalido.' });
  }

  try {
    const result = await queryWithRetry(
      'SELECT id, name, category, price, stock, description, created_at, updated_at FROM products WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }
    res.status(200).json({ pod: os.hostname(), item: result.rows[0] });
  } catch (err) {
    console.error('[API] GET /api/products/:id error:', err.message);
    res.status(503).json({ error: 'Error de conexion con la base de datos.' });
  }
});

app.post('/api/products', async (req, res) => {
  const validation = validateProductPayload(req.body || {});
  if (!validation.valid) {
    return res.status(400).json({ error: validation.errors.join(' ') });
  }

  const { name, category, price, stock, description } = validation.data;
  try {
    const result = await queryWithRetry(
      `INSERT INTO products (name, category, price, stock, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, category, price, stock, description, created_at, updated_at`,
      [name, category, price, stock, description]
    );
    res.status(201).json({
      pod: os.hostname(),
      item: result.rows[0],
    });
  } catch (err) {
    console.error('[API] POST /api/products error:', err.message);
    res.status(503).json({ error: 'No se pudo registrar el producto en la base de datos.' });
  }
});

app.put('/api/products/:id', async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'ID de producto invalido.' });
  }

  const validation = validateProductPayload(req.body || {});
  if (!validation.valid) {
    return res.status(400).json({ error: validation.errors.join(' ') });
  }

  const { name, category, price, stock, description } = validation.data;
  try {
    const result = await queryWithRetry(
      `UPDATE products
       SET name = $1,
           category = $2,
           price = $3,
           stock = $4,
           description = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING id, name, category, price, stock, description, created_at, updated_at`,
      [name, category, price, stock, description, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    res.status(200).json({
      pod: os.hostname(),
      item: result.rows[0],
    });
  } catch (err) {
    console.error('[API] PUT /api/products/:id error:', err.message);
    res.status(503).json({ error: 'No se pudo actualizar el producto en la base de datos.' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'ID de producto invalido.' });
  }

  try {
    const result = await queryWithRetry(
      'DELETE FROM products WHERE id = $1 RETURNING id, name',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }
    res.status(200).json({
      pod: os.hostname(),
      deleted: result.rows[0],
    });
  } catch (err) {
    console.error('[API] DELETE /api/products/:id error:', err.message);
    res.status(503).json({ error: 'No se pudo eliminar el producto en la base de datos.' });
  }
});

// Fallback to SPA root page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[APP] Server listening on port ${PORT} (pod: ${os.hostname()})`);
  initDatabaseWithRetry();
});

function gracefulShutdown(signal) {
  console.log(`[APP] Received ${signal}. Shutting down gracefully...`);
  if (initRetryTimer) {
    clearTimeout(initRetryTimer);
  }
  releaseAllStressBuffers();
  server.close(async () => {
    try {
      await pool.end();
      console.log('[DB] PostgreSQL pool closed.');
    } catch (err) {
      console.error('[DB] Error closing pool:', err.message);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
