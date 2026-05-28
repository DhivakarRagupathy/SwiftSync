import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Helper to generate a dummy 1536-float array for pgvector mapping verification
function generateMockEmbedding() {
  return Array.from({ length: 1536 }, () => parseFloat((Math.random() * 2 - 1).toFixed(4)));
}

async function syncTallyLedgers(clientId, ledgerList) {
  console.log(`[Sync] Initiating ledger sync for client: ${clientId}...`);

  // Transform the flat list into database rows matching our schema
  const rowsToInsert = ledgerList.map(item => ({
    client_id: clientId,
    ledger_name: item.name,
    group_context: item.group,
    embedding: generateMockEmbedding() // Vector grounding slot filled
  }));

  // Bulk upsert: If the ledger name already exists for this client, update its context
  const { data, error } = await supabase
    .from('tally_ledgers')
    .upsert(rowsToInsert, { onConflict: 'client_id,ledger_name' });

  if (error) {
    console.error(`❌ Ledger sync failed: ${error.message}`);
    return;
  }

  console.log(`✔ Successfully synced ${rowsToInsert.length} exact Tally ledgers into the database.`);
}

// Mocking the data an auditor would export from Tally and upload
const mockTallyExcelExport = [
  { name: "Sri Lakshmi Traders", group: "Sundry Creditors" },
  { name: "Bismi Biryani Center", group: "Office Refreshment Expenses" },
  { name: "Airtel Broadband A/c", group: "Telephone & Internet Charges" },
  { name: "Milton Appliances Corp", group: "Office Equipment Purchases" },
  { name: "Printing & Stationery Expenses", group: "Administrative Expenses" },
  { name: "CGST @ 9%", group: "Duties & Taxes" },
  { name: "SGST @ 9%", group: "Duties & Taxes" }
];

const mockClientId = "c0000000-0000-0000-0000-000000000000"; 
syncTallyLedgers(mockClientId, mockTallyExcelExport);