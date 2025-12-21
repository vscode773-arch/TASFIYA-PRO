const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Allow large payloads for sync
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple In-Memory Session Store (Use Redis/DB in production for persistence)
const sessions = new Map();

// --- Auth Middleware ---
const authMiddleware = (req, res, next) => {
    const publicPaths = ['/login', '/api/login', '/', '/api/sync/push'];
    if (publicPaths.includes(req.path) || req.path.startsWith('/css') || req.path.startsWith('/js')) {
        return next();
    }

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (sessions.has(token)) {
            req.user = sessions.get(token);
            return next();
        }
    }

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Session expired or unauthorized' });
    }

    if (req.accepts('html')) {
        return res.redirect('/login');
    }

    res.status(401).json({ error: 'Unauthorized' });
};

app.use(authMiddleware);

// --- Routes ---

// Views
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));

// API: Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
        const user = result.rows[0];

        if (user && user.password === password) { // Note: Use bcrypt in production
            const token = 'sess_' + Math.random().toString(36).substr(2) + Date.now().toString(36);
            sessions.set(token, user);
            res.json({ success: true, token, user: { name: user.name, username: user.username } });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Sync Endpoint (Receives Data from Desktop App)
app.post('/api/sync/push', async (req, res) => {
    const { apiKey, data } = req.body;

    // Simple API Key check
    if (apiKey !== process.env.SYNC_API_KEY) {
        return res.status(403).json({ error: 'Invalid API Key' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Sync Cashiers
        if (data.cashiers) {
            for (const c of data.cashiers) {
                await client.query(`
                    INSERT INTO cashiers (id, name, cashier_number, branch_id, active)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (id) DO UPDATE SET 
                    name = EXCLUDED.name, branch_id = EXCLUDED.branch_id, active = EXCLUDED.active
                `, [c.id, c.name, c.cashier_number, c.branch_id, c.active]);
            }
        }

        // 2. Sync Branches
        if (data.branches) {
            for (const b of data.branches) {
                await client.query(`
                    INSERT INTO branches (id, branch_name, is_active)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (id) DO UPDATE SET 
                    branch_name = EXCLUDED.branch_name, is_active = EXCLUDED.is_active
                `, [b.id, b.branch_name, b.is_active]);
            }
        }

        // 3. Sync Accountants
        if (data.accountants) {
            for (const a of data.accountants) {
                await client.query(`
                    INSERT INTO accountants (id, name, username)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (id) DO UPDATE SET 
                    name = EXCLUDED.name
                `, [a.id, a.name, a.username]);
            }
        }

        // 4. Sync Reconciliations
        if (data.reconciliations) {
            for (const r of data.reconciliations) {
                await client.query(`
                    INSERT INTO reconciliations (
                        id, reconciliation_number, cashier_id, accountant_id, 
                        reconciliation_date, system_sales, total_receipts, 
                        surplus_deficit, status, notes
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (id) DO UPDATE SET 
                    status = EXCLUDED.status,
                    system_sales = EXCLUDED.system_sales,
                    total_receipts = EXCLUDED.total_receipts,
                    surplus_deficit = EXCLUDED.surplus_deficit
                `, [
                    r.id, r.reconciliation_number, r.cashier_id, r.accountant_id,
                    r.reconciliation_date, r.system_sales, r.total_receipts,
                    r.surplus_deficit, r.status, r.notes
                ]);
            }
        }

        // 5. Sync Admin (Optional, to ensure login works)
        if (data.admins) {
            for (const a of data.admins) {
                // Only sync if not exists to avoid overwriting cloud password if changed
                const check = await client.query('SELECT id FROM admins WHERE username = $1', [a.username]);
                if (check.rowCount === 0) {
                    await client.query('INSERT INTO admins (username, password, name) VALUES ($1, $2, $3)', [a.username, a.password, a.name]);
                }
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Sync successful' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// API: Metadata
app.get('/api/metadata', async (req, res) => {
    try {
        const branches = await pool.query('SELECT id, branch_name FROM branches WHERE is_active = 1');
        const cashiers = await pool.query('SELECT id, name, cashier_number FROM cashiers WHERE active = 1');
        res.json({ branches: branches.rows, cashiers: cashiers.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Stats
app.get('/api/stats', async (req, res) => {
    try {
        let whereClause = 'WHERE 1=1';
        const params = [];
        let pIndex = 1;

        if (req.query.dateFrom) {
            whereClause += ` AND DATE(reconciliation_date) >= $${pIndex++}`;
            params.push(req.query.dateFrom);
        }
        if (req.query.dateTo) {
            whereClause += ` AND DATE(reconciliation_date) <= $${pIndex++}`;
            params.push(req.query.dateTo);
        }
        if (req.query.branchId) {
            whereClause += ` AND cashier_id IN (SELECT id FROM cashiers WHERE branch_id = $${pIndex++})`;
            params.push(req.query.branchId);
        }
        if (req.query.cashierId) {
            whereClause += ` AND cashier_id = $${pIndex++}`;
            params.push(req.query.cashierId);
        }
        if (req.query.status) {
            whereClause += ` AND status = $${pIndex++}`;
            params.push(req.query.status);
        }

        const countRes = await pool.query(`SELECT COUNT(*) as count FROM reconciliations ${whereClause}`, params);
        const receiptsRes = await pool.query(`SELECT SUM(total_receipts) as sum FROM reconciliations ${whereClause}`, params);
        const salesRes = await pool.query(`SELECT SUM(system_sales) as sum FROM reconciliations ${whereClause}`, params);

        res.json({
            totalReconciliations: countRes.rows[0].count,
            totalReceipts: receiptsRes.rows[0].sum || 0,
            totalSales: salesRes.rows[0].sum || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Reports
app.get('/api/reports', async (req, res) => {
    try {
        let sql = `
            SELECT r.*,
                   c.name as cashier_name,
                   c.cashier_number,
                   a.name as accountant_name,
                   b.branch_name
            FROM reconciliations r
            JOIN cashiers c ON r.cashier_id = c.id
            JOIN accountants a ON r.accountant_id = a.id
            LEFT JOIN branches b ON c.branch_id = b.id
            ${'WHERE 1=1'}
        `;

        const params = [];
        let pIndex = 1;

        if (req.query.dateFrom) {
            sql += ` AND DATE(r.reconciliation_date) >= $${pIndex++}`;
            params.push(req.query.dateFrom);
        }
        if (req.query.dateTo) {
            sql += ` AND DATE(r.reconciliation_date) <= $${pIndex++}`;
            params.push(req.query.dateTo);
        }
        if (req.query.status) {
            sql += ` AND r.status = $${pIndex++}`;
            params.push(req.query.status);
        }
        if (req.query.branchId) {
            sql += ` AND c.branch_id = $${pIndex++}`;
            params.push(req.query.branchId);
        }
        if (req.query.cashierId) {
            sql += ` AND r.cashier_id = $${pIndex++}`;
            params.push(req.query.cashierId);
        }

        sql += ' ORDER BY r.reconciliation_date DESC, r.id DESC LIMIT 100';

        const result = await pool.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Start Server
// Ensure tables exist
const initDB = async () => {
    try {
        const client = await pool.connect();
        await client.query(`
            CREATE TABLE IF NOT EXISTS branches (
                id INTEGER PRIMARY KEY,
                branch_name TEXT,
                is_active INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS cashiers (
                id INTEGER PRIMARY KEY,
                name TEXT,
                cashier_number TEXT,
                branch_id INTEGER,
                active INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS accountants (
                id INTEGER PRIMARY KEY,
                name TEXT,
                username TEXT
            );
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE,
                password TEXT,
                name TEXT
            );
            CREATE TABLE IF NOT EXISTS reconciliations (
                id INTEGER PRIMARY KEY,
                reconciliation_number INTEGER,
                cashier_id INTEGER,
                accountant_id INTEGER,
                reconciliation_date TEXT,
                system_sales DECIMAL(15,2),
                total_receipts DECIMAL(15,2),
                surplus_deficit DECIMAL(15,2),
                status TEXT,
                notes TEXT
            );
        `);
        client.release();
        console.log('Database initialized');
    } catch (err) {
        console.error('DB Init Error:', err);
    }
};

app.listen(port, async () => {
    await initDB();
    console.log(`Cloud Server running on port ${port}`);
});
