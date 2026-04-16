# Money Manager 💰

A modern, user-friendly Money Manager application to help you track your income and expenses across various accounts such as Banks, Wallets, and Cash.

## 🚀 Features
- **Interactive Dashboard**: Get a clear overview of your total balance, total income, and total expenses.
- **Visual Analytics**: Understand your spending habits with a beautiful expense breakdown pie chart.
- **Transaction Tracking**: Easily record new incomes and expenses, categorizing them by account and specific categories.
- **Multiple Accounts**: Keep track of your money across different physical and digital locations (Bank, Digital Wallet, Pocket Cash).

## 🛠️ Tech Stack
- **Frontend**: React, Vite, Tailwind CSS (v4), Recharts (for charts), Lucide React (for icons)
- **Backend**: Node.js, Express.js
- **Database**: MongoDB

## 📁 Project Structure
- `/frontend`: Contains all the React client-side code and UI components.
- `/backend`: Contains the Node.js API server and MongoDB data/migration scripts.

## 🏁 Getting Started

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) and MongoDB installed/running.

### 1. Start the Backend
Open your terminal and navigate to the `backend` folder:
```bash
cd backend
npm install
copy .env.example .env
node server.js
```
*The backend API will start running on http://localhost:3001*

### Optional: Migrate Existing SQLite Data to MongoDB
If you want to import old SQLite data into MongoDB:

```bash
cd backend
npm install sqlite sqlite3
set MONGO_URI=mongodb://127.0.0.1:27017/money-manager
npm run migrate:mongodb
```

Notes:
- After migration, you can remove temporary migration deps if desired: `npm uninstall sqlite sqlite3`
- By default, migration reads `backend/database.sqlite`.
- You can override SQLite file path using `SQLITE_PATH` env variable.

### Run Backend (MongoDB)
MongoDB is the default and only runtime provider:

```bash
cd backend
set MONGO_URI=mongodb://127.0.0.1:27017/money-manager
node server.js
```

Mongo-backed endpoints include:
- Auth and profile (`register`, `login`, `user/me`, profile updates, PIN flows)
- Accounts and categories
- Transactions (list, quality checks, create/update/delete, bulk actions, undo, splits)
- Subscriptions
- Analytics and forecast
- Recurring automation and reminders
- Notifications
- Debts
- Investments
- Goals (including contribute/withdraw/utilize/history)
- Reconciliation
- Month-end snapshots
- Saved filters
- Reports (yearly comparison, tax export, monthly PDF)
- CSV import/export
- Backup/restore (JSON)
- Migration health check (`GET /api/migration/health`)

Mongo backup/restore notes:
- `GET /api/backup/db` downloads `.json` backup.
- `POST /api/backup/restore` expects `.json` backup.

### 2. Start the Frontend
Open a **new** terminal window and navigate to the `frontend` folder:
```bash
cd frontend
npm install
copy .env.example .env.local
npm run dev
```
*The frontend will start running on http://localhost:5173*

## 📝 License
This project is open-source and free to use.
