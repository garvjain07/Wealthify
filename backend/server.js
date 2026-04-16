const express = require('express');
const cors = require('cors');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Parser } = require('json2csv');
const { initializeMongo, getNextId, models } = require('./mongoDatabase');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

const app = express();
const port = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET;
const BACKUP_DIR = path.join(__dirname, 'backups');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!JWT_SECRET) {
    console.error('Missing required env var: JWT_SECRET');
    process.exit(1);
}

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/', (req, res) => {
    res.json({
        service: 'Money Manager Backend',
        status: 'ok',
        docs: '/api'
    });
});

app.get('/api', (req, res) => {
    res.json({
        service: 'Money Manager API',
        status: 'ok',
        public_endpoints: ['/api/login', '/api/register', '/api/user/reset-pin']
    });
});

let db = null;
let mongoReady = false;
const dbProvider = 'mongodb';
const useMongo = true;

initializeMongo().then(() => {
    mongoReady = true;
    startBackgroundJobs();
    app.listen(port, () => {
        console.log(`Backend running on port ${port}`);
        if (useMongo) {
            console.log('DB_PROVIDER=mongodb enabled for migrated endpoints');
        }
    });
}).catch((err) => {
    console.error('MongoDB initialization failed:', err.message);
    process.exit(1);
});

const parseJSON = (str, fallback = null) => {
    try { return JSON.parse(str); } catch (_) { return fallback; }
};

const canUseMongo = () => useMongo && mongoReady;

const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const adjustMongoAccountBalance = async (accountId, delta) => {
    await models.Account.updateOne({ id: Number(accountId) }, { $inc: { balance: Number(delta || 0) } });
};

const buildMongoUserBackupPayload = async (userId) => {
    const userTransactions = await models.Transaction.find({ user_id: userId }, { _id: 0 }).lean();
    const txIds = userTransactions.map((t) => t.id);
    const subscriptionRows = await models.Subscription.find({ user_id: userId }, { _id: 0 }).lean();
    const subIds = subscriptionRows.map((s) => s.id);

    return {
        users: await models.User.find({ id: userId }, { _id: 0 }).lean(),
        accounts: await models.Account.find({ user_id: userId }, { _id: 0 }).lean(),
        categories: await models.Category.find({ user_id: userId }, { _id: 0 }).lean(),
        transactions: userTransactions,
        transaction_splits: txIds.length ? await models.TransactionSplit.find({ transaction_id: { $in: txIds } }, { _id: 0 }).lean() : [],
        subscriptions: subscriptionRows,
        debts: await models.Debt.find({ user_id: userId }, { _id: 0 }).lean(),
        investments: await models.Investment.find({ user_id: userId }, { _id: 0 }).lean(),
        goals: await models.Goal.find({ user_id: userId }, { _id: 0 }).lean(),
        goal_utilization_history: await models.GoalUtilizationHistory.find({ user_id: userId }, { _id: 0 }).lean(),
        notifications: await models.Notification.find({ user_id: userId }, { _id: 0 }).lean(),
        recurring_runs: subIds.length ? await models.RecurringRun.find({ subscription_id: { $in: subIds } }, { _id: 0 }).lean() : [],
        action_history: await models.ActionHistory.find({ user_id: userId }, { _id: 0 }).lean(),
        balance_snapshots: await models.BalanceSnapshot.find({ user_id: userId }, { _id: 0 }).lean(),
        reconciliation_sessions: await models.ReconciliationSession.find({ user_id: userId }, { _id: 0 }).lean(),
        saved_filters: await models.SavedFilter.find({ user_id: userId }, { _id: 0 }).lean(),
        quality_issue_overrides: await models.QualityIssueOverride.find({ user_id: userId }, { _id: 0 }).lean()
    };
};

const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

const shouldSendByAlertLevel = (alertLevel, level) => {
    if (alertLevel === 'critical') return level === 'danger';
    return true;
};

const getEmailTransporter = () => {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
};

const saveAction = async (userId, actionType, entityType, entityId, oldData, newData) => {
    if (canUseMongo()) {
        const id = await getNextId('action_history');
        await models.ActionHistory.create({
            id,
            user_id: userId,
            action_type: actionType,
            entity_type: entityType,
            entity_id: entityId || null,
            old_data: oldData ? JSON.stringify(oldData) : null,
            new_data: newData ? JSON.stringify(newData) : null,
            created_at: new Date().toISOString()
        });
        return;
    }
    await db.run(
        'INSERT INTO action_history (user_id, action_type, entity_type, entity_id, old_data, new_data) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, actionType, entityType, entityId || null, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null]
    );
};

const runAutoBackupForUser = async (user) => {
    if (!user.backup_frequency || user.backup_frequency === 'manual') return false;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const last = user.last_backup_at ? new Date(user.last_backup_at) : null;
    const daysSince = last ? Math.floor((now - last) / (1000 * 60 * 60 * 24)) : 999;
    const due = (user.backup_frequency === 'daily' && daysSince >= 1) || (user.backup_frequency === 'weekly' && daysSince >= 7);
    if (!due) return false;
    const out = path.join(BACKUP_DIR, `user-${user.id}-${Date.now()}.json`);
    const payload = await buildMongoUserBackupPayload(user.id);
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
    await models.User.updateOne({ id: user.id }, { $set: { last_backup_at: today } });
    await addNotificationIfMissingToday(user.id, 'backup', 'info', `Auto backup completed (${user.backup_frequency})`);
    return true;
};

const startBackgroundJobs = () => {
    setInterval(async () => {
        if (!mongoReady) return;
        try {
            const users = await models.User.find({}, { id: 1, backup_frequency: 1, last_backup_at: 1, _id: 0 }).lean();
            for (const user of users) {
                await runAutoBackupForUser(user);
            }
        } catch (_) {}
    }, 60 * 60 * 1000);
};

const isDueByFrequency = (nextDate, frequency, now) => {
    const d = new Date(nextDate);
    if (Number.isNaN(d.getTime())) return false;
    const n = new Date(now);
    return d <= n;
};

const nextDateFromFrequency = (nextDate, frequency) => {
    const d = new Date(nextDate);
    if (frequency === 'Weekly') d.setDate(d.getDate() + 7);
    else if (frequency === 'Yearly') d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1);
    return d.toISOString().split('T')[0];
};

const addNotificationIfMissingToday = async (userId, type, level, message) => {
    const profile = canUseMongo()
        ? await models.User.findOne({ id: userId }, { alert_level: 1, recovery_email: 1, _id: 0 }).lean()
        : await db.get('SELECT alert_level, recovery_email FROM users WHERE id = ?', [userId]);
    if (!shouldSendByAlertLevel(profile?.alert_level || 'all', level)) return;

    const existing = canUseMongo()
        ? await models.Notification.findOne({
            user_id: userId,
            type,
            message,
            created_at: { $regex: `^${new Date().toISOString().split('T')[0]}` }
          }, { id: 1, _id: 0 }).lean()
        : await db.get(
            `SELECT id FROM notifications WHERE user_id = ? AND type = ? AND message = ? AND DATE(created_at) = DATE('now')`,
            [userId, type, message]
        );
    if (!existing) {
        if (canUseMongo()) {
            const id = await getNextId('notifications');
            await models.Notification.create({ id, user_id: userId, type, level, message, is_read: 0, created_at: new Date().toISOString() });
        } else {
            await db.run('INSERT INTO notifications (user_id, type, level, message) VALUES (?, ?, ?, ?)', [userId, type, level, message]);
        }
        const transporter = getEmailTransporter();
        if (transporter && profile?.recovery_email && (type === 'subscription' || type === 'budget')) {
            try {
                await transporter.sendMail({
                    from: process.env.SMTP_FROM || process.env.SMTP_USER,
                    to: profile.recovery_email,
                    subject: `[Money Manager] ${type} alert`,
                    text: message
                });
            } catch (_) {}
        }
    }
};

const runRecurringAutomationForUser = async (userId) => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const subs = canUseMongo()
        ? await models.Subscription.find({ user_id: userId }, { _id: 0 }).lean()
        : await db.all('SELECT * FROM subscriptions WHERE user_id = ?', [userId]);
    let processed = 0;

    for (const s of subs) {
        if (!isDueByFrequency(s.next_date, s.frequency, now)) continue;
        const alreadyRan = canUseMongo()
            ? await models.RecurringRun.findOne({ subscription_id: s.id, run_date: today }, { id: 1, _id: 0 }).lean()
            : await db.get('SELECT id FROM recurring_runs WHERE subscription_id = ? AND run_date = ?', [s.id, today]);
        if (alreadyRan) continue;

        try {
            const desc = `[AUTO:${s.name}] Recurring ${s.type}`;
            const next = nextDateFromFrequency(s.next_date, s.frequency);

            if (canUseMongo()) {
                const txId = await getNextId('transactions');
                await models.Transaction.create({
                    id: txId,
                    user_id: userId,
                    account_id: s.account_id,
                    category_id: s.category_id,
                    amount: s.amount,
                    date: today,
                    description: desc,
                    transaction_type: s.type,
                    receipt_url: null,
                    tag: '#auto-recurring',
                    created_at: new Date().toISOString()
                });
                await adjustMongoAccountBalance(s.account_id, s.type === 'Income' ? s.amount : -s.amount);
                await models.Subscription.updateOne({ id: s.id }, { $set: { next_date: next } });
                const rrId = await getNextId('recurring_runs');
                await models.RecurringRun.create({ id: rrId, user_id: userId, subscription_id: s.id, run_date: today });
            } else {
                await db.run('BEGIN TRANSACTION');
                await db.run(
                    'INSERT INTO transactions (user_id, account_id, category_id, amount, date, description, transaction_type, receipt_url, tag) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
                    [userId, s.account_id, s.category_id, s.amount, today, desc, s.type, '#auto-recurring']
                );
                await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [s.type === 'Income' ? s.amount : -s.amount, s.account_id]);
                await db.run('UPDATE subscriptions SET next_date = ? WHERE id = ?', [next, s.id]);
                await db.run('INSERT INTO recurring_runs (user_id, subscription_id, run_date) VALUES (?, ?, ?)', [userId, s.id, today]);
                await db.run('COMMIT');
            }
            processed += 1;

            await addNotificationIfMissingToday(userId, 'recurring', 'info', `${s.name} auto-posted (${s.type})`);
        } catch (e) {
            if (!canUseMongo()) await db.run('ROLLBACK');
        }
    }
    return processed;
};

const isProtectedSystemTransaction = (tx) => {
    const tag = String(tx?.tag || '').trim().toLowerCase();
    const desc = String(tx?.description || '').trim();
    if (['goalcontribution', 'goalwithdraw', 'goalutilizedeposit', 'openingbalance', '#auto-recurring', 'auto-recurring', 'autorecurring'].includes(tag)) return true;
    if (desc === 'Opening Balance') return true;
    if (desc.startsWith('[AUTO:')) return true;
    return false;
};


// --- AUTH ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        if (canUseMongo()) {
            const exists = await models.User.findOne({ username }).lean();
            if (exists) return res.status(400).json({ error: 'Username already exists.' });

            const hash = await bcrypt.hash(password, 10);
            const user_id = await getNextId('users');
            await models.User.create({ id: user_id, username, password: hash });

            const defaultCategories = [
                { name: 'Salary', type: 'Income', monthly_budget: 0 },
                { name: 'Groceries', type: 'Expense', monthly_budget: 500 },
                { name: 'Rent', type: 'Expense', monthly_budget: 1000 }
            ];
            for (const c of defaultCategories) {
                const id = await getNextId('categories');
                await models.Category.create({ id, user_id, ...c });
            }
            const mainAccountId = await getNextId('accounts');
            await models.Account.create({ id: mainAccountId, user_id, name: 'Main Bank', type: 'Bank', balance: 1000 });

            const token = jwt.sign({ id: user_id, username }, JWT_SECRET);
            return res.json({ token, username });
        }

        const hash = await bcrypt.hash(password, 10);
        const result = await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash]);
        const user_id = result.lastID;
        
        await db.exec(`
            INSERT INTO categories (user_id, name, type, monthly_budget) VALUES 
            (${user_id}, 'Salary', 'Income', 0),
            (${user_id}, 'Groceries', 'Expense', 500),
            (${user_id}, 'Rent', 'Expense', 1000);
            INSERT INTO accounts (user_id, name, type, balance) VALUES 
            (${user_id}, 'Main Bank', 'Bank', 1000);
        `);
        
        const token = jwt.sign({ id: user_id, username }, JWT_SECRET);
        res.json({ token, username });
    } catch (e) { res.status(400).json({ error: "Username already exists." }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = canUseMongo()
        ? await models.User.findOne({ username }).lean()
        : await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, username: user.username, avatar_url: user.avatar_url });
});

const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1] || req.query.token;
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};
app.use((req, res, next) => {
    if (req.path.startsWith('/api/') && req.path !== '/api/login' && req.path !== '/api/register' && req.path !== '/api/user/reset-pin' && !req.path.startsWith('/api/uploads')) {
        return authenticateToken(req, res, next);
    }
    next();
});

