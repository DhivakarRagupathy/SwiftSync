import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { requestPresignedUpload, registerUploadComplete } from './gateway.js';
import { invoiceQueue } from './queue.js';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicFolder = path.join(__dirname, 'public');

// ---------- Session & Auth Helpers ----------
const getSessionUser = async (req) => {
  const cookies = req.headers.cookie;
  if (!cookies) return null;
  const match = cookies.split('; ').find(row => row.startsWith('ss_session='));
  if (!match) return null;
  const sessionToken = match.split('=')[1];
  // In production, use a proper session store. For simplicity, we store session in a Map or DB.
  // Here we'll assume sessionToken is the user ID (signed). For demo, we'll lookup a sessions table.
  const { data: session, error } = await supabase
    .from('user_sessions')
    .select('user_id, expires_at')
    .eq('token', sessionToken)
    .single();
  if (error || !session || new Date(session.expires_at) < new Date()) return null;
  return session.user_id;
};

const requireAuth = async (req, res, next) => {
  if (req.path === '/login' || req.path === '/api/auth/login') return next();
  const userId = await getSessionUser(req);
  if (userId) {
    req.userId = userId;
    next();
  } else {
    res.redirect('/login');
  }
};

app.use(express.json());
app.use(express.static(publicFolder));
app.use(requireAuth);

// ---------- Login Page ----------
app.get('/login', (req, res) => {
  res.sendFile(path.join(publicFolder, 'login.html'));
});

