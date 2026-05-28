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

// Calculate absolute directory path for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicFolder = path.join(__dirname, 'public');

// Quick plain-text cookie parser middleware to avoid extra npm installs
const getAuthCookie = (req) => {
  const cookies = req.headers.cookie;
  if (!cookies) return null;
  const match = cookies.split('; ').find(row => row.startsWith('ss_session='));
  return match ? match.split('=')[1] : null;
};

// Authentication Protection Gate
const requireAuth = (req, res, next) => {
  // Allow the login page and authentication API route to pass through unhindered
  if (req.path === '/login' || req.path === '/api/auth/login') {
    return next();
  }
  
  const session = getAuthCookie(req);
  if (session === 'authenticated') {
    next();
  } else {
    res.redirect('/login');
  }
};

// Apply the protection gate globally to all assets and API routes
app.use(requireAuth);

// Serve the Login Page explicitly
app.get('/login', (req, res) => {
  res.sendFile(path.join(publicFolder, 'login.html'));
});

// Authentication Processing Endpoint
app.post('/api/auth/login', express.json(), (req, res) => {
  const { username, password } = req.body;
  
  // Clean, hardcoded authentication credentials for fast local gating
  if (username === 'admin' && password === 'Kangeyam2026') {
    res.setHeader('Set-Cookie', 'ss_session=authenticated; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');
    return res.json({ success: true });
  }
  
  res.status(401).json({ error: "Invalid credentials" });
});

app.use(express.json());
app.use(express.static(publicFolder)); // Serve static files from absolute path

// Explicit root route handler with a custom visual debugger
app.get('/', (req, res) => {
  const indexPath = path.join(publicFolder, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(500).send(`
        <div style="font-family:sans-serif; padding:40px; max-width:600px; margin:auto; line-height:1.6;">
          <h1 style="color:#e11d48;">SwiftSync Server Path Debugger</h1>
          <p>The server is active, but it cannot find your <strong>index.html</strong> file.</p>
          <p><strong>Where the server is looking right now:</strong></p>
          <code style="background:#f1f5f9; padding:8px; display:block; border-radius:4px; font-family:monospace; border:1px solid #cbd5e1;">${indexPath}</code>
          <h3 style="margin-top:24px;">How to resolve this immediately:</h3>
          <ol>
            <li>Go to that exact path on your computer.</li>
            <li>Verify the folder name is lowercase <code>public</code>.</li>
            <li>Verify the file name is lowercase <code>index.html</code>. <em>(Watch out for Windows hiding extensions, making it secretly <code>index.html.txt</code>)</em>.</li>
          </ol>
        </div>
      `);
    }
  });
});

// --- API ROUTES ---

