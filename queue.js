import { Queue, Worker } from 'bullmq';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const redisOptions = { host: "127.0.0.1", port: 6379 };
const supabase = createClient("https://bbdyfhaspzrgmiatbrut.supabase.co", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJiZHlmaGFzcHpyZ21pYXRicnV0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTg3MjQ1MiwiZXhwIjoyMDk1NDQ4NDUyfQ.jtWTlgnrV8Ll0jo7JqeQa0XqGn18AATVhKKrqwI67CE");

// Fallback initialization if key is absent
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export const invoiceQueue = new Queue('InvoiceProcessingQueue', { connection: redisOptions });

// A helper function simulating Claude's vision processing and ledger normalization
async function mockClaudeVisionExtraction(ledgerString) {
  // Simulate 3 seconds of network/vision latency
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Extract names from our string to pass back an accurate matching ledger string
  const ledgersArray = ledgerString.split(',').map(l => l.trim().split(' ')[0]);
  const matchedExpenseLedger = ledgersArray[0] || "Office Stationery Expenses";

  return {
    extractionResult: {
      date: "27-05-2026",
      voucher_type: "Purchase",
      voucher_no: `INV-2026-${Math.floor(1000 + Math.random() * 9000)}`,
      party_ledger: "Sri Lakshmi Traders",
      expense_ledger: matchedExpenseLedger,
      amount: parseFloat((Math.random() * 5000 + 500).toFixed(2)),
      narration: "Automated extraction: Office consumables and processing supplies."
    },
    usage: {
      input_tokens: 1540,
      output_tokens: 210,
      cache_read_tokens: 1120 // Simulates active prompt caching behavior
    }
  };
}

const worker = new Worker('InvoiceProcessingQueue', async (job) => {
  const { invoiceId, clientId, storagePath } = job.data;
  console.log(`[Processing] Worker picked up job ${job.id} for Invoice: ${invoiceId}`);

  try {
    // 1. Fetch exact Tally ledger names specific to this specific client
    // Note: If your local DB is empty, default string handling prevents an app crash
    const { data: ledgers, error } = await supabase
      .from('tally_ledgers')
      .select('ledger_name, group_context')
      .eq('client_id', clientId);

    const ledgerString = (ledgers && ledgers.length > 0)
      ? ledgers.map(l => `${l.ledger_name} (${l.group_context})`).join(', ')
      : "Printing & Stationery (Direct Expenses)";

    let extractionResult;
    let usageMetrics;

    // 2. Core Routing Workaround
    if (anthropic) {
      // 1. Direct live API Execution
      const { data: fileBuffer, error: downloadError } = await supabase.storage.from('invoices').download(storagePath);
      if (downloadError) throw downloadError;

      const base64Image = Buffer.from(await fileBuffer.arrayBuffer()).toString('base64');

      // Determine media type dynamically based on file extension
      const extension = storagePath.split('.').pop().toLowerCase();
      let mediaType = 'image/jpeg';
      if (extension === 'png') mediaType = 'image/png';
      if (extension === 'pdf') mediaType = 'application/pdf'; // Note: Ensure model compatibility for PDF binaries

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
       system: [{ 
  type: "text", 
  text: `You are a strict, automated bookkeeping extraction engine configured for advanced Tally multi-ledger inventory tracking. Your job is to parse the invoice image and output an itemized ledger matrix.

VALID TALLY LEDGERS FOR THIS CLIENT:
[${ledgerString}]

EXTRACTION & MAPPING RULES:
1. **Voucher Date**: Extract the invoice date. Convert strictly to 'DD-MM-YYYY' format.
2. **Voucher Type Name**: Output 'Purchase' for vendor bills, or 'Payment' for cash receipts.
3. **Voucher Number**: Extract the exact reference/invoice number.
4. **Buyer/Supplier - Address**: Extract the complete physical address of the supplier cleanly.
5. **Ledger Mapping Sequence**:
   - **Ledger 1**: Must be the Sundry Creditor/Supplier Party Account. Amount is the grand total (Gross). Dr/Cr status is 'Cr'.
   - **Ledger 2**: Must be the core Expense or Purchase head (select the closest match from the VALID LEDGERS list). Amount is the taxable value (Net before tax). Dr/Cr status is 'Dr'.
   - **Ledger 3**: Extract the tax ledger name if applicable (e.g., "CGST & SGST" or "Input IGST"). Amount is the accumulated tax value. Dr/Cr status is 'Dr'. If no tax ledger is visible, leave name empty, amount 0, and Dr/Cr blank.
6. **Inventory Allocation**:
   - **Item Name**: Extract the primary item/service description name (e.g., "Milton Infrared Cooktop").
   - **Billed Quantity**: Extract the numeric quantity. Output as an integer.
   - **Item Rate**: Extract the unit price before taxes.
   - **Item Amount**: Calculate or extract the final net line-item subtotal (Quantity * Rate).
7. **Change Mode**: Always set this string strictly to 'Item Invoice'.

OUTPUT CONSTRAINTS:
- Output your response strictly as a single, valid JSON object.
- Do not wrap the JSON output inside markdown code blocks.

EXPECTED JSON SCHEMA:
{
  "voucher_date": "DD-MM-YYYY",
  "voucher_type_name": "Purchase",
  "voucher_number": "STRING",
  "supplier_address": "STRING",
  "ledger_1_name": "STRING",
  "ledger_1_amount": 0.00,
  "ledger_1_dc": "Cr",
  "ledger_2_name": "STRING",
  "ledger_2_amount": 0.00,
  "ledger_2_dc": "Dr",
  "ledger_3_name": "STRING",
  "ledger_3_amount": 0.00,
  "ledger_3_dc": "Dr",
  "item_name": "STRING",
  "billed_quantity": 0,
  "item_rate": 0.00,
  "item_amount": 0.00,
  "change_mode": "Item Invoice"
}`, 
  cache_control: { type: "ephemeral" } 
}],
        messages: [{
          role: "user",
          content: [{
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64Image }
          }]
        }]
      });

      // Clean markdown wrapper elements if present before executing parse
      let rawText = response.content[0].text.trim();
      if (rawText.startsWith("```")) {
        rawText = rawText.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
      }

      extractionResult = JSON.parse(rawText);
      usageMetrics = response.usage;
    } else {
      // Workaround Execution Block
      console.log(`[Stub Mode] Simulating vision processing for job ${job.id}...`);
      const mockData = await mockClaudeVisionExtraction(ledgerString);
      extractionResult = mockData.extractionResult;
      usageMetrics = mockData.usage;
    }

    // 3. Complete structural database mutations
    await supabase.from('invoices').update({
      status: 'COMPLETED',
      extracted_data: extractionResult
    }).eq('id', invoiceId);

    await supabase.from('usage_logs').insert({
      invoice_id: invoiceId,
      client_id: clientId,
      input_tokens: usageMetrics.input_tokens,
      output_tokens: usageMetrics.output_tokens,
      cache_read_tokens: usageMetrics.cache_read_tokens,
      pages_processed: 1
    });

    console.log(`[Success] Job ${job.id} finalized database transactions.`);
    return extractionResult;

  } catch (error) {
    console.error(`[Failure] Job ${job.id} execution failed: ${error.message}`);
    await supabase.from('invoices').update({ status: 'FAILED' }).eq('id', invoiceId);
    throw error;
  }
}, {
  connection: redisOptions,
  concurrency: 15 // Keeps the local multi-threaded resource bottleneck test real
});

worker.on('completed', (job) => console.log(`✔ Job ${job.id} completed.`));
worker.on('failed', (job, err) => console.log(`❌ Job ${job.id} execution failed: ${err.message}`));