// --- PROFILE ---
app.get('/api/user/me', async (req, res) => {
    const user = canUseMongo()
        ? await models.User.findOne({ id: req.user.id }).lean()
        : await db.get('SELECT id, username, avatar_url, currency, monthly_budget, pin_hash, alert_level, backup_frequency, recovery_question, recovery_email, pin_locked_until FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.json({});
    res.json({
        id: user.id,
        username: user.username,
        avatar_url: user.avatar_url,
        currency: user.currency,
        monthly_budget: user.monthly_budget,
        has_pin: !!user.pin_hash,
        alert_level: user.alert_level || 'all',
        backup_frequency: user.backup_frequency || 'manual',
        recovery_question: user.recovery_question || '',
        recovery_email: user.recovery_email || '',
        pin_locked_until: user.pin_locked_until || null
    });
});
app.put('/api/user/profile', async (req, res) => {
    const { username, avatar_url, password, currency, monthly_budget, pin, alert_level, backup_frequency, recovery_question, recovery_answer, recovery_email } = req.body;
    try {
        const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
        const recoveryAnswerHash = recovery_answer ? await bcrypt.hash(recovery_answer, 10) : null;
        if (canUseMongo()) {
            const update = {
                username,
                avatar_url,
                currency: currency || '$',
                monthly_budget: monthly_budget || 0,
                alert_level: alert_level || 'all',
                backup_frequency: backup_frequency || 'manual'
            };
            if (password) update.password = await bcrypt.hash(password, 10);
            if (pinHash) update.pin_hash = pinHash;
            if (recovery_question) update.recovery_question = recovery_question;
            if (recoveryAnswerHash) update.recovery_answer_hash = recoveryAnswerHash;
            if (recovery_email) update.recovery_email = recovery_email;
            await models.User.updateOne({ id: req.user.id }, { $set: update });
            return res.json({ success: true });
        }

        if (password) {
            const hash = await bcrypt.hash(password, 10);
            await db.run('UPDATE users SET username = ?, avatar_url = ?, password = ?, currency = ?, monthly_budget = ?, pin_hash = COALESCE(?, pin_hash), alert_level = ?, backup_frequency = ?, recovery_question = COALESCE(?, recovery_question), recovery_answer_hash = COALESCE(?, recovery_answer_hash), recovery_email = COALESCE(?, recovery_email) WHERE id = ?', [username, avatar_url, hash, currency || '$', monthly_budget || 0, pinHash, alert_level || 'all', backup_frequency || 'manual', recovery_question || null, recoveryAnswerHash, recovery_email || null, req.user.id]);
        } else {
            await db.run('UPDATE users SET username = ?, avatar_url = ?, currency = ?, monthly_budget = ?, pin_hash = COALESCE(?, pin_hash), alert_level = ?, backup_frequency = ?, recovery_question = COALESCE(?, recovery_question), recovery_answer_hash = COALESCE(?, recovery_answer_hash), recovery_email = COALESCE(?, recovery_email) WHERE id = ?', [username, avatar_url, currency || '$', monthly_budget || 0, pinHash, alert_level || 'all', backup_frequency || 'manual', recovery_question || null, recoveryAnswerHash, recovery_email || null, req.user.id]);
        }
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/user/verify-pin', async (req, res) => {
    const { pin } = req.body;
    const user = canUseMongo()
        ? await models.User.findOne({ id: req.user.id }, { pin_hash: 1, pin_attempts: 1, pin_locked_until: 1, _id: 0 }).lean()
        : await db.get('SELECT pin_hash, pin_attempts, pin_locked_until FROM users WHERE id = ?', [req.user.id]);
    if (!user || !user.pin_hash) return res.json({ valid: true });
    if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date()) {
        return res.status(423).json({ valid: false, error: 'PIN temporarily locked. Try later.' });
    }
    const valid = await bcrypt.compare(String(pin || ''), user.pin_hash);
    if (valid) {
        if (canUseMongo()) await models.User.updateOne({ id: req.user.id }, { $set: { pin_attempts: 0, pin_locked_until: null } });
        else await db.run('UPDATE users SET pin_attempts = 0, pin_locked_until = NULL WHERE id = ?', [req.user.id]);
        return res.json({ valid: true });
    }

    const attempts = Number(user.pin_attempts || 0) + 1;
    if (attempts >= 5) {
        const lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        if (canUseMongo()) await models.User.updateOne({ id: req.user.id }, { $set: { pin_attempts: 0, pin_locked_until: lockUntil } });
        else await db.run('UPDATE users SET pin_attempts = 0, pin_locked_until = ? WHERE id = ?', [lockUntil, req.user.id]);
        return res.status(423).json({ valid: false, error: 'Too many wrong attempts. Locked for 15 minutes.' });
    }
    if (canUseMongo()) await models.User.updateOne({ id: req.user.id }, { $set: { pin_attempts: attempts } });
    else await db.run('UPDATE users SET pin_attempts = ? WHERE id = ?', [attempts, req.user.id]);
    return res.json({ valid: false, attempts_left: 5 - attempts });
});

app.post('/api/user/reset-pin', async (req, res) => {
    const { username, recovery_answer, new_pin } = req.body;
    const user = canUseMongo()
        ? await models.User.findOne({ username }, { id: 1, recovery_answer_hash: 1, _id: 0 }).lean()
        : await db.get('SELECT id, recovery_answer_hash FROM users WHERE username = ?', [username]);
    if (!user || !user.recovery_answer_hash) return res.status(400).json({ error: 'Recovery setup not found.' });
    const ok = await bcrypt.compare(String(recovery_answer || ''), user.recovery_answer_hash);
    if (!ok) return res.status(400).json({ error: 'Recovery verification failed.' });
    const hash = await bcrypt.hash(String(new_pin || ''), 10);
    if (canUseMongo()) await models.User.updateOne({ id: user.id }, { $set: { pin_hash: hash, pin_attempts: 0, pin_locked_until: null } });
    else await db.run('UPDATE users SET pin_hash = ?, pin_attempts = 0, pin_locked_until = NULL WHERE id = ?', [hash, user.id]);
    res.json({ success: true });
});

// --- BASIC ENTITIES (ACCOUNTS/CATEGORIES/TRANSACTIONS) ---
app.get('/api/accounts', async (req, res) => {
    if (canUseMongo()) {
        const rows = await models.Account.find({ user_id: req.user.id }, { _id: 0 }).lean();
        return res.json(rows.map((r) => ({ ...r, is_owner: 1 })));
    }
    const rows = await db.all('SELECT *, 1 as is_owner FROM accounts WHERE user_id = ?', [req.user.id]);
    res.json(rows);
});
app.post('/api/accounts', async (req, res) => {
    const { name, type, balance } = req.body;
    try {
        if (canUseMongo()) {
            const accountId = await getNextId('accounts');
            const initBalance = Number(balance || 0);
            await models.Account.create({ id: accountId, user_id: req.user.id, name, type, balance: initBalance });
            if (initBalance !== 0) {
                const txType = initBalance > 0 ? 'Income' : 'Expense';
                const txId = await getNextId('transactions');
                await models.Transaction.create({
                    id: txId,
                    user_id: req.user.id,
                    account_id: accountId,
                    amount: Math.abs(initBalance),
                    date: new Date().toISOString().split('T')[0],
                    description: 'Opening Balance',
                    transaction_type: txType,
                    tag: 'OpeningBalance',
                    created_at: new Date().toISOString()
                });
            }
            return res.status(201).json({ id: accountId });
        }

        await db.run('BEGIN TRANSACTION');
        const result = await db.run('INSERT INTO accounts (user_id, name, type, balance) VALUES (?, ?, ?, 0)', [req.user.id, name, type]);
        const accountId = result.lastID;
        
        const initBalance = Number(balance || 0);
        if (initBalance !== 0) {
            const txType = initBalance > 0 ? "Income" : "Expense";
            const absAmount = Math.abs(initBalance);
            await db.run('INSERT INTO transactions (user_id, account_id, category_id, amount, date, description, transaction_type, tag) VALUES (?, ?, NULL, ?, date("now"), "Opening Balance", ?, "OpeningBalance")', [req.user.id, accountId, absAmount, txType]);
            await db.run('UPDATE accounts SET balance = ? WHERE id = ?', [initBalance, accountId]);
        }
        
        await db.run('COMMIT');
        res.status(201).json({ id: accountId });
    } catch (error) {
        await db.run('ROLLBACK');
        console.error(error);
        res.status(500).json({ error: 'Failed to create account.' });
    }
});
app.delete('/api/accounts/:id', async (req, res) => {
    if (canUseMongo()) {
        await models.Account.deleteOne({ id: Number(req.params.id), user_id: req.user.id });
        return res.json({ success: true });
    }
    await db.run('DELETE FROM accounts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
});


app.get('/api/categories', async (req, res) => {
    if (canUseMongo()) {
        const rows = await models.Category.find({ user_id: req.user.id }, { _id: 0 }).lean();
        return res.json(rows);
    }
    res.json(await db.all('SELECT * FROM categories WHERE user_id = ?', [req.user.id]));
});
app.post('/api/categories', async (req, res) => {
    const { name, type, monthly_budget } = req.body;
    if (canUseMongo()) {
        const id = await getNextId('categories');
        await models.Category.create({ id, user_id: req.user.id, name, type, monthly_budget: monthly_budget || 0 });
        return res.status(201).json({ id });
    }
    const result = await db.run('INSERT INTO categories (user_id, name, type, monthly_budget) VALUES (?, ?, ?, ?)', [req.user.id, name, type, monthly_budget || 0]);
    res.status(201).json({ id: result.lastID });
});
app.delete('/api/categories/:id', async (req, res) => {
    if (canUseMongo()) {
        await models.Category.deleteOne({ id: Number(req.params.id), user_id: req.user.id });
        return res.json({ success: true });
    }
    await db.run('DELETE FROM categories WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
});

app.get('/api/transactions', async (req, res) => {
    const page = Math.max(Number(req.query.page || 1), 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize || 100), 1), 200);
    const offset = (page - 1) * pageSize;
    const search = String(req.query.q || '').trim();
    const tag = String(req.query.tag || '').trim();
    const category = String(req.query.category || '').trim();
    const fromDate = String(req.query.fromDate || '').trim();
    const toDate = String(req.query.toDate || '').trim();

    if (canUseMongo()) {
        const [txRows, accounts, categories] = await Promise.all([
            models.Transaction.find({ user_id: req.user.id }, { _id: 0 }).lean(),
            models.Account.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean(),
            models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
        ]);

        const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
        const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
        const searchLower = search.toLowerCase();
        const tagLower = tag.toLowerCase();
        const categoryLower = category.toLowerCase();

        const filtered = txRows.filter((t) => {
            const accountName = String(accountMap.get(t.account_id) || '').toLowerCase();
            const categoryName = String(categoryMap.get(t.category_id) || '').toLowerCase();
            const desc = String(t.description || '').toLowerCase();
            const txTag = String(t.tag || '').toLowerCase();

            if (search && !(desc.includes(searchLower) || txTag.includes(searchLower) || categoryName.includes(searchLower) || accountName.includes(searchLower))) return false;
            if (tag && !txTag.includes(tagLower)) return false;
            if (category && !categoryName.includes(categoryLower)) return false;
            if (fromDate && String(t.date || '') < fromDate) return false;
            if (toDate && String(t.date || '') > toDate) return false;
            return true;
        }).sort((a, b) => {
            if (a.date === b.date) return Number(b.id) - Number(a.id);
            return String(b.date).localeCompare(String(a.date));
        });

        const pageItems = filtered.slice(offset, offset + pageSize);
        const txIds = pageItems.map((t) => t.id);
        const splitRows = txIds.length
            ? await models.TransactionSplit.find({ transaction_id: { $in: txIds } }, { _id: 0 }).lean()
            : [];
        const splitMap = splitRows.reduce((acc, row) => {
            const category_name = categoryMap.get(row.category_id) || null;
            acc[row.transaction_id] = acc[row.transaction_id] || [];
            acc[row.transaction_id].push({ ...row, category_name });
            return acc;
        }, {});

        return res.json({
            items: pageItems.map((t) => ({
                ...t,
                account_name: accountMap.get(t.account_id) || null,
                to_account_name: accountMap.get(t.to_account_id) || null,
                category_name: categoryMap.get(t.category_id) || null,
                splits: splitMap[t.id] || []
            })),
            page,
            pageSize,
            total: filtered.length
        });
    }

    const filters = ['t.user_id = ?'];
    const params = [req.user.id];
    if (search) {
        filters.push('(LOWER(COALESCE(t.description, \"\")) LIKE ? OR LOWER(COALESCE(t.tag, \"\")) LIKE ? OR LOWER(COALESCE(c.name, \"\")) LIKE ? OR LOWER(COALESCE(a.name, \"\")) LIKE ?)');
        const q = `%${search.toLowerCase()}%`;
        params.push(q, q, q, q);
    }
    if (tag) {
        filters.push('LOWER(COALESCE(t.tag, \"\")) LIKE ?');
        params.push(`%${tag.toLowerCase()}%`);
    }
    if (category) {
        filters.push('LOWER(COALESCE(c.name, \"\")) LIKE ?');
        params.push(`%${category.toLowerCase()}%`);
    }
    if (fromDate) {
        filters.push('t.date >= ?');
        params.push(fromDate);
    }
    if (toDate) {
        filters.push('t.date <= ?');
        params.push(toDate);
    }

    const where = filters.join(' AND ');
    const q = `SELECT t.*, a.name as account_name, ta.name as to_account_name, c.name as category_name
               FROM transactions t
               LEFT JOIN accounts a ON t.account_id = a.id
               LEFT JOIN accounts ta ON t.to_account_id = ta.id
               LEFT JOIN categories c ON t.category_id = c.id
               WHERE ${where}
               ORDER BY t.date DESC, t.id DESC
               LIMIT ? OFFSET ?`;
    const txns = await db.all(q, [...params, pageSize, offset]);
    const totalRow = await db.get(`SELECT COUNT(1) as total FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id LEFT JOIN categories c ON t.category_id = c.id WHERE ${where}`, params);
    const splitRows = await db.all(
        `SELECT ts.transaction_id, ts.amount, ts.tag, ts.category_id, c.name as category_name
         FROM transaction_splits ts
         LEFT JOIN categories c ON c.id = ts.category_id
         WHERE ts.transaction_id IN (SELECT id FROM transactions WHERE user_id = ?)`,
        [req.user.id]
    );
    const splitMap = splitRows.reduce((acc, row) => {
        acc[row.transaction_id] = acc[row.transaction_id] || [];
        acc[row.transaction_id].push(row);
        return acc;
    }, {});

    res.json({
        items: txns.map(t => ({ ...t, splits: splitMap[t.id] || [] })),
        page,
        pageSize,
        total: Number(totalRow?.total || 0)
    });
});

app.get('/api/transactions/quality-check', async (req, res) => {
    if (canUseMongo()) {
        const [txRows, accounts, categories, overrides] = await Promise.all([
            models.Transaction.find({ user_id: req.user.id }, { _id: 0 }).lean(),
            models.Account.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean(),
            models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean(),
            models.QualityIssueOverride.find({ user_id: req.user.id }, { transaction_id: 1, issue_code: 1, _id: 0 }).lean()
        ]);

        const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
        const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
        const txns = txRows
            .map((t) => ({ ...t, account_name: accountMap.get(t.account_id) || null, category_name: categoryMap.get(t.category_id) || null }))
            .sort((a, b) => (a.date === b.date ? Number(b.id) - Number(a.id) : String(b.date).localeCompare(String(a.date))));

        const expenseRows = txns.filter(t => t.transaction_type === 'Expense');
        const incomeRows = txns.filter(t => t.transaction_type === 'Income');
        const avgExpense = expenseRows.length ? expenseRows.reduce((s, r) => s + Number(r.amount || 0), 0) / expenseRows.length : 0;
        const avgIncome = incomeRows.length ? incomeRows.reduce((s, r) => s + Number(r.amount || 0), 0) / incomeRows.length : 0;
        const highExpenseThreshold = Math.max(10000, avgExpense * 3);
        const highIncomeThreshold = Math.max(20000, avgIncome * 3);

        const duplicateCount = new Map();
        for (const t of txns) {
            const key = `${t.account_id}|${t.transaction_type}|${t.date}|${Number(t.amount)}|${String(t.description || '').toLowerCase()}`;
            duplicateCount.set(key, (duplicateCount.get(key) || 0) + 1);
        }
        const dupKeys = new Set([...duplicateCount.entries()].filter(([, cnt]) => cnt > 1).map(([k]) => k));
        const ignoredKeys = new Set(overrides.map(r => `${r.transaction_id}|${r.issue_code}`));
        const isIgnored = (transactionId, issueCode) => ignoredKeys.has(`${transactionId}|${issueCode}`);

        const now = new Date();
        const maxFuture = new Date(now);
        maxFuture.setDate(maxFuture.getDate() + 1);
        const minPast = new Date(now);
        minPast.setFullYear(minPast.getFullYear() - 10);

        const issues = [];
        for (const t of txns) {
            const itemIssues = [];
            const amount = Number(t.amount || 0);
            if (t.transaction_type === 'Expense' && amount >= highExpenseThreshold && !isIgnored(t.id, 'high_expense_amount')) {
                itemIssues.push(`Very high expense amount (${amount.toFixed(2)})`);
            }
            if (t.transaction_type === 'Income' && amount >= highIncomeThreshold && !isIgnored(t.id, 'high_income_amount')) {
                itemIssues.push(`Very high income amount (${amount.toFixed(2)})`);
            }

            const dt = new Date(t.date);
            if ((Number.isNaN(dt.getTime()) || dt > maxFuture || dt < minPast) && !isIgnored(t.id, 'suspicious_date')) {
                itemIssues.push('Suspicious transaction date');
            }

            const dKey = `${t.account_id}|${t.transaction_type}|${t.date}|${Number(t.amount)}|${String(t.description || '').toLowerCase()}`;
            if (dupKeys.has(dKey) && !isIgnored(t.id, 'possible_duplicate')) {
                itemIssues.push('Possible duplicate transaction');
            }

            if (itemIssues.length) {
                issues.push({
                    transaction_id: t.id,
                    amount,
                    date: t.date,
                    description: t.description,
                    transaction_type: t.transaction_type,
                    account_name: t.account_name,
                    category_name: t.category_name,
                    issues: itemIssues
                });
            }
        }

        return res.json({
            count: issues.length,
            thresholds: {
                high_expense: Number(highExpenseThreshold.toFixed(2)),
                high_income: Number(highIncomeThreshold.toFixed(2))
            },
            items: issues
        });
    }

    const txns = await db.all(
        `SELECT t.id, t.amount, t.date, t.description, t.transaction_type, t.account_id, t.user_id,
                a.name as account_name, c.name as category_name
         FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = ?
         ORDER BY t.date DESC, t.id DESC`,
        [req.user.id]
    );

    const expenseRows = txns.filter(t => t.transaction_type === 'Expense');
    const incomeRows = txns.filter(t => t.transaction_type === 'Income');
    const avgExpense = expenseRows.length ? expenseRows.reduce((s, r) => s + Number(r.amount || 0), 0) / expenseRows.length : 0;
    const avgIncome = incomeRows.length ? incomeRows.reduce((s, r) => s + Number(r.amount || 0), 0) / incomeRows.length : 0;
    const highExpenseThreshold = Math.max(10000, avgExpense * 3);
    const highIncomeThreshold = Math.max(20000, avgIncome * 3);

    const duplicateRows = await db.all(
        `SELECT account_id, transaction_type, date, amount, LOWER(COALESCE(description, '')) as norm_desc, COUNT(1) as cnt
         FROM transactions
         WHERE user_id = ?
         GROUP BY account_id, transaction_type, date, amount, norm_desc
         HAVING COUNT(1) > 1`,
        [req.user.id]
    );
    const dupKeys = new Set(duplicateRows.map(r => `${r.account_id}|${r.transaction_type}|${r.date}|${Number(r.amount)}|${r.norm_desc}`));
    const overrideRows = await db.all(
        `SELECT transaction_id, issue_code
         FROM quality_issue_overrides
         WHERE user_id = ?`,
        [req.user.id]
    );
    const ignoredKeys = new Set(overrideRows.map(r => `${r.transaction_id}|${r.issue_code}`));
    const isIgnored = (transactionId, issueCode) => ignoredKeys.has(`${transactionId}|${issueCode}`);

    const now = new Date();
    const maxFuture = new Date(now);
    maxFuture.setDate(maxFuture.getDate() + 1);
    const minPast = new Date(now);
    minPast.setFullYear(minPast.getFullYear() - 10);

    const issues = [];
    for (const t of txns) {
        const itemIssues = [];
        const amount = Number(t.amount || 0);
        if (t.transaction_type === 'Expense' && amount >= highExpenseThreshold && !isIgnored(t.id, 'high_expense_amount')) {
            itemIssues.push(`Very high expense amount (${amount.toFixed(2)})`);
        }
        if (t.transaction_type === 'Income' && amount >= highIncomeThreshold && !isIgnored(t.id, 'high_income_amount')) {
            itemIssues.push(`Very high income amount (${amount.toFixed(2)})`);
        }

        const dt = new Date(t.date);
        if ((Number.isNaN(dt.getTime()) || dt > maxFuture || dt < minPast) && !isIgnored(t.id, 'suspicious_date')) {
            itemIssues.push('Suspicious transaction date');
        }

        const dKey = `${t.account_id}|${t.transaction_type}|${t.date}|${Number(t.amount)}|${String(t.description || '').toLowerCase()}`;
        if (dupKeys.has(dKey) && !isIgnored(t.id, 'possible_duplicate')) {
            itemIssues.push('Possible duplicate transaction');
        }

        if (itemIssues.length) {
            issues.push({
                transaction_id: t.id,
                amount: amount,
                date: t.date,
                description: t.description,
                transaction_type: t.transaction_type,
                account_name: t.account_name,
                category_name: t.category_name,
                issues: itemIssues
            });
        }
    }

    res.json({
        count: issues.length,
        thresholds: {
            high_expense: Number(highExpenseThreshold.toFixed(2)),
            high_income: Number(highIncomeThreshold.toFixed(2))
        },
        items: issues
    });
});

app.post('/api/transactions/:id/quality-ignore', async (req, res) => {
    const txId = Number(req.params.id);
    const issueCode = String(req.body?.issue_code || '');
    const allowedIssueCodes = new Set(['possible_duplicate', 'suspicious_date', 'high_expense_amount', 'high_income_amount']);

    if (!Number.isInteger(txId) || txId <= 0) {
        return res.status(400).json({ error: 'Invalid transaction id' });
    }
    if (!allowedIssueCodes.has(issueCode)) {
        return res.status(400).json({ error: 'Invalid issue code' });
    }

    const owned = canUseMongo()
        ? await models.Transaction.findOne({ id: txId, user_id: req.user.id }, { id: 1, _id: 0 }).lean()
        : await db.get('SELECT id FROM transactions WHERE id = ? AND user_id = ?', [txId, req.user.id]);
    if (!owned) {
        return res.status(404).json({ error: 'Transaction not found' });
    }

    if (canUseMongo()) {
        const existing = await models.QualityIssueOverride.findOne({ user_id: req.user.id, transaction_id: txId, issue_code: issueCode }, { id: 1, _id: 0 }).lean();
        if (!existing) {
            const id = await getNextId('quality_issue_overrides');
            await models.QualityIssueOverride.create({ id, user_id: req.user.id, transaction_id: txId, issue_code: issueCode, created_at: new Date().toISOString() });
        }
        return res.json({ ok: true, transaction_id: txId, issue_code: issueCode });
    }

    await db.run(
        `INSERT OR IGNORE INTO quality_issue_overrides (user_id, transaction_id, issue_code)
         VALUES (?, ?, ?)`,
        [req.user.id, txId, issueCode]
    );

    res.json({ ok: true, transaction_id: txId, issue_code: issueCode });
});

app.post('/api/transactions', async (req, res) => {
    const { account_id, to_account_id, category_id, amount, date, description, type, receipt_url, tag, split_items } = req.body;
    try {
        if (canUseMongo()) {
            const sourceId = Number(account_id);
            const ownedSource = await models.Account.findOne({ id: sourceId, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
            if (!ownedSource) return res.status(403).json({ error: 'No permission on account' });

            const amt = Number(amount || 0);
            let iId;
            if (type === 'Transfer') {
                const targetId = Number(to_account_id);
                const ownedTarget = await models.Account.findOne({ id: targetId, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
                if (!ownedTarget) return res.status(403).json({ error: 'No permission on destination account' });
                iId = await getNextId('transactions');
                await models.Transaction.create({
                    id: iId,
                    user_id: req.user.id,
                    account_id: sourceId,
                    to_account_id: targetId,
                    amount: amt,
                    date,
                    description,
                    transaction_type: type,
                    receipt_url,
                    tag: tag || null,
                    created_at: new Date().toISOString(),
                    category_id: null
                });
                await adjustMongoAccountBalance(sourceId, -amt);
                await adjustMongoAccountBalance(targetId, amt);
            } else if (Array.isArray(split_items) && split_items.length > 0) {
                const totalAmount = split_items.reduce((s, it) => s + Number(it.amount || 0), 0);
                iId = await getNextId('transactions');
                await models.Transaction.create({
                    id: iId,
                    user_id: req.user.id,
                    account_id: sourceId,
                    category_id: null,
                    amount: totalAmount,
                    date,
                    description,
                    transaction_type: type,
                    receipt_url,
                    tag: tag || null,
                    created_at: new Date().toISOString()
                });
                for (const it of split_items) {
                    const splitId = await getNextId('transaction_splits');
                    await models.TransactionSplit.create({ id: splitId, transaction_id: iId, category_id: it.category_id || null, amount: Number(it.amount || 0), tag: it.tag || null });
                }
                await adjustMongoAccountBalance(sourceId, type === 'Income' ? totalAmount : -totalAmount);
            } else {
                iId = await getNextId('transactions');
                await models.Transaction.create({
                    id: iId,
                    user_id: req.user.id,
                    account_id: sourceId,
                    category_id: category_id || null,
                    amount: amt,
                    date,
                    description,
                    transaction_type: type,
                    receipt_url,
                    tag: tag || null,
                    created_at: new Date().toISOString(),
                    to_account_id: null
                });
                await adjustMongoAccountBalance(sourceId, type === 'Income' ? amt : -amt);
            }

            const created = await models.Transaction.findOne({ id: iId }, { _id: 0 }).lean();
            await saveAction(req.user.id, 'create', 'transaction', iId, null, created);
            return res.status(201).json({ id: iId });
        }

        const ownedSource = await db.get('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [account_id, req.user.id]);
        if (!ownedSource) return res.status(403).json({ error: 'No permission on account' });
        if (type === 'Transfer') {
            const ownedTarget = await db.get('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [to_account_id, req.user.id]);
            if (!ownedTarget) return res.status(403).json({ error: 'No permission on destination account' });
        }

        await db.run('BEGIN TRANSACTION');
        let iId;
        if (type === 'Transfer') {
            const r = await db.run('INSERT INTO transactions (user_id, account_id, to_account_id, amount, date, description, transaction_type, receipt_url, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.user.id, account_id, to_account_id, amount, date, description, type, receipt_url, tag || null]);
            iId = r.lastID;
            await db.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [amount, account_id]);
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [amount, to_account_id]);
        } else if (Array.isArray(split_items) && split_items.length > 0) {
            const totalAmount = split_items.reduce((s, it) => s + Number(it.amount || 0), 0);
            const r = await db.run('INSERT INTO transactions (user_id, account_id, category_id, amount, date, description, transaction_type, receipt_url, tag) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)', [req.user.id, account_id, totalAmount, date, description, type, receipt_url, tag || null]);
            iId = r.lastID;
            for (const it of split_items) {
                await db.run('INSERT INTO transaction_splits (transaction_id, category_id, amount, tag) VALUES (?, ?, ?, ?)', [iId, it.category_id || null, Number(it.amount || 0), it.tag || null]);
            }
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [type === 'Income' ? totalAmount : -totalAmount, account_id]);
        } else {
            const r = await db.run('INSERT INTO transactions (user_id, account_id, category_id, amount, date, description, transaction_type, receipt_url, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.user.id, account_id, category_id, amount, date, description, type, receipt_url, tag || null]);
            iId = r.lastID;
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [type === 'Income' ? amount : -amount, account_id]);
        }
        await db.run('COMMIT');
        const created = await db.get('SELECT * FROM transactions WHERE id = ?', [iId]);
        await saveAction(req.user.id, 'create', 'transaction', iId, null, created);
        res.status(201).json({ id: iId });
    } catch (e) { await db.run('ROLLBACK'); res.status(400).json({ error: e.message }); }
});
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        if (canUseMongo()) {
            const txId = Number(req.params.id);
            const oldTx = await models.Transaction.findOne({ id: txId, user_id: req.user.id }, { _id: 0 }).lean();
            if (!oldTx) throw new Error('Transaction not found');
            if (isProtectedSystemTransaction(oldTx)) throw new Error('System-generated transactions cannot be deleted');

            if (oldTx.transaction_type === 'Transfer') {
                await adjustMongoAccountBalance(oldTx.account_id, Number(oldTx.amount || 0));
                await adjustMongoAccountBalance(oldTx.to_account_id, -Number(oldTx.amount || 0));
            } else {
                await adjustMongoAccountBalance(oldTx.account_id, oldTx.transaction_type === 'Income' ? -Number(oldTx.amount || 0) : Number(oldTx.amount || 0));
            }

            await saveAction(req.user.id, 'delete', 'transaction', oldTx.id, oldTx, null);
            await models.TransactionSplit.deleteMany({ transaction_id: txId });
            await models.Transaction.deleteOne({ id: txId, user_id: req.user.id });
            return res.json({ success: true });
        }

        await db.run('BEGIN TRANSACTION');
        const oldTx = await db.get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!oldTx) throw new Error("Transaction not found");
        if (isProtectedSystemTransaction(oldTx)) throw new Error('System-generated transactions cannot be deleted');
        if (oldTx.transaction_type === 'Transfer') {
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [oldTx.amount, oldTx.account_id]);
            await db.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [oldTx.amount, oldTx.to_account_id]);
        } else {
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [oldTx.transaction_type === 'Income' ? -oldTx.amount : oldTx.amount, oldTx.account_id]);
        }
        await saveAction(req.user.id, 'delete', 'transaction', oldTx.id, oldTx, null);
        await db.run('DELETE FROM transactions WHERE id = ?', [req.params.id]);
        await db.run('COMMIT');
        res.json({ success: true });
    } catch (e) { await db.run('ROLLBACK'); res.status(400).json({ error: e.message }); }
});
app.put('/api/transactions/:id', async (req, res) => {
    const { account_id, to_account_id, category_id, amount, date, description, type, receipt_url, tag, split_items } = req.body;
    try {
        if (canUseMongo()) {
            const txId = Number(req.params.id);
            const oldTx = await models.Transaction.findOne({ id: txId, user_id: req.user.id }, { _id: 0 }).lean();
            if (!oldTx) throw new Error('Transaction not found');
            if (isProtectedSystemTransaction(oldTx)) throw new Error('System-generated transactions cannot be edited');
            const oldSplits = await models.TransactionSplit.find({ transaction_id: txId }, { _id: 0 }).lean();

            const sourceId = Number(account_id);
            const ownedSource = await models.Account.findOne({ id: sourceId, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
            if (!ownedSource) throw new Error('No permission on account');
            if (type === 'Transfer') {
                const ownedTarget = await models.Account.findOne({ id: Number(to_account_id), user_id: req.user.id }, { id: 1, _id: 0 }).lean();
                if (!ownedTarget) throw new Error('No permission on destination account');
            }

            if (oldTx.transaction_type === 'Transfer') {
                await adjustMongoAccountBalance(oldTx.account_id, Number(oldTx.amount || 0));
                await adjustMongoAccountBalance(oldTx.to_account_id, -Number(oldTx.amount || 0));
            } else {
                await adjustMongoAccountBalance(oldTx.account_id, oldTx.transaction_type === 'Income' ? -Number(oldTx.amount || 0) : Number(oldTx.amount || 0));
            }

            await models.TransactionSplit.deleteMany({ transaction_id: txId });
            const amt = Number(amount || 0);
            let payload;
            if (type === 'Transfer') {
                payload = {
                    account_id: sourceId,
                    to_account_id: Number(to_account_id),
                    category_id: null,
                    amount: amt,
                    date,
                    description,
                    transaction_type: type,
                    receipt_url,
                    tag: tag || null
                };
                await adjustMongoAccountBalance(sourceId, -amt);
                await adjustMongoAccountBalance(Number(to_account_id), amt);
            } else if (Array.isArray(split_items) && split_items.length > 0) {
                const totalAmount = split_items.reduce((s, it) => s + Number(it.amount || 0), 0);
                payload = {
                    account_id: sourceId,
                    to_account_id: null,
                    category_id: null,
                    amount: totalAmount,
                    date,
                    description,
                    transaction_type: type,
                    receipt_url,
                    tag: tag || null
                };
                for (const it of split_items) {
                    const splitId = await getNextId('transaction_splits');
                    await models.TransactionSplit.create({ id: splitId, transaction_id: txId, category_id: it.category_id || null, amount: Number(it.amount || 0), tag: it.tag || null });
                }
                await adjustMongoAccountBalance(sourceId, type === 'Income' ? totalAmount : -totalAmount);
            } else {
                payload = {
                    account_id: sourceId,
                    to_account_id: null,
                    category_id: category_id || null,
                    amount: amt,
                    date,
                    description,
                    transaction_type: type,
                    receipt_url,
                    tag: tag || null
                };
                await adjustMongoAccountBalance(sourceId, type === 'Income' ? amt : -amt);
            }

            await models.Transaction.updateOne({ id: txId, user_id: req.user.id }, { $set: payload });
            const newTx = await models.Transaction.findOne({ id: txId }, { _id: 0 }).lean();
            const newSplits = await models.TransactionSplit.find({ transaction_id: txId }, { _id: 0 }).lean();
            await saveAction(req.user.id, 'update', 'transaction', oldTx.id, { ...oldTx, splits: oldSplits }, { ...newTx, splits: newSplits });
            return res.json({ success: true });
        }

        await db.run('BEGIN TRANSACTION');
        const oldTx = await db.get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!oldTx) throw new Error("Transaction not found");
        if (isProtectedSystemTransaction(oldTx)) throw new Error('System-generated transactions cannot be edited');
        const oldSplits = await db.all('SELECT * FROM transaction_splits WHERE transaction_id = ?', [req.params.id]);
        const ownedSource = await db.get('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [account_id, req.user.id]);
        if (!ownedSource) throw new Error('No permission on account');
        if (type === 'Transfer') {
            const ownedTarget = await db.get('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [to_account_id, req.user.id]);
            if (!ownedTarget) throw new Error('No permission on destination account');
        }
        // Revert old transaction balance changes
        if (oldTx.transaction_type === 'Transfer') {
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [oldTx.amount, oldTx.account_id]);
            await db.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [oldTx.amount, oldTx.to_account_id]);
        } else {
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [oldTx.transaction_type === 'Income' ? -oldTx.amount : oldTx.amount, oldTx.account_id]);
        }
        await db.run('DELETE FROM transaction_splits WHERE transaction_id = ?', [req.params.id]);
        // Apply new transaction balance changes
        if (type === 'Transfer') {
            await db.run('UPDATE transactions SET account_id=?, to_account_id=?, category_id=NULL, amount=?, date=?, description=?, transaction_type=?, receipt_url=?, tag=? WHERE id=?', [account_id, to_account_id, amount, date, description, type, receipt_url, tag || null, req.params.id]);
            await db.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [amount, account_id]);
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [amount, to_account_id]);
        } else if (Array.isArray(split_items) && split_items.length > 0) {
            const totalAmount = split_items.reduce((s, it) => s + Number(it.amount || 0), 0);
            await db.run('UPDATE transactions SET account_id=?, to_account_id=NULL, category_id=NULL, amount=?, date=?, description=?, transaction_type=?, receipt_url=?, tag=? WHERE id=?', [account_id, totalAmount, date, description, type, receipt_url, tag || null, req.params.id]);
            for (const it of split_items) {
                await db.run('INSERT INTO transaction_splits (transaction_id, category_id, amount, tag) VALUES (?, ?, ?, ?)', [req.params.id, it.category_id || null, Number(it.amount || 0), it.tag || null]);
            }
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [type === 'Income' ? totalAmount : -totalAmount, account_id]);
        } else {
            await db.run('UPDATE transactions SET account_id=?, to_account_id=NULL, category_id=?, amount=?, date=?, description=?, transaction_type=?, receipt_url=?, tag=? WHERE id=?', [account_id, category_id, amount, date, description, type, receipt_url, tag || null, req.params.id]);
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [type === 'Income' ? amount : -amount, account_id]);
        }
        const newTx = await db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
        const newSplits = await db.all('SELECT * FROM transaction_splits WHERE transaction_id = ?', [req.params.id]);
        await saveAction(req.user.id, 'update', 'transaction', oldTx.id, { ...oldTx, splits: oldSplits }, { ...newTx, splits: newSplits });
        await db.run('COMMIT');
        res.json({ success: true });
    } catch (e) { await db.run('ROLLBACK'); res.status(400).json({ error: e.message }); }
});

