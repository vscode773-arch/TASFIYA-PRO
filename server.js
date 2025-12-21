const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// OneSignal Config
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

async function sendNotification(title, message) {
    if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) {
        console.warn('⚠️ OneSignal credentials not found');
        return;
    }

    try {
        await axios.post('https://onesignal.com/api/v1/notifications', {
            app_id: ONESIGNAL_APP_ID,
            headings: { en: title, ar: title },
            contents: { en: message, ar: message },
            included_segments: ['All'], // Send to all subscribed users (Admins)
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${ONESIGNAL_API_KEY}`
            }
        });
        console.log('🔔 Notification sent:', title);
    } catch (error) {
        console.error('❌ Notification failed:', error.response?.data || error.message);
    }
}

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

// Public Config Endpoint
app.get('/api/config', (req, res) => {
    res.json({
        oneSignalAppId: process.env.ONESIGNAL_APP_ID
    });
});

// Authentication Middleware ---
const authMiddleware = (req, res, next) => {
    const publicPaths = ['/login', '/api/login', '/', '/api/sync/push', '/api/config'];
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
            const recIds = data.reconciliations.map(r => r.id);
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
                    surplus_deficit = EXCLUDED.surplus_deficit,
                    notes = EXCLUDED.notes
                `, [
                    r.id, r.reconciliation_number, r.cashier_id, r.accountant_id,
                    r.reconciliation_date, r.system_sales, r.total_receipts,
                    r.surplus_deficit, r.status, r.notes
                ]);
            }
            // DELETE reconciliations that were deleted locally
            if (recIds.length > 0) {
                const placeholders = recIds.map((_, i) => `$${i + 1}`).join(',');
                await client.query(`DELETE FROM reconciliations WHERE id NOT IN (${placeholders})`, recIds);
            } else {
                await client.query('DELETE FROM reconciliations');
            }
        }

        // 5. Sync Bank Receipts
        if (data.bankReceipts) {
            const brIds = data.bankReceipts.map(br => br.id);
            for (const br of data.bankReceipts) {
                // Determine operation type (backward compatibility)
                const opType = br.operation_type || br.bank_name || 'عملية بنكية';

                await client.query(`
                    INSERT INTO bank_receipts (id, reconciliation_id, bank_name, amount)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (id) DO UPDATE SET 
                    reconciliation_id = EXCLUDED.reconciliation_id,
                    bank_name = EXCLUDED.bank_name,
                    amount = EXCLUDED.amount
                `, [br.id, br.reconciliation_id, opType, br.amount]);
            }
            if (brIds.length > 0) {
                const placeholders = brIds.map((_, i) => `$${i + 1}`).join(',');
                await client.query(`DELETE FROM bank_receipts WHERE id NOT IN (${placeholders})`, brIds);
            } else {
                await client.query('DELETE FROM bank_receipts');
            }
        }

        // 6. Send Notifications
        if (data.reconciliations && data.reconciliations.length > 0) {
            // Find completed reconciliations in this batch
            const newRecs = data.reconciliations.filter(r => r.status === 'completed');

            if (newRecs.length > 0) {
                // We should ideally check if they are NEW (not just updated), but for now notifying on sync is okay
                // To avoid spam, we can just check the first one or send a generic message
                const count = newRecs.length;
                const lastRec = newRecs[0];
                const msg = count === 1
                    ? `تصفية جديدة #${lastRec.reconciliation_number} من ${lastRec.cashier_name}`
                    : `تم مزامنة ${count} تصفيات جديدة`;

                // Don't await, send in background
                sendNotification('تصفية جديدة 💰', msg).catch(console.error);
            }
        }

        // 6. Sync Cash Receipts
        if (data.cashReceipts) {
            const crIds = data.cashReceipts.map(cr => cr.id);
            for (const cr of data.cashReceipts) {
                await client.query(`
                    INSERT INTO cash_receipts (id, reconciliation_id, amount, notes)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (id) DO UPDATE SET 
                    reconciliation_id = EXCLUDED.reconciliation_id,
                    amount = EXCLUDED.amount,
                    notes = EXCLUDED.notes
                `, [cr.id, cr.reconciliation_id, cr.amount, cr.notes]);
            }
            if (crIds.length > 0) {
                const placeholders = crIds.map((_, i) => `$${i + 1}`).join(',');
                await client.query(`DELETE FROM cash_receipts WHERE id NOT IN (${placeholders})`, crIds);
            } else {
                await client.query('DELETE FROM cash_receipts');
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

// API: Get Single Report Details
app.get('/api/reports/:id', async (req, res) => {
    try {
        const id = req.params.id;

        // Get reconciliation with joins
        const recQuery = `
            SELECT r.*,
                   c.name as cashier_name,
                   c.cashier_number,
                   a.name as accountant_name,
                   b.branch_name
            FROM reconciliations r
            JOIN cashiers c ON r.cashier_id = c.id
            JOIN accountants a ON r.accountant_id = a.id
            LEFT JOIN branches b ON c.branch_id = b.id
            WHERE r.id = $1
        `;

        const recResult = await pool.query(recQuery, [id]);

        if (recResult.rows.length === 0) {
            return res.status(404).json({ error: 'Report not found' });
        }

        const reconciliation = recResult.rows[0];

        // Fetch receipts
        const bankReceipts = await pool.query('SELECT * FROM bank_receipts WHERE reconciliation_id = $1', [id]);
        const cashReceipts = await pool.query('SELECT * FROM cash_receipts WHERE reconciliation_id = $1', [id]);

        res.json({
            ...reconciliation,
            bankReceipts: bankReceipts.rows,
            cashReceipts: cashReceipts.rows
        });
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
            CREATE TABLE IF NOT EXISTS bank_receipts (
                id INTEGER PRIMARY KEY,
                reconciliation_id INTEGER,
                bank_name TEXT,
                amount DECIMAL(15,2)
            );
             CREATE TABLE IF NOT EXISTS cash_receipts (
                id INTEGER PRIMARY KEY,
                reconciliation_id INTEGER,
                amount DECIMAL(15,2),
                notes TEXT
            );
        `);
        client.release();
        console.log('Database initialized');
    } catch (err) {
        console.error('DB Init Error:', err);
    }
};

// Start server first to satisfy Render's health check
app.listen(port, () => {
    console.log(`Cloud Server running on port ${port}`);
});

// Initialize database in background
initDB().catch(err => {
    console.error('Failed to initialize database:', err);
});
