import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function generateTallyExport(clientId) {
  console.log(`[Export] Fetching completed transactions for client: ${clientId}...`);

  // 1. Pull all successfully processed invoices for this specific tenant
  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('id, extracted_data')
    .eq('client_id', clientId)
    .eq('status', 'COMPLETED');

  if (error) {
    console.error(`❌ Database query failure: ${error.message}`);
    return;
  }

  if (!invoices || invoices.length === 0) {
    console.log("⚠ No completed transactions found for this client code.");
    return;
  }

  // 2. Define standard Tally CSV headers
  const csvHeaders = [
    "Date",
    "Voucher Type",
    "Voucher No",
    "Party Ledger (Credit)",
    "Expense Ledger (Debit)",
    "Amount",
    "Narration"
  ];

  // 3. Compile rows from the JSON payloads
  const csvRows = invoices.map(inv => {
    const data = inv.extracted_data;
    
    // Sanitize values to prevent commas inside fields from splitting columns incorrectly
    const party = `"${data.party_ledger.replace(/"/g, '""')}"`;
    const expense = `"${data.expense_ledger.replace(/"/g, '""')}"`;
    const narration = `"${data.narration.replace(/"/g, '""')}"`;

    return [
      data.date,
      data.voucher_type,
      data.voucher_no,
      party,
      expense,
      data.amount,
      narration
    ].join(',');
  });

  // Combine headers and rows into a single text block
  const completeCsvContent = [csvHeaders.join(','), ...csvRows].join('\n');

  // 4. Save file to disk
  const outputFilename = `tally_import_client_${clientId.slice(0, 8)}.csv`;
  fs.writeFileSync(outputFilename, completeCsvContent, 'utf8');

  console.log(`\n✔ Export completed successfully!`);
  console.log(`💾 Saved file to: ./${outputFilename}`);
}

const mockClientId = "c0000000-0000-0000-0000-000000000000";
generateTallyExport(mockClientId);