app.post('/api/transactions/bulk-delete', async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.json({ success: true, count: 0 });

    if (canUseMongo()) {
        let count = 0;
        for (const id of ids.map(Number)) {
            const tx = await models.Transaction.findOne({ id, user_id: req.user.id }, { _id: 0 }).lean();
            if (!tx) continue;
            if (isProtectedSystemTransaction(tx)) continue;
            if (tx.transaction_type === 'Transfer') {
                await adjustMongoAccountBalance(tx.account_id, Number(tx.amount || 0));
                await adjustMongoAccountBalance(tx.to_account_id, -Number(tx.amount || 0));
            } else {
                await adjustMongoAccountBalance(tx.account_id, tx.transaction_type === 'Income' ? -Number(tx.amount || 0) : Number(tx.amount || 0));
            }
            await saveAction(req.user.id, 'delete', 'transaction', tx.id, tx, null);
            await models.TransactionSplit.deleteMany({ transaction_id: id });
            await models.Transaction.deleteOne({ id, user_id: req.user.id });
            count += 1;
        }
        return res.json({ success: true, count });
    }

    let count = 0;
    for (const id of ids) {
        const tx = await db.get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (!tx) continue;
        if (isProtectedSystemTransaction(tx)) continue;
        if (tx.transaction_type === 'Transfer') {
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [tx.amount, tx.account_id]);
            await db.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [tx.amount, tx.to_account_id]);
        } else {
            await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [tx.transaction_type === 'Income' ? -tx.amount : tx.amount, tx.account_id]);
        }
        await saveAction(req.user.id, 'delete', 'transaction', tx.id, tx, null);
        await db.run('DELETE FROM transactions WHERE id = ? AND user_id = ?', [id, req.user.id]);
        count += 1;
    }
    res.json({ success: true, count });
});