// ---------- Authentication Endpoint ----------
app.post('/api/auth/login', express.json(), async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing credentials" });

  try {
    const { data: user, error } = await supabase
      .from('app_users')
      .select('id, username, is_admin, invoices_left, client_id')
      .eq('username', username)
      .eq('password', password) // TODO: bcrypt
      .single();

    if (error || !user) return res.status(401).json({ error: "Invalid credentials" });

    // Create a session token (UUID)
    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 1); // 1 day

    await supabase.from('user_sessions').insert({
      token: sessionToken,
      user_id: user.id,
      expires_at: expiresAt.toISOString()
    });

    res.setHeader('Set-Cookie', `ss_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        is_admin: user.is_admin,
        invoices_left: user.invoices_left,
        client_id: user.client_id
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Authentication service error" });
  }
});

// ---------- Root ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(publicFolder, 'index.html'));
});

// ---------- API: Dashboard Metrics ----------
app.get('/api/dashboard/metrics', async (req, res) => {
  const { auditorId } = req.query;
  if (!auditorId) return res.status(400).json({ error: "Missing auditorId" });

  try {
    const { data: logs, error } = await supabase
      .from('usage_logs')
      .select('pages_processed, input_tokens, output_tokens, cache_read_tokens, clients!inner(auditor_id)')
      .eq('clients.auditor_id', auditorId);

    if (error) throw error;

    const totalPages = logs.reduce((sum, log) => sum + (log.pages_processed || 0), 0);
    let totalClaudeCostUSD = 0;
    logs.forEach(log => {
      const inputCost = ((log.input_tokens || 0) / 1_000_000) * 3.00;
      const outputCost = ((log.output_tokens || 0) / 1_000_000) * 15.00;
      const cacheCost = ((log.cache_read_tokens || 0) / 1_000_000) * 0.30;
      totalClaudeCostUSD += inputCost + outputCost + cacheCost;
    });

    const exchangeRate = 84;
    const totalInfraINR = totalClaudeCostUSD * exchangeRate;
    const grossBillingINR = totalPages * 5;
    const partnerPayoutINR = totalPages * 1;
    const netSaaSRevenue = grossBillingINR - partnerPayoutINR;
    const netProfit = netSaaSRevenue - totalInfraINR;

    res.json({
      summary: {
        total_invoices_processed: totalPages,
        gross_billing_inr: grossBillingINR,
        partner_payout_inr: partnerPayoutINR,
        net_saas_revenue_inr: netSaaSRevenue,
        claude_api_cost_inr: parseFloat(totalInfraINR.toFixed(2)),
        net_take_home_profit_inr: parseFloat(netProfit.toFixed(2))
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Bulk Initiate (with atomic quota reserve) ----------
app.post('/api/upload/bulk-initiate', async (req, res) => {
  const { files, username } = req.body;
  if (!files || !Array.isArray(files) || !username) {
    return res.status(400).json({ error: "Missing files or username" });
  }

  try {
    // Get user data including client_id
    const { data: user, error: userError } = await supabase
      .from('app_users')
      .select('id, invoices_left, client_id')
      .eq('username', username)
      .single();

    if (userError || !user) return res.status(404).json({ error: "User not found" });

    if (user.invoices_left < files.length) {
      return res.status(403).json({
        error: "Insufficient balance",
        message: `Need ${files.length}, have ${user.invoices_left}`
      });
    }

    // Atomic decrement quota
    const { error: updateError } = await supabase
      .from('app_users')
      .update({ invoices_left: user.invoices_left - files.length })
      .eq('id', user.id)
      .eq('invoices_left', user.invoices_left); // optimistic locking

    if (updateError) {
      return res.status(409).json({ error: "Quota changed, please retry" });
    }

    const uploadManifest = await Promise.all(files.map(async (fileName) => {
      try {
        // Pass client_id as the tenant identifier, and user.id as app_user_id
        const meta = await requestPresignedUpload(fileName, user.client_id, user.id);
        return { fileName, status: 'success', appUserId: user.id, clientId: user.client_id, ...meta };
      } catch (err) {
        // If any fails, we should rollback quota? For simplicity, return error.
        return { fileName, status: 'error', error: err.message };
      }
    }));

    res.json({ batch: uploadManifest, userId: user.id });
  } catch (err) {
    console.error("Bulk init error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ---------- Single Upload Initiate (kept for compatibility) ----------
app.post('/api/upload/initiate', async (req, res) => {
  const { fileName, clientId } = req.body;
  if (!fileName || !clientId) return res.status(400).json({ error: "Missing parameters" });
  try {
    const uploadMeta = await requestPresignedUpload(fileName, clientId, null);
    res.json(uploadMeta);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upload/complete', async (req, res) => {
  let { invoiceId, clientId, storagePath } = req.body;
  if (!invoiceId || !storagePath) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  // Always use the authenticated user's ID from session
  const authenticatedUserId = req.userId;
  if (!authenticatedUserId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  // Sanitize clientId – if invalid, fetch from user's record
  if (!clientId || clientId === 'null' || clientId === 'undefined') {
    const { data: user, error } = await supabase
      .from('app_users')
      .select('client_id')
      .eq('id', authenticatedUserId)
      .single();
    if (!error && user?.client_id) {
      clientId = user.client_id;
      console.log(`[Upload Complete] Using client_id from user record: ${clientId}`);
    } else {
      return res.status(400).json({ error: "No valid clientId available for this user" });
    }
  }

  try {
    const status = await registerUploadComplete(invoiceId, clientId, storagePath, authenticatedUserId);
    console.log(`[Upload Complete] Invoice ${invoiceId} linked to user ${authenticatedUserId}`);
    res.json(status);
  } catch (error) {
    console.error("Upload complete error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ---------- Tally CSV Export (with proper CSV escaping) ----------
app.get('/api/export/tally', async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: "Missing clientId" });

  try {
    const { data: invoices, error } = await supabase
      .from('invoices')
      .select('extracted_data')
      .eq('client_id', clientId)
      .eq('status', 'COMPLETED');

    if (error) throw error;
    if (!invoices.length) return res.status(404).json({ error: "No completed invoices" });

    // Escape CSV field: wrap in double quotes and escape internal quotes
    const escapeCsv = (str) => {
      if (str === undefined || str === null) return '';
      const stringified = String(str);
      if (stringified.includes(',') || stringified.includes('"') || stringified.includes('\n')) {
        return `"${stringified.replace(/"/g, '""')}"`;
      }
      return stringified;
    };

    let maxItems = 1;
    invoices.forEach(inv => {
      const items = inv.extracted_data?.items || [];
      if (items.length > maxItems) maxItems = items.length;
    });

    const headers = [
      "Voucher Date", "Voucher Type", "Voucher No", "Supplier Address",
      "Ledger1 Name", "Ledger1 Amount", "Ledger1 DC",
      "Ledger2 Name", "Ledger2 Amount", "Ledger2 DC",
      "Ledger3 Name", "Ledger3 Amount", "Ledger3 DC"
    ];
    for (let i = 1; i <= maxItems; i++) {
      headers.push(`Item Name ${i}`, `Quantity ${i}`, `Rate ${i}`, `Amount ${i}`);
    }
    headers.push("Change Mode");

    const rows = invoices.map(inv => {
      const d = inv.extracted_data;
      const row = [
        escapeCsv(d.voucher_date),
        escapeCsv(d.voucher_type_name),
        escapeCsv(d.voucher_number),
        escapeCsv(d.supplier_address),
        escapeCsv(d.ledger_1_name), d.ledger_1_amount || 0, escapeCsv(d.ledger_1_dc || 'Cr'),
        escapeCsv(d.ledger_2_name), d.ledger_2_amount || 0, escapeCsv(d.ledger_2_dc || 'Dr'),
        escapeCsv(d.ledger_3_name), d.ledger_3_amount || 0, escapeCsv(d.ledger_3_dc || 'Dr')
      ];
      const items = d.items || [];
      for (let i = 0; i < maxItems; i++) {
        const item = items[i];
        if (item) {
          row.push(escapeCsv(item.item_name), item.billed_quantity || 0, item.item_rate || 0, item.item_amount || 0);
        } else {
          row.push('', '', '', '');
        }
      }
      row.push(escapeCsv(d.change_mode || 'Item Invoice'));
      return row.join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=Tally_Export_${clientId.slice(0,8)}.csv`);
    res.send(csvContent);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- JSON Batch Export (with ownership check) ----------
app.post('/api/export/json-batch', async (req, res) => {
  const { invoiceIds } = req.body;
  if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return res.status(400).json({ error: "No invoice IDs provided" });
  }

  try {
    // Get current user ID from session
    const userId = req.userId;
    // Verify all invoices belong to this user via app_user_id
    const { data: invoices, error } = await supabase
      .from('invoices')
      .select('id, status, file_path, extracted_data, completed_at, app_user_id')
      .in('id', invoiceIds)
      .eq('app_user_id', userId); // enforce ownership

    if (error) throw error;
    if (!invoices.length) return res.status(403).json({ error: "No accessible invoices" });

    const exportBundle = {
      exported_at: new Date().toISOString(),
      batch_summary: {
        total: invoices.length,
        completed: invoices.filter(i => i.status === 'COMPLETED').length,
        failed: invoices.filter(i => i.status === 'FAILED').length
      },
      transactions: invoices.map(inv => ({
        invoice_uuid: inv.id,
        status: inv.status,
        file: inv.file_path?.split('/').pop(),
        completed_at: inv.completed_at,
        data: inv.extracted_data
      }))
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=SwiftSync_Batch_${Date.now()}.json`);
    res.send(JSON.stringify(exportBundle, null, 2));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Invoice Status Polling (with user scope) ----------
app.get('/api/invoices/status', async (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.status(400).json({ error: "Missing ids" });
  try {
    const invoiceIds = ids.split(',').map(id => id.trim());
    const userId = req.userId;
    const { data: invoices, error } = await supabase
      .from('invoices')
      .select('id, status, completed_at')
      .in('id', invoiceIds)
      .eq('app_user_id', userId);  // critical
    if (error) throw error;
    res.json({ invoices });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- User Quota (requires session) ----------
app.get('/api/user/quota', async (req, res) => {
  const userId = req.userId;
  const { data: user, error } = await supabase
    .from('app_users')
    .select('invoices_left')
    .eq('id', userId)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ invoices_left: user.invoices_left });
});

// ---------- Start Server ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});