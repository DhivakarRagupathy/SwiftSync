import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const redisConnection = process.env.REDIS_URL
  ? new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
  : new IORedis({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: null });

function extractAndParseJSON(rawText) {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error("No JSON object found");
  const jsonStr = rawText.substring(start, end + 1);
  return JSON.parse(jsonStr);
}

async function processInvoiceJob(job) {
  const { invoiceId, clientId, storagePath, appUserId } = job.data;
  console.log(`[Processing] Job ${job.id} for invoice ${invoiceId}`);

  try {
    // 1. Fetch client's ledgers
    const { data: ledgers, error: ledgerError } = await supabase
      .from('tally_ledgers')
      .select('ledger_name, group_context')
      .eq('client_id', clientId);

    if (ledgerError) throw new Error(`Ledger fetch failed: ${ledgerError.message}`);

    const ledgerString = ledgers.map(l => `"${l.ledger_name}" (${l.group_context || 'General'})`).join('\n');

    // 2. Download file from storage
    const { data: fileBuffer, error: downloadError } = await supabase.storage
      .from('invoices')
      .download(storagePath);

    if (downloadError) throw new Error(`Download failed: ${downloadError.message}`);

    const base64 = Buffer.from(await fileBuffer.arrayBuffer()).toString('base64');
    const ext = storagePath.split('.').pop().toLowerCase();
    const mediaType = ext === 'png' ? 'image/png' : 'image/jpeg';

    console.log(`[Claude] Sending to vision API using claude-sonnet-4-6...`);

    // 3. Call Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      temperature: 0,
      system: `You are a deterministic JSON extractor for Tally ERP. Output ONLY valid JSON.
Valid ledgers: ${ledgerString || "Purchase A/c"}. Schema: { "voucher_date": "DD-MM-YYYY", "voucher_type_name": "string", "voucher_number": "string", "supplier_address": "string", "ledger_1_name": "string", "ledger_1_amount": number, "ledger_1_dc": "Cr/Dr", "ledger_2_name": "string", "ledger_2_amount": number, "ledger_2_dc": "Dr", "ledger_3_name": "string", "ledger_3_amount": number, "ledger_3_dc": "Dr", "items": [{"item_name": "string", "billed_quantity": number, "item_rate": number, "item_amount": number}], "change_mode": "string" }`,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } }] }]
    });

    const rawText = response.content[0].text;
    const extracted = extractAndParseJSON(rawText);
    const pagesProcessed = 1;

    // 4. Update invoice with extracted data
    const { error: updateError } = await supabase
      .from('invoices')
      .update({
        status: 'COMPLETED',
        extracted_data: extracted,
        completed_at: new Date().toISOString(),
        pages_processed: pagesProcessed
      })
      .eq('id', invoiceId);

    if (updateError) throw new Error(`Update failed: ${updateError.message}`);

    // 5. Log usage – check error property, do NOT use .catch()
    const { error: logError } = await supabase.from('usage_logs').insert({
      client_id: clientId,
      invoice_id: invoiceId,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      pages_processed: pagesProcessed
    });
    if (logError) {
      console.warn("Log insert skipped:", logError.message);
    }

    console.log(`✅ Job ${job.id} completed`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Job ${job.id} failed:`, error.message);
    // Store error details in invoice
    await supabase.from('invoices').update({ 
      status: 'FAILED', 
      extracted_data: { error: error.message, stack: error.stack } 
    }).eq('id', invoiceId);
    throw error;
  }
}

export const invoiceQueue = new Queue('invoice-queue', { connection: redisConnection });

const worker = new Worker('invoice-queue', processInvoiceJob, { connection: redisConnection, concurrency: 2 });
worker.on('ready', () => console.log('⚡ Worker ready'));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed with error:`, err));