app.post('/api/transactions/bulk-tag', async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const tag = String(req.body.tag || '').trim();
    if (!ids.length) return res.json({ success: true, count: 0 });

    if (canUseMongo()) {
        let count = 0;
        for (const id of ids.map(Number)) {
            const oldTx = await models.Transaction.findOne({ id, user_id: req.user.id }, { _id: 0 }).lean();
            if (!oldTx) continue;
            if (isProtectedSystemTransaction(oldTx)) continue;
            await models.Transaction.updateOne({ id, user_id: req.user.id }, { $set: { tag: tag || null } });
            const newTx = await models.Transaction.findOne({ id }, { _id: 0 }).lean();
            await saveAction(req.user.id, 'update', 'transaction', oldTx.id, oldTx, newTx);
            count += 1;
        }
        return res.json({ success: true, count });
    }

    let count = 0;
    for (const id of ids) {
        const oldTx = await db.get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (!oldTx) continue;
        if (isProtectedSystemTransaction(oldTx)) continue;
        await db.run('UPDATE transactions SET tag = ? WHERE id = ? AND user_id = ?', [tag || null, id, req.user.id]);
        const newTx = await db.get('SELECT * FROM transactions WHERE id = ?', [id]);
        await saveAction(req.user.id, 'update', 'transaction', oldTx.id, oldTx, newTx);
        count += 1;
    }
    res.json({ success: true, count });
});