app.get('/api/dashboard/metrics', async (req, res) => {
  const { auditorId } = req.query;
  if (!auditorId) return res.status(400).json({ error: "Missing auditorId parameter" });

  try {
    // 1. Pull log metrics along with token data from the DB
    const { data: logs, error } = await supabase
      .from('usage_logs')
      .select(`
        pages_processed,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        clients!inner ( auditor_id )
      `)
      .eq('clients.auditor_id', auditorId);

    if (error) throw error;

    // 2. Aggregate counts
    const totalPages = logs.reduce((sum, log) => sum + (log.pages_processed || 0), 0);
    
    // 3. Calculate exact infrastructure expenditures (USD)
    let totalClaudeCostUSD = 0;
    logs.forEach(log => {
      const inputCost = ((log.input_tokens || 0) / 1000000) * 3.00;
      const outputCost = ((log.output_tokens || 0) / 1000000) * 15.00;
      const cacheSavedCost = ((log.cache_read_tokens || 0) / 1000000) * 0.30;
      
      totalClaudeCostUSD += (inputCost + outputCost + cacheSavedCost);
    });

    // Convert USD infrastructure costs to INR (using a standard baseline exchange rate of ~84)
    const totalInfrasubscriptionINR = totalClaudeCostUSD * 84;

    // 4. Client and Partner Revenue Ledger calculations
    const grossBillingINR = totalPages * 5;
    const partnerPayoutINR = totalPages * 1;
    const netSaaSRevenue = grossBillingINR - partnerPayoutINR;
    
    // 5. Final Take-Home Profit Margin
    const absoluteTakeHomeProfit = netSaaSRevenue - totalInfrasubscriptionINR;

    res.json({
      summary: {
        total_invoices_processed: totalPages,
        gross_billing_inr: grossBillingINR,
        partner_payout_inr: partnerPayoutINR,
        net_saas_revenue_inr: netSaaSRevenue,
        claude_api_cost_inr: parseFloat(totalInfrasubscriptionINR.toFixed(2)),
        net_take_home_profit_inr: parseFloat(absoluteTakeHomeProfit.toFixed(2))
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upload/initiate', async (req, res) => {
  const { fileName, clientId } = req.body;
  if (!fileName || !clientId) return res.status(400).json({ error: "Missing parameters" });
  try {
    const uploadMeta = await requestPresignedUpload(fileName, clientId);
    res.json(uploadMeta);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upload/complete', async (req, res) => {
  const { invoiceId, clientId, storagePath } = req.body;
  if (!invoiceId || !clientId || !storagePath) return res.status(400).json({ error: "Missing parameters" });
  try {
    const status = await registerUploadComplete(invoiceId, clientId, storagePath);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/export/tally', async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: "Missing clientId parameter" });

  try {
    const { data: invoices, error } = await supabase
      .from('invoices')
      .select('extracted_data')
      .eq('client_id', clientId)
      .eq('status', 'COMPLETED');

    if (error) throw error;
    if (!invoices || invoices.length === 0) {
      return res.status(444).json({ error: "No processed vouchers found for this client" });
    }

    // 1. Core Header Definition matching your exact template columns
    const csvHeaders = [
      "Voucher Date",
      "Voucher Type Name",
      "Voucher Number",
      "Buyer/Supplier - Address",
      "Ledger Name", "Ledger Amount", "Ledger Amount Dr/Cr", // Slot 1
      "Ledger Name", "Ledger Amount", "Ledger Amount Dr/Cr", // Slot 2
      "Ledger Name", "Ledger Amount", "Ledger Amount Dr/Cr", // Slot 3
      "Item Name",
      "Billed Quantity",
      "Item Rate",
      "Item Amount",
      "Change Mode"
    ];

    // 2. Loop and map JSON objects into comma-separated position vectors
    const csvRows = invoices.map(inv => {
      const d = inv.extracted_data;

      // Handle quote-escapes for free-text text values to prevent syntax breaks
      const supplierAddress = `"${(d.supplier_address || '').replace(/"/g, '""')}"`;
      const l1Name = `"${(d.ledger_1_name || '').replace(/"/g, '""')}"`;
      const l2Name = `"${(d.ledger_2_name || '').replace(/"/g, '""')}"`;
      const l3Name = `"${(d.ledger_3_name || '').replace(/"/g, '""')}"`;
      const itemName = `"${(d.item_name || '').replace(/"/g, '""')}"`;

      return [
        d.voucher_date,
        d.voucher_type_name,
        d.voucher_number,
        supplierAddress,
        
        // Ledger Entry Block 1 (Creditor Ledger)
        l1Name, d.ledger_1_amount || 0, d.ledger_1_dc || 'Cr',
        
        // Ledger Entry Block 2 (Debit Base Purchase Ledger)
        l2Name, d.ledger_2_amount || 0, d.ledger_2_dc || 'Dr',
        
        // Ledger Entry Block 3 (Tax Processing Ledger)
        l3Name, d.ledger_3_amount || 0, d.ledger_3_dc || 'Dr',
        
        // Inventory Configuration Layer
        itemName,
        d.billed_quantity || 0,
        d.item_rate || 0,
        d.item_amount || 0,
        d.change_mode || 'Item Invoice'
      ].join(',');
    });

    const finalCsvString = [csvHeaders.join('\t'), ...csvRows].join('\n');

    // 3. Set download context directives
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=Tally_Inventory_Import_${clientId.slice(0,8)}.csv`);
    res.status(200).send(finalCsvString);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/upload/bulk-initiate
 * Handles high-volume enterprise batches by generating multiple presigned URLs in a single round-trip
 */
app.post('/api/upload/bulk-initiate', async (req, res) => {
  const { files, clientId } = req.body; // 'files' is an array of strings: ["inv1.jpg", "inv2.png", ...]
  
  if (!files || !Array.isArray(files) || files.length === 0 || !clientId) {
    return res.status(400).json({ error: "Invalid payload. Provide an array of filenames and a clientId." });
  }

  try {
    console.log(`[Bulk API] Initializing a batch of ${files.length} uploads for Client: ${clientId}`);
    
    // Generate presigned URLs concurrently using Promise.all
    const uploadManifestPromises = files.map(async (fileName) => {
      try {
        const meta = await requestPresignedUpload(fileName, clientId);
        return { fileName, status: 'success', ...meta };
      } catch (err) {
        return { fileName, status: 'error', error: err.message };
      }
    });

    const uploadManifest = await Promise.all(uploadManifestPromises);
    res.json({ batch: uploadManifest });

  } catch (error) {
    res.status(500).json({ error: `Bulk initialization failed: ${error.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 API Server active at http://localhost:${PORT}`);
});