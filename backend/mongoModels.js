const mongoose = require('mongoose');

const schemaOptions = {
  timestamps: false,
  versionKey: false,
  strict: true
};

const withId = (definition) => ({
  id: { type: Number, index: true, unique: true, sparse: true },
  ...definition
});

const models = {
  User: mongoose.model('User', new mongoose.Schema(withId({
    username: { type: String, required: true, index: true },
    password: { type: String, required: true },
    avatar_url: String,
    currency: { type: String, default: '$' },
    monthly_budget: { type: Number, default: 0 },
    pin_hash: String,
    pin_attempts: { type: Number, default: 0 },
    pin_locked_until: String,
    recovery_question: String,
    recovery_answer_hash: String,
    recovery_email: String,
    alert_level: { type: String, default: 'all' },
    backup_frequency: { type: String, default: 'manual' },
    last_backup_at: String
  }), schemaOptions)),

  Account: mongoose.model('Account', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    balance: { type: Number, default: 0 }
  }), schemaOptions)),

  Category: mongoose.model('Category', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    monthly_budget: { type: Number, default: 0 }
  }), schemaOptions)),

  Transaction: mongoose.model('Transaction', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    amount: { type: Number, required: true },
    date: { type: String, required: true, index: true },
    description: String,
    transaction_type: { type: String, required: true },
    category_id: Number,
    account_id: { type: Number, required: true },
    to_account_id: Number,
    receipt_url: String,
    payment_mode: String,
    payment_app: String,
    created_at: String,
    tag: String
  }), schemaOptions)),

  TransactionSplit: mongoose.model('TransactionSplit', new mongoose.Schema(withId({
    transaction_id: { type: Number, required: true, index: true },
    category_id: Number,
    amount: { type: Number, required: true },
    tag: String
  }), schemaOptions)),

  Subscription: mongoose.model('Subscription', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    name: { type: String, required: true },
    amount: { type: Number, required: true },
    type: { type: String, required: true },
    frequency: { type: String, required: true },
    next_date: { type: String, required: true },
    category_id: Number,
    account_id: { type: Number, required: true }
  }), schemaOptions)),

  Debt: mongoose.model('Debt', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    person_name: { type: String, required: true },
    amount: { type: Number, required: true },
    type: { type: String, required: true },
    due_date: String,
    status: { type: String, default: 'Pending' }
  }), schemaOptions)),

  Investment: mongoose.model('Investment', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    current_value: { type: Number, default: 0 },
    cost_basis: { type: Number, default: 0 },
    date: String,
    notes: String
  }), schemaOptions)),

  Goal: mongoose.model('Goal', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    title: { type: String, required: true },
    target_amount: { type: Number, required: true },
    saved_amount: { type: Number, default: 0 },
    due_date: String,
    status: { type: String, default: 'Active' }
  }), schemaOptions)),

  GoalUtilizationHistory: mongoose.model('GoalUtilizationHistory', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    goal_id: Number,
    goal_title: { type: String, required: true },
    utilize_mode: { type: String, required: true },
    amount: { type: Number, required: true },
    asset_type: String,
    asset_name: String,
    item_name: String,
    account_id: Number,
    account_name: String,
    created_at: String
  }), schemaOptions)),

  Notification: mongoose.model('Notification', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    type: { type: String, required: true },
    level: { type: String, default: 'info' },
    message: { type: String, required: true },
    is_read: { type: Number, default: 0 },
    created_at: String
  }), schemaOptions)),

  RecurringRun: mongoose.model('RecurringRun', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    subscription_id: { type: Number, required: true },
    run_date: { type: String, required: true }
  }), schemaOptions)),

  ActionHistory: mongoose.model('ActionHistory', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    action_type: { type: String, required: true },
    entity_type: { type: String, required: true },
    entity_id: Number,
    old_data: String,
    new_data: String,
    created_at: String
  }), schemaOptions)),

  BalanceSnapshot: mongoose.model('BalanceSnapshot', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    snapshot_month: { type: String, required: true },
    account_id: { type: Number, required: true },
    closing_balance: { type: Number, required: true },
    created_at: String
  }), schemaOptions)),

  ReconciliationSession: mongoose.model('ReconciliationSession', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    account_id: { type: Number, required: true },
    statement_balance: { type: Number, required: true },
    app_balance: { type: Number, required: true },
    difference: { type: Number, required: true },
    notes: String,
    created_at: String
  }), schemaOptions)),

  SavedFilter: mongoose.model('SavedFilter', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    name: { type: String, required: true },
    filter_json: { type: String, required: true },
    created_at: String
  }), schemaOptions)),

  QualityIssueOverride: mongoose.model('QualityIssueOverride', new mongoose.Schema(withId({
    user_id: { type: Number, required: true, index: true },
    transaction_id: { type: Number, required: true },
    issue_code: { type: String, required: true },
    created_at: String
  }), schemaOptions))
};

module.exports = { models };