app.post('/api/transactions/undo-last', async (req, res) => {
    if (canUseMongo()) {
        const last = await models.ActionHistory.findOne({ user_id: req.user.id, entity_type: 'transaction' }, { _id: 0 }).sort({ id: -1 }).lean();
        if (!last) return res.status(404).json({ error: 'No undo action available.' });

        const oldData = parseJSON(last.old_data, null);
        const newData = parseJSON(last.new_data, null);
        try {
            if (last.action_type === 'delete' && oldData) {
                await models.Transaction.updateOne(
                    { id: oldData.id },
                    {
                        $set: {
                            id: oldData.id,
                            user_id: oldData.user_id,
                            amount: oldData.amount,
                            date: oldData.date,
                            description: oldData.description,
                            transaction_type: oldData.transaction_type,
                            category_id: oldData.category_id,
                            account_id: oldData.account_id,
                            to_account_id: oldData.to_account_id,
                            receipt_url: oldData.receipt_url,
                            created_at: oldData.created_at,
                            tag: oldData.tag || null
                        }
                    },
                    { upsert: true }
                );
                if (oldData.transaction_type === 'Transfer') {
                    await adjustMongoAccountBalance(oldData.account_id, -Number(oldData.amount || 0));
                    await adjustMongoAccountBalance(oldData.to_account_id, Number(oldData.amount || 0));
                } else {
                    await adjustMongoAccountBalance(oldData.account_id, oldData.transaction_type === 'Income' ? Number(oldData.amount || 0) : -Number(oldData.amount || 0));
                }
            } else if (last.action_type === 'update' && oldData) {
                if (newData?.transaction_type === 'Transfer') {
                    await adjustMongoAccountBalance(newData.account_id, Number(newData.amount || 0));
                    await adjustMongoAccountBalance(newData.to_account_id, -Number(newData.amount || 0));
                } else if (newData) {
                    await adjustMongoAccountBalance(newData.account_id, newData.transaction_type === 'Income' ? -Number(newData.amount || 0) : Number(newData.amount || 0));
                }

                await models.Transaction.updateOne(
                    { id: oldData.id, user_id: req.user.id },
                    {
                        $set: {
                            amount: oldData.amount,
                            date: oldData.date,
                            description: oldData.description,
                            transaction_type: oldData.transaction_type,
                            category_id: oldData.category_id,
                            account_id: oldData.account_id,
                            to_account_id: oldData.to_account_id,
                            receipt_url: oldData.receipt_url,
                            tag: oldData.tag || null
                        }
                    }
                );
                await models.TransactionSplit.deleteMany({ transaction_id: oldData.id });
                for (const s of (oldData.splits || [])) {
                    const sid = await getNextId('transaction_splits');
                    await models.TransactionSplit.create({ id: sid, transaction_id: oldData.id, category_id: s.category_id || null, amount: s.amount, tag: s.tag || null });
                }
                if (oldData.transaction_type === 'Transfer') {
                    await adjustMongoAccountBalance(oldData.account_id, -Number(oldData.amount || 0));
                    await adjustMongoAccountBalance(oldData.to_account_id, Number(oldData.amount || 0));
                } else {
                    await adjustMongoAccountBalance(oldData.account_id, oldData.transaction_type === 'Income' ? Number(oldData.amount || 0) : -Number(oldData.amount || 0));
                }
            }

            await models.ActionHistory.deleteOne({ id: last.id });
            return res.json({ success: true });
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    }

    const last = await db.get('SELECT * FROM action_history WHERE user_id = ? AND entity_type = ? ORDER BY id DESC LIMIT 1', [req.user.id, 'transaction']);
    if (!last) return res.status(404).json({ error: 'No undo action available.' });

    const oldData = parseJSON(last.old_data, null);
    const newData = parseJSON(last.new_data, null);
    await db.run('BEGIN TRANSACTION');
    try {
        if (last.action_type === 'delete' && oldData) {
            await db.run('INSERT INTO transactions (id, user_id, amount, date, description, transaction_type, category_id, account_id, to_account_id, receipt_url, created_at, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [oldData.id, oldData.user_id, oldData.amount, oldData.date, oldData.description, oldData.transaction_type, oldData.category_id, oldData.account_id, oldData.to_account_id, oldData.receipt_url, oldData.created_at, oldData.tag || null]);
            if (oldData.transaction_type === 'Transfer') {
                await db.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [oldData.amount, oldData.account_id]);
                await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [oldData.amount, oldData.to_account_id]);
            } else {
                await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [oldData.transaction_type === 'Income' ? oldData.amount : -oldData.amount, oldData.account_id]);
            }
        } else if (last.action_type === 'update' && oldData) {
            if (newData?.transaction_type === 'Transfer') {
                await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [newData.amount, newData.account_id]);
                await db.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [newData.amount, newData.to_account_id]);
            } else if (newData) {
                await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [newData.transaction_type === 'Income' ? -newData.amount : newData.amount, newData.account_id]);
            }
            await db.run('UPDATE transactions SET amount = ?, date = ?, description = ?, transaction_type = ?, category_id = ?, account_id = ?, to_account_id = ?, receipt_url = ?, tag = ? WHERE id = ? AND user_id = ?', [oldData.amount, oldData.date, oldData.description, oldData.transaction_type, oldData.category_id, oldData.account_id, oldData.to_account_id, oldData.receipt_url, oldData.tag || null, oldData.id, req.user.id]);
            await db.run('DELETE FROM transaction_splits WHERE transaction_id = ?', [oldData.id]);
            for (const s of (oldData.splits || [])) {
                await db.run('INSERT INTO transaction_splits (transaction_id, category_id, amount, tag) VALUES (?, ?, ?, ?)', [oldData.id, s.category_id || null, s.amount, s.tag || null]);
            }
            if (oldData.transaction_type === 'Transfer') {
                await db.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [oldData.amount, oldData.account_id]);
                await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [oldData.amount, oldData.to_account_id]);
            } else {
                await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [oldData.transaction_type === 'Income' ? oldData.amount : -oldData.amount, oldData.account_id]);
            }
        }
        await db.run('DELETE FROM action_history WHERE id = ?', [last.id]);
        await db.run('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await db.run('ROLLBACK');
        res.status(400).json({ error: e.message });
    }
});

// --- SUBSCRIPTIONS ---
app.get('/api/subscriptions', async (req, res) => {
    if (canUseMongo()) {
        const [subs, accounts, categories] = await Promise.all([
            models.Subscription.find({ user_id: req.user.id }, { _id: 0 }).lean(),
            models.Account.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean(),
            models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
        ]);
        const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
        const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
        return res.json(subs.map((s) => ({ ...s, account_name: accountMap.get(s.account_id) || null, category_name: categoryMap.get(s.category_id) || null })));
    }
    const q = `SELECT s.*, a.name as account_name, c.name as category_name FROM subscriptions s 
               LEFT JOIN accounts a ON s.account_id = a.id LEFT JOIN categories c ON s.category_id = c.id WHERE s.user_id = ?`;
    res.json(await db.all(q, [req.user.id]));
});
app.post('/api/subscriptions', async (req, res) => {
    const { account_id, category_id, name, amount, type, frequency, next_date } = req.body;
    if (canUseMongo()) {
        const id = await getNextId('subscriptions');
        await models.Subscription.create({ id, user_id: req.user.id, account_id, category_id, name, amount, type, frequency, next_date });
        return res.json({ id });
    }
    const r = await db.run('INSERT INTO subscriptions (user_id, account_id, category_id, name, amount, type, frequency, next_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [req.user.id, account_id, category_id, name, amount, type, frequency, next_date]);
    res.json({ id: r.lastID });
});
app.put('/api/subscriptions/:id', async (req, res) => {
    const { account_id, category_id, name, amount, type, frequency, next_date } = req.body;
    if (canUseMongo()) {
        await models.Subscription.updateOne(
            { id: Number(req.params.id), user_id: req.user.id },
            { $set: { account_id, category_id, name, amount, type, frequency, next_date } }
        );
        return res.json({ success: true });
    }
    await db.run(
        `UPDATE subscriptions
         SET account_id = ?, category_id = ?, name = ?, amount = ?, type = ?, frequency = ?, next_date = ?
         WHERE id = ? AND user_id = ?`,
        [account_id, category_id, name, amount, type, frequency, next_date, req.params.id, req.user.id]
    );
    res.json({ success: true });
});
app.delete('/api/subscriptions/:id', async (req, res) => {
    if (canUseMongo()) {
        await models.Subscription.deleteOne({ id: Number(req.params.id), user_id: req.user.id });
        return res.json({ success: true });
    }
    await db.run('DELETE FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
});

// --- ANALYTICS ---
app.get('/api/analytics', async (req, res) => {
    if (canUseMongo()) {
        const rows = await models.Transaction.find({ user_id: req.user.id, transaction_type: { $ne: 'Transfer' } }, { _id: 0, date: 1, amount: 1, transaction_type: 1 }).lean();
        const monthMap = new Map();
        for (const r of rows) {
            const month = String(r.date || '').slice(0, 7);
            if (!monthMap.has(month)) monthMap.set(month, { month, income: 0, expense: 0 });
            const item = monthMap.get(month);
            if (r.transaction_type === 'Income') item.income += Number(r.amount || 0);
            if (r.transaction_type === 'Expense') item.expense += Number(r.amount || 0);
        }
        return res.json([...monthMap.values()].sort((a, b) => String(a.month).localeCompare(String(b.month))).slice(-12));
    }
    const query = `
        SELECT substr(date, 1, 7) as month, 
        SUM(CASE WHEN transaction_type = 'Income' THEN amount ELSE 0 END) as income,
        SUM(CASE WHEN transaction_type = 'Expense' THEN amount ELSE 0 END) as expense
        FROM transactions WHERE user_id = ? AND transaction_type != 'Transfer'
        GROUP BY month ORDER BY month ASC LIMIT 12
    `;
    res.json(await db.all(query, [req.user.id]));
});

app.get('/api/analytics/forecast', async (req, res) => {
    if (canUseMongo()) {
        const rows = await models.Transaction.find({ user_id: req.user.id, transaction_type: { $ne: 'Transfer' } }, { _id: 0, date: 1, amount: 1, transaction_type: 1 }).lean();
        const monthMap = new Map();
        for (const r of rows) {
            const month = String(r.date || '').slice(0, 7);
            if (!monthMap.has(month)) monthMap.set(month, { month, income: 0, expense: 0 });
            const item = monthMap.get(month);
            if (r.transaction_type === 'Income') item.income += Number(r.amount || 0);
            if (r.transaction_type === 'Expense') item.expense += Number(r.amount || 0);
        }
        const monthly = [...monthMap.values()].sort((a, b) => String(b.month).localeCompare(String(a.month))).slice(0, 3);
        if (!monthly.length) return res.json({ forecast_income: 0, forecast_expense: 0, forecast_savings: 0, based_on_months: 0 });
        const avgIncome = monthly.reduce((s, m) => s + Number(m.income || 0), 0) / monthly.length;
        const avgExpense = monthly.reduce((s, m) => s + Number(m.expense || 0), 0) / monthly.length;
        return res.json({
            forecast_income: Number(avgIncome.toFixed(2)),
            forecast_expense: Number(avgExpense.toFixed(2)),
            forecast_savings: Number((avgIncome - avgExpense).toFixed(2)),
            based_on_months: monthly.length
        });
    }

    const monthly = await db.all(
        `SELECT substr(date, 1, 7) as month,
                SUM(CASE WHEN transaction_type = 'Income' THEN amount ELSE 0 END) as income,
                SUM(CASE WHEN transaction_type = 'Expense' THEN amount ELSE 0 END) as expense
         FROM transactions
         WHERE user_id = ? AND transaction_type != 'Transfer'
         GROUP BY month
         ORDER BY month DESC
         LIMIT 3`,
        [req.user.id]
    );
    if (!monthly.length) return res.json({ forecast_income: 0, forecast_expense: 0, forecast_savings: 0, based_on_months: 0 });
    const avgIncome = monthly.reduce((s, m) => s + Number(m.income || 0), 0) / monthly.length;
    const avgExpense = monthly.reduce((s, m) => s + Number(m.expense || 0), 0) / monthly.length;
    res.json({
        forecast_income: Number(avgIncome.toFixed(2)),
        forecast_expense: Number(avgExpense.toFixed(2)),
        forecast_savings: Number((avgIncome - avgExpense).toFixed(2)),
        based_on_months: monthly.length
    });
});

app.get('/api/reminders', async (req, res) => {
    await runRecurringAutomationForUser(req.user.id);
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const monthPrefix = `${yyyy}-${mm}`;
    const reminders = [];

    const profile = canUseMongo()
        ? await models.User.findOne({ id: req.user.id }, { currency: 1, monthly_budget: 1, _id: 0 }).lean()
        : await db.get('SELECT currency, monthly_budget FROM users WHERE id = ?', [req.user.id]);
    const curr = profile?.currency || '$';

    const totalExpenseRow = canUseMongo()
        ? { total: (await models.Transaction.find({ user_id: req.user.id, transaction_type: 'Expense', date: { $regex: `^${escapeRegExp(monthPrefix)}` } }, { amount: 1, _id: 0 }).lean()).reduce((s, r) => s + Number(r.amount || 0), 0) }
        : await db.get(
            `SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id = ? AND transaction_type = 'Expense' AND substr(date,1,7) = ?`,
            [req.user.id, monthPrefix]
        );
    const totalExpense = Number(totalExpenseRow?.total || 0);
    const globalBudget = Number(profile?.monthly_budget || 0);

    if (globalBudget > 0) {
        const pct = (totalExpense / globalBudget) * 100;
        if (pct >= 100) reminders.push({ type: 'budget', level: 'danger', message: `Global budget exceeded: ${curr}${totalExpense.toFixed(0)} / ${curr}${globalBudget.toFixed(0)}` });
        else if (pct >= 80) reminders.push({ type: 'budget', level: 'warning', message: `Global budget at ${pct.toFixed(0)}%` });
    }

    const catBudgets = canUseMongo()
        ? await models.Category.find({ user_id: req.user.id, type: 'Expense', monthly_budget: { $gt: 0 } }, { _id: 0, id: 1, name: 1, monthly_budget: 1 }).lean()
        : await db.all('SELECT id, name, monthly_budget FROM categories WHERE user_id = ? AND type = ? AND monthly_budget > 0', [req.user.id, 'Expense']);
    for (const c of catBudgets) {
        const row = canUseMongo()
            ? { total: (await models.Transaction.find({ user_id: req.user.id, category_id: c.id, transaction_type: 'Expense', date: { $regex: `^${escapeRegExp(monthPrefix)}` } }, { amount: 1, _id: 0 }).lean()).reduce((s, r) => s + Number(r.amount || 0), 0) }
            : await db.get(
                `SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id = ? AND category_id = ? AND transaction_type = 'Expense' AND substr(date,1,7)=?`,
                [req.user.id, c.id, monthPrefix]
            );
        const spent = Number(row?.total || 0);
        const pct = (spent / Number(c.monthly_budget)) * 100;
        if (pct >= 100) reminders.push({ type: 'category_budget', level: 'danger', message: `${c.name} budget exceeded` });
        else if (pct >= 80) reminders.push({ type: 'category_budget', level: 'warning', message: `${c.name} budget at ${pct.toFixed(0)}%` });
    }

    const subs = canUseMongo()
        ? await models.Subscription.find({ user_id: req.user.id }, { _id: 0, name: 1, next_date: 1 }).lean()
        : await db.all('SELECT name, next_date FROM subscriptions WHERE user_id = ?', [req.user.id]);
    for (const s of subs) {
        const d = new Date(s.next_date);
        const diff = Math.ceil((d - now) / (1000 * 60 * 60 * 24));
        if (diff >= 0 && diff <= 3) reminders.push({ type: 'subscription', level: diff === 0 ? 'danger' : 'info', message: `${s.name} due in ${diff} day(s)` });
    }

    for (const r of reminders) {
        await addNotificationIfMissingToday(req.user.id, r.type, r.level, r.message);
    }

    res.json(reminders);
});

app.post('/api/automation/run-recurring', async (req, res) => {
    const processed = await runRecurringAutomationForUser(req.user.id);
    res.json({ success: true, processed });
});

app.get('/api/notifications', async (req, res) => {
    if (canUseMongo()) {
        const rows = await models.Notification.find({ user_id: req.user.id }, { _id: 0 }).sort({ created_at: -1, id: -1 }).limit(100).lean();
        return res.json(rows);
    }
    const rows = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [req.user.id]);
    res.json(rows);
});

app.put('/api/notifications/:id/read', async (req, res) => {
    if (canUseMongo()) {
        await models.Notification.updateOne({ id: Number(req.params.id), user_id: req.user.id }, { $set: { is_read: 1 } });
        return res.json({ success: true });
    }
    await db.run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
});

app.put('/api/notifications/read-all', async (req, res) => {
    if (canUseMongo()) {
        await models.Notification.updateMany({ user_id: req.user.id }, { $set: { is_read: 1 } });
        return res.json({ success: true });
    }
    await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
    res.json({ success: true });
});

app.delete('/api/notifications/clear', async (req, res) => {
    if (canUseMongo()) {
        await models.Notification.deleteMany({ user_id: req.user.id });
        return res.json({ success: true });
    }
    await db.run('DELETE FROM notifications WHERE user_id = ?', [req.user.id]);
    res.json({ success: true });
});

app.get('/api/migration/health', async (req, res) => {
    if (!canUseMongo()) {
        return res.status(503).json({ provider: dbProvider, mongoReady, ok: false, message: 'MongoDB is not ready.' });
    }

    const userId = req.user.id;
    const [
        users,
        accounts,
        categories,
        transactions,
        subscriptions,
        debts,
        investments,
        goals,
        notifications,
        filters,
        snapshots,
        reconciliations
    ] = await Promise.all([
        models.User.countDocuments({ id: userId }),
        models.Account.countDocuments({ user_id: userId }),
        models.Category.countDocuments({ user_id: userId }),
        models.Transaction.countDocuments({ user_id: userId }),
        models.Subscription.countDocuments({ user_id: userId }),
        models.Debt.countDocuments({ user_id: userId }),
        models.Investment.countDocuments({ user_id: userId }),
        models.Goal.countDocuments({ user_id: userId }),
        models.Notification.countDocuments({ user_id: userId }),
        models.SavedFilter.countDocuments({ user_id: userId }),
        models.BalanceSnapshot.countDocuments({ user_id: userId }),
        models.ReconciliationSession.countDocuments({ user_id: userId })
    ]);

    return res.json({
        ok: true,
        provider: 'mongodb',
        mongoReady,
        user_id: userId,
        counts: {
            users,
            accounts,
            categories,
            transactions,
            subscriptions,
            debts,
            investments,
            goals,
            notifications,
            filters,
            snapshots,
            reconciliations
        }
    });
});

// --- UPLOADS & IMPORT/EXPORT ---
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ url: `http://localhost:3001/uploads/${req.file.filename}` });
});

