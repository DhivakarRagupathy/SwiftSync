import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { Worker , Queue} from 'bullmq';
import IORedis from 'ioredis';
import dotenv from 'dotenv';

// Load environment configurations
dotenv.config({ path: './local.env' }); // Adjust file matching to your setup (.env or local.env)

// Initialize Core External Clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Dynamic Redis Network Binding
const redisConnection = new IORedis(process.env.REDIS_URL || {
  host: '127.0.0.1',
  port: 6379,
  maxRetriesPerRequest: null
});

/**
 * Core Core Job Processing Loop
 */
async function processInvoiceJob(job) {
  const { invoiceId, clientId, storagePath } = job.data;
  console.log(`\n[Processing] 📥 Job ${job.id} picked up for Invoice UUID: ${invoiceId}`);

  try {
    // 1. Fetch Tenant Chart of Accounts (Ledgers)
    const { data: ledgers, error: ledgerError } = await supabase
      .from('tally_ledgers')
      .select('ledger_name, group_context')
      .eq('client_id', clientId);

    if (ledgerError) throw new Error(`Failed to fetch ledgers: ${ledgerError.message}`);

    const ledgerString = ledgers
      .map(l => `Name: "${l.ledger_name}", Group: "${l.group_context || 'None'}"`)
      .join('\n');

    // 2. Stream Binary File straight from Cloud Bucket
    const { data: fileBuffer, error: downloadError } = await supabase.storage
      .from('invoices')
      .download(storagePath);

    if (downloadError) throw new Error(`Storage download failure: ${downloadError.message}`);

    // Encode payload values for Anthropic multi-modal consumption
    const base64Image = Buffer.from(await fileBuffer.arrayBuffer()).toString('base64');
    const extension = storagePath.split('.').pop().toLowerCase();
    const mediaType = extension === 'png' ? 'image/png' : 'image/jpeg';

    console.log(`[Live API] 🧠 Dispatching image to Claude (claude-sonnet-4-6)...`);

    // 3. Execute Live Model Vision Parsing
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2500, // Large ceiling allowance for complex invoices containing dozens of lines
      system: [{ 
        type: "text", 
        text: `You are a literal, deterministic data extraction engine for Tally ERP. You must never invent, hallucinate, or use example names.

STRICT DATA SOURCE BINDING RULES:
1. **ledger_1_name (Party Ledger)**: Look at the actual invoice image. Extract the exact name of the Vendor/Supplier company printed on the document. Do not use placeholder names.
2. **ledger_2_name (Expense/Purchase Ledger)**: You must choose a name strictly from the "VALID TALLY LEDGERS FOR THIS CLIENT" list below. If the list is empty or no match fits, output "Purchase A/c". Never invent a name.
3. **ledger_3_name (Tax Ledger)**: Extract the tax ledger name visible on the invoice. If none is present, leave it empty.

VALID TALLY LEDGERS FOR THIS CLIENT:
[${ledgerString || 'Purchase A/c'}]

EXTRACTION SPECIFICATIONS:
- **voucher_date**: Invoice date formatted as 'DD-MM-YYYY'.
- **voucher_type_name**: Predict 'Purchase', 'Sales', or 'Payment' based on document context.
- **voucher_number**: Raw invoice serial reference number string.
- **supplier_address**: Full physical street address of the vendor from the document.
- **items**: Array containing every single distinct visible inventory line item with item_name, billed_quantity, item_rate, and item_amount.
- **change_mode**: Predict 'Item Invoice' if items exist, else 'Accounting Invoice'.

OUTPUT CONSTRAINTS:
- Output your response strictly as a single, valid JSON object. Do not include markdown code block ticks. Do not use default dummy values.

EXPECTED JSON SCHEMA:
{
  "voucher_date": "DD-MM-YYYY",
  "voucher_type_name": "STRING",
  "voucher_number": "STRING",
  "supplier_address": "STRING",
  "ledger_1_name": "STRING", "ledger_1_amount": 0.00, "ledger_1_dc": "Cr",
  "ledger_2_name": "STRING", "ledger_2_amount": 0.00, "ledger_2_dc": "Dr",
  "ledger_3_name": "STRING", "ledger_3_amount": 0.00, "ledger_3_dc": "Dr",
  "items": [
    {
      "item_name": "STRING",
      "billed_quantity": 0,
      "item_rate": 0.00,
      "item_amount": 0.00
    }
  ],
  "change_mode": "STRING"
}`, 
        cache_control: { type: "ephemeral" } 
      }],
      messages: [{ 
        role: "user", 
        content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } }] 
      }]
    });

    // 4. Sanitize and Extract Text String
    let rawText = response.content[0].text.trim();
    if (rawText.startsWith("```")) {
      rawText = rawText.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    }

    const extractionResult = JSON.parse(rawText);
    console.log(`[Success] Extracted ${extractionResult.items?.length || 0} line items dynamically.`);

    // 5. Update Record State inside Database
    const { error: updateError } = await supabase
      .from('invoices')
      .update({
        status: 'COMPLETED',
        extracted_data: extractionResult,
        file_path: storagePath,
        completed_at: new Date().toISOString()
      })
      .eq('id', invoiceId);

    if (updateError) throw new Error(`Database record mutation failed: updateError.message`);

    // 6. Safe Infrastructure Usage Logs Sync 
    // Uses a separate block so if the log table doesn't exist, it won't crash the main booking pipeline
    try {
      await supabase.from('usage_logs').insert({
        client_id: clientId,
        invoice_id: invoiceId,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      });
    } catch (logErr) {
      console.log(`[Notice] Usage log entry skipped (Table may be uninitialized): ${logErr.message}`);
    }

    console.log(`🏁 Job ${job.id} complete for Client context.`);
    return { success: true };

  } catch (error) {
    console.error(`❌ Job ${job.id} processing aborted:`, error.message);
    
    // Set matching database column error states so the dashboard user can see the failure
    await supabase.from('invoices').update({ 
      status: 'FAILED',
      extracted_data: { error: error.message }
    }).eq('id', invoiceId).catch(() => {});

    throw error; // Propagate exception back up to let BullMQ trigger attempt retries
  }
}

/**
 * START THE WORKER LISTENER
 */
const worker = new Worker('invoice-queue', processInvoiceJob, {
  connection: redisConnection,
  concurrency: 2
});

// ADD THIS LINE: Export the queue instance so gateway.js can use invoiceQueue.add()
export const invoiceQueue = new Queue('invoice-queue', {
  connection: redisConnection
});

worker.on('ready', () => {
  console.log('⚡ SwiftSync Automated Queue Worker is live and polling Redis...');
});