app.get('/api/export/csv', async (req, res) => {
    if (canUseMongo()) {
        const [txRows, accounts, categories] = await Promise.all([
            models.Transaction.find({ user_id: req.user.id }, { _id: 0 }).sort({ date: -1, id: -1 }).lean(),
            models.Account.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean(),
            models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
        ]);
        const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
        const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
        const data = txRows.map((t) => ({
            date: t.date,
            transaction_type: t.transaction_type,
            amount: t.amount,
            description: t.description,
            account_name: accountMap.get(t.account_id) || null,
            category_name: categoryMap.get(t.category_id) || null
        }));
        const parser = new Parser({ fields: ['date', 'transaction_type', 'amount', 'description', 'account_name', 'category_name'] });
        res.attachment('transactions.csv');
        return res.send(parser.parse(data));
    }

    const data = await db.all(`SELECT t.date, t.transaction_type, t.amount, t.description, a.name as account_name, c.name as category_name
        FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id LEFT JOIN categories c ON t.category_id = c.id WHERE t.user_id = ? ORDER BY t.date DESC`, [req.user.id]);
    const parser = new Parser({ fields: ['date', 'transaction_type', 'amount', 'description', 'account_name', 'category_name'] });
    res.attachment('transactions.csv'); res.send(parser.parse(data));
});

app.post('/api/import/csv', upload.single('csv'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv())
      .on('data', (d) => results.push(d))
      .on('end', async () => {
          if (canUseMongo()) {
              try {
                  let inserted = 0;
                  let skippedDuplicates = 0;

                  for (const row of results) {
                      let acc = await models.Account.findOne({ name: row.account_name, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
                      if (!acc && row.account_name) {
                          const accId = await getNextId('accounts');
                          await models.Account.create({ id: accId, user_id: req.user.id, name: row.account_name, type: 'Bank', balance: 0 });
                          acc = { id: accId };
                      }

                      let cat = await models.Category.findOne({ name: row.category_name, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
                      if (!cat && row.category_name && row.transaction_type !== 'Transfer') {
                          const catId = await getNextId('categories');
                          await models.Category.create({ id: catId, user_id: req.user.id, name: row.category_name, type: row.transaction_type, monthly_budget: 0 });
                          cat = { id: catId };
                      }

                      if (acc && row.amount) {
                          const amount = parseFloat(row.amount);
                          if (Number.isNaN(amount)) continue;
                          const dup = await models.Transaction.findOne({
                              user_id: req.user.id,
                              account_id: acc.id,
                              date: row.date,
                              amount,
                              transaction_type: row.transaction_type,
                              description: { $regex: `^${escapeRegExp(row.description || '')}$`, $options: 'i' }
                          }, { id: 1, _id: 0 }).lean();
                          if (dup) {
                              skippedDuplicates += 1;
                              continue;
                          }

                          const txId = await getNextId('transactions');
                          await models.Transaction.create({
                              id: txId,
                              user_id: req.user.id,
                              account_id: acc.id,
                              category_id: cat ? cat.id : null,
                              amount,
                              date: row.date,
                              description: row.description,
                              transaction_type: row.transaction_type,
                              to_account_id: null,
                              receipt_url: null,
                              tag: null,
                              created_at: new Date().toISOString()
                          });
                          const balanceChange = row.transaction_type === 'Income' ? amount : -amount;
                          await adjustMongoAccountBalance(acc.id, balanceChange);
                          inserted += 1;
                      }
                  }

                  return res.json({ success: true, count: inserted, total_rows: results.length, skipped_duplicates: skippedDuplicates });
              } catch (e) {
                  return res.status(400).json({ error: e.message });
              }
          }

          try {
              await db.run('BEGIN TRANSACTION');
              let inserted = 0;
              let skippedDuplicates = 0;
              for (let row of results) {
                  let acc = await db.get('SELECT id FROM accounts WHERE name = ? AND user_id = ?', [row.account_name, req.user.id]);
                  if (!acc && row.account_name) {
                      let ar = await db.run('INSERT INTO accounts (user_id, name, type) VALUES (?, ?, ?)', [req.user.id, row.account_name, 'Bank']);
                      acc = { id: ar.lastID };
                  }
                  let cat = await db.get('SELECT id FROM categories WHERE name = ? AND user_id = ?', [row.category_name, req.user.id]);
                  if (!cat && row.category_name && row.transaction_type !== 'Transfer') {
                       let cr = await db.run('INSERT INTO categories (user_id, name, type) VALUES (?, ?, ?)', [req.user.id, row.category_name, row.transaction_type]);
                       cat = { id: cr.lastID };
                  }
                  if (acc && row.amount) {
                      const amount = parseFloat(row.amount);
                      const dup = await db.get(
                        `SELECT id FROM transactions WHERE user_id = ? AND account_id = ? AND date = ? AND amount = ?
                         AND transaction_type = ? AND LOWER(COALESCE(description,'')) = LOWER(COALESCE(?,'')) LIMIT 1`,
                        [req.user.id, acc.id, row.date, amount, row.transaction_type, row.description || '']
                      );
                      if (dup) {
                          skippedDuplicates += 1;
                          continue;
                      }
                      await db.run('INSERT INTO transactions (user_id, account_id, category_id, amount, date, description, transaction_type) VALUES (?, ?, ?, ?, ?, ?, ?)', 
                      [req.user.id, acc.id, cat ? cat.id : null, amount, row.date, row.description, row.transaction_type]);
                      const balanceChange = row.transaction_type === 'Income' ? amount : -amount;
                      await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [balanceChange, acc.id]);
                      inserted += 1;
                  }
              }
              await db.run('COMMIT');
              res.json({ success: true, count: inserted, total_rows: results.length, skipped_duplicates: skippedDuplicates });
          } catch (e) { await db.run('ROLLBACK'); res.status(400).json({ error: e.message }); }
      });
});

app.put('/api/categories/:id/budget', authenticateToken, async (req, res) => {
    const { monthly_budget } = req.body;
    if (canUseMongo()) {
        await models.Category.updateOne({ id: Number(req.params.id), user_id: req.user.id }, { $set: { monthly_budget } });
        return res.json({ success: true });
    }
    await (await db).run("UPDATE categories SET monthly_budget = ? WHERE id = ? AND user_id = ?", [monthly_budget, req.params.id, req.user.id]);
    res.json({ success: true });
});

app.get('/api/debts', authenticateToken, async (req, res) => {
    if (canUseMongo()) {
        const rows = await models.Debt.find({ user_id: req.user.id }, { _id: 0 }).lean();
        return res.json(rows);
    }
    res.json(await (await db).all("SELECT * FROM debts WHERE user_id = ?", [req.user.id]));
});

app.post('/api/debts', authenticateToken, async (req, res) => {
    const { person_name, amount, type, due_date } = req.body;
    if (canUseMongo()) {
        const id = await getNextId('debts');
        await models.Debt.create({ id, user_id: req.user.id, person_name, amount, type, due_date, status: 'Pending' });
        return res.json({ success: true, id });
    }
    await (await db).run("INSERT INTO debts (user_id, person_name, amount, type, due_date) VALUES (?, ?, ?, ?, ?)", [req.user.id, person_name, amount, type, due_date]);
    res.json({ success: true });
});

app.put('/api/debts/:id/settle', authenticateToken, async (req, res) => {
    if (canUseMongo()) {
        await models.Debt.updateOne({ id: Number(req.params.id), user_id: req.user.id }, { $set: { status: 'Settled' } });
        return res.json({ success: true });
    }
    await (await db).run("UPDATE debts SET status = 'Settled' WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    res.json({ success: true });
});

app.get('/api/investments', async (req, res) => {
    if (canUseMongo()) {
        const rows = await models.Investment.find({ user_id: req.user.id }, { _id: 0 }).sort({ id: -1 }).lean();
        return res.json(rows);
    }
    const rows = await db.all('SELECT * FROM investments WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    res.json(rows);
});

app.post('/api/investments', async (req, res) => {
    const { name, type, current_value, cost_basis, date, notes } = req.body;
    let investmentDate = date;
    if (!investmentDate) {
        investmentDate = new Date().toISOString().split('T')[0];
    }
    if (canUseMongo()) {
        const id = await getNextId('investments');
        await models.Investment.create({
            id,
            user_id: req.user.id,
            name,
            type,
            current_value: current_value || 0,
            cost_basis: cost_basis || 0,
            date: investmentDate,
            notes: notes || null
        });
        return res.status(201).json({ id });
    }
    const r = await db.run(
        'INSERT INTO investments (user_id, name, type, current_value, cost_basis, date, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.user.id, name, type, current_value || 0, cost_basis || 0, investmentDate, notes || null]
    );
    res.status(201).json({ id: r.lastID });
});

app.put('/api/investments/:id', async (req, res) => {
    const { name, type, current_value, cost_basis, date, notes } = req.body;
    let investmentDate = date;
    if (!investmentDate) {
        investmentDate = new Date().toISOString().split('T')[0];
    }
    if (canUseMongo()) {
        await models.Investment.updateOne(
            { id: Number(req.params.id), user_id: req.user.id },
            { $set: { name, type, current_value: current_value || 0, cost_basis: cost_basis || 0, date: investmentDate, notes: notes || null } }
        );
        return res.json({ success: true });
    }
    await db.run(
        'UPDATE investments SET name = ?, type = ?, current_value = ?, cost_basis = ?, date = ?, notes = ? WHERE id = ? AND user_id = ?',
        [name, type, current_value || 0, cost_basis || 0, investmentDate, notes || null, req.params.id, req.user.id]
    );
    res.json({ success: true });
});

app.delete('/api/investments/:id', async (req, res) => {
    if (canUseMongo()) {
        await models.Investment.deleteOne({ id: Number(req.params.id), user_id: req.user.id });
        return res.json({ success: true });
    }
    await db.run('DELETE FROM investments WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
});

app.get('/api/goals', async (req, res) => {
    if (canUseMongo()) {
        const rows = await models.Goal.find({ user_id: req.user.id }, { _id: 0 }).sort({ id: -1 }).lean();
        return res.json(rows);
    }
    const rows = await db.all('SELECT * FROM goals WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    res.json(rows);
});

app.get('/api/goals/utilization-history', async (req, res) => {
    if (canUseMongo()) {
        const rows = await models.GoalUtilizationHistory.find({ user_id: req.user.id }, { _id: 0 }).sort({ id: -1 }).lean();
        const accountIds = [...new Set(rows.map((r) => r.account_id).filter(Boolean))];
        const accounts = accountIds.length
            ? await models.Account.find({ id: { $in: accountIds } }, { id: 1, name: 1, _id: 0 }).lean()
            : [];
        const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
        const mappedRows = rows.map((r) => ({ ...r, resolved_account_name: r.account_name || accountMap.get(r.account_id) || null }));
        const total_utilized = mappedRows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
        return res.json({ items: mappedRows, total_utilized: Number(total_utilized || 0) });
    }

    const rows = await db.all(
        `SELECT h.*, a.name as resolved_account_name
         FROM goal_utilization_history h
         LEFT JOIN accounts a ON h.account_id = a.id
         WHERE h.user_id = ?
         ORDER BY h.id DESC`,
        [req.user.id]
    );
    const totals = await db.get(
        `SELECT COALESCE(SUM(amount), 0) as total_utilized
         FROM goal_utilization_history WHERE user_id = ?`,
        [req.user.id]
    );
    res.json({ items: rows, total_utilized: Number(totals?.total_utilized || 0) });
});

app.post('/api/goals', async (req, res) => {
    const { title, target_amount, due_date } = req.body;
    const targetAmount = Number(target_amount || 0);
    if (targetAmount <= 0) return res.status(400).json({ error: 'Target amount must be greater than zero' });
    if (canUseMongo()) {
        const id = await getNextId('goals');
        await models.Goal.create({ id, user_id: req.user.id, title, target_amount: targetAmount, saved_amount: 0, due_date: due_date || null, status: 'Active' });
        return res.status(201).json({ id });
    }
    const r = await db.run(
        'INSERT INTO goals (user_id, title, target_amount, saved_amount, due_date) VALUES (?, ?, ?, 0, ?)',
        [req.user.id, title, targetAmount, due_date || null]
    );
    res.status(201).json({ id: r.lastID });
});

app.put('/api/goals/:id', async (req, res) => {
    const { title, target_amount, due_date } = req.body;
    const targetAmount = Number(target_amount || 0);
    if (targetAmount <= 0) return res.status(400).json({ error: 'Target amount must be greater than zero' });
    if (canUseMongo()) {
        const goal = await models.Goal.findOne({ id: Number(req.params.id), user_id: req.user.id });
        if (!goal) return res.status(404).json({ error: 'Goal not found' });
        goal.title = title;
        goal.target_amount = targetAmount;
        goal.due_date = due_date || null;
        goal.status = Number(goal.saved_amount || 0) >= targetAmount ? 'Completed' : 'Active';
        await goal.save();
        return res.json({ success: true });
    }
    await db.run(
        'UPDATE goals SET title = ?, target_amount = ?, due_date = ? WHERE id = ? AND user_id = ?',
        [title, targetAmount, due_date || null, req.params.id, req.user.id]
    );
    await db.run(
        "UPDATE goals SET status = CASE WHEN saved_amount >= target_amount THEN 'Completed' ELSE 'Active' END WHERE id = ? AND user_id = ?",
        [req.params.id, req.user.id]
    );
    res.json({ success: true });
});

app.put('/api/goals/:id/contribute', async (req, res) => {
    const { amount, account_id } = req.body;
    const contributeAmount = Number(amount || 0);
    if (contributeAmount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });

    if (canUseMongo()) {
        const goal = await models.Goal.findOne({ id: Number(req.params.id), user_id: req.user.id });
        if (!goal) return res.status(404).json({ error: 'Goal not found' });

        const account = await models.Account.findOne({ id: Number(account_id), user_id: req.user.id });
        if (!account) return res.status(403).json({ error: 'No permission on account' });
        if (Number(account.balance || 0) < contributeAmount) return res.status(400).json({ error: 'Insufficient account balance' });

        goal.saved_amount = Number(goal.saved_amount || 0) + contributeAmount;
        goal.status = Number(goal.saved_amount || 0) >= Number(goal.target_amount || 0) ? 'Completed' : 'Active';
        account.balance = Number(account.balance || 0) - contributeAmount;
        await goal.save();
        await account.save();

        const txId = await getNextId('transactions');
        await models.Transaction.create({
            id: txId,
            user_id: req.user.id,
            account_id: Number(account_id),
            category_id: null,
            amount: contributeAmount,
            date: new Date().toISOString().split('T')[0],
            description: `Goal Contribution: ${goal.title}`,
            transaction_type: 'Expense',
            tag: 'GoalContribution',
            created_at: new Date().toISOString()
        });
        return res.json({ success: true });
    }

    const goal = await db.get('SELECT id, title FROM goals WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });

    const account = await db.get('SELECT id, balance FROM accounts WHERE id = ? AND user_id = ?', [account_id, req.user.id]);
    if (!account) return res.status(403).json({ error: 'No permission on account' });
    if (Number(account.balance || 0) < contributeAmount) return res.status(400).json({ error: 'Insufficient account balance' });

    try {
        await db.run('BEGIN TRANSACTION');
        await db.run('UPDATE goals SET saved_amount = saved_amount + ? WHERE id = ? AND user_id = ?', [contributeAmount, req.params.id, req.user.id]);
        await db.run("UPDATE goals SET status = CASE WHEN saved_amount >= target_amount THEN 'Completed' ELSE 'Active' END WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
        await db.run('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?', [contributeAmount, account_id, req.user.id]);
        await db.run(
            'INSERT INTO transactions (user_id, account_id, category_id, amount, date, description, transaction_type, tag) VALUES (?, ?, NULL, ?, date("now", "localtime"), ?, ?, ?)',
            [req.user.id, account_id, contributeAmount, `Goal Contribution: ${goal.title}`, 'Expense', 'GoalContribution']
        );
        await db.run('COMMIT');
        res.json({ success: true });
    } catch (error) {
        await db.run('ROLLBACK');
        console.error(error);
        res.status(500).json({ error: 'Failed to contribute to goal' });
    }
});

app.put('/api/goals/:id/withdraw', async (req, res) => {
    const { amount, account_id } = req.body;
    const withdrawAmount = Number(amount || 0);
    if (withdrawAmount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });

    if (canUseMongo()) {
        const goal = await models.Goal.findOne({ id: Number(req.params.id), user_id: req.user.id });
        if (!goal) return res.status(404).json({ error: 'Goal not found' });
        if (Number(goal.saved_amount || 0) < withdrawAmount) return res.status(400).json({ error: 'Insufficient goal balance' });

        const account = await models.Account.findOne({ id: Number(account_id), user_id: req.user.id });
        if (!account) return res.status(403).json({ error: 'No permission on account' });

        goal.saved_amount = Number(goal.saved_amount || 0) - withdrawAmount;
        goal.status = Number(goal.saved_amount || 0) >= Number(goal.target_amount || 0) ? 'Completed' : 'Active';
        account.balance = Number(account.balance || 0) + withdrawAmount;
        await goal.save();
        await account.save();

        const txId = await getNextId('transactions');
        await models.Transaction.create({
            id: txId,
            user_id: req.user.id,
            account_id: Number(account_id),
            category_id: null,
            amount: withdrawAmount,
            date: new Date().toISOString().split('T')[0],
            description: `Goal Withdrawal: ${goal.title}`,
            transaction_type: 'Income',
            tag: 'GoalWithdraw',
            created_at: new Date().toISOString()
        });
        return res.json({ success: true });
    }

    const goal = canUseMongo()
        ? await models.Goal.findOne({ id: Number(req.params.id), user_id: req.user.id }).lean()
        : await db.get('SELECT id, title, saved_amount FROM goals WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    if (Number(goal.saved_amount || 0) < withdrawAmount) return res.status(400).json({ error: 'Insufficient goal balance' });

    const account = await db.get('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [account_id, req.user.id]);
    if (!account) return res.status(403).json({ error: 'No permission on account' });

    try {
        await db.run('BEGIN TRANSACTION');
        await db.run('UPDATE goals SET saved_amount = saved_amount - ? WHERE id = ? AND user_id = ?', [withdrawAmount, req.params.id, req.user.id]);
        await db.run("UPDATE goals SET status = CASE WHEN saved_amount >= target_amount THEN 'Completed' ELSE 'Active' END WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
        await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?', [withdrawAmount, account_id, req.user.id]);
        await db.run(
            'INSERT INTO transactions (user_id, account_id, category_id, amount, date, description, transaction_type, tag) VALUES (?, ?, NULL, ?, date("now", "localtime"), ?, ?, ?)',
            [req.user.id, account_id, withdrawAmount, `Goal Withdrawal: ${goal.title}`, 'Income', 'GoalWithdraw']
        );
        await db.run('COMMIT');
        res.json({ success: true });
    } catch (error) {
        await db.run('ROLLBACK');
        console.error(error);
        res.status(500).json({ error: 'Failed to withdraw from goal' });
    }
});

app.post('/api/goals/:id/utilize', async (req, res) => {
    const { utilize_mode, asset_type, asset_name, item_name } = req.body;
    const mode = String(utilize_mode || '').trim();
    const allowedModes = new Set(['convert_assets', 'buy_things']);

    if (!allowedModes.has(mode)) return res.status(400).json({ error: 'Invalid utilize mode' });

    const goal = canUseMongo()
        ? await models.Goal.findOne({ id: Number(req.params.id), user_id: req.user.id }).lean()
        : await db.get('SELECT id, title, saved_amount FROM goals WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const utilizeAmount = Number(goal.saved_amount || 0);
    if (utilizeAmount <= 0) return res.status(400).json({ error: 'Goal has no usable balance' });

    if (mode === 'convert_assets' && !String(asset_type || '').trim()) {
        return res.status(400).json({ error: 'Asset type is required' });
    }
    if (mode === 'convert_assets' && !String(asset_name || '').trim()) {
        return res.status(400).json({ error: 'Asset name is required' });
    }
    if (mode === 'buy_things' && !String(item_name || '').trim()) {
        return res.status(400).json({ error: 'Item name is required' });
    }

    if (canUseMongo()) {
        try {
            if (mode === 'convert_assets') {
                const invId = await getNextId('investments');
                await models.Investment.create({
                    id: invId,
                    user_id: req.user.id,
                    name: String(asset_name).trim(),
                    type: String(asset_type),
                    current_value: utilizeAmount,
                    cost_basis: utilizeAmount,
                    date: new Date().toISOString().split('T')[0],
                    notes: `Created from goal utilization: ${goal.title}`
                });
            }

            const histId = await getNextId('goal_utilization_history');
            await models.GoalUtilizationHistory.create({
                id: histId,
                user_id: req.user.id,
                goal_id: goal.id,
                goal_title: goal.title,
                utilize_mode: mode,
                amount: utilizeAmount,
                asset_type: asset_type ? String(asset_type) : null,
                asset_name: asset_name ? String(asset_name).trim() : null,
                item_name: item_name ? String(item_name) : null,
                account_id: null,
                account_name: null,
                created_at: new Date().toISOString()
            });

            await models.Goal.deleteOne({ id: goal.id, user_id: req.user.id });
            return res.json({ success: true });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to utilize goal' });
        }
    }

    try {
        await db.run('BEGIN TRANSACTION');

        if (mode === 'convert_assets') {
            await db.run(
                `INSERT INTO investments (user_id, name, type, current_value, cost_basis, date, notes)
                 VALUES (?, ?, ?, ?, ?, date("now", "localtime"), ?)` ,
                [
                    req.user.id,
                    String(asset_name).trim(),
                    String(asset_type),
                    utilizeAmount,
                    utilizeAmount,
                    `Created from goal utilization: ${goal.title}`
                ]
            );
        }

        await db.run(
            `INSERT INTO goal_utilization_history (user_id, goal_id, goal_title, utilize_mode, amount, asset_type, asset_name, item_name, account_id, account_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.user.id,
                goal.id,
                goal.title,
                mode,
                utilizeAmount,
                asset_type ? String(asset_type) : null,
                asset_name ? String(asset_name).trim() : null,
                item_name ? String(item_name) : null,
                null,
                null
            ]
        );

        // Once utilized, remove goal from active goals list.
        await db.run('DELETE FROM goals WHERE id = ? AND user_id = ?', [goal.id, req.user.id]);

        await db.run('COMMIT');
        res.json({ success: true });
    } catch (error) {
        await db.run('ROLLBACK');
        console.error(error);
        res.status(500).json({ error: 'Failed to utilize goal' });
    }
});

app.delete('/api/goals/:id', async (req, res) => {
    if (canUseMongo()) {
        await models.Goal.deleteOne({ id: Number(req.params.id), user_id: req.user.id });
        return res.json({ success: true });
    }
    await db.run('DELETE FROM goals WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
});

app.get('/api/reconciliation/:accountId', async (req, res) => {
    if (canUseMongo()) {
        const account = await models.Account.findOne({ id: Number(req.params.accountId), user_id: req.user.id }, { id: 1, name: 1, balance: 1, _id: 0 }).lean();
        if (!account) return res.status(404).json({ error: 'Account not found' });
        const txns = await models.Transaction.find({ user_id: req.user.id }, { _id: 0, amount: 1, transaction_type: 1, account_id: 1, to_account_id: 1 }).lean();
        const ledgerBalance = txns.reduce((sum, t) => {
            const amt = Number(t.amount || 0);
            if (t.transaction_type === 'Income' && t.account_id === account.id) return sum + amt;
            if (t.transaction_type === 'Expense' && t.account_id === account.id) return sum - amt;
            if (t.transaction_type === 'Transfer' && t.account_id === account.id) return sum - amt;
            if (t.transaction_type === 'Transfer' && t.to_account_id === account.id) return sum + amt;
            return sum;
        }, 0);
        return res.json({
            account_id: account.id,
            account_name: account.name,
            account_balance: Number(account.balance || 0),
            ledger_balance: Number(ledgerBalance || 0),
            difference: Number(account.balance || 0) - Number(ledgerBalance || 0)
        });
    }

    const account = await db.get('SELECT id, name, balance FROM accounts WHERE id = ? AND user_id = ?', [req.params.accountId, req.user.id]);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const calc = await db.get(
        `SELECT COALESCE(SUM(
            CASE
                WHEN transaction_type = 'Income' AND account_id = ? THEN amount
                WHEN transaction_type = 'Expense' AND account_id = ? THEN -amount
                WHEN transaction_type = 'Transfer' AND account_id = ? THEN -amount
                WHEN transaction_type = 'Transfer' AND to_account_id = ? THEN amount
                ELSE 0
            END
        ), 0) as ledger_balance FROM transactions WHERE user_id = ?`,
        [account.id, account.id, account.id, account.id, req.user.id]
    );
    res.json({ account_id: account.id, account_name: account.name, account_balance: Number(account.balance || 0), ledger_balance: Number(calc?.ledger_balance || 0), difference: Number(account.balance || 0) - Number(calc?.ledger_balance || 0) });
});

app.post('/api/reconciliation/:accountId', async (req, res) => {
    const statementBalance = Number(req.body.statement_balance || 0);
    const notes = req.body.notes || null;
    if (canUseMongo()) {
        const account = await models.Account.findOne({ id: Number(req.params.accountId), user_id: req.user.id }, { id: 1, name: 1, balance: 1, _id: 0 }).lean();
        if (!account) return res.status(404).json({ error: 'Account not found' });
        const diff = statementBalance - Number(account.balance || 0);
        const id = await getNextId('reconciliation_sessions');
        await models.ReconciliationSession.create({
            id,
            user_id: req.user.id,
            account_id: account.id,
            statement_balance: statementBalance,
            app_balance: Number(account.balance || 0),
            difference: diff,
            notes,
            created_at: new Date().toISOString()
        });
        return res.json({ success: true, difference: diff });
    }

    const account = await db.get('SELECT id, name, balance FROM accounts WHERE id = ? AND user_id = ?', [req.params.accountId, req.user.id]);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const diff = statementBalance - Number(account.balance || 0);
    await db.run(
        'INSERT INTO reconciliation_sessions (user_id, account_id, statement_balance, app_balance, difference, notes) VALUES (?, ?, ?, ?, ?, ?)',
        [req.user.id, account.id, statementBalance, Number(account.balance || 0), diff, notes]
    );
    res.json({ success: true, difference: diff });
});

app.post('/api/snapshots/close-month', async (req, res) => {
    const key = String(req.body.month || monthKey()).slice(0, 7);
    if (canUseMongo()) {
        const accounts = await models.Account.find({ user_id: req.user.id }, { id: 1, balance: 1, _id: 0 }).lean();
        for (const acc of accounts) {
            await models.BalanceSnapshot.updateOne(
                { user_id: req.user.id, snapshot_month: key, account_id: acc.id },
                { $set: { closing_balance: Number(acc.balance || 0), created_at: new Date().toISOString() }, $setOnInsert: { id: await getNextId('balance_snapshots') } },
                { upsert: true }
            );
        }
        return res.json({ success: true, month: key, count: accounts.length });
    }

    const accounts = await db.all('SELECT id, balance FROM accounts WHERE user_id = ?', [req.user.id]);
    for (const acc of accounts) {
        await db.run(
            'INSERT OR REPLACE INTO balance_snapshots (user_id, snapshot_month, account_id, closing_balance) VALUES (?, ?, ?, ?)',
            [req.user.id, key, acc.id, Number(acc.balance || 0)]
        );
    }
    res.json({ success: true, month: key, count: accounts.length });
});

app.get('/api/snapshots', async (req, res) => {
    if (canUseMongo()) {
        const [rows, accounts] = await Promise.all([
            models.BalanceSnapshot.find({ user_id: req.user.id }, { _id: 0 }).sort({ snapshot_month: -1, account_id: 1 }).lean(),
            models.Account.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
        ]);
        const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
        return res.json(rows.map((r) => ({ ...r, account_name: accountMap.get(r.account_id) || null })));
    }

    const rows = await db.all(
        `SELECT bs.*, a.name as account_name
         FROM balance_snapshots bs LEFT JOIN accounts a ON a.id = bs.account_id
         WHERE bs.user_id = ? ORDER BY bs.snapshot_month DESC, bs.account_id ASC`,
        [req.user.id]
    );
    res.json(rows);
});

app.get('/api/filters', async (req, res) => {
    if (canUseMongo()) {
        const rows = await models.SavedFilter.find({ user_id: req.user.id }, { _id: 0 }).sort({ id: -1 }).lean();
        return res.json(rows.map(r => ({ ...r, filter: parseJSON(r.filter_json, {}) })));
    }
    const rows = await db.all('SELECT * FROM saved_filters WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    res.json(rows.map(r => ({ ...r, filter: parseJSON(r.filter_json, {}) })));
});

app.post('/api/filters', async (req, res) => {
    const name = String(req.body.name || '').trim();
    const filter = req.body.filter || {};
    if (!name) return res.status(400).json({ error: 'Filter name is required.' });
    if (canUseMongo()) {
        const id = await getNextId('saved_filters');
        await models.SavedFilter.create({ id, user_id: req.user.id, name, filter_json: JSON.stringify(filter), created_at: new Date().toISOString() });
        return res.json({ id });
    }
    const r = await db.run('INSERT INTO saved_filters (user_id, name, filter_json) VALUES (?, ?, ?)', [req.user.id, name, JSON.stringify(filter)]);
    res.json({ id: r.lastID });
});

app.delete('/api/filters/:id', async (req, res) => {
    if (canUseMongo()) {
        await models.SavedFilter.deleteOne({ id: Number(req.params.id), user_id: req.user.id });
        return res.json({ success: true });
    }
    await db.run('DELETE FROM saved_filters WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
});

app.get('/api/reports/yearly-comparison', async (req, res) => {
    if (canUseMongo()) {
        const rows = await models.Transaction.find({ user_id: req.user.id, transaction_type: { $ne: 'Transfer' } }, { _id: 0, date: 1, amount: 1, transaction_type: 1 }).lean();
        const yearMap = new Map();
        for (const r of rows) {
            const year = String(r.date || '').slice(0, 4);
            if (!yearMap.has(year)) yearMap.set(year, { year, income: 0, expense: 0 });
            const item = yearMap.get(year);
            if (r.transaction_type === 'Income') item.income += Number(r.amount || 0);
            if (r.transaction_type === 'Expense') item.expense += Number(r.amount || 0);
        }
        return res.json([...yearMap.values()].sort((a, b) => String(a.year).localeCompare(String(b.year))).map((r) => ({ ...r, savings: Number(r.income || 0) - Number(r.expense || 0) })));
    }

    const rows = await db.all(
        `SELECT substr(date,1,4) as year,
                SUM(CASE WHEN transaction_type = 'Income' THEN amount ELSE 0 END) as income,
                SUM(CASE WHEN transaction_type = 'Expense' THEN amount ELSE 0 END) as expense
         FROM transactions
         WHERE user_id = ? AND transaction_type != 'Transfer'
         GROUP BY year
         ORDER BY year ASC`,
        [req.user.id]
    );
    res.json(rows.map(r => ({ ...r, savings: Number(r.income || 0) - Number(r.expense || 0) })));
});

app.get('/api/reports/tax-export', async (req, res) => {
    if (canUseMongo()) {
        const [txRows, categories] = await Promise.all([
            models.Transaction.find({ user_id: req.user.id, transaction_type: { $ne: 'Transfer' } }, { _id: 0, date: 1, description: 1, amount: 1, transaction_type: 1, category_id: 1 }).sort({ date: -1, id: -1 }).lean(),
            models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
        ]);
        const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
        const rows = txRows.map((t) => {
            const category_name = categoryMap.get(t.category_id) || null;
            const tax_group = category_name === 'Salary' || category_name === 'Bonus'
                ? 'INCOME_TAXABLE'
                : category_name === 'Rent' || category_name === 'Utilities'
                    ? 'HOME_EXPENSE'
                    : category_name === 'Medical' || category_name === 'Insurance'
                        ? 'HEALTH_EXPENSE'
                        : category_name === 'Education'
                            ? 'EDUCATION_EXPENSE'
                            : 'GENERAL';
            return {
                date: t.date,
                description: t.description,
                amount: t.amount,
                transaction_type: t.transaction_type,
                category_name,
                tax_group
            };
        });
        const parser = new Parser({ fields: ['date', 'description', 'amount', 'transaction_type', 'category_name', 'tax_group'] });
        res.attachment('tax-ready-export.csv');
        return res.send(parser.parse(rows));
    }

    const rows = await db.all(
        `SELECT t.date, t.description, t.amount, t.transaction_type, c.name as category_name,
                CASE
                    WHEN c.name IN ('Salary', 'Bonus') THEN 'INCOME_TAXABLE'
                    WHEN c.name IN ('Rent', 'Utilities') THEN 'HOME_EXPENSE'
                    WHEN c.name IN ('Medical', 'Insurance') THEN 'HEALTH_EXPENSE'
                    WHEN c.name IN ('Education') THEN 'EDUCATION_EXPENSE'
                    ELSE 'GENERAL'
                END as tax_group
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = ? AND t.transaction_type != 'Transfer'
         ORDER BY t.date DESC`,
        [req.user.id]
    );
    const parser = new Parser({ fields: ['date', 'description', 'amount', 'transaction_type', 'category_name', 'tax_group'] });
    res.attachment('tax-ready-export.csv');
    res.send(parser.parse(rows));
});

app.get('/api/reports/monthly-pdf', async (req, res) => {
    const m = String(req.query.month || monthKey()).slice(0, 7);
    let summary;
    let topCats;

    if (canUseMongo()) {
        const [txRows, categories] = await Promise.all([
            models.Transaction.find({ user_id: req.user.id, date: { $regex: `^${escapeRegExp(m)}` } }, { _id: 0, amount: 1, transaction_type: 1, category_id: 1 }).lean(),
            models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
        ]);
        const categoryMap = new Map(categories.map((c) => [c.id, c.name || 'Uncategorized']));
        let income = 0;
        let expense = 0;
        const catTotals = new Map();
        for (const t of txRows) {
            const amt = Number(t.amount || 0);
            if (t.transaction_type === 'Income') income += amt;
            if (t.transaction_type === 'Expense') {
                expense += amt;
                const catName = categoryMap.get(t.category_id) || 'Uncategorized';
                catTotals.set(catName, (catTotals.get(catName) || 0) + amt);
            }
        }
        summary = { income, expense };
        topCats = [...catTotals.entries()]
            .map(([category, total]) => ({ category, total }))
            .sort((a, b) => Number(b.total) - Number(a.total))
            .slice(0, 5);
    } else {
        [summary, topCats] = await Promise.all([
            db.get(
                `SELECT
                    COALESCE(SUM(CASE WHEN transaction_type = 'Income' THEN amount ELSE 0 END),0) as income,
                    COALESCE(SUM(CASE WHEN transaction_type = 'Expense' THEN amount ELSE 0 END),0) as expense
                 FROM transactions WHERE user_id = ? AND substr(date,1,7) = ?`,
                [req.user.id, m]
            ),
            db.all(
                `SELECT c.name as category, SUM(t.amount) as total
                 FROM transactions t
                 LEFT JOIN categories c ON c.id = t.category_id
                 WHERE t.user_id = ? AND t.transaction_type = 'Expense' AND substr(t.date,1,7) = ?
                 GROUP BY c.name
                 ORDER BY total DESC
                 LIMIT 5`,
                [req.user.id, m]
            )
        ]);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=monthly-report-${m}.pdf`);
    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    const income = Number(summary?.income || 0);
    const expense = Number(summary?.expense || 0);
    const savings = income - expense;

    doc.fontSize(20).text('Money Manager Monthly Report', { align: 'left' });
    doc.moveDown(0.5).fontSize(12).text(`Month: ${m}`);
    doc.moveDown(1);
    doc.fontSize(14).text(`Income: ${income.toFixed(2)}`);
    doc.fontSize(14).text(`Expense: ${expense.toFixed(2)}`);
    doc.fontSize(14).text(`Net Savings: ${savings.toFixed(2)}`);
    doc.moveDown(1).fontSize(14).text('Top Categories');
    if (!topCats.length) {
        doc.fontSize(12).text('No expense data for this month.');
    } else {
        topCats.forEach((c, idx) => doc.fontSize(12).text(`${idx + 1}. ${c.category || 'Uncategorized'} - ${Number(c.total || 0).toFixed(2)}`));
    }
    doc.end();
});

app.get('/api/backup/db', async (req, res) => {
    const backup = await buildMongoUserBackupPayload(req.user.id);
    res.header('Content-Type', 'application/json');
    res.attachment(`money-manager-backup-${Date.now()}.json`);
    return res.send(JSON.stringify(backup, null, 2));
});

app.post('/api/backup/restore', upload.single('sqlite'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No sqlite file uploaded' });
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (ext !== '.json') return res.status(400).json({ error: 'Please upload .json backup file.' });
    try {
        const payload = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
        const userId = req.user.id;
        const txIds = (await models.Transaction.find({ user_id: userId }, { id: 1, _id: 0 }).lean()).map((t) => t.id);
        const subIds = (await models.Subscription.find({ user_id: userId }, { id: 1, _id: 0 }).lean()).map((s) => s.id);

        if (txIds.length) await models.TransactionSplit.deleteMany({ transaction_id: { $in: txIds } });
        if (subIds.length) await models.RecurringRun.deleteMany({ subscription_id: { $in: subIds } });

        await Promise.all([
            models.Account.deleteMany({ user_id: userId }),
            models.Category.deleteMany({ user_id: userId }),
            models.Transaction.deleteMany({ user_id: userId }),
            models.Subscription.deleteMany({ user_id: userId }),
            models.Debt.deleteMany({ user_id: userId }),
            models.Investment.deleteMany({ user_id: userId }),
            models.Goal.deleteMany({ user_id: userId }),
            models.GoalUtilizationHistory.deleteMany({ user_id: userId }),
            models.Notification.deleteMany({ user_id: userId }),
            models.ActionHistory.deleteMany({ user_id: userId }),
            models.BalanceSnapshot.deleteMany({ user_id: userId }),
            models.ReconciliationSession.deleteMany({ user_id: userId }),
            models.SavedFilter.deleteMany({ user_id: userId }),
            models.QualityIssueOverride.deleteMany({ user_id: userId })
        ]);

        const safeInsert = async (Model, key) => {
            const rows = Array.isArray(payload?.[key]) ? payload[key] : [];
            if (!rows.length) return;
            await Model.insertMany(rows, { ordered: false });
        };

        const userRows = Array.isArray(payload?.users) ? payload.users.filter((u) => Number(u.id) === Number(userId)) : [];
        if (userRows.length) {
            await models.User.deleteOne({ id: userId });
            await models.User.insertMany(userRows, { ordered: false });
        }

        await safeInsert(models.Account, 'accounts');
        await safeInsert(models.Category, 'categories');
        await safeInsert(models.Transaction, 'transactions');
        await safeInsert(models.TransactionSplit, 'transaction_splits');
        await safeInsert(models.Subscription, 'subscriptions');
        await safeInsert(models.Debt, 'debts');
        await safeInsert(models.Investment, 'investments');
        await safeInsert(models.Goal, 'goals');
        await safeInsert(models.GoalUtilizationHistory, 'goal_utilization_history');
        await safeInsert(models.Notification, 'notifications');
        await safeInsert(models.RecurringRun, 'recurring_runs');
        await safeInsert(models.ActionHistory, 'action_history');
        await safeInsert(models.BalanceSnapshot, 'balance_snapshots');
        await safeInsert(models.ReconciliationSession, 'reconciliation_sessions');
        await safeInsert(models.SavedFilter, 'saved_filters');
        await safeInsert(models.QualityIssueOverride, 'quality_issue_overrides');

        res.json({ success: true, message: 'MongoDB backup restored successfully.' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});